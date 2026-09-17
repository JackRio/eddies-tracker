const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getCards: () => ipcRenderer.invoke('cards:get'),
  refreshCards: () => ipcRenderer.invoke('cards:refresh'),
  getCollection: () => ipcRenderer.invoke('collection:get'),
  setCollection: (cardId, bucket, value) => ipcRenderer.invoke('collection:set', cardId, bucket, value),
  openCollectionView: () => ipcRenderer.invoke('collection-view:open'),
  backupCollection: () => ipcRenderer.invoke('collection:backup'),
  listBackups: () => ipcRenderer.invoke('collection:listBackups'),
  restoreBackup: (filename) => ipcRenderer.invoke('collection:restoreBackup', filename),
  renameBackup: (filename, label) => ipcRenderer.invoke('collection:renameBackup', filename, label),
  setBackupLocked: (filename, locked) => ipcRenderer.invoke('collection:setBackupLocked', filename, locked),
  overwriteBackup: (filename) => ipcRenderer.invoke('collection:overwriteBackup', filename),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  publishSite: () => ipcRenderer.invoke('publish:run')
});
