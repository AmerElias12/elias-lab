/* ============================================================
   Elias Lab — renders the Team section from js/team-data.js
   You should not need to edit this file; edit team-data.js.
   ============================================================ */
(function () {
  'use strict';

  var T = window.ELIAS_TEAM;
  if (!T) return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // "Dr. Sarah Cohen" -> "SC"  (titles ignored)
  function initials(name) {
    var parts = String(name || '').replace(/\b(Dr|Prof|Mr|Ms|Mrs)\.?\s+/gi, '').trim().split(/\s+/);
    if (!parts[0]) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // Only allow real LinkedIn profile URLs — never inject arbitrary markup.
  function safeLinkedIn(url) {
    var u = String(url || '').trim();
    if (!u) return '';
    if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(u)) return '';
    return u;
  }

  var LI_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.76V21h-4v-5.6c0-1.34-.03-3.07-1.95-3.07-1.96 0-2.26 1.46-2.26 2.97V21H9z"/></svg>';

  function linkedInLink(url, name, cls) {
    var u = safeLinkedIn(url);
    if (!u) return '';
    return '<a class="' + cls + '" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer"' +
      ' aria-label="' + esc(name) + ' on LinkedIn" title="' + esc(name) + ' on LinkedIn">' + LI_ICON + '</a>';
  }

  // <img> that swaps itself for an initials circle if the file is missing
  function avatar(photo, name, cls) {
    var ini = esc(initials(name));
    if (!photo) return '<div class="' + cls + ' avatar-fallback">' + ini + '</div>';
    return '<img class="' + cls + '" src="assets/team/' + esc(photo) + '" alt="' + esc(name) + '" ' +
      'onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),' +
      '{className:\'' + cls + ' avatar-fallback\',textContent:\'' + ini + '\'}))">';
  }

  /* ---- PI ---- */
  var pi = T.pi || {};
  var piEl = document.getElementById('team-pi');
  if (piEl && pi.name) {
    piEl.innerHTML =
      '<div class="pi-photo reveal">' + avatar(pi.photo, pi.name, 'pi-avatar') + '</div>' +
      '<div class="team-bio reveal">' +
        '<h3>' + esc(pi.name) + linkedInLink(pi.linkedin, pi.name, 'li-link li-inline') + '</h3>' +
        '<p class="team-title">' + esc(pi.role || '') + '</p>' +
        (pi.bio || []).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') +
      '</div>';
  }

  /* ---- Members ---- */
  var list = (T.members || []).filter(function (m) { return m && m.name && m.name.trim(); });
  var grid = document.getElementById('team-grid');
  if (grid) {
    if (!list.length) {
      grid.style.display = 'none';           // nothing to show yet — stay tidy
    } else {
      grid.style.display = '';
      grid.innerHTML = list.map(function (m) {
        return '<div class="member-card reveal">' +
          avatar(m.photo, m.name, 'member-avatar') +
          '<h4>' + esc(m.name) + '</h4>' +
          (m.role ? '<div class="member-role">' + esc(m.role) + '</div>' : '') +
          (m.note ? '<p>' + esc(m.note) + '</p>' : '') +
          linkedInLink(m.linkedin, m.name, 'li-link li-card') +
          '</div>';
      }).join('');
    }
  }

  // Newly injected cards still need the scroll-reveal treatment.
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fresh = document.querySelectorAll('#team-pi .reveal, #team-grid .reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    fresh.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    fresh.forEach(function (el) { io.observe(el); });
  }
})();
