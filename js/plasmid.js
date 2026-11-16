/* ============================================================
   Elias Lab Notebook — plasmid core
   ------------------------------------------------------------
   Reading sequence files, sequence maths, and drawing maps.
   Pure logic: it never touches the page, so it runs unchanged in
   Node for the tests in scripts/test-plasmid.js.

   Conventions used throughout:
   • seq       uppercase IUPAC DNA, no whitespace.
   • start/end 0-based, start included, end excluded (like Python
               slicing). On a circular plasmid a feature crossing
               the origin has start > end.
   • strand    1 forward, -1 reverse, 0 neither.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  root.Plasmid = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // ---------- sequence basics ----------
  var IUPAC = 'ACGTURYSWKMBDHVN';
  var COMPLEMENT = { A: 'T', C: 'G', G: 'C', T: 'A', U: 'A', R: 'Y', Y: 'R', S: 'S', W: 'W',
    K: 'M', M: 'K', B: 'V', D: 'H', H: 'D', V: 'B', N: 'N' };

  /* Keep only sequence letters. Digits and whitespace are dropped, so a
     block pasted from GenBank or a Word document cleans up as typed. */
  function clean(seq) {
    return String(seq == null ? '' : seq).toUpperCase().replace(/[^A-Z]/g, '')
      .split('').filter(function (c) { return IUPAC.indexOf(c) >= 0; }).join('');
  }
  function isDna(seq) { return clean(seq).length === String(seq || '').replace(/[\s\d]/g, '').length; }
  function revcomp(seq) {
    var out = '', s = String(seq || '').toUpperCase();
    for (var i = s.length - 1; i >= 0; i--) out += COMPLEMENT[s[i]] || 'N';
    return out;
  }
  function gc(seq) {
    var s = clean(seq);
    if (!s.length) return 0;
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s[i] === 'G' || s[i] === 'C' || s[i] === 'S') n++;
    return n / s.length * 100;
  }
  /* Melting temperature. Short oligos use the Wallace rule; from 14 bases up,
     the salt-adjusted formula most primer tools print. */
  function tm(seq) {
    var s = clean(seq), n = s.length;
    if (!n) return 0;
    var g = Math.round(gc(s) / 100 * n);
    if (n < 14) return (n - g) * 2 + g * 4;
    return 64.9 + 41 * (g - 16.4) / n;
  }
  function molWeight(seq, topology) {
    // Average masses of the sodium salt; linear DNA keeps its 5' phosphate.
    var w = { A: 313.21, C: 289.18, G: 329.21, T: 304.2, U: 306.17 }, s = clean(seq), total = 0;
    for (var i = 0; i < s.length; i++) total += w[s[i]] || 308.95;
    total *= 2; // double stranded
    return topology === 'circular' ? total : total + 36.04;
  }

  var CODONS = {
    TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L', CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
    ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M', GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
    TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S', CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
    ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T', GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
    TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*', CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
    AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K', GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
    TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W', CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
    AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R', GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G'
  };
  var AA3 = { A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', E: 'Glu', Q: 'Gln', G: 'Gly',
    H: 'His', I: 'Ile', L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser',
    T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val', '*': 'Ter', X: 'Xaa' };
  function translate(seq) {
    var s = clean(seq), out = '';
    for (var i = 0; i + 2 < s.length; i += 3) out += CODONS[s.substr(i, 3)] || 'X';
    return out;
  }
  /* The transcript, which is the same strand with U for T. Not a biological
     step — no promoter is consulted and nothing is spliced — just the way the
     same bases are written when somebody is ordering an oligo or reading a
     paper that quotes RNA. */
  function toRna(seq) { return clean(seq).replace(/T/g, 'U'); }

  /* The forms a stretch of sequence gets copied in.

     Translation starts at the first base given, in frame, rather than at
     whichever reading frame the page happens to be displaying: the selection
     is what was asked about, and starting anywhere else would quietly answer
     a different question. A trailing partial codon is dropped — `remainder`
     reports it, because a selection whose length is not a multiple of three
     is usually a selection that is off by a base or two.

     Reverse-complement first, then transcribe or translate: the other strand
     read 5'→3' is what "reverse complement" means to somebody reading a map,
     and translating the forward strand backwards would be nonsense. */
  var COPY_FORMS = {
    dna:      { label: 'DNA',                         unit: 'bp' },
    'dna-rc': { label: 'DNA, reverse complement',     unit: 'bp', rc: true },
    rna:      { label: 'RNA',                         unit: 'nt', rna: true },
    'rna-rc': { label: 'RNA, reverse complement',     unit: 'nt', rna: true, rc: true },
    aa:       { label: 'Protein',                     unit: 'aa', aa: true },
    'aa-rc':  { label: 'Protein, reverse complement', unit: 'aa', aa: true, rc: true }
  };
  function copyForm(seq, kind) {
    var spec = COPY_FORMS[kind] || COPY_FORMS.dna;
    var s = clean(seq);
    if (spec.rc) s = revcomp(s);
    var text = spec.aa ? translate(s) : spec.rna ? toRna(s) : s;
    return { text: text, label: spec.label, unit: spec.unit,
      remainder: spec.aa ? s.length % 3 : 0 };
  }

  // ---------- features ----------
  /* Colours by feature type, close to what SnapGene and Benchling show, so a
     map imported from either still reads the way people expect. */
  var TYPE_COLORS = {
    CDS: '#b7e1b7', gene: '#b7e1b7', promoter: '#9fd3a0', terminator: '#f3a6a6',
    rep_origin: '#c9b3f0', oriT: '#c9b3f0', primer_bind: '#9ec5ef', misc_binding: '#9ec5ef',
    protein_bind: '#f2e39a', regulatory: '#f6cf9a', polyA_signal: '#f0b6dd', LTR: '#b9bdf0',
    sig_peptide: '#f6c9a8', misc_RNA: '#a8e4e0', ncRNA: '#a8e4e0', tRNA: '#a8e4e0',
    rRNA: '#a8e4e0', mRNA: '#a8e4e0', intron: '#d7d7d7', exon: '#b7e1b7',
    enhancer: '#9fd3a0', RBS: '#f2e39a', stem_loop: '#d7d7d7', repeat_region: '#d7d7d7',
    gRNA: '#ffb347', pegRNA: '#ff9a3c', tag: '#f5f09a', source: '#eeeeee', misc_feature: '#d7d7d7'
  };
  function colorFor(type) { return TYPE_COLORS[type] || TYPE_COLORS.misc_feature; }

  /* Put a feature into the shape the rest of the code expects, and keep it
     inside the sequence. Anything unusable comes back as null. */
  function normFeature(f, len) {
    if (!f) return null;
    var start = Math.round(Number(f.start)), end = Math.round(Number(f.end));
    if (!isFinite(start) || !isFinite(end) || !len) return null;
    // start lands in 0..len-1 and end in 1..len, so a feature ending on the
    // last base keeps end = len instead of folding round to 0.
    start = ((start % len) + len) % len;
    if (end > len) end = ((end % len) + len) % len;
    if (end <= 0) end = len;
    var type = String(f.type || 'misc_feature').replace(/[^\w'-]/g, '_').slice(0, 40) || 'misc_feature';
    return {
      name: String(f.name == null ? '' : f.name).slice(0, 120) || type,
      type: type,
      start: start, end: end,
      strand: f.strand === -1 || f.strand === '-1' || f.strand === '-' ? -1 : f.strand === 0 ? 0 : 1,
      color: /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : colorFor(type),
      note: String(f.note == null ? '' : f.note).slice(0, 500)
    };
  }
  function wraps(f) { return f.start >= f.end; }
  // How many bases a feature covers, counting the ones that cross the origin.
  function featureLen(f, len) { return wraps(f) ? len - f.start + f.end : f.end - f.start; }
  function featureSeq(p, f) {
    var s = p.seq, sub = wraps(f) ? s.slice(f.start) + s.slice(0, f.end) : s.slice(f.start, f.end);
    return f.strand === -1 ? revcomp(sub) : sub;
  }
  // A feature covering the whole plasmid is a filing note, not something to draw.
  function isWholeSpan(f, len) { return featureLen(f, len) >= len; }
  function drawable(features, len) {
    return (features || []).filter(function (f) { return !(isWholeSpan(f, len) && (f.type === 'source' || f.type === 'misc_feature')); });
  }
  function sortFeatures(features, len) {
    return (features || []).slice().sort(function (a, b) {
      return featureLen(b, len) - featureLen(a, len) || a.start - b.start;
    });
  }

  // ---------- a tiny XML reader ----------
  /* SnapGene stores its features as machine-written XML. Reading the few tags
     needed here keeps the parser identical in the browser and in Node, with no
     DOMParser and no dependency. */
  function unescapeXml(s) {
    return String(s == null ? '' : s).replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(+d); })
      .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
  function xmlAttrs(tag) {
    var out = {}, re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g, m;
    while ((m = re.exec(tag))) out[m[1] || m[3]] = unescapeXml(m[2] != null ? m[2] : m[4]);
    return out;
  }
  // Every <name …> element, with its attributes and its inner text.
  function xmlElements(xml, name) {
    var out = [], re = new RegExp('<' + name + '\\b([^>]*?)(/?)>', 'g'), m;
    while ((m = re.exec(xml))) {
      var attrs = xmlAttrs(m[1]), inner = '';
      if (m[2] !== '/') {
        var close = xml.indexOf('</' + name + '>', re.lastIndex);
        inner = close < 0 ? '' : xml.slice(re.lastIndex, close);
      }
      out.push({ attrs: attrs, inner: inner });
    }
    return out;
  }

  // ---------- GenBank ----------
  /* Read one GenBank record: the LOCUS line, the FEATURES table and ORIGIN.
     Locations may be plain, complement(…), join(…) or carry < and > for
     partial ends. A join that crosses the origin stays one wrapped feature. */
  function parseLocation(loc, len) {
    var strand = 1;
    loc = String(loc || '').replace(/\s+/g, '');
    if (/^complement\(/i.test(loc)) { strand = -1; loc = loc.replace(/^complement\(/i, '').replace(/\)$/, ''); }
    var isJoin = /^(join|order)\(/i.test(loc);
    if (isJoin) loc = loc.replace(/^(join|order)\(/i, '').replace(/\)$/, '');
    var parts = loc.split(',').map(function (part) {
      var m = /^[<>]?(\d+)(?:\.\.[<>]?(\d+))?$/.exec(part.replace(/^complement\(([^)]*)\)$/i, '$1'));
      if (!m) return null;
      var a = +m[1] - 1, b = m[2] == null ? +m[1] : +m[2];
      return { start: a, end: b };
    }).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return { start: parts[0].start, end: parts[0].end, strand: strand };
    // Several pieces: one that ends at the sequence end and another starting at
    // 1 is a feature crossing the origin; anything else keeps its outer span.
    var last = parts[parts.length - 1], first = parts[0];
    if (len && first.end === len && last.start === 0) return { start: first.start, end: last.end, strand: strand };
    var starts = parts.map(function (p) { return p.start; }), ends = parts.map(function (p) { return p.end; });
    return { start: Math.min.apply(null, starts), end: Math.max.apply(null, ends), strand: strand, joined: true };
  }

  function parseGenBank(text) {
    var lines = String(text || '').split(/\r?\n/);
    var name = '', topology = 'linear', definition = '', declaredLen = 0;
    var features = [], seq = '', inFeatures = false, inOrigin = false, cur = null, curQual = null;

    /* Keep the feature as written. Its location can only be turned into
       coordinates once ORIGIN has given the real length, because a location
       that crosses the origin is recognised by touching both ends. */
    function closeFeature() {
      if (!cur) return;
      features.push(cur);
      cur = null; curQual = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (inOrigin) {
        if (/^\/\//.test(line)) { inOrigin = false; continue; }
        seq += line.replace(/[\s\d]/g, '');
        continue;
      }
      if (/^LOCUS\s/i.test(line)) {
        var lm = /^LOCUS\s+(\S+)\s*(?:(\d+)\s*bp)?/i.exec(line);
        if (lm) { name = lm[1]; declaredLen = lm[2] ? +lm[2] : 0; }
        if (/\bcircular\b/i.test(line)) topology = 'circular';
        continue;
      }
      if (/^DEFINITION\s/i.test(line)) { definition = line.slice(12).trim(); continue; }
      if (/^FEATURES\s/i.test(line)) { inFeatures = true; continue; }
      if (/^ORIGIN/i.test(line)) { closeFeature(); inFeatures = false; inOrigin = true; continue; }
      if (/^(BASE COUNT|CONTIG)/i.test(line)) { closeFeature(); inFeatures = false; continue; }
      if (/^\S/.test(line)) { closeFeature(); inFeatures = false; continue; } // a new top-level section
      if (!inFeatures) continue;

      var fm = /^ {1,10}(\S+)\s+(\S.*)$/.exec(line);
      if (fm && !/^\s{10,}/.test(line)) {           // a feature key and its location
        closeFeature();
        cur = { key: fm[1], locText: fm[2].trim(), quals: {} };
        continue;
      }
      if (!cur) continue;
      var cont = line.trim();
      if (cont.charAt(0) === '/') {                  // a qualifier
        var qm = /^\/([\w-]+)(?:=([\s\S]*))?$/.exec(cont);
        if (qm) {
          var val = qm[2] == null ? 'true' : qm[2];
          var quoted = val.charAt(0) === '"';
          val = val.replace(/^"/, '').replace(/"$/, '');
          cur.quals[qm[1]] = (cur.quals[qm[1]] ? cur.quals[qm[1]] + ' ' : '') + val;
          curQual = quoted && !/"$/.test(cont) ? qm[1] : null; // still open across lines
        }
        continue;
      }
      if (curQual) {                                 // the rest of a quoted qualifier
        cur.quals[curQual] += ' ' + cont.replace(/"$/, '');
        if (/"$/.test(cont)) curQual = null;
      } else if (cur && !cur.quals.label) {           // a location continued onto the next line
        cur.locText += cont;
      }
    }
    closeFeature();

    seq = clean(seq);
    var len = seq.length || declaredLen;
    if (!len) return null;
    var norm = [];
    features.forEach(function (raw) {
      var loc = parseLocation(raw.locText, len);
      if (!loc) return;
      var q = raw.quals;
      var n = normFeature({
        name: q.label || q.gene || q.product || q.standard_name || q.note || raw.key,
        type: raw.key, start: loc.start, end: loc.end, strand: loc.strand,
        color: q.ApEinfo_fwdcolor || q.ApEinfo_revcolor || '', note: q.note || ''
      }, len);
      if (n) norm.push(n);
    });
    return { name: name || definition || 'Imported plasmid', seq: seq, topology: topology,
      features: norm, definition: definition };
  }

  // ---------- SnapGene (.dna) ----------
  /* A .dna file is a run of blocks: one type byte, four bytes of length, then
     that many bytes. Block 0 holds the sequence (its first byte says whether
     the plasmid is circular), block 10 the features and block 6 the notes. */
  function parseSnapGene(buffer) {
    var view = new DataView(buffer.buffer ? buffer.buffer : buffer);
    var bytes = new Uint8Array(buffer.buffer ? buffer.buffer : buffer);
    var pos = 0, seq = '', topology = 'linear', featuresXml = '', notesXml = '', seen = false;

    function text(from, length) {
      var out = '';
      for (var i = from; i < from + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
      return out;
    }
    while (pos + 5 <= bytes.length) {
      var type = view.getUint8(pos), length = view.getUint32(pos + 1);
      pos += 5;
      if (length < 0 || pos + length > bytes.length) break;
      if (type === 9) {                                   // the opening block
        if (text(pos, 8) !== 'SnapGene') return null;
        seen = true;
      } else if (type === 0) {
        // The sequence block opens with a flags byte, so a zero-length one is
        // not a sequence block at all. Without this the read runs one byte off
        // the end and throws RangeError instead of returning null, and a
        // truncated or mis-named .dna file crashes the import rather than
        // being refused.
        if (length < 1) break;
        topology = (view.getUint8(pos) & 1) ? 'circular' : 'linear';
        seq = clean(text(pos + 1, length - 1));
      } else if (type === 10) featuresXml = text(pos, length);
      else if (type === 6) notesXml = text(pos, length);
      pos += length;
    }
    if (!seen || !seq) return null;

    var features = [];
    xmlElements(featuresXml, 'Feature').forEach(function (el) {
      var a = el.attrs, segs = xmlElements(el.inner, 'Segment');
      var ranges = segs.map(function (s) {
        var m = /^(\d+)-(\d+)$/.exec(s.attrs.range || '');
        return m ? { start: +m[1] - 1, end: +m[2], color: s.attrs.color } : null;
      }).filter(Boolean);
      if (!ranges.length) return;
      var label = a.name || '';
      xmlElements(el.inner, 'Q').forEach(function (q) {
        if (q.attrs.name !== 'label' && q.attrs.name !== 'note') return;
        var v = xmlElements(q.inner, 'V')[0];
        if (!v) return;
        if (q.attrs.name === 'label' && !label) label = v.attrs.text || '';
      });
      var starts = ranges.map(function (r) { return r.start; }), ends = ranges.map(function (r) { return r.end; });
      // Pieces touching both ends of the sequence mean the feature crosses the origin.
      var wrapped = ranges.length > 1 && Math.max.apply(null, ends) === seq.length && Math.min.apply(null, starts) === 0;
      var span = wrapped
        ? { start: ranges.filter(function (r) { return r.end === seq.length; })[0].start,
            end: ranges.filter(function (r) { return r.start === 0; })[0].end }
        : { start: Math.min.apply(null, starts), end: Math.max.apply(null, ends) };
      features.push({ name: label || a.type || 'feature', type: a.type || 'misc_feature',
        start: span.start, end: span.end,
        strand: a.directionality === '2' ? -1 : a.directionality === '3' ? 0 : 1,
        color: ranges[0].color || '' });
    });

    var name = '';
    var nameEl = /<CustomMapLabel>([\s\S]*?)<\/CustomMapLabel>/.exec(notesXml) ||
      /<UUID>[\s\S]*?<\/UUID>[\s\S]*?<Description>([\s\S]*?)<\/Description>/.exec(notesXml);
    if (nameEl) name = unescapeXml(nameEl[1]).trim();

    var norm = [];
    features.forEach(function (f) { var n = normFeature(f, seq.length); if (n) norm.push(n); });
    return { name: name || 'Imported plasmid', seq: seq, topology: topology, features: norm };
  }

  // ---------- FASTA and plain sequence ----------
  function parseFasta(text) {
    var lines = String(text || '').split(/\r?\n/), name = '', seq = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].charAt(0) === '>') { if (seq) break; name = lines[i].slice(1).trim(); }
      else seq += lines[i];
    }
    seq = clean(seq);
    if (!seq) return null;
    return { name: name.split(/\s+/)[0] || 'Imported sequence', seq: seq, topology: 'linear', features: [],
      definition: name };
  }
  /* A pasted or typed sequence. Prose would otherwise slip through, because
     plenty of ordinary words are made only of IUPAC letters, so the text has
     to be long enough and almost entirely A/C/G/T to count as DNA. */
  function parseRaw(text) {
    var letters = String(text == null ? '' : text).toUpperCase().replace(/[^A-Z]/g, '');
    var seq = clean(letters);
    if (seq.length < 20) return null;
    var plain = (seq.match(/[ACGTUN]/g) || []).length;
    if (plain / seq.length < 0.9 || plain / letters.length < 0.9) return null;
    return { name: '', seq: seq, topology: 'circular', features: [] };
  }

  /* Work out the format from the file name and the contents. `data` is text,
     or an ArrayBuffer / Uint8Array for a SnapGene file. */
  function parseFile(filename, data) {
    var ext = (/\.([a-z0-9]+)$/i.exec(filename || '') || [, ''])[1].toLowerCase();
    var isBinary = typeof data !== 'string';
    if (ext === 'dna' || (isBinary && data && (data.byteLength || data.length) > 14)) {
      var p = parseSnapGene(data);
      if (p) return { ok: true, plasmid: p, format: 'SnapGene' };
      if (ext === 'dna') return { ok: false, error: 'This does not look like a SnapGene .dna file.' };
    }
    var text = isBinary ? String.fromCharCode.apply(null, new Uint8Array(data.buffer || data).slice(0, 5e6)) : String(data || '');
    if (/^\s*LOCUS\s/i.test(text) || ['gb', 'gbk', 'genbank', 'ape'].indexOf(ext) >= 0) {
      var g = parseGenBank(text);
      if (g) return { ok: true, plasmid: g, format: 'GenBank' };
    }
    if (/^\s*>/.test(text) || ['fa', 'fasta', 'fsa', 'fna', 'seq'].indexOf(ext) >= 0) {
      var f = parseFasta(text);
      if (f) return { ok: true, plasmid: f, format: 'FASTA' };
    }
    var r = parseRaw(text);
    if (r) return { ok: true, plasmid: r, format: 'plain sequence' };
    return { ok: false, error: 'No DNA sequence found in this file.' };
  }

  // ---------- writing files out ----------
  function pad(s, n, left) {
    s = String(s);
    while (s.length < n) s = left ? ' ' + s : s + ' ';
    return s;
  }
  var MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function gbDate(d) {
    d = d || new Date();
    return pad(d.getDate(), 2, true).replace(' ', '0') + '-' + MONTHS[d.getMonth()] + '-' + d.getFullYear();
  }
  function locationText(f, len) {
    var a = f.start + 1, b = f.end;
    var loc = wraps(f) ? 'join(' + a + '..' + len + ',1..' + b + ')' : a + '..' + b;
    return f.strand === -1 ? 'complement(' + loc + ')' : loc;
  }
  function toGenBank(p) {
    var len = p.seq.length, out = [];
    out.push('LOCUS       ' + pad((p.name || 'plasmid').replace(/\s+/g, '_').slice(0, 16), 16) + ' ' +
      pad(len, 11, true) + ' bp ds-DNA     ' + (p.topology === 'circular' ? 'circular' : 'linear  ') + ' SYN ' + gbDate());
    out.push('DEFINITION  ' + (p.definition || p.name || '.'));
    out.push('ACCESSION   .');
    out.push('VERSION     .');
    out.push('KEYWORDS    .');
    out.push('SOURCE      synthetic DNA construct');
    out.push('  ORGANISM  synthetic DNA construct');
    out.push('FEATURES             Location/Qualifiers');
    out.push('     source          1..' + len);
    out.push('                     /organism="synthetic DNA construct"');
    (p.features || []).forEach(function (f) {
      out.push('     ' + pad(f.type.slice(0, 15), 16) + locationText(f, len));
      out.push('                     /label="' + String(f.name).replace(/"/g, "'") + '"');
      if (f.color) out.push('                     /ApEinfo_fwdcolor="' + f.color + '"');
      if (f.note) out.push('                     /note="' + String(f.note).replace(/"/g, "'") + '"');
    });
    out.push('ORIGIN');
    var s = p.seq.toLowerCase();
    for (var i = 0; i < s.length; i += 60) {
      var chunks = [];
      for (var j = 0; j < 60; j += 10) {
        var piece = s.substr(i + j, 10);
        if (piece) chunks.push(piece);
      }
      out.push(pad(i + 1, 9, true) + ' ' + chunks.join(' '));
    }
    out.push('//');
    return out.join('\n') + '\n';
  }
  function toFasta(p) {
    var out = '>' + (p.name || 'plasmid') + (p.definition ? ' ' + p.definition : '') + '\n';
    for (var i = 0; i < p.seq.length; i += 70) out += p.seq.substr(i, 70) + '\n';
    return out;
  }
  function csvCell(v) {
    v = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(v)) v = "'" + v;           // stop Excel reading it as a formula
    return '"' + v.replace(/"/g, '""') + '"';
  }
  function featuresCsv(p) {
    var rows = [['Name', 'Type', 'Start', 'End', 'Length (bp)', 'Strand', 'Colour', 'Note', 'Sequence']];
    (p.features || []).forEach(function (f) {
      rows.push([f.name, f.type, f.start + 1, f.end, featureLen(f, p.seq.length),
        f.strand === -1 ? 'reverse' : f.strand === 0 ? 'both' : 'forward', f.color, f.note, featureSeq(p, f)]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  // ---------- editing the sequence ----------
  /* Compare the sequence before and after an edit and describe it as one
     change: at `pos`, `del` bases out and `ins` in. Enough for the single
     region a person edits at a time. */
  function diffEdit(oldSeq, newSeq) {
    var a = clean(oldSeq), b = clean(newSeq);
    if (a === b) return null;
    var start = 0, maxStart = Math.min(a.length, b.length);
    while (start < maxStart && a[start] === b[start]) start++;
    var endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { pos: start, del: endA - start, ins: b.slice(start, endB) };
  }
  /* Apply an edit and move the features with it. A feature covering the edit
     grows or shrinks; one that loses all its bases is dropped and reported. */
  function applyEdit(p, edit) {
    var len = p.seq.length, delta = edit.ins.length - edit.del;
    var from = edit.pos, to = edit.pos + edit.del;
    var seq = p.seq.slice(0, from) + clean(edit.ins) + p.seq.slice(to);
    var newLen = seq.length, dropped = [], changed = [];

    function movePoint(x, isEnd) {
      if (x <= from) return x;
      if (x >= to) return x + delta;
      return isEnd ? from + edit.ins.length : from;     // inside the edited stretch
    }
    var features = [];
    (p.features || []).forEach(function (f) {
      // start and end are plain positions, so each moves on its own whether or
      // not the feature crosses the origin.
      var oldLen = featureLen(f, len), wrapped = wraps(f);
      var cand = normFeature({ name: f.name, type: f.type, strand: f.strand, color: f.color, note: f.note,
        start: movePoint(f.start, false), end: movePoint(f.end, true) }, newLen);
      // Everything the feature covered was deleted.
      if (!cand || (!wrapped && cand.start === cand.end)) { dropped.push(f.name); return; }
      if (featureLen(cand, newLen) !== oldLen) changed.push(cand.name);
      features.push(cand);
    });
    return { seq: seq, features: features, dropped: dropped, changed: changed };
  }

  // ---------- translation and reading frames ----------
  /* The amino acids of a stretch, as a string the same length as the bases, so
     it lines up under them: each letter sits under the middle base of its
     codon. `frame` is 0, 1 or 2 counted from the start of the plasmid; a
     negative strand reads the other way. */
  function frameString(seq, frame, from, to, strand) {
    var len = seq.length, out = new Array(to - from).fill(' ');
    if (!len) return out.join('');
    for (var i = 0; i < to - from; i++) {
      var pos = from + i;
      // The base that carries the letter is the middle one of its codon.
      var off = strand === -1 ? (len - 1 - pos - frame) : (pos - frame);
      if (off < 1 || ((off - 1) % 3) !== 0) continue;
      var codon = strand === -1
        ? revcomp(seq.substr(pos - 1, 3))
        : seq.substr(pos - 1, 3);
      if (codon.length < 3) continue;
      out[i] = CODONS[codon] || 'X';
    }
    return out.join('');
  }
  /* Open reading frames: ATG through to a stop, in all three frames of each
     strand. On a circular plasmid a frame may run past the origin. */
  function orfs(seq, topology, minAa) {
    seq = clean(seq);
    var len = seq.length, min = minAa || 50, found = [];
    if (len < 6) return found;
    var circular = topology === 'circular';
    var hay = circular ? seq + seq : seq;
    [1, -1].forEach(function (strand) {
      var work = strand === 1 ? hay : revcomp(hay);
      for (var i = 0; i + 2 < work.length; i++) {
        if (work.substr(i, 3) !== 'ATG') continue;
        if (!circular && i >= len) break;
        if (circular && i >= len) break;
        var aa = '', j = i;
        for (; j + 2 < work.length; j += 3) {
          var c = CODONS[work.substr(j, 3)] || 'X';
          if (c === '*') break;
          aa += c;
          if (!circular && j + 3 > len) break;
          if (circular && j - i > len) break;        // gone right round
        }
        if (aa.length < min || j + 2 >= work.length) continue;
        var endExcl = j + 3;                          // take in the stop codon
        // Put it back on the forward strand's numbering.
        var a = strand === 1 ? i : work.length - endExcl;
        var b = strand === 1 ? endExcl : work.length - i;
        if (a >= len) continue;
        found.push({ start: a % len, end: b > len ? b % len || len : b, strand: strand, aa: aa, len: aa.length });
        i = j + 2;                                    // the next ATG comes after this one
      }
    });
    return found.sort(function (x, y) { return y.len - x.len; });
  }

  // ---------- CRISPR guides ----------
  /* The PAMs in common use. `side` says whether the PAM sits 3' of the
     protospacer (Cas9) or 5' of it (Cas12a); `cut` is where the blunt cut
     falls, counted back from the PAM-proximal end of the protospacer. */
  var PAM_TYPES = {
    'SpCas9 (NGG)': { pam: 'NGG', spacer: 20, side: 3, cut: 3 },
    'SpCas9-NG (NG)': { pam: 'NG', spacer: 20, side: 3, cut: 3 },
    'SaCas9 (NNGRRT)': { pam: 'NNGRRT', spacer: 21, side: 3, cut: 3 },
    'Cas12a / Cpf1 (TTTV)': { pam: 'TTTV', spacer: 23, side: 5, cut: -18 }
  };
  /* Every guide for a PAM, optionally only within `region` ({start,end}).
     `offTargets` counts how often the same protospacer occurs elsewhere in
     this plasmid — it says nothing about the genome. */
  function findGuides(seq, topology, pamKey, region) {
    seq = clean(seq);
    var len = seq.length, spec = PAM_TYPES[pamKey] || PAM_TYPES['SpCas9 (NGG)'];
    if (!len) return [];
    var circular = topology === 'circular';
    var pad = spec.spacer + spec.pam.length + 2;
    var hay = circular && len > pad ? seq + seq.slice(0, pad) : seq;
    var out = [];
    [1, -1].forEach(function (strand) {
      var work = strand === 1 ? hay : revcomp(hay);
      var re = siteRegex(spec.pam), m;
      re.lastIndex = 0;
      while ((m = re.exec(work))) {
        var at = m.index;
        re.lastIndex = at + 1;
        var sp = spec.side === 3 ? at - spec.spacer : at + spec.pam.length;
        if (sp < 0 || sp + spec.spacer > work.length) continue;
        var spacer = work.substr(sp, spec.spacer);
        if (/[^ACGT]/.test(spacer)) continue;                 // skip anything ambiguous
        // Back onto the forward strand's numbering.
        var a = strand === 1 ? sp : work.length - sp - spec.spacer;
        if (a >= len) continue;
        var cutAt = spec.side === 3
          ? (strand === 1 ? sp + spec.spacer - spec.cut : work.length - (sp + spec.spacer - spec.cut))
          : (strand === 1 ? sp + spec.spacer + spec.cut : work.length - (sp + spec.spacer + spec.cut));
        if (region && (a < region.start || a + spec.spacer > region.end)) continue;
        out.push({ spacer: spacer, pam: strand === 1 ? work.substr(at, spec.pam.length) : work.substr(at, spec.pam.length),
          start: a % len, end: (a + spec.spacer) % len || len, strand: strand,
          cutAt: ((cutAt % len) + len) % len, gc: gc(spacer), pamType: pamKey });
      }
    });
    // How often the same 20-mer turns up again in this plasmid.
    out.forEach(function (gde) {
      var both = seq + (circular ? seq.slice(0, 30) : '');
      var n = 0, from = 0, at, rc = revcomp(gde.spacer);
      while ((at = both.indexOf(gde.spacer, from)) >= 0) { n++; from = at + 1; }
      // A protospacer that reads the same backwards would otherwise be counted
      // twice at the same place.
      if (rc !== gde.spacer) {
        from = 0;
        while ((at = both.indexOf(rc, from)) >= 0) { n++; from = at + 1; }
      }
      gde.offTargets = Math.max(0, n - 1);
    });
    return out.sort(function (x, y) { return x.start - y.start; });
  }

  /* A prime-editing guide for one edit at `at` (0-based): `del` bases out,
     `ins` in. The 3' extension is written 5'->3' as the reverse transcriptase
     template followed by the primer binding site, which is how a pegRNA is
     ordered. The guide must nick on the strand carrying the edit. */
  function designPegRNA(seq, topology, guide, edit, opts) {
    opts = opts || {};
    var pbsLen = opts.pbs || 13, rttLen = opts.rtt || 13;
    seq = clean(seq);
    var len = seq.length;
    if (!guide || !len) return null;
    var nick = guide.cutAt;                       // the nick on the protospacer strand
    var fwd = guide.strand === 1;
    // Read the plasmid along the strand the guide sits on, so the nick and the
    // edit can be handled the same way whichever strand was chosen.
    var strandSeq = fwd ? seq : revcomp(seq);
    var nickOn = fwd ? nick : len - nick;
    var editAt = fwd ? edit.at : len - edit.at - (edit.del || 0);
    var insOn = fwd ? clean(edit.ins || '') : revcomp(clean(edit.ins || ''));
    var del = edit.del || 0;
    if (editAt < nickOn) return { error: 'The edit must sit downstream of the nick for this guide.' };
    // What the strand should read from the nick once edited.
    var after = strandSeq.slice(nickOn, editAt) + insOn + strandSeq.slice(editAt + del);
    var rtt = after.slice(0, rttLen);
    var pbs = strandSeq.slice(Math.max(0, nickOn - pbsLen), nickOn);
    return {
      spacer: guide.spacer,
      pbs: revcomp(pbs), rtt: revcomp(rtt),
      extension: revcomp(rtt) + revcomp(pbs),     // written 5'->3', as ordered
      pbsTm: tm(pbs), nick: nick, strand: guide.strand,
      note: 'Order as: spacer + scaffold + extension. PBS ' + pbsLen + ' nt, RTT ' + rttLen + ' nt.'
    };
  }

  // ---------- annotation ----------
  /* A small set of short, standard elements whose sequences are settled and
     short enough to be exact. Entries carrying `aa` are also looked for in
     protein, so a tag with different codon usage is still found. This is not
     a stand-in for a full feature database: the rest comes from the lab's own
     plasmids (see labLibrary) or from a library file. */
  var BUILTIN_FEATURES = [
    { name: 'M13 fwd', type: 'primer_bind', dna: 'GTAAAACGACGGCCAGT' },
    { name: 'M13 rev', type: 'primer_bind', dna: 'CAGGAAACAGCTATGAC' },
    { name: 'T7 promoter', type: 'promoter', dna: 'TAATACGACTCACTATAG' },
    { name: 'T3 promoter', type: 'promoter', dna: 'AATTAACCCTCACTAAAG' },
    { name: 'SP6 promoter', type: 'promoter', dna: 'ATTTAGGTGACACTATAG' },
    { name: 'lac operator', type: 'protein_bind', dna: 'GGAATTGTGAGCGGATAACAATT' },
    { name: 'CAP binding site', type: 'protein_bind', dna: 'GCCGGCGCCACAATTCCACAC' },
    { name: 'loxP', type: 'protein_bind', dna: 'ATAACTTCGTATAATGTATGCTATACGAAGTTAT' },
    { name: 'FRT', type: 'protein_bind', dna: 'GAAGTTCCTATTCTCTAGAAAGTATAGGAACTTC' },
    { name: 'polyA signal', type: 'polyA_signal', dna: 'AATAAA' },
    { name: 'Kozak', type: 'regulatory', dna: 'GCCACCATGG' },
    { name: 'FLAG tag', type: 'tag', dna: 'GACTACAAAGACGATGACGACAAG', aa: 'DYKDDDDK' },
    { name: 'HA tag', type: 'tag', dna: 'TACCCATACGATGTTCCAGATTACGCT', aa: 'YPYDVPDYA' },
    { name: 'Myc tag', type: 'tag', dna: 'GAACAAAAACTCATCTCAGAAGAGGATCTG', aa: 'EQKLISEEDL' },
    { name: 'V5 tag', type: 'tag', dna: 'GGTAAGCCTATCCCTAACCCTCTCCTCGGTCTCGATTCTACG', aa: 'GKPIPNPLLGLDST' },
    { name: '6xHis tag', type: 'tag', dna: 'CACCACCACCACCACCAC', aa: 'HHHHHH' },
    { name: 'Strep-tag II', type: 'tag', dna: 'TGGAGCCACCCGCAGTTCGAAAAA', aa: 'WSHPQFEK' },
    { name: 'P2A', type: 'CDS', dna: 'GGAAGCGGAGCTACTAACTTCAGCCTGCTGAAGCAGGCTGGAGACGTGGAGGAGAACCCTGGACCT', aa: 'GSGATNFSLLKQAGDVEENPGP' },
    { name: 'T2A', type: 'CDS', dna: 'GAGGGCAGAGGAAGTCTGCTAACATGCGGTGACGTCGAGGAGAATCCTGGCCCA', aa: 'EGRGSLLTCGDVEENPGP' },
    { name: 'TEV site', type: 'misc_feature', dna: 'GAAAACCTGTATTTTCAGGGC', aa: 'ENLYFQG' }
  ];
  /* Every feature the lab already has, taken from the other plasmids in the
     inventory with the bases they cover. This is what makes annotation useful:
     a construct imported from SnapGene teaches the notebook its features. */
  function labLibrary(plasmids, skipId) {
    var seen = {}, out = [];
    (plasmids || []).forEach(function (it) {
      if (!it || it.id === skipId) return;
      var seq = clean(it.seq || '');
      if (!seq) return;
      var p = { seq: seq, features: it.features || [] };
      p.features.forEach(function (f) {
        var nf = normFeature(f, seq.length);
        if (!nf || featureLen(nf, seq.length) < 8) return;
        var dna = featureSeq(p, nf);
        var key = nf.name.toLowerCase() + '|' + dna;
        if (seen[key] || dna.length > 20000) return;
        seen[key] = true;
        out.push({ name: nf.name, type: nf.type, dna: dna, color: nf.color, from: it.name || 'another plasmid' });
      });
    });
    return out;
  }

  /* Look for every library entry in the plasmid, on both strands, and in
     protein for entries that carry one. Anything already annotated at the same
     place is left out, so running it twice adds nothing. */
  function annotate(p, library, opts) {
    opts = opts || {};
    var seq = clean(p.seq || ''), len = seq.length;
    if (!len) return [];
    var circular = p.topology === 'circular';
    var hay = circular ? seq + seq.slice(0, Math.min(len, 20000)) : seq;
    var existing = {};
    (p.features || []).forEach(function (f) { existing[f.start + ':' + f.end + ':' + f.strand] = true; });
    var found = [], seen = {};

    function add(name, type, start, endExcl, strand, color, how) {
      if (endExcl - start < 1) return;
      var f = normFeature({ name: name, type: type, start: start % len,
        end: endExcl > len ? (endExcl % len || len) : endExcl, strand: strand, color: color }, len);
      if (!f) return;
      var key = f.start + ':' + f.end + ':' + f.strand;
      if (existing[key] || seen[key]) return;
      seen[key] = true;
      f.how = how;
      found.push(f);
    }

    (library || []).forEach(function (entry) {
      var dna = clean(entry.dna || '');
      if (dna.length >= (opts.minLen || 8) && dna.length <= len) {
        [[dna, 1], [revcomp(dna), -1]].forEach(function (pair, i) {
          if (i && pair[0] === dna) return;                  // palindrome: found already
          var from = 0, at;
          while ((at = hay.indexOf(pair[0], from)) >= 0) {
            from = at + 1;
            if (at >= len) break;
            add(entry.name, entry.type || 'misc_feature', at, at + dna.length, pair[1], entry.color, 'sequence');
          }
        });
      }
      // Protein match, so a tag with different codons is still picked up.
      if (entry.aa && entry.aa.length >= 5) {
        for (var frame = 0; frame < 3; frame++) {
          [1, -1].forEach(function (strand) {
            var work = strand === 1 ? hay : revcomp(hay);
            var prot = translate(work.slice(frame));
            var from = 0, at;
            while ((at = prot.indexOf(entry.aa, from)) >= 0) {
              from = at + 1;
              var s0 = frame + at * 3, e0 = s0 + entry.aa.length * 3;
              var a = strand === 1 ? s0 : work.length - e0;
              if (a >= len || a < 0) continue;
              add(entry.name, entry.type || 'tag', a, a + entry.aa.length * 3, strand, entry.color, 'protein');
            }
          });
        }
      }
    });
    return found.sort(function (a, b) { return a.start - b.start || featureLen(b, len) - featureLen(a, len); });
  }

  // ---------- restriction enzymes ----------
  /* The enzymes a cloning lab reaches for. For each: the recognition site in
     IUPAC letters, and where the cut falls counted from the start of the site
     — `t` on the top strand, `b` on the bottom. For the type IIS enzymes
     (BsaI, BsmBI, BbsI, SapI…) the cut is outside the site, so the offsets
     are larger than the site itself. Sticky ends follow from t and b: t < b
     leaves a 5' overhang, t > b a 3' overhang, and t === b is blunt. */
  var ENZYMES = [
    { n: 'AatII', s: 'GACGTC', t: 5, b: 1 }, { n: 'Acc65I', s: 'GGTACC', t: 1, b: 5 },
    { n: 'AflII', s: 'CTTAAG', t: 1, b: 5 }, { n: 'AflIII', s: 'ACRYGT', t: 1, b: 5 },
    { n: 'AgeI', s: 'ACCGGT', t: 1, b: 5 }, { n: 'AleI', s: 'CACNNNNGTG', t: 5, b: 5 },
    { n: 'ApaI', s: 'GGGCCC', t: 5, b: 1 }, { n: 'ApaLI', s: 'GTGCAC', t: 1, b: 5 },
    { n: 'AscI', s: 'GGCGCGCC', t: 2, b: 6 }, { n: 'AseI', s: 'ATTAAT', t: 2, b: 4 },
    { n: 'AvrII', s: 'CCTAGG', t: 1, b: 5 }, { n: 'BamHI', s: 'GGATCC', t: 1, b: 5 },
    { n: 'BbsI', s: 'GAAGAC', t: 8, b: 12 }, { n: 'BclI', s: 'TGATCA', t: 1, b: 5 },
    { n: 'BglII', s: 'AGATCT', t: 1, b: 5 }, { n: 'BmtI', s: 'GCTAGC', t: 5, b: 1 },
    { n: 'BsaI', s: 'GGTCTC', t: 7, b: 11 }, { n: 'BsaBI', s: 'GATNNNNATC', t: 5, b: 5 },
    { n: 'BsiEI', s: 'CGRYCG', t: 4, b: 2 }, { n: 'BsiWI', s: 'CGTACG', t: 1, b: 5 },
    { n: 'BsmBI', s: 'CGTCTC', t: 7, b: 11 }, { n: 'BspEI', s: 'TCCGGA', t: 1, b: 5 },
    { n: 'BspHI', s: 'TCATGA', t: 1, b: 5 }, { n: 'BsrGI', s: 'TGTACA', t: 1, b: 5 },
    { n: 'BssHII', s: 'GCGCGC', t: 1, b: 5 }, { n: 'BstBI', s: 'TTCGAA', t: 2, b: 4 },
    { n: 'BstEII', s: 'GGTNACC', t: 1, b: 6 }, { n: 'BstXI', s: 'CCANNNNNNTGG', t: 8, b: 4 },
    { n: 'BstZ17I', s: 'GTATAC', t: 3, b: 3 }, { n: 'ClaI', s: 'ATCGAT', t: 2, b: 4 },
    { n: 'DraI', s: 'TTTAAA', t: 3, b: 3 }, { n: 'DraIII', s: 'CACNNNGTG', t: 6, b: 3 },
    { n: 'EagI', s: 'CGGCCG', t: 1, b: 5 }, { n: 'Eco47III', s: 'AGCGCT', t: 3, b: 3 },
    { n: 'EcoRI', s: 'GAATTC', t: 1, b: 5 }, { n: 'EcoRV', s: 'GATATC', t: 3, b: 3 },
    { n: 'FseI', s: 'GGCCGGCC', t: 6, b: 2 }, { n: 'HincII', s: 'GTYRAC', t: 3, b: 3 },
    { n: 'HindIII', s: 'AAGCTT', t: 1, b: 5 }, { n: 'HpaI', s: 'GTTAAC', t: 3, b: 3 },
    { n: 'KpnI', s: 'GGTACC', t: 5, b: 1 }, { n: 'MfeI', s: 'CAATTG', t: 1, b: 5 },
    { n: 'MluI', s: 'ACGCGT', t: 1, b: 5 }, { n: 'MscI', s: 'TGGCCA', t: 3, b: 3 },
    { n: 'NaeI', s: 'GCCGGC', t: 3, b: 3 }, { n: 'NarI', s: 'GGCGCC', t: 2, b: 4 },
    { n: 'NcoI', s: 'CCATGG', t: 1, b: 5 }, { n: 'NdeI', s: 'CATATG', t: 2, b: 4 },
    { n: 'NheI', s: 'GCTAGC', t: 1, b: 5 }, { n: 'NotI', s: 'GCGGCCGC', t: 2, b: 6 },
    { n: 'NruI', s: 'TCGCGA', t: 3, b: 3 }, { n: 'NsiI', s: 'ATGCAT', t: 5, b: 1 },
    { n: 'NspI', s: 'RCATGY', t: 5, b: 1 }, { n: 'PacI', s: 'TTAATTAA', t: 5, b: 3 },
    { n: 'PciI', s: 'ACATGT', t: 1, b: 5 }, { n: 'PflMI', s: 'CCANNNNNTGG', t: 7, b: 4 },
    { n: 'PmeI', s: 'GTTTAAAC', t: 4, b: 4 }, { n: 'PmlI', s: 'CACGTG', t: 3, b: 3 },
    { n: 'PstI', s: 'CTGCAG', t: 5, b: 1 }, { n: 'PvuI', s: 'CGATCG', t: 4, b: 2 },
    { n: 'PvuII', s: 'CAGCTG', t: 3, b: 3 }, { n: 'SacI', s: 'GAGCTC', t: 5, b: 1 },
    { n: 'SacII', s: 'CCGCGG', t: 4, b: 2 }, { n: 'SalI', s: 'GTCGAC', t: 1, b: 5 },
    { n: 'SapI', s: 'GCTCTTC', t: 8, b: 11 }, { n: 'SbfI', s: 'CCTGCAGG', t: 6, b: 2 },
    { n: 'ScaI', s: 'AGTACT', t: 3, b: 3 }, { n: 'SgrAI', s: 'CRCCGGYG', t: 2, b: 6 },
    { n: 'SmaI', s: 'CCCGGG', t: 3, b: 3 }, { n: 'SnaBI', s: 'TACGTA', t: 3, b: 3 },
    { n: 'SpeI', s: 'ACTAGT', t: 1, b: 5 }, { n: 'SphI', s: 'GCATGC', t: 5, b: 1 },
    { n: 'SspI', s: 'AATATT', t: 3, b: 3 }, { n: 'StuI', s: 'AGGCCT', t: 3, b: 3 },
    { n: 'StyI', s: 'CCWWGG', t: 1, b: 5 }, { n: 'SwaI', s: 'ATTTAAAT', t: 4, b: 4 },
    { n: 'Tth111I', s: 'GACNNNGTC', t: 4, b: 5 }, { n: 'XbaI', s: 'TCTAGA', t: 1, b: 5 },
    { n: 'XhoI', s: 'CTCGAG', t: 1, b: 5 }, { n: 'XmaI', s: 'CCCGGG', t: 1, b: 5 },
    { n: 'ZraI', s: 'GACGTC', t: 3, b: 3 }
  ];
  var IUPAC_SET = { A: 'A', C: 'C', G: 'G', T: 'TU', U: 'TU', R: 'AGR', Y: 'CTUY', S: 'CGS', W: 'ATUW',
    K: 'GTUK', M: 'ACM', B: 'CGTUBYKS', D: 'AGTUDRKW', H: 'ACTUHYMW', V: 'ACGVRSM', N: IUPAC };
  function siteRegex(site) {
    var src = '';
    for (var i = 0; i < site.length; i++) src += '[' + (IUPAC_SET[site[i]] || site[i]) + ']';
    return new RegExp(src, 'g');
  }
  var _reCache = {};
  function cachedRe(site) { return _reCache[site] || (_reCache[site] = siteRegex(site)); }

  /* Where each enzyme cuts. Returns one entry per site, with the cut positions
     on both strands. On a circular plasmid a site straddling the origin is
     found too, and its positions come back inside 0..len-1. */
  function findSites(seq, topology, list) {
    seq = clean(seq);
    var len = seq.length;
    if (!len) return [];
    var circular = topology === 'circular';
    var longest = (list || ENZYMES).reduce(function (m, e) { return Math.max(m, e.s.length); }, 0);
    // Repeat the start so a site crossing the origin still matches.
    var hay = circular && len > longest ? seq + seq.slice(0, longest - 1) : seq;
    var out = [];
    (list || ENZYMES).forEach(function (e) {
      var strands = [[e.s, 1]];
      if (revcomp(e.s) !== e.s) strands.push([revcomp(e.s), -1]);
      strands.forEach(function (pair) {
        var re = cachedRe(pair[0]), m;
        re.lastIndex = 0;
        while ((m = re.exec(hay))) {
          var at = m.index;
          re.lastIndex = at + 1;                 // overlapping sites count too
          if (at >= len) break;
          /* Cuts are measured from the start of the site as written, so a
             site found on the bottom strand is measured back from its far
             end — and the two offsets change places with it. The enzyme's
             `t` is the cut in the strand it reads; for a site on the bottom
             strand that strand is our bottom one, so `t` gives this
             sequence's bottom cut and `b` its top.

             Swapping them matters only for an enzyme whose site is not its
             own reverse complement, which in practice means the Type IIS
             enzymes — and for those it was deciding that a site facing one
             way left a 5' overhang and the same enzyme facing the other way
             left a 3'. BsaI leaves a 5' overhang whichever way round its
             site sits, and two pieces cut by one enzyme are exactly what
             Golden Gate joins together. */
          var top = pair[1] === 1 ? at + e.t : at + pair[0].length - e.b;
          var bot = pair[1] === 1 ? at + e.b : at + pair[0].length - e.t;
          if (!circular && (top < 0 || top > len || bot < 0 || bot > len)) continue;
          out.push({ name: e.n, site: e.s, start: at % len, end: (at + pair[0].length) % len || len,
            cutTop: ((top % len) + len) % len, cutBottom: ((bot % len) + len) % len,
            strand: pair[1], blunt: e.t === e.b });
        }
      });
    });
    out.sort(function (a, b) { return a.cutTop - b.cutTop || a.name.localeCompare(b.name); });
    return out;
  }
  function siteCounts(sites) {
    var counts = {};
    (sites || []).forEach(function (h) { counts[h.name] = (counts[h.name] || 0) + 1; });
    return counts;
  }
  /* Keep only the enzymes cutting a chosen number of times: 'unique' for one
     site, 'two' for one or two, 'all' for everything that cuts. */
  function filterSites(sites, mode) {
    if (mode === 'all' || !mode) return sites;
    var counts = siteCounts(sites);
    var max = mode === 'unique' ? 1 : mode === 'two' ? 2 : 1e9;
    return sites.filter(function (h) { return counts[h.name] <= max; });
  }
  // Enzymes with no site at all, which is what you want for a cloning site.
  function nonCutters(sites, list) {
    var counts = siteCounts(sites);
    return (list || ENZYMES).filter(function (e) { return !counts[e.n]; }).map(function (e) { return e.n; });
  }

  // ---------- cutting and joining ----------
  /* Bases a..b on a circular sequence, wrapping if it runs past the end. */
  function sliceCirc(seq, a, b, len) {
    if (b >= a) return seq.slice(a, b);
    return seq.slice(a) + seq.slice(0, b);
  }
  /* The end a cut leaves. `ohang` is the staggered region written as it reads
     on the top strand; `type` says which strand sticks out. Two ends join when
     they are the same type and their ohang reads the same, which is what makes
     BamHI and BglII ends interchangeable. */
  function cutEnd(seq, len, site) {
    var t = site.cutTop, b = site.cutBottom;
    var lo = Math.min(t, b), hi = Math.max(t, b);
    // A cut whose two strands sit either side of the origin.
    var wrapped = Math.abs(t - b) > len / 2;
    if (wrapped) { lo = Math.max(t, b); hi = Math.min(t, b); }
    return {
      enzyme: site.name,
      type: t === b ? 'blunt' : (wrapped ? (t > b) : (t < b)) ? "5'" : "3'",
      ohang: t === b ? '' : sliceCirc(seq, lo, hi, len)
    };
  }
  function endsMatch(right, left) {
    if (!right || !left || right.type === 'end' || left.type === 'end') return false;
    if (right.type !== left.type) return false;
    return right.type === 'blunt' ? true : right.ohang === left.ohang;
  }
  /* The part of a feature that falls inside a fragment, in the fragment's own
     numbering. Anything cut through is marked, so the product says so. */
  /* The features a window [from, from+fragLen) carries, in its own numbering.

     Used both for the pieces of a digest and for the body of a PCR product,
     which is why the note is a parameter: the same clipping means "cut" in
     one case and "the primer landed inside it" in the other.

     A feature can land in the window as *two* intervals even after wraps()
     has split it at the origin, because the window itself may start partway
     through the feature. Reading one interval only is what used to make a
     gene straddling a cut site disappear from the downstream piece instead of
     appearing on it, shortened — and a feature that vanishes is far worse
     than one that is visibly truncated, because nothing on screen says it was
     ever there. */
  function carryFeatures(p, from, to, fragLen, clipNote) {
    var len = p.seq.length, out = [];
    var note = clipNote || 'Shortened when the plasmid was cut';
    (p.features || []).forEach(function (f) {
      var pieces = wraps(f) ? [[f.start, len], [0, f.end]] : [[f.start, f.end]];
      pieces.forEach(function (sp) {
        var pieceLen = sp[1] - sp[0];
        if (pieceLen <= 0) return;
        // Where the piece starts, counted from the window's first base.
        var ra = ((sp[0] - from) % len + len) % len;
        // If it runs off the end of the sequence it comes back round, and the
        // part that comes back may be the part inside the window.
        var spans = ra + pieceLen > len
          ? [[ra, len], [0, ra + pieceLen - len]]
          : [[ra, ra + pieceLen]];
        spans.forEach(function (sv) {
          var s0 = Math.max(0, sv[0]), e0 = Math.min(fragLen, sv[1]);
          if (e0 <= s0) return;
          out.push({ name: f.name, type: f.type, start: s0, end: e0, strand: f.strand, color: f.color,
            note: (e0 - s0) < pieceLen ? note : f.note });
        });
      });
    });
    return out;
  }

  /* Cut a plasmid with a set of enzymes. Comes back with the pieces in the
     order they sit on the plasmid, each carrying its sequence, its two ends
     and the features it holds. */
  function digest(p, enzymeNames) {
    var seq = clean(p.seq || ''), len = seq.length;
    var wanted = (enzymeNames || []).map(function (n) { return String(n); });
    var list = ENZYMES.filter(function (e) { return wanted.indexOf(e.n) >= 0; });
    if (!len || !list.length) return { fragments: [], sites: [] };
    var circular = p.topology === 'circular';
    var sites = findSites(seq, p.topology, list).slice()
      .sort(function (a, b) { return a.cutTop - b.cutTop; });
    // Two enzymes cutting at the very same base would make a zero-length piece.
    sites = sites.filter(function (s, i) { return i === 0 || s.cutTop !== sites[i - 1].cutTop; });
    if (!sites.length) return { fragments: [], sites: [] };

    var frags = [];
    function build(from, to, left, right) {
      var fragLen = to >= from ? to - from : len - from + to;
      if (fragLen <= 0) return;
      frags.push({ start: from, end: to, len: fragLen, seq: sliceCirc(seq, from, to, len),
        left: left, right: right, features: carryFeatures({ seq: seq, features: p.features }, from, to, fragLen) });
    }
    if (circular) {
      for (var i = 0; i < sites.length; i++) {
        var nxt = sites[(i + 1) % sites.length];
        build(sites[i].cutTop, nxt.cutTop, cutEnd(seq, len, sites[i]), cutEnd(seq, len, nxt));
      }
    } else {
      build(0, sites[0].cutTop, { type: 'end' }, cutEnd(seq, len, sites[0]));
      for (var j = 0; j < sites.length - 1; j++) {
        build(sites[j].cutTop, sites[j + 1].cutTop, cutEnd(seq, len, sites[j]), cutEnd(seq, len, sites[j + 1]));
      }
      build(sites[sites.length - 1].cutTop, len, cutEnd(seq, len, sites[sites.length - 1]), { type: 'end' });
    }
    return { fragments: frags, sites: sites };
  }

  /* The same piece the other way round: the ends swap and the overhangs are
     read on what is now the top strand. */
  function flipFragment(f) {
    return {
      start: f.start, end: f.end, len: f.len, seq: revcomp(f.seq), flipped: !f.flipped,
      left: { enzyme: f.right.enzyme, type: f.right.type, ohang: revcomp(f.right.ohang || '') },
      right: { enzyme: f.left.enzyme, type: f.left.type, ohang: revcomp(f.left.ohang || '') },
      features: (f.features || []).map(function (g) {
        return { name: g.name, type: g.type, start: f.len - g.end, end: f.len - g.start,
          strand: g.strand === 0 ? 0 : -g.strand, color: g.color, note: g.note };
      })
    };
  }

  /* Join pieces in the order given. Every join is checked, and a circular
     product has to close on itself as well. */
  function ligate(parts, circular) {
    if (!parts || !parts.length) return { ok: false, error: 'Nothing to join.' };
    var pieces = parts.map(function (x) { return x.flip ? flipFragment(x.frag) : x.frag; });
    var junctions = [];
    for (var i = 0; i < pieces.length - 1; i++) {
      if (!endsMatch(pieces[i].right, pieces[i + 1].left)) {
        return { ok: false, error: 'Piece ' + (i + 1) + ' ends with ' + describeEnd(pieces[i].right) +
          ' but piece ' + (i + 2) + ' starts with ' + describeEnd(pieces[i + 1].left) + ', so they cannot be joined.' };
      }
      junctions.push({ at: 0, left: pieces[i].right, right: pieces[i + 1].left });
    }
    if (circular && !endsMatch(pieces[pieces.length - 1].right, pieces[0].left)) {
      return { ok: false, error: 'The last piece ends with ' + describeEnd(pieces[pieces.length - 1].right) +
        ' but the first starts with ' + describeEnd(pieces[0].left) + ', so the product cannot close into a circle.' };
    }
    var seq = '', features = [], at = 0;
    pieces.forEach(function (f, i) {
      (f.features || []).forEach(function (g) {
        features.push({ name: g.name, type: g.type, start: at + g.start, end: at + g.end,
          strand: g.strand, color: g.color, note: g.note });
      });
      if (i) junctions[i - 1].at = at;
      seq += f.seq;
      at += f.seq.length;
    });
    return { ok: true, seq: seq, features: features, topology: circular ? 'circular' : 'linear',
      junctions: junctions, pieces: pieces };
  }
  function describeEnd(e) {
    if (!e || e.type === 'end') return 'a plain end';
    if (e.type === 'blunt') return 'a blunt ' + e.enzyme + ' end';
    return 'a ' + e.type + ' ' + e.ohang + ' overhang (' + e.enzyme + ')';
  }

  /* Every enzyme and how often it cuts, for choosing a cloning site: those
     that never cut, cut once, twice, and so on. */
  function enzymeSummary(p, list) {
    var seq = clean(p.seq || '');
    if (!seq) return [];
    var sites = findSites(seq, p.topology, list || ENZYMES);
    var by = {};
    sites.forEach(function (h) { (by[h.name] = by[h.name] || []).push(h); });
    return (list || ENZYMES).map(function (e) {
      var hits = by[e.n] || [];
      return { name: e.n, site: e.s, count: hits.length, hits: hits,
        blunt: e.t === e.b, cuts: hits.map(function (h) { return h.cutTop + 1; }) };
    }).sort(function (a, b) { return a.count - b.count || a.name.localeCompare(b.name); });
  }

  // ---------- primers ----------
  /* Where a primer sits on the plasmid.

     The 3' end has to match exactly — that is the end the polymerase extends
     from — so the search starts there and grows the match back towards the
     5' end. It used to stop at the first base that disagreed and call
     everything before it a tail. But a primer that changes one codon is
     complementary on both sides of the change: the bases upstream of the
     mismatch anneal just as well as the ones downstream. So the match now
     carries on across a mismatch whenever what lies beyond it pairs again,
     and only what really hangs free is the tail.

     "Pairs again" is scored: a match counts +1 and a mismatch −3, and the
     primer is taken to be annealed as far towards its 5' end as that total
     keeps improving. One mismatch therefore has to be followed by at least
     four matching bases to be bridged, which a restriction site or an
     overlap added to the 5' end practically never is.

       anneal      the stretch lying on the template, mismatches included
       tail        the 5' bases that hang free
       match3      how many bases at the 3' end match with no mismatch
       mismatches  where on the template the disagreeing bases sit
       mmIndex     the same, as positions in the primer */
  var PRIMER_MATCH = 1, PRIMER_MISMATCH = -3;
  function bindPrimers(p, primerSeq, opts) {
    opts = opts || {};
    var seq = clean(p.seq || ''), len = seq.length;
    var pr = clean(primerSeq || '');
    var minAnneal = Math.max(8, opts.minAnneal || 14);
    if (!len || pr.length < minAnneal) return [];
    var circular = p.topology === 'circular';
    var pad = Math.min(len, pr.length + 5);
    var hay = circular && len > pad ? seq + seq.slice(0, pad) : seq;
    var out = [], seen = {};
    [1, -1].forEach(function (strand) {
      var work = strand === 1 ? hay : revcomp(hay);
      var seed = pr.slice(-minAnneal), from = 0, at;
      while ((at = work.indexOf(seed, from)) >= 0) {
        from = at + 1;
        var end3 = at + minAnneal;              // where the primer's 3' end lands
        var exact = minAnneal;
        while (exact < pr.length) {             // grow back towards the 5' end
          var tp = end3 - exact - 1, pp = pr.length - exact - 1;
          if (tp < 0 || pr[pp] !== work[tp]) break;
          exact++;
        }
        // On across mismatches, for as long as it keeps paying.
        var anneal = exact, score = 0, best = 0, n = exact, missAt = [], kept = 0;
        while (n < pr.length) {
          var tq = end3 - n - 1, pq = pr.length - n - 1;
          if (tq < 0) break;
          if (pr[pq] === work[tq]) score += PRIMER_MATCH;
          else { score += PRIMER_MISMATCH; missAt.push(pq); }
          n++;
          if (score > best) { best = score; anneal = n; kept = missAt.length; }
        }
        var mmIndex = missAt.slice(0, kept).sort(function (x, y) { return x - y; });
        var sw = end3 - anneal;
        // Back onto the forward strand's numbering.
        var a = strand === 1 ? sw : work.length - end3;
        var b = strand === 1 ? end3 : work.length - sw;
        if (a >= len) continue;
        var key = strand + ':' + (a % len) + ':' + anneal;
        if (seen[key]) continue;
        seen[key] = true;
        var mismatches = mmIndex.map(function (pi) {
          var w = end3 - (pr.length - pi);      // where that base lies on the strand searched
          return (strand === 1 ? w : work.length - 1 - w) % len;
        });
        out.push({ start: a % len, end: b > len ? b % len || len : b, strand: strand,
          anneal: pr.slice(pr.length - anneal), tail: pr.slice(0, pr.length - anneal),
          match3: exact, mismatches: mismatches, mmIndex: mmIndex,
          seq: pr, tm: tm(pr.slice(pr.length - anneal)), gc: gc(pr),
          perfect: anneal === pr.length && !mmIndex.length });
      }
    });
    return out.sort(function (x, y) { return y.anneal.length - x.anneal.length || x.start - y.start; });
  }

  /* What the two primers make. The product carries both primers whole, so a
     5' tail ends up in the product even though it never touched the template. */
  function pcrProduct(p, fwd, rev) {
    var seq = clean(p.seq || ''), len = seq.length;
    if (!fwd || !rev) return { error: 'Two primers are needed.' };
    if (fwd.strand !== 1 || rev.strand !== -1) return { error: 'One primer has to read forwards and the other backwards.' };
    var circular = p.topology === 'circular';
    var from = fwd.end, to = rev.end;           // the stretch between the annealed ends
    var middle;
    if (to >= from) middle = seq.slice(from, to);
    else if (circular) middle = seq.slice(from) + seq.slice(0, to);
    else return { error: 'The reverse primer sits before the forward one, so there is no product.' };
    var between = seq.slice(fwd.end, Math.max(fwd.end, rev.start));
    var body = circular && rev.end < fwd.end ? seq.slice(fwd.start) + seq.slice(0, rev.end)
      : seq.slice(fwd.start, rev.end);
    /* The product is made of the primers, not of the template under them:
       where a primer disagrees with the template, the product has what the
       primer says. That is the whole point of a mutagenic primer. */
    if (body.length >= fwd.anneal.length + rev.anneal.length) {
      body = fwd.anneal + body.slice(fwd.anneal.length, body.length - rev.anneal.length) + revcomp(rev.anneal);
    }
    var product = fwd.tail + body + revcomp(rev.tail);

    /* The product's own annotation. The body is a window onto the template,
       so the features come from the same function the digest uses, shifted
       right by the forward tail. The tails themselves are marked because
       that is where a cloning primer puts its restriction site: without them
       the added site is invisible until something is cut, which is exactly
       when a mistake becomes expensive. */
    var tailLen = fwd.tail.length;
    var features = carryFeatures({ seq: seq, features: p.features || [] },
      fwd.start, rev.end, body.length, 'Only partly inside the product');
    features.forEach(function (f) { f.start += tailLen; f.end += tailLen; });
    if (fwd.tail) {
      features.unshift({ name: "5' tail, forward primer", type: 'misc_feature',
        start: 0, end: tailLen, strand: 1, note: 'Added by the primer, not present on the template' });
    }
    if (rev.tail) {
      features.push({ name: "5' tail, reverse primer", type: 'misc_feature',
        start: product.length - rev.tail.length, end: product.length, strand: -1,
        note: 'Added by the primer, not present on the template' });
    }

    return {
      seq: product, len: product.length,
      start: fwd.start, end: rev.end,
      templateLen: body.length,
      tails: fwd.tail.length + rev.tail.length,
      features: features,
      wraps: circular && rev.end < fwd.end
    };
  }

  /* The picture: the template as a line, the two primers as arrows with their
     annealed part on the line and any 5' tail lifted clear of it, and the
     product bracketed underneath. */
  function pcrMapSvg(p, fwd, rev, opts) {
    opts = opts || {};
    var len = p.seq.length;
    if (!len || !fwd || !rev) return '';
    var W = opts.width || 880, H = 182, pad = 56, y = 92;
    var prod = pcrProduct(p, fwd, rev);
    if (prod.error) return '';
    // Show a window around the product rather than the whole plasmid.
    var margin = Math.max(40, Math.round(prod.templateLen * 0.25));
    var vs = fwd.start - margin, ve = rev.end + margin;
    var span = (prod.wraps ? len - fwd.start + rev.end : rev.end - fwd.start) + margin * 2;
    var x = function (pos) {
      var rel = prod.wraps && pos < fwd.start ? pos + len - vs : pos - vs;
      return pad + (rel / span) * (W - pad * 2);
    };
    var svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Expected PCR product" class="ln-pl-map pcr">'];
    svg.push('<line x1="' + pad + '" y1="' + y + '" x2="' + (W - pad) + '" y2="' + y + '" class="pl-axis"/>');
    // ticks
    var step = tickStep(span, 8);
    for (var t = Math.ceil(vs / step) * step; t < vs + span; t += step) {
      var tx = round(x(prod.wraps && t > len ? t - len : t));
      if (tx < pad || tx > W - pad) continue;
      svg.push('<line x1="' + tx + '" y1="' + y + '" x2="' + tx + '" y2="' + (y + 5) + '" class="pl-tick"/>');
      svg.push('<text x="' + tx + '" y="' + (y + 17) + '" class="pl-ticklabel">' + ((t % len + len) % len || len) + '</text>');
    }
    /* A 20-base primer on a 500-base product would be a few pixels wide, so
       each arrow is given a readable minimum width, anchored at the end where
       it starts reading. The tail is drawn lifted off the template, because it
       does not anneal in the first round. */
    var MINW = 58;
    function arrow(bind, above) {
      var y0 = above ? y - 20 : y + 20, lift = above ? y0 - 18 : y0 + 18;
      var ax = x(bind.start), bx = x(bind.end);
      var x1 = Math.min(ax, bx), x2 = Math.max(ax, bx);
      if (x2 - x1 < MINW) {
        if (bind.strand === 1) x2 = x1 + MINW; else x1 = x2 - MINW;
      }
      var head = 8, w = x2 - x1;
      var d = bind.strand === 1
        ? 'M' + round(x1) + ' ' + (y0 - 5) + 'h' + round(w - head) + 'l' + head + ' 5l' + (-head) + ' 5h' + round(-(w - head)) + 'z'
        : 'M' + round(x2) + ' ' + (y0 - 5) + 'h' + round(-(w - head)) + 'l' + (-head) + ' 5l' + head + ' 5h' + round(w - head) + 'z';
      var out = '<path d="' + d + '" class="pcr-primer ' + (above ? 'fwd' : 'rev') + '"><title>' + esc(bind.name || 'primer') +
        ' · ' + bind.anneal.length + ' bases annealed, Tm ' + bind.tm.toFixed(1) + ' °C' +
        (bind.tail ? ' · ' + bind.tail.length + ' base tail not annealed' : '') + '</title></path>';
      // a line from the template up to the primer, so its real position is clear
      var anchor = bind.strand === 1 ? x1 : x2;
      out += '<line x1="' + round(bind.strand === 1 ? ax : bx) + '" y1="' + y + '" x2="' + round(anchor) + '" y2="' +
        (above ? y0 + 5 : y0 - 5) + '" class="pcr-stem"/>';
      if (bind.tail) {
        var dir = bind.strand === 1 ? -1 : 1, tx0 = bind.strand === 1 ? x1 : x2;
        var tw = 42;
        out += '<path d="M' + round(tx0) + ' ' + (y0 - 5 + 5) + 'L' + round(tx0 + dir * 12) + ' ' + round(lift) +
          'L' + round(tx0 + dir * tw) + ' ' + round(lift) + '" class="pcr-tail"/>';
        out += '<text x="' + round(tx0 + dir * (tw + 4)) + '" y="' + round(lift + 3) + '" class="pcr-taillabel" text-anchor="' +
          (bind.strand === 1 ? 'end' : 'start') + '">' + bind.tail.length + ' nt tail, free</text>';
      }
      out += '<text x="' + round((x1 + x2) / 2) + '" y="' + (above ? y0 - 11 : y0 + 17) + '" class="pcr-label">' +
        esc(bind.name || (bind.strand === 1 ? 'forward' : 'reverse')) + '</text>';
      return out;
    }
    svg.push(arrow(fwd, true));
    svg.push(arrow(rev, false));
    // the product bracket
    var px1 = x(fwd.start), px2 = x(rev.end);
    svg.push('<path d="M' + round(px1) + ' 156v6h' + round(px2 - px1) + 'v-6" class="pcr-bracket"/>');
    svg.push('<text x="' + round((px1 + px2) / 2) + '" y="176" class="pcr-size">' + prod.len.toLocaleString() + ' bp product' +
      (prod.tails ? ' (' + prod.tails + ' bp from tails)' : '') + '</text>');
    svg.push('</svg>');
    return svg.join('');
  }

  // ---------- Gibson assembly ----------
  /* Primers for joining fragments end to end. Each junction is made by hanging
     the end of the piece before it onto the 5' end of the next piece's forward
     primer, so the two products share that stretch. Overlaps of 20-40 bases and
     an annealing part near 60 C are what the Gibson and NEBuilder protocols
     ask for; both are adjustable. */
  function designGibson(frags, opts) {
    opts = opts || {};
    var overlap = Math.max(15, Math.min(60, opts.overlap || 25));
    var target = opts.annealTm || 60, minA = opts.minAnneal || 18, maxA = opts.maxAnneal || 35;
    var parts = (frags || []).map(function (f) { return { name: f.name || 'fragment', seq: clean(f.seq || ''), features: f.features || [] }; })
      .filter(function (f) { return f.seq.length; });
    if (parts.length < 2) return { error: 'Gibson assembly needs a vector and at least one insert.' };
    if (parts.length > 8) return { error: 'More than seven inserts at once is beyond what Gibson reliably gives.' };
    var tooShort = parts.filter(function (f) { return f.seq.length < overlap + minA; });
    if (tooShort.length) return { error: 'Piece “' + tooShort[0].name + '” is too short for a ' + overlap + ' base overlap.' };

    // The shortest 5' stretch whose melting temperature reaches the target.
    function anneal(seq, fromEnd) {
      var best = seq.length >= maxA ? maxA : seq.length;
      for (var n = minA; n <= Math.min(maxA, seq.length); n++) {
        var sub = fromEnd ? seq.slice(seq.length - n) : seq.slice(0, n);
        if (tm(sub) >= target) { best = n; break; }
      }
      return best;
    }
    var primers = [];
    parts.forEach(function (f, i) {
      var prev = parts[(i - 1 + parts.length) % parts.length];
      var fLen = anneal(f.seq, false), rLen = anneal(f.seq, true);
      var tail = prev.seq.slice(prev.seq.length - overlap);
      var fwdAnneal = f.seq.slice(0, fLen);
      var revAnneal = revcomp(f.seq.slice(f.seq.length - rLen));
      primers.push({ fragment: f.name, dir: 'forward', tail: tail, anneal: fwdAnneal,
        seq: tail + fwdAnneal, tmAnneal: tm(fwdAnneal), tmOverlap: tm(tail), gc: gc(tail + fwdAnneal),
        name: f.name + ' F' });
      primers.push({ fragment: f.name, dir: 'reverse', tail: '', anneal: revAnneal,
        seq: revAnneal, tmAnneal: tm(revAnneal), tmOverlap: 0, gc: gc(revAnneal),
        name: f.name + ' R' });
    });
    // The assembled circle, with every feature carried across.
    var seq = '', features = [], at = 0, junctions = [];
    parts.forEach(function (f, i) {
      (f.features || []).forEach(function (g) {
        features.push({ name: g.name, type: g.type, start: at + g.start, end: at + g.end,
          strand: g.strand, color: g.color, note: g.note });
      });
      if (i) junctions.push({ at: at, between: parts[i - 1].name + ' → ' + f.name, overlap: overlap });
      seq += f.seq;
      at += f.seq.length;
    });
    junctions.push({ at: 0, between: parts[parts.length - 1].name + ' → ' + parts[0].name, overlap: overlap });
    return { primers: primers, product: { seq: seq, features: features, topology: 'circular' },
      junctions: junctions, overlap: overlap, pieces: parts.length };
  }

  /* ---------- Golden Gate ----------

     Golden Gate is restriction cloning with the awkward part removed: a
     Type IIS enzyme cuts outside its own recognition site, so the overhang
     it leaves is whatever sequence you put there. Every piece is cut with
     the same enzyme, in the same tube, and what decides which piece joins
     which is the overhangs alone.

     That is why this is not just the restriction cloning screen with a
     different enzyme list. There, you choose the order; here the order is
     a consequence of the design, and the useful thing a computer can do is
     work it out and then tell you the three ways the design is wrong:

       - an overhang that appears twice, so two pieces compete for the same
         junction and the assembly is a mixture rather than a plasmid;
       - an overhang that is its own reverse complement, so pieces join to
         each other back to front;
       - a recognition site left inside a piece, so the enzyme cuts the
         finished plasmid straight back open again.

     None of these show up as an error at the bench. They show up as white
     colonies that are wrong, a week later. */
  var TYPE_IIS = ['BsaI', 'BbsI', 'BsmBI', 'SapI'];

  function isTypeIIS(name) { return TYPE_IIS.indexOf(name) >= 0; }

  /**
   * Work out the order a set of cut pieces assemble in, and check it.
   *
   * `chosen` is [{ name, frag }] where frag came from digest(); the first
   * is treated as the vector, because the product is described relative to
   * it. Returns { ok, error?, order, product, warnings }.
   */
  function goldenGate(chosen, enzymeName) {
    var list = (chosen || []).filter(function (c) { return c && c.frag; });
    if (list.length < 2) return { ok: false, error: 'Golden Gate needs a vector and at least one insert.' };
    var enzyme = ENZYMES.filter(function (e) { return e.n === enzymeName; })[0];
    if (!enzyme) return { ok: false, error: 'Choose the Type IIS enzyme the pieces were designed for.' };

    var warnings = [], i;
    for (i = 0; i < list.length; i++) {
      var f = list[i].frag;
      if (!f.left || !f.right || !f.left.ohang || !f.right.ohang) {
        return { ok: false, error: '“' + list[i].name + '” does not have a ' + enzymeName +
          ' overhang at both ends. Pick the piece that sits between two ' + enzymeName + ' sites.' };
      }
    }

    // A site left inside a piece is a plasmid that gets cut open again.
    list.forEach(function (c) {
      if (findSites(c.frag.seq, 'linear', [enzyme]).length) {
        warnings.push('“' + c.name + '” still contains a ' + enzymeName +
          ' site, so the assembled plasmid would be cut again in the same tube.');
      }
    });

    // An overhang equal to its own reverse complement joins either way round.
    var seenPalindrome = {};
    list.forEach(function (c) {
      [c.frag.left, c.frag.right].forEach(function (end) {
        var o = end.ohang || '';
        if (o && o === revcomp(o) && !seenPalindrome[o]) {
          seenPalindrome[o] = true;
          warnings.push('The overhang ' + o + ' is its own reverse complement, so pieces carrying it can join back to front.');
        }
      });
    });

    // Two pieces offering the same overhang: the assembly is a mixture.
    var byLeft = {};
    list.forEach(function (c) {
      var k = c.frag.left.ohang;
      (byLeft[k] || (byLeft[k] = [])).push(c.name);
    });
    var clash = Object.keys(byLeft).filter(function (k) { return byLeft[k].length > 1; });
    if (clash.length) {
      return { ok: false, error: 'The overhang ' + clash[0] + ' starts both “' + byLeft[clash[0]][0] +
        '” and “' + byLeft[clash[0]][1] + '”, so there is no single order these can assemble in. ' +
        'Redesign one of them with a different overhang.' };
    }

    /* Follow the overhangs from the vector. Each step has exactly one
       answer or the design is broken, which is the whole point of checking
       for repeats first. */
    var order = [list[0]], used = {};
    used[0] = true;
    var current = list[0].frag;
    while (order.length < list.length) {
      var next = -1;
      for (i = 1; i < list.length; i++) {
        if (used[i]) continue;
        if (endsMatch(current.right, list[i].frag.left)) { next = i; break; }
      }
      if (next < 0) {
        return { ok: false, error: 'Nothing follows “' + order[order.length - 1].name + '”: its ' +
          current.right.ohang + ' overhang does not match the start of any remaining piece.' };
      }
      used[next] = true;
      order.push(list[next]);
      current = list[next].frag;
    }
    if (!endsMatch(current.right, list[0].frag.left)) {
      return { ok: false, error: 'The pieces line up but do not close into a circle: “' +
        order[order.length - 1].name + '” ends with ' + current.right.ohang + ' and the vector starts with ' +
        list[0].frag.left.ohang + '.' };
    }

    var res = ligate(order.map(function (c) { return { frag: c.frag, flip: false }; }), true);
    if (!res.ok) return { ok: false, error: res.error };

    var at = 0;
    var steps = order.map(function (c) {
      var step = { name: c.name, start: at, end: at + c.frag.seq.length,
        left: c.frag.left.ohang, right: c.frag.right.ohang, len: c.frag.seq.length, id: c.id || '' };
      at += c.frag.seq.length;
      return step;
    });

    return {
      ok: true,
      enzyme: enzymeName,
      order: steps,
      warnings: warnings,
      product: { seq: res.seq, features: res.features, topology: 'circular' }
    };
  }

  /* ---------- aligning sequencing reads ----------

     The last step of every cloning job: the sequencing came back, does it
     say what the plan said it would. The answer is a position and a base,
     so the alignment has to be one that can report an insertion as an
     insertion. A mismatch-only comparison is cheaper and would be wrong in
     the one case that matters most — a single base dropped by the synthesis
     reads as a run of twenty mismatches, which looks like a bad read, and
     the frameshift that is actually there goes unnoticed.

     Reads are found before they are aligned. A 900 base read against a
     10 kb plasmid is a needle in a haystack, and aligning the whole of one
     against the whole of the other is both slow and prone to finding a
     better-scoring piece of nonsense somewhere else. So: exact k-mers vote
     on where the read sits, and the alignment is then done in a narrow band
     around that diagonal. This is what real aligners do, for the same two
     reasons.

     Nothing here reads a trace file. A .ab1 carries per-base quality, and
     quality is what tells a real difference from a bad base call at the end
     of a read; without it the ends are trimmed by agreement instead, which
     is a weaker rule and is described as such wherever it is shown. */
  var ALIGN_K = 12;

  /* Where the read probably sits: the diagonal that the most exact k-mers
     agree on. Returns null when nothing agrees, which is the honest answer
     for a read from a different plasmid. */
  function anchorRead(template, read, k) {
    k = k || ALIGN_K;
    if (read.length < k || template.length < k) return null;
    var index = {}, i;
    for (i = 0; i + k <= template.length; i++) {
      var key = template.substr(i, k);
      (index[key] || (index[key] = [])).push(i);
    }
    var votes = {}, best = null, bestN = 0;
    // Every few bases is enough to find the diagonal and keeps this linear.
    var step = Math.max(1, Math.floor(k / 3));
    for (i = 0; i + k <= read.length; i += step) {
      var hits = index[read.substr(i, k)];
      if (!hits || hits.length > 50) continue;      // a repeat votes for nothing
      for (var h = 0; h < hits.length; h++) {
        var diag = hits[h] - i;
        var n = (votes[diag] = (votes[diag] || 0) + 1);
        if (n > bestN) { bestN = n; best = diag; }
      }
    }
    return bestN >= 2 ? { diagonal: best, votes: bestN } : null;
  }

  /* Banded global alignment of the read against a window of the template.
     The band is what makes this affordable; a read whose true alignment
     wanders further from the diagonal than the band allows is reported as
     a poor alignment rather than quietly mis-aligned.

     `offset` is where the diagonal actually runs: template base i pairs
     with read base i - offset. It has to be given, because the window is
     opened a little before the read is expected to start, and a band
     centred on i = j would then put the true alignment along its very
     edge — where the first inserted or deleted base falls straight out of
     it and the read comes back as a hundred spurious insertions. */
  /* Gaps are affine: opening one costs a great deal more than making an
     existing one longer. A flat gap penalty leaves the twenty-odd spare
     template bases at the end of a window free to be scattered through the
     last stretch of the read, because each gap it moves past buys back a
     base that happens to match — the scores tie exactly and the arrangement
     that wins is whichever the comparison happened to prefer. The read then
     ends in a shower of invented one-base gaps. Affine gaps settle it the
     way biology does: one event of twenty-four bases, not twenty-four
     events of one. */
  function bandedAlign(t, r, band, offset) {
    band = band || 24;
    offset = offset || 0;
    var n = t.length, m = r.length;
    var NEG = -1e9, MATCH = 2, MISS = -3, OPEN = -6, EXTEND = -1;
    var i, j;
    function lowest(row) { return Math.max(0, row - offset - band); }
    function highest(row) { return Math.min(m, row - offset + band); }

    // Three states per cell: the two bases paired, a gap in the read, a gap
    // in the template. Only the previous row is kept; the pointers are kept
    // for every row, but only across the band, so this stays linear.
    var pM = new Float64Array(m + 1), pD = new Float64Array(m + 1), pI = new Float64Array(m + 1);
    var cM = new Float64Array(m + 1), cD = new Float64Array(m + 1), cI = new Float64Array(m + 1);
    var ptrM = [], ptrD = [], ptrI = [], los = [];
    var endBest = -Infinity, endRow = n, endState = 'M';
    function fill(a) { for (var k = 0; k <= m; k++) a[k] = NEG; }
    fill(pM); fill(pD); fill(pI);
    pM[0] = 0;
    for (j = Math.max(1, lowest(0)); j <= highest(0); j++) pI[j] = OPEN + (j - 1) * EXTEND;
    los.push(lowest(0));

    for (i = 1; i <= n; i++) {
      var lo = lowest(i), hi = highest(i);
      var width = hi - lo + 1;
      var rM = new Uint8Array(width + 1), rD = new Uint8Array(width + 1), rI = new Uint8Array(width + 1);
      fill(cM); fill(cD); fill(cI);
      if (lo === 0) {
        /* Template bases consumed before the read has started, and they are
           free. The window is deliberately opened before the read is
           expected to begin, so charging for that padding would be charging
           the read for where this function chose to start looking. */
        cD[0] = 0;
        rD[0] = i > 1 ? 2 : 1;
      }
      for (j = Math.max(1, lo); j <= hi; j++) {
        var k = j - lo;
        var sub = (t[i - 1] === r[j - 1]) ? MATCH : MISS;
        var fromM = pM[j - 1], fromD = pD[j - 1], fromI = pI[j - 1];
        var bestPrev = fromM, whence = 1;
        if (fromD > bestPrev) { bestPrev = fromD; whence = 2; }
        if (fromI > bestPrev) { bestPrev = fromI; whence = 3; }
        cM[j] = bestPrev + sub;
        rM[k] = whence;

        var openD = pM[j] + OPEN, extD = pD[j] + EXTEND;
        if (extD > openD) { cD[j] = extD; rD[k] = 2; } else { cD[j] = openD; rD[k] = 1; }

        var openI = cM[j - 1] + OPEN, extI = cI[j - 1] + EXTEND;
        if (extI > openI) { cI[j] = extI; rI[k] = 2; } else { cI[j] = openI; rI[k] = 1; }
      }
      ptrM.push(rM); ptrD.push(rD); ptrI.push(rI); los.push(lo);
      /* Where the read could finish: any row, as long as every one of its
         bases has been used. The template bases after that are the window's
         own padding and cost nothing.

         Ending only at the far corner is what strands the read's last base
         twenty-odd columns from its neighbours whenever that column happens
         to carry the same letter — the two readings score the same, and the
         one that wins is an accident. Finishing at the earliest row with the
         best score ends the alignment on the last base that really lines up. */
      if (m >= lo && m <= hi) {
        if (cM[m] > endBest) { endBest = cM[m]; endRow = i; endState = 'M'; }
        if (cD[m] > endBest) { endBest = cD[m]; endRow = i; endState = 'D'; }
      }
      var s;
      s = pM; pM = cM; cM = s;
      s = pD; pD = cD; cD = s;
      s = pI; pI = cI; cI = s;
    }

    var out = { t: '', r: '', score: endBest };
    // Template left over past the end of the alignment: the window's padding.
    var ti = endRow, rj = m, state = endState, guard = (n + m) * 2 + 10;
    for (var tail = n; tail > endRow; tail--) { out.t = t[tail - 1] + out.t; out.r = '-' + out.r; }
    while ((ti > 0 || rj > 0) && guard-- > 0) {
      if (ti === 0) { out.t = '-' + out.t; out.r = r[rj - 1] + out.r; rj--; continue; }
      if (rj === 0 && state !== 'D') { state = 'D'; continue; }
      var k2 = rj - los[ti];
      if (k2 < 0 || k2 >= ptrM[ti - 1].length) break;     // outside the band
      var p;
      if (state === 'M') {
        p = ptrM[ti - 1][k2];
        out.t = t[ti - 1] + out.t; out.r = r[rj - 1] + out.r;
        ti--; rj--;
        state = p === 2 ? 'D' : p === 3 ? 'I' : 'M';
      } else if (state === 'D') {
        p = ptrD[ti - 1][k2];
        out.t = t[ti - 1] + out.t; out.r = '-' + out.r;
        ti--;
        state = p === 2 ? 'D' : 'M';
      } else {
        p = ptrI[ti - 1][k2];
        out.t = '-' + out.t; out.r = r[rj - 1] + out.r;
        rj--;
        state = p === 2 ? 'I' : 'M';
      }
    }
    while (ti > 0) { out.t = t[ti - 1] + out.t; out.r = '-' + out.r; ti--; }
    while (rj > 0) { out.t = '-' + out.t; out.r = r[rj - 1] + out.r; rj--; }
    return out;
  }

  /* The ends of a Sanger read are noise. With no quality scores to go on,
     the rule is agreement: walk in from each end until a window of bases
     mostly matches, and call everything before that untrimmed. It is a
     weaker rule than a quality trim and the number of trimmed bases is
     always reported, so nobody mistakes it for one. */
  function trimEnds(cols, win) {
    win = win || 10;
    var n = cols.length, i, j, ok, from = -1, to = -1;
    /* The core begins at the first run of `win` bases that all agree, and
       ends at the last one. Allowing a few disagreements inside that run
       instead would let the ragged edge creep in a base or two, and those
       bases are then reported as differences at a position nobody has any
       confidence in — the ends of a Sanger read are where the machine is
       guessing. A real difference sits inside a stretch that agrees, which
       is what this keeps. */
    for (i = 0; i + win <= n; i++) {
      ok = true;
      for (j = 0; j < win; j++) if (!cols[i + j]) { ok = false; break; }
      if (ok) { from = i; break; }
    }
    if (from < 0) return { from: 0, to: n };     // nowhere agrees: show it all
    for (i = n; i - win >= 0; i--) {
      ok = true;
      for (j = 0; j < win; j++) if (!cols[i - 1 - j]) { ok = false; break; }
      if (ok) { to = i; break; }
    }
    return to > from ? { from: from, to: to } : { from: 0, to: n };
  }

  /**
   * Align one read to a plasmid, on whichever strand fits.
   *
   * Returns { ok, reason?, strand, start, end, identity, differences: [...],
   *           aligned: { t, r }, trimmedStart, trimmedEnd, length }
   * with start/end as 0-based half-open template coordinates.
   */
  function alignRead(p, readSeq, opts) {
    opts = opts || {};
    var seq = clean(p.seq || ''), len = seq.length;
    var raw = clean(readSeq || '');
    if (!len) return { ok: false, reason: 'The record has no sequence to align against.' };
    if (raw.length < 20) return { ok: false, reason: 'That read is too short to place (' + raw.length + ' bases).' };
    var circular = p.topology === 'circular';
    // A read can run across the origin, so the template is doubled for the
    // search the same way a primer search doubles it.
    var hay = circular && len > raw.length ? seq + seq.slice(0, Math.min(len, raw.length + 50)) : seq;

    var band = opts.band || 24;
    var tries = [{ strand: 1, read: raw }, { strand: -1, read: revcomp(raw) }];
    var best = null;
    tries.forEach(function (attempt) {
      var anchor = anchorRead(hay, attempt.read, opts.k || ALIGN_K);
      if (!anchor) return;
      var from = Math.max(0, anchor.diagonal - band);
      var to = Math.min(hay.length, anchor.diagonal + attempt.read.length + band);
      if (to <= from) return;
      var window = hay.slice(from, to);
      // Where the diagonal runs inside the window, which is what the band
      // is centred on.
      var al = bandedAlign(window, attempt.read, band, anchor.diagonal - from);
      if (!best || al.score > best.al.score) {
        best = { al: al, from: from, strand: attempt.strand, read: attempt.read, votes: anchor.votes };
      }
    });
    if (!best) {
      return { ok: false, reason: 'This read does not match anywhere in the record. It may be from a different plasmid, or too poor to place.' };
    }

    /* Walk the alignment once: it is the single source of the coordinates,
       the identity and the list of differences, so they cannot disagree. */
    var al = best.al, tPos = best.from, cols = [], recs = [];
    for (var i = 0; i < al.t.length; i++) {
      var tb = al.t[i], rb = al.r[i];
      var at = tPos;
      if (tb !== '-') tPos++;
      if (tb === '-') recs.push({ col: i, kind: 'insertion', at: at, from: '', to: rb });
      else if (rb === '-') recs.push({ col: i, kind: 'deletion', at: at, from: tb, to: '' });
      else if (tb !== rb) recs.push({ col: i, kind: 'mismatch', at: at, from: tb, to: rb });
      cols.push(tb !== '-' && rb !== '-' && tb === rb);
    }
    var cut = trimEnds(cols);
    // Where the trimmed core sits on the template, and how much was dropped.
    var tBefore = 0, rBefore = 0, k;
    for (k = 0; k < cut.from; k++) { if (al.t[k] !== '-') tBefore++; if (al.r[k] !== '-') rBefore++; }
    var rAfter = 0;
    for (k = cut.to; k < al.r.length; k++) if (al.r[k] !== '-') rAfter++;
    var core = cols.slice(cut.from, cut.to);
    var same = core.filter(Boolean).length;
    var diffs = recs.filter(function (d) { return d.col >= cut.from && d.col < cut.to; })
      .map(function (d) {
        // Back onto the real plasmid, for a read that ran past the origin.
        return { kind: d.kind, at: d.at % len, from: d.from, to: d.to };
      });
    var start = tBefore + best.from;
    var tCore = 0;
    for (k = cut.from; k < cut.to; k++) if (al.t[k] !== '-') tCore++;

    return {
      ok: true,
      strand: best.strand,
      start: start % len,
      end: ((start + tCore - 1) % len) + 1,
      spans: tCore,
      wraps: circular && start + tCore > len,
      identity: core.length ? same / core.length : 0,
      differences: diffs,
      trimmedStart: rBefore,
      trimmedEnd: rAfter,
      length: best.read.length,
      aligned: { t: al.t.slice(cut.from, cut.to), r: al.r.slice(cut.from, cut.to) }
    };
  }

  /* The coverage picture: the record as a line, each read as a bar where it
     sits, every difference as a tick on it. This is the view that answers
     the question people actually open sequencing with — is the insert
     covered, and is anything wrong inside it. */
  function alignmentSvg(p, results, opts) {
    opts = opts || {};
    var len = clean(p.seq || '').length;
    if (!len) return '';
    var rows = (results || []).filter(function (r) { return r && r.ok; });
    var W = opts.width || 860, padL = 8, padR = 8, laneH = 20;
    var featH = (p.features && p.features.length) ? 16 : 0;
    var H = 34 + featH + Math.max(1, rows.length) * laneH + 16;
    var x = function (pos) { return padL + (pos / len) * (W - padL - padR); };
    var svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H +
      '" width="100%" role="img" aria-label="Where the reads sit" class="pl-cov">'];

    // The record, with its features as a thin band for orientation.
    svg.push('<line x1="' + padL + '" y1="14" x2="' + (W - padR) + '" y2="14" class="pl-axis"/>');
    svg.push('<text x="' + padL + '" y="8" class="pl-ticklabel" style="text-anchor:start;">1</text>');
    svg.push('<text x="' + (W - padR) + '" y="8" class="pl-ticklabel end">' + len.toLocaleString() + ' bp</text>');
    (p.features || []).forEach(function (f) {
      if (wraps(f)) return;
      svg.push('<rect x="' + round(x(f.start)) + '" y="22" width="' + round(Math.max(1, x(f.end) - x(f.start))) +
        '" height="10" rx="2" fill="' + esc(f.color || '#d7d7d7') + '" opacity="0.85"><title>' +
        esc(f.name) + '</title></rect>');
    });

    rows.forEach(function (r, i) {
      var y = 34 + featH + i * laneH;
      /* A read that runs across the origin is drawn as the two pieces it
         covers, because one bar from 3800 to 400 would be drawn backwards
         and read as covering everything in between. */
      var spans = r.wraps ? [[r.start, len], [0, r.end]] : [[r.start, r.end]];
      spans.forEach(function (sp) {
        var w = Math.max(2, x(sp[1]) - x(sp[0]));
        svg.push('<rect x="' + round(x(sp[0])) + '" y="' + y + '" width="' + round(w) +
          '" height="10" rx="3" class="pl-cov-read' + (r.differences.length ? ' diff' : '') + '"><title>' +
          esc(r.name || 'read') + ' · ' + (r.start + 1) + '–' + r.end + ' · ' +
          (r.strand === -1 ? 'reverse' : 'forward') + ' · ' + (r.identity * 100).toFixed(1) + '% identity' +
          '</title></rect>');
      });
      r.differences.forEach(function (d) {
        svg.push('<rect x="' + round(x(d.at) - 1) + '" y="' + (y - 2) + '" width="2.5" height="14" class="pl-cov-tick">' +
          '<title>' + esc(diffText(d)) + '</title></rect>');
      });
    });
    svg.push('</svg>');
    return svg.join('');
  }
  /* One difference in words, at 1-based positions the way the rest of the
     notebook counts. */
  function diffText(d) {
    var at = d.at + 1;
    if (d.kind === 'mismatch') return at + ': ' + d.from + ' → ' + d.to;
    if (d.kind === 'deletion') return at + ': ' + d.from + ' missing from the read';
    return at + ': ' + d.to + ' extra in the read';
  }

  /* Reads out of a pasted blob or a file: FASTA if it looks like FASTA,
     otherwise one read per run of bases. */
  function parseReads(text) {
    var s = String(text == null ? '' : text);
    var out = [];
    if (/^\s*>/.test(s)) {
      s.split(/^>/m).forEach(function (chunk) {
        if (!chunk.trim()) return;
        var nl = chunk.indexOf('\n');
        var name = (nl < 0 ? chunk : chunk.slice(0, nl)).trim() || 'read';
        var body = nl < 0 ? '' : chunk.slice(nl);
        var bases = clean(body);
        if (bases.length) out.push({ name: name, seq: bases });
      });
      return out;
    }
    var bases = clean(s);
    if (bases.length) out.push({ name: 'Pasted read', seq: bases });
    return out;
  }

  /* ---------- agarose gels ----------

     What a digest would look like on a gel, which is the form the answer is
     actually wanted in: nobody checks a clone by reading a list of fragment
     lengths, they look at a photograph and ask whether the pattern is the
     one they expected.

     Migration is log-linear in length over the range a gel resolves and
     flat outside it — fragments far too big to be separated stack just
     below the well, fragments far too small run with the dye. The range is
     what the agarose percentage buys you, which is why the percentage is a
     control here and not a constant.

     Brightness is mass, not molarity. A digest gives every fragment in
     equimolar amounts, so a 300 bp piece carries a tenth of the stain of a
     3 kb piece: the commonest reason a band somebody expected "is missing"
     is that it is there and faint. Drawing every band equally bright would
     hide exactly that.

     Nothing here models supercoiling. An uncut circular plasmid runs ahead
     of where its length says, often as two or three bands, and a lane that
     says so in words is honest where one that draws a single confident
     band would not be. */
  var GEL_RANGES = [
    { pct: 0.5, hi: 30000, lo: 1000 },
    { pct: 0.7, hi: 20000, lo: 400 },
    { pct: 1.0, hi: 10000, lo: 200 },
    { pct: 1.2, hi: 7000, lo: 150 },
    { pct: 1.5, hi: 4000, lo: 80 },
    { pct: 2.0, hi: 2000, lo: 50 },
    { pct: 3.0, hi: 1000, lo: 20 }
  ];
  /* The ladders the lab actually has in the drawer. `bright` are the heavy
     reference bands — the ones you count from without thinking. */
  var LADDERS = [
    { name: '1 kb', bands: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500], bright: [3000, 1000] },
    { name: '1 kb Plus', bands: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 700, 500, 400, 300, 200, 100], bright: [3000, 1000, 500] },
    { name: '100 bp', bands: [1517, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100], bright: [500] },
    { name: 'λ HindIII', bands: [23130, 9416, 6557, 4361, 2322, 2027, 564, 125], bright: [4361] }
  ];
  function gelRange(pct) {
    var want = Number(pct) || 1, best = GEL_RANGES[0];
    GEL_RANGES.forEach(function (g) { if (Math.abs(g.pct - want) < Math.abs(best.pct - want)) best = g; });
    return best;
  }
  /* How far down the gel a fragment runs, as a fraction of the run: 0 at the
     well, 1 at the dye front.

     Inside the resolving range this is the log-linear march everyone reads
     sizes off. Outside it the bands crowd instead of marching on, which is
     what makes 10 kb and 20 kb one fat band near the well of a 1% gel.

     The crowding is a curve that flattens, not a clamp. A clamp puts every
     oversized fragment at exactly the same height, and then two bands that
     a real gel shows as one slightly fat band are drawn as one band with
     one of them silently gone — the order of the fragments is lost at the
     very point where somebody is squinting at the top of the gel trying to
     decide whether their 12 kb backbone is there. Everything keeps its
     place; the distances just become too small to read, which is the true
     answer and is also what merges them into one drawn band downstream. */
  var GEL_EDGE = 0.012;
  function gelMigrate(bp, pct) {
    var g = gelRange(pct), n = Math.max(1, Number(bp) || 1);
    var f = (Math.log(g.hi) - Math.log(n)) / (Math.log(g.hi) - Math.log(g.lo));
    if (f < 0) return GEL_EDGE * Math.exp(f * 2.5);
    if (f > 1) return (1 - GEL_EDGE) + GEL_EDGE * (1 - Math.exp(-(f - 1) * 2.5));
    return GEL_EDGE + f * (1 - 2 * GEL_EDGE);
  }
  /* A length the way it would be said out loud. Rounded to a tenth of a kb,
     with no trailing zero, so 2000 and 2005 are both "2 kb" rather than
     "2 kb" and "2.0 kb" — two spellings of one number read as two numbers. */
  function gelBpLabel(bp) {
    if (bp < 1000) return bp + ' bp';
    return (Math.round(bp / 100) / 10) + ' kb';
  }
  /* Lengths into bands. Two fragments closer together than the gel can
     separate are one band carrying both, which is why a digest that should
     give five bands routinely shows four. */
  function gelBands(lengths, pct) {
    var rows = (lengths || []).slice().sort(function (a, b) { return b - a; }).map(function (bp) {
      return { bp: bp, bps: [bp], y: gelMigrate(bp, pct), mass: bp };
    });
    var out = [];
    rows.forEach(function (r) {
      var prev = out[out.length - 1];
      if (prev && Math.abs(prev.y - r.y) < 0.008) {
        prev.bps = prev.bps.concat(r.bps);
        prev.mass += r.mass;
        prev.y = (prev.y + r.y) / 2;
        return;
      }
      out.push(r);
    });
    var top = out.reduce(function (m, r) { return Math.max(m, r.mass); }, 1);
    out.forEach(function (r) {
      r.intensity = Math.max(0.14, Math.min(1, r.mass / top));
      r.bps.sort(function (a, b) { return b - a; });
      r.bp = r.bps[0];
      /* One band gets the short name. A band that is really two says both
         lengths exactly: "2 kb + 2 kb" would look like a mistake, and the
         whole point of the merge is that these two are not the same piece. */
      r.label = r.bps.length > 1 ? r.bps.join(' + ') + ' bp' : gelBpLabel(r.bp);
    });
    return out;
  }
  /* One lane: a ladder, or a record cut with the enzymes chosen for it. */
  function gelLane(spec, opts) {
    opts = opts || {};
    var pct = opts.percent || 1;
    spec = spec || {};
    if (spec.ladder) {
      var L = LADDERS.filter(function (x) { return x.name === spec.ladder; })[0] || LADDERS[0];
      return { kind: 'ladder', name: L.name, note: 'ladder', lengths: L.bands.slice(),
        bands: L.bands.map(function (bp) {
          return { bp: bp, bps: [bp], y: gelMigrate(bp, pct),
            intensity: L.bright.indexOf(bp) >= 0 ? 1 : 0.6, label: gelBpLabel(bp) };
        }) };
    }
    var name = spec.name || 'sample';
    var p = { seq: clean(spec.seq || ''), features: spec.features || [],
      topology: spec.topology === 'linear' ? 'linear' : 'circular' };
    if (!p.seq.length) return { kind: 'sample', name: name, bands: [], lengths: [], note: 'no sequence yet' };
    var picked = (spec.enzymes || []).filter(Boolean);
    var d = picked.length ? digest(p, picked) : { fragments: [] };
    var lengths, note, uncut = !d.fragments.length;
    if (!uncut) {
      lengths = d.fragments.map(function (f) { return f.len; });
      note = picked.join(' + ');
    } else {
      lengths = [p.seq.length];
      note = picked.length ? 'not cut by ' + picked.join(' + ') : 'uncut';
      if (p.topology === 'circular') note += ' · circular, so the real gel runs supercoiled DNA ahead of this';
    }
    return { kind: 'sample', name: name, note: note, uncut: uncut,
      lengths: lengths.slice().sort(function (a, b) { return b - a; }),
      bands: gelBands(lengths, pct) };
  }
  /* The photograph. Dark, because that is what comes off the transilluminator
     and what the pattern is recognised against. */
  function gelSvg(lanes, opts) {
    opts = opts || {};
    lanes = lanes || [];
    if (!lanes.length) return '';
    /* Lanes are as wide as the names they have to carry, between a sensible
       floor and ceiling. Fixed-width lanes either waste half the picture on
       a gel of short names or run two long ones into each other, and a lane
       header that collides with its neighbour is worse than one truncated. */
    var NAME_MAX = 18, CHARW = 6.15;
    var longest = lanes.reduce(function (m, l) {
      return Math.max(m, Math.min(NAME_MAX, (l.name || '').length));
    }, 6);
    var laneW = opts.laneW || Math.max(92, Math.min(150, Math.round(longest * CHARW) + 16));
    var padL = 54, padR = 16, headH = 52, wellH = 7, RUN = opts.run || 360;
    var W = padL + lanes.length * laneW + padR;
    var H = headH + wellH + RUN + 30;
    var wellY = headH;
    var laneX = function (i) { return padL + i * laneW; };
    var bandY = function (y) { return wellY + wellH + y * RUN; };
    /* The styles travel inside the drawing rather than in the page's
       stylesheet, so the file somebody downloads for a figure or a thesis
       looks like the gel they were shown and not like an empty rectangle. */
    var svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H +
      '" width="100%" role="img" aria-label="Simulated agarose gel" class="pl-gel">',
      '<style>' +
        '.pl-gel-bg{fill:#10211c;}' +
        '.pl-gel-well{fill:#061210;stroke:#2c4a42;stroke-width:.6;}' +
        '.pl-gel-band{fill:#d6f5e4;}' +
        '.pl-gel-guide{stroke:#7fe3b8;stroke-opacity:.14;stroke-width:1;stroke-dasharray:3 4;}' +
        '.pl-gel-size{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;fill:#7a877f;text-anchor:end;}' +
        '.pl-gel-head{font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:11px;font-weight:600;fill:#16241f;text-anchor:middle;}' +
        '.pl-gel-sub{font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:9px;fill:#7a877f;text-anchor:middle;}' +
        '.pl-gel-num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9px;fill:#9aa8a0;text-anchor:middle;}' +
      '</style>'];
    svg.push('<rect x="' + (padL - 8) + '" y="' + (wellY - 4) + '" width="' + (lanes.length * laneW + 8 + padR - 8) +
      '" height="' + (wellH + RUN + 16) + '" rx="4" class="pl-gel-bg"/>');

    // Faint guides across the gel at the ladder's bands, to read sizes off.
    var ref = lanes.filter(function (l) { return l.kind === 'ladder'; })[0];
    if (ref) {
      ref.bands.forEach(function (b) {
        svg.push('<line x1="' + (padL - 8) + '" y1="' + round(bandY(b.y)) + '" x2="' + (W - padR) +
          '" y2="' + round(bandY(b.y)) + '" class="pl-gel-guide"/>');
        svg.push('<text x="' + (padL - 12) + '" y="' + round(bandY(b.y) + 3) + '" class="pl-gel-size">' +
          esc(gelBpLabel(b.bp)) + '</text>');
      });
    }

    var fit = Math.max(6, Math.floor((laneW - 6) / CHARW));
    var clip = function (s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    lanes.forEach(function (lane, i) {
      var x = laneX(i), mid = round(x + laneW / 2), inner = laneW - 18;
      /* Numbered, because that is how a gel is talked about: "the extra band
         in lane 3". Two lanes of the same plasmid cut two ways are otherwise
         two identical headings. */
      svg.push('<text x="' + mid + '" y="14" class="pl-gel-num">' + (i + 1) + '</text>');
      svg.push('<text x="' + mid + '" y="30" class="pl-gel-head">' + esc(clip(lane.name, fit)) +
        '<title>' + esc(lane.name + (lane.note ? ' — ' + lane.note : '')) + '</title></text>');
      var sub = lane.kind === 'ladder' ? 'ladder' : (lane.note || '');
      if (sub) {
        svg.push('<text x="' + mid + '" y="43" class="pl-gel-sub">' +
          esc(clip(sub, Math.floor(fit * 1.15))) + '<title>' + esc(sub) + '</title></text>');
      }
      svg.push('<rect x="' + round(x + 9) + '" y="' + wellY + '" width="' + inner + '" height="' + wellH +
        '" rx="1.5" class="pl-gel-well"/>');
      lane.bands.forEach(function (b) {
        var h = 3.2 + b.intensity * 2.6;
        svg.push('<rect x="' + round(x + 9) + '" y="' + round(bandY(b.y) - h / 2) + '" width="' + inner +
          '" height="' + round(h) + '" rx="1.6" class="pl-gel-band" opacity="' + round(0.25 + b.intensity * 0.75) + '">' +
          '<title>' + esc(lane.name + ' · ' + b.label +
            (b.bps.length > 1 ? ' (' + b.bps.length + ' fragments, one band)' : '')) + '</title></rect>');
      });
    });
    svg.push('</svg>');
    return svg.join('');
  }

  // ---------- maps ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function round(n) { return Math.round(n * 100) / 100; }
  // A nice tick spacing: 1, 2 or 5 times a power of ten, about `target` ticks.
  function tickStep(len, target) {
    var raw = len / (target || 10), mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / mag;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
  }
  /* Put features in rows so none overlaps another in the same row. Rows are
     filled from the inside out, longest feature first. */
  function assignLanes(features, len, minGap) {
    var lanes = [], out = [];
    sortFeatures(features, len).forEach(function (f) {
      var spans = wraps(f) ? [[f.start, len], [0, f.end]] : [[f.start, f.end]];
      for (var i = 0; i < lanes.length + 1; i++) {
        var lane = lanes[i] || (lanes[i] = []);
        var clash = lane.some(function (used) {
          return spans.some(function (sp) { return sp[0] < used[1] + (minGap || 0) && used[0] < sp[1] + (minGap || 0); });
        });
        if (!clash) { spans.forEach(function (sp) { lane.push(sp); }); out.push({ f: f, lane: i }); return; }
      }
    });
    return { items: out, lanes: lanes.length };
  }

  /* A linear map: a ruler with the features as arrows above it. */
  function linearMapSvg(p, opts) {
    opts = opts || {};
    var len = p.seq.length;
    if (!len) return '';
    var W = opts.width || 880, pad = 16, trackY, H;
    var feats = drawable(p.features, len);
    var packed = assignLanes(feats, len, Math.max(1, len * 0.012));
    var laneH = 20, lanes = Math.max(1, packed.lanes);
    trackY = 26 + lanes * laneH;
    H = trackY + 46;
    var x = function (pos) { return pad + (pos / len) * (W - pad * 2); };
    var svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Linear map of ' + esc(p.name || 'plasmid') + '" class="ln-pl-map">'];

    // the backbone line
    svg.push('<line x1="' + pad + '" y1="' + trackY + '" x2="' + (W - pad) + '" y2="' + trackY + '" class="pl-axis"/>');
    var step = tickStep(len, 10);
    for (var t = 0; t <= len; t += step) {
      var tx = round(x(t));
      svg.push('<line x1="' + tx + '" y1="' + trackY + '" x2="' + tx + '" y2="' + (trackY + 6) + '" class="pl-tick"/>');
      svg.push('<text x="' + tx + '" y="' + (trackY + 18) + '" class="pl-ticklabel">' + (t === 0 ? '1' : t) + '</text>');
    }
    svg.push('<text x="' + (W - pad) + '" y="' + (trackY + 32) + '" class="pl-ticklabel end">' + len + ' bp' +
      (p.topology === 'circular' ? ' · circular' : ' · linear') + '</text>');

    // features
    packed.items.forEach(function (item) {
      var f = item.f, y = trackY - 12 - item.lane * laneH;
      var pieces = wraps(f) ? [[f.start, len], [0, f.end]] : [[f.start, f.end]];
      pieces.forEach(function (sp, idx) {
        var x1 = x(sp[0]), x2 = x(sp[1]), w = Math.max(2, x2 - x1), h = 13;
        var tip = Math.min(7, w);
        // The arrowhead goes on the piece holding the feature's real end.
        var headHere = f.strand === -1 ? idx === 0 : idx === pieces.length - 1;
        var d;
        if (f.strand === 0 || !headHere || w < 4) d = 'M' + round(x1) + ' ' + (y - h / 2) + 'h' + round(w) + 'v' + h + 'h' + round(-w) + 'z';
        else if (f.strand === 1) d = 'M' + round(x1) + ' ' + (y - h / 2) + 'h' + round(w - tip) + 'l' + round(tip) + ' ' + (h / 2) + 'l' + round(-tip) + ' ' + (h / 2) + 'h' + round(-(w - tip)) + 'z';
        else d = 'M' + round(x2) + ' ' + (y - h / 2) + 'h' + round(-(w - tip)) + 'l' + round(-tip) + ' ' + (h / 2) + 'l' + round(tip) + ' ' + (h / 2) + 'h' + round(w - tip) + 'z';
        svg.push('<path d="' + d + '" fill="' + esc(f.color) + '" class="pl-feat" data-name="' + esc(f.name) + '"><title>' +
          esc(f.name) + ' · ' + esc(f.type) + ' · ' + (f.start + 1) + '–' + f.end + ' (' + featureLen(f, len) + ' bp)</title></path>');
        if (idx === 0 && w > 26) {
          svg.push('<text x="' + round(x1 + w / 2) + '" y="' + (y + 4) + '" class="pl-featlabel" clip-path="none">' +
            esc(f.name.length > Math.floor(w / 6) ? f.name.slice(0, Math.max(1, Math.floor(w / 6))) + '…' : f.name) + '</text>');
        }
      });
    });
    svg.push('</svg>');
    return svg.join('');
  }

  /* A circular map: features as arcs, with labels around the outside. The
     canvas is sized to the labels it actually carries, so a long feature name
     widens the drawing instead of being cut off at the edge. */
  function circularMapSvg(p, opts) {
    opts = opts || {};
    var len = p.seq.length;
    if (!len) return '';
    var S = opts.size || 440;
    var R = S * 0.30, band = 13, gap = 3, CHAR = 5.6, MAXCHARS = 24;
    var feats = drawable(p.features, len);
    var packed = assignLanes(feats, len, Math.max(1, len * 0.02));
    var ang = function (pos) { return (pos / len) * Math.PI * 2 - Math.PI / 2; };

    // Work out every label first: its angle, the radius it leaves from and its
    // text. Both the width and the height follow from these.
    var items = packed.items.map(function (item) {
      var f = item.f, r1 = R + gap + item.lane * (band + 2);
      var a1 = ang(f.start), a2 = ang(wraps(f) ? f.end + len : f.end);
      var text = f.name.length > MAXCHARS ? f.name.slice(0, MAXCHARS - 1) + '…' : f.name;
      return { f: f, r1: r1, r2: r1 + band, a1: a1, a2: a2, mid: (a1 + a2) / 2, text: text };
    });
    var outerR = items.reduce(function (m, i) { return Math.max(m, i.r2); }, R);
    var widest = items.reduce(function (m, i) { return Math.max(m, i.text.length); }, 0);
    var rightN = items.filter(function (i) { return Math.cos(i.mid) >= 0; }).length;
    var W = Math.max(S, 2 * (outerR + 26 + widest * CHAR));
    var H = Math.max(S, Math.max(rightN, items.length - rightN) * 14 + 40);
    var cx = W / 2, cy = H / 2;
    var pt = function (r, a) { return [round(cx + r * Math.cos(a)), round(cy + r * Math.sin(a))]; };
    var svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + round(W) + ' ' + round(H) + '" width="100%" role="img" aria-label="Circular map of ' + esc(p.name || 'plasmid') + '" class="ln-pl-map circ">'];

    svg.push('<circle cx="' + round(cx) + '" cy="' + round(cy) + '" r="' + round(R) + '" class="pl-ring"/>');
    var step = tickStep(len, 12);
    for (var t = 0; t < len; t += step) {
      var a = ang(t), p1 = pt(R - 4, a), p2 = pt(R + 4, a), p3 = pt(R - 13, a);
      svg.push('<line x1="' + p1[0] + '" y1="' + p1[1] + '" x2="' + p2[0] + '" y2="' + p2[1] + '" class="pl-tick"/>');
      svg.push('<text x="' + p3[0] + '" y="' + (p3[1] + 3) + '" class="pl-ticklabel mid">' + (t === 0 ? '1' : t) + '</text>');
    }

    items.forEach(function (it) {
      var f = it.f, r1 = it.r1, r2 = it.r2, a1 = it.a1, a2 = it.a2;
      var sweep = a2 - a1, tipAng = Math.min(Math.abs(sweep) * 0.45, 0.12);
      var fwd = f.strand !== -1, aHead = fwd ? a2 - tipAng : a1 + tipAng, rm = (r1 + r2) / 2;
      var large = Math.abs(sweep) > Math.PI ? 1 : 0, d;
      if (f.strand === 0 || Math.abs(sweep) < 0.02) {
        d = 'M' + pt(r2, a1) + 'A' + round(r2) + ' ' + round(r2) + ' 0 ' + large + ' 1 ' + pt(r2, a2) +
          'L' + pt(r1, a2) + 'A' + round(r1) + ' ' + round(r1) + ' 0 ' + large + ' 0 ' + pt(r1, a1) + 'Z';
      } else if (fwd) {
        d = 'M' + pt(r2, a1) + 'A' + round(r2) + ' ' + round(r2) + ' 0 ' + large + ' 1 ' + pt(r2, aHead) +
          'L' + pt(rm, a2) + 'L' + pt(r1, aHead) +
          'A' + round(r1) + ' ' + round(r1) + ' 0 ' + large + ' 0 ' + pt(r1, a1) + 'Z';
      } else {
        d = 'M' + pt(r2, a2) + 'A' + round(r2) + ' ' + round(r2) + ' 0 ' + large + ' 0 ' + pt(r2, aHead) +
          'L' + pt(rm, a1) + 'L' + pt(r1, aHead) +
          'A' + round(r1) + ' ' + round(r1) + ' 0 ' + large + ' 1 ' + pt(r1, a2) + 'Z';
      }
      svg.push('<path d="' + d.replace(/(\d),(\d)/g, '$1 $2') + '" fill="' + esc(f.color) + '" class="pl-feat" data-name="' + esc(f.name) + '"><title>' +
        esc(f.name) + ' · ' + esc(f.type) + ' · ' + (f.start + 1) + '–' + f.end + ' (' + featureLen(f, len) + ' bp)</title></path>');
    });

    /* Labels sit outside the ring. Each side keeps the order of its features
       and is spread out so none sits on top of another, then nudged back if
       the run would overflow the bottom. */
    [true, false].forEach(function (isLeft) {
      var side = items.filter(function (i) { return (Math.cos(i.mid) < 0) === isLeft; })
        .sort(function (x, y) { return Math.sin(x.mid) - Math.sin(y.mid); });
      if (!side.length) return;
      var minGap = 14, prevY = -1e9;
      side.forEach(function (l) {
        l.ly = Math.max(pt(l.r2 + 12, l.mid)[1], prevY + minGap);
        prevY = l.ly;
      });
      var over = side[side.length - 1].ly - (H - 10);
      if (over > 0) side.forEach(function (l) { l.ly = Math.max(12, l.ly - over); });
      side.forEach(function (l) {
        var from = pt(l.r2 + 1, l.mid), bend = pt(l.r2 + 12, l.mid);
        var tx = isLeft ? Math.min(bend[0], cx - outerR - 16) : Math.max(bend[0], cx + outerR + 16);
        svg.push('<polyline points="' + from[0] + ',' + from[1] + ' ' + bend[0] + ',' + bend[1] + ' ' +
          round(tx) + ',' + round(l.ly) + '" class="pl-leader"/>');
        svg.push('<text x="' + round(tx + (isLeft ? -3 : 3)) + '" y="' + round(l.ly + 3) + '" class="pl-featlabel out" text-anchor="' +
          (isLeft ? 'end' : 'start') + '">' + esc(l.text) + '</text>');
      });
    });

    svg.push('<text x="' + round(cx) + '" y="' + round(cy - 6) + '" class="pl-title">' + esc(p.name || 'plasmid') + '</text>');
    svg.push('<text x="' + round(cx) + '" y="' + round(cy + 12) + '" class="pl-sub">' + len + ' bp</text>');
    svg.push('</svg>');
    return svg.join('');
  }

  return {
    IUPAC: IUPAC, CODONS: CODONS, AA3: AA3, TYPE_COLORS: TYPE_COLORS,
    clean: clean, isDna: isDna, revcomp: revcomp, gc: gc, tm: tm, molWeight: molWeight, translate: translate,
    toRna: toRna, copyForm: copyForm, COPY_FORMS: COPY_FORMS,
    colorFor: colorFor, normFeature: normFeature, wraps: wraps, featureLen: featureLen, featureSeq: featureSeq,
    sortFeatures: sortFeatures, drawable: drawable, assignLanes: assignLanes,
    parseGenBank: parseGenBank, parseSnapGene: parseSnapGene, parseFasta: parseFasta, parseRaw: parseRaw,
    parseFile: parseFile, parseLocation: parseLocation,
    toGenBank: toGenBank, toFasta: toFasta, featuresCsv: featuresCsv, csvCell: csvCell,
    diffEdit: diffEdit, applyEdit: applyEdit,
    frameString: frameString, orfs: orfs, PAM_TYPES: PAM_TYPES, findGuides: findGuides, designPegRNA: designPegRNA,
    BUILTIN_FEATURES: BUILTIN_FEATURES, labLibrary: labLibrary, annotate: annotate,
    bindPrimers: bindPrimers, pcrProduct: pcrProduct, pcrMapSvg: pcrMapSvg, designGibson: designGibson,
    digest: digest, ligate: ligate, flipFragment: flipFragment, endsMatch: endsMatch, cutEnd: cutEnd,
    describeEnd: describeEnd, enzymeSummary: enzymeSummary, sliceCirc: sliceCirc,
    ENZYMES: ENZYMES, findSites: findSites, siteCounts: siteCounts, filterSites: filterSites, nonCutters: nonCutters, siteRegex: siteRegex,
    linearMapSvg: linearMapSvg, circularMapSvg: circularMapSvg,
    TYPE_IIS: TYPE_IIS, isTypeIIS: isTypeIIS, goldenGate: goldenGate,
    anchorRead: anchorRead, bandedAlign: bandedAlign, trimEnds: trimEnds,
    alignRead: alignRead, parseReads: parseReads, alignmentSvg: alignmentSvg, diffText: diffText,
    GEL_RANGES: GEL_RANGES, LADDERS: LADDERS, gelRange: gelRange, gelMigrate: gelMigrate,
    gelBpLabel: gelBpLabel, gelBands: gelBands, gelLane: gelLane, gelSvg: gelSvg,
    xmlElements: xmlElements, unescapeXml: unescapeXml
  };
}));
