/* Checks js/plates.js and the searchable half of js/mentions.js.
 *
 *     node scripts/check-plates.mjs
 *
 * Both files are mostly DOM, but the parts that can be wrong without anyone
 * noticing are not: which wells a format has and what they are called, what
 * survives changing format, and which entity a half-typed @ should find.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, '..', 'js', f), 'utf8');

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

function sandbox(files, extra = {}) {
  const win = Object.assign({
    document: { querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, appendChild() {} }) },
    addEventListener() {}, setTimeout, alert() {}, confirm: () => true,
    DOMParser: class { parseFromString() { return { querySelector: () => null }; } }
  }, extra);
  win.window = win;
  vm.createContext(win);
  files.forEach((f) => vm.runInContext(read(f), win));
  return win;
}

console.log('Culture plates');
const P = sandbox(['plates.js']).LabPlates;

check('every format has the geometry the plate actually has', () => {
  // Not a tidy rectangle of the right size — the real ones, so the drawing
  // matches what is in your hand.
  assert.equal(P.grid(6).rows * P.grid(6).cols, 6);
  assert.deepEqual([P.grid(6).rows, P.grid(6).cols], [2, 3]);
  assert.deepEqual([P.grid(12).rows, P.grid(12).cols], [3, 4]);
  assert.deepEqual([P.grid(24).rows, P.grid(24).cols], [4, 6]);
  assert.deepEqual([P.grid(48).rows, P.grid(48).cols], [6, 8]);
  assert.deepEqual([P.grid(96).rows, P.grid(96).cols], [8, 12]);
  P.ORDER.forEach((f) => {
    const g = P.grid(f);
    assert.equal(g.wells.length, f, f + '-well has ' + f + ' wells');
    assert.equal(g.rows * g.cols, f);
  });
});

check('wells are named the way a plate reader exports them', () => {
  const g = P.grid(96);
  assert.equal(g.wells[0], 'A1');
  assert.equal(g.wells[11], 'A12', 'the first row runs to 12 before B starts');
  assert.equal(g.wells[12], 'B1');
  assert.equal(g.wells[95], 'H12');
  // Columns are 1-based: a well called A0 would line up with nothing.
  assert.ok(!g.wells.some((w) => /^[A-Z]0$/.test(w)), 'no column zero');
  assert.equal(g.wells.filter((w) => w.startsWith('A')).join(','),
    'A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,A12');
  assert.equal(P.grid(6).wells.join(','), 'A1,A2,A3,B1,B2,B3');
});

check('a single dish is a dish, not a one-well grid called A1', () => {
  const g = P.grid(1);
  assert.equal(g.wells.join(','), 'Dish');
  assert.equal(g.rows, 1);
  assert.equal(g.cols, 1);
});

check('an unknown format falls back rather than drawing nothing', () => {
  assert.equal(P.grid(7).wells.length, 96);
  assert.equal(P.grid(undefined).wells.length, 96);
});

check('a blank plate is empty, and filled wells are counted', () => {
  const st = P.blank(24);
  assert.equal(st.f, 24);
  assert.equal(P.used(st), 0);
  st.cells.A1 = 'HEK293T';
  st.cells.B3 = '  ';            // whitespace is not something written in
  assert.equal(P.used(st), 1);
  st.cells.C4 = 'siRNA';
  assert.equal(P.used(st), 2);
});

check('stored state is read back, and nonsense is refused', () => {
  const st = P.blank(12);
  st.title = 'Transfection';
  st.cells.A1 = 'mock';
  const back = P.load(JSON.stringify(st));
  assert.equal(back.title, 'Transfection');
  assert.equal(back.cells.A1, 'mock');
  assert.equal(P.load('not json'), null);
  assert.equal(P.load(JSON.stringify({ f: 7 })), null, 'a format that does not exist');
  assert.equal(P.load(null), null);
  // A plate whose cells arrived as something other than an object still opens.
  assert.equal(Object.keys(P.load(JSON.stringify({ f: 6, cells: 'oops' })).cells).length, 0);
});

check('shrinking a plate keeps the wells that still exist', () => {
  // Which wells survive 96 → 24 is the whole question: A1 does, H12 cannot.
  const names = {};
  P.grid(24).wells.forEach((w) => { names[w] = true; });
  assert.ok(names.A1);
  assert.ok(names.D6);
  assert.ok(!names.H12, 'a 24-well plate has no row H');
  assert.ok(!names.A12, 'nor a column 12');
});

console.log('\nMentions');
const inv = {
  plasmids: [{ id: 'p1', name: 'pUC19-GFP', backbone: 'pUC19', len: 3200 },
             { id: 'p2', name: 'pLenti-Cas9' }],
  primers: [{ id: 'o1', name: 'GFP-F', sequence: 'ATGGTGAGCAAGGGC' }],
  enzymes: [{ id: 'e1', name: 'EcoRI', cutsite: 'GAATTC' }],
  kits: [{ id: 'k1', name: 'QIAprep Spin Miniprep', supplier: 'Qiagen' }],
  stocks: [{ id: 's1', serial: 'GS-0007', description: 'pUC19 in DH5α' }],
  cells: [{ id: 'c1', name: 'HEK293T', passage: 12 }]
};
const users = [{ id: 'u1', name: 'Amer Elias', email: 'amer@example.org', status: 'approved' },
               { id: 'u2', name: 'Pending Person', email: 'p@example.org', status: 'pending' }];
const M = sandbox(['mentions.js'], {
  getInventory: () => inv, getUsers: () => users, getNotebooks: () => []
}).LabMentions;

check('everything the lab keeps can be mentioned, including people', () => {
  const kinds = {};
  M.entities().forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
  assert.deepEqual(Object.keys(kinds).sort().join(','), 'cell,enzyme,kit,plasmid,primer,stock,user');
  assert.equal(kinds.plasmid, 2);
  assert.equal(kinds.user, 1, 'only approved people');
});

check('a glycerol stock is found by its serial, which is the name it has', () => {
  // It has no `name` field at all, so reading one would make it unmentionable.
  const hit = M.search('GS-0007')[0];
  assert.equal(hit.kind, 'stock');
  assert.equal(hit.label, 'GS-0007');
});

check('what you are typing the start of comes first', () => {
  const hits = M.search('p');
  assert.ok(hits.length > 1);
  assert.ok(/^p/i.test(hits[0].label), 'a name starting with p beats one containing it: ' + hits[0].label);
  const puc = M.search('pUC');
  assert.equal(puc[0].label, 'pUC19-GFP');
});

check('a search matches what is written beside the name too', () => {
  // The stock's description, not its serial.
  const hit = M.search('DH5')[0];
  assert.equal(hit.id, 's1');
  // And the supplier of a kit.
  assert.equal(M.search('Qiagen')[0].id, 'k1');
});

check('an empty query offers something rather than nothing', () => {
  assert.ok(M.search('').length > 0, 'typing @ alone shows what there is');
  assert.ok(M.search('', 3).length <= 3);
});

check('a query that matches nothing matches nothing', () => {
  assert.deepEqual(M.search('zzzzz').length, 0);
});

check('a mention resolves to the live record, so renames follow', () => {
  assert.equal(M.lookup('plasmid', 'p1').name, 'pUC19-GFP');
  inv.plasmids[0].name = 'pUC19-mCherry';
  assert.equal(M.labelOf('plasmid', M.lookup('plasmid', 'p1')), 'pUC19-mCherry');
  inv.plasmids[0].name = 'pUC19-GFP';
  assert.equal(M.lookup('plasmid', 'nope'), null, 'something deleted resolves to nothing');
  assert.equal(M.lookup('user', 'u1').name, 'Amer Elias');
});

console.log(`\n${pass} checks passed`);
