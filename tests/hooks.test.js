// 훅 등록기(install-hooks.js)와 훅 스크립트(hook-event.js) 시험.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hooks = require('../install-hooks.js');
const hookEvent = require('../hook-event.js');

const HOOK_SCRIPT = path.join(__dirname, '..', 'hook-event.js');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

// 다른 도구(Orca)가 이미 훅을 등록해 둔 설정을 흉내 낸다
function otherToolSettings() {
  const other = { type: 'command', command: 'C:/Users/me/.orca/agent-hooks/orca-agent-hook.exe claude', timeout: 10 };
  return {
    hooks: {
      Stop: [{ hooks: [Object.assign({}, other)] }],
      PreToolUse: [{ matcher: '*', hooks: [Object.assign({}, other)] }],
      PermissionRequest: [{ matcher: '*', hooks: [Object.assign({}, other)] }],
    },
    theme: 'custom:orca',
    alwaysThinkingEnabled: true,
  };
}

const handler = hooks.buildHandler('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.claude-pet\\hook-event.js');

test('등록: 기존 훅을 그대로 두고 우리 훅만 추가한다', () => {
  const settings = otherToolSettings();
  const before = JSON.parse(JSON.stringify(settings));
  hooks.addHooks(settings, handler);
  assert.equal(hooks.countHooks(settings), hooks.HOOK_EVENTS.length);
  // 기존 항목 보존
  assert.deepEqual(settings.hooks.Stop[0], before.hooks.Stop[0]);
  assert.deepEqual(settings.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.theme, 'custom:orca');
  // 도구 호출마다 도는 이벤트에는 등록하지 않는다
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUse, undefined);
  // 실행 형식: 셸을 거치지 않고, 기다리게 하지 않는다
  const ours = settings.hooks.Stop[1].hooks[0];
  assert.equal(ours.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(ours.args, ['C:\\Users\\me\\.claude-pet\\hook-event.js']);
  assert.equal(ours.async, true);
});

test('등록을 두 번 해도 중복되지 않고, 제거하면 원래대로 돌아간다', () => {
  const settings = otherToolSettings();
  const before = JSON.parse(JSON.stringify(settings));
  hooks.addHooks(settings, handler);
  hooks.addHooks(settings, handler);
  assert.equal(hooks.countHooks(settings), hooks.HOOK_EVENTS.length);
  assert.equal(hooks.removeHooks(settings), hooks.HOOK_EVENTS.length);
  assert.deepEqual(settings, before);
  assert.equal(hooks.removeHooks(settings), 0);
});

test('빈 설정에 등록했다 제거하면 hooks 항목도 사라진다', () => {
  const settings = { theme: 'dark' };
  hooks.addHooks(settings, handler);
  assert.equal(Object.keys(settings.hooks).length, hooks.HOOK_EVENTS.length);
  hooks.removeHooks(settings);
  assert.deepEqual(settings, { theme: 'dark' });
});

test('우리 훅 판별: 실행 형식과 셸 문자열 형식 모두 알아본다', () => {
  assert.equal(hooks.isOurHandler(handler), true);
  assert.equal(hooks.isOurHandler({ type: 'command', command: 'node "/Users/me/.claude-pet/hook-event.js"' }), true);
  assert.equal(hooks.isOurHandler({ type: 'command', command: 'C:/Users/me/.orca/agent-hooks/orca-agent-hook.exe claude' }), false);
  assert.equal(hooks.isOurHandler({ type: 'command', command: 'node other/hook-event.js' }), false);
  assert.equal(hooks.isOurHandler(null), false);
});

test('설정 파일 쓰기: 백업을 남기고, 깨진 설정은 건드리지 않는다', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(otherToolSettings(), null, 2), 'utf8');
  const original = fs.readFileSync(file, 'utf8');

  const { settings, existed } = hooks.readSettings(file);
  assert.equal(existed, true);
  hooks.addHooks(settings, handler);
  const backup = hooks.writeSettings(file, settings, existed);
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.equal(hooks.countHooks(JSON.parse(fs.readFileSync(file, 'utf8'))), hooks.HOOK_EVENTS.length);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ "hooks": ', 'utf8');
  assert.throws(() => hooks.readSettings(broken), /올바른 JSON이 아님/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ "hooks": ');

  const missing = hooks.readSettings(path.join(dir, 'none.json'));
  assert.deepEqual(missing, { settings: {}, existed: false });
});

test('훅 입력 변환: 필요한 항목만 남긴다', () => {
  const permission = hookEvent.toEvent({
    hook_event_name: 'PermissionRequest', session_id: 's1', cwd: 'C:\\work',
    tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: '빌드 폴더 삭제' },
    transcript_path: 'C:\\secret\\path.jsonl',
  });
  assert.equal(permission.event, 'PermissionRequest');
  assert.equal(permission.tool_detail, '실행: 빌드 폴더 삭제');
  assert.equal(permission.transcript_path, undefined);
  assert.ok(Number.isFinite(permission.ts));

  const prompt = hookEvent.toEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '비밀 내용', session_title: '제목' });
  assert.equal(prompt.prompt, undefined);       // 요청 본문은 저장하지 않는다
  assert.equal(prompt.session_title, '제목');

  assert.equal(hookEvent.toEvent({ hook_event_name: 'PreToolUse', session_id: 's1' }), null);
  assert.equal(hookEvent.toEvent({ hook_event_name: 'Stop' }), null);
  assert.equal(hookEvent.toEvent(null), null);
  assert.equal(hookEvent.toEvent({ hook_event_name: 'StopFailure', session_id: 's1', error: 'rate_limit' }).error, 'rate_limit');
});

