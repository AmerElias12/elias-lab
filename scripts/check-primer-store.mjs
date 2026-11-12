/* Checks that a primer the generator makes is actually stored.
 *
 *     node scripts/check-primer-store.mjs
 *
 * Four primers were generated, the page showed them, and a refresh showed
 * none. They had never been written. inventory_items.id is a uuid column;
 * the generator stamped each record with Date.now() and the store passed
 * that straight through as the row's primary key, so Postgres rejected every
 * write. The save runs from a React effect with no await and no catch, so
 * the rejection went nowhere: the primer sat on screen looking saved.
 *
 * It survived because local mode stores an id as a key in an array, where
 * any value works. The generator was therefore perfect on a developer's
 * machine and broken for the whole lab, and there was no suite here at all.
 *
 * So the host stubbed below REFUSES an id that is not a uuid, exactly as the
 * database does. Every check that writes goes through it.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let store, calls;

/** A notebook to save into, as strict about ids as the database is. */
function host({ rows = [], failWith = null } = {}) {
  calls = { upsert: 0, many: 0, remove: 0 };
  const inventory = { primers: rows.slice() };
  globalThis.window = {
    getInventory: () => inventory,
    currentUser: () => ({ name: 'A Scientist' }),
    DB: {
      async upsertInventory(cat, item) {
        calls.upsert++;
        if (failWith) throw new Error(failWith);
        if (!ANY_UUID.test(String(item.id))) {
          throw new Error(`invalid input syntax for type uuid: "${item.id}"`);
        }
        const i = inventory[cat].findIndex((x) => String(x.id) === String(item.id));
        if (i >= 0) inventory[cat][i] = item; else inventory[cat].push(item);
        return item;
      },
      async addInventoryMany(cat, items) {
        calls.many++;
        for (const it of items) await this.upsertInventory(cat, it);
      },
      async removeInventory(cat, id) {
        calls.remove++;
        inventory[cat] = inventory[cat].filter((x) => String(x.id) !== String(id));
      }
    }
  };
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  return inventory;
}

const require = createRequire(import.meta.url);
store = require(path.join(root, 'js', 'primer-store.js'));

const src = read('js', 'primer-store.js');
const gen = read('tools', 'grna-primer-generator.html');
const schema = read('supabase', 'schema.sql');

/** A record shaped as the generator makes one. */
const regular = (over = {}) => Object.assign({
  id: store.newId(), number: 1, name: 'PR1', sequence: 'ATGCATGCATGCATGCATGC',
  tm: '55.2', description: 'screen', freezer: '-20 A', shelf: '2', box: 'Primers Box 1'
}, over);
const grnaPair = (over = {}) => Object.assign({
  id: store.newId(), forwardNumber: 1, reverseNumber: 2,
  forwardName: 'PRg1_Frw', reverseName: 'PRg2_Rev', spacerSeq: 'GGGGTTTTCCCCAAAAGGGG',
  forwardPrimer: 'CACCGGGGGTTTTCCCCAAAAGGGG', reversePrimer: 'AAACCCCCTTTTGGGGAAAAC'
}, over);

let pass = 0;
const check = (what, fn) => {
  const done = (err) => {
    if (err) {
      console.log(`  FAIL  ${what}\n          ${err.message}`);
      process.exitCode = 1;
    } else {
      pass++;
      console.log(`  ok    ${what}`);
    }
  };
  return Promise.resolve().then(fn).then(() => done(), done);
};

console.log('The id a row is stored under');

await check('the database really does want a uuid, which is why this suite is strict', () => {
  const table = schema.slice(schema.indexOf('create table if not exists public.inventory_items'));
  assert.match(table.slice(0, 200), /id uuid primary key/,
    'if the column stopped being a uuid, this whole suite is testing the wrong thing');
});

await check('a new record gets a uuid', () => {
  assert.match(store.newId(), UUID);
  assert.notEqual(store.newId(), store.newId(), 'two records must not share an id');
});

await check('an old Date.now() id is folded into a uuid', () => {
  const id = store.rowId(1762939743210);
  assert.match(id, ANY_UUID, `got ${id}`);
});

await check('the same old id always folds to the same uuid', () => {
  assert.equal(store.rowId(1762939743210), store.rowId(1762939743210));
  assert.equal(store.rowId('1762939743210'), store.rowId(1762939743210),
    'the number and its string are the same record');
});

await check('different old ids fold to different uuids', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(store.rowId(1762939743210 + i));
  assert.equal(seen.size, 500, 'two primers collided onto one row');
});

await check('a uuid is left exactly as it is', () => {
  const id = store.newId();
  assert.equal(store.rowId(id), id);
});

await check('toRow always produces a uuid, whatever the record carried', () => {
  for (const rec of [regular(), regular({ id: Date.now() }), regular({ id: 1 }),
                     regular({ id: 'PR-7' })]) {
    assert.match(String(store.toRow('regular', rec).id), ANY_UUID,
      `record id ${rec.id} produced a row the database would refuse`);
  }
});

console.log('\nSaving, against a host as strict as the database');

await check('a primer the generator just made is written', async () => {
  const inv = host();
  await store.save('regular', [regular()]);
  assert.equal(inv.primers.length, 1);
  assert.match(String(inv.primers[0].id), ANY_UUID);
});

await check('a primer carried over from this browser is written too', async () => {
  // This is the exact record that used to be refused.
  const inv = host();
  await store.save('regular', [regular({ id: 1762939743210 })]);
  assert.equal(inv.primers.length, 1, 'an old numeric id was refused again');
});

await check('saving the same list twice does not make a second copy', async () => {
  const inv = host();
  const rec = regular({ id: 1762939743210 });
  await store.save('regular', [rec]);
  await store.save('regular', [rec]);
  assert.equal(inv.primers.length, 1);
});

