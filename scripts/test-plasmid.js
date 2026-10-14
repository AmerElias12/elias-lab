#!/usr/bin/env node
/* Checks js/plasmid.js: file reading, sequence maths, editing and map drawing.
   Run it after changing that file:  node scripts/test-plasmid.js           */
'use strict';
var assert = require('assert/strict');
var path = require('path');
var P = require(path.join(__dirname, '..', 'js', 'plasmid.js'));

var pass = 0;
function check(what, fn) { fn(); pass++; console.log('  ok  ' + what); }

// A 120 bp test sequence whose every base is known.
var SEQ = ('ATGCATGCAT GCATGCATGC TTTTCCCCAA GGGGTTTTAA CCCCGGGGAT ' +
           'CGATCGATCG TACGTACGTA CCCCTTTTGG GGAAAACCCC ATATATGCGC ' +
           'GGGGCCCCAA TTTTGGGGCC').replace(/\s/g, '');
assert.equal(SEQ.length, 120);

function genbank(locus, extra) {
  var out = ['LOCUS       ' + locus + '              120 bp ds-DNA     circular SYN 13-OCT-2026',
    'DEFINITION  A test construct.',
    'FEATURES             Location/Qualifiers',
    '     source          1..120',
    '                     /organism="synthetic DNA construct"',
    '     CDS             11..40',
    '                     /gene="bla"',
    '                     /label="AmpR fragment"',
    '     promoter        complement(51..80)',
    '                     /label="lac promoter"',
    '     misc_feature    join(111..120,1..10)',
    '                     /label="origin-spanning"',
    '                     /note="this note runs onto',
    '                     a second line"'];
  if (extra) out = out.concat(extra);
  out.push('ORIGIN');
  for (var i = 0; i < SEQ.length; i += 60) {
    var chunks = [];
    for (var j = 0; j < 60; j += 10) { var c = SEQ.toLowerCase().substr(i + j, 10); if (c) chunks.push(c); }
    out.push(String(i + 1).padStart(9) + ' ' + chunks.join(' '));
  }
  out.push('//');
  return out.join('\n');
}

console.log('GenBank');
var gb = P.parseGenBank(genbank('pTEST'));
check('sequence and topology', function () {
  assert.equal(gb.seq, SEQ);
  assert.equal(gb.topology, 'circular');
  assert.equal(gb.name, 'pTEST');
});
check('a plain feature uses /label and 0-based start', function () {
  var f = gb.features.filter(function (x) { return x.name === 'AmpR fragment'; })[0];
  assert.deepEqual([f.start, f.end, f.strand, f.type], [10, 40, 1, 'CDS']);
  assert.equal(P.featureLen(f, 120), 30);
  assert.equal(P.featureSeq(gb, f), SEQ.slice(10, 40));
});
check('complement(...) reads as the reverse strand', function () {
  var f = gb.features.filter(function (x) { return x.name === 'lac promoter'; })[0];
  assert.deepEqual([f.start, f.end, f.strand], [50, 80, -1]);
  assert.equal(P.featureSeq(gb, f), P.revcomp(SEQ.slice(50, 80)));
});
check('a join across the origin becomes one wrapped feature', function () {
  var f = gb.features.filter(function (x) { return x.name === 'origin-spanning'; })[0];
  assert.deepEqual([f.start, f.end], [110, 10]);
  assert.ok(P.wraps(f));
  assert.equal(P.featureLen(f, 120), 20);
  assert.equal(P.featureSeq(gb, f), SEQ.slice(110) + SEQ.slice(0, 10));
  assert.match(f.note, /runs onto a second line/);   // the qualifier was joined up
});
check('a source feature over the whole plasmid is kept but not drawn', function () {
  assert.ok(gb.features.some(function (f) { return f.type === 'source'; }));
  assert.ok(!P.drawable(gb.features, 120).some(function (f) { return f.type === 'source'; }));
});
check('partial ends (< and >) are accepted', function () {
  var p = P.parseGenBank(genbank('pTEST', ['     CDS             <5..>25', '                     /label="partial"']));
  var f = p.features.filter(function (x) { return x.name === 'partial'; })[0];
  assert.deepEqual([f.start, f.end], [4, 25]);
});
check('a join that does not cross the origin keeps its outer span', function () {
  var loc = P.parseLocation('join(20..30,60..70)', 120);
  assert.deepEqual([loc.start, loc.end, loc.joined], [19, 70, true]);
});

