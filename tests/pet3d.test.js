// 3D 펫 시험: 색 계산, 동작 재생, 자료 검사, 3D 펫 폴더 읽기. 그리기(WebGL)는 화면이 있어야 해서 여기서 다루지 않는다.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pet3d = require('../pet3d.js');
const petSpec = require('../pets.js');
const config = require('../config.js');

const REAL_PET_DIR = path.join(config.PROJECT_PETS_DIR, 'orange-pickle-3d');

// 시험마다 쓸 임시 폴더를 만든다
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pet-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 정리 실패는 무시 */ } });
  return dir;
}

// 시험용 작은 펫 자료를 만든다. 동작마다 두 칸이고, 두 번째 칸은 몸이 조금 눌려 있다
function sampleModel(change) {
  const clips = {};
  for (const name of pet3d.REQUIRED_CLIPS) {
    const laptop = name === 'running' ? 1 : 0;
    clips[name] = {
      loop: name !== 'waving' && name !== 'jumping',
      frames: [
        { ms: 100, pose: { sy: 1, yaw: 0, laptop } },
        { ms: 200, pose: { sy: 0.8, yaw: 0.2, laptop } },
      ],
    };
  }
  const directions = [];
  for (let i = 0; i < pet3d.LOOK_DIRECTIONS; i++) {
    const angle = (i / pet3d.LOOK_DIRECTIONS) * Math.PI * 2;
    directions.push({ yaw: Math.sin(angle) * 0.6, pitch: Math.cos(angle) * 0.5, bb: 57.5, nb: 2.5 });
  }
  const model = { version: 1, shape: { a: 72.5, bt: 76.5, bb: 57.5, nb: 2.5 }, base: {}, clips, look: { directions } };
  if (change) change(model);
  return model;
}

// 주황 계열 음영으로 채운 작은 색 지도를 만든다 (위쪽이 밝고 아래쪽이 어둡다)
function sampleMatcap(size) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const shade = 1.25 - (y / (size - 1)) * 0.5;
      const i = (y * size + x) * 4;
      pixels[i] = Math.min(255, 238 * shade); pixels[i + 1] = Math.min(255, 109 * shade); pixels[i + 2] = Math.min(255, 21 * shade); pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function brightness(pixels, index) {
  return pet3d.oklabFromRgb(pixels[index], pixels[index + 1], pixels[index + 2])[0];
}

test('색 글자 읽고 쓰기', () => {
  assert.deepEqual(pet3d.parseHexColor('#4a8fe7'), [74, 143, 231]);
  assert.deepEqual(pet3d.parseHexColor('4A8FE7'), [74, 143, 231]);
  for (const bad of ['', '#fff', '#12345g', 'red', null, undefined, 123]) assert.equal(pet3d.parseHexColor(bad), null);
  assert.equal(pet3d.toHexColor([74, 143, 231]), '#4a8fe7');
  assert.equal(pet3d.toHexColor([300, -5, 12.4]), '#ff000c');
});

test('색상·선명함·밝기와 RGB 사이를 오간다', () => {
  for (const rgb of [[238, 109, 21], [74, 143, 231], [240, 240, 240], [20, 20, 20], [0, 255, 0]]) {
    const hsv = pet3d.hsvFromRgb(rgb);
    const back = pet3d.rgbFromHsv(hsv.h, hsv.s, hsv.v);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rgb[i]) <= 1, `${rgb} → ${back}`);
  }
  assert.deepEqual(pet3d.rgbFromHsv(0, 1, 1), [255, 0, 0]);
  assert.deepEqual(pet3d.rgbFromHsv(360 + 120, 1, 1), [0, 255, 0]);
});

test('밝기 계산: 흰색은 1, 검정은 0에 가깝고 되돌리면 같은 색', () => {
  assert.ok(Math.abs(pet3d.oklabFromRgb(255, 255, 255)[0] - 1) < 0.001);
  assert.ok(pet3d.oklabFromRgb(0, 0, 0)[0] < 0.001);
  for (const rgb of [[238, 109, 21], [74, 143, 231], [229, 72, 77]]) {
    const [L, a, b] = pet3d.oklabFromRgb(rgb[0], rgb[1], rgb[2]);
    const back = pet3d.rgbFromLch(L, Math.hypot(a, b), Math.atan2(b, a));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - rgb[i]) <= 1, `${rgb} → ${back}`);
  }
  // 화면이 낼 수 없는 선명함을 줘도 범위 안의 색이 나온다
  for (const value of pet3d.rgbFromLch(0.7, 0.9, 1)) assert.ok(value >= 0 && value <= 255);
});

