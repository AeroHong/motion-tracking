// saveReport.js — 보고서 PNG + 데이터를 Firebase Storage/Firestore에 저장

import { app, auth, db } from './auth.js';
import { doc, setDoc, getDoc, Timestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const storage = getStorage(app);

// 보고서 PNG + 메타데이터를 클라우드에 저장, 다운로드 URL 반환
export async function saveReportToCloud({ studentName, className, ffData, projData, calibration, pngBlob }) {
  const user = auth.currentUser;
  if (!user) throw new Error('로그인이 필요합니다.');

  // 1. PNG → Firebase Storage
  const storageRef = ref(storage, `reports/${user.uid}/report.png`);
  await uploadBytes(storageRef, pngBlob, { contentType: 'image/png' });
  const reportUrl = await getDownloadURL(storageRef);

  // 2. 메타데이터 → Firestore (그래프 재생성용 요약 데이터 포함)
  await setDoc(doc(db, 'reports', user.uid), {
    studentName,
    className,
    unit: calibration.unit,
    updatedAt: Timestamp.now(),
    ffPoints:   ffData.map(p => ({
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

// 저장된 보고서 메타데이터 조회 (없으면 null)
export async function loadSavedReportMeta() {
  const user = auth.currentUser;
  if (!user) return null;
  try {
    const snap = await getDoc(doc(db, 'reports', user.uid));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    console.error('보고서 조회 실패:', e);
    return null;
  }
}
