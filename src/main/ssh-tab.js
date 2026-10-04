'use strict';
// Everything SSH that belongs to one tab: recognising the session, the server's resource monitor, switching the AI over to
// the server (automatically or on request) and cleaning up when the connection ends. main.js only creates / attaches /
// detaches it; the renderer learns about it through four events:
//   ssh:state    { id, active, target, since }                 an ssh session started / ended in the tab
//   ssh:metrics  { id, metrics } | { id, unavailable }          CPU / memory / GPU / disk of the server (see remotemon.js)
//   ssh:problem  { id, kind, level, hint, detail, fingerprint } host key changed, refused, dropped …
//   ssh:offer    { id, target, reason? }                        "work on this server with the AI?" (setting sshAutoRemote = ask)
const { SshWatcher, validTarget } = require('./ssh');
const { RemoteMonitor } = require('./remotemon');
const { SshLink } = require('./sshlink');
const { RemoteBrowser } = require('./sftp');

/** What the UI may know about a connection: never key paths or config file locations. */
function publicTarget(t) {
  if (!t) return null;
  return { label: t.label, id: t.id || t.label, user: t.user || '', host: t.hostName || t.host, alias: t.alias || '', port: t.port || 22, jump: t.jump || '', identity: t.identity || [] };
}

/** The destination to remember for "recent": an alias, or user@host[:port] — only when it is safe to put back on a command line. */
function recentOf(t) {
  if (!t) return '';
  const s = t.alias || `${t.user ? t.user + '@' : ''}${t.hostName || t.host}${t.port && t.port !== 22 ? ':' + t.port : ''}`;
  return validTarget(s) ? s : '';
}

class SshTab {
  /** @param {{id: string, agent: object, settings: object, hostBook: object, send: Function, visible: Function, descendants: Function, pollMs?: number}} o */
  constructor({ id, agent, settings, hostBook, send, visible = () => true, descendants, pollMs = 1500, linkOpts }) {
    this.linkOpts = linkOpts;
    this.id = id;
    this.agent = agent;
    this.settings = settings;
    this.hostBook = hostBook;
    this.send = send;
    this.visible = visible;
    this.descendants = descendants;
    this.pollMs = pollMs;
    this.watcher = null;
    this.monitor = null;
    this.link = null; // one non-interactive route to the server, shared by the monitor and the file panel
    this._browser = null;
    this.target = null;
    this.since = 0;
    this.auto = null;
    this.agent.linkProvider = () => (this.target ? this.link : null); // the AI's file tools may use this quiet route (see agent-remote.js)
  }

  attach(session) {
    this.detach();
    const w = (this.watcher = new SshWatcher(session, { descendants: this.descendants, intervalMs: this.pollMs, hosts: () => this.hostBook.configured() }));
    const m = (this.monitor = new RemoteMonitor({ isActive: this.visible }));
    w.on('change', (c) => (c.active ? this._started(c) : this._ended()));
    w.on('problem', (p) => this.send('ssh:problem', { id: this.id, ...p, target: publicTarget(p.target || this.target) }));
    m.on('metrics', (metrics) => this.send('ssh:metrics', { id: this.id, metrics }));
    m.on('unavailable', (u) => this.send('ssh:metrics', { id: this.id, unavailable: u }));
    w.start();
  }

  detach() {
    clearTimeout(this.auto);
    this.auto = null;
    if (this.watcher) this.watcher.stop();
    this._closeBrowser();
    if (this.monitor) this.monitor.stop();
    if (this.link) this.link.close();
    this.watcher = null;
    this.monitor = null;
    this.link = null;
    this.target = null;
  }

  _closeBrowser() {
    if (this._browser) { this._browser.close(); this._browser = null; }
  }

  /** The server's file engine for this tab (created on first use; only while an ssh session is active). */
  browser() {
    if (!this.target || !this.link) return null;
    if (!this._browser) {
      this._browser = new RemoteBrowser(this.link);
      this._browser.on('transfer', (t) => this.send('sftp:transfer', { id: this.id, t }));
    }
    return this._browser;
  }

  /** State for a freshly loaded UI (tab switch, reload). */
  info() {
    return { active: !!this.target, target: publicTarget(this.target), since: this.since, metrics: this.monitor && this.monitor.last ? this.monitor.last : null, remote: this.agent.publicRemoteInfo ? this.agent.publicRemoteInfo() : null };
  }

  _started(c) {
    this.target = c.target;
    this.since = c.since;
    const rec = recentOf(c.target);
    if (rec) this.hostBook.remember(rec);
    if (this.link) this.link.close();
    this.link = new SshLink(c.target, this.linkOpts || {});
    this.send('ssh:state', { id: this.id, active: true, target: publicTarget(c.target), since: c.since });
    if (this.settings.get('sshMonitor')) {
      this.monitor.intervalMs = this.settings.get('sshMonitorSec') * 1000;
      this.monitor.start(c.target, this.link);
    }
    const mode = this.settings.get('sshAutoRemote');
    if (mode === 'auto') this._autoRemote(0);
    else if (mode === 'ask') this.send('ssh:offer', { id: this.id, target: publicTarget(c.target) });
  }

  _ended() {
    clearTimeout(this.auto);
    this.target = null;
    this._closeBrowser();
    this.monitor.stop();
    if (this.link) { this.link.close(); this.link = null; }
    this.send('ssh:state', { id: this.id, active: false });
    this.send('ssh:metrics', { id: this.id, metrics: null });
    if (this.agent.remote) this.agent._remoteLost('SSH 연결이 끝났습니다');
  }

  /** Switch the AI to the server once the login has settled (banners, MOTD, key prompts take a moment). */
  _autoRemote(attempt) {
    clearTimeout(this.auto);
    this.auto = setTimeout(async () => {
      if (!this.target || this.agent.remote || this.agent.busy) return;
      const r = await this.agent.setRemote(true, { target: this.target });
      if (r.ok) return;
      const transient = /응답하지|입력을 기다|확인하지 못했/.test(r.reason || '');
      if (transient && attempt < 8) return this._autoRemote(attempt + 1);
      this.send('ssh:offer', { id: this.id, target: publicTarget(this.target), reason: r.reason });
    }, attempt === 0 ? 1800 : 2500);
  }

  /** The renderer's switch (button): probe the far side and enter / leave remote mode. */
  async setRemote(on) {
    return this.agent.setRemote(on, { target: this.target });
  }
}

module.exports = { SshTab, publicTarget, recentOf };
