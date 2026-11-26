// Claude 데스크톱 앱과 연결하는 모듈. 세션 기록의 ID를 앱의 세션 ID로 바꾸고, 그 세션을 여는 링크를 만든다.
// 앱은 세션마다 <데이터 폴더>/claude-code-sessions/<계정>/<조직>/local_<id>.json 파일을 두고,
// 그 안의 cliSessionId에 세션 기록 파일명과 같은 ID를 적어 둔다.
// 같은 파일의 lastFocusedAt에는 사용자가 그 세션을 마지막으로 화면에 띄운 시각이 적힌다.
// 링크 형식(claude://code/continue?session=local_...)과 이 항목들은 앱 코드에서 확인한 것이라 앱이 바뀌면 달라질 수 있다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 설정 상수 ───────────────────────────────────────────────
const SESSIONS_FOLDER = 'claude-code-sessions';
const SESSION_FILE_PATTERN = /^(local_[A-Za-z0-9-]{1,64})\.json$/;   // 앱이 링크에서 받아들이는 ID 형식과 같다
const CLI_ID_PATTERN = /^[A-Za-z0-9_-]{6,100}$/;                     // 세션 기록 ID로 받아들일 형식
const HEAD_BYTES = 4096;                  // cliSessionId는 파일 맨 앞에 있어 앞부분만 읽는다
const MAX_SCAN_DEPTH = 3;                 // 세션 폴더 아래로 내려가는 깊이
const MAX_FULL_SCAN_FILES = 80;           // 앞부분에서 못 찾았을 때 전체를 읽어 볼 파일 수
const MAX_FULL_SCAN_BYTES = 4 * 1024 * 1024;
const LINK_SOURCE = 'claude_pet';
// 대응하는 앱 세션이 없을 때 여는 링크. 앱은 모르는 세션 ID를 받으면 코드 탭 첫 화면을 띄운다
const FALLBACK_LINK = `claude://code/continue?session=local_claude-pet-none&source=${LINK_SOURCE}`;

// 가장 최근에 쓴 세션을 여는 링크 (앱의 "마지막 세션 이어 하기"와 같다)
const LAST_SESSION_LINK = `claude://code/continue?session=last&source=${LINK_SOURCE}`;

// 앱에서 세션을 봤는지 확인할 때 쓰는 값
const FOCUS_HEAD_BYTES = 16 * 1024;       // "마지막으로 띄운 시각"은 파일 앞쪽에 있다
const FOCUS_FULL_READ_MAX_BYTES = 8 * 1024 * 1024;   // 앞쪽에서 못 찾았을 때 전체를 읽는 한도
const FOCUS_RELOCATE_MS = 30 * 1000;      // 앱 세션을 못 찾은 기록 ID를 다시 찾아보는 간격 (터미널 세션은 끝내 못 찾는다)
const FOCUS_PATTERN = /"lastFocusedAt"\s*:\s*(\d{10,16})(?![\d.])/;

const DETECT_MAX_FILES = 5000;            // 처음 실행 창에서 세션 기록을 세는 한도 (많으면 여기서 멈춘다)

const cache = new Map();                  // 세션 기록 ID → { localId, file }

// Claude 앱의 데이터 폴더 후보를 돌려준다
function appDataRoots(platform, env, home) {
  const p = platform || process.platform;
  const e = env || process.env;
  const h = home || os.homedir();
  const roots = [];
  if (p === 'win32') {
    if (e.APPDATA) roots.push(path.join(e.APPDATA, 'Claude'));
    if (e.LOCALAPPDATA) {
      // 스토어 설치본은 LOCALAPPDATA\Claude-Data\<패키지명> 아래에 데이터를 둔다
      const base = path.join(e.LOCALAPPDATA, 'Claude-Data');
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) roots.push(path.join(base, entry.name));
        }
      } catch (_) { /* 폴더가 없으면 후보에서 뺀다 */ }
    }
  } else if (p === 'darwin') {
    roots.push(path.join(h, 'Library', 'Application Support', 'Claude'));
  } else {
    roots.push(path.join(e.XDG_CONFIG_HOME || path.join(h, '.config'), 'Claude'));
  }
  return roots;
}

