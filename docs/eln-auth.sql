-- =============================================================================
-- Electronic Lab Notebook — the three operations that precede identity
-- Run after docs/eln-schema.sql, docs/eln-rls.sql, docs/eln-rls-ownership.sql
-- =============================================================================
-- Every policy in this database answers "who is asking?" by reading
-- app.current_user_id. Three operations cannot: they are what establishes who
-- is asking, or they happen before anyone exists.
--
--   logging in      app_user_select requires id = current_user_id(), which is
--                   the very thing login is trying to work out. Looking
--                   somebody up by email, before they are authenticated,
--                   matches nothing.
--
--   registering     app_user has no INSERT policy, deliberately — otherwise
--                   the application could mint users. But somebody has to be
--                   able to create the first one.
--
--   starting a lab  lab has no INSERT policy, and lab_member's write policy
--                   requires can_administer() *in the lab you are joining*,
--                   which nobody can be in a lab that does not exist yet.
--
-- None of these can be solved with a policy, because a policy's job is to
-- compare the row against the caller and here there is no caller. The usual
-- wrong answers are to give the application BYPASSRLS (which switches off
-- every protection in the other two files for every statement it ever runs),
-- or to add WITH CHECK (true) to app_user (which lets any request create
-- users). Both trade the whole boundary for three operations.
--
-- Instead: a role that exists only to own three functions, and is exempt from
-- RLS because those three functions must be. eln_app may EXECUTE them and
-- cannot become eln_auth, so the exemption is three fixed statements wide
-- instead of connection-wide. Each function returns the minimum its caller
-- needs and takes no SQL from the caller.
--
-- Requires superuser once, at migration time, for ALTER ROLE ... BYPASSRLS.
-- The reason it is needed even though eln_auth will own the tables' data path
-- is FORCE ROW LEVEL SECURITY: FORCE applies policies to the table owner too,
-- so "owned by the table owner" is not an exemption here. That is the point of
-- FORCE, and it is why the exemption has to be explicit and visible.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eln_auth') THEN
    CREATE ROLE eln_auth NOLOGIN;
  END IF;
END
$$;

ALTER ROLE eln_auth BYPASSRLS;

-- Bypassing RLS is not the same as having privileges: eln_auth still needs
-- the grants, and it gets only the three tables the three functions touch.
GRANT USAGE ON SCHEMA public TO eln_auth;

-- auth_find_user_by_email checks can_administer(), which calls
-- current_lab_role(). That function is SECURITY DEFINER but its EXECUTE was
-- revoked from PUBLIC in eln-rls.sql §2 and granted only to eln_app — so
-- without this grant, a definer function owned by eln_auth cannot ask who is
-- calling, and fails with 42501. Bypassing RLS does not imply being able to
-- execute a function: privileges and policies are separate systems, and this
-- is the seam between them.
GRANT EXECUTE ON FUNCTION current_lab_role() TO eln_auth;
GRANT SELECT, INSERT, UPDATE ON app_user   TO eln_auth;
GRANT SELECT, INSERT         ON lab        TO eln_auth;
GRANT SELECT, INSERT         ON lab_member TO eln_auth;

-- -----------------------------------------------------------------------------
-- 1 · Logging in
-- -----------------------------------------------------------------------------
-- Returns the hash for the application to verify; it never verifies passwords
-- itself, because doing so in SQL puts the plaintext in the query and from
-- there into pg_stat_activity and the logs.
--
-- It returns a row for an inactive account too, rather than hiding it, so the
-- application can tell "no such account" from "account disabled" and answer
-- both with the same 401 while logging the difference. One deliberate
-- non-feature: no rate limiting here. That belongs in front of the API, where
-- the client address is known.
CREATE OR REPLACE FUNCTION auth_lookup_credentials(p_email text)
  RETURNS TABLE (id uuid, full_name text, hashed_password text, is_active boolean)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT u.id, u.full_name, u.hashed_password, u.is_active
    FROM app_user u
   WHERE lower(u.email) = lower(btrim(p_email))
$$;

-- -----------------------------------------------------------------------------
-- 2 · Registering
-- -----------------------------------------------------------------------------
-- A new account belongs to no lab. That is the approval step: anyone may sign
-- up, and until an administrator adds them to a lab every policy in
-- eln-rls.sql shows them nothing, because can_read() is false without a
-- membership. Self-serve registration that grants nothing is a safe default
-- for a notebook holding unpublished work.
--
-- The hash arrives already computed. The function takes a text column's worth
-- of opaque string and never sees a password.
-- It returns the new row rather than just its id, because the caller cannot
-- read it back: app_user_select matches on current_user_id(), and at
-- registration time nobody is logged in — not even, yet, the person who just
-- signed up. Returning the row here is what avoids either a second exemption
-- or a pointless 'now log in to see your own account'.
--
-- The returned columns are exactly the ones UserRead exposes. hashed_password
-- is not among them.
CREATE OR REPLACE FUNCTION auth_register_user(
  p_email           text,
  p_full_name       text,
  p_hashed_password text,
  p_orcid           text DEFAULT NULL
) RETURNS TABLE (
  id            uuid,
  email         text,
  full_name     text,
  orcid         text,
  is_active     boolean,
  created_at    timestamptz,
  last_login_at timestamptz
)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF length(btrim(coalesce(p_hashed_password, ''))) < 20 THEN
    -- A short value here means the caller passed a plaintext password, or
    -- nothing at all. Refuse rather than store it.
    RAISE EXCEPTION 'auth_register_user expects a password hash, not a password'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO app_user (email, full_name, hashed_password, orcid)
    VALUES (lower(btrim(p_email)), btrim(p_full_name), p_hashed_password, p_orcid)
    RETURNING *
  )
  -- Qualified throughout: RETURNS TABLE puts these names in scope as
  -- variables, so an unqualified `id` would be the variable, not the column.
  SELECT ins.id, ins.email, ins.full_name, ins.orcid,
         ins.is_active, ins.created_at, ins.last_login_at
    FROM ins;
