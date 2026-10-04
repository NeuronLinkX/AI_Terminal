'use strict';
// "Always allow" rules that the user chose to remember for a PROJECT. They live in the app data folder, keyed by the
// project root (git root, else the folder) — never inside the repository, so a cloned repo cannot grant itself permissions.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class ProjectRules {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'project-rules.json');
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { /* first run */ }
    this.rootCache = new Map();
  }

  /** Project root for a cwd: the git top-level if any, otherwise the folder itself. */
  rootOf(cwd) {
    if (this.rootCache.has(cwd)) return this.rootCache.get(cwd);
    let root = cwd;
    try {
      root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
    } catch { /* not a git repo */ }
    this.rootCache.set(cwd, root);
    return root;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch { /* ignore */ }
  }

  list(cwd) {
    return this.data[this.rootOf(cwd)] || [];
  }
  add(cwd, key, label) {
    const root = this.rootOf(cwd);
    const rules = (this.data[root] = this.data[root] || []);
    if (!rules.find((r) => r.key === key)) rules.push({ key, label, addedAt: new Date().toISOString() });
    this._save();
  }
  remove(cwd, key) {
    const root = this.rootOf(cwd);
    this.data[root] = (this.data[root] || []).filter((r) => r.key !== key);
    if (!this.data[root].length) delete this.data[root];
    this._save();
  }
}

module.exports = { ProjectRules };