test('색 지도 색 바꾸기: 가운데가 목표 색이 되고 밝고 어두운 순서는 그대로', () => {
  const size = 16;
  const source = sampleMatcap(size);
  const copy = Uint8ClampedArray.from(source);
  for (const target of [[74, 143, 231], [245, 197, 66], [241, 239, 233], [69, 70, 77]]) {
    const out = pet3d.recolorMatcap(source, size, target);
    assert.equal(out.length, source.length);
    const base = pet3d.matcapBaseColor(out, size);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(base[i] - target[i]) <= 14, `가운데 색 ${base.map(Math.round)}가 목표 ${target}와 다름`);
    const top = brightness(out, (1 * size + 8) * 4), middle = brightness(out, (8 * size + 8) * 4), bottom = brightness(out, (14 * size + 8) * 4);
    assert.ok(top > middle && middle > bottom, `음영 순서가 뒤집힘 (${top}, ${middle}, ${bottom})`);
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 255);
  }
  assert.deepEqual(Array.from(source), Array.from(copy));   // 원본은 그대로
  assert.throws(() => pet3d.recolorMatcap(source, size + 1, [1, 2, 3]), /크기/);
  assert.throws(() => pet3d.recolorMatcap(source, size, [1, 2]), /색/);
  assert.throws(() => pet3d.recolorMatcap(source, size, [1, NaN, 3]), /색/);
});

test('몸이 어두우면 눈을 밝은 색으로 고른다', () => {
  assert.equal(pet3d.eyeColorsFor(null), pet3d.EYE_DARK);
  assert.equal(pet3d.eyeColorsFor([238, 109, 21]), pet3d.EYE_DARK);
  assert.equal(pet3d.eyeColorsFor([241, 239, 233]), pet3d.EYE_DARK);
  assert.equal(pet3d.eyeColorsFor([69, 70, 77]), pet3d.EYE_LIGHT);
  assert.equal(pet3d.eyeColorsFor([20, 30, 90]), pet3d.EYE_LIGHT);
});

test('펫 자료 검사: 빠지거나 틀린 값을 알아낸다', () => {
  const ok = pet3d.prepareModel(sampleModel());
  assert.equal(ok.clips.idle.total, 300);
  assert.equal(ok.base.rx0, ok.base.rx);
  assert.throws(() => pet3d.prepareModel(null), /객체/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { delete m.shape.bt; })), /모양/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { delete m.clips.review; })), /review/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { m.clips.idle.frames = []; })), /프레임/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { m.clips.idle.frames[0].ms = 0; })), /시간/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { m.clips.idle.frames[1].pose.yaw = 'x'; })), /yaw/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { m.look.directions.pop(); })), /방향/);
  assert.throws(() => pet3d.prepareModel(sampleModel((m) => { m.look.directions[3].pitch = null; })), /pitch/);
  assert.equal(pet3d.prepareModel(sampleModel((m) => { delete m.look; })).look, null);
});

test('동작 재생: 칸이 시작하는 순간에는 그 칸의 자세, 사이에서는 그 사이 값', () => {
  const model = pet3d.prepareModel(sampleModel());
  const idle = model.clips.idle;
  assert.ok(Math.abs(pet3d.sampleClip(idle, 0).sy - 1) < 1e-9);
  assert.ok(Math.abs(pet3d.sampleClip(idle, 100).sy - 0.8) < 1e-9);
  const middle = pet3d.sampleClip(idle, 50).sy;
  assert.ok(middle < 1 && middle > 0.8);
  assert.ok(Math.abs(pet3d.sampleClip(idle, 300).sy - 1) < 1e-9);      // 반복: 한 바퀴 돌면 처음 자세
  assert.ok(Math.abs(pet3d.sampleClip(idle, 350).sy - middle) < 1e-9);
  const jump = model.clips.jumping;                                     // 한 번 재생: 끝난 뒤에는 마지막 자세
  assert.ok(Math.abs(pet3d.sampleClip(jump, 99999).sy - 0.8) < 1e-9);
  assert.ok(Math.abs(pet3d.sampleClip(jump, -50).sy - 1) < 1e-9);
});

