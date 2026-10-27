/* ============================================================
   Elias Lab Notebook — UI logic
   Reads from the cache (getProtocols(), etc. in data.js) and
   writes through async DB.* mutators. Works in local OR shared
   (Supabase) mode transparently.
   ============================================================ */

// ── REMEMBERED LOGIN EMAILS ────────────────────────────────
// Emails that have signed in on this device (most recent first).
// Only addresses — passwords are never stored.
var LN_EMAILS_KEY = 'elias_ln_known_emails';

function getKnownEmails() {
  try { return JSON.parse(localStorage.getItem(LN_EMAILS_KEY) || '[]'); }
  catch (e) { return []; }
}
function rememberEmail(email) {
  if (!email) return;
  email = email.toLowerCase().trim();
  var list = getKnownEmails().filter(function (e) { return e !== email; });
  list.unshift(email);
  try { localStorage.setItem(LN_EMAILS_KEY, JSON.stringify(list.slice(0, 5))); } catch (e) { }
}
function forgetEmail(email) {
  var list = getKnownEmails().filter(function (e) { return e !== email; });
  try { localStorage.setItem(LN_EMAILS_KEY, JSON.stringify(list)); } catch (e) { }
  renderKnownEmails();
}
function renderKnownEmails() {
  var list = getKnownEmails();
  var dl = document.getElementById('ln-known-emails');
  if (dl) dl.innerHTML = list.map(function (e) { return '<option value="' + esc(e) + '">'; }).join('');

  var chips = document.getElementById('ln-email-chips');
  if (!chips) return;
  if (!list.length) { chips.innerHTML = ''; return; }
  chips.innerHTML = list.map(function (e) {
    return '<span class="ln-email-chip"><button type="button" class="ln-chip-use" onclick="useKnownEmail(\'' + esc(e) + '\')">' + esc(e) + '</button>' +
      '<button type="button" class="ln-chip-x" title="Forget this email" aria-label="Forget ' + esc(e) + '" onclick="forgetEmail(\'' + esc(e) + '\')">×</button></span>';
  }).join('');
}
// Reveal the password field — makes it obvious when the browser has autofilled
// something other than what you meant to type.
function lnTogglePw() {
  var f = document.getElementById('ln-password');
  var b = document.getElementById('ln-pw-toggle');
  if (!f || !b) return;
  var show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  b.textContent = show ? 'Hide' : 'Show';
  b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  f.focus();
}

function useKnownEmail(email) {
  var f = document.getElementById('ln-email');
  if (f) f.value = email;
  var pw = document.getElementById('ln-password');
  if (pw) pw.focus();
}

// ── AUTH SCREENS ───────────────────────────────────────────
function showLoginScreen() {
  document.getElementById('ln-login-screen').style.display = 'flex';
  document.getElementById('ln-app').style.display = 'none';
  renderKnownEmails();
  var last = getKnownEmails()[0];
  var f = document.getElementById('ln-email');
  if (last && f && !f.value) f.value = last;
}
function lnMsg(txt, type) {
  var el = document.getElementById('ln-login-msg');
  el.style.display = 'block'; el.className = 'ln-msg ' + type; el.textContent = txt;
}
function lnAuthMode(mode) {
  document.getElementById('ln-signup-fields').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('ln-signin-link').style.display = mode === 'signup' ? 'inline' : 'none';
  document.getElementById('ln-signup-link').style.display = mode === 'signup' ? 'none' : 'inline';
  document.getElementById('ln-primary-btn').textContent = mode === 'signup' ? 'Create Account →' : 'Sign In →';
  document.getElementById('ln-primary-btn').dataset.mode = mode;
  document.getElementById('ln-login-msg').style.display = 'none';
}
async function lnPrimary() {
  var mode = document.getElementById('ln-primary-btn').dataset.mode || 'signin';
  var email = document.getElementById('ln-email').value.trim();
  var pw = document.getElementById('ln-password').value;
  if (!email || !pw) { lnMsg('Please enter email and password.', 'error'); return; }
  if (mode === 'signup') {
    var name = document.getElementById('ln-name').value.trim();
    if (!name) { lnMsg('Please enter your full name.', 'error'); return; }
    lnMsg('Creating account…', 'info');
    var r = await DB.signUp(name, email, pw);
    if (!r.ok) { lnMsg(r.error, 'error'); return; }
    lnMsg('Account created! It is now pending approval by the PI. You will be able to sign in once approved.' + (DB.mode === 'supabase' ? ' Check your email to confirm your address.' : ''), 'success');
    lnAuthMode('signin');
    return;
  }
  lnMsg('Signing in…', 'info');
  var res = await DB.signIn(email, pw);
  if (!res.ok) { lnMsg(res.error, 'error'); return; }
  rememberEmail(email);
  lnShowApp(res.user);
}
async function lnLogout() {
  await DB.signOut();
  // Keep the email so signing back in is one field; clear only the password.
  document.getElementById('ln-password').value = '';
  document.getElementById('ln-login-msg').style.display = 'none';
  showLoginScreen();
}

function lnShowApp(user) {
  document.getElementById('ln-login-screen').style.display = 'none';
  document.getElementById('ln-app').style.display = 'block';
  document.getElementById('ln-sidebar-name').textContent = user.name;
  document.getElementById('ln-welcome-msg').textContent = 'Welcome back, ' + user.name.split(' ').slice(-1)[0] + '!';
  document.getElementById('ln-admin-nav').style.display = user.role === 'admin' ? 'block' : 'none';
  lnLastRefresh = Date.now();
  // A link to an entry (#entry/<id>, e.g. opened in a new tab) goes straight
  // to it; showing the dashboard first would clear that address.
  var target = location.hash;
  // Reopen whatever was open last time *before* showing anything: the first
  // lnShow saves the tab list, which would write over the list being read.
  if (window.LabTabs) LabTabs.boot();
  lnShow('dashboard');
  if (/^#(entry|plasmid)\//.test(target)) { history.replaceState(null, '', target); routeHash(); }
}

// ── SHARED-MODE REFRESH ────────────────────────────────────
// Pull other members' edits whenever the tab comes back into view, and every
// 30 minutes while it stays open (which also renews attachment links before
// they expire). Skipped while a form is open so nothing is redrawn mid-edit.
var lnCurrentSection = 'dashboard';
var lnLastRefresh = 0, lnRefreshing = false;
var LN_REFRESH_MIN_GAP = 30 * 1000;
async function lnRefreshFromServer() {
  if (lnRefreshing || DB.mode !== 'supabase' || !currentUser()) return;
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lnLastRefresh < LN_REFRESH_MIN_GAP) return;
  if (document.getElementById('ln-modal-bg').classList.contains('open')) return;
  if (lnCurrentSection === 'entry' || lnCurrentSection === 'plasmid') return; // may hold unsaved edits
  lnRefreshing = true;
  try {
    if (await DB.refresh()) { lnLastRefresh = Date.now(); lnRerender(); }
  } catch (e) { /* offline or a transient error: keep showing the cached data */ }
  finally { lnRefreshing = false; }
}
// Redraw the open section, keeping whatever is typed in its search box.
function lnRerender() {
  var s = lnCurrentSection;
  var search = document.querySelector('#ln-' + s + ' .ln-search');
  if (s === 'protocols') renderProtocols(search ? search.value : '');
  else if (s === 'notebooks') renderNotebooks(search ? search.value : '');
  else if (s === 'admin') renderAdmin();
  else lnShow(s);
}
document.addEventListener('visibilitychange', lnRefreshFromServer);
window.addEventListener('focus', lnRefreshFromServer);
setInterval(lnRefreshFromServer, 30 * 60 * 1000);

// ── PRINTING ───────────────────────────────────────────────
/* Every page has a Print button (window.print). Print CSS hides the sidebar,
   buttons and search boxes; this header says what was printed, when, by whom. */
window.addEventListener('beforeprint', function () {
  var head = document.getElementById('ln-print-head');
  if (!head) return;
  var sec = document.querySelector('.ln-section.active');
  var title = sec && sec.id === 'ln-entry' ? (document.getElementById('e-title') || {}).value : (sec && sec.querySelector('h2') ? sec.querySelector('h2').textContent : '');
  var user = currentUser();
  head.textContent = 'Elias Lab \u00b7 Lab Notebook' + (title ? ' \u2014 ' + title : '') + ' \u00b7 printed ' +
    new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + (user ? ' by ' + user.name : '');
});

