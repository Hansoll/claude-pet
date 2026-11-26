// zip 읽기·쓰기(zip.js)와 코덱스 펫 가져오기(pet-import.js) 시험. 보안 검사(경로 탈출, 크기 한도, 남는 파일)도 확인한다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const zip = require('../zip.js');
const petImport = require('../pet-import.js');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-import-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

// 크기 정보만 담은 가짜 PNG (펫 규격 검사는 머리말의 가로·세로만 본다)
function fakePng(width, height) {
  const buf = Buffer.alloc(64);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// 항목들로 zip 파일을 만들어 경로를 돌려준다
function makeZip(dir, name, entries) {
  const writer = zip.createWriter();
  for (const [entryName, data] of entries) writer.addFile(entryName, data);
  const file = path.join(dir, name);
  fs.writeFileSync(file, writer.toBuffer());
  return file;
}

const GOOD_MANIFEST = JSON.stringify({ id: 'ribbon-test', displayName: 'Ribbon Test', description: 'd', spritesheetPath: 'spritesheet.png', spriteVersionNumber: 2, kind: 'animal' });

test('zip: 쓴 것을 그대로 읽고, 저장과 deflate를 모두 푼다', () => {
  const writer = zip.createWriter();
  const big = Buffer.alloc(5000, 'a');            // 잘 줄어드는 내용 → deflate
  const random = require('crypto').randomBytes(300);   // 안 줄어드는 내용 → 저장
  writer.addFile('a/big.txt', big);
  writer.addFile('random.bin', random);
  writer.addFile('run.command', '#!/bin/bash\n', 0o755);
  const buffer = writer.toBuffer();
  const entries = zip.listEntries(buffer);
  assert.deepEqual(entries.map((e) => e.name), ['a/big.txt', 'random.bin', 'run.command']);
  assert.equal(entries[0].method, 8);
  assert.equal(entries[1].method, 0);
  assert.deepEqual(zip.extractEntry(buffer, entries[0]), big);
  assert.deepEqual(zip.extractEntry(buffer, entries[1]), random);
  assert.equal((entries[2].externalAttr >>> 16) & 0o777, 0o755, '실행 권한이 남아 있어야 함');
});

test('zip: 항목을 풀지 않고 옮기면 권한과 바로 가기 표시가 그대로 남는다', () => {
  const src = zip.createWriter();
  src.addFile('Electron.app/Contents/MacOS/Electron', 'bin', 0o755);
  const srcBuffer = src.toBuffer();
  const entry = zip.listEntries(srcBuffer)[0];
  const out = zip.createWriter();
  out.copyEntry(srcBuffer, entry, 'Claude Pet/Electron.app/Contents/MacOS/Electron');
  const copied = zip.listEntries(out.toBuffer())[0];
  assert.equal(copied.name, 'Claude Pet/Electron.app/Contents/MacOS/Electron');
  assert.equal(copied.externalAttr, entry.externalAttr);
  assert.equal(copied.crc, entry.crc);
});

test('zip: 깨진 파일, 한도를 넘는 내용, 손상된 내용을 알아챈다', () => {
  assert.throws(() => zip.listEntries(Buffer.from('not a zip at all, just text.....')), (e) => e instanceof zip.ZipError);
  const writer = zip.createWriter();
  writer.addFile('big.txt', Buffer.alloc(10000, 'b'));
  const buffer = writer.toBuffer();
  const entry = zip.listEntries(buffer)[0];
  assert.throws(() => zip.extractEntry(buffer, entry, 100), (e) => e.code === 'tooBig');
  // 크기를 속인 압축 폭탄: 목록에는 작다고 적고 실제로는 크게 풀리는 경우
  const lying = Object.assign({}, entry, { size: 50 });
  assert.throws(() => zip.extractEntry(buffer, lying, 100), (e) => e.code === 'tooBig' || e.code === 'bad');
  // 내용 한 바이트를 바꾸면 CRC가 맞지 않는다
  const stored = zip.createWriter();
  stored.addFile('r.bin', require('crypto').randomBytes(64));
  const sb = stored.toBuffer();
  const se = zip.listEntries(sb)[0];
  const tampered = Buffer.from(sb);
  tampered[30 + se.name.length + 5] ^= 0xff;
  assert.throws(() => zip.extractEntry(tampered, se), (e) => e.code === 'bad');
  assert.equal(zip.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(typeof zlib.inflateRawSync, 'function');
});

test('가져오기: 코덱스 펫 zip을 펫 폴더로 만들고, pet.json은 허용한 항목만 남긴다', (t) => {
  const dir = tempDir(t);
  const root = path.join(dir, 'pets');
  const manifest = JSON.parse(GOOD_MANIFEST);
  manifest.hidden = true;                             // 가져온 펫이 스스로 숨거나
  manifest.kind = 'animal';
  manifest.modelPath = '../../evil.json';             // 다른 경로를 가리키는 항목은 버려야 한다
  const file = makeZip(dir, 'ribbon.zip', [
    ['ribbon-test/pet.json', JSON.stringify(manifest)],
    ['ribbon-test/spritesheet.png', fakePng(1536, 2288)],
    ['ribbon-test/readme.exe', 'MZ...'],              // 실행 파일은 꺼내지 않는다
  ]);
  const staged = petImport.stageArchive(file, { targetRoot: root });
  assert.equal(staged.id, 'ribbon-test');
  assert.equal(staged.exists, false);
  petImport.commitStaged(staged);
  const petDir = path.join(root, 'ribbon-test');
  assert.deepEqual(fs.readdirSync(petDir).sort(), ['pet.json', 'spritesheet.png']);
  const saved = JSON.parse(fs.readFileSync(path.join(petDir, 'pet.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['description', 'displayName', 'id', 'kind', 'spriteVersionNumber', 'spritesheetPath']);
  assert.equal(saved.spritesheetPath, 'spritesheet.png');
  // 임시 폴더가 남지 않는다
  assert.deepEqual(fs.readdirSync(root), ['ribbon-test']);
  // 같은 펫을 다시 가져오면 이미 있다고 알려 준다
  const again = petImport.stageArchive(file, { targetRoot: root });
  assert.equal(again.exists, true);
  petImport.discardStaged(again);
  assert.deepEqual(fs.readdirSync(root), ['ribbon-test']);
  // 지우기는 root 바로 아래 폴더만
  assert.throws(() => petImport.removeImported(root, dir));
  petImport.removeImported(root, petDir);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('가져오기: 맨 위에 바로 파일이 있는 zip도 받는다 (codex-pets.net 형식)', (t) => {
  const dir = tempDir(t);
  const file = makeZip(dir, 'flat.codex-pet.zip', [['pet.json', GOOD_MANIFEST], ['spritesheet.png', fakePng(1536, 2288)]]);
  const staged = petImport.stageArchive(file, { targetRoot: path.join(dir, 'pets') });
  assert.equal(staged.name, 'Ribbon Test');
  petImport.discardStaged(staged);
});

test('가져오기: 잘못된 파일은 사유와 함께 거절하고 아무것도 남기지 않는다', (t) => {
  const dir = tempDir(t);
  const root = path.join(dir, 'pets');
  const reject = (file, code, options) => {
    assert.throws(() => petImport.stageArchive(file, Object.assign({ targetRoot: root }, options)), (e) => e instanceof petImport.ImportError && e.code === code, code);
  };
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  reject(path.join(dir, 'a.txt'), 'notZip');
  fs.writeFileSync(path.join(dir, 'broken.zip'), 'this is not a zip file at all');
  reject(path.join(dir, 'broken.zip'), 'badZip');
  reject(makeZip(dir, 'nomanifest.zip', [['spritesheet.png', fakePng(1536, 2288)]]), 'noManifest');
  reject(makeZip(dir, 'nosheet.zip', [['pet.json', GOOD_MANIFEST]]), 'noSheet');
  // 펫 폴더 이름으로 쓸 수 없는 id (경로 탈출 시도 포함)
  for (const id of ['../evil', 'a/b', '', 'CON:']) {
    reject(makeZip(dir, `id${Math.random().toString(36).slice(2)}.zip`, [['pet.json', JSON.stringify({ id })], ['spritesheet.png', fakePng(1536, 2288)]]), 'badId');
  }
  // 3D 펫은 가져오지 않는다 (동작 자료 파일을 받지 않기 때문)
  reject(makeZip(dir, '3d.zip', [['pet.json', JSON.stringify({ id: 'x3d', kind: 'claude-pet-3d' })], ['spritesheet.png', fakePng(1536, 2288)]]), 'only2d');
  // 규격에 맞지 않는 시트
  reject(makeZip(dir, 'size.zip', [['pet.json', GOOD_MANIFEST], ['spritesheet.png', fakePng(100, 100)]]), 'invalid');
  // 너무 큰 압축 파일과 너무 크게 풀리는 항목
  reject(makeZip(dir, 'big.zip', [['pet.json', GOOD_MANIFEST], ['spritesheet.png', fakePng(1536, 2288)]]), 'tooBig', { maxZipBytes: 10 });
  reject(makeZip(dir, 'bomb.zip', [['pet.json', GOOD_MANIFEST], ['spritesheet.png', Buffer.concat([fakePng(1536, 2288), Buffer.alloc(100000)])]]), 'tooBig', { maxEntryBytes: 1000 });
  // 깊은 폴더 속 파일은 펫 파일로 보지 않는다
  reject(makeZip(dir, 'deep.zip', [['a/b/c/pet.json', GOOD_MANIFEST], ['a/b/c/spritesheet.png', fakePng(1536, 2288)]]), 'noManifest');
  // 실패한 뒤 남은 폴더가 없다
  const left = fs.existsSync(root) ? fs.readdirSync(root) : [];
  assert.deepEqual(left, []);
});

test('가져오기: 지난번에 멈춘 임시 폴더를 치운다', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, `${petImport.TEMP_PREFIX}abc`));
  fs.mkdirSync(path.join(dir, 'keep-me'));
  assert.equal(petImport.cleanupTemp(dir), 1);
  assert.deepEqual(fs.readdirSync(dir), ['keep-me']);
  assert.equal(petImport.cleanupTemp(path.join(dir, 'none')), 0);
});
