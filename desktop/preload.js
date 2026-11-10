// Gives the TV interface a few desktop-only abilities. The same page works without them
// in a browser or a TV-box app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('oompasApp', {
  desktop: true,
  toggleFullscreen: () => ipcRenderer.send('fullscreen'),
  // Size the window's picture area (when it isn't full screen or maximized).
  // Sets the picture area's size once; the window keeps it (and can still be dragged).
  fitWindow: (w, h) => ipcRenderer.send('fit-window', Number(w), Number(h)),
  // Hide YouTube's own on-screen extras (title bar, logo, end cards, pause/ad overlays) in its player.
  setYouTubeClean: on => ipcRenderer.send('yt-clean', !!on),
  // How loud a YouTube video is (YouTube's own measurement, dB against its reference level), for levelling.
  youtubeLoudness: videoId => ipcRenderer.invoke('yt-loudness', String(videoId)),
});
