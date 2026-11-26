// 코덱스 펫 규격(pet.json + 스프라이트 시트)을 읽고 검증하는 모듈.
// 규격 출처: OpenAI hatch-pet 스킬(9행), codex-pets.net의 v2 펫(11행, 바라보기 16방향).
'use strict';

const fs = require('fs');
const path = require('path');
const pet3d = require('./pet3d.js');

// ── 규격 상수 ───────────────────────────────────────────────
const COLS = 8;                 // 시트 가로 칸 수
const CELL_W = 192;             // 표준 한 칸 너비
const CELL_H = 208;             // 표준 한 칸 높이
const ROWS_V1 = 9;              // v1 행 수
const ROWS_V2 = 11;             // v2 행 수
const LOOK_DIRECTIONS = 16;     // v2 바라보기 방향 수 (위에서 시작해 시계 방향)
const LOOK_FIRST_ROW = 9;       // 바라보기 첫 행
const NEUTRAL_LOOK = { row: 0, frame: 6 };  // v2 정면 응시 칸
const MANIFEST_NAME = 'pet.json';
const DEFAULT_SHEET_NAME = 'spritesheet.webp';
const MAX_SHEET_BYTES = 30 * 1024 * 1024;   // 시트 파일 최대 크기
const MAX_MANIFEST_BYTES = 64 * 1024;       // pet.json 최대 크기
const CELL_RATIO_TOLERANCE = 0.02;          // 칸 비율 허용 오차
// 3D 펫 (이 앱만의 형식. 코덱스 펫과 달리 그림 시트 대신 동작 자료와 색 지도를 쓴다)
const KIND_3D = 'claude-pet-3d';            // pet.json의 kind 값
const DEFAULT_MODEL_NAME = 'model.json';
const DEFAULT_MATCAP_NAME = 'matcap.png';
const MAX_MODEL_BYTES = 2 * 1024 * 1024;    // 동작 자료 최대 크기
const MAX_MATCAP_BYTES = 4 * 1024 * 1024;   // 색 지도 최대 크기
const MATCAP_MIN_SIZE = 32;                 // 색 지도 한 변의 범위
const MATCAP_MAX_SIZE = 1024;

// 마지막 프레임만 길이가 다른 행의 길이 배열을 만든다
function durations(count, each, last) {
  const list = new Array(count).fill(each);
  list[count - 1] = last;
  return list;
}

// 행별 애니메이션 정의 (프레임 수와 프레임 길이 ms)
const ANIMATIONS = [
  { id: 'idle', row: 0, frames: 6, durations: [280, 110, 110, 140, 140, 320] },
  { id: 'running-right', row: 1, frames: 8, durations: durations(8, 120, 220) },
  { id: 'running-left', row: 2, frames: 8, durations: durations(8, 120, 220) },
  { id: 'waving', row: 3, frames: 4, durations: durations(4, 140, 280) },
  { id: 'jumping', row: 4, frames: 5, durations: durations(5, 140, 280) },
  { id: 'failed', row: 5, frames: 8, durations: durations(8, 140, 240) },
  { id: 'waiting', row: 6, frames: 6, durations: durations(6, 150, 260) },
  { id: 'running', row: 7, frames: 6, durations: durations(6, 120, 220) },
  { id: 'review', row: 8, frames: 6, durations: durations(6, 150, 280) },
];

// 행마다 실제로 그림이 들어가는 칸 수 (검증과 시트 생성에 사용)
function usedFramesByRow(version) {
  const used = {};
  for (const a of ANIMATIONS) used[a.row] = a.frames;
  if (version === 2) {
    used[0] = 7;                       // idle 6칸 + 정면 응시 1칸
    used[LOOK_FIRST_ROW] = 8;
    used[LOOK_FIRST_ROW + 1] = 8;
  }
  return used;
}

