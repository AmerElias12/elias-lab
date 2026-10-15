-- =============================================================================
-- Electronic Lab Notebook — relational schema
-- PostgreSQL 14+   ·   target stack: HTML/CSS/JS → FastAPI → PostgreSQL
-- =============================================================================
-- This is a design for the FastAPI-backed ELN, kept separate from the live
-- supabase/schema.sql that the current static notebook runs on. Nothing here
-- touches that database.
--
-- Conventions used throughout
--   · snake_case, singular table names, surrogate uuid primary keys
--   · every timestamp is timestamptz; every table carries created_at/updated_at
--   · sequence coordinates are 0-based half-open [start_pos, end_pos)
--   · soft delete via deleted_at; nothing scientific is ever hard-deleted
--   · money/decimal-free: concentrations are numeric with an explicit unit
--
-- Why uuid and not bigserial: the browser creates records offline and syncs,
-- so ids have to be generated client-side without a round trip. Use uuid v7
-- (time-ordered) from the application layer when you can — it keeps B-tree
-- inserts local and avoids the index fragmentation plain v4 causes at scale.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0 · Shared types and helpers
-- -----------------------------------------------------------------------------
CREATE TYPE topology          AS ENUM ('circular', 'linear');
CREATE TYPE entry_status      AS ENUM ('draft', 'final', 'witnessed', 'superseded', 'retracted');
CREATE TYPE signature_role    AS ENUM ('author', 'witness', 'supervisor');
CREATE TYPE lab_role          AS ENUM ('owner', 'admin', 'member', 'read_only');
CREATE TYPE guide_kind        AS ENUM ('sgRNA', 'pegRNA', 'nicking_sgRNA', 'crRNA');
CREATE TYPE edit_kind         AS ENUM ('insertion', 'deletion', 'substitution');
CREATE TYPE construction_kind AS ENUM ('restriction_ligation', 'gibson', 'golden_gate',
                                       'pcr', 'site_directed_mutagenesis', 'gene_synthesis',
                                       'recombination', 'obtained_externally');
CREATE TYPE entry_link_role   AS ENUM ('created', 'used', 'modified', 'sequenced', 'referenced');

-- One uppercase IUPAC nucleotide string. Applied as a CHECK everywhere a
-- sequence is stored, so malformed data cannot reach the database at all.
CREATE DOMAIN dna_sequence AS text
  CONSTRAINT dna_sequence_iupac CHECK (VALUE ~ '^[ACGTURYSWKMBDHVN]*$');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 1 · Tenancy and identity
-- -----------------------------------------------------------------------------
-- Every scientific row is scoped to a lab. This is the column every query
-- filters on and every row-level security policy keys off, so it is carried
-- explicitly rather than reached through three joins.
CREATE TABLE lab (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);
CREATE UNIQUE INDEX lab_slug_key ON lab (slug);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  full_name     text NOT NULL,
  -- Argon2id, written only by auth_register_user and by the rehash-on-login
  -- path. No read schema in app/schemas.py exposes this column, and the
  -- SECURITY DEFINER lookup in docs/eln-auth.sql returns it to exactly one
  -- caller: the login route, which needs it to verify a password.
  hashed_password text NOT NULL,
  orcid         text,
  is_active     boolean NOT NULL DEFAULT true,
  -- An application-level flag, not a PostgreSQL role. Nothing in the policies
  -- or the API reads it today; authorisation comes from lab_member.role. It is
  -- here for an operator account later, and because adding a column to a table
  -- people have rows in is more disruptive than carrying an unused one.
  is_superuser  boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_orcid_format CHECK (orcid IS NULL OR orcid ~ '^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$')
);
-- Case-insensitive uniqueness without the citext extension.
CREATE UNIQUE INDEX app_user_email_key ON app_user (lower(email));

