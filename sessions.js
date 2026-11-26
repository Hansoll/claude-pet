// 세션별 상태 판정 모듈. 세션 기록 줄과 훅 이벤트를 받아 "대기/작업 중/확인 필요/완료/오류"를 정한다.
// 화면이나 파일에 의존하지 않는 순수 로직이라 단독으로 시험할 수 있다.
'use strict';

const i18n = require('./i18n.js');

// 문구는 i18n.js의 표에서 꺼낸다. 언어는 본체가 setLanguage로 정한다 (바꾼 뒤 새로 만드는 문구부터 바뀐다)
let lang = i18n.LANGUAGES[0];
function L(key, ...args) { return i18n.t(lang, key, ...args); }
function setLanguage(value) { lang = i18n.LANGUAGES.includes(value) ? value : i18n.LANGUAGES[0]; }

// ── 상수 ────────────────────────────────────────────────────
const DEFAULTS = {
  END_GRACE_MS: 12 * 1000,
  WORKING_TIMEOUT_MS: 30 * 60 * 1000,
  DONE_KEEP_MS: 30 * 60 * 1000,
  SLOW_TOOL_MS: 30 * 1000,
  SESSION_FORGET_MS: 6 * 60 * 60 * 1000,
  LIST_MAX: 6,
  NOTIFY_FRESH_MS: 60 * 1000,      // 이보다 오래된 사건은 알리지 않음 (지난 기록을 되짚을 때 오알림 방지)
  DUPLICATE_START_MS: 5 * 1000,    // 훅과 기록이 같은 턴 시작을 두 번 알릴 때 무시하는 간격
};
// 사용자의 답을 기다리는 도구와 그때 보여 줄 문구의 열쇠
const WAIT_TOOLS = {
  AskUserQuestion: 'session.question',
  ExitPlanMode: 'session.planApproval',
};
// 턴이 끝났음을 뜻하는 종료 사유
const END_REASONS = new Set(['end_turn', 'stop_sequence', 'refusal']);
// 사용자 확인이 필요하다는 알림 유형
const WAIT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
// 대표 세션을 고를 때의 우선순위 (코덱스 펫과 같은 순서)
const PRIORITY = { waiting: 4, failed: 3, done: 2, working: 1, idle: 0 };
const TOOLTIP_MAX_CHARS = 120;            // 알림 영역 아이콘 설명의 최대 길이 (윈도우 한도는 127자)
// API 오류 종류 (문구는 i18n.js의 error.<종류>)
const ERROR_KINDS = new Set(['rate_limit', 'authentication_failed', 'billing_error', 'server_error', 'max_output_tokens', 'invalid_request', 'model_not_found']);
function errorLabel(kind) { return ERROR_KINDS.has(kind) ? L(`error.${kind}`) : L('session.apiFailed'); }

// 공백을 정리하고 길이를 제한한다
function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
}

// 경로에서 파일명만 뽑는다 (윈도우·맥 구분자 모두 처리)
function baseName(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// URL에서 호스트만 뽑는다
function hostOf(url) {
  if (typeof url !== 'string' || !url) return '';
  try { return new URL(url).host; } catch (_) { return clip(url, 30); }
}

// 도구 호출을 한 줄 설명으로 바꾼다
function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const n = String(name || '');
  switch (n) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return L('tool.edit', clip(baseName(i.file_path || i.notebook_path), 30) || L('tool.file'));
    case 'Write':
      return L('tool.write', clip(baseName(i.file_path), 30) || L('tool.file'));
    case 'Read':
      return L('tool.read', clip(baseName(i.file_path), 30) || L('tool.file'));
    case 'Bash':
    case 'PowerShell':
      return L('tool.run', clip(i.description || i.command, 34) || L('tool.command'));
    case 'Grep':
    case 'Glob':
      return L('tool.search', clip(i.pattern, 30) || L('tool.file'));
    case 'WebSearch':
      return L('tool.webSearch', clip(i.query, 28) || L('tool.query'));
    case 'WebFetch':
      return L('tool.webFetch', hostOf(i.url) || L('tool.page'));
    case 'Agent':
    case 'Task':
      return L('tool.task', clip(i.description, 28) || L('tool.inProgress'));
    case 'TodoWrite':
      return L('tool.todo');
    case 'Skill':
      return L('tool.skill', clip(i.skill, 28) || L('tool.running'));
    case 'ToolSearch':
      return L('tool.toolSearch');
    case 'AskUserQuestion':
    case 'ExitPlanMode':
      return L(WAIT_TOOLS[n]);
    default:
      break;
  }
  if (n.startsWith('mcp__')) {
    const parts = n.split('__');
    return L('tool.other', clip(parts[parts.length - 1], 28));
  }
  return L('tool.other', clip(n, 28) || L('tool.running'));
}

