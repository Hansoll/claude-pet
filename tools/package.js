// 배포 묶음(zip)을 만든다. 받는 사람은 Node.js 없이 압축을 풀고 실행하면 된다.
// 실행: node tools/package.js [--platform=win,mac] [--out=폴더]
//   윈도우: ClaudePet-<버전>-win-x64.zip  (ClaudePet.exe = 이름만 바꾼 Electron, 프로그램은 resources/app)
//   맥:     ClaudePet-<버전>-mac-<arm64|x64>.zip  (Electron.app은 손대지 않고 그대로, 프로그램은 app 폴더, "Claude Pet.command"로 실행)
// 보안: 넣는 파일은 아래 APP_FILES 목록에 있는 것만 넣는다 (개인 설정, 로그, 시안, 시험 파일이 들어가지 않는다).
// 맥용 Electron은 공식 배포처(GitHub electron/electron 릴리스)에서 한 번 받아 두고, 같은 곳의 SHA256 목록과 맞는지 확인한다.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const config = require('../config.js');
const zip = require('../zip.js');

// ── 설정 상수 ───────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const APP_FILES = [                              // 배포판에 넣는 프로그램 파일 (이것 말고는 넣지 않는다)
  'main.js', 'preload.js', 'config.js', 'pets.js', 'pet3d.js', 'sessions.js', 'watcher.js', 'claude-app.js',
  'autostart.js', 'hook-event.js', 'install-hooks.js', 'i18n.js', 'zip.js', 'pet-import.js',
  'pet.html', 'settings.html', 'welcome.html', 'assets/tray.png',
];
const APP_PET_DIRS = ['orange-pickle', 'orange-pickle-3d'];   // 함께 넣는 펫
const WIN_EXE = 'ClaudePet.exe';
const WIN_SKIP = new Set(['resources/default_app.asar']);     // Electron 기본 화면 (배포판에는 필요 없다)
// Chromium 화면 문구(locales/*.pak, 55개 49MB)는 펫이 지원하는 언어만 넣는다. 없는 언어는 Electron이 en-US로 대신한다.
// 펫에 언어를 더하면(config.LANGUAGES) 여기서 맞는 파일 이름이 자동으로 들어간다. 이름이 다른 언어만 아래 표에 적는다
const CHROMIUM_LOCALE_NAMES = { en: ['en-US'], zh: ['zh-CN', 'zh-TW'], pt: ['pt-BR', 'pt-PT'], es: ['es', 'es-419'] };
const KEEP_LOCALES = new Set(['en-US'].concat(...config.LANGUAGES.map((code) => CHROMIUM_LOCALE_NAMES[code] || [code])));
const MAC_ARCHS = ['arm64', 'x64'];
const MAC_COMMAND = 'Claude Pet.command';
const RELEASE_BASE = `https://github.com/electron/electron/releases/download/v${config.ELECTRON_VERSION}`;
const CACHE_DIR = path.join(config.DATA_DIR, 'build-cache');
const DEFAULT_OUT = path.join(config.DATA_DIR, 'dist');
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 5;

