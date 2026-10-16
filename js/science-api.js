/* ===========================================================================
   science-api.js — the two molecular tools that cannot run in a browser

   The site is static: GitHub Pages serves the HTML, Supabase holds the lab's
   records. Neither can run pydna, Biopython's REBASE tables or the primer
   scoring in the backend's app/primer_design.py, so those two calculations
   live in a small Python service (backend/app/science.py) and the pages call
   it directly:

       tools/gibson-calculator.html  ->  POST /api/cloning/digest-ligation
       tools/grna-primer-generator.html -> POST /api/primers/design

   No host has been chosen for that service yet, so its origin is config:
   window.ELIAS_CONFIG.SCIENCE_API_URL, empty in the published config.js.

       empty  =>  the service is not configured.

   That is a supported state, not a broken one. Every page here did its own
   arithmetic in the browser before the service existed and still does; the
   server panels are an addition that switches itself off, with a sentence
   saying so, rather than a button that fails when pressed.

   Why there is a pure half and a browser half
   -------------------------------------------
   Everything above `--- the browser half ---` touches neither the document,
   nor fetch, nor Supabase, so it runs in Node and is checked there by
   scripts/check-science-api.mjs. That is where this file can actually be
   wrong: which failure a message describes, which numbers a table shows, and
   whether a request is rejected here or 422'd there. The browser half is
   thin on purpose.

   On the token
   ------------
   The service wants a Supabase *session* token — a signed-in person. It
   refuses the publishable (anon) key by design: that key is in this
   repository and in the HTML of this site, so it identifies nobody. See the
   long note in backend/app/auth_light.py. `accessToken` below will not send
   it even if asked.
   ======================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;  // checks
  else root.ScienceAPI = api;                                              // browser
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =========================================================================
     the pure half — no document, no network
     ===================================================================== */

  /** Where to find the service, or '' for "not configured".
   *
   *  A trailing slash is dropped so that joining a path never produces the
   *  `//api/...` that some proxies answer with a redirect fetch cannot follow
   *  with an Authorization header intact. A value that is not a string, or is
   *  still the placeholder from config.example.js, counts as unset. */
  function normalizeBaseUrl(raw) {
    if (typeof raw !== 'string') return '';
    const url = raw.trim().replace(/\/+$/, '');
    if (!url) return '';
    if (/YOUR-|example\.com$|changeme/i.test(url)) return '';
    return url;
  }

  function baseUrl(config) {
    const cfg = config || (typeof window !== 'undefined' ? window.ELIAS_CONFIG : null) || {};
    return normalizeBaseUrl(cfg.SCIENCE_API_URL);
  }

  function isConfigured(config) {
    return baseUrl(config) !== '';
  }

  function endpoint(base, path) {
    return normalizeBaseUrl(base) + (path.charAt(0) === '/' ? path : '/' + path);
  }

  /* --- input, rejected here or rejected there ----------------------------
     The service answers a bad *value* with a 400 and a sentence written for
     a person ("none of EcoRI cuts A, so there is nothing to ligate"), and
     those are worth showing verbatim. What it answers with a 422 is
     pydantic's own array of {loc, msg}, which is not a sentence and not
     worth translating twice. So the bounds that would produce a 422 — and
     only those — are checked here, in the same units the server uses. */

  const MAX_ENZYMES = 8;          // schemas.py: CloningRequest.enzymes
  const PRODUCT_BP = [50, 20000]; // schemas.py: PrimerDesignRequest.product_length
  const TM_RANGE = [40, 75];      //             .optimal_tm
  const PAIR_RANGE = [1, 10];     //             .max_pairs
  const PURPOSES = ['cloning', 'qpcr', 'analytical'];

  /** Thrown for input this file refuses to send. `message` is shown as-is. */
  function InputError(message) {
    const err = new Error(message);
    err.name = 'InputError';
    err.kind = 'input';
    return err;
  }

  /** REBASE is case-sensitive: EcoRI, not ECORI. The service says so with a
   *  "did you mean" when the name is merely miscapitalised, which is more
   *  use than anything guessable here — so the only names refused locally
   *  are ones that cannot be enzyme names at all. */
  function cleanEnzymeNames(list) {
    const names = (Array.isArray(list) ? list : [])
      .map((n) => String(n == null ? '' : n).trim())
      .filter(Boolean);
    const seen = new Set();
    const unique = names.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
    if (!unique.length) throw InputError('Choose at least one enzyme.');
    if (unique.length > MAX_ENZYMES) {
      throw InputError(`Choose at most ${MAX_ENZYMES} enzymes — ${unique.length} were selected.`);
    }
    for (const name of unique) {
      if (!/^[A-Za-z0-9.\-]{2,20}$/.test(name)) {
        throw InputError(`"${name}" is not an enzyme name.`);
      }
    }
    return unique;
  }

  /** Body for POST /api/cloning/digest-ligation.
   *
   *  Sequences are passed through untouched: the endpoint reads GenBank and
   *  FASTA as well as bare bases, and stripping anything here would throw
   *  away the features that come back on the construct. */
  function cloningRequest(input) {
    const form = input || {};
    const a = String(form.sequenceA == null ? '' : form.sequenceA).trim();
    const b = String(form.sequenceB == null ? '' : form.sequenceB).trim();
    if (!a || !b) throw InputError('Paste a sequence for both molecules — vector and insert.');

    return {
      sequence_a: a,
      sequence_b: b,
      enzymes: cleanEnzymeNames(form.enzymes),
      name_a: (String(form.nameA || 'A').trim() || 'A').slice(0, 40),
      name_b: (String(form.nameB || 'B').trim() || 'B').slice(0, 40),
      circular_only: form.circularOnly !== false,
    };
  }

  function wholeNumberIn(value, range, what) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw InputError(`${what} needs a number.`);
    if (n < range[0] || n > range[1]) {
      throw InputError(`${what} must be between ${range[0]} and ${range[1]} — ${n} is outside that.`);
    }
    return Math.round(n);
  }

  /** The two endpoints do not take the same thing, and it is worth being
   *  blunt about it rather than letting somebody find out from a 400.
   *
   *  /api/cloning/digest-ligation reads GenBank and FASTA — that is how the
   *  features end up on the construct. /api/primers/design strips only
   *  whitespace and digits (backend/app/primer_design.py), so a GenBank
   *  record reaches it as its header text and comes back as "found
   *  "-./=BDEFHIJ…", which is accurate and tells nobody what to do. */
  function looksLikeRecord(text) {
    if (/^\s*>/.test(text)) return 'FASTA';
    if (/^\s*LOCUS\s/m.test(text) || /^\s*ORIGIN\s*$/m.test(text)) return 'GenBank';
    return '';
  }

  /** Body for POST /api/primers/design.
   *
   *  The template's own length is not checked here — the service answers
   *  "the template is shorter than the product" with that sentence. */
  function primerRequest(input) {
    const form = input || {};
    const template = String(form.template == null ? '' : form.template).trim();
    if (!template) throw InputError('Paste the template the primers should amplify from.');

    const record = looksLikeRecord(template);
    if (record) {
      throw InputError(
        `This endpoint takes bases, not a ${record} record — paste the sequence itself ` +
        '(line breaks and numbering are fine). The restriction-cloning panel on the Gibson ' +
        'calculator is the one that reads whole records.'
      );
    }

    const purpose = String(form.purpose || 'cloning');
    if (PURPOSES.indexOf(purpose) < 0) {
      throw InputError(`"${purpose}" is not one of ${PURPOSES.join(', ')}.`);
    }

    const tm = Number(form.optimalTm === undefined || form.optimalTm === '' ? 60 : form.optimalTm);
    if (!Number.isFinite(tm)) throw InputError('Target Tm needs a number.');
    if (tm < TM_RANGE[0] || tm > TM_RANGE[1]) {
      throw InputError(`Target Tm must be between ${TM_RANGE[0]} and ${TM_RANGE[1]} °C — ${tm} is outside that.`);
    }

    return {
      template,
      product_length: wholeNumberIn(form.productLength, PRODUCT_BP, 'Product length'),
      optimal_tm: Math.round(tm * 10) / 10,
      max_pairs: wholeNumberIn(
        form.maxPairs === undefined || form.maxPairs === '' ? 3 : form.maxPairs,
        PAIR_RANGE, 'Number of pairs'
      ),
      purpose,
    };
  }

  /* --- failure, described --------------------------------------------------
     Five things go wrong, and they want five different sentences. Lumping
     them into "something went wrong" is what makes a static site feel
     broken: a signed-out visitor and an unreachable container are not the
     same problem and only one of them is the visitor's to fix. */

  /** Thrown by the browser half. `kind` is one of the keys below. */
  function ApiError(kind, message, extra) {
    const err = new Error(message);
    err.name = 'ApiError';
    err.kind = kind;
    Object.assign(err, extra || {});
    return err;
  }

  /**
   * One place that turns a failure into what the panel shows.
   *
   * @returns {{kind, title, message, signIn}} `signIn` marks the one case a
   *          visitor can act on without the lab doing anything first.
   */
  function describeError(err, context) {
    const ctx = context || {};
    const kind = (err && err.kind) || 'unknown';

    switch (kind) {
      case 'unconfigured':
        return {
          kind,
          title: 'Not configured',
          message:
            'The molecular tools service has no address set for this site, so this panel is off. ' +
            'Everything else on this page is calculated in your browser and is unaffected.',
          signIn: false,
        };

      case 'signed-out':
        return {
          kind,
          title: 'Sign in to use this',
          message:
            'The service only answers for a signed-in lab member, because the sequence you paste is ' +
            'the lab\'s unpublished data. Sign in to the notebook in this browser, then come back.',
          signIn: true,
        };

      case 'unauthorized':
        return {
          kind,
          title: 'Session not accepted',
          message:
            'The service would not accept this session — it has most likely expired. ' +
            'Sign in to the notebook again and retry.',
          signIn: true,
        };

      case 'input':
        return { kind, title: 'Check the input', message: err.message, signIn: false };

      case 'bad-request':
        // The service writes these for a person to read: which enzyme does
        // not cut, which sequence is not DNA, why nothing circularised.
        return { kind, title: 'The service could not do that', message: err.message, signIn: false };

      case 'network':
        return {
          kind,
          title: 'Could not reach the service',
          message:
            `No response from ${ctx.base || 'the service'}. It may be stopped, or it may not list ` +
            `this site (${ctx.origin || 'this origin'}) in ELN_CORS_ORIGINS — a blocked origin looks ` +
            'exactly like a server that is down. Nothing was sent anywhere else.',
          signIn: false,
        };

      case 'server':
        return {
          kind,
          title: 'The service failed',
          message:
            `The service answered ${err.status || 'with an error'} rather than a result. ` +
            'That is a fault on its side, not in what you entered; the log on the service says which.',
          signIn: false,
        };

      default:
        return {
          kind: 'unknown',
          title: 'Something went wrong',
          message: (err && err.message) || String(err),
          signIn: false,
        };
    }
  }

  /** FastAPI's `detail` is a sentence for a 400 and pydantic's array for a
   *  422. Both end up as one line here; the array is folded rather than
   *  dropped, because "product_length: Input should be greater than or equal
   *  to 50" still says which field. */
  function detailToSentence(payload, status) {
    const detail = payload && payload.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (Array.isArray(detail) && detail.length) {
      return detail
        .map((d) => {
          const where = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
          return where ? `${where}: ${d.msg}` : d.msg;
        })
        .filter(Boolean)
        .join('; ');
    }
    return `the service answered ${status} with no explanation`;
  }

  /* --- rendering helpers -------------------------------------------------- */

  /** Exact name first, then names that start with what was typed, then the
   *  rest; within a group, shorter first.
   *
   *  REBASE holds ~1,090 names and the service returns them sorted, where
   *  digits sort before letters: searching "eco" gives 42 names with EcoRI
   *  37th, behind Eco105I, Eco9699II and the rest of the numbered series.
   *  Ordering by length instead puts the short letter-suffixed names — the
   *  ones anybody is actually looking for — at the top, and EcoRI third.
   *
   *  It cannot do better than that without a notion of which enzymes this
   *  lab uses, which is not in the name: EcoHI and EcoNI are also five
   *  characters. Typing one more letter resolves it, and the page offers the
   *  common ones as one-click presets for the same reason. */
  function rankEnzymes(names, query) {
    const needle = String(query || '').trim().toLowerCase();
    const list = (Array.isArray(names) ? names : []).map(String);
    if (!needle) return list;
    const rank = (name) => {
      const lower = name.toLowerCase();
      if (lower === needle) return 0;
      if (lower.indexOf(needle) === 0) return 1;
      return 2;
    };
    return list
      .map((name, i) => ({ name, r: rank(name), i }))
      .sort((x, y) => (x.r - y.r) || (x.name.length - y.name.length) || (x.i - y.i))
      .map((x) => x.name);
  }

  /** A construct, as js/vector-viewer.js wants it.
   *
   *  The service already shapes `sequence`, `topology` and `features` for
   *  that module, so this is close to a pass-through — it exists so that a
   *  construct with no features, or one the service named oddly, still draws
   *  rather than throwing inside the viewer. */
  function constructPayload(construct) {
    const c = construct || {};
    return {
      name: String(c.name || 'Construct'),
      sequence: String(c.sequence || ''),
      topology: c.topology === 'linear' ? 'linear' : 'circular',
      features: Array.isArray(c.features) ? c.features : [],
    };
  }

  /** The lines worth printing beside the map: what it is made of, and
   *  whether the insert can be cut back out. */
  function summarizeConstruct(construct) {
    const c = construct || {};
    const lines = [];
    const bp = Number(c.length_bp || (c.sequence || '').length);
    lines.push(`${bp} bp, ${c.topology === 'linear' ? 'linear' : 'circular'}`);

    (Array.isArray(c.parts) ? c.parts : []).forEach((p) => {
      lines.push(
        `${p.source} fragment ${p.fragment} · ${p.length_bp} bp · ${p.orientation}`
      );
    });

    (Array.isArray(c.junctions) ? c.junctions : []).forEach((j) => {
      lines.push(
        j.regenerated
          ? `${j.enzyme} (${j.site}) cuts the product ${j.sites_in_product}×: the junction rebuilt the site`
          : `${j.enzyme} (${j.site}) no longer cuts: the insert cannot be cut back out with it`
      );
    });

    return lines;
  }

  function round(value, places) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const f = Math.pow(10, places || 0);
    return Math.round(n * f) / f;
  }

  /** The score, broken into the things it is made of, largest first and
   *  zeroes dropped. A total of 4.8 says nothing; "Tm 3.2, GC clamp 1.0,
   *  Tm difference 0.6" says which knob to turn. */
  const PENALTY_LABELS = {
    tm: 'Tm',
    tm_difference: 'Tm difference',
    gc: 'GC',
    hairpin: 'hairpin',
    dimer: 'dimer',
    product_length: 'product length',
    gc_clamp: 'GC clamp',
    off_target: 'off-target',
  };

  function penaltyParts(penalties) {
    const out = [];
    Object.keys(penalties || {}).forEach((key) => {
      const value = round(penalties[key], 2);
      if (!value) return;                     // 0 and absent read the same
      out.push({ key, label: PENALTY_LABELS[key] || key, value });
    });
    return out.sort((a, b) => b.value - a.value);
  }

  /** One primer pair, flattened into the cells a table shows. */
  function summarizePair(pair, index) {
    const p = pair || {};
    const f = p.forward || {};
    const r = p.reverse || {};
    const primer = (x, role) => ({
      role,
      sequence: String(x.sequence || ''),
      length: Number(x.length || (x.sequence || '').length),
      tm: round(x.tm, 1),
      gc: round(x.gc_percent, 1),
      // 1-based inclusive, which is how a primer is written down. The
      // service reports the same 0-based half-open span js/plasmid.js uses.
      position: `${Number(x.start || 0) + 1}–${Number(x.end || 0)}`,
      strand: Number(x.strand) < 0 ? '-' : '+',
      gcClamp: Boolean(x.gc_clamp),
      hairpinDg: round(x.hairpin_dg, 1),
      bindingSites: Number(x.binding_sites || 0),
    });

    return {
      rank: Number(index || 0) + 1,
      score: round(p.score, 2),
      penalties: penaltyParts(p.penalties),
      productLength: Number(p.product_length || 0),
      productSpan: `${Number(p.product_start || 0) + 1}–${Number(p.product_end || 0)}`,
      tmDifference: round(p.tm_difference, 1),
      heteroDimer: String(p.hetero_dimer_severity || 'none'),
      screened: Boolean(p.screened),
      spuriousAmplicons: Number(p.spurious_amplicons || 0),
      warnings: Array.isArray(p.warnings) ? p.warnings.slice() : [],
      primers: [primer(f, 'forward'), primer(r, 'reverse')],
    };
  }

  /** The conditions the Tm was computed under, as one line.
   *
   *  Biopython's defaults are a hybridisation experiment, not a PCR, and the
   *  difference is around ten degrees — so a quoted Tm without its
   *  conditions is a number nobody can check. */
  function tmConditionsLine(conditions) {
    const c = conditions || {};
    const bits = [];
    if (c.na_mm != null) bits.push(`Na⁺ ${c.na_mm} mM`);
    if (c.mg_mm != null) bits.push(`Mg²⁺ ${c.mg_mm} mM`);
    if (c.dntps_mm != null) bits.push(`dNTPs ${c.dntps_mm} mM`);
    if (c.primer_nm != null) bits.push(`primer ${c.primer_nm} nM`);
    if (c.salt_correction) bits.push(String(c.salt_correction));
    return bits.join(' · ');
  }

  /** The qPCR guidance, flattened to the list of strings a panel prints.
   *  Headings come through as their own line so the sections stay readable
   *  in a plain list. */
  function guidanceLines(guidance) {
    const g = guidance;
    if (!g) return [];
    const lines = [];
    if (g.title) lines.push(String(g.title));
    if (g.summary) lines.push(String(g.summary));
    (Array.isArray(g.sections) ? g.sections : []).forEach((section) => {
      if (section && section.heading) lines.push(String(section.heading));
      (Array.isArray(section && section.rules) ? section.rules : []).forEach((rule) => {
        lines.push(String(rule));
      });
    });
    return lines;
  }

  /* =========================================================================
     the browser half — fetch, and the Supabase session
     ===================================================================== */

  let client = null;

  /** The same client js/data.js builds, from the same two config values.
   *
   *  On notebook.html, where js/data.js is loaded, its client is used
   *  instead — one client per page keeps one session. On a tool page, which
   *  loads neither the notebook nor its data layer, this builds its own and
   *  reads the session the notebook stored: same origin, same localStorage.
   *  Nothing is signed in or out from here. */
  async function supabaseClient() {
    const cfg = (typeof window !== 'undefined' ? window.ELIAS_CONFIG : null) || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return null;
    if (client) return client;
    const mod = await import('https://esm.sh/@supabase/supabase-js@2');
    client = mod.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return client;
  }

  /**
   * The signed-in person's access token, or null.
   *
   * Never the anon key. That key is published in js/config.js and in the
   * HTML of this site; the service rejects it on its claims (role is "anon",
   * there is no `sub`), and sending it would be asking to be refused. The
   * guard below is belt and braces for the case where a future config puts a
   * JWT-shaped key there.
   */
  async function accessToken() {
    const cfg = (typeof window !== 'undefined' ? window.ELIAS_CONFIG : null) || {};

    let token = null;
    if (typeof window !== 'undefined' && window.DB && typeof window.DB.accessToken === 'function') {
      token = await window.DB.accessToken();
    } else {
      const sb = await supabaseClient();
      if (!sb) return null;
      const res = await sb.auth.getSession();
      token = res && res.data && res.data.session ? res.data.session.access_token : null;
    }

    if (!token) return null;
    if (cfg.SUPABASE_ANON_KEY && token === cfg.SUPABASE_ANON_KEY) return null;
    return token;
  }

  /**
   * Whether the panel can be used at all, and why not when it cannot.
   *
   * Called before anything is drawn, so a page never shows a button that
   * cannot work. `kind` is 'ready' | 'unconfigured' | 'signed-out'.
   */
  async function status() {
    const base = baseUrl();
    if (!base) return { kind: 'unconfigured', ready: false, base: '' };
    let token = null;
    try {
      token = await accessToken();
    } catch (err) {
      // A failed CDN import of supabase-js is not a signed-out visitor, but
      // the panel cannot send a request either way and saying "sign in" is
      // the actionable half of it.
      token = null;
    }
    return { kind: token ? 'ready' : 'signed-out', ready: Boolean(token), base };
  }

  async function request(path, options) {
    const opts = options || {};
    const base = baseUrl();
    if (!base) throw ApiError('unconfigured', 'the science service is not configured');

    const token = await accessToken();
    if (!token) throw ApiError('signed-out', 'no Supabase session in this browser');

    const headers = { Authorization: 'Bearer ' + token };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(endpoint(base, path), {
        method: opts.method || (opts.body === undefined ? 'GET' : 'POST'),
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // The service holds no cookies and sets allow_credentials=false;
        // sending credentials would make the browser reject every response.
        credentials: 'omit',
        mode: 'cors',
        signal: opts.signal,
      });
    } catch (err) {
      // fetch rejects the same way for a stopped container and for a CORS
      // preflight the browser refused. describeError names both.
      throw ApiError('network', (err && err.message) || 'the request did not complete');
    }

    if (res.ok) return res.json();

    let payload = null;
    try { payload = await res.json(); } catch (err) { payload = null; }

    if (res.status === 401 || res.status === 403) {
      throw ApiError('unauthorized', detailToSentence(payload, res.status), { status: res.status });
    }
    if (res.status === 400 || res.status === 422) {
      throw ApiError('bad-request', detailToSentence(payload, res.status), { status: res.status });
    }
    throw ApiError('server', detailToSentence(payload, res.status), { status: res.status });
  }

  /* --- the three calls --------------------------------------------------- */

  /* `async` is load-bearing on both of these, not decoration. The request
     builders throw for input that is refused here, and a panel written as
     `call(...).then(ok).catch(show)` would never see a synchronous throw —
     the exception escapes the click handler, nothing is shown, and the
     button stays on "designing…". As async functions they reject instead,
     so refused-here and refused-there arrive at the same place. */
  async function digestLigation(input, options) {
    return request('/api/cloning/digest-ligation', {
      body: cloningRequest(input),
      signal: (options || {}).signal,
    });
  }

  async function designPrimers(input, options) {
    return request('/api/primers/design', {
      body: primerRequest(input),
      signal: (options || {}).signal,
    });
  }

  /** Enzyme names for a picker. REBASE holds ~1,090, so it is searched
   *  rather than sent; `limit` is capped at 200 by the service. */
  async function searchEnzymes(query, options) {
    const q = String(query || '').trim();
    const limit = (options || {}).limit || 200;
    const names = await request(
      `/api/cloning/enzymes?q=${encodeURIComponent(q)}&limit=${limit}`,
      { signal: (options || {}).signal }
    );
    return rankEnzymes(names, q);
  }

  /** What a panel prints when any of the above throws. */
  function explain(err) {
    return describeError(err, {
      base: baseUrl(),
      origin: typeof location !== 'undefined' ? location.origin : '',
    });
  }

  return {
    // pure
    normalizeBaseUrl,
    baseUrl,
    isConfigured,
    endpoint,
    cloningRequest,
    primerRequest,
    cleanEnzymeNames,
    describeError,
    detailToSentence,
    looksLikeRecord,
    rankEnzymes,
    constructPayload,
    summarizeConstruct,
    summarizePair,
    penaltyParts,
    tmConditionsLine,
    guidanceLines,
    InputError,
    ApiError,
    // browser
    accessToken,
    status,
    digestLigation,
    designPrimers,
    searchEnzymes,
    explain,
    LIMITS: {
      MAX_ENZYMES,
      PRODUCT_BP,
      TM_RANGE,
      PAIR_RANGE,
      PURPOSES,
    },
  };
}));
