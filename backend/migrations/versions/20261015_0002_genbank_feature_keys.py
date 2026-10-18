"""Add the GenBank feature keys that real files actually use.

Revision ID: 0002_genbank_feature_keys
Revises: 0001_initial_schema
Created: 2026-10-15

feature_type started with fourteen curated keys. Importing a GenBank file
showed that to be too few: `source` appears in essentially every one, and a
plasmid from a vendor routinely carries 5'UTR, sig_peptide, intron, enhancer
and RBS. All of them were landing on misc_feature, which draws every one of
them the same grey and throws away what the file knew.

These are INSDC feature keys — the controlled vocabulary GenBank, ENA and DDBJ
share — so the list is fixed and not a matter of taste. The colours follow the
ones already in the table: related things related, and nothing so close to a
neighbour that the two cannot be told apart on a map.

The application still coerces an unknown key to misc_feature rather than
failing, and that stays: this shortens the list of things that get coerced, it
does not remove the need for a fallback.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_genbank_feature_keys"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None

# key, label, colour
KEYS = [
    ("source",          "Source",                    "#eeeeee"),
    ("5'UTR",           "5' untranslated region",    "#cfe3f7"),
    ("3'UTR",           "3' untranslated region",    "#cfe3f7"),
    ("RBS",             "Ribosome binding site",     "#cde8b5"),
    ("sig_peptide",     "Signal peptide",            "#e5d4f5"),
    ("mat_peptide",     "Mature peptide",            "#d9c2ef"),
    ("intron",          "Intron",                    "#e8e8c0"),
    ("exon",            "Exon",                      "#c7e3c7"),
    ("enhancer",        "Enhancer",                  "#f6c99a"),
    ("misc_RNA",        "Other RNA",                 "#f0c0e0"),
    ("ncRNA",           "Non-coding RNA",            "#efb8d8"),
    ("tRNA",            "Transfer RNA",              "#e8aed0"),
    ("rRNA",            "Ribosomal RNA",             "#e1a4c8"),
    ("polyA_site",      "PolyA site",                "#f0b6dd"),
    ("repeat_region",   "Repeat region",             "#d5d5ea"),
    ("mobile_element",  "Mobile element",            "#c3c3e4"),
    ("misc_binding",    "Other binding site",        "#f2e39a"),
    ("misc_recomb",     "Recombination site",        "#ffd9a0"),
    ("oriT",            "Origin of transfer",        "#c9b3f0"),
    ("stem_loop",       "Stem loop",                 "#bcd9d9"),
    ("CDS_motif",       "Coding sequence motif",     "#c7ddc7"),
    ("assembly_gap",    "Assembly gap",              "#d0d0d0"),
]


def upgrade() -> None:
    # Bound parameters, not an f-string. The first version of this built the
    # VALUES list by interpolation and escaped the apostrophe in the key but
    # not the one in "5' untranslated region", which PostgreSQL read as the
    # end of a literal. Parameters remove the question.
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO feature_type (key, label, default_color, is_builtin) "
            "VALUES (:key, :label, :color, true) "
            # Safe on a database where somebody added one by hand, and safe to
            # re-run.
            "ON CONFLICT (key) DO NOTHING"
        ),
        [{"key": k, "label": lb, "color": c} for k, lb, c in KEYS],
    )


def downgrade() -> None:
    """Put the features back on misc_feature before taking their type away.

    sequence_feature.type_key references these rows, so deleting a key that is
    in use would fail on the foreign key — and the rows using it belong to the
    lab, not to this migration. Re-pointing them first means the downgrade
    loses the distinction but never the feature.
    """
    conn = op.get_bind()
    keys = [k for k, _, _ in KEYS]
    conn.execute(
        sa.text(
            "UPDATE sequence_feature SET type_key = 'misc_feature' "
            " WHERE type_key = ANY(:keys)"
        ),
        {"keys": keys},
    )
    conn.execute(
        sa.text("DELETE FROM feature_type WHERE key = ANY(:keys)"),
        {"keys": keys},
    )
