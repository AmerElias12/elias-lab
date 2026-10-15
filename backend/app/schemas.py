"""Pydantic v2 schemas.

Each resource gets three shapes, and the split is not ceremony:

  * Create — what a client may send. No id, no lab_id, no owner_id: the server
    takes those from the authenticated session, so a client cannot write a row
    into somebody else's lab by putting their id in the body.
  * Update — every field optional. Apply with model_dump(exclude_unset=True) so
    "not sent" and "set to null" stay different things.
  * Read   — what goes back out. from_attributes=True reads ORM objects.

hashed_password appears in no Read model anywhere in this file, which is the
point: there is no shape that can serialise it by accident.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.db import (
    ConstructionKind,
    EditKind,
    EntryLinkRole,
    EntryStatus,
    GuideKind,
    LabRole,
    SignatureRole,
    Topology,
)

IUPAC = re.compile(r"^[ACGTURYSWKMBDHVN]*$")


class ApiModel(BaseModel):
    """Reject unknown keys rather than silently dropping them: a client sending
    `owner_id` to a Create schema should be told it is not accepted, not have it
    quietly ignored."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ReadModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


# ---------------------------------------------------------------------------
# Shared validators
# ---------------------------------------------------------------------------
def _clean_dna(v: str) -> str:
    """Accept what people actually paste — a GenBank block, line numbers, spaces
    — and store the bases. Mirrors the dna_sequence domain, which rejects
    anything that gets past this."""
    s = re.sub(r"[\s\d]", "", str(v)).upper()
    if not IUPAC.match(s):
        bad = sorted(set(re.sub(r"[ACGTURYSWKMBDHVN]", "", s)))
        raise ValueError(f"not a DNA sequence; unexpected {''.join(bad)!r}")
    return s


DnaStr = Annotated[str, Field(min_length=1)]


