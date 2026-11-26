// 3D 펫 핵심: 그리기(WebGL 셰이더), 몸 모양 계산, 색 바꾸기, 동작 재생.
// 화면(pet.html)에서는 전역 PET3D로, 도구와 시험(Node)에서는 require로 쓴다. 다른 파일을 불러오지 않는다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PET3D = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 설정 상수 ─────────────────────────────────────────────
  const CELL_W = 192;              // 한 칸 크기 (코덱스 펫 규격과 같다)
  const CELL_H = 208;
  const MATCAP_K = 0.96;           // 빛 지도에서 가장자리 법선이 놓이는 반지름 비율
  const EYE_UP_MIX = 0.5;          // 눈 세로축: 0 = 얼굴을 따라 돎, 1 = 화면에서 수직. 원본 여덟 방향 칸에 맞춰 본 값
  const EYE_FLAT = 0.7;            // 눈이 놓이는 면: 0 = 표면 그대로, 1 = 화면을 마주 봄. 원본 여덟 방향 칸에 맞춰 본 값
  const PROFILE_BLEND = 0.5;       // 몸 아래쪽 곡선의 지수가 다 올라가는 깊이 (바닥까지를 1로 봄)
  const PROFILE_STEP = 0.25;       // 옆모습의 기울기를 잴 때 쓰는 간격 (픽셀)
  const SURFACE_SEARCH_STEPS = 40; // 표면까지의 거리를 찾을 때 반씩 좁히는 횟수
  const GAMUT_STEPS = 40;          // 화면이 못 내는 색일 때 선명함을 줄여 보는 횟수
  const GAMUT_SHRINK = 0.93;       // 한 번에 줄이는 비율
  const GAMUT_SLACK = 0.002;       // 범위 판정 여유
  const BASE_SAMPLE_RATIO = 0.06;  // 빛 지도 한가운데에서 대표색을 뽑는 범위 (한 변 대비)
  const HUE_OFFSET_KEEP = 0.6;     // 밝은 곳·어두운 곳의 색상 차이를 새 색에 남기는 비율
  const DARK_BODY_L = 0.5;         // 몸 밝기가 이보다 낮으면 눈을 밝은 색으로 바꾼다 (OKLab 밝기)
  const ICON_MARGIN = 3;           // 아이콘으로 자를 때 몸 둘레에 두는 여백 (칸 픽셀)
  const EYE_DARK = { eye: [43, 30, 21], edge: [30, 20, 12], highlight: [236, 236, 239] };
  const EYE_LIGHT = { eye: [240, 236, 228], edge: [206, 201, 192], highlight: [255, 255, 255] };
  const DEFAULT_SHAPE = { a: 72.5, bt: 76.5, bb: 57.5, nb: 2.5 };
  const DEFAULT_POSE = {
    cx: 95.5, cy: 132, sx: 1, sy: 1, roll: 0, shear: 0,
    yaw: 0, pitch: 0.195, sep: 0.236, rx: 9.3, ry: 20.4, m: 2.6,
    hx: 1.2, hy: 15.2, hr: 3.3,
    open: 1, smile: 0, lid: 0, slant: 0, twist: 0,
    noiseAmp: 0.03, noiseFreq: 0.45,
    laptop: 0, lx: 79.5, ly: 183, lw: 94, lh: 73, ld: 74, lalpha: 0.23, lbeta: 0.408, ltheta: 0.506,
  };
  // 동작 재생
  const ANIMATED_KEYS = ['cx', 'cy', 'sx', 'sy', 'shear', 'roll', 'yaw', 'pitch', 'twist', 'sep', 'rx', 'ry', 'hx', 'hy', 'open', 'smile', 'lid', 'slant', 'bb', 'nb', 'laptop'];
  const UNIT_KEYS = ['open', 'smile', 'lid', 'laptop'];          // 0~1을 벗어나면 안 되는 값
  const REQUIRED_CLIPS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
  const LOOK_DIRECTIONS = 16;      // 바라보기 방향 수 (0 = 위, 시계 방향)
  const LOOK_KEYS = ['yaw', 'pitch', 'bb', 'nb'];
  const SCALE_MIN = 0.5;           // 몸 배율 한도 (계산이 튀는 것을 막는다)
  const SCALE_MAX = 1.6;
  const TRANSITION_MS = 220;       // 동작이 바뀔 때 앞뒤 자세를 섞는 시간
  const DRAG_TRANSITION_MS = 120;  // 끌기 시작·끝의 섞는 시간
  const LOOK_FADE_MS = 180;        // 커서 바라보기가 켜지고 꺼지는 시간
  const GAZE_FOLLOW_MS = 90;       // 눈이 목표 방향을 따라잡는 시간
  const GAZE_REST = 0.004;         // 눈과 목표의 각도 차이(라디안)가 이보다 작으면 멈춘 것으로 본다
  const LOOK_FALLOFF_PX = 220;     // 커서가 이만큼 멀어지면 눈이 63%쯤 돌아간다
  const LAPTOP_SLIDE = 24;         // 노트북이 올라오는 거리 (칸 픽셀)
  const MAX_STEP_MS = 100;         // 한 번에 진행하는 최대 시간 (멈췄다 돌아왔을 때 튀지 않게)
  const MOTION_REST = 0.002;       // 탄력 값이 이만큼 이하면 멈춘 것으로 본다

  // ── 셰이더 ────────────────────────────────────────────────
  const VERTEX_SOURCE = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2 uRes;
uniform float uScale;
uniform int uSS;

uniform vec2 uBodyC;
uniform vec2 uBodyS;
uniform float uRoll;
uniform float uShear;
uniform float uGround;
uniform vec4 uShape;
uniform sampler2D uMatcap;
uniform float uMatK;
uniform vec2 uNoise;

uniform vec3 uEyeP[2];
uniform vec3 uEyeRt[2];
uniform vec3 uEyeUp[2];
uniform vec3 uEyeN[2];
uniform vec3 uEyeSize;
uniform vec2 uEyeRef;
uniform vec3 uHi;
uniform vec3 uEyeColor;
uniform vec3 uEyeEdge;
uniform vec3 uHiColor;
uniform vec4 uEyeExpr;

uniform float uLaptop;
uniform vec3 uLapT;
uniform mat3 uLapR;
uniform vec4 uLapSize;

