/* Checks the import path: a real GenBank file in, a valid API payload out.
 *
 *     node scripts/check-plasmid-import.mjs
 *
 * The parsing itself is already covered by test-plasmid.js, next door.
 * What is new here is the join between the parser and the API — and the join
 * is where the two conventions meet, so it is where they can disagree.
 *
 * The fixture is a 480 bp circular construct carrying the three location
 * forms that matter: a plain span, a complement(), and a join() across the
 * origin. The last one is the reason this file exists.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const Plasmid = require('../js/plasmid.js');
const Import = require('../js/plasmid-import.js');
const Viewer = require('../js/vector-viewer.js');

let passed = 0;
const check = (what, fn) => {
  try { fn(); } catch (err) {
    console.log(`  FAIL  ${what}\n          ${err.message}`);
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log(`  ok    ${what}`);
};

const GB = fs.readFileSync(path.join(HERE, 'fixtures', 'pTEST-GFP.gb'), 'utf8');

/* --- parsing ------------------------------------------------------------- */

let parsed;

check('a GenBank file is recognised and read', () => {
  const r = Plasmid.parseFile('pTEST-GFP.gb', GB);
  assert.ok(r.ok, r.error);
  assert.equal(r.format, 'GenBank');
  parsed = r.plasmid;
  assert.equal(parsed.name, 'pTEST-GFP');
  assert.equal(parsed.topology, 'circular');
  assert.equal(parsed.seq.length, 480);
  assert.ok(parsed.seq.startsWith('ATGAGCAAAGGCGAAGAACTG'), parsed.seq.slice(0, 30));
});

check('the three location forms all come through', () => {
  const by = Object.fromEntries(parsed.features.map((f) => [f.name, f]));

  // plain span: GenBank 1..240 is 1-based inclusive, so [0, 240) here
  assert.equal(by.EGFP.start, 0);
  assert.equal(by.EGFP.end, 240);
  assert.equal(by.EGFP.strand, 1);

  // complement(310..420) -> the reverse strand
  assert.equal(by.AmpR.strand, -1);
  assert.equal(by.AmpR.start, 309);
  assert.equal(by.AmpR.end, 420);

  // join(460..480,1..20) across the origin -> start > end
  const wrap = by['origin-spanning tag'];
  assert.equal(wrap.start, 459);
  assert.equal(wrap.end, 20);
  assert.ok(wrap.start > wrap.end, 'a wrapping feature is start > end');
});

