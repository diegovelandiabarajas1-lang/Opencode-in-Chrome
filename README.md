# Opencode in Chrome

Puente que da a [OpenCode](https://opencode.ai) el control de tu Chrome, incluso cuando OpenCode corre dentro de un contenedor Docker. Expone 32 herramientas `browser_*` mediante el protocolo MCP: abrir pestañas, leer páginas, hacer clic, escribir, capturar pantalla, grabar GIF, inspeccionar consola y red, y encadenar acciones en una sola llamada.

```
OpenCode (Docker) ──MCP/HTTP──▶ server.js (host :8765) ──WebSocket──▶ extensión de Chrome ──CDP──▶ pestañas
```

Es una implementación propia e independiente, hecha con `chrome.debugger` y un servidor MCP mínimo en Node.

## Requisitos
- Windows, macOS o Linux con Chrome (o un navegador Chromium con extensiones MV3).
- Node.js 18 o superior en el equipo donde corre Chrome.
- OpenCode con soporte de servidores MCP remotos.

## Instalación
1. Instala dependencias y arranca el servidor en el equipo con Chrome:
   ```bash
   npm install
   node server.js
   ```
   La primera vez genera `token.txt` (secreto; no lo compartas).
2. En Chrome abre `chrome://extensions`, activa **Modo de desarrollador** y usa **Cargar descomprimida** con la carpeta `extension/`.
3. En las opciones de la extensión pon el host (`127.0.0.1:8765`) y el contenido de `token.txt`. La insignia «ON» indica que está conectada.
4. Declara el servidor en la configuración de OpenCode (`opencode.json` del proyecto):
   ```json
   {
     "mcp": {
       "servers": {
         "navegador": {
           "type": "remote",
           "url": "http://host.docker.internal:8765/mcp",
           "headers": { "Authorization": "Bearer <contenido de token.txt>" }
         }
       }
     }
   }
   ```
   Si OpenCode no es de Docker, usa `http://127.0.0.1:8765/mcp`. Reinicia OpenCode para que lea el cambio y comprueba con `opencode mcp list`.
5. Opcional: copia `AGENTS.ejemplo.md` como `AGENTS.md` en el proyecto para que el agente sepa usar las herramientas.

## Herramientas
| Grupo | Herramientas |
|---|---|
| Pestañas | `browser_tabs`, `browser_open_tab`, `browser_close_tab`, `browser_focus_tab`, `browser_goto` |
| Leer | `browser_snapshot` (referencias `ref_N`), `browser_find`, `browser_query`, `browser_inspect`, `browser_text`, `browser_html`, `browser_screenshot` |
| Actuar | `browser_click`, `browser_hover`, `browser_drag`, `browser_type`, `browser_key`, `browser_scroll`, `browser_fill`, `browser_upload`, `browser_drop_files` |
| Depurar | `browser_eval`, `browser_console`, `browser_network`, `browser_viewport`, `browser_emulate`, `browser_dialog`, `browser_wait` |
| GIF | `browser_gif_start`, `browser_gif_frame`, `browser_gif_stop` |
| Lotes | `browser_batch` (hasta 20 acciones en una llamada; se detiene en el primer error) |

- **Elementos por `ref` o por `selector`:** `click`, `hover`, `type`, `fill`, `scroll`, `upload`, `text` y `screenshot` aceptan una referencia de `browser_snapshot` o un selector CSS (con `index` para elegir coincidencia). Los selectores y el snapshot entran en iframes del mismo origen.
- **`browser_find`:** todas las palabras deben aparecer, sin distinguir mayúsculas ni acentos; admite `role` y `limit`.
- **`browser_wait`:** por tiempo (hasta 60 s), texto, selector con estado (`present`, `visible`, `enabled`), parte de la URL, desaparición (`gone`) o red en calma (`idle`).
- **`browser_network`:** el listado incluye tamaño y duración, con filtros `urlPattern`, `statusMin` y `failedOnly`. Con `requestId` devuelve el cuerpo de la respuesta, o con `what: "headers"` las cabeceras, el protocolo y los tiempos. `Cookie`, `Authorization` y `Set-Cookie` salen como `[oculto]` salvo `showSecrets: true`.
- **`browser_emulate`:** modo oscuro (`colorScheme`), `reducedMotion`, idioma (`locale`, que cambia `Accept-Language` y `navigator.language`) y geolocalización (solo la ven las páginas que ya tienen permiso de ubicación). Chrome no permite a las extensiones cambiar la zona horaria.
- **`browser_batch`:** `{{ref}}` toma el primer ref del resultado de la acción anterior y `{{ref[2]}}` el tercero.
- **Validación:** los parámetros se comprueban antes de ejecutar; los errores dicen qué falta o sobra, sugieren el nombre correcto e incluyen el uso de la herramienta.
- **`browser_eval`:** espera las promesas que devuelve el código y admite `await` de nivel superior.
- **`browser_screenshot`:** `fullPage`, un solo elemento (`ref`/`selector`), `region`, `format` (jpeg/png), `save` e `inline`.
- **Rutas:** las de `save`, de los GIF y de `browser_upload`/`browser_drop_files` deben estar bajo `/workspace/`, que se traduce a la carpeta del equipo indicada por `WORKSPACE_HOST` (por defecto, dos niveles sobre este directorio).

## Seguridad
- El agente solo ve y controla las pestañas del grupo naranja «OpenCode»; el resto del navegador queda fuera de su alcance.
- El token es obligatorio en el MCP y en el WebSocket.
- El servidor escucha en `0.0.0.0` para que un contenedor pueda llegar a él. Si no usas Docker, restríngelo con `BRIDGE_HOST=127.0.0.1`.
- `browser_eval` ejecuta JavaScript arbitrario en la página: úsalo solo con agentes y modelos en los que confíes.
- Guardar archivos está limitado a `/workspace/`.

## Variables de entorno
| Variable | Por defecto | Uso |
|---|---|---|
| `BRIDGE_PORT` | `8765` | Puerto del servidor |
| `BRIDGE_HOST` | `0.0.0.0` | Interfaz donde escucha |
| `WORKSPACE_HOST` | dos niveles sobre este directorio | Carpeta real que corresponde a `/workspace` |
| `BRIDGE_DEBUG` | — | Registra cada petición HTTP |

## Limitaciones conocidas
- Los iframes de otro origen aparecen en el snapshot, pero su contenido no es accesible.
- No hay búsqueda de elementos en lenguaje natural: `browser_find` y `browser_query` trabajan con texto, roles y selectores.
- La red y la consola se registran desde que la pestaña se abre con `browser_open_tab` o se controla por primera vez.
- Cada cambio en `extension/` exige recargar la extensión en `chrome://extensions`.

## Licencia
[Apache License 2.0](LICENSE). Copyright 2026 Diego Velandia Barajas.
