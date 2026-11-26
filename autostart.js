// 컴퓨터를 켤 때(로그인할 때) 펫이 자동으로 실행되게 등록하거나 해제한다.
// 윈도우: 현재 사용자 레지스트리의 Run 항목. 맥: ~/Library/LaunchAgents 의 plist 파일.
// 사용법(점검용): node autostart.js --status | --enable | --disable
//
// 윈도우에서는 레지스트리를 직접 건드리지 않고 윈도우 서비스(WMI의 StdRegProv)를 거쳐 읽고 쓴다.
// 스토어 앱(예: Claude 데스크톱 앱) 안에서 시작된 프로그램은 레지스트리 쓰기가 그 앱만의 격리된 영역으로
// 돌려져서, reg.exe로 쓴 값이 실제 윈도우에는 들어가지 않는다(2026-11-26 실제로 겪음: 메뉴에는 켜짐으로
// 보였지만 로그인 때 실행되지 않았다). 서비스를 거치면 어디서 시작됐든 실제 설정에 닿는다.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── 설정 상수 ───────────────────────────────────────────────
const WIN_RUN_SUBKEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_RUN_KEY = `HKCU\\${WIN_RUN_SUBKEY}`;
const WIN_VALUE_NAME = 'ClaudePet';
const MAC_AGENT_LABEL = 'com.claude-pet.autostart';
const REG_TIMEOUT_MS = 10000;
const PS_TIMEOUT_MS = 20000;              // 파워셸 실행 한도
const PS_EXIT = { ok: 0, missing: 3, failed: 4 };   // 아래 스크립트가 돌려주는 종료 코드
// 값은 환경 변수로 넘긴다 (명령줄에 한글 경로나 따옴표를 넣지 않기 위함). 2147483649 = HKEY_CURRENT_USER
const PS_ARGS = "$ErrorActionPreference='Stop';$a=@{hDefKey=[uint32]2147483649;sSubKeyName=$env:CLAUDE_PET_REG_KEY;sValueName=$env:CLAUDE_PET_REG_NAME};";
const PS_CALL = 'Invoke-CimMethod -Namespace root\\default -ClassName StdRegProv -Arguments $a -MethodName ';
const PS_SCRIPTS = {
  get: `${PS_ARGS}$r=${PS_CALL}GetStringValue;if($r.ReturnValue -eq 0 -and $r.sValue){exit ${PS_EXIT.ok}}elseif($r.ReturnValue -le 2){exit ${PS_EXIT.missing}}else{exit ${PS_EXIT.failed}}`,
  set: `${PS_ARGS}$a.sValue=$env:CLAUDE_PET_REG_VALUE;$r=${PS_CALL}SetStringValue;if($r.ReturnValue -eq 0){exit ${PS_EXIT.ok}}else{exit ${PS_EXIT.failed}}`,
  delete: `${PS_ARGS}$r=${PS_CALL}DeleteValue;if($r.ReturnValue -eq 0 -or $r.ReturnValue -eq 2){exit ${PS_EXIT.ok}}else{exit ${PS_EXIT.failed}}`,
};

// 이 OS에서 자동 실행을 지원하는지
function isSupported(platform) {
  const p = platform || process.platform;
  return p === 'win32' || p === 'darwin';
}

// 윈도우 Run 항목에 넣을 명령줄을 만든다. 배포판은 appDir 없이 실행 파일만 적는다
function winCommand(electronPath, appDir) {
  return appDir ? `"${electronPath}" "${appDir}"` : `"${electronPath}"`;
}

// 맥 LaunchAgent 파일 경로
function macAgentPath(home) {
  return path.join(home || os.homedir(), 'Library', 'LaunchAgents', `${MAC_AGENT_LABEL}.plist`);
}

