import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { McpWatchdog, McpWatchdogPlugin } from "../dist/index.js"

const PROBE_ERR = "Operation timed out after 30000ms while listing tools"

/** Build a mock opencode client with scripted mcp.status responses. */
function makeClient(scripts, { onConnect, toastFails = true } = {}) {
  const calls = { status: 0, connectOrder: [], maxActive: 0, active: 0, logs: [], toasts: [] }
  let i = 0
  const client = {
    mcp: {
      status: async () => {
        calls.status++
        const s = scripts[Math.min(i++, scripts.length - 1)]
        if (s instanceof Error) throw s
        return { data: s }
      },
      connect: async ({ path: { name } }) => {
        calls.active++
        calls.maxActive = Math.max(calls.maxActive, calls.active)
        calls.connectOrder.push(name)
        try {
          await new Promise((r) => setTimeout(r, 5))
          if (onConnect) await onConnect(name)
        } finally {
          calls.active--
        }
        return {}
      },
    },
    tui: {
      showToast: async ({ body }) => {
        calls.toasts.push(body)
        if (toastFails) throw new Error("no TUI attached")
      },
    },
    app: {
      log: async ({ body }) => {
        calls.logs.push(body)
      },
    },
  }
  return { client, calls }
}

async function loadPlugin(client) {
  const plugin = await McpWatchdog({ client })
  return plugin.tool.mcp_watchdog.execute
}

const allConnected = () => ({ git: { status: "connected" } })

describe("plugin exports", () => {
  it("exposes the standard Plugin-suffixed name with a backwards-compatible alias", async () => {
    assert.equal(typeof McpWatchdogPlugin, "function")
    assert.equal(McpWatchdog, McpWatchdogPlugin)
  })
})

describe("mcp_watchdog reconnect", () => {
  it("heals failed servers one at a time (no parallel npx herd)", async () => {
    const before = {
      a: { status: "failed" },
      b: { status: "failed" },
      c: { status: "failed" },
    }
    const { client, calls } = makeClient([
      before,
      { a: { status: "connected" }, b: { status: "connected" }, c: { status: "connected" } },
    ])
    const execute = await loadPlugin(client)
    const out = await execute({ action: "reconnect" })

    assert.deepEqual(calls.connectOrder, ["a", "b", "c"])
    assert.equal(calls.maxActive, 1)
    assert.match(out, /Reconnected: a, b, c/)
  })

  it("never retries needs_auth, disabled, or already-connected servers", async () => {
    const before = {
      ok: { status: "connected" },
      auth: { status: "needs_auth" },
      off: { status: "disabled" },
      dead: { status: "failed" },
    }
    const { client, calls } = makeClient([before, allConnected()])
    const execute = await loadPlugin(client)
    await execute({ action: "reconnect" })

    assert.deepEqual(calls.connectOrder, ["dead"])
  })

  it("reports unknown states under other instead of dropping them", async () => {
    const state = { git: { status: "connected" }, ctx: { status: "connecting" } }
    const { client, calls } = makeClient([state, state])
    const execute = await loadPlugin(client)
    await execute({ action: "reconnect" })

    assert.match(calls.logs.at(-1).message, /other: ctx \(connecting\)/)
  })

  it("always runs an explicit reconnect (bypasses the cooldown)", async () => {
    const { client, calls } = makeClient([allConnected()])
    const execute = await loadPlugin(client)
    await execute({ action: "reconnect" })
    const second = await execute({ action: "reconnect" })

    assert.equal(calls.status, 4) // two full passes, two probes each
    assert.doesNotMatch(second, /already running/)
  })

  it("labels a failed refresh probe as stale last-known data", async () => {
    const before = { fetch: { status: "failed", error: "boom" } }
    const { client, calls } = makeClient([before, new Error(PROBE_ERR)])
    const execute = await loadPlugin(client)
    await execute({ action: "reconnect" })

    assert.match(calls.logs.at(-1).message, /showing last-known/)
  })

  it("returns a friendly message (not a throw) when the initial probe fails", async () => {
    const { client } = makeClient([new Error(PROBE_ERR)])
    const execute = await loadPlugin(client)
    const out = await execute({ action: "reconnect" })

    assert.match(out, /Status probe failed.*retry in a few seconds/)
  })
})

describe("mcp_watchdog status", () => {
  it("lists servers with icons and truncated errors", async () => {
    const state = {
      git: { status: "connected" },
      fetch: { status: "failed", error: "e".repeat(200) },
    }
    const { client } = makeClient([state])
    const execute = await loadPlugin(client)
    const out = await execute({ action: "status" })

    assert.match(out, /✓ git - connected/)
    assert.match(out, /✗ fetch - failed/)
    assert.ok(out.length < 200, "long errors must be shortened")
  })

  it("returns a friendly message (not a throw) when the probe fails", async () => {
    const { client } = makeClient([new Error(PROBE_ERR)])
    const execute = await loadPlugin(client)
    const out = await execute({ action: "status" })

    assert.match(out, /Status probe failed.*retry in a few seconds/)
  })
})

describe("headless mode", () => {
  it("logs the summary at info level when no TUI is attached", async () => {
    const { client, calls } = makeClient([allConnected()])
    const execute = await loadPlugin(client)
    await execute({ action: "reconnect" })

    assert.equal(calls.logs.length, 1)
    assert.equal(calls.logs[0].service, "mcp-watchdog")
    assert.equal(calls.logs[0].level, "info")
    assert.match(calls.logs[0].message, /MCP watchdog \(manual\): 1\/1 connected/)
  })
})
