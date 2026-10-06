'use strict';
// Panels: settings window, session history, command blocks + processes drawer, onboarding (model download), update notice.
(() => {
  const start = () => {
    const C = window.AITCore;
    const { ait, $, el, icon, withIcon, titled, t, tr, ui } = C;
    const text = (n, s) => { n.textContent = s; return n; };

    // ================================================================= generic controls
    const seg = (options, current, onPick, label) => {
      const wrap = el('div', 'seg');
      wrap.setAttribute('role', 'radiogroup');
      if (label) wrap.setAttribute('aria-label', label);
      options.forEach(([value, lbl]) => {
        const b = el('button', 'seg-b' + (value === current ? ' on' : ''), lbl);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(value === current));
        b.onclick = () => onPick(value);
        wrap.append(b);
      });
      return wrap;
    };
    const toggle = (on, onPick, label) => {
      const sw = el('button', 'switch' + (on ? ' on' : ''));
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(on));
      if (label) sw.setAttribute('aria-label', label);
      sw.append(el('i'));
      sw.onclick = () => onPick(!on);
      return sw;
    };
    const row = (title, desc, control, extra) => {
      const r = el('div', 'srow');
      const l = el('div', 'sl');
      l.append(el('div', 'st', title), el('div', 'sd', desc));
      if (extra) l.append(extra);
      r.append(l, control);
      return r;
    };

    // ================================================================= settings window
    let meta = null; // { values, defaults, choices, secureStorage, hasOpenaiKey }
    const KV_GB_PER_TOKEN = 0.00015; // measured: qwen3:8b ≈ 1.9GB at 12288 tokens
    const CTX_LABEL = { 4096: '4K', 8192: '8K', 12288: '12K', 16384: '16K', 24576: '24K', 32768: '32K' };

    function activeModelSizeGB() {
      const p = ui.llm && ui.llm.providers.find((x) => x.id === 'ollama');
      const m = p && p.models && p.models.find((x) => x.name === p.model);
      return m ? m.sizeGB : null;
    }
    const KV_RATIO = { f16: 1, q8_0: 34 / 64, q4_0: 18 / 64 };
    function memEstimate(ctx, kvType) {
      const w = activeModelSizeGB();
      const geo = ui.kvGeo;
      const type = kvType === 'auto' ? (ui.kv ? ui.kv.kvType : 'f16') : kvType;
      const kv = Math.round((geo ? ctx * geo.f16PerToken : ctx * KV_GB_PER_TOKEN) * KV_RATIO[type] * 10) / 10;
      const total = w === null ? null : Math.round((w + kv) * 10) / 10;
      const st = ui.stats;
      let s = w === null ? t('set.est.kvOnly', { kv }) : t('set.est.full', { w, kv, total });
      let warn = false;
      if (st && total !== null) {
        s += t('set.est.ratio', { total: st.mem.totalGB, pct: Math.round((total / st.mem.totalGB) * 100) });
        warn = total > st.mem.totalGB * 0.5;
      }
      return { s, warn };
    }
    const liveText = () => {
      const m = ui.stats && ui.stats.models[0];
      return m ? t('set.live.loaded', { name: m.name, gb: m.sizeGB }) : t('set.live.none');
    };
    const updateLive = () => { const n = document.querySelector('#settings-modal .sm-live'); if (n) n.textContent = liveText(); };
    C.registerAction('stats', updateLive);

    async function save(key, value) {
      if (!meta) meta = await ait.settingsGet();
      const r = await ait.settingsSet(key, value);
      if (!r.ok) return false;
      meta.values = r.values;
      C.onSettingsChanged(r.values);
      renderSettings();
      return true;
    }

    const FONT_LABEL = { 'sf-mono': 'SF Mono', menlo: 'Menlo', monaco: 'Monaco', courier: 'Courier' };
    const PERM_LABEL = (id) => t('perm.' + id + '.short');
    const KEEP_LABEL = { '0': t('set.keep.now'), '1m': '1', '5m': '5', '15m': '15', '30m': '30' };

    // ================================================================= API token usage
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    let officialMsg = null; // last fetch outcome shown under the official block ({ok, text})
    let officialBusy = false;

    function localTable(box) {
      box.replaceChildren();
      const u = ui.usage && ui.usage.local;
      if (!u || !(u.d30.calls || u.session.calls)) { box.append(el('div', 'dr-empty', t('usage.empty'))); return; }
      const cols = [['session', u.session], ['today', u.today], ['d7', u.d7], ['d30', u.d30]];
      const tbl = el('table', 'utable');
      const hd = el('tr');
      hd.append(el('th'), ...cols.map(([k]) => el('th', '', t('usage.col.' + k))));
      tbl.append(hd);
      for (const [row, key] of [['input', 'input'], ['output', 'output'], ['total', 'total'], ['cached', 'cached'], ['calls', 'calls']]) {
        const tr_ = el('tr', row === 'total' ? 'tot' : '');
        tr_.append(el('th', '', t('usage.row.' + row)), ...cols.map(([, c]) => el('td', '', fmt(c[key]))));
        tbl.append(tr_);
      }
      box.append(tbl);
      const est = Math.max(u.d30.estimated, u.session.estimated);
      if (est) box.append(el('div', 'sm-keymsg', t('usage.estimated', { n: est })));
      const models = Object.entries(u.byModel);
      if (models.length) {
        box.append(el('div', 'sd', t('usage.models')));
        const ul = el('div', 'umodels');
        models.sort((a, b) => b[1].total - a[1].total).forEach(([m, c]) => ul.append(el('div', '', `${m || '?'}  ·  ${fmt(c.input)} / ${fmt(c.output)}`)));
        box.append(ul);
      }
    }

    function officialTable(box) {
      box.replaceChildren();
      const o = ui.usage && ui.usage.official;
      if (officialMsg) box.append(el('div', 'sm-keymsg' + (officialMsg.ok ? '' : ' bad'), officialMsg.text));
      if (!o) return;
      const cols = [['today', o.ranges.today], ['d7', o.ranges.d7], ['d30', o.ranges.d30]];
      const tbl = el('table', 'utable');
      const hd = el('tr');
      hd.append(el('th'), ...cols.map(([k]) => el('th', '', t('usage.col.' + k))));
      tbl.append(hd);
      for (const [row, key] of [['input', 'input'], ['output', 'output'], ['cached', 'cached'], ['requests', 'requests']]) {
        const r = el('tr');
        r.append(el('th', '', t('usage.row.' + row)), ...cols.map(([, c]) => el('td', '', fmt(c[key]))));
        tbl.append(r);
      }
      if (o.cost) {
        const r = el('tr', 'tot');
        const cur = String(o.cost.currency || 'usd').toUpperCase();
        r.append(el('th', '', t('usage.row.cost')), ...['today', 'd7', 'd30'].map((k) => el('td', '', `${o.cost[k].toFixed(2)} ${cur}`)));
        tbl.append(r);
      }
      box.append(tbl, el('div', 'sm-keymsg', t('usage.official.at', { t: (o.fetchedAt || '').replace('T', ' ').slice(0, 16) })));
      const models = Object.entries(o.byModel).sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
      if (models.length) {
        const ul = el('div', 'umodels');
        models.forEach(([m, c]) => ul.append(el('div', '', `${m}  ·  ${fmt(c.input)} / ${fmt(c.output)}`)));
        box.append(ul);
      }
    }

    function usageSection(body, m) {
      const u = ui.usage || {};
      body.append(el('h4', 'sm-sec', t('set.sec.usage')));
      const lbox = el('div', 'ubox');
      lbox.id = 'usage-local';
      localTable(lbox);
      body.append(row(t('usage.local.title'), t('usage.local.desc'), el('span', 'sm-note'), lbox));

      const obox = el('div', 'ubox');
      const wrap = el('div');
      wrap.id = 'usage-official';
      if (!u.officialAvailable) {
        wrap.append(el('div', 'sm-keymsg', u.host ? t('usage.official.notOfficial', { host: u.host }) : t('usage.official.unset')));
      } else {
        const keyIn = el('input', 'sm-input');
        keyIn.type = 'password';
        keyIn.autocomplete = 'off';
        keyIn.placeholder = m.hasOpenaiAdminKey ? t('usage.admin.saved') : t('usage.admin.ph');
        keyIn.setAttribute('aria-label', t('usage.admin.label'));
        const save_ = el('button', 'btn', t('usage.admin.save'));
        const msg = el('span', 'sm-keymsg');
        save_.onclick = async () => {
          const r = await ait.secretSet('openai-admin', keyIn.value);
          keyIn.value = '';
          msg.textContent = r.ok ? t('usage.admin.ok') : (m.secureStorage ? tr(r.reason) : t('usage.noKeychain'));
          m.hasOpenaiAdminKey = !!r.has;
          keyIn.placeholder = r.has ? t('usage.admin.saved') : t('usage.admin.ph');
          if (ui.usage) { ui.usage.official = null; ui.usage.hasAdminKey = !!r.has; }
          officialMsg = null;
          officialTable(obox);
        };
        const as = u.adminKey;
        const adminNote = el('div', 'sm-keymsg keynote', as && as.source === 'env' ? t('usage.admin.env') : as && as.source === 'keychain' ? t('usage.admin.keychain') : t('usage.admin.how'));
        const keyRow = el('div', 'sm-keyrow');
        keyRow.append(keyIn, save_, msg);
        const adminLbl = el('div', 'st', t('usage.admin.label'));
        wrap.append(adminLbl, adminNote);
        const fetchB = withIcon('button', 'refresh', ' ' + t('usage.official.fetch'), 'btn');
        fetchB.onclick = async () => {
          if (officialBusy) return;
          officialBusy = true;
          fetchB.disabled = true;
          officialMsg = { ok: true, text: t('usage.official.fetching') };
          officialTable(obox);
          const r = await ait.usageOfficial();
          officialBusy = false;
          ui.usage = { ...(ui.usage || {}), ...r, local: r.local };
          officialMsg = r.result.ok ? null : { ok: false, text: t('usage.err.' + (r.result.reason.startsWith('http-') ? 'http' : r.result.reason), { reason: r.result.reason }) };
          fetchB.disabled = false;
          officialTable(obox);
        };
        const siteB = withIcon('button', 'external', ' ' + t('usage.official.open'), 'btn');
        siteB.onclick = () => ait.openExternal('https://platform.openai.com/usage');
        const keyPage = withIcon('button', 'external', ' ' + t('usage.admin.get'), 'btn');
        keyPage.onclick = () => ait.openExternal('https://platform.openai.com/settings/organization/admin-keys');
        const btns = el('div', 'btnrow');
        btns.append(fetchB, siteB, keyPage);
        wrap.append(keyRow, btns);
        officialTable(obox);
      }
      wrap.append(obox);
      body.append(row(t('usage.official.title'), t('usage.official.desc'), el('span', 'sm-note'), wrap));
    }

    C.registerAction('usage-changed', () => {
      const box = document.getElementById('usage-local');
      if (box) localTable(box);
    });

    async function renderSettings() {
      if (!meta) meta = await ait.settingsGet();
      const v = meta.values;
      const ch = meta.choices;
      const dlg = document.querySelector('#settings-modal .sm-dialog');
      const keepScroll = dlg.querySelector('.sm-body') ? dlg.querySelector('.sm-body').scrollTop : 0;
      dlg.innerHTML = '';
      const head = el('div', 'sm-head');
      head.append(withIcon('h3', 'gear', ' ' + t('set.title')));
      const x = el('button', 'btn icon', '×');
      x.title = t('common.closeEsc');
      x.setAttribute('aria-label', t('common.close'));
      x.onclick = closeSettings;
      head.append(x);
      dlg.append(head);
      const body = el('div', 'sm-body');

      // ---- AI model & memory
      body.append(el('h4', 'sm-sec', t('set.sec.ai')));
      const est = memEstimate(v.contextTokens, v.kvPrecision);
      const estEl = el('div', 'sm-est' + (est.warn ? ' warn' : ''));
      estEl.append(el('div', 'sm-est-line', t('set.est.prefix') + est.s), el('div', 'sm-live', liveText()));
      body.append(row(t('set.ctx.title'), t('set.ctx.hint.' + v.contextTokens) + ' ' + t('set.ctx.desc'), seg(ch.contextTokens.map((n) => [n, CTX_LABEL[n]]), v.contextTokens, (n) => save('contextTokens', n), t('set.ctx.title')), estEl));
      body.append(row(t('set.autoCtx.title'), t('set.autoCtx.desc'), toggle(v.autoContext, (b) => save('autoContext', b), t('set.autoCtx.title'))));
      body.append(row(t('set.keep.title'), t('set.keep.desc'), seg(ch.keepAlive.map((k) => [k, k === '0' ? t('set.keep.now') : t('set.keep.min', { n: KEEP_LABEL[k] })]), v.keepAlive, (k) => save('keepAlive', k), t('set.keep.title'))));
      body.append(row(t('set.kv.title'), t('set.kv.desc'), seg(ch.kvPrecision.map((k) => [k, t('set.kv.' + k)]), v.kvPrecision, (k) => save('kvPrecision', k), t('set.kv.title'))));
      body.append(row(t('set.compact.title'), t('set.compact.desc'), seg(ch.ctxCompaction.map((k) => [k, t('set.compact.' + k)]), v.ctxCompaction, (k) => save('ctxCompaction', k), t('set.compact.title'))));
      body.append(row(t('set.unload.title'), t('set.unload.desc'), toggle(v.unloadOnClose, (b) => save('unloadOnClose', b), t('set.unload.title'))));
      body.append(row(t('set.preload.title'), t('set.preload.desc'), toggle(v.preloadModel, (b) => save('preloadModel', b), t('set.preload.title'))));
      const cur = ui.llm && ui.llm.active ? ui.llm.active.label : t('model.none');
      body.append(row(t('set.curModel.title'), `${cur}. ${t('set.curModel.desc')}`, el('span', 'sm-note')));

      // ---- OpenAI-compatible server
      body.append(el('h4', 'sm-sec', t('set.sec.openai')));
      const urlIn = el('input', 'sm-input');
      urlIn.value = v.openaiBaseUrl;
      urlIn.placeholder = 'http://127.0.0.1:1234/v1';
      urlIn.setAttribute('aria-label', t('set.openai.url'));
      urlIn.onchange = async () => { if (!(await save('openaiBaseUrl', urlIn.value.trim()))) { urlIn.classList.add('bad'); } };
      const modelIn = el('input', 'sm-input');
      modelIn.value = v.openaiModel;
      modelIn.placeholder = t('set.openai.modelPh');
      modelIn.setAttribute('aria-label', t('set.openai.model'));
      modelIn.onchange = () => save('openaiModel', modelIn.value.trim());
      const keyIn = el('input', 'sm-input');
      keyIn.type = 'password';
      keyIn.placeholder = meta.hasOpenaiKey ? t('set.openai.keySaved') : t('set.openai.keyPh');
      keyIn.setAttribute('aria-label', t('set.openai.key'));
      keyIn.autocomplete = 'off';
      const keyBtn = el('button', 'btn', t('set.openai.keySave'));
      const keyMsg = el('span', 'sm-keymsg');
      keyBtn.onclick = async () => {
        const r = await ait.secretSet('openai', keyIn.value);
        keyIn.value = '';
        keyMsg.textContent = r.ok ? t('set.openai.keyOk') : tr(r.reason);
        meta = await ait.settingsGet();
        keyIn.placeholder = meta.hasOpenaiKey ? t('set.openai.keySaved') : t('set.openai.keyPh');
      };
      const ks = meta.keys && meta.keys.openai;
      const keyNote = el('div', 'sm-keymsg keynote');
      keyNote.textContent = !ks ? '' : ks.source === 'env' ? t('set.openai.keyEnv') : ks.envIgnored ? (v.openaiBaseUrl ? t('set.openai.keyEnvIgnored', { host: (() => { try { return new URL(v.openaiBaseUrl).host; } catch { return v.openaiBaseUrl; } })() }) : t('set.openai.keyEnvNoUrl')) + (ks.source === 'keychain' ? ' ' + t('set.openai.keyKeychain') : '') : ks.source === 'keychain' ? t('set.openai.keyKeychain') : t('set.openai.keyHow');
      const grid = el('div', 'sm-grid');
      grid.append(el('label', '', t('set.openai.url')), urlIn, el('label', '', t('set.openai.model')), modelIn, el('label', '', t('set.openai.key')), (() => { const w = el('div', 'sm-keyrow'); w.append(keyIn, keyBtn, keyMsg); return w; })(), el('span'), keyNote);
      const openaiRow = row(t('set.openai.title'), t('set.openai.desc') + (meta.secureStorage ? '' : '\n' + t('set.openai.noKeychain')), el('span', 'sm-note'), grid);
      openaiRow.querySelector('.sd').classList.add('pre'); // the description has several short paragraphs
      body.append(openaiRow);

      // ---- API token usage (what this app sent + the provider's own accounting)
      usageSection(body, meta);

      // ---- appearance
      body.append(el('h4', 'sm-sec', t('set.sec.look')));
      body.append(row(t('set.lang.title'), t('set.lang.desc'), seg(ch.language.map((l) => [l, t('set.lang.' + l)]), v.language, (l) => save('language', l), t('set.lang.title'))));
      body.append(row(t('set.font.title'), t('set.font.desc'), seg(ch.fontFamily.map((f) => [f, FONT_LABEL[f]]), v.fontFamily, (f) => save('fontFamily', f), t('set.font.title'))));
      const sizeCtl = el('div', 'stepper');
      const mk = (lbl, d) => { const b = el('button', 'btn', lbl); b.type = 'button'; b.setAttribute('aria-label', d > 0 ? t('set.size.up') : t('set.size.down')); b.onclick = () => save('fontSize', Math.min(22, Math.max(10, v.fontSize + d))); return b; };
      sizeCtl.append(mk('−', -1), el('b', '', `${v.fontSize}px`), mk('+', 1));
      body.append(row(t('set.size.title'), t('set.size.desc'), sizeCtl));
      body.append(row(t('set.lh.title'), t('set.lh.desc'), seg([[1, '1.0'], [1.18, '1.18'], [1.3, '1.3'], [1.5, '1.5']], v.lineHeight, (n) => save('lineHeight', n), t('set.lh.title'))));
      body.append(row(t('set.cursor.title'), t('set.cursor.desc'), (() => { const w = el('div', 'cursorctl'); w.append(seg(ch.cursorStyle.map((c) => [c, t('set.cursor.' + c)]), v.cursorStyle, (c) => save('cursorStyle', c), t('set.cursor.title')), (() => { const lab = el('label', 'inl', t('set.cursor.blink')); lab.append(toggle(v.cursorBlink, (b) => save('cursorBlink', b), t('set.cursor.blink'))); return lab; })()); return w; })()));
      body.append(row(t('set.scroll.title'), t('set.scroll.desc'), seg([[1000, '1K'], [5000, '5K'], [10000, '10K'], [50000, '50K']], v.scrollback, (n) => save('scrollback', n), t('set.scroll.title'))));
      const op = el('input', 'range');
      op.type = 'range';
      op.min = '60'; op.max = '100'; op.step = '5';
      op.value = String(Math.round(v.windowOpacity * 100));
      op.setAttribute('aria-label', t('set.opacity.title'));
      op.onchange = () => save('windowOpacity', Number(op.value) / 100);
      const opw = el('div', 'rangew');
      opw.append(op, el('b', '', `${op.value}%`));
      op.oninput = () => { opw.querySelector('b').textContent = `${op.value}%`; };
      body.append(row(t('set.opacity.title'), t('set.opacity.desc'), opw));
      body.append(row(t('set.monitor.title'), t('set.monitor.desc'), toggle(v.showMonitor, (b) => save('showMonitor', b), t('set.monitor.title'))));

      // ---- permissions, privacy, history
      body.append(el('h4', 'sm-sec', t('set.sec.safety')));
      body.append(row(t('set.perm.title'), t('set.perm.desc'), seg(ch.defaultPermission.map((p) => [p, PERM_LABEL(p)]), v.defaultPermission, (p) => save('defaultPermission', p), t('set.perm.title'))));
      body.append(row(t('set.net.title'), t('set.net.desc'), toggle(v.blockNetwork, (b) => save('blockNetwork', b), t('set.net.title'))));
      body.append(row(t('set.hist.title'), t('set.hist.desc'), toggle(v.keepHistory, (b) => save('keepHistory', b), t('set.hist.title'))));
      body.append(row(t('set.restore.title'), t('set.restore.desc'), toggle(v.restoreTabs, (b) => save('restoreTabs', b), t('set.restore.title'))));
      const auditBtns = el('div', 'btnrow');
      const cnt = el('span', 'sm-keymsg', '');
      ait.auditCount().then((n) => { cnt.textContent = t('set.audit.count', { n }); });
      for (const f of ['md', 'json']) {
        const b = withIcon('button', 'download', ' ' + (f === 'md' ? 'Markdown' : 'JSON'), 'btn');
        b.onclick = async () => { const r = await ait.auditExport(f); cnt.textContent = r.ok ? t('set.audit.saved', { p: r.path }) : ''; };
        auditBtns.append(b);
      }
      auditBtns.append(cnt);
      body.append(row(t('set.audit.title'), t('set.audit.desc'), el('span', 'sm-note'), auditBtns));

      // ---- ssh / remote
      body.append(el('h4', 'sm-sec', t('set.sec.ssh')));
      body.append(row(t('set.ssh.auto.title'), t('set.ssh.auto.desc'), seg(['ask', 'auto', 'off'].map((k) => [k, t('set.ssh.auto.' + k)]), v.sshAutoRemote, (k) => save('sshAutoRemote', k), t('set.ssh.auto.title'))));
      body.append(row(t('set.ssh.strict.title'), t('set.ssh.strict.desc'), toggle(v.sshStrict, (b) => save('sshStrict', b), t('set.ssh.strict.title'))));
      body.append(row(t('set.ssh.monitor.title'), t('set.ssh.monitor.desc'), toggle(v.sshMonitor, (b) => save('sshMonitor', b), t('set.ssh.monitor.title'))));
      body.append(row(t('set.ssh.sec.title'), t('set.ssh.sec.desc'), seg([2, 3, 5, 10].map((n) => [n, `${n}s`]), v.sshMonitorSec, (n) => save('sshMonitorSec', n), t('set.ssh.sec.title'))));
      body.append(row(t('set.ssh.keepAlive.title'), t('set.ssh.keepAlive.desc'), toggle(v.sshKeepAlive, (b) => save('sshKeepAlive', b), t('set.ssh.keepAlive.title'))));
      body.append(row(t('set.ssh.share.title'), t('set.ssh.share.desc'), toggle(v.sshShare, (b) => save('sshShare', b), t('set.ssh.share.title'))));
      body.append(row(t('set.ssh.files.title'), t('set.ssh.files.desc'), seg(['auto', 'manual'].map((k) => [k, t('set.ssh.files.' + k)]), v.sshFiles, (k) => save('sshFiles', k), t('set.ssh.files.title'))));

      // ---- shortcuts
      body.append(el('h4', 'sm-sec', t('set.sec.keys')));
      const keysBox = el('div', 'keys');
      const eff = { ...ch.defaultKeys, ...v.keybindings };
      // shown the way macOS writes shortcuts (⌘⇧T) and recorded by pressing the keys; stored as an Electron accelerator (CmdOrCtrl+Shift+T)
      const MODS = [['⌃', /^(Ctrl|Control)$/i], ['⌥', /^(Alt|Option)$/i], ['⇧', /^Shift$/i], ['⌘', /^(CmdOrCtrl|Cmd|Command|Super)$/i]];
      const SPECIAL = { Enter: '↩', Tab: '⇥', Space: 'Space', Up: '↑', Down: '↓', Left: '←', Right: '→', Plus: '+' };
      const pretty = (acc) => {
        const parts = String(acc).split('+');
        const key = parts.pop();
        return MODS.filter(([, re]) => parts.some((p) => re.test(p))).map(([g]) => g).join('') + (SPECIAL[key] || (key.length === 1 ? key.toUpperCase() : key));
      };
      const norm = (acc) => String(acc).toLowerCase().replace(/\b(cmd|command|super)\b/g, 'cmdorctrl').replace(/\boption\b/g, 'alt').split('+').sort().join('+');
      const CODE = { BracketLeft: '[', BracketRight: ']', Period: '.', Comma: ',', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Equal: '=', Minus: '-', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
      const accelOf = (e) => {
        let k = CODE[e.code];
        if (!k) { if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3); else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5); else if (/^F\d{1,2}$/.test(e.code)) k = e.code; }
        if (!k) return ''; // a modifier on its own, or a key that cannot be a shortcut
        const mods = [e.metaKey && 'CmdOrCtrl', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
        if (!mods.length && !/^F\d/.test(k)) return ''; // a plain letter would be typed into the terminal
        return [...mods, k].join('+');
      };
      ch.keyActions.forEach((a) => {
        const r = el('div', 'keyrow');
        r.append(el('span', 'kn', t('key.' + a)));
        const inp = el('input', 'sm-input kin');
        inp.readOnly = true;
        inp.value = pretty(eff[a]);
        inp.title = eff[a];
        inp.setAttribute('aria-label', t('key.' + a));
        const apply = async (acc) => {
          const other = ch.keyActions.find((x) => x !== a && norm(eff[x]) === norm(acc));
          if (other) { inp.classList.add('bad'); inp.title = t('set.keys.dup', { name: t('key.' + other) }); return false; }
          const next = { ...v.keybindings, [a]: acc };
          if (acc === ch.defaultKeys[a]) delete next[a];
          return save('keybindings', next);
        };
        inp.onfocus = () => { inp.classList.remove('bad'); inp.value = t('set.keys.press'); inp.classList.add('rec'); ait.keysRecord(true); };
        inp.onblur = () => { ait.keysRecord(false); inp.classList.remove('rec'); inp.value = pretty(eff[a]); };
        inp.onkeydown = async (e) => {
          if (e.key === 'Tab') return; // keep keyboard navigation working
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') return inp.blur();
          if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) { const next = { ...v.keybindings }; delete next[a]; await save('keybindings', next); return; }
          const acc = accelOf(e);
          if (!acc) return;
          if (!(await apply(acc))) inp.value = pretty(acc); // refused (already used): show what was pressed and why on hover
        };
        const rst = el('button', 'btn', t('set.keys.reset'));
        rst.onclick = () => { const next = { ...v.keybindings }; delete next[a]; save('keybindings', next); };
        r.append(inp, rst);
        keysBox.append(r);
      });
      body.append(el('div', 'sd keyhint', t('set.keys.desc')), keysBox);

      // ---- updates
      body.append(el('h4', 'sm-sec', t('set.sec.update')));
      const upMsg = el('div', 'sm-keymsg upmsg');
      const upBtn = withIcon('button', 'refresh', ' ' + t('set.update.now'), 'btn');
      upBtn.onclick = async () => { upMsg.textContent = t('set.update.checking'); showUpdateResult(await ait.updateCheck(), upMsg); };
      const upW = el('div', 'btnrow');
      upW.append(upBtn, upMsg);
      body.append(row(t('set.update.auto'), t('set.update.desc'), toggle(v.updateCheck, (b) => save('updateCheck', b), t('set.update.auto')), upW));

      const foot = el('div', 'sm-foot');
      const reset = el('button', 'btn', t('set.reset'));
      reset.onclick = async () => { meta.values = await ait.settingsReset(); C.onSettingsChanged(meta.values); renderSettings(); };
      foot.append(el('span', 'sm-ver', ui.build ? t('set.version', { v: ui.build.version, at: ui.build.builtAt }) : ''), reset);
      dlg.append(body, foot);
      body.scrollTop = keepScroll;
      updateLive();
    }
    async function openSettings() {
      meta = await ait.settingsGet();
      ui.usage = { ...(ui.usage || {}), ...(await ait.usageGet()) };
      const kvi = await ait.kvInfo();
      ui.kvGeo = kvi && kvi.f16PerToken ? kvi : null;
      await renderSettings();
      $('settings-modal').hidden = false;
      const first = document.querySelector('#settings-modal .sm-dialog button, #settings-modal .sm-dialog input');
      first && first.focus();
    }
    function closeSettings() { $('settings-modal').hidden = true; const tab = C.getTab(); tab && tab.panes.main.term.focus(); }
    document.querySelector('#settings-modal .sm-backdrop').addEventListener('click', closeSettings);
    C.registerAction('settings', () => ($('settings-modal').hidden ? openSettings() : closeSettings()));
    C.registerAction('settings-changed', (vals) => { if (meta) meta.values = vals; if (!$('settings-modal').hidden) renderSettings(); });

    // ================================================================= update notice
    function showUpdateResult(r, into) {
      const wrap = into || C.getTab() && el('span');
      let msg;
      if (r.status === 'available') msg = t('update.available', { v: r.latest, cur: r.current });
      else if (r.status === 'current') msg = t('update.current', { v: r.current });
      else if (r.status === 'unavailable') msg = tr(r.reason);
      else if (r.status === 'unconfigured') msg = t('update.unconfigured');
      else msg = tr(r.reason || '');
      if (into) {
        into.textContent = msg + ' ';
        if (r.status === 'available') {
          const b = withIcon('button', 'external', ' ' + t('update.open'), 'btn');
          b.onclick = () => ait.openExternal(r.downloadUrl || r.url);
          into.append(b);
        }
      } else if (wrap) {
        const tab = C.getTab();
        const c = C.note(tab, msg, r.status === 'available' ? 'warn' : '');
        if (r.status === 'available') {
          const b = withIcon('button', 'external', ' ' + t('update.open'), 'btn');
          b.style.marginLeft = '8px';
          b.onclick = () => ait.openExternal(r.downloadUrl || r.url);
          c.append(b);
        }
      }
    }
    C.registerAction('update-check', async () => { const tab = C.getTab(); C.note(tab, t('set.update.checking')); showUpdateResult(await ait.updateCheck()); });
    ait.onUpdateAvailable((r) => showUpdateResult(r));

    // ================================================================= drawer (blocks / processes)
    const drawer = $('drawer');
    let drawerKind = null;
    let procTimer = null;
    function closeDrawer() {
      drawer.hidden = true;
      drawerKind = null;
      clearInterval(procTimer);
      C.doFit();
    }
    $('drawer-close').onclick = closeDrawer;
    const fmtDur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

    function renderBlocks() {
      const tab = C.getTab();
      const body = $('drawer-body');
      body.innerHTML = '';
      if (!tab) return;
      const onlyFail = drawer.dataset.filter === 'fail';
      const bar = el('div', 'dr-filter');
      const fAll = el('button', 'seg-b' + (onlyFail ? '' : ' on'), t('blocks.all'));
      const fFail = el('button', 'seg-b' + (onlyFail ? ' on' : ''), t('blocks.failed'));
      fAll.onclick = () => { drawer.dataset.filter = 'all'; renderBlocks(); };
      fFail.onclick = () => { drawer.dataset.filter = 'fail'; renderBlocks(); };
      bar.append(fAll, fFail);
      body.append(bar);
      const list = tab.blocks.filter((b) => !onlyFail || (!b.running && b.exitCode !== 0)).slice().reverse();
      if (!list.length) body.append(el('div', 'dr-empty', t('blocks.empty')));
      list.forEach((b) => {
        const c = el('div', 'block ' + (b.running ? 'run' : b.exitCode === 0 ? 'ok' : 'fail'));
        const hd = el('div', 'bhd');
        hd.append(el('span', 'bdot'), el('code', 'bcmd', b.command), el('span', 'bmeta', b.running ? t('blocks.running') : `${b.exitCode === 0 ? '✓' : '✗ ' + b.exitCode} · ${fmtDur(b.durationMs)} · ${b.by === 'ai' ? 'AI' : t('blocks.you')}`));
        c.append(hd);
        if (!b.running && b.output) {
          const d = el('details');
          d.append(el('summary', '', t('blocks.output', { n: b.output.split('\n').length })), el('pre', 'out', b.output));
          c.append(d);
        }
        const act = el('div', 'bact');
        const mkb = (ic, label, fn) => { const x = withIcon('button', ic, ' ' + label, 'btn'); x.onclick = fn; return x; };
        act.append(mkb('copy', t('blocks.copyCmd'), () => ait.copy(b.command)));
        if (!b.running) act.append(mkb('copy', t('blocks.copyOut'), () => ait.copy(b.outputRaw || b.output || '')));
        act.append(mkb('play', t('blocks.rerun'), async () => { const r = await ait.shellRun(tab.id, b.command); if (!r.ok) C.note(tab, tr(r.reason), 'warn'); }));
        if (!b.running) act.append(mkb('sparkle', t('blocks.explain'), () => { C.submitAi(tab, t('blocks.explainPrompt', { cmd: b.command, code: b.exitCode, out: (b.output || '').slice(-1500) })); closeDrawer(); }));
        c.append(act);
        body.append(c);
      });
    }

    async function renderProcs() {
      const tab = C.getTab();
      const body = $('drawer-body');
      if (!tab || drawerKind !== 'procs') return;
      const list = await ait.procList(tab.id);
      if (drawerKind !== 'procs') return;
      body.innerHTML = '';
      body.append(el('div', 'dr-hint', t('procs.hint')));
      if (!list.length) body.append(el('div', 'dr-empty', t('procs.empty')));
      list.forEach((p) => {
        const c = el('div', 'proc');
        const hd = el('div', 'bhd');
        hd.style.paddingLeft = `${p.depth * 14}px`;
        hd.append(el('code', 'bcmd', p.command), el('span', 'bmeta', `PID ${p.pid} · CPU ${p.cpu}% · ${p.rssMB}MB · ${p.etime}`));
        c.append(hd);
        if (p.ports.length) {
          const pr = el('div', 'ports');
          p.ports.forEach((port) => { const b = el('button', 'portchip', `:${port}`); b.title = t('procs.openPort', { port }); b.onclick = () => ait.linkOpen('url', `http://localhost:${port}`); pr.append(b); });
          c.append(pr);
        }
        const act = el('div', 'bact');
        const stopB = withIcon('button', 'stop', ' ' + t('procs.stop'), 'btn danger');
        stopB.onclick = async () => { await ait.procKill(tab.id, p.pid, 'SIGTERM'); renderProcs(); };
        const killB = el('button', 'btn danger', t('procs.kill'));
        killB.onclick = async () => { if (confirm(t('procs.killConfirm', { pid: p.pid }))) { await ait.procKill(tab.id, p.pid, 'SIGKILL'); renderProcs(); } };
        act.append(stopB, killB);
        c.append(act);
        body.append(c);
      });
    }

    function openDrawer(kind) {
      if (drawerKind === kind) return closeDrawer();
      drawerKind = kind;
      drawer.hidden = false;
      $('drawer-title').replaceChildren(icon(kind === 'blocks' ? 'list' : 'activity'), document.createTextNode(' ' + t(kind === 'blocks' ? 'blocks.title' : 'procs.title')));
      clearInterval(procTimer);
      $('drawer-body').replaceChildren(); // never show the other panel's list while this one loads
      if (kind === 'blocks') renderBlocks();
      else { renderProcs(); procTimer = setInterval(renderProcs, 2000); }
      C.doFit();
    }
    C.registerAction('blocks', () => openDrawer('blocks'));
    C.registerAction('processes', () => openDrawer('procs'));
    C.registerAction('blocks-changed', (tab) => { if (drawerKind === 'blocks' && tab === C.getTab()) renderBlocks(); });
    C.registerAction('tab-activated', () => { if (drawerKind === 'blocks') renderBlocks(); });

    // ================================================================= session history
    const hm = $('history-modal');
    let histSel = null;
    async function loadHistory(query) {
      const listEl = $('hist-list');
      listEl.innerHTML = '';
      const q = (query || '').trim();
      const items = q ? await ait.historySearch(q) : await ait.historyList();
      if (!items.length) listEl.append(el('div', 'dr-empty', q ? t('hist.noMatch') : t('hist.empty')));
      items.forEach((s) => {
        const it = el('div', 'hitem' + (histSel === s.id ? ' sel' : ''));
        it.setAttribute('role', 'button');
        it.tabIndex = 0;
        it.append(el('div', 'ht', s.title), el('div', 'hm', q ? s.snippet : `${(s.startedAt || '').replace('T', ' ').slice(0, 16)} · ${(s.cwd || '').replace(ui.home, '~')} · ${t('hist.turns', { n: s.turns })}`));
        const open = () => { histSel = s.id; showSession(s.id); listEl.querySelectorAll('.hitem').forEach((n) => n.classList.toggle('sel', n === it)); };
        it.onclick = open;
        it.onkeydown = (e) => { if (e.key === 'Enter') open(); };
        listEl.append(it);
      });
    }
    async function showSession(id) {
      const view = $('hist-view');
      view.innerHTML = '';
      const rows = await ait.historyRead(id);
      const tools = el('div', 'hist-tools');
      const ex = withIcon('button', 'download', ' ' + t('hist.export'), 'btn');
      ex.onclick = async () => { const r = await ait.historyExport(id); if (r.ok) ex.textContent = t('hist.exported'); };
      const del = withIcon('button', 'trash', ' ' + t('hist.delete'), 'btn danger');
      del.onclick = async () => { if (!confirm(t('hist.deleteConfirm'))) return; await ait.historyDelete(id); histSel = null; view.innerHTML = ''; loadHistory($('hist-q').value); };
      tools.append(ex, del);
      view.append(tools);
      rows.forEach((r) => {
        if (r.t === 'user') view.append(el('div', 'msg user' + (r.mode === 'shell' ? ' shell' : ''), (r.mode === 'shell' ? '$ ' : '') + r.text));
        else if (r.t === 'ai' && r.ev) {
          const e = r.ev;
          if (e.type === 'say') view.append(C.richText(el('div', 'msg ai'), tr(e.text)));
          else if (e.type === 'command-start') view.append(el('div', 'hcmd', '$ ' + e.command));
          else if (e.type === 'command-result') { if (e.output) view.append(el('pre', 'out', e.output)); view.append(el('div', 'hexit ' + (e.exitCode === 0 ? 'ok' : 'fail'), t('hist.exit', { code: e.exitCode }))); }
          else if (e.type === 'file-write') { const d = el('pre', 'diff'); d.append(el('div', 'hexit', `${e.created ? '＋' : '✎'} ${e.path}`)); (e.diff ? e.diff.lines : []).forEach((l) => d.append(el('span', l.startsWith('+') ? 'add' : 'rem', l))); view.append(d); }
          else if (e.type === 'plan') { const ol = el('ol', 'plan-steps'); e.steps.forEach((s) => ol.append(el('li', '', s))); view.append(ol); }
          else if (e.type === 'error') view.append(el('div', 'note warn', tr(e.message)));
        }
      });
      if (!rows.length) view.append(el('div', 'dr-empty', t('hist.emptySession')));
    }
    async function openHistory() {
      hm.hidden = false;
      histSel = null;
      $('hist-view').innerHTML = '';
      $('hist-q').value = '';
      await loadHistory('');
      $('hist-q').focus();
    }
    const closeHistory = () => { hm.hidden = true; };
    $('hist-close').onclick = closeHistory;
    hm.querySelector('.sm-backdrop').addEventListener('click', closeHistory);
    let hq;
    $('hist-q').addEventListener('input', () => { clearTimeout(hq); hq = setTimeout(() => loadHistory($('hist-q').value), 200); });
    C.registerAction('history', () => (hm.hidden ? openHistory() : closeHistory()));

    // ================================================================= onboarding / model problem
    function removeBanner(tab) { const b = tab.tl.querySelector('.banner'); if (b) b.remove(); }
    async function showOnboarding(tab, st) {
      removeBanner(tab);
      const b = el('div', 'banner onboard');
      b.setAttribute('role', 'region');
      b.setAttribute('aria-label', t('onboard.title'));
      b.append(el('div', 'ob-title', t('onboard.title')));
      const body = el('div', 'ob-body');
      b.append(body);
      tab.tl.prepend(b);
      const render = async () => {
        const s = await ait.onboardStatus();
        body.innerHTML = '';
        const p = (st && st.problem) || { hints: [] };
        if (!s.installed) {
          body.append(el('div', 'ob-step', t('onboard.noOllama')));
          const row1 = el('div', 'btnrow');
          const dl = withIcon('button', 'external', ' ' + t('onboard.openSite'), 'btn');
          dl.onclick = () => ait.openExternal('https://ollama.com/download');
          row1.append(dl, el('code', 'ob-code', 'brew install ollama'));
          body.append(row1);
        } else if (!s.hasModel) {
          body.append(el('div', 'ob-step', t('onboard.noModel', { ram: s.ramGB })));
          s.recommended.forEach((m) => {
            const r = el('div', 'ob-model' + (m.preferred ? ' pref' : ''));
            const info = el('div', 'ob-info');
            info.append(el('div', 'mn', `${m.name} · ${m.sizeGB}GB`), el('div', 'md', m.note));
            const go = withIcon('button', 'download', ' ' + t('onboard.download', { gb: m.sizeGB }), 'btn' + (m.preferred ? ' primary' : ''));
            const prog = el('div', 'ob-prog');
            prog.hidden = true;
            const bar = el('div', 'ob-bar');
            const fill = el('i');
            bar.append(fill);
            const lab = el('span', 'ob-lab');
            const cancel = el('button', 'btn', t('onboard.cancel'));
            prog.append(bar, lab, cancel);
            go.onclick = async () => {
              if (!confirm(t('onboard.confirm', { name: m.name, gb: m.sizeGB }))) return;
              go.disabled = true;
              prog.hidden = false;
              const off = ait.onOnboardProgress((pr) => {
                if (pr.name !== m.name) return;
                fill.style.width = `${pr.pct == null ? 4 : pr.pct}%`;
                lab.textContent = pr.pct == null ? tr(pr.status) : `${pr.pct}% · ${Math.round(pr.completed / 1e6)} / ${Math.round(pr.total / 1e6)} MB`;
              });
              cancel.onclick = () => ait.onboardAbort();
              const r = await ait.onboardPull(m.name);
              off();
              if (r.ok) { lab.textContent = t('onboard.done'); await ait.llmSetModel(m.name, 'ollama'); } else { lab.textContent = tr(r.reason); go.disabled = false; }
            };
            r.append(info, go, prog);
            body.append(r);
          });
        } else {
          body.append(el('div', 'ob-step', (p.hints || []).map(tr).join('\n') || t('onboard.generic')));
        }
        const row2 = el('div', 'btnrow');
        const re = withIcon('button', 'refresh', ' ' + t('model.recheck'), 'btn');
        re.onclick = async () => { re.textContent = t('err.checking'); const r = await ait.llmDetect(); if (!r.active) render(); };
        row2.append(re);
        body.append(row2);
      };
      await render();
    }
    C.registerAction('model-problem', (tab, st) => showOnboarding(tab, st));
    C.registerAction('model-ok', () => { C.getOrder().forEach((id) => { const tb = C.tabs.get(id); tb && removeBanner(tb); }); });

    // Esc closes the topmost panel
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!hm.hidden) { e.preventDefault(); closeHistory(); } else if (!$('settings-modal').hidden) { e.preventDefault(); closeSettings(); } else if (!drawer.hidden && document.activeElement && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { closeDrawer(); }
    }, true);

    window.__panels = { openSettings, closeSettings, openHistory, closeHistory, openDrawer, closeDrawer, save };
  };
  if (window.AITCore) start();
  else document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));
})();
