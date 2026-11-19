# Dev test helpers (not part of the app)

Drive the running app through the WebView2 debug port. Start the app with the port open:

    set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
    app\build\WorshipStudio_artefacts\Release\"Worship Studio.exe"

- `cdp.mjs` — `node cdp.mjs eval "<js>"` runs JS in the app UI page (awaits promises, prints JSON);
  `node cdp.mjs shot out.png` screenshots the page. Env `CDP_URL=youtube.com` targets the embedded YouTube page instead.
- `call.js` — defines `__call(name, ...args)` for native functions: `node cdp.mjs eval "$(cat call.js); __call('devices')"`.
- `screen.ps1` — real screen capture of the app window (native views like YouTube only show up here, not in `cdp.mjs shot`).
- `winsize.ps1` — resize the app window (`-W 1366 -H 768`).
- `take_check.py` — measures how far a recorded take sits from the song mix (cross-correlation).

Safety when testing: route the app output to "CABLE Input (VB-Audio Virtual Cable)" with
`__call('setDevices', 'CABLE Input (VB-Audio Virtual Cable)', '')` so nothing plays out loud, record only
"CABLE Output" (never a microphone without JP's OK), and put the output back afterwards (JP's setting is usually
"1 - Smart TV Pro (AMD High Definition Audio Device)" — check `__call('devices')` first).
