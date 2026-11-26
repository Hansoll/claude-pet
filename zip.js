// 작은 zip 읽기·쓰기 모듈. 외부 패키지 없이 Node 내장 zlib만 쓴다.
// 읽기: 펫 가져오기(pet-import.js)가 쓴다. 쓰기: 배포 묶음 만들기(tools/package.js)가 쓴다.
// 지원 범위: 압축 방식은 저장(0)과 deflate(8)만, ZIP64와 암호는 지원하지 않는다.
'use strict';

const zlib = require('zlib');

// ── 설정 상수 ───────────────────────────────────────────────
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const END_MIN_BYTES = 22;
const END_SEARCH_BYTES = 22 + 0xffff;       // 끝 기록은 주석(최대 64KB) 앞에 있다
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const VERSION_UNIX = 3;                     // "만든 곳" 값: 유닉스 (권한 비트를 담을 때)
const VERSION_NEEDED = 20;
const DOS_EPOCH_TIME = 0;                   // 시각은 1980-01-01 00:00으로 고정 (같은 입력이면 같은 zip이 나온다)
const DOS_EPOCH_DATE = (0 << 9) | (1 << 5) | 1;

// CRC-32 표 (zlib.crc32가 없는 Node 버전용)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

// 바이트 묶음의 CRC-32를 구한다
function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zip 형식 오류 (사유를 code로 구분한다)
class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// zip의 항목 목록을 읽는다. 내용은 풀지 않는다: [{ name, method, compressedSize, size, crc, offset, flags, externalAttr, versionMadeBy, isDirectory, isSymlink }]
function listEntries(buffer, options) {
  const maxEntries = (options && options.maxEntries) || Infinity;
  if (!Buffer.isBuffer(buffer) || buffer.length < END_MIN_BYTES) throw new ZipError('bad', 'zip이 아니거나 너무 작음');
  // 끝 기록을 뒤에서부터 찾는다
  let end = -1;
  const stop = Math.max(0, buffer.length - END_SEARCH_BYTES);
  for (let i = buffer.length - END_MIN_BYTES; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new ZipError('bad', 'zip 끝 기록을 찾지 못함');
  const count = buffer.readUInt16LE(end + 10);
  const dirSize = buffer.readUInt32LE(end + 12);
  const dirOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError('unsupported', 'ZIP64는 지원하지 않음');
  if (count > maxEntries) throw new ZipError('tooMany', `항목이 너무 많음 (${count}개)`);
  if (dirOffset + dirSize > buffer.length) throw new ZipError('bad', '목록 위치가 파일 밖을 가리킴');

  const entries = [];
  let p = dirOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bad', `목록 항목 ${k}이 깨짐`);
    const versionMadeBy = buffer.readUInt16LE(p + 4);
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const externalAttr = buffer.readUInt32LE(p + 38);
    const offset = buffer.readUInt32LE(p + 42);
    if (p + 46 + nameLength > buffer.length) throw new ZipError('bad', `목록 항목 ${k}의 이름이 깨짐`);
    const rawName = buffer.subarray(p + 46, p + 46 + nameLength);
    const name = rawName.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1');
    const unixMode = (versionMadeBy >> 8) === VERSION_UNIX ? (externalAttr >>> 16) & 0xffff : 0;
    entries.push({
      name,
      rawName,
      method,
      crc,
      compressedSize,
      size,
      offset,
      flags,
      externalAttr,
      versionMadeBy,
      isDirectory: name.endsWith('/'),
      isSymlink: (unixMode & 0o170000) === 0o120000,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// 항목의 압축된 내용이 시작하는 위치를 구한다
function dataStart(buffer, entry) {
  const p = entry.offset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== SIG_LOCAL) throw new ZipError('bad', `항목 머리가 깨짐 (${entry.name})`);
  const start = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);
  if (start + entry.compressedSize > buffer.length) throw new ZipError('bad', `항목 내용이 파일 밖으로 나감 (${entry.name})`);
  return start;
}

// 항목 하나를 풀어 내용을 돌려준다. maxBytes보다 크게 풀리면 멈춘다 (압축 폭탄 방지)
function extractEntry(buffer, entry, maxBytes) {
  const limit = Number.isFinite(maxBytes) ? maxBytes : Infinity;
  if (entry.flags & FLAG_ENCRYPTED) throw new ZipError('unsupported', `암호가 걸린 항목 (${entry.name})`);
  if (entry.size > limit) throw new ZipError('tooBig', `풀린 크기가 한도를 넘음 (${entry.name})`);
  const start = dataStart(buffer, entry);
  const raw = buffer.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === METHOD_STORE) {
    data = Buffer.from(raw);
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Number.isFinite(limit) ? limit + 1 : undefined });
    } catch (e) {
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipError('tooBig', `풀린 크기가 한도를 넘음 (${entry.name})`);
      throw new ZipError('bad', `압축을 풀지 못함 (${entry.name}): ${e.message}`);
    }
  } else {
    throw new ZipError('unsupported', `지원하지 않는 압축 방식 ${entry.method} (${entry.name})`);
  }
  if (data.length > limit) throw new ZipError('tooBig', `풀린 크기가 한도를 넘음 (${entry.name})`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError('bad', `내용이 손상됨 (${entry.name})`);
  return data;
}

