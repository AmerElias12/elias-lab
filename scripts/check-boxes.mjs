/* Checks that the Storage Boxes page shows every box that is stored.
 *
 *     node scripts/check-boxes.mjs
 *
 * A box set up in the notebook is a row in the database. The page used to
 * build its list from a fixed three types, so a box saved with any other
 * type was read, indexed — and then rendered into no group at all: still in
 * the database, on no page, with nothing said about it. A box for
 * restriction enzymes vanished that way.
 *
 * Enzymes and reagents are box types themselves now, so the box that started
 * this is an ordinary box; the disappearing act is checked with a page that
 * is still not a box type, because the hole was never about enzymes.
 *
 * So the thing worth asserting is not how the groups look but that nothing
 * is lost between the stored rows and the cards: every box in the index gets
 * a card, and a row too broken to become a box is counted out loud.
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
// esc() lives in js/data.js, which the page loads first.
sandbox.esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js', 'notebook.js'), sandbox, { filename: 'notebook.js' });

const src = read('js', 'notebook.js');
const html = read('notebook.html');
const { boxIndex, boxListBody, boxCardHtml, boxDetailHtml, boxContentCols, boxCanHold,
  boxGroupName, boxGroupCats, boxLabel, boxCellPanel, boxContentRows,
  parsePosition, parsePositions, cellName, slotTakenBy,
  INV_CONFIG, INV_SLOT, BULK_EXAMPLES, bulkColumns, bulkMapHeader,
  BOX_CATS, BOX_TYPE_NAMES, BOX_WHERE } = sandbox;

// The page reads the inventory through getInventory(); give it one.
const EMPTY = { enzymes: [], primers: [], plasmids: [], stocks: [], cells: [], kits: [], boxes: [] };
function inventory(inv) { sandbox.getInventory = () => Object.assign({}, EMPTY, inv); }
const cards = (markup) => (String(markup).match(/class="ln-box-card"/g) || []).length;

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

console.log('A box typed to something that is not a box type');

check('it is still listed — this is how the enzyme box disappeared', () => {
  inventory({ boxes: [{ id: '1', name: 'Primer Box 1', cat: 'primers', layout: '9x9' }] });
  const all = boxIndex();
  assert.equal(all.length, 1, 'the box fell out of the index');
  assert.equal(cards(boxListBody(all, '')), 1, 'the box is in the index but on no page');
  assert.match(boxListBody(all, ''), /Primer Box 1/);
});

check('it says what it is instead of claiming to hold vials', () => {
  inventory({ boxes: [{ id: '1', name: 'Primer Box 1', cat: 'primers', layout: '9x9' }] });
  const markup = boxListBody(boxIndex(), '');
  assert.match(markup, /not a box type/, 'nothing tells you why the box is empty');
  assert.doesNotMatch(markup, /0 primers/, 'it must not read as a count that could ever grow');
});

check('its page opens and says what to do about it', () => {
  inventory({ boxes: [{ id: '1', name: 'Primer Box 1', cat: 'primers', layout: '9x9' }] });
  const page = boxDetailHtml(boxIndex()[0]);
  assert.match(page, /Primer Box 1/);
  assert.match(page, /Edit box/, 'the way out of the wrong type has to be on the page');
  assert.match(page, /not kept in boxes/i);
});

check('a type the app has never heard of does not throw', () => {
  // A type from a later version, or a hand-edited row.
  inventory({ boxes: [{ id: '1', name: 'Mystery', cat: 'widgets', layout: '9x9' }] });
  const all = boxIndex();
  assert.equal(cards(boxListBody(all, '')), 1);
  assert.doesNotThrow(() => boxCardHtml(all[0]));
  assert.doesNotThrow(() => boxDetailHtml(all[0]));
  // (Arrays made inside the sandbox are a different realm's Array, so this
  // compares the length rather than the object.)
  assert.equal(boxContentCols(all[0]).length, 0, 'there are no columns for a type with no table');
});

check('nothing can be filed into a box that cannot hold anything', () => {
  // "+ Restriction Enzyme" would open a form with nowhere to put the
  // position, and the vial would land nowhere.
  const panel = src.slice(src.indexOf('function boxCellPanel'), src.indexOf('function editVial'));
  assert.match(panel, /boxCanHold\(b\.cat\) \? \[b\.cat\] : \[\]/);
  assert.match(panel, /Nothing can be placed here/);
});

console.log('\nNothing is lost between the stored rows and the cards');

check('every box in the index gets a card', () => {
  inventory({
    boxes: [
      { id: '1', name: 'Enzymes Box 1', cat: 'enzymes', layout: '9x9' },
      { id: '2', name: 'Kit Box 3', cat: 'kits', layout: '10x10' },
      { id: '3', name: 'Mystery', cat: 'widgets' },
      { id: '4', name: 'Plasmid Box 1', cat: 'plasmids' },
      { id: '5', name: '', cat: 'primers', layout: '5x5' }
    ],
    stocks: [{ id: 's1', serial: 'GS-1', box: 'Box G1', position: 'A1' }]
  });
  const all = boxIndex();
  assert.equal(all.length, 6, 'a stored box, or the one the vial names, is missing from the index');
  assert.equal(cards(boxListBody(all, '')), all.length, 'the page shows fewer boxes than it indexed');
});

check('a set-up with no name is shown, because an invisible row cannot be deleted', () => {
  inventory({ boxes: [{ id: '1', name: '', cat: 'cells', layout: '5x5' }] });
  const all = boxIndex();
  assert.equal(all.length, 1);
  assert.equal(boxLabel(all[0]), 'Box with no name');
  assert.equal(cards(boxListBody(all, '')), 1);
});

check('a set-up with neither name nor type is counted, not dropped in silence', () => {
  inventory({ boxes: [{ id: '1', layout: '9x9' }] });
  const all = boxIndex();
  assert.equal(all.length, 0, 'there is nothing to draw it with');
  assert.match(boxListBody(all, ''), /cannot be shown/, 'the row exists and the page must say so');
});

check('the search still filters, and still says when it matches nothing', () => {
  inventory({ boxes: [{ id: '1', name: 'Enzymes Box 1', cat: 'enzymes' }, { id: '2', name: 'Box G1', cat: 'stocks' }] });
  const all = boxIndex();
  assert.equal(cards(boxListBody(all, 'enzymes')), 1);
  assert.match(boxListBody(all, 'nothing here'), /No box matches/);
});

console.log('\nThe ordinary boxes are untouched');

check('every box type keeps its heading, in order', () => {
  inventory({
    plasmids: [{ id: 'p1', name: 'pUC19', box: 'P1', position: 'A1' }],
    stocks: [{ id: 's1', serial: 'GS-1', box: 'G1', position: 'A1' }],
    cells: [{ id: 'c1', name: 'HEK293T', box: 'C1', position: 'A1' }],
    enzymes: [{ id: 'e1', name: 'EcoRI', box: 'E1', position: 'A1' }],
    kits: [{ id: 'k1', name: 'Miniprep kit', box: 'K1', position: 'A1' }]
  });
  const markup = boxListBody(boxIndex(), '');
  assert.equal(cards(markup), 5);
  const at = (s) => markup.indexOf(s);
  const headings = BOX_CATS.map((c) => at(BOX_TYPE_NAMES[c]));
  headings.forEach((i, n) => {
    assert.ok(i >= 0, BOX_TYPE_NAMES[BOX_CATS[n]] + ' has no heading');
    if (n) assert.ok(i > headings[n - 1], 'the type headings are out of order');
  });
  assert.equal(boxGroupCats(boxIndex()).join(','), BOX_CATS.concat([null]).join(','));
  BOX_CATS.forEach((c) => assert.ok(boxCanHold(c), c + ' should be a box type'));
});

check('a box the vials name but nobody set up still appears', () => {
  inventory({ stocks: [{ id: 's1', serial: 'GS-1', box: 'Box G1', position: 'A1' }] });
  const all = boxIndex();
  assert.equal(all.length, 1);
  assert.equal(all[0].cat, 'stocks');
  assert.equal(all[0].vials.length, 1);
  assert.equal(cards(boxListBody(all, '')), 1);
});

check('an older set-up with no type is still lent to the vials using its name', () => {
  inventory({
    boxes: [{ id: '1', name: 'Box G1', layout: '10x10' }],
    stocks: [{ id: 's1', serial: 'GS-1', box: 'Box G1', position: 'A1' }]
  });
  const all = boxIndex();
  assert.equal(all.length, 1, 'the untyped set-up should not become a second card');
  assert.equal(all[0].cat, 'stocks');
  assert.equal(all[0].dims.cols, 10, 'the layout it was given is not being used');
  assert.equal(boxGroupName(null), 'Type not set');
});

console.log('\nEnzymes and reagents in the grid');

check('both are box types, with a heading and a place to be', () => {
  ['enzymes', 'kits'].forEach((cat) => {
    assert.ok(boxCanHold(cat), cat + ' is not a box type');
    assert.ok(BOX_TYPE_NAMES[cat], cat + ' has no heading');
    ['box', 'position'].forEach((f) => {
      assert.ok(INV_CONFIG[cat].fields.indexOf(f) >= 0, cat + ' has no ' + f + ' column');
    });
    assert.equal(INV_CONFIG[cat].cols.length, INV_CONFIG[cat].fields.length, cat + ' is misaligned');
  });
});

check('a tube in a box is drawn in its square', () => {
  inventory({ enzymes: [{ id: 'e1', name: 'EcoRI', storage: '-20°C Freezer A', box: 'Enzymes Box 1', position: 'A3' }] });
  const b = boxIndex()[0];
  assert.equal(b.cat, 'enzymes');
  assert.equal(b.placed, 1, 'the enzyme is not placed in the map');
  assert.equal(b.unplaced.length, 0);
  assert.match(boxDetailHtml(b), /EcoRI/);
  // The shelf written on the vial is where the box is, so the card says so.
  assert.equal(b.where, '-20°C Freezer A');
  assert.equal(BOX_WHERE.enzymes, 'storage');
  assert.equal(BOX_WHERE.kits, 'storage');
});

check('a reagent with no position is listed as needing one, not dropped', () => {
  inventory({ kits: [{ id: 'k1', name: 'Miniprep kit', box: 'Reagents Box 1' }] });
  const b = boxIndex()[0];
  assert.equal(b.unplaced.length, 1);
  assert.match(boxDetailHtml(b), /without a usable position/);
});

check('the same square cannot be given to two tubes', () => {
  // INV_SLOT is what decides this; without an entry the save guard passes
  // everything and the map ends up with two names in one square.
  ['enzymes', 'kits'].forEach((cat) => {
    assert.ok(INV_SLOT[cat], cat + ' has no slot definition');
    assert.equal(INV_SLOT[cat][INV_SLOT[cat].length - 1], 'position');
    assert.ok(INV_SLOT[cat].indexOf('box') >= 0);
    assert.ok(INV_SLOT[cat].indexOf('storage') >= 0, 'two boxes sharing a name are told apart by the shelf');
  });
  inventory({ enzymes: [{ id: 'e1', name: 'EcoRI', box: 'Enzymes Box 1', position: 'A3' }] });
  const taken = slotTakenBy('enzymes', { id: 'e2', name: 'BamHI', box: 'Enzymes Box 1', position: 'A3' });
  assert.ok(taken && taken.name === 'EcoRI', 'a second tube in A3 is not noticed');
  assert.equal(slotTakenBy('enzymes', { id: 'e3', name: 'BamHI', box: 'Enzymes Box 1', position: 'A4' }), null);
  const save = src.slice(src.indexOf("if (tab === 'enzymes')"), src.indexOf("else if (tab === 'requests')"));
  assert.equal((save.match(/boxPositionOk\(tab, item\)/g) || []).length, 2, 'enzymes and kits must both be guarded');
});

check('the form asks for the box and the position', () => {
  const forms = src.slice(src.indexOf('var forms = {'), src.indexOf('if (!forms[currentInvTab])'));
  const enzymes = forms.slice(forms.indexOf('enzymes:'), forms.indexOf('primers:'));
  const kits = forms.slice(forms.indexOf('kits:'));
  [['enzymes', enzymes], ['kits', kits]].forEach(([cat, form]) => {
    assert.match(form, /id="m-box" list="ln-box-list"/, cat + ' has no box field');
    assert.match(form, /id="m-position"/, cat + ' has no position field');
    assert.match(form, /id="m-storage" list="ln-storage-list"/, cat + ' should offer the shelves in use');
  });
});

check('a box opened from the map fills in the shelf it is on', () => {
  const add = src.slice(src.indexOf('function addVialAt'), src.indexOf('function openBoxModal'));
  assert.match(add, /BOX_WHERE\[cat\]/, 'the freezer field is not the same one on every page');
});

check('an empty square in an enzyme box offers to fill it', () => {
  inventory({ enzymes: [{ id: 'e1', name: 'EcoRI', box: 'Enzymes Box 1', position: 'A3' }] });
  sandbox.boxSelected = '0,0';
  const panel = boxCellPanel(boxIndex()[0]);
  sandbox.boxSelected = null;
  assert.match(panel, /Add here/);
  assert.match(panel, /addVialAt\('enzymes'/);
});

check('both reach the CSV and the bulk template, and come back', () => {
  ['enzymes', 'kits'].forEach((cat) => {
    const fields = bulkColumns(cat).map((c) => c.field);
    ['box', 'position'].forEach((f) => {
      assert.ok(fields.indexOf(f) >= 0, f + ' is missing from the ' + cat + ' template');
      assert.ok(BULK_EXAMPLES[cat][f], f + ' has no example for ' + cat);
    });
    // An exported sheet is edited and uploaded back; the columns have to
    // land on the same fields they came from.
    const m = bulkMapHeader(cat, INV_CONFIG[cat].cols);
    assert.ok(m, cat + ' does not match its own exported header');
    const mapped = Object.keys(m.cols).map((i) => m.cols[i]);
    ['box', 'position'].forEach((f) => assert.ok(mapped.indexOf(f) >= 0, f + ' is lost on re-upload of ' + cat));
  });
});

check('a position is read the same way everywhere', () => {
  // "A3" and "3" are both written on real boxes; both have to land in the
  // same square as they do for a plasmid or a vial.
  const dims = { rows: 9, cols: 9 };
  assert.deepEqual(Object.assign({}, parsePosition('A3', dims)), { r: 0, c: 2 });
  assert.deepEqual(Object.assign({}, parsePosition('3', dims)), { r: 0, c: 2 });
  assert.equal(parsePosition('Z9', dims), null);
});

console.log('\nOne record, several squares');

const dims9 = { rows: 9, cols: 9 };
const squares = (s, dims = dims9) => parsePositions(s, dims).map(cellName).join(' ');

check('a run of aliquots is a run of squares', () => {
  // The case this exists for: a buffer aliquoted into two tubes, written
  // "A2-A3", was drawn nowhere and listed as not fitting the box.
  assert.equal(squares('A2-A3'), 'A2 A3');
  assert.equal(squares('A2 - A3'), 'A2 A3');
  assert.equal(squares('A2–A3'), 'A2 A3', 'an en dash is what a word processor leaves behind');
});

check('a lettered range is a block, a numbered one is a run', () => {
  // A1-C3 is read the way a range of wells on a plate is: a rectangle.
  assert.equal(squares('A1-C3'), 'A1 A2 A3 B1 B2 B3 C1 C2 C3');
  // Numbers already count row by row, so a range of them is twelve in a row.
  assert.equal(parsePositions('1-12', dims9).length, 12);
  assert.equal(squares('1-12').split(' ').slice(-2).join(' '), 'B2 B3');
});

check('a list of squares is a list of squares', () => {
  assert.equal(squares('A1, B4'), 'A1 B4');
  assert.equal(squares('A1; B4'), 'A1 B4');
  assert.equal(squares('A1, A1'), 'A1', 'the same square twice is one square');
  assert.equal(squares('A2-A3, C5'), 'A2 A3 C5');
});

check('what was already written still reads the same', () => {
  assert.equal(squares('A3'), 'A3');
  assert.equal(squares('3'), 'A3');
  assert.equal(squares('A03'), 'A3');
  assert.equal(squares('A-3'), 'A3', 'some people write the square with a dash');
  assert.equal(squares(''), '');
  assert.equal(squares('somewhere in the freezer'), '');
});

check('nothing is drawn outside the box', () => {
  assert.equal(squares('A2-A3', { rows: 2, cols: 2 }), '', 'A3 is not in a 2×2 box');
  assert.equal(squares('Z9'), '');
  assert.equal(squares('99'), '');
  assert.equal(parsePositions('1-12', { rows: 2, cols: 2 }).length, 0);
});

check('the map draws the record in every square it names', () => {
  inventory({ kits: [{ id: 'k1', name: 'jetOPTIMUS Buffer', box: 'Reagents Box 1', position: 'A2-A3' }] });
  const b = boxIndex()[0];
  assert.equal(b.unplaced.length, 0, 'this is the record that fell out of the map');
  assert.equal(b.placed, 2, 'two tubes, two squares');
  assert.ok(b.cells['0,1'] && b.cells['0,2'], 'A2 and A3 should both hold it');
  assert.equal(b.cells['0,1'][0].item.id, b.cells['0,2'][0].item.id, 'it is one record, not two');
  const page = boxDetailHtml(b);
  assert.equal((page.match(/jetOPTIMUS Buffer/g) || []).length >= 2, true, 'it should be labelled in both squares');
});

check('it is one row in the contents, saying how many squares', () => {
  inventory({ kits: [{ id: 'k1', name: 'jetOPTIMUS Buffer', box: 'Reagents Box 1', position: 'A2-A3' }] });
  const rows = boxContentRows(boxIndex()[0]);
  assert.equal(rows.length, 1, 'a record across squares is one thing in the box');
  assert.match(rows[0].pos, /A2-A3/);
  assert.match(rows[0].pos, /2 positions/);
});

check('a single square still reads as the square itself', () => {
  inventory({ kits: [{ id: 'k1', name: 'Miniprep kit', box: 'Reagents Box 1', position: '12' }] });
  assert.equal(boxContentRows(boxIndex()[0])[0].pos, 'B3', 'a number should print as the square it is');
});

check('two records still cannot overlap, even partly', () => {
  inventory({
    kits: [
      { id: 'k1', name: 'jetOPTIMUS Buffer', storage: '-20°C Freezer A', box: 'Reagents Box 1', position: 'A2-A3' },
      { id: 'k2', name: 'Q5 polymerase', storage: '-20°C Freezer A', box: 'Reagents Box 1', position: 'B1-B4' }
    ]
  });
  // Overlapping a run at one end is the same mistake as sitting on top of it.
  const onto = slotTakenBy('kits', { id: 'k3', name: 'New tube', box: 'Reagents Box 1', position: 'A3' });
  assert.ok(onto && onto.name === 'jetOPTIMUS Buffer', 'a tube into A3 should hit the buffer');
  const across = slotTakenBy('kits', { id: 'k3', name: 'New tube', box: 'Reagents Box 1', position: 'A3-B2' });
  assert.ok(across, 'a run that crosses two records should be refused');
  assert.equal(slotTakenBy('kits', { id: 'k3', name: 'New tube', box: 'Reagents Box 1', position: 'C1-C9' }), null,
    'an empty row is free');
  // The same square written two ways is still the same square.
  assert.ok(slotTakenBy('kits', { id: 'k3', name: 'New tube', box: 'Reagents Box 1', position: '3' }),
    '"3" is A3 in a 9×9 box, and A3 is taken');
  // A box of the same name on another shelf is a different box — but only
  // when both records say which shelf, since a blank is not a disagreement.
  assert.equal(slotTakenBy('kits', { id: 'k3', name: 'New tube', storage: 'Bench 2', box: 'Reagents Box 1', position: 'A3' }), null);
  assert.ok(slotTakenBy('kits', { id: 'k3', name: 'New tube', box: 'Reagents Box 1', position: 'A3' }),
    'a tube with no shelf recorded is not evidence of a different shelf');
});

check('the panel for one square says where the rest of it is', () => {
  inventory({ kits: [{ id: 'k1', name: 'jetOPTIMUS Buffer', box: 'Reagents Box 1', position: 'A2-A3' }] });
  sandbox.boxSelected = '0,1';
  const panel = boxCellPanel(boxIndex()[0]);
  sandbox.boxSelected = null;
  assert.match(panel, /All positions/);
  assert.match(panel, /A2-A3/);
});

check('shrinking a box warns about the squares a record would lose', () => {
  const save = src.slice(src.indexOf('async function saveBox'), src.indexOf('async function deleteBox'));
  assert.match(save, /parsePositions\(v\.item\.position, boxDims\(def\)\)\.length < parsePositions/);
  assert.match(save, /will lose them/);
});

check('the form says a run of positions is allowed', () => {
  assert.match(src, /var POSITION_HINT = /);
  const forms = src.slice(src.indexOf('var forms = {'), src.indexOf('if (!forms[currentInvTab])'));
  assert.equal((forms.match(/POSITION_HINT/g) || []).length, 2, 'enzymes and kits should both explain it');
  assert.match(src, /A2-A3/, 'the example people copy has to be in the app, not only here');
});

console.log('\nThe dialog that gets a box out of the wrong type');

check('the stored type stays in the list rather than being swapped on save', () => {
  const modal = src.slice(src.indexOf('function openBoxModal'), src.indexOf('async function saveBox'));
  assert.match(modal, /BOX_CATS\.indexOf\(cat\) >= 0 \? BOX_CATS : \[cat\]\.concat\(BOX_CATS\)/);
  assert.match(modal, /boxCanHold\(cat\) \? '' :/, 'the dialog has to say why the box holds nothing');
  assert.match(modal, /deleteBox\(\)/, 'a box that cannot be fixed has to be deletable');
});

check('the cache-busting versions were bumped with the code', () => {
  assert.match(html, /js\/notebook\.js\?v=(3[8-9]|[4-9]\d)/, 'notebook.js ?v= is stale');
  assert.match(html, /css\/notebook\.css\?v=(3[1-9]|[4-9]\d)/, 'notebook.css ?v= is stale');
});

console.log(`\n${pass} checks passed`);
