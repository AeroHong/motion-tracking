# 운동 분석 웹앱 — CLAUDE.md
> 고1 통합과학 자유낙하 vs 수평투사 비교 실험 분석 도구

---

## 프로젝트 개요

**목적**: 학생이 각자 촬영한 자유낙하 / 수평투사 영상을 브라우저에서 분석하고,
보고서 이미지를 다운로드하여 구글 문서에 첨부 → 클래스룸 제출

**사용자**: 고1 학생 120명 (4개 반), 안드로이드 태블릿 동일 기종
**교사**: 선유고 과학 교사 (홍선생) — 관리자 기능 불필요

---

## 기술 스택

| 역할 | 기술 | 선택 이유 |
|------|------|-----------|
| 호스팅 | Firebase Hosting | 무료, HTTPS 기본, Google 계열 |
| 인증 | Firebase Auth + Google OAuth | Workspace 계정 연동 |
| DB | Firebase Firestore | 세션 저장 (선택적) |
| 프론트엔드 | Vanilla JS + Canvas API | 프레임워크 없이 태블릿 최적화 |
| 그래프 | Chart.js (CDN) | 경량, 설치 불필요 |
| 빌드 | 없음 (순수 HTML/CSS/JS) | 복잡도 최소화 |

**Firebase 플랜**: Spark (무료) — 120명 수업 용도로 충분
- Auth: 월 50,000 MAU 무료 (실사용 120명)
- Firestore: 일 50,000 reads / 20,000 writes 무료
- Hosting: 월 10GB 전송 무료
- Storage: 사용 안 함 (이미지는 클라이언트 Canvas에서 직접 다운로드)

---

## 폴더 구조

```
project-root/
├── CLAUDE.md
├── firebase.json
├── .firebaserc
├── public/
│   ├── index.html          # 메인 앱 (SPA)
│   ├── style.css
│   ├── js/
│   │   ├── auth.js         # Google 로그인 처리
│   │   ├── video.js        # 영상 로드 & 프레임 추출
│   │   ├── tracker.js      # 클릭 트래킹 & 좌표 저장
│   │   ├── calibration.js  # px → 실제거리 보정
│   │   ├── chart.js        # Chart.js 그래프 렌더링
│   │   ├── report.js       # 보고서 이미지 생성 & 다운로드
│   │   └── app.js          # 메인 컨트롤러
│   └── firebase-config.js  # Firebase 설정 (gitignore 금지 — 공개키만 포함)
└── .gitignore
```

---

## 핵심 기능 명세

### 1. 인증 (auth.js)
- Google OAuth로 로그인
- `firebase.auth().currentUser` 확인 후 앱 진입
- 로그아웃 버튼 제공
- **도메인 제한 없음** (개인 구글 계정 포함 허용 — 수업 특성상)

### 2. 영상 로드 & 프레임 추출 (video.js)
```
[영상 업로드] → <video> 태그로 로드 → video.currentTime 조작
→ canvas.drawImage(video, ...) → 프레임 이미지 추출
```
- 지원 형식: mp4, mov
- 프레임 탐색: 이전/다음 버튼 + 슬라이더
- **자유낙하 영상** / **수평투사 영상** 각각 별도 업로드
- 영상은 서버에 업로드하지 않음 (로컬 File API만 사용) → Storage 비용 없음

### 3. 기준 보정 (calibration.js)
```
[보정 모드 ON] → 영상 속 자(ruler) 위 두 점 클릭
→ 픽셀 거리 자동 계산 → 실제 길이(cm) 입력
→ scale = 실제길이(cm) / 픽셀거리(px) 저장
```
- 보정 완료 후 모든 좌표에 scale 자동 적용

### 4. 클릭 트래킹 (tracker.js)
```
[트래킹 모드 ON] → 프레임 이동 → 물체 위치 탭/클릭
→ (x, y) 픽셀 좌표 저장 → scale 적용하여 실제 거리(cm) 변환
```
- 각 클릭마다 번호 표시 (①②③...)
- 점 간 거리 자동 계산 및 표시
- 잘못 찍은 점 삭제 가능 (마지막 점 취소)
- 프레임 간격(Δt) 입력: 촬영 fps 기반으로 자동 계산 또는 수동 입력

### 5. 데이터 분석 및 그래프 (chart.js)
Chart.js로 렌더링:
- **자유낙하**: y 이동거리 vs 시간 (y-t² 선형 확인)
- **수평투사 x**: x 이동거리 vs 시간 (등속 확인)  
- **수평투사 y**: y 이동거리 vs 시간 (자유낙하와 비교)

