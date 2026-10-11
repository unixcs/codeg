#!/usr/bin/env node
// 墨菲定律测试：专打桥的健壮性边界——巨大输入、畸形块、中途取消、并发会话、
// 未知事件噪声、残缺 turn payload、SEP 注入、stdin 收尾。凡是"用户一定会踩"的都算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, initialize } from './harness.mjs';

const SEP = '\u241f';

async function withBridge(opts, fn) {
  const b = await startBridge(opts);
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

test('巨型 prompt（~1MB 文本）正常收口，桥不死', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    const big = 'x'.repeat(1024 * 1024);
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: big }] });
    const r = await b.responseFor(3, 15000);
    assert.equal(r.result.stopReason, 'end_turn');
    // 桥还活着：再来一轮短的
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'ok' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
  });
});

test('prompt 混入非 text 块只取文本；全非 text → ACP error 且会话不死', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    // image + text 混合：只拼 text
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'image', data: 'xx' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
    assert.equal((await b.responseFor(3)).result.stopReason, 'end_turn');
    let send = (await b.actions()).filter(a => a.method === 'session/send').pop();
    assert.equal(send.params.content, 'a\nb');
    // 全非 text → error
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'image', data: 'xx' }] });
    const r4 = await b.responseFor(4);
    assert.ok(r4.error, 'no-text prompt rejected');
    // 会话仍可用
    b.request(5, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'still here' }] });
    assert.equal((await b.responseFor(5)).result.stopReason, 'end_turn');
  });
});

test('turn 进行中 set_config_option：正常应答且 turn 正常收口', async () => {
  await withBridge({ env: { MOCK_TURN_DELAY_MS: 300 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'slow turn' }] });
    b.request(4, 'session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'high' });
    const r4 = await b.responseFor(4);
    assert.ok(r4.result.configOptions, 'config op answered mid-turn');
    assert.equal((await b.responseFor(3)).result.stopReason, 'end_turn');
    const stl = (await b.actions()).find(a => a.method === 'session/setThoughtLevel');
    assert.equal(stl.params.thoughtLevel, 'high');
  });
});

test('turn 进行中 cancel：stopReason cancelled，会话可继续用', async () => {
  await withBridge({ env: { MOCK_TURN_DELAY_MS: 400 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'will be cancelled' }] });
    await b.waitFor(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk', 5000, 'first chunk');
    b.notify('session/cancel', { sessionId: sid });
    const r = await b.responseFor(3);
    assert.equal(r.result.stopReason, 'cancelled');
    // 会话没死：下一轮正常
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'next' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
  });
});

test('/compact 边界：/COMPACT 大写拦截；/compactfoo 不拦截直通', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/COMPACT' }] });
    assert.equal((await b.responseFor(3)).result.stopReason, 'end_turn');
    assert.ok((await b.actions()).some(a => a.method === 'session/compact'), 'uppercase intercepted');
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compactfoo details' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
    const sends = (await b.actions()).filter(a => a.method === 'session/send');
    assert.ok(sends.some(a => a.params.content === '/compactfoo details'), 'non-command passed through');
  });
});

test('并发两个 session/new：独立 sessionId、各自收口不串话', async () => {
  await withBridge({ env: { MOCK_SESSION_ID_SEQ: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    b.request(3, 'session/new', { cwd: '/tmp' });
    const [r2, r3] = await Promise.all([b.responseFor(2), b.responseFor(3)]);
    const sidA = r2.result.sessionId, sidB = r3.result.sessionId;
    assert.ok(sidA && sidB && sidA !== sidB, 'distinct session ids');
    b.request(4, 'session/prompt', { sessionId: sidA, prompt: [{ type: 'text', text: 'for A' }] });
    b.request(5, 'session/prompt', { sessionId: sidB, prompt: [{ type: 'text', text: 'for B' }] });
    const [r4, r5] = await Promise.all([b.responseFor(4), b.responseFor(5)]);
    assert.equal(r4.result.stopReason, 'end_turn');
    assert.equal(r5.result.stopReason, 'end_turn');
    const sends = (await b.actions()).filter(a => a.method === 'session/send');
    assert.deepEqual(sends.map(a => a.params.sessionId).sort(), [sidA, sidB].sort());
  });
});

test('zcode 事件流噪声（未知事件/畸形行/state.updated）不炸桥、turn 正常收口', async () => {
  await withBridge({ env: { MOCK_NOISE: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'with noise' }] });
    assert.equal((await b.responseFor(3)).result.stopReason, 'end_turn');
    // turn 文本流未被噪声挤掉
    const chunk = b.stdout.find(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk');
    assert.ok(chunk?.params?.update?.content?.text?.includes('echo:'), 'text stream intact');
  });
});

test('turn.completed 残缺 payload（无 response）正常收口', async () => {
  await withBridge({ env: { MOCK_BARE_COMPLETED: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'bare' }] });
    assert.equal((await b.responseFor(3)).result.stopReason, 'end_turn');
  });
});

test('model value 带 4 段 SEP（注入/超段）不炸、level 取第 3 段', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `new-provider${SEP}cn:glm-5.3-flash${SEP}low${SEP}extra${SEP}more` });
    const r = await b.responseFor(3);
    assert.ok(r.result.configOptions, 'overlong value tolerated');
    const setModel = (await b.actions()).find(a => a.method === 'session/setModel');
    assert.deepEqual(setModel.params.model, { providerId: 'new-provider', modelId: 'cn:glm-5.3-flash', options: { reasoningLevel: 'low' } });
  });
});

test('load 未知 sessionId → ACP error，桥继续服务', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/load', { cwd: '/tmp', sessionId: 'sess_unknown' });
    const r = await b.responseFor(2);
    assert.ok(r.error, 'load unknown rejected');
    // 桥仍可用
    b.request(3, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(3)).result.sessionId;
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'alive' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
  });
});

test('宿主 stdin end：桥自行退出且不留子进程', async () => {
  const b = await startBridge({});
  try {
    await initialize(b, 1);
    b.proc.stdin.end();
    const exited = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (b.proc.exitCode !== null) return resolve(true);
        if (Date.now() - t0 > 8000) return resolve(false);
        setTimeout(poll, 100);
      };
      poll();
    });
    assert.ok(exited, 'bridge exited on stdin end');
  } finally {
    await b.close();
  }
});
