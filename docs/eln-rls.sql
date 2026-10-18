-- =============================================================================
-- Electronic Lab Notebook — row-level security
-- Run after docs/eln-schema.sql
-- =============================================================================
-- This is the layer that holds when the other two are wrong. The FastAPI route
-- scopes the query, LabScope.select() adds the WHERE clause, and if both are
-- bypassed PostgreSQL still refuses the row.
--
-- How the database knows who is asking
--   The pool hands out one connection to many requests, so per-user database
--   roles are not an option. Instead each transaction sets two settings, which
--   app.scoping.apply_session_scope() already does:
--
--       SELECT set_config('app.current_user_id', '<uuid>', true),
--              set_config('app.lab_id',   '<uuid>', true);
--
--   The third argument is is_local: the setting dies with the transaction, so
--   it cannot leak to the next request that borrows the connection.
--
-- What this protects against, and what it does not
--   It stops a forgotten WHERE clause, a mis-scoped join, an ORM relationship
--   loaded without a filter — the ordinary bugs that leak one lab's data to
--   another. It does NOT stop SQL injection that can run arbitrary statements,
--   because such a payload can call set_config itself. Injection is still the
--   parameterised-query layer's job; RLS narrows the blast radius, it does not
--   replace it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · Roles
-- -----------------------------------------------------------------------------
-- Migrations run as the owner; the application connects as eln_app. The split
-- matters: a table's owner is exempt from its own policies unless the table is
-- FORCEd, and a role with BYPASSRLS ignores them outright. The application role
-- must be neither.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eln_app') THEN
    CREATE ROLE eln_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO eln_app;

-- -----------------------------------------------------------------------------
-- 2 · Who is asking
-- -----------------------------------------------------------------------------
-- STABLE so the planner evaluates them once per statement rather than once per
-- row. In the policies they are written as (SELECT current_lab()), which turns
-- the call into an InitPlan — on a large table that is the difference between a
-- scan that finishes and one that does not.
CREATE OR REPLACE FUNCTION current_lab() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.lab_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;

-- The role comes from the membership table, not from the request: a token
-- claiming 'admin' cannot grant itself anything the database does not agree to.
CREATE OR REPLACE FUNCTION current_lab_role() RETURNS lab_role
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT m.role FROM lab_member m
   WHERE m.lab_id = nullif(current_setting('app.lab_id', true), '')::uuid
     AND m.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- Membership, not the token, decides whether you may read the lab at all.
-- current_lab_role() returns NULL for a non-member, so this is false for
-- anyone who names a lab they do not belong to. Reads need this as much as
-- writes do: without it, app.lab_id is a self-service claim, and RLS is meant
-- to hold precisely when the layer that sets app.lab_id is wrong.
CREATE OR REPLACE FUNCTION can_read() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT current_lab_role() IS NOT NULL $$;

CREATE OR REPLACE FUNCTION can_write() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT current_lab_role() IN ('owner', 'admin', 'member') $$;

CREATE OR REPLACE FUNCTION can_administer() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT current_lab_role() IN ('owner', 'admin') $$;

-- current_lab_role reads lab_member, which is itself behind RLS; SECURITY
-- DEFINER lets it do so without the policy needing to consult itself.
REVOKE EXECUTE ON FUNCTION current_lab_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_lab_role() TO eln_app;

-- A note on what app.lab_id is for, now that membership is checked separately:
-- it selects which of your labs you are working in, it does not grant access
-- to it. Naming a lab you do not belong to now yields nothing rather than its
-- shared rows. The two settings answer different questions — who you are, and
-- which of your labs you are looking at — and only the first is trusted.

-- With nothing set, current_lab() is NULL and every comparison is NULL, which
-- is not true, so an unscoped connection sees nothing. Fail closed by default.

-- -----------------------------------------------------------------------------
-- 3 · Privileges
-- -----------------------------------------------------------------------------
-- RLS only narrows what a role may already touch, so the grants come first.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eln_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eln_app;

-- Entry history and the audit trail are append-only: no UPDATE, no DELETE, for
-- anyone connecting as the application. An ELN that can rewrite its own history
-- is not a lab record.
REVOKE UPDATE, DELETE ON notebook_entry_version FROM eln_app;
REVOKE UPDATE, DELETE ON entry_signature        FROM eln_app;
REVOKE INSERT, UPDATE, DELETE ON audit_event    FROM eln_app;

-- Lookup data is read-only to the application.
REVOKE INSERT, UPDATE, DELETE ON feature_type FROM eln_app;

