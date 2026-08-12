/**
 * SuperCompress TUI backend — real config, usage API, detector, proxy.
 */
import { createRequire } from "node:module"
import { spawn, execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fmt } from "./theme.ts"

const require = createRequire(import.meta.url)

export const PROXY_ROOT = path.resolve(import.meta.dir, "..")
export const VERSION = readProxyVersion()
export const CONFIG_DIR =
  process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(os.homedir(), ".supercompress")
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")
export const PID_PATH = path.join(CONFIG_DIR, "proxy.pid")
export const LOG_PATH = path.join(CONFIG_DIR, "proxy.log")
export const USAGE_URL = process.env.SUPERCOMPRESS_USAGE_URL || "https://www.supercompress.dev/api/usage"
export const ME_URL = process.env.SUPERCOMPRESS_ME_URL || "https://www.supercompress.dev/api/me"
export const ACTIVITY_URL =
  process.env.SUPERCOMPRESS_ACTIVITY_URL || "https://www.supercompress.dev/api/account?op=compress-log"
export const CONNECT_URL =
  process.env.SUPERCOMPRESS_CONNECT_URL || "https://www.supercompress.dev/api/connect-device"

export type Config = {
  api_key?: string
  port?: number
  connected_at?: string
  configured_at?: string
  configured_agents?: string[]
  mode?: string
}

export type AgentRow = {
  name: string
  saved: number
  in: number
  out: number
  requests: number
  cut: number
}

export type UsageSnap = {
  linked: boolean
  email: string
  plan: string
  uid?: string
  dashboard?: string
  unlimited: boolean
  tokensIn: number
  tokensOut: number
  tokensSaved: number
  requests: number
  quotaUsed: number
  quotaLimit: number
  quotaPct: number
  remaining: number
  cutPct: number
  payg: boolean
  billable: number
  overageUsd: number
  credits: boolean
  creditUsd: number
  creditLimitUsd: number
  agents: AgentRow[]
  pluginLinked: boolean
  pluginLinkedAt?: string
  error?: string
}

export type AccountSnap = {
  linked: boolean
  email: string
  name?: string
  plan: string
  uid?: string
  dashboard?: string
  keyPrefix?: string
  connectedAt?: string
  pluginLinked: boolean
  pluginLinkedAt?: string
  activity: { at: string; pct: number; inn: number; out: number; query: string }[]
  error?: string
}

export type DetectedAgent = {
  name: string
  detected: boolean
  autoConfigurable: boolean
  configPath?: string | null
}

function readProxyVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROXY_ROOT, "package.json"), "utf8"))
    return String(pkg.version || "0.0.0")
  } catch {
    return "0.0.0"
  }
}

function detector() {
  return require(path.join(PROXY_ROOT, "src/detector.js")) as {
    detectAll: () => Array<{
      name: string
      configPath?: string | null
      autoConfigurable?: boolean
    }>
    installAutoPlugin: () => {
      found: Array<{ name: string }>
      mcpConfigured: string[]
      rulePath: string
      hooks: { hooksPath: string }
      agentHooks: { installed: string[] }
      instructions: string[]
      hermes?: { installed?: string[] } | null
      openclaw?: { installed?: string[] } | null
      cleared: string[]
    }
    AGENT_CATALOG: Array<{ name: string }>
    agentPlugins: { loadCustomPlugins: () => Array<{ name: string; id: string; format: string; configPath?: string }> }
  }
}

export function loadConfig(): Config | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
  } catch {
    return null
  }
}

export function saveConfig(config: Config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(CONFIG_DIR, 0o700)
  } catch {}
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(CONFIG_PATH, 0o600)
  } catch {}
}

export function emptyUsage(error?: string): UsageSnap {
  const cfg = loadConfig()
  return {
    linked: Boolean(cfg?.api_key),
    email: cfg?.api_key ? "linked · loading…" : "not linked",
    plan: "—",
    unlimited: false,
    tokensIn: 0,
    tokensOut: 0,
    tokensSaved: 0,
    requests: 0,
    quotaUsed: 0,
    quotaLimit: 0,
    quotaPct: 0,
    remaining: 0,
    cutPct: 0,
    payg: false,
    billable: 0,
    overageUsd: 0,
    credits: false,
    creditUsd: 0,
    creditLimitUsd: 0,
    agents: [],
    pluginLinked: false,
    error,
  }
}

