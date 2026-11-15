/* Checks the agarose gel simulation.
 *
 *     node scripts/check-gel.mjs
 *
 * A gel is read by eye, so the things worth asserting are the ones somebody
 * would otherwise be misled by: that bigger fragments stay above smaller
 * ones, that a small fragment is drawn faint rather than equal, that two
 * fragments a gel could not separate are drawn as one band, and that an
 * uncut circular plasmid says so instead of promising a band at its length.
 *
 * js/plasmid.js is a UMD module, so it loads in Node as it ships.
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

/* A sequence with known cut sites, built rather than typed: EcoRI (GAATTC)
   at 100 and 1000 and BamHI (GGATCC) at 900, in a 3000 bp circle. The
   three cuts give pieces of clearly different sizes, so a lane here is
   testing the digest and not the merging of bands too close to tell apart,
   which has a test of its own above.
   The filler uses no T, so neither site — both of which contain one — can
   turn up in it by chance. A random ACGT filler gives an extra EcoRI site
   every four kilobases or so, which is a fixture that quietly tests
   something other than what it says. */
function build() {
  let s = '';
  let x = 7;
  for (let i = 0; i < 3000; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += 'ACG'[(x >> 16) % 3]; }
  const put = (seq, at, site) => seq.slice(0, at) + site + seq.slice(at + site.length);
  s = put(s, 100, 'GAATTC');
  s = put(s, 1000, 'GAATTC');
  s = put(s, 900, 'GGATCC');
  return { name: 'pTEST', seq: s, topology: 'circular', features: [] };
}
const p = build();

console.log('How far a fragment runs');

check('a bigger fragment never runs further than a smaller one', () => {
  let last = -1;
  for (const bp of [20000, 10000, 5000, 3000, 1000, 500, 100, 50]) {
    const y = P.gelMigrate(bp, 1);
    assert.ok(y > last, `${bp} bp runs ${y}, not past the ${last} before it`);
    last = y;
  }
});

check('everything stays on the gel', () => {
  for (const bp of [1, 50, 1e6]) {
    const y = P.gelMigrate(bp, 1);
    assert.ok(y > 0 && y < 1, `${bp} bp lands at ${y}`);
  }
});

check('a higher percentage spreads the small fragments out', () => {
  // 200 and 400 bp are one smear on 0.5% and well apart on 2%.
  const low = Math.abs(P.gelMigrate(400, 0.5) - P.gelMigrate(200, 0.5));
  const high = Math.abs(P.gelMigrate(400, 2.0) - P.gelMigrate(200, 2.0));
  assert.ok(high > low * 1.5, `0.5% separates them by ${low}, 2% by ${high}`);
});

console.log('\nBands');

check('equimolar fragments are drawn by mass, so small is faint', () => {
  const bands = P.gelBands([3000, 300], 1);
  const big = bands.find((b) => b.bp === 3000);
  const small = bands.find((b) => b.bp === 300);
  assert.equal(big.intensity, 1);
  assert.ok(small.intensity < big.intensity, 'the small fragment must be fainter');
  assert.ok(small.intensity > 0, 'but it is still there to be seen');
});

check('two fragments a gel cannot separate are one band', () => {
  const bands = P.gelBands([2000, 2005], 1);
  assert.equal(bands.length, 1, 'they would be one band on a real gel');
  assert.equal(bands[0].bps.length, 2);
  assert.match(bands[0].label, /2005 \+ 2000 bp/, 'both lengths, exactly, since they are not one piece');
});

check('fragments a gel can separate stay apart', () => {
  assert.equal(P.gelBands([2000, 1000], 1).length, 2);
});

console.log('\nLanes');

check('a digest gives one band per fragment, biggest first', () => {
  const lane = P.gelLane({ name: 'pTEST', seq: p.seq, topology: 'circular', enzymes: ['EcoRI'] }, { percent: 1 });
  assert.equal(lane.kind, 'sample');
  assert.equal(lane.lengths.length, 2, 'two cuts in a circle give two pieces');
  assert.equal(lane.lengths[0] + lane.lengths[1], 3000, 'the pieces add up to the plasmid');
  assert.ok(lane.lengths[0] >= lane.lengths[1], 'listed biggest first');
  assert.equal(lane.note, 'EcoRI');
});

check('two enzymes cut it into three', () => {
  const lane = P.gelLane({ name: 'pTEST', seq: p.seq, topology: 'circular', enzymes: ['EcoRI', 'BamHI'] }, { percent: 1 });
  assert.equal(lane.lengths.length, 3);
  assert.equal(lane.lengths.reduce((a, b) => a + b, 0), 3000);
  assert.equal(lane.note, 'EcoRI + BamHI');
});

check('an uncut circular plasmid says what a real gel would show', () => {
  const lane = P.gelLane({ name: 'pTEST', seq: p.seq, topology: 'circular', enzymes: [] }, { percent: 1 });
  assert.ok(lane.uncut);
  assert.equal(lane.lengths.length, 1);
  assert.match(lane.note, /supercoiled/, 'it must not promise a clean band at its length');
});

