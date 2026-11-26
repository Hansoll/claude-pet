// 3D 펫 자료를 만드는 도구. 이미지 펫의 시트를 읽어 몸 모양, 색 지도, 동작별 자세 값을 원본 칸에 맞춰 뽑아낸다.
// 실행: node tools/pet3d/build.js [--source=orange-pickle] [--id=orange-pickle-3d] [--name=이름] [--report=확인 그림 폴더]
// Electron을 그림판으로 쓰므로 먼저 "펫 실행"으로 런타임이 설치돼 있어야 한다. 결과는 pets/<id>/ 에 저장된다.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config.js');
const petSpec = require('../../pets.js');
const PET3D = require('../../pet3d.js');
const { DEG, STEPS, KINDS, CLIPS, WORK_CLIP, WORK_START } = require('./frames.js');

// ── 설정 상수 ───────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const PAGE_FILE = path.join(__dirname, 'fit.html');
const BUILD_DATA_DIR = config.ELECTRON_DATA_DIR + '-pet3d-build';
const DEFAULT_SOURCE = 'orange-pickle';
const DEFAULT_ID = 'orange-pickle-3d';
const DEFAULT_NAME = '모찌 3D';
const MODEL_NAME = 'model.json';
const MATCAP_NAME = 'matcap.png';
const MODEL_VERSION = 1;
const TRAY_ICON_PX = 64;                 // 알림 영역 아이콘 기본 그림의 한 변
const IDLE_CELL = [0, 0];                // 몸 모양과 색 지도를 뽑는 칸
const ROUNDS = 60;                       // 맞추기 반복 한도
const WORK_LIMIT_Y = 124;                // 작업 칸에서 노트북 덮개가 시작하는 높이 (이 위쪽만 몸으로 본다)
const WARN_OVERLAP = 97;                 // 윤곽 겹침이 이보다 낮으면 경고
const WARN_COLOR = 10;                   // 색 차이가 이보다 크면 경고
const ESTIMATE_KEYS = ['cx', 'cy', 'sx', 'sy', 'shear', 'yaw', 'pitch'];
const LAPTOP_KEYS = ['lx', 'ly', 'lw', 'lh', 'ld', 'lalpha', 'lbeta', 'ltheta'];
const REPORT_GROUPS = [['idle', 'running-right', 'running-left'], ['waving', 'jumping', 'failed'], ['waiting', 'running', 'review']];

// "--이름=값" 꼴의 인자를 읽는다
function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = ARGS.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

