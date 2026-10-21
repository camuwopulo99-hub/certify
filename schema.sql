-- Certifyx schema. Run once in Supabase → SQL Editor.
create extension if not exists pgcrypto;
create type app_role as enum ('student','faculty');

create table public.faculty_emails(email text primary key);          -- allow-list: these Google accounts become faculty
insert into public.faculty_emails values ('jayaramsappa09@gmail.com') on conflict do nothing;

create table public.settings(id int primary key default 1 check(id=1),
  drive_folder_id text not null default 'root', drive_folder_name text default 'Class Certificates 2026',
  spreadsheet_id text default '', spreadsheet_name text default '', sheet_name text default 'Form Responses 1');
insert into public.settings(id) values(1) on conflict do nothing;

create table public.students(roll_no text primary key, name text not null, email text, section text default 'CSE-C (2025-26)',
  approval text not null default 'PENDING_REVIEW' check(approval in ('APPROVED','REJECTED','PENDING_REVIEW')),
  feedback_reason text, submitted boolean not null default false, created_at timestamptz default now());

create table public.profiles(id uuid primary key references auth.users(id) on delete cascade, email text unique not null,
  full_name text, role app_role not null default 'student',
  roll_no text references public.students(roll_no) on update cascade on delete set null);

create table public.certificates(id uuid primary key default gen_random_uuid(),
  roll_no text not null references public.students(roll_no) on update cascade on delete cascade,
  category text, title text default '', file_name text not null, drive_file_id text unique, drive_link text,
  in_drive boolean not null default false, in_sheet boolean not null default false, sheet_row int,
  uploaded_by text, created_at timestamptz not null default now());
create index on public.certificates(roll_no);

create table public.notifications(id uuid primary key default gen_random_uuid(),
  roll_no text not null references public.students(roll_no) on update cascade on delete cascade,
  title text not null, message text not null, type text not null default 'NOTICE',
  sender text not null default 'Faculty Coordinator', is_read boolean not null default false, created_at timestamptz not null default now());
create index on public.notifications(roll_no);

create table public.audit_logs(id uuid primary key default gen_random_uuid(), actor text, action text not null, details text, category text, created_at timestamptz not null default now());
create table public.sync_reports(id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  students_checked int, drive_files int, sheet_rows int, outside_class int, unidentified int, repaired int, errors int, duration_ms int, triggered_by text);

-- tombstones: certificates/Drive files removed on purpose, so sync never resurrects them (service role only)
create table public.removed_keys(key text primary key, removed_at timestamptz not null default now());
alter table public.removed_keys enable row level security;

-- link accounts to roster rows
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
declare r text;
begin
  select roll_no into r from students where lower(email)=lower(new.email) limit 1;
  insert into profiles(id,email,full_name,role,roll_no) values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name',new.email),
    case when exists(select 1 from faculty_emails where lower(email)=lower(new.email)) then 'faculty'::app_role else 'student'::app_role end, r);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.link_profile() returns trigger language plpgsql security definer set search_path=public as $$
begin if new.email is not null then update profiles set roll_no=new.roll_no where lower(email)=lower(new.email) and roll_no is null; end if; return new; end $$;
create trigger students_link after insert or update of email on public.students for each row execute function public.link_profile();

-- helpers
create function public.is_faculty() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role='faculty') $$;
create function public.my_roll() returns text language sql stable security definer set search_path=public as $$ select roll_no from profiles where id=auth.uid() $$;
create function public._log(a text,d text,c text) returns void language sql security definer set search_path=public as $$
  insert into audit_logs(actor,action,details,category) values((select email from profiles where id=auth.uid()),a,d,c) $$;
revoke all on function public._log(text,text,text) from public, anon, authenticated;

-- views (RLS applies to the caller)
create view public.student_status with (security_invoker=true) as
select s.roll_no,s.name,s.email,s.section,s.approval,s.feedback_reason,s.submitted,
  count(c.id) filter(where c.in_drive) as drive_files, count(c.id) filter(where c.in_sheet) as sheet_rows,
  coalesce(array_agg(distinct c.category) filter(where c.category is not null),'{}') as categories,
  case when count(c.id) filter(where c.in_drive)>0 and count(c.id) filter(where c.in_sheet)>0 then 'COMPLETED'
       when count(c.id) filter(where c.in_drive)>0 or count(c.id) filter(where c.in_sheet)>0 then 'PENDING' else 'NOT STARTED' end as overall
from students s left join certificates c on c.roll_no=s.roll_no group by s.roll_no;

