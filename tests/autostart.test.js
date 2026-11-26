// 자동 실행(autostart.js) 시험. 실제 레지스트리는 건드리지 않고, 명령줄 생성과 맥용 파일 처리만 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const autostart = require('../autostart.js');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

test('지원하는 운영체제', () => {
  assert.equal(autostart.isSupported('win32'), true);
  assert.equal(autostart.isSupported('darwin'), true);
  assert.equal(autostart.isSupported('linux'), false);
});

test('윈도우 명령줄: 공백과 한글이 있는 경로를 따옴표로 감싼다', () => {
  const command = autostart.winCommand('C:\\Users\\me\\.claude-pet\\runtime\\electron.exe', 'C:\\Users\\me\\OneDrive\\문서\\AI\\클로드 펫');
  assert.equal(command, '"C:\\Users\\me\\.claude-pet\\runtime\\electron.exe" "C:\\Users\\me\\OneDrive\\문서\\AI\\클로드 펫"');
});

test('윈도우: 서비스를 거치는 스크립트는 값이나 경로를 직접 담지 않고 환경 변수로 받는다', () => {
  for (const name of ['get', 'set', 'delete']) {
    const script = autostart.PS_SCRIPTS[name];
    assert.match(script, /^[\x20-\x7e]+$/, `${name}: 영문·숫자·기호만 있어야 함 (한글 경로가 명령줄에 들어가면 깨질 수 있다)`);
    assert.ok(script.includes('StdRegProv'), `${name}: 레지스트리 서비스를 불러야 함`);
    assert.ok(script.includes('$env:CLAUDE_PET_REG_KEY') && script.includes('$env:CLAUDE_PET_REG_NAME'));
    assert.ok(!script.includes('ClaudePet') && !script.includes('CurrentVersion'), `${name}: 이름과 위치는 환경 변수로 넘김`);
  }
  assert.ok(autostart.PS_SCRIPTS.get.includes('GetStringValue'));
  assert.ok(autostart.PS_SCRIPTS.set.includes('SetStringValue') && autostart.PS_SCRIPTS.set.includes('$env:CLAUDE_PET_REG_VALUE'));
  assert.ok(autostart.PS_SCRIPTS.delete.includes('DeleteValue'));
  // 현재 사용자 영역(HKEY_CURRENT_USER)만 건드린다
  assert.ok(autostart.PS_SCRIPTS.set.includes('2147483649'));
  assert.equal(autostart.WIN_RUN_KEY, `HKCU\\${autostart.WIN_RUN_SUBKEY}`);
  assert.deepEqual(Object.values(autostart.PS_EXIT).sort(), [0, 3, 4]);
});

test('윈도우: 파워셸에 넘기는 스크립트 인코딩은 되돌리면 원래 글자다', () => {
  const script = autostart.PS_SCRIPTS.set;
  const encoded = autostart.encodePowerShell(script);
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script);
});

test('맥: 켜면 실행 파일과 앱 폴더가 담긴 설정 파일이 생기고, 끄면 사라진다', (t) => {
  const home = tempDir(t);
  const opts = { platform: 'darwin', home, electronPath: '/Users/me/.claude-pet/runtime/Electron.app/Contents/MacOS/Electron', appDir: '/Users/me/OneDrive/문서/AI/클로드 펫 & 친구' };
  assert.equal(autostart.isEnabled(opts), false);

  autostart.setEnabled(true, opts);
  assert.equal(autostart.isEnabled(opts), true);
  const file = autostart.macAgentPath(home);
  assert.equal(file, path.join(home, 'Library', 'LaunchAgents', 'com.claude-pet.autostart.plist'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(text.includes('<string>/Users/me/.claude-pet/runtime/Electron.app/Contents/MacOS/Electron</string>'));
  assert.ok(text.includes('<string>/Users/me/OneDrive/문서/AI/클로드 펫 &amp; 친구</string>'));   // 특수 문자는 이스케이프

  autostart.setEnabled(false, opts);
  assert.equal(autostart.isEnabled(opts), false);
  autostart.setEnabled(false, opts);                // 이미 꺼져 있어도 오류 없음
});

test('필요한 경로가 없거나 지원하지 않는 운영체제면 이유를 알린다', (t) => {
  const home = tempDir(t);
  assert.throws(() => autostart.setEnabled(true, { platform: 'darwin', home }), /경로/);
  assert.throws(() => autostart.setEnabled(true, { platform: 'linux', electronPath: '/x', appDir: '/y' }), /지원하지 않습니다/);
  assert.equal(autostart.isEnabled({ platform: 'linux' }), false);
});
