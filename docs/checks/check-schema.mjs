/* Run docs/eln-schema.sql on a real Postgres and exercise the constraints
   that matter: provenance, coordinates, signatures, audit, uniqueness. */
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import assert from 'assert/strict';

const db = new PGlite();
const sql = fs.readFileSync(process.argv[2], 'utf8');
await db.exec(sql);
console.log('schema applied cleanly');

let pass = 0;
const check = async (what, fn) => { await fn(); pass++; console.log('  ok  ' + what); };
const fails = (p, re) => assert.rejects(p, re);
const one = async (q, params) => (await db.query(q, params)).rows[0];

// --- fixtures -------------------------------------------------------------
const lab = await one(`INSERT INTO lab (name, slug) VALUES ('Elias Lab','elias-lab') RETURNING id`);
const user = await one(`INSERT INTO app_user (email, full_name, hashed_password) VALUES ('amere@braude.ac.il','Dr. Amer Elias','$argon2id$fixture-not-a-real-hash') RETURNING id`);
await db.query(`INSERT INTO lab_member (lab_id,user_id,role) VALUES ($1,$2,'owner')`, [lab.id, user.id]);
const entry = await one(
  `INSERT INTO notebook_entry (lab_id, author_id, title, body_text, performed_on)
   VALUES ($1,$2,'Gibson assembly of pLenti-GFP','assembled three fragments','2026-10-14') RETURNING id`,
  [lab.id, user.id]);

await check('a lab slug must look like a slug', async () => {
  await fails(db.query(`INSERT INTO lab (name,slug) VALUES ('Bad','Not A Slug')`), /lab_slug_format/);
});
await check('email uniqueness ignores case', async () => {
  await fails(db.query(`INSERT INTO app_user (email, full_name, hashed_password) VALUES ('AMERE@braude.ac.il','Twin','$argon2id$fixture-not-a-real-hash')`),
    /app_user_email_key/);
});

// --- provenance -----------------------------------------------------------
const plasmid = await one(
  `INSERT INTO plasmid (lab_id, name, sequence, created_in_entry_id, construction_method, owner_id)
   VALUES ($1,'pLenti-GFP', repeat('ATGC', 1200), $2, 'gibson', $3) RETURNING id, length_bp`,
  [lab.id, entry.id, user.id]);

await check('length_bp is derived from the sequence, not supplied', async () => {
  assert.equal(plasmid.length_bp, 4800);
  await fails(db.query(`UPDATE plasmid SET length_bp = 10 WHERE id=$1`, [plasmid.id]), /DEFAULT|generated/i);
});
await check('a plasmid with no provenance at all is refused', async () => {
  await fails(db.query(
    `INSERT INTO plasmid (lab_id,name,sequence,construction_method) VALUES ($1,'pMystery','ATGC','gibson')`, [lab.id]),
    /plasmid_provenance_known/);
});
await check('the entry a plasmid was made in cannot be deleted out from under it', async () => {
  await fails(db.query(`DELETE FROM notebook_entry WHERE id=$1`, [entry.id]), /foreign key|violates/i);
});
await check('a sequence that is not DNA is refused', async () => {
  await fails(db.query(
    `INSERT INTO plasmid (lab_id,name,sequence,external_source) VALUES ($1,'pJunk','ATGC!?','Addgene')`, [lab.id]),
    /dna_sequence_iupac/);
});
await check('plasmid names are unique per lab, case-insensitively', async () => {
  await fails(db.query(
    `INSERT INTO plasmid (lab_id,name,sequence,external_source) VALUES ($1,'PLENTI-GFP','ATGC','Addgene')`, [lab.id]),
    /plasmid_name_key/);
});