const float LID_T = 3.0;
const float BASE_T = 4.5;
const float LAP_CORNER = 5.0;
const float LAP_BEVEL = 0.8;
const vec3 LID_LOW = vec3(146.0, 141.0, 143.0) / 255.0;
const vec3 LID_HIGH = vec3(162.0, 156.0, 157.0) / 255.0;
const vec3 LID_EDGE = vec3(206.0, 206.0, 210.0) / 255.0;
const vec3 LAP_SIDE = vec3(131.0, 128.0, 129.0) / 255.0;
const vec3 BASE_TOP = vec3(183.0, 173.0, 169.0) / 255.0;
const vec3 KEY_GAP = vec3(46.0, 40.0, 35.0) / 255.0;
const vec3 KEY_TOP = vec3(88.0, 78.0, 71.0) / 255.0;
const float HI_SOFT = 0.9;
const float PROFILE_BLEND = ${PROFILE_BLEND.toFixed(3)};
const float PROFILE_STEP = ${PROFILE_STEP.toFixed(3)};
const float CLOSED_WIDEN = 0.20;     // 다 감으면 눈이 옆으로 넓어지는 비율
const float CLOSED_DROP = 0.30;      // 감으면 눈이 내려가는 양 (눈 높이 대비)
const float CLOSED_BEND = 0.38;      // 감은 눈의 양 끝이 올라가는 정도
const float CLOSED_HALF = 2.2;       // 감은 눈 선 두께의 절반
const float LID_STROKE = 0.75;       // 눈꺼풀 선 두께의 절반
const float LID_REACH = 1.1;         // 눈꺼풀 선이 눈 너비보다 얼마나 더 나가는지
const float SMILE_WIDTH = 1.3;       // 웃는 눈의 반너비 (눈 너비 대비)
const float SMILE_RISE = 0.78;       // 웃는 눈 가운데가 솟는 높이 (눈 너비 대비)
const float SMILE_HALF = 2.4;        // 웃는 눈 선 두께의 절반
const float HI_MIN_SCALE = 0.45;     // 눈이 작아질 때 반짝임이 줄어드는 한도
const float HI_LID_GAP = 0.6;        // 눈꺼풀 선과 반짝임 사이 틈

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  return 0.6 * vnoise(p) + 0.4 * vnoise(p * 2.3 + 7.1);
}

// 몸의 옆모습: 높이 y에서의 반지름. 위쪽은 타원, 아래쪽은 내려갈수록 둥근 사각에 가까워지는 곡선
// (가장 넓은 곳에서 위아래가 매끄럽게 이어지도록 지수를 2에서 조금씩 올린다)
float profile(float y) {
  if (y >= 0.0) {
    float t = y / uShape.y;
    if (t >= 1.0) return 0.0;
    return uShape.x * sqrt(1.0 - t * t);
  }
  float t = -y / uShape.z;
  if (t >= 1.0) return 0.0;
  float n = mix(2.0, uShape.w, smoothstep(0.0, PROFILE_BLEND, t));
  return uShape.x * pow(1.0 - pow(t, n), 1.0 / n);
}

// 몸: 세로축 회전체. 화면 점에서 표면 위치와 법선을 구한다
bool bodyHit(vec2 q, out vec3 pos, out vec3 nrm) {
  float r = profile(q.y);
  if (r < 0.01 || abs(q.x) >= r) return false;
  float z = sqrt(r * r - q.x * q.x);
  float slope = (profile(q.y + PROFILE_STEP) - profile(q.y - PROFILE_STEP)) / (2.0 * PROFILE_STEP);
  pos = vec3(q.x, q.y, z);
  nrm = normalize(vec3(q.x / r, -slope, z / r));
  return true;
}