-- -----------------------------------------------------------------------------
-- 4 · Turn it on
-- -----------------------------------------------------------------------------
-- FORCE as well as ENABLE: without FORCE the table's owner is exempt, and one
-- deployment that connects as the owner would quietly disable all of this.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lab', 'app_user', 'lab_member', 'project', 'refresh_token',
    'notebook_entry', 'notebook_entry_version', 'entry_signature',
    'plasmid', 'entry_plasmid', 'plasmid_lineage', 'sequence_feature',
    'feature_type', 'feature_library_entry', 'plasmid_sample', 'storage_box',
    'primer', 'primer_binding', 'primer_pair',
    'assembly', 'assembly_fragment',
    'guide_rna', 'pegrna_detail', 'guide_off_target',
    'attachment', 'audit_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 5 · The ordinary case: a table with its own lab_id
-- -----------------------------------------------------------------------------
-- Four policies rather than one FOR ALL, because the rules differ by command:
-- reading needs membership, writing needs a writing role, deleting needs an
-- administrator. Generated in a loop so the twelve tables cannot drift apart.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project', 'notebook_entry', 'plasmid', 'storage_box',
    'primer', 'primer_pair', 'guide_rna', 'assembly'
  ] LOOP
    EXECUTE format($f$
      CREATE POLICY %1$I_select ON %1$I FOR SELECT
        USING (lab_id = (SELECT current_lab()) AND (SELECT can_read()));
      CREATE POLICY %1$I_insert ON %1$I FOR INSERT
        WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_write()));
      CREATE POLICY %1$I_update ON %1$I FOR UPDATE
        USING (lab_id = (SELECT current_lab()) AND (SELECT can_write()))
        WITH CHECK (lab_id = (SELECT current_lab()));
      CREATE POLICY %1$I_delete ON %1$I FOR DELETE
        USING (lab_id = (SELECT current_lab()) AND (SELECT can_administer()));
    $f$, t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 6 · Tenancy and identity
-- -----------------------------------------------------------------------------
-- You see the lab you are working in.
CREATE POLICY lab_select ON lab FOR SELECT
  USING (id = (SELECT current_lab()) AND (SELECT can_read()));
CREATE POLICY lab_update ON lab FOR UPDATE
  USING (id = (SELECT current_lab()) AND (SELECT can_administer()))
  WITH CHECK (id = (SELECT current_lab()));

-- You see yourself, and the people you share this lab with. Not the whole
-- directory: an ELN hosting two groups should not leak one group's roster.
CREATE POLICY app_user_select ON app_user FOR SELECT
  USING (
    id = (SELECT current_user_id())
    OR (SELECT can_read()) AND EXISTS (
      SELECT 1 FROM lab_member m
       WHERE m.user_id = app_user.id
         AND m.lab_id = (SELECT current_lab())
    )
  );
-- You may edit your own profile; an administrator may edit anyone in the lab.
CREATE POLICY app_user_update ON app_user FOR UPDATE
  USING (
    id = (SELECT current_user_id())
    OR ((SELECT can_administer()) AND EXISTS (
      SELECT 1 FROM lab_member m
       WHERE m.user_id = app_user.id AND m.lab_id = (SELECT current_lab())))
  )
  WITH CHECK (true);

-- Your own sessions, and nobody else's — not even a lab administrator's. A
-- session is not lab data; it is the thing that proves somebody is who they
-- say they are, and an admin who can read one can become its owner.
--
-- There is no SELECT of other people's rows at any privilege level here, which
-- is also why reuse detection and revocation run inside the SECURITY DEFINER
-- function in docs/eln-auth.sql: at refresh time nobody is authenticated yet,
-- so current_user_id() is null and these policies correctly show nothing.
CREATE POLICY refresh_token_select ON refresh_token FOR SELECT
  USING (user_id = (SELECT current_user_id()));
CREATE POLICY refresh_token_insert ON refresh_token FOR INSERT
  WITH CHECK (user_id = (SELECT current_user_id()));
-- Revoking is an UPDATE. There is no DELETE policy: a session that ended is
-- part of the record of who was signed in when, and an audit that can be
-- tidied away is not one.
CREATE POLICY refresh_token_update ON refresh_token FOR UPDATE
  USING (user_id = (SELECT current_user_id()))
  WITH CHECK (user_id = (SELECT current_user_id()));

CREATE POLICY lab_member_select ON lab_member FOR SELECT
  USING (lab_id = (SELECT current_lab()) AND (SELECT can_read()));
CREATE POLICY lab_member_write ON lab_member FOR ALL
  USING (lab_id = (SELECT current_lab()) AND (SELECT can_administer()))
  WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_administer()));

