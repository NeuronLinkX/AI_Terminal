'use strict';
// One structured decision per model call. All fields are required (nullable) so the same schema works with
// strict structured-output modes (Codex --output-schema) and Ollama's `format`.
const ACTIONS = ['run', 'read_file', 'write_file', 'edit_file', 'search', 'wait', 'ask', 'done'];

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'action', 'command', 'path', 'content', 'seconds', 'old_text', 'new_text', 'start_line', 'end_line'],
  properties: {
    say: { type: 'string' },
    action: { type: 'string', enum: ACTIONS },
    command: { type: ['string', 'null'] },
    path: { type: ['string', 'null'] },
    content: { type: ['string', 'null'] },
    seconds: { type: ['integer', 'null'] },
    old_text: { type: ['string', 'null'] },
    new_text: { type: ['string', 'null'] },
    start_line: { type: ['integer', 'null'] },
    end_line: { type: ['integer', 'null'] },
  },
};

/** Plan mode: the model first proposes a short numbered plan that the user approves. */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'plan'],
  properties: { say: { type: 'string' }, plan: { type: 'array', items: { type: 'string' } } },
};
/** Vim inline edit: the model returns only the replacement code. */
const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: { code: { type: 'string' } },
};

function parsePlan(text) {
  let s = String(text).trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new LlmError('invalid-output', '모델이 계획 JSON을 반환하지 않았습니다');
  const j = JSON.parse(s.slice(a, b + 1));
  const steps = (Array.isArray(j.plan) ? j.plan : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  if (!steps.length) throw new LlmError('invalid-output', '계획이 비어 있습니다');
  return { say: typeof j.say === 'string' ? j.say : '', steps };
}

function parseDecision(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new LlmError('invalid-output', '모델이 JSON을 반환하지 않았습니다');
  let j;
  try {
    j = JSON.parse(s.slice(a, b + 1));
  } catch {
    throw new LlmError('invalid-output', '모델 출력 JSON 파싱 실패');
  }
  if (!ACTIONS.includes(j.action)) throw new LlmError('invalid-output', `알 수 없는 action: ${j.action}`);
  return {
    say: typeof j.say === 'string' ? j.say : '',
    action: j.action,
    command: typeof j.command === 'string' ? j.command : null,
    path: typeof j.path === 'string' ? j.path : null,
    content: typeof j.content === 'string' ? j.content : null,
    seconds: Number.isInteger(j.seconds) ? j.seconds : null,
    old_text: typeof j.old_text === 'string' ? j.old_text : null,
    new_text: typeof j.new_text === 'string' ? j.new_text : null,
    start_line: Number.isInteger(j.start_line) && j.start_line > 0 ? j.start_line : null,
    end_line: Number.isInteger(j.end_line) && j.end_line > 0 ? j.end_line : null,
  };
}

class LlmError extends Error {
  /** kind: not-installed | not-authenticated | outdated | server-down | model-missing | timeout | network | aborted | invalid-output | failed */
  constructor(kind, message, hint) {
    super(message);
    this.kind = kind;
    this.hint = hint;
  }
}

module.exports = { DECISION_SCHEMA, PLAN_SCHEMA, EDIT_SCHEMA, parseDecision, parsePlan, LlmError, ACTIONS };