test('동작 재생: 0~1이어야 하는 값은 곡선이 넘쳐도 범위를 지킨다', () => {
  const model = pet3d.prepareModel(sampleModel((m) => {
    m.clips.idle.frames = [1, 1, 0, 0, 1, 1].map((open) => ({ ms: 100, pose: { open } }));
  }));
  for (let t = 0; t < 600; t += 7) {
    const open = pet3d.sampleClip(model.clips.idle, t).open;
    assert.ok(open >= 0 && open <= 1, `t=${t} open=${open}`);
  }
});

test('재생기: 상태에 따라 동작이 바뀌고, 한 번 재생이 끝나면 돌아온다', () => {
  const actor = pet3d.createActor(sampleModel());
  assert.equal(actor.clipName(), 'idle');
  actor.setBase('running');
  assert.equal(actor.clipName(), 'running');
  let pose = actor.update(16);
  assert.ok(pose.laptop > 0 && pose.laptop < 1, '바뀌는 동안에는 앞뒤 자세가 섞인다');
  for (let i = 0; i < 30; i++) pose = actor.update(16);
  assert.equal(pose.laptop, 1);
  assert.equal(pose.ly, actor.model.base.ly);                // 노트북이 다 올라온 자리

  let ended = 0;
  assert.equal(actor.playOnce('jumping', () => { ended++; }), true);
  assert.equal(actor.clipName(), 'jumping');
  assert.equal(actor.isBusy(), true);
  for (let i = 0; i < 30; i++) actor.update(16);
  assert.equal(ended, 1);
  assert.equal(actor.clipName(), 'running');
  assert.equal(actor.playOnce('없는 동작'), false);
});

test('재생기: 끄는 동안에는 달리기 동작이고 한 번 재생을 받지 않는다', () => {
  const actor = pet3d.createActor(sampleModel());
  actor.setDrag('right');
  assert.equal(actor.clipName(), 'running-right');
  assert.equal(actor.playOnce('waving'), false);
  actor.setDrag('left');
  assert.equal(actor.clipName(), 'running-left');
  actor.setDrag(null);
  assert.equal(actor.clipName(), 'idle');
  actor.playOnce('waving');
  actor.setDrag('right');                                     // 끌기가 한 번 재생보다 먼저다
  assert.equal(actor.clipName(), 'running-right');
});

test('재생기: 커서 쪽을 바라보고, 커서가 멈추면 돌아온다 (대기 동작일 때만)', () => {
  const actor = pet3d.createActor(sampleModel((m) => { for (const f of m.clips.idle.frames) f.pose.yaw = 0; }));
  actor.setLook({ active: true, dx: 2000, dy: 0 });           // 멀리 오른쪽
  let pose = actor.update(16);
  assert.equal(actor.isBusy(), true);                         // 눈이 돌아가는 동안에는 자주 그린다
  for (let i = 0; i < 60; i++) pose = actor.update(16);
  const right = actor.model.look.directions[4].yaw;
  assert.ok(Math.abs(pose.yaw - right) < 0.02, `yaw ${pose.yaw} ≠ ${right}`);
  assert.equal(actor.isBusy(), false);                        // 다 돌아가서 멈추면 평소 속도로 돌아간다
  actor.setLook({ active: true, dx: 60, dy: 0 });             // 가까우면 조금만 돌아간다
  for (let i = 0; i < 60; i++) pose = actor.update(16);
  assert.ok(pose.yaw > 0.05 && pose.yaw < right * 0.5, `yaw ${pose.yaw}`);
  actor.setLook({ active: false });
  for (let i = 0; i < 60; i++) pose = actor.update(16);
  assert.ok(Math.abs(pose.yaw) < 0.001);
  assert.equal(actor.isBusy(), false);
  actor.setBase('running');                                   // 작업 중에는 커서를 보지 않는다
  actor.setLook({ active: true, dx: 2000, dy: 0 });
  for (let i = 0; i < 60; i++) pose = actor.update(16);
  assert.ok(Math.abs(pose.yaw) < 0.25);
});

