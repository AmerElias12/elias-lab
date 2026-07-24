/* ============================================================
   Elias Lab — public att-site scanner
   ------------------------------------------------------------
   Runs a REAL scan, in the visitor's browser, using the same
   pipeline as our internal GenomeScan tool:

     1. NCBI Gene  esearch  → gene ID
     2. NCBI Gene  esummary → chromosome + genomic coordinates
     3. NCBI nuccore efetch → the gene's genomic sequence
     4. IUPAC consensus scan (both strands) → attB-like sites

   The visitor is shown ONLY the number of sites. Sequences,
   positions, and scores are deliberately never rendered — those
   are what we share with collaborators.

   Consensus + geometry are kept identical to GenomeScan so the
   public count matches the lab's own number.
   ============================================================ */
(function () {
  'use strict';

  var EMAIL = 'amerelias02@gmail.com';
  var CONSENSUS = 'NNDCTTWNNNNNNNAAAGBNN';   // GenomeScan DEFAULT_CONSENSUS
  var MAX_MISMATCH = 0;                       // GenomeScan default (exact consensus match)
  var TAXID = '9606';                         // human
  var MAX_BP = 1200000;                       // guard: skip enormous loci

  var IUPAC = {
    A: 'A', T: 'T', C: 'C', G: 'G',
    R: 'AG', Y: 'CT', S: 'GC', W: 'AT', K: 'GT', M: 'AC',
    B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ATCG'
  };

  function matches(sub, cons, maxMM) {
    var mm = 0;
    for (var i = 0; i < cons.length; i++) {
      var allowed = IUPAC[cons[i]] || '';
      if (allowed.indexOf(sub[i]) === -1) { if (++mm > maxMM) return false; }
    }
    return true;
  }
  function revComp(s) {
    var c = { A: 'T', T: 'A', C: 'G', G: 'C', N: 'N' }, o = '';
    for (var i = s.length - 1; i >= 0; i--) o += (c[s[i]] || 'N');
    return o;
  }
  function countSites(seq) {
    var L = CONSENSUS.length, n = 0;
    function scan(s) {
      for (var i = 0; i <= s.length - L; i++) {
        if (matches(s.substring(i, i + L), CONSENSUS, MAX_MISMATCH)) n++;
      }
    }
    scan(seq);
    scan(revComp(seq));
    return n;
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function mailto(subject) { return 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(subject); }

  var out, input, btn, busy = false;

  function setStatus(msg) {
    out.hidden = false;
    out.className = 'scan-result busy';
    out.innerHTML = '<div class="scan-spinner" aria-hidden="true"></div><div class="scan-status">' + esc(msg) + '</div>';
  }
  function setInfo(html) { out.hidden = false; out.className = 'scan-result info'; out.innerHTML = html; }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* NCBI throttles unauthenticated callers (~3 requests/sec) and occasionally
     drops one outright, so retry with backoff before giving up. */
  async function fetchRetry(url, tries) {
    tries = tries || 3;
    var lastErr;
    for (var i = 0; i < tries; i++) {
      if (i) await sleep(400 * Math.pow(2, i - 1));
      try {
        var r = await fetch(url);
        if (r.status === 429 || r.status >= 500) { lastErr = new Error('NCBI is busy (' + r.status + ').'); continue; }
        if (!r.ok) throw new Error('NCBI request failed (' + r.status + ').');
        return r;
      } catch (e) { lastErr = e; }
    }
    throw new Error((lastErr && lastErr.message ? lastErr.message + ' ' : '') + 'Please try again in a moment.');
  }

  async function jget(url) {
    var r = await fetchRetry(url);
    return r.json();
  }

  async function lookupGene(gene) {
    var base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
    var term = gene + '[Gene Name] AND ' + TAXID + '[Taxonomy ID] AND alive[property]';
    var d = await jget(base + 'esearch.fcgi?db=gene&term=' + encodeURIComponent(term) + '&retmode=json&retmax=5');
    var ids = (d.esearchresult && d.esearchresult.idlist) || [];
    if (!ids.length) {
      d = await jget(base + 'esearch.fcgi?db=gene&term=' + encodeURIComponent(gene + '[Gene Name] AND ' + TAXID + '[Taxonomy ID]') + '&retmode=json&retmax=5');
      ids = (d.esearchresult && d.esearchresult.idlist) || [];
    }
    if (!ids.length) return null;

    var sd = await jget(base + 'esummary.fcgi?db=gene&id=' + ids[0] + '&retmode=json');
    var s = sd.result && sd.result[ids[0]];
    if (!s) return null;
    var loc = s.genomicinfo && s.genomicinfo[0];
    if (!loc || !loc.chraccver) return null;

    var a = Math.min(loc.chrstart, loc.chrstop) + 1;
    var b = Math.max(loc.chrstart, loc.chrstop) + 1;
    return {
      symbol: s.name || gene,
      description: s.description || '',
      chrom: s.chromosome ? 'chr' + s.chromosome : '',
      acc: loc.chraccver,
      start: a,
      stop: b,
      length: b - a + 1
    };
  }

  async function fetchSequence(acc, start, stop) {
    var url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=' +
      encodeURIComponent(acc) + '&rettype=fasta&retmode=text&seq_start=' + start + '&seq_stop=' + stop;
    var r = await fetchRetry(url);
    var txt = await r.text();
    return txt.replace(/^>[^\n]*\n/, '').replace(/[^ACGTNacgtn]/g, '').toUpperCase();
  }

  function showResult(gene, sites, bp) {
    var density = bp ? (sites / (bp / 1000)) : 0;
    out.hidden = false;
    out.className = 'scan-result ok';
    out.innerHTML =
      '<div class="scan-num">' + sites.toLocaleString() + '</div>' +
      '<div class="scan-cap">active attB-like site' + (sites === 1 ? '' : 's') + ' in <strong>' + esc(gene) + '</strong>' +
      (bp ? ' <span class="scan-sub">· ' + (bp / 1000).toFixed(1) + ' kb scanned · ~' + density.toFixed(1) + ' sites/kb</span>' : '') +
      '</div>' +
      '<p class="scan-note">Positions, sequences, and integration scores are withheld in this public preview. ' +
      'We share the full site map — plus a targeting and feasibility assessment — with collaborators. ' +
      '<a href="' + mailto('attB-like site analysis for ' + gene + ' — collaboration enquiry') + '">Let’s collaborate →</a></p>';
  }

  async function run() {
    if (busy) return;
    var raw = input.value.trim();
    if (!raw) { setInfo('<p class="scan-note">Enter a human gene symbol (e.g. BRCA1) to scan.</p>'); return; }

    // A pasted DNA sequence is scanned directly, no network needed.
    var seqOnly = raw.toUpperCase().replace(/\s+/g, '');
    if (seqOnly.length >= 40 && /^[ACGTN]+$/.test(seqOnly)) {
      setStatus('Scanning your sequence…');
      setTimeout(function () { showResult('your sequence', countSites(seqOnly), seqOnly.length); }, 150);
      return;
    }

    var gene = raw.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9._-]{2,20}$/.test(gene)) {
      setInfo('<p class="scan-note">That doesn’t look like a gene symbol. Try something like <strong>BRCA1</strong>, <strong>TP53</strong>, or <strong>CFTR</strong>.</p>');
      return;
    }

    busy = true; btn.disabled = true;
    try {
      setStatus('Looking up ' + gene + ' in NCBI Gene…');
      var info = await lookupGene(gene);
      if (!info) {
        setInfo('<p class="scan-note">We couldn’t find a human gene called <strong>' + esc(gene) + '</strong>. ' +
          'Check the official symbol (try <strong>BRCA1</strong>, <strong>TP53</strong>, <strong>CFTR</strong>), or ' +
          '<a href="' + mailto('attB-like scan request: ' + gene) + '">ask us to look into it →</a></p>');
        return;
      }
      if (info.length > MAX_BP) {
        setInfo('<p class="scan-note"><strong>' + esc(info.symbol) + '</strong> spans ' + (info.length / 1e6).toFixed(1) +
          ' Mb — too large for this in-browser preview. We scan loci of any size on our full GenomeScan pipeline. ' +
          '<a href="' + mailto('attB-like scan request: ' + info.symbol) + '">Ask us to scan ' + esc(info.symbol) + ' →</a></p>');
        return;
      }

      setStatus('Retrieving ' + info.symbol + ' (' + info.chrom + ', ' + (info.length / 1000).toFixed(1) + ' kb)…');
      var seq = await fetchSequence(info.acc, info.start, info.stop);
      if (seq.length < CONSENSUS.length) throw new Error('The retrieved sequence was empty. Please try again.');

      setStatus('Scanning ' + (seq.length / 1000).toFixed(1) + ' kb for attB-like sites…');
      await new Promise(function (r) { setTimeout(r, 30); });   // let the status paint
      showResult(info.symbol, countSites(seq), seq.length);
    } catch (err) {
      setInfo('<p class="scan-note">' + esc(err.message || 'Something went wrong.') + '<br>' +
        'You can also <a href="' + mailto('attB-like scan request: ' + gene) + '">ask us to run this scan for you →</a></p>');
    } finally {
      busy = false; btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    input = document.getElementById('scan-input');
    btn = document.getElementById('scan-btn');
    out = document.getElementById('scan-result');
    if (!input || !btn || !out) return;
    btn.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  });
})();