// 방향 번호(0=위, 시계 방향)를 시트의 칸 위치로 바꾼다
function lookFrame(index) {
  const i = ((Math.round(index) % LOOK_DIRECTIONS) + LOOK_DIRECTIONS) % LOOK_DIRECTIONS;
  return { row: LOOK_FIRST_ROW + Math.floor(i / COLS), frame: i % COLS };
}

// 펫 중심에서 본 커서 방향(dx 오른쪽+, dy 아래+)을 방향 번호로 바꾼다
function directionIndex(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return 0;
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;   // 위=0도, 시계 방향
  const step = 360 / LOOK_DIRECTIONS;
  return ((Math.round(degrees / step) % LOOK_DIRECTIONS) + LOOK_DIRECTIONS) % LOOK_DIRECTIONS;
}

// PNG/WebP 파일 머리말에서 가로·세로 크기를 읽는다
function readImageSize(file) {
  let fd = null;
  const head = Buffer.alloc(64);
  let read = 0;
  try {
    fd = fs.openSync(file, 'r');
    read = fs.readSync(fd, head, 0, head.length, 0);
  } catch (e) {
    throw new Error(`시트 파일을 열 수 없음 (${file}): ${e.message}`);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* 닫기 실패는 무시 */ } }
  }
  return parseImageSize(head.subarray(0, read), file);
}

