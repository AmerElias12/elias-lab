/* ===========================================================================
   Elias Lab ELN — frontend

   Vanilla ES2020, no build step, matching the rest of this repository. Three
   rules it keeps to:

     1. Nothing is written to the DOM with innerHTML. Entry titles and names
        come from other people in the lab, and textContent cannot be talked
        into running a script.

     2. The server is the authority on what is visible. This file never
        decides whether a record may be shown; it renders what the API
        returned, and the API returns what the policies allowed.

     3. Every fetch goes through api(), so a 401 has exactly one meaning and
        one handler.

   The access token is kept in localStorage. That is a real trade-off: any
   cross-site scripting on this origin can read it, where an httpOnly cookie
   could not. A cookie would need CSRF protection on every write instead, and
   rule 1 above is what keeps the XSS side closed.
   ======================================================================== */
'use strict';

const TOKEN_KEY = 'eln.token';
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  me: null,
  view: 'dashboard',
  entry: null,          // the entry open in the editor, or null for a new one
  page: { limit: 25, offset: 0, total: 0 },
  query: '',
  onlyMine: false,
};

/* --- plumbing ----------------------------------------------------------- */

const token = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};

class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = token.get();
  if (auth && t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth) {
    signOut({ silent: true });
    throw new ApiError(401, 'your session has expired — sign in again');
  }
  if (res.status === 204) return null;

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, detailOf(data) || res.statusText);
  return data;
}

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

function detailOf(data) {
  if (!data || typeof data !== 'object') return null;
  const d = data.detail;
  if (typeof d === 'string') return d;
  // FastAPI validation errors arrive as a list of per-field objects.
  if (Array.isArray(d) && d.length) {
    const first = d[0];
    const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : '';
    return field ? `${field}: ${first.msg}` : first.msg;
  }
  return null;
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3000);
}

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const initials = (name) => (name || '?')
  .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/* --- views -------------------------------------------------------------- */

function show(view) {
  state.view = view;
  $$('.view').forEach((el) => el.classList.toggle('is-active', el.dataset.view === view));
  $$('.nav__item').forEach((el) => el.classList.toggle('is-active', el.dataset.view === view));
  $('#nav-toggle').checked = false;
}

function showAuth(message) {
  $('#shell').hidden = true;
  $('#auth').hidden = false;
  const err = $('#auth-error');
  if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
}

function signOut({ silent = false } = {}) {
  token.clear();
  state.me = null;
  showAuth(silent ? null : 'Signed out.');
}

/* --- bootstrap ---------------------------------------------------------- */

async function start() {
  if (!token.get()) { showAuth(); return; }
  try {
    await loadMe();
  } catch (err) {
    if (err.status === 401) return;         // signOut already ran
    showAuth(err.message);
  }
}

async function loadMe() {
  const me = await api('/api/auth/me');
  state.me = me;

  $('#auth').hidden = true;
  $('#shell').hidden = false;

  $('#who-name').textContent = me.user.full_name;
  $('#who-avatar').textContent = initials(me.user.full_name);
  $('#who-role').textContent = me.current_role || 'no lab';

  const select = $('#lab-select');
  select.textContent = '';
  for (const lab of me.labs) {
    const opt = document.createElement('option');
    opt.value = lab.lab_id;
    opt.textContent = lab.name;
    opt.selected = lab.lab_id === me.current_lab_id;
    select.append(opt);
  }
  select.disabled = me.labs.length < 2;

  // An account with no lab can see nothing at all — that is the approval
  // step, not a bug, so it gets its own view rather than an empty dashboard.
  const hasLab = Boolean(me.current_lab_id);
  $$('.nav__item').forEach((el) => {
    if (['dashboard', 'notebook', 'lab', 'plasmids'].includes(el.dataset.view)) el.disabled = !hasLab;
  });
  $('#new-entry').disabled = !hasLab;
  $('#search').disabled = !hasLab;

  if (!hasLab) { show('nolab'); return; }
  show('dashboard');
  await loadDashboard();
}

/* --- dashboard ---------------------------------------------------------- */