check('an enzyme that does not cut says so rather than going quiet', () => {
  // XbaI is TCTAGA. The filler has no T and neither planted site spells
  // this, so it cannot be there by accident.
  const lane = P.gelLane({ name: 'pTEST', seq: p.seq, topology: 'circular', enzymes: ['XbaI'] }, { percent: 1 });
  assert.ok(lane.uncut);
  assert.match(lane.note, /not cut by XbaI/);
});

check('a record with no sequence is an empty lane, not a crash', () => {
  const lane = P.gelLane({ name: 'empty', seq: '' }, { percent: 1 });
  assert.equal(lane.bands.length, 0);
  assert.match(lane.note, /no sequence/);
});

check('a ladder is its stated bands, with the heavy ones brighter', () => {
  const lane = P.gelLane({ ladder: '1 kb' }, { percent: 1 });
  assert.equal(lane.kind, 'ladder');
  assert.equal(lane.bands.length, 10);
  const bright = lane.bands.find((b) => b.bp === 3000);
  const plain = lane.bands.find((b) => b.bp === 8000);
  assert.ok(bright.intensity > plain.intensity, 'the reference band is the heavy one');
});

check('an unknown ladder falls back rather than drawing nothing', () => {
  assert.ok(P.gelLane({ ladder: 'not a ladder' }, { percent: 1 }).bands.length > 0);
});

console.log('\nThe drawing');

const svg = P.gelSvg([
  P.gelLane({ ladder: '1 kb' }, { percent: 1 }),
  P.gelLane({ name: 'pTEST', seq: p.seq, topology: 'circular', enzymes: ['EcoRI'] }, { percent: 1 })
], {});

check('it is one self-contained SVG', () => {
  assert.match(svg, /^<svg[^>]+viewBox=/);
  assert.match(svg, /<\/svg>$/);
});

check('it carries its own styles, so a downloaded copy still looks like a gel', () => {
  assert.match(svg, /<style>[\s\S]*pl-gel-band/, 'the band colour must travel with the file');
  assert.doesNotMatch(svg, /var\(--/, 'a page variable does not resolve in a standalone file');
});

check('every band is drawn and titled', () => {
  const bands = svg.match(/class="pl-gel-band"/g) || [];
  assert.equal(bands.length, 12, '10 ladder bands and 2 from the digest');
  assert.match(svg, /<title>pTEST/);
});

check('a lane name is escaped, not injected', () => {
  const bad = P.gelSvg([P.gelLane({ name: '<script>x</script>', seq: 'ACGTACGTACGTACGTACGT', topology: 'linear' }, {})], {});
  assert.doesNotMatch(bad, /<script>/);
  assert.match(bad, /&lt;script&gt;/);
});

check('no lanes draws nothing at all', () => {
  assert.equal(P.gelSvg([], {}), '');
});

console.log('\nGetting to the gel');

/* The maths above is only reachable if the screen offers a way in. These
   read the shipped source, because the failure they guard against was not
   a wrong band — it was a digest on screen with no way to see it run. */
import fs from 'fs';
const ui = fs.readFileSync(path.join(here, '..', 'js', 'plasmid-ui.js'), 'utf8');

check('a digest can be carried straight onto a gel', () => {
  assert.match(ui, /function openGel\(prefillId, enzymes\)/,
    'openGel must accept the enzymes that made the digest');
  assert.match(ui, /lanes: \[\{ id: first\.id, enzymes: \(enzymes \|\| \[\]\)/,
    'and put them in the first lane');
});

check('the enzyme panel offers it, where the enzymes are actually chosen', () => {
  assert.match(ui, /id="pl-enz-gel"[^>]*onclick="plEnzOnGel\(\)"/);
  const fn = ui.slice(ui.indexOf('function plEnzOnGel'), ui.indexOf('function plEnzApply'));
  assert.match(fn, /openGel\(id, picked\)/, 'it must carry the ticked enzymes through');
  assert.match(fn, /plEnzPicked\.length/, 'and refuse when nothing is ticked');
});

check('the record page offers it too', () => {
  // It is an entry in the Analyze menu now, not a button of its own.
  assert.match(ui, /\['Virtual gel', 'plGelFromHere\(\)'\]/);
  const fn = ui.slice(ui.indexOf('function plGelFromHere'), ui.indexOf('// Every lane as P.gelLane'));
  assert.match(fn, /plOpts\.enzymes === 'custom' \? plOpts\.enzymeNames : \[\]/,
    'enzymes chosen by hand come along; a menu of twenty does not');
});

check('a record with no sequence is refused rather than swapped for another', () => {
  const fn = ui.slice(ui.indexOf('function openGel'), ui.indexOf('function plGelFromHere'));
  assert.match(fn, /if \(prefillId && !want\)/, 'a named record that cannot be cut must say so');
  assert.match(fn, /no sequence yet/);
});

check('records left out of the lane menu are accounted for', () => {
  assert.match(ui, /not listed above, because/,
    'a plasmid missing from the menu needs a reason, or it reads as lost');
});

console.log(`\n${pass} checks passed`);
