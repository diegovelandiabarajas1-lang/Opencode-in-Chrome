// OpenCode Bridge - service worker.
// Conecta por WebSocket al servidor local y ejecuta ordenes sobre pestanas del grupo "OpenCode" usando chrome.debugger (CDP).

const GROUP_TITLE = "OpenCode";
const attached = new Set();
const bufs = new Map(); // tabId -> {console: [], net: Map, dialog: null}

// ---------- estado ----------
const store = {
  get: async (k) => (await chrome.storage.session.get(k))[k],
  set: (k, v) => chrome.storage.session.set({ [k]: v }),
};

async function groupId() {
  const gid = await store.get("gid");
  if (gid == null) return null;
  try { await chrome.tabGroups.get(gid); return gid; } catch { return null; }
}

async function addToGroup(tabId) {
  let gid = await groupId();
  gid = gid == null ? await chrome.tabs.group({ tabIds: [tabId] }) : await chrome.tabs.group({ tabIds: [tabId], groupId: gid });
  await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: "orange" });
  await store.set("gid", gid);
  await store.set("active", tabId);
  return gid;
}

async function ownedTabs() {
  const gid = await groupId();
  return gid == null ? [] : chrome.tabs.query({ groupId: gid });
}

async function resolveTab(args) {
  const owned = await ownedTabs();
  let id = args.tabId ?? (await store.get("active"));
  if (id == null || !owned.some((t) => t.id === id)) {
    if (args.tabId != null) throw new Error(`La pestana ${args.tabId} no esta en el grupo '${GROUP_TITLE}'.`);
    id = owned[0]?.id;
  }
  if (id == null) throw new Error("No hay pestanas del agente. Usa browser_open_tab o pulsa el icono de la extension en la pestana que quieras compartir.");
  return id;
}

// ---------- CDP ----------
const send = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

async function attach(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (!/already attached/i.test(String(e.message))) throw e;
  }
  attached.add(tabId);
  bufs.set(tabId, { console: [], net: new Map(), dialog: null, pending: new Set(), last: 0, xi: new Map() });
  for (const d of ["Runtime", "Page", "Network", "Log"]) await send(tabId, d + ".enable").catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); bufs.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); bufs.delete(tabId); });

const remoteText = (o) => (o ? (o.value !== undefined ? (typeof o.value === "string" ? o.value : JSON.stringify(o.value)) : o.description || o.type) : "");

chrome.debugger.onEvent.addListener(({ tabId }, method, p) => {
  const b = bufs.get(tabId);
  if (!b) return;
  const push = (type, text) => { b.console.push({ t: Date.now(), type, text: String(text).slice(0, 2000) }); if (b.console.length > 500) b.console.shift(); };
  if (method === "Runtime.consoleAPICalled") push(p.type, p.args.map(remoteText).join(" "));
  else if (method === "Runtime.exceptionThrown") push("error", p.exceptionDetails.exception?.description || p.exceptionDetails.text);
  else if (method === "Log.entryAdded") push(p.entry.level, `${p.entry.text} ${p.entry.url || ""}`);
  else if (method === "Network.requestWillBeSent") {
    b.net.set(p.requestId, { requestId: p.requestId, method: p.request.method, url: p.request.url, type: p.type, _t0: p.timestamp, _req: { ...p.request.headers, ...(b.xi.get("q" + p.requestId) || {}) } });
    b.xi.delete("q" + p.requestId);
    if (b.net.size > 300) b.net.delete(b.net.keys().next().value);
    b.pending.add(p.requestId); b.last = Date.now();
  } else if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceivedExtraInfo") {
    // Chrome entrega Cookie / Authorization / Set-Cookie en eventos aparte; se fusionan con las cabeceras normales.
    const res = method === "Network.responseReceivedExtraInfo";
    const r = b.net.get(p.requestId);
    if (r) r[res ? "_res" : "_req"] = { ...(r[res ? "_res" : "_req"] || {}), ...p.headers };
    else if (!res) b.xi.set("q" + p.requestId, p.headers);
  } else if (method === "Network.responseReceived") {
    const r = b.net.get(p.requestId);
    if (r) {
      r.status = p.response.status; r.mime = p.response.mimeType; r._res = p.response.headers;
      if (p.response.fromDiskCache || p.response.fromServiceWorker) r.fromCache = true;
      const tm = p.response.timing;
      if (tm) r._timing = { dnsMs: tm.dnsEnd >= 0 ? Math.round(tm.dnsEnd - Math.max(tm.dnsStart, 0)) : undefined, connectMs: tm.connectEnd >= 0 ? Math.round(tm.connectEnd - Math.max(tm.connectStart, 0)) : undefined, ttfbMs: Math.round(tm.receiveHeadersEnd) };
      r._proto = p.response.protocol; r._ip = p.response.remoteIPAddress;
    }
  } else if (method === "Network.loadingFinished") {
    const r = b.net.get(p.requestId);
    if (r) { r.bytes = p.encodedDataLength; r.ms = Math.round((p.timestamp - r._t0) * 1000); }
    b.pending.delete(p.requestId); b.last = Date.now();
  } else if (method === "Network.loadingFailed") {
    const r = b.net.get(p.requestId);
    if (r) { r.failed = p.errorText; r.ms = Math.round((p.timestamp - r._t0) * 1000); }
    b.pending.delete(p.requestId); b.last = Date.now();
  } else if (method === "Page.javascriptDialogOpening") b.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
  else if (method === "Page.javascriptDialogClosed") b.dialog = null;
  else if (method === "Page.domContentEventFired") b.dom = Date.now();
});

