// GitHub 저장소용 폴더를 만든다(또는 새로 고친다). 프로젝트 폴더(OneDrive)에는 .git을 만들지 않으므로, 올릴 파일만 다른 폴더로 복사한다.
// 실행: node tools/export-github.js [--out=폴더]   (기본: ~/claude-pet-github)
// 넣는 것: 프로그램 소스, 함께 나가는 펫, 시험, 배포·3D 생성 도구, GitHub용 설명과 스크린샷(github/), 개발 안내(README.md → docs/DEVELOPMENT.ko.md)
// 넣지 않는 것: CLAUDE.md(이 PC의 작업 기록), 시안/, 설정·로그(~/.claude-pet), 배포 zip(Releases에 따로 올린다)
//
// GitHub 설명은 언어마다 github/README.<언어>.md 하나씩 둔다. 영어(README.en.md)가 첫 페이지(README.md)가 되고,
// 나머지는 README.<언어>.md로 나간다. 각 파일의 "<!-- languages -->" 줄은 모든 언어로 가는 단추 줄로 바뀐다.
// 새 언어를 더하려면 github/README.<언어>.md와 github/images/<언어>/ 를 만들기만 하면 된다 (단추는 자동으로 생긴다).
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
const RENAMED = [['README.md', 'docs/DEVELOPMENT.ko.md']];   // 이름이나 위치를 바꿔 복사하는 것
const GITHUB_DIR = 'github';
const README_PATTERN = /^README\.([a-z]{2}(?:-[A-Z]{2})?)\.md$/;
const DEFAULT_README_LANG = 'en';                // 첫 페이지 언어
const LANG_MARKER = '<!-- languages -->';
const IMAGES_FROM = 'github/images';
const IMAGES_TO = 'docs/images';
// 언어 단추에 쓰는 이름 (그 언어로 쓴 이름). 없으면 언어 코드를 그대로 쓴다
const LANGUAGE_NAMES = { en: 'English', ko: '한국어', ja: '日本語', zh: '中文', 'zh-TW': '繁體中文', es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português', vi: 'Tiếng Việt' };
const BADGE_COLOR_CURRENT = 'e06a40';            // 지금 보고 있는 언어
const BADGE_COLOR_OTHER = '57606a';
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

// 언어별 설명 파일을 찾는다: [{ lang, from, to }] (첫 페이지 언어가 맨 앞)
function findReadmes(githubDir) {
  const list = [];
  for (const name of fs.readdirSync(githubDir)) {
    const m = README_PATTERN.exec(name);
    if (m) list.push({ lang: m[1], from: path.join(githubDir, name), to: m[1] === DEFAULT_README_LANG ? 'README.md' : `README.${m[1]}.md` });
  }
  list.sort((a, b) => (a.lang === DEFAULT_README_LANG ? -1 : b.lang === DEFAULT_README_LANG ? 1 : a.lang.localeCompare(b.lang)));
  return list;
}

// 언어 단추 줄을 만든다. 지금 언어는 다른 색으로 칠하고, 단추는 각 언어의 설명 파일로 이어진다
function languageBar(readmes, currentLang) {
  const badge = (text, color) => {
    // shields.io 형식: 글자 속 "-"는 "--", "_"는 "__"로 쓴다
    const label = encodeURIComponent(text.replace(/-/g, '--').replace(/_/g, '__'));
    return `https://img.shields.io/badge/${label}-${color}?style=for-the-badge`;
  };
  const items = readmes.map((r) => {
    const name = LANGUAGE_NAMES[r.lang] || r.lang;
    const color = r.lang === currentLang ? BADGE_COLOR_CURRENT : BADGE_COLOR_OTHER;
    return `<a href="${r.to}"><img alt="${name}" src="${badge(name, color)}"></a>`;
  });
  return `<p align="right">\n  ${items.join('\n  ')}\n</p>`;
}

// 설명 파일 속 상대 경로(그림, 링크)가 내보낸 폴더에 실제로 있는지 확인한다. 없는 것을 돌려준다
function missingTargets(markdown, outDir) {
  const missing = [];
  const targets = [];
  for (const m of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) targets.push(m[1]);
  for (const m of markdown.matchAll(/<(?:a|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)) targets.push(m[1]);
  for (const target of targets) {
    if (/^(https?:|mailto:|#)/.test(target) || target.startsWith('../../')) continue;   // 바깥 주소, 문서 안 위치, GitHub 페이지(releases 등)
    const file = decodeURIComponent(target.split('#')[0]);
    if (file && !fs.existsSync(path.join(outDir, file))) missing.push(target);
  }
  return missing;
}

// ── 진입점 ──────────────────────────────────────────────────
function main() {
  const outDir = path.resolve(argValue('out', DEFAULT_OUT));
  const relative = path.relative(ROOT, outDir);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) fail('프로젝트 폴더 안에는 만들 수 없습니다 (OneDrive 폴더에 .git을 만들지 않기 위해)');
  if (/onedrive/i.test(outDir)) fail(`OneDrive 폴더 안에는 만들지 않습니다: ${outDir}`);
  const readmes = findReadmes(path.join(ROOT, GITHUB_DIR));
  if (!readmes.some((r) => r.lang === DEFAULT_README_LANG)) fail(`첫 페이지 설명이 없음: ${GITHUB_DIR}/README.${DEFAULT_README_LANG}.md`);
  fs.mkdirSync(outDir, { recursive: true });
  // 지난번에 복사한 것은 지우고 새로 복사한다 (.git은 그대로 둔다)
  for (const entry of fs.readdirSync(outDir)) {
    if (!KEEP.has(entry)) fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
  }
  for (const rel of FILES) copyFile(rel, rel, outDir);
  for (const rel of FOLDERS) copyFolder(rel, rel, outDir);
  for (const [from, to] of RENAMED) copyFile(from, to, outDir);
  copyFolder(IMAGES_FROM, IMAGES_TO, outDir);
  // 언어별 설명: 단추 줄을 넣고, 깨진 그림·링크가 없는지 확인한 뒤 쓴다
  const problems = [];
  const written = [];
  for (const r of readmes) {
    const text = fs.readFileSync(r.from, 'utf8');
    if (!text.includes(LANG_MARKER)) problems.push(`${path.basename(r.from)}: "${LANG_MARKER}" 줄이 없음`);
    const out = text.replace(LANG_MARKER, languageBar(readmes, r.lang));
    fs.writeFileSync(path.join(outDir, r.to), out, 'utf8');
    written.push({ r, out });
  }
  // 모든 언어 파일을 쓴 뒤에 확인한다 (서로를 가리키는 단추가 있어서)
  for (const { r, out } of written) {
    for (const target of missingTargets(out, outDir)) problems.push(`${path.basename(r.from)}: 없는 파일을 가리킴 (${target})`);
  }
  if (problems.length) fail(`설명 파일 문제\n  ${problems.join('\n  ')}`);
  fs.writeFileSync(path.join(outDir, '.gitignore'), GITIGNORE, 'utf8');
  fs.writeFileSync(path.join(outDir, '.gitattributes'), GITATTRIBUTES, 'utf8');
  let count = 0;
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === '.git') continue; if (e.isDirectory()) walk(path.join(dir, e.name)); else count++; } };
  walk(outDir);
  console.log(`만듦: ${outDir} (파일 ${count}개, 설명 언어: ${readmes.map((r) => `${r.lang}→${r.to}`).join(', ')})`);
}

if (require.main === module) main();

module.exports = { findReadmes, languageBar, missingTargets, LANGUAGE_NAMES };
