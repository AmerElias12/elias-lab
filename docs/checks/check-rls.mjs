/* Two labs, real data in each, then connect as the application role and try to
   cross the boundary. Fixtures are created as the owner; every assertion runs
   as eln_app, which is neither superuser nor table owner, so the policies
   actually apply. */
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import assert from 'assert/strict';

const db = new PGlite();
await db.exec(fs.readFileSync(process.argv[2], 'utf8'));   // schema
await db.exec(fs.readFileSync(process.argv[3], 'utf8'));   // rls
console.log('schema + policies applied');

let pass = 0;
const check = async (what, fn) => { await fn(); pass++; console.log('  ok  ' + what); };
const one = async (q, p) => (await db.query(q, p)).rows[0];
const rows = async (q, p) => (await db.query(q, p)).rows;
const denied = (p, re) => assert.rejects(p, re || /policy|permission|denied/i);

// ---- fixtures, as the owner ------------------------------------------------
const A = await one(`INSERT INTO lab (name,slug) VALUES ('Elias Lab','elias') RETURNING id`);
const B = await one(`INSERT INTO lab (name,slug) VALUES ('Rival Lab','rival') RETURNING id`);
const amer = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('amer@a.il','Amer','$argon2id$fixture-not-a-real-hash') RETURNING id`);
const stud = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('stud@a.il','Student','$argon2id$fixture-not-a-real-hash') RETURNING id`);
const guest = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('guest@a.il','Guest','$argon2id$fixture-not-a-real-hash') RETURNING id`);
const rival = await one(`INSERT INTO app_user (email,full_name,hashed_password) VALUES ('rival@b.il','Rival','$argon2id$fixture-not-a-real-hash') RETURNING id`);
await db.query(`INSERT INTO lab_member (lab_id,user_id,role) VALUES
  ($1,$2,'owner'), ($1,$3,'member'), ($1,$4,'read_only'), ($5,$6,'owner')`,
  [A.id, amer.id, stud.id, guest.id, B.id, rival.id]);

const entryA = await one(`INSERT INTO notebook_entry (lab_id,author_id,title,body_text)
  VALUES ($1,$2,'Gibson assembly','three fragments') RETURNING id`, [A.id, amer.id]);
const entryB = await one(`INSERT INTO notebook_entry (lab_id,author_id,title)
  VALUES ($1,$2,'Secret work') RETURNING id`, [B.id, rival.id]);
const plasA = await one(`INSERT INTO plasmid (lab_id,name,sequence,created_in_entry_id,owner_id)
  VALUES ($1,'pLenti-GFP', repeat('ATGC',1200), $2, $3) RETURNING id`, [A.id, entryA.id, amer.id]);
const plasB = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
  VALUES ($1,'pSecret', repeat('GCTA',1200),'Addgene') RETURNING id`, [B.id]);
await db.query(`INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
  VALUES ($1,'EGFP','CDS',100,820,1), ($2,'hidden','CDS',10,90,1)`, [plasA.id, plasB.id]);
await db.query(`INSERT INTO guide_rna (lab_id,name,spacer,pam_sequence,pam_pattern,target_plasmid_id)
  VALUES ($1,'g1','ACGTTGCAACGTTGCAAGGT','AGG','NGG',$2)`, [A.id, plasA.id]);
await db.query(`INSERT INTO guide_rna (lab_id,name,spacer,pam_sequence,pam_pattern,target_plasmid_id)
  VALUES ($1,'gSecret','TTTTTGCAACGTTGCAAGGT','AGG','NGG',$2)`, [B.id, plasB.id]);

// ---- become the application ------------------------------------------------
const as = async (userId, labId) => {
  await db.exec(`RESET ROLE`);
  await db.exec(`SET ROLE eln_app`);
  if (userId === null) {
    await db.query(`SELECT set_config('app.current_user_id','',false), set_config('app.lab_id','',false)`);
  } else {
    await db.query(`SELECT set_config('app.current_user_id',$1,false), set_config('app.lab_id',$2,false)`,
      [userId, labId]);
  }
};

