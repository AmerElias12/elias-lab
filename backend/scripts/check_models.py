#!/usr/bin/env python3
"""Checks for the ORM models, the Pydantic schemas and LabScope.

    python scripts/check_models.py

No database: this is about whether the mappings configure, the validators
refuse what they should, and the scope builds the WHERE clause it claims to.
Whether the columns actually exist is a different question, answered by
check_api.py against a real PostgreSQL.
"""
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

"""Exercise the ORM models, Pydantic schemas and the scoping helper.

No database is needed: SQLAlchemy is asked to configure every mapper and to
compile the DDL and the SELECTs it would emit for PostgreSQL, which catches
relationship and type errors. Pydantic is driven with real payloads.
"""
import sys, uuid, re
import pydantic, sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import configure_mappers
from sqlalchemy.schema import CreateTable

from app import models as m, schemas as s
from app.db import Base, LabScopedMixin, OwnedMixin, LabRole, Topology, GuideKind, EditKind, EntryLinkRole
from app.scoping import LabScope, ScopeError

PG = postgresql.dialect()
passed = 0
def check(what, fn):
    global passed
    fn(); passed += 1; print("  ok  " + what)

def raises(exc, fn, match=None):
    try:
        fn()
    except exc as e:
        if match and not re.search(match, str(e), re.I):
            raise AssertionError(f"wrong message: {e}")
        return
    raise AssertionError(f"expected {exc.__name__}")

print(f"SQLAlchemy {sa.__version__} · Pydantic {pydantic.__version__}")

# --- the mappers themselves -------------------------------------------------
check("every mapper and relationship configures", lambda: configure_mappers())

def ddl_for(model):
    return str(CreateTable(model.__table__).compile(dialect=PG))

check("every table compiles to PostgreSQL DDL", lambda: [ddl_for(t) for t in [
    m.Lab, m.User, m.LabMember, m.Project, m.NotebookEntry, m.NotebookEntryVersion,
    m.EntrySignature, m.Plasmid, m.EntryPlasmid, m.PlasmidLineage, m.FeatureType,
    m.SequenceFeature, m.PlasmidSample, m.StorageBox, m.Primer, m.PrimerBinding,
    m.GuideRNA, m.PegRNADetail, m.GuideOffTarget]])

# --- the ownership columns the brief asked for ------------------------------
DATA_MODELS = [m.Project, m.NotebookEntry, m.Plasmid, m.Primer, m.GuideRNA, m.StorageBox]
def _lab_on_every_data_model():
    for model in DATA_MODELS:
        assert issubclass(model, LabScopedMixin), model.__name__
        col = model.__table__.c["lab_id"]
        assert not col.nullable, f"{model.__name__}.lab_id must be NOT NULL"
        assert col.index, f"{model.__name__}.lab_id must be indexed — it is in every WHERE"
check("lab_id is on every data model, NOT NULL and indexed", _lab_on_every_data_model)

def _owner_present():
    for model in (m.Plasmid, m.Primer, m.GuideRNA):
        assert issubclass(model, OwnedMixin)
        assert model.__table__.c["owner_id"].nullable, "people leave; their plasmids stay"
    # an entry's owner is its author, and it is required
    assert not m.NotebookEntry.__table__.c["author_id"].nullable
check("owner_id where it belongs, and an entry always has an author", _owner_present)

def _enums_not_recreated():
    # The PG types come from the SQL schema; the ORM must not emit CREATE TYPE.
    for model, colname in [(m.Plasmid, "topology"), (m.GuideRNA, "kind"), (m.NotebookEntry, "status")]:
        t = model.__table__.c[colname].type
        assert isinstance(t, postgresql.ENUM), colname
        assert t.create_type is False, f"{colname} would try to CREATE TYPE again"
check("enum columns reuse the types the schema already created", _enums_not_recreated)

