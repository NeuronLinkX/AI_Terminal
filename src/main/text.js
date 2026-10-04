'use strict';
// Text utilities: ANSI cleanup, truncation, secret masking, secret-path detection.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78cDEHMNOZ]|\x1b[PX^_][^\x1b]*\x1b\\/g;

function stripAnsi(s) {
  return s.replace(ANSI, '');
}

/** Turn raw PTY output into plain text (no escapes, carriage-return rewrites collapsed). */
function cleanTerminalText(raw) {
  let s = stripAnsi(raw).replace(/\r\n/g, '\n');
  s = s
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter((p, i) => p.length || i === 0);
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n');
  while (/[^\x08]\x08/.test(s)) s = s.replace(/[^\x08]\x08/g, '');
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max}자 생략]…\n${s.slice(s.length - tail)}`;
}

const SECRET_KEY = '(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|auth(?:orization)?|credential|private[_-]?key|access[_-]?key|session[_-]?key|client[_-]?secret)';
const MASK = '‹가려짐›';

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----PRIVATE KEY ${MASK}-----`],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${MASK}`],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${MASK}@`],
  // "key": "value" (JSON)
  [new RegExp(`("[A-Za-z0-9_.-]*${SECRET_KEY}[A-Za-z0-9_.-]*"\\s*:\\s*")[^"\\n]{3,}(")`, 'gi'), `$1${MASK}$2`],
  // KEY=value / key: value
  [new RegExp(`(\\b[A-Za-z0-9_.-]*${SECRET_KEY}[A-Za-z0-9_.-]*\\s*[=:]\\s*)(["']?)[^\\s"']{4,}\\2`, 'gi'), `$1${MASK}`],
];

const entropy = (str) => {
  const f = new Map();
  for (const c of str) f.set(c, (f.get(c) || 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= (n / str.length) * Math.log2(n / str.length);
  return h;
};
/** Long random-looking tokens (API keys in unknown formats): >=32 chars, mixed classes, high entropy; not hashes/UUIDs/paths. */
function maskHighEntropy(out) {
  return out.replace(/[A-Za-z0-9+_=-]{32,}/g, (tok) => {
    if (/^[0-9a-f]+$/i.test(tok)) return tok; // git SHAs / hex digests
    // real keys contain digits next to letters; long CamelCase identifiers (class names) must stay readable
    const digits = (tok.match(/[0-9]/g) || []).length;
    return digits >= 2 && /[A-Za-z]/.test(tok) && entropy(tok) >= 4.2 ? MASK : tok;
  });
}

function maskSecrets(s) {
  if (!s) return s;
  let out = String(s);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return maskHighEntropy(out);
}

const SECRET_BASENAMES = [
  /^\.env(\..+)?$/i, /^\.envrc$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /^\.npmrc$/i, /^\.netrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /^credentials(\.json)?$/i, /^secrets?(\..+)?$/i, /^\.htpasswd$/i, /^service[-_]account.*\.json$/i, /^token(s)?(\.json|\.txt)?$/i,
];
const SECRET_SAFE = /^\.env\.(example|sample|template|dist)$/i;
const SECRET_DIRS = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gcloud|Library\/Keychains)(\/|$)/;

function isSecretPath(p) {
  if (!p) return false;
  const norm = String(p).replace(/\\/g, '/');
  const base = norm.split('/').pop();
  if (SECRET_SAFE.test(base)) return false;
  return SECRET_DIRS.test(norm) || SECRET_BASENAMES.some((re) => re.test(base));
}

module.exports = { stripAnsi, cleanTerminalText, truncateMiddle, maskSecrets, isSecretPath, MASK };
