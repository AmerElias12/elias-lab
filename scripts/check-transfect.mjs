/* The transfection plan: ng in, microlitres out.

   Run:  node scripts/check-transfect.mjs

   The numbers here are the ones from a real plan of the lab's (Exp 5,
   prime editing in iPSCs), worked out by hand in Benchling before this
   block existed. If the block ever disagrees with them, it is the block
   that is wrong. */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
createRequire(import.meta.url);

const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../js/transfect.js', import.meta.url), 'utf8'), ctx);
const T = ctx.window.LabTransfect;

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}
const round = (v) => Math.round(v * 100) / 100;

function plan() {
  const st = T.blank();
  st.format = '24'; st.reagent = 'lipostem'; st.reps = 3; st.extra = 0; st.perWell = 500;
  st.plasmids = [{ name: 'CMV-GFP', conc: 420 }, { name: 'PE6c', conc: 1300 }, { name: 'Donor', conc: 1200 }];
  st.groups = [
    { name: 'UT', ng: [0, 0, 0] },
    { name: 'GFP only', ng: [500, 0, 0] },
    { name: 'Donor', ng: [0, 0, 500] },
    { name: 'TwinPE + Donor', ng: [0, 250, 150] }
  ];
  return st;
}

check('a volume is ng × wells ÷ the stock, as planned by hand', () => {
  const k = T.compute(plan());
  assert.equal(round(k.rows[1].vols[0]), 3.57);   // 500 × 3 / 420
  assert.equal(round(k.rows[2].vols[2]), 1.25);   // 500 × 3 / 1200
  assert.equal(round(k.rows[3].vols[1]), 0.58);   // 250 × 3 / 1300
  assert.equal(round(k.rows[3].vols[2]), 0.38);   // 150 × 3 / 1200
});
check('the Lipofectamine Stem tubes match the manufacturer’s 24-well amounts', () => {
  const k = T.compute(plan());
  assert.equal(k.reagentPer, 3);    // 1 µL × 3 wells
  assert.equal(k.mediumPer, 75);    // 25 µL × 3 wells, per tube
  assert.equal(k.addPer, 50);       // onto each well
});
check('extra % is carried into every volume', () => {
  const st = plan(); st.extra = 10;
  const k = T.compute(st);
  assert.equal(round(k.rows[1].vols[0]), round(500 * 3.3 / 420));
  assert.equal(round(k.reagentPer), 3.3);
});
check('a group that does not add up to the target is flagged', () => {
  const k = T.compute(plan());
  assert.equal(k.rows[1].off, false);   // 500 of 500
  assert.equal(k.rows[3].off, true);    // 400 of 500
  assert.equal(k.rows[0].off, false);   // untransfected is not a mistake
});
check('a plasmid with no concentration gives no volume, not a zero', () => {
  const st = plan(); st.plasmids[0].conc = 0;
  const k = T.compute(st);
  assert.equal(k.rows[1].vols[0], null);
  assert.equal(k.rows[1].unknown, true);
});
check('a volume too small to pipette is noticed', () => {
  const st = plan(); st.reps = 1;
  const k = T.compute(st);
  assert.equal(round(k.rows[3].vols[2]), 0.13);
  assert.equal(k.rows[3].short, true);
});
check('jetOPTIMUS is one tube and its own buffer', () => {
  const st = plan(); st.reagent = 'jetoptimus';
  const k = T.compute(st);
  assert.equal(k.s.r.tubes, 1);
  assert.equal(k.s.r.medium, 'jetOPTIMUS buffer');
  assert.equal(k.mediumPer, 150);   // 50 µL × 3 wells
  assert.equal(k.reagentPer, 1.5);
});
check('a saved plan is read back as it was written', () => {
  const st = plan();
  const back = T.load(JSON.stringify(st));
  assert.equal(back.plasmids.length, 3);
  assert.equal(back.groups.length, 4);
  assert.equal(back.groups[3].ng[1], 250);
  assert.equal(round(T.compute(back).rows[3].vols[1]), 0.58);
});
check('a plan that has been tampered with still loads', () => {
  const back = T.load('{"format":"nonsense","reagent":"x","reps":-4,"plasmids":"no","groups":[{"ng":[5]}]}');
  assert.equal(back.format, '24');
  assert.equal(back.reagent, 'lipostem');
  assert.equal(back.reps, 1);
  assert.equal(back.plasmids.length, 1);
  assert.equal(T.load('not json'), null);
});

console.log('\n' + passed + ' checks passed');
