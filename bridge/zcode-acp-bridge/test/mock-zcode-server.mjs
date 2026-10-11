#!/usr/bin/env node
// mock-zcode-server — 测试用 ZCode Protocol (app-server --stdio) 假实现
// 行为由环境变量驱动（见下）；收到的每个请求追加写入 MOCK_ACTIONS_FILE（JSONL）供断言。
//
//   MOCK_ACTIONS_FILE          请求流水 JSONL 路径（必填才记录）
//   MOCK_SETTINGS_FILE|MOCK_SETTINGS  session/read 返回的 settings（文件优先，缺省内置一套）
//   MOCK_FAIL_SETMODEL_NO_LEVEL=1     setModel 无 options.reasoningLevel 时报 reasoning 错
//   MOCK_SETMODEL_REGISTRY_FAIL=1     setModel 一律报 Provider Registry 不存在
//   MOCK_COMPACT_FAILS=1              session/compact 报错
//   MOCK_COMPACT_PART=1               压缩 turn 里发 part.upserted(compaction, preTokens/postTokens)
//   MOCK_COMPACT_STICKY_PERMISSION=1  压缩 turn 发 permission.requested（测止损路径）
//   MOCK_TURN_DELAY_MS=N              turn.completed 延迟
//   MOCK_CREATE_DELAY_MS=N            session/create 延迟
//   MOCK_RESUME_DELAY_MS=N            session/resume 延迟（测 respawn 并发/close 竞态窗口）
//   MOCK_COMPACT_END_BEFORE_RESPONSE=1  already_running 时把在飞压缩的 turn.completed 先于响应写出
//                                       （同 chunk 保序——复刻 R5-M1 竞态）
//   MOCK_RESUME_MESSAGES_FILE         session/resume 返回的 messages（文件 JSON）
//   MOCK_SESSION_ID                   自定义会话 id（默认 sess_mock_1）

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const ACTIONS = process.env.MOCK_ACTIONS_FILE || '';
const SETTING_FILE = process.env.MOCK_SETTINGS_FILE || '';
let settings;
try {
  settings = SETTING_FILE ? JSON.parse(readFileSync(SETTING_FILE, 'utf8')) : JSON.parse(process.env.MOCK_SETTINGS || 'null');
} catch { settings = null; }
if (!settings) {
  settings = {
    model: {
      current: { providerId: 'new-provider', modelId: 'cn:glm-5.3-flash', options: { reasoningLevel: 'max' } },
      available: [
        {
          ref: { providerId: 'new-provider', modelId: 'cn:glm-5.3-flash' },
          label: 'cn:glm-5.3-flash', providerLabel: '新供应商', description: 'Start Plan',
          contextWindow: 200000,
          reasoning: { levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'max' },
        },
      ],
    },
    thoughtLevel: { enabled: true, current: 'max', defaultLevel: 'max', available: [{ label: 'low', value: 'low' }, { label: 'high', value: 'high' }, { label: 'max', value: 'max' }] },
    mode: { current: 'build' },
  };
}
const FAIL_NO_LEVEL = process.env.MOCK_FAIL_SETMODEL_NO_LEVEL === '1';
const REGISTRY_FAIL = process.env.MOCK_SETMODEL_REGISTRY_FAIL === '1';
const COMPACT_FAILS = process.env.MOCK_COMPACT_FAILS === '1';
const COMPACT_PART = process.env.MOCK_COMPACT_PART === '1';
const STICKY_PERM = process.env.MOCK_COMPACT_STICKY_PERMISSION === '1';
const NOISE = process.env.MOCK_NOISE === '1';              // turn 流里夹未知事件/畸形行/state.updated
const BARE_COMPLETED = process.env.MOCK_BARE_COMPLETED === '1'; // turn.completed 无 response 字段
const TURN_DELAY = parseInt(process.env.MOCK_TURN_DELAY_MS || '15', 10);
const CREATE_DELAY = parseInt(process.env.MOCK_CREATE_DELAY_MS || '0', 10);
const RESUME_DELAY = parseInt(process.env.MOCK_RESUME_DELAY_MS || '0', 10);
const COMPACT_END_FIRST = process.env.MOCK_COMPACT_END_BEFORE_RESPONSE === '1';
const SID_PREFIX = process.env.MOCK_SESSION_ID || 'sess_mock_1';
const SID_SEQ = process.env.MOCK_SESSION_ID_SEQ === '1'; // 1：每个 create 递增新 sessionId（并发会话场景）
let sidCounter = 0;
let lastSid = SID_PREFIX;
function newSid() {
  // 桥给每个会话 spawn 独立 mock 实例：序号必须带 pid 才能跨实例唯一（模拟真实 zcode 的全局唯一 id）
  lastSid = SID_SEQ ? `${SID_PREFIX}_${process.pid}_${++sidCounter}` : SID_PREFIX;
  return lastSid;
}
let resumeMessages = [];
try { resumeMessages = JSON.parse(readFileSync(process.env.MOCK_RESUME_MESSAGES_FILE || '/dev/null', 'utf8') || '[]'); } catch { resumeMessages = []; }

