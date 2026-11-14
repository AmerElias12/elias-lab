/* Checks how the notebook hands over a file.
 *
 *     node scripts/check-save-file.mjs
 *
 * The lab site is shown inside Wix, in a frame sandboxed without
 * allow-downloads, and a notebook tab opened from there inherits it. Every
 * download is dropped there in silence, which is how "Export does nothing"
 * and "Download template does nothing" came about. js/save-file.js picks
 * another way round in that window; this asserts the choice, and that
 * nothing in the notebook goes back to clicking a link on its own.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const save = createRequire(import.meta.url)(path.join(root, 'js', 'save-file.js'));

let pass = 0;
const check = (what, fn) => {
  try { fn(); } catch (err) { console.log(`  FAIL  ${what}\n          ${err.message}`); process.exitCode = 1; return; }
  pass++; console.log(`  ok    ${what}`);
};

console.log('Which way a file goes');

check('a window of its own downloads, as it always did', () => {
  assert.equal(save.route({ sandboxed: false, picker: true }), 'link');
  assert.equal(save.route({ sandboxed: false, picker: false }), 'link');
});
check('a sandboxed window asks for a Save dialog', () => {
  assert.equal(save.route({ sandboxed: true, picker: true }), 'picker');
});
check('a sandboxed window with no Save dialog still shows the file', () => {
  assert.equal(save.route({ sandboxed: true, picker: false }), 'show');
});
check('the extension is read off the name', () => {
  assert.equal(save.extOf('pTEST-demo.gb'), '.gb');
  assert.equal(save.extOf('pTEST-demo-features.CSV'), '.csv');
  assert.equal(save.extOf('no extension'), '');
});

console.log('\nNothing goes round it');

const src = read('js', 'save-file.js');
check('a dialog that vanished at once is not taken for a save', () => {
  assert.match(src, /e\.name === 'AbortError' && Date\.now\(\) - asked > 200/);
});
check('plain download links are caught in a sandboxed window', () => {
  assert.match(src, /closest\('a\[download\]'\)/);
});
for (const f of [['js', 'notebook.js'], ['js', 'plasmid-ui.js'], ['tools', 'grna-primer-generator.html']]) {
  check(`${f.join('/')} makes no download link of its own`, () => {
    const text = read(...f);
    assert.doesNotMatch(text, /createObjectURL|data:text\/csv/);
    assert.match(text, /LabSave\.save\(/);
  });
}
check('the helper is loaded before the code that calls it', () => {
  const nb = read('notebook.html'), gen = read('tools', 'grna-primer-generator.html');
  assert.ok(nb.indexOf('js/save-file.js') > 0 && nb.indexOf('js/save-file.js') < nb.indexOf('js/plasmid-ui.js'));
  assert.ok(gen.indexOf('js/save-file.js') > 0 && gen.indexOf('js/save-file.js') < gen.indexOf('text/babel'));
});

console.log(`\n${pass} checks passed`);