-- -----------------------------------------------------------------------------
-- 7 · Children that reach their lab through a parent
-- -----------------------------------------------------------------------------
-- These tables carry no lab_id of their own, so the policy joins up to the one
-- that does. The EXISTS is itself subject to the parent's policy, which is
-- belt and braces rather than a problem: a row whose parent is invisible is
-- invisible too. Every join column below is indexed, which is what keeps this
-- from turning into a per-row seek.
CREATE POLICY sequence_feature_all ON sequence_feature FOR ALL
  USING (EXISTS (SELECT 1 FROM plasmid p
                  WHERE p.id = sequence_feature.plasmid_id
                    AND p.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM plasmid p
             WHERE p.id = sequence_feature.plasmid_id
               AND p.lab_id = (SELECT current_lab())));

CREATE POLICY plasmid_sample_all ON plasmid_sample FOR ALL
  USING (EXISTS (SELECT 1 FROM plasmid p
                  WHERE p.id = plasmid_sample.plasmid_id
                    AND p.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM plasmid p
             WHERE p.id = plasmid_sample.plasmid_id
               AND p.lab_id = (SELECT current_lab())));

-- Both ends of this join have to be in the lab, or an entry here could be
-- linked to a plasmid over there.
CREATE POLICY entry_plasmid_all ON entry_plasmid FOR ALL
  USING (EXISTS (SELECT 1 FROM plasmid p
                  WHERE p.id = entry_plasmid.plasmid_id
                    AND p.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write())
          AND EXISTS (SELECT 1 FROM plasmid p
                       WHERE p.id = entry_plasmid.plasmid_id
                         AND p.lab_id = (SELECT current_lab()))
          AND EXISTS (SELECT 1 FROM notebook_entry e
                       WHERE e.id = entry_plasmid.entry_id
                         AND e.lab_id = (SELECT current_lab())));

CREATE POLICY plasmid_lineage_all ON plasmid_lineage FOR ALL
  USING (EXISTS (SELECT 1 FROM plasmid p
                  WHERE p.id = plasmid_lineage.child_id
                    AND p.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write())
          AND EXISTS (SELECT 1 FROM plasmid c
                       WHERE c.id = plasmid_lineage.child_id
                         AND c.lab_id = (SELECT current_lab()))
          AND EXISTS (SELECT 1 FROM plasmid pa
                       WHERE pa.id = plasmid_lineage.parent_id
                         AND pa.lab_id = (SELECT current_lab())));

-- A fragment is reachable exactly when its assembly is, which is the same
-- rule as sequence_feature and for the same reason: one place decides.
CREATE POLICY assembly_fragment_all ON assembly_fragment FOR ALL
  USING (EXISTS (SELECT 1 FROM assembly a
                  WHERE a.id = assembly_fragment.assembly_id
                    AND a.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM assembly a
             WHERE a.id = assembly_fragment.assembly_id
               AND a.lab_id = (SELECT current_lab())));

CREATE POLICY primer_binding_all ON primer_binding FOR ALL
  USING (EXISTS (SELECT 1 FROM primer pr
                  WHERE pr.id = primer_binding.primer_id
                    AND pr.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM primer pr
             WHERE pr.id = primer_binding.primer_id
               AND pr.lab_id = (SELECT current_lab())));

CREATE POLICY pegrna_detail_all ON pegrna_detail FOR ALL
  USING (EXISTS (SELECT 1 FROM guide_rna g
                  WHERE g.id = pegrna_detail.guide_id
                    AND g.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM guide_rna g
             WHERE g.id = pegrna_detail.guide_id
               AND g.lab_id = (SELECT current_lab())));

CREATE POLICY guide_off_target_all ON guide_off_target FOR ALL
  USING (EXISTS (SELECT 1 FROM guide_rna g
                  WHERE g.id = guide_off_target.guide_id
                    AND g.lab_id = (SELECT current_lab())))
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM guide_rna g
             WHERE g.id = guide_off_target.guide_id
               AND g.lab_id = (SELECT current_lab())));

-- -----------------------------------------------------------------------------
-- 8 · Entry history, signatures and attachments
-- -----------------------------------------------------------------------------
-- Readable with the entry; append-only by privilege (section 3), so there is
-- deliberately no UPDATE or DELETE policy to write.
CREATE POLICY entry_version_select ON notebook_entry_version FOR SELECT
  USING (EXISTS (SELECT 1 FROM notebook_entry e
                  WHERE e.id = notebook_entry_version.entry_id
                    AND e.lab_id = (SELECT current_lab())));
CREATE POLICY entry_version_insert ON notebook_entry_version FOR INSERT
  WITH CHECK ((SELECT can_write()) AND EXISTS (
            SELECT 1 FROM notebook_entry e
             WHERE e.id = notebook_entry_version.entry_id
               AND e.lab_id = (SELECT current_lab())));

CREATE POLICY entry_signature_select ON entry_signature FOR SELECT
  USING (EXISTS (SELECT 1 FROM notebook_entry e
                  WHERE e.id = entry_signature.entry_id
                    AND e.lab_id = (SELECT current_lab())));