console.log('GenBank round trip');
check('writing and reading back gives the same plasmid', function () {
  var again = P.parseGenBank(P.toGenBank(gb));
  assert.equal(again.seq, gb.seq);
  assert.equal(again.topology, 'circular');
  var want = gb.features.filter(function (f) { return f.type !== 'source'; });
  want.forEach(function (f) {
    var got = again.features.filter(function (x) { return x.name === f.name; })[0];
    assert.ok(got, 'lost feature ' + f.name);
    assert.deepEqual([got.start, got.end, got.strand], [f.start, f.end, f.strand], f.name);
  });
});

console.log('SnapGene');
function snap(blocks) {
  var parts = [];
  blocks.forEach(function (b) {
    var body = Buffer.isBuffer(b.data) ? b.data : Buffer.from(b.data, 'binary');
    var head = Buffer.alloc(5);
    head.writeUInt8(b.type, 0); head.writeUInt32BE(body.length, 1);
    parts.push(head, body);
  });
  return new Uint8Array(Buffer.concat(parts));
}
var featuresXml = '<?xml version="1.0"?><Features nextValidID="3">' +
  '<Feature recentID="0" name="AmpR" type="CDS" directionality="1">' +
    '<Segment range="11-40" color="#ccffcc" type="standard"/>' +
    '<Q name="label"><V text="AmpR"/></Q></Feature>' +
  '<Feature recentID="1" name="rev tag" type="promoter" directionality="2">' +
    '<Segment range="51-80" color="#ffd9b3" type="standard"/></Feature>' +
  '<Feature recentID="2" name="wrapped &amp; odd" type="misc_feature" directionality="1">' +
    '<Segment range="111-120" color="#d7d7d7" type="standard"/>' +
    '<Segment range="1-10" color="#d7d7d7" type="standard"/></Feature>' +
  '</Features>';