await check('the application role cannot step over the policies', async () => {
  const r = await one(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='eln_app'`);
  assert.equal(r.rolsuper, false);
  assert.equal(r.rolbypassrls, false);
});
await check('every table has RLS enabled and forced', async () => {
  const bad = await rows(`SELECT relname FROM pg_class
     WHERE relnamespace='public'::regnamespace AND relkind='r'
       AND NOT (relrowsecurity AND relforcerowsecurity)`);
  assert.deepEqual(bad.map(r => r.relname), []);
});

// ---- isolation -------------------------------------------------------------
await check('with no scope set, nothing at all is visible', async () => {
  await as(null);
  assert.equal((await rows(`SELECT id FROM plasmid`)).length, 0);
  assert.equal((await rows(`SELECT id FROM notebook_entry`)).length, 0);
  assert.equal((await rows(`SELECT id FROM guide_rna`)).length, 0);
});
await check('inside a lab you see its records and only its records', async () => {
  await as(amer.id, A.id);
  const p = await rows(`SELECT name FROM plasmid`);
  assert.deepEqual(p.map(r => r.name), ['pLenti-GFP']);
  const e = await rows(`SELECT title FROM notebook_entry`);
  assert.deepEqual(e.map(r => r.title), ['Gibson assembly']);
  const g = await rows(`SELECT name FROM guide_rna`);
  assert.deepEqual(g.map(r => r.name), ['g1']);
});
await check('naming the other lab’s row by its id still returns nothing', async () => {
  await as(amer.id, A.id);
  assert.equal((await rows(`SELECT id FROM plasmid WHERE id=$1`, [plasB.id])).length, 0);
  assert.equal((await rows(`SELECT id FROM notebook_entry WHERE id=$1`, [entryB.id])).length, 0);
});
await check('the other lab sees its own, and not ours', async () => {
  await as(rival.id, B.id);
  const p = await rows(`SELECT name FROM plasmid`);
  assert.deepEqual(p.map(r => r.name), ['pSecret']);
});
await check('a member of one lab cannot simply claim another lab in the token', async () => {
  // The request says lab B, but this person is not a member of B. Membership
  // is read from lab_member, not taken from the token, so the claim buys
  // nothing: no role, no reads, no writes. app.lab_id chooses among the labs
  // you belong to; it does not grant you one.
  await as(amer.id, B.id);
  const role = await one(`SELECT current_lab_role() AS r`);
  assert.equal(role.r, null, 'no membership means no role');
  assert.equal((await rows(`SELECT id FROM plasmid`)).length, 0, 'and no rows');
  assert.equal((await rows(`SELECT id FROM notebook_entry`)).length, 0);
  assert.equal((await rows(`SELECT user_id FROM lab_member`)).length, 0, 'not even the roster');
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pIntruder','ATGC','x')`, [B.id]));
});

// ---- children ---------------------------------------------------------------
await check('a feature is only visible through a plasmid you can see', async () => {
  await as(amer.id, A.id);
  const f = await rows(`SELECT name FROM sequence_feature`);
  assert.deepEqual(f.map(r => r.name), ['EGFP']);
});
await check('a cross-lab link cannot be written', async () => {
  await as(amer.id, A.id);
  // our entry, their plasmid
  await denied(db.query(`INSERT INTO entry_plasmid (entry_id,plasmid_id,role)
    VALUES ($1,$2,'used')`, [entryA.id, plasB.id]));
  // and a feature hung off their plasmid
  await denied(db.query(`INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
    VALUES ($1,'sneaky','CDS',0,30,1)`, [plasB.id]));
  // the legitimate one is fine
  await db.query(`INSERT INTO entry_plasmid (entry_id,plasmid_id,role) VALUES ($1,$2,'used')`,
    [entryA.id, plasA.id]);
});

