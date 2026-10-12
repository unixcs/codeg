#!/usr/bin/env node
// 墨菲定律测试：专打桥的健壮性边界——巨大输入、畸形块、中途取消、并发会话、
// 未知事件噪声、残缺 turn payload、SEP 注入、stdin 收尾。凡是"用户一定会踩"的都算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge, initialize } from './harness.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// ---- R5/R6 吸收批：inputId 归属 / already_running 跟随 / 重建窗口 / spawn 闸 / 孤儿收尸 ----

test('already_running 竞态（终结先于响应）：跟随轮快速收口 + 三态卡', async () => {
  // R5-M1 复刻：第 1 次 /compact 被 cancel（inputId 转 foreign），在飞压缩继续；
  // 第 2 次 /compact 撞上 already_running 且在飞轮的终结先于响应到达（同 chunk 保序）——
  // 跟随模式必须快速收口并补齐 in_progress/completed 卡，而不是挂到看门狗
  await withBridge({
    env: { MOCK_TURN_DELAY_MS: 1500, MOCK_COMPACT_END_BEFORE_RESPONSE: '1' },
  }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    await b.waitFor(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'compaction_update' && m.params?.update?.status === 'in_progress', 5000, 'first compact in_progress');
    b.notify('session/cancel', { sessionId: sid });
    assert.equal((await b.responseFor(3)).result.stopReason, 'cancelled');
    const t0 = Date.now();
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact again' }] });
    const r4 = await b.responseFor(4, 10000);
    assert.ok(Date.now() - t0 < 8000, `follow-mode compact resolved fast (took ${Date.now() - t0}ms)`);
    assert.equal(r4.result.stopReason, 'end_turn');
    const cards = b.stdout.filter(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'compaction_update').map(m => m.params.update.status);
    assert.ok(cards.includes('in_progress') && cards.includes('completed'), `three-state cards present: ${cards.join(',')}`);
    // 跟随轮收口靠在飞轮的终结事件（inputId 精确归属），session/compact 发了两次
    const compacts = (await b.actions()).filter(a => a.method === 'session/compact');
    assert.equal(compacts.length, 2);
    assert.notEqual(compacts[0].params.inputId, compacts[1].params.inputId, 'distinct inputIds per op');
  });
});

test('cancel 落在 respawn 重建窗口：本轮 cancelled 收口且不开新 turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zab-murphy-'));
  const pidFile = join(dir, 'mock.pid');
  await withBridge({ env: { MOCK_RESUME_DELAY_MS: 600, MOCK_PID_FILE: pidFile } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    // 杀掉 zcode 子进程 → 桥的 exit 处理置空 s.zc；下一轮 prompt 走透明 respawn（resume 拖 600ms）
    const pid1 = parseInt(readFileSync(pidFile, 'utf8'), 10);
    process.kill(pid1, 'SIGKILL');
    await sleep(400); // 等 exit 事件被桥消化
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'cancelled mid-rebuild' }] });
    b.notify('session/cancel', { sessionId: sid }); // 落在 respawn 窗口内
    const r3 = await b.responseFor(3);
    assert.equal(r3.result.stopReason, 'cancelled');
    // 重建出的子进程没开新 turn：actions 里只有 resume/subscribe 等，无 session/send
    assert.ok(!(await b.actions()).some(a => a.method === 'session/send'), 'no turn started after cancelled rebuild');
    // 下一轮 prompt 正常（标记已消费、不误杀）
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'next' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
  });
});

test('close×respawn 竞态：close 后重建的子进程被杀，不留孤儿', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zab-murphy-'));
  const pidFile = join(dir, 'mock.pid');
  const b = await startBridge({ env: { MOCK_RESUME_DELAY_MS: 600, MOCK_PID_FILE: pidFile } });
  try {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    const pid1 = parseInt(readFileSync(pidFile, 'utf8'), 10);
    process.kill(pid1, 'SIGKILL');
    await sleep(400);
    // prompt 触发 respawn（新 mock 立即 spawn 并覆写 pid 文件，resume 拖 600ms）；
    // close 在 resume 在飞时到达 → ensureZcode 的 closed 检查必须杀掉新子进程
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'doomed' }] });
    b.request(4, 'session/close', { sessionId: sid });
    const r4 = await b.responseFor(4);
    assert.ok(r4.result, 'close acknowledged');
    const r3 = await b.responseFor(3);
    assert.ok(r3.error, 'in-flight prompt fails once session closed');
    await sleep(500);
    const pid2 = parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.notEqual(pid2, pid1, 'respawned child registered its pid');
    let alive = true;
    try { process.kill(pid2, 0); } catch { alive = false; }
    assert.ok(!alive, `respawned child ${pid2} reaped after close`);
    // 桥还活着
    b.request(5, 'session/new', { cwd: '/tmp' });
    assert.ok((await b.responseFor(5)).result.sessionId, 'bridge alive after close');
  } finally {
    await b.close();
  }
});

