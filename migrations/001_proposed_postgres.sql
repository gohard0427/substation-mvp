-- 후속 Supabase 설계 초안. 서버 전용 접근, 클라이언트 직접 접근은 차단.
begin;
create table equipment_types(id uuid primary key default gen_random_uuid(), name text unique not null);
create table standard_work_types(id uuid primary key default gen_random_uuid(), name text unique not null);
create table work_type_aliases(alias text primary key, work_type_id uuid not null references standard_work_types);
create table ambiguity_groups(id uuid primary key default gen_random_uuid(), equipment_type_id uuid references equipment_types, reason text not null, selection_required boolean not null default true, notes text);
create table ambiguity_group_options(group_id uuid references ambiguity_groups, work_type_id uuid references standard_work_types, primary key(group_id,work_type_id));
create table work_sessions(id uuid primary key default gen_random_uuid(), capability_hash text not null, status text not null default 'uploading', last_activity timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours');
create table work_photos(id uuid primary key default gen_random_uuid(), session_id uuid not null references work_sessions on delete cascade, original_path text not null, original_extension text not null, content_hash text, storage_key text not null, output_key text, metadata jsonb not null default '{}', rotation smallint not null default 0, status text not null default 'uploaded', confirmed_work_id uuid references standard_work_types, custom_work text, confirmed_at timestamptz, excluded boolean not null default false);
create table ai_recommendations(id uuid primary key default gen_random_uuid(), photo_id uuid references work_photos on delete cascade, result jsonb not null, model text not null, prompt_version text not null, cost numeric, created_at timestamptz not null default now());
create table reference_photos(id uuid primary key default gen_random_uuid(), storage_key text not null, masked_storage_key text, raw_ocr jsonb, reviewed_metadata jsonb, work_type_id uuid references standard_work_types, equipment_type_id uuid references equipment_types, reviewed_at timestamptz, source_session text, evaluation_split text);
create table user_corrections(id uuid primary key default gen_random_uuid(), before_value jsonb, after_value jsonb, created_at timestamptz not null default now());
create table app_settings(key text primary key, value jsonb not null);
create index work_sessions_expiry on work_sessions(expires_at);
create index work_photos_session on work_photos(session_id);
-- RLS without client policies denies anon/authenticated access. All server routes must
-- verify login role AND device capability before using service role. No public bucket.
do $$ declare t text; begin foreach t in array array['equipment_types','standard_work_types','work_type_aliases','ambiguity_groups','ambiguity_group_options','work_sessions','work_photos','ai_recommendations','reference_photos','user_corrections','app_settings'] loop execute format('alter table %I enable row level security',t); end loop; end $$;
commit;
