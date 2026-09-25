const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onAnnot: (cb) => ipcRenderer.on('annot', (_e, evt) => cb(evt)),
});