// --- features -------------------------------------------------------------
await check('a feature must sit inside its plasmid', async () => {
  await db.query(
    `INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
     VALUES ($1,'EGFP','CDS',100,820,1)`, [plasmid.id]);
  await fails(db.query(
    `INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
     VALUES ($1,'off the end','CDS',4700,5200,1)`, [plasmid.id]),
    /outside the 4800 bp plasmid/);
});
await check('a feature crossing the origin is allowed, and only on a circle', async () => {
  await db.query(
    `INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand,wraps_origin)
     VALUES ($1,'spans origin','LTR',4700,120,1,true)`, [plasmid.id]);
  const lin = await one(
    `INSERT INTO plasmid (lab_id,name,sequence,topology,external_source)
     VALUES ($1,'pLinear', repeat('ATGC',100),'linear','synthesised') RETURNING id`, [lab.id]);
  await fails(db.query(
    `INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand,wraps_origin)
     VALUES ($1,'bad wrap','LTR',300,50,1,true)`, [lin.id]), /only cross the origin of a circular/);
});
await check('a span that does not wrap must run forwards', async () => {
  await fails(db.query(
    `INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
     VALUES ($1,'backwards','CDS',900,400,1)`, [plasmid.id]), /feature_span_consistent/);
});
await check('deleting a plasmid takes its features with it', async () => {
  const tmp = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pScratch', repeat('ATGC',50),'test') RETURNING id`, [lab.id]);
  await db.query(`INSERT INTO sequence_feature (plasmid_id,name,type_key,start_pos,end_pos,strand)
    VALUES ($1,'x','CDS',0,30,1)`, [tmp.id]);
  await db.query(`DELETE FROM plasmid WHERE id=$1`, [tmp.id]);
  const left = await one(`SELECT count(*)::int AS n FROM sequence_feature WHERE plasmid_id=$1`, [tmp.id]);
  assert.equal(left.n, 0);
});

// --- lineage and history --------------------------------------------------
await check('lineage records several parents and refuses a self-loop', async () => {
  const a = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pBackbone', repeat('ATGC',200),'Addgene') RETURNING id`, [lab.id]);
  const b = await one(`INSERT INTO plasmid (lab_id,name,sequence,external_source)
    VALUES ($1,'pInsert', repeat('GCTA',200),'Addgene') RETURNING id`, [lab.id]);
  await db.query(`INSERT INTO plasmid_lineage (child_id,parent_id,ordinal,method)
    VALUES ($1,$2,1,'gibson'), ($1,$3,2,'gibson')`, [plasmid.id, a.id, b.id]);
  await fails(db.query(`INSERT INTO plasmid_lineage (child_id,parent_id) VALUES ($1,$1)`, [plasmid.id]),
    /plasmid_lineage_no_self/);
  const anc = await db.query(`SELECT ancestor_id, depth FROM plasmid_ancestry WHERE plasmid_id=$1`, [plasmid.id]);
  assert.equal(anc.rows.length, 2);
});
await check('plasmid_history gives creation and every later use as one list', async () => {
  const used = await one(`INSERT INTO notebook_entry (lab_id,author_id,title)
    VALUES ($1,$2,'Transfection of HEK293T') RETURNING id`, [lab.id, user.id]);
  await db.query(`INSERT INTO entry_plasmid (entry_id,plasmid_id,role) VALUES ($1,$2,'used')`, [used.id, plasmid.id]);
  const hist = await db.query(
    `SELECT role, title FROM plasmid_history WHERE plasmid_id=$1 ORDER BY role`, [plasmid.id]);
  assert.deepEqual(hist.rows.map(r => r.role), ['created', 'used']);
  assert.match(hist.rows[0].title, /Gibson assembly/);
});

