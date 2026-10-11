#!/usr/bin/env node
// zcode-acp-bridge v0.2.0 协议层单测（node:test，mock zcode app-server）
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function findUpdate(b, pred) {
  const m = b.stdout.find(m => m.method === 'session/update' && pred(m.params?.update || {}));
  return m?.params?.update; // 直接给 update 对象，调用方断言内层字段
}

function configOptionOf(m, id) {
  const cfg = m?.params?.update?.configOptions || m?.result?.configOptions || [];
  return cfg.find(o => o.id === id);
}

test('--version 探针不挂 stdio', async () => {
  const { execFile } = await import('node:child_process');
  const bridgePath = new URL('../zcode-acp-bridge', import.meta.url).pathname;
  const out = await new Promise((resolve, reject) => {
    execFile('node', [bridgePath, '--version'], (e, stdout) => e ? reject(e) : resolve(stdout));
  });
  assert.match(out, /zcode-acp-bridge 0\.2\.0/);
});

test('initialize 应答 v1 能力与版本', async () => {
  await withBridge({}, async (b) => {
    const r = await initialize(b, 1);
    assert.equal(r.result.protocolVersion, 1);
    assert.equal(r.result.agentInfo.version, '0.2.0');
    assert.equal(r.result.agentCapabilities.loadSession, true);
  });
});

test('session/new：响应携带 models/modes/configOptions；config option 为 v1 平铺形状', async () => {
  // off：只留 manual+live 两层（都在 new-provider 下）→ 单 provider 平铺，专测 wire 形状
  await withBridge({ env: { BRIDGE_MODELS: 'kimi-k3@low', BRIDGE_DEFAULT_MODEL: 'kimi-k3@low', BRIDGE_CONFIG_MODELS: 'off' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    assert.ok(r.result.sessionId, 'sessionId');
    // v0.1 兼容层 models 块仍在（MindFS 消费）
    assert.ok(r.result.models.availableModels.length >= 1);
    assert.ok(r.result.models.availableModels[0].modelId.includes(SEP));
    // v0.1 兼容层 modes 块仍在
    assert.equal(r.result.modes.availableModes.length, 5);
    assert.equal(r.result.modes.currentModeId, 'yolo'); // allow 档默认切 yolo
    // v0.2 configOptions：平铺 type（无 kind 嵌套）
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.ok(model, 'model config option');
    assert.equal(model.type, 'select');
    assert.equal(model.category, 'model');
    assert.equal(model.currentValue, `new-provider${SEP}kimi-k3`); // 默认模型（无 level 视图）
    assert.equal(model.options[0].value, `new-provider${SEP}kimi-k3`); // 手动层排最前
    // 思考深度选项（默认 settings 有 low/high/max，current max）
    const effort = r.result.configOptions.find(o => o.id === 'reasoning_effort');
    assert.ok(effort, 'thought level option');
    assert.equal(effort.currentValue, 'max');
    assert.deepEqual(effort.options.map(o => o.value), ['low', 'high', 'max']);
  });
});

test('session/new：预响应宣告 /compact 命令（name+description 必填）', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    const cmd = findUpdate(b, u => u.sessionUpdate === 'available_commands_update');
    assert.ok(cmd, 'available_commands_update pushed');
    assert.equal(cmd.availableCommands[0].name, 'compact'); // ACP v1 必填字段名（"commands" 会被 codeg 静默丢帧）
    assert.ok(cmd.availableCommands[0].description && cmd.availableCommands[0].description.length > 0, 'description required');
    assert.ok(r.result.sessionId);
  });
});

