/* ===========================================================================
   plasmid-import.js — GenBank, SnapGene and FASTA into the ELN

   The parsing is not here. js/plasmid.js already reads all four formats and
   has 73 checks behind it; this module is the join between that parser and
   the API, which is the part that did not exist.

   Why the file never reaches the server
   -------------------------------------
   Parsing happens in the browser and only the resulting JSON is posted. Three
   reasons, in order of how much they matter:

     1. A .dna file is an untrusted binary from a colleague, a vendor or an
        email attachment. Parsing it in a tab costs an error message when it
        is malformed; parsing it in the API process is a different risk with
        the same upside.
     2. The parser exists, in JavaScript, tested. A Python port would be a
        second implementation of the same GenBank location grammar, and two
        implementations of a grammar disagree eventually.
     3. No upload endpoint, no temporary files, no storage to clean up.

   The cost is that an import needs a browser, so there is no server-side bulk
   import. That is the right trade today and the wrong one if the lab ever
   wants to ingest a directory of files, which is when this moves.
   ======================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlasmidImport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Extensions that are text. Everything else is read as binary, because
  // SnapGene's .dna is the only binary format here and anything unrecognised
  // is more likely to be binary than not.
  const TEXT_EXTENSIONS = [
    'gb', 'gbk', 'genbank', 'ape', 'txt',
    'fa', 'fasta', 'fsa', 'fna', 'seq',
  ];

  function extensionOf(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(filename || '');
    return m ? m[1].toLowerCase() : '';
  }

  function isTextFormat(filename) {
    return TEXT_EXTENSIONS.indexOf(extensionOf(filename)) >= 0;
  }

  /* --- mapping to the API ------------------------------------------------ */

  /**
   * One parsed feature -> one SequenceFeatureCreate.
   *
   * Returns null, and pushes a reason, for a feature the API would reject.
   * The rule that catches people out is `wraps_origin`: the schema requires
   * end <= start when it is set and end > start when it is not, so the flag
   * and the coordinates have to be decided together rather than the flag
   * being bolted on afterwards.
   */
  /**
   * The colour to store, or null to let the viewer choose.
   *
   * js/plasmid.js always sets one: the file's if it had it, otherwise its own
   * default for that feature type. The defaults are pale and nearly identical
   * to each other (#9fd3a0, #b7e1b7, #d7d7d7), so storing them makes every
   * imported map one colour and suppresses the type-based palette in
   * vector-viewer.js, which is the thing that makes a promoter look different
   * from a resistance marker.
   *
   * The two cases are indistinguishable after parsing, so this asks
   * plasmid.js itself: a colour equal to its default for that type was
   * invented, not read. Only a colour the file actually carried is kept —
   * which is also the right thing to put in the database, since presentation
   * nobody chose is not data.
   */
  function fileColor(f, colorFor) {
    const c = String(f.color || '');
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return null;
    if (typeof colorFor === 'function') {
      const invented = String(colorFor(f.type || 'misc_feature') || '');
      if (invented.toLowerCase() === c.toLowerCase()) return null;
    }
    return c;
  }

  function toFeatureCreate(f, warnings, colorFor) {
    const name = String(f.name || '').trim() || String(f.type || 'feature');
    const start = Number(f.start);
    const end = Number(f.end);

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      warnings.push(`"${name}": coordinates are not whole numbers`);
      return null;
    }
    if (start === end) {
      // Zero length after normalisation. The database's CHECK refuses it
      // either way; saying so here names the feature, which the constraint
      // violation would not.
      warnings.push(`"${name}": empty span at ${start}, skipped`);
      return null;
    }

    const wraps = start > end;
    const out = {
      name: name.slice(0, 200),
      type_key: String(f.type || 'misc_feature').slice(0, 40),
      start_pos: start,
      end_pos: end,
      strand: f.strand === -1 ? -1 : f.strand === 0 ? 0 : 1,
      wraps_origin: wraps,
    };
    const color = fileColor(f, colorFor);
    if (color) out.color = color;
    if (f.note) out.note = String(f.note).slice(0, 2000);
    return out;
  }

  /**
   * A parse result from Plasmid.parseFile -> the body for POST /api/plasmids.
   *
   * @param {object} parsed  the `plasmid` from parseFile, or the whole result
   * @param {object} [extra] fields the form supplies: external_source, notes…
   * @returns {{ body: object, warnings: string[] }}
   */
  function toCreatePayload(parsed, extra, options) {
    const p = parsed && parsed.plasmid ? parsed.plasmid : parsed;
    if (!p || typeof p !== 'object') throw new TypeError('nothing was parsed');
    if (typeof p.seq !== 'string' || !p.seq) throw new TypeError('the parse produced no sequence');

    // plasmid.js's own palette, used to tell a colour it invented from one the
    // file carried. Passed in for the tests; taken from the global otherwise.
    const colorFor = (options && options.colorFor)
      || (typeof globalThis !== 'undefined' && globalThis.Plasmid && globalThis.Plasmid.colorFor)
      || null;

    const warnings = [];
    const features = (p.features || [])
      .map((f) => toFeatureCreate(f, warnings, colorFor))
      .filter(Boolean);

    const body = {
      name: String(p.name || 'Imported plasmid').slice(0, 200),
      sequence: p.seq,
      topology: p.topology === 'linear' ? 'linear' : 'circular',
      features,
    };

    // The API insists a plasmid says where it came from: either the entry it
    // was built in, or an external source. An import is by definition the
    // second, so the format and filename stand in when the form says nothing.
    const source = (extra && extra.external_source) || '';
    body.external_source = String(source).slice(0, 200) || 'imported file';
    if (extra && extra.external_reference) body.external_reference = String(extra.external_reference).slice(0, 200);
    if (p.definition) body.notes = String(p.definition).slice(0, 2000);
    if (extra && extra.notes) body.notes = String(extra.notes).slice(0, 2000);

    return { body, warnings };
  }

  /* --- the browser half --------------------------------------------------- */

  /**
   * Read a File and parse it. Resolves to parseFile's result.
   *
   * Text formats are read as text rather than as bytes on purpose. parseFile
   * will convert a buffer to a string itself, but it does so with
   * String.fromCharCode.apply over the whole file, and apply throws once the
   * argument list is large enough — which for a GenBank file is a plausible
   * size, not an absurd one. Reading text as text never goes near that path.
   */
  function readFile(file) {
    if (typeof FileReader === 'undefined') {
      return Promise.reject(new Error('readFile needs a browser'));
    }
    const lib = (typeof window !== 'undefined' && window.Plasmid) || null;
    if (!lib || typeof lib.parseFile !== 'function') {
      return Promise.reject(
        new Error('js/plasmid.js is not loaded; add it before this module.')
      );
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`could not read ${file.name}`));
      reader.onload = () => {
        let result;
        try {
          result = lib.parseFile(file.name, reader.result);
        } catch (err) {
          reject(new Error(`${file.name} could not be parsed: ${err.message}`));
          return;
        }
        if (!result || !result.ok) {
          reject(new Error((result && result.error) || `${file.name} holds no DNA sequence`));
          return;
        }
        // GenBank keeps no name of its own for an unnamed construct; the
        // filename is what the person recognises it by.
        if (!result.plasmid.name || result.plasmid.name === 'Imported plasmid') {
          result.plasmid.name = file.name.replace(/\.[a-z0-9]+$/i, '');
        }
        resolve(result);
      };
      if (isTextFormat(file.name)) reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  return {
    readFile,
    toCreatePayload,
    toFeatureCreate,
    fileColor,
    isTextFormat,
    extensionOf,
    TEXT_EXTENSIONS,
  };
}));
