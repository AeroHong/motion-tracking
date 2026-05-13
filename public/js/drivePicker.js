// drivePicker.js — Google Drive에서 영상 파일 선택

import { auth } from './auth.js';
import { signInWithPopup, reauthenticateWithPopup, GoogleAuthProvider }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const DEVELOPER_KEY = firebaseConfig.apiKey;
const DRIVE_SCOPE   = 'https://www.googleapis.com/auth/drive.readonly';

let _token       = null;
let _pickerReady = false;

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
  if (_token) return _token;
  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  provider.setCustomParameters({ prompt: 'consent' });

  // 이미 로그인된 사용자는 reauthenticateWithPopup으로 Drive 스코프 포함 토큰 취득
  const user   = auth.currentUser;
  const result = user
    ? await reauthenticateWithPopup(user, provider)
    : await signInWithPopup(auth, provider);

  const cred = GoogleAuthProvider.credentialFromResult(result);
  if (!cred?.accessToken) throw new Error('Drive 액세스 토큰을 가져올 수 없습니다.');
  _token = cred.accessToken;
  return _token;
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
  if (!res.ok) throw new Error(`파일 다운로드 실패 (${res.status}). 드라이브 공유 설정을 확인하세요.`);
  return res.blob();
}
