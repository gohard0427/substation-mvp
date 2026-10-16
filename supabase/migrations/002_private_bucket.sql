-- Storage policies are deliberately NOT added for anon/authenticated users.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('np-work-private','np-work-private',false,8388608,array['image/jpeg','image/png'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
