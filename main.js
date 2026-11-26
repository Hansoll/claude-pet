// 클로드 펫 본체 (Electron 메인 프로세스).
// 투명하고 항상 위에 뜨는 창을 만들고, 세션 기록과 훅 이벤트를 읽어 화면에 상태를 보낸다.
'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('./config.js');
const petSpec = require('./pets.js');
const { SessionTracker, summaryLine } = require('./sessions.js');
const { TranscriptWatcher, HookEventReader } = require('./watcher.js');
const claudeApp = require('./claude-app.js');
const autostart = require('./autostart.js');
const i18n = require('./i18n.js');
const hookSetup = require('./install-hooks.js');
const petImport = require('./pet-import.js');
const sessionTexts = require('./sessions.js');

// ── 실행 옵션과 상수 ────────────────────────────────────────
const ARGS = process.argv.slice(1);
const HOOK_MODE = ARGS.includes(config.HOOK_ARG);                // Claude Code 훅이 실행 파일을 부른 경우 (이벤트만 기록하고 끝낸다)
const PACKAGED = !!app.isPackaged;                               // 배포용 실행 파일(ClaudePet.exe)로 떴는지
const WELCOME_ARG = ARGS.includes('--welcome');                  // 점검용: 처음 실행 창을 띄운다 (미리보기에서도)
const IMPORT_PET_ARG = argValue('--import-pet=');                // 점검용: 시작 직후 이 압축 파일을 펫으로 가져온다
const LANG_ARG = argValue('--lang=');                            // 점검용: 이번 실행에만 쓸 언어 (ko, en)
const DEMO_MODE = ARGS.includes('--demo');                       // 가짜 상태를 차례로 보여 주는 미리보기
const SNAPSHOT_DIR = argValue('--snapshot=');                    // 미리보기 화면을 PNG로 저장할 폴더
const PET_OVERRIDE = argValue('--pet=');                         // 이번 실행에만 쓸 펫 (저장하지 않음)
const DEMO_CLICK = ARGS.includes('--demo-click');                // 점검용: 미리보기 중 말풍선과 목록 줄을 대신 눌러 본다
const OPEN_SESSION_ARG = argValue('--open-session=');            // 점검용: 시작 직후 이 세션을 Claude 앱에서 연다
const EDGE_ARG = argValue('--edge=');                            // 점검용: 펫을 화면 가장자리에 둔다 (right, left, top-right, top-left)
const SCALE_ARG = Number(argValue('--scale='));                  // 점검용: 이번 실행에만 쓸 크기 배율
const NO_SMOOTH_ARG = ARGS.includes('--no-smooth');              // 점검용: 이번 실행에서 부드러운 움직임을 끈다
const FORCE_SMOOTH_ARG = ARGS.includes('--smooth');              // 점검용: 저장된 설정과 상관없이 이번 실행에서 부드러운 움직임을 켠다
const FAIL_3D_ARG = ARGS.includes('--fail-3d');                  // 점검용: 3D 펫에 깨진 색 지도를 보내 이미지 펫으로 되돌아가는지 본다
const BROKEN_IMAGE_URL = 'data:image/png;base64,AAAA';           // 점검용: 그림으로 읽히지 않는 값
const FPS_3D_ARG = argValue('--fps3d=');                         // 점검용: 3D 펫의 초당 그리는 횟수 "평소,바쁠때" (예: --fps3d=20,40)
const NO_CSS_ANIM_ARG = ARGS.includes('--no-css-anim');          // 점검용: 말풍선·배지의 깜빡임을 끈다 (부하 비교용)
const SELECT_PET_ARG = argValue('--select-pet=');                // 점검용: 시작 직후 펫 꾸미기 창에서 고른 것처럼 이 펫으로 바꾼다 (다시 뜨는 경로 확인)
const SET_COLOR_ARG = argValue('--set-color=');                  // 점검용: 시작 직후 펫 꾸미기 창에서 고른 것처럼 이 색을 저장한다
const SETTINGS_FLAG = '--settings';                              // 시작 직후 펫 꾸미기 창을 연다. 펫 종류가 바뀌어 다시 뜰 때 본체가 스스로 붙인다
const SETTINGS_ARG = ARGS.some((a) => typeof a === 'string' && (a === SETTINGS_FLAG || a.startsWith(SETTINGS_FLAG + '=')));
const SETTINGS_NOTE_ARG = argValue(SETTINGS_FLAG + '=');         // 위 창에 띄울 안내의 종류 ("applied": 펫을 바꾼 직후)
const ONE_TIME_ARGS = ['--snapshot=', '--select-pet=', '--set-color=', '--import-pet=', '--welcome', SETTINGS_FLAG];   // 다시 뜰 때 넘기지 않는 인자
const TRAY_ARG = ARGS.includes('--tray');                        // 점검용: 미리보기에서도 알림 영역 아이콘을 만든다
const SETTINGS_CHECK_STEP_MS = 900;                              // 점검용: 펫 꾸미기 창에서 동작 하나를 해 본 뒤 상태를 읽기까지 기다리는 시간
const SETTINGS_CHECK_MAX_MS = 60 * 1000;                         // 점검용: 펫 꾸미기 창 점검을 기다리는 최대 시간
const SETTINGS_BG = { light: '#f6f5f2', dark: '#1f1e1c' };       // 펫 꾸미기 창이 뜨는 순간의 바탕색 (settings.html과 같은 값)
const WELCOME_DELAY_MS = 1200;                                   // 처음 실행 창을 펫이 뜬 뒤 조금 있다가 띄운다
const AUTOSTART_CHECK_DELAY_MS = 3000;                           // 시작한 뒤 자동 실행 상태를 확인하기까지 기다리는 시간
const PNG_DATA_URL_HEAD = 'data:image/png;base64,';              // 화면이 보내는 아이콘 그림의 형식
const DEMO_FAKE_DRAG_STEPS = 20;            // 점검용: 끌기 흉내에서 보내는 이동 횟수
const DEMO_FAKE_DRAG_DX = 9;                // 점검용: 끌기 흉내의 한 번당 이동량(px)
const SAVE_DEBOUNCE_MS = 600;               // 크기를 끌어 바꾸는 동안 설정 파일을 매번 쓰지 않게 한다
const PANEL_GAP = 8;                        // 말풍선과 화면 끝 사이 여백
const OPEN_THROTTLE_MS = 800;               // 연달아 누른 클릭을 한 번으로 친다
const DEMO_CLICK_DELAY_MS = 700;
const OPEN_ARG_DELAY_MS = 1500;
const DEMO_STEP_MS = 4000;
const SNAPSHOT_STEP_MS = 1800;
const LIVE_SNAPSHOT_DELAY_MS = 5000;        // 실제 실행에서 점검용 화면을 저장하기까지의 시간
const HOOK_CHECK_MS = 60 * 1000;
const TOPMOST_REASSERT_MS = 10 * 1000;
const DRAG_MAX_MS = 2 * 60 * 1000;          // 드래그 종료 신호를 못 받았을 때의 안전 한도
const CURSOR_MOVE_THRESHOLD = 2;            // 이만큼 움직여야 커서가 움직였다고 본다
const LOOK_DEAD_ZONE = 0.45;                // 커서가 펫 위에 있으면 정면을 본다 (펫 높이 대비 비율)
const LOOK_TICK_SLACK_MS = 5;               // 커서 확인 주기 판정 여유
const DEFAULT_STATE = {
  language: '',                             // 'ko' | 'en'. 비어 있으면 처음 실행할 때 컴퓨터 언어로 정해 저장한다
  welcomed: false,                          // 처음 실행 창을 보았는지
  hooks: 'auto',                            // 'auto': 훅이 없거나 깨지면 다시 등록 / 'off': 사용자가 메뉴에서 끔
  petKey: 'project:' + config.DEFAULT_PET_ID,
  scale: config.DEFAULT_SCALE,              // 펫 크기 배율
  sound: true,
  bubble: true,
  smooth: true,                             // 부드러운 움직임 (프레임 겹쳐 넘기기와 탄력)
  color: null,                              // 3D 펫의 몸 색 ("#rrggbb"). null이면 원래 색
  anchor: null,                             // 펫 발밑 가운데의 화면 좌표
};
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;    // 저장하는 색의 형식

// ── 실행 중 상태 ────────────────────────────────────────────
let win = null;
let rendererReady = false;
let settingsWin = null;                     // 펫 꾸미기 창 (열려 있을 때만)
let settingsReady = false;                  // 그 창의 화면이 준비됐는지
let settingsNote = SETTINGS_NOTE_ARG;       // 그 창이 준비되면 한 번 띄울 안내의 종류
let settingsCheck = null;                   // 점검용: 펫 꾸미기 창 점검이 끝나면 풀리는 약속
let welcomeWin = null;                      // 처음 실행 창 (열려 있을 때만)
let welcomeReady = false;
let hookResult = { status: 'unknown', error: '' };   // 이번 실행에서 훅을 확인한 결과 ('on' | 'off' | 'failed')
let reservePets = [];                       // 목록에서 숨긴 펫 (3D를 못 그릴 때 대신 뜨는 모찌 이미지판)
let quitting = false;                       // 프로그램이 끝나는 중인지 (끝나는 동안 생기는 실패는 알리지 않는다)
let state = Object.assign({}, DEFAULT_STATE);
let allPets = [];
let excludedPets = [];                      // 쓸 수 없어 목록에서 뺀 펫과 그 사유 (펫 꾸미기 창에 보여 준다)
let currentPet = null;
let hooksInstalled = false;
let lastSummaryJson = '';
let lastSummary = { primary: null, sessions: [], total: 0, counts: { working: 0, waiting: 0, done: 0, failed: 0 } };
let drag = null;
let lastCursor = null;
let lastCursorMoveAt = 0;
let lastLookJson = '';
let lastLookTickAt = 0;
let lastOpenAt = 0;
const failed3d = new Set();                 // 이번 실행에서 그리기에 실패한 3D 펫 (다시 고르지 않는다)
let gpuEnabled = false;                     // 이번 실행에서 GPU 가속을 켰는지 (시작할 때 고른 펫이 3D일 때만 켠다)
let autostartOn = false;                    // 자동 실행이 켜져 있는지 (시작한 뒤와 켜고 끌 때 확인해 둔 값)
let tray = null;                            // 알림 영역 아이콘
let trayTip = '';                           // 아이콘에 지금 걸려 있는 설명
let trayCustom = false;                     // 화면이 보낸 그림(3D 펫 얼굴)을 쓰고 있는지
const seenChecker = new claudeApp.SeenChecker();   // Claude 앱에서 세션을 직접 봤는지 확인한다
let saveTimer = null;
let logWrites = 0;
const timers = [];
const tracker = new SessionTracker({ config });
const transcriptWatcher = new TranscriptWatcher({ dir: config.TRANSCRIPTS_DIR, config, log });
const hookReader = new HookEventReader({ file: config.HOOK_EVENTS_FILE, config, log });

// 지금 화면 언어 ('ko' | 'en')
function lang() {
  if (LANG_ARG && config.LANGUAGES.includes(LANG_ARG)) return LANG_ARG;
  return config.LANGUAGES.includes(state.language) ? state.language : systemLanguage();
}

// 컴퓨터의 언어로 고른 화면 언어 (한국어가 아니면 영어)
function systemLanguage() {
  try {
    const preferred = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
    return i18n.normalize((preferred && preferred[0]) || app.getLocale());
  } catch (e) {
    return 'en';
  }
}

// 지금 언어의 문구를 꺼낸다
function tr(key, ...args) {
  return i18n.t(lang(), key, ...args);
}

// 펫 이름을 지금 언어로 (pet.json의 displayNames가 있으면 그 값)
function petName(pet) {
  if (!pet) return '';
  return (pet.displayNames && pet.displayNames[lang()]) || pet.displayName || pet.id || '';
}

