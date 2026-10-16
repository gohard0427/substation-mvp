-- Reference images are persistent, private, masked JPEG copies. No client policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('np-reference-private','np-reference-private',false,1048576,array['image/jpeg'])
on conflict(id) do update set public=false,file_size_limit=1048576,allowed_mime_types=array['image/jpeg'];