var dna = snap([
  { type: 9, data: 'SnapGene\x00\x01\x00\x0f\x00\x11' },
  { type: 0, data: String.fromCharCode(1) + SEQ },           // flag bit 0 = circular
  { type: 10, data: featuresXml },
  { type: 6, data: '<Notes><CustomMapLabel>pSnapTest</CustomMapLabel></Notes>' }
]);
var sg = P.parseSnapGene(dna);
check('sequence, name and circular flag', function () {
  assert.equal(sg.seq, SEQ);
  assert.equal(sg.topology, 'circular');
  assert.equal(sg.name, 'pSnapTest');
});
check('ranges are 1-based inclusive, direction 2 is reverse', function () {
  var a = sg.features.filter(function (f) { return f.name === 'AmpR'; })[0];
  assert.deepEqual([a.start, a.end, a.strand, a.color], [10, 40, 1, '#ccffcc']);
  var r = sg.features.filter(function (f) { return f.name === 'rev tag'; })[0];
  assert.equal(r.strand, -1);
});
check('two segments touching both ends become one wrapped feature', function () {
  var w = sg.features.filter(function (f) { return /wrapped/.test(f.name); })[0];
  assert.deepEqual([w.start, w.end], [110, 10]);
  assert.equal(w.name, 'wrapped & odd');                     // XML entity decoded
});
check('a file that is not SnapGene is refused', function () {
  assert.equal(P.parseSnapGene(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
});

console.log('Picking the format');
check('by extension and by content', function () {
  assert.equal(P.parseFile('x.dna', dna).format, 'SnapGene');
  assert.equal(P.parseFile('x.gb', genbank('pTEST')).format, 'GenBank');
  assert.equal(P.parseFile('x.txt', 'LOCUS  pX  120 bp\nORIGIN\n  1 ' + SEQ.toLowerCase() + '\n//').format, 'GenBank');
  assert.equal(P.parseFile('x.fasta', '>pFas description here\n' + SEQ).format, 'FASTA');
  assert.equal(P.parseFile('x.seq', '>pFas\n' + SEQ).plasmid.name, 'pFas');
  var raw = P.parseFile('pasted.txt', '  atgc atgc\n123 atgcatgcatgcatgc  ');
  assert.equal(raw.format, 'plain sequence');
  assert.equal(raw.plasmid.seq, 'ATGCATGCATGCATGCATGCATGC');   // digits and spaces dropped
  assert.equal(P.parseFile('x.gb', 'not a sequence at all').ok, false);
});

console.log('Sequence maths');
check('reverse complement, GC and translation', function () {
  assert.equal(P.revcomp('ATGCN'), 'NGCAT');
  assert.equal(P.revcomp(P.revcomp(SEQ)), SEQ);
  assert.equal(Math.round(P.gc('GGCCAATT')), 50);
  assert.equal(P.translate('ATGGCGTAA'), 'MA*');
  assert.equal(P.translate('ATGGC'), 'M');            // a trailing part-codon is ignored
  assert.equal(P.clean('atg-cat n'), 'ATGCATN');
});
check('melting temperature and mass', function () {
  assert.equal(P.tm('ATGCATGCAT'), 28);                 // short: 2(A+T) + 4(G+C) = 12 + 16
  assert.ok(Math.abs(P.tm('ATGCATGCATGCATGCATGC') - 51.8) < 0.2);   // 20-mer, 50% GC
  assert.ok(P.molWeight('ATGC', 'linear') > P.molWeight('ATGC', 'circular'));
});

console.log('Editing the sequence');
check('a change is described as one edit', function () {
  assert.deepEqual(P.diffEdit('AAACCCGGG', 'AAATTTCCCGGG'), { pos: 3, del: 0, ins: 'TTT' });
  assert.deepEqual(P.diffEdit('AAACCCGGG', 'AAAGGG'), { pos: 3, del: 3, ins: '' });
  assert.equal(P.diffEdit('AAA', 'AAA'), null);
});
check('features move with an insertion before them', function () {
  var r = P.applyEdit(gb, { pos: 0, del: 0, ins: 'TTTTT' });
  assert.equal(r.seq.length, 125);
  var f = r.features.filter(function (x) { return x.name === 'AmpR fragment'; })[0];
  assert.deepEqual([f.start, f.end], [15, 45]);
  assert.equal(r.dropped.length, 0);
});
check('a deletion inside a feature shortens it and says so', function () {
  var r = P.applyEdit(gb, { pos: 20, del: 10, ins: '' });
  var f = r.features.filter(function (x) { return x.name === 'AmpR fragment'; })[0];
  assert.deepEqual([f.start, f.end], [10, 30]);
  assert.ok(r.changed.indexOf('AmpR fragment') >= 0);
});
check('a feature whose bases all go is dropped, not left behind', function () {
  var r = P.applyEdit(gb, { pos: 10, del: 30, ins: '' });
  assert.ok(r.dropped.indexOf('AmpR fragment') >= 0);
  assert.ok(!r.features.some(function (f) { return f.name === 'AmpR fragment'; }));
});
check('a feature after the edit keeps its length', function () {
  var r = P.applyEdit(gb, { pos: 45, del: 0, ins: 'AAAA' });
  var f = r.features.filter(function (x) { return x.name === 'lac promoter'; })[0];
  assert.deepEqual([f.start, f.end], [54, 84]);
  assert.equal(r.changed.indexOf('lac promoter'), -1);
});

console.log('Maps');
function svgOk(svg, label) {
  assert.ok(svg.indexOf('<svg') === 0, label + ': starts with <svg');
  assert.ok(svg.indexOf('</svg>') > 0, label + ': is closed');
  assert.ok(!/NaN|undefined|Infinity/.test(svg), label + ': no broken numbers');
  var open = (svg.match(/<(?!\/)[a-z]/g) || []).length, close = (svg.match(/<\/[a-z]+>|\/>/g) || []).length;
  assert.equal(open, close, label + ': every tag closed');
}
check('linear map', function () {
  var svg = P.linearMapSvg(gb);
  svgOk(svg, 'linear');
  // 3 drawable features, and the wrapped one is drawn as two pieces
  assert.equal((svg.match(/class="pl-feat"/g) || []).length, 4);
  assert.ok(svg.indexOf('AmpR fragment') > 0);
});
check('circular map', function () {
  var svg = P.circularMapSvg(gb);
  svgOk(svg, 'circular');
  assert.equal((svg.match(/class="pl-feat"/g) || []).length, 3);  // arcs can cross the origin
  assert.ok(svg.indexOf('120 bp') > 0);
});
check('maps of awkward plasmids still come out clean', function () {
  svgOk(P.linearMapSvg({ name: 'bare', seq: 'ATGC'.repeat(50), topology: 'linear', features: [] }), 'no features');
  svgOk(P.circularMapSvg({ name: 'bare', seq: 'ATGC'.repeat(50), topology: 'circular', features: [] }), 'no features');
  var tiny = { name: 't', seq: SEQ, topology: 'circular',
    features: [P.normFeature({ name: 'one base', type: 'misc_feature', start: 5, end: 6, strand: 1 }, 120),
               P.normFeature({ name: 'whole', type: 'CDS', start: 0, end: 120, strand: 1 }, 120)] };
  assert.equal(P.featureLen(tiny.features[1], 120), 120);
  svgOk(P.linearMapSvg(tiny), 'tiny + whole');
  svgOk(P.circularMapSvg(tiny), 'tiny + whole');
});
check('crowded maps put features in separate rows', function () {
  var many = [];
  for (var i = 0; i < 12; i++) many.push(P.normFeature({ name: 'f' + i, type: 'CDS', start: i * 2, end: i * 2 + 30, strand: 1 }, 120));
  var packed = P.assignLanes(many, 120, 1);
  assert.ok(packed.lanes > 1);
  svgOk(P.linearMapSvg({ name: 'busy', seq: SEQ, topology: 'circular', features: many }), 'busy');
});

console.log('Restriction enzymes');
check('a palindromic site cuts where the enzyme says', function () {
  var seq = 'AAAA' + 'GAATTC' + 'TTTT';                 // EcoRI G^AATTC
  var h = P.findSites(seq, 'linear').filter(function (x) { return x.name === 'EcoRI'; });
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].start, h[0].end, h[0].cutTop, h[0].cutBottom, h[0].blunt], [4, 10, 5, 9, false]);
});
check('a blunt cutter reports the same cut on both strands', function () {
  var h = P.findSites('TTTT' + 'GATATC' + 'TTTT', 'linear').filter(function (x) { return x.name === 'EcoRV'; });
  assert.deepEqual([h[0].cutTop, h[0].cutBottom, h[0].blunt], [7, 7, true]);
});
check('a type IIS enzyme cuts outside its site, on the strand it reads from', function () {
  // BsaI GGTCTC(1/5): forward, the cut is downstream of the site
  var fwd = P.findSites('AAAAA' + 'GGTCTC' + 'ACGTACGTAA', 'linear').filter(function (x) { return x.name === 'BsaI'; })[0];
  assert.equal(fwd.strand, 1);
  assert.deepEqual([fwd.cutTop, fwd.cutBottom], [12, 16]);   // 5 + 7 and 5 + 11
  // the same site written backwards is found on the other strand, cutting the other way
  var rev = P.findSites('AAAAAAAAAA' + 'GAGACC' + 'AAAAA', 'linear').filter(function (x) { return x.name === 'BsaI'; })[0];
  assert.equal(rev.strand, -1);
  assert.deepEqual([rev.cutTop, rev.cutBottom], [9, 5]);     // 16 - 7 and 16 - 11
});
check('ambiguous letters in a site match any of their bases', function () {
  var hits = P.findSites('GGTCACC', 'linear').filter(function (x) { return x.name === 'BstEII'; });  // GGTNACC
  assert.equal(hits.length, 1);
  assert.equal(P.findSites('GGTGACC', 'linear').filter(function (x) { return x.name === 'BstEII'; }).length, 1);
  assert.equal(P.findSites('GGTTTCC', 'linear').filter(function (x) { return x.name === 'BstEII'; }).length, 0);
});
check('a site crossing the origin is found on a circular plasmid only', function () {
  var seq = 'ATTC' + 'A'.repeat(40) + 'GA';               // GA|ATTC straddles the origin
  var circ = P.findSites(seq, 'circular').filter(function (x) { return x.name === 'EcoRI'; });
  assert.equal(circ.length, 1);
  assert.equal(circ[0].start, 44);
  assert.equal(circ[0].cutTop, 45);                        // one base into the site, which wraps
  assert.equal(P.findSites(seq, 'linear').filter(function (x) { return x.name === 'EcoRI'; }).length, 0);
});
check('counting and filtering by how often an enzyme cuts', function () {
  var seq = 'GAATTC' + 'A'.repeat(20) + 'GAATTC' + 'A'.repeat(20) + 'GGATCC';
  var all = P.findSites(seq, 'linear');
  var counts = P.siteCounts(all);
  assert.equal(counts.EcoRI, 2);
  assert.equal(counts.BamHI, 1);
  var unique = P.filterSites(all, 'unique').map(function (h) { return h.name; });
  assert.ok(unique.indexOf('BamHI') >= 0);
  assert.equal(unique.indexOf('EcoRI'), -1);              // two sites, so not unique
  assert.equal(P.filterSites(all, 'two').filter(function (h) { return h.name === 'EcoRI'; }).length, 2);
  assert.ok(P.nonCutters(all).indexOf('XhoI') >= 0);      // no CTCGAG anywhere
  assert.equal(P.nonCutters(all).indexOf('BamHI'), -1);
});
check('overlapping copies of a site are all found', function () {
  var hits = P.findSites('AAAAAAAAAA', 'linear');          // no site
  assert.equal(hits.length, 0);
  var dra = P.findSites('TTTAAATTTAAA', 'linear').filter(function (x) { return x.name === 'DraI'; });
  assert.equal(dra.length, 2);
});