test('config 层清单：多 provider 走服务端分组（group 字段），排序 providerOrder→modelOrder→其余，top:N 截断', async () => {
  await withBridge({ env: { BRIDGE_CONFIG_MODELS: 'top:3' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    const model = r.result.configOptions.find(o => o.id === 'model');
    // live 层（new-provider/cn:glm-5.3-flash）+ 配置层 3 个（p-b 先：model-b1,model-b2；p-a: model-a2）
    assert.ok(Array.isArray(model.options) && model.options[0].group !== undefined, 'grouped options');
    const groups = Object.fromEntries(model.options.map(g => [g.group, g]));
    assert.equal(groups['new-provider'].name, '新供应商');
    assert.equal(groups['p-b'].name, '供应商B');
    assert.equal(groups['p-b'].options.length, 2);
    assert.equal(groups['p-b'].options[0].value, `p-b${SEP}model-b1`);
    assert.equal(groups['p-a'].options[0].value, `p-a${SEP}model-a2`); // modelOrder 优先
    assert.ok(groups['new-provider'].options.some(o => o.value === `new-provider${SEP}cn:glm-5.3-flash`));
    // 共 1 live + 3 config = 4 行
    const total = model.options.reduce((n, g) => n + g.options.length, 0);
    assert.equal(total, 4);
  });
});

test('config 层清单：单 provider 平铺、BRIDGE_CONFIG_MODELS=off 关闭、value 去重', async () => {
  const cfg = {
    schemaVersion: 1,
    config: { providerConfigRules: { providerRules: [{ providerId: 'new-provider', providerName: '新供应商', config: { personalModelIds: ['cn:glm-5.3-flash', 'kimi-k3'] } }] } },
  };
  await withBridge({ providerConfig: cfg, env: { BRIDGE_CONFIG_MODELS: 'off' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.ok(model.options.every(o => o.value !== undefined && o.group === undefined), 'flat options');
    // off：只有 live 层 1 条
    assert.equal(model.options.length, 1);
    assert.equal(model.options[0].value, `new-provider${SEP}cn:glm-5.3-flash`);
  });
  // all：live + config（去重后 2 条）
  await withBridge({ providerConfig: cfg, env: { BRIDGE_CONFIG_MODELS: 'all' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.equal(model.options.length, 2); // cn:glm-5.3-flash 去重合并
  });
});

test('provider_config.json 缺失/损坏：降级 manual+live 两层', async () => {
  await withBridge({ providerConfig: null }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.equal(model.options.length, 1);
  });
  await withBridge({ providerConfig: { broken: true } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.equal(model.options.length, 1);
  });
});

test('set_config_option model → zcode setModel（model 对象形状）+ 应答带完整清单 + currentValue 更新', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const nr = await b.responseFor(2);
    const sid = nr.result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `new-provider${SEP}cn:glm-5.3-flash` });
    const r = await b.responseFor(3);
    assert.ok(r.result.configOptions, 'response carries full configOptions list');
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.equal(model.currentValue, `new-provider${SEP}cn:glm-5.3-flash`);
    const actions = await b.actions();
    const setModel = actions.find(a => a.method === 'session/setModel');
    assert.ok(setModel, 'setModel called');
    assert.deepEqual(setModel.params.model, { providerId: 'new-provider', modelId: 'cn:glm-5.3-flash' });
  });
});

test('set_config_option 兼容带 level 的旧值（level 转为 options.reasoningLevel）', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `new-provider${SEP}cn:glm-5.3-flash${SEP}low` });
    const r = await b.responseFor(3);
    assert.ok(r.result.configOptions);
    const setModel = (await b.actions()).find(a => a.method === 'session/setModel');
    assert.deepEqual(setModel.params.model, { providerId: 'new-provider', modelId: 'cn:glm-5.3-flash', options: { reasoningLevel: 'low' } });
    // currentValue 保持用户所选值
    assert.equal(r.result.configOptions.find(o => o.id === 'model').currentValue, `new-provider${SEP}cn:glm-5.3-flash`);
  });
});

test('set_config_option：模型强制 reasoning 级别时回落 low，不失败', async () => {
  await withBridge({ env: { MOCK_FAIL_SETMODEL_NO_LEVEL: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `new-provider${SEP}cn:glm-5.3-flash` });
    const r = await b.responseFor(3);
    assert.ok(r.result.configOptions, 'fallback to low succeeded');
    const actions = await b.actions();
    const setModels = actions.filter(a => a.method === 'session/setModel');
    assert.equal(setModels.length, 2);
    assert.deepEqual(setModels[1].params.model.options, { reasoningLevel: 'low' });
  });
});

test('set_config_option：registry 不存在的模型 → 错误回给宿主（不死会话）', async () => {
  await withBridge({ env: { MOCK_SETMODEL_REGISTRY_FAIL: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `new-provider${SEP}nope` });
    const r = await b.responseFor(3);
    assert.ok(r.error, 'error propagated');
    assert.equal(r.error.code, -32603);
    // 会话仍可用
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] });
    const p = await b.responseFor(4);
    assert.equal(p.result.stopReason, 'end_turn');
  });
});

test('set_config_option reasoning_effort → zcode setThoughtLevel', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'low' });
    const r = await b.responseFor(3);
    const effort = r.result.configOptions.find(o => o.id === 'reasoning_effort');
    assert.equal(effort.currentValue, 'low');
    const actions = await b.actions();
    const stl = actions.find(a => a.method === 'session/setThoughtLevel');
    assert.deepEqual(stl.params, { sessionId: sid, thoughtLevel: 'low' });
  });
});