test('훅 스크립트 실행: 이벤트 파일에 한 줄을 남기고 아무것도 출력하지 않는다', (t) => {
  const home = tempDir(t);
  const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });
  const eventsFile = path.join(home, '.claude-pet', 'events.jsonl');

  const ok = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc', cwd: '/tmp/프로젝트' }),
    env, encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
  assert.equal(ok.stderr, '');
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const saved = JSON.parse(lines[0]);
  assert.equal(saved.event, 'Stop');
  assert.equal(saved.session_id, 'abc');
  assert.equal(saved.cwd, '/tmp/프로젝트');

  // 깨진 입력, 빈 입력, 관심 없는 이벤트는 조용히 넘어간다
  for (const input of ['{깨진 입력', '', JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'abc' })]) {
    const r = spawnSync(process.execPath, [HOOK_SCRIPT], { input, env, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.equal(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').length, 1);
});

test('실행 파일 훅: 배포판은 실행 파일 하나를, 개발용 실행은 폴더를 함께 부르고, 우리 훅으로 알아본다', () => {
  const config = require('../config.js');
  const packaged = hooks.buildAppHandler('C:/Apps/ClaudePet/ClaudePet.exe', '');
  assert.deepEqual(packaged.args, [config.HOOK_ARG]);
  assert.equal(packaged.async, true);
  const dev = hooks.buildAppHandler('C:/rt/electron.exe', 'C:/proj');
  assert.deepEqual(dev.args, ['C:/proj', config.HOOK_ARG]);
  assert.ok(hooks.isOurHandler(packaged));
  assert.ok(hooks.isOurHandler(dev));
  // 다른 도구의 훅은 우리 것으로 보지 않는다
  assert.ok(!hooks.isOurHandler({ type: 'command', command: 'C:/x/orca-agent-hook.exe', args: ['claude'] }));
});

test('시작할 때 훅 확인: 없으면 등록하고, 멀쩡하면 건드리지 않고, 실행 파일이 사라졌으면 다시 등록한다', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(otherToolSettings()));
  const exe = path.join(dir, 'ClaudePet.exe');
  fs.writeFileSync(exe, 'x');
  const handler = hooks.buildAppHandler(exe, '');
  const first = hooks.ensureHooks(handler, file);
  assert.equal(first.changed, true);
  assert.ok(first.backup, '바꾸기 전 설정을 백업해야 함');
  assert.equal(first.count, hooks.HOOK_EVENTS.length);
  const second = hooks.ensureHooks(handler, file);
  assert.equal(second.changed, false, '멀쩡하면 설정 파일을 다시 쓰지 않는다');
  // 실행 파일을 옮기면(지워지면) 새 경로로 다시 등록한다
  fs.rmSync(exe);
  const moved = path.join(dir, 'moved', 'ClaudePet.exe');
  fs.mkdirSync(path.dirname(moved));
  fs.writeFileSync(moved, 'x');
  const third = hooks.ensureHooks(hooks.buildAppHandler(moved, ''), file);
  assert.equal(third.changed, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(hooks.countHooks(saved), hooks.HOOK_EVENTS.length, '중복 없이 이벤트마다 하나');
  // 다른 도구의 훅은 그대로 남아 있다
  assert.ok(JSON.stringify(saved).includes('orca-agent-hook.exe'));
  // 끄면 우리 훅만 지운다
  assert.equal(hooks.removeOurHooks(file), hooks.HOOK_EVENTS.length);
  assert.equal(hooks.installedCount(file), 0);
  assert.ok(fs.readFileSync(file, 'utf8').includes('orca-agent-hook.exe'));
  assert.equal(hooks.installedCount(path.join(dir, 'none.json')), 0);
});

test('실행 파일 훅은 UserPromptSubmit에 등록하지 않는다 (Electron이 내는 빈 줄이 Claude 입력에 섞이지 않게)', (t) => {
  assert.ok(!hooks.APP_HOOK_EVENTS.includes('UserPromptSubmit'));
  assert.equal(hooks.APP_HOOK_EVENTS.length, hooks.HOOK_EVENTS.length - 1);
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  const exe = path.join(dir, 'ClaudePet.exe');
  fs.writeFileSync(exe, 'x');
  hooks.ensureHooks(hooks.buildAppHandler(exe, ''), file, hooks.APP_HOOK_EVENTS);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.hooks.UserPromptSubmit, undefined);
  assert.equal(hooks.countHooks(saved), hooks.APP_HOOK_EVENTS.length);
  assert.equal(hooks.ensureHooks(hooks.buildAppHandler(exe, ''), file, hooks.APP_HOOK_EVENTS).changed, false);
});