await check('four primers all arrive', async () => {
  const inv = host();
  const list = [1, 2, 3, 4].map((n) => regular({ number: n, name: 'PR' + n }));
  await store.save('regular', list);
  assert.equal(inv.primers.length, 4);
});

await check('a gRNA pair is written', async () => {
  const inv = host();
  await store.save('grna', [grnaPair()]);
  assert.equal(inv.primers.length, 1);
  assert.equal(inv.primers[0].kind, 'grna');
});

await check('saving one kind leaves the other alone', async () => {
  const inv = host();
  await store.save('grna', [grnaPair()]);
  await store.save('regular', [regular()]);
  assert.equal(inv.primers.length, 2, 'the second save deleted the first kind');
});

await check('what goes in comes back out', async () => {
  host();
  const rec = regular({ description: 'BRCA1 exon 11' });
  await store.save('regular', [rec]);
  const state = await store.load();
  assert.equal(state.regular.length, 1);
  assert.equal(state.regular[0].sequence, rec.sequence);
  assert.equal(state.regular[0].description, 'BRCA1 exon 11');
  assert.equal(state.shared, true);
});

await check('an id that came back from the store stays put on the next save', async () => {
  const inv = host();
  await store.save('regular', [regular({ id: 1762939743210 })]);
  const first = String(inv.primers[0].id);
  const state = await store.load();
  await store.save('regular', state.regular);
  assert.equal(inv.primers.length, 1, 'the reloaded record was stored a second time');
  assert.equal(String(inv.primers[0].id), first);
});

console.log('\nRemoving, which is the same code path');

await check('a primer dropped from the list is removed', async () => {
  const inv = host();
  const a = regular({ number: 1 }), b = regular({ number: 2 });
  await store.save('regular', [a, b]);
  await store.save('regular', [a]);
  assert.equal(inv.primers.length, 1);
  assert.equal(inv.primers[0].number, 1);
});

await check('clearing the list clears that kind and only that kind', async () => {
  const inv = host();
  await store.save('grna', [grnaPair()]);
  await store.save('regular', [regular()]);
  await store.save('regular', []);
  assert.equal(inv.primers.length, 1);
  assert.equal(inv.primers[0].kind, 'grna');
});

console.log('\nA failed save is reported, not swallowed');

await check('save rejects when the host refuses', async () => {
  host({ failWith: 'new row violates row-level security policy' });
  await assert.rejects(() => store.save('regular', [regular()]), /row-level security/);
});

await check('the generator catches that rejection and shows it', () => {
  const effects = gen.slice(gen.indexOf('const keep ='), gen.indexOf('// Tm calculation'));
  assert.match(effects, /PrimerStore\.save\([^)]*\)\.then\(/,
    'the save effects must handle the promise');
  assert.match(effects, /setSaveError/, 'a failure has to reach the UI');
  assert.doesNotMatch(effects, /^\s*React\.useEffect\(\(\) => \{ if \(loaded\) PrimerStore\.save/m,
    'the fire-and-forget form is back');
});

await check('the failure is shown to the person, not only to the console', () => {
  assert.match(gen, /saveError\s*\?\s*'✗ Not saved/, 'the note has to render');
  assert.match(gen, /bg-red-100/, 'and read as a failure, not as the usual note');
  assert.match(gen, /Export to CSV/, 'tell them how not to lose the work');
});

await check('the generator no longer invents its own ids', () => {
  assert.doesNotMatch(gen, /id: Date\.now\(\)/,
    'Date.now() as an id is what the database refused');
  assert.equal((gen.match(/id: PrimerStore\.newId\(\)/g) || []).length, 4,
    'every record the generator makes should get its id from one place');
});

console.log('\nCarrying over what a browser already had');

await check('old local records are moved up once', async () => {
  const inv = host();
  globalThis.localStorage.setItem('regPrimers', JSON.stringify([
    regular({ id: 1762939743210, number: 1 }), regular({ id: 1762939743211, number: 2 })
  ]));
  const state = await store.load();
  assert.equal(state.moved, 2, `moved ${state.moved}`);
  assert.equal(inv.primers.length, 2);
});

await check('a second load does not move them again', async () => {
  const inv = host();
  globalThis.localStorage.setItem('regPrimers', JSON.stringify([regular({ id: 1762939743210 })]));
  await store.load();
  const again = await store.load();
  assert.equal(again.moved, 0);
  assert.equal(inv.primers.length, 1);
});

console.log('\nThe rest of the notebook can still read them');

await check('flat() lists what you would order', async () => {
  host();
  await store.save('regular', [regular({ name: 'PR1' })]);
  await store.save('grna', [grnaPair()]);
  const flat = store.flat();
  assert.equal(flat.length, 3, 'a pair is two primers, plus the regular one');
  assert.ok(flat.every((x) => x.seq && x.seq === x.seq.toUpperCase()));
});

await check('the next primer number carries on from the list', () => {
  const c = store.counters([grnaPair({ forwardNumber: 7, reverseNumber: 8 })],
                           [regular({ number: 4 })]);
  assert.equal(c.grnaCounter, 9);
  assert.equal(c.regCounter, 5);
});

await check('the cache-busting versions were bumped with the code', () => {
  const nb = read('notebook.html');
  assert.match(nb, /js\/primer-store\.js\?v=([2-9]|\d\d)/, 'primer-store.js ?v= is stale in notebook.html');
  assert.match(gen, /primer-store\.js\?v=([2-9]|\d\d)/, 'primer-store.js ?v= is stale in the generator');
});

console.log(`\n${pass} checks passed`);
