/* ============================================================
   Elias Lab Notebook — planning a transfection on a page
   ------------------------------------------------------------
   The arithmetic that gets done on the back of a glove box
   before every transfection, and gets done wrong about as often
   as it gets done: how much of each plasmid, at the stock it
   happens to be at today, goes into each group.

   Three tables and a protocol, in the order the work happens:

     1  DNA per well   how many ng of each plasmid each group
                       gets. Rows are groups, columns are
                       plasmids; add as many of either as the
                       experiment needs.
     2  The plasmids   and what they actually measured at, which
                       is the number that changes between
                       preps and makes last month's volumes
                       wrong.
     3  Volumes        ng ÷ ng/µL × the wells in the group. This
                       is the only table that gets carried to
                       the bench, so it also carries the lipid,
                       the medium and what goes on the cells.

   The protocol underneath is the same numbers written as steps,
   with the tubes named the way the reagent's own manual names
   them.

   Nothing here is stored as a result: the block keeps what was
   typed, and every number is worked out again when it opens. A
   concentration corrected after a re-measure therefore corrects
   every volume in the entry at once, which is the whole reason
   it is a block rather than a table somebody typed.
   ============================================================ */
(function () {
  'use strict';

  /* What each reagent asks for per well, by plate format. The DNA is the
     total across every plasmid in the group; `medium` is per tube, so a
     two-tube reagent uses it twice; `add` is what ends up on the cells.

     Lipofectamine's two tubes (lipid in one, DNA in the other, combined
     after) and jetOPTIMUS's single tube are genuinely different workflows,
     so the protocol below branches on `tubes` rather than pretending they
     are the same procedure with different numbers. */
  var REAGENTS = {
    lipostem: {
      name: 'Lipofectamine Stem', medium: 'Opti-MEM I', tubes: 2, p3000: false,
      source: 'Thermo Fisher Lipofectamine Stem user guide (MAN0017080), low end of each range',
      /* The guide gives a range per well — 96: 50–100 ng with 0.2–0.4 µL,
         24: 250–500 ng with 1–2 µL, 6: 1.25–2.5 µg with 5–10 µL — and the
         numbers here are the top of the DNA range with the bottom of the
         lipid range, which is where the lab's own iPSC transfections sit.
         12-well and the 10 cm dish are not in the guide and are scaled from
         the 24-well by area. */
      per: {
        '96': { dna: 100, reagent: 0.2, medium: 5, add: 10 },
        '24': { dna: 500, reagent: 1, medium: 25, add: 50 },
        '12': { dna: 1000, reagent: 2, medium: 50, add: 100 },
        '6': { dna: 2000, reagent: 5, medium: 100, add: 200 },
        '10cm': { dna: 10000, reagent: 25, medium: 500, add: 1000 }
      }
    },
    lipo3000: {
      name: 'Lipofectamine 3000', medium: 'Opti-MEM I', tubes: 2, p3000: true,
      source: 'Thermo Fisher Lipofectamine 3000 protocol (MAN0009872), the higher of its two doses',
      per: {
        '96': { dna: 100, reagent: 0.3, medium: 5, add: 10 },
        '24': { dna: 500, reagent: 1.5, medium: 25, add: 50 },
        '12': { dna: 1000, reagent: 3, medium: 50, add: 100 },
        '6': { dna: 2500, reagent: 7.5, medium: 125, add: 250 },
        '10cm': { dna: 12500, reagent: 37.5, medium: 625, add: 1250 }
      }
    },
    jetoptimus: {
      name: 'jetOPTIMUS', medium: 'jetOPTIMUS buffer', tubes: 1, p3000: false,
      source: 'Polyplus jetOPTIMUS protocol, 1 µL reagent per µg DNA',
      per: {
        '96': { dna: 100, reagent: 0.1, medium: 10, add: 10 },
        '24': { dna: 500, reagent: 0.5, medium: 50, add: 50 },
        '12': { dna: 1000, reagent: 1, medium: 100, add: 100 },
        '6': { dna: 2000, reagent: 2, medium: 200, add: 200 },
        '10cm': { dna: 10000, reagent: 10, medium: 1000, add: 1000 }
      }
    }
  };
  var REAGENT_ORDER = ['lipostem', 'lipo3000', 'jetoptimus'];
  var FORMATS = { '96': '96-well', '24': '24-well', '12': '12-well', '6': '6-well', '10cm': '10 cm dish' };
  var FORMAT_ORDER = ['96', '24', '12', '6', '10cm'];
  // Below this, a volume is smaller than most people can pipette honestly.
  var TINY = 0.5;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d || 0); }
  // Volumes are read off a pipette, so two decimals below a microlitre and
  // one above it — more digits than that is arithmetic, not a measurement.
  function vol(v) {
    if (!isFinite(v)) return '—';
    if (v === 0) return '0';
    return v < 1 ? String(Math.round(v * 100) / 100) : String(Math.round(v * 10) / 10);
  }
  function ng(v) { return isFinite(v) ? String(Math.round(v * 10) / 10) : '—'; }

  function spec(st) {
    var r = REAGENTS[st.reagent] || REAGENTS.lipostem;
    return { r: r, per: r.per[st.format] || r.per['24'] };
  }

  function blank() {
    return {
      title: '', format: '24', reagent: 'lipostem', reps: 3, extra: 0, perWell: 500,
      plasmids: [{ name: '', conc: 0 }, { name: '', conc: 0 }],
      groups: [{ name: 'Untransfected', ng: [0, 0] }, { name: '', ng: [0, 0] }]
    };
  }

  /* Rebuilt defensively: the state comes back out of the page's own HTML,
     which has been through the sanitiser and may have been edited by hand. */
  function load(raw) {
    var st;
    try { st = JSON.parse(raw || 'null'); } catch (e) { return null; }
    if (!st || typeof st !== 'object') return null;
    var out = {
      title: String(st.title || '').slice(0, 120),
      format: FORMATS[st.format] ? st.format : '24',
      reagent: REAGENTS[st.reagent] ? st.reagent : 'lipostem',
      reps: Math.max(1, Math.round(num(st.reps, 3))),
      extra: Math.max(0, num(st.extra, 0)),
      perWell: Math.max(0, num(st.perWell, 500)),
      plasmids: (Array.isArray(st.plasmids) ? st.plasmids : []).slice(0, 24).map(function (p) {
        p = p || {};
        return { name: String(p.name || '').slice(0, 80), conc: Math.max(0, num(p.conc)) };
      })
    };
    if (!out.plasmids.length) out.plasmids = [{ name: '', conc: 0 }];
    out.groups = (Array.isArray(st.groups) ? st.groups : []).slice(0, 60).map(function (g) {
      g = g || {};
      var row = out.plasmids.map(function (_, i) { return Math.max(0, num((g.ng || [])[i])); });
      return { name: String(g.name || '').slice(0, 80), ng: row };
    });
    if (!out.groups.length) out.groups = [{ name: '', ng: out.plasmids.map(function () { return 0; }) }];
    return out;
  }

  // ---- the arithmetic ----
  /* Everything the three tables and the protocol need, worked out once.
     Volumes are per group, not per well: a group is mixed in one tube and
     split across its wells, which is how it is actually done and why the
     tube has to hold the replicates and the extra together. */
  function compute(st) {
    var s = spec(st), f = 1 + st.extra / 100;
    var wells = st.reps * f;
    var rows = st.groups.map(function (g) {
      var totalNg = 0, vols = [], short = false;
      st.plasmids.forEach(function (p, i) {
        var amount = num(g.ng[i]);
        totalNg += amount;
        var v = p.conc > 0 ? (amount * wells) / p.conc : null;
        if (v != null && v > 0 && v < TINY) short = true;
        vols.push(v);
      });
      var dnaVol = vols.reduce(function (a, v) { return a + (v || 0); }, 0);
      var tubeMedium = s.per.medium * wells;
      return {
        g: g, totalNg: totalNg, vols: vols, dnaVol: dnaVol, short: short,
        unknown: st.plasmids.some(function (p, i) { return num(g.ng[i]) > 0 && !(p.conc > 0); }),
        tubeMedium: tubeMedium,
        // The DNA has to fit in the tube it is diluted into.
        overflow: totalNg > 0 && dnaVol > tubeMedium,
        p3000: s.r.p3000 ? (totalNg * wells / 1000) * 2 : 0,
        off: st.perWell > 0 && totalNg > 0 && Math.abs(totalNg - st.perWell) > 0.5
      };
    });
    return {
      s: s, wells: wells, rows: rows,
      reagentPer: s.per.reagent * wells, mediumPer: s.per.medium * wells, addPer: s.per.add,
      used: rows.filter(function (r) { return r.totalNg > 0; }).length,
      totalWells: st.groups.length * st.reps
    };
  }

  // ---- the block on the page ----
  function render(block) {
    var st = block._tfx, k = compute(st), s = k.s;
    function opt(v, label, on) { return '<option value="' + esc(v) + '"' + (on ? ' selected' : '') + '>' + esc(label) + '</option>'; }

    var head = '<div class="ln-calc-head"><div>' +
      '<input class="tfx-title" data-k="title" value="' + esc(st.title) + '" placeholder="Transfection plan">' +
      '<span>' + esc(s.r.name) + ' · ' + esc(FORMATS[st.format]) + ' · ' + st.groups.length + ' group' +
        (st.groups.length === 1 ? '' : 's') + ' × ' + st.reps + ' well' + (st.reps === 1 ? '' : 's') +
        ' = ' + k.totalWells + ' wells</span></div>' +
      '<button type="button" class="ln-calc-x" data-act="remove" title="Remove this plan">✕</button></div>';

    var ctrls = '<div class="ln-calc-ctrls">' +
      '<label>Plate<select data-k="format">' + FORMAT_ORDER.map(function (f) { return opt(f, FORMATS[f], f === st.format); }).join('') + '</select></label>' +
      '<label>Reagent<select data-k="reagent">' + REAGENT_ORDER.map(function (r) { return opt(r, REAGENTS[r].name, r === st.reagent); }).join('') + '</select></label>' +
      '<label>Wells per group<input type="number" min="1" step="1" data-k="reps" value="' + esc(String(st.reps)) + '"></label>' +
      '<label>Extra %<input type="number" min="0" step="1" data-k="extra" value="' + esc(String(st.extra)) + '"></label>' +
      '<label>DNA per well (ng)<input type="number" min="0" step="any" data-k="perWell" value="' + esc(String(st.perWell)) + '"></label>' +
      '</div>';

    // ---- 1. DNA per well ----
    var t1 = '<div class="tfx-sec">1 · DNA per well (ng)</div>' +
      '<div class="ln-calc-scroll"><table class="ln-calc-tbl tfx-tbl tfx-t1"><thead><tr><th>Group</th>' +
      st.plasmids.map(function (p, i) { return '<th>' + esc(p.name || 'Plasmid ' + (i + 1)) + '</th>'; }).join('') +
      '<th>Total</th><th></th></tr></thead><tbody>' +
      st.groups.map(function (g, gi) {
        var r = k.rows[gi];
        return '<tr><td><input data-gi="' + gi + '" data-f="name" value="' + esc(g.name) + '" placeholder="e.g. TwinPE + Donor"></td>' +
          st.plasmids.map(function (p, pi) {
            return '<td class="num"><input type="number" min="0" step="any" class="num" data-gi="' + gi + '" data-pi="' + pi + '" value="' +
              esc(String(g.ng[pi] || 0)) + '"></td>';
          }).join('') +
          '<td class="num total' + (r.off ? ' warn' : '') + '">' + ng(r.totalNg) + ' ng</td>' +
          '<td><button type="button" class="ln-calc-x sm" data-act="delgroup" data-gi="' + gi + '" title="Remove this group">✕</button></td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="ln-calc-foot"><span>' +
        (k.rows.some(function (r) { return r.off; })
          ? '<span class="warn">A group marked in red does not add up to ' + ng(st.perWell) + ' ng.</span>'
          : 'Rows are groups, columns are plasmids. Add as many of either as the experiment needs.') +
      '</span><button type="button" class="tbl-btn" data-act="addgroup">+ Group</button>' +
      '<button type="button" class="tbl-btn" data-act="addplasmid">+ Plasmid</button></div>';

    // ---- 2. the plasmids ----
    var lab = labPlasmids();
    var t2 = '<div class="tfx-sec">2 · The plasmids, as measured</div>' +
      '<div class="ln-calc-scroll"><table class="ln-calc-tbl tfx-tbl"><thead><tr><th>Plasmid</th><th>Concentration</th><th>In the lab’s list</th><th></th></tr></thead><tbody>' +
      st.plasmids.map(function (p, pi) {
        return '<tr><td><input data-pi="' + pi + '" data-f="name" value="' + esc(p.name) + '" placeholder="e.g. pCMV-PE6c (p38)"></td>' +
          '<td class="num"><input type="number" min="0" step="any" class="num" data-pi="' + pi + '" data-f="conc" value="' +
            esc(String(p.conc || '')) + '" placeholder="0"> ng/µL</td>' +
          '<td>' + (lab.length
            ? '<select data-pi="' + pi + '" data-f="pick"><option value="">— choose to fill in —</option>' +
              lab.map(function (x, i) { return '<option value="' + i + '">' + esc(x.name) + (x.conc ? ' · ' + x.conc + ' ng/µL' : ' · no concentration recorded') + '</option>'; }).join('') +
              '</select>'
            : '<span class="hint">nothing in the inventory yet</span>') + '</td>' +
          '<td><button type="button" class="ln-calc-x sm" data-act="delplasmid" data-pi="' + pi + '" title="Remove this plasmid">✕</button></td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="ln-calc-foot"><span>The concentration of the prep you are using today. Correct it here and every volume below follows.</span>' +
      '<button type="button" class="tbl-btn" data-act="addplasmid">+ Plasmid</button></div>';

    block.innerHTML = head + ctrls + t1 + t2 + '<div class="tfx-derived">' + derivedHtml(st, k) + '</div>';
  }

  /* Section 3 and the protocol: everything that is only worked out, with no
     field anybody types into. Kept apart so that typing a number can redraw
     it without touching the tables above, where the caret is. */
  function derivedHtml(st, k) {
    var s = k.s;
    var t3 = '<div class="tfx-sec">3 · What to pipette, per group (µL)</div>' +
      '<div class="ln-calc-scroll"><table class="ln-calc-tbl tfx-tbl"><thead><tr><th>Group</th>' +
      st.plasmids.map(function (p, i) { return '<th>' + esc(p.name || 'Plasmid ' + (i + 1)) + '</th>'; }).join('') +
      '<th>DNA total</th><th>' + esc(s.r.medium) + '</th>' + (s.r.p3000 ? '<th>P3000</th>' : '') + '</tr></thead><tbody>' +
      st.groups.map(function (g, gi) {
        var r = k.rows[gi];
        if (!r.totalNg) {
          return '<tr class="muted"><td>' + esc(g.name || 'Group ' + (gi + 1)) + '</td>' +
            st.plasmids.map(function () { return '<td class="num">—</td>'; }).join('') +
            '<td class="num">—</td><td class="num">—</td>' + (s.r.p3000 ? '<td class="num">—</td>' : '') + '</tr>';
        }
        return '<tr><td>' + esc(g.name || 'Group ' + (gi + 1)) + '</td>' +
          r.vols.map(function (v, i) {
            if (!num(g.ng[i])) return '<td class="num">—</td>';
            if (v == null) return '<td class="num warn" title="This plasmid has no concentration yet">?</td>';
            return '<td class="num' + (v < TINY ? ' warn' : '') + '"' + (v < TINY ? ' title="Under ' + TINY + ' µL — dilute the stock first"' : '') + '>' + vol(v) + '</td>';
          }).join('') +
          '<td class="num total">' + vol(r.dnaVol) + '</td>' +
          '<td class="num' + (r.overflow ? ' warn' : '') + '">' + vol(Math.max(0, r.tubeMedium - (s.r.tubes === 1 ? r.dnaVol : 0))) + '</td>' +
          (s.r.p3000 ? '<td class="num">' + vol(r.p3000) + '</td>' : '') +
          '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="ln-calc-foot"><span>' +
        'Each volume covers <strong>' + st.reps + '</strong> well' + (st.reps === 1 ? '' : 's') +
        (st.extra ? ' plus ' + ng(st.extra) + '% extra' : '') + '. ' +
        (k.rows.some(function (r) { return r.short; }) ? '<span class="warn">A volume under ' + TINY + ' µL cannot be pipetted — dilute that stock.</span> ' : '') +
        (k.rows.some(function (r) { return r.overflow; }) ? '<span class="warn">A DNA mix is larger than the tube it is diluted into.</span> ' : '') +
        (k.rows.some(function (r) { return r.unknown; }) ? '<span class="warn">A plasmid in use has no concentration.</span>' : '') +
      '</span></div>';
    return t3 + protocolHtml(st, k);
  }

  /* The same numbers as steps, in the reagent's own words. Written out
     rather than linked to, because this is what gets read at the hood with
     gloves on, and a step that says "as calculated above" is a step that
     gets guessed. */
  function protocolHtml(st, k) {
    var s = k.s, r = s.r, out = [];
    var mediumPer = vol(k.mediumPer), reagentPer = vol(k.reagentPer);
    out.push('Warm the medium and bring the reagent to room temperature. Vortex the reagent 5 s and spin it down; do the same with the plasmid tubes.');
    if (r.tubes === 2) {
      out.push('<strong>Tube A (lipid)</strong>, one per group: <strong>' + reagentPer + ' µL</strong> ' + esc(r.name) +
        ' in <strong>' + mediumPer + ' µL</strong> ' + esc(r.medium) + '. Mix.');
      out.push('<strong>Tube B (DNA)</strong>, one per group: the plasmid volumes from table 3, made up to <strong>' +
        mediumPer + ' µL</strong> with ' + esc(r.medium) +
        (r.p3000 ? ', plus the P3000 in the last column' : '') + '. Mix.');
      out.push('Add tube A to tube B — lipid into DNA, not the other way round. Vortex briefly and spin down.');
      out.push('Leave <strong>10–15 min</strong> at room temperature.');
      out.push('Add <strong>' + vol(k.addPer) + ' µL</strong> of the complex to each well, dropwise onto the medium already there. Rock the plate back and forth and side to side.');
    } else {
      out.push('<strong>One tube per group</strong>: the plasmid volumes from table 3 in <strong>' + mediumPer + ' µL</strong> ' +
        esc(r.medium) + ' (the kit’s own buffer, not a serum-free medium). Vortex 10 s and spin down.');
      out.push('Add <strong>' + reagentPer + ' µL</strong> ' + esc(r.name) + ' reagent to the tube. Vortex 10 s immediately — do not pipette up and down. Spin down.');
      out.push('Leave <strong>10 min</strong> at room temperature.');
      out.push('Add <strong>' + vol(k.addPer) + ' µL</strong> per well, dropwise, and rock the plate.');
    }
    out.push('Return the plate to the incubator (37 °C, 5% CO₂). No medium change is needed unless the cells look unhappy the next morning.');
    return '<div class="tfx-sec">4 · The protocol</div><ol class="tfx-steps">' +
      out.map(function (line) { return '<li>' + line + '</li>'; }).join('') + '</ol>' +
      '<div class="ln-calc-note">' + esc(r.source) + '. The per-well amounts are the manufacturer’s starting point for ' +
      esc(FORMATS[st.format]) + ': ' + ng(s.per.dna) + ' ng DNA, ' + vol(s.per.reagent) + ' µL reagent, ' +
      vol(s.per.medium) + ' µL ' + esc(r.medium) + (r.tubes === 2 ? ' per tube' : '') + '. ' +
      'Worth testing two doses on a cell line you have not transfected before.</div>';
  }

  /* The lab's own plasmids, for filling a row in without typing. The
     concentration is stored as whatever somebody typed — "285", "285 ng/µL",
     "~300" — so the number is taken off the front and the rest ignored. */
  function labPlasmids() {
    try {
      var inv = window.getInventory && window.getInventory();
      if (!inv || !Array.isArray(inv.plasmids)) return [];
      return inv.plasmids.filter(function (p) { return p && p.name; }).map(function (p) {
        var m = /-?\d+(\.\d+)?/.exec(String(p.concentration || ''));
        return { name: p.name, conc: m ? Math.max(0, parseFloat(m[0])) : 0 };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (e) { return []; }
  }

  function handle(e) {
    var block = e.target.closest && e.target.closest('.ln-tfx');
    if (!block || !block._tfx) return;
    var st = block._tfx, el = e.target;

    if (e.type === 'click') {
      var act = el.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'remove') {
        if (confirm('Remove this transfection plan from the page?')) { block.remove(); mark(); }
        return;
      }
      if (a === 'addgroup') st.groups.push({ name: '', ng: st.plasmids.map(function () { return 0; }) });
      if (a === 'delgroup') {
        if (st.groups.length < 2) return;
        st.groups.splice(+act.dataset.gi, 1);
      }
      if (a === 'addplasmid') {
        st.plasmids.push({ name: '', conc: 0 });
        st.groups.forEach(function (g) { g.ng.push(0); });
      }
      if (a === 'delplasmid') {
        if (st.plasmids.length < 2) return;
        var pi = +act.dataset.pi;
        st.plasmids.splice(pi, 1);
        st.groups.forEach(function (g) { g.ng.splice(pi, 1); });
      }
      render(block); mark();
      return;
    }

    // Choosing a plasmid from the lab's list fills the row and redraws.
    if (el.dataset.f === 'pick') {
      var chosen = labPlasmids()[+el.value];
      if (chosen) {
        var p = st.plasmids[+el.dataset.pi];
        p.name = chosen.name;
        if (chosen.conc) p.conc = chosen.conc;
      }
      render(block); mark();
      return;
    }
    if (el.dataset.k) {
      var key = el.dataset.k;
      if (key === 'title') { st.title = el.value; mark(); return; }   // no redraw: it is being typed in
      if (key === 'reps') st.reps = Math.max(1, Math.round(num(el.value, 1)));
      else if (key === 'extra') st.extra = Math.max(0, num(el.value));
      else if (key === 'perWell') st.perWell = Math.max(0, num(el.value));
      else if (key === 'format') {
        st.format = FORMATS[el.value] ? el.value : st.format;
        // The target follows the plate unless somebody has already set it.
        var was = spec(st);
        st.perWell = was.per.dna;
      } else if (key === 'reagent') st.reagent = REAGENTS[el.value] ? el.value : st.reagent;
      render(block); mark();
      return;
    }
    // A cell: a group's name, a plasmid's name or concentration, or an amount.
    if (el.dataset.gi != null && el.dataset.pi != null) {
      st.groups[+el.dataset.gi].ng[+el.dataset.pi] = Math.max(0, num(el.value));
      refresh(block); mark(); return;
    }
    if (el.dataset.gi != null && el.dataset.f === 'name') { st.groups[+el.dataset.gi].name = el.value; mark(); return; }
    if (el.dataset.pi != null && el.dataset.f === 'conc') {
      st.plasmids[+el.dataset.pi].conc = Math.max(0, num(el.value));
      refresh(block); mark(); return;
    }
    if (el.dataset.pi != null && el.dataset.f === 'name') { st.plasmids[+el.dataset.pi].name = el.value; mark(); return; }
  }

  /* Typing in a number must not redraw the table under the caret, so only
     the totals and the derived half are rewritten. */
  function refresh(block) {
    var st = block._tfx, k = compute(st);
    var totals = block.querySelectorAll('.tfx-t1 tbody td.total');
    st.groups.forEach(function (g, gi) {
      var cell = totals[gi];
      if (cell) { cell.textContent = ng(k.rows[gi].totalNg) + ' ng'; cell.className = 'num total' + (k.rows[gi].off ? ' warn' : ''); }
    });
    var box = block.querySelector('.tfx-derived');
    if (box) box.innerHTML = derivedHtml(st, k); else render(block);
  }

  function mark() { if (window.markEntryDirty) window.markEntryDirty(); }

  function hydrate(root) {
    root.querySelectorAll('.ln-tfx').forEach(function (block) {
      if (block._tfx) return;
      var st = load(block.getAttribute('data-tfx'));
      if (!st) return;              // unreadable: the saved tables stay as they are
      block._tfx = st;
      block.setAttribute('contenteditable', 'false');
      render(block);
    });
  }

  /* For saving: the state, and plain tables under it, so the entry still
     reads as a transfection plan to anyone opening it without this app. */
  function snapshot(block) {
    var st = block._tfx, k = compute(st), s = k.s;
    block.setAttribute('data-tfx', JSON.stringify(st));
    block.removeAttribute('contenteditable');
    var cols = st.plasmids.map(function (p, i) { return p.name || 'Plasmid ' + (i + 1); });
    var out = '<p><strong>' + esc(st.title || 'Transfection plan') + '</strong> — ' + esc(s.r.name) + ', ' +
      esc(FORMATS[st.format]) + ', ' + st.groups.length + ' group' + (st.groups.length === 1 ? '' : 's') +
      ' × ' + st.reps + ' well' + (st.reps === 1 ? '' : 's') + (st.extra ? ' + ' + ng(st.extra) + '% extra' : '') + '</p>';

    out += '<p>DNA per well (ng)</p><table><thead><tr><th>Group</th>' +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '<th>Total</th></tr></thead><tbody>' +
      st.groups.map(function (g, gi) {
        return '<tr><td>' + esc(g.name || 'Group ' + (gi + 1)) + '</td>' +
          g.ng.map(function (v) { return '<td>' + (v ? ng(v) : '—') + '</td>'; }).join('') +
          '<td>' + ng(k.rows[gi].totalNg) + '</td></tr>';
      }).join('') + '</tbody></table>';

    out += '<p>Plasmids</p><table><thead><tr><th>Plasmid</th><th>ng/µL</th></tr></thead><tbody>' +
      st.plasmids.map(function (p, i) {
        return '<tr><td>' + esc(p.name || 'Plasmid ' + (i + 1)) + '</td><td>' + (p.conc ? ng(p.conc) : '—') + '</td></tr>';
      }).join('') + '</tbody></table>';

    out += '<p>Volumes per group (µL)</p><table><thead><tr><th>Group</th>' +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
      '<th>DNA total</th><th>' + esc(s.r.medium) + '</th>' + (s.r.p3000 ? '<th>P3000</th>' : '') + '</tr></thead><tbody>' +
      st.groups.map(function (g, gi) {
        var r = k.rows[gi];
        return '<tr><td>' + esc(g.name || 'Group ' + (gi + 1)) + '</td>' +
          r.vols.map(function (v, i) { return '<td>' + (!num(g.ng[i]) ? '—' : v == null ? '?' : vol(v)) + '</td>'; }).join('') +
          '<td>' + (r.totalNg ? vol(r.dnaVol) : '—') + '</td>' +
          '<td>' + (r.totalNg ? vol(Math.max(0, r.tubeMedium - (s.r.tubes === 1 ? r.dnaVol : 0))) : '—') + '</td>' +
          (s.r.p3000 ? '<td>' + (r.totalNg ? vol(r.p3000) : '—') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table>';

    var steps = document.createElement('div');
    steps.innerHTML = protocolHtml(st, k);   // the steps alone, not the live tables
    var ol = steps.querySelector('ol'), note = steps.querySelector('.ln-calc-note');
    out += '<p>Protocol</p>' + (ol ? ol.outerHTML : '') + (note ? '<p>' + note.innerHTML + '</p>' : '');
    block.innerHTML = out;
  }

  window.LabTransfect = {
    REAGENTS: REAGENTS, FORMATS: FORMATS,
    blank: blank, load: load, compute: compute,
    render: render, hydrate: hydrate, snapshot: snapshot, handle: handle
  };
  if (typeof module === 'object' && module.exports) module.exports = window.LabTransfect;   // tests
})();