-- A signed-in session, as something that can be taken away.
--
-- A JWT cannot be withdrawn: it is valid until it expires because that is what
-- "stateless" means. So the long-lived half of a session lives here, as a row,
-- and the short-lived half is a token that dies on its own within minutes.
-- Signing out, or discovering a stolen session, is then an UPDATE rather than
-- a wish.
--
-- What is stored is a SHA-256 of the token, not the token. Unlike a password
-- this needs no argon2: the token is 256 bits from the system CSPRNG, so there
-- is no guessing to slow down, and a per-request argon2 verification would cost
-- 50 ms to defend against nothing. The hash is here so that a stolen database
-- backup does not hand over live sessions.
CREATE TABLE refresh_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_sha256  bytea NOT NULL,
  -- Every token descended from one sign-in shares a family. Rotation replaces
  -- a token with its successor; if an already-replaced one is ever presented
  -- again, somebody has a copy they should not, and the whole family goes.
  family_id     uuid NOT NULL,
  replaced_by_id uuid REFERENCES refresh_token(id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_reason text,
  -- For the person reading their own session list: "Firefox on the bench Mac".
  user_agent    text,
  CONSTRAINT refresh_token_hash_len CHECK (octet_length(token_sha256) = 32),
  CONSTRAINT refresh_token_expires_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT refresh_token_not_its_own_successor CHECK (replaced_by_id IS DISTINCT FROM id)
);

-- The lookup every refresh does, and it must be unique: two rows with the same
-- hash would make "which session is this" ambiguous.
CREATE UNIQUE INDEX refresh_token_hash_key ON refresh_token (token_sha256);
CREATE INDEX refresh_token_user_idx ON refresh_token (user_id, issued_at DESC);
CREATE INDEX refresh_token_family_idx ON refresh_token (family_id);

CREATE TABLE lab_member (
  lab_id     uuid NOT NULL REFERENCES lab(id)      ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       lab_role NOT NULL DEFAULT 'member',
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lab_id, user_id)
);
CREATE INDEX lab_member_user_idx ON lab_member (user_id);

CREATE TABLE project (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id      uuid NOT NULL REFERENCES lab(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  lead_id     uuid REFERENCES app_user(id) ON DELETE SET NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_name_key ON project (lab_id, lower(name));

-- -----------------------------------------------------------------------------
-- 2 · Notebook entries
-- -----------------------------------------------------------------------------
-- The entry row is the stable identity and the current state. Its text lives in
-- notebook_entry_version, which is append-only: an ELN that overwrites what was
-- written is not a lab record, and regulators (21 CFR Part 11, GLP) will not
-- accept it. The entry carries a denormalised copy of the current body purely so
-- the common read path is a single row.
CREATE TABLE notebook_entry (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id           uuid NOT NULL REFERENCES lab(id) ON DELETE RESTRICT,
  project_id       uuid REFERENCES project(id) ON DELETE SET NULL,
  author_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  title            text NOT NULL,
  -- Structured fields the notebook prompts for.
  hypothesis       text,
  methods          text,
  results          text,
  conclusions      text,
  next_steps       text,
  -- The free-form page, as the editor's document model plus a plain-text
  -- rendering kept only for search.
  body             jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_text        text  NOT NULL DEFAULT '',
  status           entry_status NOT NULL DEFAULT 'draft',
  current_version  integer NOT NULL DEFAULT 1,
  performed_on     date,
  superseded_by_id uuid REFERENCES notebook_entry(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT notebook_entry_title_present CHECK (length(btrim(title)) > 0),
  CONSTRAINT notebook_entry_version_positive CHECK (current_version >= 1),
  CONSTRAINT notebook_entry_not_self_superseding CHECK (superseded_by_id IS DISTINCT FROM id),
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(hypothesis, '') || ' ' ||
                                     coalesce(results, '')    || ' ' ||
                                     coalesce(conclusions, '')), 'C')
  ) STORED
);
CREATE INDEX notebook_entry_lab_recent_idx ON notebook_entry (lab_id, performed_on DESC NULLS LAST)
  WHERE deleted_at IS NULL;
CREATE INDEX notebook_entry_author_idx  ON notebook_entry (author_id) WHERE deleted_at IS NULL;
CREATE INDEX notebook_entry_project_idx ON notebook_entry (project_id) WHERE deleted_at IS NULL;
CREATE INDEX notebook_entry_search_idx  ON notebook_entry USING gin (search_tsv);
CREATE TRIGGER notebook_entry_touch BEFORE UPDATE ON notebook_entry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only history. content_sha256 is what a signature commits to, so a
-- later edit can never be passed off as the text somebody witnessed.
CREATE TABLE notebook_entry_version (
  entry_id       uuid    NOT NULL REFERENCES notebook_entry(id) ON DELETE CASCADE,
  version_no     integer NOT NULL,
  -- A snapshot of everything a reader sees, not just the free-form page. A
  -- signature commits to content_sha256, so anything left out of the snapshot
  -- is something that can be changed after signing while the signature still
  -- verifies. That is the difference between a witnessed record and a
  -- witnessed fragment of one.
  title          text    NOT NULL DEFAULT '',
  hypothesis     text,
  methods        text,
  results        text,
  conclusions    text,
  next_steps     text,
  performed_on   date,
  body           jsonb   NOT NULL,
  body_text      text    NOT NULL DEFAULT '',
  change_note    text,
  content_sha256 bytea   NOT NULL,
  created_by     uuid    NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entry_id, version_no),
  CONSTRAINT entry_version_positive CHECK (version_no >= 1),
  CONSTRAINT entry_version_hash_len CHECK (octet_length(content_sha256) = 32)
);

