"use strict";
// Playtime only receives its animation payload and reports that animation's end.
// Avoid constructing the main application's full IPC bridge for every banner.
const { contextBridge, ipcRenderer } = require("electron");
const incoming = new Set(["show-playtime", "start-close-animation"]);
contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    on(channel, callback) {
      if (!incoming.has(channel) || typeof callback !== "function") return;
      const listener = (_event, data) => callback(data);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    send(channel) {
      if (channel === "close-playtime-window") ipcRenderer.send(channel);
    },
  },
});
