/* Checks the sequencing-read alignment.
 *
 *     node scripts/check-align.mjs
 *
 * This is the step somebody decides a clone is correct on, so the things
 * asserted here are the ways it could be confidently wrong: a read placed
 * in the wrong place, a single-base deletion reported as a run of
 * mismatches, a position off by one against what the sequence page shows,
 * and a read from an entirely different plasmid reported as a match.
 *
 * Reads are built from the template, so the expected answer is known
 * exactly rather than eyeballed.
 */
import assert from 'assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(path.join(here, '..', 'js', 'plasmid.js'));

let pass = 0;
const check = (what, fn) => {
  try { fn(); } catch (err) {
    console.log(`  FAIL  ${what}\n          ${err.message}`);
    process.exitCode = 1;
    return;
  }
  pass++;
  console.log(`  ok    ${what}`);
};

// A 4000 bp template with no long repeats, so k-mer anchoring is unambiguous.
function template(n = 4000, seed = 99) {
  let s = '', x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += 'ACGT'[(x >> 16) & 3]; }
  return s;
}
const T = template();
const plasmid = { seq: T, topology: 'circular', features: [] };
const linear = { seq: T, topology: 'linear', features: [] };
const rc = (s) => P.revcomp(s);
// Noise on the ends, the way a Sanger read starts and finishes badly.
const noise = (n, seed = 5) => {
  let s = '', x = seed;
  for (let i = 0; i < n; i++) { x = (x * 48271) & 0x7fffffff; s += 'ACGT'[(x >> 8) & 3]; }
  return s;
};

console.log('Placing a read');

check('a clean read lands exactly where it came from', () => {
  const r = P.alignRead(plasmid, T.slice(1000, 1800));
  assert.ok(r.ok, r.reason);
  assert.equal(r.strand, 1);
  assert.equal(r.start, 1000, 'start is the 0-based first template base');
  assert.equal(r.end, 1800, 'end is the last base, 1-based inclusive');
  assert.equal(r.differences.length, 0);
  assert.equal(r.identity, 1);
});

check('a reverse read is found on the other strand, with forward coordinates', () => {
  const r = P.alignRead(plasmid, rc(T.slice(2200, 2900)));
  assert.ok(r.ok, r.reason);
  assert.equal(r.strand, -1);
  assert.equal(r.start, 2200);
  assert.equal(r.end, 2900);
  assert.equal(r.differences.length, 0);
});

check('a read from somewhere else is refused, not forced to fit', () => {
  const other = template(900, 12345);
  const r = P.alignRead(plasmid, other);
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not match|different plasmid/i);
});

check('a read too short to place says so', () => {
  const r = P.alignRead(plasmid, T.slice(0, 10));
  assert.equal(r.ok, false);
  assert.match(r.reason, /too short/i);
});

console.log('\nFinding what differs');

check('a single substitution is one mismatch at the right base', () => {
  const read = T.slice(1500, 2100).split('');
  const at = 300;                       // 1800 on the template
  const was = read[at];
  read[at] = was === 'A' ? 'G' : 'A';
  const r = P.alignRead(plasmid, read.join(''));
  assert.ok(r.ok, r.reason);
  assert.equal(r.differences.length, 1);
  const d = r.differences[0];
  assert.equal(d.kind, 'mismatch');
  assert.equal(d.at, 1800, 'the template position of the changed base');
  assert.equal(d.from, was);
  assert.equal(d.to, read[at]);
});

check('a dropped base is one deletion, not a run of mismatches', () => {
  // The case the whole aligner exists for: a frameshift must not read as
  // a bad sequencing run.
  const src = T.slice(1500, 2100);
  const read = src.slice(0, 300) + src.slice(301);
  const r = P.alignRead(plasmid, read);
  assert.ok(r.ok, r.reason);
  const dels = r.differences.filter((d) => d.kind === 'deletion');
  assert.equal(dels.length, 1, `expected one deletion, got ${JSON.stringify(r.differences)}`);
  assert.equal(dels[0].at, 1800);
  assert.equal(dels[0].from, T[1800]);
  assert.equal(r.differences.length, 1, 'and nothing else');
});

check('an extra base is one insertion', () => {
  const src = T.slice(1500, 2100);
  const read = src.slice(0, 300) + 'T' + src.slice(300);
  const r = P.alignRead(plasmid, read);
  assert.ok(r.ok, r.reason);
  const ins = r.differences.filter((d) => d.kind === 'insertion');
  assert.equal(ins.length, 1, `expected one insertion, got ${JSON.stringify(r.differences)}`);
  assert.equal(ins[0].to, 'T');
  assert.equal(r.differences.length, 1);
});

check('several scattered changes are all found', () => {
  const read = T.slice(1000, 1900).split('');
  [100, 400, 700].forEach((i) => { read[i] = read[i] === 'C' ? 'A' : 'C'; });
  const r = P.alignRead(plasmid, read.join(''));
  assert.ok(r.ok, r.reason);
  assert.equal(r.differences.length, 3);
  assert.deepEqual(r.differences.map((d) => d.at), [1100, 1400, 1700]);
});

console.log('\nThe ends of a read');

