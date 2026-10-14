// essayBridge.js — essay-platform(서술형·보고서 과제 플랫폼) 연결
//
// 학생이 essay-platform 작성 화면의 [실험 시작]을 누르면
//   https://motion-tracking.web.app/?assignment=<aid>&mode=free&return=<작성 화면 URL>
// 로 들어온다. 이 모듈은 그 과제 정보를 들고 있다가, 분석이 끝나면 결과(PNG + 측정 데이터 +
// 회귀값)를 essay-platform의 Firebase 프로젝트(equipotential-surface)에 직접 써 넣는다.
//   Firestore: experimentResults/{aid}__{essayUid}
//   Storage:   experimentResults/{essayUid}/{aid}/report.png
// 두 프로젝트의 uid가 서로 달라서 essay 프로젝트 계정으로 한 번 더 로그인해야 한다(같은 구글
// 계정을 login_hint로 넘겨 계정 선택만 하면 된다). 잠금(보고서 제출·과제 마감)은
// essay 쪽 firestore.rules가 강제하므로 여기서는 안내 문구만 맞춘다.

import { initializeApp }   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut }
                            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, increment }
                            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL }
                            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// essay-platform/src/firebase.js와 같은 공개 설정 (보안은 essay 쪽 rules가 담당)
const ESSAY_CONFIG = {
  apiKey:            'AIzaSyAKp3ooZkJPJE-SZrL6srfmmuWIFafAayY',
  authDomain:        'equipotential-surface.firebaseapp.com',
  projectId:         'equipotential-surface',
  storageBucket:     'equipotential-surface.firebasestorage.app',
  messagingSenderId: '60344638100',
  appId:             '1:60344638100:web:ee101c5cf8b67c86d2b281',
};

// return 파라미터로 받아줄 주소 — 이 목록 밖으로는 돌려보내지 않는다(오픈 리다이렉트 방지)
const ESSAY_ORIGINS = [
  'https://essay-hck.web.app',
  'https://essay-hck.firebaseapp.com',
  'http://localhost:5173',
];

const STORAGE_KEY = 'essayBridge';
const SUPPORTED_MODES = ['free'];

let essayApp = null, essayAuth = null, essayDb = null, essayStorage = null;
let bridge = null;      // { assignmentId, mode, returnUrl }
let assignment = null;  // essayAssignments 문서

// ─── 파라미터 ───────────────────────────────────────────────
function _safeReturnUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return ESSAY_ORIGINS.includes(u.origin) && u.pathname.startsWith('/write/') ? u.href : null;
  } catch { return null; }
}

/**
 * URL 파라미터에서 과제 연결 정보를 읽는다. 읽은 뒤에는 주소창에서 지우고 sessionStorage에
 * 보관한다 — SW 자동 새로고침이나 강제 새로고침(?_r=) 뒤에도 과제 연결이 유지되게.
 * @returns {{assignmentId, mode, returnUrl}|null}
 */
export function readBridgeParams() {
  const p = new URLSearchParams(location.search);
  const aid = p.get('assignment');
  if (aid && /^[A-Za-z0-9_-]{1,64}$/.test(aid)) {
    const mode = SUPPORTED_MODES.includes(p.get('mode')) ? p.get('mode') : 'free';
    bridge = { assignmentId: aid, mode, returnUrl: _safeReturnUrl(p.get('return')) };
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bridge)); } catch { /* 저장 불가 환경 */ }
    history.replaceState(null, '', location.pathname);
    return bridge;
  }
  try { bridge = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch { bridge = null; }
  return bridge;
}

export function getBridge() { return bridge; }

/** 과제 연결 해제 — 이 탭에서 다시 일반 모드로 쓰고 싶을 때 */
export function clearBridge() {
  bridge = null; assignment = null;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* 무시 */ }
}

// ─── essay 프로젝트 연결 ─────────────────────────────────────
function _ensureApp() {
  if (essayApp) return;
  essayApp     = initializeApp(ESSAY_CONFIG, 'essay');
  essayAuth    = getAuth(essayApp);
  essayDb      = getFirestore(essayApp);
  essayStorage = getStorage(essayApp);
}

/** essay 계정 로그인 상태 변화를 구독한다. 첫 콜백은 저장된 로그인 복원 직후 온다. */
export function onEssayAuthChanged(cb) {
  _ensureApp();
  return onAuthStateChanged(essayAuth, cb);
}

export function getEssayUser() { return essayAuth?.currentUser || null; }

/**
 * essay 프로젝트 계정으로 로그인. 팝업 차단을 피하려면 클릭 핸들러 안에서 await 없이 바로
 * 불러야 한다. Motion Tracker에 로그인한 계정을 login_hint로 넘긴다.
 */
export async function essayLogin(hintEmail) {
  _ensureApp();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters(hintEmail ? { login_hint: hintEmail, prompt: 'select_account' } : { prompt: 'select_account' });
  const res = await signInWithPopup(essayAuth, provider);
  return res.user;
}

