'use strict';
// The file panel of the left side bar: the server (over the tab's ssh connection) on top, this Mac below, both as trees.
// Drag a file or folder from one tree to the other to copy it; drop files from Finder onto the server tree to upload; drop
// either onto the terminal to type their paths. Transfers show progress and can be cancelled. Engine: src/main/sftp.js.
(() => {
  const start = () => {
    const C = window.AITCore;
    const X = window.AITSsh;
    if (!C || !X) return;
    const { ait, $, el, icon, withIcon, t, tr } = C;
    const { toast, askText, ctxMenu, shq, fmtSize, store, modal } = X;

    const MAX_ROWS = 2000;
    const dirOf = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/');
    const baseOf = (p) => p.replace(/\/+$/, '').split('/').pop() || p;
    const join = (d, n) => (d === '/' ? `/${n}` : `${d}/${n}`);
    const isDirEntry = (e) => e.type === 'dir' || !!(e.link && e.link.dir);
    const when = (s) => (s ? new Date(s * 1000).toLocaleString() : '');

    // ----------------------------------------------------------------- pane model
    const local = { side: 'local', root: '', nodes: new Map(), expanded: new Set(), selected: new Set(), anchor: null, filter: '', visible: [], err: '' };
    const newRemote = () => ({ side: 'remote', root: '', nodes: new Map(), expanded: new Set(), selected: new Set(), anchor: null, filter: '', visible: [], err: '' });
    const remoteOf = (id) => { const st = X.tabState(id); if (!st.files) st.files = newRemote(); return st.files; };
    const hidden = { remote: store.get('ait.files.hidden.remote', '0') === '1', local: store.get('ait.files.hidden.local', '0') === '1' };
    let drag = null; // what is being dragged inside the window: { side, tab, items: [{path, type, name}] }
    let prefetch = null; // a small server file fetched in advance so it can be dragged out to Finder
    let nativeDrag = null; // a server file handed to the system drag (Finder): { path, tab, at } — if it is dropped back onto this window it is an ordinary download
    const nativeLive = () => !!nativeDrag && Date.now() - nativeDrag.at < 120000;

    const tabId = () => X.activeId();
    const sshOf = (id) => X.tabState(id).ssh;

    async function listDir(P, dir) {
      const id = tabId();
      const r = P.side === 'remote' ? await ait.sftpList(id, dir) : await ait.localList(dir);
      if (r.error) { P.nodes.set(dir, { entries: [], error: r.error }); return r; }
      P.nodes.set(r.path, { entries: r.entries, truncated: r.truncated, error: '' });
      return r;
    }
    async function openRoot(P, dir) {
      P.err = '';
      const r = await listDir(P, dir);
      if (r.error) { P.err = r.error; return render(); }
      P.root = r.path;
      P.expanded.clear();
      P.selected.clear();
      P.anchor = null;
      render();
    }
    async function ensure(P) {
      if (P.root || P.loading) return;
      P.loading = true;
      try {
        if (P.side === 'remote') {
          const h = await ait.sftpHome(tabId());
          if (h.error) { P.err = h.error; return; }
          await openRoot(P, h.path);
        } else await openRoot(P, (C.getTab() && C.getTab().state.cwd) || ''); // this Mac: where the terminal is (the home button goes to ~)
      } finally { P.loading = false; }
    }
    async function refresh(P) {
      const dirs = [P.root, ...[...P.expanded]].filter(Boolean);
      for (const d of dirs) await listDir(P, d);
      if (P.nodes.get(P.root) && P.nodes.get(P.root).error) P.err = P.nodes.get(P.root).error; else P.err = '';
      render();
    }
    async function refreshDir(P, dir) {
      if (!P.root || !(dir === P.root || P.expanded.has(dir))) return;
      await listDir(P, dir);
      render();
    }
    async function toggle(P, dir) {
      if (P.expanded.has(dir)) P.expanded.delete(dir);
      else { P.expanded.add(dir); if (!P.nodes.has(dir)) await listDir(P, dir); }
      render();
    }

    // ----------------------------------------------------------------- operations
    async function newFolder(P, parent) {
      const name = await askText(t('files.newFolder'), '', t('common.ok'));
      if (!name || !name.trim() || /[/\0]/.test(name)) return;
      const p = join(parent, name.trim());
      const r = P.side === 'remote' ? await ait.sftpMkdir(tabId(), p) : await ait.localMkdir(p);
      if (r.error) toast(r.error, 'err'); else { await refreshDir(P, parent); P.expanded.add(parent); }
    }
    async function rename(P, path) {
      const name = await askText(t('files.rename'), baseOf(path), t('common.ok'));
      if (!name || !name.trim() || name === baseOf(path) || /[/\0]/.test(name)) return;
      const to = join(dirOf(path), name.trim());
      const r = P.side === 'remote' ? await ait.sftpRename(tabId(), path, to) : await ait.localRename(path, to);
      if (r.error) toast(r.error, 'err'); else refreshDir(P, dirOf(path));
    }
    async function remove(P, paths) {
      if (!paths.length) return;
      const names = paths.slice(0, 4).map(baseOf).join(', ') + (paths.length > 4 ? ` +${paths.length - 4}` : '');
      if (!confirm(P.side === 'remote' ? t('files.delConfirm.remote', { names, host: sshOf(tabId()).target.label }) : t('files.delConfirm.local', { names }))) return;
      for (const p of paths) {
        const r = P.side === 'remote' ? await ait.sftpRemove(tabId(), p) : await ait.localTrash(p);
        if (r.error) { toast(`${baseOf(p)}: ${r.error}`, 'err'); break; }
      }
      P.selected.clear();
      await refreshDir(P, dirOf(paths[0]));
    }
    async function chmod(P, path) {
      const mode = await askText(t('files.chmod'), '644', t('common.ok'), t('files.chmod.hint'));
      if (!mode) return;
      const r = await ait.sftpChmod(tabId(), path, mode.trim());
      if (r.error) toast(r.error, 'err'); else refreshDir(P, dirOf(path));
    }
    async function preview(path) {
      const r = await ait.sftpPreview(tabId(), path);
      if (r.error) return toast(r.error, 'err');
      const m = modal(baseOf(path), { wide: true });
      const pre = el('pre', 'preview', r.text);
      m.body.append(pre);
      const ask = withIcon('button', 'sparkle', ' ' + t('files.askAi.btn'), 'btn');
      ask.onclick = () => { m.close(); askAi(path); };
      const close = el('button', 'btn', t('common.close'));
      close.onclick = m.close;
      m.foot.append(ask, close);
    }
    async function askAi(path) {
      const tab = C.getTab();
      if (!tab) return;
      if (!tab.remote) { const r = await C.setRemote(true); if (!r || !r.ok) return; }
      C.submitAi(tab, t('files.askAi.prompt', { path }));
    }
    function inTerminal(path, isDir) {
      const tab = C.getTab();
      if (!tab) return;
      ait.ptyInput(tab.id, isDir ? `\x15cd -- ${shq(path)}\r` : ` ${shq(path)} `);
      toast(t('files.typed'));
    }

    // ----------------------------------------------------------------- transfers (UI side)
    const batchChoice = { all: null };
    async function conflictDialog(name, kind, rest) {
      if (batchChoice.all) return batchChoice.all;
      return new Promise((resolve) => {
        const m = modal(t('files.conflict.title'), { onClose: () => resolve('cancel') });
        m.body.append(el('div', '', t('files.conflict.msg', { name, kind: kind === 'dir' ? t('files.folder') : t('files.file') })));
        const all = el('input');
        all.type = 'checkbox';
        const lbl = el('label', 'chk');
        lbl.append(all, el('span', '', t('files.conflict.all')));
        if (rest > 0) m.body.append(lbl);
        const pick = (mode, danger) => { const b = el('button', 'btn' + (danger ? ' danger' : ''), t(`files.conflict.${mode}`)); b.onclick = () => { if (all.checked && mode !== 'cancel') batchChoice.all = mode; resolve(mode); m.root.remove(); }; return b; };
        m.foot.append(pick('cancel'), pick('skip'), pick('rename'), pick('overwrite', true));
      });
    }
    /** items: [{path, name}] copied INTO `destDir` on the other side */
    async function transfer(toSide, items, destDir) {
      const id = tabId();
      batchChoice.all = null;
      let started = 0;
      for (let i = 0; i < items.length; i++) {
        let mode = 'fail';
        for (;;) {
          const r = toSide === 'remote' ? await ait.sftpUpload(id, items[i], destDir, mode) : await ait.sftpDownload(id, items[i], destDir, mode);
          if (r.error) { toast(`${baseOf(items[i])}: ${r.error}`, 'err'); break; }
          if (r.skipped) break;
          if (r.conflict) {
            const choice = await conflictDialog(r.conflict.name, r.conflict.kind, items.length - i - 1);
            if (choice === 'cancel') return;
            mode = choice;
            continue;
          }
          started++;
          break;
        }
      }
      if (started) { renderXfers(); X.openPanel && S().panel !== 'files' && X.openPanel('files'); }
    }
    const S = () => X.S;

    function renderXfers() {
      const box = $('fx-list');
      if (!box) return;
      const st = X.tabState(tabId());
      const list = [...st.transfers.values()];
      box.replaceChildren();
      const active = list.filter((x) => x.state === 'running' || x.state === 'queued' || x.state === 'cancelling').length;
      const badge = $('act-files-n');
      badge.hidden = !active;
      badge.textContent = String(active);
      $('fx').hidden = !list.length;
      list.slice(-30).reverse().forEach((x) => {
        const r = el('div', `fx-row ${x.state}`);
        const pct = x.total ? Math.min(100, Math.round((x.bytes / x.total) * 100)) : x.state === 'done' ? 100 : 0;
        const top = el('div', 'fx-top');
        top.append(icon(x.dir === 'up' ? 'upload' : 'download'), el('span', 'fx-name', x.name));
        const info = x.state === 'done' ? t(x.verified ? 'files.xfer.doneVerified' : 'files.xfer.done') : x.state === 'error' ? x.error : x.state === 'cancelled' ? t('files.xfer.cancelled') : x.state === 'queued' ? t('files.xfer.queued') : `${pct}% · ${fmtSize(x.speed)}/s`;
        top.append(el('span', 'fx-info', info));
        if (x.state === 'running' || x.state === 'queued') { const c = el('button', 'btn icon sact'); c.append(icon('x')); c.title = t('files.xfer.cancel'); c.onclick = () => ait.sftpCancel(tabId(), x.id); top.append(c); }
        r.append(top);
        if (x.state === 'running' || x.state === 'queued') { const bar = el('div', 'mbar'); const f = el('i'); f.style.width = `${pct}%`; bar.append(f); r.append(bar); }
        if (x.state === 'error') r.title = x.error;
        box.append(r);
      });
    }
    ait.onTransfer(({ id, t: x }) => {
      const st = X.tabState(id);
      const prev = st.transfers.get(x.id);
      st.transfers.set(x.id, x);
      if (id === tabId()) renderXfers();
      if (x.state === 'done' && (!prev || prev.state !== 'done')) {
        const remoteSide = remoteOf(id);
        if (x.dir === 'up') refreshDir(remoteSide, dirOf(x.remote)); else refreshDir(local, dirOf(x.local));
        toast(t('files.xfer.finished', { name: x.name }));
      } else if (x.state === 'error' && (!prev || prev.state !== 'error')) toast(`${x.name}: ${x.error}`, 'err');
    });

    // ----------------------------------------------------------------- rendering
    const els = { remote: null, local: null };
    function buildShell() {
      const box = $('sp-files');
      box.replaceChildren();
      const head = el('div', 'sp-head');
      head.append(el('span', 'sp-title', t('files.title')));
      box.append(head);
      for (const side of ['remote', 'local']) {
        const wrap = el('div', 'fpane');
        wrap.dataset.side = side;
        const bar = el('div', 'ftool');
        const mk = (ic, label, fn) => { const b = el('button', 'btn icon sact'); b.append(icon(ic)); b.title = label; b.setAttribute('aria-label', label); b.onclick = fn; return b; };
        const P = () => (side === 'remote' ? remoteOf(tabId()) : local);
        const title = el('span', 'fside', side === 'remote' ? t('files.remote') : t('files.local'));
        const up = mk('up', t('files.up'), () => { const p = P(); if (p.root && p.root !== '/') openRoot(p, dirOf(p.root)); });
        const homeB = mk('home', t('files.home'), () => { const p = P(); p.root = ''; ensure(p); });
        const refB = mk('refresh', t('files.refresh'), () => refresh(P()));
        const nf = mk('plus', t('files.newFolder'), () => { const p = P(); if (p.root) newFolder(p, p.root); });
        const eye = mk(hidden[side] ? 'eye' : 'eyeoff', t('files.hidden'), () => { hidden[side] = !hidden[side]; store.set(`ait.files.hidden.${side}`, hidden[side] ? '1' : '0'); render(); });
        bar.append(title, el('span', 'grow'), up, homeB, refB, nf, eye);
        if (side === 'remote') {
          const upl = mk('upload', t('files.upload'), async () => {
            const inp = el('input'); inp.type = 'file'; inp.multiple = true;
            inp.onchange = () => { const p = remoteOf(tabId()); const paths = [...inp.files].map((f) => ait.pathForFile(f)).filter(Boolean); if (paths.length && p.root) transfer('remote', paths, p.root); };
            inp.click();
          });
          bar.append(upl);
        }
        const path = el('input', 'sm-input fpath');
        path.type = 'text';
        path.spellcheck = false;
        path.setAttribute('aria-label', side === 'remote' ? t('files.remote') : t('files.local'));
        path.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { const v = path.value.trim(); if (v) openRoot(P(), v.replace(/^~(?=\/|$)/, side === 'local' ? (local.root || '') : '~')); } });
        const filter = el('input', 'sm-input ffilter');
        filter.type = 'search';
        filter.placeholder = t('files.filter');
        filter.oninput = () => { P().filter = filter.value.toLowerCase(); render(); };
        const tree = el('div', 'ftree');
        tree.tabIndex = 0;
        tree.setAttribute('role', 'tree');
        wrap.append(bar, path, filter, tree);
        box.append(wrap);
        els[side] = { wrap, tree, path, title, filter };
        wirePane(side, tree, P);
      }
      const fx = el('div', 'fx');
      fx.id = 'fx';
      fx.hidden = true;
      const fxh = el('div', 'fx-head');
      fxh.append(el('span', '', t('files.xfer.title')));
      const clr = el('button', 'btn mini', t('files.xfer.clear'));
      clr.onclick = async () => { await ait.sftpClear(tabId()); const st = X.tabState(tabId()); for (const [k, v] of st.transfers) if (['done', 'error', 'cancelled'].includes(v.state)) st.transfers.delete(k); renderXfers(); };
      fxh.append(clr);
      const lst = el('div', 'fx-list');
      lst.id = 'fx-list';
      fx.append(fxh, lst);
      box.append(fx);
    }

    function rowFor(P, e, dir, depth) {
      const path = join(dir, e.name);
      const isDir = isDirEntry(e);
      const r = el('div', 'frow' + (P.selected.has(path) ? ' sel' : ''));
      r.style.paddingLeft = `${6 + depth * 14}px`;
      r.dataset.path = path;
      r.dataset.dir = isDir ? '1' : '0';
      r.draggable = true;
      r.setAttribute('role', 'treeitem');
      r.setAttribute('aria-selected', String(P.selected.has(path)));
      const caret = el('span', 'fcaret' + (isDir ? (P.expanded.has(path) ? ' open' : '') : ' none'));
      if (isDir) caret.append(icon('chevr'));
      const ic = icon(isDir ? 'folder' : e.link ? 'symlink' : 'file');
      ic.classList.add('fic');
      const nm = el('span', 'fnm', e.name);
      r.append(caret, ic, nm);
      if (e.link && !isDir) nm.title = `→ ${e.link.target || ''}`;
      if (e.link) nm.append(el('span', 'flink', ` → ${e.link.target || ''}`.slice(0, 40)));
      if (!isDir) r.append(el('span', 'fsz', fmtSize(e.size)));
      r.title = `${e.name}\n${e.perm || ''}${e.owner ? ' ' + e.owner : ''}\n${when(e.mtime)}`;
      caret.onclick = (ev) => { ev.stopPropagation(); if (isDir) toggle(P, path); };
      return r;
    }
    function render() {
      for (const side of ['remote', 'local']) {
        const E = els[side];
        if (!E) continue;
        const id = tabId();
        const P = side === 'remote' ? remoteOf(id) : local;
        const tree = E.tree;
        tree.replaceChildren();
        P.visible = [];
        if (side === 'remote' && !sshOf(id)) {
          E.path.value = '';
          E.path.disabled = true;
          const e = el('div', 'dr-empty');
          e.append(el('div', '', t('files.nossh')));
          const b = withIcon('button', 'server', ' ' + t('files.opensessions'), 'btn mini');
          b.style.marginTop = '8px';
          b.onclick = () => X.openPanel('sessions');
          e.append(b);
          tree.append(e);
          continue;
        }
        E.path.disabled = false;
        E.path.value = P.root || '';
        if (P.err) {
          const e = el('div', 'dr-empty err', P.err);
          const b = withIcon('button', 'refresh', ' ' + t('files.retry'), 'btn mini');
          b.style.margin = '8px auto 0';
          b.style.display = 'flex';
          b.onclick = () => { P.err = ''; P.root = ''; ensure(P).then(() => render()); };
          e.append(b);
          tree.append(e);
          continue;
        }
        if (!P.root) { tree.append(el('div', 'dr-empty', t('files.loading'))); continue; }
        let count = 0;
        const walk = (dir, depth) => {
          const node = P.nodes.get(dir);
          if (!node) return;
          if (node.error) { tree.append(el('div', 'frow err', node.error)); return; }
          for (const ent of node.entries) {
            if (!hidden[side] && ent.name.startsWith('.')) continue;
            if (P.filter && !ent.name.toLowerCase().includes(P.filter)) continue;
            if (count >= MAX_ROWS) return;
            const r = rowFor(P, ent, dir, depth);
            tree.append(r);
            P.visible.push({ path: join(dir, ent.name), dir: isDirEntry(ent), name: ent.name });
            count++;
            if (isDirEntry(ent) && P.expanded.has(join(dir, ent.name))) walk(join(dir, ent.name), depth + 1);
          }
          if (node.truncated && depth === 0) tree.append(el('div', 'dr-empty', t('files.truncated')));
        };
        walk(P.root, 0);
        if (!P.visible.length) tree.append(el('div', 'dr-empty', P.filter ? t('files.nomatch') : t('files.empty')));
        if (count >= MAX_ROWS) tree.append(el('div', 'dr-empty', t('files.more')));
      }
      renderXfers();
    }

    // ----------------------------------------------------------------- interaction + drag & drop
    function selectedItems(P, row) {
      const path = row.dataset.path;
      if (!P.selected.has(path)) { P.selected = new Set([path]); P.anchor = path; }
      return P.visible.filter((v) => P.selected.has(v.path));
    }
    function wirePane(side, tree, getP) {
      tree.addEventListener('click', (e) => {
        const row = e.target.closest('.frow');
        const P = getP();
        if (!row || !row.dataset.path) { if (!e.target.closest('.dr-empty')) { P.selected.clear(); render(); } return; }
        const path = row.dataset.path;
        if (e.shiftKey && P.anchor) {
          const a = P.visible.findIndex((v) => v.path === P.anchor);
          const b = P.visible.findIndex((v) => v.path === path);
          P.selected = new Set(P.visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((v) => v.path));
        } else if (e.metaKey || e.ctrlKey) {
          if (P.selected.has(path)) P.selected.delete(path); else P.selected.add(path);
          P.anchor = path;
        } else { P.selected = new Set([path]); P.anchor = path; }
        render();
      });
      tree.addEventListener('dblclick', (e) => {
        const row = e.target.closest('.frow');
        if (!row || !row.dataset.path) return;
        const P = getP();
        if (row.dataset.dir === '1') openRoot(P, row.dataset.path);
        else if (side === 'remote') preview(row.dataset.path);
        else ait.localReveal(row.dataset.path);
      });
      tree.addEventListener('keydown', (e) => {
        const P = getP();
        const sel = [...P.selected];
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) { e.preventDefault(); remove(P, sel); }
        else if (e.key === 'F2' && sel.length === 1) { e.preventDefault(); rename(P, sel[0]); }
        else if (e.key === 'Enter' && sel.length === 1) { const v = P.visible.find((x) => x.path === sel[0]); if (v && v.dir) openRoot(P, v.path); else if (v && side === 'remote') preview(v.path); }
        else if (e.key === 'Escape') { P.selected.clear(); render(); }
      });
      tree.addEventListener('contextmenu', (e) => {
        const P = getP();
        const row = e.target.closest('.frow');
        const rootDir = P.root;
        if (!rootDir) return;
        if (!row || !row.dataset.path) {
          return ctxMenu(e, [{ label: t('files.newFolder'), icon: 'plus', onClick: () => newFolder(P, rootDir) }, { label: t('files.refresh'), icon: 'refresh', onClick: () => refresh(P) }]);
        }
        const path = row.dataset.path;
        if (!P.selected.has(path)) { P.selected = new Set([path]); P.anchor = path; render(); }
        const items = P.visible.filter((v) => P.selected.has(v.path));
        const isDir = row.dataset.dir === '1';
        const one = items.length === 1;
        const other = side === 'remote' ? local : remoteOf(tabId());
        const dest = other.root;
        const menu = [];
        if (side === 'remote') {
          menu.push({ label: t('files.download'), icon: 'download', disabled: !dest, onClick: () => transfer('local', items.map((v) => v.path), dest) });
          if (one && !isDir) menu.push({ label: t('files.preview'), icon: 'file', onClick: () => preview(path) });
          if (one) menu.push({ label: isDir ? t('files.openTerm') : t('files.pathTerm'), icon: 'terminal', onClick: () => inTerminal(path, isDir) });
          if (one) menu.push({ label: t('files.askAi.btn'), icon: 'sparkle', onClick: () => askAi(path) });
          menu.push('sep');
          if (one) menu.push({ label: t('files.rename'), icon: 'pencil', onClick: () => rename(P, path) });
          if (one) menu.push({ label: t('files.chmod'), icon: 'key', onClick: () => chmod(P, path) });
          menu.push({ label: t('files.delete'), icon: 'trash', danger: true, onClick: () => remove(P, items.map((v) => v.path)) });
        } else {
          menu.push({ label: t('files.uploadTo'), icon: 'upload', disabled: !dest, onClick: () => transfer('remote', items.map((v) => v.path), dest) });
          menu.push({ label: t('files.reveal'), icon: 'folder', onClick: () => ait.localReveal(path) });
          if (one) menu.push({ label: t('files.pathTerm'), icon: 'terminal', onClick: () => inTerminal(path, false) });
          menu.push('sep');
          if (one) menu.push({ label: t('files.rename'), icon: 'pencil', onClick: () => rename(P, path) });
          menu.push({ label: t('files.trash'), icon: 'trash', danger: true, onClick: () => remove(P, items.map((v) => v.path)) });
        }
        menu.push('sep', { label: t('files.copyPath'), icon: 'copy', onClick: () => ait.copy(items.map((v) => v.path).join('\n')) });
        if (isDir) menu.push({ label: t('files.newFolder'), icon: 'plus', onClick: () => newFolder(P, path) });
        ctxMenu(e, menu);
      });

      // --- drag source
      tree.addEventListener('mousedown', (e) => {
        const row = e.target.closest('.frow');
        if (side !== 'remote' || !row || row.dataset.dir === '1' || e.metaKey || e.shiftKey || e.ctrlKey || e.button !== 0) return;
        const path = row.dataset.path;
        if (prefetch && prefetch.path === path) return;
        prefetch = { path, result: null };
        const mine = prefetch;
        ait.sftpDragPrepare(tabId(), path).then((r) => { mine.result = r; });
      });
      tree.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.frow');
        const P = getP();
        if (!row) return;
        const items = selectedItems(P, row);
        // a small single server file that is already here: hand it to Finder as a real file
        if (side === 'remote' && items.length === 1 && prefetch && prefetch.path === items[0].path && prefetch.result && prefetch.result.path) {
          e.preventDefault();
          nativeDrag = { path: items[0].path, tab: tabId(), at: Date.now() };
          ait.dragStart(prefetch.result.path);
          return;
        }
        drag = { side, tab: tabId(), items };
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('application/x-ait-items', JSON.stringify({ side, items: items.map((v) => v.path) }));
        e.dataTransfer.setData('text/plain', items.map((v) => v.path).join('\n'));
        // mark the selection in place: replacing the dragged row during dragstart would cancel the drag in Chromium
        tree.querySelectorAll('.frow').forEach((r) => { const on = P.selected.has(r.dataset.path); r.classList.toggle('sel', on); r.setAttribute('aria-selected', String(on)); });
      });
      tree.addEventListener('dragend', () => { drag = null; tree.parentElement.parentElement.querySelectorAll('.drop-ok').forEach((n) => n.classList.remove('drop-ok')); });

      // --- drop target
      const targetDir = (e) => {
        const P = getP();
        const row = e.target.closest('.frow');
        if (row && row.dataset.path) return { el: row, dir: row.dataset.dir === '1' ? row.dataset.path : dirOf(row.dataset.path) };
        return { el: tree, dir: P.root };
      };
      const accepts = (e) => {
        const types = [...e.dataTransfer.types];
        if (side === 'remote' && !sshOf(tabId())) return false;
        if (drag) return drag.side !== side && drag.tab === tabId();
        if (nativeLive() && types.includes('Files')) return side === 'local' && nativeDrag.tab === tabId(); // our own file coming back: only a download
        return side === 'remote' && types.includes('Files'); // from Finder: only onto the server
      };
      tree.addEventListener('dragover', (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        tree.parentElement.parentElement.querySelectorAll('.drop-ok').forEach((n) => n.classList.remove('drop-ok'));
        targetDir(e).el.classList.add('drop-ok');
      });
      tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) tree.parentElement.parentElement.querySelectorAll('.drop-ok').forEach((n) => n.classList.remove('drop-ok')); });
      tree.addEventListener('drop', async (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        const tgt = targetDir(e);
        tree.parentElement.parentElement.querySelectorAll('.drop-ok').forEach((n) => n.classList.remove('drop-ok'));
        if (!tgt.dir) return;
        if (drag) {
          const items = drag.items.map((v) => v.path);
          drag = null;
          await transfer(side, items, tgt.dir);
        } else if (nativeLive()) {
          const p = nativeDrag.path;
          nativeDrag = null;
          await transfer('local', [p], tgt.dir);
        } else {
          const paths = [...e.dataTransfer.files].map((f) => ait.pathForFile(f)).filter(Boolean);
          if (paths.length) await transfer('remote', paths, tgt.dir);
        }
      });
    }

    // drop onto the terminal: type the paths (like Terminal.app does for Finder files)
    const term = $('terminal');
    const typeable = (e) => !!drag || [...e.dataTransfer.types].includes('Files');
    term.addEventListener('dragover', (e) => { if (typeable(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    term.addEventListener('drop', (e) => {
      if (!typeable(e)) return;
      e.preventDefault();
      const tab = C.getTab();
      if (!tab) return;
      const paths = drag ? drag.items.map((v) => v.path) : nativeLive() ? [nativeDrag.path] : [...e.dataTransfer.files].map((f) => ait.pathForFile(f)).filter(Boolean);
      drag = null;
      nativeDrag = null;
      if (paths.length) ait.ptyInput(tab.id, ` ${paths.map(shq).join(' ')} `);
    });

    // ----------------------------------------------------------------- panel entry
    let built = false;
    async function renderFiles() {
      if (!built) { buildShell(); built = true; }
      const id = tabId();
      if (!id) return;
      render();
      await ensure(local);
      if (sshOf(id)) await ensure(remoteOf(id));
      render();
    }
    X.renderFiles = renderFiles;
    document.addEventListener('ait-tab-activated', () => { if (built && X.S.panel === 'files') renderFiles(); });
    X.layout();
  };
  const go = () => { if (window.AITSsh) start(); else document.addEventListener('ait-ssh-ready', start, { once: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(go, 0)); else setTimeout(go, 0);
})();
