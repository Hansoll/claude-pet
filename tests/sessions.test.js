// 상태 판정(sessions.js) 시험. 가짜 기록 줄과 훅 이벤트를 넣어 결과 상태를 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionTracker, describeTool } = require('../sessions.js');

const T0 = Date.parse('2026-11-25T01:00:00.000Z');
const SID = 'session-a';
const iso = (ms) => new Date(ms).toISOString();

// 가짜 기록 줄을 만드는 도우미들
function user(text, ms, extra) {
  return Object.assign({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } }, extra || {});
}
function toolResult(id, ms) {
  return { type: 'user', timestamp: iso(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } };
}
function assistant(blocks, stop, ms, extra) {
  return Object.assign({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: blocks, stop_reason: stop } }, extra || {});
}
const think = { type: 'thinking', thinking: '...' };
const text = (t) => ({ type: 'text', text: t });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input: input || {} });

// 기록을 순서대로 넣는다
function feed(tracker, records, opts) {
  for (const rec of records) {
    const now = Date.parse(rec.timestamp || iso(T0));
    tracker.applyRecord(SID, rec, Object.assign({ now }, opts || {}));
  }
}

test('기본 흐름: 요청 → 도구 → 결과 → 답변 완료', () => {
  const t = new SessionTracker();
  feed(t, [user('파일 고쳐줘', T0)]);
  let s = t.summary(T0);
  assert.equal(s.primary.state, 'working');
  assert.equal(s.primary.detail, '생각 중');

  feed(t, [assistant([tool('t1', 'Edit', { file_path: 'C:\\work\\a.js' })], 'tool_use', T0 + 1000)]);
  assert.equal(t.summary(T0 + 1000).primary.detail, '편집: a.js');

  feed(t, [toolResult('t1', T0 + 2000)]);
  assert.equal(t.summary(T0 + 2000).primary.detail, '생각 중');

  feed(t, [assistant([text('끝났습니다')], 'end_turn', T0 + 5000)]);
  s = t.summary(T0 + 5000);
  assert.equal(s.primary.state, 'done');
  assert.equal(s.primary.durationMs, 5000);
  const notes = t.drainNotifications();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'done');
});

test('생각 줄에 종료 표식이 먼저 와도 본문이 올 때 한 번만 완료된다', () => {
  const t = new SessionTracker();
  feed(t, [user('질문', T0), assistant([think], 'end_turn', T0 + 1000)]);
  assert.equal(t.summary(T0 + 1000).primary.state, 'working');
  feed(t, [assistant([text('답')], 'end_turn', T0 + 9000)]);
  assert.equal(t.summary(T0 + 9000).primary.state, 'done');
  assert.equal(t.drainNotifications().length, 1);
});

test('본문 없이 종료 표식만 온 경우 유예 시간이 지나면 완료된다', () => {
  const t = new SessionTracker();
  feed(t, [user('질문', T0), assistant([think], 'end_turn', T0 + 1000)]);
  t.tick(T0 + 5000);
  assert.equal(t.summary(T0 + 5000).primary.state, 'working');
  t.tick(T0 + 1000 + 12000);
  assert.equal(t.summary(T0 + 13000).primary.state, 'done');
  assert.equal(t.drainNotifications().length, 1);
});

test('훅 Stop과 기록의 종료가 겹쳐도 알림은 한 번', () => {
  const a = new SessionTracker();
  feed(a, [user('질문', T0), assistant([text('답')], 'end_turn', T0 + 3000)]);
  a.applyHook({ event: 'Stop', session_id: SID, ts: T0 + 3200 }, { now: T0 + 3200 });
  a.applyRecord(SID, { type: 'system', subtype: 'stop_hook_summary', timestamp: iso(T0 + 3300) }, { now: T0 + 3300 });
  assert.equal(a.drainNotifications().length, 1);

  // 훅이 먼저 반영되고 기록의 마지막 줄이 늦게 읽힌 경우
  const b = new SessionTracker();
  feed(b, [user('질문', T0)]);
  b.applyHook({ event: 'Stop', session_id: SID, ts: T0 + 3200 }, { now: T0 + 3200 });
  feed(b, [assistant([text('답')], 'end_turn', T0 + 3000)]);
  assert.equal(b.summary(T0 + 3300).primary.state, 'done');
  assert.equal(b.drainNotifications().length, 1);
});

