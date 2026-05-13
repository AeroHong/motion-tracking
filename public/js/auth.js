// auth.js — Google OAuth 로그인/로그아웃

import { initializeApp }         from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut }
                                  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }           from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const app      = initializeApp(firebaseConfig);
const auth     = getAuth(app);
const db       = getFirestore(app);
const provider = new GoogleAuthProvider();

export { app, auth, db };

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
