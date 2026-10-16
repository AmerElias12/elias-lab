/* Checks for the page-free half of js/science-api.js.
 *
 *     node scripts/check-science-api.mjs
 *
 *     # and, against a service that is actually running:
 *     SCIENCE_API_BASE=http://127.0.0.1:8000 \
 *     SCIENCE_API_TOKEN=<a Supabase session token> \
 *     node scripts/check-science-api.mjs
 *
 * Two halves, for two different questions.
 *
 * The first half covers what this file decides on its own: which requests it
 * refuses before sending, which sentence a failure gets, and which numbers a
 * table shows. The responses it renders are not invented — they are in
 * scripts/fixtures/science-*.json exactly as the real service returned them
 * (pydna 5.2, biopython 1.88, primers 0.5), so a shape that drifts shows up
 * here as a failing assertion rather than as an empty table in a browser.
 *
 * The second half only runs when SCIENCE_API_BASE and SCIENCE_API_TOKEN are
 * set, and then it talks to a real service: the same request builders, the
 * same rendering helpers, over real HTTP. That is the half that would catch
 * a field this file spells differently from the server. Without it the first
 * half is still worth running and says so at the end.
 *
 * The browser half of science-api.js — the Supabase session, the panels — is
 * not covered here. It needs a browser, and it was checked in one.
 */
import assert from 'assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const API = require('../js/science-api.js');
const VIEWER = require('../js/vector-viewer.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));

const CLONING = fixture('science-cloning-response.json');
const PRIMERS = fixture('science-primers-cloning.json');
const PRIMERS_QPCR = fixture('science-primers-qpcr.json');

let passed = 0;
/* An async check started at the top level would otherwise still be running
   when the total prints, and a failure in it would land after it. */
const pending = [];
const check = (what, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      const settled = r.then(
        () => { passed++; console.log(`  ok    ${what}`); },
        (err) => { console.log(`  FAIL  ${what}\n          ${err.message}`); process.exitCode = 1; }
      );
      pending.push(settled);
      return settled;
    }
  } catch (err) {
    console.log(`  FAIL  ${what}\n          ${err.message}`);
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log(`  ok    ${what}`);
};

const kindOf = (fn) => {
  try { fn(); } catch (err) { return err.kind; }
  return 'no error';
};

/* ===========================================================================
   Is it configured, and where
   ======================================================================== */
console.log('\nconfiguration');

check('a blank URL means "not configured", which is a supported state', () => {
  assert.equal(API.normalizeBaseUrl(''), '');
  assert.equal(API.normalizeBaseUrl('   '), '');
  assert.equal(API.normalizeBaseUrl(undefined), '');
  assert.equal(API.normalizeBaseUrl(null), '');
  assert.equal(API.isConfigured({ SCIENCE_API_URL: '' }), false);
  assert.equal(API.isConfigured({}), false);
});

check('js/config.js ships with no URL in it', () => {
  // The published config is a file anybody can read. A URL committed here
  // would point the whole internet at the lab's container.
  const published = readFileSync(join(HERE, '..', 'js', 'config.js'), 'utf8');
  // The declaration, not the paragraph above it that explains the field.
  const assignments = published.split('\n').filter((l) => /SCIENCE_API_URL\s*:/.test(l));
  assert.equal(assignments.length, 1, `one declaration, found ${assignments.length}`);
  const value = assignments[0].match(/SCIENCE_API_URL\s*:\s*'([^']*)'/);
  assert.ok(value, `the declaration is a plain string: ${assignments[0].trim()}`);
  assert.equal(value[1], '', `and it is empty, not ${value[1]}`);
});

check('the placeholder in config.example.js is not mistaken for a URL', () => {
  assert.equal(API.normalizeBaseUrl('https://YOUR-SERVICE-HOST'), '');
  assert.equal(API.normalizeBaseUrl('https://tools.example.com'), '');
});

check('a trailing slash never becomes a double one', () => {
  assert.equal(API.endpoint('https://t.example.org/', '/api/health'), 'https://t.example.org/api/health');
  assert.equal(API.endpoint('https://t.example.org///', 'api/health'), 'https://t.example.org/api/health');
});

/* ===========================================================================
   Requests: refused here, or refused there
   ======================================================================== */