async function fetchJson(url: string, apiKey: string) {
  const response = await fetch(url, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(String(data.detail || `HTTP ${response.status}`))
  }
  return data
}

function num(v: unknown) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function usageFromApi(data: Record<string, unknown>, cfg: Config | null): UsageSnap {
  const tokensIn = num(data.total_tokens_in)
  const tokensSaved = num(data.total_tokens_saved)
  const agents: AgentRow[] = Object.entries((data.coding_agent_usage || {}) as Record<string, Record<string, unknown>>)
    .map(([name, snap]) => {
      const inn = num(snap.tokens_in)
      const saved = num(snap.tokens_saved)
      return {
        name,
        saved,
        in: inn,
        out: num(snap.tokens_out),
        requests: num(snap.requests),
        cut: inn > 0 ? Math.round((saved / inn) * 1000) / 10 : 0,
      }
    })
    .sort((a, b) => b.saved - a.saved)

  return {
    linked: true,
    email: String(data.email || (cfg?.api_key ? "linked account" : "linked")),
    plan: String(data.plan_name || data.plan || "free"),
    uid: data.uid ? String(data.uid) : undefined,
    dashboard: String(data.dashboard_url || "https://www.supercompress.dev/dashboard"),
    unlimited: Boolean(data.unlimited),
    tokensIn,
    tokensOut: num(data.total_tokens_out),
    tokensSaved,
    requests: num(data.total_requests),
    quotaUsed: num(data.tokens_used_this_period),
    quotaLimit: num(data.tokens_per_month),
    quotaPct: num(data.usage_pct),
    remaining: num(data.tokens_remaining),
    cutPct: tokensIn > 0 ? Math.round((tokensSaved / tokensIn) * 1000) / 10 : 0,
    payg: Boolean(data.payg_enabled),
    billable: num(data.billable_tokens),
    overageUsd: num(data.estimated_overage_usd),
    credits: Boolean(data.credit_wallet),
    creditUsd: num(data.credit_balance_usd),
    creditLimitUsd: num(data.credit_limit_usd),
    agents,
    pluginLinked: Boolean((data.agent_plugin as { linked?: boolean } | undefined)?.linked),
    pluginLinkedAt: (data.agent_plugin as { linked_at?: string } | undefined)?.linked_at,
  }
}

export async function fetchUsage(): Promise<UsageSnap> {
  const cfg = loadConfig()
  if (!cfg?.api_key) return emptyUsage("No linked account. Run connect or setup.")
  try {
    const data = await fetchJson(USAGE_URL, cfg.api_key)
    if (data.auth === "required" || data.ok === false) {
      throw new Error(String(data.detail || "Authorization required — reconnect"))
    }
    const snap = usageFromApi(data, cfg)
    try {
      const me = await fetchJson(ME_URL, cfg.api_key)
      snap.email = String(me.email || snap.email)
      snap.plan = String(me.plan_name || me.plan || snap.plan)
      snap.uid = me.uid ? String(me.uid) : snap.uid
    } catch {
      /* usage still valid */
    }
    return snap
  } catch (err) {
    return emptyUsage(err instanceof Error ? err.message : String(err))
  }
}

