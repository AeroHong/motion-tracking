const firebaseConfig = {
  apiKey: "AIzaSyCbDPpjl8QbjkopviSJXwBHxTD0PcIx5vY",
  authDomain: "motion-tracking-68d0e.firebaseapp.com",
  projectId: "motion-tracking-68d0e",
  storageBucket: "motion-tracking-68d0e.firebasestorage.app",
  messagingSenderId: "507401155935",
  appId: "1:507401155935:web:7f0e8b30c3aaaf8e2af2ea"
};

// 학교망이 *.firebaseapp.com을 막는 경우가 있어, OAuth 리디렉션 URI가 등록된 주소에서는
// 로그인 창도 같은 주소(/__/auth/handler)를 쓴다. 다른 주소를 추가하려면 Google Cloud 콘솔
// 'Web client (auto created by Google Service)'에 https://<주소>/__/auth/handler 를 먼저 등록할 것.
if (["motion-tracking.web.app"].includes(location.hostname)) {
  firebaseConfig.authDomain = location.hostname;
}
