/* The inventory bulk upload: what a sheet does to what is already there.
 *
 *     node scripts/check-bulk-upload.mjs
 *
 * The case this exists for: the lab's way of correcting the inventory is to
 * download the template, change three cells and upload it again. That used
 * to be refused — a glycerol stock row was "a serial that is already taken"
 * and a plasmid row was added a second time — so the rules for matching a
 * row to a record it is meant to edit are worth holding still.
 *
 * notebook.js is the browser's file, so the functions under test are pulled
 * out of the source and run on their own, against a stub inventory.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(root, 'js', 'notebook.js'), 'utf8');
const XLSX = (await import(path.join(root, 'vendor', 'xlsx.full.min.js'))).default;

function extract(name, kind) {
  const start = src.indexOf(kind + ' ' + name + '(');
  assert.ok(start >= 0, 'could not find ' + name + ' in js/notebook.js');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  assert.ok(end > 0, 'unbalanced braces reading ' + name);
  return src.slice(start, end);
}
function statement(startsWith, endsWith = '};') {
  const at = src.indexOf(startsWith);
  assert.ok(at >= 0, 'could not find ' + startsWith);
  return src.slice(at, src.indexOf(endsWith, at) + endsWith.length);
}

// The inventory these uploads land on.
let inventory = {};
const ctx = {
  console,
  currentUser: () => ({ name: 'Amer' }),
  getInventory: () => inventory,
  INV_LABELS: {}
};
vm.createContext(ctx);
[
  statement('var INV_CONFIG ='),
  statement('var BULK_SHEETS ='),
  statement('var BULK_DATE_FIELDS =', ';'),
  statement('var BULK_EXTRA ='),
  statement('var BULK_IDENTITY =', ';'),
  statement('var BULK_UNIQUE =', ';'),
  statement('var BULK_ALIASES ='),
  statement('var BULK_CATS =', ';')
].forEach((code) => vm.runInContext(code, ctx));
['bulkKey', 'bulkPad', 'bulkColumns', 'bulkSeq', 'sameSequence', 'bulkMapHeader', 'bulkPickCategory',
  'bulkCell', 'bulkSignature', 'buildBulkPlan', 'bulkChanges'].forEach((fn) => vm.runInContext(extract(fn, 'function'), ctx));

// A workbook made the way a filled-in template arrives.
function book(sheets) {
  const wb = XLSX.utils.book_new();
  Object.keys(sheets).forEach((name) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets[name]), name);
  });
  return wb;
}
const plan = (sheets, update) => ctx.buildBulkPlan(XLSX, book(sheets), update);

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

const PLASMID_HEAD = ['Name', 'Backbone', 'Insert', 'Resistance', 'Conc.', 'Owner', 'Freezer', 'Box', 'Position', 'Location', 'Source glycerol stock', 'Sequence'];
const STOCK_HEAD = ['Serial #', 'Description', 'Resistance', 'Sequenced (QC)', 'Strain', 'Freezer (-80°C)', 'Rack_Shelf', 'Position on Drawer', 'Box', 'Position', 'Owner', 'Map', 'Notes', 'Sequence'];
const plasmidRow = (over = {}) => PLASMID_HEAD.map((h) => over[h] || '');
const stockRow = (over = {}) => STOCK_HEAD.map((h) => over[h] || '');

check('the template carries a sequence column on both sheets', () => {
  const cols = (cat) => ctx.bulkColumns(cat).map((c) => c.label);
  assert.ok(cols('plasmids').includes('Sequence'), 'plasmids');
  assert.ok(cols('plasmids').includes('Source glycerol stock'), 'the link to the stock');
  assert.ok(cols('stocks').includes('Sequence'), 'glycerol stocks');
});

check('a new row is added as it always was', () => {
  inventory = { plasmids: [], stocks: [] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pUC19-HK022', 'Conc.': '285 ng/µL' })] }, true);
  assert.equal(p.total, 1);
  assert.equal(p.updates, 0);
  assert.equal(p.cats.plasmids.items[0].name, 'pUC19-HK022');
  assert.equal(p.cats.plasmids.items[0].addedBy, 'Amer');
});

check('a row for an item already there updates it, and only the cells filled in', () => {
  inventory = { plasmids: [{ id: 'p1', name: 'pLenti-GFP', conc: '350 ng/µL', backbone: 'pLenti', box: 'Plasmid Box 1' }], stocks: [] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pLenti-GFP', 'Conc.': '420 ng/µL' })] }, true);
  assert.equal(p.updates, 1);
  assert.equal(p.cats.plasmids.items.length, 0);
  const u = p.cats.plasmids.updates[0];
  assert.equal(u.id, 'p1');
  assert.equal(u.item.conc, '420 ng/µL');
  assert.equal(u.item.backbone, 'pLenti');          // untouched column kept
  assert.equal(u.item.box, 'Plasmid Box 1');        // empty cell is not a clearance
  assert.equal(u.changes.map((c) => c.field).join(','), 'conc');
});

check('a glycerol stock is matched by its serial, which used to be refused', () => {
  inventory = { plasmids: [], stocks: [{ id: 's1', serial: 'GS-0001', description: 'clone 3', box: 'Box G1' }] };
  const off = plan({ 'Glycerol Stocks': [STOCK_HEAD, stockRow({ 'Serial #': 'GS-0001', Description: 'clone 3, resequenced' })] }, false);
  assert.equal(off.total, 0);
  assert.equal(off.cats.stocks.taken.length, 1);    // the old behaviour, still there with updating off
  const on = plan({ 'Glycerol Stocks': [STOCK_HEAD, stockRow({ 'Serial #': 'GS-0001', Description: 'clone 3, resequenced' })] }, true);
  assert.equal(on.updates, 1);
  assert.equal(on.cats.stocks.updates[0].item.description, 'clone 3, resequenced');
  assert.equal(on.cats.stocks.updates[0].item.box, 'Box G1');
});

check('a row that changes nothing is not an update', () => {
  inventory = { plasmids: [{ id: 'p1', name: 'pLenti-GFP', conc: '350 ng/µL' }], stocks: [] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pLenti-GFP', 'Conc.': '350 ng/µL' })] }, true);
  assert.equal(p.total, 0);
  assert.equal(p.cats.plasmids.dupes, 1);
});

check('two items of one name are left alone rather than guessed between', () => {
  inventory = { plasmids: [{ id: 'a', name: 'pGFP' }, { id: 'b', name: 'pGFP' }], stocks: [] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pGFP', 'Conc.': '100 ng/µL' })] }, true);
  assert.equal(p.total, 0);
  assert.equal(p.cats.plasmids.ambiguous.length, 1);
});

check('a sequence comes in cleaned, and sets the length', () => {
  inventory = { plasmids: [], stocks: [] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pSeq', Sequence: '>pSeq construct\nacgt acgt\n  1 GGCC' })] }, true);
  const it = p.cats.plasmids.items[0];
  assert.equal(it.seq, 'ACGTACGTGGCC');
  assert.equal(it.len, 12);
});

check('a sequence cell holding prose is reported, not stored as its letters', () => {
  inventory = { plasmids: [], stocks: [] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pOops', Sequence: 'see the Benchling map' })] }, true);
  assert.equal(p.cats.plasmids.badSeq.length, 1);
  assert.equal(p.cats.plasmids.items[0].seq, undefined);
});

check('a plasmid and its glycerol stock are checked against each other', () => {
  inventory = { plasmids: [], stocks: [] };
  const same = plan({
    Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pX', 'Source glycerol stock': 'GS-0007', Sequence: 'ACGTACGTTT' })],
    'Glycerol Stocks': [STOCK_HEAD, stockRow({ 'Serial #': 'GS-0007', Sequence: 'ACGTACGTTT' })]
  }, true);
  assert.equal(same.seqClashes.length, 0);
  // The same circle starting at another base is the same plasmid.
  const rotated = plan({
    Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pX', 'Source glycerol stock': 'GS-0007', Sequence: 'GTACGTTTAC' })],
    'Glycerol Stocks': [STOCK_HEAD, stockRow({ 'Serial #': 'GS-0007', Sequence: 'ACGTACGTTT' })]
  }, true);
  assert.equal(rotated.seqClashes.length, 0);
  const clash = plan({
    Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pX', 'Source glycerol stock': 'GS-0007', Sequence: 'ACGTACGTTT' })],
    'Glycerol Stocks': [STOCK_HEAD, stockRow({ 'Serial #': 'GS-0007', Sequence: 'ACGTACGTTA' })]
  }, true);
  assert.equal(clash.seqClashes.length, 1);
  assert.match(clash.seqClashes[0], /GS-0007/);
});

check('a stock already in the inventory is checked against an uploaded plasmid', () => {
  inventory = { plasmids: [], stocks: [{ id: 's1', serial: 'GS-0009', seq: 'AAAACCCCGG' }] };
  const p = plan({ Plasmids: [PLASMID_HEAD, plasmidRow({ Name: 'pY', 'Source glycerol stock': 'GS-0009', Sequence: 'AAAACCCCGT' })] }, true);
  assert.equal(p.seqClashes.length, 1);
});

console.log('\n' + passed + ' checks passed');