// --- entries, versions, signatures ---------------------------------------
await check('a signature is tied to one exact version', async () => {
  await db.query(
    `INSERT INTO notebook_entry_version (entry_id,version_no,body,body_text,content_sha256,created_by)
     VALUES ($1,1,'{}'::jsonb,'assembled three fragments', sha256('v1'::bytea), $2)`, [entry.id, user.id]);
  await db.query(
    `INSERT INTO entry_signature (entry_id,version_no,signer_id,role,content_sha256)
     VALUES ($1,1,$2,'author', sha256('v1'::bytea))`, [entry.id, user.id]);
  // the same person cannot sign the same version twice in the same role
  await fails(db.query(
    `INSERT INTO entry_signature (entry_id,version_no,signer_id,role,content_sha256)
     VALUES ($1,1,$2,'author', sha256('v1'::bytea))`, [entry.id, user.id]), /entry_signature_once_per_role/);
  // but may witness it
  await db.query(
    `INSERT INTO entry_signature (entry_id,version_no,signer_id,role,content_sha256)
     VALUES ($1,1,$2,'witness', sha256('v1'::bytea))`, [entry.id, user.id]);
  // and cannot sign a version that does not exist
  await fails(db.query(
    `INSERT INTO entry_signature (entry_id,version_no,signer_id,role,content_sha256)
     VALUES ($1,9,$2,'author', sha256('v9'::bytea))`, [entry.id, user.id]), /foreign key|violates/i);
});
await check('a signed version cannot be deleted', async () => {
  await fails(db.query(`DELETE FROM notebook_entry_version WHERE entry_id=$1 AND version_no=1`, [entry.id]),
    /foreign key|violates/i);
});
await check('full-text search finds an entry by its body', async () => {
  const hit = await one(
    `SELECT title FROM notebook_entry WHERE search_tsv @@ plainto_tsquery('english','three fragments')`);
  assert.match(hit.title, /Gibson/);
});

// --- primers and guides ---------------------------------------------------
await check('a primer keeps its tail and its binding site', async () => {
  const pr = await one(
    `INSERT INTO primer (lab_id,name,sequence,purpose,designed_in_entry_id)
     VALUES ($1,'gene F (BamHI)','GGATCCATGCGTACGTTAGCCAGTTA','cloning',$2) RETURNING id, length_nt`,
    [lab.id, entry.id]);
  assert.equal(pr.length_nt, 26);
  await db.query(
    `INSERT INTO primer_binding (primer_id,plasmid_id,start_pos,end_pos,strand,annealed_nt,tail_sequence)
     VALUES ($1,$2,400,420,1,20,'GGATCC')`, [pr.id, plasmid.id]);
  await fails(db.query(
    `INSERT INTO primer_binding (primer_id,plasmid_id,start_pos,end_pos,strand,annealed_nt)
     VALUES ($1,$2,400,420,1,20)`, [pr.id, plasmid.id]), /primer_binding_unique/);
  await fails(db.query(`INSERT INTO primer (lab_id,name,sequence) VALUES ($1,'tiny','ACGT')`, [lab.id]),
    /primer_length_sane/);
});
await check('a guide must have something to target', async () => {
  await fails(db.query(
    `INSERT INTO guide_rna (lab_id,name,spacer,pam_sequence,pam_pattern)
     VALUES ($1,'floating','ACGTTGCAACGTTGCAAGGT','AGG','NGG')`, [lab.id]), /guide_needs_a_target/);
});
await check('a pegRNA extends its guide and an insertion must say what it inserts', async () => {
  const g = await one(
    `INSERT INTO guide_rna (lab_id,name,kind,spacer,pam_sequence,pam_pattern,target_plasmid_id,
                            target_strand,target_start,cut_position)
     VALUES ($1,'peg1','pegRNA','ACGTTGCAACGTTGCAAGGT','AGG','NGG',$2,1,730,750) RETURNING id`,
    [lab.id, plasmid.id]);
  await fails(db.query(
    `INSERT INTO pegrna_detail (guide_id,pbs,rt_template,extension,edit_type,edit_position,edit_size_bp,nick_position)
     VALUES ($1,'TACGTACGTACGT','GGGGCCTACGCCC','GGGGCCTACGCCCTACGTACGTACGT','insertion',754,3,750)`, [g.id]),
    /pegrna_insertion_has_bases/);
  await db.query(
    `INSERT INTO pegrna_detail (guide_id,pbs,rt_template,extension,edit_type,edit_position,edit_size_bp,
                                inserted_bases,nick_position)
     VALUES ($1,'TACGTACGTACGT','GGGGCCTACGCCC','GGGGCCTACGCCCTACGTACGTACGT','insertion',754,3,'GGG',750)`, [g.id]);
  // deleting the guide takes the pegRNA detail with it
  await db.query(`DELETE FROM guide_rna WHERE id=$1`, [g.id]);
  const left = await one(`SELECT count(*)::int AS n FROM pegrna_detail WHERE guide_id=$1`, [g.id]);
  assert.equal(left.n, 0);
});

