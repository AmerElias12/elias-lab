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

const ctx = { Intl };
vm.createContext(ctx);
// invCollator is an IIFE assigned to a var; take the whole statement.
const collStart = src.indexOf('var invCollator =');
const collEnd = src.indexOf('})();', collStart) + 5;
assert.ok(collStart >= 0 && collEnd > collStart, 'could not find invCollator');
vm.runInContext(src.slice(collStart, collEnd), ctx);
vm.runInContext(extract('invCompare', 'function'), ctx);
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

console.log(`\n${pass} checks passed`);
