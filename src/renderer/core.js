'use strict';
// MacAIterm renderer core: tabs, terminal panes, AI timeline, approvals, input dock.
// Panels (settings, history, command blocks, processes, onboarding, updates) live in panels.js and use window.AITCore.
(() => {
  const ait = window.ait;
  const $ = (id) => document.getElementById(id);
  const I18N = window.AIT_I18N;
  const ui = { usage: null, mode: 'ai', home: '', llm: null, build: null, settings: null, stats: null, plan: false, lang: 'ko', fontStacks: {}, locale: 'ko' };
  const tabs = new Map(); // id -> tab
  let order = []; // tab ids in display order
  let T = null; // active tab
  const paneIndex = new Map(); // pty id (tab id or pane id) -> { tab, pane }
  const actions = new Map(); // menu / shortcut actions registered by panels.js
  const t = (key, vars) => I18N.t(ui.lang, key, vars);

  // ================= theme =================
  const XTERM_THEMES = {
    dark: {
      background: '#0b0d11', foreground: '#d4d8e0', cursor: '#9d8cff', cursorAccent: '#0b0d11', selectionBackground: 'rgba(157,140,255,.35)',
      black: '#1b1f27', red: '#f2606b', green: '#4cc38a', yellow: '#f2b84b', blue: '#5aa9ff', magenta: '#c08cff', cyan: '#4fd1d9', white: '#d4d8e0',
      brightBlack: '#5d6575', brightRed: '#ff7b86', brightGreen: '#6fe0a7', brightYellow: '#ffd070', brightBlue: '#7dbbff', brightMagenta: '#d6a8ff', brightCyan: '#74e3ea', brightWhite: '#ffffff',
    },
    light: {
      background: '#fbfbfd', foreground: '#1f2430', cursor: '#5b46d6', cursorAccent: '#fbfbfd', selectionBackground: 'rgba(91,70,214,.25)',
      black: '#1f2430', red: '#c8323f', green: '#198754', yellow: '#9a6700', blue: '#1e6fd0', magenta: '#8250df', cyan: '#0f7f8a', white: '#8a92a2',
      brightBlack: '#5b6475', brightRed: '#e5484d', brightGreen: '#1f9d63', brightYellow: '#b26b00', brightBlue: '#3b8ae8', brightMagenta: '#9a6ae8', brightCyan: '#1596a3', brightWhite: '#d0d5de',
    },
  };
  const THEME_KEY = 'ait-theme';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  let themePref = null; // null = follow system
  try { themePref = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
  const currentTheme = () => (themePref === 'light' || themePref === 'dark' ? themePref : mq.matches ? 'dark' : 'light');
  const allPanes = () => [...paneIndex.values()].map((x) => x.pane);
  function applyTheme() {
    const th = currentTheme();
    document.documentElement.dataset.theme = th;
    $('btn-theme').replaceChildren(icon(th === 'dark' ? 'sun' : 'moon'));
    $('btn-theme').title = th === 'dark' ? t('theme.toLight') : t('theme.toDark');
    $('btn-theme').setAttribute('aria-label', $('btn-theme').title);
    allPanes().forEach((p) => { p.term.options.theme = XTERM_THEMES[th]; });
    ait.setTheme(th); // new vim sessions pick the matching colour scheme
  }
  function toggleTheme() {
    themePref = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, themePref); } catch { /* ignore */ }
    applyTheme();
  }
  mq.addEventListener('change', () => { if (!themePref) applyTheme(); });
  document.documentElement.dataset.theme = currentTheme();

  // ================= icons (inline SVG — no dependency on emoji fonts) =================
  // 'F:' prefix = filled shape, otherwise stroked outline
  const SHIELD = '<path d="M12 2.6l7.6 2.9v6.3c0 4.7-3.2 8.2-7.6 9.7-4.4-1.5-7.6-5-7.6-9.7V5.5L12 2.6z" fill="currentColor" fill-opacity=".2"/>';
  const ICONS = {
    shield: SHIELD,
    'shield-ok': SHIELD + '<path d="M8.4 12.1l2.5 2.5 4.7-5"/>',
    'shield-eye': SHIELD + '<path d="M7.4 12s1.9-3 4.6-3 4.6 3 4.6 3-1.9 3-4.6 3-4.6-3-4.6-3z"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    'shield-ask': SHIELD + '<path d="M9.8 9.7a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.6"/><path d="M12 16.3v.01"/>',
    'shield-warn': SHIELD + '<path d="M12 8.2v4.4"/><path d="M12 15.9v.01"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M8 7h8"/>',
    pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    xcircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    sparkle: 'F:<path d="M12 2.5c.7 5.2 2.8 7.3 8 8-5.2.7-7.3 2.8-8 8-.7-5.2-2.8-7.3-8-8 5.2-.7 7.3-2.8 8-8z"/><path d="M19 15.5c.25 1.8 1 2.55 2.8 2.8-1.8.25-2.55 1-2.8 2.8-.25-1.8-1-2.55-2.8-2.8 1.8-.25 2.55-1 2.8-2.8z"/>',
    stop: 'F:<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    caret: '<path d="M6 9l6 6 6-6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    gpu: '<rect x="2.5" y="5.5" width="19" height="11" rx="2"/><circle cx="9" cy="11" r="3"/><path d="M9 8.6v4.8M6.6 11h4.8M7.3 9.3l3.4 3.4M10.7 9.3l-3.4 3.4" stroke-width="1.3"/><path d="M15 9h4M15 11.5h4M15 14h2.5"/><path d="M5 16.5v3M8 16.5v3"/>',
    ram: '<rect x="2.5" y="7" width="19" height="9" rx="1.8"/><path d="M6 10v3M10 10v3M14 10v3M18 10v3"/><path d="M6 16v2.5M10 16v2.5M14 16v2.5M18 16v2.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    checklist: '<path d="M3.5 6.5l1.5 1.5 3-3M3.5 12.5l1.5 1.5 3-3M3.5 18.5l1.5 1.5 3-3"/><path d="M12 6.5h9M12 12.5h9M12 18.5h9"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    play: 'F:<path d="M7 4.5v15l12-7.5z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
    upload: '<path d="M12 20V8M7 12l5-5 5 5M4 4h16"/>',
    file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M9.9 5.2A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a15 15 0 0 1-2.9 3.7M6.3 6.8A15 15 0 0 0 2.5 12S6 19 12 19c1.4 0 2.7-.3 3.8-.8"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    symlink: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    chevr: '<path d="M9 6l6 6-6 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  };
  function icon(name) {
    const s = document.createElement('span');
    s.className = 'ic';
    const def = ICONS[name] || '';
    const filled = def.startsWith('F:');
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${filled ? 1.2 : 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${filled ? def.slice(2) : def}</svg>`;
    return s;
  }
  const titled = (name, text, cls = 'ttl') => {
    const e = document.createElement('span');
    e.className = cls;
    e.append(icon(name), document.createTextNode(text));
    return e;
  };
  const withIcon = (tag, name, text, cls) => {
    const b = document.createElement(tag);
    if (cls) b.className = cls;
    b.append(icon(name), document.createTextNode(text));
    return b;
  };
  document.querySelectorAll('[data-ic]').forEach((n) => n.prepend(icon(n.dataset.ic)));

  // ================= helpers =================
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  function richText(container, text) {
    String(text).split(/(`[^`\n]+`)/g).forEach((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) container.append(el('code', '', part.slice(1, -1)));
      else container.append(document.createTextNode(part));
    });
    return container;
  }
  const fmtTok = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : Number(n || 0).toLocaleString('en-US'));
  const shortPath = (cwd) => (ui.home && cwd.startsWith(ui.home) ? '~' + cwd.slice(ui.home.length) : cwd);
  const input = $('input');
  const setting = (k) => (ui.settings ? ui.settings[k] : undefined);

  /** Translate texts that originate in the main process (policy reasons, agent notes) when the UI is English. */
  const tr = (s) => (ui.lang === 'en' ? I18N.translateMain(String(s)) : String(s));

  function applyI18n() {
    document.documentElement.lang = ui.lang;
    document.querySelectorAll('[data-i18n]').forEach((n) => {
      const txt = t(n.dataset.i18n);
      const ic = n.querySelector(':scope > .ic');
      n.textContent = '';
      if (ic) n.append(ic);
      n.append(document.createTextNode(txt));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); n.setAttribute('aria-label', n.title); });
    document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
    setMode(ui.mode);
  }

  // ================= tabs =================
  const PHASE_KEY = { idle: 'phase.idle', thinking: 'phase.thinking', running: 'phase.running', 'awaiting-approval': 'phase.approval', 'waiting-input': 'phase.input', busy: 'phase.busy' };

  function tabStatus(tab) {
    if (tab.pending) return 'approval';
    if (tab.state.aiBusy) return 'ai';
    if (tab.state.pty === 'busy') return 'busy';
    return 'idle';
  }
  function tabTitle(tab) {
    if (tab.customTitle) return tab.customTitle;
    const p = shortPath(tab.state.cwd || '~');
    if (p === '~' || p === '/') return p;
    return p.split('/').filter(Boolean).pop();
  }

  let dragId = null;
  function renderTabs() {
    const bar = $('tabbar');
    bar.innerHTML = '';
    order.forEach((id, i) => {
      const tab = tabs.get(id);
      const d = el('div', 'tab' + (tab === T ? ' active' : ''));
      d.dataset.status = tabStatus(tab);
      d.dataset.tab = id;
      d.draggable = true;
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-selected', String(tab === T));
      d.title = `${tab.state.cwd}\n(⌘${i + 1}): ${t('tab.renameHint')}`;
      d.append(el('span', 'tdot'), el('span', 'ttl', tabTitle(tab)));
      if (tab.remote) d.append(el('span', 'tremote', tab.remoteInfo ? tab.remoteInfo.label : t('tab.remote')));
      else if (tab.ssh && tab.ssh.active) d.append(el('span', 'tssh', tab.ssh.target ? tab.ssh.target.host : 'ssh'));
      if (i < 9) d.append(el('span', 'tnum', `⌘${i + 1}`));
      const x = el('span', 'tx', '×');
      x.title = t('tab.close');
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', t('tab.close'));
      x.onclick = (e) => { e.stopPropagation(); closeTab(id); };
      d.append(x);
      d.onclick = () => activate(id);
      d.onauxclick = (e) => { if (e.button === 1) closeTab(id); };
      d.ondblclick = (e) => { e.stopPropagation(); renameTab(tab, d); };
      d.ondragstart = (e) => { dragId = id; e.dataTransfer.effectAllowed = 'move'; };
      d.ondragover = (e) => { if (dragId && dragId !== id) { e.preventDefault(); d.classList.add('dragover'); } };
      d.ondragleave = () => d.classList.remove('dragover');
      d.ondrop = (e) => {
        e.preventDefault();
        d.classList.remove('dragover');
        if (!dragId || dragId === id) return;
        order = order.filter((x2) => x2 !== dragId);
        order.splice(order.indexOf(id) + (e.offsetX > d.clientWidth / 2 ? 1 : 0), 0, dragId);
        dragId = null;
        renderTabs();
      };
      d.ondragend = () => { dragId = null; };
      bar.append(d);
    });
    const plus = el('button', '', '+');
    plus.id = 'tab-new';
    plus.title = t('tab.new');
    plus.setAttribute('aria-label', t('tab.new'));
    plus.onclick = () => newTab();
    bar.append(plus);
    if (ui.build) {
      const tag = el('span', 'build-tag', t('build.tag', { v: ui.build.version, at: ui.build.builtAt }));
      tag.title = t('build.tip');
      bar.append(tag);
    }
  }

  function renameTab(tab, node) {
    const ttl = node.querySelector('.ttl');
    const inp = el('input', 'tab-rename');
    inp.value = tab.customTitle || tabTitle(tab);
    inp.setAttribute('aria-label', t('tab.rename'));
    ttl.replaceWith(inp);
    inp.focus();
    inp.select();
    let finished = false;
    const done = (save) => {
      if (finished) return;
      finished = true;
      if (save) {
        tab.customTitle = inp.value.trim().slice(0, 40);
        ait.tabTitle(tab.id, tab.customTitle);
      }
      renderTabs();
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
      e.stopPropagation();
    };
    inp.onblur = () => done(true);
  }

  function makeTabObject(id, snap, perm) {
    return {
      id,
      state: { pty: snap.state, cwd: snap.cwd, aiBusy: false, phase: 'idle', phaseSince: Date.now(), shellHist: [], aiHist: [], histIdx: -1, integrated: snap.integrated },
      cards: new Map(),
      pending: null,
      stick: true,
      line: '',
      dirty: false,
      hold: null,
      perm: perm || { mode: 'default', rules: [] },
      statusText: '',
      panes: { main: null, second: null },
      focus: 'main',
      blocks: [],
      remote: false,
      customTitle: '',
      live: null,
    };
  }

  async function newTab({ fromActive = true, cwd = null, title = '' } = {}) {
    const r = await ait.tabNew(fromActive && T ? T.id : null, cwd);
    const snap = { ...r.snap, integrated: true };
    const tab = makeTabObject(r.id, snap, r.perm);
    tab.customTitle = title || '';
    tabs.set(r.id, tab);
    order.push(r.id);
    // build DOM (visible first so xterm measures correctly)
    tab.termEl = el('div', 'term-wrap');
    $('terminal').append(tab.termEl);
    tab.tl = el('div', 'timeline');
    tab.tl.setAttribute('role', 'log');
    tab.tl.setAttribute('aria-live', 'polite');
    tab.tl.setAttribute('aria-label', t('a11y.timeline'));
    $('tl-host').append(tab.tl);
    tab.tl.addEventListener('scroll', () => { tab.stick = tab.tl.scrollHeight - tab.tl.scrollTop - tab.tl.clientHeight < 60; });
    activate(r.id, true);
    tab.panes.main = createPane(tab, r.id, true);
    tab.tl.append(welcome(tab));
    ait.snapshot(tab.id).then((s) => { if (s && s.supports === false) note(tab, t('note.shellUnsupported', { shell: s.shell || '?' }), 'warn'); });
    if (ui.llm && !ui.llm.active && ui.llm.problem && actions.get('model-problem')) actions.get('model-problem')(tab, ui.llm);
    const defPerm = setting('defaultPermission');
    if (defPerm && defPerm !== 'default') applyPerm(tab, await ait.permSet(tab.id, defPerm));
    doFit(tab);
    tab.panes.main.term.focus();
    return tab;
  }

  function activate(id, creating = false) {
    const tab = tabs.get(id);
    if (!tab) return;
    T = tab;
    ait.tabActive(id);
    tabs.forEach((x) => {
      const on = x === tab;
      x.termEl && x.termEl.classList.toggle('active', on);
      x.tl && x.tl.classList.toggle('active', on);
    });
    refreshChrome();
    if (!creating) {
      doFit(tab);
      focusPane(tab);
      if (tab.stick) tab.tl.scrollTop = tab.tl.scrollHeight;
    }
    actions.get('tab-activated') && actions.get('tab-activated')(tab);
    document.dispatchEvent(new CustomEvent('ait-tab-activated', { detail: { tab } }));
  }

  function switchRelative(delta) {
    if (order.length < 2) return;
    const i = order.indexOf(T.id);
    activate(order[(i + delta + order.length) % order.length]);
  }

  async function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    if ((tab.state.aiBusy || tab.state.pty === 'busy') && !confirm(t('tab.confirmClose', { name: tabTitle(tab) }))) return;
    const idx = order.indexOf(id);
    order = order.filter((x) => x !== id);
    tabs.delete(id);
    for (const p of [tab.panes.main, tab.panes.second]) if (p) { paneIndex.delete(p.id); p.term.dispose(); }
    tab.termEl.remove();
    tab.tl.remove();
    await ait.tabClose(id);
    if (!order.length) await newTab({ fromActive: false });
    else if (T === tab) activate(order[Math.min(idx, order.length - 1)]);
    else renderTabs();
  }

  // ================= terminal panes =================
  function termOptions() {
    return {
      fontFamily: ui.fontStacks[setting('fontFamily')] || ui.fontStacks['sf-mono'] || 'Menlo, monospace',
      fontSize: setting('fontSize') || 13,
      lineHeight: setting('lineHeight') || 1.18,
      cursorStyle: setting('cursorStyle') || 'block',
      cursorBlink: setting('cursorBlink') !== false,
      scrollback: setting('scrollback') || 10000,
    };
  }

  /** One xterm instance bound to a PTY. The primary pane carries the AI guard; the second pane is a plain shell. */
  function createPane(tab, id, primary) {
    const wrap = el('div', 'pane' + (primary ? ' pane-main' : ' pane-second'));
    wrap.dataset.pane = id;
    if (!primary) wrap.setAttribute('aria-label', t('pane.second'));
    tab.termEl.append(wrap);
    const term = new Terminal({ ...termOptions(), allowProposedApi: true, macOptionIsMeta: true, theme: XTERM_THEMES[currentTheme()] });
    const fit = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => ait.linkOpen('url', uri)));
    term.open(wrap);
    const pane = { id, term, fit, search, el: wrap, primary };
    paneIndex.set(id, { tab, pane });
    wrap.addEventListener('focusin', () => { tab.focus = primary ? 'main' : 'second'; });
    if (search.onDidChangeResults) search.onDidChangeResults(({ resultIndex, resultCount }) => { $('ts-count').textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : t('search.none'); });

    // file-path links ("src/app.js:12") — underlined only when the file exists; click reveals it in Finder
    const pathRe = /(?:~|\.{1,2})?\/?[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)+(?::\d+)?/g;
    const exists = new Map();
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1);
        const text = line ? line.translateToString(true) : '';
        const found = [];
        let m;
        pathRe.lastIndex = 0;
        while ((m = pathRe.exec(text))) if (!/^https?:/.test(text.slice(Math.max(0, m.index - 8), m.index))) found.push({ value: m[0].replace(/:\d+$/, ''), start: m.index, len: m[0].length });
        if (!found.length) return cb(undefined);
        const need = found.filter((f) => !exists.has(`${tab.state.cwd}\0${f.value}`));
        Promise.resolve(need.length ? ait.linkCheck(need.map((f) => f.value), tab.state.cwd) : []).then((res) => {
          need.forEach((f, i) => exists.set(`${tab.state.cwd}\0${f.value}`, res[i]));
          cb(found.filter((f) => exists.get(`${tab.state.cwd}\0${f.value}`)).map((f) => ({
            range: { start: { x: f.start + 1, y }, end: { x: f.start + f.len, y } },
            text: f.value,
            activate: () => ait.linkOpen('path', f.value, tab.state.cwd),
          })));
        });
        return undefined;
      },
    });

    if (primary) {
      // keystrokes typed directly: pass through, but never let natural language run as a command
      const trackKeys = (d) => {
        if (d === '\x7f') tab.line = Array.from(tab.line).slice(0, -1).join('');
        else if (d === '\x03' || d === '\x15' || d === '\x04') {
          tab.line = '';
          tab.dirty = false;
        } else if (d.charCodeAt(0) === 0x1b || d === '\t') tab.dirty = true;
        else if (!/[\x00-\x1f]/.test(d)) tab.line += d;
      };
      term.onData((d) => {
        if (tab.hold) return void tab.hold.push(d);
        if (tab.state.pty !== 'prompt' || tab.remote) {
          tab.line = '';
          tab.dirty = false;
          return ait.ptyInput(id, d);
        }
        if (d === '\r' && !tab.dirty && tab.line.trim()) {
          const typed = tab.line;
          tab.line = '';
          tab.hold = [];
          ait.classify(typed).then((res) => {
            const queued = tab.hold;
            tab.hold = null;
            if (res.natural) {
              ait.ptyInput(id, '\x15'); // wipe the line from the shell prompt; nothing is executed
              note(tab, t('note.naturalRouted', { reason: tr(res.reason) }), 'warn');
              submitAi(tab, typed);
            } else {
              ait.ptyInput(id, '\r');
              queued.forEach((q) => ait.ptyInput(id, q));
            }
          });
          return undefined;
        }
        if (d === '\r') {
          tab.line = '';
          tab.dirty = false;
        } else trackKeys(d);
        ait.ptyInput(id, d);
        return undefined;
      });
    } else {
      term.onData((d) => ait.ptyInput(id, d));
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'c' && term.hasSelection()) {
        ait.copy(term.getSelection());
        return false;
      }
      // app shortcuts (menu accelerators) must not be typed into the shell
      if (e.type === 'keydown' && e.metaKey && (['.', 't', 'w', 'f', 'd', 'y', 'b', ','].includes(e.key.toLowerCase()) || /^[1-9]$/.test(e.key))) return false;
      return true;
    });
    return pane;
  }

  function focusPane(tab) {
    const p = (tab.focus === 'second' && tab.panes.second) || tab.panes.main;
    p && p.term.focus();
  }

  function doFit(tab = T) {
    if (!tab || tab !== T) return;
    for (const p of [tab.panes.main, tab.panes.second]) {
      if (!p) continue;
      try {
        p.fit.fit();
        ait.ptyResize(p.id, p.term.cols, p.term.rows);
      } catch {
        /* not laid out yet */
      }
    }
  }
  let fitTimer;
  new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => doFit(), 60);
  }).observe($('terminal'));

  async function toggleSplit() {
    const tab = T;
    if (!tab) return;
    if (tab.panes.second) {
      const p = tab.panes.second;
      tab.panes.second = null;
      paneIndex.delete(p.id);
      p.term.dispose();
      p.el.remove();
      tab.focus = 'main';
      await ait.paneClose(tab.id, p.id);
    } else {
      const r = await ait.paneNew(tab.id);
      if (!r) return;
      tab.panes.second = createPane(tab, r.id, false);
      tab.focus = 'second';
    }
    tab.termEl.classList.toggle('split', !!tab.panes.second);
    $('btn-split').classList.toggle('on', !!tab.panes.second);
    doFit(tab);
    focusPane(tab);
  }

  ait.onPtyData(({ id, d }) => { const x = paneIndex.get(id); if (x) x.pane.term.write(d); });
  ait.onPtyExit(({ id }) => {
    const x = paneIndex.get(id);
    if (!x) return;
    if (!x.pane.primary) { if (x.tab.panes.second && x.tab.panes.second.id === id && x.tab === T) toggleSplit(); return; }
    x.pane.term.write(`\r\n\x1b[33m${t('term.exited')}\x1b[0m\r\n`);
  });
  ait.onPtyState(({ id, state, cwd }) => {
    const x = paneIndex.get(id);
    if (!x || !x.pane.primary) return;
    x.tab.state.pty = state;
    x.tab.state.cwd = cwd;
    if (x.tab === T) refreshChrome(); else renderTabs();
  });

  // ---- command blocks (collected here, shown by panels.js)
  ait.onBlockStart(({ id, command, by, at }) => {
    const tab = tabs.get(id);
    if (!tab) return;
    tab.blocks.push({ command, by, at, running: true, exitCode: null, output: '', outputRaw: '', durationMs: 0, cwd: tab.state.cwd });
    if (tab.blocks.length > 100) tab.blocks.shift();
    actions.get('blocks-changed') && actions.get('blocks-changed')(tab);
  });
  ait.onBlockEnd(({ id, record }) => {
    const tab = tabs.get(id);
    if (!tab) return;
    const b = [...tab.blocks].reverse().find((x) => x.running && x.command === record.command) || [...tab.blocks].reverse().find((x) => x.running);
    if (b) Object.assign(b, { running: false, exitCode: record.exitCode, output: record.output, outputRaw: record.outputRaw, durationMs: record.durationMs, cwd: record.cwd });
    actions.get('blocks-changed') && actions.get('blocks-changed')(tab);
  });

  // ================= appearance (settings) =================
  function applyAppearance() {
    const o = termOptions();
    allPanes().forEach((p) => {
      for (const k of Object.keys(o)) if (p.term.options[k] !== o[k]) p.term.options[k] = o[k];
    });
    doFit();
  }

  // ================= terminal search (⌘F) =================
  const SEARCH_DECO = { matchBackground: '#7a6a1f', matchBorder: '#b8a02e', matchOverviewRuler: '#b8a02e', activeMatchBackground: '#9d8cff', activeMatchBorder: '#d6a8ff', activeMatchColorOverviewRuler: '#9d8cff' };
  const curPane = () => (T ? (T.focus === 'second' && T.panes.second) || T.panes.main : null);
  function searchRun(dir) {
    const p = curPane();
    const q = $('ts-input').value;
    if (!p) return;
    if (!q) { p.search.clearDecorations(); $('ts-count').textContent = ''; return; }
    const opts = { decorations: SEARCH_DECO, caseSensitive: $('ts-case').classList.contains('on'), regex: $('ts-regex').classList.contains('on'), incremental: dir === 'inc' };
    const found = dir === 'prev' ? p.search.findPrevious(q, opts) : p.search.findNext(q, opts);
    if (!found) $('ts-count').textContent = t('search.none');
  }
  function openSearch() {
    $('termsearch').hidden = false;
    $('ts-input').focus();
    $('ts-input').select();
  }
  function closeSearch() {
    $('termsearch').hidden = true;
    allPanes().forEach((p) => p.search.clearDecorations());
    $('ts-count').textContent = '';
    T && focusPane(T);
  }
  $('ts-input').addEventListener('input', () => searchRun('inc'));
  $('ts-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchRun(e.shiftKey ? 'prev' : 'next'); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
  });
  $('ts-next').onclick = () => searchRun('next');
  $('ts-prev').onclick = () => searchRun('prev');
  $('ts-close').onclick = closeSearch;
  $('ts-case').onclick = () => { $('ts-case').classList.toggle('on'); searchRun('inc'); };
  $('ts-regex').onclick = () => { $('ts-regex').classList.toggle('on'); searchRun('inc'); };

  // ================= header / status chrome (reflects the active tab) =================
  function refreshChrome() {
    if (!T) return;
    const cwd = T.state.cwd;
    const short = shortPath(cwd);
    $('cwd-text').textContent = short;
    $('cwd').title = t('cwd.tip', { cwd });
    $('prompt-cwd').textContent = short.split('/').filter(Boolean).slice(-2).join('/') || short;
    let phase = T.state.phase;
    if (phase === 'idle' && T.state.pty === 'busy') phase = 'busy';
    $('state').dataset.phase = phase;
    $('state-text').textContent = t(PHASE_KEY[phase] || 'phase.idle');
    $('statusbar').dataset.phase = T.state.phase;
    $('status-text').textContent = tr(T.statusText) || t(PHASE_KEY[T.state.phase] || 'phase.idle');
    if (T.pending) showBar(T.pending.ev); else hideBar();
    $('btn-split').classList.toggle('on', !!T.panes.second);
    $('remote-toggle').classList.toggle('on', !!T.remote);
    $('remote-toggle').setAttribute('aria-pressed', String(!!T.remote));
    renderPerm();
    renderTabs();
  }
  $('cwd').addEventListener('click', () => T && ait.copy(T.state.cwd));

  function setPhase(tab, phase, text) {
    tab.state.phase = phase;
    tab.state.phaseSince = Date.now();
    tab.statusText = text || '';
    if (tab === T) refreshChrome(); else renderTabs();
  }
  setInterval(() => {
    $('status-time').textContent = !T || T.state.phase === 'idle' ? '' : `${Math.floor((Date.now() - T.state.phaseSince) / 1000)}s`;
  }, 500);

  // ================= system monitor (GPU / memory / loaded model) =================
  const level = (pct) => (pct >= 85 ? 'err' : pct >= 60 ? 'warn' : 'ok');
  function setBar(id, pct, cls) {
    const f = $(id);
    f.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    f.parentElement.parentElement.dataset.level = cls;
  }
  let lastMemWarn = 0;
  const onStats = (st) => {
    ui.stats = st;
    actions.get('stats') && actions.get('stats')(st);
    const c = st.cpu;
    if (c && c.pct !== null) {
      setBar('cpu-fill', c.pct, level(c.pct));
      $('cpu-val').textContent = `${c.pct}%`;
      $('sm-cpu').title = t('mon.cpuTip', { pct: c.pct, cores: c.cores });
    }
    const g = st.gpu;
    if (g) {
      setBar('gpu-fill', g.util, level(g.util));
      $('gpu-val').textContent = `${g.util}%`;
      $('sm-gpu').title = t('mon.gpuTip', { name: g.name, cores: g.cores ? ` (${g.cores})` : '', util: g.util, mem: g.usedGB !== null ? t('mon.gpuMem', { gb: g.usedGB }) : '' });
    } else {
      $('gpu-val').textContent = 'n/a';
      $('sm-gpu').title = t('mon.gpuNone');
    }
    const m = st.mem;
    setBar('mem-fill', m.usedPct, level(m.usedPct));
    $('mem-val').textContent = `${m.availGB}GB`;
    $('sm-mem').title = t('mon.memTip', { avail: m.availGB, total: m.totalGB, pct: m.usedPct });
    const mdl = st.models[0];
    const act = ui.llm && ui.llm.active;
    const picked = act ? act.label.replace(/^Ollama · /, '') : t('mon.noModel');
    if (act && act.id !== 'ollama') {
      const ses = ui.usage && ui.usage.local && ui.usage.local.session;
      $('mdl-val').textContent = t('mon.cloud', { m: picked }) + (ses && ses.total ? ` · ${t('mon.tokens', { n: fmtTok(ses.total) })}` : '');
      $('sm-model').dataset.loaded = '0';
      $('sm-model').title = t('mon.cloudTip');
    } else if (mdl) {
      const kv = ui.kv;
      $('mdl-val').textContent = t('mon.loaded', { name: mdl.name, gb: mdl.sizeGB }) + (kv ? ` · KV ${kv.kvType}` : '');
      $('sm-model').dataset.loaded = '1';
      $('sm-model').title = t('mon.loadedTip', { list: st.models.map((x) => `${x.name} (${x.sizeGB}GB, GPU ${x.gpuPct}%)`).join(', ') }) + (kv ? '\n' + t('mon.kvTip', { type: kv.kvType, gb: kv.kvGB, ctx: Math.round(kv.ctx / 1024), prompt: kv.promptTokens, sec: (kv.promptMs / 1000).toFixed(1), gen: kv.evalTokens, engine: kv.engine === 'managed' ? t('mon.kvManaged') : t('mon.kvShared') }) : '');
    } else {
      $('mdl-val').textContent = t('mon.idle', { m: picked });
      $('sm-model').dataset.loaded = '0';
      $('sm-model').title = t('mon.idleTip', { m: picked });
    }
    // memory guard: tell the user (once in a while) when the Mac is short on memory while a model is loaded
    if (mdl && m.availGB < 2 && T && Date.now() - lastMemWarn > 300000) {
      lastMemWarn = Date.now();
      const c = note(T, t('mem.low', { gb: m.availGB }), 'warn');
      const b = withIcon('button', 'gear', ' ' + t('mem.openSettings'), 'btn');
      b.style.marginLeft = '8px';
      b.onclick = () => actions.get('settings') && actions.get('settings')();
      c.append(b);
    }
  };
  ait.onSysStats(onStats);

  // ================= model chip =================
  function renderModel(st) {
    ui.llm = st;
    const dot = $('model-dot');
    if (st && !st.active && !st.problem && !(st.providers || []).length) {
      dot.className = 'dot';
      $('model-text').textContent = t('model.checking');
    } else if (st && st.active) {
      dot.className = 'dot ok';
      $('model-text').textContent = tr(st.active.label);
      $('model').title = t('model.tip');
      actions.get('model-ok') && actions.get('model-ok')();
    } else {
      dot.className = 'dot bad';
      $('model-text').textContent = t('model.none');
      if (st && st.problem && T) actions.get('model-problem') && actions.get('model-problem')(T, st);
    }
    renderPop();
  }
  ait.onLlmStatus(renderModel);

  const MODEL_NOTE = (m) => {
    if (!m.sizeGB) return '';
    if (/:(1[2-9]|[2-9][0-9])b/.test(m.name) || m.sizeGB >= 8) return t('model.note.big');
    if (/qwen3:8b/.test(m.name)) return t('model.note.default');
    if (m.sizeGB < 3) return t('model.note.tiny');
    return t('model.note.light');
  };
  function renderPop() {
    const pop = $('model-pop');
    const st = ui.llm;
    if (!st) return;
    pop.innerHTML = '';
    pop.append(el('h4', '', t('model.pop.title')));
    for (const p of st.providers) {
      const row = el('div', 'prov');
      const d = el('span', 'dot ' + (p.ok ? 'ok' : 'bad'));
      d.style.marginTop = '5px';
      const tt = el('div', 't');
      tt.append(el('div', '', tr(p.label)));
      const s = el('div', '', tr(p.detail || ''));
      s.style.color = 'var(--dim)';
      tt.append(s);
      if (p.hint) tt.append(el('div', 'hint', tr(p.hint)));
      if (p.remote) tt.append(el('div', 'hint', t('model.remoteWarn')));
      const ses = p.id === 'openai' && ui.usage && ui.usage.local && ui.usage.local.session;
      if (ses && ses.calls) tt.append(el('div', 'tok', t('model.tokens', { in: fmtTok(ses.input), out: fmtTok(ses.output) })));
      const isActive = !!(st.active && st.active.id === p.id);
      const use = el('button', 'btn' + (isActive ? ' using' : ''), isActive ? t('model.using') : t('model.use'));
      use.disabled = !p.ok || isActive;
      use.onclick = async () => renderModel(await ait.llmPrefer(p.id));
      row.append(d, tt, use);
      pop.append(row);
      if ((p.id === 'ollama' || p.id === 'openai') && p.models && p.models.length) {
        const list = el('div', 'models');
        list.append(el('h4', '', t('model.installed')));
        p.models.forEach((m) => {
          const o = el('div', 'mopt' + (m.name === p.model ? ' sel' : ''));
          o.setAttribute('role', 'button');
          o.append(el('span', 'rad'));
          const mt = el('div', 'mt');
          mt.append(el('div', 'mn', `${m.name}${m.sizeGB ? `  ·  ${m.sizeGB}GB` : ''}${m.params ? '  ·  ' + m.params : ''}`), el('div', 'md', MODEL_NOTE(m)));
          o.append(mt);
          const sel = m.name === p.model && st.active && st.active.id === p.id;
          o.append(el('span', 'mbadge' + (sel ? ' on' : ''), sel ? t('model.using') : t('model.use')));
          o.onclick = async () => { o.classList.add('loading'); renderModel(await ait.llmSetModel(m.name, p.id)); };
          list.append(o);
        });
        pop.append(list);
      }
    }
    const r = el('div', 'row');
    const rb = withIcon('button', 'refresh', ' ' + t('model.recheck'), 'btn');
    rb.onclick = async () => renderModel(await ait.llmDetect());
    r.append(rb);
    pop.append(r);
  }
  $('model').addEventListener('click', (e) => {
    e.stopPropagation();
    $('model-pop').hidden = !$('model-pop').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!$('model-pop').contains(e.target)) $('model-pop').hidden = true;
  });

  // ================= timeline (per tab) =================
  function push(tab, node) {
    tab.tl.append(node);
    if (tab.stick) tab.tl.scrollTop = tab.tl.scrollHeight;
    return node;
  }
  function note(tab, text, cls = '') {
    return push(tab, richText(el('div', 'note ' + cls), tr(text)));
  }
  function userMsg(tab, text, shell) {
    return push(tab, el('div', 'msg user' + (shell ? ' shell' : ''), shell ? '$ ' + text : text));
  }

  function welcome() {
    const w = el('div', 'welcome');
    const h3 = withIcon('h3', 'sparkle', ' MacAIterm');
    w.append(h3, el('p', '', t('welcome.body')));
    const ex = el('div', 'ex');
    ['welcome.ex1', 'welcome.ex2', 'welcome.ex3', 'welcome.ex4', 'welcome.ex5'].forEach((k) => {
      const b = el('button', '', t(k));
      b.onclick = () => { setMode('ai'); input.value = t(k); input.focus(); autoGrow(); };
      ex.append(b);
    });
    w.append(ex);
    return w;
  }

  function cmdCard(tab, ev) {
    const c = el('div', 'card cmd');
    const hd = el('div', 'hd');
    hd.append(el('span', 'ttl', t('card.run')), el('span', 'pill run', t('card.running')), el('span', 'meta', ev.cwd || ''));
    c.append(hd, el('div', 'cmdline', ev.command));
    tab.cards.set(ev.id, c);
    return push(tab, c);
  }
  function fillResult(c, ev) {
    c.className = 'card cmd ' + (ev.status === 'done' ? (ev.exitCode === 0 ? 'ok' : 'fail') : '');
    const pill = c.querySelector('.pill');
    let label;
    let cls;
    if (ev.status === 'done') {
      label = ev.exitCode === 0 ? t('card.ok') : t('card.fail', { code: ev.exitCode });
      cls = ev.exitCode === 0 ? 'ok' : 'fail';
    } else if (ev.status === 'running') {
      label = t('card.stillRunning');
      cls = 'warn';
    } else if (ev.status === 'aborted') {
      label = t('card.aborted');
      cls = 'warn';
    } else {
      label = ev.status;
      cls = 'fail';
    }
    pill.className = 'pill ' + cls;
    pill.textContent = label + (ev.durationMs ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : '');
    const meta = c.querySelector('.meta');
    if (meta && ev.cwd) meta.textContent = ev.cwd;
    c.querySelectorAll('.out, details').forEach((n) => n.remove());
    if (ev.output && ev.output.trim()) {
      const lines = ev.output.split('\n').length;
      const pre = el('pre', 'out', ev.output);
      if (lines > 8) {
        const d = el('details');
        d.append(el('summary', '', t('card.outputLines', { n: lines })), pre);
        c.append(d);
      } else c.append(pre);
    }
  }

  // ---- approvals (per tab; the bar shows the active tab's pending request)
  function showBar(ev) {
    $('ap-cmd').textContent = ev.command;
    $('ap-cmd').title = ev.command;
    $('ap-why').textContent = (ev.reasons || []).map(tr).join(' · ');
    $('ap-always').hidden = !ev.rule;
    $('ap-always-proj').hidden = !ev.rule || !!ev.remote;
    $('ap-host').hidden = !ev.remote;
    $('ap-host').textContent = ev.remote ? `⇄ ${ev.remote}` : '';
    if (ev.rule) $('ap-rule').textContent = `"${ev.rule.label}"` + (ev.rule.exact ? ' ' + t('ap.exactOnly') : '');
    if ($('approval-bar').hidden) $('ap-fb').value = '';
    $('approval-bar').hidden = false;
    doFit();
  }
  function hideBar() {
    if ($('approval-bar').hidden) return;
    $('approval-bar').hidden = true;
    doFit();
  }
  /** choice: once | always | project | deny */
  function answerApproval(choice, feedback = '', tab = T) {
    if (!tab || !tab.pending) return;
    if ((choice === 'always' || choice === 'project') && !tab.pending.rule) choice = 'once';
    const { id, card, rule } = tab.pending;
    tab.pending = null;
    ait.approve(tab.id, id, choice !== 'deny', { always: choice === 'project' ? 'project' : choice === 'always', feedback });
    card.classList.add('done');
    const msg = { once: t('ap.doneOnce'), always: t('ap.doneAlways', { r: rule && rule.label }), project: t('ap.doneProject', { r: rule && rule.label }), deny: feedback ? t('ap.doneDenyFb', { fb: feedback }) : t('ap.doneDeny') }[choice];
    card.append(el('div', 'note', msg));
    if (tab === T) { hideBar(); input.focus(); }
    renderTabs();
  }
  $('ap-once').onclick = () => answerApproval('once');
  $('ap-always').onclick = () => answerApproval('always');
  $('ap-always-proj').onclick = () => answerApproval('project');
  $('ap-no').onclick = () => answerApproval('deny');
  $('ap-fb').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      answerApproval('deny', e.target.value.trim());
    }
  });

  function approvalCard(tab, ev) {
    const c = el('div', 'card approval');
    c.setAttribute('role', 'alert');
    const hd = el('div', 'hd');
    hd.append(titled('alert', ' ' + (ev.kind === 'file' ? t('card.approveFile') : t('card.approve'))), ...(ev.remote ? [el('span', 'remote-badge', `⇄ ${ev.remote}`)] : []), el('span', 'meta', ev.cwd || ''));
    c.append(hd, el('div', 'cmdline', ev.command));
    const ul = el('ul', 'why');
    ev.reasons.forEach((r) => ul.append(el('li', '', tr(r))));
    c.append(ul);
    if (ev.diff) {
      const d = el('pre', 'diff');
      ev.diff.lines.forEach((l) => d.append(el('span', l.startsWith('+') ? 'add' : 'rem', l)));
      c.append(d);
    }
    const acts = el('div', 'acts');
    const yes = el('button', 'btn yes', t('ap.once'));
    const always = el('button', 'btn always', ev.remote ? t('ap.alwaysRemote', { r: ev.rule ? ev.rule.label : '', host: ev.remote }) : t('ap.alwaysBtn', { r: ev.rule ? ev.rule.label : '' }));
    const proj = el('button', 'btn always', t('ap.projectBtn', { r: ev.rule ? ev.rule.label : '' }));
    const no = el('button', 'btn no', t('ap.deny'));
    yes.onclick = () => answerApproval('once', '', tab);
    always.onclick = () => answerApproval('always', '', tab);
    proj.onclick = () => answerApproval('project', '', tab);
    no.onclick = () => answerApproval('deny', '', tab);
    acts.append(yes);
    if (ev.rule) acts.append(...(ev.remote ? [always] : [always, proj]));
    acts.append(no);
    c.append(acts);
    tab.cards.set(ev.id, c);
    tab.pending = { id: ev.id, card: c, rule: ev.rule || null, ev };
    if (tab === T) showBar(ev); else renderTabs();
    return push(tab, c);
  }

  // ---- plan card (plan mode)
  function planCard(tab, ev) {
    const c = el('div', 'card plan');
    const hd = el('div', 'hd');
    hd.append(titled('checklist', ' ' + t('plan.title')), el('span', 'meta', ev.round ? t('plan.round', { n: ev.round + 1 }) : ''));
    c.append(hd);
    if (ev.say) c.append(el('div', 'plan-say', ev.say));
    const ol = el('ol', 'plan-steps');
    ev.steps.forEach((s) => ol.append(el('li', '', s)));
    c.append(ol);
    const fb = el('input', 'plan-fb');
    fb.placeholder = t('plan.feedbackPh');
    fb.setAttribute('aria-label', t('plan.feedbackPh'));
    const acts = el('div', 'acts');
    const go = withIcon('button', 'play', ' ' + t('plan.approve'), 'btn yes');
    const rev = el('button', 'btn always', t('plan.revise'));
    const cancel = el('button', 'btn no', t('plan.cancel'));
    const lock = (msg) => { c.classList.add('done'); acts.remove(); fb.remove(); c.append(el('div', 'note', msg)); tab.cards.delete(ev.id); };
    go.onclick = () => { ait.approve(tab.id, ev.id, true); lock(t('plan.approved')); };
    const doRevise = () => { const v = fb.value.trim(); if (!v) { fb.focus(); return; } ait.approve(tab.id, ev.id, false, { feedback: v }); lock(t('plan.revising', { fb: v })); };
    rev.onclick = doRevise;
    fb.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doRevise(); } };
    cancel.onclick = () => { ait.approve(tab.id, ev.id, false, { cancel: true }); lock(t('plan.cancelled')); };
    acts.append(go, rev, cancel);
    c.append(fb, acts);
    tab.cards.set(ev.id, c);
    return push(tab, c);
  }

  function errorCard(tab, ev) {
    const c = el('div', 'card error');
    c.setAttribute('role', 'alert');
    const hd = el('div', 'hd');
    hd.append(titled('xcircle', ' ' + (I18N.has(ev.kind && 'err.' + ev.kind) ? t('err.' + ev.kind) : t('err.failed'))));
    c.append(hd, el('div', 'body', tr(ev.message)));
    if (ev.hint) c.append(el('div', 'hint', t('err.recovery', { hint: tr(ev.hint) })));
    if (['not-installed', 'not-authenticated', 'outdated', 'server-down', 'model-missing', 'network', 'timeout', 'failed'].includes(ev.kind)) {
      const acts = el('div', 'acts');
      const b = withIcon('button', 'refresh', ' ' + t('err.recheck'), 'btn');
      b.onclick = async () => {
        b.textContent = t('err.checking');
        const s = await ait.llmDetect();
        b.textContent = s.active ? t('err.connected', { m: s.active.label }) : t('err.stillDown');
      };
      acts.append(b);
      c.append(acts);
    }
    return push(tab, c);
  }

  function fileCard(tab, ev, write) {
    const c = el('div', 'card file');
    const hd = el('div', 'hd');
    hd.append(write ? titled('pencil', ' ' + (ev.created ? t('file.created') : t('file.edited'))) : titled('book', ' ' + t('file.read')), el('span', 'meta', ev.path));
    c.append(hd);
    if (write && ev.diff) {
      hd.append(el('span', 'pill ok', `+${ev.diff.added} / -${ev.diff.removed}`));
      const d = el('pre', 'diff');
      ev.diff.lines.forEach((l) => d.append(el('span', l.startsWith('+') ? 'add' : 'rem', l)));
      c.append(d);
      if (ev.undoId) {
        const bar = el('div', 'acts');
        const ub = withIcon('button', 'undo', ' ' + t('file.undo'), 'btn');
        const msg = el('span', 'undo-msg');
        ub.onclick = async () => {
          ub.disabled = true;
          const r = await ait.undoFile(tab.id, ev.undoId);
          msg.textContent = tr(r.message);
          msg.className = 'undo-msg ' + (r.ok ? 'ok' : 'bad');
          if (!r.ok) ub.disabled = false;
        };
        bar.append(ub, msg);
        c.append(bar);
      }
    }
    return push(tab, c);
  }

  /** The live (still generating) bubble becomes the final message; no flicker. */
  function finishLive(tab) {
    if (!tab.live) return null;
    const b = tab.live;
    tab.live = null;
    b.classList.remove('live');
    return b;
  }
  function dropLive(tab) {
    if (tab.live) { tab.live.remove(); tab.live = null; }
  }

  ait.onAiEvent(({ id, ev }) => {
    const tab = tabs.get(id);
    if (!tab) return;
    switch (ev.type) {
      case 'turn-start':
        tab.state.aiBusy = true;
        setPhase(tab, 'thinking');
        break;
      case 'status':
        setPhase(tab, ev.phase, ev.text);
        if (ev.phase === 'waiting-input' && tab === T) focusPane(tab);
        break;
      case 'say-stream':
        if (!tab.live) {
          tab.live = el('div', 'msg ai live');
          push(tab, tab.live);
        }
        tab.live.textContent = ev.text;
        if (tab.stick) tab.tl.scrollTop = tab.tl.scrollHeight;
        break;
      case 'say': {
        const b = finishLive(tab);
        if (b) { b.textContent = ''; richText(b, tr(ev.text)); } else push(tab, richText(el('div', 'msg ai'), tr(ev.text)));
        break;
      }
      case 'model':
        if (ui.llm && ui.llm.active && ui.llm.active.label !== ev.label) $('model-text').textContent = ev.label;
        break;
      case 'command-start':
        cmdCard(tab, ev);
        break;
      case 'command-result': {
        let c = tab.cards.get(ev.id);
        if (!c) c = cmdCard(tab, { id: ev.id, command: ev.command, cwd: ev.cwd });
        fillResult(c, ev);
        if (tab.stick) tab.tl.scrollTop = tab.tl.scrollHeight;
        break;
      }
      case 'command-blocked': {
        const c = el('div', 'card blocked');
        const bh = el('div', 'hd');
        bh.append(titled('ban', ' ' + t('card.blocked')));
        c.append(bh, el('div', 'cmdline', ev.command), el('div', 'body', ev.reasons.map(tr).join('\n')));
        push(tab, c);
        break;
      }
      case 'remote':
        tab.remote = !!ev.on;
        tab.remoteInfo = ev.on ? ev.info || null : null;
        if (tab === T) refreshChrome(); else renderTabs();
        document.dispatchEvent(new CustomEvent('ait-remote', { detail: { tab, ev } }));
        break;
      case 'approval':
        approvalCard(tab, ev);
        break;
      case 'approval-result': {
        const c = tab.cards.get(ev.id);
        if (c) c.classList.add('done');
        if (tab.pending && tab.pending.id === ev.id) { tab.pending = null; if (tab === T) hideBar(); renderTabs(); }
        break;
      }
      case 'plan':
        planCard(tab, ev);
        break;
      case 'plan-result': {
        const c = tab.cards.get(ev.id);
        if (c && !c.classList.contains('done')) { c.classList.add('done'); c.querySelectorAll('.acts, .plan-fb').forEach((n) => n.remove()); }
        break;
      }
      case 'search': {
        const c = el('div', 'card file');
        const hd = el('div', 'hd');
        hd.append(titled('search', ' ' + t('file.search', { p: ev.pattern })), el('span', 'meta', ev.path));
        c.append(hd);
        push(tab, c);
        break;
      }
      case 'file-read':
        fileCard(tab, ev, false);
        break;
      case 'file-write':
        fileCard(tab, ev, true);
        break;
      case 'error':
        dropLive(tab);
        errorCard(tab, ev);
        break;
      case 'aborted':
        dropLive(tab);
        note(tab, t('note.aborted'), 'warn');
        break;
      case 'token-usage':
        break; // the per-turn total arrives with the summary event; the running totals via usage:update
      case 'kv-usage':
        ui.kv = ev.usage;
        break;
      case 'note':
        note(tab, ev.text, 'warn');
        break;
      case 'rule-added':
        note(tab, ev.scope === 'project' ? t('note.ruleProject', { l: ev.label }) : t('note.ruleSession', { l: ev.label }));
        ait.permGet(tab.id).then((st) => applyPerm(tab, st));
        break;
      case 'ask':
        note(tab, t('note.ask'));
        break;
      case 'summary':
        if (ev.commands || ev.files || ev.tokens) {
          const parts = [];
          if (ev.commands || ev.files) parts.push(t('summary.line', { c: ev.commands, f: ev.failed, n: ev.files }));
          if (ev.tokens) parts.push(t('summary.tokens', { in: fmtTok(ev.tokens.input), out: fmtTok(ev.tokens.output), est: ev.tokens.estimated ? t('summary.estSuffix') : '' }));
          push(tab, el('div', 'summary', parts.join('  ·  ')));
        }
        break;
      case 'turn-end':
        dropLive(tab);
        if (tab.pending) { tab.pending = null; if (tab === T) hideBar(); }
        tab.state.aiBusy = false;
        setPhase(tab, 'idle');
        if (tab === T) input.focus();
        break;
      default:
        break;
    }
  });

  // ================= input dock =================
  function setMode(m) {
    ui.mode = m;
    document.body.dataset.mode = m;
    $('mode-ai').classList.toggle('active', m === 'ai');
    $('mode-sh').classList.toggle('active', m === 'sh');
    $('mode-ai').setAttribute('aria-selected', String(m === 'ai'));
    $('mode-sh').setAttribute('aria-selected', String(m === 'sh'));
    input.placeholder = m === 'ai' ? t('dock.phAi') : t('dock.phSh');
    if (T) T.state.histIdx = -1;
  }
  $('mode-ai').onclick = () => (setMode('ai'), input.focus());
  $('mode-sh').onclick = () => (setMode('sh'), input.focus());
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(140, input.scrollHeight) + 'px';
  }
  input.addEventListener('input', autoGrow);

  // plan mode toggle
  try { ui.plan = localStorage.getItem('ait-plan') === '1'; } catch { /* ignore */ }
  function setPlan(on) {
    ui.plan = !!on;
    $('plan-toggle').classList.toggle('on', ui.plan);
    $('plan-toggle').setAttribute('aria-pressed', String(ui.plan));
    try { localStorage.setItem('ait-plan', ui.plan ? '1' : '0'); } catch { /* ignore */ }
  }
  $('plan-toggle').onclick = () => setPlan(!ui.plan);

  // remote (ssh / nested shell) mode: the AI works ON the server — commands, files, search
  async function setRemote(on) {
    if (!T) return null;
    const tab = T;
    if (on && !(tab.ssh && tab.ssh.active) && !confirm(t('remote.confirm'))) return null; // a nested shell, not a detected ssh session
    $('remote-toggle').disabled = true;
    try {
      const r = await ait.remoteSet(tab.id, on);
      if (!r || !r.ok) {
        note(tab, t('remote.fail', { why: tr((r && r.reason) || '') }), 'warn');
        return r;
      }
      tab.remote = !!r.remote;
      tab.remoteInfo = r.info || null;
      note(tab, tab.remote ? t('remote.on', { host: r.info ? r.info.label : '' }) : t('remote.off'), tab.remote ? 'info' : '');
      refreshChrome();
      return r;
    } finally {
      $('remote-toggle').disabled = false;
    }
  }
  $('remote-toggle').onclick = () => setRemote(!(T && T.remote));

  function submitAi(tab, text) {
    const s = text.trim();
    if (!s) return;
    if (tab.state.aiBusy) return note(tab, tab.pending ? t('note.busyApproval') : t('note.busy'), 'warn');
    tab.state.aiHist.push(s);
    userMsg(tab, s, false);
    ait.aiSubmit(tab.id, s, ui.plan);
    return undefined;
  }
  async function submitShell(tab, text) {
    const s = text.trim();
    if (!s) return undefined;
    tab.state.shellHist.push(s);
    const res = await ait.shellRun(tab.id, s);
    if (!res.ok) return note(tab, tr(res.reason), 'warn');
    userMsg(tab, s, true);
    focusPane(tab);
    return undefined;
  }
  async function submit() {
    const tab = T;
    const s = input.value.trim();
    if (!s || !tab) return undefined;
    input.value = '';
    autoGrow();
    tab.state.histIdx = -1;
    if (ui.mode === 'ai') {
      if (s.startsWith('!')) return submitShell(tab, s.slice(1));
      return submitAi(tab, s);
    }
    if (s.startsWith('?')) return submitAi(tab, s.slice(1));
    const res = await ait.classify(s);
    if (res.natural) {
      note(tab, t('note.naturalRouted', { reason: tr(res.reason) }), 'warn');
      return submitAi(tab, s);
    }
    return submitShell(tab, s);
  }
  window.addEventListener('keydown', (e) => {
    if (!T || !T.pending) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answerApproval(e.shiftKey ? 'always' : 'once'); }
    else if (e.key === 'Escape') { e.preventDefault(); answerApproval('deny'); }
  }, true);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      if (e.shiftKey && ui.mode === 'ai') return;
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setMode(ui.mode === 'ai' ? 'sh' : 'ai');
    } else if (e.key === 'Escape') {
      if (T && T.state.aiBusy) stop();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing && T) {
      const st = T.state;
      const hist = ui.mode === 'ai' ? st.aiHist : st.shellHist;
      if (!hist.length) return;
      if (e.key === 'ArrowUp' && (input.value === '' || st.histIdx !== -1) && input.selectionStart === 0) {
        e.preventDefault();
        st.histIdx = st.histIdx === -1 ? hist.length - 1 : Math.max(0, st.histIdx - 1);
        input.value = hist[st.histIdx];
        autoGrow();
      } else if (e.key === 'ArrowDown' && st.histIdx !== -1) {
        e.preventDefault();
        st.histIdx++;
        input.value = st.histIdx >= hist.length ? '' : hist[st.histIdx];
        if (st.histIdx >= hist.length) st.histIdx = -1;
        autoGrow();
      }
    }
  });
  $('btn-send').onclick = submit;

  // ================= permission mode (per tab) =================
  const PERM_IDS = ['readonly', 'default', 'ask-all', 'trust'];
  const PERM_ICON = { readonly: 'shield-eye', default: 'shield-ok', 'ask-all': 'shield-ask', trust: 'shield-warn' };
  function renderPerm() {
    if (!T) return;
    const ps = T.perm;
    $('perm-chip').replaceChildren(icon(PERM_ICON[ps.mode] || 'shield-ok'), document.createTextNode(t('perm.chip', { m: t('perm.' + ps.mode + '.short'), n: ps.rules.length ? t('perm.rules', { n: ps.rules.length }) : '' })), icon('caret'));
    $('perm-chip').dataset.mode = ps.mode;
    const pop = $('perm-pop');
    pop.innerHTML = '';
    pop.append(el('h4', '', t('perm.title')));
    PERM_IDS.forEach((pid) => {
      const o = el('div', 'opt' + (pid === ps.mode ? ' sel' : '') + (pid === 'trust' ? ' danger' : ''));
      o.setAttribute('role', 'button');
      const pi = icon(PERM_ICON[pid]);
      pi.classList.add('pico', 'pm-' + pid);
      o.append(pi);
      const tt = el('div');
      tt.append(el('div', 't', t('perm.' + pid + '.name')), el('div', 'd', t('perm.' + pid + '.desc')));
      o.append(tt);
      o.onclick = () => setPerm(T, pid);
      pop.append(o);
    });
    const rules = el('div', 'rules');
    rules.append(el('h4', '', t('perm.rulesTitle', { n: ps.rules.length })));
    if (!ps.rules.length) rules.append(el('div', 'none', t('perm.rulesNone')));
    ps.rules.forEach((r) => {
      const row = el('div', 'rule');
      const tag = el('em', 'rtag', r.scope === 'project' ? t('perm.scopeProject') : t('perm.scopeSession'));
      const rm = el('button', '', t('perm.remove'));
      rm.onclick = async () => applyPerm(T, await ait.permRemove(T.id, r.key));
      row.append(tag, el('span', '', r.label), rm);
      rules.append(row);
    });
    pop.append(rules);
  }
  function applyPerm(tab, st) {
    tab.perm = { mode: st.mode, rules: st.rules };
    if (tab === T) renderPerm();
  }
  async function setPerm(tab, id) {
    if (id === 'trust' && !confirm(t('perm.trustConfirm'))) return;
    applyPerm(tab, await ait.permSet(tab.id, id));
    $('perm-pop').hidden = true;
    note(tab, t('note.permMode', { m: t('perm.' + id + '.name') }));
  }
  $('perm-chip').addEventListener('click', (e) => { e.stopPropagation(); $('perm-pop').hidden = !$('perm-pop').hidden; });
  document.addEventListener('click', (e) => { if (!$('perm-pop').contains(e.target)) $('perm-pop').hidden = true; });
  ait.onPermState(({ id, mode, rules }) => { const tb = tabs.get(id); if (tb) applyPerm(tb, { mode, rules }); });

  // ================= toolbar actions =================
  function stop() {
    if (!T) return;
    if (T.state.aiBusy) {
      ait.aiAbort(T.id);
      setPhase(T, 'thinking', t('note.stopping'));
    } else if (T.state.pty === 'busy') {
      ait.ptyInput(T.id, '\x03');
      note(T, t('note.sigint'), 'warn');
    }
  }
  function bufferText(tab = T) {
    const p = (tab.focus === 'second' && tab.panes.second) || tab.panes.main;
    const b = p.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true));
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }
  function copyOutput() {
    const p = curPane();
    const sel = p.term.hasSelection() ? p.term.getSelection() : '';
    const text = sel || bufferText();
    ait.copy(text);
    note(T, sel ? t('note.copiedSel', { n: sel.length }) : t('note.copiedAll', { n: text.length }));
  }
  async function resetSession() {
    const tab = T;
    if (!confirm(t('reset.confirm'))) return;
    const snap = await ait.resetSession(tab.id);
    tab.panes.main.term.reset();
    tab.tl.innerHTML = '';
    tab.cards.clear();
    tab.pending = null;
    tab.live = null;
    tab.blocks = [];
    tab.state.aiBusy = false;
    tab.state.pty = snap.state;
    tab.state.cwd = snap.cwd;
    tab.line = '';
    tab.dirty = false;
    tab.remote = false;
    setPhase(tab, 'idle');
    tab.tl.append(welcome());
    if (ui.llm && !ui.llm.active && ui.llm.problem && actions.get('model-problem')) actions.get('model-problem')(tab, ui.llm);
    refreshChrome();
    doFit();
    focusPane(tab);
  }
  $('btn-theme').onclick = toggleTheme;
  $('btn-stop').onclick = stop;
  $('btn-copy').onclick = copyOutput;
  $('btn-reset').onclick = resetSession;
  $('btn-search').onclick = () => ($('termsearch').hidden ? openSearch() : closeSearch());
  $('btn-split').onclick = toggleSplit;
  $('btn-blocks').onclick = () => actions.get('blocks') && actions.get('blocks')();
  $('btn-procs').onclick = () => actions.get('processes') && actions.get('processes')();
  $('btn-history').onclick = () => actions.get('history') && actions.get('history')();
  $('btn-settings').onclick = () => actions.get('settings') && actions.get('settings')();

  const MENU_ACTIONS = {
    stop, copy: copyOutput, reset: resetSession, theme: toggleTheme,
    'focus-ai': () => input.focus(), 'focus-term': () => T && focusPane(T),
    'toggle-mode': () => { setMode(ui.mode === 'ai' ? 'sh' : 'ai'); input.focus(); }, 'toggle-plan': () => setPlan(!ui.plan),
    'new-tab': () => newTab(), 'close-tab': () => T && closeTab(T.id), 'next-tab': () => switchRelative(1), 'prev-tab': () => switchRelative(-1),
    search: () => ($('termsearch').hidden ? openSearch() : closeSearch()), split: toggleSplit,
  };
  ait.onMenu((a) => {
    if (MENU_ACTIONS[a]) return MENU_ACTIONS[a]();
    if (/^tab-\d$/.test(a)) { const tid = order[Number(a.slice(4)) - 1]; if (tid) activate(tid); return undefined; }
    if (actions.get(a)) return actions.get(a)();
    return undefined;
  });

  // `MacAIterm --ssh=<host>` (menu-bar server list): open a tab and run the ssh command once its shell is ready.
  // main hands over only commands built by connectCommand() from a validated destination.
  let externalBusy = false;
  async function openExternal() {
    if (externalBusy) return; // the running loop also picks up a request that arrives meanwhile
    externalBusy = true;
    try {
      for (let list = await ait.externalTake(); list.length; list = await ait.externalTake()) {
        for (const r of list) {
          const tab = await newTab({ fromActive: false, title: r.target });
          let sent = false;
          for (let i = 0; i < 40 && !sent; i++) {
            const res = await ait.shellRun(tab.id, r.cmd); // refused while the shell is still starting
            if (res && res.ok) sent = true;
            else await new Promise((done) => setTimeout(done, 250));
          }
          if (!sent) ait.ptyInput(tab.id, `\x15${r.cmd}\r`); // no shell integration: type it anyway
          activate(tab.id);
        }
      }
    } finally {
      externalBusy = false;
    }
  }
  ait.onExternal(openExternal);

  // splitter between terminal and AI pane
  (() => {
    const sp = $('splitter');
    let drag = false;
    sp.addEventListener('mousedown', () => (drag = true));
    window.addEventListener('mouseup', () => (drag = false));
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const w = Math.min(Math.max(window.innerWidth - e.clientX, 320), window.innerWidth - 340);
      $('ai-pane').style.flexBasis = w + 'px';
    });
  })();

  // ================= shared API for panels.js =================
  function onSettingsChanged(vals) {
    const prevLang = ui.lang;
    ui.settings = vals;
    ui.lang = vals.language === 'auto' ? ui.autoLang || 'ko' : vals.language;
    applyAppearance();
    $('sysmon').style.display = vals.showMonitor ? '' : 'none';
    if (prevLang !== ui.lang) { applyI18n(); applyTheme(); refreshChrome(); if (ui.llm) renderModel(ui.llm); }
    actions.get('settings-changed') && actions.get('settings-changed')(vals);
  }
  window.AITCore = {
    ait, $, el, icon, withIcon, titled, richText, t, tr, ui, fmtTok, tabs, getOrder: () => order.slice(), getTab: () => T, note, push, submitAi, submitShell, userMsg,
    registerAction: (name, fn) => actions.set(name, fn), setting, setRemote, activate, newTab, closeTab, applyI18n, onSettingsChanged, applyPerm, refreshChrome, doFit, setPlan, renderModel,
  };

  // running API token totals (usage.js) → monitor chip + model popover
  ait.onUsage((summary) => {
    ui.usage = { ...(ui.usage || {}), local: summary };
    if (ui.stats) onStats(ui.stats);
    if (ui.llm) renderModel(ui.llm);
    actions.get('usage-changed') && actions.get('usage-changed')(summary);
  });

  // ================= boot =================
  (async () => {
    const info = await ait.info();
    ui.home = info.home;
    ui.build = info.build;
    ui.fontStacks = info.fontStacks;
    ui.locale = info.locale || 'ko';
    ui.autoLang = info.autoLang || 'ko';
    const meta = await ait.settingsGet();
    onSettingsChanged(meta.values);
    ait.onSettings(onSettingsChanged);
    applyTheme();
    setPlan(ui.plan);
    applyI18n();
    setMode('ai');
    const restored = await ait.restore();
    if (restored.tabs.length) {
      for (const rt of restored.tabs) await newTab({ fromActive: false, cwd: rt.cwd, title: rt.title });
      activate(order[restored.active] || order[0]);
    } else {
      await newTab({ fromActive: false });
    }
    ait.usageGet().then((u) => { ui.usage = u; if (ui.llm) renderModel(ui.llm); });
    renderModel(await ait.llmStatus());
    await openExternal(); // launched with --ssh <host>
    input.focus();
    document.dispatchEvent(new CustomEvent('ait-ready'));
  })();

  // test / debugging hook (renderer is sandboxed, local content only)
  window.__ait = {
    answerApproval, toggleTheme, submit, setMode, input, bufferText: () => bufferText(), copyOutput, stop, newTab, closeTab, activate, tabs, order: () => order.slice(),
    permSet: (m) => setPerm(T, m), getPending: () => T && T.pending, submitAi: (txt) => submitAi(T, txt), submitShell: (txt) => submitShell(T, txt), setPlan, toggleSplit, openSearch, closeSearch, searchRun,
    get term() { return (curPane() || T.panes.main).term; }, get state() { return T.state; }, get active() { return T; }, ui,
  };
})();
