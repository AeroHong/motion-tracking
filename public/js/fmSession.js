// fmSession.js — 자유 물체 운동 작업 자동 저장 (영상은 저장하지 않음)
//   Firestore: sessions/{uid}/freeMotion/{key}
//     key = 'default' 또는 과제 링크로 들어온 경우 'a_<assignmentId>' (과제별로 따로 보관)
//   영상은 출처만 기록한다 — 드라이브: 파일 ID(다시 내려받기), 로컬: 파일 이름·크기(같은 파일 재선택 확인)

import { auth, db } from './auth.js';
import { doc, getDoc, setDoc, deleteDoc, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getBridge } from './essayBridge.js';

function _ref() {
  const user = auth.currentUser;
  if (!user) return null;
  const aid = getBridge()?.assignmentId;
  const key = aid ? 'a_' + String(aid).replace(/[^A-Za-z0-9_-]/g, '_') : 'default';
  return doc(db, 'sessions', user.uid, 'freeMotion', key);
}

export async function loadFreeSession() {
  const ref = _ref();
  if (!ref) return null;
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

export async function saveFreeSession(data) {
  const ref = _ref();
  if (!ref) return;
  await setDoc(ref, { ...data, updatedAt: serverTimestamp() });
}

export async function clearFreeSession() {
  const ref = _ref();
  if (ref) await deleteDoc(ref);
}