console.log('Reading frames and ORFs');
check('amino acids line up under the middle base of their codon', function () {
  assert.equal(P.frameString('ATGGCGTAATAA', 0, 0, 12, 1), ' M  A  *  * ');
  assert.equal(P.frameString('AATGGCGTAA', 1, 0, 10, 1), '  M  A  *  '.slice(0, 10));
});
check('the reverse strand reads the other way', function () {
  // revcomp('TTACGCCAT') is 'ATGGCGTAA', so the reverse frame spells M A *
  var row = P.frameString('TTACGCCAT', 0, 0, 9, -1);
  assert.equal(row.replace(/ /g, ''), '*AM');       // written along the forward strand
});
check('ORFs are found on both strands and short ones left out', function () {
  var orf = 'ATG' + 'GCG'.repeat(60) + 'TAA';
  var seq = 'TTTT' + orf + 'TTTT';
  var found = P.orfs(seq, 'linear', 50);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].start, found[0].end, found[0].strand, found[0].len], [4, 4 + orf.length, 1, 61]);
  assert.equal(found[0].aa.slice(0, 3), 'MAA');
  assert.equal(P.orfs(seq, 'linear', 200).length, 0);          // too short to count
  var rev = 'TTTT' + P.revcomp(orf) + 'TTTT';
  var back = P.orfs(rev, 'linear', 50);
  assert.equal(back[0].strand, -1);
  assert.deepEqual([back[0].start, back[0].end], [4, 4 + orf.length]);
});