// --- samples, attachments, audit -----------------------------------------
await check('one tube per slot, until it is used up', async () => {
  const box = await one(`INSERT INTO storage_box (lab_id,name,freezer) VALUES ($1,'Box G1','Freezer A') RETURNING id`, [lab.id]);
  await db.query(`INSERT INTO plasmid_sample (plasmid_id,box_id,position,concentration_ng_ul)
    VALUES ($1,$2,'A3',285.5)`, [plasmid.id, box.id]);
  await fails(db.query(`INSERT INTO plasmid_sample (plasmid_id,box_id,position) VALUES ($1,$2,'A3')`,
    [plasmid.id, box.id]), /plasmid_sample_slot/);
  await db.query(`UPDATE plasmid_sample SET is_depleted = true WHERE box_id=$1 AND position='A3'`, [box.id]);
  await db.query(`INSERT INTO plasmid_sample (plasmid_id,box_id,position) VALUES ($1,$2,'A3')`, [plasmid.id, box.id]);
  await fails(db.query(`INSERT INTO plasmid_sample (plasmid_id,box_id,position) VALUES ($1,$2,'Z99')`,
    [plasmid.id, box.id]), /position_format/);
});
await check('an attachment belongs to exactly one thing', async () => {
  await db.query(`INSERT INTO attachment (lab_id,entry_id,filename,content_type,byte_size,storage_key)
    VALUES ($1,$2,'gel.png','image/png',20480,'s3://lab/gel.png')`, [lab.id, entry.id]);
  await fails(db.query(`INSERT INTO attachment (lab_id,entry_id,plasmid_id,filename,content_type,byte_size,storage_key)
    VALUES ($1,$2,$3,'both.png','image/png',10,'s3://lab/both.png')`, [lab.id, entry.id, plasmid.id]),
    /attachment_one_owner/);
  await fails(db.query(`INSERT INTO attachment (lab_id,filename,content_type,byte_size,storage_key)
    VALUES ($1,'orphan.png','image/png',10,'s3://lab/orphan.png')`, [lab.id]), /attachment_one_owner/);
});
await check('every change is recorded against the actor the request set', async () => {
  await db.exec(`SET app.current_user_id = '${user.id}'`);
  await db.query(`UPDATE plasmid SET notes = 'sequence verified' WHERE id=$1`, [plasmid.id]);
  const ev = await one(
    `SELECT action, actor_id, before_data->>'notes' AS was, after_data->>'notes' AS now_is, lab_id
       FROM audit_event WHERE table_name='plasmid' AND row_id=$1 ORDER BY id DESC LIMIT 1`, [plasmid.id]);
  assert.equal(ev.action, 'UPDATE');
  assert.equal(ev.actor_id, user.id);
  assert.equal(ev.was, null);
  assert.equal(ev.now_is, 'sequence verified');
  assert.equal(ev.lab_id, lab.id);
});
await check('updated_at moves on its own', async () => {
  const before = await one(`SELECT updated_at FROM plasmid WHERE id=$1`, [plasmid.id]);
  await db.query(`UPDATE plasmid SET notes='again' WHERE id=$1`, [plasmid.id]);
  const after = await one(`SELECT updated_at FROM plasmid WHERE id=$1`, [plasmid.id]);
  assert.ok(new Date(after.updated_at) >= new Date(before.updated_at));
});

console.log('\n' + pass + ' checks passed');
