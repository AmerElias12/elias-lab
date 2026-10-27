/* Checks the inventory sort in js/notebook.js.
 *
 *     node scripts/check-inventory-order.mjs
 *
 * notebook.js is the browser's own file and expects a document, so the two
 * functions under test are pulled out of the source and evaluated on their
 * own. That keeps the check honest — it runs the shipped text, not a copy —
 * without needing a DOM.
 *
 * The case this exists for: the serials in the lab's glycerol stocks are bare
 * numbers, so a plain string sort puts 100 before 22 before 5, which reads as
 * broken as the unsorted order it replaced.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'notebook.js'), 'utf8');

function extract(name, kind) {
  const start = src.indexOf(kind + ' ' + name);
  assert.ok(start >= 0, 'could not find ' + name + ' in js/notebook.js');
  // Walk braces from the first one after the declaration.
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  assert.ok(end > 0, 'unbalanced braces reading ' + name);
  return src.slice(start, end);
}

// currentInvTab is a module-level var in the app; sortInventory falls back to
// it when a caller does not name the category.
const ctx = { Intl, currentInvTab: 'stocks' };
vm.createContext(ctx);

function runStatement(startsWith) {
  const at = src.indexOf(startsWith);
  assert.ok(at >= 0, 'could not find ' + startsWith);
  vm.runInContext(src.slice(at, src.indexOf('};', at) + 2), ctx);
}
// invCollator is an IIFE assigned to a var; take the whole statement.
const collStart = src.indexOf('var invCollator =');
const collEnd = src.indexOf('})();', collStart) + 5;
assert.ok(collStart >= 0 && collEnd > collStart, 'could not find invCollator');
vm.runInContext(src.slice(collStart, collEnd), ctx);
vm.runInContext(extract('invCompare', 'function'), ctx);
runStatement('var INV_SORT =');
runStatement('var INV_SLOT =');
vm.runInContext(extract('invSortKeys', 'function'), ctx);
vm.runInContext(extract('slotKey', 'function'), ctx);
vm.runInContext(extract('bulkKey', 'function'), ctx);
vm.runInContext(extract('sortInventory', 'function'), ctx);

const stocksCfg = { fields: ['serial', 'description'] };
const namedCfg = { fields: ['name'] };
const order = (items, cfg) =>
  ctx.sortInventory(items, cfg).map((i) => i[cfg.fields[0]]).join(',');

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

console.log('Inventory order');

check('bare numeric serials sort as numbers, not as text', () => {
  // The trap: as strings this is 1, 100, 22, 5.
  const rows = [{ serial: '22' }, { serial: '5' }, { serial: '100' }, { serial: '1' }];
  assert.equal(order(rows, stocksCfg), '1,5,22,100');
});

check('the real order from the lab\'s stocks comes out ascending', () => {
  // Exactly the rows in the reported screenshots, in the order they appeared.
  const rows = ['71', '72', '22', '1', '2', '3', '4', '75', '76', '73', '74']
    .map((serial) => ({ serial: serial }));
  assert.equal(order(rows, stocksCfg), '1,2,3,4,22,71,72,73,74,75,76');
});

check('a padded scheme sorts correctly too', () => {
  const rows = [{ serial: 'GS-0010' }, { serial: 'GS-0002' }, { serial: 'GS-0001' }];
  assert.equal(order(rows, stocksCfg), 'GS-0001,GS-0002,GS-0010');
  // And mixed widths, which is what a scheme looks like mid-migration.
  const mixed = [{ serial: 'GS-10' }, { serial: 'GS-2' }, { serial: 'GS-100' }];
  assert.equal(order(mixed, stocksCfg), 'GS-2,GS-10,GS-100');
});

check('blank rows go last, not first', () => {
  // Three empty rows at the top would push every real stock off the screen.
  const rows = [{ serial: '' }, { serial: '7' }, { serial: null }, { serial: '3' }];
  const out = ctx.sortInventory(rows, stocksCfg).map((i) => i.serial || '·');
  assert.equal(out.join(','), '3,7,·,·');
});

check('whitespace does not decide the order', () => {
  const rows = [{ serial: ' 9' }, { serial: '8 ' }];
  assert.equal(order(rows, stocksCfg), '8 , 9');
});

check('other categories sort by name, case-insensitively', () => {
  const rows = [{ name: 'pUC19' }, { name: 'EcoRI' }, { name: 'ampR-plasmid' }];
  assert.equal(order(rows, namedCfg), 'ampR-plasmid,EcoRI,pUC19');
  // Names ending in a number are the same trap as serials.
  const numbered = [{ name: 'Clone 10' }, { name: 'Clone 2' }];
  assert.equal(order(numbered, namedCfg), 'Clone 2,Clone 10');
});

check('the caller\'s array is not reordered', () => {
  // renderInventory is handed the app's own state; sorting it in place would
  // silently reorder what the CSV export and the box maps read.
  const rows = [{ serial: '9' }, { serial: '1' }];
  const before = rows.map((r) => r.serial).join(',');
  ctx.sortInventory(rows, stocksCfg);
  assert.equal(rows.map((r) => r.serial).join(','), before, 'the input was mutated');
});

check('equal identifiers do not throw or drop rows', () => {
  const rows = [{ serial: '5', id: 'a' }, { serial: '5', id: 'b' }, { serial: '4', id: 'c' }];
  const out = ctx.sortInventory(rows, stocksCfg);
  assert.equal(out.length, 3);
  assert.equal(out[0].serial, '4');
});

/* ---- tissue culture: location order, and the occupied-slot guard ---- */

