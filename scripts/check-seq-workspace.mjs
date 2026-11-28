/* The sequence workspace: how much room the bases get, and which primers on
 * them could actually be pipetted today.
 *
 *     node scripts/check-seq-workspace.mjs
 *
 * Two complaints from the bench, and both are about what the screen says
 * rather than about arithmetic:
 *
 *   - the sequence was a narrow column with a half-empty panel beside it;
 *   - a primer still being designed, or ordered and not yet delivered, was
 *     drawn on the map exactly like one in the freezer, so a cloning plan
 *     could be laid around a primer nobody could pipette the next morning.
 *
 * There is no browser here, so the geometry is checked as source and the
 * decision about a primer — the part that would quietly go wrong — is run.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const ui = read('js', 'plasmid-ui.js');
const css = read('css', 'plasmid.css');
const store = read('js', 'primer-store.js');

let passed = 0;
const check = (what, fn) => {
  try { fn(); } catch (err) {
    console.log(`  FAIL  ${what}\n          ${err.message}`);
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log(`  ok    ${what}`);
};

console.log('Room for the sequence');

check('the panel beside the bases takes less than a third of the width', () => {
  const widths = [...css.matchAll(/\.pl-ws-sidepane[^{]*\{[^}]*width:min\((\d+)px,(\d+)%\)/g)];
  assert.ok(widths.length >= 2, 'the side pane should still state a width');
  for (const [, px, pct] of widths) {
    assert.ok(+pct <= 30, `the pane was ${pct}% of the window — the sequence needs the rest`);
    assert.ok(+px <= 400, `the pane was ${px}px wide`);
  }
});

check('the border between them can be dragged, and reached from the keyboard', () => {
  assert.match(ui, /class="pl-ws-grip" role="separator"/, 'the grip is a separator, not a decoration');
  assert.match(ui, /tabindex="0"/);
  assert.match(ui, /onpointerdown="plGripDown\(event\)"/);
  assert.match(ui, /onkeydown="plGripKey\(event\)"/);
  assert.match(ui, /window\.plGripDown = plGripDown;/);
  assert.match(ui, /window\.plGripKey = plGripKey;/);
  // The grip sits between the sequence and the panel, not after the rail.
  assert.ok(ui.indexOf('pl-ws-grip') < ui.indexOf("'<div class=\"pl-ws-sidepane\">'"));
  assert.match(css, /\.pl-ws-grip\{[^}]*cursor:col-resize/);
  assert.match(css, /\.pl-ws:not\(\[data-side\]\) \.pl-ws-grip\{display:none;\}/,
    'with no panel open there is no border to drag');
});

check('a dragged width cannot squeeze the sequence out, and is remembered', () => {
  const fn = ui.slice(ui.indexOf('var PL_SIDE_MIN'), ui.indexOf('function fitWs'));
  assert.match(fn, /PL_SEQ_MIN = 420/, 'the bases keep a floor of their own');
  assert.match(fn, /Math\.min\(plSideRoom\(\), Math\.max\(PL_SIDE_MIN, plSideW\)\)/,
    'the stored width is clamped on the way out, not on the way in');
  assert.match(fn, /localStorage\.setItem\('elias_pl_sidew'/);
  assert.match(fn, /matchMedia\('\(max-width: 900px\)'\)/, 'stacked under the sequence, the number means nothing');
  assert.match(fn, /window\.dispatchEvent\(new Event\('resize'\)\)/, 'SeqViz re-wraps on resize');
  assert.match(fn, /schedulePrimerPaint\(\)/, 'and the primers painted over it must follow');
});

check('nothing blank is left under the sequence', () => {
  const nb = read('js', 'notebook.js');
  // The menu down the side is taller than the window, and the shell is a row,
  // so the row used to run past the bottom of the workspace: a few hundred
  // pixels of nothing, and a page that scrolled for no reason.
  assert.match(nb, /classList\.toggle\('ln-full', section === 'plasmid'\)/,
    'the page being shown has to say so, or the shell cannot be sized');
  assert.match(nb, /window\.plFitShell\(\)/, 'and the sizing has to run on the way in and out');
  const fn = ui.slice(ui.indexOf('function fitShell'), ui.indexOf('var PL_SEQ_MIN_H'));
  assert.match(fn, /classList\.contains\('ln-full'\)/);
  assert.match(fn, /shell\.style\.height = ''/, 'and be undone for every other page');
  assert.match(css, /body\.ln-full \.ln-sidebar\{overflow:auto;\}/, 'the menu scrolls inside itself instead');
});

check('the bases can be dragged taller than the window', () => {
  assert.match(ui, /class="pl-ws-vgrip" role="separator" aria-orientation="horizontal"/);
  assert.match(ui, /onpointerdown="plVGripDown\(event\)"/);
  assert.match(ui, /onkeydown="plVGripKey\(event\)"/);
  assert.match(ui, /ondblclick="plSeqFit\(\)"/, 'and put back to the window with a double-click');
  for (const name of ['plVGripDown', 'plVGripKey', 'plSeqFit', 'plFitShell']) {
    assert.ok(ui.includes('window.' + name + ' = '), name + ' must be reachable from the markup');
  }
  const fit = ui.slice(ui.indexOf('function fitWs()'), ui.indexOf("window.addEventListener('resize', fitWs)"));
  assert.match(fit, /if \(plSeqH\) \{ ws\.style\.height = ''; return; \}/,
    'asked for a taller sequence, the workspace must stop pinning itself to the window');
  const set = ui.slice(ui.indexOf('var PL_SEQ_MIN_H'), ui.indexOf('function plVGripDown'));
  assert.match(set, /PL_SEQ_MIN_H = 260/);
  assert.match(set, /localStorage\.setItem\('elias_pl_seqh'/);
  assert.match(set, /localStorage\.removeItem\('elias_pl_seqh'/, 'fitting the window again forgets the number');
  assert.match(set, /plNarrow\(\)/, 'stacked on a phone, a dragged height means nothing');
  assert.match(css, /\.pl-ws-vgrip\{[^}]*cursor:row-resize/);
});

console.log('\nPrimers that are not in the freezer yet');

/* pendingWord, run as the page runs it. */
const ctx = { out: null };
vm.createContext(ctx);
vm.runInContext(
  ui.slice(ui.indexOf('var PL_PENDING'), ui.indexOf('function primerGlyphs')) + '\nout = pendingWord;',
  ctx);
