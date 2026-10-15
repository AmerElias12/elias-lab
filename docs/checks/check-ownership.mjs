/* Per-record ownership and explicit sharing.

   One lab with a PI, two members and a read-only guest; a rival lab next door.
   Records owned by different people, some shared and some not, plus one whose
   owner has left. Every assertion runs as eln_app, which neither owns the
   tables nor bypasses RLS. */
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import assert from 'assert/strict';

const db = new PGlite();
for (const f of process.argv.slice(2)) await db.exec(fs.readFileSync(f, 'utf8'));
console.log('schema + policies + ownership applied');

let pass = 0;
const check = async (what, fn) => { await fn(); pass++; console.log('  ok  ' + what); };
const one = async (q, p) => (await db.query(q, p)).rows[0];
const rows = async (q, p) => (await db.query(q, p)).rows;
const denied = (p) => assert.rejects(p, /policy|permission|denied/i);
const n = async (q, p) => Number((await one(q, p)).c);

// ---- fixtures, as the owner ------------------------------------------------
const A = await one(`INSERT INTO lab (name,slug) VALUES ('Elias Lab','elias') RETURNING id`);
const B = await one(`INSERT INTO lab (name,slug) VALUES ('Rival Lab','rival') RETURNING id`);

const pi    = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('amer@a.il','Amer','$argon2id$fixture-not-a-real-hash')  RETURNING id`);
const stud  = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('s@a.il','Student','$argon2id$fixture-not-a-real-hash')  RETURNING id`);
const other = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('o@a.il','Postdoc','$argon2id$fixture-not-a-real-hash')  RETURNING id`);
const guest = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('g@a.il','Guest','$argon2id$fixture-not-a-real-hash')    RETURNING id`);
const rival = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('r@b.il','Rival','$argon2id$fixture-not-a-real-hash')    RETURNING id`);

await db.query(`INSERT INTO lab_member (lab_id,user_id,role) VALUES
  ($1,$2,'owner'), ($1,$3,'member'), ($1,$4,'member'), ($1,$5,'read_only'), ($6,$7,'owner')`,
  [A.id, pi.id, stud.id, other.id, guest.id, B.id, rival.id]);

const entry = await one(`INSERT INTO notebook_entry (lab_id,author_id,title,body_text)
  VALUES ($1,$2,'Cloning',	'notes') RETURNING id`, [A.id, stud.id]);

// the student's own work, kept to themselves
const priv = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id,is_shared)
  VALUES ($1,'pStudent-draft',repeat('ATGC',600),'x',$2,false) RETURNING id`, [A.id, stud.id]);
// the student's work, shared with the lab
const shared = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id,is_shared)
  VALUES ($1,'pStudent-shared',repeat('ATGC',600),'x',$2,true) RETURNING id`, [A.id, stud.id]);
// a plasmid whose owner has since left the lab
const orphan = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id,is_shared)
  VALUES ($1,'pLegacy',repeat('ATGC',600),'x',NULL,false) RETURNING id`, [A.id]);