// Prepara una pestana para actuar: la trae al frente (los eventos de raton/teclado lo necesitan) y adjunta el depurador.
async function prep(args, { focus = true } = {}) {
  const tabId = await resolveTab(args);
  if (focus) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await attach(tabId);
  return tabId;
}

async function evalIn(tabId, expression, extra = {}) {
  const r = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, ...extra });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result;
}
// Utilidades compartidas que se inyectan delante de cada funcion de pagina:
// __find resuelve un elemento por ref o selector CSS (cruza iframes del mismo origen); __abs da su rect en el viewport superior.
const PRELUDE = `
const __G = (window.__ocb = window.__ocb || { n: 0, ids: new WeakMap(), els: new Map() });
const __idOf = (el) => { let i = __G.ids.get(el); if (!i) { i = "ref_" + ++__G.n; __G.ids.set(el, i); __G.els.set(i, new WeakRef(el)); } return i; };
const __docs = () => { const out = [document]; const walk = (d) => { for (const f of d.querySelectorAll("iframe,frame")) { try { if (f.contentDocument) { out.push(f.contentDocument); walk(f.contentDocument); } } catch (e) {} } }; walk(document); return out; };
const __find = (o) => {
  if (o.ref) { const el = __G.els.get(o.ref)?.deref(); return el && el.isConnected ? el : null; }
  if (o.selector) {
    const all = [];
    for (const d of __docs()) { try { all.push(...d.querySelectorAll(o.selector)); } catch (e) { throw new Error("Selector CSS invalido: " + o.selector); } }
    return all[o.index || 0] || null;
  }
  return null;
};
const __abs = (el) => {
  const r = el.getBoundingClientRect(); let x = r.x, y = r.y; let w = el.ownerDocument.defaultView;
  while (w && w !== w.top) { const f = w.frameElement; if (!f) break; const fr = f.getBoundingClientRect(); x += fr.x + f.clientLeft; y += fr.y + f.clientTop; w = w.parent; }
  return { x, y, width: r.width, height: r.height };
};
`;
const callPage = async (tabId, fn, arg) =>
  (await evalIn(tabId, `(function(){ ${PRELUDE}\nreturn (${fn.toString()})(${JSON.stringify(arg ?? null)}); })()`)).value;

