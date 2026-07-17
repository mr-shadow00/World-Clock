(function () {
  'use strict';

  // ---------- Small DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

  const grid = $('#clockGrid');
  const emptyState = $('#emptyState');
  const toastEl = $('#toast');
  let toastTimer = null;

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

  function partsFor(date, timeZone) {
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12,
      hour: 'numeric', minute: '2-digit', second: '2-digit',
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    }).formatToParts(date);
    const map = {};
    raw.forEach(p => { map[p.type] = (map[p.type] || '') + p.value; });
    return map;
  }

  function offsetLabel(timeZone, date) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date);
      const p = parts.find(x => x.type === 'timeZoneName');
      return p ? p.value.replace('GMT', 'UTC') : '';
    } catch (e) { return ''; }
  }

  function dateKey(timeZone, date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return `${map.year}-${map.month}-${map.day}`;
  }

  function dayRelativeLabel(timeZone, date) {
    const here = dateKey(LOCAL_TZ, date);
    const there = dateKey(timeZone, date);
    if (here === there) return 'Today';
    const hereDate = new Date(here + 'T00:00:00Z');
    const thereDate = new Date(there + 'T00:00:00Z');
    const diff = Math.round((thereDate - hereDate) / 86400000);
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return there;
  }

  function hourFraction(timeZone, date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(date);
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    let h = parseInt(map.hour, 10);
    if (h === 24) h = 0;
    const m = parseInt(map.minute, 10);
    const s = parseInt(map.second, 10);
    return (h + m / 60 + s / 3600) / 24; // 0..1
  }

  // ---------- State ----------
  const state = {
    clocks: [],        // from server, excludes local
    offsetMs: 0,
    syncOk: false,
    syncedAt: null,
    sources: [],
    respondedCount: 0,
    totalCount: 0,
    dragId: null
  };

  const cardRefs = new Map(); // id -> element refs

  function now() {
    return new Date(Date.now() + state.offsetMs);
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
    return `
      <svg viewBox="0 0 60 60" class="dial-svg" data-dial="${id}">
        <circle cx="30" cy="30" r="27" fill="none" stroke="var(--divider)" stroke-width="2"/>
        <line x1="30" y1="5" x2="30" y2="9" stroke="var(--muted)" stroke-width="2"/>
        <line x1="30" y1="51" x2="30" y2="55" stroke="var(--muted)" stroke-width="2"/>
        <line x1="5" y1="30" x2="9" y2="30" stroke="var(--muted)" stroke-width="2"/>
        <line x1="51" y1="30" x2="55" y2="30" stroke="var(--muted)" stroke-width="2"/>
        <line data-hand="hour" x1="30" y1="30" x2="30" y2="16" stroke="var(--ink)" stroke-width="3" stroke-linecap="round"/>
        <line data-hand="min" x1="30" y1="30" x2="30" y2="9" stroke="var(--accent-teal)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="30" cy="30" r="2" fill="var(--ink)"/>
      </svg>
    `;
  }

  function buildCard(clock) {
    const id = clock.id;
    const card = el('div', { className: 'clock-card' + (clock.isLocal ? ' is-local' : '') });
    card.dataset.id = id;
    if (!clock.isLocal) card.draggable = true;

    card.innerHTML = `
      <div class="card-sky"><div class="card-sky-marker" data-marker="${id}"></div></div>
      <div class="card-top">
        <div class="card-label-group">
          <div class="card-city">${escapeHtml(clock.label)}</div>
          <div class="card-day-rel" data-dayrel="${id}">Today</div>
        </div>
        ${clock.isLocal
          ? '<span class="card-pin">This device</span>'
          : `<button class="card-more" data-more="${id}" title="Rename or remove" aria-label="Rename or remove">⋯</button>`}
      </div>
      <div class="card-body">
        <div class="card-digital">
          <div class="card-time" data-time="${id}">--:--</div>
          <div class="card-meta">
            <span class="card-offset" data-offset="${id}"></span>
            <span data-date="${id}"></span>
          </div>
        </div>
        ${dialSvg(id)}
      </div>
      ${clock.isLocal ? '' : '<span class="drag-handle" title="Drag to reorder">⠿⠿</span>'}
    `;

    cardRefs.set(id, {
      card,
      timeEl: card.querySelector(`[data-time="${id}"]`),
      offsetEl: card.querySelector(`[data-offset="${id}"]`),
      dateEl: card.querySelector(`[data-date="${id}"]`),
      dayRelEl: card.querySelector(`[data-dayrel="${id}"]`),
      markerEl: card.querySelector(`[data-marker="${id}"]`),
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

    emptyState.hidden = true; // local card always present
    tick();
  }

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
  function tick() {
    const t = now();
    cardRefs.forEach((ref) => {
      const map = partsFor(t, ref.timeZone);
      const hh = map.hour || '--';
      const mm = map.minute || '--';
      const ss = map.second || '--';
      const dayPeriod = map.dayPeriod ? ' ' + map.dayPeriod : '';
      ref.timeEl.innerHTML = `${hh}:${mm}<span class="sec">:${ss}${dayPeriod}</span>`;
      ref.offsetEl.textContent = offsetLabel(ref.timeZone, t);
      ref.dateEl.textContent = `${map.weekday}, ${map.month} ${map.day}`;
      ref.dayRelEl.textContent = dayRelativeLabel(ref.timeZone, t);

      const frac = hourFraction(ref.timeZone, t);
      ref.markerEl.style.left = (frac * 100).toFixed(2) + '%';

      const h24 = frac * 24;
      const hourAngle = ((h24 % 12) / 12) * 360;
      const minAngle = ((h24 * 60) % 60) / 60 * 360;
      setHand(ref.hourHand, 30, 30, 16, hourAngle);
      setHand(ref.minHand, 30, 30, 9, minAngle);
    });
  }

  function setHand(lineEl, cx, cy, len, angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    const x2 = cx + len * Math.cos(rad);
    const y2 = cy + len * Math.sin(rad);
    lineEl.setAttribute('x2', x2.toFixed(1));
    lineEl.setAttribute('y2', y2.toFixed(1));
  }

  setInterval(tick, 1000);

  // ---------- Theme ----------
  $('#themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', cur);
    try { localStorage.setItem('wc-theme', cur); } catch (e) {}
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
  let allZones = [];

  async function ensureZones() {
    if (allZones.length) return;
    try {
      const res = await fetch('/api/timezones');
      allZones = await res.json();
    } catch (e) {
      allZones = [{ timeZone: LOCAL_TZ, offset: '' }];
    }
  }

  function renderTzList(query) {
    const q = (query || '').trim().toLowerCase();
    const matches = allZones.filter(z => z.timeZone.toLowerCase().replace(/_/g, ' ').includes(q)).slice(0, 200);
    tzList.innerHTML = '';
    if (!matches.length) {
      tzList.innerHTML = '<div class="tz-row"><span class="tz-row-name">No matches</span></div>';
      return;
    }
    matches.forEach((z) => {
      const row = el('div', { className: 'tz-row' });
      row.innerHTML = `<span class="tz-row-name">${friendlyLabel(z.timeZone)} <span class="tz-row-offset">${z.timeZone.replace(/_/g, ' ')}</span></span><span class="tz-row-offset">${z.offset || ''}</span>`;
      row.addEventListener('click', () => addClock(z.timeZone));
      tzList.appendChild(row);
    });
  }

  async function addClock(timeZone) {
    try {
      const res = await fetch('/api/clocks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeZone, label: friendlyLabel(timeZone) })
      });
      const clock = await res.json();
      state.clocks.push(clock);
      buildGrid();
      addBackdrop.hidden = true;
      toast(`Added ${clock.label}`);
    } catch (e) {
      toast('Could not add that clock — check the connection');
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
    await loadClocks();
    await syncTime(false);
    setInterval(() => syncTime(false), 5 * 60 * 1000); // background re-sync every 5 min
  })();
})();