// 머리말 바이트에서 형식과 크기를 해석한다 (시험에서 직접 호출 가능)
function parseImageSize(head, label) {
  const name = label || '(메모리)';
  if (!head || head.length < 30) throw new Error(`시트 파일이 너무 짧음 (${name})`);
  const isPng = head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a;
  if (isPng) {
    if (head.toString('ascii', 12, 16) !== 'IHDR') throw new Error(`PNG 머리말이 올바르지 않음 (${name})`);
    return { format: 'png', width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  const isWebp = head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  if (isWebp) {
    const chunk = head.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { format: 'webp', width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8L') {
      if (head[20] !== 0x2f) throw new Error(`WebP(무손실) 머리말이 올바르지 않음 (${name})`);
      const bits = head.readUInt32LE(21);
      return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') {
      if (head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a) {
        throw new Error(`WebP(손실) 머리말이 올바르지 않음 (${name})`);
      }
      return { format: 'webp', width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    }
    throw new Error(`알 수 없는 WebP 형식 "${chunk}" (${name})`);
  }
  throw new Error(`PNG나 WebP가 아님 (${name})`);
}

// 시트 크기로 행 수(9 또는 11)를 판별한다. 규격에 맞지 않으면 null
function detectRows(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width % COLS !== 0) return null;
  const cellW = width / COLS;
  const expectedRatio = CELL_H / CELL_W;
  for (const rows of [ROWS_V1, ROWS_V2]) {
    if (height % rows !== 0) continue;
    const ratio = (height / rows) / cellW;
    if (Math.abs(ratio - expectedRatio) <= CELL_RATIO_TOLERANCE) return rows;
  }
  return null;
}

// 펫 폴더 안의 파일 경로를 구한다. 폴더 밖을 가리키면 null
function resolveInside(dir, name) {
  const full = path.resolve(dir, name);
  const relative = path.relative(path.resolve(dir), full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return full;
}

// 3D 펫 폴더(pet.json + 동작 자료 + 색 지도)를 읽어 검증한다
function load3dPet(dir, source, manifest, id) {
  const modelName = typeof manifest.modelPath === 'string' && manifest.modelPath.trim() ? manifest.modelPath.trim() : DEFAULT_MODEL_NAME;
  const matcapName = typeof manifest.matcapPath === 'string' && manifest.matcapPath.trim() ? manifest.matcapPath.trim() : DEFAULT_MATCAP_NAME;
  const modelPath = resolveInside(dir, modelName);
  const matcapPath = resolveInside(dir, matcapName);
  if (!modelPath) return { ok: false, dir, error: `modelPath가 펫 폴더 밖을 가리킴 (${modelName})` };
  if (!matcapPath) return { ok: false, dir, error: `matcapPath가 펫 폴더 밖을 가리킴 (${matcapName})` };

  let model;
  try {
    const stat = fs.statSync(modelPath);
    if (!stat.isFile()) return { ok: false, dir, error: `동작 자료가 파일이 아님 (${modelName})` };
    if (stat.size > MAX_MODEL_BYTES) return { ok: false, dir, error: `동작 자료가 너무 큼 (${stat.size}바이트)` };
    model = JSON.parse(fs.readFileSync(modelPath, 'utf8').replace(/^﻿/, ''));
    pet3d.prepareModel(model);
  } catch (e) {
    const reason = e.code === 'ENOENT' ? `동작 자료 없음 (${modelName})` : `동작 자료가 올바르지 않음 (${modelName}): ${e.message}`;
    return { ok: false, dir, error: reason };
  }

  let size;
  try {
    const stat = fs.statSync(matcapPath);
    if (!stat.isFile()) return { ok: false, dir, error: `색 지도가 파일이 아님 (${matcapName})` };
    if (stat.size > MAX_MATCAP_BYTES) return { ok: false, dir, error: `색 지도가 너무 큼 (${stat.size}바이트)` };
    size = readImageSize(matcapPath);
  } catch (e) {
    const reason = e.code === 'ENOENT' ? `색 지도 없음 (${matcapName})` : e.message;
    return { ok: false, dir, error: reason };
  }
  if (size.format !== 'png') return { ok: false, dir, error: `색 지도는 PNG여야 함 (${matcapName})` };
  if (size.width !== size.height || size.width < MATCAP_MIN_SIZE || size.width > MATCAP_MAX_SIZE) {
    return { ok: false, dir, error: `색 지도 크기가 올바르지 않음 (${size.width}x${size.height}, 정사각형 ${MATCAP_MIN_SIZE}~${MATCAP_MAX_SIZE})` };
  }

  return {
    ok: true,
    pet: {
      key: `${source}:${id}`,
      id,
      source,
      displayName: typeof manifest.displayName === 'string' && manifest.displayName.trim() ? manifest.displayName.trim() : id,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      kind: KIND_3D,
      type: '3d',
      dir,
      modelPath,
      matcapPath,
      matcapSize: size.width,
      model,
      fallback: typeof manifest.fallback === 'string' && manifest.fallback.trim() ? manifest.fallback.trim() : '',
      warnings: [],
    },
  };
}

// pet.json의 선택 항목(언어별 이름, 목록에서 숨기기)을 읽은 결과에 붙인다
function withExtras(result, manifest) {
  if (!result || !result.ok) return result;
  const names = {};
  if (manifest.displayNames && typeof manifest.displayNames === 'object' && !Array.isArray(manifest.displayNames)) {
    for (const lang of Object.keys(manifest.displayNames)) {
      const value = manifest.displayNames[lang];
      if (/^[a-z]{2}$/.test(lang) && typeof value === 'string' && value.trim()) names[lang] = value.trim().slice(0, 60);
    }
  }
  result.pet.displayNames = names;
  result.pet.hidden = manifest.hidden === true;      // 목록에는 안 보이고, 3D를 못 그릴 때 대신 뜨는 용도로만 쓴다
  return result;
}

// 펫 폴더 하나를 읽어 검증한다. 실패해도 예외 대신 사유를 돌려준다
function loadPet(dir, source) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  let manifest;
  try {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile()) return { ok: false, dir, error: 'pet.json이 파일이 아님' };
    if (stat.size > MAX_MANIFEST_BYTES) return { ok: false, dir, error: `pet.json이 너무 큼 (${stat.size}바이트)` };
    const text = fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, '');
    manifest = JSON.parse(text);
  } catch (e) {
    const reason = e.code === 'ENOENT' ? 'pet.json 없음' : `pet.json 읽기 실패: ${e.message}`;
    return { ok: false, dir, error: reason };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, dir, error: 'pet.json 내용이 객체가 아님' };
  }
  const id = typeof manifest.id === 'string' ? manifest.id.trim() : '';
  if (!id) return { ok: false, dir, error: 'pet.json에 id가 없음' };
  if (manifest.kind === KIND_3D) return withExtras(load3dPet(dir, source, manifest, id), manifest);

  const sheetName = typeof manifest.spritesheetPath === 'string' && manifest.spritesheetPath.trim()
    ? manifest.spritesheetPath.trim() : DEFAULT_SHEET_NAME;
  const sheetPath = path.resolve(dir, sheetName);
  const relative = path.relative(path.resolve(dir), sheetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, dir, error: `spritesheetPath가 펫 폴더 밖을 가리킴 (${sheetName})` };
  }

  let size;
  try {
    const stat = fs.statSync(sheetPath);
    if (!stat.isFile()) return { ok: false, dir, error: `시트가 파일이 아님 (${sheetName})` };
    if (stat.size > MAX_SHEET_BYTES) return { ok: false, dir, error: `시트가 너무 큼 (${stat.size}바이트)` };
    size = readImageSize(sheetPath);
  } catch (e) {
    const reason = e.code === 'ENOENT' ? `시트 파일 없음 (${sheetName})` : e.message;
    return { ok: false, dir, error: reason };
  }

  const rows = detectRows(size.width, size.height);
  if (!rows) {
    return { ok: false, dir, error: `시트 크기가 규격과 다름 (${size.width}x${size.height}, 가로 8칸·세로 9행 또는 11행이어야 함)` };
  }
  const version = rows === ROWS_V2 ? 2 : 1;
  const declared = Number(manifest.spriteVersionNumber);
  const warnings = [];
  if (Number.isFinite(declared) && declared !== version) {
    warnings.push(`pet.json의 spriteVersionNumber(${declared})와 시트 행 수(${rows})가 달라 시트 기준으로 처리`);
  }

  return withExtras({
    ok: true,
    pet: {
      key: `${source}:${id}`,
      id,
      source,
      displayName: typeof manifest.displayName === 'string' && manifest.displayName.trim() ? manifest.displayName.trim() : id,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      kind: typeof manifest.kind === 'string' ? manifest.kind : '',
      type: 'sprite',
      version,
      rows,
      dir,
      sheetPath,
      sheetFormat: size.format,
      sheetWidth: size.width,
      sheetHeight: size.height,
      cellWidth: size.width / COLS,
      cellHeight: size.height / rows,
      warnings,
    },
  }, manifest);
}

