/* ============================================================
   Elias Lab Notebook — built-in bioinformatics tools
   In-browser modal tools: gRNA primer designer, Gibson
   assembly calculator, att-like site finder. No backend.
   ============================================================ */

function openTool(id) {
  var bg = document.getElementById('ln-tool-modal-bg');
  var mc = document.getElementById('ln-tool-modal');
  bg.classList.add('open');
  if (id === 'grna') mc.innerHTML = grnaToolHTML();
  else if (id === 'gibson') mc.innerHTML = gibsonToolHTML();
  else if (id === 'att') mc.innerHTML = attToolHTML();
}
function closeTool() { document.getElementById('ln-tool-modal-bg').classList.remove('open'); }

// reverse complement + Tm helpers
function rc(seq) { return seq.split('').reverse().map(function (b) { return ({ A: 'T', T: 'A', G: 'C', C: 'G', N: 'N', a: 't', t: 'a', g: 'c', c: 'g', U: 'A', u: 'a' }[b] || b); }).join(''); }
function calcTm(seq) { var s = seq.toUpperCase().replace(/[^ATGC]/g, ''); var gc = (s.match(/[GC]/g) || []).length; var at = s.length - gc; return s.length < 14 ? 2 * at + 4 * gc : 64.9 + 41 * (gc - 16.4) / s.length; }

// ── TOOL 1: gRNA Primer Generator ──────────────────────────
function grnaToolHTML() {
  return '<button class="ln-close-btn" onclick="closeTool()">×</button>' +
    '<h3>🧬 gRNA Primer Generator for Gibson Cloning</h3>' +
    '<p style="color:#666;font-size:13px;margin-bottom:1.5rem;">Design primers to clone a gRNA into an expression vector via Gibson assembly.</p>' +
    '<div class="tool-section"><label>gRNA Target Sequence (20 bp protospacer, 5\'→3\')</label><input id="t1-grna" placeholder="ATCGATCGATCGATCGATCG" maxlength="25" oninput="this.value=this.value.toUpperCase().replace(/[^ATGCN]/g,\'\')"></div>' +
    '<div class="tool-section"><label>Left Vector Overlap (20–25 bp sequence ending at cloning site)</label><input id="t1-left" placeholder="CACCG..." oninput="this.value=this.value.toUpperCase().replace(/[^ATGCN]/g,\'\')"></div>' +
    '<div class="tool-section"><label>Right Vector Overlap (20–25 bp sequence starting after cloning site)</label><input id="t1-right" placeholder="GTTTTAGAGCTAGAAATAGC..." oninput="this.value=this.value.toUpperCase().replace(/[^ATGCN]/g,\'\')"></div>' +
    '<div class="tool-section"><label>Additional 5\' Overhang on Fwd primer (optional, e.g. G for U6 promoter)</label><input id="t1-extra" placeholder="G" maxlength="5" oninput="this.value=this.value.toUpperCase().replace(/[^ATGCN]/g,\'\')"></div>' +
    '<button class="tool-run-btn" onclick="runGrna()">Generate Primers</button>' +
    '<div id="t1-result"></div>';
}
function runGrna() {
  var grna = document.getElementById('t1-grna').value.trim();
  var left = document.getElementById('t1-left').value.trim();
  var right = document.getElementById('t1-right').value.trim();
  var extra = document.getElementById('t1-extra').value.trim();
  if (!grna) { alert('Please enter the gRNA sequence.'); return; }
  if (grna.length !== 20) { alert('gRNA protospacer should be exactly 20 bp.'); return; }
  var fwd = (left || '') + extra + grna;
  var rev = rc(right || '') + rc(grna + (extra ? extra : ''));
  var fwdTm = calcTm(fwd), revTm = calcTm(rev);
  document.getElementById('t1-result').innerHTML = '<div class="tool-result">' +
    '<div class="res-row"><span class="res-key">Forward Primer</span><span class="res-val" style="font-size:11px;">' + fwd + '</span></div>' +
    '<div class="res-row"><span class="res-key">Fwd Length / Tm</span><span class="res-val">' + fwd.length + ' bp / ' + fwdTm.toFixed(1) + '°C</span></div>' +
    '<div class="res-row"><span class="res-key">Reverse Primer</span><span class="res-val" style="font-size:11px;">' + rev + '</span></div>' +
    '<div class="res-row"><span class="res-key">Rev Length / Tm</span><span class="res-val">' + rev.length + ' bp / ' + revTm.toFixed(1) + '°C</span></div>' +
    '<div class="res-row"><span class="res-key">gRNA RC (for antisense)</span><span class="res-val" style="font-size:11px;">' + rc(grna) + '</span></div>' +
    '<p style="font-size:11px;color:#888;margin-top:.75rem;">Note: Verify primer sequences in SnapGene before ordering. Add scaffold sequence to reverse primer if needed by your vector.</p>' +
    '</div>';
}

