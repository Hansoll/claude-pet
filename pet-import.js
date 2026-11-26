// 코덱스 펫 압축 파일(.zip)을 펫 폴더로 가져오고, 가져온 펫을 지우는 모듈.
// 보안: pet.json과 시트 그림 두 파일만 꺼내고, pet.json은 허용한 항목만 남겨 다시 쓴다.
// 압축 파일 안의 경로는 쓰지 않으므로 펫 폴더 밖에 파일이 생길 수 없다.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip.js');
const pets = require('./pets.js');

// ── 설정 상수 ───────────────────────────────────────────────
const MANIFEST_NAME = 'pet.json';
const SHEET_PATTERN = /^spritesheet\.(webp|png)$/i;
const MANIFEST_MAX_BYTES = 64 * 1024;
const KEPT_FIELDS = ['id', 'displayName', 'description', 'spriteVersionNumber', 'kind'];   // pet.json에서 남기는 항목
const TEXT_MAX = { displayName: 60, description: 400, kind: 40 };
const TEMP_PREFIX = '.import-';

// 가져오기 실패 (code는 i18n.js의 import.<code> 문구와 맞춘다)
class ImportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail || '';
  }
}

// 압축 파일 이름에서 폴더 부분을 떼고 소문자로 비교할 마지막 이름을 돌려준다
function leafName(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// 항목이 맨 위 또는 폴더 하나 아래에 있는지 (그보다 깊으면 펫 파일로 보지 않는다)
function shallow(name) {
  return String(name).replace(/\\/g, '/').split('/').filter(Boolean).length <= 2;
}

// 압축 파일 내용에서 pet.json과 시트 그림을 찾아 꺼낸다: { manifest, sheet, sheetExt, skipped }
function readArchive(buffer, limits) {
  let entries;
  try {
    entries = zip.listEntries(buffer, { maxEntries: limits.maxEntries });
  } catch (e) {
    throw new ImportError('badZip', e.message);
  }
  const files = entries.filter((e) => !e.isDirectory && !e.isSymlink && shallow(e.name));
  const manifestEntry = files.find((e) => leafName(e.name) === MANIFEST_NAME);
  if (!manifestEntry) throw new ImportError('noManifest');
  // pet.json이 있는 폴더에 같이 있는 시트를 쓴다
  const folder = manifestEntry.name.slice(0, manifestEntry.name.length - MANIFEST_NAME.length);
  const sheetEntry = files.find((e) => e.name.startsWith(folder) && SHEET_PATTERN.test(leafName(e.name)) && shallow(e.name));
  if (!sheetEntry) throw new ImportError('noSheet');
  try {
    const manifestBytes = zip.extractEntry(buffer, manifestEntry, MANIFEST_MAX_BYTES);
    const sheet = zip.extractEntry(buffer, sheetEntry, limits.maxEntryBytes);
    return {
      manifestBytes,
      sheet,
      sheetExt: SHEET_PATTERN.exec(leafName(sheetEntry.name))[1].toLowerCase(),
      skipped: entries.length - 2,
    };
  } catch (e) {
    if (e instanceof zip.ZipError && e.code === 'tooBig') throw new ImportError('tooBig', e.message);
    throw new ImportError('badZip', e.message);
  }
}

// pet.json을 읽어 허용한 항목만 남긴다. id 검사도 여기서 한다
function cleanManifest(bytes, sheetName, idPattern) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new ImportError('invalid', `pet.json: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ImportError('invalid', 'pet.json');
  if (parsed.kind === pets.KIND_3D) throw new ImportError('only2d');
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!idPattern.test(id)) throw new ImportError('badId', id.slice(0, 40));
  const out = {};
  for (const key of KEPT_FIELDS) {
    const value = parsed[key];
    if (typeof value === 'string') out[key] = value.trim().slice(0, TEXT_MAX[key] || 64);
    else if (key === 'spriteVersionNumber' && Number.isInteger(value)) out[key] = value;
  }
  out.id = id;
  out.spritesheetPath = sheetName;
  return out;
}

// 압축 파일 하나를 검사해 임시 폴더에 펫으로 풀어 둔다. 옮기기 전 단계: { id, name, tempDir, targetDir, exists }
function stageArchive(file, options) {
  const o = options || {};
  const limits = {
    maxZipBytes: o.maxZipBytes || 40 * 1024 * 1024,
    maxEntryBytes: o.maxEntryBytes || 30 * 1024 * 1024,
    maxEntries: o.maxEntries || 200,
  };
  if (!/\.zip$/i.test(String(file))) throw new ImportError('notZip');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    throw new ImportError('readFailed', e.message);
  }
  if (!stat.isFile()) throw new ImportError('readFailed', 'not a file');
  if (stat.size > limits.maxZipBytes) throw new ImportError('tooBig', String(Math.round(limits.maxZipBytes / 1024 / 1024)));
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (e) {
    throw new ImportError('readFailed', e.message);
  }

  const archive = readArchive(buffer, limits);
  const sheetName = `spritesheet.${archive.sheetExt}`;
  const manifest = cleanManifest(archive.manifestBytes, sheetName, o.idPattern || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

  // 임시 폴더에 쓰고 기존 검사(pets.loadPet)로 규격을 확인한다
  const root = o.targetRoot;
  fs.mkdirSync(root, { recursive: true });
  const tempDir = path.join(root, `${TEMP_PREFIX}${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tempDir);
  try {
    fs.writeFileSync(path.join(tempDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(tempDir, sheetName), archive.sheet);
    const loaded = pets.loadPet(tempDir, 'imported');
    if (!loaded.ok) throw new ImportError('invalid', loaded.error);
  } catch (e) {
    removeQuietly(tempDir);
    throw e instanceof ImportError ? e : new ImportError('readFailed', e.message);
  }
  const targetDir = path.join(root, manifest.id);
  return { id: manifest.id, name: manifest.displayName || manifest.id, tempDir, targetDir, exists: fs.existsSync(targetDir) };
}

// 임시 폴더를 펫 폴더로 옮긴다. 같은 id가 있으면 지우고 바꾼다 (바꿀지는 부르는 쪽이 먼저 묻는다)
function commitStaged(staged) {
  if (!insideRoot(path.dirname(staged.targetDir), staged.targetDir)) throw new ImportError('badId', staged.id);
  if (fs.existsSync(staged.targetDir)) fs.rmSync(staged.targetDir, { recursive: true, force: true });
  fs.renameSync(staged.tempDir, staged.targetDir);
  return staged.targetDir;
}

// 가져오기를 그만두고 임시 폴더를 지운다
function discardStaged(staged) {
  if (staged && staged.tempDir) removeQuietly(staged.tempDir);
}

// 가져온 펫 폴더를 지운다. root 바로 아래의 폴더만 지운다
function removeImported(root, dir) {
  if (!insideRoot(root, dir) || path.dirname(path.resolve(dir)) !== path.resolve(root)) throw new ImportError('readFailed', 'outside');
  fs.rmSync(dir, { recursive: true, force: true });
}

// 지난번에 멈춘 가져오기의 임시 폴더를 치운다
function cleanupTemp(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return 0; }
  let removed = 0;
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(TEMP_PREFIX)) { removeQuietly(path.join(root, e.name)); removed++; }
  }
  return removed;
}

// dir이 root 안에 있는지
function insideRoot(root, dir) {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// 지우기 (실패해도 멈추지 않는다)
function removeQuietly(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 다음 실행 때 cleanupTemp가 치운다 */ }
}

module.exports = { stageArchive, commitStaged, discardStaged, removeImported, cleanupTemp, ImportError, TEMP_PREFIX };