const cellsCfg = { fields: ['name', 'passage', 'amount', 'source', 'growthMedia', 'bankMedia', 'tank', 'rack', 'box', 'position', 'notes', 'addedBy'] };
const vial = (name, box, position, extra) =>
  Object.assign({ name: name, tank: 'Tank 206', rack: '3 (Grey)', box: box, position: position }, extra || {});

console.log('\nTissue culture');

check('vials are ordered by where they sit, not by cell line', () => {
  // The reported screenshot was grouped by name, so B1-B4 and C1-C2 came
  // before A1-A7. A freezer box is read in box order.
  const rows = [
    vial('HEK293', '1', 'B1'), vial('HEK293', '1', 'B2'), vial('HEK293', '1', 'C1'),
    vial('HEK293 FlpIn', '1', 'E1'),
    vial('HEK293 FT', '1', 'A1'), vial('HEK293 FT', '1', 'A2'), vial('HEK293 FT', '1', 'A10')
  ];
  const out = ctx.sortInventory(rows, cellsCfg, 'cells').map((v) => v.position).join(',');
  assert.equal(out, 'A1,A2,A10,B1,B2,C1,E1');
});

check('a box is kept whole, and A10 follows A2', () => {
  // Position alone would interleave boxes: every box in the lab has an A1.
  const rows = [vial('X', '2', 'A1'), vial('X', '1', 'A2'), vial('X', '1', 'A1'), vial('X', '2', 'A2')];
  const out = ctx.sortInventory(rows, cellsCfg, 'cells').map((v) => v.box + v.position).join(',');
  assert.equal(out, '1A1,1A2,2A1,2A2');
});

check('tanks and racks are kept whole above boxes', () => {
  const rows = [
    vial('X', '1', 'A1', { tank: 'Tank 9', rack: '1' }),
    vial('X', '1', 'A1', { tank: 'Tank 1', rack: '2' }),
    vial('X', '1', 'A1', { tank: 'Tank 1', rack: '1' })
  ];
  const out = ctx.sortInventory(rows, cellsCfg, 'cells').map((v) => v.tank + '/' + v.rack).join(',');
  assert.equal(out, 'Tank 1/1,Tank 1/2,Tank 9/1');
});

check('two vials in one position collide; different boxes do not', () => {
  const a = vial('HEK293', '1', 'A1'), b = vial('HEK293 FT', '1', 'A1');
  assert.equal(ctx.slotKey('cells', a), ctx.slotKey('cells', b), 'same box and position is one slot');
  assert.notEqual(ctx.slotKey('cells', a), ctx.slotKey('cells', vial('HEK293', '2', 'A1')),
    'box 1 and box 2 are different boxes');
  // This lab numbers its boxes inside each rack, so the rack has to count too.
  assert.notEqual(ctx.slotKey('cells', a), ctx.slotKey('cells', vial('HEK293', '1', 'A1', { rack: '4 (Blue)' })));
});

check('position is matched loosely enough to catch real duplicates', () => {
  assert.equal(ctx.slotKey('cells', vial('X', '1', 'a1')), ctx.slotKey('cells', vial('X', '1', 'A1')));
  assert.equal(ctx.slotKey('cells', vial('X', 'Box 1', 'A1')), ctx.slotKey('cells', vial('X', 'box-1', 'A1')));
});

check('a vial with no position yet clashes with nothing', () => {
  // Recording a vial before deciding where it goes has to stay possible.
  assert.equal(ctx.slotKey('cells', vial('X', '1', '')), null);
  assert.equal(ctx.slotKey('cells', vial('X', '1', undefined)), null);
});

console.log(`\n${pass} checks passed`);
