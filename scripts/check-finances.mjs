/* Checks the lab finances: budget headings, and importing a file of
 * expenses.
 *
 *     node scripts/check-finances.mjs
 *
 * Money is the one part of the notebook where a wrong number is not a
 * nuisance but a report filed incorrectly, so the arithmetic is tested on
 * the shipped functions rather than read and hoped about: that "1,200"
 * counts as 1200, that an expense charged to no grant is in no grant's
 * total, and that shekels are never quietly added to dollars.
 *
 * The import is tested the same way, on the rows a spreadsheet actually
 * arrives as — Hebrew headings, dd/mm/yyyy dates, Excel date serials, a
 * grant named in words rather than by id.
 */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(root, 'js', 'notebook.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'notebook.html'), 'utf8');

/* Pull the shipped functions out and run them against a stand-in inventory,
   so what is tested is the code that ships, not a copy of it. */
const ctx = {};
vm.createContext(ctx);

function statement(prefix) {
  const i = src.indexOf(prefix);
  assert.ok(i >= 0, 'could not find ' + prefix);
  let j = i, depth = 0, started = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '[' || c === '{' || c === '(') { depth++; started = true; }
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && started && depth === 0) break;
  }
  return src.slice(i, j + 1);
}
function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'could not find function ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

let inventory = { grants: [], expenses: [] };
ctx.getInventory = () => inventory;
ctx.currentUser = () => ({ name: 'Dr. Amer Elias' });
ctx.uid = (() => { let n = 0; return () => 'id-' + (++n); })();

vm.runInContext(fn('bulkKey'), ctx);
vm.runInContext(fn('textKey'), ctx);
vm.runInContext(fn('money'), ctx);
vm.runInContext(fn('amount'), ctx);
vm.runInContext(statement('var EXPENSE_CATS ='), ctx);
vm.runInContext(statement('var EXPENSE_CAT_ALIASES ='), ctx);
vm.runInContext(fn('expenseCat'), ctx);
vm.runInContext(fn('grants'), ctx);
vm.runInContext(fn('expenses'), ctx);
vm.runInContext(fn('grantSummary'), ctx);
vm.runInContext(statement('var EXPENSE_IMPORT_COLS ='), ctx);
vm.runInContext(fn('expenseSignature'), ctx);
vm.runInContext(fn('bulkPad'), ctx);
vm.runInContext(fn('buildExpensePlan'), ctx);

let pass = 0;
const check = (what, f) => {
  try { f(); } catch (err) {
    console.log(`  FAIL  ${what}\n          ${err.message}`);
    process.exitCode = 1;
    return;
  }
  pass++;
  console.log(`  ok    ${what}`);
};

console.log('The budget headings');

const WANTED = ['מלגות', 'חומרים וציוד מתכלה', 'הוצאות אחרות', 'כח אדם (לא כולל סטודנט מתמחה)', 'אין הגבלה'];

check('the five the lab asked for, in that order and spelled that way', () => {
  // joined, not deepEqual: the array is built inside the vm and its
  // prototype is a different realm's, which deepEqual counts as unequal.
  assert.equal(ctx.EXPENSE_CATS.map((c) => c.he).join(' | '), WANTED.join(' | '));
});

check('a heading is stored as its Hebrew, not as a code', () => {
  // What goes in the record is what the finance office reads in the export
  // and what people will have typed in the file they import.
  ctx.EXPENSE_CATS.forEach((c) => {
    assert.equal(ctx.expenseCat(c.he), c, c.he + ' does not match itself');
    assert.ok(/[֐-׿]/.test(c.he), c.key + ' is not Hebrew');
  });
});

check('a heading is recognised however it is spaced or punctuated', () => {
  assert.equal(ctx.expenseCat(' מלגות '), ctx.EXPENSE_CATS[0]);
  assert.equal(ctx.expenseCat('כח אדם  (לא כולל סטודנט מתמחה)'), ctx.EXPENSE_CATS[3]);
});