// 세션 파일 목록을 최근에 바뀐 순으로 모은다: [{ file, localId, mtimeMs, size }]
function listSessionFiles(roots) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;   // 없는 폴더나 읽을 수 없는 폴더는 건너뛴다
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) walk(full, depth + 1);
        continue;
      }
      const match = SESSION_FILE_PATTERN.exec(entry.name);
      if (!match) continue;
      try {
        const stat = fs.statSync(full);
        files.push({ file: full, localId: match[1], mtimeMs: stat.mtimeMs, size: stat.size });
      } catch (_) { /* 훑는 사이 지워진 파일 */ }
    }
  };
  for (const root of roots || []) walk(path.join(root, SESSIONS_FOLDER), 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

// 파일 앞부분을 글자로 읽는다
function readHead(file, bytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const got = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, got);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* 닫기 실패는 무시 */ } }
  }
}

// 세션 기록 ID에 대응하는 앱 세션 파일을 찾는다: { localId, file }. 없으면 null
function locateSession(cliSessionId, options) {
  if (typeof cliSessionId !== 'string' || !CLI_ID_PATTERN.test(cliSessionId)) return null;
  const o = options || {};
  const useCache = !o.roots;                       // 시험에서 폴더를 직접 줄 때는 캐시를 쓰지 않는다
  if (useCache && cache.has(cliSessionId)) return cache.get(cliSessionId);
  const files = listSessionFiles(o.roots || appDataRoots());
  const remember = (item) => {
    const found = { localId: item.localId, file: item.file };
    if (useCache) cache.set(cliSessionId, found);
    return found;
  };

  // 1차: 파일 앞부분의 cliSessionId만 본다
  const headPattern = /"cliSessionId"\s*:\s*"([^"]+)"/;
  for (const item of files) {
    let head;
    try { head = readHead(item.file, HEAD_BYTES); } catch (_) { continue; }
    const match = headPattern.exec(head);
    if (match && match[1] === cliSessionId) return remember(item);
  }
  // 2차: 세션이 이어지며 ID가 바뀐 경우를 위해 파일 전체에서 찾는다
  const fullPattern = new RegExp(`"(?:cliSessionId|lastAssistantCliSessionId)"\\s*:\\s*"${cliSessionId}"`);
  for (const item of files.slice(0, MAX_FULL_SCAN_FILES)) {
    if (item.size > MAX_FULL_SCAN_BYTES) continue;
    let text;
    try { text = fs.readFileSync(item.file, 'utf8'); } catch (_) { continue; }
    if (fullPattern.test(text)) return remember(item);
  }
  return null;
}

