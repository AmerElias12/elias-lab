/* ============================================================
   Elias Lab Notebook — @-mentions
   ------------------------------------------------------------
   Type @ on a page and a search opens: the lab's plasmids,
   primers, enzymes, kits and reagents, glycerol stocks, tissue
   culture, and the people in the lab. Pick one and it becomes a
   chip in the text. Click the chip and the thing it names opens
   in a tab.

   What a mention stores is the kind and the id, not the name.
   The name is drawn fresh from the inventory every time the
   page is opened, so renaming a plasmid renames it everywhere
   it was ever mentioned — and a mention of something that has
   since been thrown away says so instead of quietly naming a
   row that is no longer there.

   Mentioning a person is the same mechanism. There is no mail
   server behind this and no push, so "notify" means the entry
   turns up in that person's Mentions list in the notebook, which
   is read from the entries themselves rather than from a table
   of notifications that could drift out of step with them.
   ============================================================ */
(function () {
  'use strict';

  /* Everything the notebook holds, in the order it is offered when you type a
     bare @. One table, because a mention should work the same whatever it
     names, and the only differences between these are three fields:

       cat      the inventory category the records live in
       invKind  narrows one store to one sort of record — plasmids, cDNAs and
                genes share a store and are told apart by a `kind` field
       coll     a collection of its own, read through its getter
       boxes    storage boxes, which are not rows at all but are worked out
                from the vials that name them

     `name` is the field holding a human name, because a glycerol stock is
     filed by serial number and has no `name` at all. */
  var KINDS = [
    { kind: 'plasmid',    cat: 'plasmids', invKind: 'plasmid', label: 'Plasmid',        name: 'name' },
    { kind: 'cdna',       cat: 'plasmids', invKind: 'cdna',    label: 'cDNA',           name: 'name' },
    { kind: 'gene',       cat: 'plasmids', invKind: 'gene',    label: 'Gene',           name: 'name' },
    { kind: 'primer',     cat: 'primers',  label: 'Primer',         section: 'inv-primers',   name: 'name' },
    { kind: 'enzyme',     cat: 'enzymes',  label: 'Enzyme',         section: 'inv-enzymes',   name: 'name' },
    { kind: 'kit',        cat: 'kits',     label: 'Kit / reagent',  section: 'inv-kits',      name: 'name' },
    { kind: 'stock',      cat: 'stocks',   label: 'Glycerol stock', section: 'inv-stocks',    name: 'serial' },
    { kind: 'cell',       cat: 'cells',    label: 'Tissue culture', section: 'inv-cells',     name: 'name' },
    { kind: 'box',        boxes: true,     label: 'Storage box',    section: 'boxes',         name: 'name' },
    { kind: 'protocol',   coll: 'getProtocols',     label: 'Protocol',      section: 'protocols',     name: 'title' },
    { kind: 'experiment', coll: 'getNotebooks',     label: 'Experiment',    section: 'notebooks',     name: 'title' },
    { kind: 'talk',       coll: 'getPresentations', label: 'Presentation',  section: 'presentations', name: 'title' },
    { kind: 'request',    cat: 'requests', label: 'Order request',  section: 'inv-requests',  name: 'name' },
    { kind: 'grant',      cat: 'grants',   label: 'Grant',          section: 'finances',      name: 'name' },
    { kind: 'expense',    cat: 'expenses', label: 'Expense',        section: 'finances',      name: 'name' }
  ];
  // The three that share the plasmids store.
  var CLONING = ['plasmid', 'cdna', 'gene'];
  var BY_KIND = {};
  KINDS.forEach(function (k) { BY_KIND[k.kind] = k; });

  var ICONS = { plasmid: '⦿', cdna: '〜', gene: '⌁', primer: '→', enzyme: '✂',
    kit: '▧', stock: '❄', cell: '◌', box: '▦', protocol: '☰', experiment: '✎',
    talk: '▭', request: '⊞', grant: '✦', expense: '⊗', user: '●' };
  var BOX_OF = { plasmids: 'Plasmid box', stocks: 'Glycerol stock box', cells: 'Tissue culture box' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- what can be mentioned ----------
  function labelOf(kind, item) {
    var k = BY_KIND[kind];
    if (!k) return '';
    return String(item[k.name] || item.name || item.serial || '').trim();
  }
  /* A second line for the list, so two plasmids with similar names can be
     told apart without opening them. */
  function metaOf(kind, item) {
    if (kind === 'plasmid') return [item.backbone, item.resistance, item.len ? item.len + ' bp' : ''].filter(Boolean).join(' · ');
    if (kind === 'cdna') return [item.insert, item.species, item.accession].filter(Boolean).join(' · ');
    if (kind === 'gene') return [item.species, item.accession || item.locus].filter(Boolean).join(' · ');
    if (kind === 'primer') return [item.sequence ? String(item.sequence).slice(0, 24) : '', item.application].filter(Boolean).join(' · ');
    if (kind === 'enzyme') return [item.cutsite, item.supplier].filter(Boolean).join(' · ');
    // What is left matters more here than the catalogue number: an @ to a
    // reagent mid-experiment is usually somebody about to go and get it.
    if (kind === 'kit') {
      var left = typeof aliquotCount === 'function' ? aliquotCount(item) : null;
      var each = typeof aliquotSize === 'function' ? aliquotSize(item) : '';
      var stock = left === null ? ''
        : left === 0 ? 'no aliquots left'
        : left + ' aliquot' + (left === 1 ? '' : 's') + (each ? ' × ' + each : '') + ' left';
      return [item.supplier, item.catalog, stock].filter(Boolean).join(' · ');
    }
    if (kind === 'stock') return [item.description, item.hostStrain].filter(Boolean).join(' · ');
    // Passages are typed either "P12" or "12"; don't print "pP12".
    if (kind === 'cell') return [item.source, item.passage ? String(item.passage).replace(/^p?/i, 'p') : ''].filter(Boolean).join(' · ');
    if (kind === 'box') {
      var n = (item.vials && item.vials.length) || 0;
      return [BOX_OF[item.cat] || 'Box', item.where,
        n ? n + (n === 1 ? ' vial' : ' vials') : 'empty'].filter(Boolean).join(' · ');
    }
    if (kind === 'protocol') return [item.category, item.author].filter(Boolean).join(' · ');
    // An archived experiment is still a real one, but say so: citing it
    // without knowing it was archived would be a surprise later.
    if (kind === 'experiment') return [item.researcher, item.date, item.archived ? 'archived' : ''].filter(Boolean).join(' · ');
    if (kind === 'talk') return [item.presenter, item.venue, item.date].filter(Boolean).join(' · ');
    if (kind === 'request') return [item.status, item.supplier, item.urgency].filter(Boolean).join(' · ');
    if (kind === 'grant') return [item.agency, item.ref].filter(Boolean).join(' · ');
    if (kind === 'expense') return [item.date, item.cost ? (item.cost + '') : '', item.category].filter(Boolean).join(' · ');
    return '';
  }

  /* Where a kind's records live. Inventory categories come out of one object,
     collections through their getter, and boxes are built from the vials in
     them rather than stored as rows. */
  function recordsOf(k) {
    if (k.boxes) return (typeof boxIndex === 'function' && boxIndex()) || [];
    if (k.coll) return (typeof window[k.coll] === 'function' && window[k.coll]()) || [];
    if (k.cat) {
      var inv = (typeof getInventory === 'function' && getInventory()) || {};
      var rows = inv[k.cat] || [];
      if (!k.invKind) return rows;
      return rows.filter(function (x) { return ((x && x.kind) || 'plasmid') === k.invKind; });
    }
    return [];
  }

  /* What a mention stores. A box that has been set up has a row with an id,
     which survives renaming; a box known only from the vials filed in it has
     no row, so its key — type plus name — is all there is to point at. */
  function idOf(k, item) {
    if (k.boxes) return (item.def && item.def.id) || item.key;
    return item.id;
  }

  function entities() {
    var out = [];
    KINDS.forEach(function (k) {
      recordsOf(k).forEach(function (item) {
        var label = labelOf(k.kind, item), id = idOf(k, item);
        if (!id || !label) return;
        out.push({ kind: k.kind, id: id, label: label, meta: metaOf(k.kind, item), group: k.label });
      });
    });
    var users = (typeof getUsers === 'function' && getUsers()) || [];
    users.forEach(function (u) {
      if (!u.id || !u.name || (u.status && u.status !== 'approved')) return;
      out.push({ kind: 'user', id: u.id, label: u.name, meta: u.email || '', group: 'Person' });
    });
    return out;
  }

  /* Ranked so that what you are typing the start of comes first. A query
     matching the beginning of a name is nearly always the one meant; a match
     in the middle is a fallback, not an equal. */
  function search(q, limit) {
    var all = entities();
    var needle = String(q || '').trim().toLowerCase();
    if (!needle) return all.slice(0, limit || 8);
    var scored = [];
    all.forEach(function (e) {
      var name = e.label.toLowerCase();
      var at = name.indexOf(needle);
      var rank = at === 0 ? 0 : at > 0 ? 1 : (e.meta || '').toLowerCase().indexOf(needle) >= 0 ? 2 : -1;
      if (rank < 0) return;
      scored.push({ e: e, rank: rank, at: at < 0 ? 99 : at });
    });
    scored.sort(function (a, b) {
      return a.rank - b.rank || a.at - b.at || a.e.label.localeCompare(b.e.label);
    });
    return scored.slice(0, limit || 8).map(function (s) { return s.e; });
  }

  function lookup(kind, id) {
    if (kind === 'user') {
      return ((typeof getUsers === 'function' && getUsers()) || []).filter(function (u) { return u.id === id; })[0] || null;
    }
    var k = BY_KIND[kind];
    if (!k) return null;
    if (k.boxes) {
      return recordsOf(k).filter(function (b) { return (b.def && b.def.id === id) || b.key === id; })[0] || null;
    }
    var hit = recordsOf(k).filter(function (x) { return x.id === id; })[0];
    /* Plasmids, cDNAs and genes share a store. A chip written before the
       three were told apart, or one naming a record whose kind has since
       been changed, should still resolve rather than read as removed. */
    if (!hit && CLONING.indexOf(kind) >= 0) {
      var inv = (typeof getInventory === 'function' && getInventory()) || {};
      hit = (inv.plasmids || []).filter(function (x) { return x.id === id; })[0];
    }
    return hit || null;
  }

  // ---------- the chip ----------
  /* Rendered from the live record every time a page is opened, so a renamed
     plasmid reads correctly in an entry written months ago. */
  function paint(chip) {
    var kind = chip.getAttribute('data-kind'), id = chip.getAttribute('data-id');
    var rec = lookup(kind, id);
    var label = rec ? (kind === 'user' ? rec.name : labelOf(kind, rec)) : '';
    chip.setAttribute('contenteditable', 'false');
    chip.classList.toggle('gone', !rec);
    if (rec) {
      chip.textContent = '@' + label;
      chip.title = (BY_KIND[kind] ? BY_KIND[kind].label : 'Person') + ' — click to open';
    } else {
      // The name it was written with is the only trace left, so keep it.
      if (!/\(removed\)$/.test(chip.textContent)) {
        chip.textContent = (chip.textContent || '@?').replace(/\s*\(removed\)$/, '') + ' (removed)';
      }
      chip.title = 'This is no longer in the inventory';
    }
  }
  function hydrate(root) {
    (root || document).querySelectorAll('.ln-mention').forEach(paint);
  }

  // ---------- opening what a mention names ----------
  function open(kind, id) {
    var rec = lookup(kind, id);
    if (!rec) { alert('That is no longer in the lab notebook.'); return; }
    if (kind === 'user') { showPerson(rec); return; }
    // Things with a page of their own open on it. The point of citing one
    // mid-experiment is to read it, not to be shown where it is filed.
    if (CLONING.indexOf(kind) >= 0) { if (window.openPlasmid) openPlasmid(id); return; }
    if (kind === 'protocol') { if (window.viewProtocol) viewProtocol(id); return; }
    if (kind === 'experiment') { if (window.openEntry) openEntry(id); return; }
    // window.openBox, spelled out: this file has an openBox of its own for
    // the popup, and the bare name would reach that one instead.
    if (kind === 'box') { if (window.openBox) window.openBox(rec.key); return; }
    var section = BY_KIND[kind] && BY_KIND[kind].section;
    if (!section || !window.lnShow) return;
    lnShow(section);
    // The Primers page is the generator in an iframe, so there is no row of
    // ours to point at — opening the page is as far as this goes.
    setTimeout(function () { flashRow(id); }, 60);
  }
  /* Any element carrying the id, not only a table row: presentations are
     cards and a grant is a card too. */
  function flashRow(id) {
    var row = document.querySelector('[data-item-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('ln-row-flash');
    setTimeout(function () { row.classList.remove('ln-row-flash'); }, 2200);
  }
  function showPerson(u) {
    var mine = (typeof currentUser === 'function' && currentUser()) || {};
    document.getElementById('ln-modal-content').innerHTML =
      '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + esc(u.name) + '</h3>' +
      '<p class="ln-bulk-intro">' + esc(u.email || 'No email on file') +
        (u.role ? ' · ' + esc(u.role) : '') + '</p>' +
      '<p class="ln-bulk-intro">Mentioning somebody puts this entry in their Mentions list in the notebook. ' +
        'There is no mail server behind the notebook, so nothing is emailed' +
        (u.email ? ' — use the button below if you want to tell them now.' : '.') + '</p>' +
      '<div class="ln-modal-actions">' +
        (u.email && u.id !== mine.id
          ? '<a class="ln-add-btn ghost ln-add-link" href="mailto:' + esc(u.email) +
            '?subject=' + encodeURIComponent('Lab notebook entry') + '">Email ' + esc(u.name.split(' ')[0]) + '</a>'
          : '') +
        '<button class="ln-modal-cancel" onclick="closeModal()">Close</button></div>';
    document.getElementById('ln-modal-bg').classList.add('open');
  }

  // ---------- entries that mention me ----------
  /* Read out of the entries rather than kept in a table of their own: a
     notification row that disagrees with the entry it points at is worse
     than no row, and this cannot disagree. */
  function mentioning(userId) {
    if (!userId || typeof getNotebooks !== 'function') return [];
    var out = [];
    getNotebooks().forEach(function (n) {
      if (!n || !n.body || n.archived) return;
      if (n.body.indexOf(userId) < 0) return;      // cheap reject before parsing
      var doc;
      try { doc = new DOMParser().parseFromString(n.body, 'text/html'); } catch (e) { return; }
      var hit = doc.querySelector('.ln-mention[data-kind="user"][data-id="' + userId.replace(/"/g, '') + '"]');
      if (hit) out.push(n);
    });
    return out;
  }

  // ---------- typing @ ----------
  var box = null, ctx = null, items = [], active = 0;

  function close() {
    if (box) { box.remove(); box = null; }
    ctx = null; items = []; active = 0;
  }
  function isOpen() { return !!box; }

  /* Where the caret is, and what has been typed since the @. The character
     before the @ has to be a space or the start of a line, so an email
     address in the middle of a sentence does not open a search. */
  function detect(editor) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!r.collapsed || !editor.contains(r.startContainer)) return null;
    var node = r.startContainer;
    if (node.nodeType !== 3) return null;
    var before = node.textContent.slice(0, r.startOffset);
    var m = /(?:^|[\s (\[])@([^\s@<>]{0,40})$/.exec(before);
    if (!m) return null;
    return { node: node, from: r.startOffset - m[1].length - 1, to: r.startOffset, q: m[1] };
  }

  function render() {
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<div class="ln-mention-empty">Nothing in the lab matches that.</div>';
      return;
    }
    box.innerHTML = items.map(function (e, i) {
      return '<button type="button" class="ln-mention-opt' + (i === active ? ' on' : '') + '" data-i="' + i + '">' +
        '<span class="ln-mention-ico">' + (ICONS[e.kind] || '●') + '</span>' +
        '<span class="ln-mention-main"><span class="ln-mention-label">' + esc(e.label) + '</span>' +
        (e.meta ? '<span class="ln-mention-meta">' + esc(e.meta) + '</span>' : '') + '</span>' +
        '<span class="ln-mention-group">' + esc(e.group) + '</span></button>';
    }).join('');
    var on = box.querySelector('.ln-mention-opt.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  function place() {
    if (!box || !ctx) return;
    var r = document.createRange();
    try {
      r.setStart(ctx.node, ctx.from);
      r.setEnd(ctx.node, ctx.to);
    } catch (e) { return; }
    var rect = r.getBoundingClientRect();
    if (!rect.width && !rect.height) rect = ctx.node.parentNode.getBoundingClientRect();
    var top = rect.bottom + 6, left = rect.left;
    // Flip above the line when there is no room below it.
    if (top + 280 > window.innerHeight && rect.top > 300) top = rect.top - Math.min(280, box.offsetHeight || 280) - 6;
    box.style.top = Math.round(top) + 'px';
    box.style.left = Math.round(Math.min(left, window.innerWidth - 340)) + 'px';
  }

  function openBox(editor) {
    if (box) return;
    box = document.createElement('div');
    box.className = 'ln-mention-pop';
    box.addEventListener('mousedown', function (e) {
      // mousedown, not click: the editor would lose the selection first.
      var opt = e.target.closest('.ln-mention-opt');
      if (!opt) return;
      e.preventDefault();
      choose(+opt.dataset.i, editor);
    });
    document.body.appendChild(box);
  }

  function refresh(editor) {
    ctx = detect(editor);
    if (!ctx) { close(); return; }
    openBox(editor);
    items = search(ctx.q, 8);
    active = 0;
    render();
    place();
  }

  function choose(i, editor) {
    var e = items[i];
    if (!e || !ctx) { close(); return; }
    var r = document.createRange();
    try {
      r.setStart(ctx.node, ctx.from);
      r.setEnd(ctx.node, ctx.to);
    } catch (err) { close(); return; }
    r.deleteContents();

    var chip = document.createElement('span');
    chip.className = 'ln-mention';
    chip.setAttribute('data-kind', e.kind);
    chip.setAttribute('data-id', e.id);
    chip.textContent = '@' + e.label;
    chip.setAttribute('contenteditable', 'false');
    r.insertNode(chip);

    // A space after it, so the next word is not stuck to the chip and there
    // is somewhere to put the caret that is outside it.
    var sp = document.createTextNode(' ');
    chip.parentNode.insertBefore(sp, chip.nextSibling);
    var sel = window.getSelection();
    var after = document.createRange();
    after.setStart(sp, 1); after.collapse(true);
    sel.removeAllRanges(); sel.addRange(after);

    close();
    if (window.markEntryDirty) markEntryDirty();
    editor.focus();
  }

  function onKeyDown(e, editor) {
    if (!isOpen()) return false;
    if (e.key === 'Escape') { close(); e.preventDefault(); return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return false;
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render(); e.preventDefault(); return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!items.length) { close(); return false; }
      choose(active, editor); e.preventDefault(); return true;
    }
    return false;
  }

  /* Wire an editor up. Called every time an entry is drawn, so it guards
     against being attached twice to the same element. */
  function attach(editor) {
    if (!editor || editor._mentions) return;
    editor._mentions = true;

    editor.addEventListener('input', function () { refresh(editor); });
    editor.addEventListener('keydown', function (e) { onKeyDown(e, editor); }, true);
    editor.addEventListener('blur', function () { setTimeout(close, 150); });
    editor.addEventListener('click', function (e) {
      var chip = e.target.closest && e.target.closest('.ln-mention');
      if (!chip) return;
      e.preventDefault();
      open(chip.getAttribute('data-kind'), chip.getAttribute('data-id'));
    });
    document.addEventListener('scroll', function () { if (isOpen()) place(); }, true);
  }

  window.LabMentions = {
    KINDS: KINDS, entities: entities, search: search, lookup: lookup,
    labelOf: labelOf, hydrate: hydrate, open: open, mentioning: mentioning,
    attach: attach, close: close, isOpen: isOpen,
    // for checks
    _detect: detect
  };
})();