// 실행 인자에서 "--이름=값" 형태의 값을 꺼낸다
function argValue(prefix) {
  const found = ARGS.find((a) => typeof a === 'string' && a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

// 로그를 파일에 남긴다 (실패해도 앱은 계속 돈다)
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    if (logWrites++ % 200 === 0) rotateLog();
    fs.appendFileSync(config.LOG_FILE, line, 'utf8');
  } catch (_) { /* 로그 기록 실패는 무시 */ }
  if (DEMO_MODE || process.env.CLAUDE_PET_DEBUG) console.log(line.trimEnd());
}

// 로그 파일이 너무 커지면 비운다
function rotateLog() {
  try {
    const stat = fs.statSync(config.LOG_FILE);
    if (stat.size > config.LOG_MAX_BYTES) fs.truncateSync(config.LOG_FILE, 0);
  } catch (_) { /* 파일이 없으면 할 일 없음 */ }
}

// PC별 데이터 폴더를 만든다
function ensureDataDir() {
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    return true;
  } catch (e) {
    console.error(`데이터 폴더를 만들 수 없음 (${config.DATA_DIR}): ${e.message}`);
    return false;
  }
}

// 저장된 설정을 읽는다. 없거나 깨졌으면 기본값
function loadState() {
  const s = Object.assign({}, DEFAULT_STATE);
  try {
    const parsed = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.petKey === 'string' && parsed.petKey) s.petKey = parsed.petKey;
      if (Number.isFinite(parsed.scale)) s.scale = clampScale(parsed.scale);
      else if (typeof parsed.scaleKey === 'string' && config.LEGACY_SCALES[parsed.scaleKey]) s.scale = config.LEGACY_SCALES[parsed.scaleKey];
      if (typeof parsed.sound === 'boolean') s.sound = parsed.sound;
      if (typeof parsed.bubble === 'boolean') s.bubble = parsed.bubble;
      if (typeof parsed.smooth === 'boolean') s.smooth = parsed.smooth;
      if (typeof parsed.color === 'string' && COLOR_PATTERN.test(parsed.color)) s.color = parsed.color.toLowerCase();
      if (config.LANGUAGES.includes(parsed.language)) s.language = parsed.language;
      if (typeof parsed.welcomed === 'boolean') s.welcomed = parsed.welcomed;
      if (parsed.hooks === 'auto' || parsed.hooks === 'off') s.hooks = parsed.hooks;
      if (parsed.anchor && Number.isFinite(parsed.anchor.x) && Number.isFinite(parsed.anchor.y)) {
        s.anchor = { x: parsed.anchor.x, y: parsed.anchor.y };
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log(`설정 파일 읽기 실패 (${config.STATE_FILE}): ${e.message}`);
  }
  return s;
}

// 설정을 저장한다 (임시 파일에 쓴 뒤 바꿔치기)
function saveState() {
  if (DEMO_MODE) return;
  const tmp = config.STATE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, config.STATE_FILE);
  } catch (e) {
    log(`설정 파일 저장 실패 (${config.STATE_FILE}): ${e.message}`);
  }
}

// 크기 배율을 허용 범위와 단계에 맞춘다
function clampScale(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return config.DEFAULT_SCALE;
  const stepped = Math.round(v / config.SCALE_STEP) * config.SCALE_STEP;
  return Math.round(Math.min(Math.max(stepped, config.SCALE_MIN), config.SCALE_MAX) * 100) / 100;
}

// 현재 크기 설정에 따른 펫 표시 크기
function petSize() {
  const scale = clampScale(state.scale);
  return { w: Math.round(petSpec.CELL_W * scale), h: Math.round(petSpec.CELL_H * scale) };
}

// 창 크기. 펫 크기와 상관없이 일정하다 (가장 큰 펫 + 말풍선 공간)
function windowSize() {
  return {
    width: Math.max(config.WINDOW_WIDTH, Math.round(petSpec.CELL_W * config.SCALE_MAX)),
    height: Math.round(petSpec.CELL_H * config.SCALE_MAX) + config.PANEL_SPACE,
  };
}

// 처음 실행할 때의 펫 위치 (주 화면 오른쪽 아래)
function defaultAnchor() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - 140, y: area.y + area.height - 16 };
}

// 점검용: 실행 인자로 지정한 화면 가장자리 위치
function edgeAnchor() {
  if (!EDGE_ARG) return null;
  const area = screen.getPrimaryDisplay().workArea;
  const right = area.x + area.width - 1;     // 화면 안쪽의 마지막 픽셀 (옆 모니터로 넘어가지 않게)
  const bottom = area.y + area.height;
  switch (EDGE_ARG) {
    case 'right': return { x: right, y: bottom - 16 };
    case 'left': return { x: area.x, y: bottom - 16 };
    case 'top-right': return { x: right, y: area.y };
    case 'top-left': return { x: area.x, y: area.y };
    default: return null;
  }
}

// 펫이 화면 밖으로 나가지 않게 위치를 보정한다
function clampAnchor(anchor) {
  const p = petSize();
  const point = { x: Math.round(anchor.x), y: Math.round(anchor.y - p.h / 2) };
  const area = screen.getDisplayNearestPoint(point).workArea;
  const minX = area.x + p.w / 2;
  const maxX = area.x + area.width - p.w / 2;
  const minY = area.y + p.h;
  const maxY = area.y + area.height;
  return {
    x: Math.round(Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX))),
    y: Math.round(Math.min(Math.max(anchor.y, minY), Math.max(minY, maxY))),
  };
}

// 창 위치를 펫 위치에 맞추고, 화면에 배치 정보를 보낸다
function applyBounds() {
  if (!win || win.isDestroyed()) return;
  const size = windowSize();
  const p = petSize();
  const area = screen.getDisplayNearestPoint({ x: state.anchor.x, y: Math.round(state.anchor.y - p.h / 2) }).workArea;
  // 펫 위쪽이 좁으면(화면 맨 위 근처) 말풍선을 펫 아래에 둔다
  const spaceAbove = state.anchor.y - p.h - area.y;
  const spaceBelow = area.y + area.height - state.anchor.y;
  const below = spaceAbove < config.MIN_PANEL_SPACE && spaceBelow > spaceAbove;
  // 창은 좌우로 화면 밖에 나가지 않게 두고, 펫이 창 안에서 좌우로 움직인다. 그래야 가장자리에서도 말풍선이 잘리지 않는다
  const maxX = area.x + area.width - size.width;
  const bounds = {
    x: Math.round(Math.min(Math.max(state.anchor.x - size.width / 2, area.x), Math.max(area.x, maxX))),
    y: Math.round(below ? state.anchor.y - p.h : state.anchor.y - size.height),
    width: size.width,
    height: size.height,
  };
  try {
    win.setBounds(bounds);
  } catch (e) {
    log(`창 위치 지정 실패 (${JSON.stringify(bounds)}): ${e.message}`);
    return;
  }
  send('pet:layout', {
    petWidth: p.w,
    petHeight: p.h,
    petLeft: Math.round(state.anchor.x - p.w / 2 - bounds.x),     // 창 왼쪽 끝에서 펫 왼쪽 끝까지
    below,
    panelMaxHeight: Math.max(60, Math.min(config.PANEL_SPACE, below ? spaceBelow : spaceAbove) - PANEL_GAP),
  });
}

// 펫 꾸미기 창에 보낼 크기 정보
function sizePayload() {
  return { scale: clampScale(state.scale), min: config.SCALE_MIN, max: config.SCALE_MAX, step: config.SCALE_STEP };
}

// 크기 배율을 바꾼다 (슬라이더를 끄는 동안 계속 호출된다)
function setScale(value) {
  const next = clampScale(value);
  if (next === state.scale) return;
  state.scale = next;
  state.anchor = clampAnchor(state.anchor);
  applyBounds();
  if (DEMO_MODE) log(`크기 변경: ${next}`);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, SAVE_DEBOUNCE_MS);
}

// 3D 펫의 몸 색을 바꾼다 (펫 꾸미기 창에서 끄는 동안 계속 호출된다). null이나 빈 값은 원래 색
function setColor(value) {
  let next = null;
  if (typeof value === 'string' && value) {
    if (!COLOR_PATTERN.test(value)) { log(`색 값이 올바르지 않아 무시함: ${String(value).slice(0, 20)}`); return; }
    next = value.toLowerCase();
  }
  if (next === state.color) return;
  state.color = next;
  send('pet:color', next);                  // 떠 있는 펫에 바로 입힌다
  if (DEMO_MODE) log(`색 변경: ${next || '원래 색'}`);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, SAVE_DEBOUNCE_MS);
}

// 자동 실행을 켜거나 끈다 (메뉴에서 호출). 실제로 반영됐는지는 autostart.setEnabled가 다시 읽어 확인한다
function toggleAutostart(enable) {
  try {
    // 배포판(ClaudePet.exe)은 실행 파일만 등록한다. 개발용 실행은 Electron과 프로젝트 폴더를 함께 등록한다
    autostart.setEnabled(enable, { electronPath: process.execPath, appDir: PACKAGED ? '' : config.APP_DIR });
    autostartOn = !!enable;
    log(`자동 실행 ${enable ? '켬' : '끔'}`);
  } catch (e) {
    log(`자동 실행 설정 실패: ${e.message}`);
    refreshAutostart();
    try { dialog.showErrorBox(tr('app.name'), tr('dialog.autostartFailed', e.message)); } catch (_) { /* 알림 창 실패는 무시 */ }
  }
}

// 자동 실행이 켜져 있는지 다시 확인해 기억해 둔다 (확인에 0.5초쯤 걸려 메뉴를 열 때마다 하지 않는다)
function refreshAutostart() {
  autostartOn = autostartEnabled();
}

// 자동 실행이 켜져 있는지 확인한다 (확인에 실패하면 꺼진 것으로 본다)
function autostartEnabled() {
  try {
    return autostart.isSupported() && autostart.isEnabled();
  } catch (e) {
    log(`자동 실행 상태 확인 실패: ${e.message}`);
    return false;
  }
}

// 화면으로 메시지를 보낸다
function send(channel, payload) {
  if (!win || win.isDestroyed() || !rendererReady) return;
  try {
    win.webContents.send(channel, payload);
  } catch (e) {
    log(`화면 전송 실패 (${channel}): ${e.message}`);
  }
}

// 펫을 찾을 폴더 목록: 함께 나가는 펫, 압축 파일로 가져온 펫, (설정에서 켰을 때만) 코덱스 앱의 펫 폴더
function petSources() {
  const sources = [
    { dir: config.PROJECT_PETS_DIR, source: 'project' },
    { dir: config.PETS_USER_DIR, source: 'imported' },
  ];
  if (config.INCLUDE_CODEX_PETS) sources.push({ dir: config.CODEX_PETS_DIR, source: 'codex' });
  return sources;
}

// 원하는 펫을 고른다: 지정한 펫 → 기본 펫 → 첫 번째 펫 → 숨긴 대신용 펫. 목록에서 숨긴 펫은 지정해도 고르지 않는다
function choosePet(visible, reserve, wanted) {
  const byWanted = (p) => p.key === wanted || p.id === wanted;
  return visible.find(byWanted)
    || visible.find((p) => p.key === DEFAULT_STATE.petKey)
    || visible[0]
    || reserve.find((p) => p.id === config.FALLBACK_PET_ID)
    || reserve[0]
    || null;
}

// 시작할 때 GPU 가속을 켤지 정한다: 시작할 때 고를 펫이 3D일 때만 켠다
function decideGpu() {
  if (config.DISABLE_GPU) return false;
  try {
    const found = petSpec.discoverPets(petSources());
    const pet = choosePet(found.pets.filter((p) => !p.hidden), found.pets.filter((p) => p.hidden), PET_OVERRIDE || loadState().petKey);
    return !!pet && pet.type === '3d';
  } catch (e) {
    log(`GPU 사용 여부 판단 실패 (끄고 시작함): ${e.message}`);
    return false;
  }
}

