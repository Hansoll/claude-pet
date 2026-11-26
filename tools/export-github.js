// GitHub 저장소용 폴더를 만든다(또는 새로 고친다). 프로젝트 폴더(OneDrive)에는 .git을 만들지 않으므로, 올릴 파일만 다른 폴더로 복사한다.
// 실행: node tools/export-github.js [--out=폴더]   (기본: ~/claude-pet-github)
// 넣는 것: 프로그램 소스, 함께 나가는 펫, 시험, 배포·3D 생성 도구, GitHub용 README와 스크린샷(github/), 개발 안내(README.md → docs/DEVELOPMENT.ko.md)
// 넣지 않는 것: CLAUDE.md(이 PC의 작업 기록), 시안/, 설정·로그(~/.claude-pet), 배포 zip(Releases에 따로 올린다)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 설정 상수 ───────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const DEFAULT_OUT = path.join(os.homedir(), 'claude-pet-github');
const FILES = [                                  // 그대로 복사하는 파일
  'main.js', 'preload.js', 'config.js', 'pets.js', 'pet3d.js', 'sessions.js', 'watcher.js', 'claude-app.js',
  'autostart.js', 'hook-event.js', 'install-hooks.js', 'i18n.js', 'zip.js', 'pet-import.js', 'launch.js',
  'pet.html', 'settings.html', 'welcome.html', 'package.json', '펫 실행.bat', '펫 실행.command',
  'assets/tray.png', 'tools/package.js', 'tools/export-github.js',
];
const FOLDERS = ['pets', 'tests', 'tools/pet3d'];   // 통째로 복사하는 폴더
const RENAMED = [                                // 이름이나 위치를 바꿔 복사하는 것
  ['github/README.md', 'README.md'],
  ['README.md', 'docs/DEVELOPMENT.ko.md'],
];
const IMAGES_FROM = 'github/images';
const IMAGES_TO = 'docs/images';
const GITIGNORE = ['node_modules/', 'dist/', '*.log', '.DS_Store', 'Thumbs.db', ''].join('\n');
// 줄바꿈: 맥 실행 스크립트(.command)가 CRLF로 바뀌면 실행되지 않으므로 글 파일은 LF로 고정하고, .bat만 CRLF로 둔다
const GITATTRIBUTES = ['* text=auto eol=lf', '*.bat text eol=crlf', '*.png binary', '*.webp binary', ''].join('\n');
const KEEP = new Set(['.git']);                  // 새로 고칠 때 지우지 않는 것

// 실행 인자에서 "--이름=값"을 꺼낸다
function argValue(name, fallback) {
  const found = ARGS.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

// 실패하면 이유를 알리고 멈춘다
function fail(message) {
  console.error(`GitHub 폴더 만들기 실패: ${message}`);
  process.exit(1);
}

// 파일 하나를 복사한다 (폴더가 없으면 만든다)
function copyFile(fromRel, toRel, outDir) {
  const from = path.join(ROOT, fromRel);
  if (!fs.existsSync(from)) fail(`복사할 파일이 없음: ${fromRel}`);
  const to = path.join(outDir, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 폴더를 통째로 복사한다
function copyFolder(fromRel, toRel, outDir) {
  const from = path.join(ROOT, fromRel);
  if (!fs.existsSync(from)) fail(`복사할 폴더가 없음: ${fromRel}`);
  fs.cpSync(from, path.join(outDir, toRel), { recursive: true });
}

// ── 진입점 ──────────────────────────────────────────────────
function main() {
  const outDir = path.resolve(argValue('out', DEFAULT_OUT));
  const relative = path.relative(ROOT, outDir);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail('프로젝트 폴더 안에는 만들 수 없습니다 (OneDrive 폴더에 .git을 만들지 않기 위해)');
  if (/onedrive/i.test(outDir)) fail(`OneDrive 폴더 안에는 만들지 않습니다: ${outDir}`);
  fs.mkdirSync(outDir, { recursive: true });
  // 지난번에 복사한 것은 지우고 새로 복사한다 (.git은 그대로 둔다)
  for (const entry of fs.readdirSync(outDir)) {
    if (!KEEP.has(entry)) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
  for (const rel of FILES) copyFile(rel, rel, outDir);
  for (const rel of FOLDERS) copyFolder(rel, rel, outDir);
  for (const [from, to] of RENAMED) copyFile(from, to, outDir);
  copyFolder(IMAGES_FROM, IMAGES_TO, outDir);
  fs.writeFileSync(path.join(outDir, '.gitignore'), GITIGNORE, 'utf8');
  fs.writeFileSync(path.join(outDir, '.gitattributes'), GITATTRIBUTES, 'utf8');
  let count = 0;
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === '.git') continue; if (e.isDirectory()) walk(path.join(dir, e.name)); else count++; } };
  walk(outDir);
  console.log(`만듦: ${outDir} (파일 ${count}개)`);
}

main();