def _generated_is_read_only():
    ddl = ddl_for(m.Plasmid)
    assert "GENERATED ALWAYS AS (length(sequence)) STORED" in ddl, ddl
    # a generated column must never be written. (A valueless insert() compiles
    # every column, so the check has to be against a real one.)
    ins = str(sa.insert(m.Plasmid).values(name="x", sequence="ATGC").compile(dialect=PG))
    assert "length_bp" not in ins, ins
    upd = str(sa.update(m.Plasmid).values(sequence="ATGC").compile(dialect=PG))
    assert "length_bp" not in upd, upd
check("length_bp is generated and stays out of INSERT", _generated_is_read_only)

def _provenance_fk():
    fk = list(m.Plasmid.__table__.c["created_in_entry_id"].foreign_keys)[0]
    assert fk.column.table.name == "notebook_entry"
    assert fk.ondelete == "RESTRICT", "losing how a construct was built must not be silent"
    # and the many-to-many for every other appearance
    assert m.EntryPlasmid.__table__.primary_key.columns.keys() == ["entry_id", "plasmid_id", "role"]
check("plasmid -> entry provenance is RESTRICT, and use is many-to-many", _provenance_fk)

def _cascades():
    assert list(m.SequenceFeature.__table__.c["plasmid_id"].foreign_keys)[0].ondelete == "CASCADE"
    assert list(m.PegRNADetail.__table__.c["guide_id"].foreign_keys)[0].ondelete == "CASCADE"
    assert list(m.EntrySignature.__table__.foreign_key_constraints.__iter__().__next__().elements)[0].parent is not None
check("features and pegRNA detail are cascaded from their parent", _cascades)

def _lazy_raise():
    # A lazy load under asyncio fails far from its cause; make it fail here.
    offenders = []
    for mapper in Base.registry.mappers:
        for rel in mapper.relationships:
            if rel.lazy not in ("raise", "raise_on_sql", "selectin", "joined"):
                offenders.append(f"{mapper.class_.__name__}.{rel.key}={rel.lazy}")
    assert not offenders, offenders
check("no relationship can lazy-load behind your back", _lazy_raise)

# --- scoping ----------------------------------------------------------------
scope = LabScope(lab_id=uuid.uuid4(), user_id=uuid.uuid4(), role=LabRole.member)

def _scope_filters():
    sql = str(scope.select(m.Plasmid).compile(dialect=PG, compile_kwargs={"literal_binds": True}))
    assert "plasmid.lab_id = " in sql, sql
    assert "plasmid.deleted_at IS NULL" in sql, sql
check("select() narrows to the lab and hides deleted rows", _scope_filters)

def _scope_mine():
    sql = str(scope.mine(m.Plasmid).compile(dialect=PG, compile_kwargs={"literal_binds": True}))
    assert "plasmid.owner_id = " in sql
    entry_sql = str(scope.mine(m.NotebookEntry).compile(dialect=PG, compile_kwargs={"literal_binds": True}))
    assert "notebook_entry.author_id = " in entry_sql, "an entry's owner is its author"
check("mine() uses owner_id, or author_id for entries", _scope_mine)

def _scope_refuses_unscoped():
    raises(ScopeError, lambda: scope.select(m.SequenceFeature), "no lab_id")
    raises(ScopeError, lambda: scope.mine(m.StorageBox), "no owner")
check("a model without lab_id cannot be queried through a scope at all", _scope_refuses_unscoped)

def _stamp():
    row = scope.stamp({"name": "pLenti"})
    assert row["lab_id"] == scope.lab_id and row["owner_id"] == scope.user_id
    # a client-supplied lab_id is overwritten, never trusted
    sneaky = scope.stamp({"name": "x", "lab_id": uuid.uuid4()})
    assert sneaky["lab_id"] == scope.lab_id
check("stamp() sets the scope and overrides anything the client sent", _stamp)

def _permissions():
    admin = LabScope(scope.lab_id, uuid.uuid4(), LabRole.admin)
    reader = LabScope(scope.lab_id, uuid.uuid4(), LabRole.read_only)
    mine = type("Row", (), {"owner_id": scope.user_id})()
    theirs = type("Row", (), {"owner_id": uuid.uuid4()})()
    assert scope.may_edit(mine) and not scope.may_edit(theirs)
    assert admin.may_edit(theirs)
    assert not reader.may_write()
