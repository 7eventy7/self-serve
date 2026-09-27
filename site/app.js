(() => {
  'use strict';

  // Must match MERGEABLE in build.mjs: JSON files several modules may share.
  const MERGEABLE = /^assets\/[^/]+\/(?:lang\/[^/]+\.json|atlases\/[^/]+\.json|font\/[^/]+\.json|sounds\.json)$/;
  const STORE_KEY = 'pack-builder:v1';

  const $ = (sel, el = document) => el.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(c));
    return node;
  };
  const svg = (path, extra = '') =>
    new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" ${extra}>${path}</svg>`, 'image/svg+xml').documentElement;
  const ICON = {
    check: '<path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.4"/>',
    chev: '<path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    down: '<path d="M8 1v9m0 0L4.5 6.5M8 10l3.5-3.5M2 12v2.5h12V12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/>',
    warn: '<path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6v3.5M8 11.2v1" stroke="currentColor" stroke-width="1.6"/>',
    merge: '<path d="M4 2v4a4 4 0 0 0 4 4h0a4 4 0 0 1 4 4M12 2v4a4 4 0 0 1-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  };

  const fmt = new Intl.NumberFormat();
  const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  const state = {
    manifest: null,
    version: null,           // version object
    modules: new Map(),      // id -> { ...module, category }
    selected: new Set(),
    collapsed: new Set(),
    query: '',
    stats: null,             // { total, modules: { id: n } } or null if unavailable
    busy: false,
  };

  // ---------- Persistence (URL hash + localStorage) ----------
  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {}; } catch { return {}; }
  }
  function writeStore() {
    try {
      const store = readStore();
      store.version = state.version.id;
      store.selected = [...state.selected];
      store.collapsed = [...state.collapsed];
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch { /* storage unavailable — selection just won't persist */ }
  }
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    return { v: p.get('v'), m: p.has('m') ? p.get('m').split(',').filter(Boolean) : null };
  }
  function shareUrl() {
    const p = new URLSearchParams();
    p.set('v', state.version.id);
    if (state.selected.size) p.set('m', orderedSelection().map((m) => m.id).join(','));
    return `${location.origin}${location.pathname}#${p.toString().replace(/%2C/g, ',')}`;
  }
  function syncUrl() {
    history.replaceState(null, '', shareUrl());
  }

  // ---------- Toasts ----------
  function toast(msg, kind = '') {
    const t = el('div', { class: `toast ${kind}` }, msg);
    $('#toasts').append(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3800);
  }

  // ---------- Version handling ----------
  function setVersion(id) {
    const v = state.manifest.versions.find((x) => x.id === id) ?? state.manifest.versions[0];
    state.version = v;
    state.modules.clear();
    for (const cat of v.categories) for (const m of cat.modules) state.modules.set(m.id, { ...m, category: cat });
    $('#version-select').value = v.id;

    // Keep whatever was selected that still exists in this version.
    const dropped = [...state.selected].filter((id) => !state.modules.has(id));
    dropped.forEach((id) => state.selected.delete(id));
    resolveConflicts();
    return dropped;
  }

  // If a stored/shared selection contains conflicting modules, keep the first.
  function resolveConflicts() {
    const kept = new Set();
    for (const id of state.selected) {
      const m = state.modules.get(id);
      if (!m) continue;
      if (Object.keys(m.conflicts).some((c) => kept.has(c))) continue;
      kept.add(id);
    }
    state.selected = kept;
  }

  function orderedSelection() {
    const out = [];
    for (const cat of state.version.categories) for (const m of cat.modules) if (state.selected.has(m.id)) out.push(state.modules.get(m.id));
    return out;
  }

  // ---------- Selection ----------
  function select(id, { quiet = false } = {}) {
    const m = state.modules.get(id);
    if (!m || state.selected.has(id)) return [];
    const removed = Object.keys(m.conflicts).filter((c) => state.selected.has(c));
    removed.forEach((c) => state.selected.delete(c));
    state.selected.add(id);
    if (removed.length && !quiet) {
      const names = removed.map((c) => state.modules.get(c).name).join(', ');
      toast(`Deselected ${names} — it changes the same files as ${m.name}.`, 'warn');
    }
    return removed;
  }

  function toggle(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else select(id);
    update();
  }

  function selectCategory(cat, on) {
    if (!on) {
      cat.modules.forEach((m) => state.selected.delete(m.id));
    } else {
      let skipped = 0;
      for (const m of cat.modules) {
        if (state.selected.has(m.id)) continue;
        const clash = Object.keys(m.conflicts).some((c) => state.selected.has(c));
        if (clash) { skipped++; continue; }
        state.selected.add(m.id);
      }
      if (skipped) toast(`Skipped ${skipped} tweak${skipped > 1 ? 's' : ''} that conflict with ones already selected.`, 'warn');
    }
    update();
  }

  // ---------- Rendering ----------
  function renderVersions() {
    const sel = $('#version-select');
    sel.replaceChildren(...state.manifest.versions.map((v) =>
      el('option', { value: v.id }, v.id === state.manifest.latest ? `${v.label} (latest)` : v.label)));
  }

  function moduleIcon(m, cls) {
    if (m.icon) return el('img', { class: cls, src: m.icon, alt: '', width: 44, height: 44, loading: 'lazy' });
    return el('div', { class: `${cls} placeholder`, 'aria-hidden': 'true' }, m.name.charAt(0));
  }

  function renderCards() {
    const root = $('#categories');
    root.replaceChildren();
    for (const cat of state.version.categories) {
      const grid = el('div', { class: 'grid' });
      for (const m of cat.modules) {
        const conflictNames = Object.keys(m.conflicts).map((c) => state.modules.get(c)?.name).filter(Boolean);
        const meta = el('div', { class: 'card-meta' },
          el('span', { class: 'dl-count', 'data-id': m.id, hidden: !state.stats }, svg(ICON.down), '0'),
          conflictNames.length ? el('span', { class: 'conflict', title: `Changes the same files as: ${conflictNames.join(', ')}` }, svg(ICON.warn), `Conflicts with ${conflictNames.join(', ')}`) : null,
          m.merges ? el('span', { title: 'Shares language/atlas/sound files with other tweaks; they are merged automatically.' }, svg(ICON.merge), 'Merges') : null,
        );
        grid.append(el('button', {
          class: 'card', type: 'button', 'data-id': m.id, 'aria-pressed': 'false',
          'data-search': `${m.name} ${m.description} ${cat.name}`.toLowerCase(),
          onclick: () => toggle(m.id),
        },
        moduleIcon(m, 'card-icon'),
        el('div', { class: 'card-body' },
          el('div', { class: 'card-name' }, m.name),
          m.description ? el('div', { class: 'card-desc' }, m.description) : null,
          meta),
        el('span', { class: 'check', 'aria-hidden': 'true' }, svg(ICON.check))));
      }

      const section = el('section', { class: `category${state.collapsed.has(cat.id) ? ' collapsed' : ''}`, 'data-cat': cat.id },
        el('div', { class: 'category-head' },
          el('button', {
            class: 'category-toggle', type: 'button', 'aria-expanded': String(!state.collapsed.has(cat.id)),
            onclick: (e) => {
              const collapsed = section.classList.toggle('collapsed');
              e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
              collapsed ? state.collapsed.add(cat.id) : state.collapsed.delete(cat.id);
              writeStore();
            },
          },
          svg(ICON.chev, 'class="chev"'),
          cat.icon ? el('img', { class: 'category-icon pixel', src: cat.icon, alt: '', width: 28, height: 28 }) : null,
          el('div', {}, el('h2', {}, cat.name), cat.description ? el('p', { class: 'category-desc' }, cat.description) : null)),
          el('span', { class: 'category-count' }, `0/${cat.modules.length}`),
          el('div', { class: 'category-actions' },
            el('button', { class: 'btn-ghost', type: 'button', onclick: () => selectCategory(cat, true) }, 'All'),
            el('button', { class: 'btn-ghost', type: 'button', onclick: () => selectCategory(cat, false) }, 'None'))),
        grid);
      root.append(section);
    }
    applySearch();
    renderStats();
  }

  function applySearch() {
    const q = state.query.trim().toLowerCase();
    let any = false;
    for (const section of document.querySelectorAll('.category')) {
      let shown = 0;
      for (const card of section.querySelectorAll('.card')) {
        const hit = !q || card.dataset.search.includes(q);
        card.hidden = !hit;
        if (hit) shown++;
      }
      section.hidden = shown === 0;
      if (q && shown) section.classList.remove('collapsed');
      else if (!q) section.classList.toggle('collapsed', state.collapsed.has(section.dataset.cat));
      any ||= shown > 0;
    }
    $('#no-results').hidden = any || !state.modules.size;
  }

  function update() {
    for (const card of document.querySelectorAll('.card')) {
      card.setAttribute('aria-pressed', String(state.selected.has(card.dataset.id)));
    }
    for (const cat of state.version.categories) {
      const n = cat.modules.filter((m) => state.selected.has(m.id)).length;
      const badge = $(`.category[data-cat="${CSS.escape(cat.id)}"] .category-count`);
      if (badge) { badge.textContent = `${n}/${cat.modules.length}`; badge.classList.toggle('has', n > 0); }
    }
    const sel = orderedSelection();
    $('#selected-count').textContent = sel.length;
    $('#selected-label').textContent = sel.length === 1 ? 'tweak selected' : 'tweaks selected';
    const bytes = sel.reduce((n, m) => n + m.size, 0);
    $('#dock-detail').textContent = sel.length ? `${state.version.label} · ~${fmtBytes(bytes)} · ${sel.map((m) => m.name).join(', ')}` : `Minecraft ${state.version.label}`;
    $('#download-btn').disabled = !sel.length || state.busy;
    $('#clear-btn').disabled = !sel.length;
    syncUrl();
    writeStore();
  }

  // ---------- Stats ----------
  async function loadStats() {
    try {
      const res = await fetch('api/stats', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      if (typeof data.total !== 'number') throw new Error('bad payload');
      state.stats = data;
    } catch {
      state.stats = null;  // No Functions/D1 (e.g. plain static preview) — hide stats.
    }
    renderStats();
  }

  function renderStats() {
    const has = !!state.stats;
    $('#stats-btn').hidden = !has;
    if (!has) return;
    $('#total-downloads').textContent = fmt.format(state.stats.total);
    for (const span of document.querySelectorAll('.dl-count')) {
      const n = state.stats.modules[span.dataset.id] ?? 0;
      span.hidden = false;
      span.lastChild.textContent = fmt.format(n);
      span.title = `${fmt.format(n)} download${n === 1 ? '' : 's'}`;
    }
  }

  function openStats() {
    if (!state.stats) return;
    $('#stats-total').textContent = fmt.format(state.stats.total);
    const rows = [...state.modules.values()]
      .map((m) => ({ m, n: state.stats.modules[m.id] ?? 0 }))
      .sort((a, b) => b.n - a.n || a.m.name.localeCompare(b.m.name));
    const max = Math.max(1, ...rows.map((r) => r.n));
    $('#stats-note').textContent = `Per-tweak counts include every version. Showing tweaks available for ${state.version.label}.`;
    $('#stats-list').replaceChildren(...rows.map(({ m, n }) => el('li', {},
      m.icon ? el('img', { src: m.icon, alt: '' }) : el('span', { class: 'ph' }),
      el('span', { class: 'name' }, m.name, el('span', { class: 'muted small' }, ` · ${m.category.name}`)),
      el('span', { class: 'num' }, fmt.format(n)),
      el('div', { class: 'bar' }, el('div', { style: `width:${(n / max) * 100}%` })))));
    $('#stats-dialog').showModal();
  }

  function recordDownload(mods) {
    // Optimistic local bump so the counters move immediately.
    if (state.stats) {
      state.stats.total++;
      for (const m of mods) state.stats.modules[m.id] = (state.stats.modules[m.id] ?? 0) + 1;
      renderStats();
    }
    fetch('api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: state.version.id, modules: mods.map((m) => m.id) }),
      keepalive: true,
    }).catch(() => {});
  }

  // ---------- Pack assembly ----------
  // Objects merge key-by-key, arrays concatenate (atlas "sources", font
  // "providers", sound lists), anything else: the later module wins.
  function deepMerge(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
      return out;
    }
    return b;
  }

  const stripBom = (s) => s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;

  function setProgress(frac) {
    $('#progress').hidden = frac == null;
    $('#progress-bar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
  }

  async function download() {
    const mods = orderedSelection();
    if (!mods.length || state.busy) return;
    if (typeof JSZip === 'undefined') { toast('The zip library failed to load — refresh and try again.', 'warn'); return; }

    state.busy = true;
    const btn = $('#download-btn'), label = $('#download-label');
    btn.disabled = true;
    const v = state.version, site = state.manifest.site;

    try {
      const out = new JSZip();
      const merged = new Map();   // path -> parsed JSON
      const owner = new Map();    // path -> module name (for overwrite warnings)

      for (let i = 0; i < mods.length; i++) {
        const m = mods[i];
        label.textContent = `Fetching ${i + 1}/${mods.length}`;
        setProgress((i / mods.length) * 0.7);
        const res = await fetch(m.zip);
        if (!res.ok) throw new Error(`Couldn't fetch ${m.name} (${res.status})`);
        const zip = await JSZip.loadAsync(await res.arrayBuffer());

        for (const entry of Object.values(zip.files)) {
          if (entry.dir) continue;
          const p = entry.name;
          if (MERGEABLE.test(p)) {
            try {
              const data = JSON.parse(stripBom(await entry.async('string')));
              merged.set(p, merged.has(p) ? deepMerge(merged.get(p), data) : data);
              continue;
            } catch { /* not valid JSON — fall through and copy it as-is */ }
          }
          if (owner.has(p)) console.warn(`${p}: ${m.name} overwrote ${owner.get(p)}`);
          owner.set(p, m.name);
          out.file(p, await entry.async('uint8array'));
        }
      }
      for (const [p, data] of merged) out.file(p, JSON.stringify(data, null, 2));

      const ids = mods.map((m) => m.id);
      const mcmeta = {
        pack: {
          ...v.pack,
          description: `${site.packName} for ${v.label} · ${mods.length} tweak${mods.length === 1 ? '' : 's'}`,
        },
        installed_modules: {
          builder: site.title,
          ...(site.url ? { url: site.url } : {}),
          minecraft_version: v.id,
          generated: new Date().toISOString(),
          modules: ids,
        },
      };
      out.file('pack.mcmeta', JSON.stringify(mcmeta, null, 2));

      out.file('Selected Tweaks.txt', [
        `${site.title} — ${site.packName}`,
        `Minecraft ${v.label}, built ${new Date().toUTCString()}`,
        site.url ? `Rebuild or change this pack: ${site.url}#v=${encodeURIComponent(v.id)}&m=${ids.join(',')}` : '',
        '',
        ...mods.map((m) => `- ${m.name} [${m.id}] (${m.category.name})`),
        '',
      ].filter((l, i) => l !== '' || i > 2).join('\n'));

      const iconUrl = v.packPng ?? 'pack.png';
      try {
        const r = await fetch(iconUrl);
        if (r.ok) out.file('pack.png', await r.arrayBuffer());
      } catch { /* pack works without an icon */ }

      label.textContent = 'Zipping…';
      const blob = await out.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (meta) => setProgress(0.7 + (meta.percent / 100) * 0.3));

      const safeName = site.packName.replace(/[^\w.-]+/g, '-');
      const filename = `${safeName}-${v.id}-${mods.length}tweaks.zip`;
      const a = el('a', { href: URL.createObjectURL(blob), download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);

      recordDownload(mods);
      toast(`Downloaded ${filename}. Drop it in your resourcepacks folder.`);
    } catch (err) {
      console.error(err);
      toast(`Download failed: ${err.message}`, 'warn');
    } finally {
      state.busy = false;
      label.textContent = 'Download pack';
      setProgress(null);
      update();
    }
  }

  // ---------- Boot ----------
  async function init() {
    try {
      const res = await fetch('manifest.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      state.manifest = await res.json();
    } catch {
      $('#status').textContent = 'Could not load the pack list. Try refreshing.';
      return;
    }
    const { site } = state.manifest;
    document.title = site.title;
    $('#site-title').textContent = site.title;
    $('#site-tagline').textContent = site.tagline;
    $('#footer-text').textContent = [site.author && `Packs by ${site.author}`, 'Not affiliated with Mojang or Microsoft.'].filter(Boolean).join(' · ');

    const store = readStore();
    const hash = readHash();
    state.collapsed = new Set(store.collapsed ?? []);
    state.selected = new Set(hash.m ?? store.selected ?? []);

    renderVersions();
    const known = (id) => state.manifest.versions.some((v) => v.id === id);
    setVersion(known(hash.v) ? hash.v : known(store.version) && !hash.m ? store.version : state.manifest.latest);
    renderCards();
    update();

    $('#version-select').addEventListener('change', (e) => {
      const dropped = setVersion(e.target.value);
      renderCards();
      update();
      if (dropped.length) toast(`${dropped.length} selected tweak${dropped.length > 1 ? 's aren’t' : ' isn’t'} available for ${state.version.label}.`, 'warn');
    });
    $('#search').addEventListener('input', (e) => { state.query = e.target.value; applySearch(); });
    $('#clear-btn').addEventListener('click', () => { state.selected.clear(); update(); });
    $('#share-btn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(shareUrl()); toast('Share link copied.'); }
      catch { prompt('Copy this link:', shareUrl()); }
    });
    $('#download-btn').addEventListener('click', download);
    $('#stats-btn').addEventListener('click', openStats);
    $('#stats-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    window.addEventListener('hashchange', () => {
      const h = readHash();
      if (h.m) state.selected = new Set(h.m);
      if (h.v && h.v !== state.version.id) { setVersion(h.v); renderCards(); } else resolveConflicts();
      update();
    });

    loadStats();
  }

  init();
})();
