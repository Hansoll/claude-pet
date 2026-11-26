// 화면(pet.html, settings.html), 통신 통로(preload.js), 본체(main.js) 사이의 연결이 서로 맞는지 확인한다.
// 기능을 옮기거나 지울 때 한쪽에만 남은 이름을 잡아내려는 시험이다 (Electron을 띄우지 않고 파일 내용만 본다).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../config.js');

const ROOT = path.join(__dirname, '..');
const SCREENS = ['pet.html', 'settings.html', 'welcome.html'];

// 프로젝트 파일을 글자로 읽는다
function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

// 정규식에 걸린 것들의 첫 번째 묶음을 중복 없이 모은다
function collect(text, pattern) {
  return new Set(Array.from(text.matchAll(pattern), (m) => m[1]));
}

// preload.js가 화면에 내놓는 이름과, 듣는 채널·보내는 채널을 뽑는다
function preloadShape() {
  const text = read('preload.js');
  const exposed = collect(text, /^\s{2}([A-Za-z]\w*):/gm);
  const listens = collect(text, /listen\('([\w:-]+)'\)/g);
  const sends = collect(text, /ipcRenderer\.send\('([\w:-]+)'/g);
  return { exposed, listens, sends };
}

test('연결: 화면이 부르는 통로 함수는 모두 preload.js에 있다', () => {
  const { exposed } = preloadShape();
  assert.ok(exposed.size > 10, 'preload.js에서 내놓는 이름을 읽지 못함');
  for (const screen of SCREENS) {
    const used = collect(read(screen), /\bapi\.([A-Za-z]\w*)\s*\(/g);
    assert.ok(used.size > 0, `${screen}에서 통로 함수 사용을 찾지 못함`);
    for (const name of used) assert.ok(exposed.has(name), `${screen}이 부르는 api.${name}이 preload.js에 없음`);
  }
});

test('연결: 화면이 보내는 채널은 모두 본체가 받는다', () => {
  const { sends } = preloadShape();
  const handled = collect(read('main.js'), /ipcMain\.on\('([\w:-]+)'/g);
  for (const channel of sends) assert.ok(handled.has(channel), `preload.js가 보내는 ${channel}을 main.js가 받지 않음`);
  for (const channel of handled) assert.ok(sends.has(channel), `main.js가 받는 ${channel}을 preload.js가 보내지 않음`);
});

test('연결: 본체가 보내는 채널과 화면이 듣는 채널이 같다', () => {
  const { listens } = preloadShape();
  const sent = collect(read('main.js'), /\b(?:send|sendSettings)\('([\w:-]+)'/g);
  for (const channel of sent) assert.ok(listens.has(channel), `main.js가 보내는 ${channel}을 preload.js가 듣지 않음`);
  for (const channel of listens) assert.ok(sent.has(channel), `preload.js가 듣는 ${channel}을 main.js가 보내지 않음`);
});

test('연결: 펫 꾸미기 창으로 옮긴 기능이 펫 화면과 메뉴에 남아 있지 않다', () => {
  const main = read('main.js');
  for (const gone of ['pet:show-size', 'pet:show-color', "label: '펫 바꾸기'", "label: '크기 조절", "label: '색상 바꾸기", "label: '펫 목록 새로 고침'"]) {
    assert.ok(!main.includes(gone), `main.js에 옮긴 기능의 흔적이 남음: ${gone}`);
  }
  assert.ok(main.includes("tr('menu.customize')"), '메뉴에 펫 꾸미기 항목이 없음');
  const pet = read('pet.html');
  for (const gone of ['onShowSize', 'onShowColor', 'id="size"', 'id="color"']) {
    assert.ok(!pet.includes(gone), `pet.html에 옮긴 기능의 흔적이 남음: ${gone}`);
  }
});

test('연결: 화면은 보안 정책을 두고, 바깥 스크립트는 i18n.js와 pet3d.js만 읽고, HTML을 글자로 조립해 넣지 않는다', () => {
  const allowed = { 'pet.html': ['i18n.js', 'pet3d.js'], 'settings.html': ['i18n.js', 'pet3d.js'], 'welcome.html': ['i18n.js'] };
  for (const screen of SCREENS) {
    const text = read(screen);
    assert.match(text, /Content-Security-Policy" content="default-src 'none'/, `${screen}에 보안 정책이 없음`);
    const scripts = Array.from(text.matchAll(/<script[^>]*\bsrc="([^"]+)"/g), (m) => m[1]);
    assert.deepEqual(scripts, allowed[screen], `${screen}이 읽는 바깥 스크립트가 다름`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(text), `${screen}에 HTML을 글자로 넣는 코드가 있음`);
    for (const s of scripts) assert.ok(fs.existsSync(path.join(ROOT, s)), `${s}가 없음`);
  }
});

test('보안: 프로그램은 인터넷에 연결하지 않는다 (외부 주소, 네트워크 모듈, fetch가 없다)', () => {
  const files = ['main.js', 'preload.js', 'config.js', 'pets.js', 'pet3d.js', 'sessions.js', 'watcher.js', 'claude-app.js', 'autostart.js',
    'hook-event.js', 'install-hooks.js', 'i18n.js', 'zip.js', 'pet-import.js'].concat(SCREENS);
  for (const name of files) {
    const text = read(name);
    assert.ok(!/require\(['"](?:node:)?(?:https?|net|tls|dgram|http2)['"]\)/.test(text), `${name}이 네트워크 모듈을 불러옴`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon/.test(text), `${name}에 네트워크 요청 코드가 있음`);
    // 주석과 설정 표준 문서 주소(plist DTD)를 뺀 외부 주소가 없어야 한다
    const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|<!--)/.test(line)).join('\n');
    const urls = (code.match(/https?:\/\/[^\s'"`)<]+/g) || []).filter((u) => !u.startsWith('http://www.apple.com/DTDs/'));
    assert.deepEqual(urls, [], `${name}에 외부 주소가 있음`);
  }
  // 화면의 보안 정책은 바깥 연결을 막는다 (connect-src가 없고 default-src가 'none')
  for (const screen of SCREENS) assert.ok(!/connect-src/.test(read(screen)), `${screen}이 바깥 연결을 허용함`);
});

test('언어: 한국어와 영어 표의 열쇠가 같고, 넣을 값의 자리 수도 같다', () => {
  const i18n = require('../i18n.js');
  const ko = i18n.STRINGS.ko;
  const en = i18n.STRINGS.en;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  const slots = (s) => (s.match(/\{\d\}/g) || []).sort().join(',');
  for (const key of Object.keys(ko)) {
    if (key === 'settings.brokenPet') continue;              // 영어는 자세한 사유 대신 짧은 안내만 보여 준다
    assert.equal(slots(en[key]), slots(ko[key]), `넣을 값의 자리가 다름: ${key}`);
  }
  assert.equal(i18n.t('en', 'tool.edit', 'a.js'), 'Edit: a.js');
  assert.equal(i18n.t('xx', 'state.done'), '다 됐어요', '모르는 언어는 첫 번째 언어로');
  assert.equal(i18n.t('en', 'no.such.key'), 'no.such.key');
  assert.equal(i18n.normalize('ko-KR'), 'ko');
  assert.equal(i18n.normalize('en-US'), 'en');
  assert.equal(i18n.normalize('ja-JP'), 'en');
  assert.deepEqual(i18n.LANGUAGES, config.LANGUAGES);
});

test('언어: 화면과 본체가 쓰는 문구 열쇠가 표에 모두 있다', () => {
  const i18n = require('../i18n.js');
  const keys = new Set(Object.keys(i18n.STRINGS.ko));
  const missing = [];
  const check = (name, pattern) => {
    for (const m of read(name).matchAll(pattern)) if (!keys.has(m[1])) missing.push(`${name}: ${m[1]}`);
  };
  check('main.js', /\btr\('([\w.-]+)'/g);
  check('sessions.js', /\bL\('([\w.-]+)'/g);
  for (const screen of SCREENS) {
    check(screen, /\bT\('([\w.-]+)'/g);
    check(screen, /data-i18n(?:-title)?="([\w.-]+)"/g);
  }
  // 동작 단추, 상태 단추, 색 이름처럼 열쇠를 이어 붙이는 문구
  for (const s of ['idle', 'working', 'waiting', 'done', 'failed']) for (const p of ['state', 'chip']) if (!keys.has(`${p}.${s}`)) missing.push(`${p}.${s}`);
  for (const p of config.COLOR_PRESETS) if (!keys.has(`color.${p.id}`)) missing.push(`color.${p.id}`);
  for (const id of ['waving', 'jumping', 'running-right', 'running-left', 'review']) if (!keys.has(`action.${id}`)) missing.push(`action.${id}`);
  assert.deepEqual(missing, []);
});

test('연결: 펫 꾸미기 창의 상태·동작 단추로 펫 규격의 동작을 모두 볼 수 있다', () => {
  const { ANIMATIONS } = require('../pets.js');
  const text = read('settings.html');
  const block = (name) => {
    const m = new RegExp(`const ${name} = ([\\s\\S]*?);\\n`).exec(text);
    assert.ok(m, `settings.html에서 ${name}을 찾지 못함`);
    return m[1];
  };
  const reachable = new Set();
  for (const m of block('BASE_ANIMATION').matchAll(/:\s*'([\w-]+)'/g)) reachable.add(m[1]);
  for (const m of block('ACTIONS').matchAll(/id:\s*'([\w-]+)'/g)) reachable.add(m[1]);
  for (const anim of ANIMATIONS) assert.ok(reachable.has(anim.id), `미리보기에서 볼 수 없는 동작: ${anim.id}`);
  for (const id of reachable) assert.ok(ANIMATIONS.some((a) => a.id === id), `규격에 없는 동작 단추: ${id}`);
});

test('설정: 코덱스 펫 폴더는 꺼 두면 펫을 찾는 곳에서 빠진다', () => {
  assert.equal(typeof config.INCLUDE_CODEX_PETS, 'boolean');
  const main = read('main.js');
  assert.ok(!/discoverPets\(\[/.test(main), 'main.js가 petSources()를 거치지 않고 펫 폴더를 훑음');
  assert.match(main, /if \(config\.INCLUDE_CODEX_PETS\) sources\.push/);
});

test('설정: 펫 꾸미기 창의 크기와 준비된 색이 올바르다', () => {
  for (const key of ['SETTINGS_WINDOW_WIDTH', 'SETTINGS_WINDOW_HEIGHT', 'WELCOME_WINDOW_WIDTH', 'WELCOME_WINDOW_HEIGHT']) {
    assert.ok(Number.isInteger(config[key]) && config[key] >= 400 && config[key] <= 1200, `${key} 값이 이상함: ${config[key]}`);
  }
  assert.ok(Array.isArray(config.COLOR_PRESETS) && config.COLOR_PRESETS.length > 0);
  for (const preset of config.COLOR_PRESETS) {
    assert.match(preset.id, /^[a-z]+$/);
    assert.match(preset.hex, /^#[0-9a-f]{6}$/);
  }
  assert.ok(config.SCALE_MIN > 0 && config.SCALE_MAX > config.SCALE_MIN && config.SCALE_STEP > 0);
});

test('GitHub 설명: 영어가 첫 페이지이고, 언어마다 모든 언어로 가는 단추와 그 언어의 그림이 있다', () => {
  const exporter = require('../tools/export-github.js');
  const githubDir = path.join(ROOT, 'github');
  const readmes = exporter.findReadmes(githubDir);
  assert.equal(readmes[0].lang, 'en');
  assert.equal(readmes[0].to, 'README.md');
  assert.ok(readmes.some((r) => r.lang === 'ko' && r.to === 'README.ko.md'));
  const bar = exporter.languageBar(readmes, 'ko');
  for (const r of readmes) assert.ok(bar.includes(`href="${r.to}"`), `단추 없음: ${r.lang}`);
  assert.ok(bar.includes(encodeURIComponent('한국어')));
  for (const r of readmes) {
    const text = fs.readFileSync(r.from, 'utf8');
    assert.ok(text.includes('<!-- languages -->'), `${r.lang}: 언어 단추 자리 표시가 없음`);
    // 그 언어의 설명은 그 언어 폴더나 공통 폴더의 그림만 쓴다 (다른 언어 그림을 잘못 가리키지 않게)
    for (const m of text.matchAll(/docs\/images\/([^/]+)\//g)) assert.ok(m[1] === r.lang || m[1] === 'common', `${r.lang}: 다른 언어의 그림을 씀 (${m[0]})`);
    // 가리키는 그림이 github/images 아래에 실제로 있다
    for (const m of text.matchAll(/\]\((docs\/images\/[^)]+)\)/g)) {
      assert.ok(fs.existsSync(path.join(githubDir, 'images', m[1].slice('docs/images/'.length))), `${r.lang}: 그림 없음 ${m[1]}`);
    }
  }
});