check('rubbish on both ends is trimmed, and the count is reported', () => {
  const read = noise(40, 7) + T.slice(1200, 1900) + noise(30, 11);
  const r = P.alignRead(plasmid, read);
  assert.ok(r.ok, r.reason);
  assert.ok(r.trimmedStart >= 30, `only ${r.trimmedStart} trimmed from the start`);
  assert.ok(r.trimmedEnd >= 20, `only ${r.trimmedEnd} trimmed from the end`);
  assert.ok(r.identity > 0.98, `identity fell to ${r.identity} after trimming`);
  assert.equal(r.differences.length, 0, 'the trimmed noise must not be reported as differences');
});

check('trimming never invents a perfect read out of a bad one', () => {
  // A read that disagrees in the middle keeps its difference.
  const read = noise(30, 3) + T.slice(1200, 1500) + 'AAAA' + T.slice(1504, 1800) + noise(20, 9);
  const r = P.alignRead(plasmid, read);
  assert.ok(r.ok, r.reason);
  assert.ok(r.differences.length > 0, 'the middle disagreement must survive trimming');
  assert.ok(r.identity < 1);
});

console.log('\nAround the origin');

check('a read across the origin of a circle is placed, not split', () => {
  const read = T.slice(3800) + T.slice(0, 400);     // 200 + 400 bases
  const r = P.alignRead(plasmid, read);
  assert.ok(r.ok, r.reason);
  assert.equal(r.start, 3800);
  assert.ok(r.wraps, 'it should be reported as running across the origin');
  assert.equal(r.differences.length, 0);
});

check('the same read on a linear record is not forced to wrap', () => {
  const read = T.slice(3800) + T.slice(0, 400);
  const r = P.alignRead(linear, read);
  // It may align the part that fits, but it must not claim a clean wrap.
  if (r.ok) assert.ok(!r.wraps, 'a linear record has no origin to cross');
});

console.log('\nReading what was pasted in');

check('FASTA comes back as named reads', () => {
  const reads = P.parseReads('>GFP_F read one\nACGTACGTAC\nGTACGT\n>GFP_R\nTTTTGGGGCC\n');
  assert.equal(reads.length, 2);
  assert.equal(reads[0].name, 'GFP_F read one');
  assert.equal(reads[0].seq, 'ACGTACGTACGTACGT');
  assert.equal(reads[1].name, 'GFP_R');
});

check('a bare sequence is one read', () => {
  const reads = P.parseReads('acgt acgt\nACGT');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].seq, 'ACGTACGTACGT');
});

check('nothing usable gives no reads rather than an empty one', () => {
  assert.equal(P.parseReads('').length, 0);
  assert.equal(P.parseReads('>just a header\n\n').length, 0);
});

console.log('\nThe pieces underneath');

check('the anchor refuses to guess from a single k-mer', () => {
  assert.equal(P.anchorRead(T, 'ACGT', 12), null, 'too short to anchor');
  assert.equal(P.anchorRead(T, template(300, 777), 12), null, 'unrelated sequence has no diagonal');
  const a = P.anchorRead(T, T.slice(600, 900), 12);
  assert.equal(a.diagonal, 600);
});

check('the banded alignment lines two sequences up', () => {
  const al = P.bandedAlign('ACGTACGT', 'ACGTACGT', 8);
  assert.equal(al.t, 'ACGTACGT');
  assert.equal(al.r, 'ACGTACGT');
  const gap = P.bandedAlign('ACGTACGT', 'ACGACGT', 8);
  assert.equal(gap.t.length, gap.r.length, 'both rows of an alignment are the same width');
  assert.ok(gap.r.includes('-'), 'the missing base shows as a gap');
});

console.log('\nThe coverage drawing');

const covReads = [
  { ...P.alignRead(plasmid, T.slice(500, 1200)), name: 'M13F' },
  { ...P.alignRead(plasmid, rc(T.slice(2000, 2700))), name: '<script>x</script>' }
];
const cov = P.alignmentSvg({ seq: T, topology: 'circular', features: [{ name: 'GFP', start: 600, end: 1300, color: '#cfe3ff' }] }, covReads, {});

check('one self-contained SVG with a bar per read', () => {
  assert.match(cov, /^<svg[^>]+viewBox=/);
  assert.match(cov, /<\/svg>$/);
  assert.equal((cov.match(/class="pl-cov-read"/g) || []).length, 2);
});

check('a read name is escaped, not injected', () => {
  assert.doesNotMatch(cov, /<script>/);
  assert.match(cov, /&lt;script&gt;/);
});

check('a record with no sequence draws nothing', () => {
  assert.equal(P.alignmentSvg({ seq: '', topology: 'linear' }, covReads, {}), '');
});

check('differences are described at 1-based positions', () => {
  assert.equal(P.diffText({ kind: 'mismatch', at: 1799, from: 'A', to: 'G' }), '1800: A \u2192 G');
  assert.match(P.diffText({ kind: 'deletion', at: 10, from: 'T', to: '' }), /^11: T missing/);
  assert.match(P.diffText({ kind: 'insertion', at: 10, from: '', to: 'C' }), /^11: C extra/);
});

console.log(`\n${pass} checks passed`);
