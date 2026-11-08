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
  body text,                              -- the free-form notebook page (sanitised HTML)
  protocols jsonb default '[]'::jsonb,    -- ids of the protocols this experiment followed
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
-- Added after the first release: projects created earlier get the column here.
alter table public.notebooks add column if not exists body text;
-- The protocols an experiment followed, as ids. Ids rather than titles so a
-- renamed protocol still reads correctly in every entry that cited it.
alter table public.notebooks add column if not exists protocols jsonb default '[]'::jsonb;

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

-- ------------------------------------------------------------
-- Finances are admin-only
-- ------------------------------------------------------------
-- Grants and expenses are rows of inventory_items like everything else, so
-- the blanket "any approved member" policy just above would let any member
-- read the lab's budget straight from the API. The Finances menu being
-- hidden for members is only the menu; this is the part that decides.
--
-- Written as a policy rather than by moving the rows into a table of their
-- own: the rows stay where the app already reads and writes them, so there
-- is no migration to get wrong and no second place to keep in step. A
-- member's query simply does not return them — not an error, just absent,
-- which is what RLS is for.
--
-- `category not in (...)` is false when category is NULL, so a row with no
-- category would become admin-only too. category is `not null`, so there
-- are none; stated here because it is the kind of thing that changes.
drop policy if exists inventory_items_rw on public.inventory_items;
create policy inventory_items_rw on public.inventory_items
  for all to authenticated
  using (
    public.is_approved()
    and (category not in ('grants', 'expenses') or public.is_admin())
  )
  with check (
    public.is_approved()
    and (category not in ('grants', 'expenses') or public.is_admin())
  );

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

-- ============================================================
-- lab_photos  (the gallery under Team on the public site)
-- ============================================================
-- Two halves, and the split is deliberate. The images go in a PUBLIC bucket
-- so the marketing page can show them with a plain <img src>; the captions
-- go in a table that anyone may read, so that page needs one small fetch and
-- not the whole Supabase client.
--
-- PUBLIC means public: anybody with the URL can open these images, whether
-- or not they came from the site. Only put up photos everybody in them is
-- happy to have on the open internet.
create table if not exists public.lab_photos (
  id uuid primary key default gen_random_uuid(),
  path text not null,                     -- object path inside the lab-photos bucket
  caption text,
  category text default 'daily',          -- daily | occasions | conferences
  taken_on text,                          -- plain YYYY-MM-DD, as typed
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.lab_photos enable row level security;

-- Anyone may read: this is what the public site renders.
drop policy if exists lab_photos_read on public.lab_photos;
create policy lab_photos_read on public.lab_photos
  for select to anon, authenticated using (true);

-- Only approved members may add or remove.
drop policy if exists lab_photos_write on public.lab_photos;
create policy lab_photos_write on public.lab_photos
  for insert to authenticated with check (public.is_approved());

drop policy if exists lab_photos_update on public.lab_photos;
create policy lab_photos_update on public.lab_photos
  for update to authenticated using (public.is_approved()) with check (public.is_approved());

drop policy if exists lab_photos_delete on public.lab_photos;
create policy lab_photos_delete on public.lab_photos
  for delete to authenticated using (public.is_approved());

-- Postgres checks the table grant BEFORE any policy, so a table with
-- policies and no grant answers "permission denied for table lab_photos"
-- however well the policy fits. This is the one table anon may read — that
-- is the whole point of it — and the policies above are what keep anon to
-- reading. Everything else stays revoked from anon, further up this file.
grant select on public.lab_photos to anon;
grant select, insert, update, delete on public.lab_photos to authenticated;

insert into storage.buckets (id, name, public)
values ('lab-photos','lab-photos', true)
on conflict (id) do update set public = true;

drop policy if exists lab_photos_obj_read on storage.objects;
create policy lab_photos_obj_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'lab-photos');

drop policy if exists lab_photos_obj_write on storage.objects;
create policy lab_photos_obj_write on storage.objects
  for insert to authenticated with check (bucket_id = 'lab-photos' and public.is_approved());

drop policy if exists lab_photos_obj_delete on storage.objects;
create policy lab_photos_obj_delete on storage.objects
  for delete to authenticated using (bucket_id = 'lab-photos' and public.is_approved());
