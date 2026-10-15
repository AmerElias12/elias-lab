/* Checks for the page-free half of static/js/vector-viewer.js.
 *
 *     node scripts/check-vector-viewer.mjs
 *
 * No browser and no SeqViz: this covers payload normalisation, coordinate
 * conventions and origin wrapping, which is where the bugs are. Whether
 * SeqViz draws the result is a question for the browser, and the selection
 * shape these assertions assume was read off a real SeqViz event rather than
 * from its documentation:
 *
 *     linear drag        { start: 1,   end: 15,  length: 14, type: "SEQ" }
 *     annotation click   { start: 0,   end: 60,  length: 60, type: "ANNOTATION", name: "GFP" }
 *     across the origin  { start: 104, end: 6,   length: 16, type: "SEQ" }   // 114 bp
 */
import assert from 'assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const V = require('../static/js/vector-viewer.js');

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

// 114 bp, the sequence the real SeqViz events above were captured against.
const SEQ =
  'ATGAGCAAAGGCGAAGAACTGTTTACCGGCGTGGTGCCGATTCTGGTGGAACTGGATGGCGATGTGAACGGCCATAAATTTAGCGTGAGCGGCGAAGGCGAAGGCGATGCGACC';

/* --- payload normalisation ---------------------------------------------- */

check('it accepts the ELN API shape', () => {
  const m = V.normalizePayload({
    name: 'pLenti-GFP',
    sequence: SEQ,
    topology: 'circular',
    features: [
      { name: 'EGFP', type_key: 'CDS', start_pos: 0, end_pos: 60, strand: 1 },
    ],
  });
  assert.equal(m.seq, SEQ);
  assert.equal(m.circular, true);
  assert.equal(m.annotations.length, 1);
  assert.equal(m.annotations[0].start, 0);
  assert.equal(m.annotations[0].end, 60);
  assert.equal(m.annotations[0].direction, 1);
});

check('it accepts the SeqViz shape it will hand back', () => {
  const m = V.normalizePayload({
    seq: SEQ,
    annotations: [{ name: 'GFP', start: 0, end: 60, direction: -1 }],
  });
  assert.equal(m.annotations[0].direction, -1);
});

check('it accepts what js/plasmid.js produces', () => {
  const m = V.normalizePayload({
    name: 'pUC19',
    seq: SEQ,
    circular: true,
    features: [{ name: 'AmpR', type: 'CDS', start: 10, end: 50, strand: -1 }],
  });
  assert.equal(m.annotations[0].direction, -1);
  assert.equal(m.annotations[0].name, 'AmpR');
});

check('it cleans up a pasted sequence rather than refusing it', () => {
  const pasted = '   1 atgagcaaag gcgaagaact\n  21 gtttaccggc gtggtgccga';
  const m = V.normalizePayload({ seq: pasted, features: [] });
  assert.equal(m.seq, 'ATGAGCAAAGGCGAAGAACTGTTTACCGGCGTGGTGCCGA');
});

check('it refuses something that is not DNA', () => {
  assert.throws(() => V.normalizePayload({ seq: 'hello world, this is prose' }), /non-DNA/);
  assert.throws(() => V.normalizePayload({ features: [] }), /needs a DNA sequence/);
  assert.throws(() => V.normalizePayload(null), /must be an object/);
});

check('a feature outside the sequence is dropped, with a reason', () => {
  const m = V.normalizePayload({
    seq: SEQ,
    features: [
      { name: 'good', start: 0, end: 10 },
      { name: 'past the end', start: 100, end: 9999 },
      { name: 'not a number', start: 'x', end: 10 },
    ],
  });
  assert.equal(m.annotations.length, 1, 'only the placeable one survives');
  assert.equal(m.warnings.length, 2);
  assert.match(m.warnings[0], /past the end/);
  assert.match(m.warnings[0], /114 bp/, 'the warning says what it was measured against');
});

check('a linear construct stays linear', () => {
  assert.equal(V.normalizePayload({ seq: SEQ, topology: 'linear' }).circular, false);
  assert.equal(V.normalizePayload({ seq: SEQ, circular: false }).circular, false);
  // A plasmid with nothing said about it is circular, which is the common case.
  assert.equal(V.normalizePayload({ seq: SEQ }).circular, true);
});

/* --- colours ------------------------------------------------------------- */

check('features are coloured by what they are', () => {
  const promoter = V.colorFor({ name: 'CMV promoter' });
  const marker = V.colorFor({ name: 'AmpR resistance' });
  const tag = V.colorFor({ name: '6xHis tag' });
  const plain = V.colorFor({ name: 'something unlabelled' });
  assert.equal(promoter, V.TYPE_COLORS.promoter);
  assert.equal(marker, V.TYPE_COLORS.selection);
  assert.equal(tag, V.TYPE_COLORS.tag);
  assert.notEqual(promoter, marker);
  assert.notEqual(marker, tag);
  assert.equal(plain, V.TYPE_COLORS.misc_feature);
});