// 실행 인자에서 "--이름=값"을 꺼낸다
function argValue(name, fallback) {
  const found = ARGS.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

// 실패하면 이유를 알리고 멈춘다
function fail(message) {
  console.error(`배포 묶음 만들기 실패: ${message}`);
  process.exit(1);
}

// 폴더 안의 파일을 모두 모은다: [{ rel, full, mode }]
function walk(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

// 프로그램 파일과 함께 넣을 펫 파일을 [{ rel, data }]로 모은다
function appEntries() {
  const entries = [];
  for (const rel of APP_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) fail(`프로그램 파일이 없음: ${rel}`);
    entries.push({ rel, data: fs.readFileSync(full) });
  }
  for (const dirName of APP_PET_DIRS) {
    const dir = path.join(config.PROJECT_PETS_DIR, dirName);
    if (!fs.existsSync(dir)) fail(`펫 폴더가 없음: ${dirName}`);
    for (const file of walk(dir, ROOT)) entries.push({ rel: file.rel, data: fs.readFileSync(file.full) });
  }
  const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 배포판의 package.json: 이름과 시작 파일만 둔다 (개발용 스크립트는 넣지 않는다)
  entries.push({ rel: 'package.json', data: Buffer.from(JSON.stringify({ name: config.APP_ID, productName: 'Claude Pet', version: own.version, main: 'main.js', private: true }, null, 2) + '\n') });
  return { entries, version: own.version };
}

// 받는 사람용 안내문 (한국어·영어)
function readme(platform) {
  const run = platform === 'win'
    ? ['1. 압축을 푼 폴더에서 ClaudePet.exe를 실행합니다.',
      '   처음 한 번 "Windows의 PC 보호" 창이 뜨면 "추가 정보" → "실행"을 누릅니다 (서명하지 않은 프로그램이라서 뜹니다).',
      '   압축을 풀기 전에 zip을 우클릭 → 속성 → "차단 해제"를 체크하면 이 창이 뜨지 않습니다.']
    : [`1. 압축을 푼 폴더에서 "${MAC_COMMAND}"를 우클릭 → 열기 → 열기를 누릅니다 (처음 한 번만).`,
      '   "확인되지 않은 개발자" 경고는 서명하지 않은 프로그램이라서 뜹니다. 다음부터는 두 번 눌러 실행하면 됩니다.'];
  const runEn = platform === 'win'
    ? ['1. Run ClaudePet.exe in the extracted folder.',
      '   If "Windows protected your PC" appears the first time, click "More info" -> "Run anyway" (the program is not code-signed).',
      '   To avoid it, right-click the zip before extracting -> Properties -> check "Unblock".']
    : [`1. Right-click "${MAC_COMMAND}" in the extracted folder -> Open -> Open (first time only).`,
      '   The "unidentified developer" warning appears because the program is not code-signed. After that, just double-click it.'];
  return [
    '클로드 펫 (Claude Pet)',
    '======================',
    '',
    'Claude Code 세션의 진행 상황을 화면 위의 펫으로 보여 줍니다.',
    '',
    '[실행]',
    ...run,
    '2. 처음 실행하면 이 PC의 Claude를 찾아 연결 상태를 보여 줍니다. 로그인이나 비밀번호 입력은 없습니다.',
    '3. 펫을 우클릭하면 메뉴가 나옵니다. "펫 꾸미기…"에서 펫 바꾸기, 크기, 색, 코덱스 펫 압축 파일(.zip) 추가를 합니다.',
    '',
    '[이 프로그램이 하는 일]',
    '- 읽기: ~/.claude/projects (Claude Code 세션 기록), Claude 앱의 세션 목록. 비밀번호와 토큰은 읽지 않습니다.',
    '- 쓰기: ~/.claude/settings.json 에 승인 대기 알림용 훅 추가 (원래 설정은 백업, 다른 도구의 훅은 그대로)',
    '        ~/.claude-pet (설정, 로그, 가져온 펫), 메뉴에서 켰을 때만 로그인 시 자동 실행 등록',
    '- 인터넷에 연결하지 않습니다.',
    '',
    '[지우기]',
    '1. 펫 메뉴에서 "승인 대기 알림 (훅)"과 "컴퓨터 켤 때 자동 실행"을 끕니다.',
    '2. 펫 메뉴에서 "종료"를 누릅니다.',
    '3. 이 폴더와 사용자 폴더의 .claude-pet 폴더를 지웁니다.',
    '',
    '',
    'Claude Pet',
    '==========',
    '',
    'Shows the progress of your Claude Code sessions as a pet on your screen.',
    '',
    '[Run]',
    ...runEn,
    '2. On first run it finds Claude on this computer and shows the connection status. No sign-in or password is needed.',
    '3. Right-click the pet for the menu. Use "Customize pet..." to change the pet, size, color, or add a Codex pet archive (.zip).',
    '',
    '[What it does]',
    '- Reads: ~/.claude/projects (Claude Code session history) and the Claude app\'s session list. Never reads passwords or tokens.',
    '- Writes: approval-alert hooks into ~/.claude/settings.json (the original is backed up; other tools\' hooks are kept),',
    '          ~/.claude-pet (settings, log, imported pets), and a start-at-login entry only if you turn it on.',
    '- Never connects to the internet.',
    '',
    '[Uninstall]',
    '1. In the pet menu, turn off "Approval alerts (hooks)" and "Start at login".',
    '2. Choose "Quit" in the pet menu.',
    '3. Delete this folder and the .claude-pet folder in your user folder.',
    '',
  ].join(platform === 'win' ? '\r\n' : '\n');
}

// 맥 실행 스크립트: 다운로드 표시(격리 속성)를 지우고, Electron으로 app 폴더를 띄운다
function macCommand() {
  return [
    '#!/bin/bash',
    '# Claude Pet launcher. Removes the download quarantine flag from this folder, then starts the pet.',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'xattr -dr com.apple.quarantine "$DIR" 2>/dev/null',
    'nohup "$DIR/Electron.app/Contents/MacOS/Electron" "$DIR/app" >/dev/null 2>&1 &',
    'disown',
    'exit 0',
    '',
  ].join('\n');
}

// 파일의 SHA-256
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 주소에서 받아 Buffer로 돌려준다 (넘겨주기 따라감, 시간 한도)
function download(url, redirects) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'claude-pet-packager' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if ((redirects || 0) >= MAX_REDIRECTS) { reject(new Error(`넘겨주기가 너무 많음: ${url}`)); return; }
        resolve(download(new URL(res.headers.location, url).href, (redirects || 0) + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return; }
      const chunks = [];
      let got = 0;
      const total = Number(res.headers['content-length']) || 0;
      let lastShown = 0;
      res.on('data', (c) => {
        chunks.push(c);
        got += c.length;
        if (total && got - lastShown > 10 * 1024 * 1024) { lastShown = got; process.stdout.write(`  ${Math.round(got / total * 100)}%`); }
      });
      res.on('end', () => { if (total) process.stdout.write('\n'); resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => request.destroy(new Error(`시간 초과: ${url}`)));
    request.on('error', reject);
  });
}