check('the English a finance export might use is matched too', () => {
  assert.equal(ctx.expenseCat('Consumables'), ctx.EXPENSE_CATS[1]);
  assert.equal(ctx.expenseCat('stipend'), ctx.EXPENSE_CATS[0]);
  assert.equal(ctx.expenseCat('Salaries'), ctx.EXPENSE_CATS[3]);
});

check('anything else is left alone rather than guessed at', () => {
  // The old free-text categories must not be silently rewritten.
  assert.equal(ctx.expenseCat('Sequencing'), null);
  assert.equal(ctx.expenseCat(''), null);
  assert.equal(ctx.expenseCat(null), null);
  assert.equal(ctx.expenseCat(undefined), null);
});

console.log('\nWhat is left on each grant');

const ISF = { id: 'g1', name: 'ISF 1234/26', agency: 'ISF', awarded: '400,000', currency: '₪' };
const NIH = { id: 'g2', name: 'NIH R01-XYZ', agency: 'NIH', awarded: '250000', currency: '$' };

check('a typed "400,000" is four hundred thousand, not zero', () => {
  // Number("400,000") is NaN, which would have printed as 0 beside a total
  // that counted it correctly.
  assert.equal(ctx.amount('400,000'), 400000);
  assert.equal(ctx.amount('₪1,200.50'), 1200.5);
  assert.equal(ctx.amount('1200'), 1200);
  assert.equal(ctx.amount('not a number'), 0);
  assert.equal(ctx.amount(''), 0);
});

check('each grant is counted only its own expenses', () => {
  inventory = {
    grants: [ISF, NIH],
    expenses: [
      { id: 'e1', grant: 'g1', cost: '1,200', category: 'חומרים וציוד מתכלה' },
      { id: 'e2', grant: 'g1', cost: '800', category: 'מלגות' },
      { id: 'e3', grant: 'g2', cost: '5000', category: 'מלגות' }
    ]
  };
  const s = ctx.grantSummary();
  assert.equal(s[0].spent, 2000);
  assert.equal(s[0].left, 398000);
  assert.equal(s[1].spent, 5000);
  assert.equal(s[1].left, 245000);
});

check('an expense charged to nothing is in no grant total', () => {
  inventory = {
    grants: [ISF],
    expenses: [
      { id: 'e1', grant: 'g1', cost: '1000' },
      { id: 'e2', grant: '', cost: '9999' },
      { id: 'e3', grant: 'deleted-grant', cost: '7777' }
    ]
  };
  const s = ctx.grantSummary();
  assert.equal(s[0].spent, 1000, 'unassigned money must not be charged to a grant');
});

check('going over is reported as over, not clamped to nothing left', () => {
  inventory = { grants: [{ id: 'g1', name: 'Small', awarded: '100', currency: '₪' }],
    expenses: [{ id: 'e1', grant: 'g1', cost: '150' }] };
  const s = ctx.grantSummary();
  assert.equal(s[0].left, -50);
  assert.equal(s[0].pct, 100, 'the bar stops at full, but the number does not');
});

check('the by-category table never adds two currencies together', () => {
  // The guard is in categoriesHtml: a row total only when every grant
  // shares one currency.
  const body = fn('categoriesHtml');
  assert.match(body, /sameCur/);
  assert.match(body, /oneCur\.length <= 1/);
  assert.match(body, /sameCur \? '<th>Total<\/th>' : ''/);
});

check('a category that is not one of the lab headings is still shown', () => {
  const body = fn('categoriesHtml');
  assert.match(body, /not a lab heading/);
  assert.match(body, /no category/);
});

console.log('\nImporting a file of expenses');

// A tiny stand-in for the part of SheetJS the importer uses.
const XLSX = {
  SSF: {
    parse_date_code(n) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    }
  },
  utils: { sheet_to_json: (sheet) => sheet }
};
const book = (sheets) => ({ SheetNames: Object.keys(sheets), Sheets: sheets });

