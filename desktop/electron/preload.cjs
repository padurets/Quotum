'use strict';
const {contextBridge, ipcRenderer} = require('electron');
ipcRenderer.send('quotum:renderer-sandbox', process.sandboxed === true);
const commands = new Set(['app_state', 'save_settings', 'take_over', 'set_autostart', 'reenter', 'quit']);
contextBridge.exposeInMainWorld('__QUOTUM__', Object.freeze({
  invoke(command, args) {
    if (!commands.has(command)) return Promise.reject(new Error('unknown app command'));
    return ipcRenderer.invoke('quotum:invoke', command, args);
  },
}));