test('재생기: 눌리면 옆으로 퍼지고 발밑 높이는 그대로', () => {
  const actor = pet3d.createActor(sampleModel((m) => { for (const f of m.clips.idle.frames) f.pose.sy = 1; }));
  const rest = actor.update(16);
  const ground = rest.cy + rest.bb * rest.sy;
  actor.setMotion({ squash: 0.8, lean: 0.1 });
  const pressed = actor.update(16);
  assert.ok(Math.abs(pressed.sy - 0.8) < 1e-6);
  assert.ok(Math.abs(pressed.sx - 1 / Math.sqrt(0.8)) < 1e-6);
  assert.ok(Math.abs(pressed.shear - 0.1) < 1e-6);
  assert.ok(Math.abs(pressed.cy + pressed.bb * pressed.sy - ground) < 1e-6);
  actor.setMotion({ squash: 99, lean: NaN });                 // 이상한 값은 한도 안으로
  const safe = actor.update(16);
  assert.ok(safe.sy <= 1.6 && Number.isFinite(safe.shear));
});

test('재생기: 움직임 줄이기에서는 첫 자세로 멈춘다', () => {
  const actor = pet3d.createActor(sampleModel());
  actor.setStill(true);
  actor.setMotion({ squash: 0.7, lean: 0.2 });
  const a = actor.update(500), b = actor.update(500);
  assert.equal(a.sy, 1);
  assert.equal(b.sy, 1);
  assert.equal(a.shear, 0);
});

test('바라볼 방향 계산: 너무 가까우면 없음, 멀수록 많이 돌아가고 방향 사이는 이어진다', () => {
  const look = pet3d.prepareModel(sampleModel()).look;
  assert.equal(pet3d.lookTarget(look, 0.2, 0.3), null);
  assert.equal(pet3d.lookTarget(null, 100, 0), null);
  const near = pet3d.lookTarget(look, 0, -50), far = pet3d.lookTarget(look, 0, -900);
  assert.ok(near.amount > 0 && near.amount < far.amount && far.amount <= 1);
  assert.ok(Math.abs(near.yaw - look.directions[0].yaw) < 1e-9);          // 똑바로 위
  const between = pet3d.lookTarget(look, Math.sin(Math.PI / 16) * 100, -Math.cos(Math.PI / 16) * 100);
  assert.ok(Math.abs(between.yaw - (look.directions[0].yaw + look.directions[1].yaw) / 2) < 1e-6);
  const wrap = pet3d.lookTarget(look, -Math.sin(Math.PI / 16) * 100, -Math.cos(Math.PI / 16) * 100);
  assert.ok(Math.abs(wrap.yaw - (look.directions[15].yaw + look.directions[0].yaw) / 2) < 1e-6);
});

test('몸 모양: 가장 넓은 곳에서 위아래가 이어지고 표면 위의 점을 찾는다', () => {
  const shape = pet3d.DEFAULT_SHAPE;
  assert.ok(Math.abs(pet3d.profile(0, shape) - shape.a) < 1e-9);
  assert.ok(Math.abs(pet3d.profile(0.01, shape) - pet3d.profile(-0.01, shape)) < 0.01);
  assert.equal(pet3d.profile(shape.bt + 1, shape), 0);
  assert.equal(pet3d.profile(-shape.bb - 1, shape), 0);
  assert.equal(pet3d.bodyHit(shape.a + 5, 0, shape), null);
  const front = pet3d.bodyHit(0, 0, shape);
  assert.ok(Math.abs(front.z - shape.a) < 1e-6 && front.nz > 0.999);
  for (const direction of [[0, 0, 1], [0.6, 0.3, 0.74], [-0.5, -0.5, 0.7], [0, 1, 0], [0, -1, 0]]) {
    const hit = pet3d.surfacePoint(pet3d.normalize(direction), shape);
    const radius = Math.hypot(hit.p[0], hit.p[2]);
    assert.ok(Math.abs(radius - pet3d.profile(hit.p[1], shape)) < 0.01, `${direction}: 표면에서 벗어남`);
    assert.ok(Math.abs(Math.hypot(hit.n[0], hit.n[1], hit.n[2]) - 1) < 1e-6);
  }
});

