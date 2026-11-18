/**
 * 预加载脚本：通过 contextBridge 把受控的主进程能力暴露成 window.api。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { GlobalCommand, PlaybackStatus, RendererApi } from '@shared/types';

const api: RendererApi = {
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    relaunchElevated: () => ipcRenderer.invoke('app:relaunchElevated'),
    openUserData: () => ipcRenderer.invoke('app:openUserData'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    load: (id) => ipcRenderer.invoke('library:load', id),
    save: (score) => ipcRenderer.invoke('library:save', score),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    toggleFavorite: (id) => ipcRenderer.invoke('library:toggleFavorite', id),
    exportScore: (score, format) => ipcRenderer.invoke('library:export', score, format),
    importScoreFile: () => ipcRenderer.invoke('library:importScoreFile'),
  },
  files: {
    pick: (filters) => ipcRenderer.invoke('files:pick', filters),
    save: (request) => ipcRenderer.invoke('files:save', request),
  },
  playback: {
    start: (request) => ipcRenderer.invoke('playback:start', request),
    stop: () => ipcRenderer.invoke('playback:stop'),
    selfTest: () => ipcRenderer.invoke('playback:selfTest'),
    panicRelease: () => ipcRenderer.invoke('playback:panicRelease'),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, status: PlaybackStatus) => callback(status);
      ipcRenderer.on('playback:status', listener);
      return () => ipcRenderer.removeListener('playback:status', listener);
    },
  },
  windows: {
    list: () => ipcRenderer.invoke('windows:list'),
    focus: (handle) => ipcRenderer.invoke('windows:focus', handle),
  },
  input: {
    check: () => ipcRenderer.invoke('input:check'),
    onGlobalCommand: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, command: GlobalCommand) => callback(command);
      ipcRenderer.on('input:global-command', listener);
      return () => ipcRenderer.removeListener('input:global-command', listener);
    },
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('api', api);