// 일반 Node로 실행됐으면 설치된 Electron으로 자신을 다시 실행한다
function relaunchWithElectron() {
  const { spawnSync } = require('child_process');
  let electronPath;
  try {
    electronPath = require(path.join(config.RUNTIME_DIR, 'node_modules', 'electron'));
  } catch (e) {
    console.error(`Electron을 찾을 수 없음 (${config.RUNTIME_DIR}). 먼저 "node launch.js"로 설치하세요: ${e.message}`);
    process.exit(1);
  }
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronPath, [__filename].concat(ARGS), { stdio: 'inherit', env });
  if (result.error) {
    console.error(`Electron 실행 실패 (${electronPath}): ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

// 숫자를 자릿수에 맞춰 줄인다
function round(value, digits) {
  const scale = Math.pow(10, digits);
  return Math.round(value * scale) / scale;
}

// 여러 걸음 묶음을 하나로 합친다
function stepsFor(groups) {
  const out = {};
  for (const name of groups) {
    if (!STEPS[name]) throw new Error(`알 수 없는 걸음 묶음: ${name}`);
    Object.assign(out, STEPS[name]);
  }
  return out;
}

// 칸 표의 한 항목을 { kind, start, noEstimate } 꼴로 풀어 쓴다
function frameSpec(entry) {
  const spec = typeof entry === 'string' ? { kind: entry } : Object.assign({}, entry);
  if (!KINDS[spec.kind]) throw new Error(`알 수 없는 표정 종류: ${spec.kind}`);
  return spec;
}

// 페이지 안의 함수를 호출하고 결과를 받는다
function makeCaller(win) {
  return async (expression) => {
    try {
      return await win.webContents.executeJavaScript(expression);
    } catch (e) {
      throw new Error(`페이지 호출 실패 (${expression.slice(0, 80)}): ${e.message}`);
    }
  };
}

// 칸 하나에 자세를 맞춘다. 결과 자세와 원본과의 차이를 돌려준다
async function fitFrame(call, cell, spec, base, previous, options) {
  const kind = KINDS[spec.kind];
  const uniform = !!(options && options.uniform);
  const start = Object.assign({}, previous && (spec.noEstimate || uniform) ? previous : base);
  if (!spec.noEstimate && !uniform) {
    const estimate = await call(`estimateStart(${cell[0]}, ${cell[1]}, ${options && options.limitY ? options.limitY : 'undefined'})`);
    if (estimate) for (const key of ESTIMATE_KEYS) if (Number.isFinite(estimate[key])) start[key] = estimate[key];
  }
  const extra = Object.assign({}, spec.start || {});
  if (Number.isFinite(extra.cyShift)) { start.cy += extra.cyShift; delete extra.cyShift; }
  // 표정이 바뀌는 칸에서는 눈 크기와 표정 값을 기본으로 되돌린 뒤 그 표정의 값을 얹는다
  for (const key of ['rx', 'ry', 'open', 'smile', 'lid', 'slant', 'twist']) start[key] = base[key];
  Object.assign(start, kind.start, extra, kind.set);
  const groups = kind.fit.map((name) => (uniform && name === 'body' ? 'uniform' : name)).concat((options && options.extraFit) || []);
  const result = await call(`fitPose(${cell[0]}, ${cell[1]}, ${JSON.stringify(start)}, ${JSON.stringify(stepsFor(groups))}, ${ROUNDS})`);
  const pose = Object.assign({}, result.params, kind.set);
  const metrics = await call(`measure(${cell[0]}, ${cell[1]}, ${JSON.stringify(pose)})`);
  return { pose, metrics, loss: result.loss };
}

// 맞춘 자세에서 동작에 쓰는 값만 골라 줄여 적는다
function compactPose(pose, shape) {
  const out = {};
  for (const key of PET3D.ANIMATED_KEYS) {
    let value = pose[key];
    if (!Number.isFinite(value)) value = key === 'bb' ? shape.bb : key === 'nb' ? shape.nb : 0;
    out[key] = round(value, ['cx', 'cy', 'rx', 'ry', 'hx', 'hy', 'bb'].includes(key) ? 2 : 4);
  }
  return out;
}

// 동작 하나의 칸들을 차례로 맞춘다
async function fitClip(call, animation, clipDef, base) {
  const fitted = [];
  let previous = null;
  for (let i = 0; i < clipDef.frames.length; i++) {
    const result = await fitFrame(call, [animation.row, i], frameSpec(clipDef.frames[i]), base, previous, null);
    fitted.push(result);
    previous = result.pose;
  }
  return fitted;
}

// 결과를 한 줄로 요약하고 경고할 칸을 표시한다
function summarize(label, fitted) {
  const marks = fitted.map((f) => {
    const warn = f.metrics.overlap < WARN_OVERLAP || f.metrics.colorDiff > WARN_COLOR;
    return `${f.metrics.overlap.toFixed(1)}/${f.metrics.colorDiff.toFixed(1)}${warn ? '!' : ''}`;
  });
  console.log(`${label.padEnd(15)} ${marks.join('  ')}`);
}

// 파일을 저장한다. 실패하면 경로를 담아 던진다
function writeFile(file, data, encoding) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, encoding);
  } catch (e) {
    throw new Error(`파일 저장 실패 (${file}): ${e.message}`);
  }
}

// PNG data URL을 바이트로 바꾼다
function pngBytes(dataUrl, label) {
  const head = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(head)) throw new Error(`${label}: PNG 데이터가 아님`);
  return Buffer.from(dataUrl.slice(head.length), 'base64');
}

// 전체 과정: 시트 읽기 → 모양·색 지도 → 동작별 맞추기 → 저장
async function build() {
  const { BrowserWindow } = require('electron');
  const sourceId = argValue('source', DEFAULT_SOURCE);
  const petId = argValue('id', DEFAULT_ID);
  const petName = argValue('name', DEFAULT_NAME);
  const reportDir = argValue('report', '');
  const loaded = petSpec.loadPet(path.join(config.PROJECT_PETS_DIR, sourceId), 'project');
  if (!loaded.ok) throw new Error(`원본 펫을 읽을 수 없음 (${sourceId}): ${loaded.error}`);
  if (loaded.pet.version !== 2) throw new Error(`원본 펫에 바라보기 행이 없음 (${sourceId}). 11행 시트가 필요함`);
  let sheetBytes;
  try {
    sheetBytes = fs.readFileSync(loaded.pet.sheetPath);
  } catch (e) {
    throw new Error(`원본 시트를 읽을 수 없음 (${loaded.pet.sheetPath}): ${e.message}`);
  }

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const call = makeCaller(win);
  await win.loadFile(PAGE_FILE);
  const mime = loaded.pet.sheetFormat === 'png' ? 'image/png' : 'image/webp';
  await call(`loadSheet(${JSON.stringify(`data:${mime};base64,${sheetBytes.toString('base64')}`)})`);
  console.log(`그래픽 장치: ${await call('initGL()')}`);

  // 1) 몸 모양
  const shapeFit = await call(`fitShape(${IDLE_CELL[0]}, ${IDLE_CELL[1]})`);
  const sp = shapeFit.params;
  const shape = { a: round(sp.a, 3), bt: round(sp.bt, 3), bb: round(sp.bb, 3), nb: round(sp.nb, 3) };
  await call(`setShape(${JSON.stringify(shape)})`);
  console.log(`몸 모양: ${JSON.stringify(shape)} (어긋난 픽셀 ${shapeFit.loss}개)`);

  // 2) 색 지도
  const seed = Object.assign({}, PET3D.DEFAULT_POSE, { cx: sp.cx, cy: sp.cy });
  const matcap = await call(`buildMatcap(${IDLE_CELL[0]}, ${IDLE_CELL[1]}, ${JSON.stringify(seed)})`);
  console.log(`색 지도: ${matcap.size}x${matcap.size}, 원본에서 직접 얻은 비율 ${matcap.knownRatio}`);

  // 3) 기준 자세: 대기 첫 칸에서 눈 위치·크기·반짝임을 맞춘다
  const eyeSteps = { yaw: 1 * DEG, pitch: 1 * DEG, sep: 1 * DEG, rx: 0.4, ry: 0.4, m: 0.2, hx: 0.4, hy: 0.4, hr: 0.3 };
  const idleFit = await call(`fitPose(${IDLE_CELL[0]}, ${IDLE_CELL[1]}, ${JSON.stringify(seed)}, ${JSON.stringify(eyeSteps)}, ${ROUNDS})`);
  const base = idleFit.params;
  base.rx0 = base.rx;                    // 반짝임 위치의 기준이 되는 눈 크기 (화면에서도 같은 값을 쓴다)
  base.ry0 = base.ry;
  console.log(`기준 자세 손실 ${idleFit.loss.toFixed(2)}`);

  // 4) 동작별 칸 맞추기
  const animations = {};
  for (const a of petSpec.ANIMATIONS) animations[a.id] = a;
  const results = {};
  console.log('\n동작별 결과 (윤곽 겹침 % / 색 차이, !는 눈으로 확인할 칸)');
  for (const name of Object.keys(CLIPS)) {
    if (!animations[name]) throw new Error(`규격에 없는 동작: ${name}`);
    if (CLIPS[name].frames.length !== animations[name].frames) throw new Error(`동작 "${name}"의 칸 수가 규격(${animations[name].frames})과 다름`);
    results[name] = await fitClip(call, animations[name], CLIPS[name], base);
    summarize(name, results[name]);
  }

  // 5) 작업 동작: 첫 칸에서 노트북까지 맞추고, 나머지 칸은 노트북을 고정한 채 몸과 얼굴만 맞춘다
  const workAnimation = animations[WORK_CLIP.name];
  if (!workAnimation || WORK_CLIP.frames.length !== workAnimation.frames) throw new Error(`작업 동작의 칸 수가 규격과 다름`);
  const workSeed = Object.assign({}, base, WORK_START);
  {
    const spec = frameSpec(WORK_CLIP.frames[0]);
    const first = await fitFrame(call, [workAnimation.row, 0], spec, base, workSeed, { uniform: true, limitY: WORK_LIMIT_Y, extraFit: ['laptop'] });
    const laptop = {};
    for (const key of LAPTOP_KEYS) laptop[key] = first.pose[key];
    const fitted = [first];
    let previous = first.pose;
    for (let i = 1; i < WORK_CLIP.frames.length; i++) {
      const next = await fitFrame(call, [workAnimation.row, i], frameSpec(WORK_CLIP.frames[i]), base, Object.assign({}, previous, laptop, { laptop: 1 }), { uniform: true, limitY: WORK_LIMIT_Y });
      fitted.push(next);
      previous = next.pose;
    }
    results[WORK_CLIP.name] = fitted;
    summarize(WORK_CLIP.name, fitted);
    Object.assign(base, laptop);
  }

  // 6) 바라보기 16방향: 얼굴 방향과, 방향에 따라 달라지는 몸 바닥 모양
  const lookStart = Object.assign({}, base, { bb: shape.bb, nb: shape.nb });
  const lookFits = [];
  for (let i = 0; i < PET3D.LOOK_DIRECTIONS; i++) {
    const frame = petSpec.lookFrame(i);
    lookFits.push(await fitFrame(call, [frame.row, frame.frame], { kind: 'open' }, lookStart, null, { extraFit: ['bottom'] }));
  }
  summarize('look 0-7', lookFits.slice(0, 8));
  summarize('look 8-15', lookFits.slice(8));

  // 7) 자료 만들기
  const clips = {};
  for (const name of Object.keys(results)) {
    const def = name === WORK_CLIP.name ? WORK_CLIP : CLIPS[name];
    clips[name] = {
      loop: def.loop,
      frames: results[name].map((f, i) => ({ ms: animations[name].durations[i], pose: compactPose(Object.assign({}, f.pose, name === WORK_CLIP.name ? { laptop: 1 } : { laptop: 0 }), shape) })),
    };
  }
  const basePose = {};
  for (const key of Object.keys(PET3D.DEFAULT_POSE)) basePose[key] = round(Number.isFinite(base[key]) ? base[key] : PET3D.DEFAULT_POSE[key], 4);
  basePose.laptop = 0;
  const model = {
    version: MODEL_VERSION,
    source: sourceId,
    shape,
    base: basePose,
    clips,
    look: { directions: lookFits.map((f) => ({ yaw: round(f.pose.yaw, 4), pitch: round(f.pose.pitch, 4), bb: round(f.pose.bb, 2), nb: round(f.pose.nb, 3) })) },
  };
  PET3D.prepareModel(model);             // 저장하기 전에 화면이 읽는 것과 같은 검사를 거친다

  const outDir = path.join(config.PROJECT_PETS_DIR, petId);
  writeFile(path.join(outDir, MODEL_NAME), JSON.stringify(model, null, 1) + '\n', 'utf8');
  writeFile(path.join(outDir, MATCAP_NAME), pngBytes(await call('matcapDataUrl()'), '색 지도'));
  // 언어별 이름: 원본 펫의 이름 뒤에 " 3D"를 붙인다 (--name을 주면 그 이름만 쓴다)
  const sourceNames = loaded.pet.displayNames || {};
  const displayNames = argValue('name', '') ? {} : Object.fromEntries(Object.entries(sourceNames).map(([code, name]) => [code, `${name} 3D`]));
  const manifest = {
    id: petId,
    displayName: petName,
    ...(Object.keys(displayNames).length ? { displayNames } : {}),
    description: `${loaded.pet.displayName}의 그림에 맞춰 만든 3D 펫`,
    kind: petSpec.KIND_3D,
    modelPath: MODEL_NAME,
    matcapPath: MATCAP_NAME,
    fallback: sourceId,
  };
  writeFile(path.join(outDir, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const check = petSpec.loadPet(outDir, 'project');
  if (!check.ok) throw new Error(`저장한 3D 펫을 다시 읽지 못함 (${outDir}): ${check.error}`);
  console.log(`\n만듦: ${outDir}`);

  // 알림 영역 아이콘의 기본 그림: 대기 첫 칸의 얼굴
  const iconPose = Object.assign({}, base, results.idle[0].pose, { laptop: 0 });
  writeFile(config.TRAY_ICON_FILE, pngBytes(await call(`iconDataUrl(${JSON.stringify(iconPose)}, ${TRAY_ICON_PX})`), '아이콘 그림'));
  console.log(`만듦: ${config.TRAY_ICON_FILE}`);

  // 8) 확인 그림: 동작별로 원본 줄과 3D 줄을 나란히
  if (reportDir) {
    const groupFor = (name) => ({
      label: name,
      cells: results[name].map((_, i) => [animations[name].row, i]),
      poses: results[name].map((f) => f.pose),
    });
    for (let g = 0; g < REPORT_GROUPS.length; g++) {
      const file = path.join(reportDir, `clips-${g + 1}.png`);
      writeFile(file, pngBytes(await call(`rowsImage(${JSON.stringify(REPORT_GROUPS[g].map(groupFor))})`), '확인 그림'));
      console.log(`확인 그림: ${file}`);
    }
    const lookGroups = [0, 8].map((from) => ({
      label: `look ${from}-${from + 7}`,
      cells: lookFits.slice(from, from + 8).map((_, i) => { const f = petSpec.lookFrame(from + i); return [f.row, f.frame]; }),
      poses: lookFits.slice(from, from + 8).map((f) => f.pose),
    }));
    const lookFile = path.join(reportDir, 'clips-look.png');
    writeFile(lookFile, pngBytes(await call(`rowsImage(${JSON.stringify(lookGroups)})`), '확인 그림'));
    console.log(`확인 그림: ${lookFile}`);
  }
  win.destroy();
}

// ── 진입점 ──────────────────────────────────────────────────
if (!process.versions.electron) {
  relaunchWithElectron();
} else {
  const { app } = require('electron');
  try { app.setPath('userData', BUILD_DATA_DIR); } catch (e) { console.error(`데이터 폴더 지정 실패 (${BUILD_DATA_DIR}): ${e.message}`); }
  app.whenReady()
    .then(build)
    .then(() => app.exit(0))
    .catch((e) => {
      console.error(`3D 펫 만들기 실패: ${e.stack || e.message}`);
      app.exit(1);
    });
}