test('실제 3D 펫(주황 피클 3D)이 규격대로 읽힌다', () => {
  const loaded = petSpec.loadPet(REAL_PET_DIR, 'project');
  assert.equal(loaded.ok, true, loaded.error);
  const pet = loaded.pet;
  assert.equal(pet.type, '3d');
  assert.equal(pet.key, 'project:orange-pickle-3d');
  assert.ok(pet.matcapSize >= 32);
  const model = pet3d.prepareModel(pet.model);
  for (const animation of petSpec.ANIMATIONS) {
    const clip = model.clips[animation.id];
    assert.ok(clip, `${animation.id} 동작이 없음`);
    assert.equal(clip.frames.length, animation.frames);
    assert.deepEqual(clip.frames.map((f) => f.ms), animation.durations);
  }
  assert.equal(model.clips.jumping.loop, false);
  assert.equal(model.clips.waving.loop, false);
  assert.ok(model.clips.running.frames.every((f) => f.pose.laptop === 1));
  assert.ok(model.clips.idle.frames.every((f) => f.pose.laptop === 0));
  assert.equal(model.look.directions.length, pet3d.LOOK_DIRECTIONS);
  // 대신 쓸 이미지 펫이 실제로 있다
  const fallback = petSpec.loadPet(path.join(config.PROJECT_PETS_DIR, pet.fallback), 'project');
  assert.equal(fallback.ok, true, fallback.error);
  assert.equal(fallback.pet.type, 'sprite');
  // 재생기가 모든 동작을 끝까지 돌려도 숫자가 깨지지 않는다
  const actor = pet3d.createActor(pet.model);
  for (const name of pet3d.REQUIRED_CLIPS) {
    actor.setBase(name);
    for (let i = 0; i < 80; i++) {
      const pose = actor.update(33);
      for (const key of pet3d.ANIMATED_KEYS) assert.ok(Number.isFinite(pose[key]), `${name}: ${key}가 숫자가 아님`);
    }
  }
});

test('3D 펫 폴더 검사: 자료가 없거나 틀리면 사유를 알린다', (t) => {
  const dir = tempDir(t);
  const write = (name, manifest) => {
    const petDir = path.join(dir, name);
    fs.mkdirSync(petDir, { recursive: true });
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(Object.assign({ id: name, kind: petSpec.KIND_3D }, manifest)), 'utf8');
    return petDir;
  };
  const copy = (petDir) => {
    fs.copyFileSync(path.join(REAL_PET_DIR, 'model.json'), path.join(petDir, 'model.json'));
    fs.copyFileSync(path.join(REAL_PET_DIR, 'matcap.png'), path.join(petDir, 'matcap.png'));
  };

  const good = write('good', { displayName: '시험 펫', fallback: 'claude-blob' });
  copy(good);
  const loaded = petSpec.loadPet(good, 'project');
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.pet.displayName, '시험 펫');
  assert.equal(loaded.pet.fallback, 'claude-blob');

  const empty = write('empty', {});
  assert.match(petSpec.loadPet(empty, 'project').error, /동작 자료 없음/);

  const noMatcap = write('no-matcap', {});
  fs.copyFileSync(path.join(REAL_PET_DIR, 'model.json'), path.join(noMatcap, 'model.json'));
  assert.match(petSpec.loadPet(noMatcap, 'project').error, /색 지도 없음/);

  const broken = write('broken', {});
  copy(broken);
  fs.writeFileSync(path.join(broken, 'model.json'), '{"shape":{"a":1}}', 'utf8');
  assert.match(petSpec.loadPet(broken, 'project').error, /동작 자료가 올바르지 않음/);

  const notJson = write('not-json', {});
  copy(notJson);
  fs.writeFileSync(path.join(notJson, 'model.json'), '{ 깨진 내용', 'utf8');
  assert.match(petSpec.loadPet(notJson, 'project').error, /동작 자료가 올바르지 않음/);

  const outside = write('outside', { modelPath: '../good/model.json' });
  copy(outside);
  assert.match(petSpec.loadPet(outside, 'project').error, /폴더 밖/);

  const wrongImage = write('wrong-image', {});
  copy(wrongImage);
  fs.writeFileSync(path.join(wrongImage, 'matcap.png'), Buffer.from('이것은 그림이 아닙니다. 그림 파일의 머리말이 없는 글자 파일입니다.', 'utf8'));
  assert.equal(petSpec.loadPet(wrongImage, 'project').ok, false);

  // 찾기: 3D 펫과 이미지 펫이 함께 나오고, 틀린 폴더는 사유와 함께 빠진다
  const found = petSpec.discoverPets([{ dir, source: 'project' }]);
  assert.deepEqual(found.pets.map((p) => p.id), ['good']);
  assert.equal(found.errors.length, 6);
});