const pendingWord = ctx.out;

check('a primer still being designed or ordered counts as not in hand', () => {
  assert.equal(pendingWord('Designed'), 'designed');
  assert.equal(pendingWord('Ordered'), 'ordered');
  assert.equal(pendingWord(' ordered '), 'ordered', 'a status typed with spaces is the same status');
  assert.equal(pendingWord('REQUESTED'), 'requested');
});

check('one in the freezer, or with nothing said about it, is drawn as usual', () => {
  assert.equal(pendingWord('Received'), '');
  assert.equal(pendingWord('Arrived'), '');
  // Unknown is not the same as unavailable: a primer the lab's list has
  // never heard of must not be shaded, or the shading means nothing.
  assert.equal(pendingWord(''), '');
  assert.equal(pendingWord(undefined), '');
  assert.equal(pendingWord('anything else'), '');
});

check('the status reaches the page at all', () => {
  assert.match(store, /kind: 'primer'[^}]*status: r\.status \|\| ''/,
    "flat() used to drop the status, which is why the map could not know");
  assert.match(store, /gRNA cloning'[^}]*status: r\.status \|\| ''/);
  const fn = ui.slice(ui.indexOf('function primerStock'), ui.indexOf('function primerGlyphs'));
  assert.match(fn, /window\.PrimerStore && window\.PrimerStore\.flat\(\)/);
  assert.match(fn, /catch \(e\)/, 'no primer list is not a reason to fail to draw the sequence');
});

check('the glyph is told, by the primer it is, not by the annotation', () => {
  const fn = ui.slice(ui.indexOf('function primerGlyphs'), ui.indexOf('function primerRowsFor'));
  assert.match(fn, /hitPr = b\.primer/, 'the attached primer is what carries a status');
  assert.match(fn, /waiting = hitPr \? pendingWord\(stock\[P\.clean\(hitPr\.seq\)\]\) : ''/);
});

check('and draws itself as a shadow, with the reason in words', () => {
  const fn = ui.slice(ui.indexOf('function primerGlyph(d, first'), ui.indexOf('function letters'));
  assert.match(fn, /\(d\.waiting \? ' waiting' : ''\)/, 'the class the stylesheet shades');
  assert.match(fn, /not in the freezer yet/, 'the tooltip says why it is pale');
  assert.match(fn, /label = d\.name \+ \(d\.waiting \? ' · ' \+ d\.waiting : ''\)/,
    'the name on the map says it too, since a tooltip has to be found first');
  assert.match(css, /\.pl-primer-glyph\.waiting \.pl-primer-body[^{]*\{[^}]*stroke-dasharray/,
    'pale and dashed, so it reads as unavailable and not as another colour of primer');
});

check('the primers panel says the same thing in the same words', () => {
  const fn = ui.slice(ui.indexOf('function primersHtml'), ui.indexOf('Several at once'));
  assert.match(fn, /stock = primerStock\(\)/);
  assert.match(fn, /class="pl-pr-waiting"/);
  assert.match(css, /\.pl-pr-waiting\{/);
});

console.log('\n' + passed + ' checks passed');
