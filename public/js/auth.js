// auth.js — Google OAuth 로그인/로그아웃 + 도메인 검증

import { initializeApp }         from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut }
                                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, getDoc }
                                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const ADMIN_EMAIL = 'hckgood@gmail.com';

const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const db       = getFirestore(app);
const provider = new GoogleAuthProvider();

export { app, auth, db, ADMIN_EMAIL };

export function isAdmin(user) {
  return user?.email?.toLowerCase().trim() === ADMIN_EMAIL;
}

// 이메일에서 도메인 추출
export function getDomain(email) {
  return email?.split('@')[1] ?? '';
}

// Firestore에서 허용 도메인 목록 조회
export async function getAllowedDomains() {
  try {
    const snap = await getDoc(doc(db, 'config', 'allowedDomains'));
    if (snap.exists()) return snap.data().domains ?? [];
  } catch (e) {
    console.error('도메인 목록 조회 실패:', e);
  }
  return [];
}

// 로그인 후 도메인 검증 (관리자는 항상 통과)
export async function checkDomainAccess(user) {
  if (isAdmin(user)) return { allowed: true };
  const domain = getDomain(user.email);
  const allowed = await getAllowedDomains();
  if (allowed.includes(domain)) return { allowed: true };
  return { allowed: false, domain };
}

export function initAuth(onLogin, onLogout) {
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
    alert('로그인에 실패했습니다. 다시 시도해주세요.');
  }
}

export async function logout() {
  await signOut(auth);
}
