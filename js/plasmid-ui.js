/* ============================================================
   Elias Lab Notebook — plasmid page
   ------------------------------------------------------------
   One plasmid as a full page at #plasmid/<id>: where it is kept and
   how it was made, a circular and a linear map, the sequence, and
   the feature list. The maths and file reading live in js/plasmid.js.

   The map is drawn by SeqViz through js/vector-viewer.js, and files are read
   by js/plasmid-import.js. Both are loaded before this file.
   ============================================================ */
(function () {
  'use strict';
  var P = window.Plasmid;
  var VV = window.VectorViewer;

  var plId = null;            // the plasmid being shown
  var plDraft = null;         // a working copy: edits only reach the inventory on Save
  var plDirty = false;
  var plSel = null;           // { start, end } of the selected bases, 0-based
  var plOpts = { wrap: 60, find: '', enzymes: 'unique', frame: 'off', enzymeNames: [] };
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
    plCaret = 0; plAnchor = 0; plNote = ''; plUndo = []; plRedo = [];
    startDraft();
    recomputeSites();
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
      (len ? '<div class="ln-pl-mapbox' + (p.topology === 'circular' ? '' : ' linear') + '" id="pl-map"></div>' +
        '<div class="ln-pl-mapsel" id="pl-map-selection">Drag across the map to select bases.</div>' : '') +
      '<div class="ln-pl-maps"><div class="ln-pl-meta-wrap wide">' + metaHtml(it) + '</div></div>' +
      featuresHtml(p) +
      primersHtml(p) +
      seqPanelHtml(p);
    wire();
    mountMap(p);
  }

  // ---------- the map ----------
  /* SeqViz draws it, through js/vector-viewer.js. It renders SVG rather than
     a bitmap, so every base and annotation stays a DOM node and a drag can
     report the bases it covers rather than a rectangle of pixels. That is
     what feeds both the readout under the map and the sequence editor's own
     selection.

     One viewer, not two, in SeqViz's own 'both' mode: a selection then shows
     in the circular and the linear view at once, so clicking a marker on the
     ring also points at it in the sequence. Two separate instances do work —
     they keep separate state, so each would highlight only itself — but then
     the two halves disagree about what is selected, which is the one thing
     the map is for. Showing both views side by side needs the page's width,
     which is why the details sit below the map rather than beside it.

     A linear construct gets the linear view alone: there is no circle to
     draw, and vector-viewer refuses that view rather than drawing a
     misleading one. */
  var plMap = null;

  function unmountMap() {
    if (plMap) { try { plMap.destroy(); } catch (e) {} }
    plMap = null;
  }
  function mapPayload(p) {
    return { name: p.name, seq: p.seq, topology: p.topology, features: p.features };
  }
  function mountMap(p) {
    unmountMap();
    var el = document.getElementById('pl-map');
    if (!el || !p.seq.length || !VV) return;
    try {
      plMap = VV.createViewer(el, mapPayload(p), {
        view: p.topology === 'circular' ? 'both' : 'linear', log: false, onSelect: onMapSelect });
    } catch (e) {
      el.innerHTML = '<div class="ln-pl-maperr">' + esc('The map could not be drawn: ' + e.message) + '</div>';
    }
  }
  /* After an edit the sequence has changed but the page has not, so the map is
     handed the new sequence instead of being torn down and rebuilt. When there
     is no map there is nothing to refresh: a plasmid that started empty has no
     map at all, and gains one the next time the whole page is drawn, which is
     what it did before SeqViz as well. */
  function refreshMap(p) {
    if (!plMap) return;
    try { plMap.update(mapPayload(p)); } catch (e) {}
  }
  /* SeqViz reports a selection as 0-based half-open coordinates, which is the
     convention js/plasmid.js already uses, so nothing is translated on the
     way in. The line under the map is written by vector-viewer, which knows
     how to print a selection that runs across the origin; the editor's own
     selection is a plain { start, end } and cannot hold one of those, so for
     a wrapping selection it is left where it was. */
  function onMapSelect(d) {
    var line = document.getElementById('pl-map-selection');
    if (line) line.textContent = VV.formatSelection(d);
    if (!d.length || d.crossesOrigin) return;
    var end = d.end === 0 ? edLen() : d.end;
    if (end <= d.start) return;
    plSel = { start: d.start, end: end };
    plAnchor = d.start; plCaret = end; plNote = '';
    paintSelection();
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
    return '<div class="ln-pl-panel" id="pl-features"><div class="ln-pl-panel-head"><h3>Features <span>' + p.features.length + '</span></h3>' +
      '<div class="ln-header-actions">' +
        '<button class="ln-add-btn ghost" onclick="openAnnotate()">✨ Annotate</button>' +
        '<button class="ln-add-btn ghost" onclick="openOrfs()">Find ORFs</button>' +
        '<button class="ln-add-btn ghost" onclick="plFeatureModal(-1)">+ Add feature</button></div></div>' +
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

  // ---------- the sequence editor ----------
  /* The sequence is a grid of monospace cells, so every position is worked out
     from the character width rather than from one span per base. Each block of
     bases shows, from the top: the enzymes cutting there, the two strands, and
     a ribbon per feature. The caret and the selection are ours, not the
     browser's, which keeps typing, clicking and the feature coordinates in
     step. */
  var plCaret = 0;          // 0..len, sitting before the base at this index
  var plAnchor = 0;         // where a drag or shift-select started
  var plSites = [];         // restriction sites, recomputed when typing pauses
  var plUndo = [], plRedo = [];
  var plDragging = false, plSitesTimer = null, plPanelTimer = null, plNote = '';

  function edLen() { var it = rec(); return it ? P.clean(it.seq || '').length : 0; }
  function edSeq() { var it = rec(); return it ? P.clean(it.seq || '') : ''; }
  function clampPos(x) { return Math.max(0, Math.min(edLen(), Math.round(x))); }

  function recomputeSites() {
    var it = rec();
    if (!it) { plSites = []; return; }
    plSites = P.findSites(P.clean(it.seq || ''), it.topology === 'linear' ? 'linear' : 'circular');
  }
  function scheduleSites() {
    clearTimeout(plSitesTimer);
    plSitesTimer = setTimeout(function () { recomputeSites(); renderSequenceOnly(); }, 220);
  }
  // The maps, figures and feature table cost more to draw, so they follow once
  // typing stops rather than on every keystroke.
  function schedulePanels() {
    clearTimeout(plPanelTimer);
    plPanelTimer = setTimeout(function () {
      var it = rec(); if (!it) return;
      var p = asPlasmid(it);
      var stats = document.querySelector('.ln-pl-stats');
      if (stats) stats.innerHTML = statsHtml(p, it);
      refreshMap(p);
      var feats = document.getElementById('pl-features');
      if (feats) feats.outerHTML = featuresHtml(p);
    }, 400);
  }

  function pushUndo() {
    var it = rec(); if (!it) return;
    plUndo.push({ seq: it.seq || '', features: JSON.parse(JSON.stringify(it.features || [])), caret: plCaret });
    if (plUndo.length > 40) plUndo.shift();
    plRedo.length = 0;
  }
  function restore(stack, other) {
    var it = rec(), snap = stack.pop();
    if (!it || !snap) return;
    other.push({ seq: it.seq || '', features: JSON.parse(JSON.stringify(it.features || [])), caret: plCaret });
    it.seq = snap.seq; it.features = snap.features;
    plCaret = clampPos(snap.caret); plSel = null; plNote = '';
    markPlDirty(); recomputeSites(); renderSequenceOnly(); schedulePanels();
  }

  /* One edit: take out `del` bases at `pos` and put `ins` in their place. The
     features move with it; any that lose every base are reported. */
  function edEdit(pos, del, ins) {
    var it = rec(); if (!it) return;
    ins = P.clean(ins);
    if (!del && !ins) return;
    var len = edLen();
    pos = Math.max(0, Math.min(len, pos));
    del = Math.max(0, Math.min(len - pos, del));
    pushUndo();
    var r = P.applyEdit(asPlasmid(it), { pos: pos, del: del, ins: ins });
    it.seq = r.seq; it.features = r.features;
    plNote = r.dropped.length ? r.dropped.length + ' feature(s) removed: ' + r.dropped.slice(0, 3).join(', ') : '';
    plCaret = pos + ins.length; plSel = null;
    markPlDirty(); scheduleSites(); renderSequenceOnly(); schedulePanels();
  }
  function edDeleteSelection() {
    if (!plSel) return false;
    edEdit(plSel.start, plSel.end - plSel.start, '');
    return true;
  }

  // ---- drawing ----
  function laneMap(p) {
    var packed = P.assignLanes(P.drawable(p.features, p.seq.length), p.seq.length, 0);
    var lanes = [];
    packed.items.forEach(function (i) { (lanes[i.lane] = lanes[i.lane] || []).push(i.f); });
    return lanes;
  }
  // The pieces of a feature that fall on this block of bases.
  function piecesOn(f, len, from, to) {
    var spans = P.wraps(f) ? [[f.start, len], [0, f.end]] : [[f.start, f.end]];
    return spans.map(function (sp) {
      var a = Math.max(sp[0], from), b = Math.min(sp[1], to);
      return b > a ? { a: a, b: b, isStart: a === sp[0] && sp[0] === f.start, isEnd: b === sp[1] && sp[1] === f.end } : null;
    }).filter(Boolean);
  }
  function ribbonHtml(f, len, from, to) {
    return piecesOn(f, len, from, to).map(function (pc) {
      var cols = pc.b - pc.a, label = f.name;
      var head = f.strand === 1 ? pc.isEnd : f.strand === -1 ? pc.isStart : false;
      var cls = 'pl-rib' + (f.strand === -1 ? ' rev' : f.strand === 1 ? ' fwd' : '') + (head ? ' head' : '');
      if (label.length + 1 > cols) label = cols >= 4 ? label.slice(0, cols - 1) + '…' : '';
      return '<span class="' + cls + '" style="left:' + (pc.a - from) + 'ch;width:' + cols + 'ch;background:' + esc(f.color) + '"' +
        ' title="' + esc(f.name + ' · ' + f.type + ' · ' + (f.start + 1) + '–' + f.end) + '">' + esc(label) + '</span>';
    }).join('');
  }
  /* Enzyme labels are put on as few rows as will hold them without overlapping. */
  function enzymeRows(sites, from, to) {
    var marks = sites.filter(function (h) { return h.cutTop >= from && h.cutTop < to; })
      .sort(function (a, b) { return a.cutTop - b.cutTop; });
    var rows = [];
    marks.forEach(function (h) {
      var col = h.cutTop - from, width = h.name.length;
      for (var i = 0; ; i++) {
        var row = rows[i] || (rows[i] = { used: -1, items: [] });
        if (col > row.used) { row.used = col + width; row.items.push({ h: h, col: col }); break; }
      }
    });
    return rows.map(function (row) {
      return '<div class="pl-enz">' + row.items.map(function (m) {
        return '<span class="pl-enz-mark" style="left:' + m.col + 'ch" title="' +
          esc(m.h.name + ' · ' + m.h.site + ' · cuts top ' + (m.h.cutTop + 1) + ', bottom ' + (m.h.cutBottom + 1) +
            (m.h.blunt ? ' (blunt)' : ' (sticky)')) + '">' + esc(m.h.name) + '</span>';
      }).join('') + '</div>';
    }).reverse().join('');   // the row nearest the bases holds the leftmost labels
  }
  function boxesHtml(ranges, from, to, cls) {
    return ranges.map(function (r) {
      var a = Math.max(r[0], from), b = Math.min(r[1], to);
      return b > a ? '<span class="' + cls + '" style="left:' + (a - from) + 'ch;width:' + (b - a) + 'ch"></span>' : '';
    }).join('');
  }
  function findRanges(seq, q) {
    var out = [];
    q = P.clean(q);
    if (q.length < 3) return out;
    [q, P.revcomp(q)].forEach(function (needle, i) {
      if (i && needle === q) return;
      var from = 0, at;
      while ((at = seq.indexOf(needle, from)) >= 0 && out.length < 800) { out.push([at, at + needle.length]); from = at + 1; }
    });
    return out;
  }

  /* The reading frame to show. "atg" means: start at the first ATG at or
     after the selection and stop at its stop codon, which is the frame people
     actually want to read. */
  function frameSpec(p) {
    var mode = plOpts.frame, len = p.seq.length;
    if (!mode || mode === 'off' || !len) return null;
    if (mode === 'atg') {
      var from = plSel ? plSel.start : 0;
      var at = p.seq.indexOf('ATG', from);
      if (at < 0) at = p.seq.indexOf('ATG');
      if (at < 0) return null;
      var to = len;
      for (var i = at; i + 2 < len; i += 3) {
        if ((P.CODONS[p.seq.substr(i, 3)] || 'X') === '*') { to = i + 3; break; }
      }
      return { frame: at % 3, strand: 1, from: at, to: to, label: 'from the ATG at ' + (at + 1) };
    }
    var n = parseInt(mode, 10);
    return { frame: (Math.abs(n) - 1) % 3, strand: n < 0 ? -1 : 1, from: 0, to: len, label: 'frame ' + mode };
  }
  function frameRowHtml(p, fs, from, to) {
    if (!fs) return '';
    var row = P.frameString(p.seq, fs.frame, from, to, fs.strand);
    if (fs.from > from || fs.to < to) {
      row = row.split('').map(function (ch, i) {
        var pos = from + i;
        return (pos >= fs.from && pos < fs.to) ? ch : ' ';
      }).join('');
    }
    return '<div class="pl-strand aa">' + esc(row) + '</div>';
  }
  /* Which cut sites the sequence shows: by how often the enzyme cuts, or a
     list chosen by hand in the enzyme dialog. */
  function shownSites() {
    if (plOpts.enzymes === 'none') return [];
    if (plOpts.enzymes === 'custom') {
      var want = plOpts.enzymeNames;
      return plSites.filter(function (h) { return want.indexOf(h.name) >= 0; });
    }
    return P.filterSites(plSites, plOpts.enzymes);
  }
  function seqPanelHtml(p) {
    var len = p.seq.length, per = plOpts.wrap;
    var counts = P.siteCounts(plSites);
    var shown = shownSites();
    var head = '<div class="ln-pl-panel"><div class="ln-pl-panel-head"><h3>Sequence</h3>' +
      '<div class="ln-header-actions">' +
        '<input class="ln-search sm" id="pl-find" placeholder="🔍 Find bases (both strands)" value="' + esc(plOpts.find) + '">' +
        '<label class="ln-pl-check">Enzymes <select id="pl-enzymes">' +
          [['none', 'Hidden'], ['unique', 'Unique cutters'], ['two', 'Cutting once or twice'], ['all', 'All sites'], ['custom', 'Chosen by hand\u2026']]
            .map(function (o) { return '<option value="' + o[0] + '"' + (plOpts.enzymes === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="ln-pl-check">Frame <select id="pl-frame">' +
          [['off', 'Off'], ['atg', 'From first ATG'], ['1', '+1'], ['2', '+2'], ['3', '+3'], ['-1', '−1'], ['-2', '−2'], ['-3', '−3']]
            .map(function (o) { return '<option value="' + o[0] + '"' + (plOpts.frame === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></label>' +
        '<button class="ln-add-btn ghost" onclick="openEnzymePanel()">Enzymes…</button>' +
        '<button class="ln-add-btn ghost" onclick="openClone()">✂ Clone</button>' +
        '<button class="ln-add-btn ghost" onclick="openGuides()">CRISPR</button>' +
        '<button class="ln-add-btn ghost" onclick="plImportIntoThis()">⇪ Import sequence file</button>' +
      '</div></div>';

    var hits = findRanges(p.seq, plOpts.find);
    var fs = frameSpec(p);
    var lanes = laneMap(p);
    var rows = [];
    var total = Math.max(1, Math.ceil(len / per));
    for (var li = 0; li < total; li++) {
      var from = li * per, to = Math.min(len, from + per), cols = to - from;
      var top = p.seq.slice(from, to);
      var bottom = top.split('').map(function (c) { return P.revcomp(c); }).join('');
      var ribbons = lanes.map(function (lane) {
        var html = lane.map(function (f) { return ribbonHtml(f, len, from, to); }).join('');
        return html ? '<div class="pl-lane">' + html + '</div>' : '<div class="pl-lane"></div>';
      }).join('');
      rows.push('<div class="pl-row"><div class="pl-gutter">' + (from + 1) + '</div>' +
        '<div class="pl-track" data-from="' + from + '" style="width:' + Math.max(cols, 1) + 'ch">' +
        (plOpts.enzymes === 'none' ? '' : enzymeRows(shown, from, to)) +
        '<div class="pl-boxes">' + boxesHtml(hits, from, to, 'pl-hit') +
          (plSel ? boxesHtml([[plSel.start, plSel.end]], from, to, 'pl-selbox') : '') + '</div>' +
        '<div class="pl-strand top">' + esc(top) + '</div>' +
        '<div class="pl-strand bot">' + esc(bottom) + '</div>' +
        frameRowHtml(p, fs, from, to) +
        ribbons +
        (plCaret >= from && plCaret <= to && (plCaret < to || to === len) ? '<span class="pl-caret" style="left:' + (plCaret - from) + 'ch"></span>' : '') +
        '</div></div>');
    }
    var sum = Object.keys(counts).length;
    return head +
      '<div class="pl-edbar">' + editorNote(p, shown, sum) + '</div>' +
      '<div class="pl-ed" id="pl-ed" tabindex="0" role="textbox" aria-label="Plasmid sequence" aria-multiline="true">' +
      (len ? rows.join('') : '<div class="pl-empty-seq">Click here and type or paste a sequence, drop a GenBank, SnapGene or FASTA file anywhere on this page, or use <strong>Import sequence file</strong>.</div>') +
      '</div></div>';
  }
  function editorNote(p, shown, cutters) {
    if (plNote) return '<span class="warn">' + esc(plNote) + '</span>';
    if (plSel) {
      var sub = p.seq.slice(plSel.start, plSel.end);
      return '<strong>' + (plSel.start + 1) + '–' + plSel.end + '</strong> · ' + sub.length + ' bp · GC ' +
        P.gc(sub).toFixed(1) + '% · Tm ' + P.tm(sub).toFixed(1) + ' °C' +
        '<button class="ln-icon-btn" onclick="plFeatureModal(-1)">+ Make a feature</button>' +
        '<button class="ln-icon-btn" onclick="plCopySelection()">Copy</button>' +
        '<button class="ln-icon-btn" onclick="plCopySelection(true)">Copy reverse complement</button>';
    }
    var where = p.seq.length ? 'Position <strong>' + (plCaret + 1) + '</strong>' : 'Empty';
    var enz = plOpts.enzymes === 'none' ? '' : ' · ' + shown.length + ' site' + (shown.length === 1 ? '' : 's') +
      ' from ' + cutters + ' enzyme' + (cutters === 1 ? '' : 's') + ' shown';
    var fs = frameSpec(p);
    return where + ' · type to edit, drag to select' + enz + (fs ? ' · amino acids ' + esc(fs.label) : '');
  }

  // ---- caret, selection and typing ----
  function charWidth() {
    var el = document.querySelector('#pl-ed .pl-strand.top');
    if (!el || !el.textContent.length) return 0;
    return el.getBoundingClientRect().width / el.textContent.length;
  }
  function posFromEvent(e) {
    var track = e.target.closest ? e.target.closest('.pl-track') : null;
    if (!track) return null;
    var from = +track.getAttribute('data-from');
    var strand = track.querySelector('.pl-strand.top');
    var box = strand.getBoundingClientRect();
    var cw = box.width / Math.max(1, strand.textContent.length);
    var off = cw ? Math.round((e.clientX - box.left) / cw) : 0;
    return clampPos(from + Math.max(0, Math.min(strand.textContent.length, off)));
  }
  function setCaret(pos, extend) {
    plCaret = clampPos(pos);
    if (extend) {
      var a = Math.min(plAnchor, plCaret), b = Math.max(plAnchor, plCaret);
      plSel = b > a ? { start: a, end: b } : null;
    } else { plAnchor = plCaret; plSel = null; }
    plNote = '';
    paintSelection();
    scrollCaretIntoView();
  }
  /* The bases, ribbons and enzyme marks do not change when the caret moves, so
     only the highlight layer, the caret and the line above them are redrawn.
     That keeps dragging smooth and leaves the rest of the DOM alone. */
  function paintSelection() {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it), len = p.seq.length, per = plOpts.wrap;
    var hits = findRanges(p.seq, plOpts.find);
    Array.prototype.forEach.call(document.querySelectorAll('#pl-ed .pl-track'), function (track) {
      var from = +track.getAttribute('data-from'), to = Math.min(len, from + per);
      var boxes = track.querySelector('.pl-boxes');
      if (boxes) boxes.innerHTML = boxesHtml(hits, from, to, 'pl-hit') +
        (plSel ? boxesHtml([[plSel.start, plSel.end]], from, to, 'pl-selbox') : '');
      var caret = track.querySelector('.pl-caret');
      var here = plCaret >= from && plCaret <= to && (plCaret < to || to === len);
      if (here) {
        if (!caret) { caret = document.createElement('span'); caret.className = 'pl-caret'; track.appendChild(caret); }
        caret.style.left = (plCaret - from) + 'ch';
      } else if (caret) caret.remove();
    });
    var bar = document.querySelector('.pl-edbar');
    if (bar) bar.innerHTML = editorNote(p, shownSites(), Object.keys(P.siteCounts(plSites)).length);
  }
  function edMouseDown(e) {
    var pos = posFromEvent(e);
    if (pos == null) return;
    e.preventDefault();
    document.getElementById('pl-ed').focus();
    plDragging = true;
    // A plain click starts a new selection here; shift-clicking extends the
    // one already running, so its anchor has to stay put.
    if (!e.shiftKey) plAnchor = pos;
    setCaret(pos, e.shiftKey);
  }
  function edMouseMove(e) {
    if (!plDragging) return;
    var pos = posFromEvent(e);
    if (pos == null) {
      // The pointer has wandered off the bases: follow the nearest line so the
      // selection keeps growing instead of freezing.
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var track = under && under.closest ? under.closest('.pl-track') : null;
      if (track) pos = posFromEvent({ target: track, clientX: e.clientX });
    }
    if (pos != null) setCaret(pos, true);
  }
  function edMouseUp() { plDragging = false; }

  var BASE_KEY = /^[acgtunrysmwkbdhvACGTUNRYSMWKBDHV]$/;
  function edKeyDown(e) {
    if (lnCurrentSection !== 'plasmid') return;
    var len = edLen(), per = plOpts.wrap, key = e.key;
    if (e.metaKey || e.ctrlKey) {
      var k = key.toLowerCase();
      if (k === 'a') { e.preventDefault(); plAnchor = 0; plSel = len ? { start: 0, end: len } : null; plCaret = len; plNote = ''; paintSelection(); return; }
      if (k === 'c') { e.preventDefault(); plCopySelection(); return; }
      if (k === 'x') { e.preventDefault(); if (plSel) { plCopySelection(); edDeleteSelection(); } return; }
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); restore(plUndo, plRedo); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); restore(plRedo, plUndo); return; }
      return;                      // leave the rest to the browser (paste included)
    }
    if (key === 'ArrowLeft') { e.preventDefault(); setCaret(plCaret - 1, e.shiftKey); return; }
    if (key === 'ArrowRight') { e.preventDefault(); setCaret(plCaret + 1, e.shiftKey); return; }
    if (key === 'ArrowUp') { e.preventDefault(); setCaret(plCaret - per, e.shiftKey); return; }
    if (key === 'ArrowDown') { e.preventDefault(); setCaret(plCaret + per, e.shiftKey); return; }
    if (key === 'Home') { e.preventDefault(); setCaret(plCaret - (plCaret % per), e.shiftKey); return; }
    if (key === 'End') { e.preventDefault(); setCaret(Math.min(len, plCaret - (plCaret % per) + per), e.shiftKey); return; }
    if (key === 'PageUp') { e.preventDefault(); setCaret(plCaret - per * 10, e.shiftKey); return; }
    if (key === 'PageDown') { e.preventDefault(); setCaret(plCaret + per * 10, e.shiftKey); return; }
    if (key === 'Backspace') { e.preventDefault(); if (!edDeleteSelection() && plCaret > 0) edEdit(plCaret - 1, 1, ''); return; }
    if (key === 'Delete') { e.preventDefault(); if (!edDeleteSelection() && plCaret < len) edEdit(plCaret, 1, ''); return; }
    if (BASE_KEY.test(key)) {
      e.preventDefault();
      var at = plSel ? plSel.start : plCaret, del = plSel ? plSel.end - plSel.start : 0;
      edEdit(at, del, key.toUpperCase());
    }
  }
  function edPaste(e) {
    if (lnCurrentSection !== 'plasmid') return;
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text') || '';
    var bases = P.clean(text);
    if (!bases) { plNote = 'Nothing in the clipboard looked like a sequence.'; renderSequenceOnly(); return; }
    var at = plSel ? plSel.start : plCaret, del = plSel ? plSel.end - plSel.start : 0;
    edEdit(at, del, bases);
  }
  function plCopySelection(rc) {
    var it = rec(); if (!it || !plSel) return;
    var sub = P.clean(it.seq).slice(plSel.start, plSel.end);
    if (rc) sub = P.revcomp(sub);
    navigator.clipboard.writeText(sub).then(function () {
      plNote = (rc ? 'Reverse complement' : 'Selection') + ' copied (' + sub.length + ' bp).';
      paintSelection();
    }, function () { alert(sub); });
  }

  /* Redraw the sequence alone, keeping where the page was scrolled and which
     element had focus, so typing never jumps. */
  function renderSequenceOnly() {
    var it = rec(); if (!it) return;
    var panel = document.getElementById('pl-ed');
    if (!panel) return;
    var wrap = panel.closest('.ln-pl-panel');
    var scroll = panel.scrollTop, hadFocus = document.activeElement === panel;
    var find = document.getElementById('pl-find');
    var findFocus = document.activeElement === find, caretAt = find ? find.selectionStart : 0;
    var fresh = document.createElement('div');
    fresh.innerHTML = seqPanelHtml(asPlasmid(it));
    wrap.replaceWith(fresh.firstElementChild);
    var ed = document.getElementById('pl-ed');
    ed.scrollTop = scroll;
    if (hadFocus) ed.focus();
    if (findFocus) {
      var f2 = document.getElementById('pl-find');
      f2.focus(); try { f2.setSelectionRange(caretAt, caretAt); } catch (err) { }
    }
    scrollCaretIntoView();
  }
  function scrollCaretIntoView() {
    var caret = document.querySelector('#pl-ed .pl-caret');
    if (!caret) return;
    var ed = document.getElementById('pl-ed');
    var c = caret.getBoundingClientRect(), b = ed.getBoundingClientRect();
    if (c.top < b.top + 4) ed.scrollTop -= (b.top - c.top) + 30;
    else if (c.bottom > b.bottom - 4) ed.scrollTop += (c.bottom - b.bottom) + 30;
  }

  // ---------- annotation ----------
  /* What to look for: the built-in standard elements plus every feature the
     lab already has on its other plasmids. */
  function libraries(skipId) {
    return P.BUILTIN_FEATURES.concat(P.labLibrary(getInventory().plasmids || [], skipId));
  }
  var plProposed = null;
  function openAnnotate() {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it);
    if (!p.seq.length) { alert('Add a sequence before annotating.'); return; }
    var lib = libraries(it.id);
    plProposed = P.annotate(p, lib);
    var labCount = lib.length - P.BUILTIN_FEATURES.length;
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Annotate features</h3>' +
      '<p class="ln-bulk-intro">Looked through ' + lib.length + ' known elements: ' + P.BUILTIN_FEATURES.length +
      ' standard ones built in (tags, primer sites, loxP, FRT, 2A peptides) and ' + labCount +
      ' taken from your other plasmids. Anything already annotated here is left out.</p>' +
      (plProposed.length
        ? '<div style="max-height:46vh;overflow:auto;"><table class="ln-table"><thead><tr><th><input type="checkbox" id="pl-ann-all" checked onchange="plAnnToggleAll(this)"></th>' +
          '<th>Name</th><th>Type</th><th>Position</th><th>Length</th><th>Strand</th><th>Found by</th></tr></thead><tbody>' +
          plProposed.map(function (f, i) {
            return '<tr><td><input type="checkbox" class="pl-ann-pick" data-i="' + i + '" checked></td>' +
              '<td><span class="pl-swatch" style="background:' + esc(f.color) + '"></span>' + esc(f.name) + '</td>' +
              '<td>' + esc(f.type) + '</td><td class="ln-nowrap">' + (f.start + 1) + '–' + f.end + '</td>' +
              '<td class="ln-nowrap">' + P.featureLen(f, p.seq.length) + ' bp</td>' +
              '<td>' + (f.strand === -1 ? '←' : '→') + '</td>' +
              '<td>' + (f.how === 'protein' ? 'protein match' : 'sequence') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="ln-empty" style="padding:1rem 0;">Nothing new found. Import more plasmids from GenBank or SnapGene files and their features become part of the library.</div>') +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      (plProposed.length ? '<button class="ln-modal-save" onclick="plAddAnnotations()">Add selected</button>' : '') + '</div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function plAnnToggleAll(box) {
    Array.prototype.forEach.call(document.querySelectorAll('.pl-ann-pick'), function (c) { c.checked = box.checked; });
  }
  function plAddAnnotations() {
    var it = rec(); if (!it || !plProposed) return;
    var picked = Array.prototype.filter.call(document.querySelectorAll('.pl-ann-pick'), function (c) { return c.checked; })
      .map(function (c) { return plProposed[+c.getAttribute('data-i')]; }).filter(Boolean);
    if (!picked.length) { closeModal(); return; }
    it.features = (it.features || []).concat(picked.map(function (f) {
      return { name: f.name, type: f.type, start: f.start, end: f.end, strand: f.strand, color: f.color, note: f.note || '' };
    }));
    plProposed = null;
    closeModal(); markPlDirty(); renderPlasmid();
  }

  // ---------- open reading frames ----------
  var plOrfs = null;
  function openOrfs() {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it);
    if (!p.seq.length) { alert('Add a sequence first.'); return; }
    plOrfListHtml(p, 100);
  }
  function plOrfListHtml(p, minAa) {
    plOrfs = P.orfs(p.seq, p.topology, minAa);
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Open reading frames</h3>' +
      '<p class="ln-bulk-intro">Every ATG that runs to a stop codon, on both strands. Add the ones you want as CDS features.</p>' +
      '<div class="ln-form-row" style="max-width:220px;"><label>Shortest to show (amino acids)</label>' +
      '<input type="number" id="pl-orf-min" min="10" step="10" value="' + minAa + '" onchange="plOrfRefresh()"></div>' +
      (plOrfs.length
        ? '<div style="max-height:44vh;overflow:auto;"><table class="ln-table"><thead><tr><th><input type="checkbox" checked onchange="plOrfToggleAll(this)"></th>' +
          '<th>Position</th><th>Strand</th><th>Length</th><th>Starts with</th></tr></thead><tbody>' +
          plOrfs.map(function (o, i) {
            return '<tr><td><input type="checkbox" class="pl-orf-pick" data-i="' + i + '"' + (i < 5 ? ' checked' : '') + '></td>' +
              '<td class="ln-nowrap">' + (o.start + 1) + '–' + o.end + '</td>' +
              '<td>' + (o.strand === -1 ? '← reverse' : '→ forward') + '</td>' +
              '<td class="ln-nowrap">' + o.len + ' aa</td>' +
              '<td><code>' + esc(o.aa.slice(0, 24)) + (o.aa.length > 24 ? '…' : '') + '</code></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="ln-empty" style="padding:1rem 0;">No reading frame that long. Try a smaller number.</div>') +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      (plOrfs.length ? '<button class="ln-modal-save" onclick="plAddOrfs()">Add as CDS features</button>' : '') + '</div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function plOrfRefresh() {
    var it = rec(); if (!it) return;
    plOrfListHtml(asPlasmid(it), Math.max(10, +document.getElementById('pl-orf-min').value || 100));
  }
  function plOrfToggleAll(box) {
    Array.prototype.forEach.call(document.querySelectorAll('.pl-orf-pick'), function (c) { c.checked = box.checked; });
  }
  function plAddOrfs() {
    var it = rec(); if (!it || !plOrfs) return;
    var len = P.clean(it.seq).length;
    var picked = Array.prototype.filter.call(document.querySelectorAll('.pl-orf-pick'), function (c) { return c.checked; })
      .map(function (c) { return plOrfs[+c.getAttribute('data-i')]; }).filter(Boolean);
    var added = picked.map(function (o, i) {
      return P.normFeature({ name: 'ORF ' + (o.start + 1) + '–' + o.end + ' (' + o.len + ' aa)', type: 'CDS',
        start: o.start, end: o.end, strand: o.strand }, len);
    }).filter(Boolean);
    it.features = (it.features || []).concat(added);
    plOrfs = null;
    closeModal(); markPlDirty(); renderPlasmid();
  }

  // ---------- CRISPR guides and pegRNA ----------
  /* The standard SpCas9 sgRNA scaffold, shown so a guide can be ordered whole.
     Check it against your own supplier's sequence before ordering. */
  var SGRNA_SCAFFOLD = 'GTTTTAGAGCTAGAAATAGCAAGTTAAAATAAGGCTAGTCCGTTATCAACTTGAAAAAGTGGCACCGAGTCGGTGC';
  var plGuides = null, plGuideOpts = { pam: 'SpCas9 (NGG)', region: 'all' };
  function openGuides() {
    var it = rec(); if (!it) return;
    if (!P.clean(it.seq || '').length) { alert('Add a sequence first.'); return; }
    plGuideHtml();
  }
  function plGuideHtml() {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it);
    var region = plGuideOpts.region === 'sel' && plSel ? { start: plSel.start, end: plSel.end } : null;
    plGuides = P.findGuides(p.seq, p.topology, plGuideOpts.pam, region).slice(0, 300);
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>CRISPR guides</h3>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Nuclease / PAM</label><select id="pl-pam" onchange="plGuideSet()">' +
          Object.keys(P.PAM_TYPES).map(function (k) { return '<option value="' + esc(k) + '"' + (k === plGuideOpts.pam ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="ln-form-row"><label>Where to look</label><select id="pl-guide-region" onchange="plGuideSet()">' +
          '<option value="all"' + (plGuideOpts.region === 'all' ? ' selected' : '') + '>The whole plasmid</option>' +
          '<option value="sel"' + (plGuideOpts.region === 'sel' ? ' selected' : '') + '>' + (plSel ? 'The selected bases (' + (plSel.start + 1) + '–' + plSel.end + ')' : 'The selection (none yet)') + '</option>' +
        '</select></div></div>' +
      '<p class="ln-bulk-intro">Off-targets counts how often the same protospacer appears elsewhere <strong>in this plasmid</strong>. It says nothing about the genome — check that separately.</p>' +
      (plGuides.length
        ? '<div style="max-height:40vh;overflow:auto;"><table class="ln-table"><thead><tr><th>Protospacer</th><th>PAM</th><th>Cuts at</th><th>Strand</th><th>GC</th><th>Repeats</th><th></th></tr></thead><tbody>' +
          plGuides.map(function (gd, i) {
            return '<tr><td><code>' + esc(gd.spacer) + '</code></td><td><code>' + esc(gd.pam) + '</code></td>' +
              '<td class="ln-nowrap">' + (gd.cutAt + 1) + '</td><td>' + (gd.strand === -1 ? '←' : '→') + '</td>' +
              '<td class="ln-nowrap">' + gd.gc.toFixed(0) + '%</td>' +
              '<td>' + (gd.offTargets ? '<span class="warn">' + gd.offTargets + '</span>' : '0') + '</td>' +
              '<td class="ln-nowrap"><button class="ln-icon-btn" onclick="plAnnotateGuide(' + i + ')">Annotate</button>' +
              '<button class="ln-icon-btn" onclick="plPegModal(' + i + ')">pegRNA</button></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="ln-empty" style="padding:1rem 0;">No guide with that PAM here.</div>') +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Close</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function plGuideSet() {
    plGuideOpts.pam = document.getElementById('pl-pam').value;
    plGuideOpts.region = document.getElementById('pl-guide-region').value;
    plGuideHtml();
  }
  function plAnnotateGuide(i) {
    var it = rec(), gd = plGuides && plGuides[i];
    if (!it || !gd) return;
    var len = P.clean(it.seq).length;
    var f = P.normFeature({ name: 'gRNA ' + gd.spacer.slice(0, 8) + '…', type: 'gRNA',
      start: gd.start, end: gd.end, strand: gd.strand, note: 'PAM ' + gd.pam + ', cuts at ' + (gd.cutAt + 1) }, len);
    if (!f) return;
    it.features = (it.features || []).concat([f]);
    closeModal(); markPlDirty(); renderPlasmid();
  }
  function plPegModal(i) {
    var it = rec(), gd = plGuides && plGuides[i];
    if (!it || !gd) return;
    var at = plSel ? plSel.start : gd.cutAt;
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Design a pegRNA</h3>' +
      '<p class="ln-bulk-intro">Prime editing with the guide <code>' + esc(gd.spacer) + '</code>, which nicks at ' + (gd.cutAt + 1) +
      '. The edit has to sit downstream of the nick on the same strand.</p>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Edit starts at (base)</label><input type="number" id="peg-at" value="' + (at + 1) + '" min="1"></div>' +
        '<div class="ln-form-row"><label>Bases to remove</label><input type="number" id="peg-del" value="0" min="0"></div></div>' +
      '<div class="ln-form-row"><label>Bases to insert (leave empty for a deletion)</label><input id="peg-ins" placeholder="e.g. GGG"></div>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>PBS length</label><input type="number" id="peg-pbs" value="13" min="8" max="17"></div>' +
        '<div class="ln-form-row"><label>RT template length</label><input type="number" id="peg-rtt" value="13" min="8" max="30"></div></div>' +
      '<div id="peg-out"></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="openGuides()">← Back</button>' +
      '<button class="ln-modal-save" onclick="plPegRun(' + i + ')">Design</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function plPegRun(i) {
    var it = rec(), gd = plGuides && plGuides[i];
    if (!it || !gd) return;
    var p = asPlasmid(it);
    var peg = P.designPegRNA(p.seq, p.topology, gd, {
      at: Math.max(0, (+document.getElementById('peg-at').value || 1) - 1),
      del: Math.max(0, +document.getElementById('peg-del').value || 0),
      ins: document.getElementById('peg-ins').value
    }, { pbs: +document.getElementById('peg-pbs').value || 13, rtt: +document.getElementById('peg-rtt').value || 13 });
    var out = document.getElementById('peg-out');
    if (!peg || peg.error) { out.innerHTML = '<div class="ln-bulk-note error">' + esc((peg && peg.error) || 'Could not design a pegRNA here.') + '</div>'; return; }
    var full = peg.spacer + SGRNA_SCAFFOLD + peg.extension;
    out.innerHTML = '<div class="ln-bulk-note ok">Designed. PBS melting temperature ' + peg.pbsTm.toFixed(1) + ' °C.</div>' +
      '<table class="ln-table"><tbody>' +
      [['Spacer (protospacer)', peg.spacer], ['Scaffold (standard SpCas9)', SGRNA_SCAFFOLD],
       ['RT template', peg.rtt], ['Primer binding site', peg.pbs],
       ['3′ extension (RTT + PBS)', peg.extension], ['Whole pegRNA', full]].map(function (r) {
        return '<tr><td class="ln-nowrap">' + r[0] + '</td><td><code class="pl-seq-out">' + esc(r[1]) + '</code></td>' +
          '<td><button class="ln-icon-btn" onclick="plCopyText(this.closest(\'tr\').querySelector(\'code\').textContent)">Copy</button></td></tr>';
      }).join('') + '</tbody></table>' +
      '<div class="hint">Check the scaffold against your supplier’s before ordering.</div>' +
      '<div style="margin-top:.6rem;"><button class="ln-add-btn ghost" onclick="plAnnotatePeg(' + i + ')">Annotate this pegRNA on the plasmid</button></div>';
    plLastPeg = peg;
  }
  /* Record the designed pegRNA on the plasmid: the spacer becomes a pegRNA
     feature and the note carries the parts needed to order it. */
  var plLastPeg = null;
  function plAnnotatePeg(i) {
    var it = rec(), gd = plGuides && plGuides[i], peg = plLastPeg;
    if (!it || !gd || !peg) return;
    var len = P.clean(it.seq).length;
    var f = P.normFeature({ name: 'pegRNA ' + gd.spacer.slice(0, 8) + '…', type: 'pegRNA',
      start: gd.start, end: gd.end, strand: gd.strand,
      note: 'Nicks at ' + (peg.nick + 1) + '. PBS ' + peg.pbs + '. RTT ' + peg.rtt + '. 3′ extension ' + peg.extension }, len);
    if (!f) return;
    it.features = (it.features || []).concat([f]);
    plLastPeg = null;
    closeModal(); markPlDirty(); renderPlasmid();
  }
  function plCopyText(t) {
    navigator.clipboard.writeText(t).then(function () { }, function () { alert(t); });
  }

  // ---------- choosing enzymes ----------
  var plEnzFilter = 'cut', plEnzSearch = '';
  function openEnzymePanel() {
    var it = rec(); if (!it) return;
    if (!P.clean(it.seq || '').length) { alert('Add a sequence first.'); return; }
    plEnzHtml();
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function plEnzHtml() {
    var it = rec(); if (!it) return;
    var sum = P.enzymeSummary(asPlasmid(it));
    var groups = { none: 0, one: 0, two: 0, many: 0 };
    sum.forEach(function (e) {
      if (!e.count) groups.none++; else if (e.count === 1) groups.one++;
      else if (e.count === 2) groups.two++; else groups.many++;
    });
    var q = plEnzSearch.trim().toLowerCase();
    var rows = sum.filter(function (e) {
      if (q && e.name.toLowerCase().indexOf(q) < 0 && e.site.toLowerCase().indexOf(q) < 0) return false;
      if (plEnzFilter === 'none') return e.count === 0;
      if (plEnzFilter === 'one') return e.count === 1;
      if (plEnzFilter === 'two') return e.count === 2;
      if (plEnzFilter === 'many') return e.count >= 3;
      if (plEnzFilter === 'cut') return e.count > 0;
      return true;
    });
    function tab(key, label, n) {
      return '<button type="button" class="ln-icon-btn' + (plEnzFilter === key ? ' on' : '') +
        '" onclick="plEnzSet(\'' + key + '\')">' + label + ' <span>' + n + '</span></button>';
    }
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Restriction enzymes</h3>' +
      '<p class="ln-bulk-intro">How often each of the ' + P.ENZYMES.length + ' enzymes cuts this plasmid. ' +
      'Tick the ones you want marked in the sequence — the never-cutters are the ones to add to a cloning site.</p>' +
      '<div class="ln-enz-tabs">' + tab('cut', 'Cuts at all', groups.one + groups.two + groups.many) +
        tab('none', 'Never cuts', groups.none) + tab('one', 'Cuts once', groups.one) +
        tab('two', 'Cuts twice', groups.two) + tab('many', 'Three or more', groups.many) + tab('all', 'Every enzyme', sum.length) +
      '</div>' +
      '<input class="ln-search sm" id="pl-enz-search" placeholder="🔍 Enzyme or site" value="' + esc(plEnzSearch) + '" oninput="plEnzSearchSet(this.value)" style="margin:.6rem 0;width:100%;">' +
      '<div style="max-height:40vh;overflow:auto;"><table class="ln-table"><thead><tr><th></th><th>Enzyme</th><th>Site</th><th>Cuts</th><th>Where</th><th>End</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (e) {
        return '<tr><td><input type="checkbox" class="pl-enz-pick" value="' + esc(e.name) + '"' +
            (plOpts.enzymeNames.indexOf(e.name) >= 0 ? ' checked' : '') + (e.count ? '' : ' disabled') + '></td>' +
          '<td>' + esc(e.name) + '</td><td><code>' + esc(e.site) + '</code></td>' +
          '<td class="ln-nowrap">' + e.count + '</td>' +
          '<td class="ln-nowrap">' + (e.cuts.length ? esc(e.cuts.slice(0, 6).join(', ')) + (e.cuts.length > 6 ? '…' : '') : '—') + '</td>' +
          '<td>' + (e.blunt ? 'blunt' : 'sticky') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="ln-empty">Nothing matches.</td></tr>') +
      '</tbody></table></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Close</button>' +
      '<button class="ln-modal-save" onclick="plEnzApply()">Mark the ticked ones</button></div>';
  }
  function plEnzSet(k) { plEnzFilter = k; plEnzHtml(); }
  function plEnzSearchSet(v) {
    plEnzSearch = v;
    plEnzHtml();
    var box = document.getElementById('pl-enz-search');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  }
  function plEnzApply() {
    plOpts.enzymeNames = Array.prototype.filter.call(document.querySelectorAll('.pl-enz-pick'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    plOpts.enzymes = plOpts.enzymeNames.length ? 'custom' : 'unique';
    closeModal(); renderSequenceOnly();
  }

  // ---------- restriction cloning ----------
  /* The vector is this plasmid; each insert comes from another plasmid in the
     inventory. Every piece is picked from its own digest, so the same screen
     covers a plain two-enzyme clone and a three-enzyme, three-piece assembly. */
  var clone = null;
  function openClone() {
    var it = rec(); if (!it) return;
    if (!P.clean(it.seq || '').length) { alert('Add a sequence first.'); return; }
    var others = (getInventory().plasmids || []).filter(function (x) { return x.id !== it.id && P.clean(x.seq || '').length; });
    clone = { vecEnz: [], vecPick: 0, inserts: [{ id: others.length ? others[0].id : '', enz: [], pick: 0, flip: false }] };
    plCloneHtml();
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function cutterOptions(p, chosen, i) {
    var sum = P.enzymeSummary(p).filter(function (e) { return e.count > 0; })
      .sort(function (a, b) { return a.count - b.count || a.name.localeCompare(b.name); });
    return '<option value="">—</option>' + sum.map(function (e) {
      return '<option value="' + esc(e.name) + '"' + (chosen[i] === e.name ? ' selected' : '') + '>' +
        esc(e.name) + ' (' + e.count + ' cut' + (e.count === 1 ? '' : 's') + ')</option>';
    }).join('');
  }
  function fragChoice(frags, picked, onChange) {
    if (!frags.length) return '<div class="hint">Choose enzymes above to cut it.</div>';
    return '<div class="pl-frag-list">' + frags.map(function (f, i) {
      return '<label class="pl-frag' + (picked === i ? ' on' : '') + '"><input type="radio" name="' + onChange.name + '" ' +
        (picked === i ? 'checked ' : '') + 'onchange="' + onChange.call + '(' + i + ')">' +
        '<strong>' + f.len.toLocaleString() + ' bp</strong> ' +
        '<span>' + esc((f.left.enzyme || 'end')) + ' → ' + esc((f.right.enzyme || 'end')) + '</span>' +
        (f.features.length ? '<em>' + f.features.length + ' feature' + (f.features.length === 1 ? '' : 's') + '</em>' : '') +
        '</label>';
    }).join('') + '</div>';
  }
  function cloneDigests() {
    var it = rec();
    var vec = asPlasmid(it);
    var vd = P.digest(vec, clone.vecEnz.filter(Boolean));
    var ins = clone.inserts.map(function (slot) {
      var src = (getInventory().plasmids || []).filter(function (x) { return x.id === slot.id; })[0];
      if (!src) return { fragments: [], src: null };
      var d = P.digest(asPlasmid(src), slot.enz.filter(Boolean));
      d.src = src;
      return d;
    });
    return { vec: vd, ins: ins };
  }
  function plCloneHtml() {
    var it = rec(); if (!it) return;
    var others = (getInventory().plasmids || []).filter(function (x) { return x.id !== it.id && P.clean(x.seq || '').length; });
    var d = cloneDigests();
    var html = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Restriction cloning</h3>' +
      '<p class="ln-bulk-intro">Cut this plasmid and the inserts, pick the piece to keep from each, and join them. ' +
      'Every join is checked, so an end that cannot ligate is caught before you order anything.</p>' +
      '<div class="pl-clone-box"><div class="ln-form-section">Vector — ' + esc(it.name || 'this plasmid') + '</div>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>First enzyme</label><select onchange="plCloneEnz(-1,0,this.value)">' + cutterOptions(asPlasmid(it), clone.vecEnz, 0) + '</select></div>' +
        '<div class="ln-form-row"><label>Second enzyme (optional)</label><select onchange="plCloneEnz(-1,1,this.value)">' + cutterOptions(asPlasmid(it), clone.vecEnz, 1) + '</select></div>' +
      '</div>' + fragChoice(d.vec.fragments, clone.vecPick, { name: 'vecfrag', call: 'plCloneVecPick' }) + '</div>';

    clone.inserts.forEach(function (slot, n) {
      var src = (getInventory().plasmids || []).filter(function (x) { return x.id === slot.id; })[0];
      html += '<div class="pl-clone-box"><div class="ln-form-section">Insert ' + (n + 1) +
        (clone.inserts.length > 1 ? ' <button class="ln-icon-btn danger" onclick="plCloneDropInsert(' + n + ')">✕</button>' : '') + '</div>' +
        '<div class="ln-form-grid">' +
          '<div class="ln-form-row"><label>From</label><select onchange="plCloneSrc(' + n + ',this.value)">' +
            (others.length ? others.map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === slot.id ? ' selected' : '') + '>' + esc(o.name || 'Untitled') + '</option>'; }).join('')
              : '<option value="">No other plasmid has a sequence yet</option>') + '</select></div>' +
          '<div class="ln-form-row"><label>Orientation</label><select onchange="plCloneFlip(' + n + ',this.value)">' +
            '<option value="0"' + (slot.flip ? '' : ' selected') + '>As it is</option>' +
            '<option value="1"' + (slot.flip ? ' selected' : '') + '>Turned round</option></select></div>' +
        '</div><div class="ln-form-grid">' +
          '<div class="ln-form-row"><label>First enzyme</label><select onchange="plCloneEnz(' + n + ',0,this.value)">' + (src ? cutterOptions(asPlasmid(src), slot.enz, 0) : '') + '</select></div>' +
          '<div class="ln-form-row"><label>Second enzyme</label><select onchange="plCloneEnz(' + n + ',1,this.value)">' + (src ? cutterOptions(asPlasmid(src), slot.enz, 1) : '') + '</select></div>' +
        '</div>' + fragChoice(d.ins[n].fragments, slot.pick, { name: 'insfrag' + n, call: 'plCloneInsPick.bind(null,' + n + ')' }) + '</div>';
    });
    if (clone.inserts.length < 2) html += '<button class="ln-add-btn ghost" onclick="plCloneAddInsert()">+ Add a second insert (three-piece assembly)</button>';
    html += '<div id="pl-clone-out"></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      '<button class="ln-modal-save" onclick="plCloneRun()">Check the join</button></div>';
    document.getElementById('ln-modal-content').innerHTML = html;
    plCloneCheck(true);
  }
  function plCloneEnz(which, slot, val) {
    var target = which < 0 ? clone.vecEnz : clone.inserts[which].enz;
    target[slot] = val;
    if (which < 0) clone.vecPick = 0;
    else { clone.inserts[which].pick = 0; clone.inserts[which].touched = true; }
    // An insert is cut with the vector's enzymes until someone says otherwise,
    // which is what a plain two-enzyme clone needs.
    if (which < 0) clone.inserts.forEach(function (ins) {
      if (!ins.touched) { ins.enz = clone.vecEnz.slice(); ins.pick = 0; }
    });
    plCloneHtml();
  }
  function plCloneSrc(n, id) { clone.inserts[n].id = id; clone.inserts[n].pick = 0; plCloneHtml(); }
  function plCloneFlip(n, v) { clone.inserts[n].flip = v === '1'; plCloneCheck(); }
  function plCloneVecPick(i) { clone.vecPick = i; plCloneCheck(); }
  function plCloneInsPick(n, i) { clone.inserts[n].pick = i; plCloneCheck(); }
  function plCloneAddInsert() {
    var others = (getInventory().plasmids || []).filter(function (x) { return x.id !== rec().id; });
    clone.inserts.push({ id: others.length ? others[0].id : '', enz: [], pick: 0, flip: false });
    plCloneHtml();
  }
  function plCloneDropInsert(n) { clone.inserts.splice(n, 1); plCloneHtml(); }

  function cloneParts() {
    var d = cloneDigests();
    var parts = [], names = [];
    var v = d.vec.fragments[clone.vecPick];
    if (!v) return null;
    parts.push({ frag: v, flip: false }); names.push('vector');
    for (var i = 0; i < clone.inserts.length; i++) {
      var f = d.ins[i].fragments[clone.inserts[i].pick];
      if (!f) return null;
      parts.push({ frag: f, flip: clone.inserts[i].flip });
      names.push((d.ins[i].src && d.ins[i].src.name) || ('insert ' + (i + 1)));
    }
    return { parts: parts, names: names };
  }
  function plCloneCheck(quiet) {
    var out = document.getElementById('pl-clone-out');
    if (!out) return;
    var made = cloneParts();
    if (!made) { out.innerHTML = quiet ? '' : '<div class="ln-bulk-note">Choose a piece from each digest.</div>'; return; }
    var res = P.ligate(made.parts, true);
    if (!res.ok) { out.innerHTML = '<div class="ln-bulk-note error">' + esc(res.error) + '</div>'; return; }
    clone.result = res;
    out.innerHTML = '<div class="ln-bulk-note ok"><strong>' + res.seq.length.toLocaleString() + ' bp</strong> circular · ' +
      res.features.length + ' feature' + (res.features.length === 1 ? '' : 's') + ' carried over · joins: ' +
      res.junctions.map(function (j) { return esc(P.describeEnd(j.left)); }).join(', ') + '</div>' +
      '<div class="ln-form-row"><label>Name for the new plasmid</label><input id="pl-clone-name" value="' +
      esc((rec().name || 'construct') + ' + ' + made.names.slice(1).join(' + ')) + '"></div>' +
      '<button class="ln-modal-save" onclick="plCloneCreate()">Create the plasmid</button>';
  }
  function plCloneRun() { plCloneCheck(); }
  function plCloneCreate() {
    var res = clone && clone.result;
    if (!res || !res.ok) return;
    var name = g('pl-clone-name') || 'New construct';
    var me = currentUser() ? currentUser().name : 'Unknown';
    var item = { id: uid(), name: name, seq: res.seq, topology: 'circular', len: res.seq.length,
      features: res.features.map(function (f) { return P.normFeature(f, res.seq.length); }).filter(Boolean),
      owner: me, addedBy: me,
      notes: 'Built by restriction cloning in the Lab Notebook on ' + new Date().toISOString().slice(0, 10) + '.' };
    DB.upsertInventory('plasmids', item).then(function () {
      clone = null;
      closeModal();
      renderInventory('plasmids');
      openPlasmid(item.id);
    }, function (e) { alert('Could not create the plasmid: ' + e.message); });
  }

  // ---------- primers ----------
  /* Primers live on the plasmid as { name, seq }. Where each one sits is
     worked out from the sequence every time, so editing the plasmid keeps
     them honest rather than leaving a stale position behind. */
  function primerList() { var it = rec(); return (it && it.primers) || []; }
  function primerBindings(p) {
    return primerList().map(function (pr) {
      var hits = P.bindPrimers(p, pr.seq, { minAnneal: 14 });
      hits.forEach(function (h) { h.name = pr.name; });
      return { primer: pr, hits: hits };
    });
  }
  function primersHtml(p) {
    var binds = primerBindings(p);
    var rows = binds.map(function (b, i) {
      var h = b.hits[0];
      var where = !h ? '<span class="warn">does not bind</span>'
        : (h.start + 1) + '–' + h.end + ' ' + (h.strand === -1 ? '←' : '→') +
          (b.hits.length > 1 ? ' <span class="warn">(+' + (b.hits.length - 1) + ' more)</span>' : '');
      return '<tr><td>' + esc(b.primer.name) + '</td>' +
        '<td><code>' + (h && h.tail ? '<span class="pcr-tailtext">' + esc(h.tail) + '</span>' : '') +
          esc(h ? h.anneal : b.primer.seq) + '</code></td>' +
        '<td class="ln-nowrap">' + b.primer.seq.length + ' nt</td>' +
        '<td class="ln-nowrap">' + (h ? h.tm.toFixed(1) + ' °C' : '—') + '</td>' +
        '<td class="ln-nowrap">' + where + '</td>' +
        '<td class="ln-nowrap">' + (h && h.tail ? h.tail.length + ' nt tail' : h ? 'full match' : '—') + '</td>' +
        '<td class="ln-row-actions">' + (h ? '<button class="ln-icon-btn" onclick="plAnnotatePrimer(' + i + ')">Annotate</button>' : '') +
        '<button class="ln-icon-btn danger" onclick="plDeletePrimer(' + i + ')">✕</button></td></tr>';
    }).join('');
    return '<div class="ln-pl-panel" id="pl-primers"><div class="ln-pl-panel-head"><h3>Primers <span>' + binds.length + '</span></h3>' +
      '<div class="ln-header-actions">' +
        '<button class="ln-add-btn ghost" onclick="openPcr()">⟶ Expected PCR</button>' +
        '<button class="ln-add-btn ghost" onclick="openGibson()">Gibson assembly</button>' +
        '<button class="ln-add-btn ghost" onclick="openPrimerModal()">+ Attach primer</button></div></div>' +
      (binds.length ? '<div style="overflow-x:auto;"><table class="ln-table"><thead><tr><th>Name</th><th>Sequence (tail shown pale)</th><th>Length</th><th>Tm</th><th>Binds</th><th>5′ end</th><th class="ln-row-actions">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="ln-empty" style="padding:1rem 0;">No primers attached. Attach a pair and the expected PCR can be drawn.</div>') + '</div>';
  }
  function openPrimerModal() {
    var inv = (getInventory().primers || []).filter(function (x) { return x.sequence; });
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Attach a primer</h3>' +
      '<div class="ln-form-row"><label>Name</label><input id="pm-name" placeholder="e.g. HK022_attB_F"></div>' +
      '<div class="ln-form-row"><label>Sequence (5′→3′)</label><input id="pm-seq" placeholder="ATGC…">' +
      '<div class="hint">Bases that do not match the template at the 5′ end are kept as a tail, which is normal for adding a site or an overlap.</div></div>' +
      (inv.length ? '<div class="ln-form-row"><label>Or take one from the primer inventory</label><select id="pm-pick" onchange="plPrimerPick(this.value)">' +
        '<option value="">—</option>' + inv.map(function (x, i) { return '<option value="' + i + '">' + esc(x.name || 'primer') + ' · ' + esc(String(x.sequence).slice(0, 30)) + '</option>'; }).join('') +
        '</select></div>' : '') +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      '<button class="ln-modal-save" onclick="plAddPrimer()">Attach</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function plPrimerPick(i) {
    var inv = (getInventory().primers || []).filter(function (x) { return x.sequence; });
    var pick = inv[+i];
    if (!pick) return;
    document.getElementById('pm-name').value = pick.name || '';
    document.getElementById('pm-seq').value = P.clean(pick.sequence);
  }
  function plAddPrimer() {
    var it = rec(); if (!it) return;
    var seq = P.clean(g('pm-seq'));
    if (seq.length < 10) { alert('That is too short to be a primer.'); return; }
    it.primers = (it.primers || []).concat([{ name: g('pm-name') || 'primer ' + ((it.primers || []).length + 1), seq: seq }]);
    closeModal(); markPlDirty(); renderPlasmid();
  }
  function plDeletePrimer(i) {
    var it = rec(); if (!it) return;
    it.primers = (it.primers || []).filter(function (x, n) { return n !== i; });
    markPlDirty(); renderPlasmid();
  }
  function plAnnotatePrimer(i) {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it), b = primerBindings(p)[i];
    if (!b || !b.hits.length) return;
    var h = b.hits[0];
    var f = P.normFeature({ name: b.primer.name, type: 'primer_bind', start: h.start, end: h.end, strand: h.strand,
      note: h.tail ? h.tail.length + ' base 5′ tail not annealed: ' + h.tail : 'Full match' }, p.seq.length);
    if (!f) return;
    it.features = (it.features || []).concat([f]);
    markPlDirty(); renderPlasmid();
  }

  // ---------- the expected PCR ----------
  function openPcr() {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it), binds = primerBindings(p);
    var fwd = binds.filter(function (b) { return b.hits.some(function (h) { return h.strand === 1; }); });
    var rev = binds.filter(function (b) { return b.hits.some(function (h) { return h.strand === -1; }); });
    if (!fwd.length || !rev.length) { alert('Attach at least one primer that reads forwards and one that reads backwards.'); return; }
    function opts(list, strand) {
      return list.map(function (b) {
        var i = binds.indexOf(b);
        return '<option value="' + i + '">' + esc(b.primer.name) + ' · ' +
          (b.hits.filter(function (h) { return h.strand === strand; })[0].start + 1) + '</option>';
      }).join('');
    }
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Expected PCR</h3>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Forward primer</label><select id="pcr-f" onchange="plPcrDraw()">' + opts(fwd, 1) + '</select></div>' +
        '<div class="ln-form-row"><label>Reverse primer</label><select id="pcr-r" onchange="plPcrDraw()">' + opts(rev, -1) + '</select></div>' +
      '</div><div id="pcr-out"></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Close</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
    plPcrDraw();
  }
  function plPcrDraw() {
    var it = rec(); if (!it) return;
    var p = asPlasmid(it), binds = primerBindings(p);
    var fb = binds[+document.getElementById('pcr-f').value], rb = binds[+document.getElementById('pcr-r').value];
    var f = fb && fb.hits.filter(function (h) { return h.strand === 1; })[0];
    var r = rb && rb.hits.filter(function (h) { return h.strand === -1; })[0];
    var out = document.getElementById('pcr-out');
    if (!f || !r) { out.innerHTML = '<div class="ln-bulk-note error">Those two primers do not face each other.</div>'; return; }
    var prod = P.pcrProduct(p, f, r);
    if (prod.error) { out.innerHTML = '<div class="ln-bulk-note error">' + esc(prod.error) + '</div>'; return; }
    window.__pcrSeq = prod.seq;
    out.innerHTML = '<div class="pl-pcr-wrap">' + P.pcrMapSvg(p, f, r, { width: 880 }) + '</div>' +
      '<div class="ln-bulk-note ok"><strong>' + prod.len.toLocaleString() + ' bp</strong> · ' +
      prod.templateLen.toLocaleString() + ' bp from the plasmid' + (prod.tails ? ' plus ' + prod.tails + ' bp of primer tail' : '') +
      (prod.wraps ? ' · runs across the origin' : '') + ' · ' +
      'anneals at ' + f.tm.toFixed(0) + ' and ' + r.tm.toFixed(0) + ' °C</div>' +
      '<button class="ln-icon-btn" onclick="plCopyText(window.__pcrSeq)">Copy the product sequence</button>';
  }

  // ---------- Gibson ----------
  var gib = null;
  function openGibson() {
    var it = rec(); if (!it) return;
    if (!P.clean(it.seq || '').length) { alert('Add a sequence first.'); return; }
    var others = (getInventory().plasmids || []).filter(function (x) { return x.id !== it.id && P.clean(x.seq || '').length; });
    gib = { overlap: 25, tm: 60, pieces: [{ id: it.id, from: '', to: '' }, { id: others.length ? others[0].id : '', from: '', to: '' }] };
    plGibsonHtml();
    document.getElementById('ln-modal-bg').classList.add('open');
  }
  function gibSources() {
    var it = rec();
    return [it].concat((getInventory().plasmids || []).filter(function (x) { return x.id !== it.id && P.clean(x.seq || '').length; }));
  }
  function gibFragments() {
    var all = gibSources();
    return gib.pieces.map(function (pc, i) {
      var src = all.filter(function (x) { return x.id === pc.id; })[0];
      if (!src) return null;
      var p = asPlasmid(src), len = p.seq.length;
      var a = pc.from === '' ? 0 : Math.max(0, Math.min(len, parseInt(pc.from, 10) - 1 || 0));
      var b = pc.to === '' ? len : Math.max(1, Math.min(len, parseInt(pc.to, 10) || len));
      var seq = b > a ? p.seq.slice(a, b) : p.seq.slice(a) + p.seq.slice(0, b);
      var feats = [];
      (p.features || []).forEach(function (f) {
        if (P.wraps(f)) return;
        if (f.start >= a && f.end <= b) feats.push({ name: f.name, type: f.type, start: f.start - a, end: f.end - a, strand: f.strand, color: f.color });
      });
      return { name: (src.name || 'piece ' + (i + 1)) + (pc.from || pc.to ? ' ' + (a + 1) + '–' + b : ''),
        seq: seq, features: feats, srcName: src.name, len: seq.length };
    });
  }
  function plGibsonHtml() {
    var all = gibSources();
    var frags = gibFragments();
    var html = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Gibson assembly</h3>' +
      '<p class="ln-bulk-intro">Pieces are joined in the order below, closing into a circle. Each piece’s forward primer carries the end of the piece before it, so the two products share that stretch — which is what Gibson needs. Twenty to forty bases is the usual overlap.</p>' +
      '<div class="ln-form-grid">' +
        '<div class="ln-form-row"><label>Overlap (bases)</label><input type="number" id="gib-ovl" min="15" max="60" value="' + gib.overlap + '" onchange="plGibsonSet()"></div>' +
        '<div class="ln-form-row"><label>Annealing Tm to aim for (°C)</label><input type="number" id="gib-tm" min="50" max="72" value="' + gib.tm + '" onchange="plGibsonSet()"></div>' +
      '</div>';
    gib.pieces.forEach(function (pc, n) {
      var f = frags[n];
      html += '<div class="pl-clone-box"><div class="ln-form-section">' + (n ? 'Insert ' + n : 'Vector') +
        (gib.pieces.length > 2 ? ' <button class="ln-icon-btn danger" onclick="plGibsonDrop(' + n + ')">✕</button>' : '') + '</div>' +
        '<div class="ln-form-grid"><div class="ln-form-row"><label>From</label><select onchange="plGibsonSrc(' + n + ',this.value)">' +
          all.map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === pc.id ? ' selected' : '') + '>' + esc(o.name || 'Untitled') + '</option>'; }).join('') +
        '</select></div><div class="ln-form-row"><label>Bases (leave empty for all)</label>' +
          '<div style="display:flex;gap:.4rem;"><input type="number" placeholder="from" value="' + esc(pc.from) + '" onchange="plGibsonRange(' + n + ',0,this.value)">' +
          '<input type="number" placeholder="to" value="' + esc(pc.to) + '" onchange="plGibsonRange(' + n + ',1,this.value)"></div></div></div>' +
        '<div class="hint">' + (f ? f.len.toLocaleString() + ' bp · ' + f.features.length + ' feature' + (f.features.length === 1 ? '' : 's') : 'no sequence') + '</div></div>';
    });
    if (gib.pieces.length < 8) html += '<button class="ln-add-btn ghost" onclick="plGibsonAdd()">+ Add an insert (up to seven)</button>';
    html += '<div id="gib-out"></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button>' +
      '<button class="ln-modal-save" onclick="plGibsonRun()">Design the primers</button></div>';
    document.getElementById('ln-modal-content').innerHTML = html;
  }
  function plGibsonSet() {
    gib.overlap = +document.getElementById('gib-ovl').value || 25;
    gib.tm = +document.getElementById('gib-tm').value || 60;
  }
  function plGibsonSrc(n, id) { gib.pieces[n].id = id; plGibsonHtml(); }
  function plGibsonRange(n, which, v) { gib.pieces[n][which ? 'to' : 'from'] = v; plGibsonHtml(); }
  function plGibsonAdd() { var all = gibSources(); gib.pieces.push({ id: all.length > 1 ? all[1].id : all[0].id, from: '', to: '' }); plGibsonHtml(); }
  function plGibsonDrop(n) { gib.pieces.splice(n, 1); plGibsonHtml(); }
  function plGibsonRun() {
    plGibsonSet();
    var frags = gibFragments().filter(Boolean);
    var res = P.designGibson(frags, { overlap: gib.overlap, annealTm: gib.tm });
    var out = document.getElementById('gib-out');
    if (res.error) { out.innerHTML = '<div class="ln-bulk-note error">' + esc(res.error) + '</div>'; return; }
    gib.result = res;
    out.innerHTML = '<div class="ln-bulk-note ok"><strong>' + res.product.seq.length.toLocaleString() + ' bp</strong> circular · ' +
      res.pieces + ' pieces · ' + res.junctions.length + ' joins of ' + res.overlap + ' bases · ' +
      res.product.features.length + ' feature' + (res.product.features.length === 1 ? '' : 's') + ' carried over</div>' +
      '<div style="max-height:34vh;overflow:auto;"><table class="ln-table"><thead><tr><th>Primer</th><th>Sequence (overlap pale)</th><th>Length</th><th>Anneal Tm</th><th></th></tr></thead><tbody>' +
      res.primers.map(function (pr, i) {
        return '<tr><td class="ln-nowrap">' + esc(pr.name) + '</td>' +
          '<td><code class="pl-seq-out">' + (pr.tail ? '<span class="pcr-tailtext">' + esc(pr.tail) + '</span>' : '') + esc(pr.anneal) + '</code></td>' +
          '<td class="ln-nowrap">' + pr.seq.length + ' nt</td>' +
          '<td class="ln-nowrap">' + pr.tmAnneal.toFixed(1) + ' °C</td>' +
          '<td><button class="ln-icon-btn" onclick="plCopyText(\'' + pr.seq + '\')">Copy</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="ln-form-row" style="margin-top:.6rem;"><label>Name for the assembled plasmid</label>' +
      '<input id="gib-name" value="' + esc(frags.map(function (f) { return f.srcName || f.name; }).join(' + ')) + '"></div>' +
      '<button class="ln-modal-save" onclick="plGibsonCreate()">Create the plasmid</button>' +
      '<button class="ln-icon-btn" onclick="plCopyText(window.__gibAll)">Copy every primer</button>';
    window.__gibAll = res.primers.map(function (pr) { return pr.name + '\t' + pr.seq; }).join('\n');
  }
  function plGibsonCreate() {
    var res = gib && gib.result;
    if (!res) return;
    var me = currentUser() ? currentUser().name : 'Unknown';
    var seq = res.product.seq;
    var item = { id: uid(), name: g('gib-name') || 'Gibson product', seq: seq, topology: 'circular', len: seq.length,
      features: res.product.features.map(function (f) { return P.normFeature(f, seq.length); }).filter(Boolean),
      owner: me, addedBy: me,
      primers: res.primers.map(function (pr) { return { name: pr.name, seq: pr.seq }; }),
      notes: 'Designed as a Gibson assembly of ' + res.pieces + ' pieces with ' + res.overlap +
        ' base overlaps in the Lab Notebook on ' + new Date().toISOString().slice(0, 10) + '.' };
    DB.upsertInventory('plasmids', item).then(function () {
      gib = null; closeModal(); renderInventory('plasmids'); openPlasmid(item.id);
    }, function (e) { alert('Could not create the plasmid: ' + e.message); });
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
      seq: P.clean(it.seq || ''), features: it.features || [], primers: it.primers || [], len: P.clean(it.seq || '').length
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
  /* Reading the file and handing it to the parser is js/plasmid-import.js's
     job: it decides from the extension whether to read text or bytes, and it
     rejects with a reason rather than handing back a half-parsed result. The
     one thing kept here is the retry for a SnapGene file that arrived without
     its .dna extension, which happens often enough to be worth a second
     read. */
  async function parseOne(file) {
    var Imp = window.PlasmidImport;
    try {
      return await Imp.readFile(file);
    } catch (err) {
      if (!Imp.isTextFormat(file.name)) throw err;
      try {
        return await Imp.readFile(new File([file], file.name + '.dna', { type: file.type }));
      } catch (ignored) {
        throw err;                   // the first complaint is the useful one
      }
    }
  }
  /* One file onto the plasmid already open. Kept apart from the file picker
     so the same path can be driven with a File from anywhere. */
  async function importFileIntoThis(file) {
    var it = rec(); if (!it || !file) return;
    var res;
    try { res = await parseOne(file); } catch (e) { alert(e.message); return; }
    if (P.clean(it.seq || '').length &&
      !confirm('Replace the sequence and features of this plasmid with ' + file.name + ' (' + res.plasmid.seq.length + ' bp, ' + res.plasmid.features.length + ' features)?')) return;
    it.seq = res.plasmid.seq;
    it.features = res.plasmid.features;
    it.topology = res.plasmid.topology;
    if (!it.name || /^untitled/i.test(it.name)) it.name = res.plasmid.name;
    plCaret = 0; plSel = null; plUndo = []; plRedo = [];
    recomputeSites();
    markPlDirty(); renderPlasmid();
  }
  function plImportIntoThis() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gb,.gbk,.genbank,.ape,.dna,.fa,.fasta,.fna,.fsa,.seq,.txt';
    input.onchange = function () { importFileIntoThis(input.files && input.files[0]); };
    input.click();
  }

  /* ---- dropping a sequence file onto the page ----
     The same import as the button, with the file coming off a drag. A file
     arrives from a mail client or a vendor's download as often as from a file
     dialog, and dragging it onto the plasmid is the shorter way round.

     The listeners go on the section, which notebook.html owns and which
     outlives any render, rather than on the body renderPlasmid rewrites —
     and once, because wire() runs again on every render.

     Only a drag carrying files counts. Dragging selected bases out of the
     sequence editor is a text drag, and treating that as an import would be
     a confusing way to lose a plasmid. */
  var plDropDepth = 0;
  function dragHasFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }
  function wirePlasmidDrop() {
    var sect = document.getElementById('ln-plasmid');
    if (!sect || sect.getAttribute('data-drop-wired')) return;
    sect.setAttribute('data-drop-wired', '1');

    function stop() { plDropDepth = 0; sect.classList.remove('ln-pl-dropping'); }

    // dragenter and dragleave both fire again for every child the pointer
    // crosses, so the highlight follows a depth count, not the last event.
    sect.addEventListener('dragenter', function (e) {
      if (!dragHasFiles(e) || !rec()) return;
      e.preventDefault();
      if (++plDropDepth === 1) sect.classList.add('ln-pl-dropping');
    });
    sect.addEventListener('dragover', function (e) {
      if (!dragHasFiles(e) || !rec()) return;
      e.preventDefault();                  // without this the drop never arrives
      e.dataTransfer.dropEffect = 'copy';
    });
    sect.addEventListener('dragleave', function (e) {
      if (!dragHasFiles(e)) return;
      if (--plDropDepth <= 0) stop();
    });
    sect.addEventListener('drop', function (e) {
      if (!dragHasFiles(e) || !rec()) return;
      e.preventDefault();                  // or the browser opens the file itself
      stop();
      var files = e.dataTransfer.files;
      if (!files || !files.length) return;
      if (files.length > 1) {
        alert('Drop one file to give this plasmid its sequence. To add several plasmids at once, use “Import sequences” on the Plasmids page.');
        return;
      }
      importFileIntoThis(files[0]);        // which asks before replacing a sequence
    });
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
        ok.push({ file: files[i], res: await parseOne(files[i]) });
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
  /* The handlers sit on the page container, so they survive the sequence being
     redrawn; the editor's own keyboard and clipboard handlers sit on the
     document and only act while a plasmid is open. */
  function wire() {
    var box = document.getElementById('ln-plasmid-body');
    box.addEventListener('input', function (e) {
      if (e.target.id === 'pl-find') { plOpts.find = e.target.value; renderSequenceOnly(); return; }
      if (e.target.closest('.ln-pl-meta')) markPlDirty();
    });
    box.addEventListener('change', function (e) {
      if (e.target.id === 'pl-enzymes') {
        plOpts.enzymes = e.target.value;
        if (e.target.value === 'custom') { openEnzymePanel(); return; }
        renderSequenceOnly(); return;
      }
      if (e.target.id === 'pl-frame') { plOpts.frame = e.target.value; renderSequenceOnly(); return; }
      if (e.target.closest('.ln-pl-meta')) markPlDirty();
    });
    box.addEventListener('mousedown', function (e) { if (e.target.closest('#pl-ed')) edMouseDown(e); });
    wirePlasmidDrop();
  }
  document.addEventListener('mousemove', edMouseMove);
  document.addEventListener('mouseup', edMouseUp);
  document.addEventListener('keydown', function (e) {
    var ed = document.getElementById('pl-ed');
    if (lnCurrentSection !== 'plasmid' || !ed) return;
    if (document.activeElement !== ed) return;      // not while a form field has focus
    edKeyDown(e);
  });
  document.addEventListener('paste', function (e) {
    var ed = document.getElementById('pl-ed');
    if (lnCurrentSection !== 'plasmid' || !ed || document.activeElement !== ed) return;
    edPaste(e);
  });

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

  window.openAnnotate = openAnnotate;
  window.plAnnToggleAll = plAnnToggleAll;
  window.plAddAnnotations = plAddAnnotations;
  window.openOrfs = openOrfs;
  window.plOrfRefresh = plOrfRefresh;
  window.plOrfToggleAll = plOrfToggleAll;
  window.plAddOrfs = plAddOrfs;
  window.openGuides = openGuides;
  window.plGuideSet = plGuideSet;
  window.plAnnotateGuide = plAnnotateGuide;
  window.plPegModal = plPegModal;
  window.plPegRun = plPegRun;
  window.plAnnotatePeg = plAnnotatePeg;
  window.plCopyText = plCopyText;
  window.openEnzymePanel = openEnzymePanel;
  window.plEnzSet = plEnzSet;
  window.plEnzSearchSet = plEnzSearchSet;
  window.plEnzApply = plEnzApply;
  window.openClone = openClone;
  window.plCloneEnz = plCloneEnz;
  window.plCloneSrc = plCloneSrc;
  window.plCloneFlip = plCloneFlip;
  window.plCloneVecPick = plCloneVecPick;
  window.plCloneInsPick = plCloneInsPick;
  window.plCloneAddInsert = plCloneAddInsert;
  window.plCloneDropInsert = plCloneDropInsert;
  window.plCloneRun = plCloneRun;
  window.plCloneCreate = plCloneCreate;
  window.openPrimerModal = openPrimerModal;
  window.plPrimerPick = plPrimerPick;
  window.plAddPrimer = plAddPrimer;
  window.plDeletePrimer = plDeletePrimer;
  window.plAnnotatePrimer = plAnnotatePrimer;
  window.openPcr = openPcr;
  window.plPcrDraw = plPcrDraw;
  window.openGibson = openGibson;
  window.plGibsonSet = plGibsonSet;
  window.plGibsonSrc = plGibsonSrc;
  window.plGibsonRange = plGibsonRange;
  window.plGibsonAdd = plGibsonAdd;
  window.plGibsonDrop = plGibsonDrop;
  window.plGibsonRun = plGibsonRun;
  window.plGibsonCreate = plGibsonCreate;
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
  window.plImportIntoThis = plImportIntoThis;
  window.openPlasmidImport = openPlasmidImport;
  window.plPreviewImport = plPreviewImport;
  window.plRunImport = plRunImport;
  window.plExportMenu = plExportMenu;
  window.plExport = plExport;
  window.exportPlasmidsCSV = exportPlasmidsCSV;
  window.plCopySelection = plCopySelection;
})();