test('spawn 并发闸：12 并发 session/new → 8 成功 + 4 拒绝(-32603)', async () => {
  await withBridge({ env: { MOCK_CREATE_DELAY_MS: 400, MOCK_SESSION_ID_SEQ: '1' } }, async (b) => {
    await initialize(b, 1);
    const ids = Array.from({ length: 12 }, (_, i) => 10 + i);
    for (const id of ids) b.request(id, 'session/new', { cwd: '/tmp' });
    const rs = await Promise.all(ids.map(id => b.responseFor(id, 15000)));
    const ok = rs.filter(r => r.result?.sessionId);
    const rejected = rs.filter(r => r.error);
    assert.equal(ok.length, 8, `gate admits exactly 8: got ${ok.length}`);
    assert.equal(rejected.length, 4, `gate rejects the rest: got ${rejected.length}`);
    for (const r of rejected) {
      assert.equal(r.error.code, -32603);
      assert.match(r.error.message, /too many concurrent zcode spawns/);
    }
    assert.equal(new Set(ok.map(r => r.result.sessionId)).size, 8, 'distinct session ids');
  });
});

// ---- R7/R8 吸收批：load 单飞 / legacy 兜底缓冲 / -32010 重试 / 僵尸权限归属 / 日志卫生 ----

test('并发 load 同一 zsid：单飞只 spawn 一次，两个响应都成功', async () => {
  // R7-B1：并发窗口内两个 load 都见不到已入册条目——不加单飞会双 spawn 双回放，
  // 后入册者覆盖前者且其子进程成孤儿
  await withBridge({ env: { MOCK_RESUME_DELAY_MS: 400 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/load', { cwd: '/tmp', sessionId: 'sess_mock_1' });
    b.request(3, 'session/load', { cwd: '/tmp', sessionId: 'sess_mock_1' });
    const [r2, r3] = await Promise.all([b.responseFor(2), b.responseFor(3)]);
    assert.ok(r2.result?.models && r3.result?.models, 'both loads succeed');
    const resumes = (await b.actions()).filter(a => a.method === 'session/resume');
    assert.equal(resumes.length, 1, `single-flight: exactly one spawn/resume, got ${resumes.length}`);
    // 桥仍可用
    b.request(4, 'session/prompt', { sessionId: 'sess_mock_1', prompt: [{ type: 'text', text: 'after concurrent load' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
  });
});

test('legacy zcode（事件无 inputId）的 already_running 同 chunk：缓冲重放快速收口', async () => {
  // R7-M1：旧 zcode 终结事件不带 inputId，pendingTurnOp 窗口内到达的无主终结此前被吞，
  // 跟随轮挂到看门狗。现在缓存为 foreign 候选，already_running 响应后重放收口
  await withBridge({
    env: { MOCK_TURN_DELAY_MS: 1500, MOCK_COMPACT_END_BEFORE_RESPONSE: '1', MOCK_LEGACY_NO_INPUTID: '1' },
  }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    await b.waitFor(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'compaction_update' && m.params?.update?.status === 'in_progress', 5000, 'first compact in_progress');
    b.notify('session/cancel', { sessionId: sid });
    assert.equal((await b.responseFor(3)).result.stopReason, 'cancelled');
    const t0 = Date.now();
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact again' }] });
    const r4 = await b.responseFor(4, 10000);
    assert.ok(Date.now() - t0 < 8000, `legacy follow-mode resolved fast (took ${Date.now() - t0}ms)`);
    assert.equal(r4.result.stopReason, 'end_turn');
    const cards = b.stdout.filter(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'compaction_update').map(m => m.params.update.status);
    assert.ok(cards.includes('completed'), `completed card present: ${cards.join(',')}`);
  });
});

test('send 撞 -32010（上一轮终结未落）：短退避重试后成功', async () => {
  // R7-M3：紧邻 cancel 重发时真实 zcode 会拒 -32010 数百 ms——必须重试而不是直接报错
  await withBridge({ env: { MOCK_32010_CONCURRENT: '1', MOCK_TURN_DELAY_MS: 300 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'first' }] });
    await b.waitFor(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk', 5000, 'first chunk');
    b.notify('session/cancel', { sessionId: sid });
    assert.equal((await b.responseFor(3)).result.stopReason, 'cancelled');
    // 立即重发：上一 turn 还没终结 → mock 拒 -32010 → 桥退避重试 → 成功
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'retry wins' }] });
    assert.equal((await b.responseFor(4, 10000)).result.stopReason, 'end_turn');
    const sends = (await b.actions()).filter(a => a.method === 'session/send');
    assert.ok(sends.length >= 2, `retry happened (>=2 sends): ${sends.length}`);
    assert.equal(sends[sends.length - 1].params.content, 'retry wins');
  });
});