// ── TOOL 2: Gibson Assembly Calculator ─────────────────────
function gibsonToolHTML() {
  var rows = [1, 2, 3, 4, 5].map(function (i) {
    return '<div class="tool-section"><label>Fragment ' + i + ' Sequence ' + (i > 2 ? '(optional)' : '') + '</label><textarea id="g-f' + i + '" rows="2" placeholder="Paste fragment ' + i + ' sequence..." style="font-family:monospace;font-size:12px;" oninput="this.value=this.value.toUpperCase().replace(/[^ATGCN\\s]/g,\'\').replace(/\\s/g,\'\')"></textarea></div>';
  }).join('');
  return '<button class="ln-close-btn" onclick="closeTool()">×</button>' +
    '<h3>⚙️ Gibson Assembly Calculator</h3>' +
    '<p style="color:#666;font-size:13px;margin-bottom:1.5rem;">Paste 2–5 fragment sequences to calculate overlaps and assembly parameters. Fragments should already contain the overlapping ends.</p>' +
    rows +
    '<div class="tool-section"><label>Overlap Length (bp, default 20)</label><input id="g-overlap" type="number" value="20" min="10" max="60" style="max-width:120px;font-family:inherit;"></div>' +
    '<button class="tool-run-btn" onclick="runGibson()">Calculate Assembly</button>' +
    '<div id="g-result"></div>';
}
function runGibson() {
  var frags = [1, 2, 3, 4, 5].map(function (i) { return document.getElementById('g-f' + i).value.trim(); }).filter(function (s) { return s.length > 0; });
  if (frags.length < 2) { alert('Please enter at least 2 fragment sequences.'); return; }
  var ov = parseInt(document.getElementById('g-overlap').value) || 20;
  var html = '<div class="tool-result">';
  html += '<div class="res-row"><span class="res-key">Fragments</span><span class="res-val">' + frags.length + '</span></div>';
  html += '<div class="res-row"><span class="res-key">Total Expected Size</span><span class="res-val">' + (frags.reduce(function (a, f) { return a + f.length; }, 0) - ov * (frags.length - 1)) + ' bp (after assembly)</span></div>';
  html += '<div style="margin-top:1rem;"><strong>Fragment Sizes:</strong></div>';
  frags.forEach(function (f, i) { html += '<div class="res-row"><span class="res-key">Fragment ' + (i + 1) + '</span><span class="res-val">' + f.length + ' bp</span></div>'; });
  html += '<div style="margin-top:1rem;"><strong>Overlap Analysis:</strong></div>';
  for (var i = 0; i < frags.length - 1; i++) {
    var end3 = frags[i].slice(-ov), start5 = frags[i + 1].slice(0, ov), match = end3 === start5, tm = calcTm(end3);
    html += '<div style="margin:.75rem 0;padding:.75rem;background:' + (match ? '#f0fdf4' : '#fff7ed') + ';border-radius:6px;border:1px solid ' + (match ? '#86efac' : '#fdba74') + ';">' +
      '<div style="font-weight:600;font-size:13px;margin-bottom:.3rem;">Junction F' + (i + 1) + '–F' + (i + 2) + ': ' + (match ? '✅ Match' : '⚠️ Mismatch') + '</div>' +
      '<div style="font-size:12px;font-family:monospace;color:#444;">Overlap: ' + end3 + '</div>' +
      '<div style="font-size:12px;color:#666;margin-top:.3rem;">Tm: ' + tm.toFixed(1) + '°C · Length: ' + ov + ' bp' + (!match ? ' · <strong style="color:#c2410c;">Sequences do not match at overlap!</strong>' : '') + '</div></div>';
  }
  html += '<div style="margin-top:1rem;padding:1rem;background:#eff6ff;border-radius:6px;font-size:13px;"><strong>Recommended Conditions:</strong><br>Assembly temperature: 50°C · Duration: ' + (frags.length <= 3 ? '15 min' : '45–60 min') + ' · Gibson Master Mix: NEB HiFi Assembly · Use 0.02–0.5 pmol of each fragment</div></div>';
  document.getElementById('g-result').innerHTML = html;
}