### 6. 보고서 이미지 생성 (report.js)
`html2canvas` 또는 직접 Canvas 합성으로 1장짜리 PNG 생성

보고서 레이아웃:
```
┌──────────────────────────────────────────┐
│ 이름: _______ 반: ___  날짜: __________  │
├─────────────────┬────────────────────────┤
│  [자유낙하]      │  [수평투사]             │
│  궤적 이미지     │  궤적 이미지            │
│  위치점 + 간격   │  위치점 + 간격          │
├─────────────────┴────────────────────────┤
│  y-t 그래프  │  x-t 그래프  │  y-t 그래프 │
├──────────────────────────────────────────┤
│  측정 데이터표                            │
│  시간(s) │ 자유낙하 y(cm) │ 수평 x(cm) │ 수평 y(cm) │
│  보정값: 기준길이 __cm = __px            │
└──────────────────────────────────────────┘
```
- 학생 이름/반 입력 필드 포함
- **"보고서 저장 (PNG)"** 버튼 → 로컬 다운로드
- 다운로드된 PNG를 구글 문서에 첨부하여 클래스룸 제출

---

## UI/UX 요구사항

- **태블릿 우선 (Android)**: 터치 이벤트 지원, 버튼 최소 48px
- **한국어 UI 전체**
- 단계별 진행 구조 (Step 1 → 2 → 3 → 4):
  1. 로그인
  2. 영상 업로드 & 기준 보정
  3. 트래킹 (자유낙하 → 수평투사 순)
  4. 결과 확인 & 보고서 다운로드
- 다크 테마 권장 (태블릿 화면 눈 보호)

---

## Firebase 설정 메모

```javascript
// firebase-config.js — 공개키이므로 커밋 가능
// (보안은 Firestore Security Rules로 관리)
const firebaseConfig = {
  apiKey: "여기에입력",
  authDomain: "여기에입력",
  projectId: "여기에입력",
  storageBucket: "여기에입력",
  messagingSenderId: "여기에입력",
  appId: "여기에입력"
};
```

Firestore Security Rules (최소 설정):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sessions/{userId}/{document=**} {
      allow read, write: if request.auth != null
                         && request.auth.uid == userId;
    }
  }
}
```

---

## 개발 우선순위

1. **Firebase Auth + Google 로그인** → 가장 먼저
2. **영상 로드 + 프레임 탐색** → 핵심 기능
3. **클릭 트래킹 + 좌표 저장**
4. **기준 보정 (px → cm)**
5. **그래프 렌더링**
6. **보고서 PNG 생성 & 다운로드**
7. **UI polish (단계 표시, 태블릿 최적화)**

---

## 주의사항

- 영상 파일은 **절대 서버에 업로드하지 않음** (File API + 로컬 처리만)
- `video.currentTime` seekTo 방식은 Android Chrome에서 동작 확인 필요
  → 안 되면 ffmpeg.wasm 대안 검토
- `html2canvas`가 Canvas 위 video 프레임을 캡처 못 할 수 있음
  → 직접 OffscreenCanvas 합성 방식으로 대체
- 보정 없이 트래킹 시작하면 경고 표시
- Firestore 세션 저장은 선택사항 — 새로고침 시 데이터 유지용

---

## 수행평가 연계 정보

이 앱은 다음 수행평가와 연계됩니다:

**평가 흐름**: 촬영 → 앱 분석 → PNG 다운로드 → 구글 문서 첨부 → 질문 답변 → 클래스룸 제출

**구글 문서 질문지 (교사 별도 제공)**:
1. 자유낙하에서 시간 간격이 같을 때 y 이동 거리는 어떤 규칙을 보이나요? 데이터를 근거로 서술하시오.
2. 수평투사에서 x 방향 이동 거리는 어떤 규칙을 보이나요?
3. 수평투사의 y 방향 운동과 자유낙하를 비교하면 어떤 결론을 내릴 수 있나요?
4. 실험에서 오차가 발생할 수 있는 원인을 2가지 서술하시오.

**평가 루브릭 (A/B/C/D)**:
- A: 데이터 정확 + 1:3:5:7 규칙 및 등속 확인 + 운동 독립성을 데이터 근거로 서술
- B: 데이터 정확 + 패턴 확인 + 개념어 중심 서술
- C: 데이터 있으나 패턴 해석 부족 또는 서술 미흡
- D: 트래킹 미완성 또는 보정 오류로 데이터 신뢰 불가
