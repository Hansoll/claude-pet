// 원본 시트의 칸마다 어떤 표정인지와 맞출 때의 처음 값을 적어 둔 표. build.js가 읽는다.
// 표정은 원본 그림을 보고 사람이 정했다. 몸 위치·크기·기울기·눈 방향은 도구가 그림에 맞춘다.
'use strict';

const DEG = Math.PI / 180;

// ── 맞출 값 묶음과 한 번에 움직이는 걸음 ─────────────────────
const STEPS = {
  body: { cx: 0.5, cy: 0.5, sx: 0.01, sy: 0.01, shear: 0.01 },
  face: { yaw: 2 * DEG, pitch: 2 * DEG },
  eye: { rx: 0.4, ry: 0.4 },
  twist: { twist: 3 * DEG },
  lean: { roll: 1.5 * DEG },
  open: { open: 0.05 },
  lid: { lid: 0.04 },
  sad: { lid: 0.04, slant: 0.08, ry: 0.4 },
  bottom: { bb: 0.5, nb: 0.1 },
  uniform: { cx: 0.5, cy: 0.5, uni: 0.01 },
  laptop: { lx: 1, ly: 1, lw: 1, lh: 1, ld: 1, lalpha: 1 * DEG, lbeta: 1 * DEG, ltheta: 1 * DEG },
};

// ── 표정 종류 ───────────────────────────────────────────────
// set: 고정하는 값, start: 처음 값(그 뒤 맞춤), fit: 맞출 값 묶음
const KINDS = {
  open: { set: { open: 1, smile: 0, lid: 0, slant: 0 }, start: {}, fit: ['body', 'face', 'eye'] },
  tilt: { set: { open: 1, smile: 0, lid: 0, slant: 0 }, start: {}, fit: ['body', 'face', 'eye', 'twist', 'lean'] },
  half: { set: { smile: 0, lid: 0, slant: 0 }, start: { open: 0.55 }, fit: ['body', 'face', 'open'] },
  closed: { set: { open: 0, smile: 0, lid: 0, slant: 0 }, start: {}, fit: ['body', 'face'] },
  smile: { set: { open: 1, smile: 1, lid: 0, slant: 0 }, start: {}, fit: ['body', 'face', 'lean'] },
  sad: { set: { open: 1, smile: 0 }, start: { lid: 0.35, slant: 0.5 }, fit: ['body', 'face', 'sad'] },
  lid: { set: { open: 1, smile: 0, slant: 0 }, start: { lid: 0.45 }, fit: ['body', 'face', 'lid'] },
  dot: { set: { open: 1, smile: 0, lid: 0, slant: 0 }, start: { rx: 7.5, ry: 7.5 }, fit: ['body', 'face', 'eye'] },
};

// ── 동작별 칸 표 ────────────────────────────────────────────
// 칸 하나는 표정 이름이거나 { kind, start, noEstimate }. noEstimate는 윤곽으로 처음 값을 어림하지 않고 앞 칸 결과에서 시작한다
const CLIPS = {
  idle: { loop: true, frames: ['open', 'open', 'half', 'closed', 'half', 'open'] },
  'running-right': { loop: true, frames: ['tilt', 'tilt', 'tilt', 'tilt', 'tilt', 'tilt', 'tilt', 'tilt'] },
  'running-left': { loop: true, frames: ['tilt', 'tilt', 'tilt', 'tilt', 'tilt', 'tilt', 'tilt', 'tilt'] },
  waving: { loop: false, frames: ['open', 'smile', 'smile', 'open'] },
  // 세 번째 칸은 몸 위쪽이 칸 밖으로 잘려 있어 윤곽으로 어림할 수 없다
  jumping: { loop: false, frames: ['open', 'open', { kind: 'open', noEstimate: true, start: { cyShift: -24 } }, 'open', 'open'] },
  failed: { loop: true, frames: ['open', 'sad', 'sad', 'sad', 'closed', 'sad', 'half', 'open'] },
  waiting: { loop: true, frames: ['open', 'open', 'tilt', 'tilt', 'dot', 'open'] },
  review: { loop: true, frames: ['open', 'tilt', 'tilt', 'tilt', 'dot', 'open'] },
};

// 노트북이 있는 작업 동작: 몸 아래가 가려져 있어 가로세로 같은 배율로 맞춘다
const WORK_CLIP = { name: 'running', loop: true, frames: ['open', 'open', 'lid', 'closed', 'open', 'open'] };
const WORK_START = { cx: 104.5, cy: 115, uni: 0.877, yaw: -8 * DEG, pitch: 5 * DEG, rx: 8, ry: 18.5, laptop: 1 };

module.exports = { DEG, STEPS, KINDS, CLIPS, WORK_CLIP, WORK_START };