console.log('\nrequest building');

check('the cloning body uses the field names the service declares', () => {
  const body = API.cloningRequest({
    sequenceA: 'GAATTCACGT', sequenceB: 'GAATTCTGCA',
    enzymes: ['EcoRI'], nameA: 'vector', nameB: 'insert',
  });
  assert.deepEqual(Object.keys(body).sort(), [
    'circular_only', 'enzymes', 'name_a', 'name_b', 'sequence_a', 'sequence_b',
  ]);
  assert.equal(body.circular_only, true, 'linear products are off unless asked for');
});

check('a GenBank record reaches the cloning endpoint intact', () => {
  // Stripping it would throw away the features that come back on the
  // construct, which is most of the value of simulating at all.
  const gb = readFileSync(join(HERE, 'fixtures', 'pFIX-vector.gb'), 'utf8');
  const body = API.cloningRequest({ sequenceA: gb, sequenceB: gb, enzymes: ['EcoRI'] });
  assert.ok(body.sequence_a.includes('LOCUS'));
  assert.ok(body.sequence_a.includes('/label="AmpR"'));
});

check('enzyme names are de-duplicated but never re-spelled', () => {
  // REBASE is case-sensitive and the service answers a near miss with
  // "did you mean 'EcoRI'?", which beats anything guessable here.
  assert.deepEqual(API.cleanEnzymeNames([' EcoRI ', 'EcoRI', 'BamHI']), ['EcoRI', 'BamHI']);
  assert.deepEqual(API.cleanEnzymeNames(['ECORI']), ['ECORI']);
});

check('the limits that would come back as a 422 are refused here instead', () => {
  // pydantic answers these with an array of {loc, msg}, which is not a
  // sentence. The bounds are the ones in backend/app/schemas.py.
  assert.equal(kindOf(() => API.cloningRequest({ sequenceA: 'A', sequenceB: 'C', enzymes: [] })), 'input');
  assert.equal(kindOf(() => API.cloningRequest({
    sequenceA: 'A', sequenceB: 'C',
    enzymes: ['EcoRI', 'BamHI', 'XhoI', 'NotI', 'SalI', 'KpnI', 'XbaI', 'SpeI', 'PstI'],
  })), 'input');
  assert.equal(kindOf(() => API.primerRequest({ template: 'ACGT', productLength: 10 })), 'input');
  assert.equal(kindOf(() => API.primerRequest({ template: 'ACGT', productLength: 50000 })), 'input');
  assert.equal(kindOf(() => API.primerRequest({ template: 'ACGT', productLength: 200, optimalTm: 99 })), 'input');
  assert.equal(kindOf(() => API.primerRequest({ template: 'ACGT', productLength: 200, maxPairs: 50 })), 'input');
  assert.equal(kindOf(() => API.primerRequest({ template: 'ACGT', productLength: 200, purpose: 'pcr' })), 'input');
});

check('a missing sequence is named, not reported as "invalid input"', () => {
  try {
    API.cloningRequest({ sequenceA: 'ACGT', sequenceB: '   ', enzymes: ['EcoRI'] });
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /both molecules/);
  }
});

check('the primer body defaults match the service defaults', () => {
  const body = API.primerRequest({ template: 'ACGT', productLength: 400 });
  assert.equal(body.optimal_tm, 60);
  assert.equal(body.max_pairs, 3);
  assert.equal(body.purpose, 'cloning');
  assert.deepEqual(Object.keys(body).sort(), [
    'max_pairs', 'optimal_tm', 'product_length', 'purpose', 'template',
  ]);
});

