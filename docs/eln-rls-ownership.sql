-- =============================================================================
-- Electronic Lab Notebook — per-record ownership and explicit sharing
-- Run after docs/eln-schema.sql and docs/eln-rls.sql
-- =============================================================================
-- eln-rls.sql draws the outer boundary: you see your lab and no other. This
-- file draws the inner one: within a lab, a record belongs to the person who
-- made it, and colleagues see it only when it is shared.
--
-- The rule, in one sentence per command:
--
--   SELECT  your own rows, plus your lab's shared rows, plus everything if
--           you administer the lab
--   INSERT  only stamped with yourself as owner
--   UPDATE  only your own rows, and you cannot hand them to someone else
--   DELETE  only your own rows
--
-- with the lab boundary ANDed onto every one of them.
--
-- Three things a literal "owner_id = current_setting('app.current_user_id')"
-- would have got wrong, and what is done about each:
--
--   1. It hides the shared notebook. The requirement for this notebook is that
--      "any update made by any lab member is available to everyone". An
--      owner-only SELECT gives every member a notebook containing only their
--      own entries — no shared record, no lab dashboard. So is_shared defaults
--      to TRUE and the owner opts a draft *out*, rather than every record
--      starting invisible and needing to be opted in. Section 1 says how to
--      reverse that if you would rather have private-by-default.
--
--   2. It strands records when a person leaves. owner_id is ON DELETE SET
--      NULL on purpose — people leave the lab and their plasmids stay. But
--      NULL = current_user_id() is NULL, which is not TRUE, so under an
--      owner-only policy a departed student's plasmids become invisible and
--      unmodifiable to everyone, the PI included. The row still exists and
--      nobody can reach it. Every policy here therefore carries an
--      administrator branch, which is what keeps an orphaned record reachable.
--
--   3. Written as USING (is_shared) it leaks across labs. "Collaborators in
--      the same research group" is the essential half of that sentence: a bare
--      is_shared test would publish the row to every lab in the installation.
--      Here the flag is always ANDed with lab_id = current_lab(), so the lab
--      *is* the research group and sharing cannot escape it.
--
-- One deliberate non-feature: there is no per-record grant table, so you
-- cannot share a single plasmid with one named colleague. Sharing is
-- all-or-nothing within the lab. That is a smaller, checkable rule, and the
-- shape to add later if a real collaboration needs it is a plasmid_share
-- (plasmid_id, user_id) table with one more OR EXISTS branch in the SELECT
-- policy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · The columns this layer needs
-- -----------------------------------------------------------------------------
-- plasmid and primer already carry owner_id. primer_pair and guide_rna did
-- not: they are things a person designs, so they get the same treatment.
-- Nullable and ON DELETE SET NULL, matching the two that exist — deleting a
-- user must not cascade away the lab's designs.
ALTER TABLE primer_pair ADD COLUMN IF NOT EXISTS
  owner_id uuid REFERENCES app_user(id) ON DELETE SET NULL;
ALTER TABLE guide_rna   ADD COLUMN IF NOT EXISTS
  owner_id uuid REFERENCES app_user(id) ON DELETE SET NULL;

-- The sharing flag. NOT NULL so there is no third "unknown" state for a
-- policy to get wrong, and DEFAULT true so the lab notebook stays a shared
-- record (see point 1 in the header).
--
-- For private-by-default instead, change the default on the tables you want
-- it on and leave the policies alone:
--     ALTER TABLE plasmid ALTER COLUMN is_shared SET DEFAULT false;
-- Existing rows keep whatever they have; only new ones follow the new default.
ALTER TABLE notebook_entry ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;
ALTER TABLE plasmid        ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;
ALTER TABLE primer         ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;
ALTER TABLE primer_pair    ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;
ALTER TABLE guide_rna      ADD COLUMN IF NOT EXISTS is_shared boolean NOT NULL DEFAULT true;

-- A table-level GRANT covers columns added later, so the privileges from
-- eln-rls.sql section 3 already apply to these. Nothing to re-grant.