test('configOptions 含 mode 选项；set_config_option mode → zcode setMode（codeg 模式选择器补位）', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const nr = await b.responseFor(2);
    const sid = nr.result.sessionId;
    // 建立：codeg 有 configOptions 时不渲染 modes 选择器（UI 互斥），mode 必须以 configOption 补位
    const modeOpt = nr.result.configOptions.find(o => o.id === 'mode');
    assert.ok(modeOpt, 'mode config option present');
    assert.equal(modeOpt.category, 'mode');
    assert.ok(modeOpt.options.length >= 4, 'all bridge modes offered');
    // 切模式走 set_config_option → zcode setMode，应答清单 currentValue 跟随
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'mode', value: 'plan' });
    const r = await b.responseFor(3);
    assert.equal(r.result.configOptions.find(o => o.id === 'mode').currentValue, 'plan');
    const actions = await b.actions();
    const sm = actions.filter(a => a.method === 'session/setMode').pop();
    assert.equal(sm.params.mode, 'plan');
  });
});

test('session/set_model（v0.1 MindFS 契约）→ zcode setModel，provider␟model 解码', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_model', { sessionId: sid, modelId: `new-provider${SEP}cn:glm-5.3-flash` });
    const r = await b.responseFor(3);
    assert.ok(r.result, 'set_model succeeds (no -32601)');
    const actions = await b.actions();
    const setModel = actions.filter(a => a.method === 'session/setModel').pop();
    assert.ok(setModel, 'setModel called');
    assert.deepEqual(setModel.params.model, { providerId: 'new-provider', modelId: 'cn:glm-5.3-flash' });
    // models 块 currentModelId 跟随（MindFS 下拉标在用模型）
    b.request(4, 'session/load', { sessionId: sid, cwd: '/tmp' });
    const lr = await b.responseFor(4);
    assert.equal(lr.result.models.currentModelId, `new-provider${SEP}cn:glm-5.3-flash`);
  });
});

test('BRIDGE_CONFIG_OPTIONS=off（v0.1 兼容档）：无 configOptions 键、无推送、/compact 不拦截', async () => {
  await withBridge({ env: { BRIDGE_CONFIG_OPTIONS: 'off' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const nr = await b.responseFor(2);
    assert.ok(!('configOptions' in nr.result), 'no configOptions key in session/new result');
    const sid = nr.result.sessionId;
    // /compact 不再被拦截：作为普通 prompt 直通 zcode（v0.1 语义）
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    const pr = await b.responseFor(3);
    assert.equal(pr.result.stopReason, 'end_turn');
    const actions = await b.actions();
    assert.ok(actions.some(a => a.method === 'session/send' && /\/compact/.test(a.params.content || '')), '/compact went through as regular prompt');
    assert.ok(!actions.some(a => a.method === 'session/compact'), 'no session/compact call');
    // 无新增通知类型：available_commands_update / config_option_update 都不发
    const kinds = b.stdout.filter(m => m.method === 'session/update').map(m => m.params?.update?.sessionUpdate);
    assert.ok(!kinds.includes('available_commands_update'), 'no advertised commands');
    assert.ok(!kinds.includes('config_option_update'), 'no config option pushes');
  });
});

test('set_config_option：boolean 形状拒绝、未知 configId -32602、value 缺失 -32602', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'fast_mode', type: 'boolean', value: true });
    assert.equal((await b.responseFor(3)).error.code, -32602);
    b.request(4, 'session/set_config_option', { sessionId: sid, configId: 'unknown_thing', value: 'x' });
    assert.equal((await b.responseFor(4)).error.code, -32602);
    b.request(5, 'session/set_config_option', { sessionId: sid, configId: 'model', value: '' });
    assert.equal((await b.responseFor(5)).error.code, -32602);
  });
});

test('并发 set_config_option 串行落盘（两笔按到达顺序到 zcode）', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `new-provider${SEP}cn:glm-5.3-flash` });
    b.request(4, 'session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'high' });
    await b.responseFor(3);
    await b.responseFor(4);
    const actions = await b.actions();
    const iModel = actions.findIndex(a => a.method === 'session/setModel');
    const iTl = actions.findIndex(a => a.method === 'session/setThoughtLevel');
    assert.ok(iModel >= 0 && iTl > iModel, 'ordered: setModel before setThoughtLevel');
  });
});