check('a record pasted into the primer template is caught with advice', () => {
  // /api/primers/design strips whitespace and digits and nothing else, so a
  // GenBank record arrives as its own header text. Its 400 is accurate
  // ('found "-./=BDEFHIJ…') and tells nobody what to do.
  assert.equal(API.looksLikeRecord('>seq1\nACGT'), 'FASTA');
  assert.equal(API.looksLikeRecord(readFileSync(join(HERE, 'fixtures', 'pFIX-insert.gb'), 'utf8')), 'GenBank');
  assert.equal(API.looksLikeRecord('acgt acgt\n 61 acgt'), '');
  try {
    API.primerRequest({ template: '>pFIX\nACGTACGT', productLength: 150 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.kind, 'input');
    assert.match(err.message, /takes bases, not a FASTA record/);
  }
});

check('numbering and line breaks in a pasted template are left alone', () => {
  // The service strips those itself; stripping them twice is one more place
  // for the two to disagree about what was submitted.
  const pasted = '   1 acgtacgtac gtacgtacgt\n  21 acgtacgtac gtacgtacgt';
  const body = API.primerRequest({ template: pasted, productLength: 150 });
  assert.equal(body.template, pasted.trim());
});

check('refused input arrives as a rejection, not as a throw', async () => {
  // Both panels are written as call(...).then(show).catch(explain). A
  // synchronous throw from the request builder would walk straight past
  // that .catch, out of the click handler: nothing on screen, and a button
  // left reading "designing…". It cost a browser session to find once.
  const refusals = [
    () => API.designPrimers({ template: '>x\nACGT', productLength: 150 }),
    () => API.designPrimers({ template: 'ACGT', productLength: 1 }),
    () => API.digestLigation({ sequenceA: 'ACGT', sequenceB: 'ACGT', enzymes: [] }),
    () => API.digestLigation({ sequenceA: '', sequenceB: '', enzymes: ['EcoRI'] }),
  ];
  for (const call of refusals) {
    let promise;
    try {
      promise = call();
    } catch (err) {
      assert.fail(`threw synchronously instead of rejecting: ${err.message}`);
    }
    assert.ok(promise && typeof promise.then === 'function', 'a promise comes back');
    await promise.then(
      () => assert.fail('should have rejected'),
      (err) => assert.equal(err.kind, 'input', `rejected as ${err.kind}`)
    );
  }
});

/* ===========================================================================
   Failure, described
   ======================================================================== */
console.log('\nfailure modes');

check('each of the five failures gets its own sentence', () => {
  const kinds = ['unconfigured', 'signed-out', 'unauthorized', 'bad-request', 'network', 'server'];
  const seen = new Set();
  kinds.forEach((kind) => {
    const d = API.describeError({ kind, message: 'detail from the service' }, { base: 'http://svc', origin: 'http://site' });
    assert.equal(d.kind, kind);
    assert.ok(d.title && d.message, `${kind} has a title and a message`);
    assert.ok(!seen.has(d.title), `${kind} does not reuse "${d.title}"`);
    seen.add(d.title);
  });
});

check('"not configured" says the page still works', () => {
  const d = API.describeError({ kind: 'unconfigured' }, {});
  assert.match(d.message, /browser/);
  assert.equal(d.signIn, false, 'signing in would not help');
});

check('only the two session failures offer a sign-in', () => {
  assert.equal(API.describeError({ kind: 'signed-out' }, {}).signIn, true);
  assert.equal(API.describeError({ kind: 'unauthorized' }, {}).signIn, true);
  ['unconfigured', 'bad-request', 'network', 'server', 'input'].forEach((kind) => {
    assert.equal(API.describeError({ kind, message: 'x' }, {}).signIn, false, kind);
  });
});

check('a 400 is shown verbatim, because the service wrote it for a person', () => {
  const detail = 'none of EcoRI cuts A, so there is nothing to ligate';
  const d = API.describeError({ kind: 'bad-request', message: detail }, {});
  assert.equal(d.message, detail);
});

check('a network failure names both things it could be', () => {
  const d = API.describeError({ kind: 'network' }, { base: 'https://svc.example', origin: 'https://site.example' });
  assert.match(d.message, /svc\.example/);
  assert.match(d.message, /site\.example/, 'the origin, for the CORS case');
  assert.match(d.message, /ELN_CORS_ORIGINS/);
});

check('FastAPI\'s two shapes of `detail` both become one line', () => {
  assert.equal(
    API.detailToSentence({ detail: 'the template is shorter than the product' }, 400),
    'the template is shorter than the product'
  );
  assert.equal(
    API.detailToSentence({ detail: [{ loc: ['body', 'product_length'], msg: 'Input should be greater than or equal to 50' }] }, 422),
    'product_length: Input should be greater than or equal to 50'
  );
  assert.match(API.detailToSentence(null, 502), /502/);
});

/* ===========================================================================
   The enzyme picker
   ======================================================================== */
console.log('\nthe enzyme picker');

/* All 42 names GET /api/cloning/enzymes?q=eco returns, in the order it
   returns them. Digits sort before letters, so EcoRI is 37th. */
const ECO = [
  'Eco105I', 'Eco130I', 'Eco147I', 'Eco1836I', 'Eco24I', 'Eco31I', 'Eco32I',
  'Eco4174I', 'Eco43896II', 'Eco4465II', 'Eco47I', 'Eco47III', 'Eco52I',
  'Eco53kI', 'Eco57I', 'Eco57MI', 'Eco72I', 'Eco8164I', 'Eco81I', 'Eco88I',
  'Eco9009II', 'Eco9020I', 'Eco9035I', 'Eco91I', 'Eco9699II', 'EcoBLMcrX',
  'EcoE1140I', 'EcoHI', 'EcoHSI', 'EcoICRI', 'EcoMVII', 'EcoNI', 'EcoNIH6II',
  'EcoO109I', 'EcoO157SI', 'EcoO65I', 'EcoRI', 'EcoRII', 'EcoRV', 'EcoT14I',
  'EcoT22I', 'EcoT38I',
];

check('searching "eco" lifts EcoRI out of the numbered series', () => {
  assert.equal(ECO.indexOf('EcoRI'), 36, 'alphabetically it is 37th');
  const ranked = API.rankEnzymes(ECO, 'eco');
  assert.ok(ranked.indexOf('EcoRI') < 4, `ranked ${ranked.indexOf('EcoRI') + 1}th: ${ranked.slice(0, 4)}`);
  // The claim is only that the numbered names stop being in the way — not
  // that this picks the enzyme somebody meant. EcoHI is also five
  // characters, and nothing in a name says which is in the freezer.
  ranked.slice(0, 4).forEach((name) => {
    assert.ok(!/^Eco\d/.test(name), `${name} is a numbered name still at the top`);
  });
  assert.equal(ranked.length, ECO.length, 'nothing is dropped, only reordered');
});

check('one more letter resolves it', () => {
  assert.equal(API.rankEnzymes(ECO, 'ecor')[0], 'EcoRI');
  assert.equal(API.rankEnzymes(ECO, 'EcoRV')[0], 'EcoRV', 'an exact name wins outright');
  assert.equal(API.rankEnzymes(['EcoRII', 'EcoRI'], 'EcoRI')[0], 'EcoRI', 'even when a longer name contains it');
});

/* ===========================================================================
   Rendering the real cloning response
   ======================================================================== */
console.log('\nthe cloning result (fixture captured from pydna)');

check('the fixture is the shape this file claims it renders', () => {
  assert.deepEqual(Object.keys(CLONING).sort(), ['constructs', 'enzymes', 'inputs', 'notes']);
  assert.equal(CLONING.constructs.length, 4);
  assert.deepEqual(CLONING.enzymes, ['BamHI', 'EcoRI']);
});

check('a construct goes into the viewer without translation', () => {
  // The service shapes `sequence`, `topology` and `features` for
  // js/vector-viewer.js. This is the assertion that the two agree.
  const payload = API.constructPayload(CLONING.constructs[0]);
  const model = VIEWER.normalizePayload(payload);
  assert.equal(model.seq.length, CLONING.constructs[0].length_bp);
  assert.equal(model.circular, true);
  assert.deepEqual(model.warnings, [], 'no feature was dropped');
  assert.deepEqual(
    model.annotations.map((a) => a.name).sort(),
    ['AmpR', 'CMV promoter', 'EGFP']
  );
});

check('the reverse-strand marker keeps its strand through the hand-off', () => {
  // AmpR is complement(250..390) in the fixture. A marker that arrives on
  // the wrong strand is drawn pointing the wrong way.
  const construct = CLONING.constructs.find((c) => c.features.some((f) => f.name === 'AmpR'));
  const fromService = construct.features.find((f) => f.name === 'AmpR');
  assert.equal(fromService.strand, -1, 'the service says reverse');
  const model = VIEWER.normalizePayload(API.constructPayload(construct));
  assert.equal(model.annotations.find((a) => a.name === 'AmpR').direction, -1);
});

check('a construct with no features still draws', () => {
  const bare = CLONING.constructs.find((c) => c.features.length === 0);
  assert.ok(bare, 'the fixture has one');
  const model = VIEWER.normalizePayload(API.constructPayload(bare));
  assert.equal(model.annotations.length, 0);
  assert.ok(model.seq.length > 0);
});

check('a linear construct is not offered to the circular view', () => {
  const payload = API.constructPayload({ sequence: 'ACGTACGTACGT', topology: 'linear' });
  assert.equal(payload.topology, 'linear');
  assert.equal(VIEWER.normalizePayload(payload).circular, false);
});

check('the summary says whether the insert can be cut back out', () => {
  const lines = API.summarizeConstruct(CLONING.constructs[0]);
  assert.match(lines[0], /612 bp, circular/);
  assert.ok(lines.some((l) => /pFIX-insert fragment/.test(l)), 'the parts are listed');
  assert.ok(lines.some((l) => /rebuilt the site/.test(l)), 'both junctions regenerated here');

  const lost = API.summarizeConstruct({
    length_bp: 100, topology: 'circular',
    junctions: [{ enzyme: 'BamHI', site: 'GGATCC', sites_in_product: 0, regenerated: false }],
  });
  assert.ok(lost.some((l) => /cannot be cut back out/.test(l)));
});

/* ===========================================================================
   Rendering the real primer response
   ======================================================================== */
console.log('\nthe primer result (fixture captured from the primers package)');

check('a pair flattens into the cells the table shows', () => {
  const pair = API.summarizePair(PRIMERS.pairs[0], 0);
  assert.equal(pair.rank, 1);
  assert.equal(pair.primers.length, 2);
  const [fwd, rev] = pair.primers;
  assert.equal(fwd.role, 'forward');
  assert.equal(rev.role, 'reverse');
  assert.equal(fwd.sequence, PRIMERS.pairs[0].forward.sequence);
  assert.equal(fwd.tm, PRIMERS.pairs[0].forward.tm);
  assert.equal(fwd.gc, PRIMERS.pairs[0].forward.gc_percent);
  assert.equal(rev.strand, '-', 'the reverse primer reads on the reverse strand');
  assert.equal(pair.productLength, PRIMERS.pairs[0].product_length);
});

check('positions are shown 1-based, as a primer is written down', () => {
  // The service reports the 0-based half-open span js/plasmid.js uses.
  const raw = PRIMERS.pairs[0].forward;
  const shown = API.summarizePair(PRIMERS.pairs[0], 0).primers[0].position;
  assert.equal(shown, `${raw.start + 1}–${raw.end}`);
  assert.equal(
    Number(shown.split('–')[1]) - Number(shown.split('–')[0]) + 1,
    raw.length,
    'the shown span is as long as the primer'
  );
});

check('the score is broken into its parts, largest first, zeroes dropped', () => {
  // A total of 2.0 says nothing. "GC clamp 1.0, Tm difference 0.6, Tm 0.4"
  // says which knob to turn.
  const parts = API.penaltyParts(PRIMERS.pairs[0].penalties);
  assert.ok(parts.length > 0);
  assert.ok(parts.every((p) => p.value !== 0), 'nothing scored zero is listed');
  for (let i = 1; i < parts.length; i++) {
    assert.ok(parts[i - 1].value >= parts[i].value, 'descending');
  }
  const total = parts.reduce((s, p) => s + p.value, 0);
  assert.ok(Math.abs(total - PRIMERS.pairs[0].score) < 0.051, `parts sum to the score (${total} vs ${PRIMERS.pairs[0].score})`);
  assert.ok(parts.every((p) => p.label && !p.label.includes('_')), 'labels are words, not field names');
});

check('a pair that was not screened says so rather than claiming zero hits', () => {
  const pair = API.summarizePair(PRIMERS.pairs[0], 0);
  assert.equal(pair.screened, false);
  assert.equal(PRIMERS.screen, null);
  // "0 off-target sites" and "nothing was screened" are not the same claim.
  assert.equal(pair.spuriousAmplicons, 0);
});

check('the Tm conditions travel with the number', () => {
  // Biopython's defaults are a hybridisation experiment, not a PCR, and the
  // difference is around ten degrees.
  const line = API.tmConditionsLine(PRIMERS.tm_conditions);
  assert.match(line, /Na/);
  assert.match(line, /Mg/);
  assert.match(line, /primer 250 nM/);
  assert.match(line, /Owczarzy/);
  assert.equal(API.tmConditionsLine(null), '', 'and an absent block prints nothing');
});

check('the qPCR guidance comes out as the list of strings a panel prints', () => {
  const lines = API.guidanceLines(PRIMERS_QPCR.guidance);
  assert.ok(lines.length > 15, `got ${lines.length} lines`);
  assert.ok(lines.every((l) => typeof l === 'string' && l.length > 0));
  assert.match(lines[0], /exon/i, 'the title leads');
  assert.ok(lines.some((l) => /−RT control|-RT control/.test(l)), 'the control is in there');
  assert.ok(lines.some((l) => /7 bases/.test(l)), 'and the number that matters');
});

check('a cloning design has no guidance, and that is not an error', () => {
  assert.equal(PRIMERS.guidance, null);
  assert.deepEqual(API.guidanceLines(PRIMERS.guidance), []);
  assert.deepEqual(API.guidanceLines(undefined), []);
});

check('the notes that qualify the answer are not dropped', () => {
  // "40 positions were tried, not every one" is the sentence that stops
  // these being read as the best possible pairs.
  assert.ok(PRIMERS.notes.length >= 1);
  assert.ok(PRIMERS_QPCR.notes.length >= 3, 'qPCR adds the screening and exon notes');
  assert.ok(PRIMERS_QPCR.notes.some((n) => /screened/.test(n)));
});

check('a pair with warnings keeps them', () => {
  const pair = API.summarizePair({
    forward: { sequence: 'ACGT', tm: 58 }, reverse: { sequence: 'TGCA', tm: 60 },
    score: 9, penalties: { tm: 9 },
    warnings: ['the 3\' end has three G or C in the last five bases'],
  }, 0);
  assert.equal(pair.warnings.length, 1);
});

check('an empty result renders as empty rather than throwing', () => {
  // pairs_found can be 0 — a 90 bp template asked for a 400 bp product.
  assert.deepEqual([].map((p, i) => API.summarizePair(p, i)), []);
  const blank = API.summarizePair({}, 0);
  assert.equal(blank.primers.length, 2);
  assert.equal(blank.primers[0].sequence, '');
});

/* ===========================================================================
   Against a service that is actually running
   ======================================================================== */
const BASE = process.env.SCIENCE_API_BASE;
const TOKEN = process.env.SCIENCE_API_TOKEN;

async function live() {
  console.log(`\nlive, against ${BASE}`);

  const post = async (path, body) => {
    const res = await fetch(API.endpoint(BASE, path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, payload: await res.json() };
  };

  await check('the service is the one these fixtures came from', async () => {
    const res = await fetch(API.endpoint(BASE, '/api/health'));
    const health = await res.json();
    assert.equal(health.mode, 'science');
    assert.ok(health.accepts.includes('supabase'), 'it can verify a Supabase token');
  });

  await check('a request this file builds is accepted as built', async () => {
    const gbA = readFileSync(join(HERE, 'fixtures', 'pFIX-vector.gb'), 'utf8');
    const gbB = readFileSync(join(HERE, 'fixtures', 'pFIX-insert.gb'), 'utf8');
    const body = API.cloningRequest({
      sequenceA: gbA, sequenceB: gbB, enzymes: ['EcoRI', 'BamHI'],
      nameA: 'pFIX-vector', nameB: 'pFIX-insert',
    });
    const { status, payload } = await post('/api/cloning/digest-ligation', body);
    assert.equal(status, 200, JSON.stringify(payload).slice(0, 300));
    assert.equal(payload.constructs.length, CLONING.constructs.length, 'same count as the fixture');
    const model = VIEWER.normalizePayload(API.constructPayload(payload.constructs[0]));
    assert.deepEqual(model.warnings, [], 'and it still goes into the viewer clean');
  });

  await check('a live primer design renders through the same helpers', async () => {
    const bases = readFileSync(join(HERE, 'fixtures', 'pFIX-insert.gb'), 'utf8')
      .split('ORIGIN')[1].replace(/[^acgtACGT]/g, '').toUpperCase();
    const body = API.primerRequest({ template: bases, productLength: 150, maxPairs: 2, purpose: 'qpcr' });
    const { status, payload } = await post('/api/primers/design', body);
    assert.equal(status, 200, JSON.stringify(payload).slice(0, 300));
    const pair = API.summarizePair(payload.pairs[0], 0);
    assert.ok(pair.primers[0].sequence.length > 10);
    assert.ok(pair.penalties.every((p) => typeof p.value === 'number'));
    assert.ok(API.guidanceLines(payload.guidance).length > 15, 'qPCR guidance came through');
    assert.ok(API.tmConditionsLine(payload.tm_conditions).includes('Owczarzy'));
  });

  await check('a 400 from the real service is a sentence, and we show it', async () => {
    const body = API.cloningRequest({
      sequenceA: 'ACGTACGTACGTACGTACGT', sequenceB: 'ACGTACGTACGTACGTACGT', enzymes: ['EcoRI'],
    });
    const { status, payload } = await post('/api/cloning/digest-ligation', body);
    assert.equal(status, 400);
    const sentence = API.detailToSentence(payload, status);
    assert.match(sentence, /EcoRI/, 'it names the enzyme');
    assert.equal(API.describeError({ kind: 'bad-request', message: sentence }, {}).message, sentence);
  });

  await check('a miscapitalised enzyme comes back with the right spelling', async () => {
    const body = API.cloningRequest({
      sequenceA: 'GAATTCACGTACGTACGTACGTGAATTC', sequenceB: 'GAATTCACGTACGTACGTACGTGAATTC', enzymes: ['ECORI'],
    });
    const { status, payload } = await post('/api/cloning/digest-ligation', body);
    assert.equal(status, 400);
    assert.match(API.detailToSentence(payload, status), /did you mean 'EcoRI'/);
  });

  await check('the anon key is not a credential here', async () => {
    // The hazard app/auth_light.py is built around: on a legacy project the
    // publishable key is a JWT signed with the project secret, and it is in
    // the HTML of the live site. science-api.js refuses to send it; this is
    // the other end of that, confirming it would be refused anyway.
    // Read out of the published config rather than repeated here, so this
    // follows a key rotation instead of going quietly stale.
    const published = readFileSync(join(HERE, '..', 'js', 'config.js'), 'utf8');
    const anon = published.match(/SUPABASE_ANON_KEY\s*:\s*'([^']+)'/);
    assert.ok(anon, 'config.js has a publishable key');
    const res = await fetch(API.endpoint(BASE, '/api/cloning/enzymes?q=eco'), {
      headers: { Authorization: `Bearer ${anon[1]}` },
    });
    assert.equal(res.status, 401);
  });

  await check('no bearer token at all is a 401, not a crash', async () => {
    const res = await fetch(API.endpoint(BASE, '/api/cloning/enzymes?q=eco'));
    assert.equal(res.status, 401);
    assert.equal(API.describeError({ kind: 'unauthorized', message: 'not authenticated' }, {}).signIn, true);
  });

  await check('the picker ranking is applied to what REBASE actually returns', async () => {
    const res = await fetch(API.endpoint(BASE, '/api/cloning/enzymes?q=eco&limit=200'), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const names = await res.json();
    assert.deepEqual(names, ECO, 'the list above is still what the service sends');
    const ranked = API.rankEnzymes(names, 'eco');
    assert.ok(ranked.indexOf('EcoRI') < 4, `EcoRI ranked ${ranked.indexOf('EcoRI') + 1}th of ${names.length}`);
    assert.equal(API.rankEnzymes(names, 'ecorv')[0], 'EcoRV');
  });
}

async function main() {
  if (BASE && TOKEN) {
    await live();
  } else {
    console.log('\nlive checks skipped — set SCIENCE_API_BASE and SCIENCE_API_TOKEN to run them');
    console.log('  (uvicorn app.science:app, with ELN_SUPABASE_JWT_SECRET set)');
  }
  await Promise.all(pending);
  console.log(`\n${passed} checks passed${BASE && TOKEN ? '' : ' (the live half did not run)'}`);
}

main();
