// 클로드 펫 설정 상수 모음. 모든 모듈이 이 파일만 보고 경로와 주기를 정한다.
'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const APP_DIR = __dirname;
// PC마다 따로 두는 데이터 폴더 (OneDrive로 동기화하지 않는다)
const DATA_DIR = path.join(HOME, '.claude-pet');
// Claude Code 설정 폴더 (환경변수로 옮긴 경우를 따른다)
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
// 코덱스 설정 폴더 (환경변수로 옮긴 경우를 따른다)
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

module.exports = {
  // ── 기본 정보 ─────────────────────────────────────────────
  // 화면에 보이는 이름과 문구는 i18n.js에 있다 (한국어·영어)
  APP_ID: 'claude-pet',                // 파일과 배포 묶음 이름에 쓰는 이름
  LANGUAGES: ['ko', 'en'],             // 고를 수 있는 화면 언어 (첫 번째가 문구가 빠졌을 때 쓰는 언어)
  ELECTRON_VERSION: '45.5.0',
  MIN_NODE_MAJOR: 18,

  // ── 경로 ─────────────────────────────────────────────────
  APP_DIR,
  DATA_DIR,
  RUNTIME_DIR: path.join(DATA_DIR, 'runtime'),
  ELECTRON_DATA_DIR: path.join(DATA_DIR, 'electron-data'),
  STATE_FILE: path.join(DATA_DIR, 'state.json'),
  LOG_FILE: path.join(DATA_DIR, 'pet.log'),
  HOOK_EVENTS_FILE: path.join(DATA_DIR, 'events.jsonl'),
  HOOK_SCRIPT_SOURCE: path.join(APP_DIR, 'hook-event.js'),
  HOOK_SCRIPT_INSTALLED: path.join(DATA_DIR, 'hook-event.js'),
  CLAUDE_DIR,
  CLAUDE_SETTINGS_FILE: path.join(CLAUDE_DIR, 'settings.json'),
  TRANSCRIPTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  TRAY_ICON_FILE: path.join(APP_DIR, 'assets', 'tray.png'),   // 알림 영역 아이콘의 기본 그림 (tools/pet3d/build.js가 만든다)
  PROJECT_PETS_DIR: path.join(APP_DIR, 'pets'),
  PETS_USER_DIR: path.join(DATA_DIR, 'pets'),   // 압축 파일로 가져온 펫 (PC마다)
  CODEX_PETS_DIR: path.join(CODEX_HOME, 'pets'),
  DEFAULT_PET_ID: 'orange-pickle-3d',  // 처음 실행할 때와 저장된 펫을 못 찾을 때 쓰는 펫 (모찌 3D)
  FALLBACK_PET_ID: 'orange-pickle',    // 3D를 못 그릴 때 대신 뜨는 펫 (모찌 이미지판, 목록에는 숨김)
  INCLUDE_CODEX_PETS: false,           // true면 코덱스 펫 폴더(CODEX_PETS_DIR)의 펫도 목록에 넣는다 (2026-11-26 사용자 요청으로 끔)

  // ── 펫 가져오기 (코덱스 펫 압축 파일) ─────────────────────
  IMPORT_MAX_ZIP_BYTES: 40 * 1024 * 1024,      // 받아들이는 압축 파일 크기 (시험 펫 ribbon-momonga는 2.3MB)
  IMPORT_MAX_ENTRY_BYTES: 30 * 1024 * 1024,    // 꺼내는 파일 하나의 풀린 크기 한도 (압축 폭탄 방지)
  IMPORT_MAX_ENTRIES: 200,                     // 압축 파일 안 항목 수 한도
  IMPORT_ID_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,   // 폴더 이름으로 쓸 수 있는 펫 id

  // ── 처음 실행과 훅 ───────────────────────────────────────
  HOOK_ARG: '--claude-pet-hook',       // 훅이 실행 파일을 부를 때 붙이는 인자 (Node.js가 없는 PC용). 우리 훅을 알아보는 표식도 된다
  WELCOME_WINDOW_WIDTH: 460,
  WELCOME_WINDOW_HEIGHT: 470,

  // ── 감시 주기와 한도 ─────────────────────────────────────
  POLL_MS: 1000,                       // 추적 중인 기록 파일을 확인하는 주기
  FULL_SCAN_MS: 5000,                  // 새 기록 파일을 찾는 전체 탐색 주기
  ACTIVE_FILE_WINDOW_MS: 6 * 60 * 60 * 1000,   // 이 시간 안에 바뀐 기록만 추적
  STARTUP_REPLAY_WINDOW_MS: 15 * 60 * 1000,    // 시작 시 이 시간 안에 바뀐 기록은 끝부분을 되짚어 현재 상태를 복원
  STARTUP_TAIL_BYTES: 512 * 1024,      // 시작 시 되짚을 끝부분 크기
  MAX_READ_BYTES_PER_POLL: 8 * 1024 * 1024,    // 한 번에 읽는 최대 크기
  MAX_LINE_BYTES: 16 * 1024 * 1024,    // 이보다 긴 한 줄은 건너뜀
  LOG_MAX_BYTES: 1024 * 1024,          // 로그 파일 최대 크기
  HOOK_EVENTS_MAX_BYTES: 2 * 1024 * 1024,      // 훅 이벤트 파일 최대 크기

  // ── 상태 판정 시간 ───────────────────────────────────────
  END_GRACE_MS: 12 * 1000,             // 본문 없는 종료 표식 뒤 완료로 확정하기까지 기다리는 시간
  WORKING_TIMEOUT_MS: 30 * 60 * 1000,  // 작업 중인데 이 시간 동안 기록이 없으면 대기로 되돌림
  DONE_KEEP_MS: 30 * 60 * 1000,        // 완료/오류 표시를 유지하는 최대 시간
  SLOW_TOOL_MS: 30 * 1000,             // 도구 결과가 이보다 늦으면 "오래 걸리는 중" 표시
  SESSION_FORGET_MS: 6 * 60 * 60 * 1000, // 대기 상태로 이 시간이 지난 세션은 목록에서 지움
  LIST_MAX: 6,                         // 세션 목록에 보여 줄 최대 개수

  // ── 화면 ─────────────────────────────────────────────────
  SCALE_MIN: 0.25,                     // 펫 크기 배율 범위 (1.0 = 한 칸 192x208 그대로)
  SCALE_MAX: 1.2,
  SCALE_STEP: 0.05,
  DEFAULT_SCALE: 0.7,
  LEGACY_SCALES: { small: 0.5, medium: 0.7, large: 1.0 },   // 예전 설정(작게/보통/크게)을 배율로 옮길 때 쓴다
  WINDOW_WIDTH: 300,                   // 창 너비 (말풍선 포함). 창은 항상 화면 안에 두고 펫이 그 안에서 좌우로 움직인다
  PANEL_SPACE: 330,                    // 펫 위(또는 아래)의 말풍선·목록 공간
  MIN_PANEL_SPACE: 150,                // 펫 위 공간이 이보다 좁으면 말풍선을 펫 아래에 둔다
  CURSOR_POLL_MS: 100,                 // 커서 위치 확인 주기 (바라보기용)
  LOOK_ACTIVE_MS: 3000,                // 커서가 멈춘 뒤 바라보기를 유지하는 시간
  DRAG_POLL_MS: 16,                    // 드래그 중 창 이동 주기
  DISABLE_GPU: false,                  // true면 GPU 가속을 끈다. 3D 펫은 목록에서 빠지고 이미지 펫만 쓴다 (투명 창이 이상하게 보이는 PC용)
  TRAY_ICON_SIZES: [16, 32],           // 알림 영역 아이콘 크기 (화면 배율 100%용, 200%용)
  TRAY_ICON_MAX_BYTES: 256 * 1024,     // 화면이 보내는 아이콘 그림의 최대 크기
  SEEN_IN_APP: true,                   // Claude 앱에서 세션을 직접 열어 보면 펫의 완료·오류 표시도 확인한 것으로 처리한다
  SETTINGS_WINDOW_WIDTH: 780,          // 펫 꾸미기 창의 안쪽 크기 (settings.html의 배치가 이 크기에 맞춰져 있다)
  SETTINGS_WINDOW_HEIGHT: 600,

  // ── 3D 펫 ────────────────────────────────────────────────
  CURSOR_POLL_3D_MS: 33,               // 3D 펫일 때 커서 위치 확인 주기 (눈이 끊김 없이 따라가게 자주 본다)
  FPS_3D_IDLE: 30,                     // 3D 펫이 평소에 초당 그리는 횟수
  FPS_3D_BUSY: 60,                     // 눈이 커서를 따라가거나 끌거나 뛸 때 초당 그리는 횟수
  COLOR_PRESETS: [                     // 펫 꾸미기 창에 미리 준비해 두는 색 (이름은 i18n.js의 color.<id>)
    { id: 'yellow', hex: '#f5c542' },
    { id: 'lime', hex: '#8ccf5a' },
    { id: 'mint', hex: '#4fc9b4' },
    { id: 'sky', hex: '#6ab7f5' },
    { id: 'blue', hex: '#4a8fe7' },
    { id: 'purple', hex: '#9a70e0' },
    { id: 'pink', hex: '#f48fb1' },
    { id: 'red', hex: '#e5484d' },
    { id: 'white', hex: '#f1efe9' },
    { id: 'charcoal', hex: '#45464d' },
  ],
};