// 프로그램을 다시 시작한다 (GPU 가속은 시작할 때만 켜고 끌 수 있어서, 펫 종류가 바뀌면 다시 떠야 한다).
// note는 다시 뜬 뒤 펫 꾸미기 창에 띄울 안내의 종류. 실패하면 false
function relaunch(reason, note) {
  clearTimeout(saveTimer);
  saveState();
  log(`다시 시작: ${reason}`);
  try {
    // 한 번만 쓰는 인자는 다시 뜰 때 넘기지 않는다
    const args = process.argv.slice(1).filter((a) => !ONE_TIME_ARGS.some((prefix) => a.startsWith(prefix)));
    // 펫 꾸미기 창을 열어 둔 채였으면 다시 뜬 뒤에도 그 창을 연다
    if (settingsWin && !settingsWin.isDestroyed()) args.push(`${SETTINGS_FLAG}=${note || 'open'}`);
    app.relaunch({ args });
    // 바로 끝내면 종료 처리를 건너뛰므로 알림 영역 아이콘을 여기서 지운다 (안 지우면 빈 자리가 남는다)
    if (tray && !tray.isDestroyed()) tray.destroy();
    quitting = true;
    app.exit(0);
    return true;
  } catch (e) {
    quitting = false;
    log(`다시 시작 실패: ${e.message}`);
    return false;
  }
}

// 펫 폴더들을 다시 훑는다
function refreshPets() {
  const found = petSpec.discoverPets(petSources());
  for (const e of found.errors) log(`펫 제외 (${e.dir}): ${e.error}`);
  for (const p of found.pets) for (const w of p.warnings) log(`펫 경고 (${p.key}): ${w}`);
  // 규격에 맞지 않아 빠진 펫 폴더는 사유와 함께 따로 모아 둔다 (펫 폴더 자체를 못 읽은 경우는 폴더 하나가 아니라서 뺀다)
  const roots = petSources().map((s) => s.dir);
  excludedPets = found.errors
    .filter((e) => !roots.includes(e.dir))
    .map((e, index) => ({ key: `excluded:${index}:${path.basename(e.dir)}`, name: path.basename(e.dir), source: '', type: 'sprite', error: e.error }));
  // 목록에서 숨긴 펫(3D를 못 그릴 때 대신 뜨는 모찌 이미지판)은 따로 둔다
  reservePets = found.pets.filter((p) => p.hidden);
  // 3D 펫은 설정에서 GPU 가속을 막지 않았고, 이번 실행에서 그리기에 실패한 적이 없을 때만 목록에 넣는다
  allPets = found.pets.filter((p) => {
    if (p.hidden) return false;
    if (p.type !== '3d') return true;
    let reason = '';
    if (config.DISABLE_GPU) { reason = 'pet.error.gpuOff'; log(`3D 펫 제외 (${p.key}): 설정에서 GPU 가속을 껐음`); }
    else if (failed3d.has(p.key)) reason = 'pet.error.render3d';
    if (!reason) return true;
    excludedPets.push({ key: `excluded:${p.key}`, pet: p, source: p.source, type: '3d', errorKey: reason });
    return false;
  });
  currentPet = pickPet();
  if (!currentPet) log(`쓸 수 있는 펫이 없음 (${roots.join(', ')})`);
}

// 저장된 선택 → 기본 펫 → 첫 번째 펫 → 숨긴 대신용 펫 순으로 고른다
function pickPet() {
  return choosePet(allPets, reservePets, PET_OVERRIDE || state.petKey);
}

// 화면에 보낼 3D 펫 정보를 만든다. 색 지도는 화면이 픽셀을 읽을 수 있게 파일 내용을 그대로 실어 보낸다
function pet3dPayload(pet) {
  let matcap;
  try {
    matcap = fs.readFileSync(pet.matcapPath);
  } catch (e) {
    log(`색 지도 읽기 실패 (${pet.matcapPath}): ${e.message}`);
    return null;
  }
  return {
    key: pet.key,
    displayName: petName(pet),
    type: '3d',
    model: pet.model,
    matcapUrl: FAIL_3D_ARG ? BROKEN_IMAGE_URL : `data:image/png;base64,${matcap.toString('base64')}`,
    color: state.color,
    fps: fps3d(),
  };
}

// 3D 펫의 초당 그리는 횟수 (점검용 인자가 있으면 그 값)
function fps3d() {
  const parts = String(FPS_3D_ARG || '').split(',').map(Number);
  if (parts.length === 2 && parts.every((v) => Number.isFinite(v) && v > 0)) return { idle: parts[0], busy: parts[1] };
  return { idle: config.FPS_3D_IDLE, busy: config.FPS_3D_BUSY };
}

// 화면에 보낼 펫 정보를 만든다
function petPayload(pet) {
  if (!pet) return null;
  if (pet.type === '3d') {
    const payload = pet3dPayload(pet);
    if (payload) return payload;
    // 색 지도를 못 읽었으면 이미지 펫으로 대신한다
    const fallback = fallbackFor(pet);
    if (!fallback) return null;
    currentPet = fallback;
    return petPayload(fallback);
  }
  let stamp = 0;
  try { stamp = Math.round(fs.statSync(pet.sheetPath).mtimeMs); } catch (_) { /* 시트가 사라졌으면 화면에서 오류로 처리 */ }
  return {
    key: pet.key,
    displayName: petName(pet),
    type: 'sprite',
    version: pet.version,
    rows: pet.rows,
    cols: petSpec.COLS,
    sheetUrl: pathToFileURL(pet.sheetPath).href + '?v=' + stamp,
    animations: petSpec.ANIMATIONS,
    lookFirstRow: petSpec.LOOK_FIRST_ROW,
    neutralLook: petSpec.NEUTRAL_LOOK,
  };
}

// 지금 펫 정보를 화면에 보낸다. 이미지 펫이면 알림 영역 아이콘도 기본 그림으로 되돌린다
function sendPet() {
  send('pet:pet', petPayload(currentPet));
  if (!currentPet || currentPet.type !== '3d') resetTrayIcon();
}

// 화면에 보낼 설정을 만든다
function settingsPayload() {
  // 미리보기 화면을 저장하는 점검 실행에서는 소리를 내지 않는다
  return {
    sound: state.sound && !(DEMO_MODE && SNAPSHOT_DIR),
    bubble: state.bubble,
    smooth: (state.smooth || FORCE_SMOOTH_ARG) && !NO_SMOOTH_ARG,
    lang: lang(),                           // 화면은 i18n.js로 이 언어의 문구를 꺼낸다
  };
}

// 훅이 설정 파일에 등록돼 있는지 확인한다
function checkHooksInstalled() {
  hooksInstalled = hookSetup.installedCount(config.CLAUDE_SETTINGS_FILE) > 0;
  tracker.setHooksInstalled(hooksInstalled);
}

// 이 실행에 맞는 훅 정보: 배포판은 실행 파일 자신을, 개발용 실행은 Electron과 프로젝트 폴더를 부른다 (Node.js가 없어도 동작)
function hookHandler() {
  return hookSetup.buildAppHandler(process.execPath, PACKAGED ? '' : config.APP_DIR);
}

// 시작할 때 훅을 확인한다: 사용자가 끄지 않았으면, 없거나 깨진 훅을 다시 등록한다 (다른 도구의 훅은 그대로 두고 백업을 남긴다)
function ensureHooksOnStart() {
  if (DEMO_MODE) { hookResult = { status: hookSetup.installedCount(config.CLAUDE_SETTINGS_FILE) > 0 ? 'on' : 'off', error: '' }; return; }
  if (state.hooks === 'off') { hookResult = { status: 'off', error: '' }; checkHooksInstalled(); return; }
  try {
    const result = hookSetup.ensureHooks(hookHandler(), config.CLAUDE_SETTINGS_FILE, hookSetup.APP_HOOK_EVENTS);
    hookResult = { status: 'on', error: '' };
    if (result.changed) log(`훅 등록함 (${result.count}개)${result.backup ? `, 바꾸기 전 설정 백업: ${result.backup}` : ''}`);
  } catch (e) {
    hookResult = { status: 'failed', error: e.message };
    log(`훅 등록 실패: ${e.message}`);
  }
  checkHooksInstalled();
}

// 메뉴에서 훅을 켜거나 끈다. 끄면 우리 훅만 지우고, 다음 실행부터 다시 등록하지 않는다
function setHooksEnabled(enable) {
  state.hooks = enable ? 'auto' : 'off';
  saveState();
  if (enable) {
    ensureHooksOnStart();
  } else {
    try {
      const removed = hookSetup.removeOurHooks(config.CLAUDE_SETTINGS_FILE);
      hookResult = { status: 'off', error: '' };
      log(`훅 제거함 (${removed}개)`);
    } catch (e) {
      log(`훅 제거 실패: ${e.message}`);
      try { dialog.showErrorBox(tr('app.name'), e.message); } catch (_) { /* 알림 창 실패는 무시 */ }
    }
    checkHooksInstalled();
  }
  sendWelcomeData();
}

// 훅 이벤트 파일이 너무 크면 시작할 때 비운다
function trimHookEvents() {
  try {
    const stat = fs.statSync(config.HOOK_EVENTS_FILE);
    if (stat.size > config.HOOK_EVENTS_MAX_BYTES) fs.truncateSync(config.HOOK_EVENTS_FILE, 0);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`훅 이벤트 파일 정리 실패 (${config.HOOK_EVENTS_FILE}): ${e.message}`);
  }
}

// 요약이 바뀌었으면 화면에 보낸다
function pushSummary(summary, force) {
  const json = JSON.stringify(summary);
  if (!force && json === lastSummaryJson) return;
  const before = lastSummary.primary ? `${lastSummary.primary.id}:${lastSummary.primary.state}` : 'idle';
  const after = summary.primary ? `${summary.primary.id}:${summary.primary.state}` : 'idle';
  if (before !== after) log(`대표 상태 변경: ${after}${summary.total > 1 ? ` (세션 ${summary.total}개)` : ''}`);
  lastSummaryJson = json;
  lastSummary = summary;
  send('pet:state', summary);
  updateTrayTip();
}

// 완료·오류 표시가 붙은 세션을 사용자가 Claude 앱에서 직접 열어 봤으면 확인한 것으로 처리한다
function acknowledgeSeenInApp() {
  if (!config.SEEN_IN_APP || DEMO_MODE) return;
  const pending = tracker.unseenFinished();
  seenChecker.forgetExcept(pending.map((p) => p.id));
  for (const item of pending) {
    try {
      if (seenChecker.seenAfter(item.id, item.endedAt) && tracker.acknowledgeSession(item.id)) {
        log(`Claude 앱에서 직접 확인함: ${item.id}`);
      }
    } catch (e) {
      log(`앱에서 확인했는지 알아보기 실패 (${item.id}): ${e.message}`);
    }
  }
}

// 주기 작업: 새 기록과 훅 이벤트를 읽어 상태를 갱신한다
function tick() {
  const now = Date.now();
  try {
    // 훅 이벤트를 먼저 읽는다. 훅이 기록된 시점에는 그 앞의 기록 줄이 이미 디스크에 있기 때문이다
    const hookEvents = hookReader.poll();
    const records = transcriptWatcher.poll(now);
    const items = [];
    for (const ev of hookEvents) items.push({ ts: Number.isFinite(ev.ts) ? ev.ts : now, hook: ev });
    for (const r of records) {
      const parsed = typeof r.rec.timestamp === 'string' ? Date.parse(r.rec.timestamp) : NaN;
      items.push({ ts: Number.isFinite(parsed) ? parsed : -Infinity, record: r });
    }
    items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const item of items) {
      if (item.hook) tracker.applyHook(item.hook, { now });
      else tracker.applyRecord(item.record.sessionId, item.record.rec, { now, replay: item.record.replay });
    }
    tracker.tick(now);
    acknowledgeSeenInApp();
    for (const note of tracker.drainNotifications()) send('pet:notify', { kind: note.kind, title: note.title });
    pushSummary(tracker.summary(now), false);
  } catch (e) {
    log(`상태 갱신 중 오류: ${e.stack || e.message}`);
  }
}

