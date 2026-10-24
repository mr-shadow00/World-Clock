(function () {
  'use strict';

  // ---------- Small DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

  const grid = $('#clockGrid');
  const emptyState = $('#emptyState');
  const emptyStateTitle = $('#emptyStateTitle');
  const emptyStateSub = $('#emptyStateSub');
  const gridSearch = $('#gridSearch');
  const gridSearchClear = $('#gridSearchClear');
  const toastEl = $('#toast');
  let toastTimer = null;
  let searchQuery = '';

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  // ---------- Starfield ----------
  (function stars() {
    const host = $('#stars');
    const count = 70;
    let html = '';
    for (let i = 0; i < count; i++) {
      const top = Math.random() * 100;
      const left = Math.random() * 100;
      const delay = (Math.random() * 4).toFixed(2);
      const size = (Math.random() * 1.6 + 1).toFixed(1);
      html += `<span style="top:${top}%;left:${left}%;animation-delay:${delay}s;width:${size}px;height:${size}px;"></span>`;
    }
    host.innerHTML = html;
  })();

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  // ---------- Locale-aware formatting ----------
  const LOCALE = undefined; // use browser default
  const hour12 = (() => {
    try {
      return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric' }).resolvedOptions().hour12;
    } catch (e) { return true; }
  })();

  const LOCAL_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'UTC'; }
  })();

  const fmtCache = new Map();
  function fmt(timeZone, key, locale, opts) {
    const k = key + '|' + timeZone;
    let f = fmtCache.get(k);
    if (!f) { f = new Intl.DateTimeFormat(locale, Object.assign({ timeZone }, opts)); fmtCache.set(k, f); }
    return f;
  }
  function toMap(parts, multi) {
    const map = {};
    parts.forEach(p => { map[p.type] = multi ? (map[p.type] || '') + p.value : p.value; });
    return map;
  }

  function partsFor(date, timeZone) {
    return toMap(fmt(timeZone, 'full', 'en-US', {
      hour12, hour: 'numeric', minute: '2-digit', second: '2-digit',
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    }).formatToParts(date), true);
  }

  function offsetLabel(timeZone, date) {
    try {
      const p = fmt(timeZone, 'short', 'en-US', { timeZoneName: 'shortOffset' }).formatToParts(date).find(x => x.type === 'timeZoneName');
      return p ? p.value.replace('GMT', 'UTC') : '';
    } catch (e) { return ''; }
  }

  // UTC offset in minutes at a given instant (DST-aware)
  function offsetMinutes(timeZone, date) {
    try {
      const p = fmt(timeZone, 'long', 'en-US', { timeZoneName: 'longOffset' }).formatToParts(date).find(x => x.type === 'timeZoneName');
      const m = p && /GMT([+\-\u2212])(\d{1,2})(?::(\d{2}))?/.exec(p.value);
      if (!m) return 0;
      const mins = parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10);
      return m[1] === '+' ? mins : -mins;
    } catch (e) { return 0; }
  }

  function dateKey(timeZone, date) {
    const map = toMap(fmt(timeZone, 'key', 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date));
    return `${map.year}-${map.month}-${map.day}`;
  }

  // Day label of a clock at instant `date`, relative to today on this device (real now)
  function dayRelativeLabel(timeZone, date, baseDate) {
    const here = dateKey(LOCAL_TZ, baseDate);
    const there = dateKey(timeZone, date);
    if (here === there) return 'Today';
    const diff = Math.round((new Date(there + 'T00:00:00Z') - new Date(here + 'T00:00:00Z')) / 86400000);
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return there;
  }

  function hourFraction(timeZone, date) {
    const map = toMap(fmt(timeZone, 'hf', 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date));
    let h = parseInt(map.hour, 10);
    if (h === 24) h = 0;
    return (h + parseInt(map.minute, 10) / 60 + parseInt(map.second, 10) / 3600) / 24; // 0..1
  }

  function fmtDuration(mins) {
    const a = Math.abs(mins), h = Math.floor(a / 60), m = a % 60;
    return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : '');
  }

  // "5h ahead" / "3h 30m behind" / "Same time"
  function diffInfo(timeZone, date) {
    const d = offsetMinutes(timeZone, date) - offsetMinutes(LOCAL_TZ, date);
    if (d === 0) return { text: 'Same time as you', cls: 'same' };
    return d > 0 ? { text: fmtDuration(d) + ' ahead of you', cls: 'ahead' } : { text: fmtDuration(d) + ' behind you', cls: 'behind' };
  }

  const SUN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.35 5.35 7 7M17 17l1.65 1.65M18.65 5.35 17 7M7 17l-1.65 1.65"/></g></svg>';
  const MOON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7z" fill="currentColor"/></svg>';

  // ---------- State ----------
  const state = {
    clocks: [],        // from server, excludes local
    offsetMs: 0,
    syncOk: false,
    syncedAt: null,
    sources: [],
    respondedCount: 0,
    totalCount: 0,
    dragId: null,
    tab: 'all',
    travelMin: 0,        // time-travel offset in minutes (0 = live)
    zoneMeta: new Map()  // timeZone -> { country, region }
  };

  const cardRefs = new Map(); // id -> element refs

  function now() {
    return new Date(Date.now() + state.offsetMs);
  }
  function shownTime() {
    return new Date(Date.now() + state.offsetMs + state.travelMin * 60000);
  }

  // ---------- Server calls ----------
  async function loadClocks() {
    try {
      const res = await fetch('/api/clocks');
      const data = await res.json();
      state.clocks = data;
      try { localStorage.setItem('wc-clocks-cache', JSON.stringify(data)); } catch (e) {}
    } catch (e) {
      try {
        const cached = localStorage.getItem('wc-clocks-cache');
        state.clocks = cached ? JSON.parse(cached) : [];
        toast('Offline — showing your last saved clocks');
      } catch (e2) {
        state.clocks = [];
      }
    }
    buildGrid();
  }

  async function syncTime(force) {
    setSyncPending();
    try {
      const res = await fetch('/api/time' + (force ? '?refresh=1' : ''));
      const data = await res.json();
      state.offsetMs = data.offsetMs || 0;
      state.syncOk = !!data.ok;
      state.syncedAt = data.syncedAt || Date.now();
      state.sources = data.sources || [];
      state.respondedCount = data.respondedCount || 0;
      state.totalCount = data.totalCount || 0;
    } catch (e) {
      state.syncOk = false;
      state.sources = [];
    }
    renderSyncPill();
    renderSyncSheet();
  }

  // ---------- Sync pill / sheet ----------
  function setSyncPending() {
    $('#syncDot').className = 'sync-dot pending';
    $('#syncText').textContent = 'Syncing…';
  }

  function renderSyncPill() {
    const dot = $('#syncDot');
    const text = $('#syncText');
    if (state.syncOk) {
      dot.className = 'sync-dot ok';
      text.textContent = `Synced • ${state.respondedCount}/${state.totalCount} servers`;
    } else {
      dot.className = 'sync-dot bad';
      text.textContent = 'Offline · device clock';
    }
  }

  function renderSyncSheet() {
    const summary = $('#syncSummary');
    if (state.syncOk) {
      summary.textContent = `Consensus offset ${state.offsetMs >= 0 ? '+' : ''}${state.offsetMs} ms from ${state.respondedCount} of ${state.totalCount} time servers. All clocks below use this corrected time.`;
    } else {
      summary.textContent = `No time server could be reached, so every clock is falling back to this device's own system clock. Times stay correct as long as your device clock is.`;
    }
    const list = $('#sourceList');
    list.innerHTML = '';
    state.sources.forEach((s) => {
      const row = el('div', { className: 'source-row' });
      const statusDot = s.ok ? '🟢' : '⚪';
      row.innerHTML = `
        <span class="source-row-name">${statusDot} ${s.name}</span>
        <span class="source-row-detail">${s.ok ? `${s.offsetMs >= 0 ? '+' : ''}${s.offsetMs}ms · ${s.rttMs}ms rtt` : (s.error || 'unreachable')}</span>
      `;
      list.appendChild(row);
    });
    if (!state.sources.length) {
      list.innerHTML = '<div class="source-row"><span class="source-row-name">No sync attempted yet</span></div>';
    }
  }

  // ---------- Card building ----------
  function friendlyLabel(tz) {
    const parts = tz.split('/');
    return parts[parts.length - 1].replace(/_/g, ' ');
  }

  function dialSvg(id) {
    let ticks = '';
    for (let i = 0; i < 12; i++) {
      const major = i % 3 === 0;
      const rad = (i * 30 - 90) * Math.PI / 180;
      const r1 = 26, r2 = major ? 21 : 23.2;
      const x1 = (30 + r1 * Math.cos(rad)).toFixed(1), y1 = (30 + r1 * Math.sin(rad)).toFixed(1);
      const x2 = (30 + r2 * Math.cos(rad)).toFixed(1), y2 = (30 + r2 * Math.sin(rad)).toFixed(1);
      ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? 'var(--ink)' : 'var(--muted)'}" stroke-width="${major ? 2.2 : 1.4}" stroke-linecap="round"/>`;
    }
    return `
      <svg viewBox="0 0 60 60" class="dial-svg" data-dial="${id}">
        <circle cx="30" cy="30" r="28" fill="rgba(255,255,255,0.04)" stroke="var(--divider)" stroke-width="1.6"/>
        ${ticks}
        <line data-hand="hour" x1="30" y1="30" x2="30" y2="16" stroke="var(--ink)" stroke-width="3.4" stroke-linecap="round"/>
        <line data-hand="min" x1="30" y1="30" x2="30" y2="9" stroke="var(--accent-teal)" stroke-width="2.4" stroke-linecap="round"/>
        <circle cx="30" cy="30" r="2.4" fill="var(--ink)"/>
      </svg>
    `;
  }

  function buildCard(clock) {
    const id = clock.id;
    const card = el('div', { className: 'clock-card' + (clock.isLocal ? ' is-local' : '') });
    card.dataset.id = id;
    if (clock.pinned) card.classList.add('is-pinned');
    if (!clock.isLocal) card.draggable = true;

    card.innerHTML = `
      <div class="card-sky"><div class="card-sky-marker" data-marker="${id}"></div></div>
      <div class="card-top">
        <span class="sky-icon" data-sky="${id}"></span>
        <div class="card-label-group">
          <div class="card-city">${escapeHtml(clock.label)}</div>
          <div class="card-day-rel" data-dayrel="${id}">Today</div>
        </div>
        ${clock.isLocal
          ? '<span class="card-pin">This device</span>'
          : `<div class="card-actions">
              <button class="pin-btn${clock.pinned ? ' on' : ''}" data-pin="${id}" title="${clock.pinned ? 'Unpin' : 'Pin'}" aria-label="${clock.pinned ? 'Unpin' : 'Pin'} ${escapeHtml(clock.label)}" aria-pressed="${!!clock.pinned}"><svg viewBox="0 0 24 24" width="17" height="17"><use href="#i-pin"/></svg></button>
              <button class="card-more" data-more="${id}" title="Rename or remove" aria-label="Rename or remove">⋯</button>
            </div>`}
      </div>
      <div class="card-body">
        <div class="card-digital">
          <div class="card-time" data-time="${id}"><span class="tm"></span><span class="sec">:<span class="ts"></span><span class="ap"></span></span></div>
          <div class="card-meta">
            <span class="card-offset" data-offset="${id}"></span>
            <span data-date="${id}"></span>
          </div>
          <div class="card-diff" data-diff="${id}"></div>
        </div>
        ${dialSvg(id)}
      </div>
      ${clock.isLocal ? '' : '<span class="drag-handle" title="Drag to reorder">⠿⠿</span>'}
    `;

    cardRefs.set(id, {
      card,
      timeEl: card.querySelector(`[data-time="${id}"]`),
      mainEl: card.querySelector('.tm'),
      secEl: card.querySelector('.ts'),
      apEl: card.querySelector('.ap'),
      offsetEl: card.querySelector(`[data-offset="${id}"]`),
      dateEl: card.querySelector(`[data-date="${id}"]`),
      dayRelEl: card.querySelector(`[data-dayrel="${id}"]`),
      markerEl: card.querySelector(`[data-marker="${id}"]`),
      skyEl: card.querySelector(`[data-sky="${id}"]`),
      diffEl: card.querySelector(`[data-diff="${id}"]`),
      isLocal: !!clock.isLocal,
      label: clock.label,
      hourHand: card.querySelector(`[data-hand="hour"]`),
      minHand: card.querySelector(`[data-hand="min"]`),
      timeZone: clock.timeZone
    });

    if (!clock.isLocal) {
      card.addEventListener('dragstart', () => { state.dragId = id; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); state.dragId = null; });
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (state.dragId && state.dragId !== id) reorder(state.dragId, id);
      });
      card.querySelector(`[data-more="${id}"]`).addEventListener('click', () => openRename(clock));
      card.querySelector(`[data-pin="${id}"]`).addEventListener('click', () => togglePin(clock.id));
    }

    return card;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildGrid() {
    grid.innerHTML = '';
    cardRefs.clear();

    const local = { id: 'local', timeZone: LOCAL_TZ, label: 'This device', isLocal: true };
    grid.appendChild(buildCard(local));
    state.clocks.forEach((c) => grid.appendChild(buildCard(c)));

    applyFilter();
    updateFabVisibility();
  }

  // ---------- Tabs + search ----------
  function pinnedCount() { return state.clocks.filter(c => c.pinned).length; }

  function searchHaystack(ref) {
    const meta = state.zoneMeta.get(ref.timeZone) || {};
    const off = offsetLabel(ref.timeZone, now());
    return [ref.label, ref.timeZone.replace(/_/g, ' '), meta.country, meta.region, off, off.replace('UTC', 'GMT')]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function applyFilter(animateAll) {
    const tokens = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const onPinned = state.tab === 'pinned';
    let visibleClocks = 0;
    const toAnimate = [];

    cardRefs.forEach((ref, id) => {
      let show = true;
      if (!ref.isLocal && onPinned) {
        const c = state.clocks.find(x => x.id === id);
        show = !!(c && c.pinned);
      }
      if (show && tokens.length) {
        const hay = searchHaystack(ref);
        show = tokens.every(t => hay.includes(t));
      }
      ref.card.hidden = !show;
      if (show && !ref.isLocal) visibleClocks++;
      if (show && (animateAll || ref.wasShown === false)) toAnimate.push(ref);
      ref.wasShown = show;
    });
    playEnter(toAnimate);

    // tabs + counts
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.tab === state.tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    moveTabIndicator();
    $('#countPinned').textContent = pinnedCount();
    $('#countAll').textContent = state.clocks.length;

    // empty states (the "This device" card is always a candidate, so look at the other clocks)
    const emptyAction = $('#emptyAction');
    emptyAction.hidden = true;
    if (visibleClocks === 0 && tokens.length) {
      emptyStateTitle.textContent = 'No matches';
      emptyStateSub.textContent = `No ${onPinned ? 'pinned ' : ''}clocks match "${searchQuery.trim()}"`;
      if (onPinned) { emptyAction.textContent = 'Search all clocks'; emptyAction.hidden = false; }
      emptyState.hidden = false;
    } else if (visibleClocks === 0 && onPinned) {
      emptyStateTitle.textContent = 'Nothing pinned yet';
      emptyStateSub.textContent = 'Tap the pin on any clock to keep it here';
      emptyAction.textContent = 'Browse all clocks';
      emptyAction.hidden = false;
      emptyState.hidden = false;
    } else if (visibleClocks === 0) {
      emptyStateTitle.textContent = 'No clocks yet';
      emptyStateSub.textContent = 'Tap the + button to add a city';
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
    }
    tick();
  }

  function setTab(tab, remember) {
    if (tab === state.tab) return;
    state.tab = tab;
    if (remember) { try { localStorage.setItem('wc-tab', tab); } catch (e) {} }
    applyFilter(true);
    const es = $('#emptyState');
    if (!es.hidden) { es.style.animation = 'none'; void es.offsetWidth; es.style.animation = ''; }
  }

  // ---------- Motion helpers ----------
  function playEnter(refs) {
    if (!refs.length) return;
    refs.forEach((r) => r.card.classList.remove('enter'));
    void grid.offsetWidth; // one reflow for the whole batch
    refs.forEach((r, i) => {
      r.card.style.setProperty('--i', Math.min(i, 10));
      r.card.classList.add('enter');
    });
  }
  grid.addEventListener('animationend', (e) => {
    if (e.animationName === 'cardIn') e.target.classList.remove('enter');
    if (e.animationName === 'pinPop') e.target.classList.remove('pop');
  });

  const tabsEl = document.querySelector('.tabs');
  const tabInd = el('span', { className: 'tab-indicator' });
  tabsEl.prepend(tabInd);
  function moveTabIndicator() {
    const a = tabsEl.querySelector('.tab.active');
    if (!a) return;
    tabInd.style.width = a.offsetWidth + 'px';
    tabInd.style.transform = `translateX(${a.offsetLeft}px)`;
    if (!tabInd.dataset.ready) requestAnimationFrame(() => requestAnimationFrame(() => { tabInd.dataset.ready = '1'; }));
  }
  window.addEventListener('resize', moveTabIndicator);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTabIndicator);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab, true)));
  $('#emptyAction').addEventListener('click', () => setTab('all', true));

  async function togglePin(id) {
    const c = state.clocks.find(x => x.id === id);
    if (!c) return;
    if (c.pinned && state.tab === 'pinned') {
      const ref = cardRefs.get(id);
      if (ref) { ref.card.classList.add('leaving'); await new Promise((r) => setTimeout(r, 230)); }
    }
    c.pinned = !c.pinned;
    buildGrid();
    const pb = document.querySelector(`[data-pin="${id}"]`);
    if (pb && c.pinned) pb.classList.add('pop');
    toast(c.pinned ? `Pinned ${c.label}` : `Unpinned ${c.label}`);
    try {
      await fetch(`/api/clocks/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: c.pinned })
      });
    } catch (e) {
      c.pinned = !c.pinned;
      buildGrid();
      toast('Could not save pin — check the connection');
    }
  }

  gridSearch.addEventListener('input', () => {
    searchQuery = gridSearch.value;
    gridSearchClear.hidden = searchQuery.length === 0;
    applyFilter();
  });
  gridSearchClear.addEventListener('click', () => {
    gridSearch.value = '';
    searchQuery = '';
    gridSearchClear.hidden = true;
    applyFilter();
    gridSearch.focus();
  });

  async function reorder(draggedId, targetId) {
    const ids = state.clocks.map(c => c.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    state.clocks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    buildGrid();
    try {
      await fetch('/api/clocks/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: ids })
      });
    } catch (e) { /* order will resync on next load */ }
  }

  // ---------- Tick loop ----------
  // Each character is its own span; only the characters that change play a short roll-in.
  function setDigits(host, str) {
    const kids = host.children;
    if (kids.length !== str.length) {
      host.textContent = '';
      for (const ch of str) {
        const sp = el('span', { className: 'dg', textContent: ch });
        sp.dataset.c = ch;
        host.appendChild(sp);
      }
      return;
    }
    for (let i = 0; i < str.length; i++) {
      const sp = kids[i];
      if (sp.dataset.c === str[i]) continue;
      sp.dataset.c = str[i];
      sp.textContent = str[i];
      const next = sp.classList.contains('ra') ? 'rb' : 'ra';
      sp.classList.remove('ra', 'rb');
      sp.classList.add(next);
    }
  }

  function tick() {
    const real = now();
    const t = shownTime();
    cardRefs.forEach((ref) => {
      if (ref.card.hidden) return;
      const map = partsFor(t, ref.timeZone);
      const dayPeriod = map.dayPeriod ? ' ' + map.dayPeriod : '';
      setDigits(ref.mainEl, `${map.hour || '--'}:${map.minute || '--'}`);
      setDigits(ref.secEl, map.second || '--');
      if (ref.apEl.textContent !== dayPeriod) ref.apEl.textContent = dayPeriod;
      ref.offsetEl.textContent = offsetLabel(ref.timeZone, t);
      ref.dateEl.textContent = `${map.weekday}, ${map.month} ${map.day}`;
      ref.dayRelEl.textContent = dayRelativeLabel(ref.timeZone, t, real);

      const diff = ref.isLocal ? { text: 'Your time', cls: 'same' } : diffInfo(ref.timeZone, t);
      if (ref.diffEl.textContent !== diff.text) {
        ref.diffEl.textContent = diff.text;
        ref.diffEl.className = 'card-diff ' + diff.cls;
      }

      const frac = hourFraction(ref.timeZone, t);
      ref.markerEl.style.left = (frac * 100).toFixed(2) + '%';

      // sun / moon badge
      const isDay = frac >= 0.25 && frac < 0.75; // 6:00 – 18:00
      const phase = isDay ? 'day' : 'night';
      if (ref.phase !== phase) {
        ref.phase = phase;
        ref.skyEl.className = 'sky-icon ' + phase;
        ref.skyEl.title = isDay ? 'Daytime' : 'Night';
        ref.skyEl.innerHTML = isDay ? SUN_SVG : MOON_SVG;
      }

      const h24 = frac * 24;
      setHand(ref.hourHand, 30, 30, 14, ((h24 % 12) / 12) * 360);
      setHand(ref.minHand, 30, 30, 21, ((h24 * 60) % 60) / 60 * 360);

    });
    renderTravelReadout(real);
  }

  function setHand(lineEl, cx, cy, len, angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    lineEl.setAttribute('x2', (cx + len * Math.cos(rad)).toFixed(1));
    lineEl.setAttribute('y2', (cy + len * Math.sin(rad)).toFixed(1));
  }

  setInterval(tick, 1000);

  // ---------- Time travel ----------
  const travelPanel = $('#travelPanel');
  const travelSlider = $('#travelSlider');
  const travelToggle = $('#travelToggle');

  function renderTravelReadout(real) {
    const readout = $('#travelReadout');
    const sub = $('#travelSub');
    const min = state.travelMin;
    document.body.classList.toggle('travelling', min !== 0);
    travelToggle.classList.toggle('active', min !== 0);
    $('#travelToggleText').textContent = min === 0 ? 'Time travel' : (min > 0 ? '+' : '−') + fmtDuration(min);
    if (travelPanel.hidden && min === 0) return;
    if (min === 0) {
      readout.textContent = 'Now';
      sub.textContent = 'Drag the slider to see every clock at another moment';
      return;
    }
    const m = partsFor(shownTime(), LOCAL_TZ);
    readout.textContent = `${m.weekday}, ${m.month} ${m.day} · ${m.hour}:${m.minute}${m.dayPeriod ? ' ' + m.dayPeriod : ''}`;
    sub.textContent = `On this device · ${min > 0 ? 'in ' + fmtDuration(min) : fmtDuration(min) + ' ago'}`;
  }

  function setTravel(min) {
    state.travelMin = Math.max(-1440, Math.min(2880, min));
    travelSlider.value = state.travelMin;
    tick();
  }
  travelToggle.addEventListener('click', () => {
    if (!travelPanel.hidden) {
      travelPanel.classList.add('closing');
      travelToggle.setAttribute('aria-expanded', 'false');
      travelPanel.addEventListener('animationend', function done() {
        travelPanel.removeEventListener('animationend', done);
        travelPanel.hidden = true;
        travelPanel.classList.remove('closing');
      });
      return;
    }
    travelPanel.hidden = false;
    travelToggle.setAttribute('aria-expanded', 'true');
    tick();
  });
  travelSlider.addEventListener('input', () => setTravel(parseInt(travelSlider.value, 10)));
  $('#travelReset').addEventListener('click', () => setTravel(0));
  document.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => setTravel(state.travelMin + parseInt(b.dataset.step, 10))));

  // ---------- Theme ----------
  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', cur);
    try { localStorage.setItem('wc-theme-v2', cur); } catch (e) {}
  });

  // ---------- Menu popover ----------
  const menuPopover = $('#menuPopover');
  $('#menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menuPopover.hidden = !menuPopover.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!menuPopover.hidden && !menuPopover.contains(e.target) && e.target.id !== 'menuBtn') menuPopover.hidden = true;
  });
  menuPopover.addEventListener('click', async (e) => {
    const action = e.target.dataset && e.target.dataset.action;
    if (action === 'addAll') { menuPopover.hidden = true; await addAllClocks(); }
    if (action === 'removeAll') { menuPopover.hidden = true; await removeAllClocks(); }
    if (action === 'refresh') { menuPopover.hidden = true; await syncTime(true); toast('Re-synced'); }
    if (action === 'export') {
      menuPopover.hidden = true;
      window.location.href = '/api/export';
    }
  });
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    menuPopover.hidden = true;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch('/api/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json)
      });
      const result = await res.json();
      toast(`Imported ${result.added} clock(s)`);
      await loadClocks();
    } catch (err) {
      toast('Could not read that backup file');
    }
    e.target.value = '';
  });

  // ---------- Sync sheet ----------
  const syncBackdrop = $('#syncBackdrop');
  $('#syncPill').addEventListener('click', () => { renderSyncSheet(); syncBackdrop.hidden = false; });
  $('#syncNowBtn').addEventListener('click', () => syncTime(true));

  // ---------- Add clock sheet ----------
  const addBackdrop = $('#addBackdrop');
  const tzList = $('#tzList');
  const tzSearch = $('#tzSearch');
  const addAllBtn = $('#addAllBtn');
  let allZones = [];

  async function ensureZones() {
    if (allZones.length) return;
    try {
      const res = await fetch('/api/timezones');
      allZones = await res.json();
      allZones.forEach(z => state.zoneMeta.set(z.timeZone, { country: z.country || '', region: z.region || '' }));
    } catch (e) {
      allZones = [{ timeZone: LOCAL_TZ, offset: '' }];
    }
  }

  const fabAddBtn = $('#addBtn');

  function updateFabVisibility() {
    if (!allZones.length) { fabAddBtn.hidden = false; return; }
    fabAddBtn.hidden = availableZones().length === 0;
  }

  function addedTimeZones() {
    return new Set(state.clocks.map(c => c.timeZone));
  }

  function availableZones() {
    const added = addedTimeZones();
    return allZones.filter(z => !added.has(z.timeZone));
  }

  function renderTzList(query) {
    const q = (query || '').trim().toLowerCase();
    const matches = availableZones()
      .filter(z => {
        const hay = `${z.timeZone.replace(/_/g, ' ')} ${z.country || ''} ${z.region || ''} ${z.offset || ''}`.toLowerCase();
        return q.split(/\s+/).every(t => hay.includes(t));
      })
      .slice(0, 200);
    tzList.innerHTML = '';
    const remaining = availableZones().length;
    if (addAllBtn) addAllBtn.hidden = remaining === 0;
    if (!matches.length) {
      const msg = remaining === 0 ? 'All timezones are already on your dashboard' : 'No matches';
      tzList.innerHTML = `<div class="tz-row"><span class="tz-row-name">${msg}</span></div>`;
      return;
    }
    matches.forEach((z) => {
      const row = el('div', { className: 'tz-row' });
      row.innerHTML = `<span class="tz-row-name">${friendlyLabel(z.timeZone)} <span class="tz-row-offset">${escapeHtml(z.country ? z.country + ' · ' : '')}${z.timeZone.replace(/_/g, ' ')}</span></span><span class="tz-row-offset">${z.offset || ''}</span>`;
      row.addEventListener('click', () => addClock(z.timeZone));
      tzList.appendChild(row);
    });
  }

  async function addClock(timeZone) {
    try {
      const res = await fetch('/api/clocks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone, label: friendlyLabel(timeZone), pinned: state.tab === 'pinned' })
      });
      const clock = await res.json();
      state.clocks.push(clock);
      buildGrid();
      const nr = cardRefs.get(clock.id);
      if (nr) playEnter([nr]);
      addBackdrop.hidden = true;
      toast(clock.pinned ? `Added and pinned ${clock.label}` : `Added ${clock.label}`);
    } catch (e) {
      toast('Could not add that clock — check the connection');
    }
  }

  async function addAllClocks() {
    await ensureZones();
    const zones = availableZones().map(z => z.timeZone);
    if (!zones.length) { toast('All timezones are already on your dashboard'); return; }
    try {
      const res = await fetch('/api/clocks/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZones: zones })
      });
      const result = await res.json();
      state.clocks.push(...(result.added || []));
      buildGrid();
      renderTzList(tzSearch.value);
      addBackdrop.hidden = true;
      toast(`Added ${(result.added || []).length} clock(s)`);
    } catch (e) {
      toast('Could not add all clocks — check the connection');
    }
  }

  async function removeAllClocks() {
    if (!state.clocks.length) { toast('No timezones to remove'); return; }
    const ok = window.confirm(`Remove all ${state.clocks.length} timezone(s) from your dashboard? This device's clock stays.`);
    if (!ok) return;
    try {
      await fetch('/api/clocks/all', { method: 'DELETE' });
      state.clocks = [];
      buildGrid();
      renderTzList(tzSearch.value);
      toast('Removed all timezones');
    } catch (e) {
      toast('Could not remove clocks — check the connection');
    }
  }

  $('#addBtn').addEventListener('click', async () => {
    await ensureZones();
    tzSearch.value = '';
    renderTzList('');
    addBackdrop.hidden = false;
    setTimeout(() => tzSearch.focus(), 50);
  });
  tzSearch.addEventListener('input', () => renderTzList(tzSearch.value));
  addAllBtn.addEventListener('click', addAllClocks);

  // ---------- Rename sheet ----------
  const renameBackdrop = $('#renameBackdrop');
  const renameInput = $('#renameInput');
  let renamingClock = null;

  function openRename(clock) {
    renamingClock = clock;
    renameInput.value = clock.label;
    renameBackdrop.hidden = false;
    setTimeout(() => renameInput.focus(), 50);
  }

  $('#renameSaveBtn').addEventListener('click', async () => {
    if (!renamingClock) return;
    const label = renameInput.value.trim() || renamingClock.label;
    try {
      await fetch(`/api/clocks/${renamingClock.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label })
      });
      const c = state.clocks.find(c => c.id === renamingClock.id);
      if (c) c.label = label;
      buildGrid();
      renameBackdrop.hidden = true;
      toast('Renamed');
    } catch (e) {
      toast('Could not save — check the connection');
    }
  });

  $('#renameDeleteBtn').addEventListener('click', async () => {
    if (!renamingClock) return;
    try {
      await fetch(`/api/clocks/${renamingClock.id}`, { method: 'DELETE' });
      state.clocks = state.clocks.filter(c => c.id !== renamingClock.id);
      buildGrid();
      renameBackdrop.hidden = true;
      toast('Removed');
    } catch (e) {
      toast('Could not remove — check the connection');
    }
  });

  // ---------- Close sheets ----------
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.close;
      if (which === 'sync') syncBackdrop.hidden = true;
      if (which === 'add') addBackdrop.hidden = true;
      if (which === 'rename') renameBackdrop.hidden = true;
    });
  });
  [syncBackdrop, addBackdrop, renameBackdrop].forEach((bd) => {
    bd.addEventListener('click', (e) => { if (e.target === bd) bd.hidden = true; });
  });

  // ---------- Boot ----------
  (async function boot() {
    let saved = null;
    try { saved = localStorage.getItem('wc-tab'); } catch (e) {}
    await loadClocks();
    state.tab = saved === 'pinned' || saved === 'all' ? saved : (pinnedCount() > 0 ? 'pinned' : 'all');
    applyFilter(true);
    await ensureZones();
    applyFilter(); // re-run now that country names are known
    updateFabVisibility();
    await syncTime(false);
    setInterval(() => syncTime(false), 5 * 60 * 1000); // background re-sync every 5 min
  })();
})();