inventory = { grants: [ISF, NIH], expenses: [] };

check('a Hebrew heading row is understood', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    'גיליון1': [
      ['תאריך', 'פריט', 'מענק', 'קטגוריה', 'סכום', 'הערות'],
      ['2026-03-04', 'ערכת מיני-פרפ', 'ISF 1234/26', 'חומרים וציוד מתכלה', '1,200', 'דחוף']
    ]
  }));
  assert.equal(plan.items.length, 1);
  const e = plan.items[0];
  assert.equal(e.name, 'ערכת מיני-פרפ');
  assert.equal(e.grant, 'g1', 'the grant should be matched by its name');
  assert.equal(e.category, 'חומרים וציוד מתכלה');
  assert.equal(e.cost, '1,200');
  assert.equal(e.date, '2026-03-04');
  assert.equal(e.notes, 'דחוף');
});

check('an English heading row works the same', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    Sheet1: [
      ['Date', 'What was bought', 'Grant', 'Category', 'Amount', 'Notes'],
      ['2026-03-04', 'Q5 polymerase', 'NIH R01-XYZ', 'Consumables', '430', '']
    ]
  }));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].grant, 'g2');
  assert.equal(plan.items[0].category, 'חומרים וציוד מתכלה',
    'an English heading should be filed under the lab’s own Hebrew one');
});

check('a grant can be named by its reference instead', () => {
  inventory = { grants: [{ id: 'g9', name: 'Horizon', ref: 'EU-101-234', currency: '€' }], expenses: [] };
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [['Date', 'Item', 'Fund', 'Amount'], ['2026-01-01', 'Antibody', 'EU-101-234', '640']]
  }));
  assert.equal(plan.items[0].grant, 'g9');
  inventory = { grants: [ISF, NIH], expenses: [] };
});

check('dates arrive as dd/mm/yyyy and as Excel serials', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [
      ['Date', 'Item', 'Amount'],
      ['04/03/2026', 'Tips', '200'],
      [46085, 'Tubes', '300'],          // 2026-03-04 as Excel counts it
      ['4.3.2026', 'Gloves', '100']
    ]
  }));
  assert.equal(plan.items[0].date, '2026-03-04', 'dd/mm/yyyy is how the finance office writes it');
  assert.equal(plan.items[1].date, '2026-03-04', 'an Excel date serial');
  assert.equal(plan.items[2].date, '2026-03-04');
});

check('a row with no amount is skipped and named, not imported as zero', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [['Date', 'Item', 'Amount'], ['2026-01-01', 'Mystery', ''], ['2026-01-02', 'Real', '50']]
  }));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.noAmount.length, 1);
  assert.match(plan.noAmount[0], /row 2/);
});

check('a row naming a grant that is not here comes in unassigned, and is reported', () => {
  // Dropping it would hide spending; filing it anywhere would be a guess.
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [['Date', 'Item', 'Grant', 'Amount'], ['2026-01-01', 'Plates', 'ISF 9999/99', '75']]
  }));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].grant, '');
  assert.deepEqual(Object.keys(plan.unknownGrant), ['ISF 9999/99']);
});

check('a category that is not a lab heading is kept exactly as written', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [['Date', 'Item', 'Category', 'Amount'], ['2026-01-01', 'Flights', 'Travel', '900']]
  }));
  assert.equal(plan.items[0].category, 'Travel');
  assert.deepEqual(Object.keys(plan.unknownCat), ['Travel']);
});

check('importing the same file twice does not double the spending', () => {
  const sheet = book({ S: [['Date', 'Item', 'Grant', 'Amount'], ['2026-01-01', 'Tips', 'ISF 1234/26', '200']] });
  const first = ctx.buildExpensePlan(XLSX, sheet);
  assert.equal(first.items.length, 1);
  inventory.expenses = first.items;            // as if it had been saved
  const second = ctx.buildExpensePlan(XLSX, sheet);
  assert.equal(second.items.length, 0);
  assert.equal(second.dupes, 1);
  inventory.expenses = [];
});