// 커서 위치를 보고 펫이 바라볼 방향을 보낸다 (바라보기가 있는 펫, 대기 상태일 때만)
function lookTick() {
  const is3d = !!currentPet && currentPet.type === '3d';
  const canLook = !!currentPet && (is3d || currentPet.version === 2);
  if (!canLook || drag || lastSummary.primary) {
    sendLook({ active: false, index: null });
    return;
  }
  // 이미지 펫은 16방향뿐이라 자주 볼 필요가 없다
  const tickNow = Date.now();
  if (!is3d && tickNow - lastLookTickAt < config.CURSOR_POLL_MS - LOOK_TICK_SLACK_MS) return;
  lastLookTickAt = tickNow;
  let cursor;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch (e) {
    log(`커서 위치 확인 실패: ${e.message}`);
    return;
  }
  const now = Date.now();
  if (!lastCursor || Math.abs(cursor.x - lastCursor.x) + Math.abs(cursor.y - lastCursor.y) > CURSOR_MOVE_THRESHOLD) {
    lastCursor = cursor;
    lastCursorMoveAt = now;
  }
  if (now - lastCursorMoveAt > config.LOOK_ACTIVE_MS) {
    sendLook({ active: false, index: null });
    return;
  }
  const p = petSize();
  const dx = cursor.x - state.anchor.x;
  const dy = cursor.y - (state.anchor.y - p.h / 2);
  // 3D 펫은 방향 번호 대신 커서까지의 거리를 그대로 받아 눈을 끊김 없이 돌린다
  if (is3d) { sendLook({ active: true, index: null, dx: Math.round(dx), dy: Math.round(dy) }); return; }
  const near = Math.hypot(dx, dy) < p.h * LOOK_DEAD_ZONE;
  sendLook({ active: true, index: near ? null : petSpec.directionIndex(dx, dy) });
}

// 바라보기 정보가 바뀌었을 때만 보낸다
function sendLook(look) {
  const json = JSON.stringify(look);
  if (json === lastLookJson) return;
  lastLookJson = json;
  send('pet:look', look);
}

// 드래그를 시작한다 (커서를 따라 창을 옮긴다)
function startDrag() {
  if (drag) stopDrag();
  let cursor;
  try {
    cursor = screen.getCursorScreenPoint();
  } catch (e) {
    log(`드래그 시작 실패 (커서 위치 확인): ${e.message}`);
    return;
  }
  if (DEMO_MODE) log('드래그 시작');
  if (DEMO_MODE && DEMO_CLICK) {
    // 점검용: 실제 마우스가 움직이지 않으므로 오른쪽으로 끄는 이동을 대신 보낸다
    let sent = 0;
    const fake = setInterval(() => {
      send('pet:drag-move', { direction: 'right', dx: DEMO_FAKE_DRAG_DX });
      if (++sent >= DEMO_FAKE_DRAG_STEPS) clearInterval(fake);
    }, config.DRAG_POLL_MS);
  }
  drag = { startCursor: cursor, startAnchor: Object.assign({}, state.anchor), startedAt: Date.now(), timer: null };
  drag.timer = setInterval(() => {
    if (!drag) return;
    if (Date.now() - drag.startedAt > DRAG_MAX_MS) { stopDrag(); return; }
    try {
      const c = screen.getCursorScreenPoint();
      const next = clampAnchor({
        x: drag.startAnchor.x + (c.x - drag.startCursor.x),
        y: drag.startAnchor.y + (c.y - drag.startCursor.y),
      });
      const dx = next.x - state.anchor.x;
      if (next.x === state.anchor.x && next.y === state.anchor.y) return;
      state.anchor = next;
      applyBounds();
      if (dx !== 0) send('pet:drag-move', { direction: dx > 0 ? 'right' : 'left', dx });
    } catch (e) {
      log(`드래그 이동 중 오류: ${e.message}`);
    }
  }, config.DRAG_POLL_MS);
}

// 드래그를 끝내고 위치를 저장한다
function stopDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  saveState();
}

// 메뉴 내용을 만든다 (펫을 우클릭했을 때와 알림 영역 아이콘을 눌렀을 때 같은 메뉴를 쓴다)
function menuTemplate() {
  const counts = lastSummary.counts || {};
  const hasFinished = (counts.done || 0) + (counts.failed || 0) > 0;
  const languageItems = config.LANGUAGES.map((code) => ({
    label: i18n.LANGUAGE_NAMES[code] || code, type: 'radio', checked: lang() === code, click: () => setLanguage(code),
  }));
  const template = [
    { label: tr('menu.customize'), click: openSettings },      // 펫 고르기, 크기, 색상, 펫 추가, 목록 새로 고침은 이 창에 모여 있다
    { label: tr('menu.sessions'), click: () => send('pet:toggle-list') },
    { label: tr('menu.clearDone'), enabled: hasFinished, click: () => { tracker.acknowledge(); pushSummary(tracker.summary(Date.now()), true); } },
    { type: 'separator' },
    { label: tr('menu.bubble'), type: 'checkbox', checked: state.bubble, click: (item) => { state.bubble = item.checked; saveState(); send('pet:settings', settingsPayload()); } },
    { label: tr('menu.sound'), type: 'checkbox', checked: state.sound, click: (item) => { state.sound = item.checked; saveState(); send('pet:settings', settingsPayload()); } },
    { label: tr('menu.smooth'), type: 'checkbox', checked: state.smooth, click: (item) => { state.smooth = item.checked; saveState(); send('pet:settings', settingsPayload()); } },
    { label: tr('menu.autostart'), type: 'checkbox', checked: autostartOn, enabled: autostart.isSupported(), click: (item) => toggleAutostart(item.checked) },
    { label: tr('menu.hooks'), type: 'checkbox', checked: hooksInstalled, click: (item) => setHooksEnabled(item.checked) },
    { label: tr('menu.language'), submenu: languageItems },
    { type: 'separator' },
    { label: tr('menu.welcome'), click: openWelcome },
    { label: tr('menu.dataFolder'), click: () => { shell.openPath(config.DATA_DIR).then((err) => { if (err) log(`데이터 폴더 열기 실패: ${err}`); }).catch((e) => log(`데이터 폴더 열기 실패: ${e.message}`)); } },
    { type: 'separator' },
    { label: tr('menu.quit'), click: () => app.quit() },
  ];
  return template;
}

// 우클릭 메뉴를 띄운다
function showContextMenu() {
  if (!win || win.isDestroyed()) return;
  try {
    Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
  } catch (e) {
    log(`메뉴 표시 실패: ${e.message}`);
  }
}

// ── 알림 영역 아이콘 ────────────────────────────────────────

// 그림 하나를 알림 영역에 맞는 크기들로 줄여 아이콘을 만든다. 쓸 수 없는 그림이면 null
function trayImageFrom(source) {
  if (!source || source.isEmpty()) return null;
  const icon = nativeImage.createEmpty();
  config.TRAY_ICON_SIZES.forEach((size, index) => {
    const resized = source.resize({ width: size, height: size, quality: 'best' });
    icon.addRepresentation({ scaleFactor: index + 1, width: size, height: size, buffer: resized.toPNG() });
  });
  return icon.isEmpty() ? null : icon;
}

// 기본 아이콘 그림(파일)을 읽는다. 없거나 깨졌으면 null
function defaultTrayImage() {
  try {
    return trayImageFrom(nativeImage.createFromPath(config.TRAY_ICON_FILE));
  } catch (e) {
    log(`알림 영역 아이콘 그림 읽기 실패 (${config.TRAY_ICON_FILE}): ${e.message}`);
    return null;
  }
}

// 알림 영역 아이콘을 만든다. 실패해도 펫은 그대로 동작한다
function createTray() {
  if (tray || (DEMO_MODE && !TRAY_ARG)) return;
  const image = defaultTrayImage();
  if (!image) { log(`알림 영역 아이콘을 만들지 못함: 그림 파일이 없거나 읽을 수 없음 (${config.TRAY_ICON_FILE})`); return; }
  try {
    tray = new Tray(image);
    const popup = () => {
      try {
        tray.popUpContextMenu(Menu.buildFromTemplate(menuTemplate()));
      } catch (e) {
        log(`알림 영역 메뉴 표시 실패: ${e.message}`);
      }
    };
    tray.on('click', popup);
    tray.on('right-click', popup);
    trayTip = '';
    updateTrayTip();
    log('알림 영역 아이콘 표시함');
  } catch (e) {
    tray = null;
    log(`알림 영역 아이콘을 만들지 못함: ${e.message}`);
  }
}

// 아이콘에 마우스를 올렸을 때 나오는 설명을 지금 상태에 맞춘다
function updateTrayTip() {
  if (!tray || tray.isDestroyed()) return;
  const labels = {};
  for (const s of ['idle', 'working', 'waiting', 'done', 'failed']) labels[s] = tr(`state.${s}`);
  const tip = summaryLine(lastSummary, labels, tr('app.name'));
  if (tip === trayTip) return;
  try {
    tray.setToolTip(tip);
    trayTip = tip;
    if (DEMO_MODE) log(`알림 영역 설명: ${tip}`);
  } catch (e) {
    log(`알림 영역 설명 갱신 실패: ${e.message}`);
  }
}

// 화면이 보낸 펫 얼굴 그림(3D 펫)으로 아이콘을 바꾼다. 그림이 이상하면 무시한다
function onTrayIcon(dataUrl) {
  if (!tray || tray.isDestroyed()) return;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_HEAD) || dataUrl.length > config.TRAY_ICON_MAX_BYTES) {
    log('알림 영역 아이콘 그림이 올바르지 않아 무시함');
    return;
  }
  if (!currentPet || currentPet.type !== '3d') return;       // 그 사이 이미지 펫으로 바뀌었다
  try {
    const image = trayImageFrom(nativeImage.createFromDataURL(dataUrl));
    if (!image) { log('알림 영역 아이콘 그림을 풀 수 없어 무시함'); return; }
    tray.setImage(image);
    trayCustom = true;
    if (SNAPSHOT_DIR) saveTrayIconForCheck(dataUrl);
  } catch (e) {
    log(`알림 영역 아이콘 바꾸기 실패: ${e.message}`);
  }
}

// 이미지 펫으로 바뀌면 기본 그림으로 되돌린다
function resetTrayIcon() {
  if (!tray || tray.isDestroyed() || !trayCustom) return;
  const image = defaultTrayImage();
  if (!image) return;
  try {
    tray.setImage(image);
    trayCustom = false;
  } catch (e) {
    log(`알림 영역 아이콘 되돌리기 실패: ${e.message}`);
  }
}

// 점검용: 화면이 보낸 아이콘 그림을 파일로 남긴다
function saveTrayIconForCheck(dataUrl) {
  const file = path.join(SNAPSHOT_DIR, 'tray-icon.png');
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.slice(PNG_DATA_URL_HEAD.length), 'base64'));
    log(`아이콘 그림 저장: ${file}`);
  } catch (e) {
    log(`아이콘 그림 저장 실패 (${file}): ${e.message}`);
  }
}

// 펫을 바꾼다. 결과를 돌려준다: 'changed'(바로 바꿈), 'relaunching'(다시 뜨는 중), 'relaunch-failed', 'missing'
function selectPet(key) {
  const pet = allPets.find((p) => p.key === key);
  if (!pet) { log(`선택한 펫을 찾을 수 없음 (${key})`); return 'missing'; }
  state.petKey = key;
  saveState();
  // 3D 펫과 이미지 펫 사이를 오가면 GPU 가속을 켜거나 꺼야 하므로 다시 시작한다 (미리보기는 그대로 둔다)
  if (!DEMO_MODE && !config.DISABLE_GPU && (pet.type === '3d') !== gpuEnabled) {
    return relaunch(`펫 종류가 바뀜 (${key}, GPU ${pet.type === '3d' ? '켬' : '끔'})`, 'applied') ? 'relaunching' : 'relaunch-failed';
  }
  currentPet = pet;
  lastLookJson = '';
  sendPet();
  return 'changed';
}

// ── 펫 꾸미기 창 ────────────────────────────────────────────

// 펫 꾸미기 창으로 메시지를 보낸다
function sendSettings(channel, payload) {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsReady) return;
  try {
    settingsWin.webContents.send(channel, payload);
  } catch (e) {
    log(`펫 꾸미기 창 전송 실패 (${channel}): ${e.message}`);
  }
}