check('a colour in the file is kept, and the rest are given one', () => {
  const by = Object.fromEntries(parsed.features.map((f) => [f.name, f]));
  assert.equal(by.EGFP.color.toLowerCase(), '#2f9e44', 'ApEinfo_fwdcolor is honoured');
  assert.match(by['CMV promoter'].color, /^#[0-9a-f]{6}$/i);
});

/* --- the mapping to the API ---------------------------------------------- */

let payload;

check('it maps to a body the API will accept', () => {
  const out = Import.toCreatePayload(parsed, { external_source: 'Addgene #12345' },
                                     { colorFor: Plasmid.colorFor });
  payload = out.body;
  assert.deepEqual(out.warnings, []);
  assert.equal(payload.name, 'pTEST-GFP');
  assert.equal(payload.topology, 'circular');
  assert.equal(payload.sequence.length, 480);
  assert.equal(payload.external_source, 'Addgene #12345');
  assert.equal(payload.features.length, 5);
});

check('every feature satisfies the rules the schema enforces', () => {
  for (const f of payload.features) {
    assert.ok(f.name.length >= 1 && f.name.length <= 200, f.name);
    assert.ok(f.type_key.length <= 40, f.type_key);
    assert.ok(f.start_pos >= 0, `${f.name} start_pos`);
    assert.ok(f.end_pos > 0, `${f.name} end_pos`);
    assert.ok([-1, 0, 1].includes(f.strand), `${f.name} strand`);
    if (f.color !== undefined) assert.match(f.color, /^#[0-9a-fA-F]{6}$/);
    // The rule the Pydantic validator and the CHECK both apply.
    if (f.wraps_origin) {
      assert.ok(f.end_pos <= f.start_pos,
        `${f.name}: wraps_origin set but ${f.start_pos}–${f.end_pos} does not wrap`);
    } else {
      assert.ok(f.end_pos > f.start_pos,
        `${f.name}: ${f.start_pos}–${f.end_pos} is not a forward span`);
    }
  }
});

check('the wrapping feature is the one flagged, and only it', () => {
  const wrapping = payload.features.filter((f) => f.wraps_origin);
  assert.equal(wrapping.length, 1);
  assert.equal(wrapping[0].name, 'origin-spanning tag');
  assert.equal(wrapping[0].start_pos, 459);
  assert.equal(wrapping[0].end_pos, 20);
});

check('an empty span is dropped with a reason rather than sent', () => {
  const warnings = [];
  assert.equal(Import.toFeatureCreate({ name: 'nothing', start: 7, end: 7 }, warnings), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /nothing/);
  assert.match(warnings[0], /empty span/);
});

check('only colours the file actually carried are stored', () => {
  const by = Object.fromEntries(payload.features.map((f) => [f.name, f]));
  // The file set this one with /ApEinfo_fwdcolor.
  assert.equal(by.EGFP.color.toLowerCase(), '#2f9e44');
  // These had none, so plasmid.js invented a pale default for each. Storing
  // those makes every imported map one colour and suppresses the type-based
  // palette in vector-viewer.js — which is the thing that distinguishes a
  // promoter from a resistance marker at a glance.
  for (const name of ['CMV promoter', 'AmpR', 'source', 'origin-spanning tag']) {
    assert.equal(by[name].color, undefined,
      `${name} kept an invented colour (${by[name].color})`);
  }
});

check('and the viewer then colours those by what they are', () => {
  const model = Viewer.normalizePayload({
    sequence: payload.sequence, topology: payload.topology, features: payload.features,
  });
  const by = Object.fromEntries(model.annotations.map((a) => [a.name, a]));
  assert.equal(by['CMV promoter'].color, Viewer.TYPE_COLORS.promoter);
  assert.equal(by.AmpR.color, Viewer.TYPE_COLORS.cds);
  assert.equal(by.EGFP.color.toLowerCase(), '#2f9e44', 'the file still wins');
  // The point of all of it: the map is not one colour.
  assert.ok(new Set(model.annotations.map((a) => a.color)).size >= 3,
    'an imported map should not come out monochrome');
});

check('a plasmid with no source still says where it came from', () => {
  // The API refuses a plasmid that is neither built here nor obtained; an
  // import is always the second, so it must never be left blank.
  const { body } = Import.toCreatePayload(parsed, {});
  assert.ok(body.external_source, 'external_source must be set');
  assert.equal(body.external_source, 'imported file');
});

/* --- round trip into the viewer ------------------------------------------ */

check('what was parsed renders without translation', () => {
  const model = Viewer.normalizePayload(parsed);
  assert.equal(model.seq.length, 480);
  assert.equal(model.circular, true);
  assert.equal(model.annotations.length, 5, 'every feature is drawable');
  assert.deepEqual(model.warnings, [], 'and none of them was out of range');
});

check('the API shape renders too, which is what the page actually receives', () => {
  // POST returns PlasmidRead: `sequence`, `topology`, `features` with
  // start_pos/end_pos. The viewer has to take that without a mapping layer.
  const asRead = {
    name: payload.name,
    sequence: payload.sequence,
    topology: payload.topology,
    features: payload.features,
  };
  const model = Viewer.normalizePayload(asRead);
  assert.equal(model.annotations.length, 5);
  assert.equal(model.circular, true);
  const wrap = model.annotations.find((a) => a.name === 'origin-spanning tag');
  assert.equal(wrap.start, 459);
  assert.equal(wrap.end, 20, 'the wrap survives the whole round trip');
});

/* --- the other formats --------------------------------------------------- */

check('FASTA and a bare sequence are read too', () => {
  const fa = Plasmid.parseFile('x.fasta', '>pSomething a description\nATGCATGCATGCATGCATGCATGC\nATGCATGCATGCATGCATGCATGC\n');
  assert.ok(fa.ok, fa.error);
  assert.equal(fa.format, 'FASTA');
  assert.equal(fa.plasmid.seq.length, 48);

  const raw = Plasmid.parseFile('x.txt', 'atgcatgcatgcatgcatgcatgcatgcatgcatgc');
  assert.ok(raw.ok, raw.error);
  assert.equal(raw.plasmid.seq, 'ATGCATGCATGCATGCATGCATGCATGCATGCATGC');
});

check('prose is refused rather than imported as a sequence', () => {
  const r = Plasmid.parseFile('notes.txt', 'This is a note about the cloning, not a sequence at all.');
  assert.equal(r.ok, false);
  assert.match(r.error, /No DNA sequence/);
});

check('a .dna file that is not one is refused by name', () => {
  const r = Plasmid.parseFile('fake.dna', new Uint8Array(40).buffer);
  assert.equal(r.ok, false);
  assert.match(r.error, /SnapGene/);
});

/* --- which files are read as text ---------------------------------------- */

check('text formats are read as text, binary as bytes', () => {
  for (const name of ['a.gb', 'a.gbk', 'a.genbank', 'a.ape', 'a.fasta', 'a.fa', 'a.txt', 'a.seq']) {
    assert.ok(Import.isTextFormat(name), name);
  }
  assert.equal(Import.isTextFormat('a.dna'), false, 'SnapGene is binary');
  assert.equal(Import.isTextFormat('noextension'), false, 'unknown is treated as binary');
});

console.log(`\n${passed} checks passed`);
