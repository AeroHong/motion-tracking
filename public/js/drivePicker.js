// drivePicker.js — Google Drive에서 영상 파일 선택

import { auth } from './auth.js';
import { signInWithPopup, reauthenticateWithPopup, GoogleAuthProvider }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const DEVELOPER_KEY = firebaseConfig.apiKey;
const DRIVE_SCOPE   = 'https://www.googleapis.com/auth/drive.readonly';

let _token       = null;
let _tokenAt     = 0;        // 토큰 발급 시각 (ms) — 50분 후 자동 갱신
let _pickerReady = false;

function _clearToken() { _token = null; _tokenAt = 0; }

function loadPickerApi() {
  return new Promise((resolve, reject) => {
    if (_pickerReady) { resolve(); return; }
    if (typeof gapi === 'undefined') {
      reject(new Error('Google API 스크립트가 로드되지 않았습니다.'));
      return;
    }
    gapi.load('picker', {
      callback: () => { _pickerReady = true; resolve(); },
      onerror:  () => reject(new Error('Picker API 로드 실패')),
    });
  });
}

async function getAccessToken() {
  // 토큰이 있고 50분 이내면 재사용
  if (_token && Date.now() - _tokenAt < 50 * 60 * 1000) return _token;
  _clearToken();

  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  // prompt:'consent' 제거 — 매번 재인증 요구하면 팝업 차단 가능성 증가
  provider.setCustomParameters({ prompt: 'select_account' });

  const user   = auth.currentUser;
  const result = user
    ? await reauthenticateWithPopup(user, provider)
    : await signInWithPopup(auth, provider);

  const cred = GoogleAuthProvider.credentialFromResult(result);
  if (!cred?.accessToken) throw new Error('Drive 액세스 토큰을 가져올 수 없습니다.');
  _token   = cred.accessToken;
  _tokenAt = Date.now();
  return _token;
}

// Google Drive에서 이미지 선택 → { blob, name } 반환
export async function pickImageFromDrive() {
  let accessToken;
  try {
    [accessToken] = await Promise.all([getAccessToken(), loadPickerApi()]);
  } catch (e) {
    throw new Error('Google 인증 실패: ' + e.message);
  }

  return new Promise((resolve, reject) => {
    // 3분 타임아웃 — 피커가 콜백 없이 닫히는 경우 버튼이 무한 pending 되지 않도록
    const timer = setTimeout(() => reject(new Error('취소됨')), 3 * 60 * 1000);

    const view = new google.picker.DocsView(google.picker.ViewId.DOCS_IMAGES);
    view.setIncludeFolders(true);

    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(DEVELOPER_KEY)
      .addView(view)
      .setCallback(async data => {
        if (data.action === google.picker.Action.CANCEL) {
          clearTimeout(timer);
          reject(new Error('취소됨'));
          return;
        }
        if (data.action !== google.picker.Action.PICKED) return;

        clearTimeout(timer);
        const { id, name } = data.docs[0];
        try {
          const blob = await _download(id, accessToken);
          resolve({ blob, name });
        } catch (e) {
          reject(e);
        }
      })
      .build();

    picker.setVisible(true);
  });
}

// Google Drive에서 영상 선택 → { blob, name } 반환
export async function pickVideoFromDrive() {
  const [accessToken] = await Promise.all([getAccessToken(), loadPickerApi()]);

  return new Promise((resolve, reject) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS_VIDEOS);
    view.setIncludeFolders(true);

    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(DEVELOPER_KEY)
      .addView(view)
      .setCallback(async data => {
        if (data.action === google.picker.Action.CANCEL) {
          reject(new Error('취소됨'));
          return;
        }
        if (data.action !== google.picker.Action.PICKED) return;

        const { id, name } = data.docs[0];
        try {
          const blob = await _download(id, accessToken);
          resolve({ blob, name });
        } catch (e) {
          reject(e);
        }
      })
      .build();

    picker.setVisible(true);
  });
}

async function _download(fileId, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (res.status === 401) {
    _clearToken();  // 만료된 토큰 제거 → 다음 시도 시 재인증
    throw new Error('인증이 만료됐습니다. 다시 시도해 주세요.');
  }
  if (!res.ok) throw new Error(`파일 다운로드 실패 (${res.status}). 드라이브 공유 설정을 확인하세요.`);
  return res.blob();
}
