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


class MemberAdd(ApiModel):
    """Add somebody who has already registered. There is no password field on
    purpose: an administrator who sets a colleague's password knows it, and an
    entry signed by that account stops meaning anything."""

    email: EmailStr
    role: LabRole = LabRole.member


class MemberRoleUpdate(ApiModel):
    role: LabRole


class MemberRead(ReadModel):
    user_id: uuid.UUID
    full_name: str
    email: EmailStr
    role: LabRole
    joined_at: datetime


class LoginRequest(ApiModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    """What a sign-in hands back.

    `refresh_token` is deliberately always None here. The refresh token goes
    out as an httpOnly cookie instead, so that script on this origin cannot
    read it — which is the entire reason for having one. Putting it in the
    body as well would hand it straight back to the thing it is hiding from.
    The field stays so that the shape does not change if that is ever revisited.
    """

    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"
    expires_in: int


class SessionRead(ReadModel):
    """One signed-in session, for the person who owns it."""

    id: uuid.UUID
    issued_at: datetime
    expires_at: datetime
    last_used_at: datetime | None = None
    user_agent: str | None = None
    current: bool = False


class TokenPayload(BaseModel):
    """What the JWT carries. lab_id travels in the token so every request knows
    its scope without another query; changing labs means a new token."""

    sub: uuid.UUID
    lab_id: uuid.UUID | None = None
    role: LabRole | None = None
    exp: int
    jti: str


class LabCreate(ApiModel):
    """Starting a lab. The slug is in URLs and in the storage paths for
    attachments, so it is constrained to the characters that are safe in both
    rather than slugified silently from the name."""

    name: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")


class LabSwitch(ApiModel):
    lab_id: uuid.UUID


class LabMembershipRead(ReadModel):
    """One row of the lab switcher: the lab, and what you are in it."""

    lab_id: uuid.UUID
    name: str
    slug: str
    role: LabRole


class MeRead(ReadModel):
    """Everything the frontend needs to draw its shell: who you are, which
    labs you can work in, and which one this token is for. `current_lab_id` is
    None for an account nobody has added to a lab yet, which the UI shows as a
    waiting-for-approval state rather than an error."""

    user: UserRead
    labs: list[LabMembershipRead]
    current_lab_id: uuid.UUID | None = None
    current_role: LabRole | None = None


# ---------------------------------------------------------------------------
# 2 · Notebook entries
# ---------------------------------------------------------------------------
class NotebookEntryCreate(ApiModel):
    title: str = Field(min_length=1, max_length=300)
    # The owner may keep a draft to themselves; the default is the shared
    # lab record. Enforced in the database, not here.
    is_shared: bool = True
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
    is_shared: bool | None = None
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
    is_shared: bool
    project_id: uuid.UUID | None = None
    author_id: uuid.UUID
    title: str
    hypothesis: str | None = None
    methods: str | None = None
    results: str | None = None
    conclusions: str | None = None
    next_steps: str | None = None
    body: dict
    # The free-form page. Without this the notes are stored and never returned,
    # so the editor reopens blank and the main content of an entry is invisible.
    body_text: str
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
    is_shared: bool
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
    # Readable by the lab unless the owner says otherwise. owner_id is NOT here
    # on purpose: it comes from the authenticated scope, never from the body,
    # or a request could attribute a record to a colleague.
    is_shared: bool = True
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
    is_shared: bool | None = None
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
    is_shared: bool
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
# Primers
# ---------------------------------------------------------------------------
class PrimerCreate(ApiModel):
    """An oligo as ordered.

    tm_c and gc_percent are supplied rather than computed here. The arithmetic
    lives in js/plasmid.js, where it is tested, and a second implementation in
    Python would be a second answer to the same question — so what is stored is
    what the designer saw when they chose the primer, which is also the number
    they would defend in a meeting.
    """

    name: str = Field(min_length=1, max_length=200)
    sequence: DnaStr
    is_shared: bool = True
    # Free text on purpose. "gRNA cloning oligo", "colony PCR", "sequencing" —
    # labs name these things their own way, and an enum would be wrong within
    # a month. It is searchable, which is what matters.
    purpose: str | None = Field(default=None, max_length=300)
    tm_c: Decimal | None = Field(default=None, ge=0, le=120)
    gc_percent: Decimal | None = Field(default=None, ge=0, le=100)
    designed_in_entry_id: uuid.UUID | None = None
    notes: str | None = None

    _clean = field_validator("sequence")(classmethod(lambda cls, v: _clean_dna(v)))

    @field_validator("sequence")
    @classmethod
    def long_enough_to_anneal(cls, v: str) -> str:
        # Shorter than this is not a primer; it is usually a paste that lost
        # its first line.
        if len(v) < 8:
            raise ValueError("a primer needs at least 8 bases")
        if len(v) > 200:
            raise ValueError("longer than 200 bases is an oligo nobody ordered")
        return v


class PrimerUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_shared: bool | None = None
    purpose: str | None = Field(default=None, max_length=300)
    tm_c: Decimal | None = Field(default=None, ge=0, le=120)
    gc_percent: Decimal | None = Field(default=None, ge=0, le=100)
    owner_id: uuid.UUID | None = None
    designed_in_entry_id: uuid.UUID | None = None
    notes: str | None = None
    # No `sequence`. An ordered oligo is a physical thing in a freezer box; if
    # the sequence is wrong the answer is a new primer, not a quiet edit that
    # leaves every experiment citing this one describing something else.


class PrimerSummary(ReadModel):
    id: uuid.UUID
    lab_id: uuid.UUID
    owner_id: uuid.UUID | None = None
    name: str
    sequence: str
    length_nt: int
    is_shared: bool
    purpose: str | None = None
    tm_c: Decimal | None = None
    gc_percent: Decimal | None = None
    updated_at: datetime


class PrimerRead(PrimerSummary):
    designed_in_entry_id: uuid.UUID | None = None
    notes: str | None = None
    created_at: datetime


class PrimerBindingCreate(ApiModel):
    """Where a primer anneals on a plasmid, as the designer found it.

    Recorded rather than recomputed. The binding is the documented fact — this
    oligo was used with that construct — and a later edit to the plasmid should
    not silently move or erase it.
    """

    plasmid_id: uuid.UUID
    start_pos: int = Field(ge=0)
    end_pos: int = Field(ge=0)
    strand: int = Field(ge=-1, le=1)
    annealed_nt: int = Field(gt=0)
    # The 5' overhang that does not anneal: a restriction site, a Gibson arm,
    # a barcode. Empty for a plain primer.
    tail_sequence: str = ""
    tm_annealed_c: Decimal | None = Field(default=None, ge=0, le=120)

    @field_validator("tail_sequence")
    @classmethod
    def tail_is_dna_or_empty(cls, v: str) -> str:
        return _clean_dna(v) if v else ""


class PrimerBindingRead(ReadModel):
    id: uuid.UUID
    primer_id: uuid.UUID
    plasmid_id: uuid.UUID
    start_pos: int
    end_pos: int
    strand: int
    annealed_nt: int
    tail_sequence: str
    tm_annealed_c: Decimal | None = None


class PrimerBindingDetail(PrimerBindingRead):
    """A binding with enough of the primer to draw it, so the map does not need
    a second request per primer."""

    primer_name: str
    primer_sequence: str


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
    # The owner may keep a draft to themselves; the default is the shared
    # lab record. Enforced in the database, not here.
    is_shared: bool = True
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
    is_shared: bool | None = None
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
    is_shared: bool
    owner_id: uuid.UUID | None = None
    name: str
    kind: GuideKind
    spacer: str
    pam_sequence: str
    nuclease: str
    target_plasmid_id: uuid.UUID | None = None
    # Where it sits, in the list view. Without these the molecular tool can
    # tell you a guide targets the open plasmid but cannot draw it, which is
    # the one thing the list is there for.
    target_start: int | None = None
    target_strand: int | None = None
    cut_position: int | None = None
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