-- row level security
alter table public.faculty_emails enable row level security;   -- no policies: unreachable from the API
alter table public.settings enable row level security; alter table public.students enable row level security;
alter table public.profiles enable row level security; alter table public.certificates enable row level security;
alter table public.notifications enable row level security; alter table public.audit_logs enable row level security;
alter table public.sync_reports enable row level security;
create policy settings_fac on public.settings for all using(is_faculty()) with check(is_faculty());
create policy prof_read on public.profiles for select using(id=auth.uid() or is_faculty());
create policy stu_fac on public.students for all using(is_faculty()) with check(is_faculty());
create policy stu_own on public.students for select using(roll_no=my_roll());
create policy cert_fac on public.certificates for all using(is_faculty()) with check(is_faculty());
create policy cert_own on public.certificates for select using(roll_no=my_roll());
create policy not_fac on public.notifications for all using(is_faculty()) with check(is_faculty());
create policy not_own_r on public.notifications for select using(roll_no=my_roll());
create policy not_own_u on public.notifications for update using(roll_no=my_roll()) with check(roll_no=my_roll());
revoke update on public.notifications from authenticated; grant update(is_read) on public.notifications to authenticated;
create policy audit_fac on public.audit_logs for select using(is_faculty());
create policy sync_fac on public.sync_reports for select using(is_faculty());
-- students can never write certificates/students/profiles directly; uploads go through the upload-certificate function.

-- faculty-only actions
create function public.approve_student(p_roll text) returns void language plpgsql security definer set search_path=public as $$
begin if not is_faculty() then raise exception 'forbidden' using errcode='42501'; end if;
  update students set approval='APPROVED',feedback_reason=null where roll_no=p_roll;
  insert into notifications(roll_no,title,message,type) values(p_roll,'Certificate Approved','Congratulations! Your certificate submission has been verified and registered into official accreditation records.','APPROVAL');
  perform _log('APPROVE_CERTIFICATE','Approved '||p_roll,'FACULTY_REVIEW'); end $$;
create function public.reject_student(p_roll text,p_reason text) returns void language plpgsql security definer set search_path=public as $$
begin if not is_faculty() then raise exception 'forbidden' using errcode='42501'; end if;
  update students set approval='REJECTED',feedback_reason=p_reason where roll_no=p_roll;
  insert into notifications(roll_no,title,message,type) values(p_roll,'Action Required: Re-upload Certificate','Your certificate could not be accepted. Reason: '||p_reason||'. Please re-upload a clear copy as soon as possible.','REJECTION');
  perform _log('REJECT_CERTIFICATE','Requested re-upload for '||p_roll||': '||p_reason,'FACULTY_REVIEW'); end $$;
create function public.notify_student(p_roll text,p_title text,p_message text,p_type text default 'NOTICE') returns void language plpgsql security definer set search_path=public as $$
begin if not is_faculty() then raise exception 'forbidden' using errcode='42501'; end if;
  insert into notifications(roll_no,title,message,type) values(p_roll,p_title,p_message,p_type);
  perform _log('SEND_NOTIFICATION','Notified '||p_roll||': '||p_title,'NOTIFICATION'); end $$;
create function public.broadcast_alert(p_group text,p_title text,p_message text,p_priority text default 'NOTICE',p_sender text default 'Faculty Coordinator') returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin if not is_faculty() then raise exception 'forbidden' using errcode='42501'; end if;
  with t as (select roll_no from student_status where case p_group
      when 'NOT_STARTED' then overall='NOT STARTED' when 'PENDING' then overall='PENDING' when 'REJECTED' then approval='REJECTED'
      when 'APPROVED' then approval='APPROVED' when 'DEFAULTERS' then (overall<>'COMPLETED' or approval='REJECTED') else true end),
  i as (insert into notifications(roll_no,title,message,type,sender) select roll_no,p_title,p_message,p_priority,p_sender from t returning 1)
  select count(*) into n from i;
  perform _log('BROADCAST_ALERT','Sent '''||p_priority||''' alert to '||p_group||' ('||n||' students): '||p_title,'ADMIN_BROADCAST'); return n; end $$;
revoke all on function public.approve_student,public.reject_student,public.notify_student,public.broadcast_alert from public, anon;
grant execute on function public.approve_student,public.reject_student,public.notify_student,public.broadcast_alert to authenticated;

-- live updates
alter publication supabase_realtime add table public.students, public.certificates, public.notifications, public.sync_reports, public.audit_logs;

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