// 이 PC의 Claude를 찾는다 (처음 실행 창용). 기록 파일 이름과 폴더만 보고, 내용은 읽지 않는다.
// 결과: { transcripts, sessionFiles, app, accounts }
function detectInstall(options) {
  const o = options || {};
  const result = { transcripts: false, sessionFiles: 0, app: false, accounts: 0 };
  // Claude Code 세션 기록: <projects>/<프로젝트>/<세션>.jsonl
  const dir = o.transcriptsDir;
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { projects = []; }
  for (const project of projects) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, project.name)); } catch (_) { continue; }
    result.sessionFiles += files.filter((f) => f.endsWith('.jsonl')).length;
    if (result.sessionFiles >= DETECT_MAX_FILES) break;
  }
  result.transcripts = result.sessionFiles > 0;
  // Claude 데스크톱 앱: <데이터 폴더>/claude-code-sessions/<계정>/…
  for (const root of o.roots || appDataRoots()) {
    let accounts = [];
    try { accounts = fs.readdirSync(path.join(root, SESSIONS_FOLDER), { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { continue; }
    result.app = true;
    result.accounts += accounts.length;
  }
  return result;
}

// 세션 기록 ID에 대응하는 앱 세션 ID(local_...)를 찾는다. 없으면 null
function findDesktopSessionId(cliSessionId, options) {
  const found = locateSession(cliSessionId, options);
  return found ? found.localId : null;
}

// 앱 세션 파일에서 "그 세션을 마지막으로 화면에 띄운 시각"(ms)을 읽는다. 적혀 있지 않으면 null
// 앱은 세션이 화면에 보이게 될 때(다른 세션에서 넘어오거나, 가려졌던 창이 다시 보일 때) 이 값을 지금 시각으로 바꾼다
function readLastFocusedAt(file) {
  const head = readHead(file, FOCUS_HEAD_BYTES);
  const match = FOCUS_PATTERN.exec(head);
  if (match) return Number(match[1]);
  // 앞쪽에 없으면 파일 전체를 풀어 맨 바깥 항목을 본다
  const stat = fs.statSync(file);
  if (stat.size <= FOCUS_HEAD_BYTES || stat.size > FOCUS_FULL_READ_MAX_BYTES) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data && Number.isFinite(data.lastFocusedAt) ? data.lastFocusedAt : null;
}

// 사용자가 Claude 앱에서 세션을 직접 봤는지 확인하는 도구.
// 같은 파일을 매번 다시 읽지 않도록 수정 시각이 바뀐 때에만 읽는다
class SeenChecker {
  constructor(options) {
    const o = options || {};
    this.roots = o.roots || null;                  // 시험에서 폴더를 직접 줄 때
    this.now = typeof o.now === 'function' ? o.now : Date.now;
    this.entries = new Map();                      // 세션 기록 ID → { file, mtimeMs, focusedAt, lookedUpAt }
  }

  // 세션을 마지막으로 화면에 띄운 시각(ms). 앱 세션이 없거나 읽지 못하면 null
  lastFocusedAt(cliSessionId) {
    if (typeof cliSessionId !== 'string' || !CLI_ID_PATTERN.test(cliSessionId)) return null;
    let entry = this.entries.get(cliSessionId);
    const now = this.now();
    if (!entry || (!entry.file && now - entry.lookedUpAt >= FOCUS_RELOCATE_MS)) {
      const found = locateSession(cliSessionId, this.roots ? { roots: this.roots } : undefined);
      entry = { file: found ? found.file : null, mtimeMs: -1, focusedAt: null, lookedUpAt: now };
      this.entries.set(cliSessionId, entry);
    }
    if (!entry.file) return null;
    try {
      const stat = fs.statSync(entry.file);
      if (stat.mtimeMs !== entry.mtimeMs) {
        entry.focusedAt = readLastFocusedAt(entry.file);
        entry.mtimeMs = stat.mtimeMs;
      }
    } catch (e) {
      // 파일이 사라졌거나 쓰는 도중이라 풀리지 않으면 이번에는 모르는 것으로 하고 다음에 다시 찾는다
      if (e.code === 'ENOENT') { this.entries.delete(cliSessionId); cache.delete(cliSessionId); }
      return null;
    }
    return entry.focusedAt;
  }

  // 작업이 끝난 시각(endedAt, ms) 뒤에 사용자가 앱에서 그 세션을 띄웠으면 true
  seenAfter(cliSessionId, endedAt) {
    if (!Number.isFinite(endedAt)) return false;
    const focusedAt = this.lastFocusedAt(cliSessionId);
    return focusedAt !== null && focusedAt > endedAt;
  }

  // 더는 볼 필요가 없는 세션의 기억을 지운다 (keep: 계속 볼 세션 기록 ID 목록)
  forgetExcept(keep) {
    const wanted = new Set(keep || []);
    for (const id of Array.from(this.entries.keys())) if (!wanted.has(id)) this.entries.delete(id);
  }
}

// 앱 세션을 여는 링크를 만든다
function sessionLink(localId) {
  if (typeof localId !== 'string' || !SESSION_FILE_PATTERN.test(localId + '.json')) return FALLBACK_LINK;
  return `claude://code/continue?session=${localId}&source=${LINK_SOURCE}`;
}

// 세션 기록 ID로 열 링크를 정한다: { url, localId }
function linkForSession(cliSessionId, options) {
  const localId = findDesktopSessionId(cliSessionId, options);
  return { url: localId ? sessionLink(localId) : FALLBACK_LINK, localId };
}

module.exports = {
  appDataRoots, listSessionFiles, findDesktopSessionId, sessionLink, linkForSession,
  readLastFocusedAt, SeenChecker, detectInstall,
  FALLBACK_LINK, LAST_SESSION_LINK,
};
