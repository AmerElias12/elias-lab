/* ===========================================================================
   save-file.js — getting a file out of the page, wherever the page is open

   Every export in the notebook used to do the same thing: make the file in
   the page, point a link at it, and click the link. In a tab of its own that
   is a download. But the lab's site is also shown inside the Wix page, in a
   frame Wix sandboxes without `allow-downloads`, and a notebook tab opened
   from there inherits the sandbox. In that tab the browser drops every
   download without a word — no file, no error, nothing in the console. The
   Export menu closed and that was all, which is exactly what "nothing
   happens" looked like, for the plasmid exports and the primer templates
   alike.

   A page cannot lift its own sandbox. What it can still do there is ask for
   a Save dialog — that is the user choosing a place for a file, not the
   page pushing one at them, and the sandbox allows it. So:

     not sandboxed            the link, as before
     sandboxed, Save dialog   the dialog (Chrome, Edge)
     sandboxed, no dialog     the file's text on screen, to copy, with the
                              address that opens the notebook unsandboxed

   The last one is never a dead end: something always happens.
   ======================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;   // tests
  else root.LabSave = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* Whether this document is sandboxed.

     There is no property that says so. The Presentation API is refused in a
     sandbox that lacks `allow-presentation`, with a SecurityError, at the
     moment the request is constructed and before anything is shown — and a
     frame that was not given `allow-downloads` was, in practice, not given
     that either. A browser without the API answers "no", which sends it down
     the ordinary path it always took. */
  var sandboxKnown = null;
  function sandboxed() {
    if (sandboxKnown !== null) return sandboxKnown;
    sandboxKnown = false;
    try {
      if (typeof root.PresentationRequest === 'function') new root.PresentationRequest('https://example.com/');
    } catch (e) {
      sandboxKnown = !!e && e.name === 'SecurityError';
    }
    return sandboxKnown;
  }

  function extOf(name) {
    var m = /\.[A-Za-z0-9]{1,8}$/.exec(String(name || ''));
    return m ? m[0].toLowerCase() : '';
  }
  function baseType(type) { return String(type || 'text/plain').split(';')[0].trim() || 'text/plain'; }

  /* Which of the three ways a save will go. Kept apart from the doing of it
     so it can be checked without a browser. */
  function route(env) {
    if (!env.sandboxed) return 'link';
    return env.picker ? 'picker' : 'show';
  }

  function viaLink(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    a.setAttribute('data-labsave', '1');          // ours: the click handler below leaves it alone
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    /* Not straight away. The browser fetches the file after this returns —
       and with "ask where to save each file" switched on, only once the
       dialog has been answered. */
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
  }

  function viaPicker(filename, blob) {
    var ext = extOf(filename), accept = {};
    var opts = { suggestedName: filename };
    if (ext) { accept[baseType(blob.type)] = [ext]; opts.types = [{ description: ext.slice(1).toUpperCase() + ' file', accept: accept }]; }
    return root.showSaveFilePicker(opts).then(function (handle) {
      return handle.createWritable().then(function (w) {
        return w.write(blob).then(function () { return w.close(); });
      });
    });
  }

  /* The file itself, on the page. Only for text, which is everything the
     notebook exports; anything else gets the explanation and the address. */
  function show(filename, blob, why) {
    var old = document.getElementById('labsave-box');
    if (old) old.remove();
    var direct = String(root.location.href).split('#')[0];
    var box = document.createElement('div');
    box.id = 'labsave-box';
    box.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:rgba(10,30,26,.55);display:flex;align-items:center;justify-content:center;padding:20px;font:14px/1.5 system-ui,-apple-system,sans-serif;');
    var card = document.createElement('div');
    card.setAttribute('style', 'background:#fff;color:#16241f;border-radius:14px;max-width:720px;width:100%;max-height:90vh;overflow:auto;padding:22px 24px;box-shadow:0 30px 60px -30px rgba(0,0,0,.6);');
    function el(tag, style, text) {
      var x = document.createElement(tag);
      if (style) x.setAttribute('style', style);
      if (text != null) x.textContent = text;
      return x;
    }
    card.appendChild(el('h3', 'margin:0 0 8px;font-size:18px;', filename));
    card.appendChild(el('p', 'margin:0 0 10px;color:#4a5a52;',
      (why || 'This window cannot download files') + '. It was opened from a page that blocks downloads ' +
      '(the lab site inside Wix does). Copy the file below, or open the notebook at its own address in a new tab, where downloads work:'));
    var link = el('input', 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cfd8d3;border-radius:8px;margin:0 0 12px;font:13px ui-monospace,Menlo,monospace;');
    link.readOnly = true; link.value = direct;
    link.onfocus = function () { link.select(); };
    card.appendChild(link);
    var area = el('textarea', 'width:100%;box-sizing:border-box;height:260px;padding:10px;border:1px solid #cfd8d3;border-radius:8px;font:12px ui-monospace,Menlo,monospace;white-space:pre;');
    area.readOnly = true;
    var row = el('div', 'display:flex;gap:10px;justify-content:flex-end;margin-top:12px;');
    var note = el('span', 'margin-right:auto;align-self:center;color:#0f8a6c;font-weight:600;');
    function button(text, primary) {
      return el('button', 'padding:8px 16px;border-radius:100px;cursor:pointer;font:inherit;border:1px solid ' +
        (primary ? '#0d5c47;background:#0d5c47;color:#fff;' : '#cfd8d3;background:#fff;color:#16241f;'), text);
    }
    var copy = button('Copy the file', true), copyLink = button('Copy the address'), close = button('Close');
    function put(text, said) {
      var done = function () { note.textContent = said; };
      if (root.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { note.textContent = 'Select the text and copy it by hand.'; });
      } else { note.textContent = 'Select the text and copy it by hand.'; }
    }
    copy.onclick = function () { put(area.value, 'File copied.'); };
    copyLink.onclick = function () { put(direct, 'Address copied.'); };
    close.onclick = function () { box.remove(); };
    row.appendChild(note); row.appendChild(copyLink);
    var isText = /^text\/|json|xml|msword/.test(baseType(blob.type)) || /\.(csv|gb|gbk|fa|fasta|txt|tsv|json|doc)$/.test(extOf(filename));
    if (isText && blob.text) {
      card.appendChild(area);
      blob.text().then(function (t) { area.value = t.replace(/^﻿/, ''); });
      row.appendChild(copy);
    }
    row.appendChild(close);
    card.appendChild(row);
    box.appendChild(card);
    box.addEventListener('click', function (e) { if (e.target === box) box.remove(); });
    document.body.appendChild(box);
  }

  /**
   * Hand the user a file. `content` is a string or a Blob.
   * Resolves to how it went: 'link', 'picker', 'cancelled' or 'shown'.
   */
  function save(filename, content, type) {
    var blob = (typeof Blob !== 'undefined' && content instanceof Blob) ? content
      : new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    var how = route({ sandboxed: sandboxed(), picker: typeof root.showSaveFilePicker === 'function' });
    if (how === 'link') { viaLink(filename, blob); return Promise.resolve('link'); }
    if (how === 'show') { show(filename, blob); return Promise.resolve('shown'); }
    var asked = Date.now();
    return viaPicker(filename, blob).then(function () { return 'picker'; }, function (e) {
      /* Closing the dialog is an answer, not a failure — but nobody closes a
         dialog in a fifth of a second. One that is gone that fast was never
         really shown, and saying nothing then would be "nothing happens"
         all over again. */
      if (e && e.name === 'AbortError' && Date.now() - asked > 200) return 'cancelled';
      show(filename, blob, 'The Save dialog could not be opened' + (e && e.message ? ' (' + e.message + ')' : ''));
      return 'shown';
    });
  }

  /* Ordinary download links — an attachment, the inventory template — are
     dropped by the sandbox as silently as the scripted ones. In a sandboxed
     window they are caught here and sent the same way round. Outside one,
     nothing is touched. */
  function catchLinks() {
    if (typeof document === 'undefined' || !sandboxed()) return;
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
      if (!a || a.getAttribute('data-labsave') || !a.href) return;
      e.preventDefault();
      var name = a.getAttribute('download') || decodeURIComponent(a.href.split(/[?#]/)[0].split('/').pop() || 'file');
      fetch(a.href).then(function (r) {
        if (!r.ok) throw new Error('the file could not be fetched (' + r.status + ')');
        return r.blob();
      }).then(function (blob) { return save(name, blob); }, function (err) {
        alert('Could not save ' + name + ': ' + ((err && err.message) || err));
      });
    }, true);
  }
  catchLinks();

  return { save: save, sandboxed: sandboxed, route: route, extOf: extOf };
}));