test('/compact：拦截 → zcode session/compact → in_progress/completed 卡片 → end_turn', async () => {
  await withBridge({ env: { MOCK_COMPACT_PART: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    const r = await b.responseFor(3);
    assert.equal(r.result.stopReason, 'end_turn');
    const inprog = findUpdate(b, u => u.sessionUpdate === 'compaction_update' && u.status === 'in_progress');
    const done = findUpdate(b, u => u.sessionUpdate === 'compaction_update' && u.status === 'completed');
    assert.ok(inprog && done, 'both cards pushed');
    assert.equal(done.compactionId, inprog.compactionId);
    assert.match(done.compactionId, /^zcode-compact-\d+$/);
    assert.equal(done._meta.contextCompaction.version, 1);
    assert.equal(done._meta.contextCompaction.trigger, 'manual');
    assert.equal(done._meta.contextCompaction.preTokens, 12000);
    assert.equal(done._meta.contextCompaction.postTokens, 3000);
    const actions = await b.actions();
    const comp = actions.find(a => a.method === 'session/compact');
    assert.deepEqual(comp.params, { sessionId: sid });
    // 不应直通 session/send
    assert.ok(!actions.some(a => a.method === 'session/send'), 'compact intercepted, no session/send');
  });
});

test('/compact 带指示文字 → instructions 透传', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact 保留 ADR 决策' }] });
    await b.responseFor(3);
    const comp = (await b.actions()).find(a => a.method === 'session/compact');
    assert.equal(comp.params.instructions, '保留 ADR 决策');
  });
});

test('/compact 在 prompt 进行中 → 拒绝（忙闸）', async () => {
  await withBridge({ env: { MOCK_TURN_DELAY_MS: 400 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'long turn' }] });
    b.request(4, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    const r4 = await b.responseFor(4);
    assert.ok(r4.error && /already in flight/.test(r4.error.message));
    await b.responseFor(3);
  });
});

test('/compact zcode 侧失败 → compaction failed 不发 + ACP error', async () => {
  await withBridge({ env: { MOCK_COMPACT_FAILS: '1' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    const r = await b.responseFor(3);
    assert.ok(r.error && /session\/compact failed/.test(r.error.message));
    assert.ok(!findUpdate(b, u => u.sessionUpdate === 'compaction_update'), 'no cards when compact rejected');
  });
});

test('session/cancel 在压缩中 → failed 卡（不用 cancelled 状态）+ stopReason cancelled', async () => {
  await withBridge({ env: { MOCK_TURN_DELAY_MS: 400 } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    // in_progress 卡到达后取消
    await b.waitFor(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'compaction_update' && m.params.update.status === 'in_progress');
    b.notify('session/cancel', { sessionId: sid });
    const r = await b.responseFor(3);
    assert.equal(r.result.stopReason, 'cancelled');
    const failed = findUpdate(b, u => u.sessionUpdate === 'compaction_update' && u.status === 'failed');
    assert.ok(failed, 'failed card pushed');
    assert.equal(failed.error, 'cancelled by user');
    // stop 请求与响应赛跑：轮询 actions 文件直到出现（mock 记录先于应答，但桥收口可能更快）
    let stop = null;
    for (let i = 0; i < 40 && !stop; i++) {
      await new Promise(r => setTimeout(r, 50));
      stop = (await b.actions()).find(a => a.method === 'session/stop');
    }
    assert.ok(stop, 'zcode stop called');
  });
});

test('/compact 关闭（BRIDGE_COMPACT=off）：不宣告命令，/compact 直通 zcode 普通消息', async () => {
  await withBridge({ env: { BRIDGE_COMPACT: 'off' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    assert.ok(!findUpdate(b, u => u.sessionUpdate === 'available_commands_update'), 'no advertised commands');
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '/compact' }] });
    await b.responseFor(3);
    const actions = await b.actions();
    assert.ok(actions.some(a => a.method === 'session/send' && a.params.content === '/compact'));
    assert.ok(!actions.some(a => a.method === 'session/compact'));
  });
});

test('BRIDGE_THOUGHT_LEVEL=off：不暴露思考深度选项', async () => {
  await withBridge({ env: { BRIDGE_THOUGHT_LEVEL: 'off' } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const r = await b.responseFor(2);
    assert.ok(!r.result.configOptions.some(o => o.id === 'reasoning_effort'));
    assert.ok(r.result.configOptions.some(o => o.id === 'model'));
  });
});

test('普通 prompt 直通 + 工具卡映射 + turn 文本流', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] });
    const r = await b.responseFor(3);
    assert.equal(r.result.stopReason, 'end_turn');
    const chunk = findUpdate(b, u => u.sessionUpdate === 'agent_message_chunk');
    assert.ok(chunk && chunk.content.text.includes('echo:'));
    const send = (await b.actions()).find(a => a.method === 'session/send');
    assert.equal(send.params.content, 'hello\nworld');
  });
});