check("members edit their own, admins edit anything, readers edit nothing", _permissions)

# --- Pydantic ---------------------------------------------------------------
def _no_password_anywhere():
    leaks = []
    for name in dir(s):
        obj = getattr(s, name)
        if isinstance(obj, type) and issubclass(obj, pydantic.BaseModel):
            if "hashed_password" in getattr(obj, "model_fields", {}):
                leaks.append(name)
    assert not leaks, leaks
    assert "password" not in s.UserRead.model_fields
check("no schema anywhere can serialise a password hash", _no_password_anywhere)

def _create_refuses_scope_fields():
    raises(pydantic.ValidationError,
           lambda: s.PlasmidCreate(name="p", sequence="ATGC", lab_id=uuid.uuid4()), "extra")
    raises(pydantic.ValidationError,
           lambda: s.PlasmidCreate(name="p", sequence="ATGC", owner_id=uuid.uuid4()), "extra")
check("a client cannot set lab_id or owner_id on create", _create_refuses_scope_fields)

def _dna_cleaned():
    p = s.PlasmidCreate(name="pTest", sequence="  atgc atgc\n 123 ggcc  ", external_source="Addgene")
    assert p.sequence == "ATGCATGCGGCC", p.sequence
    raises(pydantic.ValidationError,
           lambda: s.PlasmidCreate(name="x", sequence="ATGXZ!", external_source="a"), "not a DNA sequence")
check("a pasted GenBank block cleans to bases; rubbish is refused", _dna_cleaned)

def _provenance_required():
    raises(pydantic.ValidationError,
           lambda: s.PlasmidCreate(name="pMystery", sequence="ATGC", construction_method="gibson"),
           "where this came from")
    s.PlasmidCreate(name="ok1", sequence="ATGC", created_in_entry_id=uuid.uuid4(),
                    construction_method="gibson")
    s.PlasmidCreate(name="ok2", sequence="ATGC", external_source="Addgene #12345")
check("a plasmid must say where it came from", _provenance_required)

def _feature_spans():
    s.SequenceFeatureCreate(name="EGFP", type_key="CDS", start_pos=100, end_pos=820)
    s.SequenceFeatureCreate(name="LTR", type_key="LTR", start_pos=4700, end_pos=120, wraps_origin=True)
    raises(pydantic.ValidationError,
           lambda: s.SequenceFeatureCreate(name="bad", type_key="CDS", start_pos=900, end_pos=400),
           "greater than start_pos")
    raises(pydantic.ValidationError,
           lambda: s.SequenceFeatureCreate(name="bad", type_key="CDS", start_pos=10, end_pos=90,
                                           wraps_origin=True), "end before it starts")
check("feature coordinates follow the half-open rule, wrap included", _feature_spans)

def _guides():
    raises(pydantic.ValidationError,
           lambda: s.GuideRNACreate(name="floating", spacer="ACGTTGCAACGTTGCAAGGT",
                                    pam_sequence="AGG"), "needs a target")
    raises(pydantic.ValidationError,
           lambda: s.GuideRNACreate(name="g", kind="pegRNA", spacer="ACGTTGCAACGTTGCAAGGT",
                                    pam_sequence="AGG", target_plasmid_id=uuid.uuid4()),
           "needs its PBS")
    g = s.GuideRNACreate(name="g1", spacer="acgttgcaacgttgcaaggt", pam_sequence="agg",
                         target_plasmid_id=uuid.uuid4(), target_strand=1, cut_position=750)
    assert g.spacer == "ACGTTGCAACGTTGCAAGGT", "spacers are normalised"
check("a guide needs a target, and a pegRNA needs its extension", _guides)

