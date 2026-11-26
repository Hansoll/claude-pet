// 펫 규격(pets.js) 시험. 코덱스 펫 형식 판별과 검증을 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pets = require('../pets.js');
const config = require('../config.js');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

// 크기 정보만 담은 가짜 PNG 머리말을 만든다
function fakePng(width, height) {
  const buf = Buffer.alloc(40);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// 가짜 WebP 머리말을 만든다 (kind: VP8X | VP8L | VP8)
function fakeWebp(kind, width, height) {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  if (kind === 'VP8X') {
    buf.write('VP8X', 12, 'ascii');
    buf.writeUIntLE(width - 1, 24, 3);
    buf.writeUIntLE(height - 1, 27, 3);
  } else if (kind === 'VP8L') {
    buf.write('VP8L', 12, 'ascii');
    buf[20] = 0x2f;
    buf.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    buf.write('VP8 ', 12, 'ascii');
    buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a;
    buf.writeUInt16LE(width, 26);
    buf.writeUInt16LE(height, 28);
  }
  return buf;
}

// 임시 펫 폴더를 만든다
function makePet(root, name, manifest, sheet) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'pet.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8');
  }
  if (sheet) fs.writeFileSync(path.join(dir, sheet.name), sheet.data);
  return dir;
}

test('이미지 머리말에서 크기를 읽는다 (PNG, WebP 세 종류)', () => {
  assert.deepEqual(pets.parseImageSize(fakePng(1536, 2288)), { format: 'png', width: 1536, height: 2288 });
  assert.deepEqual(pets.parseImageSize(fakeWebp('VP8X', 1536, 1872)), { format: 'webp', width: 1536, height: 1872 });
  assert.deepEqual(pets.parseImageSize(fakeWebp('VP8L', 1536, 2288)), { format: 'webp', width: 1536, height: 2288 });
  assert.deepEqual(pets.parseImageSize(fakeWebp('VP8', 1536, 1872)), { format: 'webp', width: 1536, height: 1872 });
  assert.throws(() => pets.parseImageSize(Buffer.from('GIF89a' + 'x'.repeat(40))), /PNG나 WebP가 아님/);
  assert.throws(() => pets.parseImageSize(Buffer.alloc(4)), /너무 짧음/);
});

test('시트 크기로 행 수를 판별한다', () => {
  assert.equal(pets.detectRows(1536, 1872), 9);
  assert.equal(pets.detectRows(1536, 2288), 11);
  assert.equal(pets.detectRows(768, 936), 9);      // 절반 크기도 비율이 맞으면 허용
  assert.equal(pets.detectRows(3072, 4576), 11);   // 두 배 크기
  assert.equal(pets.detectRows(1536, 2000), null);
  assert.equal(pets.detectRows(1500, 1872), null);
  assert.equal(pets.detectRows(0, 0), null);
});

test('행별 사용 칸 수', () => {
  assert.deepEqual(pets.usedFramesByRow(1), { 0: 6, 1: 8, 2: 8, 3: 4, 4: 5, 5: 8, 6: 6, 7: 6, 8: 6 });
  const v2 = pets.usedFramesByRow(2);
  assert.equal(v2[0], 7);
  assert.equal(v2[9], 8);
  assert.equal(v2[10], 8);
  for (const a of pets.ANIMATIONS) assert.equal(a.durations.length, a.frames);
});

test('커서 방향을 16방향 번호와 시트 칸으로 바꾼다', () => {
  assert.equal(pets.directionIndex(0, -10), 0);    // 위
  assert.equal(pets.directionIndex(10, -10), 2);   // 오른쪽 위
  assert.equal(pets.directionIndex(10, 0), 4);     // 오른쪽
  assert.equal(pets.directionIndex(0, 10), 8);     // 아래
  assert.equal(pets.directionIndex(-10, 0), 12);   // 왼쪽
  assert.equal(pets.directionIndex(-1, -10), 0);   // 거의 위 (반올림)
  assert.equal(pets.directionIndex(0, 0), 0);
  assert.deepEqual(pets.lookFrame(0), { row: 9, frame: 0 });
  assert.deepEqual(pets.lookFrame(7), { row: 9, frame: 7 });
  assert.deepEqual(pets.lookFrame(8), { row: 10, frame: 0 });
  assert.deepEqual(pets.lookFrame(15), { row: 10, frame: 7 });
  assert.deepEqual(pets.lookFrame(16), { row: 9, frame: 0 });
  assert.deepEqual(pets.lookFrame(-1), { row: 10, frame: 7 });
});

