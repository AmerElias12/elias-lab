/* ============================================================
   Elias Lab Notebook — culture plates on a page
   ------------------------------------------------------------
   A plate drawn the way it sits on the bench, with a box per
   well you can write in: what was seeded, what was added, which
   condition. The formats are the ones the lab uses — a single
   dish, 6, 12, 24, 48 and 96 wells.

   Wells are named the way every plate is printed and every
   reader exports them: rows are letters from the back of the
   plate, columns are numbers from the left, so A1 is the corner
   nearest the label. That matters more than it looks — a plate
   map whose names do not match the plate reader's output has to
   be translated by hand every time it is used.

   The block saves as its own state plus a plain table, so an
   entry still reads as a plate to anyone opening it without
   this app — or in five years, when this app is gone.
   ============================================================ */
(function () {
  'use strict';

  /* rows × cols for each format. These are the real geometries: a 6-well is
     2 by 3 and a 96 is 8 by 12, so the drawing matches what is in your hand
     rather than being a tidy rectangle of the right size. */
  var FORMATS = {
    1:  { rows: 1, cols: 1,  label: 'Single dish' },
    6:  { rows: 2, cols: 3,  label: '6-well' },
    12: { rows: 3, cols: 4,  label: '12-well' },
    24: { rows: 4, cols: 6,  label: '24-well' },
    48: { rows: 6, cols: 8,  label: '48-well' },
    96: { rows: 8, cols: 12, label: '96-well' }
  };
  var ORDER = [1, 6, 12, 24, 48, 96];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function rowName(i) { return String.fromCharCode(65 + i); }

  /* The wells of a format, in reading order. A single dish has no grid to
     speak of, so its one well is just called "Dish" rather than A1 — calling
     it A1 implies a row and a column that are not there. */
  function grid(f) {
    var spec = FORMATS[f] || FORMATS[96];
    var wells = [];
    for (var r = 0; r < spec.rows; r++) {
      for (var c = 0; c < spec.cols; c++) {
        wells.push(f === 1 ? 'Dish' : rowName(r) + (c + 1));
      }
    }
    return { rows: spec.rows, cols: spec.cols, label: spec.label, wells: wells };
  }

  function blank(f) {
    return { f: Number(f) || 96, title: '', cells: {} };
  }

  function load(raw) {
    try {
      var st = JSON.parse(raw || 'null');
      if (!st || !FORMATS[st.f]) return null;
      if (!st.cells || typeof st.cells !== 'object') st.cells = {};
      st.title = String(st.title || '');
      return st;
    } catch (e) { return null; }
  }

  /* How full the plate is, which is the one thing worth saying above it: a
     plate map with three wells filled in is usually one somebody has not
     finished, and the count makes that obvious at a glance. */
  function used(st) {
    var g = grid(st.f), n = 0;
    g.wells.forEach(function (w) { if ((st.cells[w] || '').trim()) n++; });
    return n;
  }

  function render(block) {
    var st = block._plate, g = grid(st.f);
    var head =
      '<div class="ln-plate-head">' +
        '<input class="ln-plate-title" data-k="title" placeholder="What is this plate?" value="' + esc(st.title) + '">' +
        '<label class="ln-plate-fmt">Format' +
          '<select data-k="f">' + ORDER.map(function (f) {
            return '<option value="' + f + '"' + (f === st.f ? ' selected' : '') + '>' + esc(FORMATS[f].label) + '</option>';
          }).join('') + '</select></label>' +
        '<span class="ln-plate-count">' + used(st) + ' of ' + g.wells.length + ' filled</span>' +
        '<button type="button" class="ln-calc-x" data-act="clear" title="Empty every well">Clear</button>' +
        '<button type="button" class="ln-calc-x" data-act="remove" title="Remove this plate from the page">✕</button>' +
      '</div>';

    var rows = '';
    if (st.f !== 1) {
      rows += '<tr><th></th>';
      for (var c = 0; c < g.cols; c++) rows += '<th>' + (c + 1) + '</th>';
      rows += '</tr>';
    }
    for (var r = 0; r < g.rows; r++) {
      rows += '<tr>' + (st.f === 1 ? '' : '<th>' + rowName(r) + '</th>');
      for (var c2 = 0; c2 < g.cols; c2++) {
        var w = st.f === 1 ? 'Dish' : rowName(r) + (c2 + 1);
        rows += '<td><input data-w="' + esc(w) + '" title="' + esc(w) + '" aria-label="Well ' + esc(w) + '"' +
          ' value="' + esc(st.cells[w] || '') + '"></td>';
      }
      rows += '</tr>';
    }

    block.innerHTML = head +
      '<div class="ln-plate-scroll"><table class="ln-plate-tbl ln-plate-' + st.f + '">' + rows + '</table></div>';
  }

  /* Only the count redraws while typing, so the well keeps focus. */
  function refreshCount(block) {
    var el = block.querySelector('.ln-plate-count');
    if (el) el.textContent = used(block._plate) + ' of ' + grid(block._plate.f).wells.length + ' filled';
  }

  function handle(e) {
    var block = e.target.closest && e.target.closest('.ln-plate');
    if (!block || !block._plate) return;
    var st = block._plate, el = e.target;

    if (e.type === 'click') {
      var act = el.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'remove') {
        if (confirm('Remove this plate from the page?')) { block.remove(); markEntryDirty(); }
        return;
      }
      if (act.dataset.act === 'clear') {
        if (!used(st) || confirm('Empty every well on this plate?')) {
          st.cells = {}; render(block); markEntryDirty();
        }
        return;
      }
      return;
    }

    if (el.dataset.w != null) {
      st.cells[el.dataset.w] = el.value;
      if (!el.value.trim()) delete st.cells[el.dataset.w];
      refreshCount(block); markEntryDirty();
      return;
    }
    if (el.dataset.k === 'title') { st.title = el.value; markEntryDirty(); return; }
    if (el.dataset.k === 'f') {
      // Wells that exist in both formats keep what is written in them; the
      // rest are dropped, and saying how many is the difference between a
      // change and a loss somebody notices a week later.
      var next = Number(el.value), keep = {}, lost = 0;
      var names = {};
      grid(next).wells.forEach(function (w) { names[w] = true; });
      Object.keys(st.cells).forEach(function (w) {
        if (names[w]) keep[w] = st.cells[w]; else if ((st.cells[w] || '').trim()) lost++;
      });
      if (lost && !confirm(lost + ' well' + (lost === 1 ? '' : 's') +
          ' do not exist on a ' + FORMATS[next].label + ' plate. Change format and lose what is written in them?')) {
        el.value = String(st.f);
        return;
      }
      st.f = next; st.cells = keep;
      render(block); markEntryDirty();
    }
  }

  function hydrate(root) {
    root.querySelectorAll('.ln-plate').forEach(function (block) {
      if (block._plate) return;
      var st = load(block.getAttribute('data-plate'));
      if (!st) return;          // unreadable: the saved table stays as it is
      block._plate = st;
      block.setAttribute('contenteditable', 'false');
      render(block);
    });
  }

  /* For saving: the state, and a plain table under it. Empty wells are drawn
     as empty cells rather than left out, because the shape of the plate is
     part of what is being recorded — which wells were *not* used is often
     the point. */
  function snapshot(block) {
    var st = block._plate, g = grid(st.f);
    block.setAttribute('data-plate', JSON.stringify(st));
    block.removeAttribute('contenteditable');
    var out = '<p><strong>' + esc(st.title || g.label + ' plate') + '</strong> — ' +
      esc(g.label) + ', ' + used(st) + ' of ' + g.wells.length + ' wells filled</p><table>';
    if (st.f !== 1) {
      out += '<thead><tr><th></th>';
      for (var c = 0; c < g.cols; c++) out += '<th>' + (c + 1) + '</th>';
      out += '</tr></thead>';
    }
    out += '<tbody>';
    for (var r = 0; r < g.rows; r++) {
      out += '<tr>' + (st.f === 1 ? '' : '<th>' + rowName(r) + '</th>');
      for (var c2 = 0; c2 < g.cols; c2++) {
        var w = st.f === 1 ? 'Dish' : rowName(r) + (c2 + 1);
        out += '<td>' + esc(st.cells[w] || '') + '</td>';
      }
      out += '</tr>';
    }
    block.innerHTML = out + '</tbody></table>';
  }

  window.LabPlates = {
    FORMATS: FORMATS, ORDER: ORDER,
    grid: grid, blank: blank, load: load, used: used,
    render: render, hydrate: hydrate, snapshot: snapshot, handle: handle
  };
})();
