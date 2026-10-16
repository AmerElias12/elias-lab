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
  // Bytes that parse as a run of empty blocks used to read one byte past the
  // end and throw RangeError, so a truncated or mis-named .dna file crashed
  // the import instead of being refused. Refusing is the whole contract:
  // parseFile tests the return value and never catches.
  assert.equal(P.parseSnapGene(new Uint8Array(40).buffer), null);
  assert.equal(P.parseSnapGene(new Uint8Array(40)), null);
  var r = P.parseFile('fake.dna', new Uint8Array(40).buffer);
  assert.equal(r.ok, false);
  assert.match(r.error, /SnapGene/);
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
check('the clipboard forms: DNA, RNA and protein, either strand', function () {
  // ATG GCG TAA on the forward strand; the other strand reads TTA CGC CAT,
  // which is Leu-Arg-His and not the same protein backwards.
  var orf = 'ATGGCGTAA';
  assert.equal(P.copyForm(orf, 'dna').text, orf);
  assert.equal(P.copyForm(orf, 'dna-rc').text, 'TTACGCCAT');
  assert.equal(P.copyForm(orf, 'rna').text, 'AUGGCGUAA');
  assert.equal(P.copyForm(orf, 'rna-rc').text, 'UUACGCCAU');
  assert.equal(P.copyForm(orf, 'aa').text, 'MA*');
  assert.equal(P.copyForm(orf, 'aa-rc').text, 'LRH');
  // The reverse complement is taken first and then read, which is the only
  // order that gives the protein the other strand actually encodes.
  assert.equal(P.copyForm(orf, 'aa-rc').text, P.translate(P.revcomp(orf)));
  assert.notEqual(P.copyForm(orf, 'aa-rc').text,
    P.copyForm(orf, 'aa').text.split('').reverse().join(''));
});
check('a copy says what it produced, and what it had to leave out', function () {
  var dna = P.copyForm('ATGGC', 'dna');
  assert.equal(dna.unit, 'bp');
  assert.equal(dna.remainder, 0, 'bases are never left over when copying bases');
  // 5 bases is one codon and two bases over: the two are dropped, and saying
  // so is what tells somebody their selection is off by a base.
  var aa = P.copyForm('ATGGC', 'aa');
  assert.equal(aa.text, 'M');
  assert.equal(aa.unit, 'aa');
  assert.equal(aa.remainder, 2);
  assert.equal(P.copyForm('ATGGCG', 'aa').remainder, 0);
  assert.equal(P.copyForm('ATGGC', 'rna').unit, 'nt');
  // An unknown kind copies the bases rather than nothing at all.
  assert.equal(P.copyForm('ATGGCGTAA', 'nonsense').text, 'ATGGCGTAA');
  assert.equal(P.copyForm('ATGGCGTAA').text, 'ATGGCGTAA');
});
check('transcription only rewrites T, on whichever strand it is given', function () {
  assert.equal(P.toRna('ATGCATGC'), 'AUGCAUGC');
  assert.equal(P.toRna('atg cat'), 'AUGCAU');            // cleaned first
  assert.equal(P.toRna(SEQ).indexOf('T'), -1);
  assert.equal(P.toRna(SEQ).length, SEQ.length);
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

console.log('Cutting');
function rot(a, b) {   // is a a rotation of b?
  return a.length === b.length && (b + b).indexOf(a) >= 0;
}
var VEC = 'AAAAA' + 'GAATTC' + 'TTTTTTTTTT' + 'GGATCC' + 'CCCCCCCCCC';
check('a circular plasmid gives one piece per cut', function () {
  var d = P.digest({ seq: VEC, topology: 'circular', features: [] }, ['EcoRI', 'BamHI']);
  assert.equal(d.fragments.length, 2);
  assert.equal(d.fragments[0].left.enzyme, 'EcoRI');
  assert.equal(d.fragments[0].left.type, "5'");
  assert.equal(d.fragments[0].left.ohang, 'AATT');
  assert.equal(d.fragments[0].right.ohang, 'GATC');
  assert.equal(d.fragments[0].len + d.fragments[1].len, VEC.length);
});
check('a linear plasmid gives one more piece than cuts, with plain ends', function () {
  var d = P.digest({ seq: VEC, topology: 'linear', features: [] }, ['EcoRI', 'BamHI']);
  assert.equal(d.fragments.length, 3);
  assert.equal(d.fragments[0].left.type, 'end');
  assert.equal(d.fragments[2].right.type, 'end');
  assert.equal(d.fragments.map(function (f) { return f.seq; }).join(''), VEC);
});
check('3′ overhangs and blunt cuts are told apart', function () {
  var k = P.digest({ seq: 'AAAAA' + 'GGTACC' + 'TTTTT' + 'GGTACC' + 'AAAAA', topology: 'circular', features: [] }, ['KpnI']);
  assert.equal(k.fragments[0].left.type, "3'");
  assert.equal(k.fragments[0].left.ohang, 'GTAC');
  var b = P.digest({ seq: 'AAAAA' + 'GATATC' + 'TTTTT' + 'GATATC' + 'AAAAA', topology: 'circular', features: [] }, ['EcoRV']);
  assert.equal(b.fragments[0].left.type, 'blunt');
  assert.equal(b.fragments[0].left.ohang, '');
});
check('putting the pieces back gives the plasmid again', function () {
  var d = P.digest({ seq: VEC, topology: 'circular', features: [] }, ['EcoRI', 'BamHI']);
  var back = P.ligate(d.fragments.map(function (f) { return { frag: f, flip: false }; }), true);
  assert.ok(back.ok);
  assert.ok(rot(back.seq, VEC), 'the product is the original, read from the first cut');
});

console.log('Joining');
var INS = 'TTTTT' + 'GAATTC' + 'GGGGGGGGGGGGGGG' + 'GGATCC' + 'TTTTT';
check('an insert cut with the same two enzymes drops into the vector', function () {
  var v = P.digest({ seq: VEC, topology: 'circular', features: [] }, ['EcoRI', 'BamHI']);
  var ins = P.digest({ seq: INS, topology: 'linear', features: [] }, ['EcoRI', 'BamHI']);
  var backbone = v.fragments.filter(function (f) { return f.left.enzyme === 'BamHI'; })[0];
  var piece = ins.fragments.filter(function (f) { return f.left.enzyme === 'EcoRI' && f.right.enzyme === 'BamHI'; })[0];
  assert.ok(backbone && piece);
  var out = P.ligate([{ frag: backbone, flip: false }, { frag: piece, flip: false }], true);
  assert.ok(out.ok, out.error);
  assert.equal(out.seq.length, backbone.len + piece.len);
  assert.equal(out.topology, 'circular');
  assert.equal(out.junctions.length, 1);
});
check('an insert the wrong way round is refused, and works when flipped', function () {
  var v = P.digest({ seq: VEC, topology: 'circular', features: [] }, ['EcoRI', 'BamHI']);
  var ins = P.digest({ seq: INS, topology: 'linear', features: [] }, ['EcoRI', 'BamHI']);
  var backbone = v.fragments.filter(function (f) { return f.left.enzyme === 'BamHI'; })[0];
  var piece = ins.fragments.filter(function (f) { return f.left.enzyme === 'EcoRI' && f.right.enzyme === 'BamHI'; })[0];
  // backbone runs BamHI -> EcoRI, so the piece has to run EcoRI -> BamHI
  var wrong = P.ligate([{ frag: backbone, flip: false }, { frag: piece, flip: true }], true);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /cannot be joined|cannot close/);
});
check('ends from different enzymes join when the overhang reads the same', function () {
  // BamHI G^GATCC and BglII A^GATCT both leave GATC
  var a = P.digest({ seq: 'AAAAA' + 'GGATCC' + 'TTTTTTTTTT' + 'GGATCC' + 'AAAAA', topology: 'circular', features: [] }, ['BamHI']);
  var b = P.digest({ seq: 'CCCCC' + 'AGATCT' + 'GGGGGGGGGG' + 'AGATCT' + 'CCCCC', topology: 'circular', features: [] }, ['BglII']);
  assert.equal(a.fragments[0].right.ohang, 'GATC');
  assert.equal(b.fragments[0].left.ohang, 'GATC');
  assert.ok(P.endsMatch(a.fragments[0].right, b.fragments[0].left));
  var out = P.ligate([{ frag: a.fragments[0], flip: false }, { frag: b.fragments[0], flip: false }], true);
  assert.ok(out.ok, out.error);
});
check('mismatched overhangs are refused with a reason', function () {
  var e = P.digest({ seq: VEC, topology: 'circular', features: [] }, ['EcoRI', 'BamHI']).fragments[0];
  var k = P.digest({ seq: 'AAAAA' + 'GGTACC' + 'TTTTT' + 'GGTACC' + 'AAAAA', topology: 'circular', features: [] }, ['KpnI']).fragments[0];
  var out = P.ligate([{ frag: e, flip: false }, { frag: k, flip: false }], false);
  assert.equal(out.ok, false);
  assert.match(out.error, /overhang/);
});
check('three pieces go together in order with three enzymes', function () {
  // vector EcoRI..HindIII, insert A EcoRI..BamHI, insert B BamHI..HindIII
  var vec = 'AAAAA' + 'GAATTC' + 'AAAAAAAAAAAAAAA' + 'AAGCTT' + 'AAAAA';
  var insA = 'TTTTT' + 'GAATTC' + 'GGGGGGGGGG' + 'GGATCC' + 'TTTTT';
  var insB = 'CCCCC' + 'GGATCC' + 'TTTTTTTTTT' + 'AAGCTT' + 'CCCCC';
  var v = P.digest({ seq: vec, topology: 'circular', features: [] }, ['EcoRI', 'HindIII']);
  var a = P.digest({ seq: insA, topology: 'linear', features: [] }, ['EcoRI', 'BamHI']);
  var b = P.digest({ seq: insB, topology: 'linear', features: [] }, ['BamHI', 'HindIII']);
  var backbone = v.fragments.filter(function (f) { return f.left.enzyme === 'HindIII'; })[0];
  var pa = a.fragments.filter(function (f) { return f.left.enzyme === 'EcoRI' && f.right.enzyme === 'BamHI'; })[0];
  var pb = b.fragments.filter(function (f) { return f.left.enzyme === 'BamHI' && f.right.enzyme === 'HindIII'; })[0];
  assert.ok(backbone && pa && pb);
  var out = P.ligate([{ frag: backbone, flip: false }, { frag: pa, flip: false }, { frag: pb, flip: false }], true);
  assert.ok(out.ok, out.error);
  assert.equal(out.junctions.length, 2);
  assert.equal(out.seq.length, backbone.len + pa.len + pb.len);
});
check('features ride along and are renumbered', function () {
  var seq = VEC;
  var p = { seq: seq, topology: 'circular',
    features: [P.normFeature({ name: 'spacer', type: 'misc_feature', start: 12, end: 22, strand: 1 }, seq.length)] };
  var d = P.digest(p, ['EcoRI', 'BamHI']);
  var holder = d.fragments.filter(function (f) { return f.features.length; })[0];
  assert.ok(holder, 'a piece carries it');
  assert.equal(holder.features[0].name, 'spacer');
  assert.equal(holder.features[0].start, 12 - holder.start);
  // flipping turns the feature round too
  var flipped = P.flipFragment(holder);
  assert.equal(flipped.features[0].strand, -1);
  assert.equal(flipped.features[0].end, holder.len - holder.features[0].start);
});
check('a feature cut through is marked as shortened', function () {
  var seq = VEC;
  var p = { seq: seq, topology: 'circular',
    features: [P.normFeature({ name: 'across the cut', type: 'CDS', start: 2, end: 14, strand: 1 }, seq.length)] };
  var d = P.digest(p, ['EcoRI', 'BamHI']);
  var marked = [];
  d.fragments.forEach(function (f) { f.features.forEach(function (g) { if (/Shortened/.test(g.note || '')) marked.push(g); }); });
  assert.ok(marked.length >= 1, 'the shortened piece says so');
});
check('a gene cut in two survives on both pieces, not just the later one', function () {
  // VEC is 37 bp and EcoRI cuts at 6. This CDS runs 2..14, so the cut falls
  // inside it: 4 bases sit on one piece and 8 on the other. Reading only the
  // interval that starts inside the window used to drop the 8-base part, and
  // a gene that vanishes from a piece is worse than one shown truncated —
  // nothing on screen says it was ever there.
  var p = { seq: VEC, topology: 'circular',
    features: [P.normFeature({ name: 'across the cut', type: 'CDS', start: 2, end: 14, strand: 1 }, VEC.length)] };
  var d = P.digest(p, ['EcoRI', 'BamHI']);
  var seen = d.fragments.map(function (f) {
    return f.features.filter(function (g) { return g.name === 'across the cut'; })
      .map(function (g) { return g.end - g.start; });
  });
  var lengths = [].concat.apply([], seen).sort(function (a, b) { return a - b; });
  assert.deepEqual(lengths, [4, 8], 'both halves of the gene are carried');
  assert.equal(lengths[0] + lengths[1], 12, 'and together they are the whole gene');
  d.fragments.forEach(function (f) {
    f.features.forEach(function (g) {
      assert.ok(g.start >= 0 && g.end <= f.len, 'a carried feature stays inside its piece');
    });
  });
});

check('a PCR product with sites on its primer tails clones into a cut vector', function () {
  /* The case the cloning dialog added: the template carries no useful site,
     so the sites arrive on the 5' tails of the primers. The product is linear
     with a site at each end, and once cut it is an ordinary sticky-ended
     fragment. This is the whole path — amplify, digest, ligate — because the
     parts being right individually is not the claim worth testing. */
  var F = 'ACGTTGCAAGCTACCATTGA', R = 'TTCAGGCATTACGCGATTCA';
  var tpl = { seq: 'TTTTT' + F + 'ACACACACACACACACACAC' + R + 'AAAAA', topology: 'circular', features: [] };
  assert.equal(tpl.seq.indexOf('GAATTC'), -1, 'the template has no EcoRI site of its own');
  assert.equal(tpl.seq.indexOf('GGATCC'), -1, 'nor a BamHI one');

  // Two extra bases outside each site, as you would order them: an enzyme
  // needs something to hold on to beyond its recognition sequence.
  var prod = P.pcrProduct(tpl, P.bindPrimers(tpl, 'AAGAATTC' + F)[0],
    P.bindPrimers(tpl, 'AAGGATCC' + P.revcomp(R))[0]);
  assert.ok(!prod.error, prod.error);

  var cutProduct = P.digest({ seq: prod.seq, topology: 'linear', features: prod.features },
    ['EcoRI', 'BamHI']);
  var insert = cutProduct.fragments.filter(function (f) {
    return f.left.enzyme === 'EcoRI' && f.right.enzyme === 'BamHI';
  })[0];
  assert.ok(insert, 'the middle piece has a sticky end from each enzyme');
  assert.equal(insert.left.ohang, 'AATT');
  assert.equal(insert.right.ohang, 'GATC');
  // The ends of the product are the two short offcuts, which is what tells
  // you the sites really were at the ends rather than somewhere inside.
  assert.equal(cutProduct.fragments.length, 3);

  var backbone = P.digest({ seq: VEC, topology: 'circular', features: [] }, ['EcoRI', 'BamHI'])
    .fragments.filter(function (f) { return f.left.enzyme === 'BamHI' && f.right.enzyme === 'EcoRI'; })[0];
  assert.ok(backbone, 'the vector opens with one end from each enzyme');

  var joined = P.ligate([{ frag: backbone, flip: false }, { frag: insert, flip: false }], true);
  assert.ok(joined.ok, joined.error);
  assert.equal(joined.seq.length, backbone.len + insert.len);
  assert.equal(joined.topology, 'circular');
  // The site each primer added survives the join, which is what makes the
  // insert cuttable back out again. One of the two lands across the origin of
  // the new circle, so it is only there to be found when the sequence is read
  // round — which is exactly how the plasmid will be read from now on.
  assert.ok(joined.seq.indexOf('GAATTC') >= 0, 'the EcoRI join rebuilt its site');
  assert.equal(joined.seq.indexOf('GGATCC'), -1, 'the BamHI join fell across the origin');
  assert.ok((joined.seq + joined.seq).indexOf('GGATCC') >= 0, 'and reading round finds it');
  // Which the digest agrees with, since it is the thing that reads round.
  var recut = P.digest({ seq: joined.seq, topology: 'circular', features: [] }, ['EcoRI', 'BamHI']);
  assert.equal(recut.fragments.length, 2, 'the construct cuts back into vector and insert');
});
check('a PCR product keeps its tail annotation through the digest', function () {
  var F = 'ACGTTGCAAGCTACCATTGA', R = 'TTCAGGCATTACGCGATTCA';
  var tpl = { seq: 'TTTTT' + F + 'ACACACACACACACACACAC' + R + 'AAAAA', topology: 'circular',
    features: [P.normFeature({ name: 'payload', type: 'CDS', start: 25, end: 45, strand: 1 }, 70)] };
  var prod = P.pcrProduct(tpl, P.bindPrimers(tpl, 'AAGAATTC' + F)[0],
    P.bindPrimers(tpl, 'AAGGATCC' + P.revcomp(R))[0]);
  var insert = P.digest({ seq: prod.seq, topology: 'linear', features: prod.features }, ['EcoRI', 'BamHI'])
    .fragments.filter(function (f) { return f.left.enzyme === 'EcoRI' && f.right.enzyme === 'BamHI'; })[0];
  var names = insert.features.map(function (f) { return f.name; });
  assert.ok(names.indexOf('payload') >= 0, 'what was amplified is still labelled on the fragment');
  insert.features.forEach(function (f) {
    assert.ok(f.start >= 0 && f.end <= insert.len, f.name + ' stays inside the fragment');
  });
});

console.log('Choosing an enzyme');
check('every enzyme is reported with how often it cuts, including never', function () {
  var sum = P.enzymeSummary({ seq: VEC, topology: 'circular', features: [] });
  assert.equal(sum.length, P.ENZYMES.length);
  var eco = sum.filter(function (e) { return e.name === 'EcoRI'; })[0];
  assert.equal(eco.count, 1);
  assert.deepEqual(eco.cuts, [7]);                     // G^AATTC, site at base 6
  var none = sum.filter(function (e) { return e.count === 0; });
  assert.ok(none.length > 50, 'most enzymes do not cut this short sequence');
  assert.equal(sum[0].count, 0, 'the ones that never cut come first');
});

console.log('Primers');
var F20 = 'ATGCGTACGTTAGCCAGTTA', R20 = 'TTACGCATGCATCCGTAATC';
var TPL = 'AAAAA' + F20 + 'GGGGGGGGGGGGGGGGGGGG' + R20 + 'CCCCC';
var TP = { seq: TPL, topology: 'circular', features: [] };
check('a primer that matches all through binds with no tail', function () {
  var b = P.bindPrimers(TP, F20)[0];
  assert.deepEqual([b.start, b.end, b.strand], [5, 25, 1]);
  assert.equal(b.tail, '');
  assert.equal(b.anneal, F20);
  assert.equal(b.perfect, true);
});
check('a 5′ tail is reported separately from the annealed part', function () {
  var b = P.bindPrimers(TP, 'GGATCC' + F20)[0];
  assert.deepEqual([b.start, b.end], [5, 25]);
  assert.equal(b.tail, 'GGATCC');
  assert.equal(b.anneal, F20);
  assert.equal(b.perfect, false);
  assert.ok(Math.abs(b.tm - P.tm(F20)) < 0.01, 'the melting temperature is of the annealed part only');
});
check('a reverse primer binds the other way round', function () {
  var b = P.bindPrimers(TP, P.revcomp(R20))[0];
  assert.equal(b.strand, -1);
  assert.deepEqual([b.start, b.end], [45, 65]);
});
check('a primer that does not match binds nowhere', function () {
  assert.equal(P.bindPrimers(TP, 'TTTTTTTTTTTTTTTTTTTT').length, 0);
  assert.equal(P.bindPrimers(TP, 'ACGT').length, 0, 'too short to judge');
});
check('a primer across the origin is found on a circular plasmid', function () {
  var seq = 'CGTTAGCCAGTTA' + 'A'.repeat(60) + 'ATGCGTA';   // F20 split over the origin
  var circ = P.bindPrimers({ seq: seq, topology: 'circular', features: [] }, F20);
  assert.equal(circ.length, 1);
  assert.equal(circ[0].start, 73);
  assert.equal(P.bindPrimers({ seq: seq, topology: 'linear', features: [] }, F20).length, 0);
});

console.log('PCR');
check('the product carries both primers whole, tails included', function () {
  var f = P.bindPrimers(TP, 'GGATCC' + F20)[0];
  var r = P.bindPrimers(TP, 'AAGCTT' + P.revcomp(R20))[0];
  var prod = P.pcrProduct(TP, f, r);
  assert.equal(prod.templateLen, 60);                       // 5 to 65
  assert.equal(prod.tails, 12);
  assert.equal(prod.len, 72);
  assert.ok(prod.seq.indexOf('GGATCC') === 0, 'starts with the forward tail');
  assert.ok(prod.seq.slice(-6) === P.revcomp('AAGCTT'), 'ends with the reverse tail');
  assert.equal(prod.seq.slice(6, 26), F20);
});
check('the product is annotated: the template\'s features, and the added tails', function () {
  // TPL is 70 bp; the forward primer anneals at 5 and the reverse ends at 65,
  // so the body is 5..65 and everything shifts right by the 6-base tail.
  var annotated = { seq: TPL, topology: 'circular', features: [
    P.normFeature({ name: 'inside', type: 'CDS', start: 10, end: 30, strand: 1 }, TPL.length),
    P.normFeature({ name: 'straddles the primer', type: 'CDS', start: 0, end: 10, strand: 1 }, TPL.length),
    P.normFeature({ name: 'outside', type: 'CDS', start: 66, end: 70, strand: 1 }, TPL.length)
  ] };
  var f = P.bindPrimers(annotated, 'GGATCC' + F20)[0];
  var r = P.bindPrimers(annotated, 'AAGCTT' + P.revcomp(R20))[0];
  var prod = P.pcrProduct(annotated, f, r);
  var by = {};
  prod.features.forEach(function (g) { by[g.name] = g; });

  assert.deepEqual([by.inside.start, by.inside.end], [11, 31], 'shifted by the tail, not by the primer');
  assert.equal(prod.seq.slice(by.inside.start, by.inside.end), TPL.slice(10, 30),
    'and the bases under the feature are the ones it annotated');

  // Only 5..10 of it is amplified, so it comes back shortened rather than gone.
  assert.deepEqual([by['straddles the primer'].start, by['straddles the primer'].end], [6, 11]);
  assert.match(by['straddles the primer'].note, /partly inside the product/);

  assert.ok(!by.outside, 'a feature the primers did not reach is not on the product');

  var fwdTail = by["5' tail, forward primer"], revTail = by["5' tail, reverse primer"];
  assert.deepEqual([fwdTail.start, fwdTail.end], [0, 6]);
  assert.deepEqual([revTail.start, revTail.end], [66, 72]);
  assert.equal(prod.seq.slice(fwdTail.start, fwdTail.end), 'GGATCC', 'the site the primer added');
  assert.equal(revTail.strand, -1, 'the reverse tail is annotated on the strand it came in on');
});
check('a template with no features gives a product with just its tails', function () {
  var f = P.bindPrimers(TP, 'GGATCC' + F20)[0];
  var r = P.bindPrimers(TP, P.revcomp(R20))[0];              // no tail on the reverse
  var prod = P.pcrProduct(TP, f, r);
  assert.equal(prod.features.length, 1, 'only the forward tail is marked');
  assert.equal(prod.features[0].name, "5' tail, forward primer");
});
check('two primers facing the wrong way make nothing', function () {
  var f = P.bindPrimers(TP, F20)[0];
  assert.ok(P.pcrProduct(TP, f, f).error, 'both forward is refused');
});
check('a product may run across the origin on a circular plasmid', function () {
  var seq = R20 + 'TTTTTTTTTTTTTTTTTTTT' + F20;            // forward primer after the reverse one
  var p = { seq: seq, topology: 'circular', features: [] };
  var f = P.bindPrimers(p, F20)[0], r = P.bindPrimers(p, P.revcomp(R20))[0];
  var prod = P.pcrProduct(p, f, r);
  assert.ok(!prod.error, prod.error);
  assert.equal(prod.wraps, true);
  assert.equal(prod.len, 40);                                // 20 + 20, round the origin
  assert.equal(P.pcrProduct({ seq: seq, topology: 'linear', features: [] }, f, r).error !== undefined, true);
});
check('the picture draws both primers and its tails, and stays well formed', function () {
  var f = P.bindPrimers(TP, 'GGATCC' + F20)[0];
  var r = P.bindPrimers(TP, 'AAGCTT' + P.revcomp(R20))[0];
  var svg = P.pcrMapSvg(TP, f, r);
  assert.ok(svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') > 0);
  assert.ok(!/NaN|undefined|Infinity/.test(svg), 'no broken numbers');
  assert.equal((svg.match(/class="pcr-primer/g) || []).length, 2);
  assert.equal((svg.match(/class="pcr-tail"/g) || []).length, 2, 'a tail drawn clear of the template for each');
  assert.ok(svg.indexOf('72 bp product') > 0);
});

console.log('Gibson');
function gfrag(name, n, seed) {
  var s = '', x = seed;
  for (var i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += 'ACGT'[x % 4]; }
  return { name: name, seq: s, features: [] };
}
check('each piece gets a pair of primers and the junctions are covered', function () {
  var parts = [gfrag('vector', 600, 1), gfrag('insert 1', 400, 2)];
  var g = P.designGibson(parts, { overlap: 25 });
  assert.ok(!g.error, g.error);
  assert.equal(g.primers.length, 4);
  assert.equal(g.pieces, 2);
  // the forward primer of each piece starts with the end of the piece before it
  var vecF = g.primers.filter(function (x) { return x.fragment === 'vector' && x.dir === 'forward'; })[0];
  assert.equal(vecF.tail, parts[1].seq.slice(-25), 'the vector follows the last insert, as a circle');
  var insF = g.primers.filter(function (x) { return x.fragment === 'insert 1' && x.dir === 'forward'; })[0];
  assert.equal(insF.tail, parts[0].seq.slice(-25));
  assert.equal(insF.seq, insF.tail + insF.anneal);
  assert.ok(insF.anneal.length >= 18 && insF.anneal.length <= 35);
  // reverse primers carry no tail: the next piece's forward primer makes that join
  assert.equal(vecF.tail.length, 25);
  assert.equal(g.primers.filter(function (x) { return x.dir === 'reverse'; }).every(function (x) { return x.tail === ''; }), true);
});
check('the assembled product is the pieces end to end, with their features', function () {
  var parts = [gfrag('vector', 600, 1), gfrag('insert 1', 400, 2), gfrag('insert 2', 300, 3)];
  parts[1].features = [{ name: 'gene', type: 'CDS', start: 10, end: 310, strand: 1 }];
  var g = P.designGibson(parts, { overlap: 20 });
  assert.equal(g.product.seq.length, 1300);
  assert.equal(g.product.topology, 'circular');
  assert.equal(g.junctions.length, 3);                       // three joins round a circle
  var gene = g.product.features[0];
  assert.deepEqual([gene.start, gene.end], [610, 910]);       // shifted past the vector
});
check('up to seven inserts work, and more is refused', function () {
  var many = [gfrag('vector', 500, 9)];
  for (var i = 1; i <= 7; i++) many.push(gfrag('insert ' + i, 300, i * 7));
  var g = P.designGibson(many, { overlap: 30 });
  assert.ok(!g.error, g.error);
  assert.equal(g.primers.length, 16);
  assert.equal(g.junctions.length, 8);
  many.push(gfrag('insert 8', 300, 77));
  assert.ok(P.designGibson(many, {}).error, 'nine pieces is refused');
});
check('pieces too short for the overlap, or too few, are refused with a reason', function () {
  assert.match(P.designGibson([gfrag('only one', 500, 1)], {}).error, /at least one insert/);
  var r = P.designGibson([gfrag('vector', 500, 1), gfrag('tiny', 30, 2)], { overlap: 25 });
  assert.match(r.error, /too short/);
});
check('the annealing part is grown until it is warm enough', function () {
  var parts = [gfrag('a', 500, 4), gfrag('b', 500, 5)];
  var warm = P.designGibson(parts, { overlap: 20, annealTm: 60 });
  warm.primers.forEach(function (pr) {
    assert.ok(pr.anneal.length >= 18, pr.name + ' long enough to be specific');
    assert.ok(pr.tmAnneal >= 55 || pr.anneal.length === 35, pr.name + ' reaches the target or runs out of room');
  });
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
