/* Checks the tab model in js/tabs.js.
 *
 *     node scripts/check-tabs.mjs
 *
 * No browser. js/tabs.js draws into one element and otherwise only keeps a
 * list, so the list is what is checked here: which tabs exist, which is
 * current, where a new one lands, what is held while a tab is off screen, and
 * what closing one does. The drawing is checked by looking at it.
 *
 * The stubs below are deliberately thin — enough DOM for the module to run,
 * and no more. Anything richer would start testing the stubs.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'js', 'tabs.js'), 'utf8');

const keys = (w) => w.LabTabs.list().map((t) => t.key).join('|');

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

/* A notebook with four sections and nothing in it, enough for tabs.js to
   decide what is a place and to draw the strip into something. */
function makeWorld(opts = {}) {
  const strip = { innerHTML: '', hidden: false };
  const sections = new Set(['dashboard', 'protocols', 'plasmid', 'entry', 'inv-plasmids']);
  const store = new Map();
  const asked = [];

  const win = {
    confirm(msg) { asked.push(msg); return opts.confirm !== false; },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k)
    },
    location: { hash: '' },
    document: {
      getElementById: (id) => (id === 'ln-tabstrip' ? strip
        : sections.has(String(id).replace(/^ln-/, '')) ? { id } : null),
      querySelector: () => null
    },
    // What tabs.js calls to navigate. Recorded instead of done.
    shown: [],
    lnShow(section) { win.shown.push(section); },
    routePlasmid() { win.shown.push('route:' + win.location.hash); },
    routeHash() { win.shown.push('route:' + win.location.hash); },
    getInventory: () => ({ plasmids: (opts.plasmids || []).map((id) => ({ id })) }),
    getNotebooks: () => (opts.entries || []).map((id) => ({ id }))
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(source, win);
  return { win, strip, asked, store };
}

console.log('Tab model');

check('a section becomes a tab, and showing it again does not add a second', () => {
  const { win } = makeWorld();
  win.LabTabs.noteShow('dashboard');
  win.LabTabs.noteShow('protocols');
  win.LabTabs.noteShow('dashboard');
  assert.equal(keys(win), 'dashboard|protocols');
  assert.equal(win.LabTabs.current(), 'dashboard');
});

check('an item page is keyed by its id, so two plasmids are two tabs', () => {
  const { win } = makeWorld({ plasmids: ['a', 'b'] });
  win.LabTabs.noteShow('plasmid', 'a');
  win.LabTabs.noteShow('plasmid', 'b');
  assert.equal(keys(win), 'plasmid/a|plasmid/b');
  assert.equal(win.LabTabs.current(), 'plasmid/b');
});

check('something that is not a section never becomes a tab', () => {
  const { win } = makeWorld();
  win.LabTabs.noteShow('login');
  win.LabTabs.noteShow('');
  assert.equal(win.LabTabs.list().length, 0);
});

check('a new tab lands next to the one it was opened from, not at the end', () => {
  const { win } = makeWorld({ plasmids: ['a', 'b'] });
  win.LabTabs.noteShow('dashboard');
  win.LabTabs.noteShow('protocols');
  win.LabTabs.noteShow('dashboard');          // back to the first
  win.LabTabs.noteShow('plasmid', 'a');       // opened from dashboard
  assert.equal(keys(win), 'dashboard|plasmid/a|protocols');
});

check('what a tab was holding is given back once, and only once', () => {
  const { win } = makeWorld({ plasmids: ['a', 'b'] });
  let live = { seq: 'ATGC' };
  win.LabTabs.register('plasmid', {
    title: (id) => 'plasmid ' + id,
    capture: () => ({ seq: live.seq }),
    restore: () => {},
    dirty: () => false
  });
  win.LabTabs.noteShow('plasmid', 'a');
  live.seq = 'ATGCAAAA';                      // an unsaved edit
  win.LabTabs.noteShow('plasmid', 'b');       // leaving a captures it
  const held = win.LabTabs.takeState('plasmid/a');
  assert.equal(held.seq, 'ATGCAAAA');
  assert.equal(win.LabTabs.takeState('plasmid/a'), null, 'handed over, not copied');
});

check('an unsaved tab is marked, on screen and off', () => {
  const { win } = makeWorld({ plasmids: ['a', 'b'] });
  let dirty = false;
  win.LabTabs.register('plasmid', {
    title: (id) => 'plasmid ' + id,
    capture: () => ({ any: 1 }),
    restore: () => {},
    dirty: () => dirty
  });
  win.LabTabs.noteShow('plasmid', 'a');
  dirty = true;
  win.LabTabs.refresh();
  assert.match(win.document.getElementById('ln-tabstrip').innerHTML, /ln-tab on dirty/);
  win.LabTabs.noteShow('plasmid', 'b');       // a is now off screen
  dirty = false;                              // b is clean
  win.LabTabs.refresh();
  const html = win.document.getElementById('ln-tabstrip').innerHTML;
  assert.equal((html.match(/dirty/g) || []).length, 1, 'only the one with unsaved work');
});

