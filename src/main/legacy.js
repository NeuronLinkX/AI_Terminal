'use strict';
// The app used to be called "AI Terminal". The first time MacAIterm starts with the default profile, the old data folder is COPIED
// (never moved, never overwritten) to the new name: settings, tabs, history, audit, usage, project rules, saved SSH sessions.
// Saved API keys (secrets.json) are not copied — they are encrypted with a Keychain item that is named after the app, so they have
// to be entered again (an OPENAI_API_KEY environment variable keeps working). A profile given with --user-data-dir is never touched.
const fs = require('fs');
const path = require('path');

const OLD_NAME = 'AI Terminal';
const NEW_NAME = 'MacAIterm';
const KEEP = ['settings.json', 'llm-settings.json', 'tabs.json', 'theme', 'project-rules.json', 'ssh-sessions.json', 'ssh-recent.json', 'history', 'audit', 'usage', 'backups'];

/** @returns {string[]} the names that were copied (empty when nothing had to be done) */
function migrateLegacyData(dir, appData) {
  const copied = [];
  try {
    if (path.resolve(dir) !== path.join(appData, NEW_NAME)) return copied;
    const old = path.join(appData, OLD_NAME);
    if (!fs.existsSync(old) || fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'tabs.json'))) return copied;
    fs.mkdirSync(dir, { recursive: true });
    for (const name of KEEP) {
      const from = path.join(old, name);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(dir, name), { recursive: true, force: false, errorOnExist: false });
      copied.push(name);
    }
  } catch { /* the app simply starts with fresh data */ }
  return copied;
}

module.exports = { migrateLegacyData, OLD_NAME, NEW_NAME, KEEP };