END
$$;

-- -----------------------------------------------------------------------------
-- 3 · Starting a lab
-- -----------------------------------------------------------------------------
-- The lab and its first membership are created together. A lab with no owner
-- is unreachable — no member means no can_read() for anyone, so nobody could
-- ever add one — which makes the two halves one operation, not two.
CREATE OR REPLACE FUNCTION auth_create_lab(
  p_name    text,
  p_slug    text,
  p_user_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = p_user_id AND u.is_active) THEN
    RAISE EXCEPTION 'no such active user' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO lab (name, slug) VALUES (btrim(p_name), lower(btrim(p_slug)))
  RETURNING id INTO new_id;

  INSERT INTO lab_member (lab_id, user_id, role) VALUES (new_id, p_user_id, 'owner');

  RETURN new_id;
END
$$;

-- -----------------------------------------------------------------------------
-- 3b · Finding somebody to add to your lab
-- -----------------------------------------------------------------------------
-- An administrator adding a colleague has the same problem in miniature:
-- app_user_select shows you yourself and the people already in your lab, so
-- the person you are about to add is precisely the one you cannot see.
--
-- This is narrower than the functions above in three ways, because it is
-- reachable by any logged-in request rather than only by the login flow:
--
--   * it checks can_administer() itself, so a plain member calling it
--     directly gets nothing. The GUCs are already set by the time a request
--     reaches here, so the function can ask who is calling.
--   * it matches one exact address. There is no prefix search and no listing,
--     so it cannot be walked to enumerate the user table.
--   * it returns a name and an id, never the hash.
--
-- What it does leak, to a lab administrator, is whether a given address has an
-- account. That is the minimum an "add by email" flow can reveal, and the
-- alternative — invitation tokens sent by mail — is a larger thing to build
-- and belongs with the mail story rather than here.
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email text)
  RETURNS TABLE (id uuid, full_name text, email text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  IF NOT can_administer() THEN
    RAISE EXCEPTION 'only a lab owner or admin may look up an account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
    SELECT u.id, u.full_name, u.email
      FROM app_user u
     WHERE lower(u.email) = lower(btrim(p_email))
       AND u.is_active;
END
$$;

-- -----------------------------------------------------------------------------
-- 4 · Who may call them
-- -----------------------------------------------------------------------------
-- Owned by eln_auth so SECURITY DEFINER runs as the exempt role. Executable by
-- eln_app and nobody else — in particular not by PUBLIC, which would make
-- auth_lookup_credentials a password-hash oracle for any role that can connect.
ALTER FUNCTION auth_lookup_credentials(text)              OWNER TO eln_auth;
ALTER FUNCTION auth_register_user(text, text, text, text)  OWNER TO eln_auth;
ALTER FUNCTION auth_create_lab(text, text, uuid)           OWNER TO eln_auth;
ALTER FUNCTION auth_find_user_by_email(text)               OWNER TO eln_auth;

REVOKE ALL ON FUNCTION auth_lookup_credentials(text)             FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_register_user(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_create_lab(text, text, uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_user_by_email(text)              FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_credentials(text)              TO eln_app;
GRANT EXECUTE ON FUNCTION auth_register_user(text, text, text, text) TO eln_app;
GRANT EXECUTE ON FUNCTION auth_create_lab(text, text, uuid)          TO eln_app;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text)              TO eln_app;

-- -----------------------------------------------------------------------------
-- 5 · Seeing your own labs
-- -----------------------------------------------------------------------------
-- Once logged in, before choosing a lab, a person needs the list of labs they
-- belong to — and app.lab_id is not set yet, so can_read() is false and the
-- policies in eln-rls.sql show them nothing.
--
-- This needs no exemption: "rows about me" is something the policy can express
-- directly, keyed on the identity that login has just established. Added here
-- rather than in eln-rls.sql because it exists for the login flow.
DROP POLICY IF EXISTS lab_member_select ON lab_member;
CREATE POLICY lab_member_select ON lab_member FOR SELECT
  USING (
    user_id = (SELECT current_user_id())                       -- my memberships
    OR (lab_id = (SELECT current_lab()) AND (SELECT can_read()))  -- my colleagues
  );

DROP POLICY IF EXISTS lab_select ON lab;
CREATE POLICY lab_select ON lab FOR SELECT
  USING (
    (id = (SELECT current_lab()) AND (SELECT can_read()))
    OR EXISTS (                                                -- the switcher
      SELECT 1 FROM lab_member m
       WHERE m.lab_id = lab.id AND m.user_id = (SELECT current_user_id())
    )
  );

-- =============================================================================
-- Checking it
--
--   -- exactly these four, plus current_lab_role() and the audit trigger,
--   -- should be SECURITY DEFINER, and all owned by
--   -- eln_auth. Anything else in this list is a privilege escalation waiting
--   -- to be found.
--   SELECT p.proname, r.rolname AS owner, p.prosecdef
--     FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
--    WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
--    ORDER BY p.proname;
--
--   -- the application role must not have inherited the exemption
--   SELECT rolname, rolbypassrls FROM pg_roles
--    WHERE rolname IN ('eln_app', 'eln_auth');
--
--   -- and must not be a member of eln_auth
--   SELECT pg_has_role('eln_app', 'eln_auth', 'member');   -- expect false
-- =============================================================================
