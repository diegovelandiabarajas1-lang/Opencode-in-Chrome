// Puente: OpenCode (contenedor) --HTTP/MCP--> este servidor --WebSocket--> extension de Chrome.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import jpeg from "jpeg-js";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;
import { TOOLS, CMD } from "./tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 8765);
const HOST = process.env.BRIDGE_HOST || "0.0.0.0"; // el contenedor entra por host.docker.internal
const WORKSPACE_HOST = process.env.WORKSPACE_HOST || path.resolve(here, "..", ".."); // D:\ProyectNona
const tokenFile = path.join(here, "token.txt");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("hex"));
const TOKEN = fs.readFileSync(tokenFile, "utf8").trim();

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const authed = (req, url) => {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token") || "";
  return safeEq(t, TOKEN);
};

// ---- extension ----
let ext = null;
let seq = 0;
const pending = new Map();

function callExt(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!ext || ext.readyState !== 1) return reject(new Error("La extension de Chrome no esta conectada. Abre Chrome con la extension instalada."));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Tiempo agotado en ${cmd}`)); }, 90000);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ id, cmd, args }));
  });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
wss.on("connection", (ws) => {
  if (ext && ext.readyState === 1) ext.close(1000, "reemplazada");
  ext = ws;
  console.log("[ext] conectada");
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.ping) return;
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  ws.on("close", () => { if (ext === ws) ext = null; console.log("[ext] desconectada"); });
});

// ---- utilidades ----
const toHostPath = (p) => (p.startsWith("/workspace/") ? path.join(WORKSPACE_HOST, p.slice(11)) : p);

function format(result) {
  // La extension devuelve {text?, image?:{data,mime}} o cualquier JSON.
  const content = [];
  if (result && result.image) content.push({ type: "image", data: result.image.data, mimeType: result.image.mime || "image/jpeg" });
  if (result && typeof result.text === "string") content.push({ type: "text", text: result.text });
  else if (!(result && result.image)) content.push({ type: "text", text: JSON.stringify(result ?? null, null, 2) });
  return { content };
}

// ---- validacion de parametros (subconjunto de JSON Schema) con mensajes utiles ----
const typeOk = (v, t) => (t === "array" ? Array.isArray(v) : t === "object" ? v && typeof v === "object" && !Array.isArray(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === t);
const levenshtein = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const usage = (tool) => {
  const p = tool.inputSchema.properties || {}, req = new Set(tool.inputSchema.required || []);
  return `Uso: ${tool.name} {${Object.keys(p).filter((k) => k !== "tabId").map((k) => (req.has(k) ? k : k + "?")).join(", ")}}`;
};
function validate(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return `Los argumentos de ${name} deben ser un objeto. ${usage(tool)}`;
  const props = tool.inputSchema.properties || {};
  const errs = [];
  for (const r of tool.inputSchema.required || []) if (args[r] === undefined || args[r] === null) errs.push(`falta el parametro requerido '${r}'${props[r]?.type ? ` (${props[r].type})` : ""}`);
  for (const [k, v] of Object.entries(args)) {
    const def = props[k];
    if (!def) {
      const guess = Object.keys(props).find((p) => levenshtein(k.toLowerCase(), p.toLowerCase()) <= 2) ||
        ((tool.inputSchema.required || []).length === 1 && args[(tool.inputSchema.required || [])[0]] === undefined ? tool.inputSchema.required[0] : null);
      errs.push(`parametro desconocido '${k}'${guess ? ` (quisiste decir '${guess}'?)` : ""}`);
      continue;
    }
    if (def.type && v !== undefined && v !== null && !typeOk(v, def.type)) errs.push(`'${k}' debe ser ${def.type}`);
    else if (def.enum && !def.enum.includes(v)) errs.push(`'${k}' debe ser uno de: ${def.enum.join(", ")}`);
  }
  return errs.length ? `${name}: ${errs.join("; ")}. ${usage(tool)}` : null;
}

// Escritura solo dentro del espacio de trabajo compartido (/workspace en el contenedor).
function outPath(p, ext) {
  if (!p.startsWith("/workspace/")) throw new Error("La ruta debe empezar por /workspace/");
  const root = path.resolve(WORKSPACE_HOST);
  let hp = path.resolve(toHostPath(p));
  if (!(hp.toLowerCase().startsWith(root.toLowerCase() + path.sep))) throw new Error("Ruta fuera del espacio de trabajo");
  if (!path.extname(hp)) { hp += ext; p += ext; }
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  return { hp, p };
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function encodeGif(frames, delay) {
  const gif = GIFEncoder();
  let w = 0, h = 0, used = 0;
  frames.forEach((b64, i) => {
    const img = jpeg.decode(Buffer.from(b64, "base64"), { useTArray: true, formatAsRGBA: true });
    if (!w) { w = img.width; h = img.height; }
    if (img.width !== w || img.height !== h) return; // se omiten fotogramas de otro tamano
    const palette = quantize(img.data, 256);
    gif.writeFrame(applyPalette(img.data, palette), w, h, { palette, delay: i === frames.length - 1 ? delay * 2 : delay });
    used++;
  });
  gif.finish();
  return { bytes: Buffer.from(gif.bytes()), w, h, used };
}

async function callTool(name, args = {}) {
  const cmd = CMD[name];
  if (!cmd) return { isError: true, content: [{ type: "text", text: `Herramienta desconocida: ${name}` }] };
  const bad = validate(name, args);
  if (bad) return { isError: true, content: [{ type: "text", text: bad }] };
  if (name === "browser_upload" || name === "browser_drop_files") args = { ...args, paths: (args.paths || []).map(toHostPath) };
  try {
    if (name === "browser_batch") {
      const acts = Array.isArray(args.actions) ? args.actions.slice(0, 20) : [];
      if (!acts.length) throw new Error("actions esta vacio");
      const content = [];
      let failed = false;
      let refs = []; // refs (ref_N) del resultado de la accion anterior
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i] || {};
        if (a.tool === "browser_batch") throw new Error("browser_batch no puede anidarse");
        let aargs = a.args || {};
        const raw = JSON.stringify(aargs);
        if (raw.includes("{{ref")) {
          let miss = null;
          aargs = JSON.parse(raw.replace(/\{\{ref(?:\[(\d+)\])?\}\}/g, (m, n) => { const v = refs[n === undefined ? 0 : Number(n)]; if (!v) miss = m; return v ?? m; }));
          if (miss) {
            content.push({ type: "text", text: `#${i + 1} ${a.tool} [ERROR]` }, { type: "text", text: `${miss}: la accion anterior no devolvio ese ref (hubo ${refs.length})` });
            failed = true;
            break;
          }
        }
        const r = await callTool(a.tool, aargs);
        refs = [...r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").matchAll(/ref_\d+/g)].map((m) => m[0]).filter((v, k, all) => all.indexOf(v) === k);
        content.push({ type: "text", text: `#${i + 1} ${a.tool}${r.isError ? " [ERROR]" : ""}` });
        content.push(...r.content);
        if (r.isError && args.stopOnError !== false) { failed = true; content.push({ type: "text", text: `Lote detenido en la accion ${i + 1} de ${acts.length}` }); break; }
      }
      return { content, isError: failed };
    }
    if (name === "browser_gif_stop") {
      const r = await callExt(cmd, { discard: !!args.discard });
      if (args.discard) return { content: [{ type: "text", text: "Grabacion descartada" }] };
      if (!r.frames?.length) throw new Error("La grabacion no tiene fotogramas");
      const { hp, p } = outPath(args.save || `/workspace/capturas/gif-${stamp()}`, ".gif");
      const g = encodeGif(r.frames, Math.max(50, args.delayMs || 700));
      fs.writeFileSync(hp, g.bytes);
      return { content: [{ type: "text", text: `GIF guardado: ${p} (${g.used} fotogramas, ${g.w}x${g.h}, ${(g.bytes.length / 1024).toFixed(0)} KB)` }] };
    }
    if (name === "browser_screenshot") {
      const out = args.save ? outPath(args.save, args.format === "png" ? ".png" : ".jpg") : null; // valida antes de capturar
      const r = await callExt(cmd, args);
      let res = format(r);
      if (out) {
        fs.writeFileSync(out.hp, Buffer.from(r.image.data, "base64"));
        res.content.push({ type: "text", text: `Guardada en ${out.p}` });
        if (args.inline === false) res.content = res.content.filter((c) => c.type !== "image");
      }
      return res;
    }
    return format(await callExt(cmd, args));
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
  }
}

async function rpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-chrome-bridge", version: "0.1.0" },
      });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": return ok(await callTool(params?.name, params?.arguments));
    default:
      if (id === undefined) return null; // notificacion
      return fail(-32601, `Metodo no soportado: ${method}`);
  }
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (process.env.BRIDGE_DEBUG) console.log(req.method, url.pathname, "auth:", req.headers.authorization ? "si" : "no", req.headers.accept || "");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, extension: !!(ext && ext.readyState === 1) }));
  }
  if (url.pathname !== "/mcp") { res.writeHead(404).end(); return; }
  if (!authed(req, url)) { res.writeHead(401).end("token invalido"); return; }
  if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
  let body = "";
  for await (const c of req) { body += c; if (body.length > 8e6) { res.writeHead(413).end(); return; } }
  let msg;
  try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  const batch = Array.isArray(msg);
  const out = (await Promise.all((batch ? msg : [msg]).map(rpc))).filter(Boolean);
  if (!out.length) { res.writeHead(202).end(); return; }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(batch ? out : out[0]));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ext" || !authed(req, url)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, HOST, () => {
  console.log(`Puente listo en http://${HOST}:${PORT}  (MCP: /mcp, extension: /ext)`);
  console.log(`Token en ${tokenFile}`);
});