async function loadDashboard() {
  const d = await api('/api/dashboard');
  const lab = state.me.labs.find((l) => l.lab_id === state.me.current_lab_id);
  $('#dash-lede').textContent =
    `${lab ? lab.name : 'This lab'} — what you can see as ${state.me.current_role}.`;

  const cards = [
    ['Entries visible', d.entries],
    ['Mine', d.my_entries],
    ['My drafts', d.drafts],
    ['Plasmids', d.plasmids],
    ['Primers', d.primers],
    ['Guides', d.guides],
    ['Lab members', d.members],
  ];
  const wrap = $('#dash-cards');
  wrap.textContent = '';
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    const v = document.createElement('div');
    v.className = 'card__value';
    v.textContent = String(value);
    const l = document.createElement('div');
    l.className = 'card__label';
    l.textContent = label;
    card.append(v, l);
    wrap.append(card);
  }

  const recent = $('#dash-recent');
  recent.textContent = '';
  if (!d.recent.length) {
    recent.append(emptyRow('Nothing yet. Create your first entry.'));
  } else {
    for (const r of d.recent) {
      recent.append(entryRow({ id: r.id, title: r.title, updated_at: r.updated_at }, true));
    }
  }
}

/* --- notebook list ------------------------------------------------------ */

function emptyRow(text) {
  const li = document.createElement('li');
  const div = document.createElement('div');
  div.className = 'row';
  div.style.cursor = 'default';
  div.textContent = text;
  li.append(div);
  return li;
}

function entryRow(entry, terse = false) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'row';
  btn.type = 'button';

  const main = document.createElement('div');
  main.className = 'row__main';
  const title = document.createElement('div');
  title.className = 'row__title';
  title.textContent = entry.title || 'Untitled';
  main.append(title);

  if (!terse) {
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    const author = entry.author_id === state.me.user.id ? 'you' : 'a colleague';
    sub.textContent = `${author} · performed ${fmtDate(entry.performed_on)} · updated ${fmtDate(entry.updated_at)}`;
    main.append(sub);
  }

  const meta = document.createElement('div');
  meta.className = 'row__meta';
  if (!terse) {
    if (!entry.is_shared) {
      const b = document.createElement('span');
      b.className = 'badge badge--private';
      b.textContent = 'private';
      meta.append(b);
    }
    const st = document.createElement('span');
    st.className = 'badge';
    st.textContent = entry.status;
    meta.append(st);
  }

  btn.append(main, meta);
  btn.addEventListener('click', () => openEntry(entry.id));
  li.append(btn);
  return li;
}

async function loadEntries() {
  const params = new URLSearchParams({
    limit: String(state.page.limit),
    offset: String(state.page.offset),
  });
  if (state.query) params.set('q', state.query);
  if (state.onlyMine) params.set('mine', 'true');

  const page = await api(`/api/entries?${params}`);
  state.page.total = page.total;

  const list = $('#entry-list');
  list.textContent = '';
  if (!page.items.length) {
    list.append(emptyRow(state.query ? `Nothing matches “${state.query}”.` : 'No entries yet.'));
  } else {
    for (const e of page.items) list.append(entryRow(e));
  }

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);
  $('#page-info').textContent = `${from}–${to} of ${page.total}`;
  $('#prev-page').disabled = page.offset === 0;
  $('#next-page').disabled = to >= page.total;

  $('#notebook-lede').textContent = state.onlyMine
    ? 'Entries you authored.'
    : 'Your entries, plus the ones your lab shares.';
}

/* --- entry editor ------------------------------------------------------- */

const FIELDS = ['title', 'hypothesis', 'methods', 'body_text', 'results', 'conclusions', 'next_steps'];

function fillForm(entry) {
  const form = $('#entry-form');
  for (const name of FIELDS) form.elements[name].value = entry?.[name] ?? '';
  form.elements.performed_on.value = entry?.performed_on ?? '';
  form.elements.is_shared.checked = entry ? entry.is_shared : true;
  form.elements.change_note.value = '';

  $('#entry-version').textContent = entry ? `version ${entry.current_version}` : 'new';
  $('#delete-entry').hidden = !entry;

  const mine = !entry || entry.author_id === state.me.user.id;
  const canEdit = mine || ['owner', 'admin'].includes(state.me.current_role);
  $('#entry-author').textContent = entry && !mine ? 'written by a colleague' : '';

  // Read-only when it is someone else's: the API would refuse the write with
  // 403 anyway, so showing an editable form would be a lie.
  for (const el of form.elements) el.disabled = !canEdit;
  $('#save-entry').disabled = !canEdit;
  $('#delete-entry').disabled = !canEdit;
}

