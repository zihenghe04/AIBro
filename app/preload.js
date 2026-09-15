const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workstationDesktop', {
  isDesktop: true,
  platform: process.platform,
  setLanguage: language => ipcRenderer.invoke('workstation:ui-language', language),
  setAppearance: appearance => ipcRenderer.invoke('workstation:ui-appearance', appearance),
  nativeGlass: {
    status: () => ipcRenderer.invoke('workstation:native-glass:status'),
    setRegions: regions => ipcRenderer.invoke('workstation:native-glass:regions', regions)
  },
  openAuthURL: url => ipcRenderer.invoke('workstation:open-auth', url),
  embeddingCredentials: {
    status: () => ipcRenderer.invoke('workstation:embedding-credentials:status'),
    read: options => ipcRenderer.invoke('workstation:embedding-credentials:read', options),
    save: options => ipcRenderer.invoke('workstation:embedding-credentials:save', options),
    remove: () => ipcRenderer.invoke('workstation:embedding-credentials:remove')
  },
  apiCredentials: {
    status: () => ipcRenderer.invoke('workstation:api-credentials:status'),
    read: options => ipcRenderer.invoke('workstation:api-credentials:read', options),
    save: options => ipcRenderer.invoke('workstation:api-credentials:save', options),
    remove: () => ipcRenderer.invoke('workstation:api-credentials:remove')
  }
});