// XML에 넣을 글자를 이스케이프한다
function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 맥 LaunchAgent 파일 내용을 만든다
function macAgentPlist(electronPath, appDir) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MAC_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlEscape(electronPath)}</string>`,
    ...(appDir ? [`    <string>${xmlEscape(appDir)}</string>`] : []),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// reg.exe를 실행한다. 종료 코드를 돌려준다
function runReg(args) {
  const result = spawnSync('reg', args, { windowsHide: true, timeout: REG_TIMEOUT_MS, encoding: 'buffer' });
  if (result.error) throw new Error(`reg 실행 실패 (${args[0]}): ${result.error.message}`);
  return result.status;
}

// 파워셸에 넘길 스크립트를 인코딩한다 (-EncodedCommand는 UTF-16LE를 base64로 받는다)
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// 윈도우 서비스(WMI)를 거쳐 Run 값을 읽거나 쓰거나 지운다. 종료 코드를 돌려주고, 실행 자체가 안 되면 null
function runRegistryService(action, value) {
  const script = PS_SCRIPTS[action];
  if (!script) throw new Error(`알 수 없는 동작: ${action}`);
  const env = Object.assign({}, process.env, {
    CLAUDE_PET_REG_KEY: WIN_RUN_SUBKEY,
    CLAUDE_PET_REG_NAME: WIN_VALUE_NAME,
    CLAUDE_PET_REG_VALUE: value || '',
  });
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], {
    env, windowsHide: true, timeout: PS_TIMEOUT_MS, encoding: 'buffer',
  });
  if (result.error || result.status === null) return null;       // 파워셸이 없거나 시간 초과
  return result.status;
}

// 윈도우의 자동 실행 값을 다룬다. 서비스 경유가 안 되는 PC에서만 reg.exe로 대신한다
// 돌려주는 값: 'present' | 'missing' (get), 'done' (set·delete)
function winRegistry(action, value) {
  const code = runRegistryService(action, value);
  if (code === PS_EXIT.ok) return action === 'get' ? 'present' : 'done';
  if (code === PS_EXIT.missing && action === 'get') return 'missing';
  if (code !== null && code !== 1) throw new Error(`자동 실행 설정 ${action} 실패 (윈도우 서비스 응답 코드 ${code})`);
  // 파워셸이나 WMI를 쓸 수 없는 경우: reg.exe로 한다 (스토어 앱 안에서 시작된 경우에는 실제 설정에 닿지 않을 수 있다)
  if (action === 'get') return runReg(['query', WIN_RUN_KEY, '/v', WIN_VALUE_NAME]) === 0 ? 'present' : 'missing';
  if (action === 'set') {
    const status = runReg(['add', WIN_RUN_KEY, '/v', WIN_VALUE_NAME, '/t', 'REG_SZ', '/d', value, '/f']);
    if (status !== 0) throw new Error(`자동 실행 등록 실패 (reg add 종료 코드 ${status})`);
    return 'done';
  }
  if (runReg(['query', WIN_RUN_KEY, '/v', WIN_VALUE_NAME]) === 0) {
    const status = runReg(['delete', WIN_RUN_KEY, '/v', WIN_VALUE_NAME, '/f']);
    if (status !== 0) throw new Error(`자동 실행 해제 실패 (reg delete 종료 코드 ${status})`);
  }
  return 'done';
}

// 자동 실행이 등록돼 있는지 확인한다. opts: { platform, home }
function isEnabled(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (platform === 'win32') {
    return winRegistry('get') === 'present';
  }
  if (platform === 'darwin') {
    try {
      return fs.statSync(macAgentPath(o.home)).isFile();
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw new Error(`자동 실행 파일 확인 실패 (${macAgentPath(o.home)}): ${e.message}`);
    }
  }
  return false;
}

// 자동 실행을 켜거나 끈다. opts: { electronPath, appDir, platform, home }
function setEnabled(flag, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  if (!isSupported(platform)) throw new Error(`이 운영체제(${platform})에서는 자동 실행을 지원하지 않습니다.`);
  // appDir은 개발용 실행(electron + 프로젝트 폴더)일 때만 필요하다. 배포판은 실행 파일 하나로 뜬다
  if (flag && !o.electronPath) throw new Error('자동 실행 등록에 필요한 실행 파일 경로(electronPath)가 없습니다.');

  if (platform === 'win32') {
    if (flag) winRegistry('set', winCommand(o.electronPath, o.appDir));
    else winRegistry('delete');
    // 쓴 값이 실제 설정에 들어갔는지 다시 읽어 확인한다
    const now = winRegistry('get') === 'present';
    if (now !== !!flag) throw new Error(`자동 실행을 ${flag ? '켰' : '껐'}지만 다시 읽어 보니 반영되지 않았습니다.`);
    return;
  }

  const file = macAgentPath(o.home);
  try {
    if (flag) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, macAgentPlist(o.electronPath, o.appDir), 'utf8');
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch (e) {
    throw new Error(`자동 실행 파일 ${flag ? '쓰기' : '삭제'} 실패 (${file}): ${e.message}`);
  }
}

// ── 진입점 (점검용) ─────────────────────────────────────────
if (require.main === module) {
  const config = require('./config.js');
  const args = process.argv.slice(2);
  try {
    if (args.includes('--enable') || args.includes('--disable')) {
      const enable = args.includes('--enable');
      let electronPath = '';
      if (enable) {
        electronPath = require(path.join(config.RUNTIME_DIR, 'node_modules', 'electron'));
      }
      setEnabled(enable, { electronPath, appDir: config.APP_DIR });
    }
    console.log(isEnabled() ? '자동 실행: 켜짐' : '자동 실행: 꺼짐');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = {
  isSupported, isEnabled, setEnabled, winCommand, macAgentPath, macAgentPlist, encodePowerShell,
  WIN_RUN_KEY, WIN_RUN_SUBKEY, WIN_VALUE_NAME, PS_SCRIPTS, PS_EXIT,
};