// 메시지 본문에서 글자만 모은다
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// 기록의 시각을 밀리초로 바꾼다. 없거나 잘못되면 대체값
function timeOf(rec, fallback) {
  if (rec && typeof rec.timestamp === 'string') {
    const t = Date.parse(rec.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

class SessionTracker {
  // options.config로 시간 상수를 덮어쓸 수 있다
  constructor(options) {
    const o = options || {};
    this.cfg = Object.assign({}, DEFAULTS, o.config || {});
    this.hooksInstalled = !!o.hooksInstalled;
    this.sessions = new Map();
    this.notifications = [];
  }

  // 훅 등록 여부를 알려 준다 (느린 도구의 안내 문구에 사용)
  setHooksInstalled(flag) { this.hooksInstalled = !!flag; }

  // 세션을 찾거나 새로 만든다
  _get(id, now) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        customTitle: '',
        hookTitle: '',
        summaryTitle: '',
        lastPrompt: '',
        cwd: '',
        state: 'idle',
        detail: '',
        turnStartedAt: null,
        endedAt: null,
        durationMs: null,
        acknowledged: false,
        pendingTools: new Map(),
        pendingEndAt: null,
        pendingEndReplay: false,
        waiting: null,
        updatedAt: now,
        lastActivityAt: now,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  // 화면에 보여 줄 세션 제목을 정한다
  _title(s) {
    return s.customTitle || s.hookTitle || s.summaryTitle || s.lastPrompt || baseName(s.cwd) || L('session.untitled');
  }

  // 완료·오류로 끝난 뒤에 도착한 옛 기록인지 확인한다
  _isStale(s, ts) {
    return (s.state === 'done' || s.state === 'failed') && s.endedAt != null && ts <= s.endedAt;
  }

  // 알림을 쌓는다. 되짚기 중이거나 오래된 사건이면 쌓지 않는다
  _notify(kind, s, ts, now, replay) {
    if (replay) return false;
    if (now - ts > this.cfg.NOTIFY_FRESH_MS) return false;
    this.notifications.push({ kind, sessionId: s.id, title: this._title(s), at: ts });
    return true;
  }

  // 새 턴을 시작한다
  _startTurn(s, ts) {
    if (this._isStale(s, ts)) return;
    if (s.state === 'working' && s.turnStartedAt != null && Math.abs(ts - s.turnStartedAt) < this.cfg.DUPLICATE_START_MS) return;
    s.state = 'working';
    s.turnStartedAt = ts;
    s.endedAt = null;
    s.durationMs = null;
    s.acknowledged = false;
    s.detail = L('session.thinking');
    s.pendingTools.clear();
    s.pendingEndAt = null;
    s.waiting = null;
    s.updatedAt = ts;
    s.lastActivityAt = ts;
  }

  // 활동이 보이면 작업 중으로 되돌린다
  _resume(s, ts, detail) {
    if (s.state !== 'working') {
      if (s.state !== 'waiting') { s.turnStartedAt = ts; s.durationMs = null; }
      s.state = 'working';
      s.acknowledged = false;
      s.endedAt = null;
    }
    if (s.turnStartedAt == null) s.turnStartedAt = ts;
    s.waiting = null;
    s.pendingEndAt = null;
    if (detail) s.detail = detail;
    s.updatedAt = ts;
    s.lastActivityAt = ts;
  }

  // 사용자 확인 대기 상태로 바꾼다
  _wait(s, ts, detail, toolName, now, replay) {
    const already = s.state === 'waiting' && s.detail === detail;
    if (s.turnStartedAt == null) s.turnStartedAt = ts;
    s.state = 'waiting';
    s.acknowledged = false;
    s.endedAt = null;
    s.pendingEndAt = null;
    s.waiting = { since: ts, toolName: toolName || null };
    s.detail = detail;
    s.updatedAt = ts;
    s.lastActivityAt = ts;
    if (!already) this._notify('waiting', s, ts, now, replay);
  }

  // 턴을 완료 또는 오류로 끝낸다
  _finish(s, state, ts, detail, now, replay) {
    if ((s.state === 'done' || s.state === 'failed') && s.endedAt != null) return;   // 같은 턴의 중복 신호
    s.state = state;
    s.endedAt = ts;
    s.durationMs = s.turnStartedAt != null ? Math.max(0, ts - s.turnStartedAt) : null;
    s.detail = detail || '';
    s.pendingTools.clear();
    s.pendingEndAt = null;
    s.waiting = null;
    s.updatedAt = ts;
    s.lastActivityAt = ts;
    const notified = this._notify(state, s, ts, now, replay);
    s.acknowledged = !notified;   // 알리지 않은(지난) 완료는 이미 확인한 것으로 본다
  }

  // 대기 상태로 되돌린다 (중단, 시간 초과)
  _toIdle(s, ts) {
    s.state = 'idle';
    s.detail = '';
    s.turnStartedAt = null;
    s.endedAt = null;
    s.durationMs = null;
    s.acknowledged = false;
    s.pendingTools.clear();
    s.pendingEndAt = null;
    s.waiting = null;
    s.updatedAt = ts;
  }

  // 세션 기록 한 줄을 반영한다. opts: { now, replay }
  applyRecord(sessionId, rec, opts) {
    if (!sessionId || !rec || typeof rec !== 'object') return;
    if (rec.isSidechain === true) return;   // 보조 에이전트의 기록은 본 세션 상태에 반영하지 않음
    const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
    const replay = !!(opts && opts.replay);
    const s = this._get(sessionId, now);
    if (typeof rec.cwd === 'string' && rec.cwd) s.cwd = rec.cwd;
    const ts = timeOf(rec, now);
    switch (rec.type) {
      case 'custom-title':
        if (typeof rec.customTitle === 'string') s.customTitle = clip(rec.customTitle, 40);
        return;
      case 'summary':
        if (typeof rec.summary === 'string') s.summaryTitle = clip(rec.summary, 40);
        return;
      case 'last-prompt':
        if (typeof rec.lastPrompt === 'string') s.lastPrompt = clip(rec.lastPrompt, 40);
        return;
      case 'user':
        this._onUser(s, rec, ts, now, replay);
        return;
      case 'assistant':
        this._onAssistant(s, rec, ts, now, replay);
        return;
      case 'system':
        this._onSystem(s, rec, ts, now, replay);
        return;
      default:
        return;
    }
  }

  // 사용자 쪽 기록(새 요청, 도구 결과, 중단)을 반영한다
  _onUser(s, rec, ts, now, replay) {
    const content = rec.message && rec.message.content;
    if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
      const resolved = [];
      for (const b of content) {
        if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
        const pending = s.pendingTools.get(b.tool_use_id);
        if (pending) resolved.push(pending.name);
        s.pendingTools.delete(b.tool_use_id);
      }
      if (this._isStale(s, ts)) return;
      // 승인을 기다리는 도구가 아직 남아 있으면 확인 필요 상태를 유지한다
      if (s.state === 'waiting' && s.waiting && s.waiting.toolName && !resolved.includes(s.waiting.toolName)) {
        const stillPending = Array.from(s.pendingTools.values()).some((t) => t.name === s.waiting.toolName);
        if (stillPending) { s.updatedAt = ts; s.lastActivityAt = ts; return; }
      }
      if (s.state !== 'working' && s.state !== 'waiting') return;   // 진행 중인 턴이 없으면 도구 결과만으로 상태를 바꾸지 않음
      // 함께 호출된 다른 도구가 아직 돌고 있으면 그 도구를 계속 보여 준다
      const remaining = Array.from(s.pendingTools.values());
      this._resume(s, ts, remaining.length ? remaining[remaining.length - 1].detail : L('session.thinking'));
      return;
    }
    if (rec.isMeta === true) return;   // 시스템이 덧붙인 보조 기록
    const text = extractText(content).trimStart();
    const hasImage = Array.isArray(content) && content.some((b) => b && b.type === 'image');
    if (!text && !hasImage) return;
    if (text.startsWith('[Request interrupted')) { this._toIdle(s, ts); return; }
    if (text.startsWith('<')) return;   // 명령 출력이나 작업 알림처럼 시스템이 넣은 글
    this._startTurn(s, ts);
  }

  // 어시스턴트 쪽 기록(생각, 답변, 도구 호출, 종료)을 반영한다
  _onAssistant(s, rec, ts, now, replay) {
    if (this._isStale(s, ts)) return;
    const msg = rec.message && typeof rec.message === 'object' ? rec.message : {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    if (rec.isApiErrorMessage === true) {
      this._finish(s, 'failed', ts, clip(extractText(blocks), 60) || L('session.apiError'), now, replay);
      return;
    }
    let detail = '';
    let waitTool = '';
    let hasText = false;
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        if (!detail) detail = L('session.thinking');
      } else if (b.type === 'text') {
        hasText = true;
        detail = L('session.answering');
      } else if (b.type === 'tool_use') {
        const described = describeTool(b.name, b.input);
        if (b.id) s.pendingTools.set(b.id, { name: String(b.name || ''), detail: described, at: ts });
        detail = described;
        if (WAIT_TOOLS[b.name]) waitTool = b.name;
      }
    }
    this._resume(s, ts, detail || s.detail || L('session.thinking'));
    if (waitTool) this._wait(s, ts, L(WAIT_TOOLS[waitTool]), waitTool, now, replay);
    const stop = msg.stop_reason;
    if (END_REASONS.has(stop)) {
      if (hasText) this._finish(s, 'done', ts, '', now, replay);
      else { s.pendingEndAt = ts; s.pendingEndReplay = replay; }   // 본문이 뒤따라올 수 있으니 잠시 기다림
    } else if (stop === 'max_tokens') {
      s.pendingEndAt = ts;
      s.pendingEndReplay = replay;
    }
  }

  // 시스템 기록(훅 요약, API 재시도)을 반영한다
  _onSystem(s, rec, ts, now, replay) {
    if (this._isStale(s, ts)) return;
    if (rec.subtype === 'stop_hook_summary') {
      if (s.state === 'working' || s.state === 'waiting') this._finish(s, 'done', ts, '', now, replay);
    } else if (rec.subtype === 'api_error') {
      if (s.state === 'working') { s.detail = L('session.apiRetry'); s.updatedAt = ts; s.lastActivityAt = ts; }
    }
  }

  // 훅 이벤트 하나를 반영한다. ev: { ts, event, session_id, cwd, ... }
  applyHook(ev, opts) {
    if (!ev || typeof ev !== 'object' || typeof ev.session_id !== 'string' || !ev.session_id) return;
    const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
    const replay = !!(opts && opts.replay);
    const ts = Number.isFinite(ev.ts) ? ev.ts : now;
    if (ev.event === 'SessionEnd') { this.sessions.delete(ev.session_id); return; }
    const s = this._get(ev.session_id, now);
    if (typeof ev.cwd === 'string' && ev.cwd) s.cwd = ev.cwd;
    if (typeof ev.session_title === 'string' && ev.session_title) s.hookTitle = clip(ev.session_title, 40);
    switch (ev.event) {
      case 'UserPromptSubmit':
        this._startTurn(s, ts);
        return;
      case 'Stop':
        if (this._isStale(s, ts)) return;
        this._finish(s, 'done', ts, '', now, replay);
        return;
      case 'StopFailure':
        if (this._isStale(s, ts)) return;
        this._finish(s, 'failed', ts, errorLabel(ev.error), now, replay);
        return;
      case 'PermissionRequest':
        if (this._isStale(s, ts)) return;
        {
          // 훅이 남긴 입력이 있으면 화면 언어로 설명을 만들고, 없으면(예전 훅) 훅이 만든 설명을 쓴다
          const detail = ev.tool_input && typeof ev.tool_input === 'object' && ev.tool_name
            ? describeTool(ev.tool_name, ev.tool_input)
            : clip(ev.tool_detail, 34) || clip(ev.tool_name, 28) || L('tool.tool');
          this._wait(s, ts, L('session.approval', detail), ev.tool_name, now, replay);
        }
        return;
      case 'Elicitation':
        if (this._isStale(s, ts)) return;
        this._wait(s, ts, L('session.inputRequest', clip(ev.mcp_server, 28) || L('tool.external')), null, now, replay);
        return;
      case 'ElicitationResult':
        if (s.state === 'waiting') this._resume(s, ts, L('session.thinking'));
        return;
      case 'Notification':
        // 턴이 진행 중일 때만 확인 필요로 바꾼다 (끝난 뒤의 유휴 알림은 무시)
        if (s.state === 'working' && WAIT_NOTIFICATIONS.has(ev.notification_type)) {
          this._wait(s, ts, clip(ev.message, 40) || L('session.needsCheck'), null, now, replay);
        }
        return;
      default:
        return;
    }
  }

  // 시간 경과에 따른 상태 정리를 한다
  tick(now) {
    for (const s of Array.from(this.sessions.values())) {
      if (s.pendingEndAt != null && s.state === 'working' && now - s.pendingEndAt >= this.cfg.END_GRACE_MS) {
        this._finish(s, 'done', s.pendingEndAt, '', now, s.pendingEndReplay);
      }
      if (s.state === 'working' && now - s.lastActivityAt > this.cfg.WORKING_TIMEOUT_MS) this._toIdle(s, now);
      if (s.state === 'waiting' && now - s.lastActivityAt > this.cfg.SESSION_FORGET_MS) this._toIdle(s, now);
      if ((s.state === 'done' || s.state === 'failed') && !s.acknowledged && now - s.endedAt > this.cfg.DONE_KEEP_MS) {
        s.acknowledged = true;
      }
      if (this._effective(s) === 'idle' && now - s.updatedAt > this.cfg.SESSION_FORGET_MS) this.sessions.delete(s.id);
    }
  }

  // 확인이 끝난 완료·오류는 대기로 취급한다
  _effective(s) {
    if ((s.state === 'done' || s.state === 'failed') && s.acknowledged) return 'idle';
    return s.state;
  }

  // 완료·오류 표시를 확인 처리한다. 처리한 개수를 돌려준다
  acknowledge() {
    let count = 0;
    for (const s of this.sessions.values()) {
      if ((s.state === 'done' || s.state === 'failed') && !s.acknowledged) { s.acknowledged = true; count++; }
    }
    return count;
  }

  // 세션 하나의 완료·오류 표시만 확인 처리한다 (그 세션을 열어 봤을 때)
  acknowledgeSession(id) {
    const s = this.sessions.get(id);
    if (!s || (s.state !== 'done' && s.state !== 'failed') || s.acknowledged) return false;
    s.acknowledged = true;
    return true;
  }

  // 아직 확인하지 않은 완료·오류 세션을 돌려준다: [{ id, endedAt }] (앱에서 직접 봤는지 확인할 대상)
  unseenFinished() {
    const list = [];
    for (const s of this.sessions.values()) {
      if ((s.state === 'done' || s.state === 'failed') && !s.acknowledged && s.endedAt != null) list.push({ id: s.id, endedAt: s.endedAt });
    }
    return list;
  }

  // 쌓인 알림을 꺼내고 비운다
  drainNotifications() {
    const list = this.notifications;
    this.notifications = [];
    return list;
  }

  // 화면에 보낼 요약을 만든다
  summary(now) {
    const views = [];
    const counts = { working: 0, waiting: 0, done: 0, failed: 0 };
    for (const s of this.sessions.values()) {
      const state = this._effective(s);
      if (state === 'idle') continue;
      counts[state]++;
      let detail = s.detail;
      if (state === 'working' && s.pendingTools.size > 0) {
        let oldest = Infinity;
        for (const t of s.pendingTools.values()) oldest = Math.min(oldest, t.at);
        if (now - oldest > this.cfg.SLOW_TOOL_MS && !this.hooksInstalled) detail += L('session.maybeApproval');
      }
      views.push({
        id: s.id,
        state,
        title: this._title(s),
        detail,
        startedAt: s.turnStartedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        updatedAt: s.updatedAt,
      });
    }
    views.sort((a, b) => (PRIORITY[b.state] - PRIORITY[a.state]) || (b.updatedAt - a.updatedAt));
    return {
      primary: views.length ? views[0] : null,
      sessions: views.slice(0, this.cfg.LIST_MAX),
      total: views.length,
      counts,
    };
  }
}

// 알림 영역 아이콘에 마우스를 올렸을 때 보여 줄 한 줄을 만든다 (예: "클로드 펫 · 작업 중: 주간 리뷰 외 1개")
function summaryLine(summary, labels, appName) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const label = (state) => text(labels && labels[state]) || state;
  const primary = summary && summary.primary;
  let line;
  if (!primary) {
    line = label('idle');
  } else {
    line = label(primary.state);
    if (text(primary.title)) line += `: ${text(primary.title)}`;
    const others = (Number.isFinite(summary.total) ? summary.total : 1) - 1;
    if (others > 0) line += L('session.others', others);
  }
  const full = text(appName) ? `${text(appName)} · ${line}` : line;
  return full.length > TOOLTIP_MAX_CHARS ? `${full.slice(0, TOOLTIP_MAX_CHARS - 1)}…` : full;
}

module.exports = { SessionTracker, describeTool, summaryLine, setLanguage, clip, baseName, PRIORITY, WAIT_TOOLS, DEFAULTS };
