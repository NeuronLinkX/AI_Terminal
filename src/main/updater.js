'use strict';
// "Is there a newer version?" — checks the GitHub Releases API of the repository named in package.json. It only
// reports and opens the download page; installing stays a manual (user-initiated) step because the app is unsigned,
// and macOS cannot self-replace an unsigned app. Nothing is checked unless the user asks (menu) or enables it in Settings.
const pkg = require('../../package.json');

const cmp = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
};

function repoSlug() {
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const m = String(url).match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : '';
}

async function checkForUpdate(current, fetchImpl = fetch) {
  const slug = repoSlug();
  if (!slug) return { status: 'unconfigured', current };
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'AI-Terminal-update-check' }, signal: AbortSignal.timeout(6000) });
    if (r.status === 404) return { status: 'unavailable', current, reason: '릴리스를 찾을 수 없습니다(저장소가 비공개이거나 아직 릴리스가 없음).' };
    if (!r.ok) return { status: 'error', current, reason: `GitHub 응답 ${r.status}` };
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    const asset = (j.assets || []).find((a) => /\.dmg$/.test(a.name) && a.name.includes(process.arch === 'arm64' ? 'arm64' : 'x64')) || (j.assets || []).find((a) => /\.dmg$/.test(a.name));
    return { status: cmp(latest, current) > 0 ? 'available' : 'current', current, latest, url: j.html_url, downloadUrl: asset && asset.browser_download_url, notes: String(j.body || '').slice(0, 1500) };
  } catch (e) {
    return { status: 'error', current, reason: '네트워크에 연결할 수 없습니다.' };
  }
}

module.exports = { checkForUpdate, cmp, repoSlug };