// 여러 폴더에서 펫을 찾아 모은다. sources: [{ dir, source }]
function discoverPets(sources) {
  const pets = [];
  const errors = [];
  const seen = new Set();
  for (const item of sources || []) {
    if (!item || !item.dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch (e) {
      if (e.code !== 'ENOENT') errors.push({ dir: item.dir, error: `폴더 읽기 실패: ${e.message}` });
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;          // 숨김 폴더와 가져오는 중인 임시 폴더(.import-…)는 펫이 아니다
      const full = path.join(item.dir, entry.name);
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = fs.statSync(full).isDirectory(); } catch (_) { isDir = false; }
      }
      if (!isDir) continue;
      const result = loadPet(full, item.source);
      if (!result.ok) { errors.push({ dir: full, error: result.error }); continue; }
      if (seen.has(result.pet.key)) {
        errors.push({ dir: full, error: `같은 id의 펫이 이미 있음 (${result.pet.id})` });
        continue;
      }
      seen.add(result.pet.key);
      pets.push(result.pet);
    }
  }
  pets.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
  return { pets, errors };
}

module.exports = {
  COLS,
  CELL_W,
  CELL_H,
  ROWS_V1,
  ROWS_V2,
  LOOK_DIRECTIONS,
  LOOK_FIRST_ROW,
  NEUTRAL_LOOK,
  KIND_3D,
  ANIMATIONS,
  usedFramesByRow,
  lookFrame,
  directionIndex,
  readImageSize,
  parseImageSize,
  detectRows,
  loadPet,
  discoverPets,
};