// ---- writing ---------------------------------------------------------------
await check('a member may create in their own lab, but not stamp another lab on it', async () => {
  await as(stud.id, A.id);
  await db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pStudent', repeat('ATGC',40),'synthesised')`, [A.id]);
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pSmuggled','ATGC','x')`, [B.id]));
});
await check('a read-only member reads but cannot write', async () => {
  await as(guest.id, A.id);
  assert.ok((await rows(`SELECT id FROM plasmid`)).length >= 1);
  await denied(db.query(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pGuest','ATGC','x')`, [A.id]));
  // An UPDATE refused by a USING clause does not raise: it matches no rows.
  const u = await db.query(`UPDATE plasmid SET notes='hello' WHERE id=$1`, [plasA.id]);
  assert.equal(u.affectedRows, 0);
});
await check('a member may not delete; an administrator may', async () => {
  await as(stud.id, A.id);
  const victim = await one(`SELECT id FROM plasmid WHERE name='pStudent'`);
  const r = await db.query(`DELETE FROM plasmid WHERE id=$1`, [victim.id]);
  assert.equal(r.affectedRows, 0, 'the delete silently matches nothing, which is how RLS denies');
  await as(amer.id, A.id);
  const r2 = await db.query(`DELETE FROM plasmid WHERE id=$1`, [victim.id]);
  assert.equal(r2.affectedRows, 1);
});
await check('an update cannot move a row into another lab', async () => {
  await as(amer.id, A.id);
  await denied(db.query(`UPDATE plasmid SET lab_id=$1 WHERE id=$2`, [B.id, plasA.id]));
});

// ---- history, signatures, audit --------------------------------------------
await check('entry history and signatures cannot be rewritten', async () => {
  await as(amer.id, A.id);
  await db.query(`INSERT INTO notebook_entry_version (entry_id,version_no,body,body_text,content_sha256,created_by)
    VALUES ($1,1,'{}'::jsonb,'three fragments', sha256('v1'::bytea), $2)`, [entryA.id, amer.id]);
  await denied(db.query(`UPDATE notebook_entry_version SET body_text='rewritten' WHERE entry_id=$1`, [entryA.id]),
    /permission denied/i);
  await denied(db.query(`DELETE FROM notebook_entry_version WHERE entry_id=$1`, [entryA.id]),
    /permission denied/i);
});
await check('you sign as yourself and nobody else', async () => {
  await as(amer.id, A.id);
  await db.query(`INSERT INTO entry_signature (entry_id,version_no,signer_id,role,content_sha256)
    VALUES ($1,1,$2,'author', sha256('v1'::bytea))`, [entryA.id, amer.id]);
  await denied(db.query(`INSERT INTO entry_signature (entry_id,version_no,signer_id,role,content_sha256)
    VALUES ($1,1,$2,'witness', sha256('v1'::bytea))`, [entryA.id, stud.id]));
});
await check('the audit trail records writes but the application cannot forge it', async () => {
  await as(amer.id, A.id);
  await db.query(`UPDATE plasmid SET notes='sequence verified' WHERE id=$1`, [plasA.id]);
  const ev = await one(`SELECT action, actor_id, after_data->>'notes' AS note
     FROM audit_event WHERE table_name='plasmid' AND row_id=$1 ORDER BY id DESC LIMIT 1`, [plasA.id]);
  assert.equal(ev.action, 'UPDATE');
  assert.equal(ev.actor_id, amer.id, 'the trail names the person, not the pool');
  assert.equal(ev.note, 'sequence verified');
  await denied(db.query(`INSERT INTO audit_event (lab_id,table_name,action)
    VALUES ($1,'plasmid','DELETE')`, [A.id]), /permission denied/i);
  await denied(db.query(`DELETE FROM audit_event`), /permission denied/i);
});
await check('a plain member cannot read the audit trail at all', async () => {
  await as(stud.id, A.id);
  assert.equal((await rows(`SELECT id FROM audit_event`)).length, 0);
  await as(amer.id, A.id);
  assert.ok((await rows(`SELECT id FROM audit_event`)).length > 0);
});

// ---- the roster ------------------------------------------------------------
await check('you see the people in your lab, not the whole directory', async () => {
  await as(amer.id, A.id);
  const names = (await rows(`SELECT full_name FROM app_user ORDER BY full_name`)).map(r => r.full_name);
  assert.deepEqual(names, ['Amer', 'Guest', 'Student']);
  assert.ok(!names.includes('Rival'));
});
await check('a member cannot promote themselves', async () => {
  await as(stud.id, A.id);
  const r = await db.query(`UPDATE lab_member SET role='owner' WHERE user_id=$1 AND lab_id=$2`,
    [stud.id, A.id]);
  assert.equal(r.affectedRows, 0);
  const still = await one(`SELECT current_lab_role() AS r`);
  assert.equal(still.r, 'member');
});

// ---- shared reference data --------------------------------------------------
await check('built-in feature types are shared; library entries are not', async () => {
  await db.exec(`RESET ROLE`);
  await db.query(`INSERT INTO feature_library_entry (lab_id,name,type_key,sequence)
    VALUES (NULL,'FLAG tag','tag','GACTACAAAGACGATGACGACAAG'), ($1,'our cassette','CDS','ATGCATGC')`, [B.id]);
  await as(amer.id, A.id);
  const lib = (await rows(`SELECT name FROM feature_library_entry ORDER BY name`)).map(r => r.name);
  assert.deepEqual(lib, ['FLAG tag'], 'the built-in, never the rival lab’s');
  assert.ok((await rows(`SELECT key FROM feature_type`)).length >= 14);
});

await db.exec(`RESET ROLE`);
console.log('\n' + pass + ' checks passed');
