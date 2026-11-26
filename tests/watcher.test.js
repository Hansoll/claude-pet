// 파일 이어 읽기(watcher.js) 시험. 임시 폴더에 가짜 기록 파일을 만들어 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TailReader, TranscriptWatcher, HookEventReader } = require('../watcher.js');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

test('TailReader: 줄이 완성될 때만 돌려주고, 한글이 읽기 경계에서 잘려도 깨지지 않는다', (t) => {
  const file = path.join(tempDir(t), 'a.jsonl');
  const line = Buffer.from('{"글":"한글 문장"}\n', 'utf8');
  const cut = 8;   // 여러 바이트 글자 중간에서 자른다
  fs.writeFileSync(file, line.subarray(0, cut));
  const r = new TailReader(file, { offset: 0 });
  assert.deepEqual(r.readLines(), []);
  fs.appendFileSync(file, line.subarray(cut));
  assert.deepEqual(r.readLines(), ['{"글":"한글 문장"}']);
  assert.deepEqual(r.readLines(), []);
  fs.appendFileSync(file, '{"a":1}\n{"b":2}\n{"c"');
  assert.deepEqual(r.readLines(), ['{"a":1}', '{"b":2}']);
  fs.appendFileSync(file, ':3}\n');
  assert.deepEqual(r.readLines(), ['{"c":3}']);
});

test('TailReader: 중간부터 시작하면 첫 조각 줄을 버린다', (t) => {
  const file = path.join(tempDir(t), 'b.jsonl');
  fs.writeFileSync(file, '{"first":"aaaaaaaa"}\n{"second":2}\n');
  const r = new TailReader(file, { offset: 5, skipPartial: true });
  assert.deepEqual(r.readLines(), ['{"second":2}']);
});

test('TailReader: 파일이 짧아지면 처음부터 다시 읽는다', (t) => {
  const file = path.join(tempDir(t), 'c.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":2}\n');
  const r = new TailReader(file, { offset: 0 });
  assert.equal(r.readLines().length, 2);
  fs.writeFileSync(file, '{"z":9}\n');
  assert.deepEqual(r.readLines(), ['{"z":9}']);
});

test('TailReader: 너무 긴 줄은 버리고 다음 줄부터 이어 읽는다', (t) => {
  const file = path.join(tempDir(t), 'd.jsonl');
  fs.writeFileSync(file, '{"ok":1}\n' + 'x'.repeat(500));
  const r = new TailReader(file, { offset: 0, maxLineBytes: 100 });
  assert.deepEqual(r.readLines(), ['{"ok":1}']);
  assert.equal(r.droppedLines, 1);
  fs.appendFileSync(file, 'yyyy\n{"next":2}\n');
  assert.deepEqual(r.readLines(), ['{"next":2}']);
});

test('TailReader: 파일이 없으면 빈 결과와 missing 표시', (t) => {
  const r = new TailReader(path.join(tempDir(t), 'none.jsonl'), { offset: 0 });
  assert.deepEqual(r.readLines(), []);
  assert.equal(r.missing, true);
});

test('TranscriptWatcher: 시작 시 최근 기록은 되짚고, 이후 추가분과 새 파일을 읽는다', (t) => {
  const root = tempDir(t);
  const project = path.join(root, 'proj-1');
  fs.mkdirSync(project);
  const recent = path.join(project, 'recent.jsonl');
  const quiet = path.join(project, 'quiet.jsonl');
  const ancient = path.join(project, 'ancient.jsonl');
  fs.writeFileSync(recent, '{"type":"user","n":1}\n');
  fs.writeFileSync(quiet, '{"type":"user","n":2}\n');
  fs.writeFileSync(ancient, '{"type":"user","n":3}\n');
  const now = Date.now();
  fs.utimesSync(quiet, new Date(now - 60 * 60 * 1000), new Date(now - 60 * 60 * 1000));
  fs.utimesSync(ancient, new Date(now - 10 * 60 * 60 * 1000), new Date(now - 10 * 60 * 60 * 1000));
  // 하위 폴더(보조 에이전트 기록)는 보지 않는다
  fs.mkdirSync(path.join(project, 'recent', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(project, 'recent', 'subagents', 'agent.jsonl'), '{"type":"user","n":99}\n');

  const logs = [];
  const w = new TranscriptWatcher({ dir: root, log: (m) => logs.push(m) });
  const first = w.poll(now);
  assert.deepEqual(first.map((x) => [x.sessionId, x.rec.n, x.replay]), [['recent', 1, true]]);

  fs.appendFileSync(recent, '{"type":"assistant","n":4}\n깨진 줄\n');
  fs.appendFileSync(quiet, '{"type":"user","n":5}\n');
  const second = w.poll(now + 1000);
  const got = second.map((x) => [x.sessionId, x.rec.n, x.replay]).sort();
  assert.deepEqual(got, [['quiet', 5, false], ['recent', 4, false]]);
  assert.equal(logs.length, 1);   // 깨진 줄 한 건만 기록

  // 실행 중에 새 세션 파일이 생김 → 다음 전체 탐색에서 잡힌다
  const fresh = path.join(project, 'fresh.jsonl');
  fs.writeFileSync(fresh, '{"type":"user","n":6}\n');
  assert.deepEqual(w.poll(now + 2000), []);
  const third = w.poll(now + 7000);
  assert.deepEqual(third.map((x) => [x.sessionId, x.rec.n, x.replay]), [['fresh', 6, false]]);
});

test('TranscriptWatcher: 기록 폴더가 없어도 오류 없이 빈 결과', (t) => {
  const w = new TranscriptWatcher({ dir: path.join(tempDir(t), 'missing') });
  assert.deepEqual(w.poll(Date.now()), []);
});

test('HookEventReader: 시작 전 이벤트는 건너뛰고 이후 것만 읽는다', (t) => {
  const file = path.join(tempDir(t), 'events.jsonl');
  fs.writeFileSync(file, '{"event":"Stop","session_id":"old"}\n');
  const r = new HookEventReader({ file });
  assert.deepEqual(r.poll(), []);
  fs.appendFileSync(file, '{"event":"Stop","session_id":"new","ts":1}\n형식 오류\n{"event":"Stop"}\n');
  assert.deepEqual(r.poll().map((e) => e.session_id), ['new']);
});

test('HookEventReader: 파일이 나중에 생기면 처음부터 읽고, 지워졌다 다시 생겨도 이어진다', (t) => {
  const file = path.join(tempDir(t), 'events.jsonl');
  const r = new HookEventReader({ file });
  assert.deepEqual(r.poll(), []);
  fs.writeFileSync(file, '{"event":"UserPromptSubmit","session_id":"s1"}\n');
  assert.deepEqual(r.poll().map((e) => e.event), ['UserPromptSubmit']);
  fs.rmSync(file);
  assert.deepEqual(r.poll(), []);
  fs.writeFileSync(file, '{"event":"Stop","session_id":"s1"}\n');
  assert.deepEqual(r.poll().map((e) => e.event), ['Stop']);
});