test('확인하면 대기로 돌아가고, 뒤늦은 Stop 훅은 다시 알리지 않는다', () => {
  const t = new SessionTracker();
  feed(t, [user('질문', T0), assistant([text('답')], 'end_turn', T0 + 3000)]);
  t.drainNotifications();
  assert.equal(t.acknowledge(), 1);
  assert.equal(t.summary(T0 + 3100).primary, null);
  t.applyHook({ event: 'Stop', session_id: SID, ts: T0 + 3500 }, { now: T0 + 3500 });
  assert.equal(t.summary(T0 + 3600).primary, null);
  assert.equal(t.drainNotifications().length, 0);
});

test('완료 뒤 새 요청이 오면 다시 작업 중이 된다', () => {
  const t = new SessionTracker();
  feed(t, [user('하나', T0), assistant([text('답')], 'end_turn', T0 + 3000), user('둘', T0 + 60000)]);
  const s = t.summary(T0 + 60000);
  assert.equal(s.primary.state, 'working');
  assert.equal(s.primary.startedAt, T0 + 60000);
});

test('사용자가 중단하면 알림 없이 대기로 돌아간다', () => {
  const t = new SessionTracker();
  feed(t, [
    user('질문', T0),
    assistant([tool('t1', 'Bash', { command: 'npm test' })], 'tool_use', T0 + 1000),
    user('[Request interrupted by user for tool use]', T0 + 2000),
    toolResult('t1', T0 + 2100),
  ]);
  assert.equal(t.summary(T0 + 2200).primary, null);
  assert.equal(t.drainNotifications().length, 0);
});

test('보조 에이전트 기록, 보조 글, 시스템이 넣은 글은 무시한다', () => {
  const t = new SessionTracker();
  feed(t, [
    assistant([tool('x', 'Read', { file_path: 'a' })], 'tool_use', T0, { isSidechain: true }),
    user('[Image: source: C:\\x.png]', T0 + 100, { isMeta: true }),
    user('<task-notification>끝</task-notification>', T0 + 200),
    user('<local-command-stdout>ok</local-command-stdout>', T0 + 300),
  ]);
  assert.equal(t.summary(T0 + 400).primary, null);
});

test('질문 도구는 확인 필요가 되고, 답하면 작업 중으로 돌아간다', () => {
  const t = new SessionTracker();
  feed(t, [user('질문', T0), assistant([tool('q1', 'AskUserQuestion', {})], 'tool_use', T0 + 1000)]);
  let s = t.summary(T0 + 1000);
  assert.equal(s.primary.state, 'waiting');
  assert.equal(s.primary.detail, '질문에 답해 주세요');
  assert.deepEqual(t.drainNotifications().map((n) => n.kind), ['waiting']);
  feed(t, [toolResult('q1', T0 + 9000)]);
  s = t.summary(T0 + 9000);
  assert.equal(s.primary.state, 'working');
  assert.equal(s.primary.startedAt, T0);
});

test('승인 요청 훅: 다른 도구 결과가 와도 승인 대기 도구가 남아 있으면 유지한다', () => {
  const t = new SessionTracker();
  feed(t, [
    user('질문', T0),
    assistant([tool('r1', 'Read', { file_path: 'a.txt' }), tool('b1', 'Bash', { command: 'rm x' })], 'tool_use', T0 + 1000),
  ]);
  t.applyHook({ event: 'PermissionRequest', session_id: SID, ts: T0 + 1200, tool_name: 'Bash', tool_detail: '실행: rm x' }, { now: T0 + 1200 });
  let s = t.summary(T0 + 1200);
  assert.equal(s.primary.state, 'waiting');
  assert.equal(s.primary.detail, '승인 필요: 실행: rm x');
  feed(t, [toolResult('r1', T0 + 1500)]);
  assert.equal(t.summary(T0 + 1500).primary.state, 'waiting');
  feed(t, [toolResult('b1', T0 + 8000)]);
  assert.equal(t.summary(T0 + 8000).primary.state, 'working');
  assert.deepEqual(t.drainNotifications().map((n) => n.kind), ['waiting']);
});

