// 클로드 펫 실행기. Electron 런타임이 없으면 PC별 폴더(~/.claude-pet/runtime)에 설치한 뒤 펫을 띄운다.
// 사용법: node launch.js            (펫 실행)
//         node launch.js --demo     (가짜 상태를 차례로 보여 주는 미리보기)
//         node launch.js --wait     (펫이 끝날 때까지 기다리며 로그를 콘솔에 표시)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('./config.js');

// ── 설정 상수 ───────────────────────────────────────────────
const PASS_ARGS = process.argv.slice(2).filter((a) => a !== '--wait');
const WAIT = process.argv.includes('--wait');
const RUNTIME_PACKAGE = { name: 'claude-pet-runtime', private: true };
const ELECTRON_PACKAGE_JSON = path.join(config.RUNTIME_DIR, 'node_modules', 'electron', 'package.json');
const SPAWN_GRACE_MS = 1500;           // 실행 실패를 알아채기 위해 기다리는 시간

// 오류를 알리고 끝낸다
function fail(message) {
  console.error(message);
  process.exit(1);
}

// Node 버전을 확인한다
function checkNode() {
  const major = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(major) || major < config.MIN_NODE_MAJOR) {
    fail(`Node.js ${config.MIN_NODE_MAJOR} 이상이 필요합니다. (현재 ${process.versions.node})`);
  }
}

// 설치된 Electron 버전을 읽는다. 없으면 null
function installedElectronVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(ELECTRON_PACKAGE_JSON, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Electron 설치 정보 읽기 실패 (${ELECTRON_PACKAGE_JSON}): ${e.message}`);
    return null;
  }
}

// Electron을 PC별 폴더에 설치한다 (OS마다 실행 파일이 달라 OneDrive 폴더에는 두지 않는다)
function installElectron() {
  try {
    fs.mkdirSync(config.RUNTIME_DIR, { recursive: true });
    const pkgFile = path.join(config.RUNTIME_DIR, 'package.json');
    if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, JSON.stringify(RUNTIME_PACKAGE, null, 2) + '\n', 'utf8');
  } catch (e) {
    fail(`런타임 폴더를 준비할 수 없음 (${config.RUNTIME_DIR}): ${e.message}`);
  }
  console.log(`Electron ${config.ELECTRON_VERSION}을 설치합니다. 처음 한 번만 필요하며 몇 분 걸릴 수 있습니다.`);
  console.log(`설치 위치: ${config.RUNTIME_DIR}`);
  const command = `npm install electron@${config.ELECTRON_VERSION} --no-audit --no-fund --loglevel=error`;
  const result = spawnSync(command, { cwd: config.RUNTIME_DIR, shell: true, stdio: 'inherit' });
  if (result.error) fail(`npm 실행 실패: ${result.error.message}. Node.js와 npm이 설치돼 있는지 확인하세요.`);
  if (result.status !== 0) {
    fail(`Electron 설치 실패 (npm 종료 코드 ${result.status}). 네트워크나 사내 프록시 설정을 확인한 뒤 다시 실행하세요.`);
  }
}

// Electron 실행 파일 경로를 찾는다 (실행 파일이 아직 없으면 이때 내려받는다)
function electronBinary() {
  let binary;
  try {
    binary = require(path.join(config.RUNTIME_DIR, 'node_modules', 'electron'));
  } catch (e) {
    fail(`Electron을 불러올 수 없음 (${config.RUNTIME_DIR}): ${e.message}. 폴더를 지우고 다시 실행하면 새로 설치합니다.`);
  }
  if (typeof binary !== 'string' || !fs.existsSync(binary)) {
    fail(`Electron 실행 파일을 찾을 수 없음 (${binary}). ${config.RUNTIME_DIR} 폴더를 지우고 다시 실행하세요.`);
  }
  return binary;
}

// 펫을 띄운다
function launch(binary) {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;     // 이 값이 있으면 Electron이 창 없이 Node처럼 돌아 버린다
  let child;
  try {
    child = spawn(binary, [config.APP_DIR].concat(PASS_ARGS), {
      detached: !WAIT,
      stdio: WAIT ? 'inherit' : 'ignore',
      env,
    });
  } catch (e) {
    fail(`펫 실행 실패 (${binary}): ${e.message}`);
  }
  child.on('error', (e) => fail(`펫 실행 실패 (${binary}): ${e.message}`));
  if (WAIT) {
    child.on('exit', (code) => process.exit(code == null ? 1 : code));
    return;
  }
  child.on('exit', (code) => {
    // 곧바로 끝났다면 이미 실행 중이었거나 시작에 실패한 것이다
    if (code === 0) console.log('이미 실행 중이거나 바로 종료되었습니다.');
    else fail(`펫이 시작 직후 종료되었습니다 (종료 코드 ${code}). 로그: ${config.LOG_FILE}`);
    process.exit(0);
  });
  setTimeout(() => {
    child.unref();
    console.log(`${config.APP_NAME}을 실행했습니다. 끝내려면 펫을 우클릭해 "종료"를 고르세요.`);
    process.exit(0);
  }, SPAWN_GRACE_MS);
}

// ── 진입점 ──────────────────────────────────────────────────
checkNode();
if (installedElectronVersion() !== config.ELECTRON_VERSION) installElectron();
launch(electronBinary());
