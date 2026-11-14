# OpenCode <-> Chrome (puente)

Da a OpenCode (en el contenedor Docker) control de Chrome del host, con herramientas `browser_*` propias.

```
OpenCode (Docker) --MCP/HTTP--> server.js (host :8765) --WebSocket--> extension de Chrome --CDP--> pestanas
```

## Puesta en marcha
1. En el host: `start.bat` (genera `token.txt` la primera vez).
2. Chrome > `chrome://extensions` > Modo desarrollador > Cargar descomprimida > carpeta `extension/`.
3. En las opciones de la extension: host `127.0.0.1:8765` y el contenido de `token.txt`. La insignia "ON" indica conexion.
4. `D:\ProyectNona\opencode.json` ya declara el servidor MCP `navegador` (URL `http://host.docker.internal:8765/mcp` + token).
   OpenCode lo lee al (re)iniciar; si `opencode mcp list` no lo muestra, reinicia `opencode serve` del contenedor.
5. Pulsa el icono de la extension en una pestana para compartirla, o deja que el agente use `browser_open_tab`.

## Seguridad
- Solo se controlan pestanas del grupo naranja "OpenCode"; el resto del navegador es invisible para el agente.
- Token obligatorio en MCP y WebSocket; no lo subas (esta en .gitignore, igual que opencode.json).
- El servidor escucha en 0.0.0.0 para que el contenedor llegue; usa `BRIDGE_HOST` para restringirlo.

## Herramientas (23)
tabs, open_tab, close_tab, focus_tab, goto, snapshot (refs `ref_N`), find, text, screenshot, click, hover, drag,
type, key, scroll, fill, upload (rutas /workspace/... -> host), eval, console, network, viewport, dialog, wait.

## Pendiente
Grabacion GIF, iframes cross-origin en snapshot, prueba de extremo a extremo con Chrome real.