console.log('CRISPR guides');
var SPACER = 'ACGTTGCAACGTTGCAAGGT';   // deliberately not its own reverse complement
var GSEQ = 'TTTTT' + SPACER + 'AGG' + 'CCCCCCCCCC';
check('a guide is found next to its PAM, with the cut 3 bases in', function () {
  var g = P.findGuides(GSEQ, 'linear', 'SpCas9 (NGG)').filter(function (x) { return x.spacer === SPACER; })[0];
  assert.ok(g, 'guide found');
  assert.deepEqual([g.start, g.end, g.strand, g.pam], [5, 25, 1, 'AGG']);
  assert.equal(g.cutAt, 22);                                    // 3 bases back from the PAM
  assert.ok(g.gc > 40 && g.gc < 60);
  assert.equal(g.offTargets, 0);
});
check('guides are found on the reverse strand too', function () {
  var seq = 'CCCCC' + 'CCT' + P.revcomp(SPACER) + 'TTTTT';      // CCT is AGG read back
  var g = P.findGuides(seq, 'linear', 'SpCas9 (NGG)').filter(function (x) { return x.spacer === SPACER; })[0];
  assert.ok(g, 'reverse guide found');
  assert.equal(g.strand, -1);
  assert.deepEqual([g.start, g.end], [8, 28]);
});
check('a protospacer repeated in the plasmid is counted', function () {
  var twice = GSEQ + 'AAAAA' + SPACER + 'TGG';
  var g = P.findGuides(twice, 'linear', 'SpCas9 (NGG)').filter(function (x) { return x.spacer === SPACER; })[0];
  assert.equal(g.offTargets, 1);
});
check('a protospacer that reads the same backwards is not counted twice', function () {
  var pal = 'ACGTACGTACGTACGTACGT';
  assert.equal(P.revcomp(pal), pal);
  var g = P.findGuides('TTTTT' + pal + 'AGG' + 'CCCCC', 'linear', 'SpCas9 (NGG)')
    .filter(function (x) { return x.spacer === pal; })[0];
  assert.equal(g.offTargets, 0);
});
check('other PAMs are offered', function () {
  assert.ok(Object.keys(P.PAM_TYPES).length >= 4);
  assert.equal(P.PAM_TYPES['Cas12a / Cpf1 (TTTV)'].side, 5);
});