test('함께 호출된 도구 중 하나만 끝나면 남은 도구를 계속 보여 준다', () => {
  const t = new SessionTracker();
  feed(t, [
    user('질문', T0),
    assistant([tool('e1', 'Edit', { file_path: 'a.js' })], 'tool_use', T0 + 1000),
    assistant([tool('b1', 'Bash', { command: 'npm test', description: '테스트 실행' })], 'tool_use', T0 + 1100),
    toolResult('e1', T0 + 1500),
  ]);
  assert.equal(t.summary(T0 + 1500).primary.detail, '실행: 테스트 실행');
  feed(t, [toolResult('b1', T0 + 9000)]);
  assert.equal(t.summary(T0 + 9000).primary.detail, '생각 중');
});

test('여러 세션의 우선순위: 확인 필요 > 오류 > 완료 > 작업 중', () => {
  const t = new SessionTracker();
  const now = T0 + 5000;
  t.applyRecord('w', user('작업', T0), { now });
  t.applyRecord('d', user('작업', T0), { now });
  t.applyRecord('d', assistant([text('끝')], 'end_turn', T0 + 1000), { now });
  t.applyRecord('f', user('작업', T0), { now });
  t.applyHook({ event: 'StopFailure', session_id: 'f', ts: T0 + 2000, error: 'rate_limit' }, { now });
  assert.equal(t.summary(now).primary.id, 'f');
  assert.equal(t.summary(now).primary.detail, '사용량 한도에 걸렸어요');
  t.applyRecord('q', user('작업', T0), { now });
  t.applyHook({ event: 'PermissionRequest', session_id: 'q', ts: T0 + 3000, tool_name: 'Bash' }, { now });
  const s = t.summary(now);
  assert.deepEqual(s.sessions.map((v) => v.id), ['q', 'f', 'd', 'w']);
  assert.deepEqual(s.counts, { working: 1, waiting: 1, done: 1, failed: 1 });
});

test('되짚기 중에는 알리지 않고, 지난 완료는 확인된 것으로 본다', () => {
  const t = new SessionTracker();
  feed(t, [user('옛 질문', T0), assistant([text('옛 답')], 'end_turn', T0 + 1000)], { replay: true });
  assert.equal(t.drainNotifications().length, 0);
  assert.equal(t.summary(T0 + 2000).primary, null);

  const u = new SessionTracker();
  feed(u, [user('진행 중', T0), assistant([tool('t1', 'Read', { file_path: 'a' })], 'tool_use', T0 + 1000)], { replay: true });
  assert.equal(u.summary(T0 + 2000).primary.state, 'working');
});

test('오래된 사건은 되짚기가 아니어도 알리지 않는다', () => {
  const t = new SessionTracker();
  const now = T0 + 10 * 60 * 1000;
  t.applyRecord(SID, user('옛 질문', T0), { now });
  t.applyRecord(SID, assistant([text('옛 답')], 'end_turn', T0 + 1000), { now });
  assert.equal(t.drainNotifications().length, 0);
  assert.equal(t.summary(now).primary, null);
});

test('세션 제목: 지정 제목 > 마지막 요청 > 폴더명', () => {
  const t = new SessionTracker();
  t.applyRecord(SID, user('작업', T0, { cwd: 'C:\\Users\\me\\프로젝트 폴더' }), { now: T0 });
  assert.equal(t.summary(T0).primary.title, '프로젝트 폴더');
  t.applyRecord(SID, { type: 'last-prompt', lastPrompt: '펫 만들어줘' }, { now: T0 });
  assert.equal(t.summary(T0).primary.title, '펫 만들어줘');
  t.applyRecord(SID, { type: 'custom-title', customTitle: '클로드 펫 제작' }, { now: T0 });
  assert.equal(t.summary(T0).primary.title, '클로드 펫 제작');
});

test('시간 경과: 작업 중 시간 초과는 대기로, 완료 표시는 자동 확인', () => {
  const t = new SessionTracker({ config: { WORKING_TIMEOUT_MS: 1000, DONE_KEEP_MS: 2000 } });
  feed(t, [user('작업', T0)]);
  t.tick(T0 + 500);
  assert.equal(t.summary(T0 + 500).primary.state, 'working');
  t.tick(T0 + 1500);
  assert.equal(t.summary(T0 + 1500).primary, null);

  feed(t, [user('작업2', T0 + 2000), assistant([text('끝')], 'end_turn', T0 + 2500)]);
  assert.equal(t.summary(T0 + 2600).primary.state, 'done');
  t.tick(T0 + 5000);
  assert.equal(t.summary(T0 + 5000).primary, null);
});