// ---------- funciones que corren DENTRO de la pagina ----------
function pageSnapshot(o) {
  const G = (window.__ocb = window.__ocb || { n: 0, ids: new WeakMap(), els: new Map() });
  const idOf = (el) => {
    let i = G.ids.get(el);
    if (!i) { i = "ref_" + ++G.n; G.ids.set(el, i); G.els.set(i, new WeakRef(el)); }
    return i;
  };
  const ROLE = { a: "link", button: "button", select: "combobox", textarea: "textbox", img: "img", ul: "list", ol: "list", li: "listitem",
    table: "table", tr: "row", td: "cell", th: "columnheader", nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    form: "form", aside: "complementary", section: "region", dialog: "dialog", summary: "button", label: "label", p: "paragraph" };
  const INPUT = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider", search: "searchbox" };
  const ROLES_I = new Set(["button", "link", "checkbox", "tab", "menuitem", "option", "switch", "radio", "combobox", "textbox", "searchbox", "slider", "menuitemcheckbox", "menuitemradio", "treeitem"]);
  const role = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "input") return INPUT[(el.type || "text").toLowerCase()] || "textbox";
    if (/^h[1-6]$/.test(t)) return "heading";
    if (t === "a" && !el.hasAttribute("href")) return "generic";
    return ROLE[t] || "generic";
  };
  const txt = (s) => (s || "").replace(/\s+/g, " ").trim();
  const name = (el) => {
    let v = el.getAttribute("aria-label");
    if (v) return txt(v);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { v = lb.split(/\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" "); if (txt(v)) return txt(v); }
    if (el.labels && el.labels.length) return txt(el.labels[0].textContent);
    if (el.alt) return txt(el.alt);
    const t = el.tagName.toLowerCase();
    if (t === "input" && ["button", "submit", "reset"].includes(el.type)) return txt(el.value);
    if (el.placeholder) return txt(el.placeholder);
    if (["button", "a", "summary", "label"].includes(t) || /^h[1-6]$/.test(t) || ROLES_I.has(el.getAttribute("role"))) return txt(el.textContent).slice(0, 100);
    return txt(el.title);
  };
  const interactive = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === "a") return el.hasAttribute("href");
    if (t === "input") return el.type !== "hidden";
    if (["button", "select", "textarea", "summary"].includes(t)) return true;
    if (ROLES_I.has(el.getAttribute("role"))) return true;
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  };
  const visible = (el) => {
    const s = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || el.getAttribute("aria-hidden") === "true") return false;
    return true;
  };
  const onlyI = o.mode === "interactive";
  const out = [];
  const walk = (node, depth) => {
    if (node.nodeType === 3) {
      if (onlyI) return;
      const s = txt(node.nodeValue);
      if (s) out.push("  ".repeat(depth) + 'text "' + s.slice(0, 120) + '"');
      return;
    }
    if (node.nodeType !== 1) return;
    const t = node.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "svg", "head"].includes(t)) return;
    if (!visible(node)) return;
    if (t === "iframe" || t === "frame") {
      let inner = null;
      try { inner = node.contentDocument; } catch (e) { /* otro origen */ }
      const nm = name(node);
      out.push("  ".repeat(depth) + "iframe" + (nm ? ' "' + nm.replace(/"/g, "'") + '"' : "") + " [" + idOf(node) + "]" + (inner ? "" : " (otro origen: contenido no accesible)"));
      if (inner && inner.body) walk(inner.body, depth + 1);
      return;
    }
    let d = depth;
    const isI = interactive(node);
    const r = role(node);
    const struct = r !== "generic" && r !== "paragraph" && r !== "label";
    if (isI || (!onlyI && struct)) {
      const ex = [];
      if (t === "a" && node.href) ex.push("href=" + node.href.slice(0, 150));
      if (t === "input" || t === "textarea" || t === "select") {
        if (node.type && t === "input") ex.push("type=" + node.type);
        if (node.type === "checkbox" || node.type === "radio") ex.push(node.checked ? "checked" : "unchecked");
        else if (node.type !== "password" && node.value) ex.push("value=" + JSON.stringify(String(node.value).slice(0, 80)));
        if (node.disabled) ex.push("disabled");
      }
      const nm = name(node);
      out.push("  ".repeat(depth) + r + (nm ? ' "' + nm.replace(/"/g, "'") + '"' : "") + " [" + idOf(node) + "]" + (ex.length ? " " + ex.join(" ") : ""));
      d = depth + 1;
      if (isI && ["button", "a", "summary"].includes(t) && nm) return; // el nombre ya resume los hijos
    }
    if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) walk(c, d);
    for (const c of node.childNodes) walk(c, d);
  };
  let root = document.body;
  if (o.root) {
    root = G.els.get(o.root)?.deref();
    if (!root || !root.isConnected) return "ERROR: ref desconocida o ya no esta en la pagina: " + o.root;
  }
  walk(root, 0);
  let text = `URL: ${location.href}\nTitulo: ${document.title}\nViewport: ${innerWidth}x${innerHeight}\n` + out.join("\n");
  const max = o.maxChars || 40000;
  if (text.length > max) text = text.slice(0, max) + "\n...[truncado; usa root o mode=interactive]";
  return text;
}

function pageRefRect(o) {
  let el;
  try { el = __find(o); } catch (e) { return { error: e.message }; }
  if (!el) return { error: "elemento no encontrado: " + (o.ref || o.selector) + " (vuelve a hacer browser_snapshot)" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = __abs(el);
  if (!r.width || !r.height) return { error: "El elemento no tiene tamano visible" };
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x, top: r.y, width: r.width, height: r.height };
}

function pageFocus(o) {
  let el;
  try { el = __find(o); } catch (e) { return "ERROR: " + e.message; }
  if (!el) return "ERROR: elemento no encontrado: " + (o.ref || o.selector);
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  return "ok";
}

function pageQuery(o) {
  const res = [];
  const lim = o.limit || 20;
  for (const d of __docs()) {
    let list;
    try { list = d.querySelectorAll(o.selector); } catch (e) { return { error: "Selector CSS invalido: " + o.selector }; }
    for (const el of list) {
      const r = __abs(el);
      const vis = r.width > 0 && r.height > 0 && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== "hidden";
      if (o.visibleOnly && !vis) continue;
      res.push({ ref: __idOf(el), tag: el.tagName.toLowerCase(), visible: vis, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        text: (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80) });
      if (res.length >= lim) return { count: res.length, items: res, nota: "limite alcanzado" };
    }
  }
  return { count: res.length, items: res };
}

function pageInspect(o) {
  let el;
  try { el = __find(o); } catch (e) { return { error: e.message }; }
  if (!el) return { error: "elemento no encontrado: " + (o.ref || o.selector) };
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  const r = __abs(el);
  const pw = el.type === "password";
  const attrs = {};
  for (const a of el.attributes) if (!(pw && a.name === "value")) attrs[a.name] = a.value.slice(0, 200);
  return {
    ref: __idOf(el), tag: el.tagName.toLowerCase(), attrs,
    text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
    value: "value" in el && !pw ? String(el.value).slice(0, 200) : undefined,
    checked: el.checked, disabled: el.disabled,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    inViewport: r.width > 0 && r.height > 0 && r.y < innerHeight && r.y + r.height > 0 && r.x < innerWidth && r.x + r.width > 0,
    style: { display: cs.display, visibility: cs.visibility, position: cs.position, opacity: cs.opacity, color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex },
    html: pw ? undefined : el.outerHTML.slice(0, 600),
  };
}

function pageWaitCheck(o) {
  if (o.urlContains && !location.href.includes(o.urlContains)) return false;
  let present = true;
  if (o.text) present = present && document.body.innerText.includes(o.text);
  if (o.selector) {
    try {
      const el = __find(o);
      let ok = !!el;
      if (ok && (o.state === "visible" || o.state === "enabled")) {
        const r = el.getBoundingClientRect();
        ok = r.width > 0 && r.height > 0 && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== "hidden";
        if (ok && o.state === "enabled") ok = !el.disabled && el.getAttribute("aria-disabled") !== "true";
      }
      present = present && ok;
    } catch (e) { present = false; }
  }
  return o.gone ? !present : present;
}

function pageHtml(o) {
  let el;
  if (o.ref || o.selector) {
    try { el = __find(o); } catch (e) { return "ERROR: " + e.message; }
    if (!el) return "ERROR: elemento no encontrado: " + (o.ref || o.selector);
  } else el = document.documentElement;
  const html = o.inner ? el.innerHTML : el.outerHTML;
  const max = o.maxChars || 30000;
  const pre = o.ref || o.selector ? "" : "<!doctype html>\n";
  return html.length > max ? pre + html.slice(0, max) + `\n...[truncado: ${html.length} caracteres en total]` : pre + html;
}

function pageFill(o) {
  let el;
  try { el = __find(o); } catch (e) { return "ERROR: " + e.message; }
  if (!el) return "ERROR: elemento no encontrado: " + (o.ref || o.selector);
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const ev = (n) => el.dispatchEvent(new Event(n, { bubbles: true }));
  const t = el.tagName.toLowerCase();
  if (t === "select") {
    const opt = [...el.options].find((x) => x.value === String(o.value) || x.text.trim() === String(o.value));
    if (!opt) return "ERROR: opcion no encontrada. Disponibles: " + [...el.options].map((x) => x.text.trim()).join(" | ");
    el.value = opt.value; ev("input"); ev("change");
  } else if (t === "input" && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = o.value === true || o.value === "true"; ev("input"); ev("change");
  } else if (el.isContentEditable) {
    el.focus(); el.textContent = String(o.value); ev("input");
  } else if (t === "input" || t === "textarea") {
    const proto = t === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(o.value));
    ev("input"); ev("change");
  } else return "ERROR: el elemento no es un campo editable (" + t + ")";
  return "ok";
}

function pageText(o) {
  let el;
  if (o.ref || o.selector) {
    try { el = __find(o); } catch (e) { return "ERROR: " + e.message; }
    if (!el) return "ERROR: elemento no encontrado: " + (o.ref || o.selector);
  } else el = document.querySelector("article, main") || document.body;
  const s = `URL: ${location.href}\nTitulo: ${document.title}\n\n` + el.innerText;
  const max = o.maxChars || 50000;
  return s.length > max ? s.slice(0, max) + "\n...[truncado]" : s;
}

// sx/sy: desplazamiento actual. El recorte de Page.captureScreenshot usa coordenadas del DOCUMENTO, no de la ventana.
const pageMetrics = () => ({ w: innerWidth, h: innerHeight, sx: Math.round(window.scrollX), sy: Math.round(window.scrollY) });
const pageHasText = (o) => document.body.innerText.includes(o.text);

// ---------- teclado / raton ----------
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, shift: 8 };
const NAMED = { enter: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], space: [" ", "Space", 32],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowup: ["ArrowUp", "ArrowUp", 38], arrowright: ["ArrowRight", "ArrowRight", 39],
  arrowdown: ["ArrowDown", "ArrowDown", 40], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34] };
