#!/usr/bin/env node
// 测试驱动：起一个桥实例（BRIDGE_ZCODE_BIN 指向 mock），提供收发与等待原语。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const BRIDGE = join(PKG, 'zcode-acp-bridge');
const MOCK = join(HERE, 'mock-zcode-server.mjs');

export async function startBridge(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zab-test-'));
  const actionsFile = join(dir, 'zcode-actions.jsonl');
  const logDir = join(dir, 'bridge-logs');
  const homeDir = join(dir, 'zhome');
  const shimPath = join(dir, 'zcode-shim');
  writeFileSync(shimPath, `#!/usr/bin/env bash\nexec node "${MOCK}"\n`, { mode: 0o755 });
  // 默认 provider_config 夹具：两个 provider（多分组场景）；单测可覆盖
  if (opts.providerConfig !== null) {
    const cfg = opts.providerConfig ?? {
      schemaVersion: 1,
      config: {
        providerOrder: ['p-b', 'p-a'],
        providerConfigRules: {
          providerRules: [
            { providerId: 'p-b', providerName: '供应商B', config: { personalModelIds: ['model-b1', 'model-b2'] } },
            { providerId: 'p-a', providerName: '供应商A', config: { modelOrder: ['model-a2'], personalModelIds: ['model-a1', 'model-a2', 'model-a3'] } },
          ],
        },
      },
    };
    mkdirSync(join(homeDir, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(homeDir, '.zcode', 'v2', 'provider_config.json'), JSON.stringify(cfg));
  }

  const env = {
    ...process.env,
    BRIDGE_ZCODE_BIN: shimPath,
    BRIDGE_ZCODE_HOME: homeDir,
    BRIDGE_LOG_DIR: logDir,
    MOCK_ACTIONS_FILE: actionsFile,
    ...(opts.env || {}),
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  openSync(actionsFile, 'a');
  // detached：桥自成进程组，关闭时整组杀（桥 + 它 spawn 的 mock zcode），不留孤儿
  const proc = spawn('node', [BRIDGE], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const state = {
    dir, actionsFile, logDir, homeDir, proc,
    stdout: [], stderr: '',
    waiters: [],
    closed: false,
    exitCode: null,
  };
  let sbuf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    sbuf += d;
    let i;
    while ((i = sbuf.indexOf('\n')) >= 0) {
      const line = sbuf.slice(0, i); sbuf = sbuf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      state.stdout.push(m);
      for (let i = state.waiters.length - 1; i >= 0; i--) {
        const w = state.waiters[i];
        if (w.pred(m)) {
          state.waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(m);
        }
      }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { state.stderr += d; });
  proc.on('exit', (code) => { state.closed = true; state.exitCode = code; });

  const api = {
    ...state,
    raw: (obj) => proc.stdin.write(JSON.stringify(obj) + '\n'),
    request: (id, method, params) => proc.stdin.write(JSON.stringify({ id, method, params }) + '\n'),
    notify: (method, params) => proc.stdin.write(JSON.stringify({ method, params }) + '\n'),
    waitFor: (pred, timeoutMs = 8000, label = 'message') => new Promise((resolve, reject) => {
      for (const m of state.stdout) if (pred(m)) return resolve(m);
      const w = { pred, resolve, timer: null };
      w.timer = setTimeout(() => {
        const idx = state.waiters.indexOf(w);
        if (idx >= 0) state.waiters.splice(idx, 1);
        reject(new Error(`waitFor timeout: ${label}; got ${JSON.stringify(state.stdout.slice(-6)).slice(0, 1200)}`));
      }, timeoutMs);
      state.waiters.push(w);
    }),
    responseFor: (id, timeoutMs = 8000) => api.waitFor(m => m.id === id && (m.result !== undefined || m.error !== undefined), timeoutMs, `response for ${id}`),
    actions: async () => {
      try {
        return readFileSync(actionsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      } catch { return []; }
    },
    close: async () => {
      if (state.closed) return state.exitCode;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
      await new Promise((r) => {
        if (state.closed) return r();
        const t = setTimeout(r, 3000);
        proc.on('exit', () => { clearTimeout(t); r(); });
      });
      return state.exitCode;
    },
  };
  return api;
}

export async function initialize(b, id = 1) {
  b.request(id, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  return b.responseFor(id);
}