// 펫 꾸미기 창의 아래쪽에 안내나 오류를 띄운다
function sendSettingsResult(ok, message) {
  sendSettings('settings:result', { ok: !!ok, message: String(message || '') });
}

// 펫 하나를 펫 꾸미기 창이 미리 볼 수 있는 모양으로 만든다. 파일을 못 읽으면 사유를 실어 보낸다
function settingsPetPayload(pet) {
  const item = {
    key: pet.key, name: petName(pet), source: pet.source, type: pet.type === '3d' ? '3d' : 'sprite',
    deletable: pet.source === 'imported',              // 압축 파일로 가져온 펫만 지울 수 있다
  };
  if (pet.type === '3d') {
    try {
      // 색 지도는 화면이 픽셀을 읽을 수 있게 파일 내용을 그대로 실어 보낸다
      item.three = { model: pet.model, matcapUrl: `data:image/png;base64,${fs.readFileSync(pet.matcapPath).toString('base64')}` };
    } catch (e) {
      log(`펫 꾸미기: 색 지도 읽기 실패 (${pet.matcapPath}): ${e.message}`);
      item.error = tr('settings.fail.empty3d');
    }
    return item;
  }
  try {
    const stamp = Math.round(fs.statSync(pet.sheetPath).mtimeMs);
    item.sprite = {
      sheetUrl: `${pathToFileURL(pet.sheetPath).href}?v=${stamp}`, rows: pet.rows, cols: petSpec.COLS, animations: petSpec.ANIMATIONS,
      version: pet.version, lookFirstRow: petSpec.LOOK_FIRST_ROW, neutralLook: petSpec.NEUTRAL_LOOK,   // v2 펫은 미리보기에서도 커서를 바라본다
    };
  } catch (e) {
    log(`펫 꾸미기: 시트 확인 실패 (${pet.sheetPath}): ${e.message}`);
    item.error = tr('settings.fail.emptySheet');
  }
  return item;
}

// 쓸 수 없는 펫을 펫 꾸미기 창의 카드 모양으로 만든다 (사유는 지금 언어로)
function excludedPayload(entry) {
  const name = entry.pet ? petName(entry.pet) : entry.name;
  // 규격 오류 문장(pets.js)은 한국어로만 있어서, 영어 화면에서는 짧은 안내만 보여 주고 자세한 사유는 로그에 둔다
  const error = entry.errorKey ? tr(entry.errorKey) : (lang() === 'ko' ? entry.error : tr('settings.brokenPet'));
  return { key: entry.key, name, source: entry.source, type: entry.type, error };
}

// 펫 꾸미기 창에 보낼 전체 자료 (펫 목록, 지금 쓰는 펫, 크기, 색, 언어)
function settingsData() {
  return {
    pets: allPets.map(settingsPetPayload).concat(excludedPets.map(excludedPayload)),
    currentKey: currentPet ? currentPet.key : '',
    scale: sizePayload(),
    color: state.color,
    presets: config.COLOR_PRESETS,
    lang: lang(),
    languages: config.LANGUAGES.map((code) => ({ code, name: i18n.LANGUAGE_NAMES[code] || code })),
    gpu: gpuEnabled,                        // 꺼져 있으면 창이 3D 미리보기를 덜 자주 그린다 (GPU 없이 그리면 CPU를 많이 쓴다)
  };
}

// 펫 꾸미기 창의 내용을 지금 상태로 다시 채운다. selectKey를 주면 그 펫을 골라 둔다
function sendSettingsData(selectKey) {
  if (!settingsWin || settingsWin.isDestroyed() || !settingsReady) return;
  try {
    sendSettings('settings:data', Object.assign(settingsData(), selectKey ? { selectKey } : {}));
  } catch (e) {
    log(`펫 꾸미기 자료 만들기 실패: ${e.stack || e.message}`);
  }
}

// 작은 창(펫 꾸미기, 처음 실행)을 놓을 자리: 펫이 있는 화면의 가운데
function centerOnPetScreen(width, height) {
  const point = state.anchor ? { x: Math.round(state.anchor.x), y: Math.round(state.anchor.y) } : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  return {
    x: Math.round(area.x + Math.max(0, (area.width - width) / 2)),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
  };
}

// 보통 창 하나를 만든다 (펫 꾸미기, 처음 실행). 실패하면 null. onClosed는 창이 닫힐 때 부른다
function createToolWindow(file, width, height, title, logName, onClosed) {
  let created = null;
  try {
    created = new BrowserWindow(Object.assign({
      width,
      height,
      useContentSize: true,
      show: false,
      title,
      icon: config.TRAY_ICON_FILE,
      backgroundColor: nativeTheme.shouldUseDarkColors ? SETTINGS_BG.dark : SETTINGS_BG.light,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    }, centerOnPetScreen(width, height)));
    const win2 = created;
    if (process.platform !== 'darwin') win2.removeMenu();       // 윈도우에서는 창마다 메뉴 줄이 붙으므로 뗀다
    win2.on('closed', () => onClosed(win2));
    win2.once('ready-to-show', () => { if (!win2.isDestroyed()) win2.show(); });
    win2.webContents.on('render-process-gone', (_e, details) => {
      if (quitting) return;
      log(`${logName} 창의 화면 프로세스 종료됨 (${details && details.reason}). 창을 닫음`);
      if (!win2.isDestroyed()) win2.destroy();
    });
    win2.webContents.on('console-message', (event, level, message) => {
      // Electron 버전에 따라 인자 형태가 달라 둘 다 처리한다
      const lv = typeof level === 'number' ? level : event && event.level;
      const text = typeof message === 'string' ? message : event && event.message;
      const isProblem = typeof lv === 'number' ? lv >= 2 : (lv === 'warning' || lv === 'error');
      if (isProblem) log(`[${logName}] ${text}`);
    });
    // 창 안의 링크나 끌어 놓은 파일로 다른 페이지가 열리지 않게 한다 (끌어 놓은 압축 파일은 화면이 따로 받는다)
    win2.webContents.on('will-navigate', (event) => event.preventDefault());
    win2.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win2.loadFile(path.join(__dirname, file)).catch((e) => {
      // 불러오는 도중에 창이 닫혔거나 프로그램이 끝나는 중이면 실패가 아니다 (여기서 알림을 띄우면 종료가 막힌다)
      if (quitting || win2.isDestroyed()) return;
      log(`화면 파일 불러오기 실패 (${file}): ${e.message}`);
      win2.destroy();
      // 펫이 멈추지 않게, 기다리지 않는 알림 창으로 알린다
      dialog.showMessageBox({ type: 'error', title: tr('app.name'), message: tr('dialog.windowFailed'), detail: e.message })
        .catch((err) => log(`알림 창 표시 실패: ${err.message}`));
    });
    log(`${logName} 창 엶`);
    return win2;
  } catch (e) {
    log(`${logName} 창을 만들지 못함: ${e.stack || e.message}`);
    if (created && !created.isDestroyed()) { try { created.destroy(); } catch (_) { /* 이미 닫힘 */ } }
    return null;
  }
}

// 이미 열린 창을 앞으로 가져온다. 열려 있었으면 true
function focusIfOpen(target) {
  if (!target || target.isDestroyed()) return false;
  try {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  } catch (e) {
    log(`창을 앞으로 가져오지 못함: ${e.message}`);
  }
  return true;
}

// 펫 꾸미기 창을 연다. 이미 열려 있으면 앞으로 가져온다
function openSettings() {
  if (focusIfOpen(settingsWin)) return;
  settingsReady = false;
  settingsWin = createToolWindow('settings.html', config.SETTINGS_WINDOW_WIDTH, config.SETTINGS_WINDOW_HEIGHT, tr('settings.title'), '펫 꾸미기', (closed) => {
    if (settingsWin === closed) { settingsWin = null; settingsReady = false; }
  });
}

// 펫 꾸미기 창을 닫는다
function closeSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  try {
    settingsWin.close();
  } catch (e) {
    log(`펫 꾸미기 창 닫기 실패: ${e.message}`);
  }
}

// 펫 꾸미기 창의 화면이 준비되면 자료를 보내고, 다시 뜬 직후라면 안내를 한 번 띄운다
function onSettingsReady(event) {
  if (!settingsWin || settingsWin.isDestroyed() || event.sender !== settingsWin.webContents) return;
  settingsReady = true;
  sendSettingsData();
  if (settingsNote === 'applied') sendSettingsResult(true, tr('result.applied'));
  log(`펫 꾸미기 창 준비됨 (펫 ${allPets.length}개, 쓸 수 없는 펫 ${excludedPets.length}개${settingsNote ? `, 안내: ${settingsNote}` : ''})`);
  settingsNote = '';
}

// 펫 꾸미기 창에서 "이 펫으로 바꾸기"를 눌렀을 때
function applyPetFromSettings(key) {
  let outcome;
  try {
    outcome = selectPet(String(key || ''));
  } catch (e) {
    log(`펫 바꾸기 실패 (${key}): ${e.stack || e.message}`);
    sendSettingsResult(false, tr('result.applyFailed', e.message));
    return;
  }
  if (outcome === 'relaunching') return;                 // 곧 다시 뜨고, 그때 창도 다시 열린다
  if (outcome === 'missing') { sendSettingsData(); sendSettingsResult(false, tr('result.missing')); return; }
  if (outcome === 'relaunch-failed') { sendSettingsResult(false, tr('result.relaunchFailed')); return; }
  sendSettingsData();
  sendSettingsResult(true, tr('result.applied'));
}

// 펫 꾸미기 창에서 "새로 고침"을 눌렀을 때: 펫 폴더를 다시 훑고, 그리기에 실패했던 3D 펫도 다시 시도한다
function refreshFromSettings() {
  try {
    failed3d.clear();
    refreshPets();
    lastLookJson = '';
    sendPet();
    sendSettingsData();
    sendSettingsResult(true, allPets.length ? tr('result.found', allPets.length) : tr('result.foundNone'));
  } catch (e) {
    log(`펫 목록 새로 고침 실패: ${e.stack || e.message}`);
    sendSettingsResult(false, tr('result.refreshFailed', e.message));
  }
}

// ── 펫 가져오기 (코덱스 펫 압축 파일) ──────────────────────

// 가져오기 오류를 지금 언어의 문장으로 바꾼다
function importErrorText(error) {
  if (error instanceof petImport.ImportError) {
    if (error.code === 'tooBig') return tr('import.tooBig', Math.round(config.IMPORT_MAX_ZIP_BYTES / 1024 / 1024));
    if (error.code === 'badId') return tr('import.badId', error.detail);
    if (error.code === 'invalid') return lang() === 'ko' ? tr('import.invalid', error.detail) : tr('import.invalid', 'see the log');
    return tr(`import.${error.code}`);
  }
  return tr('import.readFailed');
}

// 이미 있는 펫을 바꿀지 묻는다 (펫 꾸미기 창 위에 띄운다). 바꾸면 true
async function confirmReplace(name) {
  const options = {
    type: 'question', title: tr('app.name'), message: tr('import.exists', name),
    buttons: [tr('import.replace'), tr('import.cancel')], defaultId: 1, cancelId: 1, noLink: true,
  };
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
  const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return answer.response === 0;
}

// 압축 파일들을 펫으로 가져온다. 결과 안내를 펫 꾸미기 창에 띄우고, 마지막으로 가져온 펫을 골라 둔다
async function importPets(files) {
  const list = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f).slice(0, 20);
  if (!list.length) return;
  const added = [];
  const failed = [];
  for (const file of list) {
    const label = path.basename(file);
    let staged = null;
    try {
      staged = petImport.stageArchive(file, {
        targetRoot: config.PETS_USER_DIR,
        maxZipBytes: config.IMPORT_MAX_ZIP_BYTES,
        maxEntryBytes: config.IMPORT_MAX_ENTRY_BYTES,
        maxEntries: config.IMPORT_MAX_ENTRIES,
        idPattern: config.IMPORT_ID_PATTERN,
      });
      if (staged.exists && !(await confirmReplace(staged.name))) {
        petImport.discardStaged(staged);
        failed.push(tr('result.importFailed', label, tr('import.cancelled')));
        continue;
      }
      petImport.commitStaged(staged);
      added.push(staged);
      log(`펫 가져옴: ${staged.id} (${label})`);
    } catch (e) {
      petImport.discardStaged(staged);
      log(`펫 가져오기 실패 (${label}): ${e.message}`);
      failed.push(tr('result.importFailed', label, importErrorText(e)));
    }
  }
  refreshPets();
  const last = added.length ? allPets.find((p) => p.source === 'imported' && p.id === added[added.length - 1].id) : null;
  sendSettingsData(last ? last.key : '');
  if (failed.length) sendSettingsResult(false, failed.join(' / '));
  else if (added.length === 1) sendSettingsResult(true, tr('result.imported', last ? petName(last) : added[0].name));
  else if (added.length > 1) sendSettingsResult(true, tr('result.importedMany', added.length));
}

