-- ============================================================
-- Elias Lab Notebook — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.
-- Then create a Storage bucket named "lab-files" (public) — see bottom.
-- ============================================================

-- ---------- helper: is the caller an approved lab member? ----------
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
    case when lower(new.email) = 'amerelias02@gmail.com' then 'admin' else 'member' end,
    case when lower(new.email) = 'amerelias02@gmail.com' then 'approved' else 'pending' end
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
  category text not null,                 -- enzymes | primers | plasmids | stocks | kits
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
-- Storage: create a PUBLIC bucket named  lab-files
-- ------------------------------------------------------------
-- Easiest: Dashboard → Storage → New bucket → name "lab-files",
-- toggle "Public bucket" ON.  Then run the policies below so
-- approved members can upload/delete and anyone can read.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('lab-files','lab-files', true)
on conflict (id) do update set public = true;

drop policy if exists lab_files_read on storage.objects;
create policy lab_files_read on storage.objects
  for select using (bucket_id = 'lab-files');

drop policy if exists lab_files_write on storage.objects;
create policy lab_files_write on storage.objects
  for insert to authenticated with check (bucket_id = 'lab-files' and public.is_approved());

drop policy if exists lab_files_delete on storage.objects;
create policy lab_files_delete on storage.objects
  for delete to authenticated using (bucket_id = 'lab-files' and public.is_approved());