export async function fetchAccount(): Promise<AccountSnap> {
  const cfg = loadConfig()
  if (!cfg?.api_key) {
    return {
      linked: false,
      email: "not linked",
      plan: "—",
      pluginLinked: false,
      activity: [],
      error: "No linked account. Run connect or setup.",
    }
  }
  try {
    const data = await fetchJson(ME_URL, cfg.api_key)
    const activity: AccountSnap["activity"] = []
    try {
      const log = await fetchJson(`${ACTIVITY_URL}&limit=8`, cfg.api_key)
      for (const e of ((log.entries as unknown[]) || []).slice(0, 8) as Record<string, unknown>[]) {
        activity.push({
          at: String(e.at || "?"),
          pct: num(e.tokens_saved_pct),
          inn: num(e.tokens_in),
          out: num(e.tokens_out),
          query: String(e.query || "").slice(0, 72),
        })
      }
    } catch {
      /* optional */
    }
    return {
      linked: true,
      email: String(data.email || "(none)"),
      name: data.display_name ? String(data.display_name) : undefined,
      plan: String(data.plan_name || data.plan || "free"),
      uid: data.uid ? String(data.uid) : undefined,
      dashboard: String(data.dashboard_url || "https://www.supercompress.dev/dashboard"),
      keyPrefix: `${String(cfg.api_key).slice(0, 16)}…`,
      connectedAt: cfg.connected_at || cfg.configured_at,
      pluginLinked: Boolean((data.agent_plugin as { linked?: boolean } | undefined)?.linked),
      pluginLinkedAt: (data.agent_plugin as { linked_at?: string } | undefined)?.linked_at,
      activity,
    }
  } catch (err) {
    return {
      linked: true,
      email: "linked (fetch failed)",
      plan: "—",
      keyPrefix: `${String(cfg.api_key).slice(0, 16)}…`,
      pluginLinked: false,
      activity: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function detectAgents(): { catalog: DetectedAgent[]; custom: Array<{ name: string; id: string; format: string; configPath?: string }> } {
  const d = detector()
  const found = new Map(d.detectAll().map((a) => [a.name, a]))
  const catalog: DetectedAgent[] = d.AGENT_CATALOG.map((agent) => {
    const hit = found.get(agent.name)
    return {
      name: agent.name,
      detected: Boolean(hit),
      autoConfigurable: Boolean(hit?.autoConfigurable),
      configPath: hit?.configPath,
    }
  })
  return { catalog, custom: d.agentPlugins.loadCustomPlugins() }
}

export function installPlugin() {
  const d = detector()
  const result = d.installAutoPlugin()
  const cfg = loadConfig() || {}
  saveConfig({
    ...cfg,
    configured_at: cfg.configured_at || new Date().toISOString(),
    configured_agents: result.mcpConfigured,
    mode: cfg.mode || "mcp",
  })
  return result
}

export function beginConnect() {
  const code = crypto.randomBytes(16).toString("hex")
  const url = `https://www.supercompress.dev/dashboard?connect=${code}&source=tui`
  const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    execFileSync(openCmd, [url], { stdio: "ignore" })
  } catch {
    /* user can open url manually */
  }
  return { code, url }
}

export async function pollConnect(code: string) {
  const res = await fetch(`${CONNECT_URL}?code=${encodeURIComponent(code)}`)
  const data = (await res.json().catch(() => ({}))) as { status?: string; secret?: string }
  if (res.ok && data.status === "linked" && data.secret) return data.secret
  return null
}

export function saveApiKey(apiKey: string) {
  const cfg = loadConfig() || {}
  saveConfig({
    ...cfg,
    api_key: apiKey.trim(),
    connected_at: new Date().toISOString(),
    configured_at: cfg.configured_at || new Date().toISOString(),
    mode: cfg.mode || "mcp",
    port: cfg.port || 8080,
  })
}

function readPid() {
  try {
    if (!fs.existsSync(PID_PATH)) return null
    const pid = parseInt(fs.readFileSync(PID_PATH, "utf8").trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isOurProxyProcess(pid: number | null) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return /supercompress|packages[\\/]+proxy[\\/]+src[\\/]+server\.js|proxy[\\/]+src[\\/]+server\.js/i.test(out)
  } catch {
    return false
  }
}

export function fetchHealth(port: number, timeoutMs = 700): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const started = Date.now()
    const check = () => {
      const req = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 800 }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          body += chunk
        })
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>
              if (parsed.status === "ok" && parsed.service === "supercompress") return resolve(parsed)
            } catch {}
          }
          retry()
        })
      })
      req.on("error", retry)
      req.on("timeout", () => req.destroy())
    }
    const retry = () => {
      if (Date.now() - started >= timeoutMs) return resolve(null)
      setTimeout(check, 80)
    }
    check()
  })
}

export async function proxyStatus() {
  const cfg = loadConfig()
  const port = cfg?.port || 8080
  const health = await fetchHealth(port)
  return {
    configured: Boolean(cfg),
    linked: Boolean(cfg?.api_key),
    port,
    running: Boolean(health),
    version: health?.version ? String(health.version) : null,
    agents: cfg?.configured_agents || [],
  }
}

