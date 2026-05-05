# 운동 분석 웹앱 개발 진행상황

## 프로젝트 정보
- **Firebase 프로젝트**: motion-tracking-68d0e
- **호스팅 URL**: https://motion-tracking-68d0e.web.app (배포 후 활성화)
- **대상**: 선유고 고1 통합과학 수행평가

---

## 진행 현황

| # | 작업 | 상태 | 비고 |
|---|------|------|------|
| 1 | 프로젝트 설계 & CLAUDE.md | ✅ 완료 | |
| 2 | .env, .gitignore 설정 | ✅ 완료 | |
| 3 | firebase-config.js | ✅ 완료 | |
| 4 | firebase.json / .firebaserc | ✅ 완료 | |
| 5 | index.html 레이아웃 | ✅ 완료 | |
| 6 | style.css | ✅ 완료 | |
| 7 | auth.js | ✅ 완료 | Google OAuth |
| 8 | video.js | ✅ 완료 | fps 자동 측정 포함 |
| 9 | tracker.js | ✅ 완료 | 터치 클릭 좌표 저장 |
| 10 | calibration.js | ✅ 완료 | px→cm 보정 |
| 11 | graphs.js | ✅ 완료 | Chart.js 렌더링 |
| 12 | report.js | ✅ 완료 | OffscreenCanvas PNG 생성 |
| 13 | app.js | ✅ 완료 | 메인 컨트롤러 |
| 14 | GitHub 저장소 연결 | ⏳ 대기 중 | 저장소 URL 필요 |
| 15 | Firebase Hosting 배포 | ⏳ 대기 중 | #14 완료 후 진행 |

---

## 기술 결정사항

| 항목 | 결정 | 이유 |
|------|------|------|
| Auth | Firebase + Google OAuth, 초기부터 포함 | 수업 흐름 일치 |
| 영상 입력 | 태블릿 기본 카메라 촬영 후 파일 업로드 | 복잡도 최소화 |
| fps 측정 | `requestVideoFrameCallback` 자동 측정 + 수동 override | 정확도 + fallback |
| 보고서 생성 | OffscreenCanvas 직접 합성 | html2canvas 미지원 대비 |
| 그래프 파일명 | graphs.js | chart.js는 Chart.js 라이브러리와 충돌 |

---

## 알려진 주의사항

- Android Chrome에서 `video.currentTime` seek 동작 확인 필요
- `requestVideoFrameCallback` → Chrome 83+ 필요 (현재 안드로이드 태블릿 기준 충족)
- 보정 없이 트래킹 시작 시 경고 표시
- `.env` 파일은 절대 커밋 금지 (`.gitignore` 처리됨)
