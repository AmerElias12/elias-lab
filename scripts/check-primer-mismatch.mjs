/* A primer that changes one base is annealed on both sides of the change.

   Run:  node scripts/check-primer-mismatch.mjs

   The binding used to stop at the first base that disagreed with the
   template and call everything 5' of it a free tail, so a mutagenic primer
   was drawn as mostly unattached. These are the cases that pin down where
   the line now is between a mismatch and a tail. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const P = createRequire(import.meta.url)('../js/plasmid.js');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

const left = 'ACGTTGCAAGGCTTACCGGATATCGGCATTGACC';
const mid = 'AAGACCCTGCTGGACTACGCCTCTAAGATCCGGGCCATC';
const right = 'TTGACGGATTCAGGCATCGATTACGGCTAAGCTTGGCACTGGCCGTCGTTTTACAACGTCGTGACTGGG';
const p = { seq: left + mid + right, topology: 'linear', features: [] };
const bind = (seq) => P.bindPrimers(p, seq, { minAnneal: 8 })[0];
// Y100F: TAC -> TTC, as the forward primer and as the reverse one.
const fw = 'GCTGGACTTCGCCTCTAAGATCC', rv = 'GGATCTTAGAGGCGAAGTCCAGCAGG';

check('one mismatch leaves the whole forward primer annealed', () => {
  const h = bind(fw);
  assert.equal(h.tail, '');
  assert.equal(h.anneal, fw);
  assert.deepEqual(h.mmIndex, [8]);
  assert.equal(p.seq[h.mismatches[0]], 'A');
  assert.equal(h.end - h.start, fw.length);
  assert.equal(h.perfect, false);
});
check('and the whole reverse primer, at the same base of the template', () => {
  const h = bind(rv);
  assert.equal(h.tail, '');
  assert.equal(h.strand, -1);
  assert.deepEqual(h.mismatches, bind(fw).mismatches);
});
check('a restriction site added to the 5′ end is still a tail', () => {
  const h = bind('AAAAGAATTC' + mid.slice(8, 28));
  assert.equal(h.tail, 'AAAAGAATTC');
  assert.deepEqual(h.mmIndex, []);
});
check('a primer that matches throughout has no mismatches and no tail', () => {
  const h = bind(mid.slice(5, 27));
  assert.equal(h.perfect, true);
  assert.equal(h.tail, '');
});
check('a mismatch with too little beyond it is not bridged', () => {
  // three matching bases past the mismatch do not pay for it
  const h = bind('CTG' + 'C' + mid.slice(12, 30));
  assert.equal(h.tail, 'CTGC');
});
check('the product carries the primer’s base, not the template’s', () => {
  const r = P.bindPrimers(p, P.revcomp(right.slice(30, 52)), { minAnneal: 8 })[0];
  const out = P.pcrProduct(p, bind(fw), r);
  assert.equal(out.seq.slice(0, fw.length), fw);
});

console.log('\n' + passed + ' checks passed');
