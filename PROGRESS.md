# Motion Tracker — 개발 진행상황

## 프로젝트 정보

| 항목 | 내용 |
|------|------|
| Firebase 프로젝트 | motion-tracking-68d0e |
| 배포 URL | https://motion-tracker-kr.web.app |
| 현재 버전 | v1.3 patch2 |
| 최신 커밋 | `4d44f6e` |

---

## 로드맵 (예정 작업)

| # | 항목 | 상태 | 비고 |
|---|------|------|------|
| 1 | 회절 무늬 분석 실험 추가 | ⏳ 예정 | 고3 대상, 이중슬릿 엔진 재활용 |
| 2 | 앱 첫 화면 디자인 수정 | ⏳ 예정 | 모드 선택 화면 UI 개편 |
| 3 | 개인정보처리방침 추가 | ⏳ 예정 | 외부 공개 전 법적 요건 |
| 4 | 다양한 사용자 대상으로 확장 | ⏳ 예정 | 선유고 전용 → 일반 공개 전환 |

---

## 완료된 작업

### v1.3 patch2 (2026-06-12)

| # | 작업 | 비고 |
|---|------|------|
| - | 이중슬릿: 보고서→분석 전환 및 저장/불러오기 후 무늬 점선 위치 어긋남 버그 수정 | `_fitCanvas`에서 canvasW/H 변화 시 좌표 비례 보정 |

### v1.3 patch1 (2026-06-11)

| # | 작업 | 비고 |
|---|------|------|
| - | Firebase Storage CORS 설정 | cors.json + gsutil |
| - | 캔버스 오염(tainted canvas) 방지 | fetch → blob URL 변환 |
| - | 중복 Firestore 문서 방지 | _currentExpDocId 세션 변수 |
| - | 실험 목록 자동 갱신 | 저장 후 _refreshExperimentList() 호출 |
| - | _buildEnhanced / _readBrightness 예외 처리 | drawImage + getImageData try-catch |
| - | SW 캐시 버전 업 | v34 |

### v1.3 (2026-06-11) — 이중슬릿 분석 모듈

| # | 작업 | 비고 |
|---|------|------|
| 1 | 이중슬릿 분석 UI 전면 개편 | 3-컬럼 레이아웃, 무늬 이동 모드, 드래그 핸들 |
| 2 | 보고서 PNG 저장 | html2canvas, input→div 변환으로 텍스트 클리핑 해결 |
| 3 | 보고서 DOCX 저장 | JSZip 기반 Open XML 직접 생성 |
| 4 | 실험 저장/불러오기 | 이미지→Firebase Storage, 분석 상태→Firestore |
| 5 | 파일명 자동화 | 학번+이름 포함 (이중슬릿_보고서_학번이름.png) |
| 6 | 모바일 UX 개선 | 터치 히트 영역, 너지 버튼, 레이아웃, 보정 패널 |

### v1.2

| # | 작업 | 비고 |
|---|------|------|
| 1 | 보정 UX 개편 | A·B 점 사이 캔버스 버튼 탭으로 길이 입력 트리거 |
| 2 | 재보정 시 기존 입력값 유지 | realLengthCm pre-fill |
| 3 | 보정 점 드래그 중 실시간 재계산 | |
| 4 | 보고서 클라우드 저장/불러오기 | Firestore + Firebase Storage |
| 5 | 그래프 x축 0 시작, 단위 레이블 개선 | |
| 6 | 가이드라인 색상 커스터마이징 | 색상 피커 |

### v1.1

| # | 작업 | 비고 |
|---|------|------|
| 1 | 자유 물체 운동 분석 모드 추가 | freeMotion.js |
| 2 | 원점 설정 기능 | 상대 좌표 분석 |
| 3 | ZoomController | 핀치줌 + 마우스휠 줌 |
| 4 | 패닝 모드 | |
| 5 | Google Drive 영상 불러오기 | drivePicker.js |
| 6 | 클립보드 TSV 복사 | Google Sheets 연동 |
| 7 | PWA 홈 화면 설치 | manifest.json, sw.js, icons/ |
| 8 | 앱 정보 모달, 푸터 | |
| 9 | 모드 선택 화면: 촬영 팁 + 변경이력 | |

### v1.0 (초기 릴리즈)

| # | 작업 | 비고 |
|---|------|------|
| 1 | 프로젝트 설계 & CLAUDE.md | |
| 2 | Firebase 설정 | Auth, Firestore, Hosting |
| 3 | Google OAuth 로그인 | |
| 4 | 영상 로드 & 프레임 추출 | video.js, fps 자동 측정 포함 |
| 5 | 클릭 트래킹 + 좌표 저장 | tracker.js |
| 6 | 기준 보정 (px → cm) | calibration.js |
| 7 | Chart.js 그래프 | graphs.js |
| 8 | 보고서 PNG 생성 & 다운로드 | OffscreenCanvas 직접 합성 |
| 9 | NCC 자동 추적 | autotracker.js, 템플릿 매칭 |
| 10 | 이중슬릿 간섭무늬 분석 모듈 | slitAnalyzer.js |

---

## 수업 연계 실험별 대상

| 모듈 | 대상 학년 | 과목 |
|------|----------|------|
| 자유낙하 / 수평투사 | 고1 | 통합과학 |
| 이중슬릿 간섭무늬 분석 | 고2 | 물리학 |
| 회절 무늬 분석 (예정) | 고3 | 물리학 |

---

## 기술 결정사항

| 항목 | 결정 | 이유 |
|------|------|------|
| Auth | Firebase + Google OAuth | Workspace 계정 연동 |
| 영상 입력 | 파일 업로드 (서버 전송 없음) | Storage 비용 없음 |
| fps 측정 | requestVideoFrameCallback 자동 + 수동 override | 정확도 + fallback |
| 보고서 생성 | html2canvas + OffscreenCanvas 병행 | Android 호환 |
| 그래프 파일명 | graphs.js | chart.js는 Chart.js 라이브러리와 충돌 |
| 이중슬릿 이미지 저장 | Firebase Storage (slit/{uid}/{expId}/) | 운동분석 reports/{uid}/와 경로 분리 |

---

## 알려진 주의사항

- Android Chrome에서 `video.currentTime` seek 동작 확인 필요
- `requestVideoFrameCallback` → Chrome 83+ 필요
- Firebase Storage CORS 설정 필요 (`gsutil cors set cors.json gs://...`)
- 보정 없이 트래킹 시작 시 경고 표시
