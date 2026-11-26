// 세션 기록 파일(jsonl)과 훅 이벤트 파일을 "새로 추가된 줄만" 이어 읽는 모듈.
'use strict';

const fs = require('fs');
const path = require('path');

// ── 기본값 (config.js 값으로 덮어쓸 수 있다) ────────────────
const DEFAULTS = {
  FULL_SCAN_MS: 5000,
  ACTIVE_FILE_WINDOW_MS: 6 * 60 * 60 * 1000,
  STARTUP_REPLAY_WINDOW_MS: 15 * 60 * 1000,
  STARTUP_TAIL_BYTES: 512 * 1024,
  MAX_READ_BYTES_PER_POLL: 8 * 1024 * 1024,
  MAX_LINE_BYTES: 16 * 1024 * 1024,
};
const TRANSCRIPT_EXT = '.jsonl';
const MAX_LOGGED_PARSE_FAILURES = 5;
const NEWLINE = 0x0a;

// 파일 하나를 끝에서부터 이어 읽는다
class TailReader {
  // opts: { offset, skipPartial, maxReadBytes, maxLineBytes }
  constructor(file, opts) {
    const o = opts || {};
    this.file = file;
    this.offset = Number.isFinite(o.offset) ? o.offset : 0;
    this.skipPartial = !!o.skipPartial;      // 중간부터 읽기 시작했으면 첫 조각 줄은 버린다
    this.maxReadBytes = o.maxReadBytes || DEFAULTS.MAX_READ_BYTES_PER_POLL;
    this.maxLineBytes = o.maxLineBytes || DEFAULTS.MAX_LINE_BYTES;
    this.leftover = Buffer.alloc(0);         // 줄바꿈이 아직 오지 않은 끝 조각
    this.dropping = false;                   // 너무 긴 줄을 버리는 중인지
    this.droppedLines = 0;
    this.missing = false;
    this.mtimeMs = 0;
  }

  // 새로 완성된 줄들을 문자열 배열로 돌려준다
  readLines() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      if (e.code === 'ENOENT') { this.missing = true; return []; }
      throw new Error(`파일 상태 확인 실패 (${this.file}): ${e.message}`);
    }
    this.missing = false;
    this.mtimeMs = stat.mtimeMs;
    if (stat.size < this.offset) {
      // 파일이 다시 쓰여 짧아졌다. 처음부터 다시 읽는다
      this.offset = 0;
      this.leftover = Buffer.alloc(0);
      this.skipPartial = false;
      this.dropping = false;
    }
    if (stat.size === this.offset) return [];

    const want = Math.min(stat.size - this.offset, this.maxReadBytes);
    const buf = Buffer.allocUnsafe(want);
    let fd = null;
    let got = 0;
    try {
      fd = fs.openSync(this.file, 'r');
      got = fs.readSync(fd, buf, 0, want, this.offset);
    } catch (e) {
      throw new Error(`파일 읽기 실패 (${this.file}, 위치 ${this.offset}): ${e.message}`);
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* 닫기 실패는 무시 */ } }
    }
    if (got <= 0) return [];
    this.offset += got;

    const chunk = buf.subarray(0, got);
    const data = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const lines = [];
    let start = 0;
    for (;;) {
      const nl = data.indexOf(NEWLINE, start);
      if (nl === -1) break;
      if (this.skipPartial || this.dropping) {
        this.skipPartial = false;
        this.dropping = false;
      } else if (nl > start) {
        lines.push(data.toString('utf8', start, nl));
      }
      start = nl + 1;
    }
    let rest = data.subarray(start);
    if (this.skipPartial || this.dropping) {
      rest = Buffer.alloc(0);                // 버리는 줄의 끝(줄바꿈)이 아직 안 왔다
    } else if (rest.length > this.maxLineBytes) {
      rest = Buffer.alloc(0);
      this.dropping = true;
      this.droppedLines++;
    }
    this.leftover = Buffer.from(rest);       // 큰 버퍼를 붙잡지 않도록 복사
    return lines;
  }
}

