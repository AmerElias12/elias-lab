/* Checks aliquot tracking on Kits & Reagents.
 *
 *     node scripts/check-aliquots.mjs
 *
 * A reagent arrives as one tube and is split the same day. The count of
 * what is left is the thing people act on — whether to start an experiment,
 * whether to ask for an order — so the two states that should stop somebody
 * are worth asserting, and so is the arithmetic that gets to them.
 *
 * The functions are run out of the shipped js/notebook.js, in a sandbox with
 * just enough of a browser around it to let the file define itself. Nothing
 * in it runs on its own; the page only acts on events that never arrive.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const noop = () => {};
const sandbox = {
  document: { addEventListener: noop, getElementById: () => null, visibilityState: 'hidden' },
  addEventListener: noop,
  setInterval: noop,
  console
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js', 'notebook.js'), sandbox, { filename: 'notebook.js' });

const src = read('js', 'notebook.js');
const mentions = read('js', 'mentions.js');
const html = read('notebook.html');
const { aliquotCount, aliquotSize, aliquotState, INV_CONFIG, ALIQUOT_UNITS,
  BULK_EXAMPLES, bulkColumns, bulkMapHeader } = sandbox;

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

console.log('Reading a count');

check('a plain count is a number', () => {
  assert.equal(aliquotCount({ aliquots: '12' }), 12);
  assert.equal(aliquotCount({ aliquots: 12 }), 12);
  assert.equal(aliquotCount({ aliquots: '0' }), 0);
});

check('no count at all is not the same as none left', () => {
  // A reagent nobody aliquoted must not be reported as "out of aliquots":
  // that is the difference between a full bottle and an empty shelf.
  assert.equal(aliquotCount({}), null);
  assert.equal(aliquotCount({ aliquots: '' }), null);
  assert.equal(aliquotCount({ aliquots: null }), null);
  assert.equal(aliquotCount(null), null);
  assert.notEqual(aliquotCount({ aliquots: '0' }), null, '0 is a real answer');
});

check('nonsense does not become a number', () => {
  assert.equal(aliquotCount({ aliquots: 'a dozen' }), null);
  assert.equal(aliquotCount({ aliquots: '-3' }), null, 'a negative count is not a count');
  assert.equal(aliquotCount({ aliquots: 'many' }), null);
});

check('a count typed with its unit still reads as the count', () => {
  // Bulk uploads arrive with "12 tubes" in the column often enough.
  assert.equal(aliquotCount({ aliquots: '12 tubes' }), 12);
});

console.log('\nWhat the table says about it');

check('nothing is said while there is plenty', () => {
  // The cell already prints the number; a badge repeating it is noise.
  assert.equal(aliquotState({ aliquots: '12' }), null);
  assert.equal(aliquotState({ aliquots: '2' }), null);
  assert.equal(aliquotState({}), null);
});

check('the last one and none left are both called out', () => {
  assert.equal(aliquotState({ aliquots: '1' }).note, 'last one');
  assert.equal(aliquotState({ aliquots: '1' }).cls, 'expired');
  assert.equal(aliquotState({ aliquots: '0' }).note, 'none left');
  assert.equal(aliquotState({ aliquots: '0' }).cls, 'expired');
});

check('the size reads as an amount, or says nothing', () => {
  assert.equal(aliquotSize({ aliquotVol: '500', aliquotUnit: 'µL' }), '500 µL');
  assert.equal(aliquotSize({ aliquotVol: '1.5', aliquotUnit: 'mL' }), '1.5 mL');
  assert.equal(aliquotSize({ aliquotVol: '500' }), '500', 'a volume with no unit is still a volume');
  assert.equal(aliquotSize({ aliquotUnit: 'mL' }), '', 'a unit with no number says nothing');
  assert.equal(aliquotSize({}), '');
  assert.equal(aliquotSize(null), '');
});

console.log('\nTaking one off the shelf');

check('the button is offered only when there is one to take', () => {
  // aliquotCount returns 0 for an empty shelf and null for an unaliquoted
  // reagent; both are falsy, which is what the row test relies on.
  assert.ok(!aliquotCount({ aliquots: '0' }), 'nothing to take from an empty shelf');
  assert.ok(!aliquotCount({}), 'nothing to take from a reagent nobody split');
  assert.ok(aliquotCount({ aliquots: '1' }), 'the last one can still be taken');
});

check('taking one subtracts exactly one and never goes below zero', () => {
  const take = src.slice(src.indexOf('async function takeAliquot'), src.indexOf('/* The squares that are left'));
  assert.match(take, /if \(!item \|\| !n\) return;/, 'it must refuse when there is nothing to take');
  assert.match(take, /aliquots: String\(n - 1\)/);
  assert.match(take, /Object\.assign\(\{\}, item/, 'the rest of the record has to survive the edit');
  assert.match(take, /renderInventory\('kits'\)/);
  assert.match(take, /catch \(e\)[\s\S]*?alert/, 'a failed write must not look like a success');
});

console.log('\nThe tube leaves its square');

const { positionsAfterTaking, formatPositions, parsePositions } = sandbox;
const dims = { rows: 9, cols: 9 };
const after = (pos, left, d = dims) => positionsAfterTaking(pos, left, d);

check('taking one of ten gives up the last square', () => {
  // The case from the bench: ten 10 mL aliquots in C1-C5 and D1-D5.
  assert.equal(after('C1-C5, D1-D5', 9), 'C1-C5, D1-D4');
  assert.equal(after('C1-C5, D1-D4', 8), 'C1-C5, D1-D3');
});

check('a row that empties drops out, and the last tube takes the position with it', () => {
  assert.equal(after('C1-C5, D1', 5), 'C1-C5');
  assert.equal(after('A3', 0), '');
});

check('a block stays a block for as long as it is one', () => {
  assert.equal(after('A1-C3', 8), 'A1-B3, C1-C2');
  assert.equal(after('A1-C3', 6), 'A1-B3');
});

check('numbered positions stay numbered', () => {
  assert.equal(after('1-12', 11), '1-11');
  assert.equal(after('5', 0), '');
});

check('a count that had run ahead of its squares is put right', () => {
  // Left by the old button: eight aliquots still drawn in ten squares.
  assert.equal(after('C1-C5, D1-D5', 7), 'C1-C5, D1-D2');
});

check('tubes the map never knew about are taken first', () => {
  assert.equal(after('B1-B9', 11), null, 'twelve tubes, nine squares: the squares stay');
  assert.equal(after('B1-B9', 9), null);
});

check('a position that names no square is left alone', () => {
  assert.equal(after('top shelf, left', 3), null);
  assert.equal(after('', 3), null);
});

check('what is written back reads as the same squares', () => {
  for (const pos of ['C1-C5, D1-D5', 'A1-C3', 'A1, B1, C1', 'A1-A9, B1-B4', 'A2, A4-A6, C1']) {
    const cells = parsePositions(pos, dims);
    const back = parsePositions(formatPositions(cells, dims, false), dims);
    assert.deepEqual(back.map((c) => c.r + ',' + c.c), cells.map((c) => c.r + ',' + c.c), pos);
  }
  assert.equal(formatPositions(parsePositions('A1, B1', dims), dims, false), 'A1, B1');
});

check('the button changes the square and the count in one write', () => {
  const take = src.slice(src.indexOf('async function takeAliquot'), src.indexOf('/* The squares that are left'));
  assert.match(take, /positionsAfterTaking\(item\.position, n - 1/);
  assert.match(take, /if \(kept !== null\) next\.position = kept;/);
  assert.equal((take.match(/DB\.upsertInventory/g) || []).length, 1);
  assert.match(take, /lnCurrentSection === 'boxes'\) renderBoxes\(\)/, 'an open box map has to redraw');
});

console.log('\nThe form and what it saves');

check('the three fields are on the kit form', () => {
  const forms = src.slice(src.indexOf('kits: \'<div class="ln-form-row"><label>Kit Name'));
  assert.match(forms.slice(0, 2000), /id="m-aliquots" type="number" min="0" step="1"/);
  assert.match(forms.slice(0, 2000), /id="m-aliquotVol" type="number" min="0"/);
  assert.match(forms.slice(0, 2000), /<select id="m-aliquotUnit">/);
});

check('the unit is chosen from a list, not typed', () => {
  // µl, uL and ul are one volume; as free text they search and sort as three.
  assert.ok(ALIQUOT_UNITS.indexOf('µL') >= 0);
  assert.ok(ALIQUOT_UNITS.indexOf('mL') >= 0);
  assert.ok(ALIQUOT_UNITS.length >= 4);
  const uniq = ALIQUOT_UNITS.filter((u, i, a) => a.indexOf(u) === i);
  assert.equal(uniq.length, ALIQUOT_UNITS.length, 'a unit is listed twice');
  assert.doesNotMatch(src, /id="m-aliquotUnit"[^>]*>\s*<input/, 'the unit must not be a text input');
});

check('the form says what to do when a reagent is not aliquoted', () => {
  const forms = src.slice(src.indexOf('<div class="ln-form-section">Aliquots</div>'));
  assert.match(forms.slice(0, 800), /Leave blank/i);
});

check('a count that is not a whole number is refused, with somewhere to put it', () => {
  const save = src.slice(src.indexOf("else if (tab === 'kits')"), src.indexOf("else if (tab === 'requests')"));
  assert.match(save, /!\/\^\\d\+\$\/\.test\(item\.aliquots\)/);
  assert.match(save, /whole number/i);
  assert.match(save, /Quantity Remaining/, 'refusing input without saying where it goes is a dead end');
  assert.match(save, /parseFloat\(item\.aliquotVol\)/);
});

check('a unit with nothing to measure is not saved', () => {
  const save = src.slice(src.indexOf("else if (tab === 'kits')"), src.indexOf("else if (tab === 'requests')"));
  assert.match(save, /if \(!item\.aliquots && !item\.aliquotVol\) item\.aliquotUnit = '';/);
});

console.log('\nThe table, the export and the upload template');

check('the columns and fields line up', () => {
  const k = INV_CONFIG.kits;
  assert.equal(k.cols.length, k.fields.length, 'a column with no field prints the wrong value in every row');
  ['aliquots', 'aliquotVol', 'aliquotUnit'].forEach((f) => {
    assert.ok(k.fields.indexOf(f) >= 0, f + ' is not a kit column');
  });
  // Next to Qty Left, before the expiry, where somebody looking for stock reads.
  assert.ok(k.fields.indexOf('aliquots') > k.fields.indexOf('qty'));
  assert.ok(k.fields.indexOf('aliquots') < k.fields.indexOf('expiry'));
});

check('all three reach the CSV and the bulk template', () => {
  // Both are built from INV_CONFIG, so an exported sheet can be edited and
  // uploaded back without losing the aliquots.
  const cols = bulkColumns('kits').map((c) => c.field);
  ['aliquots', 'aliquotVol', 'aliquotUnit'].forEach((f) => {
    assert.ok(cols.indexOf(f) >= 0, f + ' is missing from the upload template');
    assert.ok(BULK_EXAMPLES.kits[f], f + ' has no example in the template instructions');
  });
});

check('an exported sheet maps back onto the same fields', () => {
  const header = INV_CONFIG.kits.cols;
  const m = bulkMapHeader('kits', header);
  assert.ok(m, 'the template header does not even match its own category');
  const mapped = Object.keys(m.cols).map((i) => m.cols[i]);
  ['aliquots', 'aliquotVol', 'aliquotUnit'].forEach((f) => {
    assert.ok(mapped.indexOf(f) >= 0, f + ' is lost on re-upload');
  });
});

check('the headings people actually type are understood', () => {
  const m = bulkMapHeader('kits', ['Kit Name', 'Number of aliquots', 'Volume per aliquot', 'Unit']);
  assert.ok(m);
  const mapped = Object.keys(m.cols).map((i) => m.cols[i]);
  assert.deepEqual(mapped.slice(1).join(','), 'aliquots,aliquotVol,aliquotUnit');
});

check('nothing else in the inventory was disturbed', () => {
  Object.keys(INV_CONFIG).forEach((cat) => {
    assert.equal(INV_CONFIG[cat].cols.length, INV_CONFIG[cat].fields.length, cat + ' is misaligned');
  });
  // The aliquot fields belong to kits alone; the cells page has its own
  // "Cells / Vial" and must not grow a second amount column.
  Object.keys(INV_CONFIG).filter((c) => c !== 'kits').forEach((cat) => {
    assert.equal(INV_CONFIG[cat].fields.indexOf('aliquots'), -1, cat + ' grew an aliquot column');
  });
});

console.log('\nWhere else the count shows up');

check('the row marks the count and offers the button', () => {
  assert.match(src, /f === 'aliquots' && currentInvTab === 'kits'/);
  assert.match(src, /currentInvTab === 'kits' && aliquotCount\(item\) \?[\s\S]{0,200}?takeAliquot/);
});

check('the page says at the top what has run out', () => {
  const banner = src.slice(src.indexOf("if (currentInvTab === 'kits')"));
  assert.match(banner.slice(0, 1800), /out of aliquots/);
  assert.match(banner.slice(0, 1800), /down to the last one/);
  assert.match(banner.slice(0, 1800), /all\.forEach/, 'counted across the category, not the filtered view');
});

check('an @-mention of a reagent says what is left', () => {
  assert.match(mentions, /aliquotCount/);
  assert.match(mentions, /left/);
  // notebook.js defines these, and mentions.js loads first.
  assert.match(mentions, /typeof aliquotCount === 'function'/, 'it must not throw before notebook.js has loaded');
  assert.ok(html.indexOf('js/mentions.js') < html.indexOf('js/notebook.js'),
    'the load order this guard exists for has changed');
});

check('the cache-busting versions were bumped with the code', () => {
  assert.match(html, /js\/notebook\.js\?v=(4[3-9]|[5-9]\d)/, 'notebook.js ?v= is stale');
  assert.match(html, /js\/mentions\.js\?v=([4-9]|\d\d)/, 'mentions.js ?v= is stale');
});

console.log(`\n${pass} checks passed`);
