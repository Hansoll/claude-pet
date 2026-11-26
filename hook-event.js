// Claude Code 훅이 호출하는 스크립트. 표준 입력으로 받은 이벤트를 한 줄로 줄여 이벤트 파일에 덧붙인다.
// 설치 시 ~/.claude-pet/ 로 복사되어 단독으로 실행되므로 다른 파일을 불러오지 않는다.
// 어떤 경우에도 Claude의 작업을 막지 않도록 항상 조용히(출력 없이, 종료 코드 0) 끝난다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 설정 상수 (config.js와 같은 값을 쓴다) ──────────────────
const DATA_DIR = path.join(os.homedir(), '.claude-pet');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;   // 이보다 커지면 비우고 새로 쌓는다
const MAX_STDIN_BYTES = 4 * 1024 * 1024;    // 입력이 이보다 크면 읽기를 멈춘다
const STDIN_TIMEOUT_MS = 2000;              // 입력이 오지 않을 때 기다리는 한도
const TEXT_LIMIT = 120;
// 기록할 이벤트 종류
const KEEP_EVENTS = new Set([
  'UserPromptSubmit', 'Stop', 'StopFailure', 'PermissionRequest',
  'Notification', 'Elicitation', 'ElicitationResult', 'SessionEnd',
]);

// 공백을 정리하고 길이를 제한한다
function clip(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 경로에서 파일명만 뽑는다
function baseName(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// 승인을 기다리는 도구를 한 줄로 설명한다
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Bash' || name === 'PowerShell') return '실행: ' + (clip(i.description || i.command, 40) || '명령');
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return '편집: ' + (clip(baseName(i.file_path || i.notebook_path), 34) || '파일');
  if (name === 'Write') return '작성: ' + (clip(baseName(i.file_path), 34) || '파일');
  if (name === 'Read') return '읽기: ' + (clip(baseName(i.file_path), 34) || '파일');
  if (name === 'WebFetch' || name === 'WebSearch') return '웹: ' + (clip(i.url || i.query, 34) || '요청');
  if (typeof name === 'string' && name.startsWith('mcp__')) {
    const parts = name.split('__');
    return '도구: ' + clip(parts[parts.length - 1], 34);
  }
  return clip(String(name || ''), 34);
}

// 훅 입력에서 펫이 쓸 항목만 골라 낸다
function toEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const event = input.hook_event_name;
  if (typeof event !== 'string' || !KEEP_EVENTS.has(event)) return null;
  if (typeof input.session_id !== 'string' || !input.session_id) return null;
  const out = { ts: Date.now(), event, session_id: input.session_id };
  if (typeof input.cwd === 'string') out.cwd = input.cwd;
  if (typeof input.session_title === 'string' && input.session_title) out.session_title = clip(input.session_title, 60);
  if (event === 'PermissionRequest') {
    out.tool_name = clip(String(input.tool_name || ''), 60);
    out.tool_detail = describeTool(input.tool_name, input.tool_input);
    // 펫이 화면 언어로 다시 설명을 만들 수 있게 짧게 줄인 입력 몇 가지만 남긴다 (설명 문장은 한국어로만 만들어지므로)
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const brief = {};
    for (const key of ['file_path', 'notebook_path', 'command', 'description', 'url', 'query', 'pattern', 'skill']) {
      if (typeof ti[key] === 'string' && ti[key]) brief[key] = clip(ti[key], 80);
    }
    if (Object.keys(brief).length) out.tool_input = brief;
  } else if (event === 'Notification') {
    out.notification_type = clip(String(input.notification_type || ''), 40);
    out.message = clip(input.message, TEXT_LIMIT);
  } else if (event === 'StopFailure') {
    out.error = clip(String(input.error || ''), 40);
  } else if (event === 'Elicitation' || event === 'ElicitationResult') {
    out.mcp_server = clip(String(input.mcp_server_name || input.mcp_server || ''), 40);
  } else if (event === 'SessionEnd') {
    out.reason = clip(String(input.reason || ''), 40);
  }
  return out;
}

// 이벤트 한 줄을 파일에 덧붙인다
function appendEvent(event) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    if (fs.statSync(EVENTS_FILE).size > MAX_EVENTS_BYTES) fs.truncateSync(EVENTS_FILE, 0);
  } catch (_) { /* 파일이 아직 없으면 그대로 진행 */ }
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
}

// 입력을 다 읽은 뒤 처리한다
function handle(raw) {
  try {
    const text = raw.replace(/^﻿/, '').trim();
    if (!text) return;
    const event = toEvent(JSON.parse(text));
    if (event) appendEvent(event);
  } catch (_) { /* 실패해도 Claude 작업에는 영향을 주지 않는다 */ }
}

// 표준 입력을 다 읽어 기록하고 조용히 끝낸다. 실행 파일(배포판)이 "--claude-pet-hook"으로 불릴 때도 이 함수를 쓴다
function runFromStdin() {
  const chunks = [];
  let size = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    handle(Buffer.concat(chunks).toString('utf8'));
    process.exit(0);
  };
  const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
  timer.unref();
  try {
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_STDIN_BYTES) chunks.push(chunk);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  } catch (_) {
    finish();
  }
}

// 표준 입력을 한 번에 읽어 기록하고 끝낸다. 배포판 실행 파일(Electron)이 훅으로 불릴 때 쓴다:
// 윈도우의 Electron 본체는 process.stdin으로 파이프 입력을 받지 못해서(2026-11-26 확인) 입력 핸들을 직접 읽는다
function runFromStdinSync() {
  try {
    const raw = fs.readFileSync(0);
    handle(raw.subarray(0, MAX_STDIN_BYTES).toString('utf8'));
  } catch (_) { /* 입력이 없거나 읽을 수 없으면 조용히 끝낸다 */ }
  process.exit(0);
}

// ── 진입점 ──────────────────────────────────────────────────
if (require.main === module) runFromStdin();

module.exports = { toEvent, describeTool, runFromStdin, runFromStdinSync };