// 맥용 Electron zip을 받아 두고(이미 있으면 그대로 쓰고) 공식 SHA256 목록과 맞는지 확인한다
async function macElectron(arch) {
  const name = `electron-v${config.ELECTRON_VERSION}-darwin-${arch}.zip`;
  const file = path.join(CACHE_DIR, name);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const sumsFile = path.join(CACHE_DIR, `SHASUMS256-${config.ELECTRON_VERSION}.txt`);
  if (!fs.existsSync(sumsFile)) {
    console.log(`받는 중: ${RELEASE_BASE}/SHASUMS256.txt`);
    fs.writeFileSync(sumsFile, await download(`${RELEASE_BASE}/SHASUMS256.txt`));
  }
  const sums = fs.readFileSync(sumsFile, 'utf8');
  const line = sums.split(/\r?\n/).find((l) => l.endsWith(` *${name}`) || l.endsWith(`  ${name}`) || l.endsWith(` ${name}`));
  if (!line) fail(`공식 SHA256 목록에 ${name}이 없음`);
  const expected = line.split(/\s+/)[0].toLowerCase();
  let buffer = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!buffer || sha256(buffer) !== expected) {
    console.log(`받는 중: ${RELEASE_BASE}/${name}`);
    buffer = await download(`${RELEASE_BASE}/${name}`);
    if (sha256(buffer) !== expected) fail(`${name}의 SHA256이 공식 목록과 다름 (받은 파일을 쓰지 않음)`);
    fs.writeFileSync(file, buffer);
  }
  console.log(`확인함: ${name} (SHA256 일치)`);
  return buffer;
}