// "압축 파일에서 펫 추가"를 눌렀을 때: 파일 고르기 창을 띄운다 (고른 경로만 받는다)
async function pickAndImport() {
  try {
    const options = {
      title: tr('import.pick'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: tr('import.filter'), extensions: ['zip'] }],
    };
    const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (!result.canceled) await importPets(result.filePaths);
  } catch (e) {
    log(`펫 가져오기 창 오류: ${e.message}`);
    sendSettingsResult(false, tr('import.readFailed'));
  }
}

// 가져온 펫을 지운다 (묻고 나서). 지금 쓰는 펫이면 기본 펫으로 바꾼다
async function deleteImportedPet(key) {
  const pet = allPets.find((p) => p.key === key && p.source === 'imported');
  if (!pet) { sendSettingsResult(false, tr('result.missing')); return; }
  try {
    const options = {
      type: 'warning', title: tr('app.name'), message: tr('delete.confirm', petName(pet)),
      buttons: [tr('delete.ok'), tr('import.cancel')], defaultId: 1, cancelId: 1, noLink: true,
    };
    const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
    const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (answer.response !== 0) return;
    petImport.removeImported(config.PETS_USER_DIR, pet.dir);
    log(`가져온 펫 지움: ${pet.key}`);
    const wasCurrent = currentPet && currentPet.key === pet.key;
    refreshPets();
    if (wasCurrent) {
      // 지운 펫을 쓰고 있었으면 기본 펫으로 (종류가 바뀌면 다시 뜬다)
      const next = choosePet(allPets, reservePets, DEFAULT_STATE.petKey);
      if (next && selectPet(next.key) === 'relaunching') return;
    }
    lastLookJson = '';
    sendPet();
    sendSettingsData();
    sendSettingsResult(true, tr('result.deleted', petName(pet)));
  } catch (e) {
    log(`가져온 펫 지우기 실패 (${key}): ${e.message}`);
    sendSettingsResult(false, tr('result.deleteFailed', e.message));
  }
}

// ── 언어 ────────────────────────────────────────────────────

// 화면 언어를 바꾼다: 저장하고, 떠 있는 모든 화면과 알림 영역 설명을 다시 그린다 (다시 띄우지 않는다)
function setLanguage(code) {
  if (!config.LANGUAGES.includes(code)) return;
  state.language = code;
  saveState();
  sessionTexts.setLanguage(code);
  send('pet:settings', settingsPayload());
  sendPet();
  trayTip = '';
  updateTrayTip();
  sendSettingsData();
  sendWelcomeData();
  try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(tr('settings.title')); } catch (_) { /* 제목 실패는 무시 */ }
  try { if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.setTitle(tr('welcome.title')); } catch (_) { /* 제목 실패는 무시 */ }
  log(`언어 바꿈: ${code}`);
}

// ── 처음 실행 창 (Claude 연결 확인) ────────────────────────

// 처음 실행 창에 보낼 자료: Claude를 찾은 결과, 훅 상태, 언어
function welcomeData() {
  let found = { transcripts: false, sessionFiles: 0, app: false, accounts: 0 };
  try {
    found = claudeApp.detectInstall({ transcriptsDir: config.TRANSCRIPTS_DIR });
  } catch (e) {
    log(`Claude 찾기 실패: ${e.message}`);
  }
  return {
    lang: lang(),
    languages: config.LANGUAGES.map((code) => ({ code, name: i18n.LANGUAGE_NAMES[code] || code })),
    found,
    // 설정 파일을 지금 다시 읽어 판단한다 (미리보기처럼 시작할 때 훅을 확인하지 않은 실행에서도 맞게 보이도록)
    hooks: { status: hookSetup.installedCount(config.CLAUDE_SETTINGS_FILE) > 0 ? 'on' : hookResult.status === 'failed' ? 'failed' : 'off', error: hookResult.error },
  };
}

// 처음 실행 창으로 자료를 보낸다
function sendWelcomeData() {
  if (!welcomeWin || welcomeWin.isDestroyed() || !welcomeReady) return;
  try {
    welcomeWin.webContents.send('welcome:data', welcomeData());
  } catch (e) {
    log(`처음 실행 창 전송 실패: ${e.message}`);
  }
}

// 처음 실행 창을 연다 (처음 한 번은 자동으로, 그 뒤에는 메뉴의 "연결 상태 보기")
function openWelcome() {
  if (focusIfOpen(welcomeWin)) return;
  welcomeReady = false;
  welcomeWin = createToolWindow('welcome.html', config.WELCOME_WINDOW_WIDTH, config.WELCOME_WINDOW_HEIGHT, tr('welcome.title'), '처음 실행', (closed) => {
    if (welcomeWin !== closed) return;
    welcomeWin = null;
    welcomeReady = false;
    // 창을 한 번 보았으면 다음부터 자동으로 띄우지 않는다
    if (!state.welcomed) { state.welcomed = true; saveState(); }
  });
}

// 처음 실행 창의 화면이 준비되면 자료를 보낸다
function onWelcomeReady(event) {
  if (!welcomeWin || welcomeWin.isDestroyed() || event.sender !== welcomeWin.webContents) return;
  welcomeReady = true;
  sendWelcomeData();
  // 점검용: 미리보기에서 화면 저장 폴더를 주면 처음 실행 창도 그림으로 남긴다
  if (DEMO_MODE && SNAPSHOT_DIR) {
    setTimeout(() => {
      if (!welcomeWin || welcomeWin.isDestroyed()) return;
      const file = path.join(SNAPSHOT_DIR, `welcome-${lang()}.png`);
      welcomeWin.webContents.capturePage()
        .then((image) => { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); fs.writeFileSync(file, image.toPNG()); log(`화면 저장: ${file}`); })
        .catch((e) => log(`처음 실행 창 저장 실패: ${e.message}`));
    }, WELCOME_DELAY_MS);
  }
}

// 처음 실행 창의 "다시 확인": 훅을 다시 확인하고(사용자가 끄지 않았으면 등록) 결과를 다시 보낸다
function recheckFromWelcome() {
  ensureHooksOnStart();
  sendWelcomeData();
}

// 처음 실행 창 닫기
function closeWelcome() {
  if (!welcomeWin || welcomeWin.isDestroyed()) return;
  try { welcomeWin.close(); } catch (e) { log(`처음 실행 창 닫기 실패: ${e.message}`); }
}

// 연달아 누른 클릭인지 확인한다 (맞으면 true)
function openThrottled() {
  const now = Date.now();
  if (now - lastOpenAt < OPEN_THROTTLE_MS) return true;
  lastOpenAt = now;
  return false;
}

// Claude 앱을 연다 (캐릭터를 눌렀을 때). 진행 중인 세션이 있으면 그 세션을, 없으면 마지막 세션을 연다
function openClaude() {
  if (lastSummary.primary) { openSession(lastSummary.primary.id); return; }
  if (openThrottled()) return;
  if (DEMO_MODE) { log('Claude 열기 요청 (미리보기라 실제로 열지 않음)'); return; }
  log('Claude 열기: 진행 중인 세션이 없어 마지막 세션을 엶');
  shell.openExternal(claudeApp.LAST_SESSION_LINK).catch((e) => log(`Claude 앱 열기 실패 (${claudeApp.LAST_SESSION_LINK}): ${e.message}`));
}

// 세션을 Claude 앱에서 연다 (말풍선이나 목록 줄을 눌렀을 때). opts.force는 미리보기에서도 실제로 열게 한다
function openSession(sessionId, opts) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  if (openThrottled()) return;
  if (DEMO_MODE && !(opts && opts.force)) {
    log(`세션 열기 요청 (미리보기라 실제로 열지 않음): ${sessionId}`);
    return;
  }
  let link;
  try {
    link = claudeApp.linkForSession(sessionId);
  } catch (e) {
    log(`앱 세션 찾기 실패 (${sessionId}): ${e.message}`);
    link = { url: claudeApp.FALLBACK_LINK, localId: null };
  }
  log(`세션 열기: ${sessionId} → ${link.localId || '대응하는 앱 세션이 없어 코드 탭만 엶'}`);
  shell.openExternal(link.url).catch((e) => log(`Claude 앱 열기 실패 (${link.url}): ${e.message}`));
  // 열어 본 세션의 완료 표시는 확인한 것으로 처리한다
  if (!DEMO_MODE && tracker.acknowledgeSession(sessionId)) pushSummary(tracker.summary(Date.now()), true);
}

// 3D 펫을 쓸 수 없을 때 대신할 이미지 펫을 찾는다 (pet.json의 fallback → 기본 캐릭터 → 아무 이미지 펫)
function fallbackFor(pet) {
  // 목록에서 숨긴 대신용 펫(모찌 이미지판)도 후보에 넣는다
  const sprites = reservePets.concat(allPets).filter((p) => p.type !== '3d' && p.key !== pet.key);
  return (pet.fallback && sprites.find((p) => p.id === pet.fallback))
    || sprites.find((p) => p.id === config.FALLBACK_PET_ID)
    || sprites[0]
    || null;
}

// 화면이 3D 펫을 그리지 못했을 때 이미지 펫으로 되돌린다. 저장된 선택은 그대로 둬서 다음 실행 때 다시 시도한다
function onRenderError(info) {
  const key = info && typeof info.key === 'string' ? info.key : '';
  const reason = info && typeof info.reason === 'string' ? info.reason.slice(0, 300) : '원인 불명';
  log(`3D 펫 그리기 실패 (${key}): ${reason}`);
  if (!currentPet || currentPet.key !== key || currentPet.type !== '3d') return;
  failed3d.add(key);
  const failed = currentPet;
  const fallback = fallbackFor(failed);
  allPets = allPets.filter((p) => p.key !== key);
  excludedPets.push({ key: `excluded:${key}`, pet: failed, source: failed.source, type: '3d', errorKey: 'pet.error.render3d' });
  if (!fallback) {
    log('대신할 이미지 펫이 없음');
    currentPet = null;
    send('pet:pet', null);
  } else {
    log(`이미지 펫으로 전환: ${fallback.key}`);
    currentPet = fallback;
    lastLookJson = '';
    sendPet();
  }
  // 펫 꾸미기 창이 열려 있으면 바뀐 사정을 알린다
  sendSettingsData();
  sendSettingsResult(false, tr('result.fallback'));
}

// 화면이 시트를 못 읽었을 때 기본 캐릭터로 되돌린다
function onSheetError(info) {
  const key = info && info.key;
  log(`시트 불러오기 실패 (${key}): ${(info && info.reason) || '원인 불명'}`);
  if (!currentPet || currentPet.key !== key) return;
  const fallback = choosePet(allPets.filter((p) => p.key !== key), reservePets.filter((p) => p.key !== key), DEFAULT_STATE.petKey);
  if (!fallback) return;
  currentPet = fallback;
  sendPet();
  sendSettingsData();
  sendSettingsResult(false, tr('result.sheetFailed'));
}

