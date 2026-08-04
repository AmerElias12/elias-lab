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
  lnShow('dashboard');
}

// ── NAVIGATION ─────────────────────────────────────────────
function lnShow(section) {
  document.querySelectorAll('.ln-section').forEach(function (s) { s.classList.remove('active'); });
  document.querySelectorAll('.ln-nav-item').forEach(function (n) { n.classList.remove('active'); });
  var sec = document.getElementById('ln-' + section); if (sec) sec.classList.add('active');
  document.querySelectorAll('.ln-nav-item').forEach(function (n) { var oc = n.getAttribute('onclick'); if (oc && oc.indexOf("'" + section + "'") >= 0) n.classList.add('active'); });
  if (section === 'dashboard') renderDashboard();
  else if (section === 'protocols') renderProtocols();
  else if (section === 'notebooks') renderNotebooks();
  else if (section === 'presentations') renderPresentations();
  else if (section === 'webapps') renderWebapps();
  else if (section === 'inventory') renderInventory(currentInvTab);
  else if (section === 'admin') { renderAdmin(); refreshAdmin(); }
}
// pull fresh user list (catches new sign-ups), then re-render
async function refreshAdmin() {
  if (!DB.isAdmin()) return;
  try { await DB.refreshUsers(); renderAdmin(); } catch (e) { /* keep cached view */ }
}

// ── DASHBOARD ──────────────────────────────────────────────
function renderDashboard() {
  var inv = getInventory();
  var invTotal = Object.keys(inv).reduce(function (a, k) { return a + (inv[k] || []).length; }, 0);
  document.getElementById('ln-stats-grid').innerHTML =
    [{ num: getProtocols().length, label: 'Protocols' }, { num: getNotebooks().filter(function (n) { return !n.archived; }).length, label: 'Active Experiments' }, { num: getPresentations().length, label: 'Presentations' }, { num: invTotal, label: 'Inventory Items' }]
      .map(function (s) { return '<div class="ln-stat-card"><div class="ln-stat-num">' + s.num + '</div><div class="ln-stat-label">' + s.label + '</div></div>'; }).join('');
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
      '<div class="ln-card-meta">👤 ' + esc(n.researcher) + ' · 📅 ' + esc(n.date) + '</div></div>' +
      '<div class="ln-card-actions"><button class="ln-icon-btn" onclick="viewNotebook(\'' + n.id + '\')">View</button>' +
      '<button class="ln-icon-btn" onclick="openModal(\'notebook\',\'' + n.id + '\')">Edit</button>' +
      (isAdmin ? '<button class="ln-icon-btn" onclick="archiveNotebook(\'' + n.id + '\')">' + (n.archived ? 'Restore' : 'Archive') + '</button>' : '') +
      (isAdmin ? '<button class="ln-icon-btn danger" onclick="deleteNotebook(\'' + n.id + '\')">✕ Delete</button>' : '') +
      '</div></div><div style="font-size:13px;color:#555;">' + (n.hypothesis ? '<strong>Hypothesis:</strong> ' + esc(n.hypothesis).slice(0, 120) + (n.hypothesis.length > 120 ? '…' : '') : '') + '</div>' +
      renderAttachments(n.files) + '</div>';
  }).join('');
}
async function deleteNotebook(id) { if (!DB.isAdmin()) { alert('Only the PI can delete experiments.'); return; } if (confirm('Permanently delete this experiment entry?')) { await DB.remove('notebooks', id); renderNotebooks(); renderDashboard(); } }
async function archiveNotebook(id) { if (!DB.isAdmin()) { alert('Only the PI can archive experiments.'); return; } var n = getNotebooks().find(function (x) { return x.id === id; }); if (n) { n.archived = !n.archived; await DB.upsert('notebooks', n); renderNotebooks(); } }