// Claude 세션 기록 폴더를 감시한다
class TranscriptWatcher {
  // opts: { dir, config, log }
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir;
    this.cfg = Object.assign({}, DEFAULTS, o.config || {});
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.files = new Map();
    this.started = false;
    this.lastFullScan = 0;
    this.parseFailures = 0;
  }

  // 새 기록을 모아 돌려준다: [{ sessionId, rec, replay }]
  poll(now) {
    if (!this.started || now - this.lastFullScan >= this.cfg.FULL_SCAN_MS) {
      this._fullScan(now);
      this.lastFullScan = now;
    }
    const out = [];
    for (const [file, info] of Array.from(this.files.entries())) {
      let lines;
      try {
        lines = info.reader.readLines();
      } catch (e) {
        this.log(e.message);
        continue;
      }
      if (info.reader.missing) { this.files.delete(file); continue; }
      const replay = info.replaying;
      info.replaying = false;                // 되짚기는 첫 읽기 한 번뿐
      for (const line of lines) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (e) {
          this.parseFailures++;
          if (this.parseFailures <= MAX_LOGGED_PARSE_FAILURES) {
            this.log(`기록 줄 해석 실패 (${path.basename(file)}, 길이 ${line.length}): ${e.message}`);
          }
          continue;
        }
        out.push({ sessionId: info.sessionId, rec, replay });
      }
    }
    this.started = true;
    return out;
  }

  // 기록 폴더 전체를 훑어 새 파일을 추적 목록에 넣고, 오래된 파일은 뺀다
  _fullScan(now) {
    for (const [file, info] of Array.from(this.files.entries())) {
      if (info.reader.mtimeMs && now - info.reader.mtimeMs > this.cfg.ACTIVE_FILE_WINDOW_MS) this.files.delete(file);
    }
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`기록 폴더 읽기 실패 (${this.dir}): ${e.message}`);
      return;
    }
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue;
      const projectDir = path.join(this.dir, d.name);
      let entries;
      try {
        entries = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch (e) {
        this.log(`프로젝트 기록 폴더 읽기 실패 (${projectDir}): ${e.message}`);
        continue;
      }
      for (const f of entries) {
        if (!f.isFile() || !f.name.endsWith(TRANSCRIPT_EXT)) continue;
        const file = path.join(projectDir, f.name);
        if (this.files.has(file)) continue;
        let stat;
        try { stat = fs.statSync(file); } catch (_) { continue; }   // 훑는 사이 지워진 파일
        if (now - stat.mtimeMs > this.cfg.ACTIVE_FILE_WINDOW_MS) continue;
        this._track(file, stat, now);
      }
    }
  }

  // 파일 하나를 추적 목록에 넣는다
  _track(file, stat, now) {
    let offset;
    let replaying;
    if (!this.started) {
      if (now - stat.mtimeMs <= this.cfg.STARTUP_REPLAY_WINDOW_MS) {
        // 방금까지 쓰이던 기록: 끝부분을 되짚어 현재 상태를 복원한다
        offset = Math.max(0, stat.size - this.cfg.STARTUP_TAIL_BYTES);
        replaying = true;
      } else {
        // 한동안 조용했던 기록: 앞으로 추가되는 줄만 본다
        offset = stat.size;
        replaying = false;
      }
    } else {
      // 실행 중에 새로 보인 기록: 끝부분부터 읽되, 지난 사건은 상태 판정 쪽에서 알림을 거른다
      offset = Math.max(0, stat.size - this.cfg.STARTUP_TAIL_BYTES);
      replaying = false;
    }
    const reader = new TailReader(file, {
      offset,
      skipPartial: offset > 0 && offset < stat.size,
      maxReadBytes: this.cfg.MAX_READ_BYTES_PER_POLL,
      maxLineBytes: this.cfg.MAX_LINE_BYTES,
    });
    reader.mtimeMs = stat.mtimeMs;
    this.files.set(file, { reader, sessionId: path.basename(file, TRANSCRIPT_EXT), replaying });
  }
}

// 훅 스크립트가 쌓는 이벤트 파일을 이어 읽는다
class HookEventReader {
  // opts: { file, config, log }
  constructor(opts) {
    const o = opts || {};
    this.file = o.file;
    this.cfg = Object.assign({}, DEFAULTS, o.config || {});
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.reader = null;
    this.firstPoll = true;
  }

  // 새 훅 이벤트를 돌려준다
  poll() {
    if (!this.reader) {
      let stat = null;
      try {
        stat = fs.statSync(this.file);
      } catch (e) {
        if (e.code !== 'ENOENT') this.log(`훅 이벤트 파일 확인 실패 (${this.file}): ${e.message}`);
      }
      const startAtEnd = this.firstPoll;       // 시작 전에 쌓인 이벤트는 건너뛴다
      this.firstPoll = false;
      if (!stat) return [];
      this.reader = new TailReader(this.file, {
        offset: startAtEnd ? stat.size : 0,
        maxReadBytes: this.cfg.MAX_READ_BYTES_PER_POLL,
        maxLineBytes: this.cfg.MAX_LINE_BYTES,
      });
    }
    let lines;
    try {
      lines = this.reader.readLines();
    } catch (e) {
      this.log(e.message);
      return [];
    }
    if (this.reader.missing) { this.reader = null; return []; }
    const events = [];
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch (e) { this.log(`훅 이벤트 줄 해석 실패 (길이 ${line.length}): ${e.message}`); continue; }
      if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string' || typeof ev.session_id !== 'string') continue;
      events.push(ev);
    }
    return events;
  }
}

module.exports = { TailReader, TranscriptWatcher, HookEventReader };
