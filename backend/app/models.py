"""SQLAlchemy models for the four domains: identity, notebook entries, plasmid
vectors and CRISPR designs.

Mapped against docs/eln-schema.sql. The database owns the invariants — CHECK
constraints, the dna_sequence domain, the generated columns, the audit
triggers — and these classes describe them so the ORM does not fight them.
Where a constraint is repeated here it is for the error message, not because
the database is trusted any less.

Loading strategy: every relationship is lazy="raise". Under asyncio a lazy load
raises MissingGreenlet at some unrelated line; making it raise immediately and
by name means the query that forgot its selectinload fails in development
rather than in a request. Load what you need with selectinload/joinedload.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import (
    Base,
    ConstructionKind,
    EditKind,
    EntryLinkRole,
    EntryStatus,
    GuideKind,
    LabRole,
    LabScopedMixin,
    OwnedMixin,
    PrimaryKeyMixin,
    ShareableMixin,
    SignatureRole,
    SoftDeleteMixin,
    TimestampMixin,
    Topology,
    pg_enum,
)

# A column type matching the dna_sequence DOMAIN. The CHECK lives in the
# database; this is just the storage type.
DnaSequence = sa.Text


# ===========================================================================
# 1 · Identity and tenancy
# ===========================================================================
class Lab(Base, PrimaryKeyMixin, TimestampMixin):
    __tablename__ = "lab"

    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    slug: Mapped[str] = mapped_column(sa.Text, nullable=False, unique=True)

    members: Mapped[list["LabMember"]] = relationship(back_populates="lab", lazy="raise")


class User(Base, PrimaryKeyMixin, TimestampMixin):
    """Authentication lives here. hashed_password never leaves this layer: no
    Pydantic read schema exposes it, which is why it has no `read` counterpart."""

    __tablename__ = "app_user"

    email: Mapped[str] = mapped_column(sa.Text, nullable=False)
    full_name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    hashed_password: Mapped[str] = mapped_column(sa.Text, nullable=False)
    orcid: Mapped[str | None] = mapped_column(sa.Text)
    is_active: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, server_default=sa.true())
    is_superuser: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, server_default=sa.false())
    last_login_at: Mapped[datetime | None] = mapped_column(sa.TIMESTAMP(timezone=True))

    memberships: Mapped[list["LabMember"]] = relationship(back_populates="user", lazy="raise")

    __table_args__ = (
        sa.Index("app_user_email_key", sa.func.lower(sa.column("email")), unique=True),
    )


class LabMember(Base):
    """Which labs a person belongs to, and with what rights. The composite key
    is the membership: a person cannot hold two roles in one lab."""

    __tablename__ = "lab_member"

    lab_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("lab.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[LabRole] = mapped_column(
        pg_enum(LabRole, "lab_role"), nullable=False, server_default="member"
    )
    joined_at: Mapped[datetime] = mapped_column(
        sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.func.now()
    )

    lab: Mapped[Lab] = relationship(back_populates="members", lazy="raise")
    user: Mapped[User] = relationship(back_populates="memberships", lazy="raise")


class Project(Base, PrimaryKeyMixin, LabScopedMixin, TimestampMixin):
    __tablename__ = "project"

    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    description: Mapped[str | None] = mapped_column(sa.Text)
    lead_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="SET NULL")
    )
    is_archived: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, server_default=sa.false())


# ===========================================================================
# 2 · Notebook entries
# ===========================================================================
class NotebookEntry(
    Base, PrimaryKeyMixin, LabScopedMixin, ShareableMixin, TimestampMixin, SoftDeleteMixin
):
    """The stable identity of an entry and its current state. The text of each
    revision lives in NotebookEntryVersion, which is append-only."""

    __tablename__ = "notebook_entry"

    project_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("project.id", ondelete="SET NULL"), index=True
    )
    # The author is this model's owner column; it is NOT NULL because an entry
    # without an author is not a record, so OwnedMixin's nullable owner_id does
    # not fit and the column is spelled out.
    author_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(sa.Text, nullable=False)

    hypothesis: Mapped[str | None] = mapped_column(sa.Text)
    methods: Mapped[str | None] = mapped_column(sa.Text)
    results: Mapped[str | None] = mapped_column(sa.Text)
    conclusions: Mapped[str | None] = mapped_column(sa.Text)
    next_steps: Mapped[str | None] = mapped_column(sa.Text)

    body: Mapped[dict] = mapped_column(pg.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb"))
    body_text: Mapped[str] = mapped_column(sa.Text, nullable=False, server_default="")

    status: Mapped[EntryStatus] = mapped_column(
        pg_enum(EntryStatus, "entry_status"), nullable=False, server_default="draft"
    )
    current_version: Mapped[int] = mapped_column(sa.Integer, nullable=False, server_default="1")
    performed_on: Mapped[date | None] = mapped_column(sa.Date)
    superseded_by_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="SET NULL")
    )

    author: Mapped[User] = relationship(lazy="raise", foreign_keys=[author_id])
    project: Mapped[Project | None] = relationship(lazy="raise")
    versions: Mapped[list["NotebookEntryVersion"]] = relationship(
        back_populates="entry", lazy="raise", order_by="NotebookEntryVersion.version_no",
        cascade="all, delete-orphan",
    )
    # A signature points at (entry_id, version_no) together, so there is no plain
    # foreign key from here to it and the join has to be spelled out. viewonly
    # because signing is an explicit act against one version, never a side
    # effect of appending to a collection.
    signatures: Mapped[list["EntrySignature"]] = relationship(
        lazy="raise",
        primaryjoin="NotebookEntry.id == foreign(EntrySignature.entry_id)",
        viewonly=True,
        order_by="EntrySignature.signed_at",
    )
    # Plasmids mentioned in this entry. The one it *created* is on Plasmid.
    plasmid_links: Mapped[list["EntryPlasmid"]] = relationship(
        back_populates="entry", lazy="raise", cascade="all, delete-orphan"
    )

    # search_tsv is a generated tsvector used only by the GIN index. It is left
    # unmapped so no query drags the vector across the wire; rank with
    # sa.text("search_tsv @@ plainto_tsquery('english', :q)") instead.


class NotebookEntryVersion(Base):
    """Append-only. content_sha256 is what a signature commits to, so a later
    edit can never be passed off as the text somebody witnessed."""

    __tablename__ = "notebook_entry_version"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="CASCADE"), primary_key=True
    )
    version_no: Mapped[int] = mapped_column(sa.Integer, primary_key=True)
    # The snapshot. See the table comment in docs/eln-schema.sql: a signature
    # is only worth what the snapshot covers.
    title: Mapped[str] = mapped_column(sa.Text, nullable=False, server_default="")
    hypothesis: Mapped[str | None] = mapped_column(sa.Text)
    methods: Mapped[str | None] = mapped_column(sa.Text)
    results: Mapped[str | None] = mapped_column(sa.Text)
    conclusions: Mapped[str | None] = mapped_column(sa.Text)
    next_steps: Mapped[str | None] = mapped_column(sa.Text)
    performed_on: Mapped[date | None] = mapped_column(sa.Date)
    body: Mapped[dict] = mapped_column(pg.JSONB, nullable=False)
    body_text: Mapped[str] = mapped_column(sa.Text, nullable=False, server_default="")
    change_note: Mapped[str | None] = mapped_column(sa.Text)
    content_sha256: Mapped[bytes] = mapped_column(sa.LargeBinary, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.func.now()
    )

    entry: Mapped[NotebookEntry] = relationship(back_populates="versions", lazy="raise")


class EntrySignature(Base, PrimaryKeyMixin):
    """Binds one person to one exact version. Witnessing is a second row with a
    different role, which is why role is part of the uniqueness."""

    __tablename__ = "entry_signature"

    entry_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid(as_uuid=True), nullable=False, index=True)
    version_no: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    signer_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[SignatureRole] = mapped_column(
        pg_enum(SignatureRole, "signature_role"), nullable=False
    )
    statement: Mapped[str] = mapped_column(sa.Text, nullable=False)
    content_sha256: Mapped[bytes] = mapped_column(sa.LargeBinary, nullable=False)
    signed_at: Mapped[datetime] = mapped_column(
        sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.func.now()
    )

    __table_args__ = (
        sa.ForeignKeyConstraint(
            ["entry_id", "version_no"],
            ["notebook_entry_version.entry_id", "notebook_entry_version.version_no"],
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("entry_id", "version_no", "signer_id", "role",
                            name="entry_signature_once_per_role"),
    )


# ===========================================================================
# 3 · Plasmid vectors
# ===========================================================================
class Plasmid(
    Base, PrimaryKeyMixin, LabScopedMixin, OwnedMixin, ShareableMixin,
    TimestampMixin, SoftDeleteMixin,
):
    """The construct as a design. The tube in the freezer is PlasmidSample — one
    design routinely has several aliquots in different boxes."""

    __tablename__ = "plasmid"

    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    alias: Mapped[str | None] = mapped_column(sa.Text)
    sequence: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    topology: Mapped[Topology] = mapped_column(
        pg_enum(Topology, "topology"), nullable=False, server_default="circular"
    )
    # Generated by the database. Computed() marks it read-only, so SQLAlchemy
    # leaves it out of INSERT and UPDATE.
    length_bp: Mapped[int] = mapped_column(
        sa.Integer, sa.Computed("length(sequence)", persisted=True)
    )
    backbone: Mapped[str | None] = mapped_column(sa.Text)
    insert_description: Mapped[str | None] = mapped_column(sa.Text)
    selection_markers: Mapped[list[str]] = mapped_column(
        pg.ARRAY(sa.Text), nullable=False, server_default=sa.text("'{}'")
    )
    host_strain: Mapped[str | None] = mapped_column(sa.Text)

    # --- provenance --------------------------------------------------------
    # Where this construct was made. RESTRICT because losing the record of how
    # it was built is worse than refusing the delete.
    created_in_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="RESTRICT"), index=True
    )
    construction_method: Mapped[ConstructionKind | None] = mapped_column(
        pg_enum(ConstructionKind, "construction_kind")
    )
    external_source: Mapped[str | None] = mapped_column(sa.Text)
    external_reference: Mapped[str | None] = mapped_column(sa.Text)

    map_url: Mapped[str | None] = mapped_column(sa.Text)
    notes: Mapped[str | None] = mapped_column(sa.Text)

    created_in_entry: Mapped[NotebookEntry | None] = relationship(
        lazy="raise", foreign_keys=[created_in_entry_id]
    )
    features: Mapped[list["SequenceFeature"]] = relationship(
        back_populates="plasmid", lazy="raise", cascade="all, delete-orphan",
        order_by="SequenceFeature.start_pos",
    )
    entry_links: Mapped[list["EntryPlasmid"]] = relationship(
        back_populates="plasmid", lazy="raise", cascade="all, delete-orphan"
    )
    parents: Mapped[list["PlasmidLineage"]] = relationship(
        back_populates="child", lazy="raise",
        foreign_keys="PlasmidLineage.child_id", cascade="all, delete-orphan",
    )


class EntryPlasmid(Base):
    """Every appearance of a plasmid in the notebook other than its creation:
    used in a transfection, re-sequenced, modified. Many-to-many with a role, so
    it is an association object rather than a bare secondary table."""

    __tablename__ = "entry_plasmid"

    entry_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="CASCADE"), primary_key=True
    )
    plasmid_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[EntryLinkRole] = mapped_column(
        pg_enum(EntryLinkRole, "entry_link_role"), primary_key=True, server_default="used"
    )
    note: Mapped[str | None] = mapped_column(sa.Text)

    entry: Mapped[NotebookEntry] = relationship(back_populates="plasmid_links", lazy="raise")
    plasmid: Mapped[Plasmid] = relationship(back_populates="entry_links", lazy="raise")


class PlasmidLineage(Base):
    """Construct genealogy. Many-to-many because a Gibson product has several
    parents; ordinal keeps them in assembly order."""

    __tablename__ = "plasmid_lineage"

    child_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="CASCADE"), primary_key=True
    )
    parent_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="RESTRICT"), primary_key=True, index=True
    )
    ordinal: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False, server_default="1")
    method: Mapped[ConstructionKind | None] = mapped_column(
        pg_enum(ConstructionKind, "construction_kind")
    )
    note: Mapped[str | None] = mapped_column(sa.Text)

    child: Mapped[Plasmid] = relationship(
        back_populates="parents", lazy="raise", foreign_keys=[child_id]
    )
    parent: Mapped[Plasmid] = relationship(lazy="raise", foreign_keys=[parent_id])


class FeatureType(Base):
    __tablename__ = "feature_type"

    key: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    label: Mapped[str] = mapped_column(sa.Text, nullable=False)
    default_color: Mapped[str] = mapped_column(sa.Text, nullable=False, server_default="#d7d7d7")
    is_builtin: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, server_default=sa.false())


class SequenceFeature(Base, PrimaryKeyMixin):
    """Coordinates are 0-based half-open [start_pos, end_pos). A feature crossing
    the origin has wraps_origin = True, and then end_pos <= start_pos. A trigger
    in the database checks it fits the plasmid, which a CHECK cannot do."""

    __tablename__ = "sequence_feature"

    plasmid_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    type_key: Mapped[str] = mapped_column(
        sa.ForeignKey("feature_type.key", ondelete="RESTRICT"), nullable=False, index=True
    )
    start_pos: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    end_pos: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    strand: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False, server_default="1")
    wraps_origin: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, server_default=sa.false()
    )
    color: Mapped[str | None] = mapped_column(sa.Text)
    note: Mapped[str | None] = mapped_column(sa.Text)
    annotated_by: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="SET NULL")
    )
    annotation_source: Mapped[str] = mapped_column(
        sa.Text, nullable=False, server_default="manual"
    )
    created_at: Mapped[datetime] = mapped_column(
        sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.func.now()
    )

    plasmid: Mapped[Plasmid] = relationship(back_populates="features", lazy="raise")
    feature_type: Mapped[FeatureType] = relationship(lazy="raise")


class PlasmidSample(Base, PrimaryKeyMixin):
    """One tube. Separate from Plasmid on purpose: the design is a sequence, the
    sample is a physical thing with a concentration that runs out."""

    __tablename__ = "plasmid_sample"

    plasmid_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    box_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("storage_box.id", ondelete="SET NULL")
    )
    position: Mapped[str | None] = mapped_column(sa.Text)
    label: Mapped[str | None] = mapped_column(sa.Text)
    concentration_ng_ul: Mapped[Decimal | None] = mapped_column(sa.Numeric(10, 2))
    volume_ul: Mapped[Decimal | None] = mapped_column(sa.Numeric(10, 2))
    extraction_kit: Mapped[str | None] = mapped_column(sa.Text)
    host_strain: Mapped[str | None] = mapped_column(sa.Text)
    prepared_by: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("app_user.id", ondelete="SET NULL")
    )
    prepared_on: Mapped[date | None] = mapped_column(sa.Date)
    prepared_in_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="SET NULL")
    )
    is_depleted: Mapped[bool] = mapped_column(sa.Boolean, nullable=False, server_default=sa.false())
    created_at: Mapped[datetime] = mapped_column(
        sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.func.now()
    )

    plasmid: Mapped[Plasmid] = relationship(lazy="raise")


class StorageBox(Base, PrimaryKeyMixin, LabScopedMixin):
    __tablename__ = "storage_box"

    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    freezer: Mapped[str | None] = mapped_column(sa.Text)
    shelf: Mapped[str | None] = mapped_column(sa.Text)
    rows_count: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False, server_default="9")
    cols_count: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False, server_default="9")
    created_at: Mapped[datetime] = mapped_column(
        sa.TIMESTAMP(timezone=True), nullable=False, server_default=sa.func.now()
    )


# ===========================================================================
# 4 · Primers
# ===========================================================================
class Primer(
    Base, PrimaryKeyMixin, LabScopedMixin, OwnedMixin, ShareableMixin,
    TimestampMixin, SoftDeleteMixin,
):
    __tablename__ = "primer"

    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    sequence: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    length_nt: Mapped[int] = mapped_column(
        sa.Integer, sa.Computed("length(sequence)", persisted=True)
    )
    tm_c: Mapped[Decimal | None] = mapped_column(sa.Numeric(5, 2))
    gc_percent: Mapped[Decimal | None] = mapped_column(sa.Numeric(5, 2))
    purpose: Mapped[str | None] = mapped_column(sa.Text)
    designed_in_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="SET NULL")
    )
    notes: Mapped[str | None] = mapped_column(sa.Text)

    bindings: Mapped[list["PrimerBinding"]] = relationship(
        back_populates="primer", lazy="raise", cascade="all, delete-orphan"
    )


class PrimerBinding(Base, PrimaryKeyMixin):
    """Where a primer is meant to sit, and which part of it does not anneal. The
    5' tail is stored rather than recomputed: the designer's intent and a later
    alignment are different facts and may legitimately disagree."""

    __tablename__ = "primer_binding"

    primer_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("primer.id", ondelete="CASCADE"), nullable=False
    )
    plasmid_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_pos: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    end_pos: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    strand: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False)
    annealed_nt: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    tail_sequence: Mapped[str] = mapped_column(DnaSequence, nullable=False, server_default="")
    tm_annealed_c: Mapped[Decimal | None] = mapped_column(sa.Numeric(5, 2))

    primer: Mapped[Primer] = relationship(back_populates="bindings", lazy="raise")
    plasmid: Mapped[Plasmid] = relationship(lazy="raise")


# ===========================================================================
# 5 · CRISPR designs
# ===========================================================================
class GuideRNA(
    Base, PrimaryKeyMixin, LabScopedMixin, OwnedMixin, ShareableMixin,
    TimestampMixin, SoftDeleteMixin,
):
    """An sgRNA, pegRNA or nicking guide. A guide targets a plasmid we hold, a
    genomic locus, or both — the database refuses one with neither."""

    __tablename__ = "guide_rna"

    name: Mapped[str] = mapped_column(sa.Text, nullable=False)
    kind: Mapped[GuideKind] = mapped_column(
        pg_enum(GuideKind, "guide_kind"), nullable=False, server_default="sgRNA"
    )
    spacer: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    pam_sequence: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    pam_pattern: Mapped[str] = mapped_column(sa.Text, nullable=False)
    nuclease: Mapped[str] = mapped_column(sa.Text, nullable=False, server_default="SpCas9")
    scaffold: Mapped[str | None] = mapped_column(DnaSequence)

    target_plasmid_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("plasmid.id", ondelete="SET NULL"), index=True
    )
    target_strand: Mapped[int | None] = mapped_column(sa.SmallInteger)
    target_start: Mapped[int | None] = mapped_column(sa.Integer)
    cut_position: Mapped[int | None] = mapped_column(sa.Integer)
    target_genome: Mapped[str | None] = mapped_column(sa.Text)
    target_locus: Mapped[str | None] = mapped_column(sa.Text)

    gc_percent: Mapped[Decimal | None] = mapped_column(sa.Numeric(5, 2))
    on_target_score: Mapped[Decimal | None] = mapped_column(sa.Numeric(6, 3))
    designed_in_entry_id: Mapped[uuid.UUID | None] = mapped_column(
        sa.ForeignKey("notebook_entry.id", ondelete="SET NULL")
    )
    notes: Mapped[str | None] = mapped_column(sa.Text)

    target_plasmid: Mapped[Plasmid | None] = relationship(lazy="raise")
    # One-to-one: a pegRNA is the same guide with a 3' extension.
    pegrna: Mapped["PegRNADetail | None"] = relationship(
        back_populates="guide", lazy="raise", uselist=False, cascade="all, delete-orphan"
    )
    off_targets: Mapped[list["GuideOffTarget"]] = relationship(
        back_populates="guide", lazy="raise", cascade="all, delete-orphan"
    )


class PegRNADetail(Base):
    """The prime-editing extension. A separate table rather than nullable columns
    on GuideRNA: it is a strict 1:1, and NOT NULL constraints that actually hold
    are worth the join."""

    __tablename__ = "pegrna_detail"

    guide_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("guide_rna.id", ondelete="CASCADE"), primary_key=True
    )
    pbs: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    rt_template: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    extension: Mapped[str] = mapped_column(DnaSequence, nullable=False)
    pbs_tm_c: Mapped[Decimal | None] = mapped_column(sa.Numeric(5, 2))
    edit_type: Mapped[EditKind] = mapped_column(pg_enum(EditKind, "edit_kind"), nullable=False)
    edit_position: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    edit_size_bp: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    inserted_bases: Mapped[str | None] = mapped_column(DnaSequence)
    nick_position: Mapped[int] = mapped_column(sa.Integer, nullable=False)

    guide: Mapped[GuideRNA] = relationship(back_populates="pegrna", lazy="raise")


class GuideOffTarget(Base, PrimaryKeyMixin):
    __tablename__ = "guide_off_target"

    guide_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("guide_rna.id", ondelete="CASCADE"), nullable=False, index=True
    )
    locus: Mapped[str] = mapped_column(sa.Text, nullable=False)
    mismatches: Mapped[int] = mapped_column(sa.SmallInteger, nullable=False)
    score: Mapped[Decimal | None] = mapped_column(sa.Numeric(6, 3))
    in_cds: Mapped[bool | None] = mapped_column(sa.Boolean)
    found_by: Mapped[str | None] = mapped_column(sa.Text)

    guide: Mapped[GuideRNA] = relationship(back_populates="off_targets", lazy="raise")
