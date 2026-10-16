> 이전 Python 서버 구성 자료입니다. 현재 기본 무료 배포는 [FREE_SETUP.md](FREE_SETUP.md)를 따르세요.

# GitHub → Cloudflare Pages 배포

현재 소스는 Cloudflare Pages의 화면·API 중계와 영속 디스크를 쓰는 Python ASGI 백엔드로 구성합니다. **외부 계정에 실제 서비스를 생성하거나 배포 완료한 상태는 아닙니다.** 기존 작업자 명단 앱의 저장소·배포는 변경하지 않습니다.

## 구성과 비용

```text
스마트폰/PC → Cloudflare Pages HTTPS 주소
                 ├─ 화면·스타일·브라우저 JS
                 └─ /api/* Pages Functions
                         → 비공개 중계 키 검사 → Python ASGI 서버
                                                  ├─ SQLite 상태·작업 대기열
                                                  ├─ 원본/결과 파일 (영속 디스크)
                                                  └─ 비전 API (선택 사항)
```

기존 명단 앱의 프런트 배포 방식과 동일하게 GitHub `main`을 Cloudflare Pages에 연결합니다. 명판 앱은 Pillow 기반 이미지 합성과 ZIP·서버 복구가 필요하므로 Python 서버를 함께 실행해야 합니다. `static`만 올리면 업무 기능이 작동하지 않습니다.

**Render의 영속 디스크는 유료 서비스에 연결하는 방식입니다.** 무료 임시 파일 시스템으로 바꾸면 재배포·재시작 후 사진·진행 상태를 잃을 수 있어 복구 요구사항을 충족하지 못합니다. 저장소의 `render.yaml`은 `starter` 서버 + 5GB 디스크를 지정합니다. 파일을 저장하거나 GitHub에 올리는 것만으로 서비스가 생성되지는 않습니다. 실제 Blueprint 적용 전에 계정 화면에서 서버·디스크 요금과 예산을 확인해야 합니다. 자동 확장이나 여러 인스턴스를 켜지 않습니다.