test('session/load：历史回放（user/assistant/tool）在响应前，config_option_update 在响应后', async () => {
  const resumeMsgs = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: '问题A' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: '回答A' }, { type: 'tool', toolCallId: 'tc1', toolName: 'read', state: { status: 'completed', title: 'Read file', input: {} } }] },
  ];
  const dir = (await import('node:os')).tmpdir();
  const f = join(dir, `zab-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(resumeMsgs));
  await withBridge({ env: { MOCK_RESUME_MESSAGES_FILE: f } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/load', { cwd: '/tmp', sessionId: 'sess_mock_1' });
    const r = await b.responseFor(2);
    assert.ok(r.result.models && r.result.modes);
    const userChunk = findUpdate(b, u => u.sessionUpdate === 'user_message_chunk');
    const agentChunk = findUpdate(b, u => u.sessionUpdate === 'agent_message_chunk' && u.content?.text === '回答A');
    const tool = findUpdate(b, u => u.sessionUpdate === 'tool_call' && u.toolCallId === 'tc1');
    assert.ok(userChunk && agentChunk && tool, 'history replayed');
    assert.equal(tool.kind, 'read');
    assert.equal(tool.status, 'completed');
    // 响应后异步落笔：waitFor（响应已到，此刻出现的 config_option_update 必然是响应后推送）
    await b.waitFor(m => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'config_option_update', 5000, 'config options after load');
  });
});

test('畸形 JSON 行被忽略、未知方法 -32601、未声明 session 的 set_config_option 报 unknown', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.proc.stdin.write('not-json-garbage\n\n');
    b.request(2, 'some/unknown/method', {});
    const r = await b.responseFor(2);
    assert.equal(r.error.code, -32601);
    b.request(3, 'session/set_config_option', { sessionId: 'nope', configId: 'model', value: 'x' });
    assert.match((await b.responseFor(3)).error.message, /unknown session/);
  });
});

test('stderr 纪律：全程不输出 code+message 形状行', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'x' }] });
    await b.responseFor(3);
    b.request(4, 'session/set_config_option', { sessionId: sid, configId: 'model', value: 'bad-value-no-sep' });
    await b.responseFor(4);
    await new Promise(r => setTimeout(r, 100));
    const bad = b.stderr.split('\n').filter(l => /"code"\s*:/.test(l) && /"message"\s*:/.test(l));
    assert.equal(bad.length, 0, `stderr discipline violated: ${JSON.stringify(bad)}`);
  });
});

test('zcode 子进程被杀：在飞 prompt 以 end_turn 收口 + 提示 chunk', async () => {
  // pid 文件精准定位本桥 spawn 的 mock：pgrep -f 会误杀并行测试文件（murphy）的 mock 实例
  const pidFile = join(tmpdir(), `mock-zcode-pid-${process.pid}-${Date.now()}`);
  await withBridge({ env: { MOCK_TURN_DELAY_MS: 100000, MOCK_PID_FILE: pidFile } }, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    b.request(3, 'session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'x' }] });
    // 等 send 真正到达 mock（turn 在飞）再杀：杀早了会被透明 respawn 接管，测不到"子进程死亡收口"路径
    for (let i = 0; i < 200; i++) {
      if ((await b.actions()).some(a => a.method === 'session/send')) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'valid pid');
    try { process.kill(pid, 'SIGKILL'); } catch {}
    const r = await b.responseFor(3);
    assert.equal(r.result.stopReason, 'end_turn');
    const chunk = findUpdate(b, u => u.sessionUpdate === 'agent_message_chunk' && /进程退出/.test(u.content?.text || ''));
    assert.ok(chunk, 'exit notice chunk');
  });
});

test('set_config_option 值不在清单：仍透传 zcode 校验（宿主偏好回放路径）', async () => {
  await withBridge({}, async (b) => {
    await initialize(b, 1);
    b.request(2, 'session/new', { cwd: '/tmp' });
    const sid = (await b.responseFor(2)).result.sessionId;
    // 合法编码但不在当前清单的模型 → zcode registry 校验（mock 接受）→ 成功
    b.request(3, 'session/set_config_option', { sessionId: sid, configId: 'model', value: `other-provider${SEP}m9` });
    const r = await b.responseFor(3);
    assert.ok(r.result.configOptions, 'accepted via zcode registry validation');
    const model = r.result.configOptions.find(o => o.id === 'model');
    assert.equal(model.currentValue, `other-provider${SEP}m9`);
    // 当前模型兜底入选清单（默认夹具多 provider → 分组，扁平化后查）
    const flat = model.options.flatMap(o => (o.group ? o.options : [o]));
    assert.ok(flat.some(o => o.value === `other-provider${SEP}m9`));
  });
});
