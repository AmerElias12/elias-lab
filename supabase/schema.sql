-- ============================================================
-- Elias Lab Notebook — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.
-- It also creates the private Storage bucket "lab-files" — see bottom.
-- ============================================================

-- ============================================================
-- profiles  (one row per auth user)
-- ============================================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  email      text not null,
  role       text not null default 'member',   -- 'admin' | 'member'
  status     text not null default 'pending',  -- 'pending' | 'approved' | 'disabled'
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ---------- helper: is the caller an approved lab member? ----------
-- Defined after the profiles table: Postgres checks a SQL function's body
-- when it is created, so the table must already exist.
create or replace function public.is_approved()
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved'
  );
$$;

create or replace function public.is_admin()
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and status = 'approved'
  );
$$;

-- any authenticated user may read the member list (names appear in dropdowns)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

-- a user may update their own name; admins may update anyone (role/status)
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- profiles_update_self lets a member edit their own row, but RLS can't limit
-- which columns change, so without this a pending member could approve
-- themselves or make themselves admin. Only admins may change role/status.
-- (auth.uid() is null in the SQL Editor/dashboard, which stays unrestricted.)
create or replace function public.guard_profile_role_status()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and (new.role is distinct from old.role or new.status is distinct from old.status) then
    raise exception 'only an admin can change role or status';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_role_status on public.profiles;
create trigger guard_profile_role_status
  before update on public.profiles
  for each row execute function public.guard_profile_role_status();

-- ---------- auto-create a profile when someone signs up ----------
-- The PI email is auto-approved as admin; everyone else is 'pending'.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email, role, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    case when lower(new.email) = 'amere@braude.ac.il' then 'admin' else 'member' end,
    case when lower(new.email) = 'amere@braude.ac.il' then 'approved' else 'pending' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- content tables  — readable/writable by approved members
-- ============================================================
create table if not exists public.protocols (
  id uuid primary key default gen_random_uuid(),
  title text, category text, author text, date text, link text,
  summary text, materials text, steps text, notes text,
  files jsonb default '[]'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.notebooks (
  id uuid primary key default gen_random_uuid(),
  title text, researcher text, date text,
  hypothesis text, methods text, results text, conclusions text, nextsteps text,
  tables jsonb default '[]'::jsonb,
  files jsonb default '[]'::jsonb,
  archived boolean default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.presentations (
  id uuid primary key default gen_random_uuid(),
  title text, presenter text, date text, venue text, link text, notes text,
  files jsonb default '[]'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,                 -- enzymes | primers | plasmids | stocks | cells | kits
  data jsonb not null default '{}'::jsonb,
  added_by text,
  created_at timestamptz not null default now()
);

-- enable RLS + apply the same "approved members" policy to each table
do $$
declare t text;
begin
  foreach t in array array['protocols','notebooks','presentations','inventory_items'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I_rw on public.%I;', t, t);
    execute format(
      'create policy %I_rw on public.%I for all to authenticated using (public.is_approved()) with check (public.is_approved());',
      t, t);
  end loop;
end $$;

-- ============================================================
-- Data API access
-- ------------------------------------------------------------
-- The project is created with "Automatically expose new tables" OFF, so
-- tables are unreachable through the API until granted. Grant them only to
-- signed-in users (RLS above still decides which rows they see); logged-out
-- visitors (anon) get no access at all.
-- ============================================================
revoke all on public.profiles, public.protocols, public.notebooks,
              public.presentations, public.inventory_items from anon;
grant select, insert, update, delete
  on public.profiles, public.protocols, public.notebooks,
     public.presentations, public.inventory_items
  to authenticated;
grant execute on function public.is_approved(), public.is_admin() to authenticated;

-- ============================================================
-- Storage: a PRIVATE bucket named  lab-files
-- ------------------------------------------------------------
-- Attachments are unpublished lab data, so there are no public links:
-- only approved members can read files, and the notebook opens them
-- through signed links that expire after a couple of hours.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('lab-files','lab-files', false)
on conflict (id) do update set public = false;

drop policy if exists lab_files_read on storage.objects;
create policy lab_files_read on storage.objects
  for select to authenticated using (bucket_id = 'lab-files' and public.is_approved());

drop policy if exists lab_files_write on storage.objects;
create policy lab_files_write on storage.objects
  for insert to authenticated with check (bucket_id = 'lab-files' and public.is_approved());

drop policy if exists lab_files_delete on storage.objects;
create policy lab_files_delete on storage.objects
  for delete to authenticated using (bucket_id = 'lab-files' and public.is_approved());