export async function essayLogout() {
  if (essayAuth) await signOut(essayAuth);
}

/** 과제 문서(제목·마감·상태·작성 교사)를 읽는다. 로그인 후에만 읽을 수 있다. */
export async function loadAssignment() {
  if (!bridge || !getEssayUser()) return null;
  const snap = await getDoc(doc(essayDb, 'essayAssignments', bridge.assignmentId));
  assignment = snap.exists() ? { id: snap.id, ...snap.data() } : null;
  return assignment;
}

export function getAssignment() { return assignment; }

/**
 * essay 쪽 사용자 이름에서 학번·이름을 뽑는다. 개인 계정은 "10305-홍길동" 형식으로
 * 저장되어 있고(essay-platform services/users.js), 학교 계정은 구글 표시 이름 그대로다.
 * @returns {Promise<{studentId: string, name: string}>}
 */
export async function getStudentIdentity() {
  const user = getEssayUser();
  if (!user) return { studentId: '', name: '' };
  let raw = user.displayName || '';
  try {
    const snap = await getDoc(doc(essayDb, 'users', user.uid));
    if (snap.exists() && snap.data().name) raw = snap.data().name;
  } catch { /* 문서가 없거나 권한 없음 — 표시 이름 사용 */ }
  const m = raw.match(/^(\d{5})\s*[-_ ]?\s*(.+)$/);
  return m ? { studentId: m[1], name: m[2].trim() } : { studentId: '', name: raw.trim() };
}

/** 이 학생의 기존 실험 결과 (없으면 null) */
export async function getMyResult() {
  const user = getEssayUser();
  if (!bridge || !user) return null;
  const snap = await getDoc(doc(essayDb, 'experimentResults', `${bridge.assignmentId}__${user.uid}`));
  return snap.exists() ? snap.data() : null;
}

/**
 * 분석 결과 제출. Storage 업로드 → Firestore 문서 저장(덮어쓰기, 제출 횟수 누적).
 * @param {object} r { pngBlob, trackBlob, layout, studentName, motionLabel, unit, data, fit, calibration, origin, fps }
 */
export async function submitExperimentResult(r) {
  const user = getEssayUser();
  if (!bridge || !user) throw new Error('과제 계정에 로그인해야 합니다.');
  if (!assignment) await loadAssignment();
  if (!assignment) throw new Error('과제를 찾을 수 없습니다. 선생님께 링크를 확인해 달라고 하세요.');
  if (assignment.status === 'closed') throw new Error('마감된 과제라 실험 결과를 제출할 수 없습니다.');

  const aid  = bridge.assignmentId;
  const path = `experimentResults/${user.uid}/${aid}/report.png`;
  // 서버 규칙이 어차피 막지만, 업로드 전에 먼저 확인해 알기 쉬운 안내를 띄운다
  const sub = await getDoc(doc(essayDb, 'essaySubmissions', `${aid}__${user.uid}`)).catch(() => null);
  if (sub?.exists() && sub.data().status === 'submitted') {
    throw new Error('보고서를 이미 제출해서 실험 결과를 바꿀 수 없습니다.\n수정이 필요하면 선생님께 "재열기"를 요청하세요.');
  }
  try {

    const objRef = ref(essayStorage, path);
    await uploadBytes(objRef, r.pngBlob, { contentType: 'image/png' });
    const pngUrl = await getDownloadURL(objRef);

    // 웹 보고서용 궤적 이미지 (영상 위에 점을 찍은 부분)
    let trackPngPath = null, trackPngUrl = null;
    if (r.trackBlob) {
      trackPngPath = `experimentResults/${user.uid}/${aid}/track.png`;
      const trackRef = ref(essayStorage, trackPngPath);
      await uploadBytes(trackRef, r.trackBlob, { contentType: 'image/png' });
      trackPngUrl = await getDownloadURL(trackRef);
    }

    const docRef = doc(essayDb, 'experimentResults', `${aid}__${user.uid}`);
    const exists = (await getDoc(docRef)).exists();
    const c = r.calibration;
    await setDoc(docRef, {
      assignmentId: aid,
      studentUid:   user.uid,
      teacherUid:   assignment.createdBy,
      studentName:  r.studentName || user.displayName || '',
      studentEmail: (user.email || '').toLowerCase(),
      tool:         'motion-tracker',
      mode:         bridge.mode,
      motionLabel:  r.motionLabel || '',
      unit:         r.unit,
      pngPath:      path,
      pngUrl,
      // 결과 화면 배치 그대로의 웹 보고서 (essay ExperimentReport.jsx)
      reportVersion: r.layout ? 2 : 1,
      layout:        r.layout || null,
      trackPngPath,
      trackPngUrl,
      calib: c?.isCalibrated
        ? { scale: c.scale, realLengthCm: c.realLengthCm, pxDist: c.pixelDistance }
        : null,
      origin: r.origin || null,
      fps:    r.fps || null,
      dt:     r.fps ? 1 / r.fps : null,
      points: r.data.map(p => ({
        t: +(p.relTSec?.toFixed(4) ?? 0),
        x: +(p.relXCm?.toFixed(3)  ?? 0),
        y: +(p.relYCm?.toFixed(3)  ?? 0),
      })),
      fit: r.fit || null,
      attemptCount: increment(1),
      updatedAt:    serverTimestamp(),
      ...(exists ? {} : { createdAt: serverTimestamp() }),
    }, { merge: true });
  } catch (e) {
    if (e?.code === 'permission-denied' || e?.code === 'storage/unauthorized') {
      throw new Error('보고서를 이미 제출했거나 과제가 마감되어 실험 결과를 바꿀 수 없습니다.\n수정이 필요하면 선생님께 "재열기"를 요청하세요.');
    }
    throw e;
  }
}

