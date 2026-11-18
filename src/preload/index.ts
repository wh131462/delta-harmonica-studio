/**
 * 预加载脚本：通过 contextBridge 把受控的主进程能力暴露成 window.api。
 * 主窗口与悬浮窗使用同一份 preload；悬浮窗只使用其中一小部分 API。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  GlobalCommand,
  HotkeyRegistrationStatus,
  OverlayCommand,
  OverlaySyncState,
  PlaybackStatus,
  RendererApi,
} from '@shared/types';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

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
    onStatus: (callback) => subscribe<PlaybackStatus>('playback:status', callback),
  },
  windows: {
    list: () => ipcRenderer.invoke('windows:list'),
    focus: (handle) => ipcRenderer.invoke('windows:focus', handle),
  },
  input: {
    check: () => ipcRenderer.invoke('input:check'),
    onGlobalCommand: (callback) => subscribe<GlobalCommand>('input:global-command', callback),
  },
  hotkeys: {
    status: () => ipcRenderer.invoke('hotkeys:status') as Promise<HotkeyRegistrationStatus[]>,
    setRecording: (recording: boolean) => ipcRenderer.invoke('hotkeys:setRecording', recording),
  },
  overlay: {
    setVisible: (visible) => ipcRenderer.invoke('overlay:setVisible', visible),
    syncState: (state) => ipcRenderer.invoke('overlay:syncState', state),
    sendCommand: (command: OverlayCommand) => ipcRenderer.invoke('overlay:command', command),
    onState: (callback) => subscribe<OverlaySyncState>('overlay:state', callback),
    onVisibility: (callback) => subscribe<boolean>('overlay:visibility', callback),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
};

contextBridge.exposeInMainWorld('api', api);