let state = JSON.parse(JSON.stringify(settings));
let seq = 0;

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function record(method, params) {
  if (!ACTIONS) return;
  try { appendFileSync(ACTIONS, JSON.stringify({ method, params }) + '\n'); } catch {}
}
function ev(type, payload, sid = lastSid) {
  send({ method: 'session/event', params: { type, payload, seq: ++seq, sessionId: sid, eventId: `e${seq}`, deliveryKind: 'desktop-continuous' } });
}
// 在飞压缩登记：accepted 后、终结事件前非空（真实 zcode 的 already_running 判据）
let compactInFlight = null; // { sid, inputId, turn }
function runTurn(kind, sid = lastSid, inputId) {
  const turn = { ended: false };
  ev('turn.started', { turnNumber: 1, ...(inputId ? { inputId } : {}) }, sid);
  if (NOISE) {
    ev('future.event.type', { something: true }, sid);   // 未来版本新词：桥必须忽略
    process.stdout.write('))) not json (((\n');           // 畸形行：桥必须跳过
    send({ method: 'state.updated', params: { sessionId: sid, patch: [] } }); // 已知但忽略的通知
  }
  if (kind === 'compact' && COMPACT_PART) {
    ev('part.upserted', { part: { messageId: 'm1', partId: 'p1', sessionId: sid, type: 'compaction', preTokens: 12000, postTokens: 3000 } }, sid);
  }
  if (kind === 'compact' && STICKY_PERM) {
    ev('permission.requested', { requestId: 'perm_1', toolCallId: 't1', toolName: 'bash', reason: 'test', riskLevel: 'low', input: {}, options: [{ optionId: 'opt_allow', label: 'Allow', kind: 'allowOnce' }] }, sid);
    return turn; // 收口交给 permission 应答后的 turn.completed
  }
  if (kind !== 'compact') ev('part.delta', { messageId: 'm1', partId: 'p1', field: 'text', delta: 'echo:' }, sid);
  const completed = {
    ...(inputId ? { inputId } : {}),
    ...(BARE_COMPLETED ? {} : { response: kind === 'compact' ? 'compaction summary text' : 'echo:ok', tokenCount: 3, toolCallCount: 0, duration: 5 }),
  };
  setTimeout(() => {
    if (turn.ended) return; // 已被 END_FIRST 等路径提前收口
    turn.ended = true;
    ev('turn.completed', completed, sid);
    if (compactInFlight && compactInFlight.turn === turn) compactInFlight = null;
  }, TURN_DELAY);
  return turn;
}

let buf = '';
process.stdin.setEncoding('utf8');
// pid 文件：测试按路径精准杀本实例，替代 pgrep 散弹枪（pgrep 会误杀并行跑的其他测试文件的 mock）
if (process.env.MOCK_PID_FILE) {
  try { writeFileSync(process.env.MOCK_PID_FILE, String(process.pid)); } catch {}
}
process.stdin.on('end', () => process.exit(0)); // 防御：被当普通脚本跑时 stdin 关闭即退，不当孤儿
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method) {
      record(m.method, m.params);
      handle(m);
    }
  }
});

