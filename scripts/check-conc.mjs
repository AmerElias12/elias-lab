/* Concentrations: a number, a unit, and what a transfection plan does with
 * them.
 *
 *     node scripts/check-conc.mjs
 *
 * This exists because the two mistakes it guards against both end as a
 * volume somebody pipettes: reading 1.3 µg/µL as 1.3 ng/µL is a thousandfold
 * error, and reading a plasmid's concentration off a field name no record
 * has (`concentration`, where every record says `conc`) leaves the planner
 * with nothing at all.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(root, 'js', 'data.js'), 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'could not find ' + name + ' in js/data.js');
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
function statement(startsWith, endsWith = '};') {
  const at = src.indexOf(startsWith);
  assert.ok(at >= 0, 'could not find ' + startsWith);
  return src.slice(at, src.indexOf(endsWith, at) + endsWith.length);
}
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(statement('var CONC_UNITS =', '];'), ctx);
vm.runInContext(statement('var CONC_FACTOR ='), ctx);
['concUnitKey', 'parseConc', 'formatConc'].forEach((fn) => vm.runInContext(extract(fn), ctx));
const { parseConc, formatConc, CONC_UNITS } = ctx;

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

check('a number with its unit reads back as both', () => {
  const c = parseConc('285 ng/µL');
  assert.equal(c.n, 285);
  assert.equal(c.unit, 'ng/µL');
  assert.equal(c.ngul, 285);
  assert.equal(c.assumed, false);
});

check('every unit the form offers converts to ng/µL', () => {
  const ngul = (s) => parseConc(s).ngul;
  assert.equal(ngul('1 ng/µL'), 1);
  assert.equal(ngul('1 µg/µL'), 1000);
  assert.equal(ngul('1 mg/mL'), 1000);
  assert.equal(ngul('1 g/L'), 1000);
  assert.equal(ngul('1 µg/mL'), 1);        // the same number as ng/µL
  assert.equal(ngul('1000 ng/mL'), 1);
  CONC_UNITS.forEach((u) => assert.ok(parseConc('2 ' + u).unit === u, u + ' did not survive'));
});

check('the ways people actually write a unit are the same unit', () => {
  ['1.3 ug/ul', '1.3 µg/µL', '1.3 μg/μL', '1.3ug/uL', '1.3 UG/UL'].forEach((s) => {
    assert.equal(parseConc(s).ngul, 1300, s);
  });
});

check('a bare number is ng/µL, and says that it was assumed', () => {
  const c = parseConc('350');
  assert.equal(c.ngul, 350);
  assert.equal(c.unit, '');
  assert.equal(c.assumed, true);
});

check('a unit nobody can calculate with is not silently taken as ng/µL', () => {
  const c = parseConc('20000 U/mL');
  assert.equal(c.n, 20000);
  assert.equal(c.unit, '');
  assert.equal(c.assumed, true);   // the form shows this, rather than converting it
});

check('something with no number in it is nothing', () => {
  assert.equal(parseConc(''), null);
  assert.equal(parseConc('see the notes'), null);
  assert.equal(parseConc(null), null);
});

check('a decimal comma is a decimal point', () => {
  assert.equal(parseConc('1,5 µg/µL').ngul, 1500);
});

check('the form writes back what the parser can read', () => {
  assert.equal(formatConc('350', 'ng/µL'), '350 ng/µL');
  assert.equal(formatConc(1.3, 'µg/µL'), '1.3 µg/µL');
  assert.equal(formatConc('', 'ng/µL'), '');
  assert.equal(parseConc(formatConc('1.3', 'ug/ul')).ngul, 1300);
});

check('the transfection planner reads the field a plasmid record actually has', () => {
  const tfx = fs.readFileSync(path.join(root, 'js', 'transfect.js'), 'utf8');
  const fn = tfx.slice(tfx.indexOf('function labPlasmids'), tfx.indexOf('function handle'));
  assert.ok(/p\.conc\b/.test(fn), 'labPlasmids no longer reads conc');
  assert.ok(/parseConc/.test(fn), 'labPlasmids no longer converts the unit');
});

console.log('\n' + passed + ' checks passed');
