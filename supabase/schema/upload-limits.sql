-- Raise only the source-photo count limit; preserve current function and grants.
do $migration$
declare definition text;
begin
 definition := pg_get_functiondef('public.np_rpc(text,jsonb)'::regprocedure);
 if position('jsonb_array_length(j.payload->''photos'')>=200' in definition)>0 then return; end if;
 if position('jsonb_array_length(j.payload->''photos'')>=50' in definition)=0 then
  raise exception 'Unexpected np_rpc photo limit; inspect before changing';
 end if;
 execute replace(definition,'jsonb_array_length(j.payload->''photos'')>=50','jsonb_array_length(j.payload->''photos'')>=200');
end $migration$;