-- -----------------------------------------------------------------------------
-- 2 · Reading the flag without a round trip
-- -----------------------------------------------------------------------------
-- STABLE and called as (SELECT owns(...)) for the same reason as the helpers
-- in eln-rls.sql: it becomes an InitPlan evaluated once per statement instead
-- of a function call per row.
CREATE OR REPLACE FUNCTION owns(owner uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT owner IS NOT NULL AND owner = current_user_id() $$;

-- Spelled out rather than left implicit: an unset app.current_user_id makes
-- current_user_id() NULL, owns() false, and the whole predicate false. An
-- unidentified connection owns nothing.

-- -----------------------------------------------------------------------------
-- 3 · The owned tables
-- -----------------------------------------------------------------------------
-- These REPLACE the lab-wide policies from eln-rls.sql section 5 rather than
-- sitting beside them, and that is the point to understand: PostgreSQL ORs
-- permissive policies together. Leaving the old lab_id-only SELECT policy in
-- place and adding an owner policy next to it would give
--
--     lab_id = current_lab()  OR  owner_id = current_user_id()
--
-- which is the lab-wide rule again — the ownership test can only ever widen
-- it. Tightening means replacing the predicate, so each policy below is
-- dropped and recreated with the full condition.
--
-- notebook_entry keys off author_id; the rest off owner_id. One loop over
-- (table, owner column) pairs so the five cannot drift apart.
DO $$
DECLARE
  spec text[] := ARRAY[
    'notebook_entry', 'author_id',
    'plasmid',        'owner_id',
    'primer',         'owner_id',
    'primer_pair',    'owner_id',
    'guide_rna',      'owner_id'
  ];
  i int;
  t text;
  oc text;
BEGIN
  FOR i IN 1 .. array_length(spec, 1) BY 2 LOOP
    t  := spec[i];
    oc := spec[i + 1];

    EXECUTE format('DROP POLICY IF EXISTS %1$I_select ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_insert ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_update ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_delete ON %1$I', t);

    -- Read: mine, or shared with my lab, or I administer the lab. The lab test
    -- is what makes `is_shared` mean "shared with my research group" instead
    -- of "shared with the world".
    EXECUTE format($f$
      CREATE POLICY %1$I_select ON %1$I FOR SELECT
        USING (
          lab_id = (SELECT current_lab())
          AND (SELECT can_read())
          AND (
                (SELECT owns(%2$I))
             OR is_shared
             OR (SELECT can_administer())
          )
        )
    $f$, t, oc);

    -- Create: you may only create records owned by you. Without the owner
    -- test a member could insert a row already attributed to a colleague,
    -- which in a notebook that is meant to be evidence is forgery.
    -- Administrators may attribute to someone else, for the real case of
    -- entering a departed student's backlog.
    EXECUTE format($f$
      CREATE POLICY %1$I_insert ON %1$I FOR INSERT
        WITH CHECK (
          lab_id = (SELECT current_lab())
          AND (SELECT can_write())
          AND ((SELECT owns(%2$I)) OR (SELECT can_administer()))
        )
    $f$, t, oc);

    -- Modify: USING picks which rows you may touch, WITH CHECK what they may
    -- become. Both are needed and they do different jobs here — USING stops
    -- you editing a colleague's record, WITH CHECK stops you pushing your own
    -- record into another lab or signing it over to somebody else. An
    -- ownership transfer is an administrator's action.
    EXECUTE format($f$
      CREATE POLICY %1$I_update ON %1$I FOR UPDATE
        USING (
          lab_id = (SELECT current_lab())
          AND (SELECT can_write())
          AND ((SELECT owns(%2$I)) OR (SELECT can_administer()))
        )
        WITH CHECK (
          lab_id = (SELECT current_lab())
          AND ((SELECT owns(%2$I)) OR (SELECT can_administer()))
        )
    $f$, t, oc);

    -- Remove: your own, or an administrator's. This is a loosening of
    -- eln-rls.sql, where DELETE was administrators only.
    --
    -- Two things still stand in the way of losing a record, and they should:
    -- the API soft-deletes by setting deleted_at rather than issuing DELETE,
    -- and plasmid.created_in_entry_id is ON DELETE RESTRICT, so an entry that
    -- produced a plasmid cannot be deleted at all while that plasmid exists.
    -- A policy permitting DELETE is not the same as a path that reaches it.
    EXECUTE format($f$
      CREATE POLICY %1$I_delete ON %1$I FOR DELETE
        USING (
          lab_id = (SELECT current_lab())
          AND ((SELECT owns(%2$I)) OR (SELECT can_administer()))
        )
    $f$, t, oc);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 4 · A floor under all of it
-- -----------------------------------------------------------------------------
-- RESTRICTIVE policies are ANDed with everything else instead of ORed, so this
-- one cannot be widened by any policy added later. The lab test already
-- appears in each predicate above; this makes it structural rather than
-- repeated by hand, so a future permissive policy written in a hurry — or one
-- that forgets the lab clause entirely — still cannot reach another lab's row.
--
-- can_read() is in here too, which is the more important half. app.lab_id is
-- set by the application from a token; membership is read from lab_member. If
-- those two ever disagree -- a stale token after someone leaves the group, a
-- scope built from a request header, a bug in the JWT path -- this is the line
-- that decides it, and it decides it by consulting the table rather than the
-- claim. Shared rows are the ones that would leak, since sharing is the branch
-- that does not depend on who you are.
--
-- The cost of saying it twice is one more cheap AND on an indexed column. The
-- cost of not saying it is a cross-lab leak that nothing catches.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'notebook_entry', 'plasmid', 'primer', 'primer_pair', 'guide_rna'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %1$I_in_lab ON %1$I', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_in_lab ON %1$I AS RESTRICTIVE FOR ALL
        USING      (lab_id = (SELECT current_lab()) AND (SELECT can_read()))
        WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_read()))
    $f$, t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 5 · Children inherit the decision
