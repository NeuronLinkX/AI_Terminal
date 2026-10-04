'use strict';
// Tiny encrypted secret store (API keys). Values are encrypted with Electron's safeStorage, i.e. a key held in the
// macOS Keychain; nothing is ever written in plain text. If encryption is unavailable the secret is NOT stored.
const fs = require('fs');
const path = require('path');

class Secrets {
  constructor(dataDir, safeStorage) {
    this.file = path.join(dataDir, 'secrets.json');
    this.safe = safeStorage;
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { /* first run */ }
  }
  get available() {
    return !!this.safe && this.safe.isEncryptionAvailable();
  }
  has(name) {
    return !!this.data[name];
  }
  get(name) {
    if (!this.has(name) || !this.available) return '';
    try { return this.safe.decryptString(Buffer.from(this.data[name], 'base64')); } catch { return ''; }
  }
  set(name, value) {
    if (!this.available) return { ok: false, reason: 'macOS 키체인 암호화를 사용할 수 없어 저장하지 않았습니다.' };
    if (!value) {
      delete this.data[name];
    } else {
      this.data[name] = this.safe.encryptString(String(value)).toString('base64');
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    } catch (e) {
      return { ok: false, reason: `저장 실패: ${e.code || e.message}` };
    }
    return { ok: true };
  }
}

module.exports = { Secrets };
