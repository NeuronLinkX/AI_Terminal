#!/usr/bin/env node
'use strict';
// Layer-wise KV study on the real local model: builds agent-shaped prompts from this repository's real files and command
// output, runs native/kvprof (libllama) on them, and writes docs/benchmark-kv-layers.json + docs/kv-layer-profile.svg.
//   node scripts/kv-profile.js [model]        default qwen3:8b
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { build, out: BIN } = require('./build-native');
const { SYSTEM } = require('../src/main/agent');

const root = path.join(__dirname, '..');
const model = process.argv[2] || 'qwen3:8b';
const CTX = 2048;

function blobOf(m) {
  const [name, tag] = m.split(':');
  const mf = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ollama/models/manifests/registry.ollama.ai/library', name, tag || 'latest'), 'utf8'));
  return path.join(os.homedir(), '.ollama/models/blobs', mf.layers.find((l) => /image\.model$/.test(l.mediaType)).digest.replace(':', '-'));
}
const sh = (cmd) => { try { return execFileSync('/bin/zsh', ['-lc', cmd], { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 24 }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
const read = (f, a = 0, b = 9000) => fs.readFileSync(path.join(root, f), 'utf8').slice(a, b);

/** An agent turn in qwen3's chat format: system prompt + state + request + the observations gathered so far. */
const turn = (request, observations) => `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n[현재 상태]\n[환경] macOS arm64, shell=zsh, cwd=~/AI_terminal\n[디렉터리]\n${sh('ls').trim()}\n[Git]\n${sh('git status --short | head -15')}\n[사용자 요청]\n${request}\n\n[이번 요청에서 지금까지 실제로 수행한 단계]\n${observations}\n[지시] 다음 결정 하나를 JSON으로 출력하세요.<|im_end|>\n<|im_start|>assistant\n`;
const obs = (n, cmd, body) => `${n}. run \`${cmd}\` → 종료코드 0\n<untrusted_output>\n${body}\n</untrusted_output>\n`;
const file = (n, p, body) => `${n}. read_file ${p} →\n<untrusted_file>\n${body}\n</untrusted_file>\n`;

const prompts = {
  // calibration set: code reading, git history, Korean documentation
  'calib-code': turn('정책 파일이 어떻게 동작하는지 설명해줘.', obs(1, 'ls src/main', sh('ls -la src/main')) + file(2, 'src/main/policy.js', read('src/main/policy.js', 0, 6500))),
  'calib-git': turn('최근 변경 내역을 정리해줘.', obs(1, 'git log --stat -8', sh('git log --stat -8 | head -90')) + obs(2, 'git diff --stat', sh('git diff --stat | head -40'))),
  'calib-ko': turn('README 의 핵심 기능을 요약해줘.', file(1, 'README.md', read('README.md', 0, 5200)) + obs(2, 'wc -l README.md', sh('wc -l README.md'))),
  // held-out set: different files, different kind of content
  'eval-agent': turn('에이전트가 명령을 어떻게 실행하는지 알려줘.', obs(1, 'grep -n "async _doRun" -r src', sh('grep -rn "_doRun\\|_decide\\|assessCommand" src | head -30')) + file(2, 'src/main/agent.js', read('src/main/agent.js', 9000, 15500))),
  'eval-log': turn('벤치마크 결과를 보고 메모리 사용량을 분석해줘.', obs(1, 'cat docs/benchmark-memory.json', read('docs/benchmark-memory.json', 0, 3500)) + obs(2, 'npm test', sh('node --test test/core.test.js 2>&1 | head -60'))),
  'eval-shell': turn('셸 통합 스크립트가 하는 일을 설명해줘.', file(1, 'src/main/shell-integration/zsh/.zshrc', read('src/main/shell-integration/zsh/.zshrc', 0, 4000)) + file(2, 'src/main/pty-session.js', read('src/main/pty-session.js', 0, 4200))),
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-kvprof-'));
const files = {};
for (const [k, v] of Object.entries(prompts)) { files[k] = path.join(dir, k + '.txt'); fs.writeFileSync(files[k], v); }

const b = build();
if (!b.ok) { console.error('native build failed:', b.reason); process.exit(1); }

// free the GPU: the profiler loads its own copy of the model
for (const base of ['http://127.0.0.1:11434']) {
  try {
    const ps = JSON.parse(execFileSync('curl', ['-s', `${base}/api/ps`], { encoding: 'utf8' }));
    for (const m of ps.models || []) execFileSync('curl', ['-s', `${base}/api/generate`, '-d', JSON.stringify({ model: m.name, keep_alive: 0 })], { stdio: 'ignore' });
  } catch { /* server not running */ }
}

const outJson = path.join(root, 'docs', 'benchmark-kv-layers.json');
const args = ['--model', blobOf(model), '--ctx', String(CTX), '--out', outJson];
for (const k of Object.keys(files)) args.push(k.startsWith('calib') ? '--calib' : '--eval', files[k]);
console.log('running kvprof …');
const t0 = Date.now();
execFileSync(BIN, args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: 1800000 });
const data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
data.model = model;
data.measuredAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
data.seconds = Math.round((Date.now() - t0) / 1000);
data.prompts = Object.keys(files);
fs.writeFileSync(outJson, JSON.stringify(data, null, 1));
console.log('written', path.relative(root, outJson));

// ------------------------------------------------------------------ SVG figure
const L = data.layers;
const W = 880, H = 440;
const x0 = 56, x1 = W - 24;
const px = (l) => x0 + ((x1 - x0) * l) / Math.max(1, L - 1);
const cap10 = data.perLayer.map((l) => l.capture['0.1']);
const lo = Math.min(...cap10), hi = Math.max(...cap10);
const py = (v) => 190 - ((v - lo) / Math.max(1e-9, hi - lo)) * 130;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="12"><rect width="${W}" height="${H}" fill="#ffffff"/>`;
svg += `<text x="${x0}" y="24" font-size="14" font-weight="700" fill="#1f2430">${model}: how much attention a layer keeps when only 10% of the keys survive</text>`;
svg += `<text x="${x0}" y="42" fill="#5b6475">measured with libllama on ${data.calibPrompts} agent-shaped prompts (${data.ctx} tokens, observation window ${data.window}); higher = the layer can be pruned harder</text>`;
svg += `<line x1="${x0}" y1="190" x2="${x1}" y2="190" stroke="#cfd4dd"/><line x1="${x0}" y1="60" x2="${x0}" y2="190" stroke="#cfd4dd"/>`;
svg += `<polyline fill="none" stroke="#5b46d6" stroke-width="2" points="${cap10.map((v, l) => `${px(l).toFixed(1)},${py(v).toFixed(1)}`).join(' ')}"/>`;
cap10.forEach((v, l) => { svg += `<circle cx="${px(l).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.6" fill="#5b46d6"/>`; });
svg += `<text x="${x0 - 8}" y="64" text-anchor="end" fill="#5b6475">${(hi * 100).toFixed(0)}%</text><text x="${x0 - 8}" y="194" text-anchor="end" fill="#5b6475">${(lo * 100).toFixed(0)}%</text>`;
for (let l = 0; l < L; l += 5) svg += `<text x="${px(l).toFixed(1)}" y="208" text-anchor="middle" fill="#5b6475">${l}</text>`;
svg += `<text x="${(x0 + x1) / 2}" y="224" text-anchor="middle" fill="#5b6475">layer (0 = first)</text>`;
// policy bars at 10% and 20% budgets
const pols = [['uniform', 'uniform'], ['pyramid', 'PyramidKV-style'], ['cake', 'CAKE-style'], ['depthkv-proportional', 'DepthKV-style (∝ loss)'], ['marginal', 'marginal-gain (optimal)'], ['marginal+adakv', 'marginal + Ada-KV heads']];
const colors = ['#8a92a2', '#1e6fd0', '#b26b00', '#198754', '#5b46d6', '#c8323f'];
svg += `<text x="${x0}" y="256" font-size="13" font-weight="700" fill="#1f2430">Attention mass LOST at the same total KV budget, on held-out prompts (lower = better)</text>`;
['0.1', '0.2'].forEach((rho, gi) => {
  const ev = data.eval[rho];
  const gx = x0 + gi * 400;
  svg += `<text x="${gx}" y="278" fill="#1f2430" font-weight="600">keep ${Math.round(rho * 100)}% of the keys on average</text>`;
  const vals = pols.map(([k]) => ev[k].meanLoss);
  const mx = Math.max(...vals);
  pols.forEach(([k, label], i) => {
    const w = (ev[k].meanLoss / mx) * 150;
    const y = 288 + i * 23;
    svg += `<rect x="${gx}" y="${y}" width="${w.toFixed(1)}" height="14" rx="3" fill="${colors[i]}"/><text x="${gx + w + 6}" y="${y + 11}" fill="#1f2430">${(ev[k].meanLoss * 100).toFixed(1)}% <tspan fill="#5b6475">${label}</tspan></text>`;
  });
});
svg += '</svg>\n';
fs.writeFileSync(path.join(root, 'docs', 'kv-layer-profile.svg'), svg);
console.log('written docs/kv-layer-profile.svg');
