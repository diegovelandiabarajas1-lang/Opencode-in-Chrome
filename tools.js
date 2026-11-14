// Catalogo de herramientas MCP. Cada una se reenvia a la extension como {cmd, args}.
// Diseno propio: nombres browser_*, todas operan solo sobre pestanas del grupo "OpenCode".
const tab = { tabId: { type: "number", description: "Pestana destino; por defecto la pestana activa del agente." } };

export const TOOLS = [
  {
    name: "browser_tabs",
    description: "Lista las pestanas que el agente puede controlar (grupo 'OpenCode'). Devuelve id, titulo y URL.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_open_tab",
    description: "Abre una pestana nueva dentro del grupo del agente y la deja activa.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL inicial (opcional)." } } },
  },
  {
    name: "browser_close_tab",
    description: "Cierra una pestana del grupo del agente.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] },
  },
  {
    name: "browser_focus_tab",
    description: "Marca una pestana del grupo como la activa para las siguientes herramientas y la trae al frente.",
    inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] },
  },
  {
    name: "browser_goto",
    description: "Navega a una URL, o 'back' / 'forward' / 'reload'. Espera a que cargue (max 20 s).",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "URL o back|forward|reload" }, ...tab }, required: ["target"] },
  },
  {
    name: "browser_snapshot",
    description:
      "Devuelve el arbol de la pagina como texto con referencias [ref_N] estables para usar en click/type/fill. 'interactive' lista solo lo accionable.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["interactive", "all"], description: "Por defecto 'all'." },
        root: { type: "string", description: "ref_N: limita el arbol a ese elemento." },
        maxChars: { type: "number" },
        ...tab,
      },
    },
  },
  {
    name: "browser_find",
    description: "Busca en el arbol de la pagina elementos cuyo rol, nombre o texto contenga la consulta (sin distinguir mayusculas). Max 20.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, ...tab }, required: ["query"] },
  },
  {
    name: "browser_text",
    description: "Extrae el texto visible de la pagina (articulo/main primero, si no body).",
    inputSchema: { type: "object", properties: { maxChars: { type: "number" }, ...tab } },
  },
  {
    name: "browser_screenshot",
    description:
      "Captura la parte visible de la pagina. Las coordenadas de la imagen son pixeles CSS del viewport, usables directamente en click/hover/scroll. Con 'region' [x0,y0,x1,y1] recorta y amplia.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        scale: { type: "number", minimum: 0.1, maximum: 1, description: "Reduce el tamano de la imagen (solo sin region)." },
        fullPage: { type: "boolean", description: "Captura la pagina completa (todo el alto del documento), no solo lo visible." },
        format: { type: "string", enum: ["jpeg", "png"], description: "Por defecto jpeg." },
        save: { type: "string", description: "Guarda la imagen en esta ruta (debe estar bajo /workspace/). Se anade la extension si falta." },
        inline: { type: "boolean", description: "false = no devolver la imagen en la respuesta (util con save y paginas largas)." },
        ...tab,
      },
    },
  },
  {
    name: "browser_gif_start",
    description:
      "Empieza a grabar una pestana. Despues de cada accion (goto, click, type, key, scroll, fill, hover, drag) se anade un fotograma automaticamente; tambien puedes anadir uno con browser_gif_frame.",
    inputSchema: {
      type: "object",
      properties: {
        scale: { type: "number", minimum: 0.2, maximum: 1, description: "Escala de los fotogramas respecto al viewport (def. 0.5)." },
        maxFrames: { type: "number", description: "Limite de fotogramas (def. 60, max 120)." },
        ...tab,
      },
    },
  },
  {
    name: "browser_gif_frame",
    description: "Anade un fotograma manual a la grabacion en curso.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_gif_stop",
    description:
      "Detiene la grabacion y genera un GIF animado. Se guarda bajo /workspace/ (por defecto /workspace/capturas/gif-<fecha>.gif) y se devuelve la ruta.",
    inputSchema: {
      type: "object",
      properties: {
        save: { type: "string", description: "Ruta de salida bajo /workspace/." },
        delayMs: { type: "number", description: "Duracion de cada fotograma en ms (def. 700)." },
        discard: { type: "boolean", description: "true = descartar la grabacion sin generar GIF." },
      },
    },
  },
  {
    name: "browser_click",
    description: "Clic con raton real (CDP). Indica ref (se hace scroll hasta el elemento) o coordenadas x,y.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        count: { type: "number", description: "1 = clic, 2 = doble, 3 = triple." },
        modifiers: { type: "string", description: "p. ej. ctrl+shift" },
        ...tab,
      },
    },
  },
  {
    name: "browser_hover",
    description: "Mueve el raton sobre un elemento (ref) o coordenada, sin hacer clic.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, x: { type: "number" }, y: { type: "number" }, ...tab } },
  },
  {
    name: "browser_drag",
    description: "Arrastra de una coordenada a otra con el boton izquierdo.",
    inputSchema: {
      type: "object",
      properties: { fromX: { type: "number" }, fromY: { type: "number" }, toX: { type: "number" }, toY: { type: "number" }, ...tab },
      required: ["fromX", "fromY", "toX", "toY"],
    },
  },
  {
    name: "browser_type",
    description: "Escribe texto en el elemento enfocado (o primero lo enfoca si das ref). Soporta unicode.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" }, ...tab }, required: ["text"] },
  },
  {
    name: "browser_key",
    description: "Pulsa teclas separadas por espacio: 'Enter', 'ctrl+a', 'Tab Tab', 'ArrowDown'. 'repeat' repite la secuencia.",
    inputSchema: { type: "object", properties: { keys: { type: "string" }, repeat: { type: "number" }, ...tab }, required: ["keys"] },
  },
  {
    name: "browser_scroll",
    description: "Desplaza con la rueda en una posicion (por defecto el centro). O usa ref para llevar un elemento a la vista.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pasos de ~100 px (def. 3)." },
        x: { type: "number" },
        y: { type: "number" },
        ref: { type: "string" },
        ...tab,
      },
    },
  },
  {
    name: "browser_fill",
    description: "Asigna valor a input, textarea, select (valor o texto), checkbox/radio (booleano) o contenteditable, disparando input/change.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, value: {}, ...tab }, required: ["ref", "value"] },
  },
  {
    name: "browser_upload",
    description: "Adjunta archivos a un <input type=file>. Rutas del contenedor (/workspace/...) se traducen a rutas del host.",
    inputSchema: { type: "object", properties: { ref: { type: "string" }, paths: { type: "array", items: { type: "string" } }, ...tab }, required: ["ref", "paths"] },
  },
  {
    name: "browser_eval",
    description: "Ejecuta JavaScript en la pagina (admite await) y devuelve el resultado serializado. Para depurar/inspeccionar.",
    inputSchema: { type: "object", properties: { code: { type: "string" }, ...tab }, required: ["code"] },
  },
  {
    name: "browser_console",
    description: "Lee mensajes de consola/errores acumulados desde que se controla la pestana.",
    inputSchema: {
      type: "object",
      properties: { onlyErrors: { type: "boolean" }, pattern: { type: "string" }, limit: { type: "number" }, clear: { type: "boolean" }, ...tab },
    },
  },
  {
    name: "browser_network",
    description: "Lista peticiones de red acumuladas, o con requestId devuelve el cuerpo de esa respuesta.",
    inputSchema: { type: "object", properties: { urlPattern: { type: "string" }, requestId: { type: "string" }, limit: { type: "number" }, clear: { type: "boolean" }, ...tab } },
  },
  {
    name: "browser_viewport",
    description: "Cambia el tamano de ventana (width/height) o aplica preset mobile|tablet|desktop (emulacion).",
    inputSchema: { type: "object", properties: { preset: { type: "string", enum: ["mobile", "tablet", "desktop"] }, width: { type: "number" }, height: { type: "number" }, ...tab } },
  },
  {
    name: "browser_dialog",
    description: "Responde a un alert/confirm/prompt abierto (accept true/false, text para prompt). Sin argumentos informa si hay uno.",
    inputSchema: { type: "object", properties: { accept: { type: "boolean" }, text: { type: "string" }, ...tab } },
  },
  {
    name: "browser_wait",
    description: "Espera N segundos (max 10), o hasta que aparezca texto en la pagina si das 'text'.",
    inputSchema: { type: "object", properties: { seconds: { type: "number" }, text: { type: "string" }, ...tab } },
  },
];

export const CMD = {
  browser_tabs: "tabs", browser_open_tab: "openTab", browser_close_tab: "closeTab", browser_focus_tab: "focusTab",
  browser_goto: "goto", browser_snapshot: "snapshot", browser_find: "find", browser_text: "text",
  browser_screenshot: "screenshot", browser_click: "click", browser_hover: "hover", browser_drag: "drag",
  browser_type: "type", browser_key: "key", browser_scroll: "scroll", browser_fill: "fill", browser_upload: "upload",
  browser_eval: "evalJs", browser_console: "console", browser_network: "network", browser_viewport: "viewport",
  browser_dialog: "dialog", browser_wait: "wait",
  browser_gif_start: "gifStart", browser_gif_frame: "gifFrame", browser_gif_stop: "gifStop",
};
