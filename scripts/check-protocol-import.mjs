/* Checks the Protocols page's "Import from file".
 *
 *     node scripts/check-protocol-import.mjs
 *
 * The bundle it reads is a file off disk, written by a script run on another
 * machine, so the page treats it as something to check rather than something
 * to trust. Three things matter and are asserted here:
 *
 *   * nothing already in the notebook is overwritten or duplicated, so the
 *     same bundle can be imported twice and a bundle can be regenerated
 *     after a few more PDFs are dropped in the folder;
 *   * a record only contributes the fields a protocol has, with a category
 *     the form actually offers, so a bundle cannot smuggle a column in;
 *   * a link is http(s) or nothing, because the protocol cards put it
 *     straight into an href where a javascript: URL would run.
 *
 * The functions are run out of the shipped js/notebook.js, in a sandbox with
 * just enough of a browser around it to let the file define itself.
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
sandbox.esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js', 'notebook.js'), sandbox, { filename: 'notebook.js' });

const src = read('js', 'notebook.js');
const html = read('notebook.html');
const py = read('scripts', 'import_protocols.py');
const { cleanProtoRecord, cleanProtoLink, buildProtoImportPlan, protoCategories,
  PROTO_IMPORT_KIND, PROTO_FIELDS } = sandbox;

function here_already(titles) {
  sandbox.getProtocols = () => titles.map((t, i) => ({ id: String(i), title: t }));
}
const bundle = (...protocols) => ({ kind: PROTO_IMPORT_KIND, version: 1, protocols });
here_already([]);

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

console.log('What counts as a bundle');

check('a file that is not one is refused by name, not by stack trace', () => {
  for (const bad of [null, {}, { protocols: [] }, { kind: 'something-else', protocols: [] },
                     { kind: PROTO_IMPORT_KIND }, { kind: PROTO_IMPORT_KIND, protocols: 'lots' }]) {
    assert.throws(() => buildProtoImportPlan(bad), /not a protocol bundle/);
  }
});

check('the error says where a bundle comes from', () => {
  assert.throws(() => buildProtoImportPlan({}), /import_protocols\.py/);
});

check('an empty bundle is read, and offers nothing to add', () => {
  const plan = buildProtoImportPlan(bundle());
  assert.equal(plan.new.length, 0);
  assert.equal(plan.here.length, 0);
});

console.log('\nNothing already here is touched');

check('a title already in the notebook is left alone and counted', () => {
  here_already(['Western Blot']);
  const plan = buildProtoImportPlan(bundle(
    { title: 'Western Blot', steps: 'a different version of it' },
    { title: 'IVT of sgRNA', steps: '1. order oligos' }));
  // Compared element by element: the plan is built in the sandbox's realm, so
  // its arrays have a different Array prototype and deepEqual refuses them.
  assert.equal(plan.here.length, 1);
  assert.equal(plan.here[0], 'Western Blot');
  assert.equal(plan.new.length, 1);
  assert.equal(plan.new[0].title, 'IVT of sgRNA');
});

check('a title that matches apart from case and punctuation is the same protocol', () => {
  here_already(['Western Blot']);
  const plan = buildProtoImportPlan(bundle({ title: ' western-blot ' }));
  assert.equal(plan.new.length, 0, 'it should have been recognised as already here');
  assert.equal(plan.here.length, 1);
});

check('importing the same bundle twice adds nothing the second time', () => {
  here_already([]);
  const b = bundle({ title: 'Cell Lysis with QuickExtract' }, { title: 'Western Blot' });
  const first = buildProtoImportPlan(b);
  assert.equal(first.new.length, 2);
  here_already(first.new.map((p) => p.title));
  const second = buildProtoImportPlan(b);
  assert.equal(second.new.length, 0);
  assert.equal(second.here.length, 2);
});

check('one bundle naming the same protocol twice adds it once', () => {
  here_already([]);
  const plan = buildProtoImportPlan(bundle(
    { title: 'RNP Electroporation', steps: 'first' },
    { title: 'RNP electroporation', steps: 'second' }));
  assert.equal(plan.new.length, 1);
  assert.equal(plan.new[0].steps, 'first', 'the first one wins; the second is a duplicate');
});

check('a record with no title is counted rather than saved as a blank', () => {
  here_already([]);
  const plan = buildProtoImportPlan(bundle(
    { steps: 'no title' }, { title: '   ' }, null, 'nonsense', { title: 'Western Blot' }));
  assert.equal(plan.skipped, 4);
  assert.equal(plan.new.length, 1);
});

console.log('\nOnly the fields a protocol has');

check('an unknown field in the bundle does not reach the record', () => {
  const rec = cleanProtoRecord({ title: 'X', archived: true, created_by: 'someone-else',
                                 id: 'fixed-id', password: 'hunter2' });
  for (const k of Object.keys(rec)) {
    assert.ok(PROTO_FIELDS.includes(k) || k === 'files', `${k} should not be in a record`);
  }
  assert.equal(rec.id, undefined, 'an id from the file would overwrite an existing protocol');
});

check('every field a protocol has is carried', () => {
  const full = {};
  PROTO_FIELDS.forEach((f) => { full[f] = 'value of ' + f; });
  full.date = '2021-11-05';
  full.link = 'https://example.org/p';
  full.category = 'NGS';
  const rec = cleanProtoRecord(full);
  PROTO_FIELDS.forEach((f) => assert.equal(rec[f], full[f], f + ' was dropped'));
});

check('the fields the form writes are the fields the import writes', () => {
  // saveProtocol() is the hand-typed path; the two must not drift apart.
  const save = src.slice(src.indexOf('async function saveProtocol'),
                         src.indexOf('async function savePresentation'));
  for (const f of PROTO_FIELDS) {
    assert.match(save, new RegExp(`\\b${f}:`), `saveProtocol has no ${f}`);
  }
});

check('a category the form does not offer becomes Other', () => {
  assert.equal(cleanProtoRecord({ title: 'X', category: 'Astrology' }).category, 'Other');
  assert.equal(cleanProtoRecord({ title: 'X' }).category, 'Other');
  assert.equal(cleanProtoRecord({ title: 'X', category: 'NGS' }).category, 'NGS');
});

check('the categories offered are the ones the protocol form lists', () => {
  const modal = src.slice(src.indexOf("if (type === 'protocol')"), src.indexOf("m-author-sel"));
  for (const cat of protoCategories()) {
    assert.ok(modal.includes("'" + cat + "'"), cat + ' is not in the form');
  }
});

check('a date that is not YYYY-MM-DD is dropped rather than shown as rubbish', () => {
  assert.equal(cleanProtoRecord({ title: 'X', date: '05Nov2021' }).date, '');
  assert.equal(cleanProtoRecord({ title: 'X', date: 'tomorrow' }).date, '');
  assert.equal(cleanProtoRecord({ title: 'X', date: '2021-11-05' }).date, '2021-11-05');
});

check('files start empty — a bundle cannot attach anything', () => {
  const rec = cleanProtoRecord({ title: 'X', files: [{ name: 'x', data: 'data:text/html,<img>' }] });
  assert.deepEqual(rec.files.length, 0);
});

console.log('\nLinks');

check('only http(s) survives — the cards put a link straight into an href', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>',
                     'file:///etc/passwd', 'vbscript:x', ' javascript:alert(1)']) {
    assert.equal(cleanProtoLink(bad), '', bad + ' should not have survived');
  }
  assert.equal(cleanProtoLink('https://www.promega.com/x'), 'https://www.promega.com/x');
  assert.equal(cleanProtoLink('http://example.org'), 'http://example.org');
  assert.equal(cleanProtoLink(undefined), '');
});

check('a protocol card still escapes what it shows', () => {
  const render = src.slice(src.indexOf('function renderProtocols'),
                           src.indexOf('async function deleteProtocol'));
  assert.match(render, /esc\(p\.link\)/, 'the link is put in an href and must be escaped');
  assert.match(render, /esc\(p\.title\)/);
});

console.log('\nThe page offers it, and says what it does');

check('the Protocols page has the button', () => {
  assert.match(html, /onclick="openProtocolImportModal\(\)"/);
  const header = html.slice(html.indexOf('<h2>Protocols</h2>'));
  assert.ok(header.indexOf('openProtocolImportModal') < header.indexOf('</div></div>') + 400,
    'the button belongs in the Protocols header');
});

check('the dialog names the script that makes a bundle', () => {
  const modal = src.slice(src.indexOf('function openProtocolImportModal'),
                          src.indexOf('async function previewProtocolImport'));
  assert.match(modal, /import_protocols\.py/);
  assert.match(modal, /--src/, 'it has to show how to run it');
  assert.match(modal, /left as it is|left alone/, 'it has to say duplicates are not overwritten');
});

check('an oversized file is refused before it is parsed', () => {
  const preview = src.slice(src.indexOf('async function previewProtocolImport'),
                            src.indexOf('async function saveProtocolImport'));
  assert.match(preview, /PROTO_IMPORT_MAX/);
  assert.ok(preview.indexOf('PROTO_IMPORT_MAX') < preview.indexOf('JSON.parse'),
    'the size check has to come first');
});

check('a run that stops half way says how far it got', () => {
  const save = src.slice(src.indexOf('async function saveProtocolImport'),
                         src.indexOf('// ── EXPERIMENT NOTEBOOKS'));
  assert.match(save, /Added ' \+ done/, 'it has to report what was saved, not just the error');
  assert.match(save, /renderProtocols\(\)/, 'the page has to show what arrived');
});

console.log('\nThe bundle the script writes is the bundle the page reads');

check('the script writes the kind the page insists on', () => {
  assert.match(py, new RegExp(`"kind": "${PROTO_IMPORT_KIND}"`));
});

check('the script writes every field the page reads, and no others', () => {
  const builder = py.slice(py.indexOf('def build_sop'), py.indexOf('def build_appendix'));
  for (const f of PROTO_FIELDS) {
    assert.match(builder, new RegExp(`"${f}":`), `the script does not write ${f}`);
  }
  // "kind" is the one extra, and is only read for the preview's wording.
  const written = [...builder.matchAll(/^        "(\w+)":/gm)].map((m) => m[1]);
  for (const f of written) {
    assert.ok(PROTO_FIELDS.includes(f) || f === 'kind', `${f} is written but never read`);
  }
});

check('the categories the script assigns are categories the form offers', () => {
  const table = py.slice(py.indexOf('CATEGORIES = ['), py.indexOf(']', py.indexOf('CATEGORIES = [')));
  const used = [...table.matchAll(/\("([^"]+)",/g)].map((m) => m[1]);
  assert.ok(used.length >= 8, 'the category table went missing');
  for (const cat of used) {
    assert.ok(protoCategories().includes(cat), cat + ' is not a category the form offers');
  }
});

check('the cache-busting version was bumped with the code', () => {
  assert.match(html, /js\/notebook\.js\?v=(4[2-9]|[5-9]\d)/, 'notebook.js ?v= is stale');
});

console.log(`\n${pass} checks passed`);
