import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
}))

import {
  buildLocalBlob,
  createPrefsPusher,
  fetchServerPrefs,
  reconcileFromServer,
} from "./client-prefs-sync"

const BALL_ENABLED = "codeg-floating-ball-enabled"
const BALL_BINDINGS = "codeg-floating-ball-bindings"

function serverSnapshot(
  keys: Record<string, string>,
  syncedAtMs: number
): { blob: string; syncedAtMs: number } {
  return {
    blob: JSON.stringify({ keys, syncedAtMs }),
    syncedAtMs,
  }
}

beforeEach(() => {
  localStorage.clear()
  call.mockReset()
  call.mockResolvedValue({ prefs: "", synced_at_ms: 0, supported: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("fetchServerPrefs", () => {
  it("treats a server that predates the endpoint as having no memory", async () => {
    call.mockResolvedValue({ prefs: "", synced_at_ms: 0, supported: false })
    await expect(fetchServerPrefs()).resolves.toBeNull()
  })

  it("swallows transport failures", async () => {
    call.mockRejectedValue(new Error("404"))
    await expect(fetchServerPrefs()).resolves.toBeNull()
  })

  it("passes the served blob through untouched", async () => {
    const blob = JSON.stringify({ keys: { a: "1" }, syncedAtMs: 5 })
    call.mockResolvedValue({ prefs: blob, synced_at_ms: 5, supported: true })
    await expect(fetchServerPrefs()).resolves.toEqual({
      blob,
      syncedAtMs: 5,
    })
  })
})

describe("reconcileFromServer", () => {
  it("seeds an empty browser from the server", () => {
    const outcome = reconcileFromServer(
      serverSnapshot({ [BALL_ENABLED]: "1", [BALL_BINDINGS]: "{}" }, 1000)
    )
    expect(outcome).toBe("seeded")
    expect(localStorage.getItem(BALL_ENABLED)).toBe("1")
    expect(localStorage.getItem(BALL_BINDINGS)).toBe("{}")
  })

  it("pushes local state up when the server has nothing", () => {
    localStorage.setItem(BALL_ENABLED, "1")
    expect(reconcileFromServer(serverSnapshot({}, 0))).toBe("pushed")
    expect(call).toHaveBeenCalledTimes(1)
    const [method, params] = call.mock.calls[0]
    expect(method).toBe("update_client_preferences")
    expect(JSON.parse(params.prefs).keys[BALL_ENABLED]).toBe("1")
  })

  it("does nothing when both sides are empty", () => {
    expect(reconcileFromServer(serverSnapshot({}, 0))).toBe("none")
    expect(call).not.toHaveBeenCalled()
  })

  it("prefers the server when the local copy was never stamped", () => {
    // A browser configured before the server kept any memory: the server's copy
    // is the shared source of truth, the local one predates it.
    localStorage.setItem(BALL_ENABLED, "0")
    const outcome = reconcileFromServer(
      serverSnapshot({ [BALL_ENABLED]: "1" }, 1000)
    )
    expect(outcome).toBe("seeded")
    expect(localStorage.getItem(BALL_ENABLED)).toBe("1")
  })

  it("keeps a local change that is newer than the server copy", () => {
    // Regression: the first cut wrote the server blob over local state whenever
    // the server had one, so a change made less than one debounce window before
    // a reload was silently rolled back.
    localStorage.setItem(BALL_ENABLED, "0")
    localStorage.setItem("codeg-client-prefs-synced-at", "2000")
    const outcome = reconcileFromServer(
      serverSnapshot({ [BALL_ENABLED]: "1" }, 1000)
    )
    expect(outcome).toBe("pushed")
    expect(localStorage.getItem(BALL_ENABLED)).toBe("0")
    expect(JSON.parse(call.mock.calls[0][1].prefs).keys[BALL_ENABLED]).toBe("0")
  })

  it("takes the server copy when it is newer than the local stamp", () => {
    localStorage.setItem(BALL_ENABLED, "0")
    localStorage.setItem("codeg-client-prefs-synced-at", "1000")
    const outcome = reconcileFromServer(
      serverSnapshot({ [BALL_ENABLED]: "1" }, 2000)
    )
    expect(outcome).toBe("seeded")
    expect(localStorage.getItem(BALL_ENABLED)).toBe("1")
  })
})

describe("createPrefsPusher", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("debounces a burst of changes into one write", () => {
    const pusher = createPrefsPusher()
    localStorage.setItem(BALL_ENABLED, "1")
    pusher.schedule()
    localStorage.setItem(BALL_BINDINGS, '{"tap":"newConversation"}')
    pusher.schedule()
    vi.advanceTimersByTime(900)
    expect(call).toHaveBeenCalledTimes(1)
    expect(JSON.parse(call.mock.calls[0][1].prefs).keys[BALL_BINDINGS]).toBe(
      '{"tap":"newConversation"}'
    )
  })

  it("skips a write when the content did not change", () => {
    // Regression: the dedupe compared blobs that embed Date.now(), so every
    // comparison differed and identical content was re-pushed forever.
    const pusher = createPrefsPusher()
    localStorage.setItem(BALL_ENABLED, "1")
    pusher.markSynced()
    pusher.schedule()
    vi.advanceTimersByTime(900)
    expect(call).not.toHaveBeenCalled()
  })

  it("records the stamp it pushed so a reload does not roll the change back", async () => {
    const pusher = createPrefsPusher()
    localStorage.setItem(BALL_ENABLED, "1")
    pusher.schedule()
    vi.advanceTimersByTime(900)
    const pushedAt = call.mock.calls[0][1].synced_at_ms as number
    await Promise.resolve()
    expect(localStorage.getItem("codeg-client-prefs-synced-at")).toBe(
      String(pushedAt)
    )
  })
})

describe("buildLocalBlob", () => {
  it("carries only whitelisted keys", () => {
    localStorage.setItem(BALL_ENABLED, "1")
    localStorage.setItem("unrelated-key", "x")
    const parsed = JSON.parse(buildLocalBlob(7))
    expect(parsed).toEqual({ keys: { [BALL_ENABLED]: "1" }, syncedAtMs: 7 })
  })
})
