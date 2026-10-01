'use strict';
const {contextBridge, ipcRenderer} = require('electron');
ipcRenderer.send('quotum:renderer-sandbox', process.sandboxed === true);
const commands = new Set(['app_state', 'save_settings', 'save_desktop_settings', 'reset_secret_key', 'take_over', 'set_autostart', 'reenter', 'quit', 'open_main', 'close_panel', 'report_panel_height']);
contextBridge.exposeInMainWorld('__QUOTUM__', Object.freeze({
  invoke(command, args) {
    if (!commands.has(command)) return Promise.reject(new Error('unknown app command'));
    if (command === 'reset_secret_key' && args !== undefined) return Promise.reject(new Error('secret_key_reset_invalid'));
    return ipcRenderer.invoke('quotum:invoke', command, args);
  },
  /** The app's state whenever it changes; what it returns stops that. */
  watch(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('quotum:state', listener);
    return () => { ipcRenderer.removeListener('quotum:state', listener); };
  },
}));