test('알림 훅: 진행 중일 때만 확인 필요로 바꾼다', () => {
  const t = new SessionTracker();
  feed(t, [user('작업', T0)]);
  t.applyHook({ event: 'Notification', session_id: SID, ts: T0 + 500, notification_type: 'permission_prompt', message: 'Claude needs your permission' }, { now: T0 + 500 });
  assert.equal(t.summary(T0 + 500).primary.state, 'waiting');
  feed(t, [assistant([text('끝')], 'end_turn', T0 + 2000)]);
  t.applyHook({ event: 'Notification', session_id: SID, ts: T0 + 70000, notification_type: 'idle_prompt', message: 'waiting' }, { now: T0 + 70000 });
  assert.equal(t.summary(T0 + 70000).primary.state, 'done');
});

test('세션 종료 훅은 세션을 지우고, 입력 요청 훅은 확인 필요를 만든다', () => {
  const t = new SessionTracker();
  feed(t, [user('작업', T0)]);
  t.applyHook({ event: 'Elicitation', session_id: SID, ts: T0 + 100, mcp_server: 'slack' }, { now: T0 + 100 });
  assert.equal(t.summary(T0 + 100).primary.detail, '입력 요청: slack');
  t.applyHook({ event: 'ElicitationResult', session_id: SID, ts: T0 + 200 }, { now: T0 + 200 });
  assert.equal(t.summary(T0 + 200).primary.state, 'working');
  t.applyHook({ event: 'SessionEnd', session_id: SID, ts: T0 + 300 }, { now: T0 + 300 });
  assert.equal(t.summary(T0 + 300).primary, null);
});

test('API 오류 메시지는 오류 상태가 된다', () => {
  const t = new SessionTracker();
  feed(t, [user('작업', T0), assistant([text('API Error: overloaded')], null, T0 + 1000, { isApiErrorMessage: true })]);
  const s = t.summary(T0 + 1000);
  assert.equal(s.primary.state, 'failed');
  assert.deepEqual(t.drainNotifications().map((n) => n.kind), ['failed']);
});

test('잘못된 입력은 조용히 무시한다', () => {
  const t = new SessionTracker();
  t.applyRecord(SID, null, { now: T0 });
  t.applyRecord('', user('x', T0), { now: T0 });
  t.applyRecord(SID, { type: 'assistant', timestamp: 'not-a-date', message: null }, { now: T0 });
  t.applyHook(null, { now: T0 });
  t.applyHook({ event: 'Stop' }, { now: T0 });
  t.applyRecord(SID, { type: 'user', timestamp: iso(T0), message: { content: [] } }, { now: T0 });
  assert.ok(t.summary(T0));
});

test('도구 설명 문구', () => {
  assert.equal(describeTool('Edit', { file_path: '/a/b/pet.html' }), '편집: pet.html');
  assert.equal(describeTool('Write', { file_path: 'C:\\x\\새 파일.md' }), '작성: 새 파일.md');
  assert.equal(describeTool('Bash', { command: 'npm test', description: '테스트 실행' }), '실행: 테스트 실행');
  assert.equal(describeTool('Grep', { pattern: 'TODO' }), '검색: TODO');
  assert.equal(describeTool('WebFetch', { url: 'https://example.com/a/b' }), '웹 읽기: example.com');
  assert.equal(describeTool('mcp__slack__send_message', {}), '도구: send_message');
  assert.equal(describeTool('Read', null), '읽기: 파일');
  assert.equal(describeTool(undefined, undefined), '도구: 실행');
});

test('승인 대기 설명은 화면 언어를 따른다 (훅이 남긴 입력으로 다시 만든다)', () => {
  const sessions = require('../sessions.js');
  try {
    sessions.setLanguage('en');
    const t = new sessions.SessionTracker({ config: {} });
    t.applyHook({ event: 'UserPromptSubmit', session_id: 'sess-en-1', ts: 1000 }, { now: 1000 });
    t.applyHook({ event: 'PermissionRequest', session_id: 'sess-en-1', ts: 1200, tool_name: 'Bash', tool_detail: '실행: npm test', tool_input: { command: 'npm test' } }, { now: 1200 });
    const view = t.summary(1300).primary;
    assert.equal(view.state, 'waiting');
    assert.equal(view.detail, 'Approval: Run: npm test');
    assert.equal(sessions.describeTool('Read', { file_path: '/a/b.txt' }), 'Read: b.txt');
  } finally {
    sessions.setLanguage('ko');
  }
});
