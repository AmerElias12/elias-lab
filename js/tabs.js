/* ============================================================
   Elias Lab Notebook — internal tabs
   ------------------------------------------------------------
   Several pages open at once, inside the notebook, the way a
   browser holds tabs: cloning means comparing a vector against a
   donor against the construct you just made, and one page at a
   time turns that into a lot of clicking back and forth.

   A tab is a *place*: a section, optionally with the id of one
   item in it. "inv-plasmids" is the list; "plasmid/abc" is one
   plasmid's page. The key is the two joined, and it is also the
   address bar's hash for the pages that have one.

   What this module does NOT do is know how any page works. A
   section that holds unsaved state registers a handler saying
   how to pick that state up and put it back; everything else
   needs nothing, because a list redraws itself from the data.

      LabTabs.register('plasmid', {
        title:   function (id) { ... },
        capture: function ()   { return state; },
        restore: function (st) { ... },
        dirty:   function ()   { return true/false; }
      });

   Switching away captures; switching back restores. That is the
   whole contract, and it is why leaving a half-edited plasmid no
   longer asks whether you meant it — the edit is still there when
   you come back. The question is asked when a tab is *closed*,
   which is the point where the work would actually be lost.
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'elias_ln_tabs';
  var MAX_TABS = 12;

  var tabs = [];          // [{ key, section, id, state }]
  var currentKey = null;
  var handlers = {};      // section -> { title, capture, restore, dirty, icon }
  var mounted = false;

  /* Sections whose own <h2> is not a name — the dashboard greets you by
     name, which makes a poor tab. Everything else is read off the page, so
     adding a section needs nothing here. */
  var LABELS = { dashboard: 'Dashboard', entry: 'Entry', plasmid: 'Plasmid' };
  var ICONS = {
    dashboard: '▦', protocols: '⌸', notebooks: '✎', entry: '✎',
    presentations: '◱', webapps: '⚙', boxes: '⬚', admin: '☸',
    plasmid: '⦿', 'inv-plasmids': '⦿', 'inv-primers': '→',
    'inv-enzymes': '✂', 'inv-stocks': '❄', 'inv-cells': '◌',
    'inv-kits': '▧'
  };

  function keyOf(section, id) { return id ? section + '/' + id : section; }
  function find(key) {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].key === key) return tabs[i];
    return null;
  }
  function indexOf(key) {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].key === key) return i;
    return -1;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* A tab's name, asked for fresh every time it is drawn: renaming a plasmid
     should rename its tab, and a title captured once would go stale. */
  function titleOf(tab) {
    var h = handlers[tab.section];
    if (h && h.title) {
      // The held state too, so a tab that is off screen with an unsaved
      // rename in it shows the new name rather than the one on disk.
      var t = h.title(tab.id, tab.state);
      if (t) return t;
    }
    if (LABELS[tab.section]) return LABELS[tab.section];
    var head = document.querySelector('#ln-' + tab.section + ' .ln-section-header h2');
    return head ? head.textContent.trim() : tab.section;
  }
  function isDirty(tab) {
    if (tab.key !== currentKey) return !!(tab.state && tab.state.__dirty);
    var h = handlers[tab.section];
    return !!(h && h.dirty && h.dirty());
  }

  /* Whether a place is worth a tab of its own. An item page always is. A
     section is, too — that is what "everything that has a page" means — but
     the login screen and the modals are not sections and never get here. */
  function isPlace(section) {
    return !!section && !!document.getElementById('ln-' + section);
  }

  // ---------- the strip ----------
  function strip() { return document.getElementById('ln-tabstrip'); }

  function render() {
    var el = strip();
    if (!el) return;
    if (!tabs.length) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = tabs.map(function (t) {
      var name = titleOf(t);
      return '<div class="ln-tab' + (t.key === currentKey ? ' on' : '') + (isDirty(t) ? ' dirty' : '') + '"' +
        ' role="tab" aria-selected="' + (t.key === currentKey ? 'true' : 'false') + '"' +
        ' title="' + esc(name) + '" onclick="LabTabs.focus(\'' + esc(t.key) + '\')">' +
        '<span class="ln-tab-icon" aria-hidden="true">' + (ICONS[t.section] || '●') + '</span>' +
        '<span class="ln-tab-name">' + esc(name) + '</span>' +
        '<button type="button" class="ln-tab-x" aria-label="Close ' + esc(name) + '"' +
        ' onclick="event.stopPropagation();LabTabs.close(\'' + esc(t.key) + '\')">×</button>' +
        '</div>';
    }).join('') +
      (tabs.length > 1 ? '<button type="button" class="ln-tab-closeall" onclick="LabTabs.closeOthers()">Close others</button>' : '');
    save();
  }

  // ---------- remembering which tabs were open ----------
  /* Only which places were open, never what was typed in them. A draft that
     survived a reload without being saved would be a promise this cannot
     keep — the reload warning is what covers that. */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: tabs.map(function (t) { return { section: t.section, id: t.id }; }),
        current: currentKey
      }));
    } catch (e) { /* private window, or storage is full: tabs just do not persist */ }
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
  }

  // ---------- the API ----------
  var LabTabs = {
    /* Called by a section as it becomes visible. Bookkeeping only — it never
       navigates, which is what keeps it safe to call from inside lnShow. */
    noteShow: function (section, id) {
      if (!isPlace(section)) return;
      var key = keyOf(section, id);
      if (key === currentKey) { render(); return; }
      stashCurrent();
      var tab = find(key);
      if (!tab) {
        tab = { key: key, section: section, id: id || null, state: null };
        // A new tab lands next to the one it was opened from, like a browser,
        // rather than at the far end of a row you then have to hunt along.
        var at = indexOf(currentKey);
        if (at >= 0) tabs.splice(at + 1, 0, tab); else tabs.push(tab);
        if (tabs.length > MAX_TABS) dropOldest();
      }
      currentKey = key;
      render();
    },

    /* Clicking a tab. This one does navigate. */
    focus: function (key) {
      var tab = find(key);
      if (!tab || key === currentKey) return;
      stashCurrent();
      currentKey = key;
      render();
      if (tab.id) {
        var hash = '#' + tab.section + '/' + tab.id;
        if (location.hash === hash) {
          if (tab.section === 'plasmid' && window.routePlasmid) routePlasmid();
          else if (window.routeHash) routeHash();
        } else {
          location.hash = hash;
        }
      } else if (window.lnShow) {
        lnShow(tab.section);
      }
    },

    close: function (key) {
      var at = indexOf(key);
      if (at < 0) return;
      var tab = tabs[at];
      if (isDirty(tab) &&
          !confirm(titleOf(tab) + ' has unsaved changes. Close it and lose them?')) return;
      var wasCurrent = key === currentKey;
      var h = handlers[tab.section];
      if (h && h.discard) h.discard(tab.id, wasCurrent);
      tabs.splice(at, 1);
      if (!wasCurrent) { render(); return; }
      currentKey = null;
      var next = tabs[at] || tabs[at - 1];
      if (next) this.focus(next.key);
      else { render(); if (window.lnShow) lnShow('dashboard'); }
    },

    closeOthers: function () {
      var keep = currentKey;
      var others = tabs.filter(function (t) { return t.key !== keep; });
      for (var i = 0; i < others.length; i++) this.close(others[i].key);
    },

    register: function (section, handler) { handlers[section] = handler; },

    /* The state put aside when this tab was last left, handed over once. The
       caller owns it afterwards, so a half-finished restore cannot be applied
       twice. */
    takeState: function (key) {
      var tab = find(key);
      if (!tab || !tab.state) return null;
      var st = tab.state;
      tab.state = null;
      return st;
    },

    /* The page was renamed, or its dirty flag moved. */
    refresh: render,

    current: function () { return currentKey; },
    list: function () { return tabs.map(function (t) { return { key: t.key, section: t.section, id: t.id, title: titleOf(t) }; }); },

    /* Reopen what was open last time, then go wherever the address bar says.
       Called once, after sign-in, when the data is there to name things with. */
    boot: function () {
      if (mounted) return;
      mounted = true;
      var saved = load();
      if (!saved || !saved.open || !saved.open.length) return;
      saved.open.forEach(function (p) {
        if (!isPlace(p.section)) return;
        if (p.id && !itemExists(p.section, p.id)) return;
        var key = keyOf(p.section, p.id);
        if (find(key)) return;
        tabs.push({ key: key, section: p.section, id: p.id || null, state: null });
      });
      render();
    }
  };

  /* A tab whose item has since been deleted elsewhere would reopen as "could
     not be found", which is a worse greeting than simply not reopening. */
  function itemExists(section, id) {
    try {
      if (section === 'plasmid') {
        return (getInventory().plasmids || []).some(function (x) { return x.id === id; });
      }
      if (section === 'entry') {
        return getNotebooks().some(function (x) { return x.id === id; });
      }
    } catch (e) { return false; }
    return true;
  }

  function stashCurrent() {
    if (!currentKey) return;
    var tab = find(currentKey);
    if (!tab) return;
    var h = handlers[tab.section];
    if (!h || !h.capture) return;
    var st = h.capture();
    if (st) { st.__dirty = !!(h.dirty && h.dirty()); tab.state = st; }
  }

  /* When there are too many, the oldest tab with nothing unsaved in it goes.
     Never one with unsaved work, and never the current one. */
  function dropOldest() {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].key !== currentKey && !isDirty(tabs[i])) { tabs.splice(i, 1); return; }
    }
  }

  window.LabTabs = LabTabs;
})();
