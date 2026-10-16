# 현장명판 — 수동 생성 MVP + 선택적 AI 연결

한국어 모바일 웹앱 초기 구현입니다. **운영 배포용 완제품은 아닙니다.** 비전 API 연결 코드는 있으나 실제 키가 없어 외부 API 호출·추천 정확도 평가는 수행하지 않았습니다.

## 웹 주소로 사용하는 배포

기존 앱과 같은 GitHub → Cloudflare Pages 연결을 위한 빌드·Functions와 Python 서버 배포 구성을 추가했습니다. 설정 순서는 **[Cloudflare·Python 서버 배포 안내](docs/CLOUDFLARE_SETUP.md)** 를 참고하세요. 계정에 실제 서비스를 생성하거나 배포 완료했다고 확인한 상태는 아닙니다. 이 구성은 영속 디스크가 필요하며 Render 사용 시 서버·디스크 요금 확인이 필요합니다.

## GitHub에서 Windows로 다운로드·실행

저장소 화면에서 전달받은 브랜치를 먼저 선택하고 **Code → Download ZIP**을 누릅니다. ZIP을 압축 해제한 뒤 `server.py`와 `README.md`가 있는 폴더를 엽니다. 압축 폴더 안에서 바로 실행하지 마십시오.

Python 3.11 이상이 설치되어 있어야 합니다. 해당 폴더에서 PowerShell을 열고 다음을 실행합니다. 가상환경 활성화 명령을 사용하지 않으므로 PowerShell 실행 정책을 변경할 필요가 없습니다.

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock
$env:KOREAN_FONT = Join-Path $env:WINDIR 'Fonts\malgunbd.ttf'
$adminSecret = Read-Host '관리자 비밀번호' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $adminSecret).Password
$workerSecret = Read-Host '작업자 공용 비밀번호' -AsSecureString
$env:WORKER_PASSWORD = [System.Net.NetworkCredential]::new('', $workerSecret).Password
.\.venv\Scripts\python.exe server.py
```

그 터미널을 열어 둔 상태로 **같은 Windows PC**의 브라우저에서 http://localhost:8000 에 접속합니다. 종료는 터미널에서 Ctrl+C입니다. 다른 PC나 스마트폰의 `localhost`는 이 서버를 가리키지 않습니다. Windows에서는 맑은 고딕 Bold를 사용하므로 Linux Noto 폰트와 글자 모양이 달라질 수 있습니다. Noto Sans CJK Bold 폰트를 설치했다면 해당 파일 경로를 `KOREAN_FONT`로 지정하면 됩니다.

이 프로젝트의 실제 서버는 Python입니다. `requirements.lock`은 Python 런타임 의존성을 고정합니다. 요청하신 `package.json`·`package-lock.json`도 포함하며 선택적인 Node 검사/실행 명령을 제공합니다. npm 런타임 패키지 의존성은 없습니다. Next.js 프로젝트로 표시하지 않습니다.

Cloudflare Pages에 정적 파일만 올려서는 로그인·업로드·AI·합성 기능이 실행되지 않습니다. 별도의 Python 백엔드 없이 화면만 배포한 주소를 완성된 앱으로 안내하지 않습니다. 웹 배포는 위의 Cloudflare·Python 서버 연결 안내를, 로컬 실행은 이 절차를 사용합니다.

## Linux/macOS 로컬 실행

Python 3.11+, 잠금 파일의 Python 패키지, 한글 Noto Sans CJK Bold 폰트가 필요합니다. Linux Debian 계열 폰트 패키지는 `fonts-noto-cjk`입니다. 다른 OS는 `KOREAN_FONT` 환경변수로 폰트 경로를 지정하십시오.

```sh
cd /workspace/substation
python -m pip install -r requirements.lock
read -s -p '관리자 비밀번호: ' ADMIN_PASSWORD
export ADMIN_PASSWORD
read -s -p '작업자 비밀번호: ' WORKER_PASSWORD
export WORKER_PASSWORD
python server.py
```

http://localhost:8000 에서 사용합니다. 비밀번호 미설정 시 로그인을 허용하지 않습니다. `.env.example`은 환경변수 설명이며 자동으로 읽지 않습니다. 로컬 HTTP에서는 `COOKIE_SECURE`를 설정하지 않고, 실제 HTTPS 배포에서는 `COOKIE_SECURE=1`로 설정합니다.

작업자 계정을 선택하고 공용 비밀번호로 로그인 → 사진 또는 ZIP 선택 → 묶음 정보 수정 → 사진별 작업 하나 입력 또는 AI 추천 선택 → 확인 체크 → 전체 명판 생성 → 결과 미리보기 → 전체/날짜별 ZIP 또는 개별 사진 다운로드 → 저장 완료 확인.

같은 브라우저의 다른 탭에서 동일 작업을 수정하면 저장 버전 충돌을 감지해 자동 저장을 중단합니다. 다시 불러오면 서버의 최신 내용이 적용됩니다. 다른 기기의 작업은 같은 공용 계정으로 로그인해도 조회할 수 없습니다. 브라우저 데이터 삭제 시 기기 복구 권한을 잃습니다. 공유 브라우저 프로필은 같은 기기로 취급합니다.

## 구현 상태

- 관리자·공용 로그인, 기기별 256비트 복구 쿠키, 서버에는 토큰 해시 저장.
- 관리자 공사명, 표준 작업 목록, 구분 필요 그룹 등록·수정.
- 공용 비밀번호 변경(PBKDF2-HMAC-SHA256, 60만 회)과 모든 기존 작업자 세션 무효화. 관리자 세션은 유지하며 별도 전체 세션 종료 버튼도 제공.
- 사진/ZIP 업로드, 한글 상대 경로, YYYYMMDD 또는 구분된 날짜 추정, 폴더 묶음 편집, 중복 표시·유지, 손상 파일 건너뛰기.
- 사진별 확정·제외·정보 누락/선택 필요/확인 완료/생성 실패 상태. 입력 변경 시 기존 확인 해제.
- 자동 저장 요청 직렬화, 늦은 응답의 최신 입력 덮어쓰기 방지, 서버 버전 충돌 검사.
- EXIF 방향 보정 및 수동 회전 미리보기, 동일한 방향 처리 함수로 합성.
- 4:3 캔버스, 최대 1280×960, 작은 원본 무확대, JPEG 85%, EXIF 제거.
- 실제 예시의 명판 비율 적용, 5행 2열, 오른쪽·아래 여백 0, 흰 배경·굵은 한글·왼쪽 정렬.
- SQLite 영속 대기열, 단일 worker 순차 생성, 중단된 생성 작업을 서버 시작 시 다시 대기열로 이동. 사진별 JPEG 캐시로 성공 사진 재합성 방지. 생성 실패 사진의 오류 표시·재시도.
- 합성 결과 미리보기, 개별 JPEG, 전체 및 날짜별 ZIP. 원본 상대 폴더 유지.
- 저장 완료 후 원본·분석 자료·출력·임시 ZIP 전부 삭제. 마지막 처리/저장 활동 후 24시간 만료. 서버가 켜져 있는 동안 60초마다 정리하며 재시작 후 정리.
- 선택적 OpenAI 비전 API 서버 연결, 구조화 JSON 검증, 표준 목록 안에서 최대 3개 후보, 관찰 단서·추천 근거, 결과 재사용, 일일 호출 한도.

초기 PMA 그룹은 `PMA`가 포함된 설비 타입의 측정 장면/불명확한 작업에 적용합니다. `대상 기기`, `작업 전/후`, `분리`, `조립`, `청소`, `점검`, `교체`는 측정 장면 표시가 없으면 기본 예외입니다. 작업자가 측정 장면을 표시하거나 AI가 혼동 그룹을 반환하면 직접 선택을 요구합니다. 후보와 최종 작업의 일치 여부도 서버에서 검사합니다. **사진 기반 PMA 판별 정확도를 검증한 것은 아닙니다.** 설비 타입 오입력이나 AI 탐지 누락을 막는 완전한 규칙은 아니며 실제 사진 평가가 필요합니다.

## 실제 AI 연결

서버를 실행할 터미널 또는 배포 서비스의 비밀 환경변수에 설정합니다. 키는 채팅·소스 코드·브라우저에 넣지 마십시오.

```sh
read -s -p 'OpenAI API 키: ' OPENAI_API_KEY
export OPENAI_API_KEY
export OPENAI_VISION_MODEL=gpt-4.1-mini
export AI_DAILY_LIMIT=100
export AI_MIN_INTERVAL_SECONDS=1
python server.py
```

키가 없으면 직접 입력 기능만 사용하고 AI 요청 버튼은 비활성화합니다. 키가 있으면 ‘사진별 AI 추천 요청’으로 서버 대기열에 분석을 등록합니다. 키 존재만으로 실제 API 권한이나 연결 성공을 확인한 것은 아닙니다. 설정 변경은 서버 재시작이 필요합니다.

- 사진은 방향 보정된 분석 사본으로 서버에서만 전송합니다. 변전소/폴더명을 작업 분류 근거로 보내지 않으며 설비 타입 힌트만 사용합니다.
- 기존 명판이 있는 예시 사진은 묶음 설정 또는 사진별 ‘기존 명판 있음’을 표시하십시오. 두 예시 규격을 포함하도록 원본 방향의 오른쪽 아래 영역(가로 54%, 세로 22%)을 회색으로 가린 뒤, 실제 출력과 동일하게 회전·축소합니다. 원본과 최종 출력에는 이 마스킹을 적용하지 않습니다. 모든 임의 명판 위치를 자동 탐지하는 기능은 아닙니다.
- `store:false`로 요청하지만 이것만으로 공급자의 보관 기간이나 학습 사용 정책을 보증하지 않습니다. 회사 계정의 데이터 제어/보관/학습 설정을 확인한 뒤 사용하십시오. 참고: https://platform.openai.com/docs/guides/your-data
- 자동 API 재시도는 하지 않습니다. 중단된 호출은 비용 중복 방지를 위해 보류하고, 사용자 재요청이 있을 때만 다시 호출합니다. 호출은 최근 24시간 `AI_DAILY_LIMIT`회로 제한하며 시작한 요청도 한도에 포함합니다.
- 성공 결과는 사진·회전·설비 힌트·명판 가리기·작업 목록·혼동 그룹·모델 버전 조합으로 재사용합니다. 방향/설비/가리기 설정을 바꾸면 추천을 다시 요청해야 합니다. 표준 목록/그룹 변경은 다음 요청 때 캐시를 무효화합니다.
- 토큰 사용량은 사진별 응답 메타데이터에 기록합니다. 요금표/통화가 미설정이므로 비용이나 정확도를 숫자로 만들어 표시하지 않습니다.
- **현재 추천은 사진+표준 목록 기반 1차 연결입니다. 기존 참고 사진 검색·OCR·이미지 임베딩을 사용하는 RAG는 아직 없습니다.** 검수된 사례 검색을 갖춘 최종 AI 기능으로 간주하지 않습니다.

## 명판 및 샘플 검증

제공된 예시1 27장 + 예시2 35장 = 62장. 2048×1536 45장, 1440×1080 17장, 총 8개 폴더 묶음입니다. 실제 사진 62장을 Pillow로 열고 폴더 정보 추정 및 1280×960 합성을 확인했습니다.

다수 사진의 2048×1536 프로필에서 표 911×336px, 왼쪽 열 약132px을 측정해 비례 적용했습니다. 1440×1080 예시에는 다른 프로필이 있습니다. 현재는 첫 프로필로 통일하며 자동 선택하지 않습니다. `docs/sample-review.md`와 `docs/sample-validation.json`에 근거를 기록했습니다. 원본 글꼴의 정확한 이름은 미확인으로 Noto Sans CJK Bold를 대체 사용합니다. A4 2열×3행 인쇄 가독성은 실물 확인이 필요합니다.

작은 원본을 확대하지 않습니다. 다른 비율은 자르지 않고 흰 여백으로 4:3에 맞춥니다. 이미지 내용 기반 자동 방향 판별은 미구현이며 세로는 EXIF 처리 후 90도 회전해 수동 조정할 수 있습니다.

## 제약 및 남은 작업

- Next.js/TypeScript/Supabase 전환, 실제 외부 API·모바일 브라우저·실물 인쇄 검증, 운영 배포는 미완료.
- 기존 참고 사진 등록/OCR 검수/명판 자동 탐지/작업 별칭 DB/실제 이미지 임베딩·유사 검색/대상 기기 문맥/교정 기록 별도 장기 보존/정확도·비용 대시보드는 미구현.
- 업로드는 압축 파일 200MB, 해제 1GB, 최대 2,000개 항목, 사진당 30MB·4천만 픽셀, 최대 압축률 200배. 경로 탈출/절대 경로와 잘못된 실이미지 형식을 차단합니다.
- 업로드 본문은 아직 서버 메모리에 적재합니다. 이 한도를 넘는 월 ZIP은 지원하지 않습니다. 업로드 재개·스트리밍 업로드/압축 해제·업로드 진행률은 미구현.
- 대기열은 영속화했지만 **단일 서버 프로세스와 영속 로컬 디스크를 전제로 합니다.** 다중 worker/다중 인스턴스 lease·분산 잠금·운영 스케줄러는 아직 없습니다. 서버 시작 때 중단 작업의 복구 로직을 테스트했지만 실제 프로세스 강제 종료/재시작 내구성 시험은 별도 필요합니다.
- ASGI/Uvicorn 실행, 중계 키 확인과 로그인 시도 제한을 추가했습니다. 외부 인증 공급자, 감사 로그, 저장소 용량 할당량 및 실제 외부 계정 검증은 여전히 남아 있습니다.
- 만료 정리는 웹브라우저에 의존하지 않지만 서버가 중단된 동안 실행되지는 않습니다. 운영에서는 별도 상시 cron/worker가 필요합니다.

## 구조 및 데이터

- `static/`: 모바일 한국어 UI. 화면/관리자 기능은 API 권한과 별도로 서버에서 다시 검증.
- `server.py`: HTTP API, SQLite, 파일 검증·합성·대기열·만료 삭제.
- `vision.py`: OpenAI Responses API 어댑터. 비밀 키를 서버에서만 사용.
- `asgi.py`, `Dockerfile`, `render.yaml`: 영속 디스크를 사용하는 별도 서버 배포 구성.
- `scripts/build.mjs`, `functions/`, `cloudflare/`: Cloudflare Pages 빌드·서버 API 중계. 비밀 값은 정적 출력에 넣지 않습니다.
- `data/app.db`: 로그인 해시, 비밀번호 재설정 해시, 기기별 작업 권한 해시/사진별 상태·추천·확정, 표준 작업/혼동 그룹, AI 호출 한도 기록.
- `data/<무작위 작업 ID>/`: 원본, `outputs/` 사진별 JPEG 캐시, 결과 ZIP. 정적 경로로 제공하지 않음.
- `migrations/001_proposed_postgres.sql`: 후속 Supabase 서버 전용 모델 초안이며 현재 SQLite와 자동 연동되지 않습니다.

## 테스트

ASGI HTTP 테스트용 개발 의존성은 별도로 설치합니다.

```sh
python -m pip install -r requirements-dev.lock
python -m unittest discover -s tests -v
node tests/test_frontend.cjs
node tests/test_proxy.mjs
npm run build
node --check static/app.js
```

서버/이미지/HTTP/AI 어댑터 테스트와 Node VM 기반 자동 저장 경쟁 테스트를 제공합니다. AI 테스트는 모의 응답을 사용하며 실제 공급자를 호출하지 않습니다. Node VM/Fetch API 테스트는 실제 브라우저·Cloudflare 런타임 검증을 대신하지 않습니다. 이번 검증 결과는 `docs/validation.md`에 기록합니다.

## 배포 계획

Python 서버 전체를 Vercel/Cloudflare Workers에 그대로 배포하면 안 됩니다. Cloudflare에는 `npm run build`로 만든 `dist`와 Pages Functions를 배포하고 Python ASGI는 영속 디스크가 있는 별도 서버로 실행합니다. 로컬 파일·SQLite·worker 스레드가 영속 프로세스에 의존합니다.

내부 시험은 영속 볼륨을 가진 단일 Linux 프로세스에서 비루트 사용자, HTTPS 리버스 프록시, `COOKIE_SECURE=1`, 비공개 파일 저장소, 프로세스 자동 재시작으로 구성합니다. `python server.py`는 개발용입니다. 배포용 `Dockerfile`은 Uvicorn 단일 프로세스, 요청 동시성 제한, 비루트 실행과 로그인 시도 제한을 사용합니다. 이 작업에서는 외부 계정 배포를 확인하지 않았습니다.

운영 목표 구조는 Next.js 모바일 프런트 + Supabase Auth/PostgreSQL/private Storage + 전용 컨테이너 worker입니다. Vercel은 UI와 짧은 API만 담당하고, 대용량 ZIP은 재개 업로드·디스크 스트리밍·행 잠금/lease/heartbeat를 가진 PostgreSQL 큐에서 처리합니다. 공용 auth.uid()만으로 접근을 허용하지 않고 기기별 capability를 모든 요청에서 검사해야 합니다. 1,000장을 브라우저에서 일괄 해제하지 않습니다.
