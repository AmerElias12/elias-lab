/* ============================================================
   Elias Lab Notebook — plasmid page
   ------------------------------------------------------------
   One plasmid as a full page at #plasmid/<id>: where it is kept and
   how it was made, a circular and a linear map, the sequence, and
   the feature list. The maths and file reading live in js/plasmid.js.
   ============================================================ */
(function () {
  'use strict';
  var P = window.Plasmid;

  var plId = null;            // the plasmid being shown
  var plDraft = null;         // a working copy: edits only reach the inventory on Save
  var plDirty = false;
  var plSel = null;           // { start, end } of the selected bases, 0-based
  var plOpts = { complement: false, wrap: 60, find: '' };
  var plImport = null;        // files waiting in the import dialog

  // The record being edited. Everything on the page changes this copy, so
  // leaving without saving cannot alter what the rest of the notebook shows.
  function rec() { return plDraft; }
  function stored() { return (getInventory().plasmids || []).filter(function (x) { return x.id === plId; })[0] || null; }
  function startDraft() {
    var it = stored();
    plDraft = it ? JSON.parse(JSON.stringify(it)) : null;
  }
  // The plasmid in the shape js/plasmid.js works with.
  function asPlasmid(it) {
    return { name: it.name || 'Untitled plasmid', seq: P.clean(it.seq || ''),
      topology: it.topology === 'linear' ? 'linear' : 'circular',
      features: (it.features || []).map(function (f) { return P.normFeature(f, P.clean(it.seq || '').length); }).filter(Boolean),
      definition: it.insert || '' };
  }

  // ---------- getting here ----------
  function openPlasmid(id) {
    var hash = '#plasmid/' + (id || 'new');
    if (location.hash === hash) routePlasmid(); else location.hash = hash;
  }
  function routePlasmid() {
    var m = /^#plasmid\/(.+)$/.exec(location.hash);
    if (!m || !currentUser()) return;
    var id = decodeURIComponent(m[1]);
    if (id === 'new') { lnShow('inv-plasmids'); return; }   // a typed address, not a real plasmid
    if (lnCurrentSection === 'plasmid' && plId === id) return;
    if (!leavePlasmidOk()) { history.replaceState(null, '', plId ? '#plasmid/' + plId : '#'); return; }
    plId = id; plSel = null; plDirty = false;
    startDraft();
    renderPlasmid();
    lnShow('plasmid');
  }
  function leavePlasmidOk() {
    if (lnCurrentSection !== 'plasmid' || !plDirty) return true;
    if (!confirm('This plasmid has unsaved changes. Leave without saving them?')) return false;
    plDirty = false;
    return true;
  }
  function markPlDirty() {
    if (plDirty) return;
    plDirty = true;
    var st = document.getElementById('ln-pl-status');
    if (st) { st.textContent = 'Unsaved changes'; st.className = 'ln-entry-status dirty'; }
  }

  // ---------- the page ----------
  function renderPlasmid() {
    var el = document.getElementById('ln-plasmid-body');
    if (!el) return;
    var it = rec();
    if (!it) {
      el.innerHTML = '<div class="ln-entry-bar"><a href="#" class="ln-back-link" onclick="lnShow(\'inv-plasmids\');return false;">← Plasmids</a></div>' +
        '<div class="ln-empty">This plasmid could not be found. It may have been removed.</div>';
      return;
    }
    var p = asPlasmid(it), len = p.seq.length;
    el.innerHTML =
      '<div class="ln-entry-bar">' +
        '<a href="#" class="ln-back-link" onclick="lnShow(\'inv-plasmids\');return false;">← Plasmids</a>' +
        '<span id="ln-pl-status" class="ln-entry-status">' + (plDirty ? 'Unsaved changes' : 'Saved') + '</span>' +
        '<div class="ln-header-actions">' +
          '<a class="ln-add-btn ghost ln-add-link" href="#plasmid/' + esc(it.id) + '" target="_blank" rel="noopener">Open in new tab ↗</a>' +
          '<button class="ln-add-btn ghost" onclick="window.print()">🖨 Print</button>' +
          '<button class="ln-add-btn ghost" onclick="plExportMenu(this)">↓ Export</button>' +
          '<button class="ln-add-btn" id="ln-pl-save" onclick="savePlasmid()">Save</button>' +
        '</div></div>' +
      '<h2 class="ln-pl-name">' + esc(it.name || 'Untitled plasmid') + '</h2>' +
      '<div class="ln-pl-stats">' + statsHtml(p, it) + '</div>' +
      (len ? '<div class="ln-pl-maps"><div class="ln-pl-circ">' + P.circularMapSvg(p, { size: 440 }) + '</div>' +
        '<div class="ln-pl-meta-wrap">' + metaHtml(it) + '</div></div>' +
        '<div class="ln-pl-linear">' + P.linearMapSvg(p, { width: 900 }) + '</div>'
        : '<div class="ln-pl-maps"><div class="ln-pl-meta-wrap wide">' + metaHtml(it) + '</div></div>') +
      featuresHtml(p) +
      sequenceHtml(p);
    wire();
  }

  function statsHtml(p, it) {
    var len = p.seq.length;
    if (!len) return '<span class="ln-pl-stat warn">No sequence yet — import a file or paste one below</span>';
    return [
      ['Length', len.toLocaleString() + ' bp'],
      ['Topology', p.topology === 'circular' ? 'Circular' : 'Linear'],
      ['GC', P.gc(p.seq).toFixed(1) + '%'],
      ['Mass', (P.molWeight(p.seq, p.topology) / 1e6).toFixed(2) + ' MDa'],
      ['Features', String(p.features.length)]
    ].map(function (s) { return '<span class="ln-pl-stat"><em>' + s[0] + '</em>' + s[1] + '</span>'; }).join('');
  }

  var KITS = ['QIAprep Spin Miniprep', 'QIAGEN Plasmid Midi', 'QIAGEN Plasmid Maxi', 'Monarch Miniprep (NEB)',
    'ZymoPURE II Midiprep', 'NucleoSpin Plasmid (Macherey-Nagel)', 'PureLink HiPure Midiprep', 'Home-made alkaline lysis'];
  function metaHtml(it) {
    var stocks = (getInventory().stocks || []).filter(function (s) { return s.serial; });
    function row(id, label, value, hint) {
      return '<div class="ln-form-row"><label>' + label + '</label><input id="' + id + '" value="' + esc(value || '') + '"' +
        (hint ? ' placeholder="' + esc(hint) + '"' : '') + '></div>';
    }
    return '<div class="ln-pl-meta">' +
      '<div class="ln-form-section">Identity</div>' +
      row('pl-name', 'Plasmid name', it.name, 'e.g. pLenti-CMV-GFP') +
      '<div class="ln-form-grid">' + row('pl-backbone', 'Backbone', it.backbone, 'e.g. pUC19') +
        row('pl-insert', 'Insert', it.insert, 'e.g. HK022 integrase CDS') + '</div>' +
      '<div class="ln-form-grid">' + row('pl-resistance', 'Resistance', it.resistance, 'e.g. AmpR') +
        '<div class="ln-form-row"><label>Topology</label><select id="pl-topology">' +
          ['circular', 'linear'].map(function (t) { return '<option value="' + t + '"' + (it.topology === t || (t === 'circular' && !it.topology) ? ' selected' : '') + '>' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>'; }).join('') +
        '</select></div></div>' +

      '<div class="ln-form-section">Preparation</div>' +
      '<div class="ln-form-grid">' + row('pl-conc', 'Concentration', it.conc, 'e.g. 285 ng/µL') +
        '<div class="ln-form-row"><label>Extraction kit</label><input id="pl-kit" list="pl-kit-list" value="' + esc(it.kit || '') + '" placeholder="e.g. QIAprep Spin Miniprep">' +
          '<datalist id="pl-kit-list">' + KITS.map(function (k) { return '<option value="' + esc(k) + '">'; }).join('') + '</datalist></div></div>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Source glycerol stock</label><input id="pl-stock" list="pl-stock-list" value="' + esc(it.stock || '') + '" placeholder="e.g. GS-0007">' +
          '<datalist id="pl-stock-list">' + stocks.map(function (s) { return '<option value="' + esc(s.serial) + '">' + esc(s.description || '') + '</option>'; }).join('') + '</datalist>' +
          (it.stock ? stockNote(it.stock) : '') + '</div>' +
        '<div class="ln-form-row"><label>Owner</label>' + userSelect('pl-owner', it.owner || (currentUser() ? currentUser().name : '')) + '</div></div>' +

      '<div class="ln-form-section">Storage</div>' +
      '<div class="ln-form-grid">' + row('pl-freezer', 'Freezer', it.freezer, 'e.g. Freezer A') +
        '<div class="ln-form-row"><label>Box</label><input id="pl-box" list="ln-box-list" value="' + esc(it.box || '') + '" placeholder="e.g. Plasmid Box 1">' +
          (it.box ? '<div class="hint"><a href="#" onclick="openBoxByName(\'' + esc(it.box).replace(/'/g, "\\'") + '\',\'plasmids\');return false;">Open box map ▦</a></div>' : '') + '</div></div>' +
      '<div class="ln-form-grid">' + row('pl-position', 'Position', it.position, 'e.g. A3') +
        row('pl-location', 'Other location detail', it.location, 'optional') + '</div>' +
      '<datalist id="ln-box-list">' + (window.boxIndex ? boxIndex().filter(function (b) { return !b.cat || b.cat === 'plasmids'; }).map(function (b) { return '<option value="' + esc(b.name) + '">'; }).join('') : '') + '</datalist>' +

      '<div class="ln-form-section">Reference</div>' +
      row('pl-mapLink', 'Map link', it.mapLink, 'https://… (Addgene, Benchling, SnapGene)') +
      '<div class="ln-form-row"><label>Notes</label><textarea id="pl-notes">' + esc(it.notes || '') + '</textarea></div>' +
      '</div>';
  }
  function stockNote(serial) {
    var s = (getInventory().stocks || []).filter(function (x) { return String(x.serial || '').toLowerCase() === String(serial).toLowerCase(); })[0];
    if (!s) return '<div class="hint">No glycerol stock with this serial yet.</div>';
    return '<div class="hint">' + esc(s.description || '') + (s.box ? ' · ' + esc(s.box) + ' ' + esc(s.position || '') : '') + '</div>';
  }

  // ---------- features ----------
  function featuresHtml(p) {
    var len = p.seq.length;
    var rows = P.sortFeatures(p.features, len).map(function (f) {
      var i = p.features.indexOf(f);
      return '<tr><td><span class="pl-swatch" style="background:' + esc(f.color) + '"></span>' + esc(f.name) + '</td>' +
        '<td>' + esc(f.type) + '</td>' +
        '<td class="ln-nowrap">' + (f.start + 1) + '–' + f.end + (P.wraps(f) ? ' <em>(crosses origin)</em>' : '') + '</td>' +
        '<td class="ln-nowrap">' + P.featureLen(f, len) + ' bp</td>' +
        '<td>' + (f.strand === -1 ? '← reverse' : f.strand === 0 ? '—' : '→ forward') + '</td>' +
        '<td class="ln-row-actions"><button class="ln-icon-btn" onclick="plFeatureModal(' + i + ')">✎</button>' +
        '<button class="ln-icon-btn danger" onclick="plDeleteFeature(' + i + ')">✕</button></td></tr>';
    }).join('');
    return '<div class="ln-pl-panel"><div class="ln-pl-panel-head"><h3>Features <span>' + p.features.length + '</span></h3>' +
      '<div class="ln-header-actions"><button class="ln-add-btn ghost" onclick="plFeatureModal(-1)">+ Add feature</button></div></div>' +
      (p.features.length ? '<div style="overflow-x:auto;"><table class="ln-table"><thead><tr><th>Name</th><th>Type</th><th>Position</th><th>Length</th><th>Strand</th><th class="ln-row-actions">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="ln-empty" style="padding:1rem 0;">No features yet. Import a GenBank or SnapGene file to bring its annotations in, or add one by hand.</div>') +
      '</div>';
  }
  var FEATURE_TYPES = ['CDS', 'gene', 'promoter', 'terminator', 'rep_origin', 'primer_bind', 'protein_bind',
    'regulatory', 'polyA_signal', 'LTR', 'sig_peptide', 'misc_RNA', 'intron', 'exon', 'enhancer', 'RBS',
    'repeat_region', 'tag', 'misc_feature'];
  function plFeatureModal(index) {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it), len = p.seq.length;
    if (!len) { alert('Add a sequence before adding features.'); return; }
    var f = index >= 0 ? p.features[index] : null;
    var start = f ? f.start + 1 : (plSel ? plSel.start + 1 : 1);
    var end = f ? f.end : (plSel ? plSel.end : Math.min(len, 100));
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + (f ? 'Edit' : 'Add') + ' feature</h3>' +
      '<div class="ln-form-row"><label>Name</label><input id="f-name" value="' + esc(f ? f.name : '') + '" placeholder="e.g. AmpR"></div>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Type</label><input id="f-type" list="f-type-list" oninput="plTypeColor()" value="' + esc(f ? f.type : 'misc_feature') + '">' +
          '<datalist id="f-type-list">' + FEATURE_TYPES.map(function (t) { return '<option value="' + t + '">'; }).join('') + '</datalist></div>' +
        '<div class="ln-form-row"><label>Strand</label><select id="f-strand">' +
          [[1, 'Forward →'], [-1, 'Reverse ←'], [0, 'Neither']].map(function (s) { return '<option value="' + s[0] + '"' + (f && f.strand === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
        '</select></div></div>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Start (first base)</label><input type="number" id="f-start" min="1" max="' + len + '" value="' + start + '"></div>' +
        '<div class="ln-form-row"><label>End (last base)</label><input type="number" id="f-end" min="1" max="' + len + '" value="' + end + '"></div></div>' +
      '<div class="hint" style="margin:-.4rem 0 .8rem;">Positions count from 1 and include both ends. On a circular plasmid an end before the start means the feature crosses the origin.</div>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Colour</label><input type="color" id="f-color" onchange="this.dataset.auto=\'0\'"' +
          ' data-auto="' + (!f || f.color === P.colorFor(f.type) ? '1' : '0') + '" value="' + esc(f ? f.color : P.colorFor('misc_feature')) + '"></div>' +
        '<div class="ln-form-row"><label>Note</label><input id="f-note" value="' + esc(f ? f.note : '') + '"></div></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      '<button class="ln-modal-save" onclick="plSaveFeature(' + index + ')">' + (f ? 'Save feature' : 'Add feature') + '</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  /* The colour follows the type until someone picks one themselves. */
  function plTypeColor() {
    var col = document.getElementById('f-color');
    if (col && col.dataset.auto !== '0') col.value = P.colorFor(g('f-type') || 'misc_feature');
  }
  function plSaveFeature(index) {
    var it = rec(); if (!it) return;
    var len = P.clean(it.seq || '').length;
    var name = g('f-name');
    if (!name) { alert('Please give the feature a name.'); return; }
    var start = Math.round(Number(document.getElementById('f-start').value)) - 1;
    var end = Math.round(Number(document.getElementById('f-end').value));
    var f = P.normFeature({ name: name, type: g('f-type') || 'misc_feature', start: start, end: end,
      strand: Number(document.getElementById('f-strand').value), color: document.getElementById('f-color').value,
      note: g('f-note') }, len);
    if (!f) { alert('Those positions are not inside this plasmid.'); return; }
    var features = (it.features || []).slice();
    if (index >= 0) features[index] = f; else features.push(f);
    it.features = features;
    closeModal(); markPlDirty(); renderPlasmid();
  }
  function plDeleteFeature(index) {
    var it = rec(); if (!it) return;
    var f = (it.features || [])[index];
    if (!f || !confirm('Remove the feature “' + f.name + '”?')) return;
    it.features = it.features.filter(function (x, i) { return i !== index; });
    markPlDirty(); renderPlasmid();
  }

  // ---------- sequence ----------
  /* One feature per base, longest first so a short feature sits on top of the
     long one it is inside. Used to colour the sequence. */
  function colorAt(p) {
    var len = p.seq.length, arr = new Array(len);
    P.sortFeatures(P.drawable(p.features, len), len).forEach(function (f) {
      var spans = P.wraps(f) ? [[f.start, len], [0, f.end]] : [[f.start, f.end]];
      spans.forEach(function (sp) { for (var i = sp[0]; i < sp[1]; i++) arr[i] = f; });
    });
    return arr;
  }
  function findHits(seq, q) {
    var hits = [];
    q = P.clean(q);
    if (q.length < 3) return hits;
    [[q, 1], [P.revcomp(q), -1]].forEach(function (pair) {
      if (pair[1] === -1 && pair[0] === q) return;      // a palindrome, already found
      var from = 0, at;
      while ((at = seq.indexOf(pair[0], from)) >= 0 && hits.length < 500) { hits.push({ start: at, end: at + q.length, strand: pair[1] }); from = at + 1; }
    });
    return hits;
  }
  function sequenceHtml(p) {
    var len = p.seq.length;
    var head = '<div class="ln-pl-panel"><div class="ln-pl-panel-head"><h3>Sequence</h3>' +
      '<div class="ln-header-actions">' +
        '<input class="ln-search sm" id="pl-find" placeholder="🔍 Find bases (both strands)" value="' + esc(plOpts.find) + '">' +
        '<label class="ln-pl-check"><input type="checkbox" id="pl-complement"' + (plOpts.complement ? ' checked' : '') + '> Complement</label>' +
        '<button class="ln-add-btn ghost" onclick="plImportIntoThis()">⇪ Import sequence file</button>' +
        '<button class="ln-add-btn ghost" onclick="plEditSequence()">✎ Edit sequence</button>' +
      '</div></div>';
    if (!len) {
      return head + '<div class="ln-empty" style="padding:1rem 0;">No sequence yet. Use <strong>Import sequence file</strong> for a GenBank, SnapGene or FASTA file, or <strong>Edit sequence</strong> to paste one in.</div></div>';
    }
    var hits = findHits(p.seq, plOpts.find);
    var hitAt = new Array(len);
    hits.forEach(function (h) { for (var i = h.start; i < h.end && i < len; i++) hitAt[i] = true; });
    var colors = colorAt(p), per = plOpts.wrap, out = [];
    for (var lineStart = 0; lineStart < len; lineStart += per) {
      var lineEnd = Math.min(len, lineStart + per);
      var top = '', bottom = '', runStart = lineStart, i;
      for (i = lineStart; i <= lineEnd; i++) {
        var same = i < lineEnd && colors[i] === colors[runStart] && !!hitAt[i] === !!hitAt[runStart];
        if (same) continue;
        var f = colors[runStart], chunk = p.seq.slice(runStart, i);
        var style = f ? ' style="background:' + esc(f.color) + '"' : '';
        var cls = 'pl-b' + (hitAt[runStart] ? ' hit' : '');
        var title = f ? ' title="' + esc(f.name) + '"' : '';
        top += '<span class="' + cls + '" data-start="' + runStart + '"' + style + title + '>' + chunk + '</span>';
        if (plOpts.complement) bottom += '<span class="' + cls + '"' + style + '>' + chunk.split('').map(function (c) { return P.revcomp(c); }).join('') + '</span>';
        runStart = i;
      }
      out.push('<div class="pl-line"><span class="pl-num">' + (lineStart + 1) + '</span><span class="pl-bases">' + top +
        (plOpts.complement ? '<br><span class="pl-comp">' + bottom + '</span>' : '') + '</span></div>');
    }
    var selNote = '<div class="ln-pl-selnote" id="pl-selnote">' + selectionNote(p) + '</div>';
    return head + (plOpts.find && !hits.length ? '<div class="ln-bulk-note">No match for “' + esc(plOpts.find) + '” on either strand.</div>' :
      plOpts.find ? '<div class="ln-bulk-note ok">' + hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ' on both strands.</div>' : '') +
      selNote + '<div class="pl-seq" id="pl-seq">' + out.join('') + '</div></div>';
  }
  function selectionNote(p) {
    if (!plSel) return 'Select bases to see their length, GC and melting temperature — then you can make them a feature.';
    var sub = p.seq.slice(plSel.start, plSel.end);
    return '<strong>' + (plSel.start + 1) + '–' + plSel.end + '</strong> · ' + sub.length + ' bp · GC ' +
      P.gc(sub).toFixed(1) + '% · Tm ' + P.tm(sub).toFixed(1) + ' °C ' +
      '<button class="ln-icon-btn" onclick="plFeatureModal(-1)">+ Make a feature</button>' +
      '<button class="ln-icon-btn" onclick="plCopySelection()">Copy</button>' +
      '<button class="ln-icon-btn" onclick="plCopySelection(true)">Copy reverse complement</button>';
  }
  function readSelection() {
    var sel = window.getSelection();
    var box = document.getElementById('pl-seq');
    if (!sel || !sel.rangeCount || !box) return;
    var r = sel.getRangeAt(0);
    if (!box.contains(r.startContainer) || !box.contains(r.endContainer) || sel.isCollapsed) return;
    function posOf(node, offset) {
      var span = node.nodeType === 3 ? node.parentNode : node;
      while (span && !span.hasAttribute('data-start')) span = span.parentNode;
      if (!span) return null;
      return +span.getAttribute('data-start') + offset;
    }
    var a = posOf(r.startContainer, r.startOffset), b = posOf(r.endContainer, r.endOffset);
    if (a == null || b == null) return;
    var it = rec(); if (!it) return;
    var len = P.clean(it.seq).length;
    plSel = { start: Math.max(0, Math.min(a, b)), end: Math.min(len, Math.max(a, b)) };
    if (plSel.end <= plSel.start) { plSel = null; return; }
    var note = document.getElementById('pl-selnote');
    if (note) note.innerHTML = selectionNote(asPlasmid(it));
  }
  function plCopySelection(rc) {
    var it = rec(); if (!it || !plSel) return;
    var sub = P.clean(it.seq).slice(plSel.start, plSel.end);
    if (rc) sub = P.revcomp(sub);
    navigator.clipboard.writeText(sub).then(function () {
      var note = document.getElementById('pl-selnote');
      if (note) note.insertAdjacentHTML('beforeend', ' <span class="ok">copied</span>');
    }, function () { alert(sub); });
  }

  /* Editing the bases. The sequence goes into a box; on Apply the change is
     worked out and the features move with it, with anything shortened or
     dropped reported before it is kept. */
  function plEditSequence() {
    var it = rec(); if (!it) return;
    var seq = P.clean(it.seq || '');
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Edit sequence</h3>' +
      '<p class="ln-bulk-intro">Type or paste the bases. Anything that is not a base (numbers, spaces, line breaks) is ignored, so a block copied from GenBank pastes in cleanly. Features move with the change; any that lose all their bases are removed, and you will be told which.</p>' +
      '<div class="ln-form-row"><textarea id="pl-seq-edit" class="pl-seq-edit" spellcheck="false">' + esc(seq) + '</textarea>' +
      '<div class="hint" id="pl-seq-count">' + seq.length.toLocaleString() + ' bp</div></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      '<button class="ln-modal-save" onclick="plApplySequence()">Apply</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
    var box = document.getElementById('pl-seq-edit');
    box.addEventListener('input', function () {
      document.getElementById('pl-seq-count').textContent = P.clean(box.value).length.toLocaleString() + ' bp';
    });
  }
  function plApplySequence() {
    var it = rec(); if (!it) return;
    var next = P.clean(document.getElementById('pl-seq-edit').value);
    var cur = P.clean(it.seq || '');
    if (!next) { alert('The sequence cannot be empty.'); return; }
    var edit = P.diffEdit(cur, next);
    if (!edit) { closeModal(); return; }
    if (!cur) { it.seq = next; }
    else {
      var r = P.applyEdit(asPlasmid(it), edit);
      var msg = [];
      if (r.dropped.length) msg.push(r.dropped.length + ' feature(s) lost all their bases and will be removed: ' + r.dropped.slice(0, 6).join(', '));
      if (r.changed.length) msg.push(r.changed.length + ' feature(s) change length: ' + r.changed.slice(0, 6).join(', '));
      if (msg.length && !confirm(msg.join('\n\n') + '\n\nApply the change?')) return;
      it.seq = r.seq; it.features = r.features;
    }
    plSel = null;
    closeModal(); markPlDirty(); renderPlasmid();
  }

  // ---------- saving ----------
  function savePlasmid() {
    var it = rec(); if (!it) return;
    if (!stored()) { alert('This plasmid is no longer in the inventory, so it cannot be saved.'); return; }
    var name = g('pl-name');
    if (!name) { alert('Please give the plasmid a name.'); document.getElementById('pl-name').focus(); return; }
    var btn = document.getElementById('ln-pl-save'), st = document.getElementById('ln-pl-status');
    btn.disabled = true; btn.textContent = 'Saving…';
    var item = Object.assign({}, it, {
      name: name, backbone: g('pl-backbone'), insert: g('pl-insert'), resistance: g('pl-resistance'),
      topology: g('pl-topology') === 'linear' ? 'linear' : 'circular',
      conc: g('pl-conc'), kit: g('pl-kit'), stock: g('pl-stock'), owner: getSelectOrManual('pl-owner'),
      freezer: g('pl-freezer'), box: g('pl-box'), position: g('pl-position'), location: g('pl-location'),
      mapLink: g('pl-mapLink'), notes: g('pl-notes'),
      seq: P.clean(it.seq || ''), features: it.features || [], len: P.clean(it.seq || '').length
    });
    DB.upsertInventory('plasmids', item).then(function () {
      plDraft = JSON.parse(JSON.stringify(item));
      plDirty = false;
      st.textContent = 'Saved ✓ ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      st.className = 'ln-entry-status saved';
      btn.disabled = false; btn.textContent = 'Save';
      renderInventory('plasmids');
    }, function (e) {
      st.textContent = 'Not saved'; st.className = 'ln-entry-status dirty';
      btn.disabled = false; btn.textContent = 'Save';
      alert('Could not save the plasmid: ' + e.message);
    });
  }

  // ---------- importing ----------
  function readFile(file, asBinary) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      if (asBinary) r.readAsArrayBuffer(file); else r.readAsText(file);
    });
  }
  // SnapGene files are binary; everything else reads as text.
  async function parseOne(file) {
    var binary = /\.dna$/i.test(file.name);
    var data = await readFile(file, binary);
    var res = P.parseFile(file.name, binary ? new Uint8Array(data) : data);
    if (!res.ok && !binary) {                      // a stray .dna without the extension
      var buf = await readFile(file, true);
      res = P.parseFile(file.name + '.dna', new Uint8Array(buf));
    }
    return res;
  }
  function plImportIntoThis() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gb,.gbk,.genbank,.ape,.dna,.fa,.fasta,.fna,.fsa,.seq,.txt';
    input.onchange = async function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var it = rec(); if (!it) return;
      var res;
      try { res = await parseOne(file); } catch (e) { alert(e.message); return; }
      if (!res.ok) { alert(res.error); return; }
      if (P.clean(it.seq || '').length &&
        !confirm('Replace the sequence and features of this plasmid with ' + file.name + ' (' + res.plasmid.seq.length + ' bp, ' + res.plasmid.features.length + ' features)?')) return;
      it.seq = res.plasmid.seq;
      it.features = res.plasmid.features;
      it.topology = res.plasmid.topology;
      if (!it.name || /^untitled/i.test(it.name)) it.name = res.plasmid.name;
      markPlDirty(); renderPlasmid();
    };
    input.click();
  }

  /* Several sequence files at once, each becoming its own plasmid. */
  function openPlasmidImport() {
    plImport = null;
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Import plasmid sequences</h3>' +
      '<p class="ln-bulk-intro">Choose one or more sequence files. Each becomes a plasmid, keeping the annotations the file already carries.</p>' +
      '<div class="ln-bulk-step"><span class="ln-bulk-num">1</span><div><strong>Choose the files</strong>' +
        '<div class="hint">GenBank (.gb, .gbk), SnapGene (.dna), FASTA (.fa, .fasta) or a plain sequence (.txt, .seq).</div>' +
        '<input type="file" id="pl-import-files" multiple accept=".gb,.gbk,.genbank,.ape,.dna,.fa,.fasta,.fna,.fsa,.seq,.txt" onchange="plPreviewImport(this)"></div></div>' +
      '<div id="pl-import-preview"></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      '<button class="ln-modal-save" id="pl-import-save" disabled onclick="plRunImport()">Add plasmids</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  async function plPreviewImport(input) {
    var out = document.getElementById('pl-import-preview'), btn = document.getElementById('pl-import-save');
    plImport = null; btn.disabled = true;
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) { out.innerHTML = ''; return; }
    out.innerHTML = '<div class="ln-bulk-note">Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…</div>';
    var ok = [], bad = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var res = await parseOne(files[i]);
        if (res.ok) ok.push({ file: files[i], res: res }); else bad.push(files[i].name + ' — ' + res.error);
      } catch (e) { bad.push(files[i].name + ' — ' + e.message); }
    }
    plImport = ok;
    out.innerHTML = (ok.length ? '<div style="overflow-x:auto;"><table class="ln-table"><thead><tr><th>File</th><th>Name</th><th>Format</th><th>Length</th><th>Features</th></tr></thead><tbody>' +
      ok.map(function (o) {
        return '<tr><td>' + esc(o.file.name) + '</td><td>' + esc(o.res.plasmid.name) + '</td><td>' + esc(o.res.format) + '</td>' +
          '<td class="ln-nowrap">' + o.res.plasmid.seq.length.toLocaleString() + ' bp ' + (o.res.plasmid.topology === 'circular' ? '○' : '—') + '</td>' +
          '<td>' + o.res.plasmid.features.length + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '') +
      (bad.length ? '<div class="ln-bulk-note error">Could not read: ' + esc(bad.join('; ')) + '</div>' : '');
    if (ok.length) { btn.disabled = false; btn.textContent = 'Add ' + ok.length + ' plasmid' + (ok.length === 1 ? '' : 's'); }
  }
  async function plRunImport() {
    if (!plImport || !plImport.length) return;
    var btn = document.getElementById('pl-import-save'), out = document.getElementById('pl-import-preview');
    btn.disabled = true; btn.textContent = 'Adding…';
    var me = currentUser() ? currentUser().name : 'Unknown', added = 0, failed = null;
    for (var i = 0; i < plImport.length; i++) {
      var pl = plImport[i].res.plasmid;
      try {
        await DB.upsertInventory('plasmids', { id: uid(), name: pl.name, seq: pl.seq, topology: pl.topology,
          features: pl.features, len: pl.seq.length, insert: pl.definition || '', owner: me, addedBy: me });
        added++;
      } catch (e) { failed = e.message; break; }
    }
    plImport = null;
    renderInventory('plasmids');
    out.innerHTML = (added ? '<div class="ln-bulk-note ok">Added ' + added + ' plasmid' + (added === 1 ? '' : 's') + '.</div>' : '') +
      (failed ? '<div class="ln-bulk-note error">Stopped: ' + esc(failed) + '</div>' : '');
    btn.textContent = 'Done'; btn.disabled = false; btn.onclick = closeModal;
    document.getElementById('pl-import-files').value = '';
  }

  // ---------- exporting ----------
  function download(filename, text, type) {
    var url = URL.createObjectURL(new Blob(['﻿'.repeat(type === 'text/csv' ? 1 : 0) + text], { type: (type || 'text/plain') + ';charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }
  function safeName(s) { return String(s || 'plasmid').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'plasmid'; }
  function plExportMenu(btn) {
    var old = document.getElementById('pl-export-menu');
    if (old) { old.remove(); return; }
    var menu = document.createElement('div');
    menu.id = 'pl-export-menu';
    menu.className = 'ln-pl-menu';
    menu.innerHTML = [['gb', 'GenBank (.gb)'], ['fa', 'FASTA (.fa)'], ['csv', 'Features (.csv)']]
      .map(function (o) { return '<button type="button" onclick="plExport(\'' + o[0] + '\')">' + o[1] + '</button>'; }).join('');
    btn.parentNode.appendChild(menu);
    setTimeout(function () {
      document.addEventListener('click', function close(e) {
        if (menu.contains(e.target) || e.target === btn) return;
        menu.remove(); document.removeEventListener('click', close);
      });
    }, 0);
  }
  function plExport(kind) {
    var it = rec(); if (!it) return;
    var menu = document.getElementById('pl-export-menu'); if (menu) menu.remove();
    var p = asPlasmid(it), base = safeName(it.name);
    if (!p.seq.length && kind !== 'csv') { alert('This plasmid has no sequence yet.'); return; }
    if (kind === 'gb') download(base + '.gb', P.toGenBank(p));
    else if (kind === 'fa') download(base + '.fa', P.toFasta(p));
    else download(base + '-features.csv', P.featuresCsv(p), 'text/csv');
  }
  /* The whole plasmid list as CSV, including the sequence, so it can be kept
     outside the notebook or loaded into another tool. */
  function exportPlasmidsCSV() {
    var items = getInventory().plasmids || [];
    if (!items.length) { alert('There are no plasmids to export yet.'); return; }
    var cols = [['Name', 'name'], ['Backbone', 'backbone'], ['Insert', 'insert'], ['Resistance', 'resistance'],
      ['Length (bp)', null], ['Topology', 'topology'], ['Concentration', 'conc'], ['Extraction kit', 'kit'],
      ['Source glycerol stock', 'stock'], ['Owner', 'owner'], ['Freezer', 'freezer'], ['Box', 'box'],
      ['Position', 'position'], ['Other location', 'location'], ['Map link', 'mapLink'], ['Notes', 'notes'],
      ['Features', null], ['Sequence', 'seq']];
    var rows = [cols.map(function (c) { return c[0]; })].concat(items.map(function (it) {
      return cols.map(function (c) {
        if (c[0] === 'Length (bp)') return P.clean(it.seq || '').length || '';
        if (c[0] === 'Features') return (it.features || []).map(function (f) { return f.name; }).join('; ');
        return it[c[1]] == null ? '' : it[c[1]];
      });
    }));
    download('elias-lab-plasmids-' + new Date().toISOString().slice(0, 10) + '.csv',
      rows.map(function (r) { return r.map(P.csvCell).join(','); }).join('\r\n'), 'text/csv');
  }

  // ---------- events ----------
  function wire() {
    var box = document.getElementById('ln-plasmid-body');
    box.addEventListener('input', function (e) {
      if (e.target.id === 'pl-find') { plOpts.find = e.target.value; refreshSequence(); return; }
      if (e.target.closest('.ln-pl-meta')) markPlDirty();
    });
    box.addEventListener('change', function (e) {
      if (e.target.id === 'pl-complement') { plOpts.complement = e.target.checked; refreshSequence(); return; }
      if (e.target.closest('.ln-pl-meta')) markPlDirty();
    });
    var seq = document.getElementById('pl-seq');
    if (seq) seq.addEventListener('mouseup', readSelection);
    document.addEventListener('selectionchange', function () {
      if (lnCurrentSection === 'plasmid') readSelection();
    });
  }
  // Redraw only the sequence panel, so the find box keeps focus and its cursor.
  function refreshSequence() {
    var it = rec(); if (!it) return;
    var panel = document.getElementById('pl-seq');
    var p = asPlasmid(it);
    var fresh = document.createElement('div');
    fresh.innerHTML = sequenceHtml(p);
    var newSeq = fresh.querySelector('#pl-seq'), newNote = fresh.querySelector('.ln-bulk-note');
    if (panel && newSeq) panel.replaceWith(newSeq);
    var note = document.querySelector('#ln-plasmid-body .ln-pl-panel .ln-bulk-note');
    if (note) note.remove();
    if (newNote) document.getElementById('pl-selnote').insertAdjacentElement('beforebegin', newNote);
    var s2 = document.getElementById('pl-seq');
    if (s2) s2.addEventListener('mouseup', readSelection);
  }

  // ---------- opening a plasmid from the inventory list ----------
  function newPlasmid() {
    var me = currentUser() ? currentUser().name : 'Unknown';
    var item = { id: uid(), name: '', seq: '', topology: 'circular', features: [], owner: me, addedBy: me };
    DB.upsertInventory('plasmids', item).then(function () {
      renderInventory('plasmids');
      openPlasmid(item.id);
      setTimeout(function () { var n = document.getElementById('pl-name'); if (n) n.focus(); }, 80);
    }, function (e) { alert('Could not create the plasmid: ' + e.message); });
  }

  // Leaving the tab, and Ctrl/Cmd+S, behave as they do for an experiment entry.
  window.addEventListener('beforeunload', function (e) {
    if (lnCurrentSection === 'plasmid' && plDirty) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', function (e) {
    if (lnCurrentSection === 'plasmid' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); savePlasmid(); }
  });

  window.openPlasmid = openPlasmid;
  window.routePlasmid = routePlasmid;
  window.renderPlasmid = renderPlasmid;
  window.leavePlasmidOk = leavePlasmidOk;
  window.savePlasmid = savePlasmid;
  window.newPlasmid = newPlasmid;
  window.plFeatureModal = plFeatureModal;
  window.plTypeColor = plTypeColor;
  window.plSaveFeature = plSaveFeature;
  window.plDeleteFeature = plDeleteFeature;
  window.plEditSequence = plEditSequence;
  window.plApplySequence = plApplySequence;
  window.plImportIntoThis = plImportIntoThis;
  window.openPlasmidImport = openPlasmidImport;
  window.plPreviewImport = plPreviewImport;
  window.plRunImport = plRunImport;
  window.plExportMenu = plExportMenu;
  window.plExport = plExport;
  window.exportPlasmidsCSV = exportPlasmidsCSV;
  window.plCopySelection = plCopySelection;
})();