-- A signature binds a person to one exact version. Witnessing is a second row
-- with a different role, which is why role is part of the key.
CREATE TABLE entry_signature (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL,
  version_no     integer NOT NULL,
  signer_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  role           signature_role NOT NULL,
  statement      text NOT NULL DEFAULT 'I confirm this record is accurate and complete.',
  content_sha256 bytea NOT NULL,
  signed_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (entry_id, version_no)
    REFERENCES notebook_entry_version(entry_id, version_no) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX entry_signature_once_per_role
  ON entry_signature (entry_id, version_no, signer_id, role);
CREATE INDEX entry_signature_entry_idx ON entry_signature (entry_id);

-- -----------------------------------------------------------------------------
-- 3 · Plasmids
-- -----------------------------------------------------------------------------
-- The construct as a design: one sequence, one identity. The tube in the
-- freezer is a different thing entirely and lives in plasmid_sample — a lab
-- routinely holds six aliquots of one plasmid in four boxes, and conflating
-- the two is the single most common modelling mistake in a LIMS.
CREATE TABLE plasmid (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id              uuid NOT NULL REFERENCES lab(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  alias               text,
  sequence            dna_sequence NOT NULL,
  topology            topology NOT NULL DEFAULT 'circular',
  length_bp           integer GENERATED ALWAYS AS (length(sequence)) STORED,
  backbone            text,
  insert_description  text,
  selection_markers   text[] NOT NULL DEFAULT '{}',
  host_strain         text,
  owner_id            uuid REFERENCES app_user(id) ON DELETE SET NULL,

  -- ---- provenance -----------------------------------------------------------
  -- The entry in which this construct was made. This is the link that answers
  -- "where did this plasmid come from"; everything else it appears in is a row
  -- in entry_plasmid. ON DELETE RESTRICT because losing the record of how a
  -- construct was built is worse than refusing the delete.
  created_in_entry_id uuid REFERENCES notebook_entry(id) ON DELETE RESTRICT,
  construction_method construction_kind,
  external_source     text,          -- Addgene #, collaborator, supplier
  external_reference  text,

  map_url             text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT plasmid_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT plasmid_sequence_present CHECK (length(sequence) > 0),
  -- Either it was built here, or it came from somewhere: say which.
  CONSTRAINT plasmid_provenance_known CHECK (
    created_in_entry_id IS NOT NULL
    OR external_source IS NOT NULL
    OR construction_method = 'obtained_externally'
    OR construction_method IS NULL
  )
);
CREATE UNIQUE INDEX plasmid_name_key ON plasmid (lab_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX plasmid_created_in_entry_idx ON plasmid (created_in_entry_id);
CREATE INDEX plasmid_owner_idx ON plasmid (owner_id) WHERE deleted_at IS NULL;
CREATE TRIGGER plasmid_touch BEFORE UPDATE ON plasmid
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every other appearance of a plasmid in the notebook: used in a transfection,
-- re-sequenced, modified. Separate from created_in_entry_id because this is
-- many-to-many and that one is not.
CREATE TABLE entry_plasmid (
  entry_id   uuid NOT NULL REFERENCES notebook_entry(id) ON DELETE CASCADE,
  plasmid_id uuid NOT NULL REFERENCES plasmid(id)        ON DELETE CASCADE,
  role       entry_link_role NOT NULL DEFAULT 'used',
  note       text,
  PRIMARY KEY (entry_id, plasmid_id, role)
);
CREATE INDEX entry_plasmid_plasmid_idx ON entry_plasmid (plasmid_id);

-- Construct genealogy. Many-to-many because a Gibson product has several
-- parents; ordinal keeps the pieces in assembly order.
CREATE TABLE plasmid_lineage (
  child_id   uuid NOT NULL REFERENCES plasmid(id) ON DELETE CASCADE,
  parent_id  uuid NOT NULL REFERENCES plasmid(id) ON DELETE RESTRICT,
  ordinal    smallint NOT NULL DEFAULT 1,
  method     construction_kind,
  note       text,
  PRIMARY KEY (child_id, parent_id),
  CONSTRAINT plasmid_lineage_no_self CHECK (child_id <> parent_id)
);
CREATE INDEX plasmid_lineage_parent_idx ON plasmid_lineage (parent_id);

-- -----------------------------------------------------------------------------
-- 4 · Sequence features
-- -----------------------------------------------------------------------------
-- Extensible rather than an enum: labs invent feature types, and adding an
-- enum value takes a migration while inserting a row does not.
CREATE TABLE feature_type (
  key           text PRIMARY KEY,          -- 'CDS', 'promoter', 'gRNA', …
  label         text NOT NULL,
  default_color text NOT NULL DEFAULT '#d7d7d7',
  is_builtin    boolean NOT NULL DEFAULT false,
  CONSTRAINT feature_type_color_hex CHECK (default_color ~ '^#[0-9a-fA-F]{6}$')
);

-- Coordinates are 0-based half-open [start_pos, end_pos).
-- A feature crossing the origin of a circular plasmid has wraps_origin = true,
-- and then end_pos <= start_pos. Storing the flag explicitly beats inferring it
-- from end <= start, because a zero-length feature would otherwise be
-- indistinguishable from one spanning the whole plasmid.
CREATE TABLE sequence_feature (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plasmid_id    uuid NOT NULL REFERENCES plasmid(id) ON DELETE CASCADE,
  name          text NOT NULL,
  type_key      text NOT NULL REFERENCES feature_type(key) ON DELETE RESTRICT,
  start_pos     integer NOT NULL,
  end_pos       integer NOT NULL,
  strand        smallint NOT NULL DEFAULT 1,
  wraps_origin  boolean NOT NULL DEFAULT false,
  color         text,
  note          text,
  -- How it got here, so a machine-made annotation can be told from a curated one.
  annotated_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  annotation_source text NOT NULL DEFAULT 'manual',   -- manual | imported | library | orf_scan
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_strand_valid CHECK (strand IN (-1, 0, 1)),
  CONSTRAINT feature_start_nonneg CHECK (start_pos >= 0),
  CONSTRAINT feature_end_positive CHECK (end_pos > 0),
  CONSTRAINT feature_color_hex CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT feature_span_consistent CHECK (
    (NOT wraps_origin AND end_pos > start_pos) OR (wraps_origin AND end_pos <= start_pos)
  )
);
CREATE INDEX sequence_feature_plasmid_idx ON sequence_feature (plasmid_id, start_pos);
CREATE INDEX sequence_feature_type_idx    ON sequence_feature (type_key);

-- A feature cannot be checked against its plasmid's length in a CHECK, because
-- CHECK sees one row. A trigger is the only correct place for it.
CREATE FUNCTION assert_feature_within_plasmid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  seq_len integer;
  topo    topology;
BEGIN
  SELECT length_bp, topology INTO seq_len, topo FROM plasmid WHERE id = NEW.plasmid_id;
  IF NEW.start_pos >= seq_len OR NEW.end_pos > seq_len THEN
    RAISE EXCEPTION 'feature %..% lies outside the % bp plasmid',
      NEW.start_pos, NEW.end_pos, seq_len;
  END IF;
  IF NEW.wraps_origin AND topo <> 'circular' THEN
    RAISE EXCEPTION 'a feature can only cross the origin of a circular plasmid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sequence_feature_bounds
  BEFORE INSERT OR UPDATE ON sequence_feature
  FOR EACH ROW EXECUTE FUNCTION assert_feature_within_plasmid();

-- The library auto-annotation matches against: standard elements plus whatever
-- the lab has curated. lab_id NULL means a built-in shared by every lab.
CREATE TABLE feature_library_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id      uuid REFERENCES lab(id) ON DELETE CASCADE,
  name        text NOT NULL,
  type_key    text NOT NULL REFERENCES feature_type(key) ON DELETE RESTRICT,
  sequence    dna_sequence,
  peptide     text,                 -- matched in all six frames when present
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_library_has_a_pattern CHECK (sequence IS NOT NULL OR peptide IS NOT NULL),
  CONSTRAINT feature_library_peptide_chars CHECK (peptide IS NULL OR peptide ~ '^[ACDEFGHIKLMNPQRSTVWY*X]+$')
);
CREATE INDEX feature_library_lab_idx ON feature_library_entry (lab_id);

-- -----------------------------------------------------------------------------
-- 5 · Primers
-- -----------------------------------------------------------------------------
-- Again design versus physical: primer is the designed oligo, primer_sample is
-- the tube that arrived from the supplier at a given concentration.
CREATE TABLE primer (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id              uuid NOT NULL REFERENCES lab(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  sequence            dna_sequence NOT NULL,
  length_nt           integer GENERATED ALWAYS AS (length(sequence)) STORED,
  tm_c                numeric(5,2),
  gc_percent          numeric(5,2),
  purpose             text,               -- cloning, sequencing, qPCR, screening
  owner_id            uuid REFERENCES app_user(id) ON DELETE SET NULL,
  designed_in_entry_id uuid REFERENCES notebook_entry(id) ON DELETE SET NULL,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT primer_length_sane CHECK (length(sequence) BETWEEN 6 AND 200),
  CONSTRAINT primer_gc_range CHECK (gc_percent IS NULL OR gc_percent BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX primer_name_key ON primer (lab_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX primer_sequence_idx ON primer (lab_id, sequence);
CREATE TRIGGER primer_touch BEFORE UPDATE ON primer
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Where a primer is intended to sit on a plasmid, and which part of it does not
-- anneal. The 5' tail is the whole point of a cloning primer, so it is stored
-- rather than recomputed: the designer's intent and a later alignment are
-- different facts and can legitimately disagree.
CREATE TABLE primer_binding (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primer_id      uuid NOT NULL REFERENCES primer(id)  ON DELETE CASCADE,
  plasmid_id     uuid NOT NULL REFERENCES plasmid(id) ON DELETE CASCADE,
  start_pos      integer NOT NULL,
  end_pos        integer NOT NULL,
  strand         smallint NOT NULL,
  annealed_nt    integer NOT NULL,
  tail_sequence  dna_sequence NOT NULL DEFAULT '',
  tm_annealed_c  numeric(5,2),
  CONSTRAINT primer_binding_strand CHECK (strand IN (-1, 1)),
  CONSTRAINT primer_binding_span CHECK (end_pos > start_pos),
  CONSTRAINT primer_binding_annealed CHECK (annealed_nt > 0)
);
CREATE UNIQUE INDEX primer_binding_unique ON primer_binding (primer_id, plasmid_id, start_pos, strand);
CREATE INDEX primer_binding_plasmid_idx ON primer_binding (plasmid_id);

-- A pair used together, with the product it is expected to give.
CREATE TABLE primer_pair (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id             uuid NOT NULL REFERENCES lab(id) ON DELETE RESTRICT,
  name               text NOT NULL,
  forward_primer_id  uuid NOT NULL REFERENCES primer(id) ON DELETE RESTRICT,
  reverse_primer_id  uuid NOT NULL REFERENCES primer(id) ON DELETE RESTRICT,
  template_plasmid_id uuid REFERENCES plasmid(id) ON DELETE SET NULL,
  expected_bp        integer,
  annealing_temp_c   numeric(5,2),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT primer_pair_distinct CHECK (forward_primer_id <> reverse_primer_id),
  CONSTRAINT primer_pair_product_positive CHECK (expected_bp IS NULL OR expected_bp > 0)
);
CREATE UNIQUE INDEX primer_pair_name_key ON primer_pair (lab_id, lower(name));

-- -----------------------------------------------------------------------------
-- 6 · CRISPR guides
-- -----------------------------------------------------------------------------
CREATE TABLE guide_rna (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id            uuid NOT NULL REFERENCES lab(id) ON DELETE RESTRICT,
  -- Nullable and SET NULL for the same reason as plasmid.owner_id: a departing
  -- student must not take the lab's guide designs with them.
  owner_id          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  name              text NOT NULL,
  kind              guide_kind NOT NULL DEFAULT 'sgRNA',
  spacer            dna_sequence NOT NULL,
  pam_sequence      dna_sequence NOT NULL,
  pam_pattern       text NOT NULL,          -- 'NGG', 'TTTV', …
  nuclease          text NOT NULL DEFAULT 'SpCas9',
  scaffold          dna_sequence,

  -- A guide targets a plasmid we hold, a genomic locus, or both.
  target_plasmid_id uuid REFERENCES plasmid(id) ON DELETE SET NULL,
  target_strand     smallint,
  target_start      integer,
  cut_position      integer,
  target_genome     text,                    -- 'GRCh38', 'mm39'
  target_locus      text,                    -- 'chr7:5527151-5527174'

  gc_percent        numeric(5,2),
  on_target_score   numeric(6,3),
  designed_in_entry_id uuid REFERENCES notebook_entry(id) ON DELETE SET NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT guide_spacer_length CHECK (length(spacer) BETWEEN 16 AND 30),
  CONSTRAINT guide_strand_valid CHECK (target_strand IS NULL OR target_strand IN (-1, 1)),
  CONSTRAINT guide_needs_a_target CHECK (target_plasmid_id IS NOT NULL OR target_locus IS NOT NULL)
);
CREATE UNIQUE INDEX guide_rna_name_key ON guide_rna (lab_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX guide_rna_plasmid_idx ON guide_rna (target_plasmid_id);
CREATE INDEX guide_rna_spacer_idx  ON guide_rna (lab_id, spacer);
CREATE TRIGGER guide_rna_touch BEFORE UPDATE ON guide_rna
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Prime editing adds a 3' extension to the same guide. Kept in its own table
-- rather than as nullable columns on guide_rna: it is a strict 1:1 extension,
-- and NOT NULL constraints that actually hold are worth a join.
CREATE TABLE pegrna_detail (
  guide_id        uuid PRIMARY KEY REFERENCES guide_rna(id) ON DELETE CASCADE,
  pbs             dna_sequence NOT NULL,
  rt_template     dna_sequence NOT NULL,
  extension       dna_sequence NOT NULL,
  pbs_tm_c        numeric(5,2),
  edit_type       edit_kind NOT NULL,
  edit_position   integer NOT NULL,
  edit_size_bp    integer NOT NULL,
  inserted_bases  dna_sequence,
  nick_position   integer NOT NULL,
  CONSTRAINT pegrna_pbs_length CHECK (length(pbs) BETWEEN 8 AND 20),
  CONSTRAINT pegrna_rtt_length CHECK (length(rt_template) BETWEEN 8 AND 60),
  CONSTRAINT pegrna_edit_size CHECK (edit_size_bp > 0),
  CONSTRAINT pegrna_insertion_has_bases CHECK (
    edit_type <> 'insertion' OR inserted_bases IS NOT NULL
  )
);

CREATE TABLE guide_off_target (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id     uuid NOT NULL REFERENCES guide_rna(id) ON DELETE CASCADE,
  locus        text NOT NULL,
  mismatches   smallint NOT NULL,
  score        numeric(6,3),
  in_cds       boolean,
  found_by     text,                    -- 'Cas-OFFinder', 'CRISPOR', 'in-plasmid scan'
  CONSTRAINT guide_off_target_mismatches CHECK (mismatches BETWEEN 0 AND 10)
);
CREATE INDEX guide_off_target_guide_idx ON guide_off_target (guide_id, mismatches);

-- -----------------------------------------------------------------------------
-- 7 · Physical samples and storage
-- -----------------------------------------------------------------------------
CREATE TABLE storage_box (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id      uuid NOT NULL REFERENCES lab(id) ON DELETE CASCADE,
  name        text NOT NULL,
  freezer     text,
  shelf       text,
  rows_count  smallint NOT NULL DEFAULT 9,
  cols_count  smallint NOT NULL DEFAULT 9,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storage_box_grid CHECK (rows_count BETWEEN 1 AND 26 AND cols_count BETWEEN 1 AND 26)
);
CREATE UNIQUE INDEX storage_box_name_key ON storage_box (lab_id, lower(name));

-- One tube. A plasmid design may have many of these; so may a primer.
CREATE TABLE plasmid_sample (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plasmid_id        uuid NOT NULL REFERENCES plasmid(id) ON DELETE RESTRICT,
  box_id            uuid REFERENCES storage_box(id) ON DELETE SET NULL,
  position          text,                 -- 'A3'
  label             text,
  concentration_ng_ul numeric(10,2),
  volume_ul         numeric(10,2),
  extraction_kit    text,
  host_strain       text,
  prepared_by       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  prepared_on       date,
  prepared_in_entry_id uuid REFERENCES notebook_entry(id) ON DELETE SET NULL,
  is_depleted       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plasmid_sample_position_format CHECK (position IS NULL OR position ~ '^[A-Z]([1-9]|1[0-9]|2[0-6])$'),
  CONSTRAINT plasmid_sample_amounts CHECK (
    (concentration_ng_ul IS NULL OR concentration_ng_ul >= 0) AND
    (volume_ul IS NULL OR volume_ul >= 0)
  )
);
-- One tube per position in a box, but only while it is still there.
CREATE UNIQUE INDEX plasmid_sample_slot ON plasmid_sample (box_id, position)
  WHERE box_id IS NOT NULL AND position IS NOT NULL AND is_depleted = false;
CREATE INDEX plasmid_sample_plasmid_idx ON plasmid_sample (plasmid_id);

-- -----------------------------------------------------------------------------
-- 8 · Attachments
-- -----------------------------------------------------------------------------
-- Exactly one owner, enforced. The alternative — an entity_type/entity_id pair —
-- cannot have a foreign key at all, so orphans accumulate silently.
CREATE TABLE attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id        uuid NOT NULL REFERENCES lab(id) ON DELETE CASCADE,
  entry_id      uuid REFERENCES notebook_entry(id) ON DELETE CASCADE,
  plasmid_id    uuid REFERENCES plasmid(id)        ON DELETE CASCADE,
  guide_id      uuid REFERENCES guide_rna(id)      ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  byte_size     bigint NOT NULL,
  storage_key   text NOT NULL,            -- object-store path, never the bytes
  sha256        bytea,
  uploaded_by   uuid REFERENCES app_user(id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachment_size_positive CHECK (byte_size > 0),
  CONSTRAINT attachment_one_owner CHECK (
    (entry_id IS NOT NULL)::int + (plasmid_id IS NOT NULL)::int + (guide_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX attachment_entry_idx   ON attachment (entry_id);
CREATE INDEX attachment_plasmid_idx ON attachment (plasmid_id);

-- -----------------------------------------------------------------------------
-- 9 · Audit trail
-- -----------------------------------------------------------------------------
-- Append-only, written by trigger so the API cannot forget. Revoke UPDATE and
-- DELETE on this table from the application role.
CREATE TABLE audit_event (
  id          bigserial PRIMARY KEY,
  lab_id      uuid,
  table_name  text NOT NULL,
  row_id      uuid,
  action      text NOT NULL,            -- INSERT | UPDATE | DELETE
  actor_id    uuid,
  before_data jsonb,
  after_data  jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_action_valid CHECK (action IN ('INSERT', 'UPDATE', 'DELETE'))
);
CREATE INDEX audit_event_row_idx  ON audit_event (table_name, row_id, occurred_at DESC);
CREATE INDEX audit_event_lab_idx  ON audit_event (lab_id, occurred_at DESC);

-- The actor comes from a per-request setting the FastAPI dependency sets:
--   SET LOCAL app.current_user_id = '<uuid>';
CREATE FUNCTION record_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  INSERT INTO audit_event (lab_id, table_name, row_id, action, actor_id, before_data, after_data)
  VALUES (
    COALESCE(
      CASE WHEN TG_OP <> 'DELETE' THEN (to_jsonb(NEW) ->> 'lab_id')::uuid END,
      CASE WHEN TG_OP <> 'INSERT' THEN (to_jsonb(OLD) ->> 'lab_id')::uuid END
    ),
    TG_TABLE_NAME,
    COALESCE(
      CASE WHEN TG_OP <> 'DELETE' THEN (to_jsonb(NEW) ->> 'id')::uuid END,
      CASE WHEN TG_OP <> 'INSERT' THEN (to_jsonb(OLD) ->> 'id')::uuid END
    ),
    TG_OP, actor,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER notebook_entry_audit AFTER INSERT OR UPDATE OR DELETE ON notebook_entry
  FOR EACH ROW EXECUTE FUNCTION record_audit_event();
CREATE TRIGGER plasmid_audit AFTER INSERT OR UPDATE OR DELETE ON plasmid
  FOR EACH ROW EXECUTE FUNCTION record_audit_event();
CREATE TRIGGER guide_rna_audit AFTER INSERT OR UPDATE OR DELETE ON guide_rna
  FOR EACH ROW EXECUTE FUNCTION record_audit_event();
CREATE TRIGGER primer_audit AFTER INSERT OR UPDATE OR DELETE ON primer
  FOR EACH ROW EXECUTE FUNCTION record_audit_event();

-- -----------------------------------------------------------------------------
-- 10 · Read models
-- -----------------------------------------------------------------------------
-- Every entry a plasmid appears in, creation included, as one ordered history.
CREATE VIEW plasmid_history AS
  SELECT p.id AS plasmid_id, e.id AS entry_id, 'created'::entry_link_role AS role,
         e.title, e.performed_on, e.author_id
    FROM plasmid p
    JOIN notebook_entry e ON e.id = p.created_in_entry_id
   WHERE p.deleted_at IS NULL
  UNION ALL
  SELECT ep.plasmid_id, e.id, ep.role, e.title, e.performed_on, e.author_id
    FROM entry_plasmid ep
    JOIN notebook_entry e ON e.id = ep.entry_id
   WHERE e.deleted_at IS NULL;

-- Construct genealogy to any depth, for "what was this built from".
CREATE VIEW plasmid_ancestry AS
  WITH RECURSIVE up AS (
    SELECT l.child_id AS root_id, l.parent_id, 1 AS depth
      FROM plasmid_lineage l
    UNION ALL
    SELECT u.root_id, l.parent_id, u.depth + 1
      FROM up u
      JOIN plasmid_lineage l ON l.child_id = u.parent_id
     WHERE u.depth < 20                       -- stops a cycle running away
  )
  SELECT root_id AS plasmid_id, parent_id AS ancestor_id, depth FROM up;

-- -----------------------------------------------------------------------------
-- 11 · Seed data
-- -----------------------------------------------------------------------------
INSERT INTO feature_type (key, label, default_color, is_builtin) VALUES
  ('CDS',          'Coding sequence',   '#b7e1b7', true),
  ('gene',         'Gene',              '#b7e1b7', true),
  ('promoter',     'Promoter',          '#9fd3a0', true),
  ('terminator',   'Terminator',        '#f3a6a6', true),
  ('rep_origin',   'Origin of replication', '#c9b3f0', true),
  ('primer_bind',  'Primer binding site', '#9ec5ef', true),
  ('protein_bind', 'Protein binding site', '#f2e39a', true),
  ('regulatory',   'Regulatory element', '#f6cf9a', true),
  ('polyA_signal', 'PolyA signal',      '#f0b6dd', true),
  ('LTR',          'Long terminal repeat', '#b9bdf0', true),
  ('tag',          'Epitope or purification tag', '#f5f09a', true),
  ('gRNA',         'Guide RNA target',  '#ffb347', true),
  ('pegRNA',       'Prime editing guide target', '#ff9a3c', true),
  ('misc_feature', 'Other feature',     '#d7d7d7', true),
  -- INSDC keys that real GenBank files carry. Added by migration 0002 as
  -- well, idempotently, for databases built before it existed.
  ('source',         'Source',                    '#eeeeee', true),
  ('5''UTR',         '5'' untranslated region',   '#cfe3f7', true),
  ('3''UTR',         '3'' untranslated region',   '#cfe3f7', true),
  ('RBS',            'Ribosome binding site',     '#cde8b5', true),
  ('sig_peptide',    'Signal peptide',            '#e5d4f5', true),
  ('mat_peptide',    'Mature peptide',            '#d9c2ef', true),
  ('intron',         'Intron',                    '#e8e8c0', true),
  ('exon',           'Exon',                      '#c7e3c7', true),
  ('enhancer',       'Enhancer',                  '#f6c99a', true),
  ('misc_RNA',       'Other RNA',                 '#f0c0e0', true),
  ('ncRNA',          'Non-coding RNA',            '#efb8d8', true),
  ('tRNA',           'Transfer RNA',              '#e8aed0', true),
  ('rRNA',           'Ribosomal RNA',             '#e1a4c8', true),
  ('polyA_site',     'PolyA site',                '#f0b6dd', true),
  ('repeat_region',  'Repeat region',             '#d5d5ea', true),
  ('mobile_element', 'Mobile element',            '#c3c3e4', true),
  ('misc_binding',   'Other binding site',        '#f2e39a', true),
  ('misc_recomb',    'Recombination site',        '#ffd9a0', true),
  ('oriT',           'Origin of transfer',        '#c9b3f0', true),
  ('stem_loop',      'Stem loop',                 '#bcd9d9', true),
  ('CDS_motif',      'Coding sequence motif',     '#c7ddc7', true),
  ('assembly_gap',   'Assembly gap',              '#d0d0d0', true);
