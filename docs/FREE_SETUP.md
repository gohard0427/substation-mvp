# 무료 배포 설정

이 안내는 소스 준비 단계의 설정 절차입니다. 실제 프로젝트/배포/정리 예약 실행은 연결 후 검증해야 합니다. API 키와 비밀번호를 채팅이나 GitHub에 붙이지 마세요.

## 1. 전용 Supabase Free 프로젝트

다른 앱에 영향이 없도록 이 앱 전용 프로젝트를 생성합니다. 플랜은 Free로 유지합니다. SQL Editor에서 아래 파일 내용을 순서대로 실행합니다.

1. `supabase/migrations/001_free_mvp.sql`
2. `supabase/migrations/002_private_bucket.sql`

Authentication 설정에서 공개 회원가입을 끄고 관리자와 작업자 공용 사용자를 각각 생성합니다. 각 사용자의 이메일과 UUID를 기록합니다. 작업자 이메일을 여러 기기에서 함께 사용하되 앱 작업 권한은 기기별로 분리됩니다. 이메일 확인/사용자 활성화 상태도 확인합니다.

프로젝트 설정에서 URL, anon key와 service_role key를 확인합니다. 이 코드는 기존 JWT 형식 `anon`/`service_role` 키를 사용합니다. service_role은 외부 공개 금지입니다.

## 2. Cloudflare Pages

Workers & Pages에서 **Pages 프로젝트**를 만들고 GitHub의 `gohard0427/substation-mvp`를 연결합니다. 기존 다른 앱의 프로젝트를 수정하지 않습니다.

- 배포 브랜치: `main`
- 프레임워크: 없음
- 빌드 명령: `npm ci && npm run build`
- 출력 폴더: `dist`
- Node 버전: 22 이상

Pages의 Variables and Secrets에 다음 값을 **서버 환경 변수**로 설정합니다. 키를 `VITE_`, `NEXT_PUBLIC_` 이름으로 만들지 마세요.

| 이름 | 값 |
|---|---|
| SUPABASE_URL | `https://프로젝트ID.supabase.co` |
| SUPABASE_ANON_KEY | anon 키 |
| SUPABASE_SERVICE_ROLE_KEY | service_role 키, Secret |
| ADMIN_EMAIL / ADMIN_USER_ID | 관리자 이메일 / UUID |
| WORKER_EMAIL / WORKER_USER_ID | 공용 사용자 이메일 / UUID |
| PUBLIC_ORIGIN | 실제 운영 `https://이름.pages.dev` 주소, 마지막 `/` 없음 |

`DEPLOY_TARGET`는 설정하지 않습니다. `python`을 지정하면 이전 릴레이가 활성화됩니다. Preview 배포는 운영 Origin과 다르므로 API가 차단되는 것이 기본 동작입니다. 설정 후 재배포합니다.

## 3. 24시간 정리 — 필수

프런트엔드 배포만으로 정기 삭제가 시작되지는 않습니다. Supabase CLI를 로그인한 뒤 프로젝트에 연결하고 함수 배포:

```sh
supabase link --project-ref 프로젝트ID
supabase functions deploy np-cleanup --no-verify-jwt
```

함수는 JWT 자동 검증 대신 서버에서 service_role bearer를 직접 비교합니다. 내장 `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY` 환경을 사용합니다. 배포 번들에서 루트 `cloudflare/supabase-client.mjs`와 `_shared/cleanup.mjs` import가 포함되는지 확인합니다.

Supabase Vault 화면에서 `np_project_url`(프로젝트 URL)과 `np_service_role_key`(service_role)를 등록합니다. 값이 담긴 SQL을 저장소에 기록하지 않습니다. 이어서 SQL Editor에서 `supabase/schedule-cleanup.sql`을 실행합니다. pg_cron/pg_net 확장과 Vault 사용 가능 상태를 확인합니다.

15분마다 만료된 작업을 정리하므로 파일 삭제는 만료 시각 이후 최대 예약 간격과 처리 시간만큼 지연될 수 있습니다. API 접근은 24시간 만료 즉시 차단됩니다. 삭제 실패 시 메타데이터/용량 예약을 유지해 다음 실행에서 재시도합니다. cron 실행 로그, 함수 2xx, 버킷 파일 제거를 실제로 확인한 후 운영합니다. Edge Function 오류나 무료 프로젝트 일시 중지 중에는 정리가 지연됩니다.

## 4. 운영 전 직접 확인

스마트폰 두 대에서 공용 로그인 → 작은 ZIP 업로드 → 다른 기기 작업 접근 차단 → 사진별 내용 확정 → PMA 직접 선택 → 생성 → 개별/ZIP 다운로드 → 저장 완료 → 비공개 버킷 파일 삭제를 확인합니다. 브라우저를 닫았다 다시 열어 이 기기 복구와 생성 이어하기도 확인합니다. 관리자에서 비밀번호 변경 후 이전 앱 세션이 차단되는지 확인합니다.

24시간 만료는 별도 시험 작업의 DB 시각을 테스트 환경에서 조정해 실제 cron/Storage 삭제까지 확인합니다. 50장 실사진 모바일 테스트와 A4 6장 인쇄 검수도 필요합니다. 로컬 자동 테스트 통과는 이러한 실서비스 검증을 대신하지 않습니다.

## 비용과 제한

별도 유료 서버를 만들지 않습니다. 앱 저장 예약을 700MiB로 제한하지만 무료 전송량·DB·함수 호출 한도도 적용됩니다. Supabase Free의 현재 저장/전송/비활성 중지 조건과 Cloudflare Pages Functions의 Workers Free CPU 제한을 계정 화면에서 확인하세요. 무료 한도 정책은 공급자가 변경할 수 있습니다. 사진 반복 다운로드나 동시 사용량에 따라 하루 20~50장이어도 한도가 부족할 수 있습니다.

외부 API 키와 활성화 설정이 없으면 AI 버튼은 비활성입니다. [AI_SETUP.md](AI_SETUP.md)의 검수·AI 연결 안내를 참고하세요. 외부 비전 API 도입은 별도 사용료·공급자 보관 정책·예산 한도를 정한 뒤 연결합니다. 월간 수백~1,000장 서버 백그라운드 분석은 이번 무료 MVP 범위에 포함하지 않습니다.

- https://supabase.com/pricing
- https://supabase.com/docs/guides/functions/schedule-functions
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/pages/functions/
