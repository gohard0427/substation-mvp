-- Server-controlled trial switch. Keeps access checks, cache, and concurrency lock.
-- Request parameters cannot enable unlimited mode.
do $patch$
declare definition text; line text; result text:=''; changed integer:=0;
begin
 definition:=pg_get_functiondef('public.np_ai_rpc(text,jsonb)'::regprocedure);
 if position('aiTrialUnlimited' in definition)=0 then
  foreach line in array string_to_array(definition,E'\n') loop
   if line like '%raise exception ''AI_DAILY_LIMIT''%' or line like '%raise exception ''AI_TOTAL_LIMIT''%' or line like '%raise exception ''AI_BUDGET_LIMIT''%' then
    if position('  if ' in line)=0 then raise exception 'UNLIMITED_GATE_TARGET_MISSING';end if;
    line:=replace(line,'  if ','  if not coalesce((select (payload->>''aiTrialUnlimited'')::boolean from public.np_config where singleton),false) and ');
    changed:=changed+1;
   end if;
   result:=result||line||E'\n';
  end loop;
  if changed<>3 then raise exception 'UNLIMITED_EXPECTED_THREE_GATES';end if;
  definition:=replace(result,'''estimatedCostKrw'',','''trialUnlimited'',coalesce((select (payload->>''aiTrialUnlimited'')::boolean from public.np_config where singleton),false),''estimatedCostKrw'',');
  execute definition;
 end if;
end $patch$;
