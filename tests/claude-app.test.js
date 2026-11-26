// Claude 앱 연결(claude-app.js) 시험. 임시 폴더에 가짜 세션 파일을 만들어 ID 대응과 링크를 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeApp = require('../claude-app.js');
const { SessionTracker, summaryLine } = require('../sessions.js');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

// 가짜 앱 세션 파일을 만든다 (실제 파일처럼 cliSessionId가 맨 앞에 온다)
function writeSession(root, localId, fields, mtime) {
  const dir = path.join(root, 'claude-code-sessions', 'account-1', 'org-1');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${localId}.json`);
  fs.writeFileSync(file, JSON.stringify(Object.assign({ sessionId: localId }, fields)), 'utf8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

const CLI_A = '3d2d15b8-f278-4a51-a382-b04648203824';
const CLI_B = '11111111-2222-3333-4444-555555555555';
const CLI_OLD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('세션 기록 ID로 앱 세션 ID를 찾는다', (t) => {
  const root = tempDir(t);
  writeSession(root, 'local_aaa-111', { cliSessionId: CLI_A, title: '펫 만들기' });
  writeSession(root, 'local_bbb-222', { cliSessionId: CLI_B, title: '다른 세션' });
  fs.writeFileSync(path.join(root, 'claude-code-sessions', 'account-1', 'org-1', 'archived-sessions.idx'), 'x');
  const options = { roots: [root, path.join(root, 'missing')] };
  assert.equal(claudeApp.findDesktopSessionId(CLI_A, options), 'local_aaa-111');
  assert.equal(claudeApp.findDesktopSessionId(CLI_B, options), 'local_bbb-222');
  assert.equal(claudeApp.findDesktopSessionId('99999999-0000-0000-0000-000000000000', options), null);
});

test('세션이 이어지며 ID가 바뀐 경우 파일 뒤쪽의 ID로도 찾는다', (t) => {
  const root = tempDir(t);
  writeSession(root, 'local_ccc-333', {
    cliSessionId: CLI_B,
    padding: 'x'.repeat(6000),                 // 앞부분(4KB) 밖으로 밀어낸다
    lastAssistantCliSessionId: CLI_OLD,
  });
  assert.equal(claudeApp.findDesktopSessionId(CLI_OLD, { roots: [root] }), 'local_ccc-333');
});

test('잘못된 입력과 깨진 파일은 조용히 넘어간다', (t) => {
  const root = tempDir(t);
  const dir = path.join(root, 'claude-code-sessions', 'a', 'b');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_broken.json'), '{ 깨진 내용', 'utf8');
  fs.writeFileSync(path.join(dir, 'local_bad name!.json'), '{"cliSessionId":"' + CLI_A + '"}', 'utf8');
  const options = { roots: [root] };
  assert.equal(claudeApp.findDesktopSessionId(CLI_A, options), null);     // 이름이 형식에 안 맞는 파일은 무시
  assert.equal(claudeApp.findDesktopSessionId('', options), null);
  assert.equal(claudeApp.findDesktopSessionId(null, options), null);
  assert.equal(claudeApp.findDesktopSessionId('a".*"b', options), null);  // 정규식에 쓰일 수 없는 글자는 거부
  assert.equal(claudeApp.findDesktopSessionId(CLI_A, { roots: [] }), null);
});

test('세션 파일 목록은 최근에 바뀐 순이다', (t) => {
  const root = tempDir(t);
  const now = Date.now();
  writeSession(root, 'local_old', { cliSessionId: CLI_A }, new Date(now - 60000));
  writeSession(root, 'local_new', { cliSessionId: CLI_B }, new Date(now));
  assert.deepEqual(claudeApp.listSessionFiles([root]).map((f) => f.localId), ['local_new', 'local_old']);
});

test('링크: 찾으면 그 세션 링크, 못 찾으면 코드 탭 링크', (t) => {
  const root = tempDir(t);
  writeSession(root, 'local_aaa-111', { cliSessionId: CLI_A });
  const found = claudeApp.linkForSession(CLI_A, { roots: [root] });
  assert.equal(found.localId, 'local_aaa-111');
  assert.equal(found.url, 'claude://code/continue?session=local_aaa-111&source=claude_pet');
  const missing = claudeApp.linkForSession(CLI_B, { roots: [root] });
  assert.equal(missing.localId, null);
  assert.equal(missing.url, claudeApp.FALLBACK_LINK);
  // 앱이 받아들이는 형식(local_ + 영문·숫자·하이픈)만 링크에 넣는다
  assert.match(claudeApp.FALLBACK_LINK, /^claude:\/\/code\/continue\?session=local_[A-Za-z0-9-]{1,64}&source=claude_pet$/);
  assert.equal(claudeApp.sessionLink('local_x&evil=1'), claudeApp.FALLBACK_LINK);
  assert.equal(claudeApp.sessionLink(undefined), claudeApp.FALLBACK_LINK);
});

test('데이터 폴더 후보: OS별 위치', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'Local', 'Claude-Data', 'claude_store'), { recursive: true });
  const win = claudeApp.appDataRoots('win32', { APPDATA: path.join(root, 'Roaming'), LOCALAPPDATA: path.join(root, 'Local') }, root);
  assert.deepEqual(win, [path.join(root, 'Roaming', 'Claude'), path.join(root, 'Local', 'Claude-Data', 'claude_store')]);
  assert.deepEqual(claudeApp.appDataRoots('darwin', {}, '/Users/me'), [path.join('/Users/me', 'Library', 'Application Support', 'Claude')]);
  assert.deepEqual(claudeApp.appDataRoots('linux', {}, '/home/me'), [path.join('/home/me', '.config', 'Claude')]);
});

test('세션 하나만 확인 처리한다', () => {
  const T0 = Date.parse('2026-11-25T01:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const tracker = new SessionTracker();
  for (const id of ['one', 'two']) {
    tracker.applyRecord(id, { type: 'user', timestamp: iso(T0), message: { content: '작업' } }, { now: T0 });
    tracker.applyRecord(id, { type: 'assistant', timestamp: iso(T0 + 1000), message: { content: [{ type: 'text', text: '끝' }], stop_reason: 'end_turn' } }, { now: T0 + 1000 });
  }
  assert.equal(tracker.summary(T0 + 2000).counts.done, 2);
  assert.equal(tracker.acknowledgeSession('one'), true);
  assert.equal(tracker.acknowledgeSession('one'), false);
  assert.equal(tracker.acknowledgeSession('none'), false);
  const s = tracker.summary(T0 + 2000);
  assert.equal(s.counts.done, 1);
  assert.equal(s.primary.id, 'two');
});

test('앱 세션 파일에서 "마지막으로 띄운 시각"을 읽는다', (t) => {
  const root = tempDir(t);
  const T = 1795654562491;
  const head = writeSession(root, 'local_head', { cliSessionId: CLI_A, lastFocusedAt: T, title: '앞쪽에 있음' });
  assert.equal(claudeApp.readLastFocusedAt(head), T);
  // 앞부분(16KB) 밖에 있어도 파일 전체를 풀어 찾는다
  const far = writeSession(root, 'local_far', { cliSessionId: CLI_B, padding: 'x'.repeat(40000), lastFocusedAt: T + 5 });
  assert.equal(claudeApp.readLastFocusedAt(far), T + 5);
  const none = writeSession(root, 'local_none', { cliSessionId: CLI_OLD, title: '기록 없음' });
  assert.equal(claudeApp.readLastFocusedAt(none), null);
  // 숫자가 아닌 값이나 다른 이름은 받아들이지 않는다
  const odd = writeSession(root, 'local_odd', { cliSessionId: CLI_OLD, lastFocusedAt: '어제', notLastFocusedAt: T });
  assert.equal(claudeApp.readLastFocusedAt(odd), null);
  assert.throws(() => claudeApp.readLastFocusedAt(path.join(root, '없는 파일.json')));
});

test('앱에서 직접 봤는지: 끝난 뒤에 띄웠을 때만 확인한 것으로 본다', (t) => {
  const root = tempDir(t);
  const ended = 1795654600000;
  const file = writeSession(root, 'local_aaa-111', { cliSessionId: CLI_A, lastFocusedAt: ended - 5000 }, new Date(ended));
  const checker = new claudeApp.SeenChecker({ roots: [root] });
  assert.equal(checker.seenAfter(CLI_A, ended), false);                 // 끝나기 전에 본 것은 확인이 아니다
  assert.equal(checker.lastFocusedAt(CLI_A), ended - 5000);
  // 사용자가 그 세션을 다시 띄우면 앱이 파일을 고쳐 쓴다
  fs.writeFileSync(file, JSON.stringify({ sessionId: 'local_aaa-111', cliSessionId: CLI_A, lastFocusedAt: ended + 3000 }), 'utf8');
  fs.utimesSync(file, new Date(ended + 3000), new Date(ended + 3000));
  assert.equal(checker.seenAfter(CLI_A, ended), true);
  assert.equal(checker.seenAfter(CLI_A, ended + 3000), false);          // 같은 시각은 뒤가 아니다
  assert.equal(checker.seenAfter(CLI_A, ended + 9000), false);          // 그 뒤에 또 끝난 작업은 아직 안 봤다
  // 잘못된 입력
  assert.equal(checker.seenAfter(CLI_A, NaN), false);
  assert.equal(checker.seenAfter(CLI_A, null), false);
  assert.equal(checker.seenAfter('', ended), false);
  assert.equal(checker.seenAfter('a".*"b', ended), false);
});

test('앱에서 직접 봤는지: 앱에 없는 세션과 사라진 파일은 조용히 "모름"으로 처리한다', (t) => {
  const root = tempDir(t);
  let now = 1795654600000;
  const checker = new claudeApp.SeenChecker({ roots: [root], now: () => now });
  // 터미널에서 돌린 세션처럼 앱에 파일이 없는 경우
  assert.equal(checker.seenAfter(CLI_B, now - 1000), false);
  // 그 뒤 앱 세션이 생겨도 바로 다시 훑지는 않는다 (매초 전체를 훑지 않기 위함)
  const file = writeSession(root, 'local_bbb-222', { cliSessionId: CLI_B, lastFocusedAt: now + 500 });
  assert.equal(checker.seenAfter(CLI_B, now - 1000), false);
  now += 31000;                                                         // 30초가 지나면 다시 찾아본다
  assert.equal(checker.seenAfter(CLI_B, now - 32000), true);
  // 파일이 지워지면 오류 없이 "모름"
  fs.rmSync(file);
  assert.equal(checker.seenAfter(CLI_B, now - 32000), false);
  // 깨진 파일도 오류를 내지 않는다
  writeSession(root, 'local_ccc-333', { cliSessionId: CLI_OLD });
  fs.writeFileSync(path.join(root, 'claude-code-sessions', 'account-1', 'org-1', 'local_ccc-333.json'), `{"sessionId":"local_ccc-333","cliSessionId":"${CLI_OLD}","padding":"${'x'.repeat(20000)}" 깨짐`, 'utf8');
  assert.equal(checker.seenAfter(CLI_OLD, 0), false);
  // 더 볼 필요가 없는 세션은 기억에서 지운다
  checker.forgetExcept([CLI_OLD]);
  assert.deepEqual(Array.from(checker.entries.keys()), [CLI_OLD]);
});

test('아직 확인하지 않은 완료·오류 세션 목록', () => {
  const T0 = Date.parse('2026-11-25T01:00:00.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const tracker = new SessionTracker();
  assert.deepEqual(tracker.unseenFinished(), []);
  tracker.applyRecord('done-one', { type: 'user', timestamp: iso(T0), message: { content: '작업' } }, { now: T0 });
  tracker.applyRecord('done-one', { type: 'assistant', timestamp: iso(T0 + 1000), message: { content: [{ type: 'text', text: '끝' }], stop_reason: 'end_turn' } }, { now: T0 + 1000 });
  tracker.applyRecord('busy', { type: 'user', timestamp: iso(T0), message: { content: '작업' } }, { now: T0 });
  assert.deepEqual(tracker.unseenFinished(), [{ id: 'done-one', endedAt: T0 + 1000 }]);
  // 앱에서 봤다고 판단되면 확인 처리하고, 목록에서 빠진다
  assert.equal(tracker.acknowledgeSession('done-one'), true);
  assert.deepEqual(tracker.unseenFinished(), []);
  assert.equal(tracker.summary(T0 + 2000).counts.done, 0);
  // 같은 세션에서 다음 작업이 끝나면 다시 대상이 된다
  tracker.applyRecord('done-one', { type: 'user', timestamp: iso(T0 + 5000), message: { content: '다음 작업' } }, { now: T0 + 5000 });
  tracker.applyRecord('done-one', { type: 'assistant', timestamp: iso(T0 + 7000), message: { content: [{ type: 'text', text: '끝' }], stop_reason: 'end_turn' } }, { now: T0 + 7000 });
  assert.deepEqual(tracker.unseenFinished(), [{ id: 'done-one', endedAt: T0 + 7000 }]);
});

test('알림 영역 아이콘 설명 한 줄', () => {
  const labels = { idle: '대기 중', working: '작업 중', done: '다 됐어요' };
  const empty = { primary: null, sessions: [], total: 0 };
  assert.equal(summaryLine(empty, labels, '클로드 펫'), '클로드 펫 · 대기 중');
  assert.equal(summaryLine(null, labels, '클로드 펫'), '클로드 펫 · 대기 중');
  const one = { primary: { state: 'working', title: '주간 리뷰' }, total: 1 };
  assert.equal(summaryLine(one, labels, '클로드 펫'), '클로드 펫 · 작업 중: 주간 리뷰');
  const many = { primary: { state: 'done', title: '  기획서 검토  ' }, total: 3 };
  assert.equal(summaryLine(many, labels, '클로드 펫'), '클로드 펫 · 다 됐어요: 기획서 검토 외 2개');
  assert.equal(summaryLine({ primary: { state: 'waiting' }, total: 1 }, labels), 'waiting');   // 문구가 없으면 상태 이름 그대로
  const long = summaryLine({ primary: { state: 'working', title: '가'.repeat(300) }, total: 1 }, labels, '클로드 펫');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});