function viewNotebook(id) {
  var n = getNotebooks().find(function (x) { return x.id === id; }); if (!n) return;
  var tablesHtml = n.tables && n.tables.length ? n.tables.map(function (t, i) { return '<h4 style="margin:.75rem 0 .5rem;">Table ' + (i + 1) + (t.label ? ' – ' + esc(t.label) : '') + '</h4><div style="overflow-x:auto;"><table class="ln-table">' + t.html + '</table></div>'; }).join('') : '';
  var mc = document.getElementById('ln-modal-content');
  mc.innerHTML = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + esc(n.title) + '</h3>' +
    '<div style="font-size:12px;color:#888;margin-bottom:1.5rem;">👤 ' + esc(n.researcher) + ' · 📅 ' + esc(n.date) + '</div>' +
    (n.hypothesis ? '<h4>Hypothesis</h4><p style="color:#555;margin:.5rem 0 1rem;line-height:1.7;">' + esc(n.hypothesis) + '</p>' : '') +
    (n.methods ? '<h4>Materials &amp; Methods</h4><pre style="white-space:pre-wrap;font-size:13px;color:#555;background:#f9f9f9;padding:1rem;border-radius:6px;margin:.5rem 0 1rem;">' + esc(n.methods) + '</pre>' : '') +
    (n.results ? '<h4>Results &amp; Observations</h4><pre style="white-space:pre-wrap;font-size:13px;color:#555;background:#f9f9f9;padding:1rem;border-radius:6px;margin:.5rem 0 1rem;">' + esc(n.results) + '</pre>' : '') +
    tablesHtml +
    (n.conclusions ? '<h4>Conclusions</h4><p style="color:#555;margin:.5rem 0 1rem;line-height:1.7;">' + esc(n.conclusions) + '</p>' : '') +
    (n.nextsteps ? '<h4>Next Steps</h4><p style="color:#555;margin:.5rem 0;line-height:1.7;">' + esc(n.nextsteps) + '</p>' : '') +
    renderAttachments(n.files) +
    '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Close</button></div>';
  document.getElementById('ln-modal-bg').classList.add('open');
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
      var tbl = document.getElementById('tbl-' + idx); if (tbl) tbl.innerHTML = t.html;
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
  // In-page custom tools (no external files needed) + bundled GenomeScan
  var custom = '' +
    // Full standalone apps, opened in their own tab
    appCard('tools/grna-primer-generator.html', '🧬', 'Primer Generator', 'Dual system: gRNA cloning primers (PRg) and regular primers (PR), with storage tracking, bulk CSV import and export') +
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
// A full standalone tool, opened in its own tab.
function appCard(href, icon, name, desc) {
  return '<a href="' + href + '" target="_blank" rel="noopener" class="ln-webapp-card custom">' +
    '<div class="ln-webapp-custom-label">Elias Lab Tool · full app ↗</div>' +
    '<div class="ln-webapp-icon">' + icon + '</div>' +
    '<div class="ln-webapp-name">' + name + '</div>' +
    '<div class="ln-webapp-desc">' + desc + '</div></a>';
}

// ── INVENTORY ──────────────────────────────────────────────
var currentInvTab = 'enzymes';
var INV_CONFIG = {
  enzymes: { cols: ['Name', 'Supplier', 'Catalog #', 'Cut Site', 'Conc.', 'Qty', 'Storage', 'Added by'], fields: ['name', 'supplier', 'catalog', 'cutsite', 'conc', 'qty', 'storage', 'addedBy'] },
  primers: { cols: ['Name', "Sequence (5'→3')", 'Tm (°C)', 'Application', 'Storage', 'Added by'], fields: ['name', 'sequence', 'tm', 'application', 'storage', 'addedBy'] },
  plasmids: { cols: ['Name', 'Backbone', 'Insert', 'Resistance', 'Location', 'Added by'], fields: ['name', 'backbone', 'insert', 'resistance', 'location', 'addedBy'] },
  stocks: { cols: ['Strain / Name', 'Plasmid', 'Date Prepared', 'Box', 'Made by'], fields: ['strain', 'plasmid', 'date', 'box', 'madeBy'] },
  kits: { cols: ['Kit Name', 'Supplier', 'Catalog #', 'Qty Left', 'Expiry', 'Storage', 'Added by'], fields: ['name', 'supplier', 'catalog', 'qty', 'expiry', 'storage', 'addedBy'] }
};
function lnInvTab(tab, el) {
  currentInvTab = tab;
  document.querySelectorAll('.ln-tab').forEach(function (t) { t.classList.remove('active'); });
  document.querySelectorAll('.ln-tab-content').forEach(function (t) { t.classList.remove('active'); });
  el.classList.add('active');
  var c = document.getElementById('ln-inv-' + tab); if (c) c.classList.add('active');
  renderInventory(tab);
}
function renderInventory(tab) {
  currentInvTab = tab || currentInvTab;
  var inv = getInventory();
  var cfg = INV_CONFIG[currentInvTab];
  var items = inv[currentInvTab] || [];
  var el = document.getElementById('ln-inv-' + currentInvTab);
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="ln-empty">No ' + currentInvTab + ' added yet.</div>'; return; }
  el.innerHTML = '<div style="overflow-x:auto;"><table class="ln-table"><thead><tr>' + cfg.cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '<th>Actions</th></tr></thead><tbody>' +
    items.map(function (item) { return '<tr>' + cfg.fields.map(function (f) { return '<td>' + esc(item[f] || '—') + '</td>'; }).join('') + '<td><button class="ln-icon-btn danger" onclick="deleteInvItem(\'' + currentInvTab + '\',\'' + item.id + '\')">✕</button></td></tr>'; }).join('') +
    '</tbody></table></div>';
}
async function deleteInvItem(tab, id) { if (confirm('Remove this item?')) { await DB.removeInventory(tab, id); renderInventory(tab); } }

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
    else if (type === 'notebook') existing = getNotebooks().find(function (n) { return n.id === editId; });
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
  } else if (type === 'notebook') {
    initTableEditor();
    html = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>' + (editId ? 'Edit' : 'New') + ' Experiment Entry</h3>' +
      '<div class="ln-form-row"><label>Experiment Title</label><input id="m-title" value="' + esc(ex.title || '') + '" placeholder="e.g. HK022 attB integration test in HEK293"></div>' +
      '<div class="ln-form-row"><label>Researcher</label>' + userSelect('m-researcher-sel', ex.researcher || (user ? user.name : '')) + '</div>' +
      '<div class="ln-form-row"><label>Date</label><input type="date" id="m-date" value="' + esc(ex.date || today) + '"></div>' +
      '<div class="ln-form-row"><label>Hypothesis</label><textarea id="m-hypothesis" placeholder="What are you testing and why?">' + esc(ex.hypothesis || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Materials &amp; Methods</label><textarea id="m-methods" style="min-height:100px;" placeholder="Detailed methods used...">' + esc(ex.methods || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Results &amp; Observations</label><textarea id="m-results" style="min-height:100px;" placeholder="Data, observations, gel results...">' + esc(ex.results || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Data Tables</label><div id="ln-tables-editor"></div><button class="tbl-btn" onclick="addTableToEditor()" style="margin-top:.5rem;">+ Add Table</button></div>' +
      '<div class="ln-form-row"><label>Conclusions</label><textarea id="m-conclusions" placeholder="What do the results mean?">' + esc(ex.conclusions || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Next Steps</label><textarea id="m-nextsteps" placeholder="Follow-up experiments or actions...">' + esc(ex.nextsteps || '') + '</textarea></div>' +
      '<div class="ln-form-row"><label>Upload Files (gel images, FACS plots, charts)</label><input type="file" id="m-files" multiple accept="image/*,.pdf,.fcs,.xlsx"><div class="hint">Existing attachments are preserved.</div></div>' +
      '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="saveNotebook(\'' + (editId || '') + '\')">Save Entry</button></div>';
    setTimeout(function () { if (editId && ex.tables && ex.tables.length) loadTablesIntoEditor(ex.tables); }, 100);
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
async function saveNotebook(editId) {
  var title = (document.getElementById('m-title').value || '').trim();
  if (!title) { alert('Please enter a title.'); return; }
  var researcher = getSelectOrManual('m-researcher-sel');
  var newFiles = await collectFiles('m-files'); if (newFiles === null) return;
  var tables = serializeTables();
  var ex = editId ? (getNotebooks().find(function (n) { return n.id === editId; }) || {}) : {};
  var obj = { id: editId || undefined, title: title, researcher: researcher, date: g('m-date'), hypothesis: g('m-hypothesis'), methods: g('m-methods'), results: g('m-results'), conclusions: g('m-conclusions'), nextsteps: g('m-nextsteps'), tables: tables, files: (ex.files || []).concat(newFiles), archived: ex.archived || false };
  await DB.upsert('notebooks', obj); closeModal(); renderNotebooks(); renderDashboard();
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

function openInventoryModal() {
  var bg = document.getElementById('ln-modal-bg'), mc = document.getElementById('ln-modal-content');
  var user = currentUser(), today = new Date().toISOString().split('T')[0];
  var forms = {
    enzymes: '<div class="ln-form-row"><label>Enzyme Name</label><input id="m-name" placeholder="e.g. EcoRI"></div><div class="ln-form-row"><label>Supplier</label><input id="m-supplier" placeholder="e.g. NEB"></div><div class="ln-form-row"><label>Catalog #</label><input id="m-catalog"></div><div class="ln-form-row"><label>Recognition / Cut Site</label><input id="m-cutsite" placeholder="e.g. G↓AATTC"></div><div class="ln-form-row"><label>Concentration</label><input id="m-conc" placeholder="e.g. 20,000 U/mL"></div><div class="ln-form-row"><label>Quantity</label><input id="m-qty" placeholder="e.g. 3 vials"></div><div class="ln-form-row"><label>Storage Location</label><input id="m-storage" placeholder="e.g. -20°C Box 2A"></div>',
    primers: '<div class="ln-form-row"><label>Primer Name</label><input id="m-name" placeholder="e.g. HK022_attB_F"></div><div class="ln-form-row"><label>Sequence (5\'→3\')</label><input id="m-sequence" placeholder="ATCGATCG..."></div><div class="ln-form-row"><label>Tm (°C)</label><input id="m-tm" type="number" placeholder="60"></div><div class="ln-form-row"><label>Application</label><input id="m-application" placeholder="e.g. Genotyping HK022 locus"></div><div class="ln-form-row"><label>Storage</label><input id="m-storage" placeholder="e.g. -20°C Primers Box A"></div>',
    plasmids: '<div class="ln-form-row"><label>Plasmid Name</label><input id="m-name" placeholder="e.g. pUC19-HK022"></div><div class="ln-form-row"><label>Backbone</label><input id="m-backbone" placeholder="e.g. pUC19"></div><div class="ln-form-row"><label>Insert</label><input id="m-insert" placeholder="e.g. HK022 integrase CDS"></div><div class="ln-form-row"><label>Antibiotic Resistance</label><input id="m-resistance" placeholder="e.g. AmpR, KanR"></div><div class="ln-form-row"><label>Box / Location</label><input id="m-location" placeholder="e.g. -80°C Plasmid Box 1"></div>',
    stocks: '<div class="ln-form-row"><label>Strain / Clone Name</label><input id="m-strain" placeholder="e.g. HEK293-HK022-GFP"></div><div class="ln-form-row"><label>Plasmid / Insert</label><input id="m-plasmid" placeholder="e.g. pHK022-GFP"></div><div class="ln-form-row"><label>Date Prepared</label><input type="date" id="m-date" value="' + today + '"></div><div class="ln-form-row"><label>Storage Box</label><input id="m-box" placeholder="e.g. -80°C Box G1, slot 3"></div><div class="ln-form-row"><label>Made by</label><input id="m-madeBy" value="' + esc(user ? user.name : '') + '"></div>',
    kits: '<div class="ln-form-row"><label>Kit Name</label><input id="m-name" placeholder="e.g. QIAprep Spin Miniprep Kit"></div><div class="ln-form-row"><label>Supplier</label><input id="m-supplier" placeholder="e.g. QIAGEN"></div><div class="ln-form-row"><label>Catalog #</label><input id="m-catalog"></div><div class="ln-form-row"><label>Quantity Remaining</label><input id="m-qty" placeholder="e.g. 250 preps"></div><div class="ln-form-row"><label>Expiry Date</label><input type="date" id="m-expiry"></div><div class="ln-form-row"><label>Storage</label><input id="m-storage" placeholder="e.g. Room temp, Kit Shelf B"></div>'
  };
  var tabLabel = currentInvTab.charAt(0).toUpperCase() + currentInvTab.slice(1);
  mc.innerHTML = '<button class="ln-close-btn" onclick="closeModal()">×</button><h3>Add ' + tabLabel + ' Item</h3>' + forms[currentInvTab] +
    '<div style="margin-top:.75rem;font-size:12px;color:#888;">Added by: <strong>' + esc(user ? user.name : '') + '</strong></div>' +
    '<div class="ln-modal-actions"><button class="ln-modal-cancel" onclick="closeModal()">Cancel</button><button class="ln-modal-save" onclick="saveInvItem()">Add to Inventory</button></div>';
  bg.classList.add('open');
}
async function saveInvItem() {
  var user = currentUser(), addedBy = user ? user.name : 'Unknown', today = new Date().toISOString().split('T')[0], tab = currentInvTab;
  var item = { id: uid(), addedBy: addedBy };
  if (tab === 'enzymes') Object.assign(item, { name: g('m-name'), supplier: g('m-supplier'), catalog: g('m-catalog'), cutsite: g('m-cutsite'), conc: g('m-conc'), qty: g('m-qty'), storage: g('m-storage') });
  else if (tab === 'primers') Object.assign(item, { name: g('m-name'), sequence: g('m-sequence'), tm: g('m-tm'), application: g('m-application'), storage: g('m-storage') });
  else if (tab === 'plasmids') Object.assign(item, { name: g('m-name'), backbone: g('m-backbone'), insert: g('m-insert'), resistance: g('m-resistance'), location: g('m-location') });
  else if (tab === 'stocks') Object.assign(item, { strain: g('m-strain'), plasmid: g('m-plasmid'), date: g('m-date') || today, box: g('m-box'), madeBy: g('m-madeBy') });
  else if (tab === 'kits') Object.assign(item, { name: g('m-name'), supplier: g('m-supplier'), catalog: g('m-catalog'), qty: g('m-qty'), expiry: g('m-expiry'), storage: g('m-storage') });
  if (!item.name && !item.strain) { alert('Please fill in the item name.'); return; }
  await DB.upsertInventory(tab, item); closeModal(); renderInventory(tab);
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