check('an explicit colour wins over the palette', () => {
  assert.equal(V.colorFor({ name: 'CMV promoter', color: '#123456' }), '#123456');
});

/* --- selections ---------------------------------------------------------- */

check('a plain drag gives the bases it covers', () => {
  const d = V.describeSelection(SEQ, { start: 1, end: 15, length: 14, type: 'SEQ' });
  assert.equal(d.length, 14);
  assert.equal(d.bases, SEQ.slice(1, 15));
  assert.equal(d.bases, 'TGAGCAAAGGCGAA');
  assert.equal(d.kind, 'sequence');
  assert.equal(d.crossesOrigin, false);
});

check('coordinates are reported both ways round', () => {
  const d = V.describeSelection(SEQ, { start: 0, end: 60, type: 'ANNOTATION', name: 'GFP' });
  // 0-based half-open in, 1-based inclusive out: [0, 60) is bases 1 to 60.
  assert.equal(d.start, 0);
  assert.equal(d.end, 60);
  assert.equal(d.startDisplay, 1);
  assert.equal(d.endDisplay, 60);
  assert.equal(d.length, 60);
  assert.equal(d.featureName, 'GFP');
  assert.equal(d.kind, 'feature');
});

check('a selection across the origin is the tail then the head', () => {
  // The real event: start 104, end 6, length 16, on 114 bp.
  const d = V.describeSelection(SEQ, { start: 104, end: 6, length: 16, type: 'SEQ' });
  assert.equal(d.crossesOrigin, true);
  assert.equal(d.length, 16, 'and the length agrees with what SeqViz reported');
  assert.equal(d.bases, SEQ.slice(104) + SEQ.slice(0, 6));
  assert.equal(d.startDisplay, 105);
  assert.equal(d.endDisplay, 6);
  // Slicing it the naive way is the bug this guards against.
  assert.equal(SEQ.slice(104, 6), '', 'a plain slice would silently return nothing');
});

check('a selection that runs to the very end is not a wrap', () => {
  const d = V.describeSelection(SEQ, { start: 100, end: 0, type: 'SEQ' });
  assert.equal(d.bases, SEQ.slice(100));
  assert.equal(d.crossesOrigin, false);
  assert.equal(d.endDisplay, SEQ.length, 'not 0, which is not a coordinate');
});

check('an empty selection says so instead of pretending', () => {
  for (const sel of [null, undefined, { start: 5, end: 5 }, {}]) {
    const d = V.describeSelection(SEQ, sel);
    assert.equal(d.length, 0);
    assert.equal(d.bases, '');
    assert.equal(d.startDisplay, 0);
    assert.equal(V.formatSelection(d), 'No selection');
  }
});

check('the reverse complement is the other strand, read the other way', () => {
  const d = V.describeSelection('ATGC', { start: 0, end: 4, type: 'SEQ' });
  assert.equal(d.revComp, 'GCAT');
  assert.equal(V.revComp('AAGGTTCC'), 'GGAACCTT');
  assert.equal(V.revComp(V.revComp(SEQ)), SEQ, 'and twice is where it started');
});

check('GC content is a percentage of the selection, not of the plasmid', () => {
  assert.equal(V.gcPercent('GGCC'), 100);
  assert.equal(V.gcPercent('ATAT'), 0);
  assert.equal(V.gcPercent('ATGC'), 50);
  assert.equal(V.gcPercent(''), 0, 'and an empty selection is not a division by zero');
  const d = V.describeSelection(SEQ, { start: 0, end: 4, type: 'SEQ' });
  assert.equal(d.bases, 'ATGA');
  assert.equal(d.gc, 25);
});

check('the one-line summary carries the coordinates and the bases', () => {
  const d = V.describeSelection(SEQ, { start: 104, end: 6, type: 'SEQ' });
  const line = V.formatSelection(d);
  assert.match(line, /105–6/);
  assert.match(line, /crosses the origin/);
  assert.match(line, /16 bp/);
  assert.ok(line.includes(d.bases), 'the bases themselves are in it');
});

check('a long selection is abbreviated in the summary but not in the data', () => {
  // A real plasmid is kilobases; 114 bp fits on a line and is not the case
  // worth testing. A 2 kb selection is.
  const big = SEQ.repeat(18);                       // 2052 bp
  const long = V.describeSelection(big, { start: 0, end: big.length, type: 'SEQ' });
  assert.equal(long.bases.length, 2052, 'the full selection is still available');
  const line = V.formatSelection(long);
  assert.ok(line.includes('…'), 'but the printed line is trimmed');
  assert.ok(line.length < 200, `the summary stayed ${line.length} characters`);
  assert.ok(line.includes(big.slice(0, 60)), 'it shows the start');
  assert.ok(line.includes(big.slice(-60)), 'and the end');
});

check('createViewer refuses clearly when SeqViz is absent', () => {
  // In Node there is no window, which is the same failure as forgetting the
  // script tag. The message should say so rather than "Viewer is undefined".
  assert.throws(() => V.createViewer('anything', { seq: SEQ }), /SeqViz is not loaded/);
});

console.log(`\n${passed} checks passed`);