// ── NAVIGATION ─────────────────────────────────────────────
function lnShow(section) {
  // Leaving an edited page no longer loses it: the tab keeps what was typed,
  // and the question is asked when the tab is closed instead. So nothing is
  // confirmed here, and entryDirty survives the move.
  if (section !== 'entry' && section !== 'plasmid' && /^#(entry|plasmid)\//.test(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  // The two item pages are noted by their own render paths, which know the id;
  // keyed on the section alone they would all share one tab.
  if (section !== 'entry' && section !== 'plasmid' && window.LabTabs) LabTabs.noteShow(section);
  lnCurrentSection = section;
  document.querySelectorAll('.ln-section').forEach(function (s) { s.classList.remove('active'); });
  document.querySelectorAll('.ln-nav-item').forEach(function (n) { n.classList.remove('active'); });
  var sec = document.getElementById('ln-' + section); if (sec) sec.classList.add('active');
  document.querySelectorAll('.ln-nav-item').forEach(function (n) { var oc = n.getAttribute('onclick'), nav = section === 'entry' ? 'notebooks' : section === 'plasmid' ? 'inv-plasmids' : section;
    if (oc && oc.indexOf("'" + nav + "'") >= 0) n.classList.add('active'); });
  if (section === 'dashboard') renderDashboard();
  else if (section === 'protocols') renderProtocols();
  else if (section === 'notebooks') renderNotebooks();
  else if (section === 'presentations') renderPresentations();
  else if (section === 'webapps') renderWebapps();
  else if (section.indexOf('inv-') === 0) showInventoryPage(section.slice(4));
  else if (section === 'boxes') renderBoxes();
  else if (section === 'admin') { renderAdmin(); refreshAdmin(); }
}
// pull fresh user list (catches new sign-ups), then re-render
async function refreshAdmin() {
  if (!DB.isAdmin()) return;
  try { await DB.refreshUsers(); renderAdmin(); } catch (e) { /* keep cached view */ }
}

// ── DASHBOARD ──────────────────────────────────────────────
/* Each stat card is a category; clicking it opens a breakdown underneath
   (presentations per lab member, protocols per category, ...). One open at
   a time; clicking a row goes to that page, filtered when it has a search. */
var dashOpen = null;
var DASH_INV_CATS = ['enzymes', 'primers', 'plasmids', 'stocks', 'cells', 'kits'];
var DASH_INV_NAMES = { enzymes: 'Restriction Enzymes', primers: 'Primers', plasmids: 'Plasmids', stocks: 'Glycerol Stocks', cells: 'Tissue Culture', kits: 'Kits & Reagents' };

// Count items by a free-text field, merging case and spacing differences.
// Names in `always` (lab members) are listed even with a count of zero.
function dashCountBy(items, field, always) {
  var rows = {}, order = [];
  function row(raw) {
    var name = String(raw || '').trim(), key = name.toLowerCase();
    if (!rows[key]) { rows[key] = { name: name || 'Not specified', query: name, count: 0 }; order.push(key); }
    return rows[key];
  }
  (always || []).forEach(function (n) { if (String(n || '').trim()) row(n); });
  items.forEach(function (it) { row(it[field]).count++; });
  return order.map(function (k) { return rows[k]; })
    // Most first; entries with no name go last whatever their count.
    .sort(function (a, b) { return (!a.query - !b.query) || b.count - a.count || a.name.localeCompare(b.name); });
}
function dashSearch(section, q) {
  lnShow(section);
  var box = document.querySelector('#ln-' + section + ' .ln-search');
  if (box) box.value = q;
  if (section === 'protocols') renderProtocols(q); else renderNotebooks(q);
}
function dashGroups() {
  var members = getApprovedUserNames(), inv = getInventory();
  var notebooks = getNotebooks();
  var active = notebooks.filter(function (n) { return !n.archived; });
  var archived = notebooks.length - active.length;
  return [
    { key: 'protocols', label: 'Protocols', by: 'by category', rows: dashCountBy(getProtocols(), 'category'),
      go: function (r) { dashSearch('protocols', r.query); } },
    { key: 'experiments', label: 'Active Experiments', by: 'by researcher', rows: dashCountBy(active, 'researcher', members),
      note: archived ? archived + ' archived experiment' + (archived === 1 ? '' : 's') + ' not counted' : '',
      go: function (r) { dashSearch('notebooks', r.query); } },
    { key: 'presentations', label: 'Presentations', by: 'by presenter', rows: dashCountBy(getPresentations(), 'presenter', members),
      go: function () { lnShow('presentations'); } },
    { key: 'inventory', label: 'Inventory Items', by: 'by inventory page',
      // Primers live in the Primer Generator, so list them only if the inventory holds any.
      rows: DASH_INV_CATS.filter(function (c) { return c !== 'primers' || (inv.primers || []).length; })
        .map(function (c) { return { name: DASH_INV_NAMES[c], query: c, count: (inv[c] || []).length }; }),
      go: function (r) { lnShow('inv-' + r.query); } }
  ].map(function (grp) {
    grp.total = grp.rows.reduce(function (a, r) { return a + r.count; }, 0);
    return grp;
  });
}
function toggleDash(key) { dashOpen = dashOpen === key ? null : key; renderDashboard(); }
function dashGo(key, i) {
  var grp = dashGroups().filter(function (x) { return x.key === key; })[0];
  if (grp && grp.rows[i] && grp.rows[i].query) grp.go(grp.rows[i]);
}

/* Entries somebody has @-mentioned you in.

   This is what "notify" amounts to without a mail server: the entries that
   name you, read out of the entries themselves. Nothing is stored about it,
   so it cannot say you were mentioned in something that no longer mentions
   you — a notification that outlives its reason is worse than none. */
function renderMentionsPanel() {
  var host = document.getElementById('ln-mentions-panel');
  if (!host) return;
  var me = currentUser();
  var hits = (window.LabMentions && me) ? LabMentions.mentioning(me.id) : [];
  if (!hits.length) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  host.innerHTML = '<div class="ln-mentions-head">● You are mentioned in ' + hits.length +
      ' entr' + (hits.length === 1 ? 'y' : 'ies') + '</div>' +
    hits.slice(-6).reverse().map(function (n) {
      return '<button type="button" class="ln-mentions-row" onclick="openEntry(\'' + esc(n.id) + '\')">' +
        '<span class="ln-mentions-title">' + esc(n.title || 'Untitled entry') + '</span>' +
        '<span class="ln-mentions-meta">' + esc(n.researcher || '') +
        (n.date ? ' · ' + esc(n.date) : '') + '</span></button>';
    }).join('');
}

function renderDashboard() {
  var groups = dashGroups();
  document.getElementById('ln-stats-grid').innerHTML = groups.map(function (grp) {
    var open = dashOpen === grp.key;
    return '<button type="button" class="ln-stat-card' + (open ? ' open' : '') + '" aria-expanded="' + open + '" aria-controls="ln-dash-detail" onclick="toggleDash(\'' + grp.key + '\')">' +
      '<div class="ln-stat-num">' + grp.total + '</div><div class="ln-stat-label">' + grp.label + '</div>' +
      '<div class="ln-stat-by">' + grp.by + ' <span class="ln-stat-chev">' + (open ? '▴' : '▾') + '</span></div></button>';
  }).join('');

  var detail = document.getElementById('ln-dash-detail');
  var grp = groups.filter(function (x) { return x.key === dashOpen; })[0];
  if (!grp) { detail.innerHTML = ''; detail.hidden = true; }
  else {
    var max = grp.rows.reduce(function (m, r) { return Math.max(m, r.count); }, 0) || 1;
    detail.hidden = false;
    detail.innerHTML = '<div class="ln-dash-head"><strong>' + grp.label + '</strong> ' + grp.by + ' · ' + grp.total + ' total</div>' +
      (grp.rows.length ? grp.rows.map(function (r, i) {
        var inner = '<span class="ln-dash-name">' + esc(r.name) + '</span>' +
          '<span class="ln-dash-bar"><span style="width:' + Math.round(r.count / max * 100) + '%"></span></span>' +
          '<span class="ln-dash-count">' + r.count + '</span>';
        return r.query
          ? '<button type="button" class="ln-dash-row" onclick="dashGo(\'' + grp.key + '\',' + i + ')">' + inner + '</button>'
          : '<div class="ln-dash-row">' + inner + '</div>';
      }).join('') : '<div class="ln-empty" style="padding:.5rem 0;">Nothing here yet.</div>') +
      (grp.note ? '<div class="ln-dash-note">' + esc(grp.note) + '</div>' : '');
  }
  renderMentionsPanel();
  var rp = getProtocols().slice(-3).reverse();
  document.getElementById('ln-recent-protocols').innerHTML = rp.length ? rp.map(function (p) { return '<div class="ln-card" style="padding:1rem;margin-bottom:.6rem;"><div class="ln-card-title" style="font-size:14px;">' + esc(p.title) + '</div><div class="ln-card-meta">' + esc(p.category) + ' · ' + esc(p.date) + '</div></div>'; }).join('') : '<div class="ln-empty" style="padding:0;">No protocols yet.</div>';
  var rn = getNotebooks().filter(function (n) { return !n.archived; }).slice(-3).reverse();
  document.getElementById('ln-recent-notebooks').innerHTML = rn.length ? rn.map(function (n) { return '<div class="ln-card" style="padding:1rem;margin-bottom:.6rem;"><div class="ln-card-title" style="font-size:14px;">' + esc(n.title) + '</div><div class="ln-card-meta">' + esc(n.researcher) + ' · ' + esc(n.date) + '</div></div>'; }).join('') : '<div class="ln-empty" style="padding:0;">No experiments yet.</div>';
}

// ── FILE COLLECTION ────────────────────────────────────────
async function collectFiles(inputId) {
  var input = document.getElementById(inputId);
  if (!input || !input.files.length) return [];
  try { return await DB.uploadFiles(input.files); }
  catch (e) { alert(e.message); return null; }
}
function renderAttachments(files) {
  if (!files || !files.length) return '';
  return '<div class="ln-attachments">' + files.map(function (f) {
    if (f.type && f.type.indexOf('image/') === 0) return '<div style="width:100%;margin-top:.5rem;"><div style="font-size:12px;color:#888;margin-bottom:.3rem;">📎 ' + esc(f.name) + '</div><img src="' + f.data + '" class="ln-attachment-thumb" onclick="window.open(\'' + f.data + '\',\'_blank\')"></div>';
    return '<a href="' + f.data + '" download="' + esc(f.name) + '" class="ln-attachment-item">📎 ' + esc(f.name) + '</a>';
  }).join('') + '</div>';
}

// ── PROTOCOLS ──────────────────────────────────────────────
var CAT_COLORS = { 'Molecular Cloning': 'blue', 'Protein Purification': 'teal', 'Cell Culture': 'green', 'PCR & Sequencing': 'purple', 'Flow Cytometry': 'orange', 'NGS': 'blue', 'Western Blot': 'teal', 'Gene Editing': 'orange', 'Other': 'blue' };
function catColor(c) { return CAT_COLORS[c] || 'blue'; }

function renderProtocols(filter) {
  filter = filter || '';
  var protos = getProtocols();
  if (filter) protos = protos.filter(function (p) { return (p.title || '').toLowerCase().indexOf(filter.toLowerCase()) >= 0 || (p.category || '').toLowerCase().indexOf(filter.toLowerCase()) >= 0 || (p.author || '').toLowerCase().indexOf(filter.toLowerCase()) >= 0; });
  var el = document.getElementById('ln-protocols-list');
  if (!protos.length) { el.innerHTML = '<div class="ln-empty">No protocols yet. Click "+ Add Protocol" to get started.</div>'; return; }
  el.innerHTML = protos.slice().reverse().map(function (p) {
    return '<div class="ln-card"><div class="ln-card-header"><div><div class="ln-card-title">' + esc(p.title) + '</div>' +
      '<div class="ln-card-meta">📁 ' + esc(p.category) + ' · 👤 ' + esc(p.author) + ' · 📅 ' + esc(p.date) + (p.link ? ' · <a href="' + esc(p.link) + '" target="_blank" style="color:#0d6efd;">External Link ↗</a>' : '') + '</div></div>' +
      '<div class="ln-card-actions"><span class="ln-badge ' + catColor(p.category) + '">' + esc(p.category) + '</span>' +
      '<button class="ln-icon-btn" onclick="viewProtocol(\'' + p.id + '\')">View</button>' +
      '<button class="ln-icon-btn" onclick="openModal(\'protocol\',\'' + p.id + '\')">Edit</button>' +
      '<button class="ln-icon-btn primary" onclick="exportProtocolPDF(\'' + p.id + '\')">PDF</button>' +
      '<button class="ln-icon-btn primary" onclick="exportProtocolWord(\'' + p.id + '\')">DOC</button>' +
      '<button class="ln-icon-btn danger" onclick="deleteProtocol(\'' + p.id + '\')">✕</button></div></div>' +
      (p.summary ? '<div style="font-size:13px;color:#555;line-height:1.6;">' + esc(p.summary).slice(0, 150) + (p.summary.length > 150 ? '…' : '') + '</div>' : '') +
      renderAttachments(p.files) + '</div>';
  }).join('');
}
async function deleteProtocol(id) { if (confirm('Delete this protocol?')) { await DB.remove('protocols', id); renderProtocols(); renderDashboard(); } }

function viewProtocol(id) {
  var p = getProtocols().find(function (x) { return x.id === id; }); if (!p) return;
  var mc = document.getElementById('ln-modal-content');
  mc.innerHTML = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + esc(p.title) + '</h3>' +
    '<div style="font-size:12px;color:#888;margin-bottom:1.5rem;">📁 ' + esc(p.category) + ' · 👤 ' + esc(p.author) + ' · 📅 ' + esc(p.date) + (p.link ? ' · <a href="' + esc(p.link) + '" target="_blank" style="color:#0d6efd;">External Link ↗</a>' : '') + '</div>' +
    (p.summary ? '<p style="color:#555;margin-bottom:1.5rem;line-height:1.7;">' + esc(p.summary) + '</p>' : '') +
    (p.materials ? '<h4 style="margin-bottom:.5rem;">Materials &amp; Reagents</h4><pre style="white-space:pre-wrap;font-size:13px;color:#555;background:#f9f9f9;padding:1rem;border-radius:6px;margin-bottom:1.5rem;">' + esc(p.materials) + '</pre>' : '') +
    (p.steps ? '<h4 style="margin-bottom:.5rem;">Protocol Steps</h4><pre style="white-space:pre-wrap;font-size:13px;color:#555;background:#f9f9f9;padding:1rem;border-radius:6px;margin-bottom:1.5rem;">' + esc(p.steps) + '</pre>' : '') +
    (p.notes ? '<h4 style="margin-bottom:.5rem;">Notes &amp; Troubleshooting</h4><pre style="white-space:pre-wrap;font-size:13px;color:#555;background:#f9f9f9;padding:1rem;border-radius:6px;margin-bottom:1.5rem;">' + esc(p.notes) + '</pre>' : '') +
    renderAttachments(p.files) +
    '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Close</button><button class="ln-modal-save" onclick="exportProtocolPDF(\'' + p.id + '\')">Export PDF</button><button class="ln-modal-save" onclick="exportProtocolWord(\'' + p.id + '\')">Export DOC</button></div>';
  document.getElementById('ln-modal-bg').classList.add('open');
}

function exportProtocolPDF(id) {
  var p = getProtocols().find(function (x) { return x.id === id; }); if (!p) return;
  var win = window.open('', '_blank');
  var imgs = p.files ? p.files.filter(function (f) { return f.type && f.type.indexOf('image/') === 0; }).map(function (f) { return '<img src="' + f.data + '" style="max-width:100%;margin:8px 0;border-radius:4px;">'; }).join('') : '';
  var doc = '<!DOCTYPE html><html><head><title>' + esc(p.title) + '</title>';
  doc += '<style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;color:#333;padding:20px;}h1{color:#064e55;border-bottom:2px solid #064e55;padding-bottom:10px;}h2{color:#064e55;font-size:16px;margin-top:24px;}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:4px;font-size:13px;}td,th{border:1px solid #ddd;padding:8px;}@media print{body{margin:0;}}</style></head><body>';
  doc += '<h1>' + esc(p.title) + '</h1><p><b>Category:</b> ' + esc(p.category) + ' &nbsp;|&nbsp; <b>Author:</b> ' + esc(p.author) + ' &nbsp;|&nbsp; <b>Date:</b> ' + esc(p.date) + '</p>';
  if (p.link) doc += '<p><b>Reference:</b> <a href="' + esc(p.link) + '">' + esc(p.link) + '</a></p>';
  if (p.summary) doc += '<h2>Summary</h2><p>' + esc(p.summary) + '</p>';
  if (p.materials) doc += '<h2>Materials &amp; Reagents</h2><pre>' + esc(p.materials) + '</pre>';
  if (p.steps) doc += '<h2>Protocol Steps</h2><pre>' + esc(p.steps) + '</pre>';
  if (p.notes) doc += '<h2>Notes &amp; Troubleshooting</h2><pre>' + esc(p.notes) + '</pre>';
  if (imgs) doc += '<h2>Attachments</h2>' + imgs;
  doc += '</body></html>';
  win.document.write(doc); win.document.close(); win.focus();
  setTimeout(function () { win.print(); }, 400);
}
function exportProtocolWord(id) {
  var p = getProtocols().find(function (x) { return x.id === id; }); if (!p) return;
  var html = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'><style>body{font-family:Arial;font-size:12pt;}h1{color:#064e55;}h2{color:#064e55;font-size:14pt;}pre{font-family:Courier New;font-size:10pt;background:#f5f5f5;padding:8pt;}</style></head><body>" +
    '<h1>' + esc(p.title) + '</h1><p><b>Category:</b> ' + esc(p.category) + ' | <b>Author:</b> ' + esc(p.author) + ' | <b>Date:</b> ' + esc(p.date) + '</p>' +
    (p.link ? '<p><b>Reference:</b> ' + esc(p.link) + '</p>' : '') +
    (p.summary ? '<h2>Summary</h2><p>' + esc(p.summary) + '</p>' : '') +
    (p.materials ? '<h2>Materials &amp; Reagents</h2><pre>' + esc(p.materials) + '</pre>' : '') +
    (p.steps ? '<h2>Protocol Steps</h2><pre>' + esc(p.steps) + '</pre>' : '') +
    (p.notes ? '<h2>Notes &amp; Troubleshooting</h2><pre>' + esc(p.notes) + '</pre>' : '') +
    '</body></html>';
  var blob = new Blob(['﻿', html], { type: 'application/msword' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = p.title.replace(/[^a-z0-9]/gi, '_') + '.doc'; a.click(); URL.revokeObjectURL(url);
}

// ── EXPERIMENT NOTEBOOKS ───────────────────────────────────
function renderNotebooks(filter) {
  filter = filter || '';
  var nbs = getNotebooks();
  if (filter) nbs = nbs.filter(function (n) { return (n.title || '').toLowerCase().indexOf(filter.toLowerCase()) >= 0 || (n.researcher || '').toLowerCase().indexOf(filter.toLowerCase()) >= 0; });
  var el = document.getElementById('ln-notebooks-list');
  var isAdmin = DB.isAdmin();
  if (!nbs.length) { el.innerHTML = '<div class="ln-empty">No experiment entries yet.</div>'; return; }
  el.innerHTML = nbs.slice().reverse().map(function (n) {
    return '<div class="ln-card" style="' + (n.archived ? 'opacity:.65;' : '') + '"><div class="ln-card-header"><div>' +
      '<div class="ln-card-title">' + esc(n.title) + ' ' + (n.archived ? '<span class="ln-badge archived">Archived</span>' : '') + '</div>' +
      '<div class="ln-card-meta">👤 ' + esc(n.researcher) + ' · 📅 ' + esc(n.date) + (n.body ? ' · \ud83d\udcc4 notebook page' : '') + '</div></div>' +
      '<div class="ln-card-actions"><button class="ln-icon-btn" onclick="openEntry(\'' + n.id + '\')">Open</button>' +
      '<a class="ln-icon-btn" href="#entry/' + n.id + '" target="_blank" rel="noopener" title="Open in a new tab">\u2197</a>' +
      (isAdmin ? '<button class="ln-icon-btn" onclick="archiveNotebook(\'' + n.id + '\')">' + (n.archived ? 'Restore' : 'Archive') + '</button>' : '') +
      (isAdmin ? '<button class="ln-icon-btn danger" onclick="deleteNotebook(\'' + n.id + '\')">✕ Delete</button>' : '') +
      '</div></div><div style="font-size:13px;color:#555;">' + (n.hypothesis ? '<strong>Hypothesis:</strong> ' + esc(n.hypothesis).slice(0, 120) + (n.hypothesis.length > 120 ? '…' : '') : '') + '</div>' +
      renderAttachments(n.files) + '</div>';
  }).join('');
}
async function deleteNotebook(id) { if (!DB.isAdmin()) { alert('Only the PI can delete experiments.'); return; } if (confirm('Permanently delete this experiment entry?')) { await DB.remove('notebooks', id); renderNotebooks(); renderDashboard(); } }
async function archiveNotebook(id) { if (!DB.isAdmin()) { alert('Only the PI can archive experiments.'); return; } var n = getNotebooks().find(function (x) { return x.id === id; }); if (n) { n.archived = !n.archived; await DB.upsert('notebooks', n); renderNotebooks(); } }

// ── SAFE HTML ──────────────────────────────────────────────
/* Notebook pages and data tables are HTML that other members' browsers
   render, so every stored or pasted fragment goes through DOMPurify
   (vendor/purify.min.js) with a short allowlist: formatting, lists, tables,
   links and images. Scripts, event handlers, iframes and CSS beyond a few
   text styles are dropped. */
var SAFE_TAGS = ['p', 'br', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'mark',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'a'];
var SAFE_CLASSES = { 'ln-checklist': true, 'checked': true, 'ln-calc': true, 'ln-file': true,
  'ln-plate': true, 'ln-daymark': true, 'ln-mention': true, 'gone': true };
var SAFE_STYLES = ['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration'];
var safeHtmlReady = false;
function safeHtml(html) {
  if (!window.DOMPurify) { var d = document.createElement('div'); d.textContent = String(html || ''); return d.innerHTML; }
  if (!safeHtmlReady) {
    DOMPurify.addHook('uponSanitizeAttribute', function (node, data) {
      if (data.attrName === 'class') data.attrValue = data.attrValue.split(/\s+/).filter(function (c) { return SAFE_CLASSES[c]; }).join(' ');
      if (data.attrName === 'style') data.attrValue = data.attrValue.split(';').filter(function (decl) {
        return SAFE_STYLES.indexOf(decl.split(':')[0].trim().toLowerCase()) >= 0 && !/url\s*\(|expression|@import/i.test(decl);
      }).join(';');
    });
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer');
        // data: links only as downloads (files attached in local mode), never to open.
        if (/^\s*data:/i.test(node.getAttribute('href') || '') && !node.hasAttribute('download')) node.removeAttribute('href');
      }
      // Images: https, or pasted/uploaded data URLs of plain image types only.
      if (node.tagName === 'IMG' && node.hasAttribute('src') && !/^(https:|data:image\/(png|jpe?g|gif|webp);)/i.test(node.getAttribute('src'))) node.removeAttribute('src');
    });
    safeHtmlReady = true;
  }
  return DOMPurify.sanitize(String(html || ''), {
    ALLOWED_TAGS: SAFE_TAGS,
    // data-kind/data-id carry what a mention points at; data-day the date on
    // a divider. All are read back only as an id or a date, never as markup.
    ALLOWED_ATTR: ['href', 'src', 'alt', 'download', 'data-path', 'data-calc', 'data-plate',
      'data-day', 'data-kind', 'data-id', 'class', 'style', 'colspan', 'rowspan'],
    ADD_DATA_URI_TAGS: ['a'],
    ALLOW_DATA_ATTR: false
  }).replace(/<img(?![^>]*\b(?:src|data-path)=)[^>]*>/gi, ''); // images whose source was unsafe
}

// Data tables are stored as a <table>'s inner HTML (thead/tbody). Out of a
// table those elements are dropped by the HTML parser, so clean them inside one.
function safeTableHtml(inner) {
  var t = document.createElement('template');
  t.innerHTML = safeHtml('<table>' + String(inner || '') + '</table>');
  var table = t.content.querySelector('table');
  return table ? table.innerHTML : '';
}

// ── EXPERIMENT ENTRY PAGE ──────────────────────────────────
/* An entry opens as its own page, addressed #entry/<id> (#entry/new for a
   new one), so it can also be opened in a separate browser tab. The built-in
   structure comes first; below it is a blank free-form page, like a paper
   notebook, for anything else: notes, checklists, tables, pasted images. */
var ENTRY_FIELDS = [
  ['hypothesis', 'Hypothesis', 'What are you testing and why?'],
  ['methods', 'Materials & Methods', 'Reagents, conditions, protocol used…'],
  ['results', 'Results & Observations', 'Data, observations, gel results…'],
  ['conclusions', 'Conclusions', 'What do the results mean?'],
  ['nextsteps', 'Next Steps', 'Follow-up experiments or actions…']
];
var entryId = null, entryDirty = false;

function viewNotebook(id) { openEntry(id); }
function openEntry(id) {
  var hash = '#entry/' + (id || 'new');
  if (location.hash === hash) routeHash(); else location.hash = hash;
}
// Show the entry named in the address bar, if any.
function routeHash() {
  if (/^#plasmid\//.test(location.hash)) { if (window.routePlasmid) routePlasmid(); return; }
  var m = /^#entry\/(.+)$/.exec(location.hash);
  if (!m || !currentUser()) return;
  var id = m[1] === 'new' ? null : decodeURIComponent(m[1]);
  if (lnCurrentSection === 'entry' && entryId === id && id) return;
  if (!leaveEntryOk()) { history.replaceState(null, '', entryId ? '#entry/' + entryId : '#entry/new'); return; }
  renderEntry(id);
  lnShow('entry');
  // Text boxes can only measure their content once the page is visible.
  document.querySelectorAll('#ln-paper textarea').forEach(autoGrow);
}
window.addEventListener('hashchange', routeHash);

if (window.LabTabs) {
  LabTabs.register('entry', {
    title: function (id, held) {
      if (lnCurrentSection === 'entry' && (entryId || 'new') === id) {
        var live = document.getElementById('e-title');
        if (live && live.value.trim()) return live.value.trim();
      } else if (held && held.values && (held.values['e-title'] || '').trim()) {
        return held.values['e-title'].trim();
      }
      if (!id || id === 'new') return 'New entry';
      var n = getNotebooks().filter(function (x) { return x.id === id; })[0];
      return n ? (n.title || 'Untitled entry') : 'Entry';
    },
    capture: entryCapture,
    restore: entryRestore,
    dirty: function () { return lnCurrentSection === 'entry' && entryDirty; }
  });
}
/* Kept for the paths that still ask, but moving between pages no longer
   loses anything: the tab holds what was typed until it is closed, and that
   is where the question is asked now. */
function leaveEntryOk() { return true; }

/* ---- what an entry tab is holding while it is not on screen ----
   The typed values and the page body, not the saved record — the record is
   redrawn from the data when the tab comes back, and this goes on top. A
   file chosen but not yet uploaded cannot be carried across, so the input is
   deliberately left out rather than half-restored. */
/* A calculation table or a plate keeps its numbers on the element, not in the
   markup — the markup is the form. Writing that state back into the data
   attribute before the page is copied is what lets the copy be rebuilt; the
   innerHTML on its own would come back as a form full of defaults. */
function syncBlockState(root) {
  root.querySelectorAll('.ln-calc').forEach(function (b) {
    if (b._calc) b.setAttribute('data-calc', JSON.stringify(b._calc));
  });
  root.querySelectorAll('.ln-plate').forEach(function (b) {
    if (b._plate) b.setAttribute('data-plate', JSON.stringify(b._plate));
  });
}
function entryCapture() {
  if (lnCurrentSection !== 'entry') return null;
  var body = document.getElementById('e-body');
  if (!body) return null;
  syncBlockState(body);
  var values = {};
  ['e-title', 'e-researcher', 'e-date'].concat(ENTRY_FIELDS.map(function (f) { return 'e-' + f[0]; }))
    .forEach(function (id) {
      var el = document.getElementById(id);
      if (el) values[id] = el.value;
    });
  var main = document.querySelector('.ln-main');
  return { values: values, body: body.innerHTML, dirty: entryDirty,
    scroll: main ? main.scrollTop : 0 };
}
function entryRestore(st) {
  Object.keys(st.values || {}).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = st.values[id];
  });
  var body = document.getElementById('e-body');
  if (body && typeof st.body === 'string') {
    body.innerHTML = safeHtml(st.body);
    blockHydrate(body);
    hydrateEntryFiles(body);
  }
  document.querySelectorAll('#ln-paper textarea').forEach(autoGrow);
  if (st.dirty) markEntryDirty();
  var main = document.querySelector('.ln-main');
  if (main && st.scroll) setTimeout(function () { main.scrollTop = st.scroll; }, 0);
}
window.addEventListener('beforeunload', function (e) {
  if (lnCurrentSection === 'entry' && entryDirty) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('keydown', function (e) {
  if (lnCurrentSection === 'entry' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEntry(); }
});
function markEntryDirty() {
  if (entryDirty) return;
  entryDirty = true;
  var st = document.getElementById('ln-entry-status');
  if (st) { st.textContent = 'Unsaved changes'; st.className = 'ln-entry-status dirty'; }
  if (window.LabTabs) LabTabs.refresh();   // the tab gets its unsaved dot
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }

function renderEntry(id) {
  var el = document.getElementById('ln-entry-body');
  var n = id ? getNotebooks().filter(function (x) { return x.id === id; })[0] : null;
  if (id && !n) {
    entryId = null; entryDirty = false;
    el.innerHTML = '<div class="ln-entry-bar"><a href="#" class="ln-back-link" onclick="lnShow(\'notebooks\');return false;">\u2190 Experiment Notebooks</a></div>' +
      '<div class="ln-empty">This entry could not be found. It may have been deleted.</div>';
    return;
  }
  entryId = n ? n.id : null; entryDirty = false;
  var user = currentUser(), today = new Date().toISOString().split('T')[0];
  n = n || {};
  el.innerHTML =
    '<div class="ln-entry-bar">' +
      '<a href="#" class="ln-back-link" onclick="lnShow(\'notebooks\');return false;">\u2190 Experiment Notebooks</a>' +
      '<span id="ln-entry-status" class="ln-entry-status">' + (entryId ? 'Saved' : 'New entry \u2014 not saved yet') + '</span>' +
      '<div class="ln-header-actions">' +
        '<a id="ln-entry-newtab" class="ln-add-btn ghost ln-add-link" href="#entry/' + (entryId || 'new') + '" target="_blank" rel="noopener"' + (entryId ? '' : ' hidden') + '>Open in a browser window \u2197</a>' +
        '<button class="ln-add-btn ghost" onclick="window.print()">\ud83d\udda8 Print</button>' +
        '<button class="ln-add-btn" id="ln-entry-save" onclick="saveEntry()">Save</button>' +
      '</div></div>' +
    '<article class="ln-paper" id="ln-paper">' +
      '<input id="e-title" class="ln-paper-title" placeholder="Untitled experiment" value="' + esc(n.title || '') + '">' +
      '<div class="ln-paper-meta">' +
        '<div class="ln-paper-metaitem"><label>Researcher</label>' + userSelect('e-researcher', n.researcher || (user ? user.name : '')) + '</div>' +
        '<div class="ln-paper-metaitem"><label>Date</label><input type="date" id="e-date" value="' + esc(n.date || today) + '"></div>' +
        (n.archived ? '<span class="ln-badge archived">Archived</span>' : '') +
      '</div>' +
      ENTRY_FIELDS.map(function (f) {
        return '<section class="ln-paper-field"><h3>' + esc(f[1]) + '</h3><textarea id="e-' + f[0] + '" rows="2" placeholder="' + esc(f[2]) + '">' + esc(n[f[0]] || '') + '</textarea></section>';
      }).join('') +
      '<section class="ln-paper-field ln-paper-tables"><h3>Data Tables</h3><div id="ln-tables-editor"></div><button class="tbl-btn" onclick="addTableToEditor()">+ Add Table</button></section>' +
      '<section class="ln-paper-field"><h3>Attachments</h3><div id="e-attachments">' + (renderAttachments(n.files) || '<div class="ln-paper-none">No attachments yet.</div>') + '</div>' +
        '<input type="file" id="e-files" multiple accept="image/*,.pdf,.fcs,.xlsx,.csv,.docx,.pptx"><div class="hint">Files are uploaded when you save.</div></section>' +
      '<section class="ln-paper-page"><h3>Notebook Page</h3>' + editorToolbarHtml() +
        '<div id="e-body" class="ln-page-editor" contenteditable="true" spellcheck="true" data-placeholder="A blank page \u2014 write freely: notes, observations, plate layouts, checklists, pasted images\u2026"></div>' +
      '</section>' +
    '</article>';

  var editor = document.getElementById('e-body');
  editor.innerHTML = safeHtml(n.body || '');
  blockHydrate(editor);
  editor.addEventListener('input', calcHandle);
  editor.addEventListener('change', calcHandle);
  editor.addEventListener('click', calcHandle);
  editor.addEventListener('input', LabPlates.handle);
  editor.addEventListener('change', LabPlates.handle);
  editor.addEventListener('click', LabPlates.handle);
  LabMentions.attach(editor);
  hydrateEntryFiles(editor);
  initTableEditor();
  loadTablesIntoEditor((n.tables || []).map(function (t) { return { label: t.label, html: safeTableHtml(t.html) }; }));
  var paper = document.getElementById('ln-paper');
  paper.querySelectorAll('textarea').forEach(autoGrow);
  paper.addEventListener('input', function (e) { if (e.target.tagName === 'TEXTAREA') autoGrow(e.target); markEntryDirty(); });
  paper.addEventListener('change', markEntryDirty);
  paper.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('.tbl-btn')) markEntryDirty(); });
  // Enter starts a new paragraph (<p>), not a bare <div>.
  editor.addEventListener('focus', function () { document.execCommand('defaultParagraphSeparator', false, 'p'); });
  editor.addEventListener('click', toggleChecklistItem);
  editor.addEventListener('click', openPageFile);
  editor.addEventListener('paste', editorPaste);
  editor.addEventListener('drop', editorDrop);
  if (!entryId) setTimeout(function () { document.getElementById('e-title').focus(); }, 50);
  if (window.LabTabs) LabTabs.noteShow('entry', entryId || 'new');
  // Anything this tab was holding when it was last left goes back in now,
  // over the top of what was just drawn from the saved record.
  var held = window.LabTabs && LabTabs.takeState('entry/' + (entryId || 'new'));
  if (held) entryRestore(held);
  // Same reason as in routePlasmid: the strip was drawn while the flags still
  // belonged to the page being left.
  if (window.LabTabs) LabTabs.refresh();
}