def _pegrna():
    peg = dict(pbs="TACGTACGTACGT", rt_template="GGGGCCTACGCCC",
               extension="GGGGCCTACGCCCTACGTACGTACGT", edit_type="insertion",
               edit_position=754, edit_size_bp=3, inserted_bases="GGG", nick_position=750)
    s.GuideRNACreate(name="peg1", kind="pegRNA", spacer="ACGTTGCAACGTTGCAAGGT",
                     pam_sequence="AGG", target_plasmid_id=uuid.uuid4(),
                     pegrna=s.PegRNADetailCreate(**peg))
    raises(pydantic.ValidationError,
           lambda: s.PegRNADetailCreate(**{**peg, "inserted_bases": None}), "which bases")
    raises(pydantic.ValidationError,
           lambda: s.PegRNADetailCreate(**{**peg, "edit_size_bp": 7}), "must match the length")
    raises(pydantic.ValidationError,
           lambda: s.PegRNADetailCreate(**{**peg, "edit_position": 700}), "downstream of the nick")
check("a pegRNA edit must be described, sized and downstream of the nick", _pegrna)

def _update_partial():
    u = s.PlasmidUpdate(notes="sequence verified")
    sent = u.model_dump(exclude_unset=True)
    assert sent == {"notes": "sequence verified"}, sent     # nothing else is touched
    cleared = s.PlasmidUpdate(notes=None).model_dump(exclude_unset=True)
    assert cleared == {"notes": None}, "explicit null stays distinct from absent"
check("update sends only what was set, and null is not the same as absent", _update_partial)

def _password_rules():
    raises(pydantic.ValidationError,
           lambda: s.UserCreate(email="a@b.co", full_name="A", password="short"), "at least 12")
    raises(pydantic.ValidationError,
           lambda: s.UserCreate(email="a@b.co", full_name="A", password="aaaaaaaaaaaa"), "distinct")
    s.UserCreate(email="amere@braude.ac.il", full_name="Dr. Amer Elias",
                 password="correct horse battery staple")
check("passwords are length-checked and the obvious ones refused", _password_rules)

def _read_from_orm():
    # Read models populate straight off an ORM instance.
    obj = type("FakePlasmid", (), {})()
    for k, v in dict(id=uuid.uuid4(), lab_id=uuid.uuid4(), owner_id=None, name="pLenti",
                     alias=None, topology=Topology.circular, length_bp=4800, backbone="pUC19",
                     created_in_entry_id=uuid.uuid4(), is_shared=True,
                     updated_at=__import__("datetime").datetime.now()).items():
        setattr(obj, k, v)
    out = s.PlasmidSummary.model_validate(obj)
    assert out.length_bp == 4800 and "sequence" not in out.model_dump()
check("read models hydrate from ORM objects, and the summary omits the sequence", _read_from_orm)


def _visible_mirrors_the_policy():
    from app.scoping import LabScope
    lab, me = uuid.uuid4(), uuid.uuid4()
    # The WHERE clause, not the whole statement: SELECT * lists every column,
    # is_shared among them, whatever the filter says.
    where = lambda stmt: str(stmt.whereclause)

    member = LabScope(lab_id=lab, user_id=me, role=LabRole.member)
    w = where(member.visible(m.Plasmid))
    assert "is_shared" in w, "a member's list must consider the sharing flag"
    assert "owner_id" in w, "and their own records"
    assert "lab_id" in w, "inside their lab"

    # An administrator sees the whole lab, so no ownership clause is added.
    pi = LabScope(lab_id=lab, user_id=me, role=LabRole.owner)
    assert "is_shared" not in where(pi.visible(m.Plasmid)), \
        "the PI's list is not narrowed by sharing"

    # Entries key off author_id; a model with no flag comes back unnarrowed.
    e = where(member.visible(m.NotebookEntry))
    assert "author_id" in e and "is_shared" in e
    assert "is_shared" not in where(member.visible(m.StorageBox))
check("visible() narrows a list the way the SELECT policy does", _visible_mirrors_the_policy)

print(f"\n{passed} checks passed")
