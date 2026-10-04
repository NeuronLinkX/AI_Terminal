'use strict';
// A throw-away OpenSSH server for tests: listens on 127.0.0.1 only, accepts one freshly generated key (no passwords, no
// PAM), runs as the current user and leaves nothing behind. The credentials exist only for the lifetime of the test.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SSHD = '/usr/sbin/sshd';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});
const canConnect = (port) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1');
  c.on('connect', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

/** @returns {Promise<null | {port, dir, user, key, knownHosts, sshArgs, command, stop}>} null when sshd cannot run here */
async function startSshd({ home, ps1 = '[test]\\$ ', identity } = {}) {
  if (!fs.existsSync(SSHD)) return null;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ait-sshd-')));
  try {
    const hostKey = path.join(dir, 'host_key');
    const key = path.join(dir, 'client_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ait-test-host', '-f', hostKey]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ait-test-client', '-f', key]);
    // deterministic remote shell, whatever the user's own rc files do: a plain interactive bash for a login, and the
    // requested command (e.g. the monitor's `sh` with its script on stdin) for everything else
    // identity: { user, host } — `id -un` and `hostname` answer with these names (for screen recordings / documentation), both in the
    // login shell and in the commands the app runs over the connection, so the app's same-account check still matches
    let shims = '';
    if (identity) {
      const sd = path.join(dir, 'shims');
      fs.mkdirSync(sd);
      fs.writeFileSync(path.join(sd, 'id'), `#!/bin/sh\nif [ "$1" = "-un" ]; then echo '${identity.user}'; else exec /usr/bin/id "$@"; fi\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(sd, 'hostname'), `#!/bin/sh\nif [ $# -eq 0 ]; then echo '${identity.host}'; else exec /bin/hostname "$@"; fi\n`, { mode: 0o755 });
      // `ls -l` / `whoami` would print the real account of this Mac as the owner: show the neutral name instead
      const real = os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, '');
      fs.writeFileSync(path.join(sd, 'ls'), `#!/bin/sh\n/bin/ls "$@" | /usr/bin/sed 's/${real}/${identity.user}/g'\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(sd, 'whoami'), `#!/bin/sh\necho '${identity.user}'\n`, { mode: 0o755 });
      shims = `export PATH='${sd}':"$PATH"; `;
    }
    const homeSetup = shims + (home ? `export HOME='${home}'; cd "$HOME" 2>/dev/null; ` : '');
    const forced = `${homeSetup}if [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"; else export BASH_SILENCE_DEPRECATION_WARNING=1 PS1="${ps1}"; exec /bin/bash --noprofile --norc -i; fi`;
    fs.writeFileSync(path.join(dir, 'authorized_keys'), `command="${forced.replace(/"/g, '\\"')}",pty ${fs.readFileSync(`${key}.pub`, 'utf8')}`);
    const port = await freePort();
    const user = os.userInfo().username;
    const cfg = path.join(dir, 'sshd_config');
    fs.writeFileSync(cfg, [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${path.join(dir, 'sshd.pid')}`,
      `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes', 'UsePAM no', 'StrictModes no', 'PermitRootLogin no', `AllowUsers ${user}`, 'LogLevel ERROR', 'PrintMotd no',
    ].join('\n') + '\n');
    const knownHosts = path.join(dir, 'known_hosts');
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${fs.readFileSync(`${hostKey}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`);
    const child = spawn(SSHD, ['-D', '-e', '-f', cfg], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      if (child.exitCode !== null) break;
      up = await canConnect(port);
      if (!up) await sleep(100);
    }
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    process.once('exit', stop); // a killed / crashed test run must not leave a server (or its keys) behind
    if (!up) { stop(); return null; }
    const sshArgs = ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-p', String(port)];
    return { port, dir, user, key, knownHosts, sshArgs, command: `ssh ${sshArgs.join(' ')} ${user}@127.0.0.1`, stop };
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

module.exports = { startSshd };
