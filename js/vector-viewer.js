/* ===========================================================================
   vector-viewer.js — interactive plasmid maps, linear and circular

   Wraps SeqViz (vendored at vendor/seqviz.min.js, v3.10.25) behind a small
   API that takes the lab's own JSON and gives back selection events with the
   bases already sliced out.

   A note on the word "canvas": SeqViz draws SVG, not <canvas>. That is the
   better primitive here — every base, annotation and tick stays a real DOM
   node, so selection, text search, zoom and printing work without
   reimplementing hit-testing against pixels. Nothing below needs a <canvas>
   element and passing one will not work.

   Why there is a pure half and a DOM half
   ---------------------------------------
   Everything above `createViewer` touches neither the document nor SeqViz,
   so it runs in Node and is tested there by scripts/check-vector-viewer.mjs.
   That is where the bugs actually live: coordinate conventions, origin
   wrapping, and payloads from three different sources that spell the same
   field three different ways. The DOM half is thin on purpose.

   Coordinates
   -----------
   SeqViz reports selections as 0-based half-open [start, end), and when the
   selection crosses the origin of a circular plasmid it reports start > end.
   That is the same convention js/plasmid.js already uses, so no translation
   is needed between them — but biologists read 1-based inclusive, so every
   selection carries both and the UI shows the 1-based pair.
   ======================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;  // tests
  else root.VectorViewer = api;                                            // browser
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* --- palette ----------------------------------------------------------
     Colour by what a feature *is*. A map where every arrow is the same blue
     tells you where things are but not what they are, and the three kinds
     people scan for first — what drives it, what it tags, what selects it —
     should be distinguishable at a glance without reading any label. */
  const TYPE_COLORS = {
    promoter:        '#2f9e44',
    terminator:      '#e03131',
    cds:             '#1f6feb',
    gene:            '#1f6feb',
    tag:             '#9c36b5',
    selection:       '#f08c00',   // selection marker
    resistance:      '#f08c00',
    marker:          '#f08c00',
    origin:          '#0c8599',
    rep_origin:      '#0c8599',
    primer:          '#868e96',
    primer_bind:     '#868e96',
    grna:            '#ff922b',
    pegrna:          '#f76707',
    rbs:             '#66a80f',
    misc_feature:    '#5c7cfa',
    source:          '#adb5bd',
  };
  const DEFAULT_COLOR = TYPE_COLORS.misc_feature;

  /* Words that show up in real GenBank files for the same idea. Checked as
     substrings so "AmpR resistance marker" and "ampicillin_resistance" land
     on the same colour. */
  const TYPE_ALIASES = [
    [/promot/i,                       'promoter'],
    [/termin/i,                       'terminator'],
    [/resist|select|marker|ampr|kanr|neor|puro|bsd|hygro/i, 'selection'],
    [/\btag\b|his6|flag|myc|\bha\b|gfp|mcherry|egfp|strep/i, 'tag'],
    [/ori\b|origin|rep_origin/i,      'origin'],
    [/primer/i,                       'primer'],
    [/\brbs\b|ribosome/i,             'rbs'],
    [/pegrna|prime.?edit/i,           'pegrna'],
    [/grna|sgrna|guide|crispr|spacer|protospacer/i, 'grna'],
    [/\bcds\b|\bgene\b|\borf\b/i,     'cds'],
  ];

  function colorFor(feature) {
    if (feature.color) return feature.color;
    const hay = [feature.type, feature.type_key, feature.kind, feature.name]
      .filter(Boolean).join(' ');
    const exact = TYPE_COLORS[String(feature.type || feature.type_key || '').toLowerCase()];
    if (exact) return exact;
    for (const [re, key] of TYPE_ALIASES) if (re.test(hay)) return TYPE_COLORS[key];
    return DEFAULT_COLOR;
  }

  /* --- sequence helpers -------------------------------------------------- */

  const COMPLEMENT = {
    A: 'T', T: 'A', G: 'C', C: 'G', U: 'A', N: 'N',
    R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
    B: 'V', V: 'B', D: 'H', H: 'D',
  };

  function revComp(seq) {
    let out = '';
    for (let i = seq.length - 1; i >= 0; i--) out += COMPLEMENT[seq[i]] || 'N';
    return out;
  }

  function gcPercent(seq) {
    if (!seq.length) return 0;
    let gc = 0;
    for (const base of seq) if (base === 'G' || base === 'C' || base === 'S') gc++;
    return Math.round((gc / seq.length) * 1000) / 10;
  }

  /* --- payload normalisation --------------------------------------------
     Three sources feed this: the ELN API, a GenBank or SnapGene file parsed
     by js/plasmid.js, and whatever a person pastes in. They disagree about
     field names, so the disagreement is resolved here, once, instead of at
     every call site. */

  function firstOf(obj, names) {
    for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
    return undefined;
  }

  /** Normalise one feature. Returns null when it cannot be placed, with the
   *  reason pushed onto `warnings` — a feature with impossible coordinates is
   *  dropped rather than silently clamped, because a marker drawn in the
   *  wrong place is worse than one that is missing. */
  function normalizeFeature(raw, seqLength, warnings) {
    const name = String(firstOf(raw, ['name', 'label', 'title']) ?? '').trim() || 'unnamed';
    const start = Number(firstOf(raw, ['start', 'start_pos', 'from', 'begin']));
    const end = Number(firstOf(raw, ['end', 'end_pos', 'to', 'finish']));

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      warnings.push(`"${name}": start and end must be whole numbers`);
      return null;
    }
    if (start < 0 || end < 0 || start > seqLength || end > seqLength) {
      warnings.push(`"${name}": ${start}–${end} lies outside a ${seqLength} bp sequence`);
      return null;
    }

    // strand: 1 / -1, or a boolean/string from other tools.
    let direction = firstOf(raw, ['direction', 'strand']);
    if (direction === undefined) direction = 1;
    if (typeof direction === 'string') {
      direction = direction === '-' || direction === 'reverse' || direction === '-1' ? -1 : 1;
    }
    direction = Number(direction) < 0 ? -1 : 1;

    return {
      name,
      start,
      end,
      direction,
      color: colorFor(raw),
      type: String(firstOf(raw, ['type', 'type_key', 'kind']) ?? 'misc_feature'),
    };
  }

  /**
   * Turn a lab payload into the props SeqViz wants.
   *
   * Accepts, for the sequence: seq | sequence | bases.
   * Accepts, for the features: features | annotations | feature_list.
   * Topology from: circular (bool) | topology ("circular"/"linear").
   *
   * Returns { name, seq, circular, annotations, warnings }. It never throws
   * for bad features — they land in `warnings` so the caller can show them —
   * but it does throw for a missing or non-DNA sequence, because there is
   * nothing to draw and carrying on would render an empty map that looks
   * like a loading state.
   */
  function normalizePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new TypeError('payload must be an object');

    const rawSeq = firstOf(payload, ['seq', 'sequence', 'bases']);
    if (typeof rawSeq !== 'string' || !rawSeq.trim()) {
      throw new TypeError('payload needs a DNA sequence in "seq" (or "sequence")');
    }
    // Tolerate what people paste: FASTA line breaks, spaces, and the digits
    // GenBank puts at the start of each line.
    const seq = rawSeq.replace(/[\s\d]/g, '').toUpperCase();
    if (!/^[ACGTURYSWKMBDHVN]+$/.test(seq)) {
      const bad = Array.from(new Set(seq.replace(/[ACGTURYSWKMBDHVN]/g, ''))).join('');
      throw new TypeError(`sequence contains non-DNA characters: ${bad}`);
    }

    const warnings = [];
    const rawFeatures = firstOf(payload, ['features', 'annotations', 'feature_list']) || [];
    if (!Array.isArray(rawFeatures)) {
      warnings.push('features must be an array; ignoring it');
    }

    const annotations = (Array.isArray(rawFeatures) ? rawFeatures : [])
      .map((f) => normalizeFeature(f, seq.length, warnings))
      .filter(Boolean);

    let circular = firstOf(payload, ['circular']);
    if (circular === undefined) {
      const topology = String(firstOf(payload, ['topology']) ?? '').toLowerCase();
      circular = topology ? topology === 'circular' : true;   // plasmids usually are
    }

    return {
      name: String(firstOf(payload, ['name', 'title']) ?? 'Unnamed construct'),
      seq,
      circular: Boolean(circular),
      annotations,
      warnings,
    };
  }

  /* --- selections -------------------------------------------------------- */

  /**
   * The bases a selection covers.
   *
   * SeqViz does not include the sequence in its selection event — only the
   * coordinates — so this is what turns "bases 104 to 6" into actual letters.
   * When start > end the selection wrapped past the origin, and the answer is
   * the tail followed by the head; slicing naively there returns the empty
   * string, which looks like "nothing selected" rather than like a bug.
   */
  function sliceSelection(seq, start, end) {
    if (!seq) return '';
    if (start === end) return '';
    if (start < end) return seq.slice(start, end);
    return seq.slice(start) + seq.slice(0, end);           // crosses the origin
  }

  /**
   * SeqViz reports start > end for two situations that mean opposite things:
   *
   *     across the origin       { start: 480, end: 20,  length: 44  }   // 504 bp
   *     reverse-strand feature  { start: 420, end: 309, length: 111 }
   *
   * Only `length` tells them apart: a wrap covers seqLen - start + end bases,
   * a reverse-strand feature covers start - end, and it is simply reported
   * 3' to 5'. Reading the second as the first is not a near miss — it returns
   * the whole rest of the plasmid instead of the gene, and nearly every
   * plasmid carries a resistance marker on the reverse strand.
   *
   * With no `length` to go on, start > end is taken as a wrap, which is what
   * it means for a drag.
   */
  function orient(seq, sel) {
    const start = Number(sel.start) || 0;
    const end = Number(sel.end) || 0;
    if (start <= end) return { start, end, reversed: false };
    const reported = Number(sel.length);
    const wrapped = seq.length - start + end;
    if (Number.isFinite(reported) && reported !== wrapped && reported === start - end) {
      return { start: end, end: start, reversed: true };
    }
    return { start, end, reversed: false };
  }

  /**
   * Everything worth showing about a selection: both coordinate conventions,
   * the bases, and the numbers somebody would otherwise work out by hand.
   */
  function describeSelection(seq, selection) {
    const sel = selection || {};
    const { start, end, reversed } = orient(seq, sel);
    const bases = sliceSelection(seq, start, end);
    // end === 0 with a non-zero start is "runs to the end of the sequence",
    // not a wrap back to base 1: the slice stops at the end either way, and
    // calling it a wrap would print "105–0", which is not a coordinate.
    const crossesOrigin = start > end && end !== 0;

    return {
      // 0-based half-open, as SeqViz and js/plasmid.js use internally
      start,
      end,
      // 1-based inclusive, as every catalogue and paper prints it. The last
      // included base is `end` in both conventions, since half-open already
      // excludes it: [0, 60) is bases 1–60.
      startDisplay: bases.length ? start + 1 : 0,
      endDisplay: bases.length ? (end === 0 ? seq.length : end) : 0,
      length: bases.length,
      bases,
      revComp: revComp(bases),
      gc: gcPercent(bases),
      crossesOrigin,
      // the feature is annotated on the reverse strand; `bases` is still the
      // forward strand, and `revComp` is the strand the feature is read on
      reversed,
      // present when the click landed on a feature rather than bare sequence
      featureName: sel.name || '',
      kind: sel.type === 'ANNOTATION' ? 'feature'
          : sel.type === 'ENZYME' ? 'enzyme'
          : sel.type ? 'sequence' : 'none',
    };
  }

  /** One line, the way it would be written in a notebook. */
  function formatSelection(d) {
    if (!d.length) return 'No selection';
    const where = d.crossesOrigin
      ? `${d.startDisplay}–${d.endDisplay} (crosses the origin)`
      : d.reversed
        ? `${d.startDisplay}–${d.endDisplay} (reverse strand)`
        : `${d.startDisplay}–${d.endDisplay}`;
    const what = d.featureName ? `${d.featureName} · ` : '';
    const preview = d.bases.length > 120
      ? `${d.bases.slice(0, 60)}…${d.bases.slice(-60)}`
      : d.bases;
    return `${what}${where} · ${d.length} bp · ${d.gc}% GC\n${preview}`;
  }

  /* --- the DOM half ------------------------------------------------------ */

  function requireSeqViz() {
    const lib = typeof window !== 'undefined' ? window.seqviz : undefined;
    if (!lib || typeof lib.Viewer !== 'function') {
      throw new Error(
        'SeqViz is not loaded. Add <script src="vendor/seqviz.min.js"> before this module.'
      );
    }
    return lib;
  }

  /**
   * Render a payload into `target` and report selections.
   *
   * @param {Element|string} target   element, or its id
   * @param {object} payload          { seq|sequence, features|annotations, ... }
   * @param {object} [options]
   *   view        "both" (default) | "circular" | "linear"
   *   onSelect    fn(description, rawSelection)
   *   output      element whose .value or .textContent receives the summary
   *   log         true (default) to also console.log each selection
   *   enzymes     array of enzyme names for SeqViz to mark, e.g. ["EcoRI"]
   *   showComplement, showIndex, zoom — passed through
   *
   * @returns {{ update, setView, destroy, getSelection }}
   */
  function createViewer(target, payload, options) {
    const opts = options || {};
    const lib = requireSeqViz();

    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) throw new Error(`no element for ${String(target)}`);

    let model = normalizePayload(payload);
    let last = describeSelection(model.seq, null);

    function report(selection) {
      last = describeSelection(model.seq, selection);
      // A click that selects nothing fires too; reporting it would wipe the
      // panel every time somebody clicked the background.
      if (!last.length && last.kind !== 'feature') return;

      if (opts.log !== false && typeof console !== 'undefined') {
        console.log(
          '[vector-viewer] selection',
          { ...last, bases: last.bases.length > 200 ? `${last.bases.slice(0, 200)}…` : last.bases }
        );
      }
      if (opts.output) {
        const text = formatSelection(last);
        if ('value' in opts.output) opts.output.value = text;
        else opts.output.textContent = text;
      }
      if (typeof opts.onSelect === 'function') opts.onSelect(last, selection);
    }

    function propsFor(view) {
      return {
        name: model.name,
        seq: model.seq,
        annotations: model.annotations,
        viewer: view,
        seqType: 'dna',
        showComplement: opts.showComplement !== false,
        showIndex: opts.showIndex !== false,
        enzymes: opts.enzymes || [],
        zoom: opts.zoom || { linear: 50 },
        // SeqViz decides circular-vs-linear from the chosen viewer, so a
        // linear construct must not be offered the circular view at all.
        onSelection: report,
      };
    }

    let view = opts.view || (model.circular ? 'both' : 'linear');
    if (!model.circular && view !== 'linear') view = 'linear';

    const viewer = lib.Viewer(el, propsFor(view));
    viewer.render();

    return {
      /** Swap in a different plasmid without tearing the viewer down. */
      update(nextPayload) {
        model = normalizePayload(nextPayload);
        if (!model.circular) view = 'linear';
        viewer.setState(propsFor(view));
        return model.warnings;
      },
      setView(next) {
        if (!model.circular && next !== 'linear') return false;
        view = next;
        viewer.setState(propsFor(view));
        return true;
      },
      getSelection() { return last; },
      getWarnings() { return model.warnings; },
      destroy() { el.textContent = ''; },
    };
  }

  return {
    normalizePayload,
    normalizeFeature,
    orient,
    sliceSelection,
    describeSelection,
    formatSelection,
    revComp,
    gcPercent,
    colorFor,
    createViewer,
    TYPE_COLORS,
  };
}));