// ── TOOL 3: att-Like Sites Finder ──────────────────────────
function attToolHTML() {
  return '<button class="ln-close-btn" onclick="closeTool()">×</button>' +
    '<h3>🔍 att-Like Sites Search Tool</h3>' +
    '<p style="color:#666;font-size:13px;margin-bottom:1.5rem;">Search a DNA sequence for attB-like sites compatible with HK022 integrase. The tool scans for the conserved core sequence motif and reports positions with similarity scores.</p>' +
    '<div class="tool-section"><label>Input DNA Sequence (paste genomic or plasmid sequence)</label><textarea id="att-seq" rows="5" placeholder="Paste DNA sequence here (A/T/G/C only, any length)..." style="font-family:monospace;font-size:12px;" oninput="this.value=this.value.toUpperCase().replace(/[^ATGCN\\s]/g,\'\').replace(/\\s/g,\'\')"></textarea></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;">' +
    '<div class="tool-section"><label>Min. Similarity (%)</label><input id="att-sim" type="number" value="70" min="50" max="100" style="font-family:inherit;"></div>' +
    '<div class="tool-section"><label>Site Type</label><select id="att-type" style="font-family:inherit;"><option value="attB">attB (HK022)</option><option value="attP">attP (HK022)</option><option value="both">Both</option></select></div>' +
    '<div class="tool-section"><label>Max Results</label><input id="att-max" type="number" value="20" min="1" max="100" style="font-family:inherit;"></div>' +
    '</div>' +
    '<button class="tool-run-btn" onclick="runAttSearch()">Search Sequence</button>' +
    '<div id="att-result"></div>';
}
function runAttSearch() {
  var seq = document.getElementById('att-seq').value.trim();
  if (seq.length < 50) { alert('Please enter a sequence of at least 50 bp.'); return; }
  var minSim = parseInt(document.getElementById('att-sim').value) || 70;
  var maxRes = parseInt(document.getElementById('att-max').value) || 20;
  var ATT_CORES = {
    attB: { core: 'GTTTTTT', arm5: 'GTTGACA', arm3: 'TATAAT', label: 'attB (HK022)' },
    attP: { core: 'GTTTTTT', arm5: 'TTGACAG', arm3: 'TATAATG', label: 'attP (HK022)' }
  };
  var siteType = document.getElementById('att-type').value;
  var toSearch = siteType === 'both' ? ['attB', 'attP'] : siteType === 'attB' ? ['attB'] : ['attP'];
  var hits = [];
  toSearch.forEach(function (type) {
    var motif = ATT_CORES[type].arm5 + ATT_CORES[type].core + ATT_CORES[type].arm3;
    var wl = motif.length;
    for (var i = 0; i <= seq.length - wl; i++) {
      var win = seq.slice(i, i + wl), matches = 0;
      for (var j = 0; j < wl; j++) { if (win[j] === motif[j]) matches++; }
      var sim = Math.round(matches / wl * 100);
      if (sim >= minSim) hits.push({ pos: i + 1, seq: win, sim: sim, type: ATT_CORES[type].label, strand: '+' });
      var rcWin = rc(win), rcMatches = 0;
      for (var k = 0; k < wl; k++) { if (rcWin[k] === motif[k]) rcMatches++; }
      var rcSim = Math.round(rcMatches / wl * 100);
      if (rcSim >= minSim) hits.push({ pos: i + 1, seq: win, sim: rcSim, type: ATT_CORES[type].label, strand: '-' });
    }
  });
  hits.sort(function (a, b) { return b.sim - a.sim; });
  var topHits = hits.slice(0, maxRes);
  if (!topHits.length) { document.getElementById('att-result').innerHTML = '<div class="tool-result"><p style="color:#888;">No att-like sites found above ' + minSim + '% similarity threshold. Try lowering the minimum similarity.</p></div>'; return; }
  var html = '<div class="tool-result"><div class="res-row"><span class="res-key">Sequence Length</span><span class="res-val">' + seq.length.toLocaleString() + ' bp</span></div>' +
    '<div class="res-row"><span class="res-key">Sites Found</span><span class="res-val">' + topHits.length + ' (showing top ' + Math.min(topHits.length, maxRes) + ')</span></div>' +
    '<div style="margin-top:1rem;overflow-x:auto;"><table class="ln-table"><thead><tr><th>#</th><th>Position</th><th>Strand</th><th>Type</th><th>Similarity</th><th>Sequence</th></tr></thead><tbody>' +
    topHits.map(function (h, i) { return '<tr><td>' + (i + 1) + '</td><td>' + h.pos + '</td><td>' + h.strand + '</td><td>' + h.type + '</td><td><span style="font-weight:700;color:' + (h.sim >= 90 ? '#16a34a' : h.sim >= 80 ? '#d97706' : '#2563eb') + '">' + h.sim + '%</span></td><td style="font-family:monospace;font-size:11px;">' + esc(h.seq) + '</td></tr>'; }).join('') +
    '</tbody></table></div><p style="font-size:11px;color:#888;margin-top:.75rem;">Positions are 1-based. Verify top hits using SnapGene or Benchling. Native human attB sites typically show 85–100% similarity to the core motif.</p></div>';
  document.getElementById('att-result').innerHTML = html;
}