export async function startProxy() {
  const cfg = loadConfig()
  if (!cfg?.api_key) throw new Error("Not configured. Run setup or connect first.")
  const port = cfg.port || 8080
  const health = await fetchHealth(port)
  if (health) {
    if (health.version && String(health.version) !== VERSION) {
      stopProxy(port)
      await new Promise((r) => setTimeout(r, 400))
    } else {
      return { already: true, port, pid: readPid() }
    }
  }
  const serverPath = path.join(PROXY_ROOT, "src", "server.js")
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const logFd = fs.openSync(LOG_PATH, "a")
  const child = spawn(process.execPath, [serverPath, String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      SUPERCOMPRESS_API_KEY: cfg.api_key,
      SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR,
    },
  })
  child.on("close", () => {
    try {
      fs.closeSync(logFd)
    } catch {}
  })
  fs.writeFileSync(PID_PATH, String(child.pid))
  child.unref()
  const ok = await fetchHealth(port, 5000)
  if (!ok) {
    try {
      process.kill(child.pid!, "SIGTERM")
    } catch {}
    try {
      fs.unlinkSync(PID_PATH)
    } catch {}
    throw new Error(`Proxy did not become healthy on localhost:${port}`)
  }
  return { already: false, port, pid: child.pid }
}

export function stopProxy(portArg?: number) {
  const port = portArg || loadConfig()?.port || 8080
  let stopped = false
  const pid = readPid()
  if (pid && isOurProxyProcess(pid)) {
    try {
      process.kill(pid, "SIGTERM")
      stopped = true
    } catch {}
  }
  try {
    fs.unlinkSync(PID_PATH)
  } catch {}
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    for (const line of out.split("\n")) {
      const p = parseInt(line.trim(), 10)
      if (!p || p === process.pid || !isOurProxyProcess(p)) continue
      try {
        process.kill(p, "SIGTERM")
        stopped = true
      } catch {}
    }
  } catch {}
  return stopped
}

