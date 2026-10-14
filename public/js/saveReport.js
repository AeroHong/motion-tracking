// saveReport.js — 보고서 PNG + 데이터를 Firebase Storage/Firestore에 저장

import { app, auth, db } from './auth.js';
import { collection, addDoc, getDocs, query, orderBy, limit, Timestamp, doc, deleteDoc }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const storage = getStorage(app);

// ── 클래식 모드 (자유낙하 + 수평투사) ───────────────────

export async function saveReportToCloud({ studentName, className, ffData, projData, ffCalibration, projCalibration, pngBlob }) {
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');

  const reportId   = Date.now().toString();
  const storagePath = `reports/${user.uid}/${reportId}.png`;

  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, pngBlob, { contentType: 'image/png' });
  const reportUrl = await getDownloadURL(storageRef);

  const entriesCol = collection(db, 'reports', user.uid, 'entries');
  await addDoc(entriesCol, {
    studentName, className,
    unit: ffCalibration.unit,
    createdAt: Timestamp.now(),
    storagePath,
    ffPoints: ffData.map(p => ({
      t: +(p.relTSec?.toFixed(4) ?? 0),
      y: +(p.relYCm?.toFixed(3)  ?? 0),
    })),
    projPoints: projData.map(p => ({
      t: +(p.relTSec?.toFixed(4) ?? 0),
      x: +(p.relXCm?.toFixed(3)  ?? 0),
      y: +(p.relYCm?.toFixed(3)  ?? 0),
    })),
    reportUrl,
  });

  return reportUrl;
}

export async function loadAllReportsMeta({ maxCount = 30 } = {}) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const entriesCol = collection(db, 'reports', user.uid, 'entries');
    const q = query(entriesCol, orderBy('createdAt', 'desc'), limit(maxCount));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('보고서 목록 조회 실패:', e);
    return [];
  }
}

export async function deleteClassicReport({ docId, storagePath }) {
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');
  await deleteDoc(doc(db, 'reports', user.uid, 'entries', docId));
  if (storagePath) {
    try { await deleteObject(ref(storage, storagePath)); } catch (e) { console.warn('Storage 삭제 실패:', e); }
  }
}

// ── 자유 물체 운동 모드 ──────────────────────────────────

export async function saveFreeMotionReportToCloud({
  studentName, className, motionLabel, data, calibration, pngBlob,
  fit = null, origin = null, fps = null,
}) {
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');

  const reportId    = Date.now().toString();
  const storagePath = `reports/${user.uid}/free_${reportId}.png`;

  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, pngBlob, { contentType: 'image/png' });
  const reportUrl = await getDownloadURL(storageRef);

  const entriesCol = collection(db, 'reports', user.uid, 'free_entries');
  await addDoc(entriesCol, {
    studentName, className, motionLabel,
    unit: calibration.unit,
    createdAt: Timestamp.now(),
    storagePath,
    calib: calibration.isCalibrated
      ? { scale: calibration.scale, realLengthCm: calibration.realLengthCm, pxDist: calibration.pixelDistance }
      : null,
    origin, fps, fit,
    points: data.map(p => ({
      t: +(p.relTSec?.toFixed(4) ?? 0),
      x: +(p.relXCm?.toFixed(3)  ?? 0),
      y: +(p.relYCm?.toFixed(3)  ?? 0),
    })),
    reportUrl,
  });

  return reportUrl;
}

export async function loadAllFreeMotionReports({ maxCount = 30 } = {}) {
  const user = auth.currentUser;
  if (!user) return [];
  try {
    const entriesCol = collection(db, 'reports', user.uid, 'free_entries');
    const q = query(entriesCol, orderBy('createdAt', 'desc'), limit(maxCount));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('자유 물체 운동 보고서 목록 조회 실패:', e);
    return [];
  }
}

export async function deleteFreeMotionReport({ docId, storagePath }) {
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');
  await deleteDoc(doc(db, 'reports', user.uid, 'free_entries', docId));
  if (storagePath) {
    try { await deleteObject(ref(storage, storagePath)); } catch (e) { console.warn('Storage 삭제 실패:', e); }
  }
}
