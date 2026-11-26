// Claude Code 전역 설정(~/.claude/settings.json)에 클로드 펫 훅을 등록하거나 제거한다.
// 사용법: node install-hooks.js            (등록)
//         node install-hooks.js --uninstall (제거)
//         node install-hooks.js --status    (등록 여부 확인)
// 기존 훅(다른 도구가 등록한 것)은 건드리지 않고, 바꾸기 전에 백업을 남긴다.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.js');

// ── 설정 상수 ───────────────────────────────────────────────
// 등록할 이벤트 (자주 발생하는 도구 호출 이벤트는 넣지 않는다)
const HOOK_EVENTS = [
  'UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest',
  'Notification', 'Elicitation', 'ElicitationResult', 'SessionEnd',
];
// 실행 파일(Electron)로 부르는 훅은 UserPromptSubmit을 뺀다. 윈도우의 Electron은 시작할 때 빈 줄(\r\n)을 출력하는데,
// UserPromptSubmit 훅의 출력은 Claude의 입력에 섞이기 때문이다 (2026-11-26 확인). 턴 시작은 세션 기록으로도 알 수 있다
const APP_HOOK_EVENTS = HOOK_EVENTS.filter((e) => e !== 'UserPromptSubmit');
const HOOK_TIMEOUT_SECONDS = 5;
const SCRIPT_MARK = 'hook-event.js';       // 우리 훅을 알아보는 표식 (스크립트 파일명)
const FOLDER_MARK = '.claude-pet';         // 우리 훅을 알아보는 표식 (설치 폴더명)
const BACKUP_PREFIX = '.claude-pet-backup-';

// 훅 실행 정보를 만든다. 셸을 거치지 않는 실행 형식이라 경로에 공백이 있어도 안전하다
function buildHandler(nodePath, scriptPath) {
  return {
    type: 'command',
    command: nodePath,
    args: [scriptPath],
    timeout: HOOK_TIMEOUT_SECONDS,
    async: true,                           // Claude 작업을 기다리게 하지 않는다
  };
}

// 실행 파일로 부르는 훅 정보를 만든다 (Node.js가 없는 PC용). appDir은 개발용 실행(electron + 폴더)일 때만 준다
function buildAppHandler(execPath, appDir) {
  return {
    type: 'command',
    command: execPath,
    args: appDir ? [appDir, config.HOOK_ARG] : [config.HOOK_ARG],
    timeout: HOOK_TIMEOUT_SECONDS,
    async: true,
  };
}

// 우리 훅인지 확인한다 (스크립트 방식과 실행 파일 방식 둘 다)
function isOurHandler(handler) {
  if (!handler || typeof handler !== 'object') return false;
  const parts = [String(handler.command || '')];
  if (Array.isArray(handler.args)) for (const a of handler.args) parts.push(String(a));
  const joined = parts.join(' ').replace(/\\/g, '/');
  if (Array.isArray(handler.args) && handler.args.includes(config.HOOK_ARG)) return true;
  return joined.includes(SCRIPT_MARK) && joined.includes(FOLDER_MARK);
}

// 등록된 우리 훅이 주어진 이벤트마다 하나씩 있고, 부르는 프로그램과 스크립트가 실제로 있는지 확인한다
function hooksHealthy(settings, events) {
  const list = events || HOOK_EVENTS;
  if (countHooks(settings) < list.length) return false;
  for (const event of list) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const ours = groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks.filter(isOurHandler) : []));
    if (ours.length !== 1) return false;
    const h = ours[0];
    if (!h.command || !fs.existsSync(h.command)) return false;
    const script = Array.isArray(h.args) ? h.args.find((a) => /\.js$/i.test(String(a))) : null;
    if (script && !fs.existsSync(script)) return false;
  }
  return true;
}

// 본체가 시작할 때 부른다: 우리 훅이 없거나 깨져 있으면 이 실행 파일로 다시 등록한다. 출력하지 않는다.
// 결과: { changed, backup, count }. 실패하면 예외 (원본은 그대로 둔다)
function ensureHooks(handler, file, events) {
  const target = file || config.CLAUDE_SETTINGS_FILE;
  const list = events || HOOK_EVENTS;
  const { settings, existed } = readSettings(target);
  if (hooksHealthy(settings, list)) return { changed: false, backup: '', count: countHooks(settings) };
  addHooks(settings, handler, list);
  const backup = writeSettings(target, settings, existed);
  return { changed: true, backup, count: countHooks(settings) };
}

// 메뉴에서 끌 때 부른다: 우리 훅만 지운다. 지운 개수를 돌려준다. 출력하지 않는다
function removeOurHooks(file) {
  const target = file || config.CLAUDE_SETTINGS_FILE;
  const { settings, existed } = readSettings(target);
  if (!existed) return 0;
  const removed = removeHooks(settings);
  if (removed > 0) writeSettings(target, settings, existed);
  return removed;
}

// 우리 훅이 몇 개 등록돼 있는지 (파일이 없거나 깨졌으면 0)
function installedCount(file) {
  try {
    return countHooks(readSettings(file || config.CLAUDE_SETTINGS_FILE).settings);
  } catch (_) {
    return 0;
  }
}