-- -----------------------------------------------------------------------------
-- sequence_feature, primer_binding, pegrna_detail and the rest have no owner
-- and need none: their policies in eln-rls.sql section 7 are EXISTS tests
-- against the parent, and that EXISTS is itself subject to the parent's
-- policies. Tightening the parent's SELECT above therefore tightened theirs in
-- the same motion — a feature on an unshared plasmid is already unreachable.
--
-- This is the argument for expressing the rule once on the owning table rather
-- than copying owner_id down onto every child: one predicate to change, and no
-- chance of the copies disagreeing.

-- -----------------------------------------------------------------------------
-- 6 · Indexes
-- -----------------------------------------------------------------------------
-- Every statement now filters on (lab_id, owner). The composite covers both
-- halves; eln-rls.sql's lab_id-only indexes stay useful for the tables that
-- have no owner.
CREATE INDEX IF NOT EXISTS notebook_entry_lab_author_idx ON notebook_entry (lab_id, author_id);
CREATE INDEX IF NOT EXISTS plasmid_lab_owner_idx         ON plasmid        (lab_id, owner_id);
CREATE INDEX IF NOT EXISTS primer_lab_owner_idx          ON primer        (lab_id, owner_id);
CREATE INDEX IF NOT EXISTS primer_pair_lab_owner_idx     ON primer_pair   (lab_id, owner_id);
CREATE INDEX IF NOT EXISTS guide_rna_lab_owner_idx       ON guide_rna     (lab_id, owner_id);

-- No index on is_shared. It is a boolean that is true for nearly every row, so
-- it cannot narrow anything; the planner would ignore the index and the writes
-- would pay for it anyway. If private records ever become the common case, a
-- partial index on the minority value is the thing to add:
--     CREATE INDEX plasmid_private_idx ON plasmid (lab_id, owner_id)
--       WHERE NOT is_shared;

-- =============================================================================
-- Checking it
--
--   -- five permissive policies per owned table, plus one restrictive
--   SELECT tablename, policyname, permissive, cmd
--     FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'plasmid'
--    ORDER BY cmd, policyname;
--
--   -- nothing stranded: rows whose owner has left, which only an
--   -- administrator can now reach
--   SELECT 'plasmid' AS tbl, count(*) FROM plasmid WHERE owner_id IS NULL
--   UNION ALL
--   SELECT 'primer',  count(*) FROM primer  WHERE owner_id IS NULL;
--
--   -- what one person actually sees, checked from outside the application
--   SET ROLE eln_app;
--   SELECT set_config('app.current_user_id', '<uuid>', true),
--          set_config('app.lab_id',          '<uuid>', true);
--   SELECT count(*) FROM plasmid;
--   RESET ROLE;
-- =============================================================================