// Pages store images and attached files by storage path; give them fresh
// signed links to show or open.
async function hydrateEntryFiles(root) {
  root.querySelectorAll('a.ln-file').forEach(function (a) { a.contentEditable = 'false'; });
  var els = Array.prototype.slice.call(root.querySelectorAll('img[data-path], a[data-path]'));
  if (!els.length) return;
  try {
    var urls = await DB.signPaths(els.map(function (el) { return el.getAttribute('data-path'); }));
    els.forEach(function (el) {
      var u = urls[el.getAttribute('data-path')];
      if (u) el.setAttribute(el.tagName === 'IMG' ? 'src' : 'href', u);
    });
  } catch (e) { /* they stay without a link; the next open retries */ }
}
function entryBodyForSave() {
  var live = document.getElementById('e-body');
  var clone = live.cloneNode(true);
  // Calculation tables and plates: save their state and a plain snapshot, not
  // the form. The clone is in the same order as the live page, so the live
  // state can be matched to it by position.
  var liveCalcs = live.querySelectorAll('.ln-calc'), cloneCalcs = clone.querySelectorAll('.ln-calc');
  Array.prototype.forEach.call(cloneCalcs, function (b, i) { if (liveCalcs[i] && liveCalcs[i]._calc) { b._calc = liveCalcs[i]._calc; calcSnapshot(b); } });
  var livePlates = live.querySelectorAll('.ln-plate'), clonePlates = clone.querySelectorAll('.ln-plate');
  Array.prototype.forEach.call(clonePlates, function (b, i) {
    if (livePlates[i] && livePlates[i]._plate) { b._plate = livePlates[i]._plate; LabPlates.snapshot(b); }
  });
  // A mention keeps only what it points at; the name is drawn again on the
  // way back in, so renaming a plasmid renames every mention of it.
  clone.querySelectorAll('.ln-mention').forEach(function (m) { m.removeAttribute('contenteditable'); });
  clone.querySelectorAll('.ln-daymark').forEach(function (m) { m.removeAttribute('contenteditable'); });
  // Signed links expire, so stored images and files keep only their storage path.
  clone.querySelectorAll('img[data-path]').forEach(function (i) { i.removeAttribute('src'); });
  clone.querySelectorAll('a[data-path]').forEach(function (a) { a.removeAttribute('href'); });
  var html = safeHtml(clone.innerHTML);
  var probe = document.createElement('div'); probe.innerHTML = html;
  return probe.textContent.trim() || probe.querySelector('img,table,hr,ul.ln-checklist,.ln-calc,a.ln-file') ? html : '';
}

async function saveEntry() {
  var titleEl = document.getElementById('e-title');
  var title = (titleEl.value || '').trim();
  if (!title) { alert('Please give the entry a title.'); titleEl.focus(); return; }
  var btn = document.getElementById('ln-entry-save'), st = document.getElementById('ln-entry-status');
  btn.disabled = true; btn.textContent = 'Saving\u2026';
  try {
    var newFiles = await collectFiles('e-files');
    if (newFiles === null) return;
    var ex = entryId ? (getNotebooks().filter(function (x) { return x.id === entryId; })[0] || {}) : {};
    var obj = {
      id: entryId || undefined, title: title, researcher: getSelectOrManual('e-researcher'), date: g('e-date'),
      tables: serializeTables().map(function (t) { return { label: t.label, html: safeTableHtml(t.html) }; }),
      files: (ex.files || []).concat(newFiles), archived: ex.archived || false, body: entryBodyForSave()
    };
    ENTRY_FIELDS.forEach(function (f) { obj[f[0]] = document.getElementById('e-' + f[0]).value; });
    var saved = await DB.upsert('notebooks', obj);
    entryId = saved.id; entryDirty = false;
    history.replaceState(null, '', '#entry/' + entryId);
    document.getElementById('e-files').value = '';
    document.getElementById('e-attachments').innerHTML = renderAttachments(saved.files) || '<div class="ln-paper-none">No attachments yet.</div>';
    var nt = document.getElementById('ln-entry-newtab'); nt.href = '#entry/' + entryId; nt.hidden = false;
    st.textContent = 'Saved \u2713 ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    st.className = 'ln-entry-status saved';
  } catch (e) {
    st.textContent = 'Not saved'; st.className = 'ln-entry-status dirty';
    alert('Could not save the entry: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ── NOTEBOOK PAGE EDITOR ───────────────────────────────────
function editorToolbarHtml() {
  function b(cmd, label, title) { return '<button type="button" title="' + title + '" onmousedown="event.preventDefault()" onclick="editorCmd(\'' + cmd + '\')">' + label + '</button>'; }
  return '<div class="ln-editor-toolbar" role="toolbar" aria-label="Page formatting">' +
    '<select title="Text style" onchange="editorCmd(\'block\',this.value);this.value=\'\'"><option value="">Text style</option><option value="p">Normal text</option><option value="h2">Heading 1</option><option value="h3">Heading 2</option><option value="h4">Heading 3</option><option value="pre">Code / sequence</option></select>' +
    '<span class="sep"></span>' + b('bold', '<b>B</b>', 'Bold (Ctrl/Cmd+B)') + b('italic', '<i>I</i>', 'Italic (Ctrl/Cmd+I)') + b('underline', '<u>U</u>', 'Underline') + b('strikeThrough', '<s>S</s>', 'Strikethrough') +
    b('highlight', '<mark>H</mark>', 'Highlight') + b('subscript', 'x\u2082', 'Subscript') + b('superscript', 'x\u00b2', 'Superscript') +
    '<span class="sep"></span>' + b('insertUnorderedList', '\u2022 List', 'Bulleted list') + b('insertOrderedList', '1. List', 'Numbered list') + b('checklist', '\u2611 Checklist', 'Checklist') +
    b('quote', '\u275d', 'Quote') + b('insertHorizontalRule', '\u2015', 'Divider line') +
    '<span class="sep"></span>' + b('table', '\u229e Table', 'Insert a table') + b('tableRow', '+ Row', 'Add a row to the table you are in') + b('tableCol', '+ Col', 'Add a column to the table you are in') +
    b('file', '\ud83d\udcce File', 'Attach any file: images appear on the page, other files as a link (you can also paste or drop files)') +
    '<button type="button" class="ln-calc-btn" title="Insert a ready-made PCR, qPCR, transfection or electroporation table" onmousedown="event.preventDefault()" onclick="openCalcPicker()">\ud83e\uddee Calc table</button>' +
    '<button type="button" class="ln-calc-btn" title="Insert a culture plate you can write in: 1, 6, 12, 24, 48 or 96 wells" onmousedown="event.preventDefault()" onclick="openPlatePicker()">\u25a6 Plate</button>' +
    '<button type="button" class="ln-calc-btn" title="Start a new day on this page: a date and a line" onmousedown="event.preventDefault()" onclick="insertDayMark()">\ud83d\udcc5 New day</button>' +
    '<span class="sep"></span>' + b('removeFormat', 'Clear', 'Clear formatting') + b('undo', '\u21ba Undo', 'Undo (Ctrl/Cmd+Z)') + b('redo', '\u21bb Redo', 'Redo') +
    '<input type="file" id="e-file-input" multiple hidden onchange="editorInsertFiles(this.files);this.value=\'\'">' +
    '</div>';
}
function editorSelectionNode() {
  var sel = window.getSelection();
  if (!sel.rangeCount) return null;
  var n = sel.getRangeAt(0).startContainer;
  var editor = document.getElementById('e-body');
  return editor && editor.contains(n) ? (n.nodeType === 1 ? n : n.parentNode) : null;
}
function editorCmd(cmd, arg) {
  var editor = document.getElementById('e-body');
  if (cmd !== 'file') editor.focus();
  var here = editorSelectionNode();
  if (cmd === 'block') { if (arg) document.execCommand('formatBlock', false, '<' + arg + '>'); }
  else if (cmd === 'quote') document.execCommand('formatBlock', false, '<blockquote>');
  else if (cmd === 'highlight') { if (!document.execCommand('hiliteColor', false, '#fff1a8')) document.execCommand('backColor', false, '#fff1a8'); }
  else if (cmd === 'checklist') {
    var ul = here && here.closest('ul');
    if (!ul) { document.execCommand('insertUnorderedList'); ul = (editorSelectionNode() || editor).closest('ul'); }
    if (ul) ul.classList.toggle('ln-checklist');
  }
  else if (cmd === 'table') {
    var cells = function (tag) { return '<tr>' + [0, 1, 2].map(function () { return '<' + tag + '><br></' + tag + '>'; }).join('') + '</tr>'; };
    document.execCommand('insertHTML', false, '<table><thead>' + cells('th') + '</thead><tbody>' + cells('td') + cells('td') + '</tbody></table><p><br></p>');
  }
  else if (cmd === 'tableRow' || cmd === 'tableCol') {
    var cell = here && here.closest('td,th');
    if (!cell) { alert('Click inside a table on the page first.'); return; }
    var table = cell.closest('table');
    if (cmd === 'tableRow') {
      var tr = cell.closest('tr'), row = document.createElement('tr');
      for (var i = 0; i < tr.cells.length; i++) { var td = document.createElement('td'); td.innerHTML = '<br>'; row.appendChild(td); }
      (tr.parentNode.tagName === 'THEAD' ? (table.tBodies[0] || table.createTBody()).insertBefore(row, (table.tBodies[0] || {}).firstChild || null) : tr.parentNode.insertBefore(row, tr.nextSibling));
    } else {
      var col = cell.cellIndex;
      Array.prototype.forEach.call(table.rows, function (r) { var c = document.createElement(r.parentNode.tagName === 'THEAD' ? 'th' : 'td'); c.innerHTML = '<br>'; r.insertBefore(c, r.cells[col + 1] || null); });
    }
  }
  else if (cmd === 'file') { document.getElementById('e-file-input').click(); return; }
  else document.execCommand(cmd, false, null);
  markEntryDirty();
}
function toggleChecklistItem(e) {
  var li = e.target.closest && e.target.closest('ul.ln-checklist > li');
  if (!li) return;
  var box = li.getBoundingClientRect();
  if (e.clientX - box.left > 26) return; // only the checkbox area toggles
  li.classList.toggle('checked');
  markEntryDirty();
}
// Files go to storage (shared mode) or inline (local mode), then onto the
// page: images as pictures, everything else as a file chip with name and size.
var PAGE_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B'; }
async function editorInsertFiles(files) {
  files = Array.prototype.slice.call(files || []);
  if (!files.length) return;
  var st = document.getElementById('ln-entry-status');
  if (st) st.textContent = 'Uploading ' + (files.length === 1 ? files[0].name : files.length + ' files') + '\u2026';
  try {
    var up = await DB.uploadFiles(files);
    var editor = document.getElementById('e-body');
    editor.focus();
    document.execCommand('insertHTML', false, up.map(function (f) {
      var path = f.path ? ' data-path="' + esc(f.path) + '"' : '';
      if (PAGE_IMAGE_TYPES.test(f.type)) return '<img src="' + esc(f.data) + '"' + path + ' alt="' + esc(f.name) + '">';
      return '<a class="ln-file" href="' + esc(f.data) + '"' + path + ' download="' + esc(f.name) + '">\ud83d\udcce ' + esc(f.name) + ' \u00b7 ' + fmtBytes(f.size) + '</a>&nbsp;';
    }).join('') + '<p><br></p>');
    editor.querySelectorAll('a.ln-file').forEach(function (a) { a.contentEditable = 'false'; });
    markEntryDirty();
    if (st) { st.textContent = 'Unsaved changes'; st.className = 'ln-entry-status dirty'; }
  } catch (e) { alert(e.message); if (st) st.textContent = 'Unsaved changes'; }
}
// Links don't open on click inside an editable page, so open file chips here.
function openPageFile(e) {
  var a = e.target.closest && e.target.closest('a.ln-file');
  if (!a) return;
  e.preventDefault();
  var href = a.getAttribute('href');
  if (!href) { alert('This file\u2019s link is still loading. Try again in a moment.'); return; }
  var tmp = document.createElement('a');
  tmp.href = href; tmp.rel = 'noopener';
  if (/^data:/i.test(href)) tmp.download = a.getAttribute('download') || 'file'; else tmp.target = '_blank';
  document.body.appendChild(tmp); tmp.click(); document.body.removeChild(tmp);
}
function editorPaste(e) {
  if (e.target.closest && e.target.closest('.ln-calc')) return; // a calc table's own fields
  var cd = e.clipboardData;
  if (!cd) return;
  if (cd.files && cd.files.length) { e.preventDefault(); editorInsertFiles(cd.files); return; }
  var html = cd.getData('text/html');
  if (html) { e.preventDefault(); document.execCommand('insertHTML', false, safeHtml(html)); markEntryDirty(); }
}
function editorDrop(e) {
  if (e.target.closest && e.target.closest('.ln-calc')) return;
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); editorInsertFiles(e.dataTransfer.files); }
}

// ── CALCULATION TABLES ─────────────────────────────────────
/* Ready-made tables for the notebook page (PCR, qPCR, transfection,
   electroporation). A table is a non-editable block inside the page,
   <div class="ln-calc" data-calc="{state}">, that recalculates as the
   number of samples, replicates, controls, extra % or plate changes.
   The state (which recipe, the inputs and every component row) lives in
   data-calc; on save the block's contents become a plain snapshot table,
   and on open it is rebuilt from the state. Recipes are standard published
   ones; every amount can be edited per entry, and the lab defaults are the
   CALC_TEMPLATES below. */
var CALC_FORMATS = {
  tubes: { label: 'Tubes / strips', wells: 0 },
  '96': { label: '96-well plate', wells: 96 }, '384': { label: '384-well plate', wells: 384 },
  '6': { label: '6-well plate', wells: 6 }, '12': { label: '12-well plate', wells: 12 }, '24': { label: '24-well plate', wells: 24 },
  '10cm': { label: '10 cm dish', wells: 1 }, '15cm': { label: '15 cm dish', wells: 1 },
  neon10: { label: 'Neon 10 µL tip', wells: 0 }, neon100: { label: 'Neon 100 µL tip', wells: 0 },
  cuv1: { label: '0.1 cm cuvette', wells: 0 }, cuv2: { label: '0.2 cm cuvette', wells: 0 }
};
// kind 'mix': fixed reaction volume, water fills it up, amounts scale with the volume.
// kind 'perwell': amounts per well/reaction depend on the format (per: { format: amount }).
// `well: true` = added to each well/tube separately, not into the master mix.
var CALC_TEMPLATES = {
  q5: {
    name: 'PCR — Q5 High-Fidelity', source: 'NEB Q5 High-Fidelity DNA Polymerase (M0491), 50 µL reaction',
    kind: 'mix', volume: 50, formats: ['tubes', '96'], format: 'tubes',
    labels: { samples: 'Samples', controls: 'No-template controls', reps: 'Replicates' },
    defaults: { samples: 8, reps: 1, controls: 1, extra: 10 },
    comps: [
      { name: '5X Q5 Reaction Buffer', stock: '5X', final: '1X', per: 10 },
      { name: 'dNTPs', stock: '10 mM', final: '200 µM', per: 1 },
      { name: 'Forward primer', stock: '10 µM', final: '0.5 µM', per: 2.5 },
      { name: 'Reverse primer', stock: '10 µM', final: '0.5 µM', per: 2.5 },
      { name: 'Q5 High-Fidelity DNA Polymerase', stock: '2 U/µL', final: '0.02 U/µL', per: 0.5 },
      { name: 'Template DNA', stock: '', final: '< 1 µg', per: 1, well: true },
      { name: 'Nuclease-free water', stock: '', final: '', fill: true }
    ],
    note: 'Cycling: 98 °C 30 s; 25–35 cycles of 98 °C 10 s, 50–72 °C 20 s, 72 °C 20–30 s/kb; 72 °C 2 min. Add the polymerase last.'
  },
  taq: {
    name: 'PCR — Taq 2× Master Mix', source: 'NEB Taq 2X Master Mix (M0270), 25 µL reaction',
    kind: 'mix', volume: 25, formats: ['tubes', '96'], format: 'tubes',
    labels: { samples: 'Samples', controls: 'No-template controls', reps: 'Replicates' },
    defaults: { samples: 8, reps: 1, controls: 1, extra: 10 },
    comps: [
      { name: 'Taq 2X Master Mix', stock: '2X', final: '1X', per: 12.5 },
      { name: 'Forward primer', stock: '10 µM', final: '0.2 µM', per: 0.5 },
      { name: 'Reverse primer', stock: '10 µM', final: '0.2 µM', per: 0.5 },
      { name: 'Template DNA', stock: '', final: '< 1 µg', per: 1, well: true },
      { name: 'Nuclease-free water', stock: '', final: '', fill: true }
    ],
    note: 'Cycling: 95 °C 30 s; 30 cycles of 95 °C 15–30 s, 45–68 °C 15–60 s, 68 °C 1 min/kb; 68 °C 5 min.'
  },
  qpcr: {
    name: 'qRT-PCR — SYBR Green', source: '2X SYBR Green qPCR master mix (e.g. PowerUp, Luna, iTaq); 20 µL in 96-well, 10 µL in 384-well',
    kind: 'mix', volume: 20, volumeByFormat: { '96': 20, '384': 10 }, formats: ['96', '384'], format: '96', targets: true,
    labels: { samples: 'Samples (cDNA)', controls: 'NTC per target', reps: 'Technical replicates', targets: 'Targets (primer pairs)' },
    defaults: { samples: 6, reps: 3, controls: 1, extra: 10, targets: 2 },
    comps: [
      { name: '2X SYBR Green master mix', stock: '2X', final: '1X', per: 10 },
      { name: 'Forward primer', stock: '10 µM', final: '400 nM', per: 0.8 },
      { name: 'Reverse primer', stock: '10 µM', final: '400 nM', per: 0.8 },
      { name: 'cDNA (diluted)', stock: '', final: '', per: 2, well: true },
      { name: 'Nuclease-free water', stock: '', final: '', fill: true }
    ],
    note: 'One master mix per target (primer pair). Dispense the mix, then add cDNA (water for NTC). Include a reference gene among the targets.'
  },
  lipo3000: {
    name: 'Transfection — Lipofectamine 3000', source: 'Thermo Fisher Lipofectamine 3000 protocol, amounts per well',
    kind: 'perwell', formats: ['96', '24', '12', '6'], format: '24',
    labels: { samples: 'Conditions', controls: 'Mock / control wells', reps: 'Replicate wells' },
    defaults: { samples: 3, reps: 3, controls: 1, extra: 10 },
    comps: [
      { name: 'Tube A — Opti-MEM', unit: 'µL', per: { '96': 5, '24': 25, '12': 50, '6': 125 } },
      { name: 'Tube A — Lipofectamine 3000', unit: 'µL', per: { '96': 0.3, '24': 1.5, '12': 3, '6': 7.5 } },
      { name: 'Tube B — Opti-MEM', unit: 'µL', per: { '96': 5, '24': 25, '12': 50, '6': 125 } },
      { name: 'Tube B — Plasmid DNA', unit: 'µg', per: { '96': 0.1, '24': 0.5, '12': 1, '6': 2.5 } },
      { name: 'Tube B — P3000 reagent', unit: 'µL', per: { '96': 0.2, '24': 1, '12': 2, '6': 5 } }
    ],
    note: 'Add tube B to tube A (1:1), mix gently, incubate 10–15 min at room temperature, then add the complex per well (10 / 50 / 100 / 250 µL for 96 / 24 / 12 / 6-well). Lipofectamine shown at the upper dose; Thermo suggests testing two doses.'
  },
  pei: {
    name: 'Transfection — PEI (3:1)', source: 'Linear PEI 25K / PEI MAX, 1 mg/mL; PEI:DNA 3:1 (w/w)',
    kind: 'perwell', formats: ['24', '12', '6', '10cm', '15cm'], format: '6',
    labels: { samples: 'Conditions', controls: 'Mock / control wells', reps: 'Replicate wells' },
    defaults: { samples: 3, reps: 2, controls: 1, extra: 10 },
    comps: [
      { name: 'Serum-free medium (Opti-MEM)', unit: 'µL', per: { '24': 50, '12': 100, '6': 200, '10cm': 1000, '15cm': 2000 } },
      { name: 'Plasmid DNA (total)', unit: 'µg', per: { '24': 0.5, '12': 1, '6': 2, '10cm': 10, '15cm': 25 } },
      { name: 'PEI (1 mg/mL)', unit: 'µL', per: { '24': 1.5, '12': 3, '6': 6, '10cm': 30, '15cm': 75 } }
    ],
    note: 'Dilute DNA in the medium, add PEI (3 µL per µg DNA), vortex briefly, incubate 15–20 min at room temperature, add dropwise. For lentivirus, split the DNA between transfer, packaging and envelope plasmids.'
  },
  neon: {
    name: 'Electroporation — Neon (mammalian)', source: 'Thermo Fisher Neon Transfection System',
    kind: 'perwell', formats: ['neon10', 'neon100'], format: 'neon10',
    labels: { samples: 'Conditions', controls: 'Controls (no DNA)', reps: 'Replicates' },
    defaults: { samples: 3, reps: 2, controls: 1, extra: 10 },
    comps: [
      { name: 'Cells', unit: 'cells', per: { neon10: 100000, neon100: 1000000 } },
      { name: 'Resuspension Buffer R', unit: 'µL', per: { neon10: 10, neon100: 100 } },
      { name: 'Plasmid DNA', unit: 'µg', per: { neon10: 1, neon100: 5 } },
      { name: 'Pre-warmed medium, no antibiotics (receiving well)', unit: 'µL', per: { neon10: 500, neon100: 2000 } }
    ],
    note: 'Receiving plate: 24-well (10 µL tip) or 6-well (100 µL tip). Pulse conditions are cell-type specific (e.g. HEK293: 1,100 V, 20 ms, 2 pulses). Buffer E (10 µL tip) or E2 (100 µL tip) in the Neon tube.'
  },
  ecoli: {
    name: 'Electroporation — E. coli', source: 'Electrocompetent E. coli, standard cuvette protocol',
    kind: 'perwell', formats: ['cuv1', 'cuv2'], format: 'cuv1',
    labels: { samples: 'Transformations', controls: 'Controls (no DNA / pUC19)', reps: 'Replicates' },
    defaults: { samples: 4, reps: 1, controls: 1, extra: 0 },
    comps: [
      { name: 'Electrocompetent cells', unit: 'µL', per: { cuv1: 50, cuv2: 80 } },
      { name: 'DNA (1–10 ng plasmid, or ≤ 2 µL desalted ligation)', unit: 'µL', per: { cuv1: 1, cuv2: 2 } },
      { name: 'SOC recovery medium', unit: 'µL', per: { cuv1: 950, cuv2: 920 } }
    ],
    note: '0.1 cm cuvette: 1.8 kV; 0.2 cm cuvette: 2.5 kV; 200 Ω, 25 µF. Keep cells and cuvettes on ice, add SOC immediately after the pulse, recover 1 h at 37 °C, 250 rpm.'
  }
};
var CALC_ORDER = ['q5', 'taq', 'qpcr', 'lipo3000', 'pei', 'neon', 'ecoli'];

function calcNum(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d || 0); }
function calcFmt(v, unit) {
  if (!isFinite(v)) return '—';
  if (unit === 'cells') {
    if (v < 1000) return String(Math.round(v));
    var e = Math.floor(Math.log10(v)), m = v / Math.pow(10, e);
    return (Math.round(m * 100) / 100) + ' × 10' + String(e).split('').map(function (d) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]; }).join('');
  }
  var r = Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
  return String(r);
}
// A fresh table state for a recipe.
function calcNew(t) {
  var tpl = CALC_TEMPLATES[t];
  var st = Object.assign({ t: t, format: tpl.format, volume: tpl.volume || 0, targets: 1 }, tpl.defaults);
  st.comps = calcCompsFor(tpl, st.format);
  return st;
}
function calcCompsFor(tpl, format) {
  return tpl.comps.map(function (c) {
    var per = typeof c.per === 'object' ? c.per[format] : c.per;
    return { name: c.name, stock: c.stock || '', final: c.final || '', unit: c.unit || 'µL', per: per == null ? 0 : per, well: !!c.well, fill: !!c.fill };
  });
}
// Rebuild a stored state defensively: it came from the page HTML.
function calcLoad(raw) {
  var st;
  try { st = JSON.parse(raw); } catch (e) { return null; }
  if (!st || !CALC_TEMPLATES[st.t]) return null;
  var tpl = CALC_TEMPLATES[st.t], d = tpl.defaults;
  var out = {
    t: st.t, format: tpl.formats.indexOf(st.format) >= 0 ? st.format : tpl.format,
    samples: Math.max(0, Math.round(calcNum(st.samples, d.samples))), reps: Math.max(1, Math.round(calcNum(st.reps, d.reps))),
    controls: Math.max(0, Math.round(calcNum(st.controls, d.controls))), extra: Math.max(0, calcNum(st.extra, d.extra)),
    targets: Math.max(1, Math.round(calcNum(st.targets, d.targets || 1))), volume: Math.max(0, calcNum(st.volume, tpl.volume || 0))
  };
  out.comps = Array.isArray(st.comps) ? st.comps.slice(0, 40).map(function (c) {
    c = c || {};
    return { name: String(c.name || '').slice(0, 120), stock: String(c.stock || '').slice(0, 40), final: String(c.final || '').slice(0, 40),
      unit: ['µL', 'µg', 'cells', 'ng', 'mL'].indexOf(c.unit) >= 0 ? c.unit : 'µL', per: Math.max(0, calcNum(c.per)), well: !!c.well, fill: !!c.fill };
  }) : calcCompsFor(tpl, out.format);
  return out;
}
function calcCompute(st) {
  var tpl = CALC_TEMPLATES[st.t];
  var perTarget = (st.samples + st.controls) * st.reps;
  var targets = tpl.targets ? st.targets : 1;
  var wells = perTarget * targets;
  var n = Math.ceil(perTarget * (1 + st.extra / 100) - 1e-9);
  var fixed = 0, wellVol = 0;
  st.comps.forEach(function (c) {
    if (c.fill || c.unit !== 'µL') return;
    if (c.well) wellVol += c.per; else fixed += c.per;
  });
  var water = tpl.kind === 'mix' ? st.volume - fixed - wellVol : null;
  var cap = (CALC_FORMATS[st.format] || {}).wells || 0;
  return { tpl: tpl, perTarget: perTarget, targets: targets, wells: wells, n: n, water: water, mixPer: tpl.kind === 'mix' ? st.volume - wellVol : null, wellVol: wellVol, cap: cap };
}
function calcRowPer(st, c, k) { return c.fill ? k.water : c.per; }