// 설정에서 우리 훅만 걷어 낸다. 걷어 낸 개수를 돌려준다 (settings를 직접 고친다)
function removeHooks(settings) {
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { keptGroups.push(group); continue; }
      const kept = group.hooks.filter((h) => !isOurHandler(h));
      const diff = group.hooks.length - kept.length;
      removed += diff;
      if (diff === 0) keptGroups.push(group);
      else if (kept.length > 0) keptGroups.push(Object.assign({}, group, { hooks: kept }));
    }
    if (keptGroups.length > 0) settings.hooks[event] = keptGroups;
    else delete settings.hooks[event];
  }
  if (removed > 0 && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

// 설정에 우리 훅을 넣는다. 이미 있으면 새 것으로 바꾼다 (settings를 직접 고친다)
function addHooks(settings, handler, events) {
  const list = events || HOOK_EVENTS;
  removeHooks(settings);
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of list) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({ hooks: [Object.assign({}, handler, { args: handler.args.slice() })] });
  }
  return list.length;
}

// 설정에 우리 훅이 몇 개 있는지 센다
function countHooks(settings) {
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object') return 0;
  let count = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group && Array.isArray(group.hooks)) count += group.hooks.filter(isOurHandler).length;
    }
  }
  return count;
}

// 설정 파일을 읽는다. 없으면 빈 설정, 깨졌으면 예외
function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { settings: {}, existed: false };
    throw new Error(`설정 파일을 읽을 수 없음 (${file}): ${e.message}`);
  }
  let settings;
  try {
    settings = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`설정 파일이 올바른 JSON이 아님 (${file}): ${e.message}. 원본은 건드리지 않았습니다.`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`설정 파일의 최상위가 객체가 아님 (${file}). 원본은 건드리지 않았습니다.`);
  }
  return { settings, existed: true };
}

// 날짜를 파일명에 쓸 수 있는 글로 바꾼다
function stamp(date) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 설정 파일을 백업한 뒤 새 내용으로 바꾼다. 백업 경로를 돌려준다
function writeSettings(file, settings, existed) {
  let backup = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (existed) {
      backup = file + BACKUP_PREFIX + stamp(new Date());
      fs.copyFileSync(file, backup);
    }
  } catch (e) {
    throw new Error(`설정 파일 백업 실패 (${file}): ${e.message}. 원본은 건드리지 않았습니다.`);
  }
  const tmp = file + '.claude-pet-tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8'));        // 쓴 내용이 올바른지 확인
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* 임시 파일 정리 실패는 무시 */ }
    throw new Error(`설정 파일 쓰기 실패 (${file}): ${e.message}.${backup ? ` 백업: ${backup}` : ''}`);
  }
  return backup;
}

// 훅 스크립트를 PC별 폴더로 복사한다
function copyHookScript() {
  try {
    fs.mkdirSync(path.dirname(config.HOOK_SCRIPT_INSTALLED), { recursive: true });
    fs.copyFileSync(config.HOOK_SCRIPT_SOURCE, config.HOOK_SCRIPT_INSTALLED);
  } catch (e) {
    throw new Error(`훅 스크립트 복사 실패 (${config.HOOK_SCRIPT_SOURCE} → ${config.HOOK_SCRIPT_INSTALLED}): ${e.message}`);
  }
}

// 등록
function install() {
  copyHookScript();
  const { settings, existed } = readSettings(config.CLAUDE_SETTINGS_FILE);
  const handler = buildHandler(process.execPath, config.HOOK_SCRIPT_INSTALLED);
  const added = addHooks(settings, handler);
  const backup = writeSettings(config.CLAUDE_SETTINGS_FILE, settings, existed);
  console.log(`훅 ${added}개를 등록했습니다: ${config.CLAUDE_SETTINGS_FILE}`);
  if (backup) console.log(`바꾸기 전 설정 백업: ${backup}`);
  console.log(`훅 스크립트: ${config.HOOK_SCRIPT_INSTALLED}`);
  console.log('이미 열려 있는 세션에는 몇 초 뒤 반영되며, 반영되지 않으면 세션을 새로 시작하세요.');
}

// 제거
function uninstall() {
  const { settings, existed } = readSettings(config.CLAUDE_SETTINGS_FILE);
  if (!existed) { console.log('설정 파일이 없어 제거할 훅이 없습니다.'); return; }
  const removed = removeHooks(settings);
  if (removed === 0) { console.log('등록된 클로드 펫 훅이 없습니다.'); return; }
  const backup = writeSettings(config.CLAUDE_SETTINGS_FILE, settings, existed);
  console.log(`훅 ${removed}개를 제거했습니다: ${config.CLAUDE_SETTINGS_FILE}`);
  if (backup) console.log(`바꾸기 전 설정 백업: ${backup}`);
}

// 등록 여부 확인
function status() {
  const { settings } = readSettings(config.CLAUDE_SETTINGS_FILE);
  const count = countHooks(settings);
  console.log(count > 0 ? `클로드 펫 훅 ${count}개가 등록돼 있습니다.` : '클로드 펫 훅이 등록돼 있지 않습니다.');
}

// ── 진입점 ──────────────────────────────────────────────────
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--uninstall')) uninstall();
    else if (args.includes('--status')) status();
    else install();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = {
  HOOK_EVENTS, APP_HOOK_EVENTS, buildHandler, buildAppHandler, isOurHandler, addHooks, removeHooks, countHooks, readSettings, writeSettings,
  hooksHealthy, ensureHooks, removeOurHooks, installedCount,
};