// ── 쓰기 ────────────────────────────────────────────────────

// 새 zip을 만든다. add로 항목을 넣고 toBuffer로 끝낸다
function createWriter() {
  const parts = [];
  const central = [];
  let offset = 0;
  const names = new Set();

  // 지역 머리와 내용을 붙이고, 목록 항목을 적어 둔다
  function push(entry, data) {
    if (names.has(entry.name)) throw new ZipError('duplicate', `같은 이름의 항목이 두 번 들어감: ${entry.name}`);
    names.add(entry.name);
    const nameBuffer = entry.rawName || Buffer.from(entry.name, 'utf8');
    const flags = entry.rawName ? entry.flags & FLAG_UTF8 : FLAG_UTF8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(DOS_EPOCH_TIME, 10);
    local.writeUInt16LE(DOS_EPOCH_DATE, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuffer, data);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(SIG_CENTRAL, 0);
    record.writeUInt16LE(entry.versionMadeBy, 4);
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt16LE(DOS_EPOCH_TIME, 12);
    record.writeUInt16LE(DOS_EPOCH_DATE, 14);
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(entry.size, 24);
    record.writeUInt16LE(nameBuffer.length, 28);
    record.writeUInt32LE(entry.externalAttr >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
    if (offset > 0xffffffff) throw new ZipError('tooBig', 'zip이 4GB를 넘음 (ZIP64 미지원)');
  }

  return {
    // 파일 하나를 넣는다. mode는 유닉스 권한(예: 0o755). 실행 파일 표시가 필요할 때만 준다
    addFile(name, data, mode) {
      const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const deflated = zlib.deflateRawSync(body, { level: 9 });
      const useDeflate = deflated.length < body.length;
      const unixMode = 0o100000 | (mode || 0o644);
      push({
        name: String(name).replace(/\\/g, '/'),
        method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
        crc: crc32(body),
        size: body.length,
        versionMadeBy: (VERSION_UNIX << 8) | VERSION_NEEDED,
        externalAttr: (unixMode << 16) >>> 0,
      }, useDeflate ? deflated : body);
    },
    // 다른 zip의 항목을 풀지 않고 그대로 옮긴다 (권한과 바로 가기(symlink)를 그대로 둔다). name을 주면 이름만 바꾼다
    copyEntry(sourceBuffer, entry, name) {
      const start = dataStart(sourceBuffer, entry);
      const renamed = typeof name === 'string' && name !== entry.name;
      push({
        name: renamed ? name : entry.name,
        rawName: renamed ? null : entry.rawName,
        flags: entry.flags,
        method: entry.method,
        crc: entry.crc,
        size: entry.size,
        versionMadeBy: entry.versionMadeBy,
        externalAttr: entry.externalAttr,
      }, sourceBuffer.subarray(start, start + entry.compressedSize));
    },
    // 끝 기록을 붙여 zip 전체를 돌려준다
    toBuffer() {
      const dir = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(SIG_END, 0);
      end.writeUInt16LE(names.size, 8);
      end.writeUInt16LE(names.size, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(offset, 16);
      if (names.size > 0xfffe) throw new ZipError('tooMany', '항목이 너무 많음 (ZIP64 미지원)');
      return Buffer.concat(parts.concat([dir, end]));
    },
  };
}

module.exports = { listEntries, extractEntry, createWriter, crc32, ZipError };