// 윈도우 묶음: 이 PC의 Electron(런타임 폴더)을 그대로 쓰고 실행 파일 이름만 바꾼다
function buildWindows(app, outDir) {
  const electronDir = path.join(config.RUNTIME_DIR, 'node_modules', 'electron', 'dist');
  const versionFile = path.join(electronDir, 'version');
  if (!fs.existsSync(path.join(electronDir, 'electron.exe'))) fail(`윈도우용 Electron이 없음 (${electronDir}). 먼저 "node launch.js"로 한 번 실행해 설치하세요.`);
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (version && version !== config.ELECTRON_VERSION) fail(`런타임 Electron 버전(${version})이 설정(${config.ELECTRON_VERSION})과 다름`);
  const top = 'ClaudePet';
  const writer = zip.createWriter();
  for (const file of walk(electronDir, electronDir)) {
    if (WIN_SKIP.has(file.rel)) continue;
    const locale = /^locales\/(.+)\.pak$/.exec(file.rel);
    if (locale && !KEEP_LOCALES.has(locale[1])) continue;
    const rel = file.rel === 'electron.exe' ? WIN_EXE : file.rel;
    writer.addFile(`${top}/${rel}`, fs.readFileSync(file.full));
  }
  for (const entry of app.entries) writer.addFile(`${top}/resources/app/${entry.rel}`, entry.data);
  writer.addFile(`${top}/README.txt`, readme('win'));
  const out = path.join(outDir, `ClaudePet-${app.version}-win-x64.zip`);
  fs.writeFileSync(out, writer.toBuffer());
  return out;
}

// 맥 묶음: 받은 Electron.app은 풀지 않고 그대로 옮긴다 (서명과 바로 가기가 깨지지 않게)
async function buildMac(app, outDir, arch) {
  const source = await macElectron(arch);
  const top = 'Claude Pet';
  const writer = zip.createWriter();
  for (const entry of zip.listEntries(source)) {
    if (!entry.name.startsWith('Electron.app/')) continue;          // LICENSE 같은 바깥 파일은 넣지 않는다
    writer.copyEntry(source, entry, `${top}/${entry.name}`);
  }
  for (const entry of app.entries) writer.addFile(`${top}/app/${entry.rel}`, entry.data);
  writer.addFile(`${top}/${MAC_COMMAND}`, macCommand(), 0o755);
  writer.addFile(`${top}/README.txt`, readme('mac'));
  const out = path.join(outDir, `ClaudePet-${app.version}-mac-${arch}.zip`);
  fs.writeFileSync(out, writer.toBuffer());
  return out;
}

// ── 진입점 ──────────────────────────────────────────────────
async function main() {
  const platforms = argValue('platform', 'win,mac').split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = path.resolve(argValue('out', DEFAULT_OUT));
  fs.mkdirSync(outDir, { recursive: true });
  const app = appEntries();
  console.log(`프로그램 파일 ${app.entries.length}개 (버전 ${app.version})`);
  const built = [];
  if (platforms.includes('win')) { built.push(buildWindows(app, outDir)); console.log(`만듦: ${built[built.length - 1]}`); }
  if (platforms.includes('mac')) {
    for (const arch of MAC_ARCHS) { built.push(await buildMac(app, outDir, arch)); console.log(`만듦: ${built[built.length - 1]}`); }
  }
  // 받는 사람이 같은 파일인지 확인할 수 있게 SHA256을 남긴다
  // 한 OS만 다시 만들어도 다른 OS의 값은 남겨 둔다 (지금 폴더에 있는 zip만 적는다)
  const sumsFile = path.join(outDir, 'SHA256SUMS.txt');
  const sums = new Map();
  if (fs.existsSync(sumsFile)) {
    for (const line of fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m && fs.existsSync(path.join(outDir, m[2]))) sums.set(m[2], m[1]);
    }
  }
  const lines = built.map((file) => `${sha256(fs.readFileSync(file))}  ${path.basename(file)}`);
  for (const line of lines) { const [hash, name] = line.split(/\s+/); sums.set(name, hash); }
  fs.writeFileSync(sumsFile, Array.from(sums.entries()).sort().map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n', 'utf8');
  console.log('\nSHA256:');
  for (const [i, line] of lines.entries()) console.log(`  ${line}  (${Math.round(fs.statSync(built[i]).size / 1024 / 1024)}MB)`);
  console.log(`\n폴더: ${outDir}`);
}

main().catch((e) => fail(e.stack || e.message));