function handle(m) {
  const p = m.params || {};
  switch (m.method) {
    case 'session/requestRuntimePreferences':
      // 不回：让桥的超时路径也可见。默认回，避免拖慢测试。
      send({ id: m.id, result: { nativeSearchEnhancementsEnabled: false } });
      return;
    case 'session/create': {
      const sid = newSid();
      const done = () => send({ id: m.id, result: { session: { sessionId: sid }, protocol: { name: 'ZCode Protocol', version: 1 }, messages: [], projection: {} } });
      if (CREATE_DELAY > 0) setTimeout(done, CREATE_DELAY); else done();
      return;
    }
    case 'session/read': {
      state.model.current = state.model.current || {};
      send({ id: m.id, result: { settings: state, sessionId: p.sessionId } });
      return;
    }
    case 'session/setModel': {
      if (REGISTRY_FAIL) { send({ id: m.id, error: { code: -32603, message: 'Provider Registry 中不存在 Model: [object Object]' } }); return; }
      if (!p.model?.options?.reasoningLevel && FAIL_NO_LEVEL) {
        send({ id: m.id, error: { code: -32602, message: 'reasoning level is required for this model' } });
        return;
      }
      state.model.current = { providerId: p.model.providerId, modelId: p.model.modelId, ...(p.model.options ? { options: p.model.options } : {}) };
      send({ id: m.id, result: {} });
      return;
    }
    case 'session/setThoughtLevel': {
      if (p.thoughtLevel === undefined) { send({ id: m.id, error: { code: -32602, message: 'thoughtLevel is required' } }); return; }
      state.thoughtLevel = { ...(state.thoughtLevel || { enabled: true, available: [] }), current: p.thoughtLevel };
      send({ id: m.id, result: {} });
      return;
    }
    case 'session/setMode':
      if (state.mode) state.mode.current = p.mode;
      send({ id: m.id, result: {} });
      return;
    case 'session/subscribe':
      send({ id: m.id, result: { eventSeq: 0, events: [], sessionId: p.sessionId } });
      return;
    case 'session/send':
      if (p.sessionId !== lastSid) { send({ id: m.id, error: { code: -32602, message: 'unknown session' } }); return; }
      send({ id: m.id, result: { accepted: true, sessionId: p.sessionId, stateRevision: 1 } });
      runTurn('prompt', p.sessionId, p.inputId);
      return;
    case 'session/compact': {
      if (COMPACT_FAILS) { send({ id: m.id, error: { code: -32010, message: 'Cannot compact while a prompt is running' } }); return; }
      if (compactInFlight && compactInFlight.sid === (p.sessionId || lastSid)) {
        // 真实 zcode 语义：已在压缩中 → 不重复开 turn，回 already_running
        if (COMPACT_END_FIRST) {
          // R5-M1 竞态复刻：在飞压缩的终结事件先于本响应写出（stdout 保序 → 桥同 chunk 收到）
          compactInFlight.turn.ended = true;
          ev('turn.completed', { inputId: compactInFlight.inputId, response: 'in-flight compaction summary', duration: 4 }, compactInFlight.sid);
          compactInFlight = null;
        }
        send({ id: m.id, result: { compact: { state: 'already_running', ...(p.inputId ? { inputId: p.inputId } : {}) } } });
        return;
      }
      const compactInputId = p.inputId || `mock-compact-${++seq}`;
      send({ id: m.id, result: { response: '', snapshot: {}, compact: { state: 'started', ...(p.inputId ? { inputId: p.inputId } : {}) } } });
      const turn = runTurn('compact', p.sessionId, compactInputId);
      compactInFlight = { sid: p.sessionId || lastSid, inputId: compactInputId, turn };
      return;
    }
    case 'session/stop':
      send({ id: m.id, result: {} });
      return;
    case 'session/resume':
      if (p.sessionId !== lastSid) { send({ id: m.id, error: { code: -32602, message: 'unknown session' } }); return; }
      {
        const done = () => send({ id: m.id, result: { messages: resumeMessages, projection: {}, protocol: { name: 'ZCode Protocol', version: 1 }, runtime: {} } });
        if (RESUME_DELAY > 0) setTimeout(done, RESUME_DELAY); else done();
      }
      return;
    case 'v4/command':
      send({ id: m.id, result: { type: p.type, resolvedBy: { clientId: 'mock' } } });
      // permission 应答后给压缩 turn 收口（sticky permission 场景）
      if (p.type === 'resolveInteraction') setTimeout(() => {
        ev('turn.completed', { response: '', duration: 3 }, lastSid);
        if (compactInFlight) compactInFlight = null;
      }, TURN_DELAY);
      return;
    default:
      send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}