async function openEntry(id) {
  try {
    const entry = await api(`/api/entries/${id}`);
    state.entry = entry;
    fillForm(entry);
    show('entry');
    await loadVersions(id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function newEntry() {
  state.entry = null;
  fillForm(null);
  $('#version-list').textContent = '';
  show('entry');
  $('#entry-form').elements.title.focus();
}

async function loadVersions(id) {
  const versions = await api(`/api/entries/${id}/versions`);
  const list = $('#version-list');
  list.textContent = '';
  for (const v of versions) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    main.className = 'row__main';
    const t = document.createElement('div');
    t.className = 'row__title';
    t.textContent = `Version ${v.version_no}`;
    const s = document.createElement('div');
    s.className = 'row__sub';
    s.textContent = v.change_note
      ? `${v.change_note} · ${fmtDate(v.created_at)}`
      : fmtDate(v.created_at);
    main.append(t, s);
    row.append(main);
    li.append(row);
    list.append(li);
  }
}

function formPayload() {
  const form = $('#entry-form');
  const payload = {};
  for (const name of FIELDS) {
    const value = form.elements[name].value.trim();
    payload[name] = value === '' ? null : value;
  }
  payload.title = form.elements.title.value.trim();
  payload.performed_on = form.elements.performed_on.value || null;
  payload.is_shared = form.elements.is_shared.checked;
  // body_text is NOT NULL in the database; the rest are nullable.
  payload.body_text = form.elements.body_text.value;
  const note = form.elements.change_note.value.trim();
  return { payload, note };
}

async function saveEntry() {
  const { payload, note } = formPayload();
  if (!payload.title) { toast('Give the entry a title.', 'error'); return; }

  const btn = $('#save-entry');
  btn.disabled = true;
  try {
    if (state.entry) {
      const body = { ...payload };
      if (note) body.change_note = note;
      state.entry = await api(`/api/entries/${state.entry.id}`, { method: 'PATCH', body });
      toast(`Saved as version ${state.entry.current_version}.`);
    } else {
      state.entry = await api('/api/entries', { method: 'POST', body: payload });
      toast('Entry created.');
    }
    fillForm(state.entry);
    await loadVersions(state.entry.id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function deleteEntry() {
  if (!state.entry) return;
  if (!confirm(`Delete “${state.entry.title}”?\n\nIt is removed from the notebook but kept in the lab's history and audit trail.`)) return;
  try {
    await api(`/api/entries/${state.entry.id}`, { method: 'DELETE' });
    toast('Entry deleted.');
    state.entry = null;
    show('notebook');
    await loadEntries();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* --- lab members -------------------------------------------------------- */

const ROLE_LABEL = {
  owner: 'Owner', admin: 'Admin', member: 'Member', read_only: 'Read only',
};

async function loadMembers() {
  const isAdmin = ['owner', 'admin'].includes(state.me.current_role);
  $('#add-member-form').hidden = !isAdmin;
  $('#lab-lede').textContent = isAdmin
    ? 'You manage this lab. Members write their own records and read what the lab shares.'
    : 'Who you share this notebook with.';

  const members = await api('/api/lab/members');
  const list = $('#member-list');
  list.textContent = '';

  for (const m of members) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';

    const avatar = document.createElement('span');
    avatar.className = 'who__avatar';
    avatar.textContent = initials(m.full_name);

    const main = document.createElement('div');
    main.className = 'row__main';
    const name = document.createElement('div');
    name.className = 'row__title';
    name.textContent = m.full_name + (m.user_id === state.me.user.id ? ' (you)' : '');
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    sub.textContent = m.email;
    main.append(name, sub);

    const meta = document.createElement('div');
    meta.className = 'row__meta';

    const isSelf = m.user_id === state.me.user.id;
    if (isAdmin && !isSelf && m.role !== 'owner') {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Role for ${m.full_name}`);
      for (const r of ['admin', 'member', 'read_only']) {
        const o = document.createElement('option');
        o.value = r;
        o.textContent = ROLE_LABEL[r];
        o.selected = r === m.role;
        sel.append(o);
      }
      sel.addEventListener('change', async () => {
        try {
          await api(`/api/lab/members/${m.user_id}`, { method: 'PATCH', body: { role: sel.value } });
          toast(`${m.full_name} is now ${ROLE_LABEL[sel.value].toLowerCase()}.`);
        } catch (err) { toast(err.message, 'error'); await loadMembers(); }
      });

      const remove = document.createElement('button');
      remove.className = 'btn btn--danger';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.full_name} from the lab?\n\nTheir entries and plasmids stay.`)) return;
        try {
          await api(`/api/lab/members/${m.user_id}`, { method: 'DELETE' });
          toast(`${m.full_name} removed.`);
          await loadMembers();
        } catch (err) { toast(err.message, 'error'); }
      });

      meta.append(sel, remove);
    } else {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = ROLE_LABEL[m.role] || m.role;
      meta.append(badge);
    }

    row.append(avatar, main, meta);
    li.append(row);
    list.append(li);
  }
}

/* --- plasmids and the vector viewer ------------------------------------- */

let vector = null;          // the controller from VectorViewer.createViewer
let currentPlasmid = null;

/* A real plasmid, so the page has something to show before the lab has put
   anything in. pUC19's backbone features at their usual coordinates. */
const EXAMPLE_PLASMID = {
  name: 'pUC19 (example)',
  topology: 'circular',
  external_source: 'example payload, not saved',
  sequence: (
    'TCGCGCGTTTCGGTGATGACGGTGAAAACCTCTGACACATGCAGCTCCCGGAGACGGTCACAGCTTGTCTGTAAGCGGATGCCGGGAGCAGACAAGCCCGTCAGGGCGCGTCAGCGGGTGTTGGCGGGTGTCGGGGCTGGCTTAACTATGCGGCATCAGAGCAGATTGTACTGAGAGTGCACCATATGCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGGCGCCATTCGCCATTCAGGCTGCGCAACTGTTGGGAAGGGCGATCGGTGCGGGCCTCTTCGCTATTACGCCAGCTGGCGAAAGGGGGATGTGCTGCAAGGCGATTAAGTTGGGTAACGCCAGGGTTTTCCCAGTCACGACGTTGTAAAACGACGGCCAGTGAATTCGAGCTCGGTACCCGGGGATCCTCTAGAGTCGACCTGCAGGCATGCAAGCTTGGCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTGGCGTTACCCAACTTAATCGCCTTGCAGCACATCCCCCTTTCGCCAGCTGGCGTAATAGCGAAGAGGCCCGCACCGATCGCCCTTCCCAACAGTTGCGCAGCCTGAATGGCGAATGGCGCCTGATGCGGTATTTTCTCCTTACGCATCTGTGCGGTATTTCACACCGCATATGGTGCACTCTCAGTACAATCTGCTCTGATGCCGCATAGTTAAGCCAGCCCCGACACCCGCCAACACCCGCTGACGCGCCCTGACGGGCTTGTCTGCTCCCGGCATCCGCTTACAGACAAGCTGTGACCGTCTCCGGGAGCTGCATGTGTCAGAGGTTTTCACCGTCATCACCGAAACGCGCGA'
  ).repeat(1),
  features: [
    { name: 'lac promoter',  type_key: 'promoter',   start_pos: 356, end_pos: 387, strand: -1 },
    { name: 'lacZ-alpha',    type_key: 'CDS',        start_pos: 387, end_pos: 460, strand: -1 },
    { name: 'MCS',           type_key: 'misc_feature', start_pos: 396, end_pos: 454, strand: 1 },
    { name: 'AmpR promoter', type_key: 'promoter',   start_pos: 700, end_pos: 760, strand: 1 },
    { name: 'ori',           type_key: 'rep_origin', start_pos: 120, end_pos: 300, strand: 1 },
    { name: 'M13 fwd primer', type_key: 'primer_bind', start_pos: 340, end_pos: 356, strand: 1 },
  ],
};

function renderFacts(d) {
  const facts = $('#vector-facts');
  facts.textContent = '';
  const rows = d.length
    ? [
        ['Coordinates', d.crossesOrigin
          ? `${d.startDisplay}–${d.endDisplay} (wraps)`
          : `${d.startDisplay}–${d.endDisplay}`],
        ['Length', `${d.length} bp`],
        ['GC', `${d.gc}%`],
        ['On', d.kind === 'feature' ? (d.featureName || 'a feature') : 'the sequence'],
      ]
    : [['Coordinates', '—'], ['Length', '—'], ['GC', '—'], ['On', '—']];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  }
}

function showPlasmid(payload) {
  currentPlasmid = payload;
  const target = $('#vector-canvas');

  $('#vector-name').textContent = payload.name || 'Unnamed';
  const seq = payload.sequence || payload.seq || '';
  $('#vector-size').textContent = `${seq.replace(/[\s\d]/g, '').length} bp`;

  const options = {
    output: $('#vector-bases'),          // the sidebar textbox
    log: true,                            // and the console, as asked
    onSelect: renderFacts,
  };

  try {
    if (vector) {
      vector.destroy();
      vector = null;
    }
    vector = VectorViewer.createViewer(target, payload, options);
  } catch (err) {
    target.textContent = '';
    toast(err.message, 'error');
    return;
  }

  const warnings = vector.getWarnings();
  const box = $('#vector-warnings');
  if (warnings.length) {
    box.textContent = `${warnings.length} feature(s) not drawn — ${warnings.join('; ')}`;
    box.hidden = false;
  } else {
    box.hidden = true;
  }

  // A linear construct has no circular view to offer.
  const circular = (payload.topology || 'circular') !== 'linear';
  $$('[data-mapview]').forEach((b) => {
    b.disabled = !circular && b.dataset.mapview !== 'linear';
    b.classList.toggle('is-active',
      b.dataset.mapview === (circular ? 'both' : 'linear'));
  });

  renderFacts(VectorViewer.describeSelection(seq, null));
  $('#vector-bases').value = '';
}

async function loadPlasmids() {
  const page = await api('/api/plasmids?limit=50');
  const list = $('#plasmid-list');
  list.textContent = '';

  if (!page.items.length) {
    list.append(emptyRow('No plasmids yet. Add one, or load the example.'));
    return;
  }
  for (const p of page.items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'row';
    btn.type = 'button';
    const main = document.createElement('div');
    main.className = 'row__main';
    const t = document.createElement('div');
    t.className = 'row__title';
    t.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    sub.textContent = `${p.length_bp} bp · ${p.topology}`;
    main.append(t, sub);
    btn.append(main);
    btn.addEventListener('click', async () => {
      try {
        showPlasmid(await api(`/api/plasmids/${p.id}`));
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    li.append(btn);
    list.append(li);
  }
}

$$('[data-mapview]').forEach((btn) => btn.addEventListener('click', () => {
  if (!vector) return;
  if (!vector.setView(btn.dataset.mapview)) return;
  $$('[data-mapview]').forEach((b) => b.classList.toggle('is-active', b === btn));
}));

$('#plasmid-demo').addEventListener('click', () => showPlasmid(EXAMPLE_PLASMID));

$('#vector-copy').addEventListener('click', async () => {
  const bases = vector && vector.getSelection().bases;
  if (!bases) { toast('Nothing selected yet.', 'error'); return; }
  try {
    await navigator.clipboard.writeText(bases);
    toast(`${bases.length} bp copied.`);
  } catch {
    // Clipboard access can be refused; selecting the text is the fallback
    // that always works.
    $('#vector-bases').select();
    toast('Press the copy shortcut to copy the selected text.');
  }
});

$('#plasmid-new').addEventListener('click', () => {
  $('#plasmid-form').reset();
  show('plasmid-new');
});
$('#plasmid-back').addEventListener('click', () => show('plasmids'));

$('#plasmid-save').addEventListener('click', async () => {
  const f = $('#plasmid-form').elements;
  if (!f.name.value.trim() || !f.sequence.value.trim()) {
    toast('A name and a sequence are needed.', 'error');
    return;
  }
  try {
    const created = await api('/api/plasmids', {
      method: 'POST',
      body: {
        name: f.name.value.trim(),
        sequence: f.sequence.value,
        topology: f.topology.value,
        external_source: f.external_source.value.trim() || 'pasted',
      },
    });
    toast(`${created.name} saved.`);
    show('plasmids');
    await loadPlasmids();
    showPlasmid(created);
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* --- events ------------------------------------------------------------- */

$$('[data-authtab]').forEach((tab) => tab.addEventListener('click', () => {
  const which = tab.dataset.authtab;
  $$('[data-authtab]').forEach((t) => {
    const on = t === tab;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#login-form').hidden = which !== 'login';
  $('#register-form').hidden = which !== 'register';
  $('#auth-error').hidden = true;
}));

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const res = await api('/api/auth/login', {
      method: 'POST', auth: false,
      body: { email: f.email.value, password: f.password.value },
    });
    token.set(res.access_token);
    await loadMe();
  } catch (err) {
    showAuth(err.message);
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/api/auth/register', {
      method: 'POST', auth: false,
      body: { email: f.email.value, full_name: f.full_name.value, password: f.password.value },
    });
    const res = await api('/api/auth/login', {
      method: 'POST', auth: false,
      body: { email: f.email.value, password: f.password.value },
    });
    token.set(res.access_token);
    await loadMe();
  } catch (err) {
    showAuth(err.message);
  }
});

$('#create-lab-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const lab = await api('/api/auth/labs', {
      method: 'POST',
      body: { name: f.name.value, slug: f.slug.value },
    });
    // The lab lives in the token, so working in it needs a new one.
    const res = await api('/api/auth/switch-lab', { method: 'POST', body: { lab_id: lab.id } });
    token.set(res.access_token);
    toast(`Created ${lab.name}.`);
    await loadMe();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#lab-select').addEventListener('change', async (e) => {
  try {
    const res = await api('/api/auth/switch-lab', {
      method: 'POST', body: { lab_id: e.target.value },
    });
    token.set(res.access_token);
    state.page.offset = 0;
    await loadMe();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$$('.nav__item').forEach((item) => item.addEventListener('click', async () => {
  const view = item.dataset.view;
  show(view);
  try {
    if (view === 'dashboard') await loadDashboard();
    if (view === 'notebook') await loadEntries();
    if (view === 'lab') await loadMembers();
    if (view === 'plasmids') await loadPlasmids();
  } catch (err) {
    toast(err.message, 'error');
  }
}));

$('#add-member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const m = await api('/api/lab/members', {
      method: 'POST', body: { email: f.email.value, role: f.role.value },
    });
    toast(`${m.full_name} added to the lab.`);
    e.target.reset();
    await loadMembers();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#sign-out').addEventListener('click', () => signOut());
$('#new-entry').addEventListener('click', newEntry);
$('#save-entry').addEventListener('click', saveEntry);
$('#delete-entry').addEventListener('click', deleteEntry);
$('#print-entry').addEventListener('click', () => window.print());
$('#back-to-list').addEventListener('click', async () => {
  show('notebook');
  try { await loadEntries(); } catch (err) { toast(err.message, 'error'); }
});

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.query = $('#search').value.trim();
  state.page.offset = 0;
  show('notebook');
  try { await loadEntries(); } catch (err) { toast(err.message, 'error'); }
});

$('#only-mine').addEventListener('change', async (e) => {
  state.onlyMine = e.target.checked;
  state.page.offset = 0;
  try { await loadEntries(); } catch (err) { toast(err.message, 'error'); }
});

$('#prev-page').addEventListener('click', async () => {
  state.page.offset = Math.max(0, state.page.offset - state.page.limit);
  await loadEntries();
});
$('#next-page').addEventListener('click', async () => {
  state.page.offset += state.page.limit;
  await loadEntries();
});

// Ctrl/Cmd+S saves while the editor is open, which is what anyone writing in a
// textarea for twenty minutes will reach for.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.view === 'entry') {
    e.preventDefault();
    saveEntry();
  }
});

start();
