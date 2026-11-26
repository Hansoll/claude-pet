// 화면(pet.html, settings.html, welcome.html)과 본체(main.js) 사이의 통신 통로. 화면에는 아래 함수들만 노출한다.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 본체가 보내는 채널을 화면의 콜백에 연결한다
function listen(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on(channel, (_event, payload) => {
      try {
        callback(payload);
      } catch (e) {
        console.error(`[preload] ${channel} 처리 중 오류:`, e);
      }
    });
  };
}

contextBridge.exposeInMainWorld('petApi', {
  // 본체 → 펫 화면
  onSettings: listen('pet:settings'),
  onPet: listen('pet:pet'),
  onLayout: listen('pet:layout'),
  onState: listen('pet:state'),
  onNotify: listen('pet:notify'),
  onLook: listen('pet:look'),
  onDragMove: listen('pet:drag-move'),
  onColor: listen('pet:color'),
  onToggleList: listen('pet:toggle-list'),
  // 펫 화면 → 본체
  ready: () => ipcRenderer.send('pet:ready'),
  setIgnoreMouse: (flag) => ipcRenderer.send('pet:ignore-mouse', !!flag),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  acknowledge: () => ipcRenderer.send('pet:ack'),
  openSession: (id) => ipcRenderer.send('pet:open-session', String(id || '')),
  openClaude: () => ipcRenderer.send('pet:open-claude'),
  trayIcon: (dataUrl) => ipcRenderer.send('pet:tray-icon', String(dataUrl || '')),
  sheetError: (key, reason) => ipcRenderer.send('pet:sheet-error', { key: String(key || ''), reason: String(reason || '') }),
  renderError: (key, reason) => ipcRenderer.send('pet:render-error', { key: String(key || ''), reason: String(reason || '') }),
  // 본체 → 펫 꾸미기 창
  onSettingsData: listen('settings:data'),
  onSettingsResult: listen('settings:result'),
  // 펫 꾸미기 창 → 본체
  settingsReady: () => ipcRenderer.send('settings:ready'),
  applyPet: (key) => ipcRenderer.send('settings:apply-pet', String(key || '')),
  refreshPets: () => ipcRenderer.send('settings:refresh'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  setScale: (value) => ipcRenderer.send('pet:set-scale', Number(value)),
  setColor: (value) => ipcRenderer.send('pet:set-color', typeof value === 'string' ? value : null),
  pickImport: () => ipcRenderer.send('settings:pick-import'),
  // 끌어 놓은 파일의 경로를 본체에 넘긴다 (경로는 Electron이 알려 준 실제 파일 경로만 쓴다)
  importFiles: (files) => {
    const paths = [];
    for (const file of Array.from(files || []).slice(0, 20)) {
      try {
        const p = webUtils.getPathForFile(file);
        if (typeof p === 'string' && p) paths.push(p);
      } catch (e) {
        console.error('[preload] 끌어 놓은 파일의 경로를 알 수 없음:', e);
      }
    }
    if (paths.length) ipcRenderer.send('settings:import-files', paths);
    return paths.length;
  },
  deletePet: (key) => ipcRenderer.send('settings:delete-pet', String(key || '')),
  setLanguage: (code) => ipcRenderer.send('app:set-language', String(code || '')),
  // 본체 → 처음 실행 창
  onWelcomeData: listen('welcome:data'),
  // 처음 실행 창 → 본체
  welcomeReady: () => ipcRenderer.send('welcome:ready'),
  welcomeRecheck: () => ipcRenderer.send('welcome:recheck'),
  closeWelcome: () => ipcRenderer.send('welcome:close'),
});