test('僵尸轮权限止损归属：外来轮只拒交互不动会话，健康轮不受牵连', async () => {
  // R7-M2：turn1 的权限无从归属（无工具卡）→ 止损 refusal（保底行为不变）；
  // turn2 先有工具卡 → 僵尸权限（tc_zombie）判外来轮 → 只应答 deny，不 session/stop 不 endTurn
  await withBridge({ env: { MOCK_ZOMBIE_PERM: '1', MOCK_TURN_DELAY_MS: 200 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'first' }] });
    assert.equal((await b.responseFor(3)).result.stopReason, 'refusal', 'unattributable permission still stops its own turn');
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'second' }] });
    assert.equal((await b.responseFor(4, 10000)).result.stopReason, 'end_turn', 'healthy turn survives zombie permission');
    const stops = (await b.actions()).filter(a => a.method === 'session/stop');
    assert.equal(stops.length, 1, `exactly one stop-loss stop (turn1), got ${stops.length}`);
  });
});

test('畸形 ACP 行含密钥形态：日志只记长度+hex 头，不落原文', async () => {
  // R8-M1：ACP parse error 是桥唯一落"宿主原文"的汇点——必须只记 len + 首 16 字节 hex
  const b = await startBridge({});
  try {
    await initialize(b, 1);
    // 绕过 b.raw（它会 JSON.stringify 整个字符串——畸形行会变合法字面量）：直接写 stdin
    b.proc.stdin.write('{"broken": "AIzaSyD-123456789012345678901234567890abc"} no trailing\n');
    await sleep(300);
    const logFile = join(b.logDir, `bridge-${b.proc.pid}.log`);
    const content = readFileSync(logFile, 'utf8');
    assert.ok(content.includes('ACP parse error'), 'parse error logged');
    assert.ok(!content.includes('AIza'), 'no plaintext key material in log');
    assert.ok(!content.includes('"broken"'), 'no raw line content in log');
  } finally {
    await b.close();
  }
});

test('turn.failed 收口：失败消息透出、会话可继续', async () => {
  // R7 指出的测试盲区：mock 此前无 turn.failed 路径。失败轮要正常释放 waiter
  //（stopReason end_turn）+ 消息块带失败原因，且不污染下一轮（sawText 水位归零）
  await withBridge({ env: { MOCK_FAIL_TURN: '2', MOCK_TURN_DELAY_MS: 50 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'ok turn' }] });
    assert.equal((await b.responseFor(3)).result.stopReason, 'end_turn');
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'doomed turn' }] });
    assert.equal((await b.responseFor(4)).result.stopReason, 'end_turn');
    const failedChunk = b.stdout.find(m => m.method === 'session/update'
      && m.params?.update?.sessionUpdate === 'agent_message_chunk'
      && String(m.params?.update?.content?.text || '').includes('mock turn failure'));
    assert.ok(failedChunk, 'failure reason surfaced as message chunk');
    // 下一轮正常：failed 分支的水位归零没有把旧前缀兜底重放
    b.request(5, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'after failure' }] });
    assert.equal((await b.responseFor(5)).result.stopReason, 'end_turn');
    const chunks = b.stdout.filter(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk')
      .map(m => m.params.update.content.text).join('|');
    assert.ok(!chunks.includes('echo:okecho:'), `no duplicated prefix replay: ${chunks.slice(0, 120)}`);
  });
});