// ─── 화면 연결 ───────────────────────────────────────────────
// app.js가 Motion Tracker 로그인 직후 한 번 부른다. 배너(과제 제목·마감·계정)와
// 자유 물체 운동 결과 화면의 "과제에 결과 제출" 영역을 보여주고 상태를 맞춘다.

const $ = id => document.getElementById(id);
let _uiStarted = false;

function _fmtDue(ts) {
  const d = ts?.toDate?.();
  return d ? d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) : null;
}

function _goReturn() {
  if (bridge?.returnUrl) location.href = bridge.returnUrl;
}

/** 결과 화면 안내 문구 — freeMotion.js의 제출 처리도 같은 요소를 쓴다. */
export function setBridgeStatus(text, color = 'var(--text-dim)') {
  const el = $('fm-bridge-status');
  if (el) { el.textContent = text; el.style.color = color; }
}

async function _renderAssignment(motionEmail) {
  const user = getEssayUser();
  $('ebb-btn-login').classList.toggle('hidden', Boolean(user));
  if (!user) {
    $('ebb-title').textContent = '과제 계정 연결이 필요합니다';
    $('ebb-meta').textContent = '결과를 과제에 제출하려면 [과제 계정 연결]을 눌러 같은 구글 계정을 선택하세요.';
    return;
  }
  let a = null;
  try { a = await loadAssignment(); } catch (e) { console.warn('과제 조회 실패:', e); }
  if (!a) {
    $('ebb-title').textContent = '과제를 찾을 수 없습니다';
    $('ebb-meta').textContent = '선생님께 받은 링크로 다시 들어와 주세요.';
    return;
  }
  $('ebb-title').textContent = a.title || '실험 과제';
  const parts = [];
  const due = _fmtDue(a.dueAt);
  if (due) parts.push(`마감 ${due}`);
  if (a.status === 'closed') parts.push('<span class="ebb-warn">마감됨</span>');
  // Motion Tracker와 다른 계정으로 과제에 연결했으면 눈에 띄게 알린다(제출물이 엉뚱한 계정에 붙음)
  const sameAccount = !motionEmail || (user.email || '').toLowerCase() === motionEmail.toLowerCase();
  parts.push(sameAccount ? user.email : `<span class="ebb-warn">과제 계정 ${user.email} (Motion Tracker와 다름)</span>`);
  $('ebb-meta').innerHTML = parts.join(' · ');

  // 학번·이름 입력칸이 비어 있으면 과제 계정 정보로 채운다
  const id = await getStudentIdentity();
  if (!$('fm-student-name').value && id.name)       $('fm-student-name').value  = id.name;
  if (!$('fm-student-class').value && id.studentId) $('fm-student-class').value = id.studentId;

  const prev = await getMyResult().catch(() => null);
  if (prev?.updatedAt?.toDate) {
    setBridgeStatus(`이전에 제출한 결과가 있습니다 (${prev.updatedAt.toDate().toLocaleString('ko-KR')}). 다시 제출하면 최신 결과로 바뀝니다.`);
    $('fm-btn-bridge-return').classList.toggle('hidden', !bridge.returnUrl);
  }
}

export function startBridgeUI(motionUser) {
  if (!bridge) return;
  $('essay-bridge-banner').classList.remove('hidden');
  $('fm-bridge-section').classList.remove('hidden');
  $('ebb-btn-return').classList.toggle('hidden', !bridge.returnUrl);
  if (_uiStarted) return;
  _uiStarted = true;

  $('ebb-btn-return').addEventListener('click', _goReturn);
  $('fm-btn-bridge-return').addEventListener('click', _goReturn);
  $('ebb-btn-login').addEventListener('click', () => {
    essayLogin(motionUser.email).catch(e => {
      if (e?.code !== 'auth/popup-closed-by-user') alert('과제 계정 연결 실패: ' + (e.message || e.code));
    });
  });
  onEssayAuthChanged(() => _renderAssignment(motionUser.email));
}
