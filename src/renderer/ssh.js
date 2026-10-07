'use strict';
// SSH in the window: the server's resource monitor next to this Mac's, the SSH chip, offers and warnings, the left side bar
// (activity bar + panels) and the session manager. The file panel (server + this Mac, drag & drop, transfers) is in files.js.
(() => {
  const start = () => {
    const C = window.AITCore;
    const { ait, $, el, icon, withIcon, titled, t, tr, ui } = C;

    // ================================================================= small helpers shared with files.js
    const store = {
      get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
    };
    const S = { tabs: new Map(), panel: store.get('ait.side.panel', ''), width: Math.min(560, Math.max(220, Number(store.get('ait.side.w', 300)) || 300)), sess: null };
    const tabState = (id) => {
      if (!S.tabs.has(id)) S.tabs.set(id, { ssh: null, metrics: null, unavailable: null, hist: { cpu: [], mem: [], gpu: [] }, transfers: new Map(), files: null });
      return S.tabs.get(id);
    };
    const activeId = () => (C.getTab() ? C.getTab().id : null);
    const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const fmtSize = (n) => {
      if (n < 1024) return `${n} B`;
      const u = ['KB', 'MB', 'GB', 'TB'];
      let v = n / 1024;
      let i = 0;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
    };
    const fmtUp = (sec) => {
      if (sec == null) return 'n/a';
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return d ? t('ssh.up.dh', { d, h }) : h ? t('ssh.up.hm', { h, m }) : t('ssh.up.m', { m });
    };
    const level = (pct) => (pct >= 85 ? 'err' : pct >= 60 ? 'warn' : 'ok');

    // toast
    let toastTimer = null;
    function toast(text, kind = '') {
      let n = $('toast');
      if (!n) { n = el('div', 'toast'); n.id = 'toast'; n.setAttribute('role', 'status'); document.body.append(n); }
      n.className = 'toast show ' + kind;
      n.textContent = text;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => n.classList.remove('show'), kind === 'err' ? 7000 : 3500);
    }

    // modal shell (the same look as the settings window)
    function modal(title, { wide = false, onClose } = {}) {
      const root = el('div', 'ait-modal');
      const back = el('div', 'sm-backdrop');
      const dlg = el('div', 'sm-dialog' + (wide ? ' wide' : ''));
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-label', title);
      const head = el('div', 'sm-head');
      const h = el('h3');
      h.append(el('span', '', title));
      const x = el('button', 'btn icon', '×');
      x.title = t('common.close');
      head.append(h, x);
      const body = el('div', 'sm-body');
      const foot = el('div', 'sm-foot');
      dlg.append(head, body, foot);
      root.append(back, dlg);
      document.body.append(root);
      const close = () => { root.remove(); document.removeEventListener('keydown', onKey, true); if (onClose) onClose(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
      document.addEventListener('keydown', onKey, true);
      back.onclick = close;
      x.onclick = close;
      return { root, body, foot, close, dlg };
    }
    /** A one-line question. Resolves to the text, or null when cancelled. */
    function askText(title, initial = '', okLabel = t('common.ok'), hint = '') {
      return new Promise((resolve) => {
        let done = false;
        const m = modal(title, { onClose: () => { if (!done) resolve(null); } });
        const inp = el('input', 'sm-input');
        inp.type = 'text';
        inp.value = initial;
        inp.spellcheck = false;
        m.body.append(inp);
        if (hint) m.body.append(el('div', 'sd', hint));
        const ok = el('button', 'btn primary', okLabel);
        const cancel = el('button', 'btn', t('common.cancel'));
        m.foot.append(cancel, ok);
        const finish = (v) => { done = true; resolve(v); m.close(); };
        ok.onclick = () => finish(inp.value);
        cancel.onclick = () => finish(null);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) finish(inp.value); });
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
      });
    }
    /** Small context menu at the pointer. items: [{label, icon?, danger?, onClick} | 'sep'] */
    function ctxMenu(ev, items) {
      ev.preventDefault();
      document.querySelectorAll('.ctx').forEach((n) => n.remove());
      const m = el('div', 'ctx');
      m.setAttribute('role', 'menu');
      items.forEach((it) => {
        if (it === 'sep') return m.append(el('div', 'ctx-sep'));
        const b = el('button', 'ctx-i' + (it.danger ? ' danger' : ''));
        b.setAttribute('role', 'menuitem');
        if (it.icon) b.append(icon(it.icon));
        b.append(el('span', '', it.label));
        b.disabled = !!it.disabled;
        b.onclick = () => { m.remove(); it.onClick(); };
        m.append(b);
      });
      document.body.append(m);
      const r = m.getBoundingClientRect();
      m.style.left = `${Math.min(ev.clientX, innerWidth - r.width - 6)}px`;
      m.style.top = `${Math.min(ev.clientY, innerHeight - r.height - 6)}px`;
      const away = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); } };
      const esc = (e) => { if (e.key === 'Escape') { m.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); } };
      setTimeout(() => { document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true); }, 0);
    }

    // ================================================================= server resource monitor (a strip under the tabs, while this Mac's stays in the top bar)
    const strip = $('rstrip');
    const rmon = el('div', 'rmon');
    rmon.id = 'rmon';
    rmon.hidden = true;
    rmon.setAttribute('role', 'group');
    rmon.setAttribute('aria-label', 'Server monitor');
    const mkSeg = (cls, ic, label) => {
      const root = el('span', `sm ${cls}`);
      const bar = el('span', 'bar');
      const fill = el('i');
      bar.append(fill);
      const val = el('b', '', '--');
      const extra = el('span', 'sx');
      root.append(el('span', 'ic-slot', ''), el('span', 'lbl', label), bar, val, extra);
      root.firstChild.append(icon(ic));
      return { root, fill, val, extra };
    };
    const sCpu = mkSeg('rcpu', 'cpu', 'CPU');
    const sMem = mkSeg('rmem', 'ram', t('ssh.mon.mem'));
    const sGpu = mkSeg('rgpu', 'gpu', 'GPU');
    const sDisk = mkSeg('rdisk', 'disk', t('ssh.mon.disk'));
    const rinfo = el('span', 'sm rinfo');
    rmon.append(sCpu.root, sMem.root, sGpu.root, sDisk.root, rinfo);
    strip.append(rmon);
    const SEGS = [sCpu, sMem, sGpu, sDisk];

    function setSeg(seg, pct, text, extra = '') {
      seg.fill.style.width = `${Math.max(2, Math.min(100, pct || 0))}%`;
      seg.root.dataset.level = pct == null ? '' : level(pct);
      seg.val.textContent = text;
      seg.extra.textContent = extra;
    }
    function monitorTip(tab, st) {
      const m = st.metrics;
      const L = [t('ssh.tip.head', { host: st.ssh.target.label, os: m.os || '?', arch: m.arch || '' })];
      if (m.cpu) L.push(t('ssh.tip.cpu', { pct: m.cpu.pct, cores: m.cores || '?', load: m.load ? m.load.join(' ') : 'n/a' }));
      if (m.mem) L.push(t('ssh.tip.mem', { used: m.mem.usedGB, total: m.mem.totalGB, pct: m.mem.usedPct, swap: m.mem.swapTotalGB ? t('ssh.tip.swap', { u: m.mem.swapUsedGB, t: m.mem.swapTotalGB }) : '' }));
      if (m.gpus.length) m.gpus.forEach((g, i) => L.push(t('ssh.tip.gpu', { i, name: g.name, util: g.util, mem: g.memTotalMB ? ` · ${(g.memUsedMB / 1024).toFixed(1)}/${(g.memTotalMB / 1024).toFixed(1)}GB` : '', temp: g.temp != null ? ` · ${g.temp}℃` : '' })));
      else L.push(t('ssh.tip.nogpu'));
      if (m.disk) L.push(t('ssh.tip.disk', { mount: m.disk.mount, used: m.disk.usedGB, total: m.disk.totalGB, pct: m.disk.usedPct }));
      L.push(t('ssh.tip.up', { up: fmtUp(m.uptimeSec), via: t(`ssh.via.${m.via || 'own'}`) }));
      return L.join('\n');
    }
    function renderTopMon() {
      const tab = C.getTab();
      const st = tab && S.tabs.get(tab.id);
      const on = !!(tab && st && st.ssh);
      if (strip.hidden === on) { strip.hidden = !on; setTimeout(() => C.doFit(), 30); } // the terminal gets (or gives back) the strip's height
      rmon.hidden = !on;
      if (!on) return;
      const m = st.metrics;
      const fresh = m && Date.now() - m.at < 20000;
      for (const s of SEGS) s.root.hidden = !fresh;
      rinfo.hidden = false;
      if (!fresh) {
        rinfo.textContent = st.unavailable ? `${t('ssh.mon.none')} · ${tr(st.unavailable.hint || '')}` : t('ssh.mon.waiting');
        rinfo.title = st.ssh.target.label;
        return;
      }
      const tip = monitorTip(tab, st);
      setSeg(sCpu, m.cpu ? m.cpu.pct : null, m.cpu ? `${m.cpu.pct}%` : 'n/a', m.cores ? t('ssh.mon.cores', { n: m.cores }) : '');
      setSeg(sMem, m.mem ? m.mem.usedPct : null, m.mem ? `${m.mem.usedGB}/${m.mem.totalGB}G` : 'n/a');
      if (m.gpus.length) {
        const g = m.gpus[0];
        setSeg(sGpu, g.util, `${g.util}%${m.gpus.length > 1 ? `+${m.gpus.length - 1}` : ''}`, g.name);
      } else setSeg(sGpu, null, 'n/a', t('ssh.mon.nogpu'));
      setSeg(sDisk, m.disk ? m.disk.usedPct : null, m.disk ? `${m.disk.usedPct}%` : 'n/a');
      rinfo.textContent = [m.load ? `${t('ssh.mon.load')} ${m.load[0]}` : '', m.uptimeSec != null ? `${t('ssh.mon.up')} ${fmtUp(m.uptimeSec)}` : ''].filter(Boolean).join(' · ');
      for (const s of SEGS) s.root.title = tip;
      rinfo.title = tip;
    }

    // ================================================================= SSH chip + popover
    const chip = el('div', 'chip ssh');
    chip.id = 'ssh-chip';
    chip.hidden = true;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    const chipDot = el('span', 'dot');
    const chipTxt = el('span', '', '');
    chip.append(chipDot, chipTxt);
    strip.prepend(chip);
    const pop = el('div', 'pop ssh-pop');
    pop.id = 'ssh-pop';
    pop.hidden = true;
    document.body.append(pop);
    function renderChip() {
      const tab = C.getTab();
      const st = tab && S.tabs.get(tab.id);
      if (!tab || !st || !st.ssh) { chip.hidden = true; pop.hidden = true; return; }
      chip.hidden = false;
      chipDot.className = 'dot ' + (tab.remote ? 'ai' : 'ok');
      chipTxt.textContent = `SSH · ${st.ssh.target.label}${tab.remote ? ' · AI' : ''}`;
      chip.title = tab.remote ? t('ssh.chip.remoteOn', { host: st.ssh.target.label }) : t('ssh.chip.remoteOff', { host: st.ssh.target.label });
    }
    function openPop() {
      const tab = C.getTab();
      const st = tab && S.tabs.get(tab.id);
      if (!tab || !st || !st.ssh) return;
      pop.replaceChildren();
      const tg = st.ssh.target;
      pop.append(el('div', 'pop-h', tg.label));
      const rows = [[t('ssh.pop.since'), new Date(st.ssh.since).toLocaleTimeString()], tab.remoteInfo ? [t('ssh.pop.sys'), `${tab.remoteInfo.os} ${tab.remoteInfo.arch} · ${tab.remoteInfo.shell}`] : null, tg.jump ? [t('ssh.pop.jump'), tg.jump] : null, tg.identity.length ? [t('ssh.pop.key'), tg.identity.join(', ')] : null].filter(Boolean);
      rows.forEach(([k, v]) => { const r = el('div', 'pop-r'); r.append(el('span', 'k', k), el('span', 'v', v)); pop.append(r); });
      const act = (ic, label, fn) => { const b = withIcon('button', ic, ' ' + label, 'btn pop-b'); b.onclick = () => { pop.hidden = true; fn(); }; pop.append(b); };
      act(tab.remote ? 'reset' : 'sparkle', tab.remote ? t('ssh.pop.local') : t('ssh.pop.ai'), () => C.setRemote(!tab.remote));
      act('monitor', t('vnc.pop.open'), () => window.AITVnc && window.AITVnc.open({ auto: true }));
      act('folder', t('ssh.pop.files'), () => openPanel('files'));
      act('activity', t('ssh.pop.status'), () => openPanel('status'));
      act('copy', t('ssh.pop.copy'), () => ait.copy(tg.label));
      pop.hidden = false;
      const r = chip.getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`;
    }
    chip.onclick = () => (pop.hidden ? openPop() : (pop.hidden = true));
    chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.click(); } });
    document.addEventListener('mousedown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !chip.contains(e.target)) pop.hidden = true; }, true);

    // ================================================================= events from the main process
    function applyState(id, ssh) {
      const st = tabState(id);
      st.ssh = ssh;
      const tab = C.tabs.get(id);
      if (tab) tab.ssh = ssh;
      if (!ssh) { st.metrics = null; st.unavailable = null; st.files = null; st.transfers = new Map(); }
      C.refreshChrome();
      if (activeId() === id) { renderTopMon(); renderChip(); refreshPanel(); }
    }
    ait.onSshState(({ id, active, target, since }) => {
      applyState(id, active ? { active: true, target, since } : null);
      const tab = C.tabs.get(id);
      if (active && tab && C.setting('sshFiles') !== 'manual' && C.getTab() && C.getTab().id === id && (!S.panel || S.panel === 'sessions')) openPanel('files');
    });
    ait.onSshMetrics(({ id, metrics, unavailable }) => {
      const st = tabState(id);
      if (metrics === null) { st.metrics = null; } else if (metrics) {
        st.metrics = metrics;
        st.unavailable = null;
        const h = st.hist;
        h.cpu.push(metrics.cpu ? metrics.cpu.pct : 0);
        h.mem.push(metrics.mem ? metrics.mem.usedPct : 0);
        h.gpu.push(metrics.gpus.length ? metrics.gpus[0].util : 0);
        for (const k of Object.keys(h)) if (h[k].length > 90) h[k].shift();
      }
      if (unavailable) st.unavailable = unavailable;
      if (activeId() === id) { renderTopMon(); if (S.panel === 'status') renderStatus(); }
    });
    ait.onSshProblem(({ id, ...p }) => {
      const tab = C.tabs.get(id);
      if (!tab) return;
      const c = C.note(tab, `${t(`ssh.problem.${p.kind}`) || ''} ${tr(p.hint || '')}`.trim(), p.level === 'danger' ? 'warn danger' : p.level === 'info' ? '' : 'warn');
      if (p.fingerprint) c.append(el('div', 'fp', t('ssh.problem.fp', { type: p.fingerprint.type, fp: p.fingerprint.fingerprint })));
    });
    ait.onSshOffer(({ id, target, reason }) => {
      const tab = C.tabs.get(id);
      if (!tab || tab.remote) return;
      const c = C.note(tab, reason ? t('ssh.offer.retry', { host: target.label, why: tr(reason) }) : t('ssh.offer', { host: target.label }), 'info');
      const yes = withIcon('button', 'sparkle', ' ' + t('ssh.offer.yes'), 'btn primary');
      const no = el('button', 'btn', t('ssh.offer.no'));
      yes.style.marginLeft = '8px';
      no.style.marginLeft = '6px';
      yes.onclick = async () => { yes.disabled = true; const r = await C.setRemote(true); if (r && r.ok) c.remove(); else yes.disabled = false; };
      no.onclick = () => c.remove();
      c.append(yes, no);
    });
    document.addEventListener('ait-tab-activated', () => { renderTopMon(); renderChip(); refreshPanel(); });
    document.addEventListener('ait-remote', () => { renderChip(); refreshPanel(); });
    chip.addEventListener('keyup', () => {});
    // monitor of THIS Mac keeps working as before; re-render when its numbers change so the status panel can compare
    C.registerAction('stats', () => { if (S.panel === 'status') renderStatus(); });

    // ================================================================= side bar frame
    const side = $('side');
    const panelEl = $('side-panel');
    const split = $('side-split');
    const PANES = { sessions: renderSessions, files: () => window.AITSsh.renderFiles && window.AITSsh.renderFiles(), status: renderStatus };
    function openPanel(name) {
      S.panel = S.panel === name ? '' : name;
      if (name === 'settings') { S.panel = store.get('ait.side.panel', ''); window.__panels && window.__panels.openSettings(); return; }
      store.set('ait.side.panel', S.panel);
      layout();
    }
    function layout() {
      side.querySelectorAll('.act').forEach((b) => { const on = b.dataset.pane === S.panel; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
      panelEl.hidden = !S.panel;
      split.hidden = !S.panel;
      panelEl.style.width = `${S.width}px`;
      ['sessions', 'files', 'status'].forEach((k) => { $(`sp-${k}`).hidden = k !== S.panel; });
      refreshPanel();
      setTimeout(() => C.doFit(), 30);
    }
    function refreshPanel() {
      if (S.panel && PANES[S.panel]) PANES[S.panel]();
    }
    side.querySelectorAll('.act').forEach((b) => { b.onclick = () => openPanel(b.dataset.pane); });
    split.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = S.width;
      const mv = (m) => { S.width = Math.min(560, Math.max(220, w0 + m.clientX - x0)); panelEl.style.width = `${S.width}px`; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); store.set('ait.side.w', String(S.width)); C.doFit(); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    // ================================================================= connect: type the command into a (new) tab
    async function runInTab(command, title, here = false) {
      const cur = C.getTab();
      if (here && cur && cur.state.pty === 'prompt') {
        const r = await ait.shellRun(cur.id, command);
        if (r && r.ok) return cur;
      }
      const tab = await C.newTab({ fromActive: false, title });
      for (let i = 0; i < 40; i++) {
        const res = await ait.shellRun(tab.id, command); // refused while the shell is still starting
        if (res && res.ok) { C.activate(tab.id); return tab; }
        await new Promise((r) => setTimeout(r, 250));
      }
      ait.ptyInput(tab.id, `\x15${command}\r`);
      C.activate(tab.id);
      return tab;
    }
    async function connect(arg, here) {
      const r = await ait.sessCommand(arg);
      if (!r || !r.ok) { toast((r && r.errors && r.errors[0] && r.errors[0].message) || t('ssh.sess.cantconnect'), 'err'); return null; }
      return runInTab(r.command, r.title, here);
    }

    // ================================================================= sessions panel
    const ago = (ts) => { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? t('ssh.ago.now') : m < 60 ? t('ssh.ago.m', { n: m }) : m < 1440 ? t('ssh.ago.h', { n: Math.round(m / 60) }) : t('ssh.ago.d', { n: Math.round(m / 1440) }); };
    async function renderSessions() {
      const box = $('sp-sessions');
      const data = await ait.sessList();
      S.sess = data;
      if (S.panel !== 'sessions') return;
      const q = (S.sessQuery || '').toLowerCase();
      box.replaceChildren();
      const head = el('div', 'sp-head');
      head.append(el('span', 'sp-title', t('ssh.sess.title')));
      const add = withIcon('button', 'plus', ' ' + t('ssh.sess.new'), 'btn mini primary');
      add.onclick = () => sessionEditor(null);
      head.append(add);
      const search = el('input', 'sm-input sp-search');
      search.type = 'search';
      search.placeholder = t('ssh.sess.search');
      search.value = S.sessQuery || '';
      search.oninput = () => { S.sessQuery = search.value; renderSessions(); };
      search.spellcheck = false;
      box.append(head, search);
      const body = el('div', 'sp-body');
      const match = (...f) => !q || f.some((x) => String(x || '').toLowerCase().includes(q));
      const row = (o) => {
        const r = el('div', 'sess-row');
        r.tabIndex = 0;
        r.append(icon(o.icon || 'server'));
        const txt = el('div', 'stxt');
        txt.append(el('div', 'sname', o.name), el('div', 'ssub', o.sub));
        r.append(txt);
        const acts = el('div', 'sacts');
        o.actions.forEach(([ic, label, fn]) => { const b = el('button', 'btn icon sact'); b.append(icon(ic)); b.title = label; b.setAttribute('aria-label', label); b.onclick = (e) => { e.stopPropagation(); fn(e); }; acts.append(b); });
        r.append(acts);
        r.ondblclick = o.open;
        r.addEventListener('keydown', (e) => { if (e.key === 'Enter') o.open(e); });
        r.addEventListener('contextmenu', (e) => ctxMenu(e, o.menu || []));
        return r;
      };
      const section = (title, rows, key) => {
        if (!rows.length) return;
        const folded = store.get(`ait.sess.fold.${key}`, '0') === '1';
        const h = el('button', 'ssec' + (folded ? ' folded' : ''));
        h.append(icon('chevr'), el('span', '', title), el('span', 'cnt', String(rows.length)));
        h.onclick = () => { store.set(`ait.sess.fold.${key}`, folded ? '0' : '1'); renderSessions(); };
        body.append(h);
        if (!folded) rows.forEach((r) => body.append(r));
      };
      const saved = data.sessions.filter((s) => match(s.name, s.host, s.user, s.folder));
      const folders = [...new Set(saved.map((s) => s.folder || ''))].sort((a, b) => a.localeCompare(b));
      folders.forEach((f) => {
        section(f || t('ssh.sess.saved'), saved.filter((s) => (s.folder || '') === f).map((s) => row({
          name: s.name,
          sub: `${s.user ? s.user + '@' : ''}${s.host}${s.port !== 22 ? ':' + s.port : ''}${s.lastUsed ? ' · ' + ago(s.lastUsed) : ''}`,
          open: (e) => connect({ id: s.id }, e && e.altKey),
          actions: [['play', t('ssh.sess.connect'), (e) => connect({ id: s.id }, e.altKey)], ['pencil', t('ssh.sess.edit'), () => sessionEditor(s)], ['copy', t('ssh.sess.dup'), async () => { const r = await ait.sessDuplicate(s.id); if (!r.ok) toast(r.errors[0].message, 'err'); renderSessions(); }], ['trash', t('ssh.sess.del'), async () => { if (confirm(t('ssh.sess.delConfirm', { name: s.name }))) { await ait.sessDelete(s.id); renderSessions(); } }]],
          menu: [{ label: t('ssh.sess.connect'), icon: 'play', onClick: () => connect({ id: s.id }) }, { label: t('ssh.sess.connectHere'), icon: 'terminal', onClick: () => connect({ id: s.id }, true) }, 'sep', { label: t('ssh.sess.edit'), icon: 'pencil', onClick: () => sessionEditor(s) }, { label: t('ssh.sess.dup'), icon: 'copy', onClick: async () => { await ait.sessDuplicate(s.id); renderSessions(); } }, { label: t('ssh.sess.del'), icon: 'trash', danger: true, onClick: async () => { if (confirm(t('ssh.sess.delConfirm', { name: s.name }))) { await ait.sessDelete(s.id); renderSessions(); } } }],
        })), `f:${f}`);
      });
      const recent = data.recent.filter((r) => match(r.target));
      const saveRecent = (r) => { const m = r.target.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/); sessionEditor({ name: r.target, host: m ? m[2] : r.target, user: m && m[1] || '', port: m && m[3] ? Number(m[3]) : 22, keepAlive: true, share: true, x11: 'off', forwards: [] }, true); };
      const forgetRecent = async (r) => { await ait.sessRecentForget(r.target); renderSessions(); };
      const clearRecent = async () => { if (confirm(t('ssh.recent.clearConfirm'))) { await ait.sessRecentClear(); renderSessions(); } };
      section(t('ssh.sess.recent'), recent.map((r) => row({
        name: r.target, sub: ago(r.at), icon: 'clock', open: () => connect({ target: r.target }),
        actions: [['play', t('ssh.sess.connect'), () => connect({ target: r.target })], ['plus', t('ssh.sess.save'), () => saveRecent(r)], ['trash', t('ssh.recent.forget'), () => forgetRecent(r)]],
        menu: [{ label: t('ssh.sess.connect'), icon: 'play', onClick: () => connect({ target: r.target }) }, { label: t('ssh.sess.connectHere'), icon: 'terminal', onClick: () => connect({ target: r.target }, true) }, { label: t('ssh.sess.save'), icon: 'plus', onClick: () => saveRecent(r) }, 'sep', { label: t('ssh.recent.forget'), icon: 'trash', danger: true, onClick: () => forgetRecent(r) }, { label: t('ssh.recent.clear'), icon: 'trash', danger: true, onClick: clearRecent }],
      })), 'recent');
      const cfg = data.configured.filter((h) => match(h.alias, h.hostName, h.user));
      section(t('ssh.sess.config'), cfg.map((h) => row({
        name: h.alias, sub: `${h.user ? h.user + '@' : ''}${h.hostName || h.alias}${h.port ? ':' + h.port : ''}`, icon: 'key', open: () => connect({ alias: h.alias }),
        actions: [['play', t('ssh.sess.connect'), () => connect({ alias: h.alias })], ['plus', t('ssh.sess.import'), async () => { const p = await ait.sessFromConfig(h.alias); if (p) sessionEditor(p, true); }]],
      })), 'config');
      if (!saved.length && !recent.length && !cfg.length) {
        const e = el('div', 'dr-empty', q ? t('ssh.sess.nomatch') : t('ssh.sess.empty'));
        body.append(e);
        if (!q) { const b = withIcon('button', 'plus', ' ' + t('ssh.sess.new'), 'btn primary'); b.style.margin = '10px auto'; b.style.display = 'flex'; b.onclick = () => sessionEditor(null); body.append(b); }
      }
      body.append(el('div', 'sp-foot', t('ssh.sess.pwnote')));
      box.append(body);
    }

    // session editor (new / edit)
    function sessionEditor(session, isNew) {
      const s = session ? { forwards: [], keepAlive: true, share: true, x11: 'off', port: 22, ...session } : { name: '', host: '', user: '', port: 22, keepAlive: true, share: true, x11: 'off', forwards: [], startDir: '', jump: '', keyFile: '', folder: '', notes: '' };
      const editing = !!(s.id && !isNew);
      const m = modal(editing ? t('ssh.edit.title.edit') : t('ssh.edit.title.new'), { wide: true });
      const grid = el('div', 'sm-grid');
      const errBox = el('div', 'ssh-errors');
      const fields = {};
      const field = (key, label, input, hint) => {
        const l = el('label', '', label);
        grid.append(l, input);
        if (hint) { const h = el('div', 'sd fhint', hint); h.style.gridColumn = '2'; grid.append(h); }
        fields[key] = input;
        return input;
      };
      const text = (key, val, ph = '') => { const i = el('input', 'sm-input'); i.type = 'text'; i.value = val || ''; i.placeholder = ph; i.spellcheck = false; i.dataset.k = key; return i; };
      field('name', t('ssh.edit.name'), text('name', s.name, t('ssh.edit.name.ph')));
      const folderIn = text('folder', s.folder, t('ssh.edit.folder.ph'));
      folderIn.setAttribute('list', 'ssh-folders');
      const dl = el('datalist');
      dl.id = 'ssh-folders';
      [...new Set(((S.sess && S.sess.sessions) || []).map((x) => x.folder).filter(Boolean))].forEach((f) => { const o = el('option'); o.value = f; dl.append(o); });
      field('folder', t('ssh.edit.folder'), folderIn).after(dl);
      field('host', t('ssh.edit.host'), text('host', s.host, 'example.com / 192.0.2.10'));
      const portIn = text('port', String(s.port || 22));
      portIn.style.maxWidth = '110px';
      field('port', t('ssh.edit.port'), portIn);
      field('user', t('ssh.edit.user'), text('user', s.user, t('ssh.edit.user.ph')));
      // key file: the path is picked with a file dialog, the key itself is never read by the app
      const keyWrap = el('div', 'sm-keyrow');
      const keyIn = text('keyFile', s.keyFile, t('ssh.edit.key.ph'));
      const pick = el('input');
      pick.type = 'file';
      pick.hidden = true;
      const pickBtn = el('button', 'btn', t('ssh.edit.key.pick'));
      pickBtn.type = 'button';
      pickBtn.onclick = () => pick.click();
      pick.onchange = () => { const p = pick.files[0] && ait.pathForFile(pick.files[0]); if (p) keyIn.value = p; };
      keyWrap.append(keyIn, pickBtn, pick);
      grid.append(el('label', '', t('ssh.edit.key')), keyWrap);
      fields.keyFile = keyIn;
      const keyHint = el('div', 'sd fhint', t('ssh.edit.key.hint'));
      keyHint.style.gridColumn = '2';
      grid.append(keyHint);
      field('jump', t('ssh.edit.jump'), text('jump', s.jump, 'user@bastion:22'));
      field('startDir', t('ssh.edit.startDir'), text('startDir', s.startDir, '/srv/app'));
      // X11
      const x11 = el('select', 'sm-input');
      [['off', t('ssh.edit.x11.off')], ['safe', t('ssh.edit.x11.safe')], ['trusted', t('ssh.edit.x11.trusted')]].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; x11.append(o); });
      x11.value = s.x11 || 'off';
      field('x11', t('ssh.edit.x11'), x11, (S.sess && S.sess.x11) ? t('ssh.edit.x11.ok') : t('ssh.edit.x11.missing'));
      // switches
      const sw = (key, label, on) => { const b = el('input'); b.type = 'checkbox'; b.checked = !!on; const w = el('label', 'chk'); w.append(b, el('span', '', label)); w.dataset.k = key; return { w, b }; };
      const ka = sw('keepAlive', t('ssh.edit.keepAlive'), s.keepAlive);
      const sh = sw('share', t('ssh.edit.share'), s.share);
      const swrap = el('div', 'chk-col');
      swrap.append(ka.w, sh.w);
      grid.append(el('label', '', t('ssh.edit.options')), swrap);
      // forwards
      const fwWrap = el('div', 'fw-list');
      const fws = (s.forwards || []).map((f) => ({ ...f }));
      const drawFw = () => {
        fwWrap.replaceChildren();
        fws.forEach((f, i) => {
          const r = el('div', 'fw-row');
          const kind = el('select', 'sm-input');
          [['L', t('ssh.fw.L')], ['R', t('ssh.fw.R')], ['D', t('ssh.fw.D')]].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; kind.append(o); });
          kind.value = f.kind;
          kind.onchange = () => { f.kind = kind.value; drawFw(); };
          const lp = el('input', 'sm-input'); lp.type = 'number'; lp.min = 1; lp.max = 65535; lp.placeholder = t('ssh.fw.listen'); lp.value = f.listenPort || ''; lp.oninput = () => { f.listenPort = Number(lp.value) || 0; };
          r.append(kind, lp);
          if (f.kind !== 'D') {
            const h = el('input', 'sm-input'); h.type = 'text'; h.placeholder = t('ssh.fw.host'); h.value = f.host || ''; h.oninput = () => { f.host = h.value.trim(); };
            const p = el('input', 'sm-input'); p.type = 'number'; p.min = 1; p.max = 65535; p.placeholder = t('ssh.fw.port'); p.value = f.port || ''; p.oninput = () => { f.port = Number(p.value) || 0; };
            r.append(h, p);
          }
          const rm = el('button', 'btn icon'); rm.type = 'button'; rm.append(icon('x')); rm.title = t('common.close'); rm.onclick = () => { fws.splice(i, 1); drawFw(); };
          r.append(rm);
          fwWrap.append(r);
        });
        const add = withIcon('button', 'plus', ' ' + t('ssh.fw.add'), 'btn mini');
        add.type = 'button';
        add.onclick = () => { fws.push({ kind: 'L', listenPort: 8080, host: 'localhost', port: 80 }); drawFw(); };
        fwWrap.append(add);
      };
      drawFw();
      grid.append(el('label', '', t('ssh.edit.forwards')), fwWrap);
      const notes = el('textarea', 'sm-input');
      notes.rows = 2;
      notes.value = s.notes || '';
      field('notes', t('ssh.edit.notes'), notes);
      m.body.append(grid, errBox, el('div', 'sd', t('ssh.edit.pwnote')));

      const collect = () => ({ id: editing ? s.id : '', name: fields.name.value, folder: fields.folder.value, host: fields.host.value, port: fields.port.value, user: fields.user.value, keyFile: fields.keyFile.value, jump: fields.jump.value, startDir: fields.startDir.value, x11: x11.value, keepAlive: ka.b.checked, share: sh.b.checked, forwards: fws, notes: notes.value });
      const save = async (andConnect) => {
        errBox.replaceChildren();
        Object.values(fields).forEach((f) => f.classList && f.classList.remove('bad'));
        const r = await ait.sessSave(collect());
        if (!r.ok) {
          r.errors.forEach((e) => { errBox.append(el('div', 'ssh-err', e.message)); if (fields[e.field]) fields[e.field].classList.add('bad'); });
          return;
        }
        m.close();
        toast(t('ssh.edit.saved', { name: r.session.name }));
        renderSessions();
        if (andConnect) connect({ id: r.session.id });
      };
      const saveB = el('button', 'btn', t('ssh.edit.save'));
      const goB = withIcon('button', 'play', ' ' + t('ssh.edit.saveConnect'), 'btn primary');
      const cancel = el('button', 'btn', t('common.cancel'));
      m.foot.append(cancel, saveB, goB);
      cancel.onclick = m.close;
      saveB.onclick = () => save(false);
      goB.onclick = () => save(true);
      setTimeout(() => fields.host.focus(), 30);
    }

    // ================================================================= status panel (server and this Mac side by side)
    function spark(values, cls) {
      const w = 220;
      const h = 34;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('class', 'spark ' + (cls || ''));
      svg.setAttribute('aria-hidden', 'true');
      if (values.length > 1) {
        const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - (Math.min(100, v) / 100) * (h - 4)).toFixed(1)}`).join(' ');
        const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        area.setAttribute('points', `1,${h - 1} ${pts} ${w - 1},${h - 1}`);
        area.setAttribute('class', 'area');
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', pts);
        line.setAttribute('class', 'line');
        svg.append(area, line);
      }
      return svg;
    }
    function metricBlock(label, pct, text, hist, sub) {
      const b = el('div', 'mblock');
      b.dataset.level = pct == null ? '' : level(pct);
      const top = el('div', 'mtop');
      top.append(el('span', 'ml', label), el('b', 'mv', text));
      const bar = el('div', 'mbar');
      const fill = el('i');
      fill.style.width = `${Math.max(1, Math.min(100, pct || 0))}%`;
      bar.append(fill);
      b.append(top, bar);
      if (hist && hist.length > 1) b.append(spark(hist));
      if (sub) b.append(el('div', 'msub', sub));
      return b;
    }
    function renderStatus() {
      const box = $('sp-status');
      if (S.panel !== 'status') return;
      box.replaceChildren();
      const head = el('div', 'sp-head');
      head.append(el('span', 'sp-title', t('ssh.status.title')));
      box.append(head);
      const body = el('div', 'sp-body');
      const tab = C.getTab();
      const st = tab && S.tabs.get(tab.id);
      const m = st && st.metrics;
      // the server
      const sv = el('div', 'msec');
      sv.append(el('div', 'msec-h', st && st.ssh ? `⇄ ${st.ssh.target.label}` : t('ssh.status.noserver')));
      if (!st || !st.ssh) sv.append(el('div', 'dr-empty', t('ssh.status.connect')));
      else if (!m) sv.append(el('div', 'dr-empty', st.unavailable ? tr(st.unavailable.hint || '') : t('ssh.mon.waiting')));
      else {
        sv.append(metricBlock('CPU', m.cpu ? m.cpu.pct : null, m.cpu ? `${m.cpu.pct}%` : 'n/a', st.hist.cpu, t('ssh.status.load', { cores: m.cores || '?', load: m.load ? m.load.join(' · ') : 'n/a' })));
        if (m.mem) sv.append(metricBlock(t('ssh.mon.mem'), m.mem.usedPct, `${m.mem.usedGB} / ${m.mem.totalGB} GB`, st.hist.mem, m.mem.swapTotalGB ? t('ssh.status.swap', { u: m.mem.swapUsedGB, t: m.mem.swapTotalGB }) : ''));
        if (m.gpus.length) m.gpus.forEach((g, i) => sv.append(metricBlock(`GPU${m.gpus.length > 1 ? ' ' + i : ''}`, g.util, `${g.util}%`, i === 0 ? st.hist.gpu : null, `${g.name}${g.memTotalMB ? ` · ${(g.memUsedMB / 1024).toFixed(1)}/${(g.memTotalMB / 1024).toFixed(1)} GB` : ''}${g.temp != null ? ` · ${g.temp}℃` : ''}`)));
        else sv.append(metricBlock('GPU', null, 'n/a', null, t('ssh.tip.nogpu')));
        if (m.disk) sv.append(metricBlock(t('ssh.status.disk'), m.disk.usedPct, `${m.disk.usedGB} / ${m.disk.totalGB} GB`, null, m.disk.mount));
        sv.append(el('div', 'msub', `${m.os} ${m.arch} · ${t('ssh.status.uptime', { up: fmtUp(m.uptimeSec) })} · ${t(`ssh.via.${m.via || 'own'}`)}`));
      }
      body.append(sv);
      // this Mac
      const lc = el('div', 'msec local');
      lc.append(el('div', 'msec-h', t('ssh.status.local')));
      const stats = ui.stats;
      if (stats) {
        if (stats.cpu && stats.cpu.pct !== null) lc.append(metricBlock('CPU', stats.cpu.pct, `${stats.cpu.pct}%`, null, t('ssh.mon.cores', { n: stats.cpu.cores })));
        lc.append(metricBlock(t('ssh.mon.mem'), stats.mem.usedPct, `${stats.mem.usedGB} / ${stats.mem.totalGB} GB`, null, t('ssh.status.avail', { gb: stats.mem.availGB })));
        if (stats.gpu) lc.append(metricBlock('GPU', stats.gpu.util, `${stats.gpu.util}%`, null, stats.gpu.name));
        const mdl = stats.models && stats.models[0];
        lc.append(el('div', 'msub', mdl ? t('ssh.status.model', { name: mdl.name, gb: mdl.sizeGB }) : t('ssh.status.nomodel')));
      } else lc.append(el('div', 'dr-empty', '…'));
      body.append(lc);
      body.append(el('div', 'sp-foot', t('ssh.status.note')));
      box.append(body);
    }

    // ================================================================= start-up
    window.AITSsh = { S, store, tabState, toast, modal, askText, ctxMenu, shq, fmtSize, fmtUp, openPanel, layout, activeId, connect, runInTab, renderFiles: null };
    layout();
    renderTopMon();
    renderChip();
    // pick up sessions that are already running (window reload) and load the home directory for the key-path shortening
    (async () => {
      for (const [id] of C.tabs) {
        const info = await ait.sshGet(id);
        if (info && info.active) { applyState(id, { active: true, target: info.target, since: info.since }); if (info.metrics) tabState(id).metrics = info.metrics; const tab = C.tabs.get(id); if (tab && info.remote) { tab.remote = true; tab.remoteInfo = info.remote; } }
      }
      renderTopMon();
      renderChip();
    })();
    document.dispatchEvent(new CustomEvent('ait-ssh-ready'));
  };
  if (window.AITCore) start();
  else document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));
})();
