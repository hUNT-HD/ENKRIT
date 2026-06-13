// ENKRIT — preload.js
const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { pathToFileURL } = require("url");

contextBridge.exposeInMainWorld("electronAPI", {

  // Run local Whisper Python script
  runWhisper: async (videoPath) => {
    return await ipcRenderer.invoke("run-whisper", videoPath);
  },

  // Listen for progress updates from whisper
  onWhisperProgress: (callback) => {
    ipcRenderer.on("whisper-progress", (event, data) => callback(data));
  },

  // Read a file from disk (for loading generated SRT)
  readFile: async (filePath) => {
    return await ipcRenderer.invoke("read-file", filePath);
  },

  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch(_) { return file && file.path ? file.path : ""; }
  },

  toFileUrl: (filePath) => {
    try { return pathToFileURL(filePath).href; }
    catch(_) { return ""; }
  },

  preparePlayable: async (mediaPath) => {
    return await ipcRenderer.invoke("prepare-playable", mediaPath);
  },

  openMediaDialog: async () => {
    return await ipcRenderer.invoke("open-media-dialog");
  },

  openFolderDialog: async () => {
    return await ipcRenderer.invoke("open-folder-dialog");
  },

  // Private vault: block screen capture (Win + Mac) while the vault is open
  setContentProtection: (on) => { ipcRenderer.send("set-content-protection", !!on); },
  // Private vault: OS biometric (mac TouchID; Windows Hello not built-in)
  requestBiometric: async (reason) => await ipcRenderer.invoke("request-biometric", reason),

});

// Library scanning
contextBridge.exposeInMainWorld("libraryAPI", {
  scanLibrary: async () => await ipcRenderer.invoke("scan-library"),
});