check('the same amount on two different days is not a duplicate', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [['Date', 'Item', 'Amount'], ['2026-01-01', 'Tips', '200'], ['2026-02-01', 'Tips', '200']]
  }));
  assert.equal(plan.items.length, 2, 'buying the same thing twice is two expenses');
});

check('a sheet without the two columns that matter is left alone', () => {
  // The workbook may hold other sheets; only ones that can describe an
  // expense are read.
  const plan = ctx.buildExpensePlan(XLSX, book({
    Instructions: [['How to fill this in'], ['Write one row per expense']],
    S: [['Date', 'Item', 'Amount'], ['2026-01-01', 'Tips', '200']]
  }));
  assert.equal(plan.sheets, 1);
  assert.equal(plan.items.length, 1);
});

check('every imported expense is credited to whoever imported it', () => {
  const plan = ctx.buildExpensePlan(XLSX, book({
    S: [['Date', 'Item', 'Amount'], ['2026-01-01', 'Tips', '200']]
  }));
  assert.equal(plan.items[0].addedBy, 'Dr. Amer Elias');
  assert.ok(plan.items[0].id, 'every row needs an id of its own');
});

console.log('\nA grant’s allowance per heading');

vm.runInContext(fn('grantBudget'), ctx);
vm.runInContext(fn('hasBudget'), ctx);

check('a grant saved before budgets existed has none, and does not throw', () => {
  assert.deepEqual(Object.keys(ctx.grantBudget({ id: 'g1', name: 'Old' })), []);
  assert.deepEqual(Object.keys(ctx.grantBudget(null)), []);
  assert.deepEqual(Object.keys(ctx.grantBudget({ budget: 'not an object' })), []);
  assert.equal(ctx.hasBudget({ id: 'g1' }), false);
});

check('a heading left blank is untracked, not a cap of zero', () => {
  // "Nothing may be spent here" and "nobody said" are different facts and
  // the page shows them differently.
  assert.equal(ctx.hasBudget({ budget: {} }), false);
  assert.equal(ctx.hasBudget({ budget: { consumables: '' } }), false);
  assert.equal(ctx.hasBudget({ budget: { consumables: '40000' } }), true);
});