# ---------------------------------------------------------------------------
# 1 · Authentication
# ---------------------------------------------------------------------------
class UserCreate(ApiModel):
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=12, max_length=200)
    orcid: str | None = Field(default=None, pattern=r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")

    @field_validator("password")
    @classmethod
    def password_is_not_trivial(cls, v: str) -> str:
        # Length does the heavy lifting; this only blocks the obvious.
        if v.lower() in {"password1234", "123456789012", "qwertyuiop12"}:
            raise ValueError("choose a less common password")
        if len(set(v)) < 5:
            raise ValueError("password repeats too few distinct characters")
        return v


class UserUpdate(ApiModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    orcid: str | None = Field(default=None, pattern=r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")
    is_active: bool | None = None


class PasswordChange(ApiModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=200)


class UserRead(ReadModel):
    id: uuid.UUID
    email: EmailStr
    full_name: str
    orcid: str | None = None
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None = None


class LabRead(ReadModel):
    id: uuid.UUID
    name: str
    slug: str


class MembershipRead(ReadModel):
    lab_id: uuid.UUID
    user_id: uuid.UUID
    role: LabRole
    joined_at: datetime


class LoginRequest(ApiModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"
    expires_in: int


class TokenPayload(BaseModel):
    """What the JWT carries. lab_id travels in the token so every request knows
    its scope without another query; changing labs means a new token."""

    sub: uuid.UUID
    lab_id: uuid.UUID | None = None
    role: LabRole | None = None
    exp: int
    jti: str


# ---------------------------------------------------------------------------
# 2 · Notebook entries
# ---------------------------------------------------------------------------
class NotebookEntryCreate(ApiModel):
    title: str = Field(min_length=1, max_length=300)
    project_id: uuid.UUID | None = None
    hypothesis: str | None = None
    methods: str | None = None
    results: str | None = None
    conclusions: str | None = None
    next_steps: str | None = None
    body: dict = Field(default_factory=dict)
    body_text: str = ""
    performed_on: date | None = None


class NotebookEntryUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    project_id: uuid.UUID | None = None
    hypothesis: str | None = None
    methods: str | None = None
    results: str | None = None
    conclusions: str | None = None
    next_steps: str | None = None
    body: dict | None = None
    body_text: str | None = None
    performed_on: date | None = None
    change_note: str | None = Field(default=None, max_length=500)


class NotebookEntryRead(ReadModel):
    id: uuid.UUID
    lab_id: uuid.UUID
    project_id: uuid.UUID | None = None
    author_id: uuid.UUID
    title: str
    hypothesis: str | None = None
    methods: str | None = None
    results: str | None = None
    conclusions: str | None = None
    next_steps: str | None = None
    body: dict
    status: EntryStatus
    current_version: int
    performed_on: date | None = None
    created_at: datetime
    updated_at: datetime


class NotebookEntrySummary(ReadModel):
    """The list view. Deliberately without `body`: a hundred entries each
    carrying a full document is the difference between a fast page and a slow one."""

    id: uuid.UUID
    title: str
    author_id: uuid.UUID
    status: EntryStatus
    performed_on: date | None = None
    updated_at: datetime


class EntryVersionRead(ReadModel):
    entry_id: uuid.UUID
    version_no: int
    change_note: str | None = None
    created_by: uuid.UUID
    created_at: datetime


class SignatureCreate(ApiModel):
    version_no: int = Field(ge=1)
    role: SignatureRole
    statement: str = Field(
        default="I confirm this record is accurate and complete.", max_length=500
    )


class SignatureRead(ReadModel):
    id: uuid.UUID
    entry_id: uuid.UUID
    version_no: int
    signer_id: uuid.UUID
    role: SignatureRole
    statement: str
    signed_at: datetime


# ---------------------------------------------------------------------------
# 3 · Plasmid vectors
# ---------------------------------------------------------------------------
class SequenceFeatureCreate(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    type_key: str = Field(default="misc_feature", max_length=40)
    start_pos: int = Field(ge=0)
    end_pos: int = Field(gt=0)
    strand: int = Field(default=1, ge=-1, le=1)
    wraps_origin: bool = False
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    note: str | None = None

    @model_validator(mode="after")
    def span_is_consistent(self) -> "SequenceFeatureCreate":
        # Same rule as the CHECK, repeated so the client gets a useful message
        # instead of a constraint-violation traceback.
        if self.wraps_origin:
            if self.end_pos > self.start_pos:
                raise ValueError("a feature crossing the origin must end before it starts")
        elif self.end_pos <= self.start_pos:
            raise ValueError("end_pos must be greater than start_pos")
        return self


class SequenceFeatureRead(ReadModel):
    id: uuid.UUID
    plasmid_id: uuid.UUID
    name: str
    type_key: str
    start_pos: int
    end_pos: int
    strand: int
    wraps_origin: bool
    color: str | None = None
    note: str | None = None
    annotation_source: str


class PlasmidCreate(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    sequence: DnaStr
    topology: Topology = Topology.circular
    alias: str | None = None
    backbone: str | None = None
    insert_description: str | None = None
    selection_markers: list[str] = Field(default_factory=list)
    host_strain: str | None = None
    # Provenance: either it was built in an entry, or it came from somewhere.
    created_in_entry_id: uuid.UUID | None = None
    construction_method: ConstructionKind | None = None
    external_source: str | None = None
    external_reference: str | None = None
    map_url: str | None = None
    notes: str | None = None
    features: list[SequenceFeatureCreate] = Field(default_factory=list)

    _clean = field_validator("sequence")(classmethod(lambda cls, v: _clean_dna(v)))

    @model_validator(mode="after")
    def provenance_is_known(self) -> "PlasmidCreate":
        if self.created_in_entry_id is None and not self.external_source:
            if self.construction_method not in (None, ConstructionKind.obtained_externally):
                raise ValueError(
                    "say where this came from: created_in_entry_id for something built here, "
                    "or external_source for something obtained"
                )
        return self


class PlasmidUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sequence: str | None = None
    topology: Topology | None = None
    alias: str | None = None
    backbone: str | None = None
    insert_description: str | None = None
    selection_markers: list[str] | None = None
    host_strain: str | None = None
    owner_id: uuid.UUID | None = None          # handing a construct to someone else
    created_in_entry_id: uuid.UUID | None = None
    construction_method: ConstructionKind | None = None
    external_source: str | None = None
    map_url: str | None = None
    notes: str | None = None

    @field_validator("sequence")
    @classmethod
    def clean(cls, v: str | None) -> str | None:
        return _clean_dna(v) if v is not None else None


class PlasmidSummary(ReadModel):
    """The list view: no sequence. A page of fifty 10 kb plasmids is half a
    megabyte of bases nobody is reading."""

    id: uuid.UUID
    lab_id: uuid.UUID
    owner_id: uuid.UUID | None = None
    name: str
    alias: str | None = None
    topology: Topology
    length_bp: int
    backbone: str | None = None
    created_in_entry_id: uuid.UUID | None = None
    updated_at: datetime


class PlasmidRead(PlasmidSummary):
    sequence: str
    insert_description: str | None = None
    selection_markers: list[str]
    host_strain: str | None = None
    construction_method: ConstructionKind | None = None
    external_source: str | None = None
    external_reference: str | None = None
    map_url: str | None = None
    notes: str | None = None
    created_at: datetime
    features: list[SequenceFeatureRead] = Field(default_factory=list)


class EntryPlasmidLink(ApiModel):
    plasmid_id: uuid.UUID
    role: EntryLinkRole = EntryLinkRole.used
    note: str | None = None


class PlasmidHistoryRow(ReadModel):
    """One line of 'where has this construct been' — creation and every later use."""

    entry_id: uuid.UUID
    role: EntryLinkRole
    title: str
    performed_on: date | None = None
    author_id: uuid.UUID


# ---------------------------------------------------------------------------
# 4 · CRISPR designs
# ---------------------------------------------------------------------------
class PegRNADetailCreate(ApiModel):
    pbs: DnaStr
    rt_template: DnaStr
    extension: DnaStr
    pbs_tm_c: Decimal | None = None
    edit_type: EditKind
    edit_position: int = Field(ge=0)
    edit_size_bp: int = Field(gt=0)
    inserted_bases: str | None = None
    nick_position: int = Field(ge=0)

    @field_validator("pbs", "rt_template", "extension", "inserted_bases")
    @classmethod
    def clean(cls, v: str | None) -> str | None:
        return _clean_dna(v) if v is not None else None

    @model_validator(mode="after")
    def edit_is_described(self) -> "PegRNADetailCreate":
        if self.edit_type is EditKind.insertion and not self.inserted_bases:
            raise ValueError("an insertion must say which bases it inserts")
        if self.edit_type is EditKind.insertion and len(self.inserted_bases or "") != self.edit_size_bp:
            raise ValueError("edit_size_bp must match the length of inserted_bases")
        if self.edit_position < self.nick_position:
            raise ValueError("the edit has to sit downstream of the nick for this guide")
        return self


class PegRNADetailRead(ReadModel):
    pbs: str
    rt_template: str
    extension: str
    pbs_tm_c: Decimal | None = None
    edit_type: EditKind
    edit_position: int
    edit_size_bp: int
    inserted_bases: str | None = None
    nick_position: int


class GuideRNACreate(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    kind: GuideKind = GuideKind.sgRNA
    spacer: str = Field(min_length=16, max_length=30)
    pam_sequence: DnaStr
    pam_pattern: str = Field(default="NGG", max_length=12)
    nuclease: str = "SpCas9"
    scaffold: str | None = None
    target_plasmid_id: uuid.UUID | None = None
    target_strand: int | None = Field(default=None, ge=-1, le=1)
    target_start: int | None = Field(default=None, ge=0)
    cut_position: int | None = Field(default=None, ge=0)
    target_genome: str | None = None
    target_locus: str | None = None
    on_target_score: Decimal | None = None
    designed_in_entry_id: uuid.UUID | None = None
    notes: str | None = None
    pegrna: PegRNADetailCreate | None = None

    @field_validator("spacer", "pam_sequence", "scaffold")
    @classmethod
    def clean(cls, v: str | None) -> str | None:
        return _clean_dna(v) if v is not None else None

    @model_validator(mode="after")
    def target_and_kind_agree(self) -> "GuideRNACreate":
        if self.target_plasmid_id is None and not self.target_locus:
            raise ValueError("a guide needs a target: a plasmid in the lab or a genomic locus")
        if self.target_strand == 0:
            raise ValueError("a guide reads one strand or the other")
        if self.kind is GuideKind.pegRNA and self.pegrna is None:
            raise ValueError("a pegRNA needs its PBS and RT template")
        if self.kind is not GuideKind.pegRNA and self.pegrna is not None:
            raise ValueError("only a pegRNA carries a 3' extension")
        return self


class GuideRNAUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    owner_id: uuid.UUID | None = None
    notes: str | None = None
    on_target_score: Decimal | None = None
    designed_in_entry_id: uuid.UUID | None = None


class GuideOffTargetRead(ReadModel):
    locus: str
    mismatches: int
    score: Decimal | None = None
    in_cds: bool | None = None
    found_by: str | None = None


class GuideRNASummary(ReadModel):
    id: uuid.UUID
    lab_id: uuid.UUID
    owner_id: uuid.UUID | None = None
    name: str
    kind: GuideKind
    spacer: str
    pam_sequence: str
    nuclease: str
    target_plasmid_id: uuid.UUID | None = None
    gc_percent: Decimal | None = None
    updated_at: datetime


class GuideRNARead(GuideRNASummary):
    pam_pattern: str
    scaffold: str | None = None
    target_strand: int | None = None
    target_start: int | None = None
    cut_position: int | None = None
    target_genome: str | None = None
    target_locus: str | None = None
    on_target_score: Decimal | None = None
    designed_in_entry_id: uuid.UUID | None = None
    notes: str | None = None
    created_at: datetime
    pegrna: PegRNADetailRead | None = None
    off_targets: list[GuideOffTargetRead] = Field(default_factory=list)