// 창을 만든다
function createWindow() {
  const size = windowSize();
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,                       // 클릭해도 작업 중인 창의 포커스를 뺏지 않는다
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,          // 포커스가 없어도 애니메이션이 멈추지 않게 한다
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) { log(`모든 화면에 표시 설정 실패: ${e.message}`); }
  }
  win.setIgnoreMouseEvents(true, { forward: true });   // 투명한 부분은 클릭이 뒤 창으로 통과한다
  win.on('closed', () => { win = null; rendererReady = false; });
  win.webContents.on('render-process-gone', (_e, details) => {
    log(`화면 프로세스 종료됨 (${details && details.reason})`);
    rendererReady = false;
    if (win && !win.isDestroyed()) win.reload();
  });
  win.webContents.on('console-message', (event, level, message) => {
    // Electron 버전에 따라 인자 형태가 달라 둘 다 처리한다
    const lv = typeof level === 'number' ? level : event && event.level;
    const text = typeof message === 'string' ? message : event && event.message;
    const isProblem = typeof lv === 'number' ? lv >= 2 : (lv === 'warning' || lv === 'error');
    if (isProblem) log(`[화면] ${text}`);
  });
  win.loadFile(path.join(__dirname, 'pet.html')).catch((e) => log(`화면 파일 불러오기 실패 (pet.html): ${e.message}`));
}

// 화면이 준비되면 초기 정보를 보낸다
function onRendererReady() {
  rendererReady = true;
  if (NO_CSS_ANIM_ARG && win && !win.isDestroyed()) {
    win.webContents.insertCSS('* { animation: none !important; }').catch((e) => log(`점검용 스타일 넣기 실패: ${e.message}`));
  }
  send('pet:settings', settingsPayload());
  applyBounds();
  sendPet();
  pushSummary(lastSummary, true);
  if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
}

// 미리보기용 가짜 상태 목록을 만든다
function demoSteps() {
  const now = Date.now();
  const view = (id, st, title, detail, extra) => Object.assign({
    id, state: st, title, detail, startedAt: now - 72000, endedAt: null, durationMs: null, updatedAt: now,
  }, extra || {});
  const empty = { working: 0, waiting: 0, done: 0, failed: 0 };
  const one = (v) => ({ primary: v, sessions: [v], total: 1, counts: Object.assign({}, empty, { [v.state]: 1 }) });
  // 세션 제목은 사용자가 쓴 글이라 언어를 따르지 않지만, 미리보기에서는 화면 언어에 맞춘 예시를 쓴다
  const en = lang() === 'en';
  const titleA = en ? 'Build the desktop pet' : '클로드 펫 만들기';
  const working = view('a', 'working', titleA, tr('tool.edit', 'pet.html'));
  const waiting = view('a', 'waiting', titleA, tr('session.approval', tr('tool.run', 'npm test')));
  const done = view('a', 'done', titleA, '', { endedAt: now, durationMs: 185000 });
  const failed = view('a', 'failed', titleA, tr('error.rate_limit'), { endedAt: now });
  const other = view('b', 'working', en ? 'Weekly review draft' : '주간 리뷰 초안', tr('tool.read', 'weekly.pptx'));
  const third = view('c', 'done', en ? 'Spec review' : '기획서 검토', '', { endedAt: now, durationMs: 64000 });
  return [
    { label: 'idle', summary: { primary: null, sessions: [], total: 0, counts: empty } },
    { label: 'working', summary: one(working) },
    { label: 'waiting', summary: one(waiting), notify: 'waiting' },
    { label: 'done', summary: one(done), notify: 'done' },
    { label: 'failed', summary: one(failed), notify: 'failed' },
    { label: 'list', summary: { primary: waiting, sessions: [waiting, third, other], total: 3, counts: { working: 1, waiting: 1, done: 1, failed: 0 }, demoOpenList: true } },
  ];
}

// 점검용: 미리보기 단계마다 화면에서 대신 해 볼 동작 (마우스를 흉내 낸다)
function demoClickScript(label) {
  const pointer = (selector, events) => `(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var r = el.getBoundingClientRect();
    ${JSON.stringify(events)}.forEach(function (ev) {
      el.dispatchEvent(new PointerEvent(ev.type, { bubbles: true, button: 0, pointerId: 1, clientX: r.left + r.width * ev.at, clientY: r.top + r.height / 2, screenX: 400 + (ev.dx || 0), screenY: 400 }));
    });
    return true;
  })()`;
  const click = (selector) => `(function () { var el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`;
  // 캐릭터를 잡고 0.5초 뒤에 놓는다 (그 사이 본체가 이동을 흉내 내 보낸다)
  const drag = `(function () {
    var el = document.querySelector('#pet');
    if (!el) return false;
    var r = el.getBoundingClientRect();
    function fire(type, dx) { el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, screenX: 400 + dx, screenY: 400 })); }
    fire('pointerdown', 0); fire('pointermove', 60);
    setTimeout(function () { fire('pointerup', 60); }, 500);
    return true;
  })()`;
  // 0.9초 동안 화면 값을 읽어 프레임 겹침과 몸의 변형(떠오름, 눌림, 기울임)이 실제로 일어나는지 센다
  const probe = `(function () { return new Promise(function (resolve) {
    var pet = document.getElementById('pet'), layers = document.querySelectorAll('.layer');
    var seen = { samples: 0, blending: 0, transformed: 0, maxLiftPx: 0, minScaleY: 1, maxScaleY: 1, maxLeanDeg: 0 };
    var started = performance.now();
    var timer = setInterval(function () {
      seen.samples++;
      for (var i = 0; i < layers.length; i++) { var o = parseFloat(getComputedStyle(layers[i]).opacity); if (o > 0.02 && o < 0.98) { seen.blending++; break; } }
      var m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(pet).transform || '');
      if (m) {
        var p = m[1].split(',').map(Number);
        seen.transformed++;
        seen.maxLiftPx = Math.max(seen.maxLiftPx, Math.round(-p[5] * 10) / 10);
        var scaleY = Math.round(Math.hypot(p[2], p[3]) * 1000) / 1000;
        seen.minScaleY = Math.min(seen.minScaleY, scaleY); seen.maxScaleY = Math.max(seen.maxScaleY, scaleY);
        seen.maxLeanDeg = Math.max(seen.maxLeanDeg, Math.round(Math.abs(Math.atan2(p[1], p[0]) * 180 / Math.PI) * 10) / 10);
      }
      if (performance.now() - started > 900) { clearInterval(timer); resolve(seen); }
    }, 8);
  }); })()`;
  // 3D 펫: 화면이 내놓는 점검 값(지금 동작, 그린 장수, 색, 자세)을 읽는다. 이미지 펫이면 null
  const probe3d = `(function () { return typeof window.petDebug === 'function' ? window.petDebug() : null; })()`;
  switch (label) {
    case 'idle': return [{ name: '캐릭터 클릭', script: pointer('#pet', [{ type: 'pointerdown', at: 0.5 }, { type: 'pointerup', at: 0.5 }]) }, { name: '3D 상태 관측', script: probe3d, delay: 1200 }];
    case 'working': return [{ name: '말풍선 클릭', script: click('#bubble') }, { name: '3D 상태 관측', script: probe3d, delay: 1200 }];
    case 'waiting': return [{ name: '캐릭터 끌기', script: drag }, { name: '끌 때 관측', script: probe }, { name: '3D 상태 관측', script: probe3d, delay: 1000 }];
    case 'done': return [{ name: '완료 점프 관측', script: probe, delay: 0 }, { name: '3D 상태 관측', script: probe3d, delay: 1200 }];
    case 'failed': return [{ name: '3D 상태 관측', script: probe3d, delay: 1500 }];
    case 'list': return [{ name: '목록 줄 클릭', script: click('#list .row') }, { name: '3D 상태 관측', script: probe3d, delay: 1200 }];
    default: return [];
  }
}