console.log('pegRNA');
check('the 3′ extension is the RT template then the primer binding site', function () {
  var g = P.findGuides(GSEQ, 'linear', 'SpCas9 (NGG)').filter(function (x) { return x.spacer === SPACER; })[0];
  var peg = P.designPegRNA(GSEQ, 'linear', g, { at: 22, del: 0, ins: 'GGG' }, { pbs: 13, rtt: 13 });
  // PBS pairs with the 13 bases just before the nick at 22
  assert.equal(peg.pbs, P.revcomp(GSEQ.slice(9, 22)));

  // the template carries the inserted GGG followed by what comes after the nick
  assert.equal(peg.rtt, P.revcomp(('GGG' + GSEQ.slice(22)).slice(0, 13)));

  assert.equal(peg.extension, peg.rtt + peg.pbs);
  assert.equal(peg.spacer, SPACER);
});
check('an edit upstream of the nick is refused rather than designed wrongly', function () {
  var g = P.findGuides(GSEQ, 'linear', 'SpCas9 (NGG)').filter(function (x) { return x.spacer === SPACER; })[0];
  var peg = P.designPegRNA(GSEQ, 'linear', g, { at: 8, del: 0, ins: 'A' }, {});
  assert.ok(peg.error, 'refused with a reason');
});