check('the allowance is keyed by the stable key, not the Hebrew words', () => {
  // The Hebrew is what an expense stores, because that is what is in the
  // files people import. This map is internal, so renaming a label later
  // must not strand the figures under it.
  const modal = src.slice(src.indexOf('function openGrantModal'), src.indexOf('async function saveGrant'));
  assert.match(modal, /id="m-gb-' \+ c\.key/);
  const save = fn('saveGrant');
  assert.match(save, /budget\[c\.key\] = v/);
  assert.match(save, /if \(v !== ''\)/, 'a blank must not be stored as a cap');
});

check('spending is measured against the heading of the grant it came out of', () => {
  // Not against the sum of every grant's allowance for that heading: the
  // whole point is that each grant is followed separately.
  const body = fn('categoriesHtml');
  assert.match(body, /grantBudget\(byId\[col\.id\]\)\[row\.match\.key\]/);
  assert.match(body, /col\.loose/, 'an unassigned expense has no grant and so no allowance');
});

check('a heading is shown once it has an allowance, before anything is spent', () => {
  const body = fn('categoriesHtml');
  assert.match(body, /!caps\.some\(function \(c\) \{ return c != null; \}\)/);
});

check('over the allowance is said, not hidden', () => {
  const body = fn('categoriesHtml');
  assert.match(body, /over by/);
  assert.match(body, /left of/);
  assert.match(body, /over \? ' over' : ''/);
});

console.log('\nWho can see the money');

const sql = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');

check('grants and expenses are admin-only in the database, not just in the menu', () => {
  // A member's own query must come back without those rows. Hiding the
  // menu item hides the menu item and nothing else.
  const pol = sql.slice(sql.indexOf('drop policy if exists inventory_items_rw'));
  assert.ok(pol, 'there is no inventory_items policy of its own');
  const stmt = pol.slice(0, pol.indexOf(';', pol.indexOf('with check')) + 1);
  assert.match(stmt, /category not in \('grants', 'expenses'\) or public\.is_admin\(\)/);
  // both halves: reading them and writing them
  assert.equal((stmt.match(/is_admin\(\)/g) || []).length, 2,
    'using and with check must both be restricted, or a member could still write them');
  assert.match(stmt, /using \(/);
  assert.match(stmt, /with check \(/);
});

check('the stricter policy is applied after the blanket one, not before', () => {
  // The loop above creates inventory_items_rw for every content table; if
  // the strict one came first the loop would replace it and nobody would
  // notice until a student read the budget.
  const loop = sql.indexOf("foreach t in array array['protocols'");
  const strict = sql.indexOf('drop policy if exists inventory_items_rw');
  assert.ok(loop >= 0 && strict > loop, 'the admin-only policy must come after the loop that creates the generic one');
});

check('being approved is still required as well as being admin', () => {
  const pol = sql.slice(sql.indexOf('drop policy if exists inventory_items_rw'));
  const stmt = pol.slice(0, pol.indexOf(';', pol.indexOf('with check')) + 1);
  assert.equal((stmt.match(/is_approved\(\)/g) || []).length, 2,
    'a disabled admin should not keep access');
});

check('the app agrees with the database rather than showing an empty page', () => {
  assert.match(src, /function financesAllowed\(\) \{ return DB\.isAdmin\(\); \}/);
  const render = fn('renderFinances');
  assert.match(render, /if \(!financesAllowed\(\)\)/);
  assert.match(render, /visible to the PI only/);
  ['openGrantModal', 'openExpenseModal', 'openExpenseImportModal'].forEach((name) => {
    assert.match(fn(name), /if \(!financesAllowed\(\)\)/, name + ' is not guarded');
  });
});

console.log('\nWiring');

check('the Import button is on the Finances page', () => {
  assert.match(html, /onclick="openExpenseImportModal\(\)"/);
  const fin = html.slice(html.indexOf('id="ln-finances"'), html.indexOf('id="ln-admin"'));
  assert.match(fin, /openExpenseImportModal/, 'it belongs in the Finances header, not elsewhere');
});

check('every function the page calls is defined', () => {
  ['openExpenseImportModal', 'downloadExpenseTemplate', 'previewExpenseImport',
   'saveExpenseImport', 'categoriesHtml', 'expenseCat'].forEach((name) => {
    assert.match(src, new RegExp('function ' + name + '\\('), name + ' is referenced but not defined');
  });
});

check('the category field is a fixed list now, not free text', () => {
  const modal = src.slice(src.indexOf('function openExpenseModal'), src.indexOf('async function saveExpense'));
  assert.match(modal, /<select id="m-ecategory"/);
  assert.doesNotMatch(modal, /<input id="m-ecategory"/);
  // and an expense recorded before the headings existed keeps what it had
  assert.match(modal, /as recorded/);
});

check('Hebrew is laid out in its own direction wherever it is shown', () => {
  assert.match(src, /<select id="m-ecategory" dir="auto"/);
  assert.match(fn('categoriesHtml'), /<td dir="auto">/);
  const css = fs.readFileSync(path.join(root, 'css', 'notebook.css'), 'utf8');
  assert.match(css, /\.ln-cat-table \[dir="auto"\]\{unicode-bidi:isolate;\}/);
});

check('the cache-busting versions were bumped with the code', () => {
  assert.match(html, /js\/notebook\.js\?v=(3[4-9]|[4-9]\d)/, 'notebook.js ?v= is stale');
  assert.match(html, /css\/notebook\.css\?v=(29|[3-9]\d)/, 'notebook.css ?v= is stale');
});

console.log(`\n${pass} checks passed`);
