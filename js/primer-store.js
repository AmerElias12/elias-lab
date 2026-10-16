/* ===========================================================================
   primer-store.js — the lab's primers, somewhere everyone can see them

   The primer generator kept its two lists in localStorage. That made them
   per browser: a primer somebody ordered from their own machine was invisible
   to everyone else, and invisible to the plasmid page on the next machine
   along. They now live in the shared inventory, under the `primers` category,
   one row per record the generator makes.

   No schema change was needed. inventory_items is { id, category, data,
   added_by } with data as JSON, so a record keeps whatever shape the
   generator gave it; a `kind` field says which of the two lists it came from.
   The columns the rest of the notebook expects of a primer — name, sequence,
   tm, application, storage — are filled in alongside, so a row is legible to
   code that knows nothing about gRNA cloning.

   Where it writes
   ---------------
   The generator runs in an iframe inside the notebook, from the same origin,
   so it can reach the notebook's data layer through window.parent. Opened on
   its own, with no notebook around it, there is nobody to share with and it
   falls back to this browser's localStorage, which is what it always did.

   Primer numbers
   --------------
   Worked out from the highest number already recorded, rather than kept in a
   counter of their own. A counter shared between people is a counter two
   people can hold at the same value, and the list is the thing that is really
   shared — so the next number comes from the list.
   ======================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // tests
  else root.PrimerStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORY = 'primers';
  const LS = { grna: 'grnaPrimers', regular: 'regPrimers' };
  const MIGRATED = 'primersMovedToShared';

  /* The notebook's data layer: this page's own, or the one belonging to the
     page that embedded us. Reaching into window.parent throws if it is not
     the same origin, which is its own answer — it is not our notebook. */
  function host() {
    try {
      if (typeof window === 'undefined') return null;
      if (window.DB && window.getInventory) return window;
      const up = window.parent;
      if (up && up !== window && up.DB && up.getInventory) return up;
    } catch (e) { /* cross-origin */ }
    return null;
  }
  function isShared() { return !!host(); }

  function lsGet(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) { return []; }
  }
  function lsSet(key, list) {
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { /* full or blocked */ }
  }

  function where(r) {
    return [r.freezer, r.shelf, r.box].filter(Boolean).join(' · ');
  }

  /* One generator record -> one inventory row. The record is kept whole, so
     nothing the generator relies on is lost on the way through; the fields
     added on top are the ones the rest of the notebook reads. */
  function toRow(kind, rec, addedBy) {
    const row = Object.assign({}, rec, {
      id: String(rec.id),
      kind: kind,
      storage: where(rec),
      application: rec.description || ''
    });
    if (kind === 'grna') {
      row.name = [rec.forwardName, rec.reverseName].filter(Boolean).join(' / ') || 'gRNA primer pair';
      row.sequence = rec.spacerSeq || rec.forwardPrimer || '';
    } else {
      row.name = rec.name || ('PR' + (rec.number || ''));
      row.sequence = rec.sequence || '';
      row.tm = rec.tm || '';
    }
    if (addedBy) row.addedBy = addedBy;
    return row;
  }
  // and back again, so the generator sees exactly what it stored
  function fromRow(row) {
    const rec = Object.assign({}, row);
    delete rec.kind; delete rec.storage; delete rec.application; delete rec.addedBy;
    return rec;
  }

  function rowsOf(h, kind) {
    return (h.getInventory()[CATEGORY] || []).filter(function (r) { return r && r.kind === kind; });
  }

  /* Whatever this browser still has, moved up once. The local copy is left
     where it is: if the move half fails, nothing has been thrown away, and a
     second run skips the records that already arrived. */
  async function migrateLocal(h) {
    let already = false;
    try { already = localStorage.getItem(MIGRATED) === '1'; } catch (e) { /* blocked */ }
    if (already) return 0;
    const user = (h.currentUser && h.currentUser()) || null;
    const addedBy = user ? user.name : null;
    let moved = 0;
    for (const kind of ['grna', 'regular']) {
      const mine = lsGet(LS[kind]);
      if (!mine.length) continue;
      const have = {};
      rowsOf(h, kind).forEach(function (r) { have[String(r.id)] = true; });
      for (const rec of mine) {
        if (!rec || rec.id == null || have[String(rec.id)]) continue;
        await h.DB.upsertInventory(CATEGORY, toRow(kind, rec, addedBy));
        moved++;
      }
    }
    try { localStorage.setItem(MIGRATED, '1'); } catch (e) { /* blocked */ }
    return moved;
  }

  function counters(grna, regular) {
    let g = 0, r = 0;
    grna.forEach(function (x) { g = Math.max(g, +x.forwardNumber || 0, +x.reverseNumber || 0); });
    regular.forEach(function (x) { r = Math.max(r, +x.number || 0); });
    return { grnaCounter: g + 1, regCounter: r + 1 };
  }

  /**
   * Both lists, and the number each should carry on from.
   * Resolves to { grna, regular, grnaCounter, regCounter, shared, moved }.
   */
  async function load() {
    const h = host();
    if (!h) {
      const grna = lsGet(LS.grna), regular = lsGet(LS.regular);
      return Object.assign({ grna, regular, shared: false, moved: 0 }, counters(grna, regular));
    }
    let moved = 0;
    try { moved = await migrateLocal(h); } catch (e) { moved = 0; }
    const grna = rowsOf(h, 'grna').map(fromRow);
    const regular = rowsOf(h, 'regular').map(fromRow);
    return Object.assign({ grna, regular, shared: true, moved }, counters(grna, regular));
  }

  function differs(a, b) {
    // the stored row carries extra fields; compare only what the generator set
    return Object.keys(b).some(function (k) {
      return k !== 'addedBy' && JSON.stringify(a[k]) !== JSON.stringify(b[k]);
    });
  }

  /**
   * Make the shared list match `list`. Works out what is new, what changed
   * and what has gone, rather than rewriting every row each time somebody
   * adds one primer.
   */
  async function save(kind, list) {
    const h = host();
    if (!h) { lsSet(LS[kind], list || []); return; }
    const user = (h.currentUser && h.currentUser()) || null;
    const addedBy = user ? user.name : null;
    const existing = {};
    rowsOf(h, kind).forEach(function (r) { existing[String(r.id)] = r; });

    const seen = {}, fresh = [];
    for (const rec of (list || [])) {
      if (!rec || rec.id == null) continue;
      const id = String(rec.id);
      seen[id] = true;
      const row = toRow(kind, rec, addedBy);
      if (!existing[id]) fresh.push(row);
      else if (differs(existing[id], row)) await h.DB.upsertInventory(CATEGORY, row);
    }
    // A CSV import arrives as one big list; sending it row by row would be a
    // round trip each.
    if (fresh.length > 4 && h.DB.addInventoryMany) await h.DB.addInventoryMany(CATEGORY, fresh);
    else for (const row of fresh) await h.DB.upsertInventory(CATEGORY, row);

    for (const id of Object.keys(existing)) {
      if (!seen[id]) await h.DB.removeInventory(CATEGORY, id);
    }
  }

  /**
   * Every primer the lab has, flattened to the ones you would actually order:
   * a gRNA record is one pair, so it becomes its two primers. This is what
   * the plasmid page searches.
   */
  function flat() {
    const h = host();
    const grna = h ? rowsOf(h, 'grna').map(fromRow) : lsGet(LS.grna);
    const regular = h ? rowsOf(h, 'regular').map(fromRow) : lsGet(LS.regular);
    const out = [];
    regular.forEach(function (r) {
      if (!r || !r.sequence) return;
      out.push({ name: r.name || ('PR' + (r.number || '')), seq: String(r.sequence).toUpperCase(),
        kind: 'primer', note: r.description || '', where: where(r) });
    });
    grna.forEach(function (r) {
      if (!r) return;
      const note = [r.description, r.spacerSeq ? 'spacer ' + r.spacerSeq : ''].filter(Boolean).join(' · ');
      if (r.forwardPrimer) out.push({ name: r.forwardName || 'gRNA forward',
        seq: String(r.forwardPrimer).toUpperCase(), kind: 'gRNA cloning', note: note, where: where(r) });
      if (r.reversePrimer) out.push({ name: r.reverseName || 'gRNA reverse',
        seq: String(r.reversePrimer).toUpperCase(), kind: 'gRNA cloning', note: note, where: where(r) });
    });
    return out.filter(function (x) { return x.seq.length; });
  }

  return { load, save, flat, isShared, toRow, fromRow, counters, CATEGORY };
}));