const EDIT = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

async function pressKey(tabId, combo) {
  const parts = combo.split("+").map((s) => s.trim()).filter(Boolean);
  let modifiers = 0;
  let keyName = parts.pop();
  for (const m of parts) modifiers |= MODS[m.toLowerCase()] ?? 0;
  let key, code, vk, text;
  const n = NAMED[keyName.toLowerCase()];
  if (n) [key, code, vk] = n;
  else if (/^f([1-9]|1[0-2])$/i.test(keyName)) { const k = Number(keyName.slice(1)); key = code = "F" + k; vk = 111 + k; }
  else if (keyName.length === 1) {
    key = keyName; vk = keyName.toUpperCase().charCodeAt(0);
    code = /[a-z]/i.test(keyName) ? "Key" + keyName.toUpperCase() : /\d/.test(keyName) ? "Digit" + keyName : "";
    if (!(modifiers & (1 | 2 | 4))) text = keyName;
  } else throw new Error("Tecla no reconocida: " + keyName);
  if (key === "Enter" && !(modifiers & 6)) text = "\r";
  const commands = modifiers & 6 && keyName.length === 1 && EDIT[keyName.toLowerCase()] ? [EDIT[keyName.toLowerCase()]] : undefined;
  const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, commands });
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const BTN = { left: ["left", 1], right: ["right", 2], middle: ["middle", 4] };
const modMask = (s) => (s || "").split("+").reduce((m, p) => m | (MODS[p.trim().toLowerCase()] ?? 0), 0);