// 끝이 둥근 선분 모양까지의 거리 (가로로 긴 띠)
float bandDistance(float along, float across, float halfLength, float halfThickness) {
  vec2 d = vec2(abs(along) - halfLength, abs(across) - halfThickness);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

vec4 shadeBody(vec2 P) {
  // 화면 → 몸 좌표: 기울임(바닥은 그대로, 위로 갈수록 옆으로 밀림)을 풀고, 회전과 배율을 푼다
  vec2 v = vec2(P.x - uBodyC.x - uShear * (uGround - P.y), uBodyC.y - P.y);
  float c = cos(uRoll);
  float s = sin(uRoll);
  vec2 q = vec2(c * v.x + s * v.y, -s * v.x + c * v.y) / uBodyS;
  vec3 pos;
  vec3 nl;
  if (!bodyHit(q, pos, nl)) return vec4(0.0);
  vec3 nw = vec3(nl.x / uBodyS.x, nl.y / uBodyS.y, nl.z / uBodyS.x);
  nw = vec3(c * nw.x - s * nw.y, s * nw.x + c * nw.y, nw.z);
  nw.y -= uShear * nw.x;
  nw = normalize(nw);
  vec2 uv = vec2(0.5) + nw.xy * vec2(0.5, -0.5) * uMatK;
  vec3 col = texture(uMatcap, uv).rgb;
  float grain = fbm(pos * uNoise.y);
  col *= 1.0 + uNoise.x * (grain - 0.5) * 2.0;

  float aa = 1.0 / uScale;
  float open = clamp(uEyeExpr.x, 0.0, 1.0);
  float smile = clamp(uEyeExpr.y, 0.0, 1.0);
  float lid = clamp(uEyeExpr.z, 0.0, 1.0);
  float closed = 1.0 - open;
  float shut = smoothstep(0.6, 1.0, closed);            // 거의 다 감았을 때만 선 모양으로 바뀐다
  float rx = uEyeSize.x * (1.0 + CLOSED_WIDEN * shut);
  float ry = max(uEyeSize.y * open, CLOSED_HALF);
  for (int i = 0; i < 2; i++) {
    if (dot(nl, uEyeN[i]) <= 0.0) continue;
    float side = i == 0 ? -1.0 : 1.0;
    vec3 d = pos - uEyeP[i];
    float e = dot(d, uEyeRt[i]);
    float f0 = dot(d, uEyeUp[i]);
    // 1) 뜬 눈 ~ 감은 선
    float f = f0 + uEyeSize.y * CLOSED_DROP * closed;
    float g = f - shut * CLOSED_BEND * e * e / rx;
    float m = mix(uEyeSize.z, 4.0, shut);
    float k = pow(pow(abs(e) / rx, m) + pow(abs(g) / ry, m), 1.0 / m);
    float aEye = clamp(0.5 - (k - 1.0) * min(rx, ry) / aa, 0.0, 1.0);
    // 반짝임: 눈 크기에 맞춰 자리와 크기를 줄인다
    vec2 eyeRatio = vec2(uEyeSize.x / uEyeRef.x, uEyeSize.y * open / uEyeRef.y);
    vec2 hiCenter = vec2(uHi.x * eyeRatio.x, uHi.y * eyeRatio.y);
    float hiRadius = uHi.z * clamp(sqrt(eyeRatio.x * eyeRatio.y), HI_MIN_SCALE, 1.0);
    // 윗눈꺼풀: 비스듬한 선 위쪽을 가리고 선을 긋는다 (slant가 양수면 바깥쪽이 내려간 처진 눈)
    if (lid > 0.0) {
      float lidLine = ry * (1.0 - 2.0 * lid) - side * uEyeExpr.w * e;
      float below = clamp(0.5 - (g - lidLine) / aa, 0.0, 1.0);
      float strokeDist = max(abs(g - lidLine) - LID_STROKE, abs(e) - rx * LID_REACH);
      float stroke = clamp(0.5 - strokeDist / aa, 0.0, 1.0) * smoothstep(0.0, 0.12, lid);
      aEye = max(aEye * below, stroke);
      // 반짝임이 눈꺼풀에 가리지 않게 선 아래로 내린다
      float lidAtHi = ry * (1.0 - 2.0 * lid) - side * uEyeExpr.w * hiCenter.x;
      hiCenter.y = min(hiCenter.y, lidAtHi - hiRadius - HI_LID_GAP);
    }
    // 2) 웃는 눈: 가운데가 솟은 띠
    float aSmile = 0.0;
    if (smile > 0.0) {
      float halfWidth = uEyeSize.x * SMILE_WIDTH;
      float t = e / halfWidth;
      float arc = uEyeSize.x * SMILE_RISE * (0.5 - t * t);
      aSmile = clamp(0.5 - bandDistance(e, f0 - arc, halfWidth, SMILE_HALF) / aa, 0.0, 1.0);
    }
    float a = mix(aEye, aSmile, smile);
    if (a <= 0.0) continue;
    vec3 eye = uEyeColor * mix(0.93, 1.06, clamp(g / ry * 0.5 + 0.5, 0.0, 1.0));
    eye = mix(eye, uEyeEdge, smoothstep(0.86, 1.0, k) * (1.0 - shut) * (1.0 - smile));
    float hd = length(vec2(e, g) - hiCenter) - hiRadius;
    float hiShow = smoothstep(0.15, 0.4, open) * (1.0 - smile);
    eye = mix(eye, uHiColor, (1.0 - smoothstep(-HI_SOFT, HI_SOFT, hd)) * hiShow);
    col = mix(col, eye, a);
  }
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}

float sdRoundRect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float extrude(float d2, float z, float h) {
  vec2 w = vec2(d2, abs(z) - h) + LAP_BEVEL;
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - LAP_BEVEL;
}

// 노트북: 덮개와 바닥판. 경첩 가운데가 원점, x는 경첩 방향, y는 위, z는 보는 쪽
vec2 lapMap(vec3 p) {
  float th = uLapSize.w;
  vec3 ld = vec3(0.0, cos(th), sin(th));
  vec3 ln = vec3(0.0, -sin(th), cos(th));
  vec3 a = vec3(p.x, dot(p, ld) - uLapSize.y * 0.5, dot(p, ln));
  float dLid = extrude(sdRoundRect(a.xy, vec2(uLapSize.x, uLapSize.y) * 0.5, LAP_CORNER), a.z, LID_T * 0.5);
  vec3 b = p - vec3(0.0, -BASE_T * 0.5, -uLapSize.z * 0.5);
  float dBase = extrude(sdRoundRect(b.xz, vec2(uLapSize.x, uLapSize.z) * 0.5, LAP_CORNER), b.y, BASE_T * 0.5);
  return dLid < dBase ? vec2(dLid, 1.0) : vec2(dBase, 2.0);
}

vec3 lapNormal(vec3 p) {
  vec2 e = vec2(0.05, -0.05);
  return normalize(e.xyy * lapMap(p + e.xyy).x + e.yyx * lapMap(p + e.yyx).x + e.yxy * lapMap(p + e.yxy).x + e.xxx * lapMap(p + e.xxx).x);
}

vec4 shadeLaptop(vec2 P) {
  mat3 inv = transpose(uLapR);
  vec3 origin = inv * (vec3(P.x, -P.y, 300.0) - uLapT);
  vec3 dir = inv * vec3(0.0, 0.0, -1.0);
  float t = 0.0;
  float part = 0.0;
  bool hit = false;
  for (int i = 0; i < 72; i++) {
    vec2 m = lapMap(origin + dir * t);
    if (m.x < 0.02) { hit = true; part = m.y; break; }
    t += m.x;
    if (t > 600.0) break;
  }
  if (!hit) return vec4(0.0);
  vec3 p = origin + dir * t;
  vec3 n = lapNormal(p);
  float th = uLapSize.w;
  vec3 ld = vec3(0.0, cos(th), sin(th));
  vec3 ln = vec3(0.0, -sin(th), cos(th));
  vec3 col;
  if (part < 1.5) {
    float v = clamp(dot(p, ld) / uLapSize.y, 0.0, 1.0);
    vec3 back = mix(LID_LOW, LID_HIGH, v) * mix(0.78, 1.0, smoothstep(0.0, 0.15, v));
    float topness = smoothstep(0.25, 0.75, dot(n, ld));
    float sideness = 1.0 - smoothstep(0.2, 0.6, abs(dot(n, ln)));
    col = mix(back, LAP_SIDE, sideness);
    col = mix(col, LID_EDGE, topness);
  } else {
    vec3 b = p - vec3(0.0, -BASE_T * 0.5, -uLapSize.z * 0.5);
    if (n.y > 0.5) {
      col = BASE_TOP;
      float kx = uLapSize.x * 0.5 - 7.0;
      float z0 = -uLapSize.z * 0.5 + uLapSize.z * 0.40;
      float z1 = uLapSize.z * 0.5 - uLapSize.z * 0.10;
      if (abs(b.x) < kx && b.z > z0 && b.z < z1) {
        vec2 g = fract(vec2(b.x, b.z) / 5.5);
        float key = step(0.18, g.x) * step(0.18, g.y);
        col = mix(KEY_GAP, KEY_TOP, key);
      }
    } else {
      col = LAP_SIDE * mix(0.9, 1.08, smoothstep(-BASE_T * 0.5, BASE_T * 0.5, b.y));
    }
  }
  return vec4(col, 1.0);
}

vec4 shade(vec2 P) {
  vec4 body = shadeBody(P);
  if (uLaptop > 0.001) {
    vec4 lap = shadeLaptop(P) * clamp(uLaptop, 0.0, 1.0);
    body = lap + body * (1.0 - lap.a);
  }
  return body;
}

void main() {
  vec4 acc = vec4(0.0);
  vec2 base = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  for (int j = 0; j < uSS; j++) {
    for (int i = 0; i < uSS; i++) {
      vec2 off = (vec2(float(i), float(j)) + 0.5) / float(uSS) - 0.5;
      acc += shade((base + off) / uScale);
    }
  }
  outColor = acc / float(uSS * uSS);
}
`;

  // ── 작은 계산 도구 ────────────────────────────────────────
  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); }
  function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

  function normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  // ── 몸 모양 ───────────────────────────────────────────────

  // 자세에 몸 아래쪽 모양 값이 따로 있으면 그것을 쓴다 (아래를 볼 때 바닥이 둥글어지는 것을 흉내 내기 위함)
  function shapeFor(shape, pose) {
    return {
      a: shape.a, bt: shape.bt,
      bb: isNumber(pose.bb) ? pose.bb : shape.bb,
      nb: isNumber(pose.nb) ? pose.nb : shape.nb,
    };
  }

  // 몸의 옆모습: 높이 y에서의 반지름 (셰이더의 profile과 같은 식)
  function profile(y, s) {
    if (y >= 0) {
      const t = y / s.bt;
      return t >= 1 ? 0 : s.a * Math.sqrt(1 - t * t);
    }
    const t = -y / s.bb;
    if (t >= 1) return 0;
    const k = clamp(t / PROFILE_BLEND, 0, 1);
    const n = 2 + (s.nb - 2) * k * k * (3 - 2 * k);
    return s.a * Math.pow(1 - Math.pow(t, n), 1 / n);
  }

  // 옆모습의 기울기 (높이가 1 오를 때 반지름이 변하는 양)
  function profileSlope(y, s) {
    return (profile(y + PROFILE_STEP, s) - profile(y - PROFILE_STEP, s)) / (2 * PROFILE_STEP);
  }

  // 몸 중심 기준 화면 점(X 오른쪽, Y 위)에서 표면의 깊이와 법선을 구한다
  function bodyHit(X, Y, s) {
    const r = profile(Y, s);
    if (r < 0.01 || Math.abs(X) >= r) return null;
    const z = Math.sqrt(r * r - X * X);
    const n = normalize([X / r, -profileSlope(Y, s), z / r]);
    return { z, nx: n[0], ny: n[1], nz: n[2] };
  }

  // 몸 중심에서 주어진 방향으로 나가 표면과 만나는 점과 그 법선을 구한다
  function surfacePoint(d, s) {
    const rho = Math.hypot(d[0], d[2]);
    if (rho < 1e-6) {
      // 똑바로 위나 아래를 향하면 꼭대기나 바닥이다
      const up = d[1] >= 0;
      return { p: [0, up ? s.bt : -s.bb, 0], n: [0, up ? 1 : -1, 0] };
    }
    // 중심에서 멀어질수록 "바깥쪽 거리 - 반지름"이 커지므로 반씩 좁혀 가며 찾는다
    let near = 0, far = Math.max(s.a, s.bt, s.bb) * 1.5;
    for (let i = 0; i < SURFACE_SEARCH_STEPS; i++) {
      const middle = (near + far) / 2;
      if (middle * rho - profile(middle * d[1], s) > 0) far = middle; else near = middle;
    }
    const t = (near + far) / 2;
    const p = [d[0] * t, d[1] * t, d[2] * t];
    const radius = Math.max(rho * t, 0.0001);
    return { p, n: normalize([p[0] / radius, -profileSlope(p[1], s), p[2] / radius]) };
  }

  // 얼굴 방향(yaw, pitch)과 눈 사이 각으로 두 눈의 위치와 기준 축을 구한다
  function eyeFrames(pose, s) {
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw), cp = Math.cos(pose.pitch), sp = Math.sin(pose.pitch);
    const rotate = (v) => {
      const y1 = v[1] * cp + v[2] * sp;
      const z1 = -v[1] * sp + v[2] * cp;
      return [v[0] * cy + z1 * sy, y1, -v[0] * sy + z1 * cy];
    };
    const faceUp = rotate([0, 1, 0]);
    const mix = isNumber(pose.upMix) ? pose.upMix : EYE_UP_MIX;
    const flat = isNumber(pose.eyeFlat) ? pose.eyeFlat : EYE_FLAT;
    const twist = pose.twist || 0;
    const frames = [];
    for (const side of [-1, 1]) {
      const direction = rotate([side * Math.sin(pose.sep), 0, Math.cos(pose.sep)]);
      const hit = surfacePoint(direction, s);
      // 눈이 놓이는 면: 표면 그대로와 화면을 마주 보는 면 사이. 원본은 가장자리에서도 눈이 덜 찌그러진다
      const plane = normalize([hit.n[0] * (1 - flat), hit.n[1] * (1 - flat), hit.n[2] * (1 - flat) + flat]);
      // 눈의 세로축: 얼굴을 따라 도는 방향과 화면에서 곧게 서는 방향을 섞는다
      const along = dot(plane, faceUp);
      const faceTangent = normalize([faceUp[0] - plane[0] * along, faceUp[1] - plane[1] * along, faceUp[2] - plane[2] * along]);
      const screenTangent = normalize([0, plane[2], -plane[1]]);
      let up = normalize([
        faceTangent[0] * (1 - mix) + screenTangent[0] * mix,
        faceTangent[1] * (1 - mix) + screenTangent[1] * mix,
        faceTangent[2] * (1 - mix) + screenTangent[2] * mix,
      ]);
      let right = cross(up, plane);
      if (twist) {
        const c = Math.cos(twist), s2 = Math.sin(twist);
        const up2 = [up[0] * c + right[0] * s2, up[1] * c + right[1] * s2, up[2] * c + right[2] * s2];
        const right2 = [right[0] * c - up[0] * s2, right[1] * c - up[1] * s2, right[2] * c - up[2] * s2];
        up = up2; right = right2;
      }
      frames.push({ p: hit.p, n: plane, up, right });
    }
    return frames;
  }

  // 아이콘으로 쓸 때 잘라 낼 정사각형(칸 픽셀)을 구한다: 몸 전체가 들어가고 가운데에 오게 한다
  function iconRegion(pose, shape) {
    const s = shapeFor(shape, pose);
    const left = pose.cx - s.a * pose.sx, right = pose.cx + s.a * pose.sx;
    const top = pose.cy - s.bt * pose.sy, bottom = pose.cy + s.bb * pose.sy;
    const size = Math.max(right - left, bottom - top) + ICON_MARGIN * 2;
    return { x: (left + right) / 2 - size / 2, y: (top + bottom) / 2 - size / 2, size };
  }

  // ── 색 바꾸기 ─────────────────────────────────────────────
  // 빛 지도의 색을 다른 색으로 옮긴다. 밝기·선명함·색상을 따로 다루는 OKLab 색 공간에서 계산해
  // 밝은 곳과 어두운 곳의 차이(음영)는 그대로 두고 색만 바꾼다.

  function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  // sRGB(0~255) → OKLab [밝기, a, b]
  function oklabFromRgb(r8, g8, b8) {
    const r = srgbToLinear(r8 / 255), g = srgbToLinear(g8 / 255), b = srgbToLinear(b8 / 255);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }

  // OKLab → 선형 RGB (범위를 벗어날 수 있다)
  function linearFromOklab(L, a, b) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }

  function toByte(linear) { return Math.round(clamp(linearToSrgb(clamp(linear, 0, 1)), 0, 1) * 255); }

  // 밝기·선명함·색상각으로 sRGB(0~255)를 만든다. 화면이 낼 수 없는 색이면 선명함을 줄여 맞춘다
  function rgbFromLch(L, C, h) {
    let chroma = C;
    for (let i = 0; i < GAMUT_STEPS; i++) {
      const rgb = linearFromOklab(L, chroma * Math.cos(h), chroma * Math.sin(h));
      if (rgb.every((v) => v >= -GAMUT_SLACK && v <= 1 + GAMUT_SLACK) || chroma < 1e-4) return rgb.map(toByte);
      chroma *= GAMUT_SHRINK;
    }
    return linearFromOklab(L, 0, 0).map(toByte);
  }

  // "#rrggbb" 글자를 [r, g, b]로 바꾼다. 형식이 틀리면 null
  function parseHexColor(text) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(text == null ? '' : text).trim());
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  // [r, g, b]를 "#rrggbb"로 바꾼다
  function toHexColor(rgb) {
    return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  // 색상(0~360)·선명함(0~1)·밝기(0~1)를 [r, g, b]로 바꾼다 (색상 패널용)
  function rgbFromHsv(h, s, v) {
    const hue = ((h % 360) + 360) % 360 / 60;
    const c = v * s, x = c * (1 - Math.abs(hue % 2 - 1)), m = v - c;
    const [r, g, b] = hue < 1 ? [c, x, 0] : hue < 2 ? [x, c, 0] : hue < 3 ? [0, c, x] : hue < 4 ? [0, x, c] : hue < 5 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  // [r, g, b]를 색상(0~360)·선명함(0~1)·밝기(0~1)로 바꾼다
  function hsvFromRgb(rgb) {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta > 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max > 0 ? delta / max : 0, v: max };
  }

  // 빛 지도의 대표색(몸 한가운데 색)을 구한다
  function matcapBaseColor(pixels, size) {
    let r = 0, g = 0, b = 0, n = 0;
    const center = Math.floor(size / 2), reach = Math.max(1, Math.floor(size * BASE_SAMPLE_RATIO));
    for (let y = center - reach; y <= center + reach; y++) {
      for (let x = center - reach; x <= center + reach; x++) {
        const i = (y * size + x) * 4;
        r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n++;
      }
    }
    return [r / n, g / n, b / n];
  }

  // 빛 지도 전체를 목표 색으로 옮긴 새 픽셀 배열을 돌려준다 (원본은 건드리지 않는다)
  function recolorMatcap(pixels, size, targetRgb) {
    if (!pixels || pixels.length !== size * size * 4) throw new Error(`빛 지도 크기가 맞지 않음 (${pixels ? pixels.length : 0} ≠ ${size * size * 4})`);
    if (!Array.isArray(targetRgb) || targetRgb.length !== 3 || targetRgb.some((v) => !isNumber(v))) throw new Error('바꿀 색이 올바르지 않음');
    const base = matcapBaseColor(pixels, size);
    const [bL, ba, bb2] = oklabFromRgb(base[0], base[1], base[2]);
    const [tL, ta, tb] = oklabFromRgb(targetRgb[0], targetRgb[1], targetRgb[2]);
    const baseChroma = Math.hypot(ba, bb2), targetChroma = Math.hypot(ta, tb);
    const baseHue = Math.atan2(bb2, ba), targetHue = Math.atan2(tb, ta);
    const chromaScale = baseChroma > 1e-4 ? targetChroma / baseChroma : 0;
    // 색상이 없는 목표(흰색·회색)는 돌릴 방향이 없으므로 원래 색상각을 그대로 둔다
    const hueShift = targetChroma > 1e-4 ? targetHue - baseHue : 0;
    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      const [L, a, b] = oklabFromRgb(pixels[i], pixels[i + 1], pixels[i + 2]);
      // 밝기: 목표가 더 밝으면 흰색 쪽으로, 더 어두우면 검정 쪽으로 눌러 음영의 순서를 지킨다
      const newL = tL >= bL ? 1 - (1 - L) * ((1 - tL) / Math.max(1e-4, 1 - bL)) : L * (tL / Math.max(1e-4, bL));
      const chroma = Math.hypot(a, b) * chromaScale;
      const hue = Math.atan2(b, a);
      // 밝은 테두리와 어두운 바닥은 원래 색상각이 조금 다르다. 그 차이는 줄여서 옮긴다
      const offset = Math.atan2(Math.sin(hue - baseHue), Math.cos(hue - baseHue)) * HUE_OFFSET_KEEP;
      const rgb = rgbFromLch(newL, chroma, baseHue + offset + hueShift);
      out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255;
    }
    return out;
  }

  // 몸 색에 어울리는 눈 색을 고른다 (몸이 어두우면 눈이 묻히므로 밝은 눈을 쓴다). bodyRgb가 없으면 원래 눈
  function eyeColorsFor(bodyRgb) {
    if (!Array.isArray(bodyRgb) || bodyRgb.length !== 3) return EYE_DARK;
    return oklabFromRgb(bodyRgb[0], bodyRgb[1], bodyRgb[2])[0] < DARK_BODY_L ? EYE_LIGHT : EYE_DARK;
  }

  // ── 동작 재생 ─────────────────────────────────────────────

  // 네 점을 지나는 부드러운 곡선에서 p1과 p2 사이의 값을 구한다 (u: 0~1)
  function catmull(p0, p1, p2, p3, u) {
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  }

  // 자세 값이 한도를 벗어나지 않게 다듬는다
  function tidyPose(pose) {
    for (const key of UNIT_KEYS) if (isNumber(pose[key])) pose[key] = clamp(pose[key], 0, 1);
    if (isNumber(pose.sx)) pose.sx = clamp(pose.sx, SCALE_MIN, SCALE_MAX);
    if (isNumber(pose.sy)) pose.sy = clamp(pose.sy, SCALE_MIN, SCALE_MAX);
    return pose;
  }

  // 펫 자료(model.json)를 검사하고 재생하기 좋은 꼴로 바꾼다. 문제가 있으면 이유를 담아 던진다
  function prepareModel(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('펫 자료가 객체가 아님');
    const shape = raw.shape;
    if (!shape || !['a', 'bt', 'bb', 'nb'].every((k) => isNumber(shape[k]) && shape[k] > 0)) throw new Error('몸 모양 값(shape)이 올바르지 않음');
    const basePose = Object.assign({}, DEFAULT_POSE, raw.base || {});
    basePose.bb = isNumber(basePose.bb) ? basePose.bb : shape.bb;
    basePose.nb = isNumber(basePose.nb) ? basePose.nb : shape.nb;
    basePose.rx0 = basePose.rx;          // 반짝임 위치의 기준이 되는 눈 크기
    basePose.ry0 = basePose.ry;
    for (const key of Object.keys(basePose)) if (!isNumber(basePose[key])) throw new Error(`기본 자세의 ${key} 값이 숫자가 아님`);
    if (!raw.clips || typeof raw.clips !== 'object') throw new Error('동작(clips)이 없음');
    const clips = {};
    for (const name of Object.keys(raw.clips)) {
      const source = raw.clips[name];
      if (!source || !Array.isArray(source.frames) || !source.frames.length) throw new Error(`동작 "${name}"에 프레임이 없음`);
      let total = 0;
      const frames = source.frames.map((frame, index) => {
        if (!frame || !isNumber(frame.ms) || frame.ms <= 0) throw new Error(`동작 "${name}"의 ${index}번 프레임 시간이 올바르지 않음`);
        const pose = {};
        for (const key of ANIMATED_KEYS) {
          const value = frame.pose && frame.pose[key] !== undefined ? frame.pose[key] : basePose[key];
          if (!isNumber(value)) throw new Error(`동작 "${name}"의 ${index}번 프레임 ${key} 값이 숫자가 아님`);
          pose[key] = value;
        }
        const start = total;
        total += frame.ms;
        return { ms: frame.ms, start, pose };
      });
      clips[name] = { name, loop: !!source.loop, frames, total };
    }
    for (const name of REQUIRED_CLIPS) if (!clips[name]) throw new Error(`필요한 동작 "${name}"이 없음`);
    let look = null;
    if (raw.look) {
      const directions = raw.look.directions;
      if (!Array.isArray(directions) || directions.length !== LOOK_DIRECTIONS) throw new Error(`바라보기 방향은 ${LOOK_DIRECTIONS}개여야 함`);
      look = {
        falloffPx: isNumber(raw.look.falloffPx) && raw.look.falloffPx > 0 ? raw.look.falloffPx : LOOK_FALLOFF_PX,
        directions: directions.map((dir, index) => {
          const out = {};
          for (const key of LOOK_KEYS) {
            if (!dir || !isNumber(dir[key])) throw new Error(`바라보기 ${index}번 방향의 ${key} 값이 숫자가 아님`);
            out[key] = dir[key];
          }
          return out;
        }),
      };
    }
    return { shape: { a: shape.a, bt: shape.bt, bb: shape.bb, nb: shape.nb }, base: basePose, clips, look };
  }

  // 동작의 주어진 시각에서 자세를 구한다. 프레임 i는 "그 구간 동안 i번 자세에서 i+1번 자세로 간다"로 풀이한다
  function sampleClip(clip, timeMs) {
    const frames = clip.frames, count = frames.length;
    let t = clip.loop ? ((timeMs % clip.total) + clip.total) % clip.total : clamp(timeMs, 0, clip.total);
    let index = count - 1;
    for (let i = 0; i < count; i++) {
      if (t < frames[i].start + frames[i].ms) { index = i; break; }
    }
    const u = clamp((t - frames[index].start) / frames[index].ms, 0, 1);
    const at = (k) => frames[clip.loop ? ((k % count) + count) % count : clamp(k, 0, count - 1)].pose;
    const p0 = at(index - 1), p1 = at(index), p2 = at(index + 1), p3 = at(index + 2);
    const pose = {};
    for (const key of ANIMATED_KEYS) pose[key] = catmull(p0[key], p1[key], p2[key], p3[key], u);
    return tidyPose(pose);
  }

  // 두 자세를 섞는다 (t = 0이면 a, 1이면 b)
  function mixPose(a, b, t) {
    const pose = {};
    for (const key of ANIMATED_KEYS) pose[key] = lerp(a[key], b[key], t);
    return pose;
  }

  // 커서가 있는 쪽(dx 오른쪽+, dy 아래+, 화면 픽셀)을 볼 때의 얼굴 값과 돌아간 정도(0~1)를 구한다
  function lookTarget(look, dx, dy) {
    if (!look || !isNumber(dx) || !isNumber(dy)) return null;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return null;
    let angle = Math.atan2(dx, -dy);                       // 위 = 0, 시계 방향
    if (angle < 0) angle += Math.PI * 2;
    const position = angle / (Math.PI * 2 / LOOK_DIRECTIONS);
    const first = Math.floor(position) % LOOK_DIRECTIONS, second = (first + 1) % LOOK_DIRECTIONS, part = position - Math.floor(position);
    const target = { amount: 1 - Math.exp(-distance / look.falloffPx) };
    for (const key of LOOK_KEYS) target[key] = lerp(look.directions[first][key], look.directions[second][key], part);
    return target;
  }

  // 상태에 맞는 동작을 이어 붙이고 섞어 매 순간의 자세를 내놓는 재생기
  function createActor(rawModel) {
    const model = prepareModel(rawModel);
    const state = {
      base: 'idle', drag: null, still: false,
      clip: model.clips.idle, time: 0, oneShot: null, onEnd: null,
      blend: null,                       // { from, left, total }
      lastClipPose: sampleClip(model.clips.idle, 0),
      look: { active: false, dx: 0, dy: 0 }, lookWeight: 0, gaze: null, gazeMoving: false,
      motion: { squash: 1, lean: 0 },
    };

    // 지금 재생해야 할 반복 동작의 이름
    function wantedLoop() {
      if (state.drag) return state.drag === 'right' ? 'running-right' : 'running-left';
      return model.clips[state.base] ? state.base : 'idle';
    }

    // 동작을 바꾼다. 앞 자세에서 새 동작으로 짧게 섞는다
    function startClip(name, blendMs) {
      const clip = model.clips[name];
      if (!clip) return false;
      state.blend = { from: Object.assign({}, state.lastClipPose), left: blendMs, total: blendMs };
      state.clip = clip;
      state.time = 0;
      return true;
    }

    // 반복 동작이 바뀌어야 하면 바꾼다 (한 번 재생 중에는 끝날 때까지 둔다)
    function syncLoop(blendMs) {
      if (state.oneShot) return;
      const name = wantedLoop();
      if (state.clip.name !== name) startClip(name, blendMs);
    }

    return {
      model,
      // 앱 상태에 맞는 반복 동작을 정한다
      setBase(name) {
        if (!model.clips[name] || state.base === name) return;
        state.base = name;
        syncLoop(TRANSITION_MS);
      },
      // 한 번만 재생하고 원래 동작으로 돌아간다. 끄는 중이거나 없는 동작이면 false
      playOnce(name, onEnd) {
        if (state.drag || !model.clips[name]) return false;
        state.oneShot = name;
        state.onEnd = typeof onEnd === 'function' ? onEnd : null;
        return startClip(name, TRANSITION_MS);
      },
      // 끄는 방향('left' | 'right')을 알린다. null이면 끌기 끝
      setDrag(direction) {
        const next = direction === 'left' || direction === 'right' ? direction : null;
        if (next === state.drag) return;
        state.drag = next;
        if (next) { state.oneShot = null; state.onEnd = null; }
        syncLoop(DRAG_TRANSITION_MS);
      },
      // 커서 위치를 알린다 (펫 얼굴 기준 화면 픽셀)
      setLook(look) {
        state.look = { active: !!(look && look.active), dx: look && isNumber(look.dx) ? look.dx : 0, dy: look && isNumber(look.dy) ? look.dy : 0 };
      },
      // 탄력 값(눌림 배율, 기울임)을 알린다
      setMotion(motion) {
        state.motion = {
          squash: motion && isNumber(motion.squash) ? clamp(motion.squash, SCALE_MIN, SCALE_MAX) : 1,
          lean: motion && isNumber(motion.lean) ? motion.lean : 0,
        };
      },
      // 움직임을 멈추고 상태별 첫 자세만 보여 준다 (움직임 줄이기 설정용)
      setStill(flag) { state.still = !!flag; },
      // 초당 그리는 횟수를 올려야 하는 순간인지
      isBusy() {
        return !!(state.blend || state.oneShot || state.drag || state.gazeMoving
          || Math.abs(state.motion.squash - 1) > MOTION_REST || Math.abs(state.motion.lean) > MOTION_REST);
      },
      clipName() { return state.clip.name; },
      // 시간을 흘려보내고 지금의 자세(그리기에 필요한 모든 값)를 돌려준다
      update(deltaMs) {
        const dt = clamp(isNumber(deltaMs) ? deltaMs : 0, 0, MAX_STEP_MS);
        let clipPose;
        if (state.still) {
          state.oneShot = null; state.blend = null;
          const name = wantedLoop();
          if (state.clip.name !== name) { state.clip = model.clips[name]; }
          state.time = 0;
          clipPose = sampleClip(state.clip, 0);
        } else {
          state.time += dt;
          if (!state.clip.loop && state.time >= state.clip.total) {
            // 한 번 재생이 끝났다
            state.lastClipPose = sampleClip(state.clip, state.clip.total);
            const done = state.onEnd;
            state.oneShot = null; state.onEnd = null;
            startClip(wantedLoop(), TRANSITION_MS);
            if (done) { try { done(); } catch (e) { /* 알림 받는 쪽의 오류로 재생이 멈추면 안 된다 */ } }
          }
          clipPose = sampleClip(state.clip, state.time);
          if (state.blend) {
            state.blend.left -= dt;
            if (state.blend.left <= 0) state.blend = null;
            else clipPose = mixPose(state.blend.from, clipPose, smooth(1 - state.blend.left / state.blend.total));
          }
        }
        state.lastClipPose = clipPose;
        const pose = Object.assign({}, model.base, clipPose);
        const ground = pose.cy + pose.bb * pose.sy;       // 발밑 높이. 아래에서 모양을 바꿔도 여기는 그대로 둔다

        // 커서 바라보기: 대기 동작일 때만 얼굴 방향을 덮어쓴다
        const lookable = !state.still && state.clip.name === 'idle' && !state.oneShot && state.look.active && model.look;
        const target = lookable ? lookTarget(model.look, state.look.dx, state.look.dy) : null;
        const fade = LOOK_FADE_MS > 0 ? dt / LOOK_FADE_MS : 1;
        state.lookWeight = target ? Math.min(1, state.lookWeight + fade) : Math.max(0, state.lookWeight - fade);
        let gazeMoving = false;
        if (target) {
          const follow = 1 - Math.exp(-dt / GAZE_FOLLOW_MS);
          const aim = {};
          for (const key of LOOK_KEYS) aim[key] = lerp(pose[key], target[key], target.amount);
          if (!state.gaze) {
            state.gaze = aim;
            gazeMoving = true;
          } else {
            // 눈이 목표에서 아직 떨어져 있으면 움직이는 중이다 (자주 그려야 한다)
            gazeMoving = Math.abs(aim.yaw - state.gaze.yaw) + Math.abs(aim.pitch - state.gaze.pitch) > GAZE_REST;
            for (const key of LOOK_KEYS) state.gaze[key] += (aim[key] - state.gaze[key]) * follow;
          }
        }
        state.gazeMoving = gazeMoving || (state.lookWeight > 0 && state.lookWeight < 1);
        if (state.gaze && state.lookWeight > 0) {
          const w = smooth(state.lookWeight);
          for (const key of LOOK_KEYS) pose[key] = lerp(pose[key], state.gaze[key], w);
        } else if (state.lookWeight <= 0) {
          state.gaze = null;
        }

        // 탄력: 눌리면 옆으로 퍼지고, 끌면 기운다
        if (!state.still) {
          pose.sy *= state.motion.squash;
          pose.sx /= Math.sqrt(state.motion.squash);
          pose.shear += state.motion.lean;
        }
        tidyPose(pose);
        pose.cy = ground - pose.bb * pose.sy;
        pose.ly = model.base.ly + (1 - pose.laptop) * LAPTOP_SLIDE;
        return pose;
      },
    };
  }

  // ── 그리기 도구 ───────────────────────────────────────────

  // 캔버스에 WebGL 그리기 도구를 만든다. 실패하면 이유를 담아 던진다
  function createRenderer(canvas, options) {
    const keep = !!(options && options.preserveDrawingBuffer);
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: keep });
    if (!gl) throw new Error('WebGL2 컨텍스트를 만들 수 없음 (그래픽 가속이 꺼져 있거나 지원하지 않는 환경)');
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`셰이더 컴파일 실패: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SOURCE));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`셰이더 연결 실패: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    const cache = {};
    const uniform = (name) => {
      if (!(name in cache)) cache[name] = gl.getUniformLocation(program, name);
      return cache[name];
    };
    let texture = null;
    let eyeColors = EYE_DARK;

    // 빛 지도를 텍스처로 올린다. source는 RGBA 픽셀 배열(size 필요)이거나 그림/캔버스
    function setMatcap(source, size) {
      if (!texture) texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
        if (!Number.isInteger(size) || source.length !== size * size * 4) throw new Error('빛 지도 픽셀 수가 크기와 맞지 않음');
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // 눈 색을 정한다 ({ eye, edge, highlight } 각각 [r, g, b])
    function setEyeColors(colors) {
      eyeColors = colors && colors.eye && colors.edge && colors.highlight ? colors : EYE_DARK;
    }

    // 자세 값으로 한 장을 그린다. scale은 칸 1픽셀당 캔버스 픽셀 수, ss는 픽셀당 표본 수(한 변)
    function draw(pose, shape, scale, ss) {
      if (!texture) throw new Error('빛 지도를 먼저 올려야 함');
      const width = Math.max(1, Math.round(CELL_W * scale)), height = Math.max(1, Math.round(CELL_H * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const bodyShape = shapeFor(shape, pose);
      const value = (key, fallback) => (isNumber(pose[key]) ? pose[key] : fallback);
      gl.viewport(0, 0, width, height);
      gl.uniform2f(uniform('uRes'), width, height);
      gl.uniform1f(uniform('uScale'), scale);
      gl.uniform1i(uniform('uSS'), ss);
      gl.uniform2f(uniform('uBodyC'), pose.cx, pose.cy);
      gl.uniform2f(uniform('uBodyS'), pose.sx, pose.sy);
      gl.uniform1f(uniform('uRoll'), value('roll', 0));
      gl.uniform1f(uniform('uShear'), value('shear', 0));
      gl.uniform1f(uniform('uGround'), pose.cy + bodyShape.bb * pose.sy);
      gl.uniform4f(uniform('uShape'), bodyShape.a, bodyShape.bt, bodyShape.bb, bodyShape.nb);
      gl.uniform1i(uniform('uMatcap'), 0);
      gl.uniform1f(uniform('uMatK'), MATCAP_K);
      gl.uniform2f(uniform('uNoise'), value('noiseAmp', 0), value('noiseFreq', 1));
      const frames = eyeFrames(pose, bodyShape);
      const flat = (key) => new Float32Array(frames[0][key].concat(frames[1][key]));
      gl.uniform3fv(uniform('uEyeP'), flat('p'));
      gl.uniform3fv(uniform('uEyeRt'), flat('right'));
      gl.uniform3fv(uniform('uEyeUp'), flat('up'));
      gl.uniform3fv(uniform('uEyeN'), flat('n'));
      gl.uniform3f(uniform('uEyeSize'), pose.rx, pose.ry, pose.m);
      // 반짝임의 자리와 크기는 기준 눈 크기(rx0, ry0)에서 잰 값이다. 눈이 작아지면 거기에 맞춰 줄인다
      gl.uniform2f(uniform('uEyeRef'), Math.max(0.1, value('rx0', pose.rx)), Math.max(0.1, value('ry0', pose.ry)));
      gl.uniform3f(uniform('uHi'), pose.hx, pose.hy, pose.hr);
      gl.uniform3f(uniform('uEyeColor'), eyeColors.eye[0] / 255, eyeColors.eye[1] / 255, eyeColors.eye[2] / 255);
      gl.uniform3f(uniform('uEyeEdge'), eyeColors.edge[0] / 255, eyeColors.edge[1] / 255, eyeColors.edge[2] / 255);
      gl.uniform3f(uniform('uHiColor'), eyeColors.highlight[0] / 255, eyeColors.highlight[1] / 255, eyeColors.highlight[2] / 255);
      gl.uniform4f(uniform('uEyeExpr'), value('open', 1), value('smile', 0), value('lid', 0), value('slant', 0));
      gl.uniform1f(uniform('uLaptop'), value('laptop', 0));
      gl.uniform3f(uniform('uLapT'), pose.lx, -pose.ly, 0);
      // 노트북 좌표 → 화면 좌표 회전: 카메라 내려다보기(Rx) · 세로축 돌리기(Ry)
      const ca = Math.cos(pose.lalpha), sa = Math.sin(pose.lalpha), cb = Math.cos(pose.lbeta), sb = Math.sin(pose.lbeta);
      const tilt = (v) => [v[0], v[1] * ca - v[2] * sa, v[1] * sa + v[2] * ca];
      gl.uniformMatrix3fv(uniform('uLapR'), false, new Float32Array(tilt([cb, 0, sb]).concat(tilt([0, 1, 0]), tilt([-sb, 0, cb]))));
      gl.uniform4f(uniform('uLapSize'), pose.lw, pose.lh, pose.ld, pose.ltheta);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return { width, height };
    }

    // 어떤 그래픽 장치로 그리는지 알려 준다
    function info() {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    }

    return { gl, setMatcap, setEyeColors, draw, info };
  }

  return {
    CELL_W, CELL_H, MATCAP_K, DEFAULT_SHAPE, DEFAULT_POSE, ANIMATED_KEYS, REQUIRED_CLIPS, LOOK_DIRECTIONS, LOOK_KEYS, LAPTOP_SLIDE,
    EYE_DARK, EYE_LIGHT,
    clamp, lerp, smooth, normalize, cross, dot,
    shapeFor, profile, bodyHit, surfacePoint, eyeFrames, iconRegion,
    oklabFromRgb, rgbFromLch, parseHexColor, toHexColor, rgbFromHsv, hsvFromRgb, matcapBaseColor, recolorMatcap, eyeColorsFor,
    catmull, prepareModel, sampleClip, mixPose, lookTarget, createActor,
    createRenderer,
  };
});