test('펫 폴더 읽기: 정상 v2, v1, 이름 기본값', (t) => {
  const root = tempDir(t);
  const v2 = pets.loadPet(makePet(root, 'cat', { id: 'cat', displayName: '고양이', spritesheetPath: 'sheet.png', spriteVersionNumber: 2, kind: 'animal' }, { name: 'sheet.png', data: fakePng(1536, 2288) }), 'project');
  assert.equal(v2.ok, true);
  assert.equal(v2.pet.version, 2);
  assert.equal(v2.pet.rows, 11);
  assert.equal(v2.pet.key, 'project:cat');
  assert.equal(v2.pet.cellWidth, 192);
  assert.equal(v2.pet.cellHeight, 208);
  assert.deepEqual(v2.pet.warnings, []);

  // spritesheetPath와 displayName이 없으면 기본값을 쓴다. BOM이 붙어 있어도 읽는다
  const v1 = pets.loadPet(makePet(root, 'dog', '﻿{"id":"dog"}', { name: 'spritesheet.webp', data: fakeWebp('VP8X', 1536, 1872) }), 'codex');
  assert.equal(v1.ok, true);
  assert.equal(v1.pet.version, 1);
  assert.equal(v1.pet.displayName, 'dog');
  assert.equal(v1.pet.sheetFormat, 'webp');
});

test('펫 폴더 읽기: 문제 있는 펫은 사유와 함께 거른다', (t) => {
  const root = tempDir(t);
  const png = { name: 'spritesheet.webp', data: fakeWebp('VP8X', 1536, 1872) };
  assert.match(pets.loadPet(makePet(root, 'a'), 'project').error, /pet\.json 없음/);
  assert.match(pets.loadPet(makePet(root, 'b', '{깨진'), 'project').error, /읽기 실패/);
  assert.match(pets.loadPet(makePet(root, 'c', '[]', png), 'project').error, /객체가 아님/);
  assert.match(pets.loadPet(makePet(root, 'd', { displayName: '이름만' }, png), 'project').error, /id가 없음/);
  assert.match(pets.loadPet(makePet(root, 'e', { id: 'e' }), 'project').error, /시트 파일 없음/);
  assert.match(pets.loadPet(makePet(root, 'f', { id: 'f', spritesheetPath: '../a/spritesheet.webp' }), 'project').error, /펫 폴더 밖/);
  assert.match(pets.loadPet(makePet(root, 'g', { id: 'g' }, { name: 'spritesheet.webp', data: fakeWebp('VP8X', 1000, 1000) }), 'project').error, /규격과 다름/);
  assert.match(pets.loadPet(makePet(root, 'h', { id: 'h' }, { name: 'spritesheet.webp', data: Buffer.from('not an image at all, just text padding....') }), 'project').error, /PNG나 WebP가 아님/);
});

test('펫 폴더 읽기: 선언한 버전과 시트가 다르면 시트 기준으로 처리하고 경고', (t) => {
  const root = tempDir(t);
  const r = pets.loadPet(makePet(root, 'x', { id: 'x', spriteVersionNumber: 2 }, { name: 'spritesheet.webp', data: fakeWebp('VP8X', 1536, 1872) }), 'project');
  assert.equal(r.ok, true);
  assert.equal(r.pet.version, 1);
  assert.equal(r.pet.warnings.length, 1);
});

test('여러 폴더에서 펫 찾기: 없는 폴더는 건너뛰고 오류는 따로 모은다', (t) => {
  const root = tempDir(t);
  const project = path.join(root, 'project');
  const codex = path.join(root, 'codex');
  const sheet = { name: 'spritesheet.webp', data: fakeWebp('VP8X', 1536, 2288) };
  makePet(project, 'blob', { id: 'blob', displayName: '점토' }, sheet);
  makePet(project, 'broken', '{');
  makePet(codex, 'blob', { id: 'blob', displayName: '코덱스 점토' }, sheet);
  makePet(codex, 'cat', { id: 'cat', displayName: '고양이' }, sheet);
  fs.writeFileSync(path.join(codex, 'readme.txt'), '폴더가 아닌 파일');
  const found = pets.discoverPets([
    { dir: project, source: 'project' },
    { dir: codex, source: 'codex' },
    { dir: path.join(root, 'missing'), source: 'codex' },
  ]);
  assert.deepEqual(found.pets.map((p) => p.key).sort(), ['codex:blob', 'codex:cat', 'project:blob']);
  assert.equal(found.errors.length, 1);
  assert.match(found.errors[0].error, /읽기 실패/);
});

