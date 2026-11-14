/* Checks Golden Gate assembly.
 *
 *     node scripts/check-golden-gate.mjs
 *
 * The assembly itself is ordinary ligation, which has its own checks. What
 * is asserted here is the part that is specific to Golden Gate and that
 * fails silently at the bench: the order worked out from the overhangs, and
 * the three designs that produce wrong plasmids rather than no plasmid — a
 * repeated overhang, a palindromic one, and a recognition site left inside
 * a piece.
 *
 * Pieces are built base by base so the overhangs are known exactly.
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

/* Filler with no G, so neither BsaI's site (GGTCTC) nor the same site on
   the other strand (GAGACC) can appear in it by chance. Leaving out T
   instead is the obvious move and is not enough: GAGACC has no T in it, so
   a T-free filler quietly sprouts reverse-strand sites every few hundred
   bases and the cassette is cut in places the test never intended. */
function filler(n, seed) {
  let s = '', x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += 'ACT'[(x >> 16) % 3]; }
  return s;
}

/* A BsaI cassette. BsaI is GGTCTC(1/5): it cuts the top strand one base
   past the site and the bottom five past, leaving a 4-base 5' overhang
   whose sequence is whatever sits in positions 2-5 after the site.
   Two sites pointing inwards release the middle with the two overhangs
   that were designed into them. */
const rc = (s) => P.revcomp(s);
function cassette(leftOH, body, rightOH, pad = 60, seed = 3) {
  // left site reads forward into the body; right site reads back into it.
  return filler(pad, seed) + 'GGTCTC' + 'A' + leftOH + body + rightOH + 'A' + rc('GGTCTC') + filler(pad, seed + 1);
}

// The piece between the two BsaI sites, as digest() should return it.
function pieceOf(name, seq, topology = 'linear') {
  const p = { name, seq, topology, features: [] };
  const d = P.digest(p, ['BsaI']);
  // The released middle is the fragment with a BsaI overhang at both ends.
  const frag = d.fragments.filter((f) => f.left.ohang && f.right.ohang)
    .sort((a, b) => b.len - a.len)[0];
  return { name, frag, all: d.fragments };
}

console.log('Working out the order');

// A vector and two inserts, designed to chain A->B->C->A.
/* Every piece is a linear cassette whose middle is released by two
   inward-facing sites, which is how a synthesised part arrives. A circular
   vector works the same way, but the piece you keep is then the backbone —
   the one OUTSIDE the two sites — so its overhangs are the far sides of
   them, and a fixture that quietly picked the wrong fragment would be
   testing the wrong thing. */
const vec = pieceOf('pGG vector', cassette('CCAT', filler(900, 11), 'AATG', 80, 21));
const ins1 = pieceOf('promoter', cassette('AATG', filler(400, 31), 'GCTT'));
const ins2 = pieceOf('terminator', cassette('GCTT', filler(300, 41), 'CCAT'));

check('the test pieces really do carry the designed overhangs', () => {
  assert.equal(vec.frag.left.ohang, 'CCAT', `vector left was ${vec.frag.left.ohang}`);
  assert.equal(vec.frag.right.ohang, 'AATG');
  assert.equal(ins1.frag.left.ohang, 'AATG');
  assert.equal(ins1.frag.right.ohang, 'GCTT');
  assert.equal(ins2.frag.left.ohang, 'GCTT');
  assert.equal(ins2.frag.right.ohang, 'CCAT');
});

check('the pieces are ordered by their overhangs, not by how they were listed', () => {
  // Handed over in the wrong order on purpose.
  const r = P.goldenGate([vec, ins2, ins1], 'BsaI');
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.order.map((o) => o.name), ['pGG vector', 'promoter', 'terminator']);
  assert.equal(r.warnings.length, 0, `unexpected warnings: ${r.warnings}`);
});

check('the product is circular and is the pieces end to end', () => {
  const r = P.goldenGate([vec, ins1, ins2], 'BsaI');
  assert.ok(r.ok, r.error);
  assert.equal(r.product.topology, 'circular');
  const total = r.order.reduce((n, o) => n + o.len, 0);
  assert.equal(r.product.seq.length, total);
  assert.equal(r.order[0].start, 0);
  assert.equal(r.order[2].end, total);
});

