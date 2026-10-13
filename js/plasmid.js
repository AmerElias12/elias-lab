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
    colorFor: colorFor, normFeature: normFeature, wraps: wraps, featureLen: featureLen, featureSeq: featureSeq,
    sortFeatures: sortFeatures, drawable: drawable, assignLanes: assignLanes,
    parseGenBank: parseGenBank, parseSnapGene: parseSnapGene, parseFasta: parseFasta, parseRaw: parseRaw,
    parseFile: parseFile, parseLocation: parseLocation,
    toGenBank: toGenBank, toFasta: toFasta, featuresCsv: featuresCsv, csvCell: csvCell,
    diffEdit: diffEdit, applyEdit: applyEdit,
    linearMapSvg: linearMapSvg, circularMapSvg: circularMapSvg,
    xmlElements: xmlElements, unescapeXml: unescapeXml
  };
}));
