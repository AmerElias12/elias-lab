/* ============================================================
   Elias Lab Notebook — data layer
   Dual mode:
     • SUPABASE  — shared, backed-up, real auth (when config set)
     • LOCAL     — browser localStorage fallback (config blank)
   The UI (notebook.js) reads from an in-memory cache via the
   sync accessors (getProtocols(), etc.) and writes through the
   async DB.* mutators, which persist + update the cache.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.ELIAS_CONFIG || {};
  var ADMIN_EMAIL = (CFG.ADMIN_EMAIL || 'amerelias02@gmail.com').toLowerCase();
  var hasSupabase = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  // ---- in-memory cache (what the UI renders from) ----
  var state = {
    currentUser: null,
    users: [],
    protocols: [],
    notebooks: [],
    presentations: [],
    inventory: { enzymes: [], primers: [], plasmids: [], stocks: [], kits: [] }
  };
  var INV_CATS = ['enzymes', 'primers', 'plasmids', 'stocks', 'kits'];
  var COLLECTIONS = { protocols: 'protocols', notebooks: 'notebooks', presentations: 'presentations' };

  // ---- small helpers shared with the UI ----
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // fallback uuid-v4-ish
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function g(id) { var el = document.getElementById(id); return el && el.value ? el.value.trim() : ''; }
  function djb2(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xFFFFFFFF; return (h >>> 0).toString(16); }

  // expose helpers globally (UI uses them directly)
  window.uid = uid; window.esc = esc; window.g = g;

  // ---- sync accessors (read cache) ----
  window.currentUser = function () { return state.currentUser; };
  window.getUsers = function () { return state.users; };
  window.getProtocols = function () { return state.protocols; };
  window.getNotebooks = function () { return state.notebooks; };
  window.getPresentations = function () { return state.presentations; };
  window.getInventory = function () { return state.inventory; };
  window.getApprovedUserNames = function () { return state.users.filter(function (u) { return u.status === 'approved'; }).map(function (u) { return u.name; }); };

  // ===========================================================
  // LOCAL-MODE storage (mirrors the original localStorage layer)
  // ===========================================================
  var hasLS = (function () { try { var t = '__ln__'; localStorage.setItem(t, '1'); localStorage.removeItem(t); return true; } catch (e) { return false; } })();
  var mem = {};
  function lsGet(k) { var key = 'elias_ln_' + k; try { var raw = hasLS ? localStorage.getItem(key) : mem[key]; return JSON.parse(raw || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { var key = 'elias_ln_' + k; var str = JSON.stringify(v); try { if (hasLS) localStorage.setItem(key, str); else mem[key] = str; } catch (e) { mem[key] = str; } }
  function ssGet(k) { try { return JSON.parse((hasLS ? sessionStorage.getItem('elias_lns_' + k) : mem['s_' + k]) || 'null'); } catch (e) { return null; } }
  function ssSet(k, v) { try { if (hasLS) sessionStorage.setItem('elias_lns_' + k, JSON.stringify(v)); else mem['s_' + k] = JSON.stringify(v); } catch (e) { mem['s_' + k] = JSON.stringify(v); } }
  function ssDel(k) { try { if (hasLS) sessionStorage.removeItem('elias_lns_' + k); else delete mem['s_' + k]; } catch (e) { } }

  function localSeedAdmin() {
    var users = lsGet('users') || [];
    if (!users.find(function (u) { return u.email === ADMIN_EMAIL; })) {
      users.unshift({ id: uid(), name: 'Dr. Amer Elias', email: ADMIN_EMAIL, pwHash: djb2('eliaslab'), role: 'admin', status: 'approved', added: today() });
      lsSet('users', users);
    }
    return users;
  }
  function today() { return new Date().toISOString().split('T')[0]; }

  // ===========================================================
  // Supabase client (loaded lazily from CDN)
  // ===========================================================
  var sb = null;
  async function ensureSb() {
    if (sb) return sb;
    var mod = await import('https://esm.sh/@supabase/supabase-js@2');
    sb = mod.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    return sb;
  }
  function profileFromRow(r) { return { id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, added: (r.created_at || '').split('T')[0] }; }

  // ===========================================================
  // Public DB API
  // ===========================================================
  var DB = {
    mode: hasSupabase ? 'supabase' : 'local',
    isAdmin: function () { return state.currentUser && state.currentUser.role === 'admin'; },

    /* Establish mode + restore any existing session. Returns the
       restored user (or null). Sets a banner in local/error mode. */
    init: async function () {
      var banner = document.getElementById('ln-mode-banner');
      if (this.mode === 'local') {
        localSeedAdmin();
        if (banner) {
          banner.className = 'local';
          // Only reveal the demo credentials when running locally — never on a
          // public URL, where they would be visible to anyone.
          var isLocal = location.protocol === 'file:' ||
            /^(localhost|127\.0\.0\.1|\[::1\]|.*\.local)$/i.test(location.hostname);
          banner.innerHTML = 'Local mode — data is saved only in this browser and is not shared. ' +
            'Configure Supabase (see DEPLOY.md) to enable the shared lab notebook.' +
            (isLocal ? ' &nbsp;(Demo PI login: ' + ADMIN_EMAIL + ' / eliaslab)' : '');
        }
        return this.restoreSession();
      }
      try {
        await ensureSb();
        return await this.restoreSession();
      } catch (e) {
        this.mode = 'local';
        localSeedAdmin();
        if (banner) { banner.className = 'error'; banner.textContent = 'Could not reach Supabase — falling back to local mode. ' + (e.message || ''); }
        return null;
      }
    },

    restoreSession: async function () {
      if (this.mode === 'local') {
        var u = ssGet('user');
        if (u) { state.currentUser = u; await this.loadAll(); }
        return u;
      }
      var res = await sb.auth.getSession();
      var session = res.data.session;
      if (!session) return null;
      return await hydrateProfile(session.user);
    },

    signUp: async function (name, email, pw) {
      email = (email || '').toLowerCase().trim();
      if (this.mode === 'local') {
        var users = lsGet('users') || [];
        if (users.find(function (u) { return u.email === email; })) return { ok: false, error: 'An account with this email already exists.' };
        var nu = { id: uid(), name: name, email: email, pwHash: djb2(pw), role: 'member', status: 'pending', added: today() };
        users.push(nu); lsSet('users', users);
        if (state.users && state.users.length) state.users.push(nu); // keep cache fresh for a logged-in admin
        return { ok: true, pending: true };
      }
      var r = await sb.auth.signUp({ email: email, password: pw, options: { data: { name: name } } });
      if (r.error) return { ok: false, error: r.error.message };
      return { ok: true, pending: true };
    },

    signIn: async function (email, pw) {
      email = (email || '').toLowerCase().trim();
      if (this.mode === 'local') {
        var users = lsGet('users') || [];
        var u = users.find(function (x) { return x.email === email; });
        if (!u) return { ok: false, error: 'No account found with this email.' };
        if (u.pwHash !== djb2(pw)) return { ok: false, error: 'Incorrect password.' };
        if (u.status === 'pending') return { ok: false, error: 'Your account is pending approval.' };
        if (u.status === 'disabled') return { ok: false, error: 'Your account has been disabled.' };
        state.currentUser = u; ssSet('user', u); await this.loadAll();
        return { ok: true, user: u };
      }
      var r = await sb.auth.signInWithPassword({ email: email, password: pw });
      if (r.error) return { ok: false, error: r.error.message };
      var prof = await hydrateProfile(r.data.user);
      if (!prof) return { ok: false, error: 'Profile not found.' };
      if (prof.status === 'pending') { await sb.auth.signOut(); state.currentUser = null; return { ok: false, error: 'Your account is pending approval by the PI.' }; }
      if (prof.status === 'disabled') { await sb.auth.signOut(); state.currentUser = null; return { ok: false, error: 'Your account has been disabled.' }; }
      return { ok: true, user: prof };
    },

    signOut: async function () {
      if (this.mode === 'supabase') { try { await sb.auth.signOut(); } catch (e) { } }
      else ssDel('user');
      state.currentUser = null;
    },

    /* Load all collections into the cache. */
    loadAll: async function () {
      if (this.mode === 'local') {
        state.users = lsGet('users') || [];
        state.protocols = lsGet('protocols') || [];
        state.notebooks = lsGet('notebooks') || [];
        state.presentations = lsGet('presentations') || [];
        state.inventory = lsGet('inventory') || { enzymes: [], primers: [], plasmids: [], stocks: [], kits: [] };
        return;
      }
      // supabase
      var q = await Promise.all([
        sb.from('profiles').select('*').order('created_at'),
        sb.from('protocols').select('*').order('created_at'),
        sb.from('notebooks').select('*').order('created_at'),
        sb.from('presentations').select('*').order('created_at'),
        sb.from('inventory_items').select('*').order('created_at')
      ]);
      state.users = (q[0].data || []).map(profileFromRow);
      state.protocols = q[1].data || [];
      state.notebooks = q[2].data || [];
      state.presentations = q[3].data || [];
      var inv = { enzymes: [], primers: [], plasmids: [], stocks: [], kits: [] };
      (q[4].data || []).forEach(function (r) {
        var item = Object.assign({ id: r.id, addedBy: r.added_by }, r.data || {});
        if (inv[r.category]) inv[r.category].push(item);
      });
      state.inventory = inv;
    },

    /* Insert or update one record in a collection. */
    upsert: async function (collection, obj) {
      if (!obj.id) obj.id = uid();
      if (this.mode === 'local') {
        var arr = state[collection];
        var i = arr.findIndex(function (x) { return x.id === obj.id; });
        if (i >= 0) arr[i] = obj; else arr.push(obj);
        lsSet(collection, arr);
        return obj;
      }
      var row = Object.assign({}, obj, { created_by: state.currentUser ? state.currentUser.id : null });
      var r = await sb.from(COLLECTIONS[collection]).upsert(row).select().single();
      if (r.error) throw new Error(r.error.message);
      var arr2 = state[collection];
      var j = arr2.findIndex(function (x) { return x.id === r.data.id; });
      if (j >= 0) arr2[j] = r.data; else arr2.push(r.data);
      return r.data;
    },

    remove: async function (collection, id) {
      if (this.mode === 'local') {
        state[collection] = state[collection].filter(function (x) { return x.id !== id; });
        lsSet(collection, state[collection]);
        return;
      }
      var r = await sb.from(COLLECTIONS[collection]).delete().eq('id', id);
      if (r.error) throw new Error(r.error.message);
      state[collection] = state[collection].filter(function (x) { return x.id !== id; });
    },

    upsertInventory: async function (category, item) {
      if (!item.id) item.id = uid();
      if (this.mode === 'local') {
        var arr = state.inventory[category];
        var i = arr.findIndex(function (x) { return x.id === item.id; });
        if (i >= 0) arr[i] = item; else arr.push(item);
        lsSet('inventory', state.inventory);
        return item;
      }
      var data = Object.assign({}, item); delete data.id; delete data.addedBy;
      var row = { id: item.id, category: category, data: data, added_by: item.addedBy || null };
      var r = await sb.from('inventory_items').upsert(row).select().single();
      if (r.error) throw new Error(r.error.message);
      var arr2 = state.inventory[category];
      var j = arr2.findIndex(function (x) { return x.id === item.id; });
      if (j >= 0) arr2[j] = item; else arr2.push(item);
      return item;
    },

    removeInventory: async function (category, id) {
      if (this.mode === 'local') {
        state.inventory[category] = state.inventory[category].filter(function (x) { return x.id !== id; });
        lsSet('inventory', state.inventory);
        return;
      }
      var r = await sb.from('inventory_items').delete().eq('id', id);
      if (r.error) throw new Error(r.error.message);
      state.inventory[category] = state.inventory[category].filter(function (x) { return x.id !== id; });
    },

    // ---- user management (admin) ----
    refreshUsers: async function () {
      if (this.mode === 'local') { state.users = lsGet('users') || []; return; }
      var r = await sb.from('profiles').select('*').order('created_at');
      if (!r.error) state.users = (r.data || []).map(profileFromRow);
    },
    addUser: async function (u) {
      // Only supported in local mode (Supabase users self-register).
      if (this.mode !== 'local') return { ok: false, error: 'In shared mode, members sign up on the login screen and you approve them here.' };
      var users = lsGet('users') || [];
      if (users.find(function (x) { return x.email === u.email.toLowerCase(); })) return { ok: false, error: 'A user with this email already exists.' };
      var nu = { id: uid(), name: u.name, email: u.email.toLowerCase(), pwHash: djb2(u.pw), role: u.role, status: 'approved', added: today() };
      users.push(nu); lsSet('users', users); state.users = users;
      return { ok: true };
    },
    setUserStatus: async function (id, status) {
      if (this.mode === 'local') {
        var users = lsGet('users') || []; var u = users.find(function (x) { return x.id === id; });
        if (u) { u.status = status; lsSet('users', users); state.users = users; }
        return;
      }
      var r = await sb.from('profiles').update({ status: status }).eq('id', id);
      if (r.error) throw new Error(r.error.message);
      var c = state.users.find(function (x) { return x.id === id; }); if (c) c.status = status;
    },
    removeUser: async function (id) {
      if (this.mode === 'local') {
        state.users = (lsGet('users') || []).filter(function (x) { return x.id !== id; });
        lsSet('users', state.users); return;
      }
      var r = await sb.from('profiles').delete().eq('id', id);
      if (r.error) throw new Error(r.error.message);
      state.users = state.users.filter(function (x) { return x.id !== id; });
    },
    resetUserPw: async function (id, pw) {
      if (this.mode !== 'local') return { ok: false, error: 'In shared mode, the member resets their own password via the "Forgot password" email.' };
      var users = lsGet('users') || []; var u = users.find(function (x) { return x.id === id; });
      if (u) { u.pwHash = djb2(pw); lsSet('users', users); state.users = users; }
      return { ok: true };
    },

    // ---- file uploads ----
    uploadFiles: async function (fileList) {
      var out = [];
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        if (this.mode === 'local') {
          if (f.size > 3 * 1024 * 1024) throw new Error('"' + f.name + '" exceeds the 3 MB local-mode limit. Configure Supabase for larger uploads.');
          out.push(await readAsDataURL(f));
        } else {
          if (f.size > 50 * 1024 * 1024) throw new Error('"' + f.name + '" exceeds 50 MB.');
          var path = (state.currentUser ? state.currentUser.id : 'anon') + '/' + Date.now() + '-' + f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          var up = await sb.storage.from('lab-files').upload(path, f, { upsert: false });
          if (up.error) throw new Error(up.error.message);
          var pub = sb.storage.from('lab-files').getPublicUrl(path);
          out.push({ name: f.name, type: f.type, data: pub.data.publicUrl, size: f.size });
        }
      }
      return out;
    },

    /* Best-effort migration: push this browser's localStorage data
       into Supabase (admin only). Returns a summary string. */
    importLocalData: async function () {
      if (this.mode !== 'supabase') return 'Only available in shared mode.';
      var n = 0;
      var p = lsGet('protocols') || []; for (var i = 0; i < p.length; i++) { await this.upsert('protocols', p[i]); n++; }
      var nb = lsGet('notebooks') || []; for (var j = 0; j < nb.length; j++) { await this.upsert('notebooks', nb[j]); n++; }
      var pr = lsGet('presentations') || []; for (var k = 0; k < pr.length; k++) { await this.upsert('presentations', pr[k]); n++; }
      var inv = lsGet('inventory') || {}; for (var c = 0; c < INV_CATS.length; c++) { var cat = INV_CATS[c]; var items = inv[cat] || []; for (var m = 0; m < items.length; m++) { await this.upsertInventory(cat, items[m]); n++; } }
      return 'Imported ' + n + ' records from this browser into the shared database.';
    }
  };

  async function hydrateProfile(authUser) {
    var r = await sb.from('profiles').select('*').eq('id', authUser.id).single();
    if (r.error || !r.data) return null;
    var prof = profileFromRow(r.data);
    state.currentUser = prof;
    if (prof.status === 'approved') await DB.loadAll();
    return prof;
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve({ name: file.name, type: file.type, data: e.target.result, size: file.size }); };
      reader.onerror = function () { reject(new Error('Failed to read file.')); };
      reader.readAsDataURL(file);
    });
  }

  window.DB = DB;
})();