export function mcpCheck(timeoutMs = 8000): Promise<{ ok: boolean; tools: string[]; detail: string }> {
  return new Promise((resolve) => {
    const mcpPath = path.join(PROXY_ROOT, "src/mcp.js")
    const child = spawn(process.execPath, [mcpPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => {
      out += d
    })
    child.stderr.on("data", (d) => {
      err += d
    })
    const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`)
    const finish = (result: { ok: boolean; tools: string[]; detail: string }) => {
      try {
        child.kill()
      } catch {}
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, tools: [], detail: err.trim() || "MCP check timed out" })
    }, timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      finish({ ok: false, tools: [], detail: e.message })
    })
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "supercompress-tui", version: VERSION },
      },
    })
    const onData = () => {
      if (!out.includes('"id":1') && !out.includes('"id": 1')) return
      child.stdout.off("data", onData)
      send({ jsonrpc: "2.0", method: "notifications/initialized" })
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    }
    child.stdout.on("data", onData)
    const done = setInterval(() => {
      if (!out.includes('"id":2') && !out.includes('"id": 2')) return
      clearInterval(done)
      clearTimeout(timer)
      try {
        const lines = out.split("\n").filter(Boolean)
        const listLine = [...lines].reverse().find((l) => l.includes("tools") && (l.includes('"id":2') || l.includes('"id": 2')))
        const parsed = JSON.parse(listLine || "{}")
        const tools = ((parsed.result && parsed.result.tools) || []).map((t: { name: string }) => t.name)
        const need = ["compress_context", "connect_account", "usage_summary"]
        const missing = need.filter((n) => !tools.includes(n))
        if (missing.length) {
          finish({ ok: false, tools, detail: `missing tools: ${missing.join(", ")}` })
          return
        }
        finish({ ok: true, tools, detail: err.trim().split("\n").pop() || "ready" })
      } catch (e) {
        finish({ ok: false, tools: [], detail: e instanceof Error ? e.message : String(e) })
      }
    }, 50)
  })
}

export function formatUsageLog(u: UsageSnap) {
  const lines = [
    `USAGE  ·  ${u.plan}`,
    u.error ? `✗ ${u.error}` : `account  ${u.email}`,
    `requests      ${fmt(u.requests)}`,
    `tokens in     ${fmt(u.tokensIn)}`,
    `tokens out    ${fmt(u.tokensOut)}`,
    `tokens saved  ${fmt(u.tokensSaved)}${u.tokensIn ? `  (−${u.cutPct}%)` : ""}`,
  ]
  if (u.unlimited) lines.push("quota        unlimited")
  else if (u.quotaLimit) lines.push(`quota        ${fmt(u.quotaUsed)} / ${fmt(u.quotaLimit)}  (${u.quotaPct}%)`)
  if (u.payg && u.billable) lines.push(`billable     ${fmt(u.billable)}  (~$${u.overageUsd.toFixed(2)})`)
  if (u.credits) lines.push(`credits      $${u.creditUsd.toFixed(2)} / $${u.creditLimitUsd.toFixed(2)}`)
  lines.push("")
  lines.push("BY AGENT")
  if (!u.agents.length) lines.push("  no compress activity yet")
  else {
    for (const a of u.agents) {
      lines.push(`  ${a.name.padEnd(16)} ${fmt(a.saved).padStart(6)} saved  −${a.cut}%  ${a.requests} req`)
    }
  }
  if (u.pluginLinked) lines.push("", `plugin linked${u.pluginLinkedAt ? `  ${u.pluginLinkedAt}` : ""}`)
  lines.push("", "dashboard  https://www.supercompress.dev/dashboard")
  return lines.join("\n")
}

export function formatAccountLog(a: AccountSnap) {
  const lines = [
    "ACCOUNT",
    a.error ? `✗ ${a.error}` : `email     ${a.email}`,
  ]
  if (a.name) lines.push(`name      ${a.name}`)
  lines.push(`plan      ${a.plan}`)
  if (a.uid) lines.push(`uid       ${a.uid}`)
  if (a.keyPrefix) lines.push(`key       ${a.keyPrefix}`)
  if (a.connectedAt) lines.push(`machine   ${a.connectedAt}`)
  lines.push(`agents    ${a.pluginLinked ? `linked${a.pluginLinkedAt ? ` (${a.pluginLinkedAt})` : ""}` : "not linked yet"}`)
  if (a.dashboard) lines.push(`dash      ${a.dashboard}`)
  if (a.activity.length) {
    lines.push("", "RECENT COMPRESS")
    for (const e of a.activity) {
      lines.push(`  ${e.at}  −${e.pct}%  ${fmt(e.inn)}→${fmt(e.out)}  ${e.query}`)
    }
  }
  return lines.join("\n")
}

export function formatAgentsLog(detected: ReturnType<typeof detectAgents>) {
  const found = detected.catalog.filter((a) => a.detected)
  const lines = [
    `AGENTS  ·  ${found.length} detected / ${detected.catalog.length} catalogued`,
    "",
  ]
  for (const a of detected.catalog) {
    const mark = a.detected ? (a.autoConfigurable ? "✓" : "●") : "·"
    const note = a.detected ? (a.autoConfigurable ? "configurable" : "manual setup") : "not detected"
    lines.push(`  ${mark} ${a.name.padEnd(22)} ${note}`)
  }
  if (detected.custom.length) {
    lines.push("", "CUSTOM PLUGINS")
    for (const p of detected.custom) {
      lines.push(`  • ${p.name} (${p.id})  ${p.format}  ${p.configPath || ""}`)
    }
  }
  lines.push("", "add:  supercompress agents add --name MyAgent --format mcp-json --config ~/.myagent/mcp.json")
  return lines.join("\n")
}

export function formatPluginLog(result: ReturnType<typeof installPlugin>) {
  const lines = [`Detected ${result.found.length} coding agent(s)`]
  for (const agent of result.found) lines.push(`  ✓ ${agent.name}`)
  if (result.mcpConfigured.length) lines.push(`✓ MCP plugin  ${result.mcpConfigured.join(", ")}`)
  else lines.push("○ No MCP-capable agent configs found to update")
  lines.push(`✓ Cursor rule   ${result.rulePath}`)
  lines.push(`✓ Cursor hooks  ${result.hooks.hooksPath}`)
  if (result.agentHooks.installed.length) lines.push(`✓ Prompt/tool hooks  ${result.agentHooks.installed.join(", ")}`)
  if (result.instructions.length) lines.push(`✓ Instructions      ${result.instructions.join(", ")}`)
  if (result.hermes?.installed?.length) lines.push(`✓ Hermes auto-compress  ${result.hermes.installed.join(", ")}`)
  if (result.openclaw?.installed?.length) lines.push(`✓ OpenClaw auto-compress  ${result.openclaw.installed.join(", ")}`)
  if (result.cleared.length) lines.push(`✓ Cleared proxy overrides  ${result.cleared.join(", ")}`)
  lines.push("", "Restart agents so MCP/hooks reload.")
  return lines.join("\n")
}
