-- Correct the default; preserve custom titles, completed exports and in-flight generation.
begin;
update public.np_config set payload=jsonb_set(payload,'{project}',to_jsonb('2026~2027년도 시흥전력지사 변전협력회사 총액공사'::text)) where singleton and payload->>'project'='2026~2026년도 시흥전력지사 변전협력회사 총액공사';
update public.np_jobs set payload=jsonb_set(payload,'{project}',to_jsonb('2026~2027년도 시흥전력지사 변전협력회사 총액공사'::text)),revision=revision+1 where state='uploaded' and payload->>'project'='2026~2026년도 시흥전력지사 변전협력회사 총액공사';
commit;