check('closing a tab with unsaved work asks first, and no means no', () => {
  const { win, asked } = makeWorld({ plasmids: ['a'], confirm: false });
  win.LabTabs.register('plasmid', {
    title: () => 'pA', capture: () => ({}), restore: () => {}, dirty: () => true
  });
  win.LabTabs.noteShow('plasmid', 'a');
  win.LabTabs.close('plasmid/a');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /unsaved changes/);
  assert.equal(win.LabTabs.list().length, 1, 'it is still open');
});

check('closing a clean tab asks nothing and moves to its neighbour', () => {
  const { win, asked } = makeWorld({ plasmids: ['a', 'b'] });
  win.LabTabs.noteShow('dashboard');
  win.LabTabs.noteShow('plasmid', 'a');
  win.LabTabs.noteShow('plasmid', 'b');
  win.LabTabs.close('plasmid/b');
  assert.equal(asked.length, 0);
  assert.equal(keys(win), 'dashboard|plasmid/a');
  assert.equal(win.LabTabs.current(), 'plasmid/a', 'focus went to the neighbour');
});

check('closing the last tab falls back to the dashboard rather than nothing', () => {
  const { win } = makeWorld();
  win.LabTabs.noteShow('protocols');
  win.LabTabs.close('protocols');
  assert.equal(win.LabTabs.list().length, 0);
  assert.ok(win.shown.includes('dashboard'), 'it showed the dashboard');
});

check('close others keeps the one you are on', () => {
  const { win } = makeWorld({ plasmids: ['a', 'b'] });
  win.LabTabs.noteShow('dashboard');
  win.LabTabs.noteShow('plasmid', 'a');
  win.LabTabs.noteShow('plasmid', 'b');
  win.LabTabs.closeOthers();
  assert.equal(keys(win), 'plasmid/b');
});

check('clicking a tab navigates; noting one never does', () => {
  const { win } = makeWorld({ plasmids: ['a'] });
  win.LabTabs.noteShow('dashboard');
  win.LabTabs.noteShow('plasmid', 'a');
  assert.equal(win.shown.join('|'), '', 'noting is bookkeeping only');
  win.LabTabs.focus('dashboard');
  assert.equal(win.shown.join('|'), 'dashboard');
  win.LabTabs.focus('plasmid/a');
  assert.equal(win.location.hash, '#plasmid/a', 'an item page goes through the address');
});

console.log('Remembering what was open');

check('which places were open is saved, and what was typed in them is not', () => {
  const { win, store } = makeWorld({ plasmids: ['a'] });
  win.LabTabs.register('plasmid', {
    title: () => 'pA',
    capture: () => ({ secretDraft: 'ATGCATGC' }),
    restore: () => {},
    dirty: () => true
  });
  win.LabTabs.noteShow('plasmid', 'a');
  win.LabTabs.noteShow('dashboard');          // captures a's draft into memory
  const saved = store.get('elias_ln_tabs');
  assert.match(saved, /plasmid/, 'the place is remembered');
  assert.doesNotMatch(saved, /ATGCATGC/,
    'the draft is not: surviving a reload is a promise this cannot keep');
});

check('reopening skips an item that has since been deleted', () => {
  const first = makeWorld({ plasmids: ['a', 'b'] });
  first.win.LabTabs.noteShow('plasmid', 'a');
  first.win.LabTabs.noteShow('plasmid', 'b');
  const saved = first.store.get('elias_ln_tabs');

  // Same saved tabs, but plasmid b is gone from the inventory now.
  const second = makeWorld({ plasmids: ['a'] });
  second.store.set('elias_ln_tabs', saved);
  second.win.LabTabs.boot();
  assert.equal(keys(second.win), 'plasmid/a');
});

check('boot runs once, so a second call cannot duplicate the tabs', () => {
  const first = makeWorld({ plasmids: ['a'] });
  first.win.LabTabs.noteShow('plasmid', 'a');
  const saved = first.store.get('elias_ln_tabs');
  const second = makeWorld({ plasmids: ['a'] });
  second.store.set('elias_ln_tabs', saved);
  second.win.LabTabs.boot();
  second.win.LabTabs.boot();
  assert.equal(keys(second.win), 'plasmid/a');
});

check('a title is asked for fresh, so a rename shows without reopening', () => {
  const { win } = makeWorld({ plasmids: ['a'] });
  let name = 'pUC19';
  win.LabTabs.register('plasmid', {
    title: () => name, capture: () => ({}), restore: () => {}, dirty: () => false
  });
  win.LabTabs.noteShow('plasmid', 'a');
  assert.match(win.document.getElementById('ln-tabstrip').innerHTML, /pUC19/);
  name = 'pUC19-GFP';
  win.LabTabs.refresh();
  assert.match(win.document.getElementById('ln-tabstrip').innerHTML, /pUC19-GFP/);
});

check('a name with markup in it cannot inject anything into the strip', () => {
  const { win } = makeWorld({ plasmids: ['a'] });
  win.LabTabs.register('plasmid', {
    title: () => '<img src=x onerror=alert(1)>', capture: () => ({}), restore: () => {}, dirty: () => false
  });
  win.LabTabs.noteShow('plasmid', 'a');
  const html = win.document.getElementById('ln-tabstrip').innerHTML;
  assert.doesNotMatch(html, /<img/, 'the name is escaped');
  assert.match(html, /&lt;img/);
});

console.log(`\n${pass} checks passed`);
