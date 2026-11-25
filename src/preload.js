const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('telinha', {
  appInfo: () => ipcRenderer.invoke('app-info'),
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (sel) => ipcRenderer.invoke('select-source', sel),
  probeAudio: () => ipcRenderer.invoke('probe-audio'),
  listAudioApps: () => ipcRenderer.invoke('list-audio-apps'),
  startAudio: (opts) => ipcRenderer.invoke('audio-start', opts),
  stopAudio: () => ipcRenderer.invoke('audio-stop'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  onDeepLink: (cb) => {
    ipcRenderer.removeAllListeners('deep-link');
    ipcRenderer.on('deep-link', (_e, code) => cb(code));
  },
  overlayShow: (sourceId) => ipcRenderer.invoke('overlay-show', sourceId),
  overlayHide: () => ipcRenderer.invoke('overlay-hide'),
  overlayEvent: (evt) => ipcRenderer.send('overlay-event', evt),
  controlStart: (sourceId) => ipcRenderer.invoke('control-start', sourceId),
  controlInput: (ev) => ipcRenderer.send('control-input', ev),
  controlStop: () => ipcRenderer.invoke('control-stop'),
  controlPending: (on) => ipcRenderer.invoke('control-pending', !!on),
  onControlShortcut: (cb) => {
    ipcRenderer.removeAllListeners('control-shortcut');
    ipcRenderer.on('control-shortcut', (_e, action) => cb(action));
  },
  onControlEnded: (cb) => {
    ipcRenderer.removeAllListeners('control-ended');
    ipcRenderer.on('control-ended', () => cb());
  },
  onAudioData: (cb) => {
    ipcRenderer.removeAllListeners('audio-data');
    ipcRenderer.on('audio-data', (_e, data) => cb(data));
  },
  onAudioStatus: (cb) => {
    ipcRenderer.removeAllListeners('audio-status');
    ipcRenderer.on('audio-status', (_e, status) => cb(status));
  },
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: (info) => ipcRenderer.invoke('install-update', info),
  onUpdateProgress: (cb) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (_e, p) => cb(p));
  },
});