function calcSummaryHtml(st, k) {
  var tpl = k.tpl, unitWord = tpl.kind === 'mix' || !k.cap ? 'reactions' : 'wells';
  var parts = [];
  if (tpl.targets) parts.push('<strong>' + k.targets + '</strong> master mix' + (k.targets === 1 ? '' : 'es') + ' (one per target), each for <strong>' + k.n + '</strong> reactions');
  else parts.push('Prepare for <strong>' + k.n + '</strong> ' + unitWord + ' (' + k.wells + ' + ' + calcFmt(st.extra) + '% extra)');
  parts.push('<strong>' + k.wells + '</strong> ' + (tpl.kind === 'mix' ? 'wells/tubes' : k.cap ? 'wells' : 'reactions') + ' in total');
  if (k.cap > 1) {
    var plates = Math.ceil(k.wells / k.cap);
    parts.push(plates <= 1 ? k.wells + ' of ' + k.cap + ' wells on one plate' : '<span class="warn">needs ' + plates + ' plates (' + k.cap + ' wells each)</span>');
  } else if (k.cap === 1) parts.push(k.wells + ' dish' + (k.wells === 1 ? '' : 'es'));
  if (k.water != null && k.water < 0) parts.push('<span class="warn">components exceed the ' + calcFmt(st.volume) + ' µL reaction volume</span>');
  return parts.join(' · ');
}
function calcFootHtml(st, k) {
  if (k.tpl.kind !== 'mix') return '';
  var wellComps = st.comps.filter(function (c) { return c.well && !c.fill; });
  return 'Per well/tube: <strong>' + calcFmt(k.mixPer) + ' µL</strong> master mix' +
    (wellComps.length ? ' + ' + wellComps.map(function (c) { return calcFmt(c.per, c.unit) + ' ' + c.unit + ' ' + esc(c.name); }).join(' + ') : '') +
    ' = ' + calcFmt(st.volume) + ' µL';
}

// The interactive table, built from the state.
function calcRender(block) {
  var st = block._calc, k = calcCompute(st), tpl = k.tpl, L = tpl.labels;
  function num(key, label, step) {
    return '<label>' + esc(label) + '<input type="number" min="0" step="' + (step || 1) + '" data-k="' + key + '" value="' + esc(String(st[key])) + '"></label>';
  }
  var perHead = tpl.kind === 'mix' ? 'Per reaction' : 'Per well / reaction';
  var mixHead = tpl.kind === 'mix' ? (tpl.targets ? 'Master mix (each)' : 'Master mix') + ' ×' + k.n : 'Total ×' + k.n;
  block.innerHTML =
    '<div class="ln-calc-head"><div><strong>' + esc(tpl.name) + '</strong><span>' + esc(tpl.source) + '</span></div>' +
      '<button type="button" class="ln-calc-x" data-act="remove" title="Remove this table">✕</button></div>' +
    '<div class="ln-calc-ctrls">' +
      num('samples', L.samples) + num('reps', L.reps) + num('controls', L.controls) + (tpl.targets ? num('targets', L.targets) : '') +
      num('extra', 'Extra %', 1) +
      '<label>Format<select data-k="format">' + tpl.formats.map(function (f) { return '<option value="' + f + '"' + (f === st.format ? ' selected' : '') + '>' + CALC_FORMATS[f].label + '</option>'; }).join('') + '</select></label>' +
      (tpl.kind === 'mix' ? num('volume', 'Reaction volume (µL)', 0.5) : '') +
    '</div>' +
    '<div class="ln-calc-sum" data-out="sum">' + calcSummaryHtml(st, k) + '</div>' +
    '<div class="ln-calc-scroll"><table class="ln-calc-tbl"><thead><tr><th>Component</th>' + (tpl.kind === 'mix' ? '<th>Stock</th><th>Final</th>' : '') +
      '<th>' + perHead + '</th><th>' + mixHead + '</th><th></th></tr></thead><tbody>' +
    st.comps.map(function (c, i) {
      var per = calcRowPer(st, c, k);
      return '<tr' + (c.well ? ' class="well"' : '') + '><td><input data-ci="' + i + '" data-f="name" value="' + esc(c.name) + '"></td>' +
        (tpl.kind === 'mix' ? '<td><input class="sm" data-ci="' + i + '" data-f="stock" value="' + esc(c.stock) + '"></td><td><input class="sm" data-ci="' + i + '" data-f="final" value="' + esc(c.final) + '"></td>' : '') +
        '<td class="num">' + (c.fill ? '<span data-out="per' + i + '" class="' + (per < 0 ? 'warn' : '') + '">' + calcFmt(per) + '</span> µL <em>to ' + calcFmt(st.volume) + '</em>'
          : '<input type="number" min="0" step="any" class="num" data-ci="' + i + '" data-f="per" value="' + esc(String(c.per)) + '"> ' + esc(c.unit)) + '</td>' +
        '<td class="num total" data-out="tot' + i + '">' + calcTotalCell(st, c, k) + '</td>' +
        '<td><button type="button" class="ln-calc-x sm" data-act="del" data-ci="' + i + '" title="Remove row">✕</button></td></tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<div class="ln-calc-foot"><span data-out="foot">' + calcFootHtml(st, k) + '</span>' +
      '<button type="button" class="tbl-btn" data-act="add">+ Component</button></div>' +
    (tpl.note ? '<div class="ln-calc-note">' + esc(tpl.note) + '</div>' : '');
}
function calcTotalCell(st, c, k) {
  var per = calcRowPer(st, c, k);
  if (k.tpl.kind === 'mix' && c.well) return '<em>per well · ' + calcFmt(per * k.wells, c.unit) + ' ' + esc(c.unit) + ' total</em>';
  return '<strong>' + calcFmt(per * k.n, c.unit) + '</strong> ' + esc(c.unit);
}
// After typing in a field: update the numbers only, so the field keeps focus.
function calcRefresh(block) {
  var st = block._calc, k = calcCompute(st);
  block.querySelector('[data-out="sum"]').innerHTML = calcSummaryHtml(st, k);
  block.querySelector('[data-out="foot"]').innerHTML = calcFootHtml(st, k);
  st.comps.forEach(function (c, i) {
    var t = block.querySelector('[data-out="tot' + i + '"]'); if (t) t.innerHTML = calcTotalCell(st, c, k);
    var p = block.querySelector('[data-out="per' + i + '"]');
    if (p) { var per = calcRowPer(st, c, k); p.textContent = calcFmt(per); p.className = per < 0 ? 'warn' : ''; }
  });
  var head = block.querySelector('thead th:nth-last-child(2)');
  if (head) head.textContent = (k.tpl.kind === 'mix' ? (k.tpl.targets ? 'Master mix (each)' : 'Master mix') : 'Total') + ' ×' + k.n;
}
function calcHandle(e) {
  var block = e.target.closest && e.target.closest('.ln-calc');
  if (!block || !block._calc) return;
  var st = block._calc, el = e.target, tpl = CALC_TEMPLATES[st.t];
  if (e.type === 'click') {
    var act = el.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'remove') { if (confirm('Remove this ' + tpl.name + ' table from the page?')) { block.remove(); markEntryDirty(); } return; }
    if (act.dataset.act === 'del') st.comps.splice(+act.dataset.ci, 1);
    if (act.dataset.act === 'add') st.comps.splice(st.comps.findIndex(function (c) { return c.fill; }) >= 0 ? st.comps.findIndex(function (c) { return c.fill; }) : st.comps.length, 0,
      { name: 'New component', stock: '', final: '', unit: 'µL', per: 0, well: false, fill: false });
    calcRender(block); markEntryDirty(); return;
  }
  if (el.dataset.k) {
    var key = el.dataset.k;
    if (key === 'format') {
      st.format = el.value;
      if (tpl.kind === 'perwell') st.comps = calcCompsFor(tpl, st.format).map(function (c, i) { return st.comps[i] ? Object.assign({}, c, { name: st.comps[i].name }) : c; });
      else if (tpl.volumeByFormat && tpl.volumeByFormat[st.format]) calcScale(st, tpl.volumeByFormat[st.format]);
      calcRender(block); markEntryDirty(); return;
    }
    if (key === 'volume') {
      if (e.type !== 'change') return; // scale once the new volume is complete
      calcScale(st, Math.max(0, calcNum(el.value, st.volume)));
      calcRender(block); markEntryDirty(); return;
    }
    st[key] = key === 'extra' ? Math.max(0, calcNum(el.value)) : Math.max(key === 'reps' || key === 'targets' ? 1 : 0, Math.round(calcNum(el.value)));
  } else if (el.dataset.ci != null && el.dataset.f) {
    var c = st.comps[+el.dataset.ci];
    if (!c) return;
    c[el.dataset.f] = el.dataset.f === 'per' ? Math.max(0, calcNum(el.value)) : el.value;
  } else return;
  calcRefresh(block); markEntryDirty();
}
// New reaction volume: every amount keeps its proportion of the reaction.
function calcScale(st, vol) {
  var f = st.volume > 0 ? vol / st.volume : 1;
  st.comps.forEach(function (c) { if (!c.fill) c.per = Math.round(c.per * f * 1000) / 1000; });
  st.volume = vol;
}
// Turn stored blocks in a page into live tables.
function calcHydrate(root) {
  root.querySelectorAll('.ln-calc').forEach(function (block) {
    if (block._calc) return;
    var st = calcLoad(block.getAttribute('data-calc'));
    if (!st) return; // unreadable state: the stored snapshot stays as it is
    block._calc = st;
    block.setAttribute('contenteditable', 'false');
    calcRender(block);
  });
}
// For saving: the state, plus a plain table anyone can read without the app.
function calcSnapshot(block) {
  var st = block._calc, k = calcCompute(st), tpl = k.tpl;
  block.setAttribute('data-calc', JSON.stringify(st));
  block.removeAttribute('contenteditable');
  block.innerHTML = '<p><strong>' + esc(tpl.name) + '</strong> — ' + calcSummaryHtml(st, k).replace(/<[^>]+>/g, '') + '</p>' +
    '<table><thead><tr><th>Component</th><th>Per reaction</th><th>Total</th></tr></thead><tbody>' +
    st.comps.map(function (c) { var per = calcRowPer(st, c, k); return '<tr><td>' + esc(c.name) + '</td><td>' + calcFmt(per, c.unit) + ' ' + esc(c.unit) + '</td><td>' + calcTotalCell(st, c, k).replace(/<[^>]+>/g, '') + '</td></tr>'; }).join('') +
    '</tbody></table>';
}

// Picker: choose a recipe, insert it where the cursor was on the page.
var editorRange = null;
document.addEventListener('selectionchange', function () {
  var ed = document.getElementById('e-body'), sel = window.getSelection();
  if (ed && sel.rangeCount && ed.contains(sel.getRangeAt(0).startContainer)) editorRange = sel.getRangeAt(0).cloneRange();
});
function openCalcPicker() {
  document.getElementById('ln-modal-content').innerHTML = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Insert a calculation table</h3>' +
    '<p class="ln-bulk-intro">Amounts update as you change the number of samples, replicates, controls or the plate. Every amount can be edited in the table.</p>' +
    '<div class="ln-calc-pick">' + CALC_ORDER.map(function (t) {
      var tpl = CALC_TEMPLATES[t];
      return '<button type="button" class="ln-box-card" onclick="insertCalc(\'' + t + '\')"><div class="ln-calc-pick-name">' + esc(tpl.name) + '</div><div class="ln-box-card-meta">' + esc(tpl.source) + '</div></button>';
    }).join('') + '</div>';
  document.getElementById('ln-modal-bg').classList.add('open');
}
function insertCalc(t) {
  closeModal();
  var ed = document.getElementById('e-body');
  ed.focus();
  var sel = window.getSelection();
  if (editorRange && ed.contains(editorRange.startContainer)) { sel.removeAllRanges(); sel.addRange(editorRange); }
  else { sel.selectAllChildren(ed); sel.collapseToEnd(); }
  var holder = document.createElement('div');
  holder.className = 'ln-calc';
  holder.setAttribute('data-calc', JSON.stringify(calcNew(t)));
  document.execCommand('insertHTML', false, holder.outerHTML + '<p><br></p>');
  calcHydrate(ed);
  markEntryDirty();
}

/* Put a block on the page at the caret.

   Not execCommand('insertHTML'): a <div> dropped inside a <p> is invalid, so
   the browser unwraps it — the block vanishes and its text is left behind in
   the paragraph, which looks like nothing happened until you notice the date
   sitting in the middle of a sentence. Climbing to the editor's own child
   and inserting beside it puts the block where a block can actually live. */
function insertBlockAtCaret(ed, node) {
  ed.focus();
  var sel = window.getSelection();
  var range = (editorRange && ed.contains(editorRange.startContainer)) ? editorRange.cloneRange() : null;
  if (!range) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); }
  var at = range.startContainer;
  while (at && at !== ed && at.parentNode !== ed) at = at.parentNode;
  if (at && at !== ed) ed.insertBefore(node, at.nextSibling);
  else ed.appendChild(node);
  // Somewhere to carry on typing, since the block itself is not editable.
  var p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  ed.insertBefore(p, node.nextSibling);
  var after = document.createRange();
  after.setStart(p, 0); after.collapse(true);
  sel.removeAllRanges(); sel.addRange(after);
  editorRange = after.cloneRange();
}

// ── CULTURE PLATES ─────────────────────────────────────────
/* The block itself is js/plates.js; this is the picker and the insert, which
   work exactly like the calculation tables above so there is one way to put
   a block on a page rather than two. */
function openPlatePicker() {
  document.getElementById('ln-modal-content').innerHTML =
    '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Insert a culture plate</h3>' +
    '<p class="ln-bulk-intro">A box per well to write in — what was seeded, what was added, which condition. ' +
    'Wells are named the way the plate is printed and the way a plate reader exports them, so a map made here ' +
    'lines up with the data that comes back. The format can be changed afterwards.</p>' +
    '<div class="ln-calc-pick">' + LabPlates.ORDER.map(function (f) {
      var g = LabPlates.grid(f);
      return '<button type="button" class="ln-box-card" onclick="insertPlate(' + f + ')">' +
        '<div class="ln-calc-pick-name">' + esc(g.label) + '</div>' +
        '<div class="ln-box-card-meta">' + (f === 1 ? 'one dish' : g.rows + ' × ' + g.cols + ' wells') + '</div></button>';
    }).join('') + '</div>';
  document.getElementById('ln-modal-bg').classList.add('open');
}
function insertPlate(f) {
  closeModal();
  var ed = document.getElementById('e-body');
  var holder = document.createElement('div');
  holder.className = 'ln-plate';
  holder.setAttribute('data-plate', JSON.stringify(LabPlates.blank(f)));
  insertBlockAtCaret(ed, holder);
  LabPlates.hydrate(ed);
  markEntryDirty();
}

// ── DAY DIVIDERS ───────────────────────────────────────────
/* An experiment runs over days, and a page that records one is really
   several pages. A divider says where one day ends and the next begins, so
   "day 3" is something you can find rather than something you count down to.

   The date is stored as plain YYYY-MM-DD and written out in full, because a
   notebook read by somebody else should not need the reader to know whether
   03/04 is March or April. */