// the rival lab's own, marked shared — shared inside *their* group, not ours
const far = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id,is_shared)
  VALUES ($1,'pRival',repeat('GCTA',600),'x',$2,true) RETURNING id`, [B.id, rival.id]);

await db.query(`INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
  VALUES ($1,'secret-CDS','CDS',10,90,1)`, [priv.id]);

// private and shared notebook entries
const privEntry = await one(`INSERT INTO notebook_entry (lab_id,author_id,title,is_shared)
  VALUES ($1,$2,'unfinished thought',false) RETURNING id`, [A.id, stud.id]);

// ---- become the application ------------------------------------------------
const as = async (userId, labId) => {
  await db.exec(`RESET ROLE`);
  await db.exec(`SET ROLE eln_app`);
  await db.query(`SELECT set_config('app.current_user_id',$1,false), set_config('app.lab_id',$2,false)`,
    [userId ?? '', labId ?? '']);
};

// ---- the shape of the policies --------------------------------------------
await check('each owned table has four permissive policies and one restrictive floor', async () => {
  for (const t of ['notebook_entry', 'plasmid', 'primer', 'primer_pair', 'guide_rna']) {
    const p = await rows(
      `SELECT cmd, permissive FROM pg_policies WHERE schemaname='public' AND tablename=$1`, [t]);
    const perm = p.filter((r) => r.permissive === 'PERMISSIVE');
    const rest = p.filter((r) => r.permissive === 'RESTRICTIVE');
    assert.equal(perm.length, 4, `${t} permissive`);
    assert.equal(rest.length, 1, `${t} restrictive`);
    assert.deepEqual(perm.map((r) => r.cmd).sort(), ['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  }
});

await check('no lab-wide policy was left behind to OR the ownership test away', async () => {
  // the replaced policies would have a qual mentioning lab_id and nothing else
  const q = await one(`SELECT qual AS c FROM pg_policies
                        WHERE schemaname='public' AND tablename='plasmid' AND cmd='SELECT'`);
  assert.match(q.c, /owns/, 'the SELECT policy must test ownership');
  assert.match(q.c, /is_shared/, 'and the sharing flag');
});

// ---- 1 · owner_id drives access -------------------------------------------
await check('the owner sees their own unshared record', async () => {
  await as(stud.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [priv.id]), 1);
});

await check('a colleague in the same lab cannot see it', async () => {
  await as(other.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [priv.id]), 0);
  // naming it by primary key does not help
  assert.equal((await rows(`SELECT name FROM plasmid WHERE id=$1`, [priv.id])).length, 0);
});

await check('a member may create a record, owned by themselves', async () => {
  await as(other.id, A.id);
  const r = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id)
    VALUES ($1,'pPostdoc',repeat('ATGC',600),'x',$2) RETURNING id`, [A.id, other.id]);
  assert.ok(r.id);
});

await check('a member cannot create a record attributed to someone else', async () => {
  await as(other.id, A.id);
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id)
    VALUES ($1,'pForged',repeat('ATGC',600),'x',$2)`, [A.id, stud.id]));
});

await check('a member cannot create an unowned record either', async () => {
  await as(other.id, A.id);
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id)
    VALUES ($1,'pNobody',repeat('ATGC',600),'x',NULL)`, [A.id]));
});

await check('updating someone else’s record matches no rows', async () => {
  await as(other.id, A.id);
  const r = await db.query(`UPDATE plasmid SET notes='mine now' WHERE id=$1`, [priv.id]);
  assert.equal(r.affectedRows, 0);
});

await check('the owner may update their own', async () => {
  await as(stud.id, A.id);
  const r = await db.query(`UPDATE plasmid SET notes='mapped' WHERE id=$1`, [priv.id]);
  assert.equal(r.affectedRows, 1);
});

await check('the owner cannot sign a record over to a colleague', async () => {
  await as(stud.id, A.id);
  await denied(db.query(`UPDATE plasmid SET owner_id=$1 WHERE id=$2`, [other.id, priv.id]));
});

await check('deleting someone else’s record matches no rows', async () => {
  await as(other.id, A.id);
  const r = await db.query(`DELETE FROM plasmid WHERE id=$1`, [priv.id]);
  assert.equal(r.affectedRows, 0);
});

await check('the owner may delete their own', async () => {
  await as(stud.id, A.id);
  const doomed = await one(`SELECT id FROM plasmid WHERE name='pStudent-shared'`);
  const r = await db.query(`DELETE FROM plasmid WHERE id=$1`, [doomed.id]);
  assert.equal(r.affectedRows, 1);
  // put it back for the sharing checks below
  await as(null, null);
  await db.exec(`RESET ROLE`);
  await db.query(`INSERT INTO plasmid (id,lab_id,name,sequence,external_source,owner_id,is_shared)
    VALUES ($1,$2,'pStudent-shared',repeat('ATGC',600),'x',$3,true)`, [shared.id, A.id, stud.id]);
});

// ---- 2 · is_shared, within the research group -----------------------------
await check('a colleague sees a shared record', async () => {
  await as(other.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [shared.id]), 1);
});

await check('a shared record is still not writable by a colleague', async () => {
  await as(other.id, A.id);
  const r = await db.query(`UPDATE plasmid SET notes='edited' WHERE id=$1`, [shared.id]);
  assert.equal(r.affectedRows, 0, 'sharing grants reading, not writing');
});

