'use strict';
// Provider: OpenAI Codex CLI in non-interactive mode (`codex exec`). Uses the CLI's own ChatGPT login —
// this app never reads or stores credentials. The prompt goes via stdin, the answer comes back through
// --output-schema (structured JSON) + --output-last-message. The CLI runs in an empty read-only scratch dir.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DECISION_SCHEMA, LlmError } = require('./schema');
const { maskSecrets, truncateMiddle } = require('../text');

const CANDIDATE_MODELS = (process.env.AIT_CODEX_MODEL ? [process.env.AIT_CODEX_MODEL] : ['gpt-5.6-luna', 'gpt-5.5']);

class CodexProvider {
  constructor({ dataDir }) {
    this.id = 'codex';
    this.dataDir = dataDir;
    this.scratch = path.join(dataDir, 'llm-scratch');
    this.schemaFile = path.join(this.scratch, 'decision.schema.json');
    this.model = CANDIDATE_MODELS[0];
    this.bin = process.env.AIT_CODEX_BIN || 'codex';
  }
  get label() {
    return `Codex CLI · ${this.model}`;
  }

  _prepare() {
    fs.mkdirSync(this.scratch, { recursive: true });
    fs.writeFileSync(this.schemaFile, JSON.stringify(DECISION_SCHEMA));
  }

  /** Cheap check: binary present and logged in. Does not call the model. */
  available() {
    return new Promise((resolve) => {
      execFile(this.bin, ['login', 'status'], { timeout: 8000, env: process.env }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ ok: false, kind: 'not-installed', detail: 'codex CLI 없음', hint: '`npm i -g @openai/codex` 또는 `brew install codex` 로 설치하세요.' });
        const out = `${stdout}${stderr}`;
        if (err || /not logged in/i.test(out)) return resolve({ ok: false, kind: 'not-authenticated', detail: '로그인 필요', hint: '터미널에서 `codex login` 으로 로그인하세요 (앱은 인증 정보를 저장/출력하지 않습니다).' });
        resolve({ ok: true, detail: out.trim().split('\n')[0] || '로그인됨' });
      });
    });
  }

  complete({ system, user, signal, schema, timeoutMs = 120000 }) {
    this._prepare();
    let schemaFile = this.schemaFile;
    if (schema) {
      // a custom answer shape (plan / inline edit): write it next to the default schema for this one call
      schemaFile = path.join(this.scratch, `schema-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(schemaFile, JSON.stringify(schema));
    }
    return this._run(CANDIDATE_MODELS.slice(), `${system}\n\n${user}`, signal, timeoutMs, schemaFile).finally(() => {
      if (schemaFile !== this.schemaFile) fs.rm(schemaFile, { force: true }, () => {});
    });
  }

  async _run(models, prompt, signal, timeoutMs, schemaFile) {
    const model = models[0];
    try {
      const text = await this._exec(model, prompt, signal, timeoutMs, schemaFile);
      this.model = model;
      return text;
    } catch (e) {
      if ((e.kind === 'model-missing' || e.kind === 'outdated') && models.length > 1) return this._run(models.slice(1), prompt, signal, timeoutMs, schemaFile);
      throw e;
    }
  }

  _exec(model, prompt, signal, timeoutMs, schemaFile) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new LlmError('aborted', '중단됨'));
      const outFile = path.join(this.scratch, `out-${process.pid}-${Date.now()}.txt`);
      const args = [
        'exec', '-m', model, '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
        '-s', 'read-only', '-C', this.scratch, '--color', 'never',
        '-c', 'model_reasoning_effort="low"',
        '--output-schema', schemaFile || this.schemaFile, '-o', outFile, '-',
      ];
      const child = spawn(this.bin, args, { cwd: this.scratch, env: process.env, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fs.rm(outFile, { force: true }, () => {});
        fn(v);
      };
      const onAbort = () => {
        child.kill('SIGTERM');
        finish(reject, new LlmError('aborted', '중단됨'));
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(reject, new LlmError('timeout', `모델 응답 시간 초과 (${Math.round(timeoutMs / 1000)}초)`, '네트워크 상태를 확인하고 다시 시도하세요.'));
      }, timeoutMs);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.stderr.on('data', (d) => {
        if (stderr.length < 20000) stderr += d;
      });
      child.on('error', (e) => finish(reject, e.code === 'ENOENT' ? new LlmError('not-installed', 'codex CLI를 찾을 수 없습니다', '`npm i -g @openai/codex` 로 설치하세요.') : new LlmError('failed', e.message)));
      child.on('close', (code) => {
        if (done) return;
        if (code === 0) {
          try {
            const t = fs.readFileSync(outFile, 'utf8');
            if (t.trim()) return finish(resolve, t);
          } catch {
            /* fallthrough */
          }
          return finish(reject, new LlmError('invalid-output', '모델이 빈 응답을 반환했습니다'));
        }
        finish(reject, classify(stderr, code));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

function classify(stderr, code) {
  const s = stderr || '';
  if (/requires a newer version/i.test(s)) return new LlmError('outdated', '선택한 모델이 현재 Codex CLI 버전에서 지원되지 않습니다', '`npm i -g @openai/codex@latest` 로 Codex를 업데이트하거나 AIT_CODEX_MODEL 로 다른 모델을 지정하세요.');
  if (/model.*(not found|does not exist|not supported|unsupported)/i.test(s)) return new LlmError('model-missing', '모델을 사용할 수 없습니다', 'AIT_CODEX_MODEL 환경변수로 사용 가능한 모델을 지정하세요.');
  if (/not logged in|unauthorized|401|authentication|log ?in/i.test(s)) return new LlmError('not-authenticated', 'Codex 로그인이 필요합니다', '터미널에서 `codex login` 을 실행하세요.');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|dns|connection|fetch failed|stream disconnected/i.test(s)) return new LlmError('network', '네트워크 연결 실패', '인터넷 연결을 확인하세요. 로컬 모델(Ollama)로 전환할 수도 있습니다.');
  return new LlmError('failed', `codex 종료 코드 ${code}: ${truncateMiddle(maskSecrets(s.trim()), 400)}`);
}

module.exports = { CodexProvider, classify };
