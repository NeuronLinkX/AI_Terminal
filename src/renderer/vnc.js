'use strict';
// Remote screen (VNC) in the window: a view that covers the terminal of an SSH tab and shows the server's desktop. noVNC draws it
// (loaded the first time a screen is opened); the bytes travel over IPC and the tab's ssh connection (src/main/vnc.js), so no network
// code lives here and no port is opened on this Mac. The VNC password is asked for in a dialog, used once and never stored.
// Design rules: docs/VNC_CODE_GUIDE.md.
(() => {
  const start = () => {
    const C = window.AITCore;
    const SSH = window.AITSsh;
    const { ait, $, el, icon, withIcon, t } = C;
    const { toast, modal, store } = SSH;

    const PRESETS = { fast: { q: 3, c: 6 }, balanced: { q: 6, c: 2 }, sharp: { q: 9, c: 0 } };
    const AUTO_RETRIES = 5; // an automatic opening waits for a server whose VNC is still starting: this many more tries...
    const RETRY_MS = 4000; // ...this far apart
    const ACK_BYTES = 64 * 1024; // tell the main process what has been processed, in steps of this size (flow control)
    const views = new Map(); // tab id -> view
    const byVid = new Map(); // screen number -> view (while connecting / connected)
    const early = new Map(); // screen number -> events that arrived before the view knew its number

    // noVNC is loaded on first use: no cost at start-up for people who never open a remote screen
    let RFB = null;
    const loadRfb = async () => {
      if (!RFB) RFB = (await import('../../node_modules/@novnc/novnc/core/rfb.js')).default;
      return RFB;
    };

    /**
     * The shape of a WebSocket as noVNC needs it, backed by IPC. noVNC attaches its handlers a moment after it is created, so
     * what arrives before that waits in a queue and is handed over in order (never dropped, never early).
     */
    class IpcChannel {
      constructor(view) {
        this.view = view;
        this.binaryType = 'arraybuffer';
        this.protocol = '';
        this.onopen = null;
        this.onerror = null;
        this._om = null;
        this._oc = null;
        this._q = [];
        this._draining = false;
        this._state = 'open';
      }
      get readyState() { return this._state; }
      get onmessage() { return this._om; }
      set onmessage(f) { this._om = f; this._drain(); }
      get onclose() { return this._oc; }
      set onclose(f) { this._oc = f; this._drain(); }
      send(data) {
        if (this._state === 'open') ait.vncWrite(this.view.tabId, this.view.vid, data);
      }
      close() {
        if (this._state === 'closed') return;
        this._state = 'closed';
        ait.vncClose(this.view.tabId, this.view.vid);
        this._q.push({ close: { code: 1000, wasClean: true } });
        this._drain();
      }
      _in(u8) { // from the main process
        if (this._state !== 'open') return;
        this._q.push({ data: u8 });
        this._drain();
      }
      _end(code) {
        if (this._state === 'closed') return;
        this._state = 'closed';
        this.view.endCode = code || '';
        this._q.push({ close: { code: 1006, wasClean: code === 'closed' } });
        this._drain();
      }
      _drain() {
        if (this._draining) return;
        this._draining = true;
        queueMicrotask(() => {
          this._draining = false;
          while (this._q.length) {
            const x = this._q[0];
            if (x.data) {
              if (!this._om) return;
              this._q.shift();
              const u8 = x.data;
              this._om({ data: u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer });
              noteBytes(this.view, u8.byteLength);
            } else {
              if (!this._oc) return;
              this._q.shift();
              this._oc({ code: x.close.code, reason: '', wasClean: x.close.wasClean });
            }
          }
        });
      }
    }

    // ---- flow control: confirm bytes only while the view is on screen (a hidden tab makes the main process stop reading, R4)
    const canAck = (v) => v.shown && !document.hidden;
    function flushAck(v) {
      clearTimeout(v.ackTimer);
      v.ackTimer = null;
      if (v.unacked > 0 && v.vid && canAck(v)) { ait.vncAck(v.tabId, v.vid, v.unacked); v.unacked = 0; }
    }
    function noteBytes(v, n) {
      v.unacked += n;
      if (v.unacked >= ACK_BYTES) flushAck(v);
      else if (!v.ackTimer) v.ackTimer = setTimeout(() => flushAck(v), 40);
    }
    document.addEventListener('visibilitychange', () => views.forEach(flushAck));

    ait.onVncData(({ vid, data }) => {
      const v = byVid.get(vid);
      if (v && v.channel) return v.channel._in(data);
      if (!early.has(vid)) { early.set(vid, []); setTimeout(() => early.delete(vid), 3000); }
      early.get(vid).push({ data });
    });
    ait.onVncEnd(({ vid, code }) => {
      const v = byVid.get(vid);
      if (v && v.channel) return v.channel._end(code);
      if (early.has(vid)) early.get(vid).push({ end: code });
    });

    // ---- one view per tab
    const hostKey = (v) => { const st = SSH.S.tabs.get(v.tabId); return st && st.ssh ? st.ssh.target.label : v.tabId; };
    const errText = (code) => { const k = `vnc.err.${code || 'failed'}`; const s = t(k); return s === k ? t('vnc.err.failed') : s; };

    function setState(v, state, text = '') {
      v.state = state;
      v.root.dataset.state = state;
      const label = state === 'connected' ? t('vnc.state.connected') : state === 'connecting' ? t('vnc.state.connecting') : state === 'ended' ? t('vnc.state.ended') : t('vnc.state.idle');
      v.status.textContent = label;
      v.status.title = v.desktop || '';
      const live = state === 'connecting' || state === 'connected';
      v.go.textContent = live ? t('vnc.disconnect') : state === 'ended' ? t('vnc.reconnect') : t('vnc.connect');
      v.go.classList.toggle('primary', !live);
      v.port.disabled = live;
      v.cad.disabled = state !== 'connected';
      v.clipSend.disabled = state !== 'connected';
      v.clipGet.disabled = !(state === 'connected' && v.remoteClip);
      v.msg.hidden = state === 'connected';
      v.msgText.textContent = state === 'connecting' ? text || t('vnc.state.connecting') : text || (state === 'idle' ? t('vnc.hint') : state === 'ended' ? t('vnc.state.ended') : '');
      v.msgText.classList.toggle('vnc-err', state === 'ended' && !!text);
      renderToggle();
    }

    function createView(tabId) {
      const v = { tabId, open: false, shown: false, state: 'idle', vid: 0, channel: null, rfb: null, endCode: '', secReason: '', desktop: '', remoteClip: '', unacked: 0, ackTimer: null, retryLeft: 0, retryTimer: null };
      v.root = el('div', 'vnc-wrap');
      v.root.hidden = true;
      v.root.dataset.state = 'idle';
      const bar = el('div', 'vnc-bar');
      const back = withIcon('button', 'terminal', ' ' + t('vnc.back'), 'btn mini');
      back.type = 'button';
      back.onclick = () => hide(v);
      const st = el('span', 'vnc-status');
      v.status = el('span', '', '');
      st.append(el('span', 'dot'), v.status);
      const pl = el('label', 'vnc-port');
      pl.title = t('vnc.port.tip');
      v.port = el('input', 'sm-input');
      v.port.type = 'number';
      v.port.min = '1';
      v.port.max = '65535';
      v.port.value = store.get(`ait.vnc.port.${hostKey(v)}`, '5901');
      v.port.setAttribute('aria-label', t('vnc.port'));
      pl.append(el('span', '', t('vnc.port')), v.port);
      v.go = el('button', 'btn mini primary');
      v.go.type = 'button';
      v.go.onclick = () => (v.state === 'connecting' || v.state === 'connected' ? disconnect(v) : connect(v));
      v.port.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); v.go.click(); } });
      const sel = (opts, cur, tip, onChange) => { const s = el('select', 'sm-input vnc-sel'); opts.forEach(([val, label]) => { const o = el('option', '', label); o.value = val; s.append(o); }); s.value = cur; s.title = tip; s.onchange = () => onChange(s.value); return s; };
      v.scaleVal = store.get('ait.vnc.scale', 'fit');
      v.presetVal = PRESETS[store.get('ait.vnc.preset', 'balanced')] ? store.get('ait.vnc.preset', 'balanced') : 'balanced';
      v.scale = sel([['fit', t('vnc.scale.fit')], ['one', t('vnc.scale.one')]], v.scaleVal, t('vnc.scale.tip'), (x) => { v.scaleVal = x; store.set('ait.vnc.scale', x); applyOptions(v); });
      v.preset = sel([['fast', t('vnc.q.fast')], ['balanced', t('vnc.q.balanced')], ['sharp', t('vnc.q.sharp')]], v.presetVal, t('vnc.q.tip'), (x) => { v.presetVal = x; store.set('ait.vnc.preset', x); applyOptions(v); });
      const vo = el('label', 'chk vnc-vo');
      v.viewOnly = el('input');
      v.viewOnly.type = 'checkbox';
      v.viewOnly.onchange = () => applyOptions(v);
      vo.title = t('vnc.viewonly.tip');
      vo.append(v.viewOnly, el('span', '', t('vnc.viewonly')));
      const au = el('label', 'chk vnc-vo vnc-auto');
      v.auto = el('input');
      v.auto.type = 'checkbox';
      v.auto.checked = store.get(`ait.vnc.auto.${hostKey(v)}`, '') === '1';
      v.auto.onchange = () => { store.set(`ait.vnc.auto.${hostKey(v)}`, v.auto.checked ? '1' : ''); if (v.auto.checked) store.set(`ait.vnc.port.${hostKey(v)}`, String(Number(v.port.value) || 5901)); };
      au.title = t('vnc.auto.tip');
      au.append(v.auto, el('span', '', t('vnc.auto')));
      v.cad = el('button', 'btn mini', 'Ctrl+Alt+Del');
      v.cad.type = 'button';
      v.cad.onclick = () => v.rfb && v.rfb.sendCtrlAltDel();
      v.clipSend = withIcon('button', 'upload', '', 'btn mini icon');
      v.clipSend.type = 'button';
      v.clipSend.title = t('vnc.clip.send');
      v.clipSend.setAttribute('aria-label', t('vnc.clip.send'));
      v.clipSend.onclick = async () => { const text = await ait.clipboardRead(); if (v.rfb && text) { v.rfb.clipboardPasteFrom(text); toast(t('vnc.clip.sent')); } };
      v.clipGet = withIcon('button', 'download', '', 'btn mini icon');
      v.clipGet.type = 'button';
      v.clipGet.title = t('vnc.clip.get');
      v.clipGet.setAttribute('aria-label', t('vnc.clip.get'));
      v.clipGet.onclick = () => { if (v.remoteClip) { ait.copy(v.remoteClip); toast(t('vnc.clip.copied')); } };
      const fs = withIcon('button', 'expand', '', 'btn mini icon');
      fs.type = 'button';
      fs.title = t('vnc.fullscreen');
      fs.setAttribute('aria-label', t('vnc.fullscreen'));
      fs.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else v.root.requestFullscreen().catch(() => {}); };
      bar.append(back, st, el('span', 'grow'), pl, v.go, v.scale, v.preset, vo, au, v.cad, v.clipSend, v.clipGet, fs);
      v.screen = el('div', 'vnc-screen');
      v.screen.addEventListener('mousedown', () => v.rfb && v.rfb.focus());
      v.msg = el('div', 'vnc-msg');
      v.msgText = el('div', 'vnc-msg-text');
      v.msg.append(v.msgText);
      v.root.append(bar, v.screen, v.msg);
      $('terminal').append(v.root);
      views.set(tabId, v);
      setState(v, 'idle');
      return v;
    }

    function applyOptions(v) {
      const r = v.rfb;
      if (!r) return;
      const p = PRESETS[v.presetVal] || PRESETS.balanced;
      r.scaleViewport = v.scaleVal === 'fit';
      r.clipViewport = false;
      r.resizeSession = false; // never change the server's desktop size
      r.showDotCursor = false;
      r.qualityLevel = p.q;
      r.compressionLevel = p.c;
      r.viewOnly = v.viewOnly.checked;
      r.background = '#0b0d11';
    }

    async function connect(v, { again = false, retries } = {}) {
      if (!again && (v.state === 'connecting' || v.state === 'connected')) return;
      if (retries !== undefined) v.retryLeft = retries; else if (!again) v.retryLeft = 0; // only an automatic opening keeps trying
      clearTimeout(v.retryTimer);
      v.retryTimer = null;
      const port = Number(v.port.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return setState(v, 'ended', errText('bad-target'));
      store.set(`ait.vnc.port.${hostKey(v)}`, String(port));
      v.endCode = '';
      v.userClose = false;
      v.secReason = '';
      v.desktop = '';
      v.remoteClip = '';
      setState(v, 'connecting');
      let R;
      try { R = await loadRfb(); } catch { return setState(v, 'ended', errText('load')); }
      if (v.state !== 'connecting') return; // cancelled while the module was loading
      const r = await ait.vncOpen(v.tabId, port);
      if (!r || !r.ok) return setState(v, 'ended', errText(r && r.code));
      if (v.state !== 'connecting') { ait.vncClose(v.tabId, r.vid); return; }
      v.vid = r.vid;
      v.unacked = 0;
      byVid.set(r.vid, v);
      v.channel = new IpcChannel(v);
      v.screen.replaceChildren();
      try {
        v.rfb = new R(v.screen, v.channel, { shared: true });
      } catch {
        release(v);
        return setState(v, 'ended', errText('failed'));
      }
      const rfb = v.rfb;
      applyOptions(v);
      rfb.addEventListener('connect', () => { setState(v, 'connected'); applyOptions(v); if (v.shown) rfb.focus(); });
      rfb.addEventListener('disconnect', () => finish(v));
      rfb.addEventListener('credentialsrequired', (e) => askCredentials(v, e.detail && e.detail.types));
      rfb.addEventListener('securityfailure', (e) => { v.secReason = (e.detail && e.detail.reason) || 'x'; });
      rfb.addEventListener('desktopname', (e) => { v.desktop = (e.detail && e.detail.name) || ''; v.status.title = v.desktop; });
      rfb.addEventListener('clipboard', (e) => { v.remoteClip = (e.detail && e.detail.text) || ''; v.clipGet.disabled = !v.remoteClip; });
      const pending = early.get(r.vid);
      early.delete(r.vid);
      for (const x of pending || []) { if (x.data) v.channel._in(x.data); else v.channel._end(x.end); }
    }

    /** Drop everything that belongs to the running connection (safe to call again). */
    function release(v) {
      clearTimeout(v.ackTimer);
      v.ackTimer = null;
      if (v.vid) { byVid.delete(v.vid); }
      v.vid = 0;
      v.rfb = null;
      v.channel = null;
      v.screen.replaceChildren();
    }

    function finish(v) {
      if (v.vid && v.channel) ait.vncClose(v.tabId, v.vid); // harmless when the main process already ended it
      const code = v.endCode;
      const sec = v.secReason;
      const wasLive = v.state === 'connected' || v.state === 'connecting';
      const byUser = v.userClose;
      v.userClose = false;
      release(v);
      if (!wasLive) return;
      if (byUser) return setState(v, 'idle');
      if (code === 'refused' && v.retryLeft > 0 && !sec) { // the server's VNC may still be starting: ask again shortly
        v.retryLeft--;
        setState(v, 'connecting', t('vnc.waiting'));
        v.retryTimer = setTimeout(() => { v.retryTimer = null; if (v.state === 'connecting' && !v.rfb && !v.vid) connect(v, { again: true }); }, RETRY_MS);
        return;
      }
      if (sec) return setState(v, 'ended', t('vnc.err.security'));
      if (code && code !== 'closed') return setState(v, 'ended', errText(code));
      setState(v, 'ended', code === 'closed' ? t('vnc.err.closed') : '');
    }

    function disconnect(v) {
      clearTimeout(v.retryTimer);
      v.retryTimer = null;
      v.retryLeft = 0;
      v.userClose = true;
      if (v.rfb) v.rfb.disconnect();
      else if (v.state === 'connecting' && !v.vid) { // waiting between two tries, or still loading
        setState(v, 'idle');
      } else { // still connecting, nothing attached yet
        if (v.vid) ait.vncClose(v.tabId, v.vid);
        release(v);
        setState(v, 'idle');
      }
    }

    /** The server asks for a password (and sometimes a user name). It is sent once and not kept anywhere. */
    function askCredentials(v, types) {
      const need = new Set(types || []);
      let sent = false;
      const m = modal(t('vnc.pw.title'), { onClose: () => { if (!sent && v.rfb) v.rfb.disconnect(); } });
      const grid = el('div', 'sm-grid');
      const fields = {};
      const add = (key, label, type) => { const i = el('input', 'sm-input'); i.type = type; i.autocomplete = 'off'; i.spellcheck = false; fields[key] = i; grid.append(el('label', '', label), i); };
      if (need.has('username')) add('username', t('vnc.pw.user'), 'text');
      if (need.has('password') || !need.size) add('password', t('vnc.pw.pass'), 'password');
      m.body.append(grid, el('div', 'sd', t('vnc.pw.note')));
      const ok = el('button', 'btn primary', t('vnc.pw.ok'));
      const cancel = el('button', 'btn', t('common.cancel'));
      m.foot.append(cancel, ok);
      const submit = () => {
        const creds = {};
        for (const [k, i] of Object.entries(fields)) { creds[k] = i.value; i.value = ''; }
        sent = true;
        if (v.rfb) v.rfb.sendCredentials(creds);
        m.close();
        if (v.rfb && v.shown) v.rfb.focus();
      };
      ok.onclick = submit;
      cancel.onclick = () => m.close();
      m.root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } });
      setTimeout(() => (fields.username || fields.password).focus(), 30);
    }

    // ---- showing, hiding, the button in the terminal's title bar
    const toggle = el('button', 'btn mini');
    toggle.id = 'btn-screen';
    toggle.type = 'button';
    toggle.append(icon('monitor'));
    toggle.title = t('vnc.btn.tip');
    toggle.setAttribute('aria-label', t('vnc.btn.tip'));
    toggle.hidden = true;
    $('btn-search').before(toggle);

    function setShown(v, on) {
      if (v.shown === on) return;
      v.shown = on;
      if (on) { flushAck(v); if (v.rfb && v.state === 'connected') setTimeout(() => v.rfb && v.rfb.focus(), 0); }
    }
    function applyVisibility() {
      const id = SSH.activeId();
      views.forEach((v) => { const show = v.open && v.tabId === id; v.root.hidden = !show; setShown(v, show); });
      renderToggle();
    }
    function renderToggle() {
      const id = SSH.activeId();
      const st = id && SSH.S.tabs.get(id);
      toggle.hidden = !(st && st.ssh);
      const v = views.get(id);
      toggle.classList.toggle('on', !!(v && v.open));
      toggle.dataset.live = v && !v.open && (v.state === 'connected' || v.state === 'connecting') ? '1' : '';
    }
    function hide(v) {
      v.open = false;
      applyVisibility();
      try { C.doFit(); const tab = C.tabs.get(v.tabId); const p = tab && tab.panes.main; p && p.term.focus(); } catch { /* terminal not ready */ }
    }
    function destroy(tabId) {
      const v = views.get(tabId);
      if (!v) return;
      clearTimeout(v.retryTimer);
      if (v.rfb) { try { v.rfb.disconnect(); } catch { /* already gone */ } } else if (v.vid) ait.vncClose(tabId, v.vid);
      release(v);
      v.root.remove();
      views.delete(tabId);
      renderToggle();
    }

    /**
     * Open the remote screen of a tab (default: the active one). `port` connects at once; `auto` (the button) connects at once when
     * this server's port is known; `retries` makes an opening that fails with "no VNC server there yet" try again a few times.
     */
    function open({ tabId, port, auto = false, retries } = {}) {
      const id = tabId || SSH.activeId();
      const st = id && SSH.S.tabs.get(id);
      if (!st || !st.ssh) { toast(t('vnc.err.no-ssh'), 'err'); return null; }
      const v = views.get(id) || createView(id);
      v.open = true;
      if (port) v.port.value = String(port);
      applyVisibility();
      if ((v.state === 'idle' || v.state === 'ended') && (port || (auto && store.get(`ait.vnc.port.${hostKey(v)}`, '')))) connect(v, { retries });
      else if (v.state === 'connected' && v.rfb) v.rfb.focus();
      return v;
    }
    toggle.onclick = () => {
      const v = views.get(SSH.activeId());
      if (v && v.open) hide(v); else open({ auto: true });
    };

    // ---- automatic opening: a server marked "open automatically" shows its screen once the ssh login has worked (the first server
    // reading of the monitor proves the route is usable; without the monitor a short wait stands in for it)
    const fired = new Map(); // tab id -> the ssh session ("since") that already opened a screen by itself
    function maybeAuto(id) {
      const st = SSH.S.tabs.get(id);
      if (!st || !st.ssh || fired.get(id) === st.ssh.since) return;
      const label = st.ssh.target.label;
      if (store.get(`ait.vnc.auto.${label}`, '') !== '1') return;
      fired.set(id, st.ssh.since);
      open({ tabId: id, port: Number(store.get(`ait.vnc.port.${label}`, '5901')) || 5901, retries: AUTO_RETRIES });
    }
    ait.onSshMetrics(({ id, metrics }) => { if (metrics) maybeAuto(id); });

    document.addEventListener('ait-tab-activated', applyVisibility);
    document.addEventListener('ait-tab-closed', (e) => { fired.delete(e.detail && e.detail.id); destroy(e.detail && e.detail.id); });
    ait.onSshState(({ id, active }) => {
      if (!active) { fired.delete(id); destroy(id); return; }
      renderToggle();
      if (C.setting('sshMonitor') === false) setTimeout(() => maybeAuto(id), 4000);
    });

    window.AITVnc = { open, views, loaded: () => !!RFB, connect: (id) => views.get(id || SSH.activeId()) && connect(views.get(id || SSH.activeId())), loadRfb };
    renderToggle();
  };
  if (window.AITCore && window.AITSsh) start();
  else document.addEventListener('ait-ssh-ready', start, { once: true });
})();
