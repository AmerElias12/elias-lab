"""Keep the PCR products and assemblies the molecular tool works out.

Revision ID: 0004_constructions
Revises: 0003_refresh_tokens
Created: 2026-10-15

js/plasmid.js computes the product of an amplification and the primers for a
Gibson; until now that lived for as long as the tab stayed open. primer_pair
gains the product it was always implying, and assembly/assembly_fragment hold
a design: the ordered pieces, the overlaps, the primers worked out for each.

plasmid_lineage already records that a construct came from its parents. That
is provenance — what happened. This is what was *planned*, which is the thing
somebody needs when an assembly gives no colonies.

Idempotent, like the others: docs/*.sql already describe these, so a database
built today gets them from revision 0001 and arrives here with nothing to do.
"""
from __future__ import annotations

from alembic import op

revision = "0004_constructions"
down_revision = "0003_refresh_tokens"
branch_labels = None
depends_on = None

NEW_PRIMER_PAIR_COLUMNS = (
    ("product_start", "integer"),
    ("product_end", "integer"),
    ("product_sequence", "dna_sequence"),
    ("product_plasmid_id", "uuid REFERENCES plasmid(id) ON DELETE SET NULL"),
    ("designed_in_entry_id", "uuid REFERENCES notebook_entry(id) ON DELETE SET NULL"),
    ("notes", "text"),
    ("updated_at", "timestamptz NOT NULL DEFAULT now()"),
    ("deleted_at", "timestamptz"),
)


def upgrade() -> None:
    for name, decl in NEW_PRIMER_PAIR_COLUMNS:
        op.execute(f"ALTER TABLE primer_pair ADD COLUMN IF NOT EXISTS {name} {decl}")

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assembly (
          id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          lab_id             uuid NOT NULL REFERENCES lab(id) ON DELETE RESTRICT,
          owner_id           uuid REFERENCES app_user(id) ON DELETE SET NULL,
          is_shared          boolean NOT NULL DEFAULT true,
          name               text NOT NULL,
          method             construction_kind NOT NULL DEFAULT 'gibson',
          overlap_bp         integer,
          product_plasmid_id uuid REFERENCES plasmid(id) ON DELETE SET NULL,
          product_bp         integer,
          product_sequence   dna_sequence,
          designed_in_entry_id uuid REFERENCES notebook_entry(id) ON DELETE SET NULL,
          notes              text,
          created_at         timestamptz NOT NULL DEFAULT now(),
          updated_at         timestamptz NOT NULL DEFAULT now(),
          deleted_at         timestamptz,
          CONSTRAINT assembly_name_present CHECK (length(btrim(name)) > 0),
          CONSTRAINT assembly_overlap_sane
            CHECK (overlap_bp IS NULL OR overlap_bp BETWEEN 10 AND 120)
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS assembly_name_key "
        "  ON assembly (lab_id, lower(name)) WHERE deleted_at IS NULL"
    )
    op.execute("CREATE INDEX IF NOT EXISTS assembly_lab_idx ON assembly (lab_id)")
    op.execute("CREATE INDEX IF NOT EXISTS assembly_product_idx ON assembly (product_plasmid_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS assembly_lab_owner_idx ON assembly (lab_id, owner_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS assembly_fragment (
          id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          assembly_id       uuid NOT NULL REFERENCES assembly(id) ON DELETE CASCADE,
          ordinal           smallint NOT NULL,
          name              text NOT NULL,
          source_plasmid_id uuid REFERENCES plasmid(id) ON DELETE SET NULL,
          start_pos         integer,
          end_pos           integer,
          length_bp         integer,
          forward_primer_id uuid REFERENCES primer(id) ON DELETE SET NULL,
          reverse_primer_id uuid REFERENCES primer(id) ON DELETE SET NULL,
          overlap_sequence  dna_sequence,
          note              text,
          CONSTRAINT assembly_fragment_ordinal_positive CHECK (ordinal >= 1),
          CONSTRAINT assembly_fragment_length_positive
            CHECK (length_bp IS NULL OR length_bp > 0)
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS assembly_fragment_order_key "
        "  ON assembly_fragment (assembly_id, ordinal)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS assembly_fragment_assembly_idx "
        "  ON assembly_fragment (assembly_id)"
    )

    for table in ("assembly", "assembly_fragment"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO eln_app")

    # An assembly is owned and shareable, like a plasmid: mine, or shared with
    # the lab, or anything if I administer it.
    for name, body in (
        (
            "assembly_select",
            "FOR SELECT USING (lab_id = (SELECT current_lab()) AND (SELECT can_read()) "
            "  AND ((SELECT owns(owner_id)) OR is_shared OR (SELECT can_administer())))",
        ),
        (
            "assembly_insert",
            "FOR INSERT WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_write()) "
            "  AND ((SELECT owns(owner_id)) OR (SELECT can_administer())))",
        ),
        (
            "assembly_update",
            "FOR UPDATE USING (lab_id = (SELECT current_lab()) AND (SELECT can_write()) "
            "  AND ((SELECT owns(owner_id)) OR (SELECT can_administer()))) "
            "WITH CHECK (lab_id = (SELECT current_lab()) "
            "  AND ((SELECT owns(owner_id)) OR (SELECT can_administer())))",
        ),
        (
            "assembly_delete",
            "FOR DELETE USING (lab_id = (SELECT current_lab()) "
            "  AND ((SELECT owns(owner_id)) OR (SELECT can_administer())))",
        ),
    ):
        op.execute(f"DROP POLICY IF EXISTS {name} ON assembly")
        op.execute(f"CREATE POLICY {name} ON assembly {body}")

    # The restrictive floor, as on every other owned table: ANDed with
    # everything, so no policy added later can reach another lab.
    op.execute("DROP POLICY IF EXISTS assembly_in_lab ON assembly")
    op.execute(
        "CREATE POLICY assembly_in_lab ON assembly AS RESTRICTIVE FOR ALL "
        "  USING      (lab_id = (SELECT current_lab()) AND (SELECT can_read())) "
        "  WITH CHECK (lab_id = (SELECT current_lab()) AND (SELECT can_read()))"
    )

    # A fragment is reachable exactly when its assembly is.
    op.execute("DROP POLICY IF EXISTS assembly_fragment_all ON assembly_fragment")
    op.execute(
        """
        CREATE POLICY assembly_fragment_all ON assembly_fragment FOR ALL
          USING (EXISTS (SELECT 1 FROM assembly a
                          WHERE a.id = assembly_fragment.assembly_id
                            AND a.lab_id = (SELECT current_lab())))
          WITH CHECK ((SELECT can_write()) AND EXISTS (
                    SELECT 1 FROM assembly a
                     WHERE a.id = assembly_fragment.assembly_id
                       AND a.lab_id = (SELECT current_lab())))
        """
    )


def downgrade() -> None:
    """Drop the assemblies and the product columns.

    This loses designs. The amplifications themselves survive — primer_pair
    keeps its primers, template and expected size — but what the product was
    goes with the columns.
    """
    op.execute("DROP TABLE IF EXISTS assembly_fragment")
    op.execute("DROP TABLE IF EXISTS assembly")
    for name, _ in NEW_PRIMER_PAIR_COLUMNS:
        op.execute(f"ALTER TABLE primer_pair DROP COLUMN IF EXISTS {name}")
