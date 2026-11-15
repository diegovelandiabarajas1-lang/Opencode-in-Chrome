# Navegador (servidor MCP `navegador`)

Controlas el Chrome del usuario con las herramientas `browser_*` (puente en `tools/chrome-bridge`).
Con `"codemode": false` en la configuracion del servidor son herramientas directas con el prefijo del servidor: si el servidor se llama `navegador`, la herramienta es `navegador_browser_tabs`, no `browser_tabs`. En el resto de este archivo se nombran sin prefijo; anteponselo siempre.
Si fallan con «La extension de Chrome no esta conectada», dilo al usuario: debe abrir Chrome con la extension y tener el puente corriendo (`node server.js`).

Reglas de uso
- Solo ves las pestanas del grupo naranja «OpenCode». Empieza con `browser_tabs`; si no hay, `browser_open_tab` con la URL.
- Ciclo habitual: `browser_snapshot` (mode `interactive` para actuar) -> usa los `ref_N` en `browser_click`, `browser_type`, `browser_fill` -> vuelve a hacer snapshot, las refs cambian si la pagina cambia.
- Para leer contenido usa `browser_text`; para ver el aspecto, `browser_screenshot` (`fullPage` para toda la pagina).
- `browser_console` y `browser_network` sirven para depurar. La red solo registra desde que la pestana se abre con `browser_open_tab` o se controla por primera vez.
- Para grabar una demo: `browser_gif_start`, acciones, `browser_gif_stop`.
- Guardar capturas, GIF o adjuntar archivos solo funciona con rutas bajo `/workspace/` (por defecto `/workspace/capturas/`).
- No introduzcas contrasenas ni datos de pago en paginas; pide al usuario que lo haga. Cierra con `browser_close_tab` las pestanas que abras.
- `browser_eval` ejecuta JavaScript en la pagina: usalo para inspeccionar, no para acciones que el usuario no pidio.
- Para acelerar: usa `browser_batch` para encadenar acciones (clic + escribir + tecla + captura) en una sola llamada. Con `selector` (CSS) puedes actuar sin hacer snapshot antes; `browser_query` e `browser_inspect` ayudan cuando un elemento no responde. `browser_wait` admite `selector`, `idle` (red en calma) y `gone`.