console.log('Annotation');
var FLAG = 'GACTACAAAGACGATGACGACAAG', LOXP = 'ATAACTTCGTATAATGTATGCTATACGAAGTTAT';
check('library sequences are found on both strands', function () {
  var seq = 'AAAA' + FLAG + 'TTTT' + P.revcomp(LOXP) + 'CCCC';
  var hits = P.annotate({ seq: seq, topology: 'linear', features: [] }, P.BUILTIN_FEATURES);
  var flag = hits.filter(function (h) { return h.name === 'FLAG tag'; })[0];
  assert.deepEqual([flag.start, flag.end, flag.strand, flag.how], [4, 28, 1, 'sequence']);
  var lox = hits.filter(function (h) { return h.name === 'loxP'; })[0];
  assert.equal(lox.strand, -1);
});
check('a tag with different codons is still found, through its protein', function () {
  // the same peptide DYKDDDDK, written with other codons
  var alt = 'GATTATAAGGATGACGATGATAAA';
  assert.equal(P.translate(alt), 'DYKDDDDK');
  assert.notEqual(alt, FLAG);
  var seq = 'AA' + alt + 'TTTTTT';
  var hits = P.annotate({ seq: seq, topology: 'linear', features: [] }, P.BUILTIN_FEATURES);
  var flag = hits.filter(function (h) { return h.name === 'FLAG tag'; })[0];
  assert.ok(flag, 'found by protein');
  assert.equal(flag.how, 'protein');
  assert.deepEqual([flag.start, flag.end], [2, 26]);
});
check('what is already annotated is not offered again', function () {
  var seq = 'AAAA' + FLAG + 'TTTT';
  var p = { seq: seq, topology: 'linear', features: [P.normFeature({ name: 'FLAG tag', type: 'tag', start: 4, end: 28, strand: 1 }, seq.length)] };
  var hits = P.annotate(p, P.BUILTIN_FEATURES);
  assert.equal(hits.filter(function (h) { return h.start === 4 && h.end === 28 && h.strand === 1; }).length, 0);
});
check('the lab library is built from the other plasmids', function () {
  var other = { id: 'p1', name: 'pDonor', seq: 'GGGG' + FLAG + 'AAAA',
    features: [{ name: 'my cassette', type: 'CDS', start: 4, end: 28, strand: 1 }] };
  var lib = P.labLibrary([other, { id: 'skip', seq: 'ACGT', features: [] }], 'skip');
  assert.equal(lib.length, 1);
  assert.equal(lib[0].name, 'my cassette');
  assert.equal(lib[0].dna, FLAG);
  assert.equal(lib[0].from, 'pDonor');
  // and a new plasmid carrying it is annotated from that library
  var hits = P.annotate({ seq: 'TT' + FLAG + 'TT', topology: 'linear', features: [] }, lib);
  assert.equal(hits[0].name, 'my cassette');
  assert.deepEqual([hits[0].start, hits[0].end], [2, 26]);
  // a plasmid does not teach itself
  assert.equal(P.labLibrary([other], 'p1').length, 0);
});
check('very short entries are ignored, so the map is not swamped', function () {
  var hits = P.annotate({ seq: 'AATAAA'.repeat(3), topology: 'linear', features: [] },
    [{ name: 'tiny', type: 'misc_feature', dna: 'AAT' }], { minLen: 8 });
  assert.equal(hits.length, 0);
});

console.log('CSV');
check('features export with headers and sequences', function () {
  var csv = P.featuresCsv(gb);
  var lines = csv.split('\r\n');
  assert.equal(lines.length, gb.features.length + 1);
  assert.ok(lines[0].indexOf('"Name","Type","Start","End"') === 0);
  assert.ok(csv.indexOf('"AmpR fragment"') > 0);
  assert.ok(P.csvCell('=cmd').indexOf("'=") === 1);          // Excel formula guard
});

console.log('\n' + pass + ' checks passed');