// 점검용: 펫 꾸미기 창에서 차례로 해 볼 동작 (--demo --demo-click --settings 로 실행했을 때)
function settingsCheckSteps() {
  const click = (selector) => `(function () { var el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`;
  const press = (selector, at) => `(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var r = el.getBoundingClientRect();
    ['pointerdown', 'pointerup'].forEach(function (type) {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: r.left + r.width * ${Number(at)}, clientY: r.top + r.height / 2 }));
    });
    return true;
  })()`;
  const slide = (value) => `(function () {
    var el = document.querySelector('#sizeRange');
    if (!el) return false;
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
  return [
    { label: 'open' },
    { label: 'state-working', script: click('#stateChips .chip[data-state="working"]') },
    { label: 'state-done', script: click('#stateChips .chip[data-state="done"]') },
    { label: 'action-waving', script: click('#actionChips .chip[data-action="waving"]') },
    { label: 'action-running-left', script: click('#actionChips .chip[data-action="running-left"]') },
    { label: 'pick-3d', script: click('#petList .card[data-type="3d"]:not([data-error="true"])') },
    { label: 'color-preset', script: click('#swatches button:nth-child(5)') },
    { label: 'color-hue', script: press('#colorHue', 0.8) },
    { label: 'size-large', script: slide(1) },
    { label: 'pick-sprite', script: click('#petList .card[data-type="sprite"]:not([data-error="true"]):not([data-current="true"])') },
    { label: 'action-jumping', script: click('#actionChips .chip[data-action="jumping"]') },
    { label: 'state-idle-look', script: `(function () {
      var chip = document.querySelector('#stateChips .chip[data-state="idle"]');
      if (!chip) return false;
      chip.click();
      var stage = document.getElementById('stage').getBoundingClientRect();
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: stage.left + 10, clientY: stage.top + 10 }));
      return true;
    })()` },
    { label: 'state-failed', script: click('#stateChips .chip[data-state="failed"]') },
    { label: 'apply', script: click('#apply') },
    { label: 'refresh', script: click('#refresh') },
    { label: 'pick-3d-again', script: click('#petList .card[data-type="3d"]:not([data-error="true"])') },
    { label: 'color-original', script: click('#colorReset') },
    { label: 'size-small', script: slide(0.4) },
    { label: 'pick-broken', script: click('#petList .card[data-error="true"]') },       // 쓸 수 없는 펫이 있을 때만 눌린다
  ];
}

// 점검용: 위 동작을 차례로 해 보고, 단계마다 창의 상태를 로그에 남긴다 (저장 폴더가 있으면 화면도 남긴다)
async function runSettingsCheck() {
  const steps = settingsCheckSteps();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!settingsWin || settingsWin.isDestroyed()) { log(`펫 꾸미기 점검 중단 (${step.label}): 창이 닫혀 있음`); return; }
    try {
      if (step.script && !(await settingsWin.webContents.executeJavaScript(step.script))) log(`펫 꾸미기 점검 (${step.label}): 누를 대상 없음`);
      await pause(SETTINGS_CHECK_STEP_MS);
      if (!settingsWin || settingsWin.isDestroyed()) { log(`펫 꾸미기 점검 중단 (${step.label}): 창이 닫힘`); return; }
      const seen = await settingsWin.webContents.executeJavaScript("typeof window.settingsDebug === 'function' ? window.settingsDebug() : null");
      log(`펫 꾸미기 점검 (${step.label}): ${JSON.stringify(seen)}`);
      if (SNAPSHOT_DIR) {
        const file = path.join(SNAPSHOT_DIR, `settings-${String(i).padStart(2, '0')}-${step.label}.png`);
        fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
        fs.writeFileSync(file, (await settingsWin.webContents.capturePage()).toPNG());
        log(`화면 저장: ${file}`);
      }
    } catch (e) {
      log(`펫 꾸미기 점검 실패 (${step.label}): ${e.message}`);
    }
  }
  log('펫 꾸미기 점검 끝');
}

// 미리보기를 돌린다. 저장 폴더가 지정되면 단계마다 화면을 PNG로 남기고 끝낸다
function runDemo() {
  const steps = demoSteps();
  let index = 0;
  const stepMs = SNAPSHOT_DIR ? SNAPSHOT_STEP_MS : DEMO_STEP_MS;
  if (SNAPSHOT_DIR) {
    try { fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch (e) { log(`화면 저장 폴더 생성 실패 (${SNAPSHOT_DIR}): ${e.message}`); }
  }
  const show = () => {
    const step = steps[index % steps.length];
    pushSummary(step.summary, true);
    if (step.notify) send('pet:notify', { kind: step.notify, title: (step.summary.primary && step.summary.primary.title) || '' });
    log(`미리보기 단계: ${step.label}`);
    // 점검용: 단계마다 클릭·끌기를 대신 해 보고 연결을 확인한다
    for (const action of DEMO_CLICK ? demoClickScript(step.label) : []) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(action.script)
          .then((result) => {
            if (result && typeof result === 'object') log(`점검 관측 (${action.name}): ${JSON.stringify(result)}`);
            else log(`점검 동작 (${action.name}): ${result ? '실행함' : '대상 없음'}`);
          })
          .catch((e) => log(`점검 동작 실패 (${action.name}): ${e.message}`));
      }, Number.isFinite(action.delay) ? action.delay : DEMO_CLICK_DELAY_MS);
    }
  };
  let finishing = false;
  const advance = async () => {
    if (finishing) return;
    if (SNAPSHOT_DIR && win && !win.isDestroyed()) {
      const step = steps[index % steps.length];
      const file = path.join(SNAPSHOT_DIR, `${index}-${step.label}.png`);
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        log(`화면 저장: ${file}`);
      } catch (e) {
        log(`화면 저장 실패 (${file}): ${e.message}`);
      }
      if (index + 1 >= steps.length) {
        // 펫 꾸미기 창 점검이 돌고 있으면 끝날 때까지(최대 한도까지) 기다렸다가 끝낸다
        finishing = true;
        const limit = new Promise((resolve) => setTimeout(resolve, SETTINGS_CHECK_MAX_MS));
        await Promise.race([settingsCheck || Promise.resolve(), limit]);
        app.quit();
        return;
      }
    }
    index++;
    show();
  };
  show();
  timers.push(setInterval(() => { advance().catch((e) => log(`미리보기 진행 오류: ${e.message}`)); }, stepMs));
}

// 점검용: 실제 실행 화면을 한 장 저장한다 (--snapshot=폴더 를 미리보기 없이 줬을 때)
async function captureLive() {
  if (!win || win.isDestroyed()) return;
  const file = path.join(SNAPSHOT_DIR, 'live.png');
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const image = await win.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    log(`화면 저장: ${file} / 대표 세션: ${lastSummary.primary ? `${lastSummary.primary.state} · ${lastSummary.primary.detail}` : '없음'}`);
  } catch (e) {
    log(`화면 저장 실패 (${file}): ${e.message}`);
  }
}

// 통신 채널을 연결한다
function registerIpc() {
  ipcMain.on('pet:ready', onRendererReady);
  ipcMain.on('pet:ignore-mouse', (_e, flag) => {
    if (!win || win.isDestroyed()) return;
    try {
      if (flag) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
    } catch (e) {
      log(`마우스 통과 설정 실패: ${e.message}`);
    }
  });
  ipcMain.on('pet:drag-start', startDrag);
  ipcMain.on('pet:drag-end', stopDrag);
  ipcMain.on('pet:context-menu', showContextMenu);
  ipcMain.on('pet:ack', () => {
    if (DEMO_MODE) { pushSummary({ primary: null, sessions: [], total: 0, counts: { working: 0, waiting: 0, done: 0, failed: 0 } }, true); return; }
    tracker.acknowledge();
    pushSummary(tracker.summary(Date.now()), true);
  });
  ipcMain.on('pet:sheet-error', (_e, info) => onSheetError(info));
  ipcMain.on('pet:open-session', (_e, id) => openSession(id));
  ipcMain.on('pet:open-claude', openClaude);
  ipcMain.on('pet:set-scale', (_e, value) => setScale(value));
  ipcMain.on('pet:set-color', (_e, value) => setColor(value));
  ipcMain.on('pet:tray-icon', (_e, dataUrl) => onTrayIcon(dataUrl));
  ipcMain.on('pet:render-error', (_e, info) => onRenderError(info));
  // 펫 꾸미기 창 (크기와 색은 위의 pet:set-scale, pet:set-color로 온다)
  ipcMain.on('settings:ready', onSettingsReady);
  ipcMain.on('settings:apply-pet', (_e, key) => applyPetFromSettings(key));
  ipcMain.on('settings:refresh', refreshFromSettings);
  ipcMain.on('settings:close', closeSettings);
  ipcMain.on('settings:pick-import', () => { pickAndImport().catch((e) => log(`펫 가져오기 오류: ${e.message}`)); });
  // 끌어 놓은 파일: 펫 꾸미기 창에서 온 것만, 경로 문자열만 받는다 (실제 검사는 importPets가 한다)
  ipcMain.on('settings:import-files', (event, paths) => {
    if (!settingsWin || settingsWin.isDestroyed() || event.sender !== settingsWin.webContents) return;
    importPets(Array.isArray(paths) ? paths : []).catch((e) => log(`펫 가져오기 오류: ${e.message}`));
  });
  ipcMain.on('settings:delete-pet', (_e, key) => { deleteImportedPet(String(key || '')).catch((e) => log(`펫 지우기 오류: ${e.message}`)); });
  ipcMain.on('app:set-language', (_e, code) => setLanguage(String(code || '')));
  // 처음 실행 창
  ipcMain.on('welcome:ready', onWelcomeReady);
  ipcMain.on('welcome:recheck', recheckFromWelcome);
  ipcMain.on('welcome:close', closeWelcome);
}

// 앱 시작
function start() {
  state = loadState();
  if (DEMO_MODE && Number.isFinite(SCALE_ARG) && SCALE_ARG > 0) state.scale = clampScale(SCALE_ARG);
  // 처음 실행이면 컴퓨터 언어로 화면 언어를 정해 저장한다
  if (!state.language) { state.language = systemLanguage(); saveState(); }
  sessionTexts.setLanguage(lang());
  petImport.cleanupTemp(config.PETS_USER_DIR);
  refreshPets();
  state.anchor = clampAnchor((DEMO_MODE && edgeAnchor()) || state.anchor || defaultAnchor());
  registerIpc();
  createWindow();
  createTray();
  if (!DEMO_MODE) setTimeout(refreshAutostart, AUTOSTART_CHECK_DELAY_MS);

  if (DEMO_MODE) {
    ipcMain.once('pet:ready', () => setTimeout(runDemo, 600));
  } else {
    trimHookEvents();
    ensureHooksOnStart();
    tick();
    timers.push(setInterval(tick, config.POLL_MS));
    timers.push(setInterval(checkHooksInstalled, HOOK_CHECK_MS));
    if (SNAPSHOT_DIR) setTimeout(() => { captureLive().catch((e) => log(`화면 저장 오류: ${e.message}`)); }, LIVE_SNAPSHOT_DELAY_MS);
  }
  if (OPEN_SESSION_ARG) setTimeout(() => openSession(OPEN_SESSION_ARG, { force: true }), OPEN_ARG_DELAY_MS);
  // 처음 실행이면 Claude 연결 상태를 보여 준다 (미리보기에서는 --welcome을 줄 때만)
  if (WELCOME_ARG || (!DEMO_MODE && !state.welcomed)) setTimeout(openWelcome, WELCOME_DELAY_MS);
  if (IMPORT_PET_ARG) {
    // 점검용: 펫 꾸미기 창이 뜬 뒤에 가져온다 (창에서 고른 것과 같은 결과를 보려고)
    setTimeout(() => { importPets([IMPORT_PET_ARG]).catch((e) => log(`펫 가져오기 오류: ${e.message}`)); }, OPEN_ARG_DELAY_MS * 2);
  }
  if (SETTINGS_ARG) {
    // 점검용: 창이 준비되면 동작을 차례로 해 본다
    if (DEMO_MODE && DEMO_CLICK) {
      settingsCheck = new Promise((resolve) => {
        ipcMain.once('settings:ready', () => { runSettingsCheck().catch((e) => log(`펫 꾸미기 점검 오류: ${e.message}`)).then(resolve); });
      });
    }
    setTimeout(openSettings, OPEN_ARG_DELAY_MS);
  }
  if (SET_COLOR_ARG || SELECT_PET_ARG) {
    // 펫 꾸미기 창도 함께 여는 실행이면, 그 창이 다 뜬 뒤에 바꾼다 (창에서 누른 것과 같은 순서)
    setTimeout(() => {
      if (SET_COLOR_ARG) setColor(SET_COLOR_ARG === 'none' ? null : SET_COLOR_ARG);
      if (SELECT_PET_ARG) {
        if (SETTINGS_ARG) applyPetFromSettings(SELECT_PET_ARG);
        else selectPet(SELECT_PET_ARG);
      }
    }, SETTINGS_ARG ? OPEN_ARG_DELAY_MS * 2 : OPEN_ARG_DELAY_MS);
  }
  timers.push(setInterval(lookTick, Math.min(config.CURSOR_POLL_MS, config.CURSOR_POLL_3D_MS)));
  timers.push(setInterval(() => {
    if (win && !win.isDestroyed()) {
      try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { log(`항상 위 재설정 실패: ${e.message}`); }
    }
  }, TOPMOST_REASSERT_MS));

  const relocate = () => {
    try {
      state.anchor = clampAnchor(state.anchor);
      applyBounds();
    } catch (e) {
      log(`화면 구성 변경 처리 실패: ${e.message}`);
    }
  };
  screen.on('display-metrics-changed', relocate);
  screen.on('display-removed', relocate);
  screen.on('display-added', relocate);
  log(`시작: 펫 ${currentPet ? currentPet.key : '없음'}, 찾은 펫 ${allPets.length}개, 훅 ${hooksInstalled ? '등록됨' : '없음'}, GPU 가속 ${gpuEnabled ? '켬' : '끔'}${DEMO_MODE ? ', 미리보기' : ''}`);
}

// ── 진입점 ──────────────────────────────────────────────────
if (HOOK_MODE) {
  // Claude Code 훅이 실행 파일을 부른 경우: 이벤트 한 줄만 기록하고 바로 끝낸다 (창, 로그, 중복 실행 검사 없음)
  require('./hook-event.js').runFromStdinSync();
} else {
  startApp();
}

// 펫 프로그램을 시작한다
function startApp() {
process.on('uncaughtException', (e) => log(`처리되지 않은 오류: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log(`처리되지 않은 비동기 오류: ${(e && (e.stack || e.message)) || e}`));

ensureDataDir();
// 미리보기는 실행 중인 펫과 캐시 폴더가 겹치지 않게 따로 쓴다
const USER_DATA_DIR = DEMO_MODE ? config.ELECTRON_DATA_DIR + '-demo' : config.ELECTRON_DATA_DIR;
try {
  app.setPath('userData', USER_DATA_DIR);
} catch (e) {
  log(`Electron 데이터 폴더 지정 실패 (${USER_DATA_DIR}): ${e.message}`);
}
// GPU 가속은 3D 펫을 쓸 때만 켠다. 이미지 펫은 GPU 없이가 더 가볍다 (실측: 켜면 CPU가 코어 1개의 2%에서 8%로 오른다)
gpuEnabled = decideGpu();
if (!gpuEnabled) app.disableHardwareAcceleration();
// 창이 가려진 것으로 판단돼 애니메이션이 멈추는 일을 막는다
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 미리보기는 이미 떠 있는 펫과 따로 돌 수 있게 중복 실행 검사를 하지 않는다
const gotLock = DEMO_MODE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 실행 파일을 한 번 더 누르면 이미 떠 있다는 것을 알 수 있게 펫 꾸미기 창을 띄운다
  app.on('second-instance', () => { log('이미 실행 중이라 새 실행은 종료됨 (펫 꾸미기 창을 띄움)'); openSettings(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    for (const t of timers) clearInterval(t);
    if (drag) stopDrag();
    // 아이콘을 지우지 않고 끝내면 윈도우 알림 영역에 빈 자리가 남는다
    if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch (e) { log(`알림 영역 아이콘 지우기 실패: ${e.message}`); } }
  });
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.hide(); } catch (e) { log(`Dock 아이콘 숨기기 실패: ${e.message}`); }
    }
    start();
  }).catch((e) => {
    log(`시작 실패: ${e.stack || e.message}`);
    app.quit();
  });
}
}
