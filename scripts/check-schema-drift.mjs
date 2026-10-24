/* Checks the missing-column message in js/data.js.
 *
 *     node scripts/check-schema-drift.mjs
 *
 * A postdoc lost a save to "Could not find the 'body' column of 'notebooks'
 * in the schema cache", which reads like a fault in the app. It is not — it
 * means the project's database predates a column in supabase/schema.sql. The
 * message is what stands between that person and assuming their work is gone,
 * so it is worth a check of its own.
 *
 * The function is pulled out of the shipped source and run on its own, so
 * this tests the text that actually ships.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(root, 'js', 'data.js'), 'utf8');

const start = src.indexOf('function schemaDriftMessage');
assert.ok(start >= 0, 'schemaDriftMessage is not in js/data.js');
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);
const msg = ctx.schemaDriftMessage;

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

console.log('Missing-column message');

// The exact string PostgREST returned to the lab.
const real = { code: 'PGRST204', message: "Could not find the 'body' column of 'notebooks' in the schema cache" };

check('the real error is recognised and names the column and table', () => {
  const out = msg(real);
  assert.ok(out, 'it was not recognised at all');
  assert.match(out, /body/);
  assert.match(out, /notebooks/);
});

check('it says the work is not lost, which is the thing to say first', () => {
  // Somebody reading this has just had a save fail with a page full of typing.
  assert.match(msg(real), /Nothing you typed is lost/i);
  assert.match(msg(real), /leave this page open/i);
});

check('it gives the fix, and says the fix is safe', () => {
  const out = msg(real);
  assert.match(out, /supabase\/schema\.sql/);
  assert.match(out, /SQL Editor/);
  assert.match(out, /safe to re-run/i);
});

check('it does not leak the driver wording it is replacing', () => {
  assert.doesNotMatch(msg(real), /schema cache/i, 'that phrase is what confused everybody');
  assert.doesNotMatch(msg(real), /PGRST/);
});

check('any missing column is covered, not just body', () => {
  const other = { message: "Could not find the 'nextsteps' column of 'notebooks' in the schema cache" };
  assert.match(msg(other), /nextsteps/);
  const inv = { message: "Could not find the 'added_by' column of 'inventory_items' in the schema cache" };
  assert.match(msg(inv), /added_by/);
  assert.match(msg(inv), /inventory_items/);
});

check('every other failure is left alone for the caller to report', () => {
  // Returning null is what makes the caller fall back to the real message;
  // swallowing an unrelated error would hide it behind advice about SQL.
  assert.equal(msg({ message: 'duplicate key value violates unique constraint' }), null);
  assert.equal(msg({ message: 'JWT expired' }), null);
  assert.equal(msg({ message: 'new row violates row-level security policy' }), null);
  assert.equal(msg(null), null);
  assert.equal(msg({}), null);
  assert.equal(msg({ message: '' }), null);
});

console.log('\nThe fix the message points at');

check('schema.sql really does add the column the lab was missing', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
  assert.match(sql, /alter table public\.notebooks add column if not exists body text/i,
    'the message tells people to run schema.sql, so schema.sql has to carry the fix');
});

check('schema.sql is safe to re-run, as the message promises', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
  // Every create guarded, and the only drops are of policies and triggers
  // that the file recreates — nothing that could take data with it.
  const creates = sql.match(/^\s*create table (?!if not exists)/gim) || [];
  assert.equal(creates.length, 0, 'an unguarded create table would fail on a re-run');
  const drops = (sql.match(/^\s*drop\s+(\w+)/gim) || []).map((d) => d.trim().split(/\s+/)[1].toLowerCase());
  const allowed = ['policy', 'trigger'];
  drops.forEach((kind) => {
    assert.ok(allowed.indexOf(kind) >= 0, 'schema.sql drops a ' + kind + ', which re-running would not be safe for');
  });
  assert.doesNotMatch(sql, /truncate|delete\s+from/i);
});

console.log(`\n${pass} checks passed`);