check('one piece on its own is not an assembly', () => {
  const r = P.goldenGate([vec], 'BsaI');
  assert.equal(r.ok, false);
  assert.match(r.error, /vector and at least one insert/i);
});

console.log('\nDesigns that would fail at the bench');

check('two pieces starting with the same overhang are refused, not guessed at', () => {
  const clash = pieceOf('decoy', cassette('AATG', filler(200, 55), 'CCAT'));
  const r = P.goldenGate([vec, ins1, clash], 'BsaI');
  assert.equal(r.ok, false);
  assert.match(r.error, /AATG/);
  assert.match(r.error, /promoter|decoy/);
  assert.match(r.error, /no single order|redesign/i);
});

check('a chain that does not close is refused and says where it stops', () => {
  const dangling = pieceOf('wrong end', cassette('AATG', filler(200, 61), 'TTCA'));
  const r = P.goldenGate([vec, dangling], 'BsaI');
  assert.equal(r.ok, false);
  assert.match(r.error, /do not close into a circle|does not match/i);
});

check('a palindromic overhang is assembled but warned about', () => {
  // AATT is its own reverse complement.
  const v = pieceOf('pal vector', cassette('AATT', filler(500, 71), 'GCTT'));
  const i = pieceOf('pal insert', cassette('GCTT', filler(200, 81), 'AATT'));
  const r = P.goldenGate([v, i], 'BsaI');
  assert.ok(r.ok, r.error);
  assert.ok(r.warnings.some((w) => /AATT/.test(w) && /reverse complement|back to front/i.test(w)),
    `expected a palindrome warning, got ${JSON.stringify(r.warnings)}`);
});

check('a site left inside a piece is warned about', () => {
  /* A piece that still carries a BsaI site. It is built by hand rather
     than digested, because digesting it would of course cut there — which
     is the whole point of the warning. This is the piece somebody ends up
     with when the site came in on a synthesised part nobody re-checked. */
  const i = { name: 're-cut insert',
    frag: { seq: 'AATG' + filler(100, 91) + 'GGTCTC' + filler(100, 92), len: 210,
      left: { enzyme: 'BsaI', type: "5'", ohang: 'AATG' },
      right: { enzyme: 'BsaI', type: "5'", ohang: 'CCAT' }, features: [] } };
  const r = P.goldenGate([vec, i], 'BsaI');
  assert.ok(r.ok, r.error);
  assert.ok(r.warnings.some((w) => /re-cut insert/.test(w) && /cut again/i.test(w)),
    `expected a re-cutting warning, got ${JSON.stringify(r.warnings)}`);
});

check('a blunt piece is refused, because it has no overhang to assemble by', () => {
  const blunt = { name: 'blunt', frag: { seq: 'ACGTACGT', len: 8,
    left: { type: 'blunt', enzyme: 'SmaI' }, right: { type: 'blunt', enzyme: 'SmaI' }, features: [] } };
  const r = P.goldenGate([vec, blunt], 'BsaI');
  assert.equal(r.ok, false);
  assert.match(r.error, /overhang at both ends/i);
});

check('an enzyme that is not the one in hand is refused', () => {
  assert.match(P.goldenGate([vec, ins1], 'NotAnEnzyme').error, /Type IIS enzyme/i);
});

console.log('\nThe enzymes offered');

check('all four are real Type IIS enzymes in the table', () => {
  P.TYPE_IIS.forEach((n) => {
    const e = P.ENZYMES.filter((x) => x.n === n)[0];
    assert.ok(e, `${n} is offered but is not in the enzyme table`);
    assert.ok(e.t > e.s.length, `${n} must cut outside its recognition site to be Type IIS`);
  });
  assert.ok(P.isTypeIIS('BsaI'));
  assert.ok(!P.isTypeIIS('EcoRI'));
});

console.log(`\n${pass} checks passed`);
