const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const h = (_e, data) => fn(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('pet', {
  platform: process.platform,
  // pet window
  config: () => ipcRenderer.invoke('pet:config'),
  onConfig: fn => on('pet:config', fn),
  mouse: capture => ipcRenderer.send('pet:mouse', !!capture),
  drag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  click: () => ipcRenderer.send('pet:click'),
  menu: () => ipcRenderer.send('pet:menu'),
  // tasks
  tasks: () => ipcRenderer.invoke('tasks:get'),
  onTasks: fn => on('tasks:update', fn),
  focusT3: () => ipcRenderer.send('t3:focus'),
  openThread: key => ipcRenderer.send('t3:openThread', String(key)),
  threadAction: (key, action) => ipcRenderer.invoke('thread:action', { key, action }),
  enableActions: () => ipcRenderer.invoke('actions:enable'),
  disableActions: () => ipcRenderer.invoke('actions:disable'),
  // panel
  onTab: fn => on('panel:tab', fn),
  pin: pinned => ipcRenderer.send('panel:pin', !!pinned),
  close: () => ipcRenderer.send('panel:close'),
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  setKey: (name, value) => ipcRenderer.invoke('keys:set', { name, value }),
  pets: () => ipcRenderer.invoke('pets:list'),
  onPets: fn => on('pets:list', fn),
  setPet: id => ipcRenderer.invoke('pets:set', id),
  openPetsFolder: () => ipcRenderer.invoke('pets:openFolder'),
  builderStatus: () => ipcRenderer.invoke('builder:status'),
  build: req => ipcRenderer.invoke('builder:start', req),
  cancelBuild: () => ipcRenderer.invoke('builder:cancel'),
  pickReference: () => ipcRenderer.invoke('builder:pickReference'),
  onBuilder: fn => on('builder:update', fn),
  openFile: p => ipcRenderer.invoke('file:open', p),
  fileUrl: p => ipcRenderer.invoke('file:url', p),
});
