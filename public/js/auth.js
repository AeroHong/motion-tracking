// auth.js — Google OAuth 로그인/로그아웃

import { initializeApp }         from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, signOut }
                                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }           from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage }             from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const db       = getFirestore(app);
const storage  = getStorage(app);
const provider = new GoogleAuthProvider();

export { app, auth, db, storage };

// 실패 원인을 한국어로 — 다음에 같은 문제가 생기면 코드로 바로 원인을 알 수 있게
const LOGIN_ERRORS = {
  'auth/popup-blocked':             '로그인 창이 차단되었습니다. 페이지 이동 방식으로 다시 시도합니다.',
  'auth/network-request-failed':    '네트워크 연결에 실패했습니다. 와이파이나 학교망 상태를 확인해 주세요.',
  'auth/unauthorized-domain':       '이 주소는 로그인이 허용되지 않았습니다. motion-tracking.web.app 으로 접속해 주세요.',
  'auth/web-storage-unsupported':   '이 브라우저는 로그인 정보를 저장할 수 없습니다. Chrome으로 열어 주세요.',
  'auth/operation-not-supported-in-this-environment': '이 브라우저에서는 구글 로그인을 쓸 수 없습니다. Chrome으로 열어 주세요.',
  'auth/internal-error':            '로그인 처리 중 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.',
};

function _alertLoginError(e) {
  const msg = LOGIN_ERRORS[e?.code] || '로그인에 실패했습니다. 다시 시도해 주세요.';
  alert(`${msg}\n\n(오류 코드: ${e?.code || e?.message || '알 수 없음'} · ${location.hostname})`);
}

export function initAuth(onLogin, onLogout) {
  // 페이지 이동 방식으로 로그인하고 돌아온 경우의 오류 표시
  getRedirectResult(auth).catch(e => { console.error('로그인 실패(리디렉션):', e); _alertLoginError(e); });
  onAuthStateChanged(auth, user => {
    if (user) {
      onLogin(user);
    } else {
      onLogout();
    }
  });
}

export async function login() {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.error('로그인 실패:', e);
    // 사용자가 창을 닫은 것은 오류가 아님
    if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return;
    // 팝업이 막히거나 이 환경에서 팝업을 못 쓰면 페이지 이동 방식으로 재시도
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      try { await signInWithRedirect(auth, provider); return; }
      catch (e2) { console.error('로그인 실패(리디렉션):', e2); _alertLoginError(e2); return; }
    }
    _alertLoginError(e);
  }
}

export async function logout() {
  await signOut(auth);
}
