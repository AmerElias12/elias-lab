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

   The access token is never stored. It lives in a variable for fifteen
   minutes and is renewed from an httpOnly refresh cookie that script cannot
   read — so an XSS on this origin can act while the page is open but cannot
   take the session away with it. The cookie is SameSite=strict and scoped to
   /api/auth, which is what stands in for a CSRF token on the two endpoints
   that act on it.
   ======================================================================== */
'use strict';

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

/* The access token lives here and nowhere else — not in localStorage, not in
   sessionStorage. It is good for fifteen minutes and is replaced from the
   refresh cookie, which is httpOnly and therefore unreadable from script. So
   an XSS on this origin can use the session while the page is open and cannot
   walk away with it, which is the whole reason the refresh flow exists.

   The cost is that a reload has no token. That is what refreshOnce() on boot
   is for, and it is why the first paint can briefly show nothing. */
let accessToken = null;

/* One refresh in flight at a time. Three requests failing with 401 together
   must not start three rotations: the second would present a token the first
   has already replaced, which is precisely the reuse the server treats as a
   theft — and it would sign the person out for being quick. */
let refreshing = null;

function refreshOnce() {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        accessToken = data ? data.access_token : null;
        return accessToken;
      })
      .catch(() => null)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

class ApiError extends Error {
  constructor(status, detail) {
    super(detail || `HTTP ${status}`);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body, auth = true, retried = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth && !retried) {
    // The access token expires every fifteen minutes, so this is the ordinary
    // case rather than an error: renew it and repeat the request once. Once,
    // because a second 401 after a fresh token means the session is genuinely
    // over and retrying forever would just hide that.
    if (await refreshOnce()) {
      return api(path, { method, body, auth, retried: true });
    }
    signOut({ silent: true, server: false });
    throw new ApiError(401, 'your session has ended — sign in again');
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

function signOut({ silent = false, server = true } = {}) {
  // Tell the server, so the session is actually over rather than merely
  // forgotten here. Nothing waits on it: the page should sign out instantly
  // even if the request fails, and the cookie is cleared by the response.
  if (server) {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  }
  accessToken = null;
  state.me = null;
  showAuth(silent ? null : 'Signed out.');
}

/* --- bootstrap ---------------------------------------------------------- */

async function start() {
  // There is no stored token to find, so the question on boot is whether the
  // browser still holds a refresh cookie. It is httpOnly, so the only way to
  // ask is to try.
  if (!(await refreshOnce())) { showAuth(); return; }
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

  // Overlays belong to the plasmid that was open, not to this one.
  overlays = [];
  marked.clear();
  $('#pcr-bar').hidden = true;
  showAttachedPrimers();
  loadDesigns();
  if (libTab === 'primers') loadPrimers().catch(() => {});
  if (libTab === 'guides') loadGuides().catch(() => {});
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

/* --- the lab library: primers and guides on the open map ----------------

   The molecular tool's half of the notebook. Primers and guides the lab has
   already designed are searchable here and can be put straight onto the map,
   so nobody retypes a 20-mer out of a spreadsheet.

   Which primers bind is worked out here, in the browser, by the same
   js/plasmid.js that the old notebook used: it matches both strands, grows
   the anneal back from the 3' end and reports the 5' tail separately. The API
   hands over the library; it does not try to answer "does this bind", because
   a second implementation of that in Python would be a second answer.
   ----------------------------------------------------------------------- */

let libTab = 'plasmids';
let overlays = [];            // features added on top of the plasmid's own

function basePlasmidFeatures() {
  if (!currentPlasmid) return [];
  return currentPlasmid.features || currentPlasmid.annotations || [];
}

function redrawWithOverlays() {
  if (!vector || !currentPlasmid) return;
  vector.update({
    name: currentPlasmid.name,
    sequence: currentPlasmid.sequence || currentPlasmid.seq,
    topology: currentPlasmid.topology,
    features: basePlasmidFeatures().concat(overlays),
  });
}

function addOverlay(feature) {
  // Same name twice is the same thing twice; replace rather than stack.
  overlays = overlays.filter((o) => o.name !== feature.name);
  overlays.push(feature);
  redrawWithOverlays();
}

function openSequence() {
  if (!currentPlasmid) return '';
  return (currentPlasmid.sequence || currentPlasmid.seq || '').replace(/[\s\d]/g, '').toUpperCase();
}

/** Where a primer anneals on the plasmid that is open, if anywhere. */
function bindingsFor(sequence) {
  const seq = openSequence();
  if (!seq || !sequence) return [];
  return Plasmid.bindPrimers(
    { seq, topology: currentPlasmid.topology || 'circular' },
    sequence,
  );
}

function libRow(title, subtitle, monoText, actions, badges) {
  const li = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'row lib-row';

  const t = document.createElement('div');
  t.className = 'row__title';
  t.textContent = title;
  row.append(t);

  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'row__sub';
    sub.textContent = subtitle;
    row.append(sub);
  }
  if (monoText) {
    const m = document.createElement('div');
    m.className = 'mono-sm';
    m.textContent = monoText;
    row.append(m);
  }

  const meta = document.createElement('div');
  meta.className = 'row__meta';
  for (const b of badges || []) {
    const el = document.createElement('span');
    el.className = 'badge' + (b.good ? ' badge--binds' : '');
    el.textContent = b.text;
    meta.append(el);
  }
  for (const a of actions || []) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.type = 'button';
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    meta.append(btn);
  }
  row.append(meta);
  li.append(row);
  return li;
}

/* Primers currently drawn on the map, by id. Two of them pointing at each
   other is a PCR, which is the one derived thing worth offering here: the
   product is computed by js/plasmid.js — including the case where it runs
   across the origin — and only the result is ever sent. */
const marked = new Map();

function updatePcrBar() {
  const bar = $('#pcr-bar');
  const fwd = [...marked.values()].find((m) => m.binding.strand === 1);
  const rev = [...marked.values()].find((m) => m.binding.strand === -1);
  if (!currentPlasmid || !fwd || !rev) { bar.hidden = true; return; }

  const product = Plasmid.pcrProduct(
    { seq: openSequence(), topology: currentPlasmid.topology || 'circular' },
    fwd.binding, rev.binding,
  );
  if (product.error) {
    $('#pcr-bar-text').textContent = `${fwd.primer.name} + ${rev.primer.name}: ${product.error}`;
    $('#pcr-save').hidden = true;
    bar.hidden = false;
    return;
  }
  bar.dataset.product = JSON.stringify({
    forward_primer_id: fwd.primer.id,
    reverse_primer_id: rev.primer.id,
    product_start: product.start,
    product_end: product.end,
    product_sequence: product.seq,
    name: `${fwd.primer.name} + ${rev.primer.name}`,
  });
  const extra = product.tails ? ` (${product.tails} bp of 5′ tails)` : '';
  const wraps = product.wraps ? ', across the origin' : '';
  $('#pcr-bar-text').textContent =
    `${fwd.primer.name} + ${rev.primer.name} → ${product.len} bp${extra}${wraps}`;
  $('#pcr-save').hidden = false;
  bar.hidden = false;
}

$('#pcr-save').addEventListener('click', async () => {
  const raw = $('#pcr-bar').dataset.product;
  if (!raw || !currentPlasmid || !currentPlasmid.id) return;
  const design = JSON.parse(raw);
  const btn = $('#pcr-save');
  btn.disabled = true;
  try {
    const saved = await api('/api/pcr', {
      method: 'POST',
      body: { ...design, template_plasmid_id: currentPlasmid.id },
    });
    toast(`Saved: ${saved.name}, ${saved.expected_bp} bp.`);
    await loadDesigns();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

/** PCRs and assemblies already recorded against the open plasmid. */
async function loadDesigns() {
  const list = $('#design-list');
  list.textContent = '';
  if (!currentPlasmid || !currentPlasmid.id) return;

  let pcrs, assemblies;
  try {
    [pcrs, assemblies] = await Promise.all([
      api(`/api/pcr?template_plasmid_id=${currentPlasmid.id}`),
      api(`/api/assemblies?uses_plasmid_id=${currentPlasmid.id}`),
    ]);
  } catch {
    return;                      // a map without its designs is still a map
  }

  if (!pcrs.items.length && !assemblies.items.length) {
    list.append(emptyRow('Nothing designed against this plasmid yet.'));
    return;
  }
  for (const p of pcrs.items) {
    list.append(libRow(p.name, `PCR · ${p.expected_bp || '?'} bp`, null, [{
      label: 'Show',
      onClick: () => {
        addOverlay({
          name: p.name, type: 'misc_feature',
          start: p.product_start ?? 0,
          end: p.product_end ?? (p.product_start ?? 0) + (p.expected_bp || 0),
          strand: 1,
        });
        toast(`${p.name} marked.`);
      },
    }], []));
  }
  for (const a of assemblies.items) {
    list.append(libRow(a.name, `${a.method} · ${a.fragment_count} fragments`, null, [], []));
  }
}

async function loadPrimers() {
  // The whole library, not a page of it: binding is computed over all of them.
  const params = new URLSearchParams({ limit: '500' });
  const q = $('#lib-search').value.trim();
  if (q) params.set('q', q);
  const page = await api(`/api/primers?${params}`);

  const list = $('#primer-list');
  list.textContent = '';
  if (!page.items.length) {
    list.append(emptyRow(q ? `No primer matches “${q}”.` : 'No primers recorded yet.'));
    return;
  }

  for (const p of page.items) {
    const sites = bindingsFor(p.sequence);
    const badges = [];
    if (!currentPlasmid) badges.push({ text: 'open a plasmid' });
    else if (!sites.length) badges.push({ text: 'no site here' });
    else {
      const b = sites[0];
      badges.push({
        good: true,
        text: `binds ${b.start + 1} ${b.strand === 1 ? '+' : '−'}${b.perfect ? '' : ' (5′ tail)'}`,
      });
    }

    const actions = [];
    if (sites.length) {
      const b = sites[0];
      actions.push({
        label: 'Show',
        onClick: () => {
          addOverlay({
            name: p.name,
            type: 'primer_bind',
            start: b.start,
            end: b.end,
            strand: b.strand,
          });
          marked.set(p.id, { primer: p, binding: b });
          updatePcrBar();
          toast(`${p.name} marked at ${b.start + 1}.`);
        },
      });
      actions.push({
        label: 'Attach',
        onClick: async () => {
          try {
            await api(`/api/primers/${p.id}/bindings`, {
              method: 'POST',
              body: {
                plasmid_id: currentPlasmid.id,
                start_pos: b.start,
                end_pos: b.end,
                strand: b.strand,
                annealed_nt: b.anneal.length,
                tail_sequence: b.tail || '',
                tm_annealed_c: Number.isFinite(b.tm) ? Math.round(b.tm * 100) / 100 : null,
              },
            });
            toast(`${p.name} recorded against ${currentPlasmid.name}.`);
            await showAttachedPrimers();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      });
    }

    const bits = [`${p.length_nt} nt`];
    if (p.tm_c != null) bits.push(`Tm ${p.tm_c} °C`);
    if (p.purpose) bits.push(p.purpose);
    list.append(libRow(p.name, bits.join(' · '), p.sequence, actions, badges));
  }
}

/** Primers already recorded against this plasmid, drawn when it opens. */
async function showAttachedPrimers() {
  if (!currentPlasmid || !currentPlasmid.id) return;
  let bindings;
  try {
    bindings = await api(`/api/primers/bindings?plasmid_id=${currentPlasmid.id}`);
  } catch {
    return;                      // a map without its primers is still a map
  }
  for (const b of bindings) {
    addOverlay({
      name: b.primer_name,
      type: 'primer_bind',
      start: b.start_pos,
      end: b.end_pos,
      strand: b.strand,
    });
  }
}

async function loadGuides() {
  const params = new URLSearchParams({ limit: '500' });
  const q = $('#lib-search').value.trim();
  if (q) params.set('q', q);
  // With a plasmid open, the question is which guides target *this* one.
  if (currentPlasmid && currentPlasmid.id && !q) {
    params.set('target_plasmid_id', currentPlasmid.id);
  }
  const page = await api(`/api/guides?${params}`);

  const list = $('#guide-list');
  list.textContent = '';
  if (!page.items.length) {
    list.append(emptyRow(
      q ? `No guide matches “${q}”.`
        : currentPlasmid ? 'No guides designed against this plasmid.' : 'No guides recorded yet.'
    ));
    return;
  }

  for (const g of page.items) {
    const onThis = currentPlasmid && g.target_plasmid_id === currentPlasmid.id;
    const badges = [{ text: g.kind }];
    if (g.gc_percent != null) badges.push({ text: `${g.gc_percent}% GC` });

    const actions = [];
    if (onThis && g.target_start != null) {
      actions.push({
        label: 'Show',
        onClick: () => {
          const start = g.target_start;
          addOverlay({
            name: g.name,
            type: g.kind === 'pegRNA' ? 'pegRNA' : 'gRNA',
            start,
            end: start + g.spacer.length,
            strand: g.target_strand === -1 ? -1 : 1,
          });
          toast(`${g.name} marked at ${start + 1}.`);
        },
      });
    }
    const where = onThis ? `targets this plasmid` : (g.target_locus || g.target_genome || 'no target here');
    list.append(libRow(g.name, `${where} · ${g.nuclease}`, g.spacer + ' ' + g.pam_sequence,
                       actions, badges));
  }
}

/* --- in-silico cloning -------------------------------------------------- */

/* The one place the browser does not do the biology. Digest and ligation run
   on the server against Biopython's REBASE set — about 1,090 enzymes against
   the 81 js/plasmid.js carries — and pydna decides which ends actually join.
   The browser's digest stays for drawing sites while somebody scrolls; this
   is what a result gets saved from. */

async function loadClonePartners() {
  const select = $('#clone-partner');
  select.textContent = '';
  const paste = document.createElement('option');
  paste.value = '';
  paste.textContent = '— paste below —';
  select.append(paste);
  try {
    const page = await api('/api/plasmids?limit=100');
    for (const p of page.items) {
      if (currentPlasmid && p.id === currentPlasmid.id) continue;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.length_bp} bp)`;
      select.append(opt);
    }
  } catch { /* the paste box still works */ }
  $('#clone-lede').textContent = currentPlasmid
    ? `Digest ${currentPlasmid.name} and the partner, then join the ends that fit.`
    : 'Open a plasmid first — it is the other half of the cloning.';
}

let enzymeTimer;
$('#clone-enzymes').addEventListener('input', (e) => {
  clearTimeout(enzymeTimer);
  // REBASE is particular about case, so the list is there to stop people
  // guessing rather than to save typing.
  const tail = e.target.value.split(',').pop().trim();
  if (tail.length < 2) return;
  enzymeTimer = setTimeout(async () => {
    try {
      const names = await api(`/api/cloning/enzymes?q=${encodeURIComponent(tail)}&limit=20`);
      const list = $('#enzyme-options');
      list.textContent = '';
      for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n;
        list.append(opt);
      }
    } catch { /* the field still accepts typing */ }
  }, 250);
});

$('#clone-run').addEventListener('click', async () => {
  if (!currentPlasmid) { toast('Open a plasmid first.', 'error'); return; }
  const enzymes = $('#clone-enzymes').value.split(',').map((x) => x.trim()).filter(Boolean);
  if (!enzymes.length) { toast('Name at least one enzyme.', 'error'); return; }

  let sequenceB = $('#clone-paste').value.trim();
  const partnerId = $('#clone-partner').value;
  if (partnerId) {
    try {
      sequenceB = (await api(`/api/plasmids/${partnerId}`)).sequence;
    } catch (err) { toast(err.message, 'error'); return; }
  }
  if (!sequenceB) { toast('Choose a partner, or paste one.', 'error'); return; }

  const btn = $('#clone-run');
  btn.disabled = true;
  try {
    const out = await api('/api/cloning/digest-ligation', {
      method: 'POST',
      body: {
        sequence_a: openSequence(),
        sequence_b: sequenceB,
        enzymes,
        name_a: currentPlasmid.name || 'A',
        name_b: partnerId ? ($('#clone-partner').selectedOptions[0].textContent) : 'pasted',
        circular_only: !$('#clone-linear').checked,
      },
    });
    renderCloneResults(out);
  } catch (err) {
    $('#clone-results').textContent = '';
    const notes = $('#clone-notes');
    notes.className = 'alert alert--error';
    notes.textContent = err.message;
    notes.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

function renderCloneResults(out) {
  const notes = $('#clone-notes');
  if (out.notes.length) {
    notes.className = 'alert alert--note';
    notes.textContent = out.notes.join(' ');
    notes.hidden = false;
  } else {
    notes.hidden = true;
  }

  const list = $('#clone-results');
  list.textContent = '';
  const cutA = out.inputs.a.fragments.length;
  const cutB = out.inputs.b.fragments.length;
  list.append(emptyRow(`${cutA} + ${cutB} fragments → ${out.constructs.length} product(s)`));

  for (const k of out.constructs) {
    // What the junctions say is the part worth reading: a site that did not
    // come back is an insert that cannot be cut out again.
    const lost = k.junctions.filter((j) => !j.regenerated).map((j) => j.enzyme);
    const sub = `${k.length_bp} bp ${k.topology}` +
      (lost.length ? ` · ${lost.join(', ')} site not regenerated` : '');
    const orient = k.parts.map((p) => p.orientation === 'reverse' ? '↺' : '→').join(' ');

    list.append(libRow(`${orient} ${k.length_bp} bp`, sub, null, [{
      label: 'View',
      onClick: () => {
        // Straight into the viewer: the response is already the shape
        // normalizePayload takes, which is why nothing is translated here.
        showPlasmid({
          name: k.name,
          sequence: k.sequence,
          topology: k.topology,
          features: k.features,
        });
        toast(`${k.length_bp} bp construct — not saved.`);
      },
    }], lost.length ? [] : [{ good: true, text: 'sites intact' }]));
  }
}

/* --- primer design ------------------------------------------------------ */

function cell(row, text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  row.append(td);
  return td;
}

/** One primer's row. The pair occupies two, sharing the spanned columns. */
function primerRow(tbody, pair, which, index, isFirst) {
  const p = pair[which];
  const tr = document.createElement('tr');
  if (isFirst) tr.className = 'pair-start';

  if (isFirst) {
    const n = document.createElement('td');
    n.className = 'num';
    n.rowSpan = 2;
    n.textContent = String(index + 1);
    tr.append(n);
  }

  cell(tr, which === 'forward' ? 'Forward' : 'Reverse');
  cell(tr, p.sequence, 'seq');
  cell(tr, p.length, 'num');

  // Tm matters as a pair, so the difference is shown once, beside the pair.
  const tm = cell(tr, `${p.tm} °C`, 'num');
  if (isFirst && pair.tm_difference > 5) tm.classList.add('warn');

  const gc = cell(tr, `${p.gc_percent}%`, 'num');
  if (p.gc_percent < 35 || p.gc_percent > 70) gc.classList.add('warn');

  // A positive or near-zero dG means the oligo does not fold. Printing the
  // number there invites somebody to read "1.6" as a hairpin when it is the
  // opposite.
  const folds = p.hairpin_dg < -2;
  const hp = cell(tr, folds ? `${p.hairpin_dg} kcal/mol` : 'none', folds ? 'num warn' : 'num');
  if (p.hairpin_dg >= -2) hp.classList.add('good');

  if (isFirst) {
    // Dimer, product and score describe the pair, not either primer.
    const dimer = document.createElement('td');
    dimer.rowSpan = 2;
    dimer.textContent = pair.hetero_dimer_severity === 'none'
      ? 'none'
      : `${pair.hetero_dimer_severity} (${pair.hetero_dimer_3prime_run || pair.hetero_dimer_run} bp)`;
    if (pair.hetero_dimer_3prime_run >= 4) dimer.classList.add('warn');
    tr.append(dimer);

    const prod = document.createElement('td');
    prod.rowSpan = 2;
    prod.className = 'num';
    prod.textContent = `${pair.product_length} bp`;
    tr.append(prod);

    const score = document.createElement('td');
    score.rowSpan = 2;
    score.className = 'num';
    score.textContent = pair.score.toFixed(2);
    // The breakdown is the useful part; a total on its own says nothing
    // about why one pair beat another.
    score.title = Object.entries(pair.penalties)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') || 'nothing counted against it';
    tr.append(score);

    const action = document.createElement('td');
    action.rowSpan = 2;
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost';
    btn.type = 'button';
    btn.textContent = 'Save pair';
    btn.addEventListener('click', () => savePair(pair, index, btn));
    action.append(btn);
    tr.append(action);
  }

  tbody.append(tr);
}

function renderDesign(out) {
  const table = $('#design-table');
  const body = $('#design-body');
  body.textContent = '';

  const notes = $('#design-notes');
  if (out.notes.length) {
    notes.textContent = out.notes.join(' ');
    notes.hidden = false;
  } else {
    notes.hidden = true;
  }

  if (!out.pairs.length) { table.hidden = true; return; }

  const c = out.tm_conditions;
  $('#design-caption').textContent =
    `${out.pairs_found} usable pair(s) from ${out.windows_tried} window(s) across ` +
    `${out.template_length} bp — best ${out.pairs.length}, lowest score first. ` +
    `Hover a score for the breakdown. ` +
    `Tm at ${c.primer_nm} nM primer, ${c.na_mm} mM Na⁺, ${c.mg_mm} mM Mg²⁺.`;

  out.pairs.forEach((pair, i) => {
    primerRow(body, pair, 'forward', i, true);
    primerRow(body, pair, 'reverse', i, false);
    if (pair.warnings.length) {
      const tr = document.createElement('tr');
      tr.className = 'pair-warnings';
      const td = document.createElement('td');
      td.colSpan = 11;
      td.textContent = pair.warnings.join(' · ');
      tr.append(td);
      body.append(tr);
    }
  });
  table.hidden = false;
}

/** Keep a pair: two primers in the library, plus the PCR that links them. */
async function savePair(pair, index, btn) {
  btn.disabled = true;
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (currentPlasmid && currentPlasmid.name) || 'design';
  try {
    const made = [];
    for (const [which, suffix] of [['forward', 'F'], ['reverse', 'R']]) {
      made.push(await api('/api/primers', {
        method: 'POST',
        body: {
          name: `${base} ${stamp} #${index + 1} ${suffix}`,
          sequence: pair[which].sequence,
          purpose: `designed for a ${pair.product_length} bp product`,
          tm_c: pair[which].tm,
          gc_percent: pair[which].gc_percent,
        },
      }));
    }
    const body = {
      name: `${base} ${stamp} #${index + 1}`,
      forward_primer_id: made[0].id,
      reverse_primer_id: made[1].id,
      product_start: pair.product_start,
      product_end: pair.product_end,
      annealing_temp_c: Math.min(pair.forward.tm, pair.reverse.tm) - 3,
    };
    // Only claim the plasmid as the template when that is what was designed
    // against; a pasted template is not one of ours.
    if (currentPlasmid && currentPlasmid.id && $('#design-source').dataset.fromPlasmid === '1') {
      body.template_plasmid_id = currentPlasmid.id;
    }
    await api('/api/pcr', { method: 'POST', body });
    toast(`Pair ${index + 1} saved, with its PCR.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function openDesign() {
  const box = $('#design-template');
  const source = $('#design-source');
  if (currentPlasmid && openSequence()) {
    box.value = openSequence();
    source.textContent = `— from ${currentPlasmid.name}`;
    source.dataset.fromPlasmid = currentPlasmid.id ? '1' : '0';
  } else {
    source.textContent = '';
    source.dataset.fromPlasmid = '0';
  }
  $('#design-table').hidden = true;
  $('#design-notes').hidden = true;
  show('primer-design');
}

$('#open-design').addEventListener('click', openDesign);
$('#design-back').addEventListener('click', () => show('plasmids'));

$('#design-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const template = $('#design-template').value.trim();
  if (!template) { toast('Paste a template, or open a plasmid first.', 'error'); return; }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    renderDesign(await api('/api/primers/design', {
      method: 'POST',
      body: {
        template,
        product_length: Number(f.product_length.value),
        optimal_tm: Number(f.optimal_tm.value),
      },
    }));
  } catch (err) {
    $('#design-table').hidden = true;
    const notes = $('#design-notes');
    notes.textContent = err.message;
    notes.hidden = false;
    notes.className = 'alert alert--error';
  } finally {
    btn.disabled = false;
  }
});

async function showLibTab(tab) {
  libTab = tab;
  $$('[data-libtab]').forEach((b) => b.classList.toggle('is-active', b.dataset.libtab === tab));
  $('#plasmid-list').hidden = tab !== 'plasmids';
  $('#primer-list').hidden = tab !== 'primers';
  $('#guide-list').hidden = tab !== 'guides';
  $('#clone-panel').hidden = tab !== 'clone';
  $('#open-design').hidden = tab !== 'primers';
  $('#lib-search').hidden = tab === 'plasmids' || tab === 'clone';
  $('#lib-search').value = '';
  try {
    if (tab === 'plasmids') await loadPlasmids();
    if (tab === 'primers') await loadPrimers();
    if (tab === 'guides') await loadGuides();
    if (tab === 'clone') await loadClonePartners();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$$('[data-libtab]').forEach((b) => b.addEventListener('click', () => showLibTab(b.dataset.libtab)));

let libSearchTimer;
$('#lib-search').addEventListener('input', () => {
  clearTimeout(libSearchTimer);
  // Typing a primer name should not be one request per keystroke.
  libSearchTimer = setTimeout(() => {
    if (libTab === 'primers') loadPrimers().catch((e) => toast(e.message, 'error'));
    if (libTab === 'guides') loadGuides().catch((e) => toast(e.message, 'error'));
  }, 250);
});

/* --- importing a file --------------------------------------------------- */

// What has been parsed but not yet saved. Nothing reaches the API until the
// person looks at the map and says so: a parser getting a file subtly wrong
// is much easier to see on a map than in a row of numbers.
let pendingImport = null;

function setPending(next) {
  pendingImport = next;
  const bar = $('#import-pending');
  if (!next) { bar.hidden = true; return; }
  const n = next.body.features.length;
  const warn = next.warnings.length ? ` · ${next.warnings.length} feature(s) skipped` : '';
  $('#import-pending-text').textContent =
    `${next.body.name} — ${next.format}, ${next.body.sequence.length} bp, ` +
    `${n} feature${n === 1 ? '' : 's'}${warn}. Not saved yet.`;
  bar.hidden = false;
}

async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (files.length > 1) {
    toast(`Importing ${files[0].name}; one at a time for now.`);
  }
  const file = files[0];

  let parsed;
  try {
    parsed = await PlasmidImport.readFile(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  let mapped;
  try {
    mapped = PlasmidImport.toCreatePayload(parsed, {
      external_source: `${parsed.format} file: ${file.name}`,
    });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  // Preview the payload that will be saved, not the raw parse. They differ in
  // one way that shows: colours plasmid.js invented are dropped on the way
  // through, so previewing the parse would show a washed-out map and saving
  // would produce a different-looking one.
  showPlasmid({
    name: mapped.body.name,
    sequence: mapped.body.sequence,
    topology: mapped.body.topology,
    features: mapped.body.features,
  });
  setPending({ body: mapped.body, warnings: mapped.warnings, format: parsed.format });

  if (mapped.warnings.length) {
    const box = $('#vector-warnings');
    box.textContent = `Not imported: ${mapped.warnings.join('; ')}`;
    box.hidden = false;
  }
  toast(`Read ${file.name} as ${parsed.format}.`);
}

$('#plasmid-import').addEventListener('click', () => $('#plasmid-file').click());
$('#plasmid-file').addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = '';          // so the same file can be chosen twice
});

$('#import-discard').addEventListener('click', () => {
  setPending(null);
  toast('Import discarded.');
});

$('#import-save').addEventListener('click', async () => {
  if (!pendingImport) return;
  const btn = $('#import-save');
  btn.disabled = true;
  try {
    const saved = await api('/api/plasmids', { method: 'POST', body: pendingImport.body });
    toast(`${saved.name} saved with ${saved.features.length} features.`);
    setPending(null);
    await loadPlasmids();
    showPlasmid(saved);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// Drag and drop onto the map. dragover must be cancelled or the browser
// navigates to the file instead of handing it over.
const dropZone = $('#vector-canvas');
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  dropZone.classList.add('is-dropping');
}));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  dropZone.classList.remove('is-dropping');
}));
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files) importFiles(e.dataTransfer.files);
});

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
    accessToken = res.access_token;
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
    accessToken = res.access_token;
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
    accessToken = res.access_token;
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
    accessToken = res.access_token;
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
