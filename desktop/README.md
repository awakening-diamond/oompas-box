# OOMPAS Box desktop app

Electron wrapper around the OOMPAS server (`../pc-server/server.mjs`) and its TV interface (`../pc-server/tv/`).

- `main.js` starts the server with Electron's built-in Node (`ELECTRON_RUN_AS_NODE`) and the bundled FFmpeg,
  keeps its data in the app's user-data folder, and shows `http://127.0.0.1:8090/tv/` in the window. Quitting stops the server.
- `preload.js` gives the page one desktop extra (`window.oompasApp.toggleFullscreen`). The page works without it.
- The TV interface (`pc-server/tv/`) is plain HTML/CSS/JS with no build step. It talks to the server through:
  `/api/state`, `/api/channels`, `/api/guide`, `/api/play`, `/api/settings` (POST), `/api/iptv/refresh` (POST), `/api/log`,
  and plays `/tune/<dial>.ts?viewer=app` (H.264 + AAC in MPEG-TS, via mpegts.js) or IPTV through `/iptv/p` (HLS via hls.js).

## Building

```
npm install
# put FFmpeg builds in ffmpeg/win-x64/ffmpeg.exe, ffmpeg/mac-x64/ffmpeg, ffmpeg/mac-arm64/ffmpeg
#   (ffmpeg-static release b6.1.1: https://github.com/eugeneware/ffmpeg-static/releases)
npm run dist:win     # Windows installer (on Linux this needs wine, including 32-bit wine)
npm run dist:mac     # Mac zips; on a Mac, set mac.identity to sign and notarize properly
```

Mac builds made on Linux are unsigned. Apple Silicon needs at least an ad-hoc signature:
`rcodesign sign "OOMPAS Box.app"` (apple-codesign) on Linux, or `codesign --force --deep -s - "OOMPAS Box.app"` on a Mac.

## Making a TV app later

Everything in the interface works with arrow keys, OK and Back, scales to the screen height, and keeps a safe margin, so
it's already shaped for a remote. The simplest TV app is a thin wrapper that opens the server's page:

- **Android TV / Google TV / Fire TV:** a WebView app (or Capacitor) that asks for the PC's address once and loads
  `http://<pc>:8090/tv/`. Map the remote's Back to `Escape`, and Channel Up/Down and Guide pass through as keys
  (`ChannelUp`, `ChannelDown`, `Guide` are already handled). The PC keeps doing the work (schedules, IPTV, transcoding).
- **Apple TV:** tvOS has no web view, so it would need a native player that uses the same `/api/*` endpoints
  (the streams are standard MPEG-TS and HLS).
- **Standalone (no PC):** the server is plain Node + FFmpeg, so it could run on a small box (Raspberry Pi, NAS) instead of a PC.