function dayLabel(iso) {
  var d = new Date(String(iso || '') + 'T00:00:00');
  if (isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function dayMarkHtml(iso) {
  return '<div class="ln-daymark" data-day="' + esc(iso) + '"><span>' + esc(dayLabel(iso)) + '</span></div>';
}
function insertDayMark() {
  var ed = document.getElementById('e-body');
  if (!ed) return;
  var last = lastDayOnPage(ed);
  var suggested = new Date().toISOString().slice(0, 10);
  var iso = prompt('Start a new day on this page.\n\nDate (YYYY-MM-DD)' +
    (last ? '\nThe last day on this page is ' + dayLabel(last) + '.' : ''), suggested);
  if (iso == null) return;
  iso = String(iso).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || isNaN(new Date(iso + 'T00:00:00').getTime())) {
    alert('That is not a date. Use the form 2026-10-17.');
    return;
  }
  var mark = document.createElement('div');
  mark.className = 'ln-daymark';
  mark.setAttribute('data-day', iso);
  insertBlockAtCaret(ed, mark);
  dayMarkHydrate(ed);
  markEntryDirty();
}
function lastDayOnPage(root) {
  var marks = root.querySelectorAll('.ln-daymark[data-day]');
  return marks.length ? marks[marks.length - 1].getAttribute('data-day') : '';
}
/* Dividers are not editable text — clicking one asks for the date instead,
   so a stray keystroke cannot leave a page with half a date on it. */
function dayMarkHydrate(root) {
  root.querySelectorAll('.ln-daymark').forEach(function (el) {
    el.setAttribute('contenteditable', 'false');
    var iso = el.getAttribute('data-day') || '';
    el.innerHTML = '<span>' + esc(dayLabel(iso)) + '</span>';
    if (el._wired) return;
    el._wired = true;
    el.addEventListener('click', function () {
      var next = prompt('Date for this divider (YYYY-MM-DD), or leave empty to remove it:', el.getAttribute('data-day') || '');
      if (next == null) return;
      next = String(next).trim();
      if (!next) { el.remove(); markEntryDirty(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || isNaN(new Date(next + 'T00:00:00').getTime())) {
        alert('That is not a date. Use the form 2026-10-17.');
        return;
      }
      el.setAttribute('data-day', next);
      el.innerHTML = '<span>' + esc(dayLabel(next)) + '</span>';
      markEntryDirty();
    });
  });
}

/* Everything a page can hold that is more than text. One call, so a new kind
   of block is added in one place rather than in four. */
function blockHydrate(root) {
  calcHydrate(root);
  if (window.LabPlates) LabPlates.hydrate(root);
  dayMarkHydrate(root);
  if (window.LabMentions) LabMentions.hydrate(root);
}

// ── TABLE EDITOR ───────────────────────────────────────────
var activeTables = [];
function initTableEditor() { activeTables = []; }
function addTableToEditor() {
  var idx = activeTables.length; activeTables.push({ label: '', rows: 2, cols: 3 });
  var cont = document.getElementById('ln-tables-editor');
  var div = document.createElement('div'); div.id = 'tbl-wrap-' + idx; div.style.marginBottom = '1.5rem';
  var heads = [0, 1, 2].map(function (c) { return '<th contenteditable="true">Column ' + (c + 1) + '</th>'; }).join('');
  var body = [0, 1].map(function () { return '<tr>' + [0, 1, 2].map(function () { return '<td contenteditable="true"></td>'; }).join('') + '</tr>'; }).join('');
  div.innerHTML = '<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;"><input placeholder="Table label (optional)" style="flex:1;padding:.4rem .7rem;border:1.5px solid #ddd;border-radius:6px;font-size:13px;" id="tbl-label-' + idx + '" value=""><button class="tbl-btn del" onclick="removeTable(' + idx + ')">✕ Remove Table</button></div>' +
    '<div class="exp-table-wrap"><table class="exp-tbl" id="tbl-' + idx + '"><thead><tr id="tbl-head-' + idx + '">' + heads + '</tr></thead><tbody id="tbl-body-' + idx + '">' + body + '</tbody></table></div>' +
    '<div style="margin-top:.4rem;"><button class="tbl-btn" onclick="addTblRow(' + idx + ')">+ Row</button><button class="tbl-btn" onclick="addTblCol(' + idx + ')">+ Column</button><button class="tbl-btn del" onclick="delTblRow(' + idx + ')">- Row</button><button class="tbl-btn del" onclick="delTblCol(' + idx + ')">- Column</button></div>';
  cont.appendChild(div);
}
function removeTable(idx) { var d = document.getElementById('tbl-wrap-' + idx); if (d) d.remove(); }
function addTblRow(idx) { var tb = document.getElementById('tbl-body-' + idx); if (!tb) return; var cols = (document.getElementById('tbl-head-' + idx) || { children: { length: 3 } }).children.length || 3; var tr = document.createElement('tr'); for (var i = 0; i < cols; i++) { var td = document.createElement('td'); td.contentEditable = 'true'; tr.appendChild(td); } tb.appendChild(tr); }
function addTblCol(idx) { var head = document.getElementById('tbl-head-' + idx); if (!head) return; var th = document.createElement('th'); th.contentEditable = 'true'; th.textContent = 'Column'; head.appendChild(th); document.querySelectorAll('#tbl-body-' + idx + ' tr').forEach(function (tr) { var td = document.createElement('td'); td.contentEditable = 'true'; tr.appendChild(td); }); }
function delTblRow(idx) { var tb = document.getElementById('tbl-body-' + idx); if (!tb) return; if (tb.rows.length > 1) tb.deleteRow(tb.rows.length - 1); }
function delTblCol(idx) { var head = document.getElementById('tbl-head-' + idx); if (!head || head.children.length <= 1) return; head.deleteCell(head.children.length - 1); document.querySelectorAll('#tbl-body-' + idx + ' tr').forEach(function (tr) { if (tr.cells.length > 0) tr.deleteCell(tr.cells.length - 1); }); }
function serializeTables() {
  var tables = [];
  document.querySelectorAll('[id^="tbl-wrap-"]').forEach(function (wrap) {
    var idx = wrap.id.replace('tbl-wrap-', '');
    var tbl = document.getElementById('tbl-' + idx);
    var labelEl = document.getElementById('tbl-label-' + idx);
    if (!tbl) return;
    tables.push({ label: labelEl ? labelEl.value : '', html: tbl.innerHTML });
  });
  return tables;
}
function loadTablesIntoEditor(tables) {
  if (!tables || !tables.length) return;
  tables.forEach(function (t, idx) {
    addTableToEditor();
    setTimeout(function () {
      var labelEl = document.getElementById('tbl-label-' + idx); if (labelEl) labelEl.value = t.label || '';
      var tbl = document.getElementById('tbl-' + idx);
      if (tbl) { tbl.innerHTML = t.html; tbl.querySelectorAll('th,td').forEach(function (c) { c.contentEditable = 'true'; }); }
    }, 50);
  });
}

// ── PRESENTATIONS ──────────────────────────────────────────
function renderPresentations() {
  var ps = getPresentations().slice().reverse();
  var el = document.getElementById('ln-presentations-list');
  if (!ps.length) { el.innerHTML = '<div class="ln-empty">No presentations yet.</div>'; return; }
  el.innerHTML = ps.map(function (p) {
    return '<div class="ln-card"><div class="ln-card-header"><div><div class="ln-card-title">' + esc(p.title) + '</div>' +
      '<div class="ln-card-meta">👤 ' + esc(p.presenter) + ' · 📅 ' + esc(p.date) + ' · 🏷️ ' + esc(p.venue) + '</div></div>' +
      '<div class="ln-card-actions">' + (p.link ? '<a href="' + esc(p.link) + '" target="_blank" class="ln-icon-btn">Open ↗</a>' : '') +
      '<button class="ln-icon-btn danger" onclick="deletePresentation(\'' + p.id + '\')">✕</button></div></div>' +
      (p.notes ? '<div style="font-size:13px;color:#555;">' + esc(p.notes) + '</div>' : '') + renderAttachments(p.files) + '</div>';
  }).join('');
}
async function deletePresentation(id) { if (confirm('Delete this presentation?')) { await DB.remove('presentations', id); renderPresentations(); } }

// ── WEBAPPS & TOOLS ────────────────────────────────────────
function renderWebapps() {
  // Full standalone apps. The Primer Generator is not here: it is the
  // Inventory -> Primers page.
  var custom = '' +
    // First, because the person most likely to open this page is the person
    // who has not used the notebook before.
    appCard('https://claude.ai/artifact/JRF9PbuxPvXxqeivBDzL14', '📖', 'Lab Notebook Guide',
      'How every module works, field by field — inventory, primers, plasmids and cloning, tissue culture, glycerol stocks',
      'Elias Lab · guide ↗') +
    // Full standalone apps, opened in their own tab
    appCard('tools/gibson-calculator.html', '⚙️', 'Gibson Assembly Calculator', 'Reaction volume calculator for NEB Gibson and EURx LigON kits, with protocol notes') +
    appCard('tools/genome-scan.html', '🧭', 'GenomeScan', 'Consensus / att-site finder across the human genome (BLAST + Open Targets)');
  document.getElementById('ln-custom-tools-grid').innerHTML = custom;

  var TOOLS = [
    { icon: '🧬', name: 'NCBI BLAST', url: 'https://blast.ncbi.nlm.nih.gov', desc: 'Sequence alignment & homology search' },
    { icon: '🔬', name: 'AlphaFold Server', url: 'https://alphafoldserver.com', desc: 'Protein structure prediction (AlphaFold3)' },
    { icon: '📊', name: 'Benchling', url: 'https://benchling.com', desc: 'Molecular biology ELN platform' },
    { icon: '🧪', name: 'SnapGene Viewer', url: 'https://www.snapgene.com/snapgene-viewer', desc: 'Plasmid visualization & cloning design' },
    { icon: '🌐', name: 'Addgene', url: 'https://www.addgene.org', desc: 'Plasmid repository & protocols' },
    { icon: '🔗', name: 'Primer3', url: 'https://primer3.ut.ee', desc: 'PCR primer design tool' },
    { icon: '📈', name: 'GraphPad Prism', url: 'https://www.graphpad.com', desc: 'Statistical analysis & graphing' },
    { icon: '🧫', name: 'UniProt', url: 'https://www.uniprot.org', desc: 'Protein sequence & function database' },
    { icon: '🔍', name: 'UCSC Genome Browser', url: 'https://genome.ucsc.edu', desc: 'Genomic sequence exploration' },
    { icon: '🏥', name: 'ClinicalTrials.gov', url: 'https://clinicaltrials.gov', desc: 'Gene therapy clinical trial registry' }
  ];
  document.getElementById('ln-webapp-grid').innerHTML = TOOLS.map(function (t) {
    return '<a href="' + t.url + '" target="_blank" rel="noopener" class="ln-webapp-card"><div class="ln-webapp-icon">' + t.icon + '</div><div class="ln-webapp-name">' + t.name + '</div><div class="ln-webapp-desc">' + t.desc + '</div></a>';
  }).join('');
}
// A full standalone tool, opened in its own tab. `label` is the line above
// the name; it defaults to the tool wording, because not everything the lab
// publishes here is a tool — the guide is a document.
function appCard(href, icon, name, desc, label) {
  return '<a href="' + href + '" target="_blank" rel="noopener" class="ln-webapp-card custom">' +
    '<div class="ln-webapp-custom-label">' + (label || 'Elias Lab Tool · full app ↗') + '</div>' +
    '<div class="ln-webapp-icon">' + icon + '</div>' +
    '<div class="ln-webapp-name">' + name + '</div>' +
    '<div class="ln-webapp-desc">' + desc + '</div></a>';
}

// ── INVENTORY ──────────────────────────────────────────────
var currentInvTab = 'enzymes';
var INV_LABELS = {
  enzymes:  { one: 'Restriction Enzyme', many: 'restriction enzymes' },
  primers:  { one: 'Primer',             many: 'primers' },
  plasmids: { one: 'Plasmid',            many: 'plasmids' },
  stocks:   { one: 'Glycerol Stock',     many: 'glycerol stocks' },
  cells:    { one: 'Cell Line',           many: 'cell lines' },
  kits:     { one: 'Kit / Reagent',      many: 'kits or reagents' }
};
var INV_CONFIG = {
  enzymes: { cols: ['Name', 'Supplier', 'Catalog #', 'Cut Site', 'Conc.', 'Qty', 'Storage', 'Added by'], fields: ['name', 'supplier', 'catalog', 'cutsite', 'conc', 'qty', 'storage', 'addedBy'] },
  primers: { cols: ['Name', "Sequence (5'→3')", 'Tm (°C)', 'Application', 'Storage', 'Added by'], fields: ['name', 'sequence', 'tm', 'application', 'storage', 'addedBy'] },
  plasmids: { cols: ['Name', 'Backbone', 'Insert', 'Resistance', 'Size (bp)', 'Conc.', 'Owner', 'Freezer', 'Box', 'Position', 'Location', 'Added by'], fields: ['name', 'backbone', 'insert', 'resistance', 'len', 'conc', 'owner', 'freezer', 'box', 'position', 'location', 'addedBy'] },
  stocks: { cols: ['Serial #', 'Description', 'Resistance', 'Sequenced (QC)', 'Strain', 'Freezer (-80°C)', 'Rack_Shelf', 'Position on Drawer', 'Box', 'Position', 'Owner', 'Map', 'Notes'], fields: ['serial', 'description', 'resistance', 'qc', 'hostStrain', 'freezer', 'shelf', 'shelfPlace', 'box', 'position', 'owner', 'mapLink', 'notes'] },
  cells: { cols: ['Cell Line', 'Passage', 'Cells / Vial', 'Source', 'Growth Media', 'Banking Media', 'Liquid N₂ Tank', 'Rack', 'Box', 'Position', 'Notes', 'Added by'], fields: ['name', 'passage', 'amount', 'source', 'growthMedia', 'bankMedia', 'tank', 'rack', 'box', 'position', 'notes', 'addedBy'] },
  kits: { cols: ['Kit Name', 'Supplier', 'Catalog #', 'Qty Left', 'Expiry', 'Storage', 'Added by'], fields: ['name', 'supplier', 'catalog', 'qty', 'expiry', 'storage', 'addedBy'] }
};
// E. coli strains the lab keeps glycerol stocks in; offered as suggestions, others can be typed.
var STOCK_STRAINS = ['DH5α', 'NEB Stable', 'Stbl3'];
var RESISTANCES = ['AmpR', 'KanR', 'CmR', 'SpecR', 'TetR', 'ZeoR'];

/* Each inventory category is its own page, reached from the sidebar.
   Primers is the Primer Generator app instead of a table; its iframe is
   loaded the first time the page is opened, not on every page load. */
function showInventoryPage(cat) {
  if (!INV_CONFIG[cat]) return;
  currentInvTab = cat;
  if (cat === 'primers') {
    var frame = document.getElementById('ln-primer-app');
    if (frame && !frame.getAttribute('src')) frame.setAttribute('src', frame.getAttribute('data-src'));
    return;
  }
  renderInventory(cat);
}
/* Kits carry an expiry date, so say something about it rather than printing
   it as one more column. Dates are plain YYYY-MM-DD, compared at local
   midnight so "expires today" is not already in the past. */
function expiryState(value) {
  if (!value) return null;
  var d = new Date(value + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var days = Math.round((d - today) / 86400000);
  if (days < 0) return { cls: 'expired', note: 'expired' };
  if (days === 0) return { cls: 'expired', note: 'expires today' };
  if (days <= 30) return { cls: 'soon', note: days + ' day' + (days === 1 ? '' : 's') + ' left' };
  return null;
}

/* Rows arrive from the database in the order they were added, which is
   nobody's reading order: a stock numbered 22 sits between 72 and 1 because
   that is when it was typed in. They are sorted here by the field that
   identifies the row — the serial for glycerol stocks, the name everywhere
   else, which is `fields[0]` in every category.

   Numeric-aware, because these identifiers are usually bare numbers and a
   plain string sort puts 100 before 22 before 5 — as unreadable as no sort
   at all. Intl.Collator with numeric:true also orders a padded scheme like
   GS-0007 correctly, and names that end in a number.

   A row whose identifying field is empty goes last. Blank rows happen —
   a bulk upload with trailing lines leaves them — and sorting them to the
   top would push the real stocks out of the first screen. */
var invCollator = (function () {
  try { return new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }); }
  catch (e) { return null; }   // very old browser: localeCompare below still sorts
})();
function invCompare(a, b, key) {
  var x = String(a[key] == null ? '' : a[key]).trim();
  var y = String(b[key] == null ? '' : b[key]).trim();
  if (!x !== !y) return x ? -1 : 1;
  if (!x) return 0;
  return invCollator ? invCollator.compare(x, y) : x.localeCompare(y, undefined, { numeric: true });
}

/* Which fields decide the order, in priority order.

   Tissue culture is read off a freezer box, not off a list of names, so it
   sorts the way the vials are physically arranged: tank, then rack, then box,
   then position — A1, A2 … B1, B2. Position alone would not do, because A1
   exists in every box in the lab and sorting on it would interleave them.

   Everything else sorts by the field that names it, which is fields[0]. */
var INV_SORT = { cells: ['tank', 'rack', 'box', 'position'] };
function invSortKeys(cat, cfg) { return INV_SORT[cat] || [cfg.fields[0]]; }

/* What makes one slot in a freezer different from another.

   The whole location, not the box name alone: a lab that numbers its boxes
   within each rack has a "Box 1" in every rack, and matching on the name
   would call two different physical boxes the same one and refuse a position
   that is genuinely free. */
var INV_SLOT = {
  cells: ['tank', 'rack', 'box', 'position'],
  stocks: ['freezer', 'shelf', 'box', 'position'],
  plasmids: ['freezer', 'box', 'position']
};
function slotKey(cat, item) {
  var keys = INV_SLOT[cat];
  if (!keys) return null;
  var parts = keys.map(function (k) { return bulkKey(item[k]); });
  // No position means it has not been given a slot yet, so it clashes with
  // nothing — a vial can be recorded before anybody decides where it goes.
  return parts[parts.length - 1] ? parts.join('|') : null;
}
/* The item already sitting where this one wants to go, if there is one. */
function slotTakenBy(cat, item) {
  var key = slotKey(cat, item);
  if (!key) return null;
  return (getInventory()[cat] || []).filter(function (x) {
    return x.id !== item.id && slotKey(cat, x) === key;
  })[0] || null;
}

/* A copy, not a sort in place: `items` is the app's own array, and drawing a
   table should not quietly reorder the state that the CSV export, the box
   maps and the dashboard all read. */
function sortInventory(items, cfg, cat) {
  var keys = invSortKeys(cat || currentInvTab, cfg);
  return items.slice().sort(function (a, b) {
    for (var i = 0; i < keys.length; i++) {
      var d = invCompare(a, b, keys[i]);
      if (d) return d;
    }
    return 0;
  });
}

function renderInventory(tab) {
  currentInvTab = tab || currentInvTab;
  var cfg = INV_CONFIG[currentInvTab];
  var el = document.getElementById('ln-invtable-' + currentInvTab);
  if (!el || !cfg) return;
  var all = getInventory()[currentInvTab] || [];

  // The search box is the single source of truth, so a filter survives
  // leaving the page and coming back.
  var box = document.getElementById('ln-invsearch-' + currentInvTab);
  var q = (box && box.value || '').trim().toLowerCase();
  var items = !q ? all : all.filter(function (item) {
    for (var i = 0; i < cfg.fields.length; i++) {
      if (String(item[cfg.fields[i]] || '').toLowerCase().indexOf(q) >= 0) return true;
    }
    return false;
  });

  if (!all.length) { el.innerHTML = '<div class="ln-empty">No ' + INV_LABELS[currentInvTab].many + ' added yet.</div>'; return; }
  if (!items.length) { el.innerHTML = '<div class="ln-empty">Nothing here matches \u201c' + esc(q) + '\u201d.</div>'; return; }
  items = sortInventory(items, cfg);

  // Expiry summary, kits only.
  var banner = '';
  if (currentInvTab === 'kits') {
    var expired = 0, soon = 0;
    all.forEach(function (item) {
      var st = expiryState(item.expiry);
      if (st && st.cls === 'expired') expired++; else if (st) soon++;
    });
    if (expired || soon) {
      var parts = [];
      if (expired) parts.push('<strong>' + expired + '</strong> expired');
      if (soon) parts.push('<strong>' + soon + '</strong> expiring within 30 days');
      banner = '<div class="ln-inv-alert ' + (expired ? 'expired' : 'soon') + '">\u26a0 ' + parts.join(' \u00b7 ') + '</div>';
    }
  }

  /* Tissue culture: the lines that are down to their last vial.
     Counted across the whole category, not the filtered view \u2014 a search for
     "HEK" must not make a line look like its last vial because the others
     are hidden. Thawing the only vial of a line is how a line leaves the lab,
     so it is said at the top and marked on the row. */
  var lastVials = {};
  if (currentInvTab === 'cells') {
    var byLine = {};
    all.forEach(function (item) {
      var k = bulkKey(item.name);
      if (k) (byLine[k] = byLine[k] || []).push(item);
    });
    Object.keys(byLine).forEach(function (k) { if (byLine[k].length === 1) lastVials[k] = true; });
    var names = Object.keys(byLine).filter(function (k) { return lastVials[k]; })
      .map(function (k) { return byLine[k][0].name; }).sort();
    if (names.length) {
      banner = '<div class="ln-inv-alert expired">\u26a0 <strong>' + names.length + ' cell line' +
        (names.length === 1 ? '' : 's') + ' down to the last vial:</strong> ' +
        names.map(esc).join(', ') + ' \u2014 expand before thawing the last one.</div>';
    }
  }

  var count = q ? '<div class="ln-inv-count">' + items.length + ' of ' + all.length + ' shown</div>' : '';

  el.innerHTML = banner + count + '<div style="overflow-x:auto;"><table class="ln-table"><thead><tr>' +
    cfg.cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '<th class="ln-row-actions">Actions</th></tr></thead><tbody>' +
    items.map(function (item) {
      // The id is on the row so an @-mention of this item can point straight
      // at it rather than leaving somebody to find it in the table.
      return '<tr data-item-id="' + esc(item.id || '') + '">' + cfg.fields.map(function (f) {
        var val = esc(item[f] || '\u2014');
        if (f === 'name' && currentInvTab === 'plasmids' && item.name) {
          val = '<a href="#plasmid/' + esc(item.id) + '" class="ln-box-link" onclick="openPlasmid(\'' + item.id + '\');return false;">' + esc(item.name) + '</a>';
        }
        if (f === 'expiry') {
          var st = expiryState(item[f]);
          if (st) val = '<span class="ln-exp ' + st.cls + '">' + val + ' \u00b7 ' + st.note + '</span>';
        }
        // The only vial of its line, marked where the line is named.
        if (f === 'name' && currentInvTab === 'cells' && lastVials[bulkKey(item.name)]) {
          val += ' <span class="ln-exp expired">last vial</span>';
        }
        // A box name opens that box's map.
        if (f === 'box' && item.box && BOX_CATS.indexOf(currentInvTab) >= 0) {
          val = '<a href="#" class="ln-box-link" data-box="' + esc(item.box) + '" onclick="openBoxByName(this.dataset.box,\'' + currentInvTab + '\');return false;" title="Open box map">' + esc(item.box) + ' ▦</a>';
        }
        // Map links open in a new tab; only http(s), so a typed "javascript:" can't run.
        if (f === 'mapLink' && /^https?:\/\//i.test(item[f] || '')) {
          val = '<a href="' + esc(item[f]) + '" target="_blank" rel="noopener" class="ln-map-link">Map \u2197</a>';
        }
        var cls = f === 'notes' ? 'ln-notes-cell' : f === 'serial' ? 'ln-nowrap' : f === 'description' ? 'ln-wide-cell' : '';
        return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + val + '</td>';
      }).join('') +
      '<td class="ln-row-actions">' +
        (currentInvTab === 'plasmids' ? '<button class="ln-icon-btn" title="Open the plasmid page" onclick="openPlasmid(\'' + item.id + '\')">Open</button>' : '') +
        // Four vials of the same freeze differ only in where they sit, and
        // typing the other eight fields out four times is how they end up
        // disagreeing with each other.
        (currentInvTab === 'cells' ? '<button class="ln-icon-btn" title="Copy this vial to another position" onclick="copyInvItem(\'' + item.id + '\')">\u29c9</button>' : '') +
        '<button class="ln-icon-btn" title="Edit" onclick="openInventoryModal(\'' + item.id + '\')">\u270e</button>' +
        '<button class="ln-icon-btn danger" title="Remove" onclick="deleteInvItem(\'' + currentInvTab + '\',\'' + item.id + '\')">\u2715</button>' +
      '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

/* Download one category as CSV, for ordering lists and audits. */
function exportInventoryCSV(cat) {
  var cfg = INV_CONFIG[cat], items = getInventory()[cat] || [];
  if (!items.length) { alert('There is nothing in ' + INV_LABELS[cat].many + ' to export yet.'); return; }
  // In the same order as the page. A spreadsheet handed to somebody for an
  // order or an audit should not arrive shuffled by when each row was typed.
  items = sortInventory(items, cfg, cat);
  var rows = [cfg.cols].concat(items.map(function (item) {
    return cfg.fields.map(function (f) { return item[f] == null ? '' : String(item[f]); });
  }));
  var csv = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  // BOM so Excel reads the UTF-8 in °C, 5'→3' and G↓AATTC correctly.
  var url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = 'elias-lab-' + cat + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
}
function csvCell(v) {
  // A leading = + - or @ makes Excel treat the cell as a formula; prefix it.
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
}
async function deleteInvItem(tab, id) {
  if (!confirm('Remove this item?')) return;
  await DB.removeInventory(tab, id); renderInventory(tab);
  if (lnCurrentSection === 'boxes') renderBoxes();
}

// ── STORAGE BOXES ──────────────────────────────────────────
/* A box is an inventory item of category 'boxes': { name, cat, layout,
   freezer, notes }. Each box holds one inventory type (cat: plasmids, stocks
   or cells), so "Box 1" of glycerol stocks and "Box 1" of cell lines are two
   different boxes. Its vials are the items of that type whose Box matches the
   name (case and spacing ignored), placed by Position: "A3" style, or a
   number counted row by row (1-81 in a 9x9). A box name used by vials but
   never set up still shows, assumed 9x9.
   Set-ups saved before boxes had a type have no `cat`; they apply to every
   type using that name until edited, when they are saved with the type. */
var BOX_CATS = ['plasmids', 'stocks', 'cells'];
var BOX_TYPE_NAMES = { plasmids: 'Plasmid boxes', stocks: 'Glycerol stock boxes', cells: 'Tissue culture boxes' };
var BOX_LAYOUTS = { '9x9': { rows: 9, cols: 9 }, '10x10': { rows: 10, cols: 10 }, '5x5': { rows: 5, cols: 5 } };
var BOX_DEFAULT_LAYOUT = '9x9';
var boxView = null;      // key of the open box, or null for the list of boxes
var boxSelected = null;  // 'r,c' of the selected cell in the open box

function boxKey(cat, name) { return (cat || 'any') + ':' + bulkKey(name); }
function boxDims(def) { return BOX_LAYOUTS[def && def.layout] || BOX_LAYOUTS[BOX_DEFAULT_LAYOUT]; }
function boxTypeOne(cat) { return cat ? INV_LABELS[cat].one.toLowerCase() : 'any'; }
function vialLabel(cat, it) {
  if (cat === 'stocks') return it.serial || it.description || 'Stock';
  return it.name || INV_LABELS[cat].one;
}
// Grid cell for a position, or null when it doesn't fit this box.
function parsePosition(pos, dims) {
  var s = String(pos == null ? '' : pos).trim().toUpperCase().replace(/[\s\-_:]/g, '');
  var r, c, m;
  if ((m = /^([A-Z])0*(\d{1,2})$/.exec(s))) { r = m[1].charCodeAt(0) - 65; c = +m[2] - 1; }
  else if ((m = /^0*(\d{1,3})$/.exec(s))) { var i = +m[1] - 1; r = Math.floor(i / dims.cols); c = i % dims.cols; }
  else return null;
  return r >= 0 && c >= 0 && r < dims.rows && c < dims.cols ? { r: r, c: c } : null;
}

/* Every box: the set-up ones plus names vials use without a set-up box. */
function boxIndex() {
  var inv = getInventory(), boxes = {}, order = [];
  function get(cat, name) {
    var k = boxKey(cat, name);
    if (!boxes[k]) { boxes[k] = { key: k, cat: cat, name: String(name).trim(), def: null, vials: [] }; order.push(k); }
    return boxes[k];
  }
  var defs = inv.boxes || [];
  defs.forEach(function (d) { if (d.name && d.cat) get(d.cat, d.name).def = d; });
  BOX_CATS.forEach(function (cat) {
    (inv[cat] || []).forEach(function (it) { if (String(it.box || '').trim()) get(cat, it.box).vials.push({ cat: cat, item: it }); });
  });
  // Untyped (older) set-ups: lend the layout to every type using the name.
  defs.forEach(function (d) {
    if (!d.name || d.cat) return;
    var used = BOX_CATS.filter(function (c) { return boxes[boxKey(c, d.name)]; });
    if (!used.length) { get(null, d.name).def = d; return; }
    used.forEach(function (c) {
      var b = boxes[boxKey(c, d.name)];
      if (!b.def) { b.def = d; b.sharedDef = used.length > 1; }
    });
  });
  return order.map(function (k) {
    var b = boxes[k];
    if (b.def) b.name = b.def.name;
    b.dims = boxDims(b.def);
    b.cells = {}; b.unplaced = [];
    b.vials.forEach(function (v) {
      var p = parsePosition(v.item.position, b.dims);
      if (!p) { b.unplaced.push(v); return; }
      (b.cells[p.r + ',' + p.c] = b.cells[p.r + ',' + p.c] || []).push(v);
    });
    b.placed = Object.keys(b.cells).length;
    // Where it is: the box's own freezer, else what its vials say.
    b.where = (b.def && b.def.freezer) || (b.vials.map(function (v) { return v.item.freezer || v.item.tank || ''; }).filter(Boolean)[0] || '');
    return b;
  }).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
}
function findBox(key) { return boxIndex().filter(function (x) { return x.key === key; })[0] || null; }

function openBoxesPage() { boxView = null; boxSelected = null; lnShow('boxes'); }
function openBox(key) { boxView = key; boxSelected = null; lnShow('boxes'); }
function openBoxByName(name, cat) { openBox(boxKey(cat, name)); }
function renderBoxes() {
  var el = document.getElementById('ln-boxes-body');
  if (!el) return;
  var all = boxIndex();
  var box = boxView && all.filter(function (b) { return b.key === boxView; })[0];
  if (boxView && !box) boxView = null; // renamed or emptied
  el.innerHTML = box ? boxDetailHtml(box) : boxListHtml(all);
}

function boxListHtml(all) {
  var box = document.getElementById('ln-boxsearch');
  var q = box ? box.value : '';
  return '<div class="ln-section-header"><div><h2>Storage Boxes</h2><p>Freezer and liquid-nitrogen boxes: open one to see where every vial sits</p></div>' +
    '<div class="ln-header-actions"><button class="ln-add-btn ghost" onclick="window.print()">\ud83d\udda8 Print</button><button class="ln-add-btn" onclick="openBoxModal()">+ New Box</button></div></div>' +
    '<input class="ln-search" id="ln-boxsearch" placeholder="🔍 Search boxes or freezers..." value="' + esc(q) + '" oninput="document.getElementById(\'ln-box-listbody\').innerHTML = boxListBody(boxIndex(), this.value)" style="margin-bottom:1.5rem;">' +
    '<div id="ln-box-listbody">' + boxListBody(all, q) + '</div>';
}
function boxListBody(all, q) {
  q = String(q || '').trim().toLowerCase();
  var shown = !q ? all : all.filter(function (b) { return (b.name + ' ' + b.where).toLowerCase().indexOf(q) >= 0; });
  if (!all.length) return '<div class="ln-empty">No boxes yet. Click "+ New Box", or give a plasmid, glycerol stock or cell line a Box name and it appears here.</div>';
  if (!shown.length) return '<div class="ln-empty">No box matches “' + esc(q) + '”.</div>';
  // One group per type, so same-named boxes of different types sit apart.
  return BOX_CATS.concat([null]).map(function (cat) {
    var group = shown.filter(function (b) { return b.cat === cat; });
    if (!group.length) return '';
    return '<h3 class="ln-box-group">' + (cat ? BOX_TYPE_NAMES[cat] : 'Type not set') + ' <span>' + group.length + '</span></h3>' +
      '<div class="ln-box-grid-list">' + group.map(boxCardHtml).join('') + '</div>';
  }).join('');
}
function boxCardHtml(b) {
  var total = b.dims.rows * b.dims.cols, n = b.vials.length;
  var content = !b.cat ? '<span class="ln-vchip">empty · type not set</span>'
    : '<span class="ln-vchip ' + b.cat + '">' + n + ' ' + (n === 1 ? INV_LABELS[b.cat].one.toLowerCase() : INV_LABELS[b.cat].many) + '</span>';
  return '<button type="button" class="ln-box-card" data-key="' + esc(b.key) + '" onclick="openBox(this.dataset.key)">' +
    '<div class="ln-box-card-name">' + esc(b.name) + '</div>' +
    '<div class="ln-box-card-meta">' + (b.def ? esc(b.def.layout || BOX_DEFAULT_LAYOUT).replace('x', '×') : 'Layout not set') + (b.where ? ' · ' + esc(b.where) : '') + '</div>' +
    '<div class="ln-box-fill"><span style="width:' + Math.round(b.placed / total * 100) + '%"></span></div>' +
    '<div class="ln-box-card-count">' + b.placed + ' / ' + total + ' positions used' + (b.unplaced.length ? ' · <span class="warn">' + b.unplaced.length + ' without a position</span>' : '') + '</div>' +
    '<div class="ln-vchips">' + content + '</div></button>';
}

function boxDetailHtml(b) {
  var d = b.dims, rowsHtml = '';
  var type = b.cat ? INV_LABELS[b.cat].one + ' box' : 'Box (type not set)';
  var head = '<div class="ln-section-header"><div><a href="#" class="ln-back-link" onclick="openBoxesPage();return false;">← All boxes</a>' +
    '<h2>' + esc(b.name) + '</h2><p>' + type + ' · ' + (b.def ? esc(b.def.layout || BOX_DEFAULT_LAYOUT).replace('x', '×') : 'layout not set (shown as 9×9)') +
    (b.where ? ' · ' + esc(b.where) : '') + ' · ' + b.placed + ' / ' + (d.rows * d.cols) + ' positions used</p></div>' +
    '<div class="ln-header-actions"><button class="ln-add-btn ghost" onclick="window.print()">\ud83d\udda8 Print</button>' +
      '<button class="ln-add-btn ghost" data-key="' + esc(b.key) + '" onclick="exportBoxCSV(this.dataset.key)">\u2193 CSV</button>' +
      '<button class="ln-add-btn ' + (b.def ? 'ghost' : '') + '" data-key="' + esc(b.key) + '" onclick="openBoxModal(this.dataset.key)">' + (b.def ? 'Edit box' : 'Set up this box') + '</button></div></div>' +
    (b.def && b.def.notes ? '<div class="ln-box-notes">' + esc(b.def.notes) + '</div>' : '');
  rowsHtml += '<div class="ln-bm-corner"></div>';
  for (var c = 0; c < d.cols; c++) rowsHtml += '<div class="ln-bm-colh">' + (c + 1) + '</div>';
  for (var r = 0; r < d.rows; r++) {
    rowsHtml += '<div class="ln-bm-rowh">' + String.fromCharCode(65 + r) + '</div>';
    for (c = 0; c < d.cols; c++) {
      var key = r + ',' + c, vs = b.cells[key], pos = String.fromCharCode(65 + r) + (c + 1);
      var sel = boxSelected === key ? ' selected' : '';
      if (!vs) { rowsHtml += '<button type="button" class="ln-bm-cell empty' + sel + '" title="' + pos + ' — empty" onclick="selectBoxCell(\'' + key + '\')"></button>'; continue; }
      var v = vs[0], label = vialLabel(v.cat, v.item);
      rowsHtml += '<button type="button" class="ln-bm-cell ' + v.cat + (vs.length > 1 ? ' clash' : '') + sel + '" title="' + pos + ' — ' + esc(vs.map(function (x) { return vialLabel(x.cat, x.item); }).join(' / ')) + '" onclick="selectBoxCell(\'' + key + '\')">' +
        '<span class="ln-bm-label">' + esc(label) + '</span>' + (vs.length > 1 ? '<span class="ln-bm-badge">' + vs.length + '</span>' : '') + '</button>';
    }
  }
  var legend = '<div class="ln-bm-legend">' + (b.cat ? '<span><i class="ln-bm-swatch ' + b.cat + '"></i>' + INV_LABELS[b.cat].one + '</span>' : '') +
    '<span><i class="ln-bm-swatch clash"></i>Two vials in one position</span></div>';
  var unplaced = b.unplaced.length ? '<div class="ln-bm-unplaced"><strong>' + b.unplaced.length + ' in this box without a usable position</strong>' +
    b.unplaced.map(function (v) {
      return '<button type="button" class="ln-bm-uitem ' + v.cat + '" onclick="editVial(\'' + v.cat + '\',\'' + v.item.id + '\')">' + esc(vialLabel(v.cat, v.item)) +
        ' <span>' + (v.item.position ? 'position “' + esc(v.item.position) + '” does not fit' : 'no position') + '</span></button>';
    }).join('') + '</div>' : '';
  return head + '<div class="ln-bm-wrap"><div class="ln-bm" style="grid-template-columns:22px repeat(' + d.cols + ',minmax(26px,1fr));">' + rowsHtml + '</div>' +
    '<div class="ln-bm-side">' + legend + boxCellPanel(b) + '</div></div>' + unplaced + boxContentsHtml(b);
}

/* What is in a box, position by position: shown under the map, printed with
   it, and exported as CSV. Fields are the box type's columns minus Box. */
function boxContentRows(b) {
  var rows = [];
  Object.keys(b.cells).forEach(function (k) {
    var rc = k.split(',');
    b.cells[k].forEach(function (v) { rows.push({ r: +rc[0], c: +rc[1], pos: String.fromCharCode(65 + +rc[0]) + (+rc[1] + 1), v: v }); });
  });
  rows.sort(function (x, y) { return x.r - y.r || x.c - y.c; });
  b.unplaced.forEach(function (v) { rows.push({ pos: v.item.position ? v.item.position + ' (does not fit)' : '\u2014', v: v }); });
  return rows;
}
function boxContentCols(b) {
  var cat = b.cat || (b.vials[0] && b.vials[0].cat);
  if (!cat) return [];
  var cfg = INV_CONFIG[cat];
  return cfg.fields.map(function (f, i) { return { f: f, label: cfg.cols[i] }; })
    .filter(function (c) { return c.f !== 'box' && c.f !== 'position' && c.f !== 'addedBy'; });
}
function boxContentsHtml(b) {
  var rows = boxContentRows(b), cols = boxContentCols(b);
  if (!rows.length) return '';
  return '<h3 class="ln-box-group" style="margin-top:2rem;">Contents <span>' + rows.length + '</span></h3>' +
    '<div style="overflow-x:auto;"><table class="ln-table ln-box-contents"><thead><tr><th>Position</th>' +
    cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (row) {
      return '<tr><td class="ln-nowrap"><strong>' + esc(row.pos) + '</strong></td>' + cols.map(function (c) { return '<td>' + esc(row.v.item[c.f] || '\u2014') + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
}
function exportBoxCSV(key) {
  var b = findBox(key);
  if (!b) return;
  var rows = boxContentRows(b), cols = boxContentCols(b);
  if (!rows.length) { alert('This box is empty, so there is nothing to export.'); return; }
  var lines = [['Box', 'Layout', 'Position'].concat(cols.map(function (c) { return c.label; }))].concat(rows.map(function (row) {
    return [b.name, (b.def && b.def.layout) || BOX_DEFAULT_LAYOUT, row.pos].concat(cols.map(function (c) { return String(row.v.item[c.f] == null ? '' : row.v.item[c.f]); }));
  }));
  var csv = lines.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  var url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }));
  var a = document.createElement('a');
  a.href = url; a.download = 'elias-lab-box-' + b.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 0);
}

function selectBoxCell(key) { boxSelected = boxSelected === key ? null : key; renderBoxes(); }
// The panel beside the map: what is in the selected position, or how to fill it.
function boxCellPanel(b) {
  if (!boxSelected) return '<div class="ln-bm-panel muted">Click a position to see what is in it, or to add a vial there.</div>';
  var rc = boxSelected.split(','), pos = String.fromCharCode(65 + +rc[0]) + (+rc[1] + 1);
  var vs = b.cells[boxSelected];
  if (!vs) {
    return '<div class="ln-bm-panel"><div class="ln-bm-panel-pos">' + pos + ' · empty</div><div class="ln-bm-panel-add">Add here:' +
      (b.cat ? [b.cat] : BOX_CATS).map(function (c) { return '<button type="button" class="ln-icon-btn" data-key="' + esc(b.key) + '" onclick="addVialAt(\'' + c + '\',this.dataset.key,\'' + pos + '\')">+ ' + INV_LABELS[c].one + '</button>'; }).join('') +
      '</div></div>';
  }
  return '<div class="ln-bm-panel"><div class="ln-bm-panel-pos">' + pos + (vs.length > 1 ? ' · <span class="warn">' + vs.length + ' vials share this position</span>' : '') + '</div>' +
    vs.map(function (v) {
      var cfg = INV_CONFIG[v.cat];
      var rows = cfg.fields.map(function (f, i) {
        var val = v.item[f];
        if (!val || f === 'box' || f === 'position' || val === vialLabel(v.cat, v.item)) return '';
        if (f === 'mapLink' && /^https?:\/\//i.test(val)) return '<div><span>' + cfg.cols[i] + '</span><a href="' + esc(val) + '" target="_blank" rel="noopener" class="ln-map-link">Map ↗</a></div>';
        return '<div><span>' + cfg.cols[i] + '</span>' + esc(val) + '</div>';
      }).join('');
      return '<div class="ln-bm-vial"><span class="ln-vchip ' + v.cat + '">' + INV_LABELS[v.cat].one + '</span>' +
        '<div class="ln-bm-vial-name">' + esc(vialLabel(v.cat, v.item)) + '</div><div class="ln-bm-fields">' + rows + '</div>' +
        '<button type="button" class="ln-icon-btn" onclick="editVial(\'' + v.cat + '\',\'' + v.item.id + '\')">✎ Edit</button></div>';
    }).join('') + '</div>';
}
function editVial(cat, id) { currentInvTab = cat; openInventoryModal(id); }

/* Another vial from the same freeze: everything carried over except where it
   sits, which is the one thing that differs and the one thing to fill in. */
function copyInvItem(id) {
  var src = (getInventory()[currentInvTab] || []).filter(function (x) { return x.id === id; })[0];
  if (!src) return;
  var prefill = {};
  INV_CONFIG[currentInvTab].fields.forEach(function (f) {
    if (f === 'position' || f === 'addedBy') return;
    if (src[f]) prefill[f] = src[f];
  });
  openInventoryModal(null, prefill);
  var pos = document.getElementById('m-position');
  if (pos) pos.focus();
}
function addVialAt(cat, key, pos) {
  var b = findBox(key);
  if (!b) return;
  currentInvTab = cat;
  var prefill = { box: b.name, position: pos };
  if (b.where) prefill[cat === 'cells' ? 'tank' : 'freezer'] = b.where;
  openInventoryModal(null, prefill);
}

/* Set up or edit a box. The type is fixed once vials are in it, since they
   decide it. Renaming offers to move its vials, which find it by name. */
var editingBox = null;
function openBoxModal(key) {
  var b = key ? findBox(key) : null;
  editingBox = b;
  var def = (b && b.def) || {};
  var layout = def.layout || BOX_DEFAULT_LAYOUT;
  var typeLocked = !!(b && b.vials.length);
  var cat = (b && b.cat) || 'stocks';
  document.getElementById('ln-modal-content').innerHTML = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + (b && b.def ? 'Edit Box' : 'Set Up Box') + '</h3>' +
    '<div class="ln-form-grid"><div class="ln-form-row"><label>Box Name</label><input id="m-boxname" value="' + esc(b ? b.name : '') + '" placeholder="e.g. Box 1"></div>' +
    '<div class="ln-form-row"><label>Holds</label><select id="m-boxcat"' + (typeLocked ? ' disabled' : '') + '>' +
      BOX_CATS.map(function (c) { return '<option value="' + c + '"' + (c === cat ? ' selected' : '') + '>' + INV_LABELS[c].many.replace(/^./, function (x) { return x.toUpperCase(); }) + '</option>'; }).join('') +
    '</select></div></div>' +
    '<div class="hint" style="margin:-.4rem 0 .9rem;font-size:12px;color:#7a877f;">' + (typeLocked ? 'The type is set by the vials already in this box. ' : '') +
      'Vials of this type are placed here when their Box field matches the name. Boxes of different types can share a name.</div>' +
    '<div class="ln-form-grid"><div class="ln-form-row"><label>Layout</label><select id="m-boxlayout">' +
      Object.keys(BOX_LAYOUTS).map(function (k) { var d = BOX_LAYOUTS[k]; return '<option value="' + k + '"' + (k === layout ? ' selected' : '') + '>' + d.rows + ' × ' + d.cols + ' (' + d.rows * d.cols + ' positions)</option>'; }).join('') +
    '</select></div><div class="ln-form-row"><label>Freezer / Tank</label><input id="m-boxfreezer" value="' + esc(def.freezer || (b ? b.where : '')) + '" placeholder="e.g. -80°C Freezer A, or LN2 Tank 1"></div></div>' +
    '<div class="ln-form-row"><label>Notes</label><textarea id="m-boxnotes" placeholder="e.g. Lentiviral plasmids only">' + esc(def.notes || '') + '</textarea></div>' +
    '<div class="ln-modal-actions">' + (b && b.def ? '<button class="ln-modal-cancel" style="margin-right:auto;color:#8f2a2a;" onclick="deleteBox()">Delete box</button>' : '') +
    '<button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="saveBox()">Save box</button></div>';
  document.getElementById('ln-modal-bg').classList.add('open');
}
async function saveBox() {
  var name = g('m-boxname');
  if (!name) { alert('Please give the box a name.'); return; }
  var b = editingBox;
  var cat = b && b.vials.length ? b.cat : g('m-boxcat');
  var key = boxKey(cat, name);
  var clash = boxIndex().filter(function (x) { return x.key === key && x.def && x.def.cat && (!b || x.key !== b.key); })[0];
  if (clash) { alert('A ' + boxTypeOne(cat) + ' box called “' + clash.name + '” is already set up.'); return; }
  // An older set-up shared by several types: give this type its own copy.
  var base = b && b.def ? (b.sharedDef ? Object.assign({}, b.def, { id: undefined }) : b.def) : {};
  var def = Object.assign({}, base, { name: name, cat: cat, layout: g('m-boxlayout'), freezer: g('m-boxfreezer'), notes: g('m-boxnotes') });
  if (!def.id) delete def.id;
  if (!def.addedBy) def.addedBy = currentUser() ? currentUser().name : 'Unknown';
  // Fewer positions than before: say which vials would no longer fit.
  if (b && b.vials.length) {
    var lost = b.vials.filter(function (v) { return parsePosition(v.item.position, b.dims) && !parsePosition(v.item.position, boxDims(def)); });
    if (lost.length && !confirm(lost.length + ' vial(s) sit outside a ' + def.layout.replace('x', '×') + ' grid and will be listed as without a usable position. Continue?')) return;
  }
  var renamed = b && b.vials.length && key !== b.key;
  if (renamed && !confirm('Move the ' + b.vials.length + ' vial(s) in “' + b.name + '” to the new name “' + name + '” as well?')) return;
  try {
    await DB.upsertInventory('boxes', def);
    if (renamed) for (var i = 0; i < b.vials.length; i++) {
      await DB.upsertInventory(b.vials[i].cat, Object.assign({}, b.vials[i].item, { box: name }));
    }
  } catch (e) { alert('Could not save the box: ' + e.message); return; }
  closeModal();
  if (boxView) boxView = key;
  renderBoxes();
}
async function deleteBox() {
  var b = editingBox;
  if (!b || !b.def) return;
  var msg = 'Delete the box set-up for “' + b.name + '”?' +
    (b.vials.length ? ' Its ' + b.vials.length + ' vial(s) are not deleted and keep their Box name, so the box still appears with its layout unset.' : '') +
    (b.sharedDef ? ' This set-up is also used by the other boxes named “' + b.name + '”, which lose their layout too.' : '');
  if (!confirm(msg)) return;
  await DB.removeInventory('boxes', b.def.id);
  closeModal();
  if (!b.vials.length) boxView = null;
  renderBoxes();
}

// ── INVENTORY BULK UPLOAD ──────────────────────────────────
/* One spreadsheet covers every table category: the template has a sheet per
   category, headed with the same column names as the tables and the CSV
   export, so an exported CSV can be uploaded back as well. Primers live in
   the Primer Generator app, so they are not part of it. */
var BULK_CATS = ['enzymes', 'plasmids', 'stocks', 'cells', 'kits'];
var BULK_SHEETS = { enzymes: 'Restriction Enzymes', plasmids: 'Plasmids', stocks: 'Glycerol Stocks', cells: 'Tissue Culture', kits: 'Kits & Reagents' };
var BULK_DATE_FIELDS = { expiry: true };
// A column whose value must not repeat within a category: rows reusing one are skipped.
var BULK_UNIQUE = { stocks: 'serial' };
var BULK_EXAMPLES = {
  enzymes: { name: 'EcoRI', supplier: 'NEB', catalog: 'R0101S', cutsite: 'G↓AATTC', conc: '20,000 U/mL', qty: '3 vials', storage: '-20°C Box 2A' },
  plasmids: { name: 'pUC19-HK022', backbone: 'pUC19', insert: 'HK022 integrase CDS', resistance: 'AmpR', freezer: 'Freezer A', box: 'Plasmid Box 1', position: 'A3 (or 1-81)', location: 'Any other location detail' },
  stocks: { serial: 'GS-0001 (must be unique)', description: 'pUC19-HK022 attB, clone 3', resistance: 'AmpR', qc: 'Sequenced with M13F + M13R, correct', hostStrain: STOCK_STRAINS.join(', ') + ' or other', freezer: 'Freezer A', shelf: 'R2_S3', shelfPlace: 'Left, front', box: 'Box G1', position: 'A3', owner: 'Blank = your name', mapLink: 'https://benchling.com/...', notes: 'Any extra information' },
  cells: { name: 'HEK293T', passage: 'P12', source: 'ATCC CRL-3216', tank: 'LN2 Tank 1', rack: 'Rack 3', box: 'Box B', position: 'A4' },
  kits: { name: 'QIAprep Spin Miniprep Kit', supplier: 'QIAGEN', catalog: '27104', qty: '250 preps', expiry: '2027-01-31', storage: 'Room temp, Kit Shelf B' }
};
// Other header spellings people are likely to type, keyed by field.
var BULK_ALIASES = {
  qty: ['quantity', 'quantityremaining'], expiry: ['expirydate', 'expires'],
  cutsite: ['recognitionsite', 'recognitioncutsite'], conc: ['concentration'],
  resistance: ['antibioticresistance'], location: ['boxlocation', 'storagelocation'], passage: ['passagenumber'],
  tank: ['ln2tank', 'liquidnitrogentank'], storage: ['storagelocation'],
  serial: ['serialnumber', 'serialno', 'serial', 'stocknumber', 'stockno'], description: ['desc'],
  qc: ['sequenced', 'sequencing', 'sequencingqc', 'qcprimers', 'sequencedwith'], hostStrain: ['strain', 'ecolistrain', 'bacterialstrain'],
  freezer: ['freezer', 'freezername', 'freezer80c', 'freezer80'], shelf: ['rack', 'rackshelf', 'shelf'],
  shelfPlace: ['positionondrawer', 'drawerposition', 'drawer', 'placeofshelf', 'placeonshelf', 'shelfplace', 'shelfposition'],
  owner: ['madeby'], mapLink: ['map', 'maplink', 'plasmidmap', 'link', 'mapurl']
};

// SheetJS 0.20.3 reads .xlsx/.csv uploads. Served from this site (vendor/)
// rather than a CDN, which some networks and blockers stop, and pinned to a
// patched version (0.18.x on cdnjs has known file-parsing vulnerabilities).
// Loaded only when the bulk upload dialog opens.
var XLSX_SRC = 'vendor/xlsx.full.min.js';
var XLSX_SRI = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';
// The template is a plain file so downloading it needs no script: generated
// documents are blocked by some browsers (in-app browsers, some Safari
// setups). Rebuild it after changing INV_CONFIG: node scripts/build-inventory-template.js
var BULK_TEMPLATE_URL = 'assets/elias-lab-inventory-template.xlsx';
var xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) xlsxLoading = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = XLSX_SRC; s.integrity = XLSX_SRI;
    s.onload = function () { resolve(window.XLSX); };
    s.onerror = function () { xlsxLoading = null; reject(new Error('Could not load the spreadsheet reader. Check your internet connection and try again.')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

// Template columns: everything in the table except "Added by", which is filled
// in automatically. The first column (name / strain) is the required one.
function bulkColumns(cat) {
  var cfg = INV_CONFIG[cat];
  return cfg.fields.map(function (f, i) { return { field: f, label: cfg.cols[i] }; })
    .filter(function (c) { return c.field !== 'addedBy' && c.field !== 'len'; }); // len comes from the sequence
}
function bulkKey(s) { return String(s == null ? '' : s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function bulkPad(n) { return (n < 10 ? '0' : '') + n; }

/* The template workbook. Only used by scripts/build-inventory-template.js to
   write BULK_TEMPLATE_URL, so the template always matches INV_CONFIG. */
function buildInventoryTemplate(XLSX) {
  var wb = XLSX.utils.book_new();
  var help = [
    ['Elias Lab inventory — bulk upload template'], [],
    ['1. Fill in the sheet for each category you want to add to. Leave the others empty.'],
    ['2. One item per row, starting under the header row. Keep the headers as they are.'],
    ['3. Write dates as YYYY-MM-DD (e.g. 2026-03-05) or as Excel dates.'],
    ['4. In the Lab Notebook, open any inventory page, click "Bulk upload" and choose this file.'],
    ['Rows missing the required (first) column are skipped, and so are rows identical to an item already in the inventory.'],
    ['Glycerol stock serial numbers must be unique: a row reusing a serial that is already taken (in the inventory or earlier in the file) is skipped.'],
    ['Primers are not included: add them in the Primer Generator.'], [],
    ['Sheet', 'Column', 'Required', 'Example']
  ];
  BULK_CATS.forEach(function (cat) {
    bulkColumns(cat).forEach(function (c, i) { help.push([BULK_SHEETS[cat], c.label, i === 0 ? 'yes' : '', BULK_EXAMPLES[cat][c.field] || '']); });
  });
  var hs = XLSX.utils.aoa_to_sheet(help);
  hs['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 10 }, { wch: 34 }];
  XLSX.utils.book_append_sheet(wb, hs, 'Instructions');
  BULK_CATS.forEach(function (cat) {
    var cols = bulkColumns(cat);
    var ws = XLSX.utils.aoa_to_sheet([cols.map(function (c) { return c.label; })]);
    ws['!cols'] = cols.map(function (c) { return { wch: Math.max(16, c.label.length + 4) }; });
    XLSX.utils.book_append_sheet(wb, ws, BULK_SHEETS[cat]);
  });
  return wb;
}

/* Map a header row to fields of one category. Returns {cols: {index: field},
   score} or null when the category's required column is missing. */
function bulkMapHeader(cat, header) {
  var cfg = INV_CONFIG[cat], lookup = {};
  cfg.fields.forEach(function (f, i) {
    lookup[bulkKey(cfg.cols[i])] = f; lookup[bulkKey(f)] = f;
    (BULK_ALIASES[f] || []).forEach(function (a) { if (!lookup[a]) lookup[a] = f; });
  });
  var cols = {}, used = {}, score = 0;
  header.forEach(function (h, i) {
    var f = lookup[bulkKey(h)];
    if (f && !used[f]) { cols[i] = f; used[f] = true; score++; }
  });
  return used[cfg.fields[0]] ? { cols: cols, score: score } : null;
}
// Pick the category for a sheet: its name if it is one of ours, otherwise
// the category whose columns best match the header row.
function bulkPickCategory(sheetName, header) {
  var named = BULK_CATS.filter(function (c) { return bulkKey(sheetName) === bulkKey(BULK_SHEETS[c]) || bulkKey(sheetName) === c; })[0];
  if (named) { var m = bulkMapHeader(named, header); if (m) return { cat: named, cols: m.cols }; }
  var best = null, tie = false;
  BULK_CATS.forEach(function (c) {
    var m = bulkMapHeader(c, header);
    if (!m || m.score < 2) return;
    if (!best || m.score > best.score) { best = { cat: c, cols: m.cols, score: m.score }; tie = false; }
    else if (m.score === best.score) tie = true;
  });
  return best && !tie ? best : null;
}
function bulkCell(XLSX, v, field) {
  if (v == null) return '';
  if (typeof v === 'number' && BULK_DATE_FIELDS[field]) {
    var d = XLSX.SSF.parse_date_code(v);
    if (d && d.y) return d.y + '-' + bulkPad(d.m) + '-' + bulkPad(d.d);
  }
  var s = String(v).trim();
  if (/^'[=+\-@]/.test(s)) s = s.slice(1); // undo the CSV export's formula guard
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (BULK_DATE_FIELDS[field] && iso) s = iso[1] + '-' + bulkPad(+iso[2]) + '-' + bulkPad(+iso[3]);
  return s;
}
function bulkSignature(cat, item) {
  return bulkColumns(cat).map(function (c) { return String(item[c.field] || '').trim().toLowerCase(); }).join('\u0001');
}

/* Read a workbook or CSV into a plan: per category, the new items plus what
   was skipped and why. Nothing is saved here. */
function buildBulkPlan(XLSX, wb) {
  var user = currentUser(), me = user ? user.name : 'Unknown';
  var plan = { cats: {}, ignored: [], total: 0 };
  wb.SheetNames.forEach(function (sheetName) {
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
    var h = 0;
    while (h < rows.length && !rows[h].some(function (v) { return String(v).trim() !== ''; })) h++;
    if (h >= rows.length) return; // empty sheet
    var pick = bulkPickCategory(sheetName, rows[h]);
    if (!pick) { if (bulkKey(sheetName) !== 'instructions') plan.ignored.push(sheetName); return; }
    var cat = pick.cat, nameField = INV_CONFIG[cat].fields[0];
    var p = plan.cats[cat] || (plan.cats[cat] = { items: [], noName: [], dupes: 0, badDates: [], taken: [] });
    var seen = {}, uniq = BULK_UNIQUE[cat], used = {};
    (getInventory()[cat] || []).concat(p.items).forEach(function (it) {
      seen[bulkSignature(cat, it)] = true;
      if (uniq && it[uniq]) used[bulkKey(it[uniq])] = true;
    });
    for (var r = h + 1; r < rows.length; r++) {
      var item = {}, any = false;
      Object.keys(pick.cols).forEach(function (i) {
        var f = pick.cols[i], v = bulkCell(XLSX, rows[r][i], f);
        if (v !== '') { item[f] = v; any = true; }
      });
      if (!any) continue;
      var rowNo = sheetName + ' row ' + (r + 1);
      if (!item[nameField]) { p.noName.push(rowNo); continue; }
      Object.keys(BULK_DATE_FIELDS).forEach(function (f) {
        if (item[f] && !/^\d{4}-\d{2}-\d{2}$/.test(item[f])) p.badDates.push(rowNo + ' (' + item[f] + ')');
      });
      var sig = bulkSignature(cat, item);
      if (seen[sig]) { p.dupes++; continue; }
      if (uniq && used[bulkKey(item[uniq])]) { p.taken.push(rowNo + ' (' + item[uniq] + ')'); continue; }
      seen[sig] = true;
      if (uniq) used[bulkKey(item[uniq])] = true;
      if (!item.addedBy) item.addedBy = me;
      if (cat === 'stocks' && !item.owner) item.owner = me;
      p.items.push(item); plan.total++;
    }
  });
  return plan;
}

var bulkPlan = null;
function openBulkUploadModal() {
  bulkPlan = null;
  document.getElementById('ln-modal-content').innerHTML =
    '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Bulk upload inventory</h3>' +
    '<p class="ln-bulk-intro">Add many items at once, to any inventory category. The template has one sheet per category; a CSV exported from an inventory page works too.</p>' +
    '<div class="ln-bulk-step"><span class="ln-bulk-num">1</span><div><strong>Download the template</strong>' +
      '<div class="hint">Sheets for Restriction Enzymes, Plasmids, Glycerol Stocks, Tissue Culture and Kits &amp; Reagents, with an example for every column. Primers are added in the Primer Generator.</div>' +
      '<a class="ln-add-btn ghost ln-add-link" href="' + BULK_TEMPLATE_URL + '" download>↓ Download template (.xlsx)</a></div></div>' +
    '<div class="ln-bulk-step"><span class="ln-bulk-num">2</span><div><strong>Upload the filled-in file</strong>' +
      '<div class="hint">Excel (.xlsx) or CSV. You will see what will be added before anything is saved.</div>' +
      '<input type="file" id="m-bulk-file" accept=".xlsx,.xls,.csv" onchange="previewBulkUpload(this)"></div></div>' +
    '<div id="ln-bulk-preview"></div>' +
    '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" id="ln-bulk-save" disabled onclick="saveBulkUpload()">Add items</button></div>';
  document.getElementById('ln-modal-bg').classList.add('open');
  loadXlsx().catch(function () { /* reported when a file is chosen */ }); // warm up while they pick a file
}

async function previewBulkUpload(input) {
  var out = document.getElementById('ln-bulk-preview'), btn = document.getElementById('ln-bulk-save');
  bulkPlan = null; btn.disabled = true; btn.textContent = 'Add items';
  var file = input.files && input.files[0];
  if (!file) { out.innerHTML = ''; return; }
  out.innerHTML = '<div class="ln-bulk-note">Reading ' + esc(file.name) + '…</div>';
  try {
    var XLSX = await loadXlsx();
    var isCsv = /\.csv$/i.test(file.name);
    // CSV as text so UTF-8 (°C, ↓, ₂) survives; raw keeps catalog numbers like 0123 as typed.
    var wb = isCsv ? XLSX.read(await file.text(), { type: 'string', raw: true })
                   : XLSX.read(await file.arrayBuffer(), { type: 'array' });
    bulkPlan = buildBulkPlan(XLSX, wb);
  } catch (e) {
    out.innerHTML = '<div class="ln-bulk-note error">Could not read this file: ' + esc(e.message) + '</div>';
    return;
  }
  // Untouched template sheets have no rows at all, so leave them out.
  var parts = BULK_CATS.filter(function (c) {
    var p = bulkPlan.cats[c];
    return p && (p.items.length || p.dupes || p.noName.length || p.taken.length);
  }).map(function (cat) {
    var p = bulkPlan.cats[cat], notes = [];
    if (p.dupes) notes.push(p.dupes + ' already in the inventory, skipped');
    if (p.noName.length) notes.push(p.noName.length + ' missing \u201c' + esc(INV_CONFIG[cat].cols[0]) + '\u201d, skipped (' + esc(p.noName.slice(0, 5).join(', ')) + (p.noName.length > 5 ? '…' : '') + ')');
    if (p.taken.length) notes.push(p.taken.length + ' reuse a ' + esc(INV_CONFIG[cat].cols[0]) + ' that is already taken, skipped: ' + esc(p.taken.slice(0, 5).join(', ')) + (p.taken.length > 5 ? '…' : ''));
    if (p.badDates.length) notes.push('dates not in YYYY-MM-DD, kept as written: ' + esc(p.badDates.slice(0, 5).join(', ')) + (p.badDates.length > 5 ? '…' : ''));
    return '<li><strong>' + esc(BULK_SHEETS[cat]) + '</strong> — ' + p.items.length + ' new' +
      (notes.length ? '<div class="ln-bulk-sub">' + notes.join('<br>') + '</div>' : '') + '</li>';
  });
  if (bulkPlan.ignored.length) parts.push('<li class="muted">Not recognised as an inventory category, ignored: ' + esc(bulkPlan.ignored.join(', ')) + '</li>');
  if (!parts.length) parts.push('<li class="muted">No inventory rows found. Check that the header row matches the template.</li>');
  out.innerHTML = '<ul class="ln-bulk-list">' + parts.join('') + '</ul>';
  if (bulkPlan.total) { btn.disabled = false; btn.textContent = 'Add ' + bulkPlan.total + ' item' + (bulkPlan.total === 1 ? '' : 's'); }
}

async function saveBulkUpload() {
  if (!bulkPlan || !bulkPlan.total) return;
  var btn = document.getElementById('ln-bulk-save'), out = document.getElementById('ln-bulk-preview');
  btn.disabled = true; btn.textContent = 'Adding…';
  var done = [], error = null;
  for (var i = 0; i < BULK_CATS.length && !error; i++) {
    var cat = BULK_CATS[i], p = bulkPlan.cats[cat];
    if (!p || !p.items.length) continue;
    try {
      var n = await DB.addInventoryMany(cat, p.items);
      done.push(n + ' ' + (n === 1 ? INV_LABELS[cat].one.toLowerCase() : INV_LABELS[cat].many));
    }
    catch (e) { error = INV_LABELS[cat].many + ': ' + e.message; }
  }
  bulkPlan = null;
  if (lnCurrentSection.indexOf('inv-') === 0) renderInventory();
  out.innerHTML = (done.length ? '<div class="ln-bulk-note ok">Added ' + esc(done.join(', ')) + '.</div>' : '') +
    (error ? '<div class="ln-bulk-note error">Stopped on ' + esc(error) + '</div>' : '');
  btn.textContent = 'Done'; btn.disabled = false; btn.onclick = closeModal;
  document.getElementById('m-bulk-file').value = '';
}

// ── ADMIN ──────────────────────────────────────────────────
function renderAdmin() {
  if (!DB.isAdmin()) return;
  // mode-aware controls
  var addBtn = document.getElementById('ln-adduser-btn');
  if (addBtn) addBtn.style.display = DB.mode === 'local' ? 'inline-block' : 'none';
  var importBtn = document.getElementById('ln-import-btn');
  if (importBtn) importBtn.style.display = DB.mode === 'supabase' ? 'inline-block' : 'none';

  var users = getUsers();
  var adminEmail = (window.ELIAS_CONFIG && ELIAS_CONFIG.ADMIN_EMAIL ? ELIAS_CONFIG.ADMIN_EMAIL : 'amere@braude.ac.il').toLowerCase();
  document.getElementById('ln-users-tbody').innerHTML = users.map(function (u) {
    var actions = (u.email !== adminEmail) ?
      ((u.status === 'pending' ? '<button class="ln-icon-btn" onclick="approveUser(\'' + u.id + '\')">✔ Approve</button>' : '') +
        (DB.mode === 'local' ? '<button class="ln-icon-btn" onclick="resetUserPw(\'' + u.id + '\')">🔑 Reset PW</button>' : '') +
        '<button class="ln-icon-btn danger" onclick="deleteUser(\'' + u.id + '\')">✕ Remove</button>')
      : '<span style="color:#aaa;font-size:12px;">PI Account</span>';
    return '<tr><td><strong>' + esc(u.name) + '</strong></td><td>' + esc(u.email) + '</td>' +
      '<td><span class="ln-badge ' + (u.role === 'admin' ? 'orange' : 'blue') + '">' + esc(u.role) + '</span></td>' +
      '<td><span class="' + (u.status === 'approved' ? 'ln-approved-badge' : 'ln-pending-badge') + '">' + esc(u.status) + '</span></td>' +
      '<td>' + esc(u.added || '—') + '</td><td style="display:flex;gap:.4rem;flex-wrap:wrap;">' + actions + '</td></tr>';
  }).join('');
}
async function approveUser(id) { await DB.setUserStatus(id, 'approved'); renderAdmin(); }
async function deleteUser(id) { if (!confirm('Remove this user?')) return; await DB.removeUser(id); renderAdmin(); }
async function resetUserPw(id) { var pw = prompt('Enter new password for this user:'); if (!pw) return; var r = await DB.resetUserPw(id, pw); alert(r.ok ? 'Password updated.' : r.error); }
async function runImport() {
  if (!confirm('Push this browser\'s local notebook data into the shared database?')) return;
  try { var msg = await DB.importLocalData(); await DB.loadAll(); alert(msg); lnShow('dashboard'); }
  catch (e) { alert('Import failed: ' + e.message); }
}

// ── MODALS ─────────────────────────────────────────────────
function closeModal() { document.getElementById('ln-modal-bg').classList.remove('open'); }

function userSelect(fieldId, selectedName) {
  var names = getApprovedUserNames();
  return '<select id="' + fieldId + '" style="width:100%;padding:.65rem .9rem;border:1.5px solid #ddd;border-radius:8px;font-size:14px;outline:none;">' +
    names.map(function (n) { return '<option ' + (n === selectedName ? 'selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
    '<option ' + (!selectedName || names.indexOf(selectedName) < 0 ? 'selected' : '') + ' value="">-- Enter manually --</option></select>' +
    '<input id="' + fieldId + '-manual" placeholder="Or type name manually..." style="width:100%;margin-top:.3rem;padding:.5rem .9rem;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;display:' + (names.length ? 'none' : 'block') + '" value="' + (selectedName || '') + '">';
}
function getSelectOrManual(fieldId) {
  var sel = document.getElementById(fieldId); var manual = document.getElementById(fieldId + '-manual');
  if (sel && sel.value && sel.value !== '') return sel.value;
  return manual ? manual.value : '';
}

function openModal(type, editId) {
  var bg = document.getElementById('ln-modal-bg'), mc = document.getElementById('ln-modal-content');
  var user = currentUser(), today = new Date().toISOString().split('T')[0];
  var existing = null;
  if (editId) {
    if (type === 'protocol') existing = getProtocols().find(function (p) { return p.id === editId; });
    else if (type === 'presentation') existing = getPresentations().find(function (p) { return p.id === editId; });
  }
  var ex = existing || {}, html = '';
  if (type === 'protocol') {
    html = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + (editId ? 'Edit' : 'New') + ' Protocol</h3>' +
      '<div class="ln-form-row"><label>Title</label><input id="m-title" value="' + esc(ex.title || '') + '" placeholder="e.g. HK022 Integrase Purification"></div>' +
      '<div class="ln-form-row"><label>Category</label><select id="m-category">' + ['Molecular Cloning', 'Protein Purification', 'Cell Culture', 'PCR & Sequencing', 'Flow Cytometry', 'NGS', 'Western Blot', 'Gene Editing', 'Other'].map(function (c) { return '<option ' + (c === (ex.category || '') ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></div>' +
      '<div class="ln-form-row"><label>Author</label>' + userSelect('m-author-sel', ex.author || (user ? user.name : '')) + '</div>' +
      '<div class="ln-form-row"><label>Date</label><input type="date" id="m-date" value="' + esc(ex.date || today) + '"></div>' +
      '<div class="ln-form-row"><label>External Protocol Link (URL, optional)</label><input id="m-link" type="url" value="' + esc(ex.link || '') + '" placeholder="https://www.protocols.io/..."></div>' +
      '<div class="ln-form-row"><label>Summary</label><textarea id="m-summary" placeholder="Brief description...">' + esc(ex.summary || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Materials &amp; Reagents</label><textarea id="m-materials" placeholder="List all required materials...">' + esc(ex.materials || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Protocol Steps</label><textarea id="m-steps" style="min-height:130px;" placeholder="1. Step one&#10;2. Step two...">' + esc(ex.steps || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Notes &amp; Troubleshooting</label><textarea id="m-notes" placeholder="Tips, issues, variations...">' + esc(ex.notes || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Upload Files (images, PDFs)</label><input type="file" id="m-files" multiple accept="image/*,.pdf,.doc,.docx,.xlsx"><div class="hint">Existing files are preserved when editing.</div></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="saveProtocol(\'' + (editId || '') + '\')">Save Protocol</button></div>';
  } else if (type === 'presentation') {
    html = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + (editId ? 'Edit' : 'Add') + ' Presentation</h3>' +
      '<div class="ln-form-row"><label>Title</label><input id="m-title" value="' + esc(ex.title || '') + '" placeholder="Presentation title"></div>' +
      '<div class="ln-form-row"><label>Presenter</label>' + userSelect('m-presenter-sel', ex.presenter || (user ? user.name : '')) + '</div>' +
      '<div class="ln-form-row"><label>Date</label><input type="date" id="m-date" value="' + esc(ex.date || today) + '"></div>' +
      '<div class="ln-form-row"><label>Venue / Event</label><input id="m-venue" value="' + esc(ex.venue || '') + '" placeholder="e.g. Lab Meeting, ASGCT Annual Meeting"></div>' +
      '<div class="ln-form-row"><label>Link (Google Slides, PDF URL)</label><input id="m-link" type="url" value="' + esc(ex.link || '') + '" placeholder="https://..."></div>' +
      '<div class="ln-form-row"><label>Upload Presentation File (PDF, PPTX)</label><input type="file" id="m-files" multiple accept=".pdf,.pptx,.ppt,image/*"><div class="hint">Existing files are preserved when editing.</div></div>' +
      '<div class="ln-form-row"><label>Notes</label><textarea id="m-notes" placeholder="Summary or key takeaways...">' + esc(ex.notes || '') + '</textarea></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="savePresentation(\'' + (editId || '') + '\')">Save</button></div>';
  } else if (type === 'adduser') {
    html = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Add Lab Member</h3>' +
      '<div class="ln-form-row"><label>Full Name</label><input id="m-name" placeholder="e.g. Dr. Sarah Cohen"></div>' +
      '<div class="ln-form-row"><label>Email</label><input id="m-email" type="email" placeholder="member@university.edu"></div>' +
      '<div class="ln-form-row"><label>Temporary Password</label><input id="m-pw" type="password" placeholder="They can change this later"></div>' +
      '<div class="ln-form-row"><label>Role</label><select id="m-role"><option value="member">Lab Member</option><option value="admin">Admin</option></select></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="saveNewUser()">Add &amp; Approve</button></div>';
  }
  mc.innerHTML = html; bg.classList.add('open');
}

// ── SAVE FUNCTIONS ─────────────────────────────────────────
async function saveProtocol(editId) {
  var title = (document.getElementById('m-title').value || '').trim();
  if (!title) { alert('Please enter a title.'); return; }
  var author = getSelectOrManual('m-author-sel');
  var newFiles = await collectFiles('m-files'); if (newFiles === null) return;
  var ex = editId ? (getProtocols().find(function (p) { return p.id === editId; }) || {}) : {};
  var obj = { id: editId || undefined, title: title, category: g('m-category'), author: author, date: g('m-date'), link: g('m-link'), summary: g('m-summary'), materials: g('m-materials'), steps: g('m-steps'), notes: g('m-notes'), files: (ex.files || []).concat(newFiles) };
  await DB.upsert('protocols', obj); closeModal(); renderProtocols(); renderDashboard();
}
async function savePresentation(editId) {
  var title = (document.getElementById('m-title').value || '').trim();
  if (!title) { alert('Please enter a title.'); return; }
  var presenter = getSelectOrManual('m-presenter-sel');
  var newFiles = await collectFiles('m-files'); if (newFiles === null) return;
  var ex = editId ? (getPresentations().find(function (p) { return p.id === editId; }) || {}) : {};
  var obj = { id: editId || undefined, title: title, presenter: presenter, date: g('m-date'), venue: g('m-venue'), link: g('m-link'), notes: g('m-notes'), files: (ex.files || []).concat(newFiles) };
  await DB.upsert('presentations', obj); closeModal(); renderPresentations();
}
async function saveNewUser() {
  var name = g('m-name'), email = g('m-email'), pw = g('m-pw'), role = g('m-role');
  if (!name || !email || !pw) { alert('Please fill in all fields.'); return; }
  var r = await DB.addUser({ name: name, email: email, pw: pw, role: role });
  if (!r.ok) { alert(r.error); return; }
  closeModal(); renderAdmin();
}

/* Suggest the next glycerol stock serial: the highest existing number plus
   one, keeping its prefix and zero padding (GS-0041 -> GS-0042). */
function nextStockSerial() {
  var best = null;
  getInventory().stocks.forEach(function (x) {
    var m = /^(.*?)(\d+)$/.exec(String(x.serial || '').trim());
    if (m && (!best || +m[2] > best.n)) best = { prefix: m[1], n: +m[2], width: m[2].length };
  });
  if (!best) return '';
  var next = String(best.n + 1);
  while (next.length < best.width) next = '0' + next;
  return best.prefix + next;
}

/* Called with no argument to add, or with an item id to edit it. `prefill`
   sets fields on a new item, e.g. the box and position clicked on a box map. */
var editingInvItem = null;
function openInventoryModal(id, prefill) {
  // Plasmids have a page of their own: maps, sequence and the molecular tools.
  if (currentInvTab === 'plasmids') { if (id) openPlasmid(id); else newPlasmid(); return; }
  editingInvItem = id ? (getInventory()[currentInvTab] || []).filter(function (x) { return x.id === id; })[0] || null : null;
  var bg = document.getElementById('ln-modal-bg'), mc = document.getElementById('ln-modal-content');
  var user = currentUser(), today = new Date().toISOString().split('T')[0];
  var forms = {
    enzymes: '<div class="ln-form-row"><label>Enzyme Name</label><input id="m-name" placeholder="e.g. EcoRI"></div><div class="ln-form-row"><label>Supplier</label><input id="m-supplier" placeholder="e.g. NEB"></div><div class="ln-form-row"><label>Catalog #</label><input id="m-catalog"></div><div class="ln-form-row"><label>Recognition / Cut Site</label><input id="m-cutsite" placeholder="e.g. G↓AATTC"></div><div class="ln-form-row"><label>Concentration</label><input id="m-conc" placeholder="e.g. 20,000 U/mL"></div><div class="ln-form-row"><label>Quantity</label><input id="m-qty" placeholder="e.g. 3 vials"></div><div class="ln-form-row"><label>Storage Location</label><input id="m-storage" placeholder="e.g. -20°C Box 2A"></div>',
    primers: '<div class="ln-form-row"><label>Primer Name</label><input id="m-name" placeholder="e.g. HK022_attB_F"></div><div class="ln-form-row"><label>Sequence (5\'→3\')</label><input id="m-sequence" placeholder="ATCGATCG..."></div><div class="ln-form-row"><label>Tm (°C)</label><input id="m-tm" type="number" placeholder="60"></div><div class="ln-form-row"><label>Application</label><input id="m-application" placeholder="e.g. Genotyping HK022 locus"></div><div class="ln-form-row"><label>Storage</label><input id="m-storage" placeholder="e.g. -20°C Primers Box A"></div>',
    cells: '<div class="ln-note-tip">Before banking: look up the <strong>cells per vial</strong> and the <strong>banking medium</strong> recommended for this line — both differ by cell line, and a vial frozen at the wrong density or in the wrong medium usually does not come back.</div>' +
      '<div class="ln-form-row"><label>Cell Line</label><input id="m-name" placeholder="e.g. HEK293T"></div>' +
      '<div class="ln-form-row"><label>Passage Number</label><input id="m-passage" placeholder="e.g. P12"></div>' +
      '<div class="ln-form-row"><label>Cells per vial</label><input id="m-amount" placeholder="e.g. 1×10⁶ in 1 mL"></div>' +
      '<div class="ln-form-row"><label>Source</label><input id="m-source" placeholder="e.g. ATCC CRL-3216, or a collaborator"></div>' +
      '<div class="ln-form-row"><label>Growth medium</label><input id="m-growthMedia" placeholder="e.g. DMEM + 10% FBS + 1% P/S"></div>' +
      '<div class="ln-form-row"><label>Banking medium</label><input id="m-bankMedia" placeholder="e.g. 90% FBS + 10% DMSO"></div>' +
      '<div class="ln-form-row"><label>Liquid N₂ Tank</label><input id="m-tank" placeholder="e.g. LN2 Tank 1"></div>' +
      '<div class="ln-form-row"><label>Rack</label><input id="m-rack" placeholder="e.g. Rack 3"></div>' +
      '<div class="ln-form-row"><label>Box</label><input id="m-box" list="ln-box-list" placeholder="e.g. Box B"></div>' +
      '<div class="ln-form-row"><label>Position</label><input id="m-position" placeholder="e.g. A4"></div>' +
      '<div class="ln-form-row"><label>Notes</label><textarea id="m-notes" rows="2" placeholder="Anything the next person should know before thawing this vial"></textarea></div>',
    kits: '<div class="ln-form-row"><label>Kit Name</label><input id="m-name" placeholder="e.g. QIAprep Spin Miniprep Kit"></div><div class="ln-form-row"><label>Supplier</label><input id="m-supplier" placeholder="e.g. QIAGEN"></div><div class="ln-form-row"><label>Catalog #</label><input id="m-catalog"></div><div class="ln-form-row"><label>Quantity Remaining</label><input id="m-qty" placeholder="e.g. 250 preps"></div><div class="ln-form-row"><label>Expiry Date</label><input type="date" id="m-expiry"></div><div class="ln-form-row"><label>Storage</label><input id="m-storage" placeholder="e.g. Room temp, Kit Shelf B"></div>'
  };
  var tabLabel = INV_LABELS[currentInvTab].one;
  var editing = !!editingInvItem;
  var credit = editing ? (editingInvItem.addedBy || editingInvItem.owner || '') : (user ? user.name : '');
  mc.innerHTML = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + (editing ? 'Edit ' : 'Add ') + tabLabel + '</h3>' + forms[currentInvTab] +
    '<datalist id="ln-box-list">' + boxIndex().filter(function (b) { return !b.cat || b.cat === currentInvTab; }).map(function (b) { return '<option value="' + esc(b.name) + '">'; }).join('') + '</datalist>' +
    '<div style="margin-top:.75rem;font-size:12px;color:#888;">' + (editing ? 'Originally added by' : 'Added by') + ': <strong>' + esc(credit) + '</strong></div>' +
    '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="saveInvItem()">' + (editing ? 'Save changes' : 'Add to Inventory') + '</button></div>';
  // Pre-fill from the item being edited; fields without an input are skipped.
  if (editing) {
    INV_CONFIG[currentInvTab].fields.forEach(function (f) {
      var input = document.getElementById('m-' + f);
      if (input && editingInvItem[f] != null) input.value = editingInvItem[f];
    });
  } else if (currentInvTab === 'stocks') {
    document.getElementById('m-serial').value = nextStockSerial();
    document.getElementById('m-owner').value = user ? user.name : '';
  }
  if (!editing && prefill) Object.keys(prefill).forEach(function (f) {
    var input = document.getElementById('m-' + f);
    if (input && prefill[f]) input.value = prefill[f];
  });
  bg.classList.add('open');
}
async function saveInvItem() {
  var user = currentUser(), addedBy = user ? user.name : 'Unknown', today = new Date().toISOString().split('T')[0], tab = currentInvTab;
  // Editing keeps the item's id and who originally added it.
  var item = editingInvItem ? Object.assign({}, editingInvItem) : { id: uid(), addedBy: addedBy };
  if (tab === 'enzymes') Object.assign(item, { name: g('m-name'), supplier: g('m-supplier'), catalog: g('m-catalog'), cutsite: g('m-cutsite'), conc: g('m-conc'), qty: g('m-qty'), storage: g('m-storage') });
  else if (tab === 'primers') Object.assign(item, { name: g('m-name'), sequence: g('m-sequence'), tm: g('m-tm'), application: g('m-application'), storage: g('m-storage') });
  else if (tab === 'stocks') {
    INV_CONFIG.stocks.fields.forEach(function (f) { item[f] = g('m-' + f); });
    if (!item.serial) { alert('Please fill in the serial number.'); return; }
    var clash = getInventory().stocks.filter(function (x) { return x.id !== item.id && bulkKey(x.serial) === bulkKey(item.serial); })[0];
    if (clash) { alert('Serial number ' + item.serial + ' is already used by another glycerol stock' + (clash.description ? ' (' + clash.description + ')' : '') + '.'); return; }
  }
  else if (tab === 'cells') {
    Object.assign(item, { name: g('m-name'), passage: g('m-passage'), amount: g('m-amount'),
      source: g('m-source'), growthMedia: g('m-growthMedia'), bankMedia: g('m-bankMedia'),
      tank: g('m-tank'), rack: g('m-rack'), box: g('m-box'), position: g('m-position'), notes: g('m-notes') });
    // One vial per position. Filing a second vial where one already sits is
    // how a tank ends up disagreeing with its own records, and it used to be
    // allowed silently.
    var sitting = slotTakenBy('cells', item);
    if (sitting) {
      alert('Position ' + item.position + ' in box ' + (item.box || '—') +
        ' already holds ' + (sitting.name || 'a vial') +
        (sitting.passage ? ' (' + sitting.passage + ')' : '') +
        '.\n\nUse a free position, or edit that vial if this is the same one.');
      return;
    }
  }
  else if (tab === 'kits') Object.assign(item, { name: g('m-name'), supplier: g('m-supplier'), catalog: g('m-catalog'), qty: g('m-qty'), expiry: g('m-expiry'), storage: g('m-storage') });
  if (tab !== 'stocks' && !item.name) { alert('Please fill in the item name.'); return; }
  await DB.upsertInventory(tab, item); editingInvItem = null; closeModal(); renderInventory(tab);
  if (lnCurrentSection === 'boxes') renderBoxes();
}

// ── BOOT ───────────────────────────────────────────────────
document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'ln-modal-bg') closeModal();
});
document.addEventListener('DOMContentLoaded', async function () {
  lnAuthMode('signin');
  try {
    var user = await DB.init();
    if (user && user.status === 'approved') lnShowApp(user);
    else showLoginScreen();
  } catch (e) { console.error(e); showLoginScreen(); }
});
