/**
 * 服务端记忆的浏览器偏好（批v91）。
 *
 * 悬浮球手势等设置原本只存 localStorage——清站点数据、换浏览器、换设备即失忆，
 * 三台服务器各自配一遍。这里把白名单块以不透明 JSON 字符串存进服务端
 * （app_metadata KV，schema 归前端管），web 前端在 hydration 后：
 *   1) 服务端有 & 本地无 → 播种 localStorage（换浏览器/清 Cookie 自愈）；
 *   2) 服务端无 & 本地有 → 本地首发上收（第一台配置过的浏览器变种子）；
 *   3) 两边都有 → synced_at_ms 新者胜（写入本地）。
 * 之后任何白名单 setter 变更都会 debounce 双写到服务端。
 *
 * 降级：404 / 网络失败 / 桌面 Tauri 模式一律静默跳过——桌面端本来就单机，
 * 老服务端不该被新前端打死。
 */

import { getTransport } from "@/lib/transport"

// 与 appearance-script.ts 的 key 一一对应（悬浮球 5 件套）。
const SYNCED_KEYS = [
  "codeg-floating-ball-enabled",
  "codeg-floating-ball-position",
  "codeg-floating-ball-bindings",
  "codeg-floating-ball-size",
  "codeg-floating-ball-favorite-agents",
] as const

const DEBOUNCE_MS = 800

export interface ServerPrefsSnapshot {
  /** 不透明 JSON 字符串：{ keys: Record<key, string>, syncedAtMs } */
  blob: string
  syncedAtMs: number
}

interface BlobShape {
  keys?: Record<string, string>
  syncedAtMs?: number
}

function readLocalBlock(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SYNCED_KEYS) {
    try {
      const v = localStorage.getItem(key)
      if (v !== null) out[key] = v
    } catch {
      // storage 被禁（隐私模式）时视为空：服务端有就播种，播种失败也无害。
    }
  }
  return out
}

function writeLocalBlock(keys: Record<string, string>): void {
  for (const key of SYNCED_KEYS) {
    try {
      const v = keys[key]
      if (v === undefined) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, v)
      }
    } catch {
      // 同上：播不进去就放弃，本次会话仍可用内存态。
    }
  }
}

function parseBlob(blob: string): BlobShape | null {
  if (!blob) return null
  try {
    const parsed: unknown = JSON.parse(blob)
    if (typeof parsed !== "object" || parsed === null) return null
    const shape = parsed as BlobShape
    if (typeof shape.keys !== "object" || shape.keys === null) return null
    return shape
  } catch {
    return null
  }
}

export function buildLocalBlob(syncedAtMs: number): string {
  return JSON.stringify({ keys: readLocalBlock(), syncedAtMs })
}

/// GET 服务端偏好；老服务端（404）返回 null（=无服务端记忆）。
export async function fetchServerPrefs(): Promise<ServerPrefsSnapshot | null> {
  const transport = getTransport()
  try {
    const res = await transport.call<{
      prefs: string
      synced_at_ms: number
      supported: boolean
    }>("get_client_preferences")
    if (!res?.supported) return null
    return { blob: res.prefs ?? "", syncedAtMs: res.synced_at_ms ?? 0 }
  } catch {
    // 404（老服务端）或网络失败：无服务端记忆，静默。
    return null
  }
}

/// 本机上次与服务端对齐的墙钟（毫秒）。两边都有数据时靠它判谁新——否则
/// "服务端有值就覆盖本地"会把刚改完、还没等 debounce 上收的本地改动吞掉。
const LOCAL_MS_KEY = "codeg-client-prefs-synced-at"

function readLocalMs(): number {
  try {
    const raw = localStorage.getItem(LOCAL_MS_KEY)
    const n = raw === null ? 0 : Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function writeLocalMs(ms: number): void {
  try {
    localStorage.setItem(LOCAL_MS_KEY, String(ms))
  } catch {
    // 写不进去只影响"谁新"的判定，下一次上收会重新对齐。
  }
}

/// PUT 服务端偏好。失败静默（下一轮变更会再试）；成功才记本机对齐时间。
export async function pushServerPrefs(
  blob: string,
  syncedAtMs: number = Date.now()
): Promise<void> {
  try {
    await getTransport().call("update_client_preferences", {
      prefs: blob,
      synced_at_ms: syncedAtMs,
    })
    writeLocalMs(syncedAtMs)
  } catch {
    // 静默：服务端不可达不影响本机使用。
  }
}

/**
 * hydration 对账：决定谁是种子并落本地。返回是否播了种（调用方据此刷新
 * React 状态）。
 */
export function reconcileFromServer(
  server: ServerPrefsSnapshot | null
): "seeded" | "pushed" | "none" {
  if (!server) return "none"
  const shape = parseBlob(server.blob)
  const local = readLocalBlock()
  const localEmpty = Object.keys(local).length === 0
  const serverKeys = shape?.keys ?? {}
  const serverEmpty = Object.keys(serverKeys).length === 0
  const serverMs = shape?.syncedAtMs ?? 0

  if (serverEmpty && localEmpty) return "none"
  if (serverEmpty && !localEmpty) {
    // 首发上收：本浏览器是种子。
    void pushServerPrefs(buildLocalBlob(Date.now()))
    return "pushed"
  }
  if (localEmpty && !serverEmpty) {
    // 播种：服务端是记忆源。
    writeLocalBlock(serverKeys)
    writeLocalMs(serverMs)
    return "seeded"
  }
  // 两边都有：按墙钟新者胜。本机没记过对齐时间 = 这份本地配置早于服务端记忆
  // （功能上线前就存在），服务端才是权威；否则谁新谁赢。
  const localMs = readLocalMs()
  if (serverMs > 0 && serverMs >= localMs) {
    writeLocalBlock(serverKeys)
    writeLocalMs(serverMs)
    return "seeded"
  }
  void pushServerPrefs(buildLocalBlob(Date.now()))
  return "pushed"
}

/// 白名单内容指纹（不含墙钟）：去重与"回声"判断都看它。
function localKeysFingerprint(): string {
  const local = readLocalBlock()
  const sorted: Record<string, string> = {}
  for (const key of Object.keys(local).sort()) sorted[key] = local[key]
  return JSON.stringify(sorted)
}

/**
 * 变更双写：白名单任一 key 变化后调用。800ms debounce（拖动悬浮球会连发），
 * 内容相同则跳过（storage 回声 / 无实质变化不 PUT）。
 *
 * 去重比的是**内容**，不含墙钟：把 syncedAtMs 也算进快照会让每次比较都不同，
 * 去重直接失效，服务端会收到一串内容一样的 PUT。
 */
export function createPrefsPusher() {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPushedKeys: string | null = null

  const flush = () => {
    timer = null
    const keys = localKeysFingerprint()
    if (keys === lastPushedKeys) return
    lastPushedKeys = keys
    const now = Date.now()
    void pushServerPrefs(buildLocalBlob(now), now)
  }

  return {
    schedule() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, DEBOUNCE_MS)
    },
    /// 快照基线：播种后调用，防止把刚从服务端收到的值再推回去（回声）。
    /// 不动本机对齐时间——播种时服务端那个 ms 才是真值。
    markSynced() {
      lastPushedKeys = localKeysFingerprint()
    },
  }
}

/// 白名单 key 判断（storage 事件监听用：远端窗口的变更不回推服务端，避免
/// 双窗口乒乓；服务端扇出另有对账件负责）。
export function isSyncedKey(key: string): boolean {
  return (SYNCED_KEYS as readonly string[]).includes(key)
}
