-- Run ONLY if you already ran version 1 of schema.sql. (Fresh installs: use schema.sql.)
drop view if exists public.duplicate_certificates;
drop function if exists public.remove_duplicates();
create table if not exists public.removed_keys(key text primary key, removed_at timestamptz not null default now());
alter table public.removed_keys enable row level security;
alter publication supabase_realtime add table public.audit_logs;
-- self-heal: create the caller's profile if it is missing (e.g. they signed up before this schema existed)
create function public.ensure_profile() returns public.profiles language plpgsql security definer set search_path=public as $$
declare u auth.users; r text; p profiles;
begin
  select * into u from auth.users where id=auth.uid(); if u.id is null then raise exception 'not signed in' using errcode='28000'; end if;
  select * into p from profiles where id=u.id; if found then return p; end if;
  select roll_no into r from students where lower(email)=lower(u.email) limit 1;
  insert into profiles(id,email,full_name,role,roll_no) values(u.id,u.email,coalesce(u.raw_user_meta_data->>'full_name',u.email),
    case when exists(select 1 from faculty_emails where lower(email)=lower(u.email)) then 'faculty'::app_role else 'student'::app_role end, r)
  returning * into p; return p;
end $$;
revoke all on function public.ensure_profile() from public, anon; grant execute on function public.ensure_profile() to authenticated;

-- backfill profiles for accounts that already exist
insert into public.profiles(id,email,full_name,role,roll_no)
select u.id,u.email,coalesce(u.raw_user_meta_data->>'full_name',u.email),
  case when exists(select 1 from public.faculty_emails f where lower(f.email)=lower(u.email)) then 'faculty'::app_role else 'student'::app_role end,
  (select roll_no from public.students s where lower(s.email)=lower(u.email) limit 1)
from auth.users u on conflict (id) do nothing;