-- You sign as yourself. Nobody signs on another person's behalf, which is the
-- whole point of a signature.
CREATE POLICY entry_signature_insert ON entry_signature FOR INSERT
  WITH CHECK (
    signer_id = (SELECT current_user_id())
    AND EXISTS (SELECT 1 FROM notebook_entry e
                 WHERE e.id = entry_signature.entry_id
                   AND e.lab_id = (SELECT current_lab()))
  );

CREATE POLICY attachment_select ON attachment FOR SELECT
  USING (lab_id = (SELECT current_lab()) AND (SELECT can_read()));
CREATE POLICY attachment_insert ON attachment FOR INSERT
  WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_write()));
CREATE POLICY attachment_delete ON attachment FOR DELETE
  USING (lab_id = (SELECT current_lab()) AND (SELECT can_administer()));

-- -----------------------------------------------------------------------------
-- 9 · Shared reference data
-- -----------------------------------------------------------------------------
-- feature_type is global and read-only to the application.
CREATE POLICY feature_type_select ON feature_type FOR SELECT USING (true);

-- A library entry with no lab is a built-in every lab can match against; one
-- with a lab belongs to it alone.
CREATE POLICY feature_library_select ON feature_library_entry FOR SELECT
  USING (lab_id IS NULL OR (lab_id = (SELECT current_lab()) AND (SELECT can_read())));
CREATE POLICY feature_library_write ON feature_library_entry FOR ALL
  USING (lab_id = (SELECT current_lab()) AND (SELECT can_write()))
  WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_write()));

-- -----------------------------------------------------------------------------
-- 10 · The audit trail
-- -----------------------------------------------------------------------------
-- Administrators read their own lab's trail. Nobody writes it directly: the
-- grant was revoked in section 3, so only the trigger can, and the trigger has
-- to be SECURITY DEFINER for that to work. This is what stops the application
-- forging an entry in its own audit log.
CREATE POLICY audit_event_select ON audit_event FOR SELECT
  USING (lab_id = (SELECT current_lab()) AND (SELECT can_administer()));

-- The trigger runs as the function's owner, and FORCE applies to the owner too,
-- so without a permissive INSERT policy every audited write would fail. The
-- policy says "whoever is allowed to insert here may insert anything"; the
-- REVOKE in section 3 is what decides that the application is not allowed.
-- Privilege picks who, policy picks what — getting those the wrong way round
-- is how an audit trail silently stops recording.
CREATE POLICY audit_event_insert ON audit_event FOR INSERT WITH CHECK (true);

ALTER FUNCTION record_audit_event() SECURITY DEFINER SET search_path = public;

-- -----------------------------------------------------------------------------
-- 11 · How a denial actually looks
-- -----------------------------------------------------------------------------
-- These are not the same, and the difference decides what the API must check:
--
--   SELECT / UPDATE / DELETE blocked by a USING clause
--       -> no error. The row is simply not there: zero rows returned, zero
--          rows affected. Code that only catches exceptions will report
--          success for an update that changed nothing.
--
--   INSERT, or an UPDATE that would move a row out of the lab, blocked by a
--   WITH CHECK clause
--       -> raises 42501, new row violates row-level security policy.
--
-- So a handler that updates or deletes must look at the row count and answer
-- 404 when it is zero, rather than assuming the absence of an exception means
-- the write happened.

-- -----------------------------------------------------------------------------
-- 12 · Indexes the policies depend on
-- -----------------------------------------------------------------------------
-- Every EXISTS above joins on a primary key, which is already indexed. These
-- cover the lab_id lookups the policies add to every statement.
CREATE INDEX IF NOT EXISTS plasmid_lab_idx         ON plasmid (lab_id);
CREATE INDEX IF NOT EXISTS notebook_entry_lab_idx  ON notebook_entry (lab_id);
CREATE INDEX IF NOT EXISTS guide_rna_lab_idx       ON guide_rna (lab_id);
CREATE INDEX IF NOT EXISTS primer_lab_idx          ON primer (lab_id);
CREATE INDEX IF NOT EXISTS assembly_lab_id_idx      ON assembly (lab_id);
CREATE INDEX IF NOT EXISTS lab_member_lab_user_idx ON lab_member (lab_id, user_id);

-- =============================================================================
-- Checking it in production
--
--   -- every table should say both t and t
--   SELECT relname, relrowsecurity, relforcerowsecurity
--     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
--    ORDER BY relname;
--
--   -- the application role must not be able to step over any of it
--   SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'eln_app';
--
--   -- and it must not own the tables, or FORCE is the only thing saving you
--   SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public';
-- =============================================================================