test('기본 캐릭터 묶음이 규격에 맞는다', () => {
  const found = pets.discoverPets([{ dir: config.PROJECT_PETS_DIR, source: 'project' }]);
  assert.deepEqual(found.errors, []);
  // 사용자가 정한 펫 구성: 목록에는 모찌 3D만 보이고, 모찌 이미지판은 3D를 못 그릴 때 대신 뜨는 용도로 숨겨 둔다
  const three = found.pets.find((p) => p.id === config.DEFAULT_PET_ID);
  assert.ok(three, `기본 펫(${config.DEFAULT_PET_ID})이 pets 폴더에 있어야 함`);
  assert.equal(three.type, '3d');
  assert.equal(three.hidden, false);
  assert.equal(three.fallback, config.FALLBACK_PET_ID);
  const mochi = found.pets.find((p) => p.id === config.FALLBACK_PET_ID);
  assert.ok(mochi, `대신용 펫(${config.FALLBACK_PET_ID})이 pets 폴더에 있어야 함`);
  assert.equal(mochi.type, 'sprite', '대신용 펫은 3D를 못 그리는 PC에서도 떠야 하므로 이미지 펫이어야 함');
  assert.equal(mochi.hidden, true);
  assert.equal(mochi.version, 2);
  assert.equal(mochi.sheetWidth, 1536);
  assert.equal(mochi.sheetHeight, 2288);
  assert.deepEqual(found.pets.filter((p) => !p.hidden).map((p) => p.displayName), ['모찌 3D']);
  assert.deepEqual(mochi.displayNames, { ko: '모찌', en: 'Mochi' });
});

test('pet.json의 언어별 이름과 숨기기를 읽고, 이상한 값은 버린다', (t) => {
  const dir = tempDir(t);
  const sheet = Buffer.concat([fakePng(1536, 2288), Buffer.alloc(16)]);
  const write = (name, manifest) => {
    const petDir = path.join(dir, name);
    fs.mkdirSync(petDir);
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(Object.assign({ id: name, spritesheetPath: 'spritesheet.png' }, manifest)));
    fs.writeFileSync(path.join(petDir, 'spritesheet.png'), sheet);
    return pets.loadPet(petDir, 'project');
  };
  const good = write('a', { displayName: '가', displayNames: { ko: '가', en: 'A', xx1: 'bad', fr: 5 }, hidden: true });
  assert.ok(good.ok, good.error);
  assert.deepEqual(good.pet.displayNames, { ko: '가', en: 'A' });
  assert.equal(good.pet.hidden, true);
  const plain = write('b', { hidden: 'yes', displayNames: ['x'] });
  assert.ok(plain.ok, plain.error);
  assert.deepEqual(plain.pet.displayNames, {});
  assert.equal(plain.pet.hidden, false, 'hidden은 true일 때만 숨긴다');
  // 점으로 시작하는 폴더(가져오는 중인 임시 폴더)는 펫으로 보지 않는다
  fs.mkdirSync(path.join(dir, '.import-123'));
  const found = pets.discoverPets([{ dir, source: 'project' }]);
  assert.deepEqual(found.errors, []);
  assert.equal(found.pets.length, 2);
});

test('이 PC의 코덱스 펫 폴더가 있으면 오류 없이 읽힌다', (t) => {
  if (!fs.existsSync(config.CODEX_PETS_DIR)) { t.skip('코덱스 펫 폴더 없음'); return; }
  const found = pets.discoverPets([{ dir: config.CODEX_PETS_DIR, source: 'codex' }]);
  for (const p of found.pets) {
    assert.ok(p.rows === 9 || p.rows === 11);
    assert.ok(fs.existsSync(p.sheetPath));
  }
  t.diagnostic(`코덱스 펫 ${found.pets.length}개 인식, 제외 ${found.errors.length}개`);
});
