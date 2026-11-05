/* ============================================================
   Elias Lab — lab life gallery, under Team on the public site
   ------------------------------------------------------------
   Photos are uploaded from the Lab Notebook, where members are
   signed in. This file only shows them.

   It deliberately does NOT load the Supabase client. The public
   page is the lab's front door and should stay light, so the
   captions come from one plain fetch against the REST endpoint
   and the images from the public bucket by URL. That is roughly
   a hundred kilobytes of library not downloaded by every visitor
   to read five captions.

   Everything here fails quietly. A lab with no photos yet, a
   project not yet configured, a network that refuses — in every
   case the section simply is not there, because an error box on
   a marketing page is worse than a missing gallery.
   ============================================================ */
(function () {
  'use strict';

  var CATEGORIES = [
    { key: 'all', label: 'All' },
    { key: 'daily', label: 'Day to day' },
    { key: 'occasions', label: 'Occasions' },
    { key: 'conferences', label: 'Conferences' }
  ];

  var cfg = window.ELIAS_CONFIG || {};
  var photos = [];
  var filter = 'all';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function imageUrl(path) {
    return cfg.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/object/public/lab-photos/' + path
      .split('/').map(encodeURIComponent).join('/');
  }

  function render() {
    var host = document.getElementById('lab-gallery');
    if (!host) return;
    var shown = filter === 'all' ? photos : photos.filter(function (p) { return (p.category || 'daily') === filter; });
    var have = {};
    photos.forEach(function (p) { have[p.category || 'daily'] = true; });

    host.innerHTML =
      '<div class="gallery-tabs">' + CATEGORIES.filter(function (c) {
        return c.key === 'all' || have[c.key];
      }).map(function (c) {
        return '<button type="button" class="gallery-tab' + (filter === c.key ? ' on' : '') +
          '" data-cat="' + c.key + '">' + esc(c.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="gallery-grid">' + shown.map(function (p) {
        var cap = p.caption || '';
        return '<figure class="gallery-item">' +
          '<img src="' + esc(imageUrl(p.path)) + '" alt="' + esc(cap || 'Elias Lab') + '" loading="lazy" decoding="async">' +
          (cap || p.taken_on
            ? '<figcaption>' + esc(cap) +
              (p.taken_on ? '<span>' + esc(p.taken_on) + '</span>' : '') + '</figcaption>'
            : '') +
          '</figure>';
      }).join('') + '</div>';

    host.querySelectorAll('.gallery-tab').forEach(function (b) {
      b.addEventListener('click', function () { filter = b.dataset.cat; render(); });
    });
  }

  async function load() {
    var section = document.getElementById('lab-gallery-section');
    if (!section || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
    try {
      var r = await fetch(
        cfg.SUPABASE_URL.replace(/\/+$/, '') +
          '/rest/v1/lab_photos?select=path,caption,category,taken_on&order=taken_on.desc,created_at.desc',
        { headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + cfg.SUPABASE_ANON_KEY } }
      );
      if (!r.ok) return;                       // table not created yet, or no access
      photos = (await r.json()).filter(function (p) { return p && p.path; });
    } catch (e) {
      return;                                  // offline, blocked, or misconfigured
    }
    if (!photos.length) return;                // nothing to show is not a section
    section.hidden = false;
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