async function target(tabId, a) {
  if (a.ref || a.selector) {
    const r = await callPage(tabId, pageRefRect, { ref: a.ref, selector: a.selector, index: a.index });
    if (r.error) throw new Error(r.error);
    return r;
  }
  if (typeof a.x === "number" && typeof a.y === "number") return { x: a.x, y: a.y };
  throw new Error("Indica ref, selector o coordenadas x,y");
}
const mouse = (tabId, type, x, y, extra = {}) => send(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera a que la pestana cargue: estado "complete", o 3 s despues del DOMContentLoaded
// (paginas con rastreadores o conexiones abiertas, como Netflix, tardan 20 s en llegar a "complete").
function waitLoad(tabId, ms = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const done = () => { clearTimeout(t); clearInterval(iv); chrome.tabs.onUpdated.removeListener(l); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, ms);
    const iv = setInterval(() => {
      const b = bufs.get(tabId);
      if (b && b.dom > start && Date.now() - b.dom > 3000) done();
    }, 250);
    chrome.tabs.onUpdated.addListener(l);
  });
}

const T = (x) => ({ text: typeof x === "string" ? x : JSON.stringify(x, null, 2) });

// ---------- grabacion GIF (los fotogramas se codifican en el servidor) ----------
let rec = null; // {tabId, scale, max, frames:[jpeg base64], busy}
const AUTO_FRAME = new Set(["goto", "click", "type", "key", "scroll", "fill", "hover", "drag"]);
async function grabFrame() {
  if (!rec || rec.busy || rec.frames.length >= rec.max) return;
  rec.busy = true;
  try {
    const { w, h, sx, sy } = await callPage(rec.tabId, pageMetrics);
    const r = await send(rec.tabId, "Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: sx, y: sy, width: w, height: h, scale: rec.scale } });
    rec.frames.push(r.data);
  } catch { /* la pestana pudo cerrarse */ }
  rec.busy = false;
}

// ---------- comandos ----------
const H = {
  async tabs() {
    const gid = await groupId();
    const active = await store.get("active");
    const list = (await ownedTabs()).map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.id === active }));
    return T({ group: gid != null ? GROUP_TITLE : null, tabs: list, note: list.length ? undefined : "Sin pestanas. Usa browser_open_tab." });
  },
  async openTab(a) {
    // Se crea en blanco y se engancha el depurador ANTES de navegar, para que consola y red vean la carga completa.
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    await addToGroup(tab.id);
    await attach(tab.id);
    if (a.url) {
      if (/^\s*javascript:/i.test(a.url)) throw new Error("javascript: no esta permitido; usa browser_eval");
      const w = waitLoad(tab.id);
      await chrome.tabs.update(tab.id, { url: /^[a-z][a-z0-9+.-]*:/i.test(a.url) ? a.url : "https://" + a.url });
      await w;
    }
    return T({ tabId: tab.id });
  },
  async closeTab(a) { const id = await resolveTab(a); await chrome.tabs.remove(id); return T("cerrada " + id); },
  async focusTab(a) { const id = await resolveTab(a); await store.set("active", id); await chrome.tabs.update(id, { active: true }); return T("activa " + id); },
  async goto(a) {
    const id = await prep(a, { focus: false });
    const g = a.target.trim();
    const w = waitLoad(id);
    if (g === "back") await chrome.tabs.goBack(id);
    else if (g === "forward") await chrome.tabs.goForward(id);
    else if (g === "reload") await chrome.tabs.reload(id);
    else {
      if (/^\s*javascript:/i.test(g)) throw new Error("javascript: no esta permitido; usa browser_eval");
      await chrome.tabs.update(id, { url: /^[a-z][a-z0-9+.-]*:/i.test(g) ? g : "https://" + g });
    }
    await w;
    const t = await chrome.tabs.get(id);
    return T(`Navegado: ${t.url} - ${t.title}`);
  },
  async snapshot(a) { const id = await prep(a, { focus: false }); return T(await callPage(id, pageSnapshot, a)); },
  async find(a) {
    const id = await prep(a, { focus: false });
    // Sin distinguir mayusculas ni acentos: «iniciar sesion» encuentra «Iniciar sesión».
    const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const q = norm(a.query).trim();
    const terms = q.split(/\s+/).filter(Boolean);
    const role = a.role ? norm(a.role) : null;
    const scored = (await callPage(id, pageSnapshot, { mode: "all", maxChars: 400000 }))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\[ref_\d+\]/.test(l))
      .map((l) => ({ l, low: norm(l) }))
      .filter(({ low }) => terms.every((t) => low.includes(t)) && (!role || low.startsWith(role + " ") || low.startsWith(role + "[")))
      .map(({ l, low }) => ({ l, s: low.includes('"' + q + '"') ? 3 : low.includes('"' + q) ? 2 : 1 }))
      .sort((x, y) => y.s - x.s)
      .slice(0, a.limit || 20);
    return T(scored.map((x) => x.l).join("\n") || "Sin coincidencias");
  },
  async query(a) {
    const id = await prep(a, { focus: false });
    const r = await callPage(id, pageQuery, a);
    if (r.error) throw new Error(r.error);
    return T(r);
  },
  async html(a) {
    const id = await prep(a, { focus: false });
    const r = await callPage(id, pageHtml, a);
    if (typeof r === "string" && r.startsWith("ERROR:")) throw new Error(r.slice(7));
    return T(r);
  },
  async emulate(a) {
    const id = await prep(a, { focus: false });
    const done = [];
    if (a.reset) {
      await send(id, "Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
      await send(id, "Emulation.setGeolocationOverride", {}).catch(() => {});
      const ua = await callPage(id, () => navigator.userAgent);
      await send(id, "Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: "" }).catch(() => {});
      return T("emulacion quitada (colorScheme, reducedMotion, locale, geolocation)");
    }
    const features = [];
    if (a.colorScheme) { features.push({ name: "prefers-color-scheme", value: a.colorScheme }); done.push("colorScheme=" + a.colorScheme); }
    if (a.reducedMotion) { features.push({ name: "prefers-reduced-motion", value: a.reducedMotion }); done.push("reducedMotion=" + a.reducedMotion); }
    if (features.length) await send(id, "Emulation.setEmulatedMedia", { features });
    if (a.locale) {
      // Chrome no deja a las extensiones cambiar el locale de Intl; si cambia el idioma del navegador y la cabecera Accept-Language.
      const ua = await callPage(id, () => navigator.userAgent);
      await send(id, "Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: a.locale });
      done.push("idioma(Accept-Language y navigator.language)=" + a.locale);
    }
    if (a.geolocation) {
      await send(id, "Emulation.setGeolocationOverride", { latitude: a.geolocation.latitude, longitude: a.geolocation.longitude, accuracy: a.geolocation.accuracy ?? 50 });
      done.push(`geolocation=${a.geolocation.latitude},${a.geolocation.longitude}`);
    }
    if (!done.length) throw new Error("Indica al menos uno de: colorScheme, reducedMotion, locale, geolocation, o reset=true");
    return T("emulando: " + done.join(", ") + ". Recarga la pagina si ya habia leido estos valores.");
  },
  async inspect(a) {
    const id = await prep(a, { focus: false });
    const r = await callPage(id, pageInspect, a);
    if (r.error) throw new Error(r.error);
    return T(r);
  },
  async text(a) {
    const id = await prep(a, { focus: false });
    const r = await callPage(id, pageText, a);
    if (typeof r === "string" && r.startsWith("ERROR:")) throw new Error(r.slice(7));
    return T(r);
  },
  async screenshot(a) {
    const id = await prep(a);
    let m = await callPage(id, pageMetrics);
    let clip, beyond = false, note = `Viewport ${m.w}x${m.h} (coordenadas en pixeles CSS)`;
    if (a.ref || a.selector) {
      const e = await callPage(id, pageRefRect, { ref: a.ref, selector: a.selector, index: a.index });
      if (e.error) throw new Error(e.error);
      m = await callPage(id, pageMetrics); // el scroll cambio al llevar el elemento a la vista
      clip = { x: e.left + m.sx, y: e.top + m.sy, width: e.width, height: e.height, scale: Math.min(3, 1400 / e.width) };
      beyond = true;
      note = `Elemento ${Math.round(e.width)}x${Math.round(e.height)} en (${Math.round(e.left)}, ${Math.round(e.top)})`;
    } else if (a.region) {
      const [x0, y0, x1, y1] = a.region;
      const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
      clip = { x: x0 + m.sx, y: y0 + m.sy, width, height, scale: Math.min(3, 1400 / width) };
    } else if (a.fullPage) {
      const m = await send(id, "Page.getLayoutMetrics");
      const cs = m.cssContentSize || m.contentSize;
      const width = Math.ceil(cs.width), height = Math.min(Math.ceil(cs.height), 16000); // limite de Chrome ~16384 px
      clip = { x: 0, y: 0, width, height, scale: a.scale || 1 };
      beyond = true;
      note = `Pagina completa ${width}x${height}` + (cs.height > 16000 ? " (recortada a 16000 px de alto)" : "");
    } else clip = { x: m.sx, y: m.sy, width: m.w, height: m.h, scale: a.scale || 1 };
    const png = a.format === "png";
    const r = await send(id, "Page.captureScreenshot", { format: png ? "png" : "jpeg", ...(png ? {} : { quality: 72 }), clip, captureBeyondViewport: beyond });
    return { image: { data: r.data, mime: png ? "image/png" : "image/jpeg" }, text: note };
  },
  async gifStart(a) {
    const id = await prep(a);
    const { w, h } = await callPage(id, pageMetrics);
    rec = { tabId: id, scale: a.scale || 0.5, max: Math.min(a.maxFrames || 60, 120), frames: [], busy: false };
    await grabFrame();
    return T(`Grabando pestana ${id} (${Math.round(w * rec.scale)}x${Math.round(h * rec.scale)}, max ${rec.max} fotogramas)`);
  },
  async gifFrame() {
    if (!rec) throw new Error("No hay grabacion en curso. Usa browser_gif_start.");
    await grabFrame();
    return T(`${rec.frames.length} fotogramas`);
  },
  async gifStop(a) {
    if (!rec) throw new Error("No hay grabacion en curso.");
    const r = rec;
    rec = null;
    return a.discard ? T("descartada") : { frames: r.frames };
  },
  async click(a) {
    const id = await prep(a);
    const { x, y } = await target(id, a);
    const [button, mask] = BTN[a.button || "left"];
    const modifiers = modMask(a.modifiers);
    await mouse(id, "mouseMoved", x, y, { modifiers });
    for (let i = 1; i <= Math.min(a.count || 1, 3); i++) {
      await mouse(id, "mousePressed", x, y, { button, buttons: mask, clickCount: i, modifiers });
      await mouse(id, "mouseReleased", x, y, { button, buttons: 0, clickCount: i, modifiers });
    }
    return T(`clic en (${Math.round(x)}, ${Math.round(y)})`);
  },
  async hover(a) { const id = await prep(a); const { x, y } = await target(id, a); await mouse(id, "mouseMoved", x, y); return T("hover"); },
  async drag(a) {
    const id = await prep(a);
    await mouse(id, "mouseMoved", a.fromX, a.fromY);
    await mouse(id, "mousePressed", a.fromX, a.fromY, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) await mouse(id, "mouseMoved", a.fromX + ((a.toX - a.fromX) * i) / 8, a.fromY + ((a.toY - a.fromY) * i) / 8, { buttons: 1 });
    await mouse(id, "mouseReleased", a.toX, a.toY, { button: "left", buttons: 0, clickCount: 1 });
    return T("arrastrado");
  },
  async type(a) {
    const id = await prep(a);
    if (a.ref || a.selector) { const r = await callPage(id, pageFocus, a); if (r !== "ok") throw new Error(r); }
    await send(id, "Input.insertText", { text: a.text });
    return T(`escrito ${a.text.length} caracteres`);
  },
  async key(a) {
    const id = await prep(a);
    const seq = a.keys.split(/\s+/).filter(Boolean);
    for (let i = 0; i < Math.min(a.repeat || 1, 100); i++) for (const k of seq) await pressKey(id, k);
    return T("teclas: " + a.keys);
  },
  async scroll(a) {
    const id = await prep(a);
    if (a.ref || a.selector) { const r = await callPage(id, pageRefRect, a); if (r.error) throw new Error(r.error); return T("elemento en vista"); }
    const m = await callPage(id, pageMetrics);
    const x = a.x ?? m.w / 2, y = a.y ?? m.h / 2;
    const px = (a.amount ?? 3) * 100;
    const dir = a.direction || "down";
    await mouse(id, "mouseWheel", x, y, { deltaX: dir === "left" ? -px : dir === "right" ? px : 0, deltaY: dir === "up" ? -px : dir === "down" ? px : 0 });
    await sleep(150);
    return T("scroll " + dir);
  },
  async fill(a) {
    const id = await prep(a, { focus: false });
    const r = await callPage(id, pageFill, a);
    if (r !== "ok") throw new Error(r);
    return T("ok");
  },
  async upload(a) {
    const id = await prep(a, { focus: false });
    const q = JSON.stringify({ ref: a.ref, selector: a.selector, index: a.index });
    const o = await evalIn(id, `(function(){ ${PRELUDE}\nreturn __find(${q}); })()`, { returnByValue: false });
    if (!o.objectId) throw new Error("elemento no encontrado: " + (a.ref || a.selector));
    await send(id, "DOM.setFileInputFiles", { files: a.paths, objectId: o.objectId });
    return T(`${a.paths.length} archivo(s) adjuntados`);
  },
  // Suelta archivos sobre una zona de arrastre (no solo <input type=file>), con eventos de arrastre reales.
  async dropFiles(a) {
    const id = await prep(a);
    const { x, y } = await target(id, a);
    const data = { items: [], files: a.paths, dragOperationsMask: 1 };
    await send(id, "Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
    await send(id, "Input.dispatchDragEvent", { type: "dragOver", x, y, data });
    await send(id, "Input.dispatchDragEvent", { type: "drop", x, y, data });
    return T(`${a.paths.length} archivo(s) soltados en (${Math.round(x)}, ${Math.round(y)})`);
  },
  async evalJs(a) {
    const id = await prep(a, { focus: false });
    // replMode permite 'await' al nivel superior pero no espera las promesas que se devuelven sin await; por eso solo se usa si hace falta.
    const needsRepl = /\bawait\b/.test(a.code);
    const r = await send(id, "Runtime.evaluate", { expression: a.code, returnByValue: true, awaitPromise: true, ...(needsRepl ? { replMode: true } : {}), userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    const v = r.result.value !== undefined ? r.result.value : r.result.description ?? r.result.type;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return T(s && s.length > 20000 ? s.slice(0, 20000) + "...[truncado]" : s ?? "undefined");
  },
  async console(a) {
    const id = await prep(a, { focus: false });
    const b = bufs.get(id);
    let items = b.console.filter((m) => (!a.onlyErrors || /error|warn/.test(m.type)) && (!a.pattern || m.text.includes(a.pattern)));
    items = items.slice(-(a.limit || 50));
    if (a.clear) b.console = [];
    return T(items.map((m) => `[${new Date(m.t).toISOString().slice(11, 19)}] ${m.type}: ${m.text}`).join("\n") || "(sin mensajes)");
  },
  async network(a) {
    const id = await prep(a, { focus: false });
    const b = bufs.get(id);
    const SECRET = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;
    const hide = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, SECRET.test(k) && !a.showSecrets ? "[oculto]" : v]));
    if (a.requestId) {
      if (a.what === "headers") {
        const r = b.net.get(a.requestId);
        if (!r) throw new Error("requestId desconocido (solo se guardan las ultimas 300 peticiones)");
        return T({
          url: r.url, method: r.method, status: r.status, mime: r.mime, type: r.type, bytes: r.bytes, ms: r.ms, fromCache: r.fromCache, failed: r.failed,
          protocol: r._proto, ip: r._ip, timing: r._timing,
          requestHeaders: hide(r._req), responseHeaders: hide(r._res),
        });
      }
      const r = await send(id, "Network.getResponseBody", { requestId: a.requestId });
      const body = r.base64Encoded ? "[binario base64] " + r.body.slice(0, 2000) : r.body;
      return T(body.length > 30000 ? body.slice(0, 30000) + "...[truncado]" : body);
    }
    const pub = (r) => ({ requestId: r.requestId, method: r.method, url: r.url, type: r.type, status: r.status, mime: r.mime, bytes: r.bytes, ms: r.ms, fromCache: r.fromCache, failed: r.failed });
    let items = [...b.net.values()]
      .filter((r) => (!a.urlPattern || r.url.includes(a.urlPattern)) && (!a.statusMin || (r.status ?? 0) >= a.statusMin) && (!a.failedOnly || r.failed || (r.status ?? 0) >= 400))
      .slice(-(a.limit || 50))
      .map(pub);
    if (a.clear) b.net.clear();
    return T(items);
  },
  async viewport(a) {
    const id = await prep(a, { focus: false });
    const P = { mobile: [375, 812, 2, true], tablet: [768, 1024, 2, true] };
    if (a.preset === "desktop") { await send(id, "Emulation.clearDeviceMetricsOverride"); return T("emulacion quitada"); }
    if (a.preset) {
      const [width, height, deviceScaleFactor, mobile] = P[a.preset];
      await send(id, "Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile });
      return T(`emulando ${a.preset} ${width}x${height}`);
    }
    if (a.width && a.height) { const t = await chrome.tabs.get(id); await chrome.windows.update(t.windowId, { width: a.width, height: a.height }); return T("ventana redimensionada"); }
    throw new Error("Indica preset o width y height");
  },
  async dialog(a) {
    const id = await prep(a, { focus: false });
    const b = bufs.get(id);
    if (a.accept === undefined) return T(b.dialog ? b.dialog : "No hay dialogo abierto");
    if (!b.dialog) throw new Error("No hay dialogo abierto");
    await send(id, "Page.handleJavaScriptDialog", { accept: a.accept, promptText: a.text });
    return T(a.accept ? "aceptado" : "rechazado");
  },
  async wait(a) {
    const id = await prep(a, { focus: false });
    const limit = Math.min(Math.max(a.seconds ?? 10, 0), 60) * 1000;
    const conds = a.text || a.selector || a.urlContains || a.idle;
    if (!conds) { await sleep(limit); return T("espera completada"); }
    const end = Date.now() + limit;
    const b = bufs.get(id);
    while (Date.now() < end) {
      const pageOk = a.text || a.selector || a.urlContains ? await callPage(id, pageWaitCheck, a) : true;
      const idleOk = !a.idle || (b.pending.size === 0 && Date.now() - b.last > 500);
      if (pageOk && idleOk) return T("condicion cumplida");
      await sleep(250);
    }
    return T("la condicion no se cumplio a tiempo" + (a.idle && b.pending.size > 0 ? ` (${b.pending.size} peticiones siguen en curso)` : ""));
  },
};

// ---------- conexion ----------
let ws = null;
let pingTimer = null;

async function connect() {
  if (ws && ws.readyState <= 1) return;
  const { host = "127.0.0.1:8765", token } = await chrome.storage.local.get(["host", "token"]);
  if (!token) return;
  try { ws = new WebSocket(`ws://${host}/ext?token=${encodeURIComponent(token)}`); } catch { return; }
  const mine = ws;
  mine.onopen = () => { clearInterval(pingTimer); pingTimer = setInterval(() => mine.readyState === 1 && mine.send('{"ping":1}'), 20000); setBadge("ON"); };
  mine.onclose = () => { clearInterval(pingTimer); if (ws === mine) ws = null; setBadge(""); setTimeout(connect, 3000); };
  mine.onerror = () => {};
  mine.onmessage = async (ev) => {
    const { id, cmd, args } = JSON.parse(ev.data);
    try {
      if (!H[cmd]) throw new Error("Comando desconocido: " + cmd);
      const result = await H[cmd](args || {});
      if (rec && AUTO_FRAME.has(cmd)) { await sleep(250); await grabFrame(); }
      mine.send(JSON.stringify({ id, result }));
    } catch (e) {
      mine.send(JSON.stringify({ id, error: String(e.message || e) }));
    }
  };
}
const setBadge = (t) => { chrome.action.setBadgeText({ text: t }); chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" }); };

chrome.runtime.onMessage.addListener((m) => { if (m.type === "reconnect") { ws?.close(); ws = null; connect(); } });
chrome.action.onClicked.addListener(async (tab) => { await addToGroup(tab.id); await attach(tab.id).catch(() => {}); });
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onStartup.addListener(connect);
connect();
