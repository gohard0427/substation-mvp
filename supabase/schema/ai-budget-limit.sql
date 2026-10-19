-- Conservative trial budget: model input $0.75/M, output $4.50/M;
-- effective KRW 2400/USD includes exchange/tax buffer. Not an invoice.
-- Reserve KRW 800 per outstanding/unknown request: 400k context + 4k output
-- costs <= KRW 763.2 at these buffered rates. Cache hits bypass this gate.
do $patch$
declare definition text;
begin
 definition := pg_get_functiondef('public.np_ai_rpc(text,jsonb)'::regprocedure);
 definition := replace(definition,
 'least(greatest(coalesce((p_data->>''totalLimit'')::integer,100),1),100)',
 'least(greatest(coalesce((p_data->>''totalLimit'')::integer,10000),1),10000)');
 if position('AI_BUDGET_LIMIT' in definition)=0 then
  definition := replace(definition,
  '  insert into public.np_ai_runs(job_id,photo_id,signature,status)',
  E'  if (select coalesce(sum(case when coalesce((usage->>''input_tokens'')::bigint,0)+coalesce((usage->>''output_tokens'')::bigint,0)>0 then ceil(greatest(coalesce((usage->>''input_tokens'')::bigint,0),0)*0.0018+greatest(coalesce((usage->>''output_tokens'')::bigint,0),0)*0.0108) else 800 end),0) from public.np_ai_runs)+800>30000 then raise exception ''AI_BUDGET_LIMIT'';end if;\n  insert into public.np_ai_runs(job_id,photo_id,signature,status)');
  if position('AI_BUDGET_LIMIT' in definition)=0 then raise exception 'AI_BUDGET_PATCH_TARGET_MISSING';end if;
 end if;
 if position('estimatedCostKrw' in definition)=0 then
  definition:=replace(definition,'''totalAttempts'',', '''estimatedCostKrw'',(select coalesce(sum(case when coalesce((usage->>''input_tokens'')::bigint,0)+coalesce((usage->>''output_tokens'')::bigint,0)>0 then ceil(greatest(coalesce((usage->>''input_tokens'')::bigint,0),0)*0.0018+greatest(coalesce((usage->>''output_tokens'')::bigint,0),0)*0.0108) else 800 end),0) from public.np_ai_runs),''budgetKrw'',30000,''totalAttempts'',');
  if position('estimatedCostKrw' in definition)=0 then raise exception 'AI_BUDGET_USAGE_PATCH_TARGET_MISSING';end if;
 end if;
 execute definition;
end $patch$;