공식 문서: [Cloudflare 정적 배포](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/), [Pages Functions](https://developers.cloudflare.com/pages/functions/api-reference/), [Render 영속 디스크](https://render.com/docs/disks).

## 1. Python 백엔드

Render 계정을 연결한 뒤 `gohard0427/substation-mvp`의 `main`을 선택합니다. Blueprint라면 루트의 `render.yaml`을 검토합니다. 직접 생성해도 다음 구성이 같아야 합니다.

|항목|값|
|---|---|
|런타임|Docker|
|Dockerfile|`./Dockerfile`|
|인스턴스 수|1|
|영속 디스크 마운트|`/var/data`|
|디스크 크기|초기 5GB (요금 확인)|
|상태 점검|`/healthz`|
|데이터 경로|`DATA_DIR=/var/data`|
|배포 보호|`DEPLOYMENT_MODE=1`|
|HTTPS 쿠키|`COOKIE_SECURE=1`|
|업로드 제한|`MAX_UPLOAD_BYTES=94371840`|

서버 Secrets/환경변수에 관리자·공용 비밀번호(각 12자 이상), `EDGE_PROXY_SECRET`(예측할 수 없는 32자 이상)을 저장합니다. **채팅·GitHub·빌드 변수에 실제 값을 넣지 않습니다.** `EDGE_PROXY_SECRET`은 뒤의 Pages Functions와 같은 값을 사용합니다. API는 이 값이 없는 직접 요청을 거부합니다. `/healthz`는 비밀정보 없이 상태만 반환합니다.

AI를 사용하려면 백엔드에만 `OPENAI_API_KEY`를 추가합니다. 키 없이도 수동 명판 생성이 가능합니다. 기본 AI 한도는 최근 24시간 100회입니다. AI 공급자 데이터 정책 확인 방법은 README를 참고합니다.

배포가 성공한 후 Render가 반환하는 실제 HTTPS 서비스 주소를 기록합니다. 예시 URL을 실제 주소로 가정하면 안 됩니다. `/healthz`에서 `{"status":"ok"}`가 나와야 합니다.

Docker는 부팅 시 디스크 최상위 소유권만 준비하고 UID 10001로 권한을 내려 실행합니다. ASGI는 Uvicorn 단일 프로세스이며 생성/분석 worker도 하나입니다. `--workers` 또는 서비스 인스턴스를 늘리지 마십시오. SQLite 대기열은 분산 worker를 위한 lease를 구현하지 않았습니다.

## 2. Cloudflare Pages

Cloudflare 대시보드 → Workers & Pages → Pages → 기존 Git 저장소 가져오기를 선택합니다.

|항목|값|
|---|---|
|저장소|`gohard0427/substation-mvp`|
|Production branch|`main`|
|Framework preset|None|
|Root directory|저장소 루트|
|Build command|`npm run build`|
|Build output directory|`dist`|
|Node.js 환경변수|`NODE_VERSION=24`|

루트 `functions/`가 API 중계를 제공하므로 Functions를 포함하는 Git 배포를 사용합니다. `dist` 폴더만 수동 업로드하고 완성된 앱으로 안내하지 마십시오.

Production의 **서버 Functions 변수/Secrets**에 설정합니다.

- `BACKEND_URL`: 앞에서 실제로 배포된 Python 서버 HTTPS origin. 경로·쿼리·사용자명/비밀번호를 붙이지 않습니다.
- `EDGE_PROXY_SECRET`: 백엔드와 동일한 비밀 중계 값.
- `PUBLIC_ORIGIN`: 실제 Production Pages 주소의 origin (`https://실제이름.pages.dev`). Preview 주소는 이 값과 다르면 API가 거부됩니다.

`VITE_` 또는 프런트엔드 공개 변수로 비밀을 넣지 않습니다. `OPENAI_API_KEY`, 계정 비밀번호는 Pages에 넣을 필요가 없습니다. Pages에는 중계 키만 Secret으로 보관합니다.

처음 배포에서 Pages 주소가 정해진 뒤 `PUBLIC_ORIGIN`을 설정하고 재배포합니다. 연결 설정이 없으면 UI에서 서버 설정 미완료 안내가 나오고 API는 503을 반환합니다. 로그인 성공으로 표시하지 않습니다. Production Secrets를 Preview에 복사하지 마십시오.

## 3. 실제 접속 검증

반환된 실제 Pages 주소로 PC와 스마트폰에서 접속합니다. `localhost`는 배포 주소가 아닙니다.

1. 설정한 공용 비밀번호로 로그인합니다. 두 기기에서 각각 로그인할 수 있어야 합니다.
2. 한 기기에서 작은 ZIP을 올리고 다른 기기에는 해당 작업이 보이지 않는지 확인합니다.
3. 폴더 정보·회전·작업 내용을 확인하고 모든 사진을 확정합니다.
4. PMA 측정은 직접 선택 전 생성이 차단되는지 확인합니다.
5. 일괄 생성 후 결과 미리보기, 개별 및 전체/날짜별 ZIP을 다운로드합니다.
6. 생성 중 브라우저를 닫고 같은 브라우저로 재접속해 작업을 복구합니다.
7. 저장 완료를 누른 후 재다운로드가 차단되고 서버 파일이 삭제되는지 확인합니다.
8. 관리자 비밀번호 변경 기능으로 공용 비밀번호를 바꾸면 기존 작업자 세션이 종료되는지 확인합니다.

쿠키는 HttpOnly·SameSite=Strict·Secure로 Pages 주소에 저장됩니다. 브라우저는 같은 Pages 주소의 `/api`만 호출하며 API 중계가 쿠키를 백엔드로 전달합니다. 별도 출처의 Python URL로 브라우저에서 직접 호출하거나 CORS를 `*`로 열 필요가 없습니다.

Pages 경유 업로드는 **파일당 90MiB**로 제한합니다. Cloudflare 계정·요금제별 요청 크기 제한을 넘지 않도록 정한 MVP 한도입니다. 큰 월 ZIP은 나누어 올려야 합니다. 재개 업로드·오브젝트 스토리지 직접 업로드·대규모 분산 처리는 후속 과제입니다.

## 4. 운영과 한계

- 서버가 꺼져 있는 시간에는 정리 작업이 실행되지 않습니다. 다시 시작하면 만료 작업을 정리합니다. 정확한 24시간 상시 삭제가 필요하면 항상 켜진 worker/스케줄러를 운영해야 합니다.
- 실패·재시작으로 DB에 등록되지 못한 업로드 폴더도 24시간 지난 것은 정리합니다. `DATA_DIR`은 이 앱 전용으로 사용합니다.
- 저장 완료/24시간 삭제는 앱이 관리하는 파일·DB를 대상으로 합니다. 호스팅 공급자의 자동 디스크 스냅샷은 별도 보관 정책일 수 있습니다. 회사의 사진 삭제 정책에 맞는 공급자 백업/스냅샷 보관·복원 조건을 실제 계정에서 확인해야 합니다. 애플리케이션 삭제만으로 공급자 백업까지 지웠다고 간주하지 않습니다.
- 무료 배포로 비용을 줄이려면 DB/사진을 외부 영속 저장소로 옮기는 추가 구현이 필요합니다. 현재 사진·권한·복구 동작을 없애거나 브라우저 저장만으로 대체하지 않습니다.
- Cloudflare·Render·비전 API 외부 계정의 실제 배포·로그인·모바일 시험이 끝나기 전에는 운영 완료로 보고하지 않습니다.

## 로컬 컨테이너 검증

일반 개발 PC에서 Docker가 준비되어 있다면 `docker build -t substation-mvp .`로 이미지를 빌드합니다. 비밀번호와 중계 키는 로컬 환경변수 또는 안전하게 관리하는 env 파일로 전달하고 컨테이너 `/var/data`를 영속 볼륨에 연결합니다. `.dockerignore`는 소스 allowlist만 포함하므로 `.env`·사진·DB·`node_modules`는 이미지에 들어가지 않습니다.

관리형 개발 환경에서는 세션 프록시 CA를 BuildKit Secret으로 제공해 빌드했습니다. 이 CA는 이미지에 복사하거나 GitHub에 올리지 않았습니다. 일반 Render 환경에서는 해당 Secret 없이 빌드하며 기본 인증서로 HTTPS를 검증합니다.

Linux Docker 환경에서는 빌드 후 `python scripts/check-container.py`로 컨테이너 시작·일괄 생성·재시작 복구·삭제를 재검증할 수 있습니다. 시험용 비밀번호는 실행 중 무작위로 만들며 출력하거나 저장소 파일에 기록하지 않습니다. 이 스크립트는 로컬 Unix Docker 소켓을 사용하며 Windows 실행 스크립트가 아닙니다.