await check('is_shared does NOT cross the lab boundary', async () => {
  await as(rival.id, B.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [shared.id]), 0,
    'another lab must not see our shared record');
  // and ours cannot see theirs, equally marked shared
  await as(stud.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [far.id]), 0);
});

await check('a rival naming our lab in the token still gets nothing', async () => {
  await as(rival.id, A.id);          // not a member of lab A
  assert.equal(await n(`SELECT count(*) c FROM plasmid`), 0,
    'app.lab_id is a choice among your labs, not a grant of access to one');
  assert.equal(await n(`SELECT count(*) c FROM notebook_entry`), 0);
  assert.equal((await rows(`SELECT user_id FROM lab_member`)).length, 0, 'nor the roster');
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id)
    VALUES ($1,'pIntruder',repeat('ATGC',600),'x',$2)`, [A.id, rival.id]));
});

await check('a read-only member reads shared records and writes nothing', async () => {
  await as(guest.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [shared.id]), 1);
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source,owner_id)
    VALUES ($1,'pGuest',repeat('ATGC',600),'x',$2)`, [A.id, guest.id]));
});

// ---- 3 · the administrator branch, and orphaned records -------------------
await check('the PI sees every record in the lab, shared or not', async () => {
  await as(pi.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [priv.id]), 1);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [orphan.id]), 1);
});

await check('a record whose owner left is unreachable to members', async () => {
  await as(other.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM plasmid WHERE id=$1`, [orphan.id]), 0);
  const r = await db.query(`UPDATE plasmid SET notes='x' WHERE id=$1`, [orphan.id]);
  assert.equal(r.affectedRows, 0);
});

await check('but an administrator can still reach it, so nothing is stranded', async () => {
  await as(pi.id, A.id);
  const r = await db.query(`UPDATE plasmid SET owner_id=$1 WHERE id=$2`, [other.id, orphan.id]);
  assert.equal(r.affectedRows, 1, 'the PI can re-home a departed member’s plasmid');
});

// ---- 4 · the restrictive floor --------------------------------------------
await check('not even the PI can move a row into another lab', async () => {
  await as(pi.id, A.id);
  await denied(db.query(`UPDATE plasmid SET lab_id=$1 WHERE id=$2`, [B.id, shared.id]));
});

// ---- 5 · children follow the parent ---------------------------------------
await check('a feature on an unshared plasmid is invisible too', async () => {
  await as(guest.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM sequence_feature WHERE plasmid_id=$1`, [priv.id]), 0);
  await as(stud.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM sequence_feature WHERE plasmid_id=$1`, [priv.id]), 1);
});

// ---- 6 · notebook entries -------------------------------------------------
await check('entries default to shared, so the lab notebook stays a shared record', async () => {
  await as(other.id, A.id);
  assert.equal(await n(`SELECT count(*) c FROM notebook_entry WHERE id=$1`, [entry.id]), 1,
    'a colleague reads the lab notebook');
  assert.equal(await n(`SELECT count(*) c FROM notebook_entry WHERE id=$1`, [privEntry.id]), 0,
    'but not an entry the author kept private');
});

await check('an author keeps control of their own entry', async () => {
  await as(other.id, A.id);
  const r = await db.query(`UPDATE notebook_entry SET title='rewritten' WHERE id=$1`, [entry.id]);
  assert.equal(r.affectedRows, 0, 'a readable entry is not an editable one');
  await as(stud.id, A.id);
  const m = await db.query(`UPDATE notebook_entry SET title='Cloning, take 2' WHERE id=$1`, [entry.id]);
  assert.equal(m.affectedRows, 1);
});

// ---- 7 · unidentified connections -----------------------------------------
await check('with no user set, nothing is readable and nothing is writable', async () => {
  await as(null, null);
  assert.equal(await n(`SELECT count(*) c FROM plasmid`), 0);
  assert.equal(await n(`SELECT count(*) c FROM notebook_entry`), 0);
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pAnon',repeat('ATGC',600),'x')`, [A.id]));
});

await db.exec(`RESET ROLE`);
console.log(`\n${pass} checks passed`);
