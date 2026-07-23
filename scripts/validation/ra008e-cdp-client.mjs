// RA-008-E: Node-standard-library-only Chrome DevTools Protocol client.
//
// Purpose: drive a real, locally installed Google Chrome (macOS) over CDP for
// real-browser adversarial cross-tab invalidation validation. This module is
// intentionally dependency-free (only Node built-ins: node:child_process,
// node:fs, node:timers/promises, global fetch, global WebSocket) and is never
// imported by the production bundle or app runtime — it is a validation-only
// tool invoked directly via `node scripts/validation/ra008e-cross-tab-browser.mjs`.
//
// Mac/Chrome validation harness only. Not part of the shipped application.

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

export function findChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export function launchChrome({ binary, port, userDataDir, headless = true }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-features=Translate',
    '--disable-extensions',
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')
  const proc = spawn(binary, args, { stdio: 'ignore', detached: false })
  return proc
}

export async function killChromeProcess(proc, { timeoutMs = 5000 } = {}) {
  if (!proc || proc.exitCode !== null || proc.killed) return
  await new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    proc.once('exit', finish)
    try {
      proc.kill('SIGTERM')
    } catch {
      // process may already be gone
    }
    const forceKillTimer = setTimeout(() => {
      if (settled) return
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
    }, Math.min(3000, timeoutMs))
    setTimeout(() => {
      clearTimeout(forceKillTimer)
      finish()
    }, timeoutMs)
  })
}

export async function waitForDevtoolsReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
    } catch (err) {
      lastErr = err
    }
    await delay(150)
  }
  throw new Error(`devtools endpoint not ready on port ${port}: ${lastErr}`)
}

export async function createTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  })
  if (!res.ok) throw new Error(`failed to create target (${res.status}) for ${url}`)
  return res.json()
}

export async function getBrowserWsUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`)
  const info = await res.json()
  return info.webSocketDebuggerUrl
}

/** Minimal CDP JSON-RPC client bound to a single websocket target (browser- or page-level). */
export class CdpClient {
  constructor(wsUrl, { label = 'target', commandTimeoutMs = 10000 } = {}) {
    this.wsUrl = wsUrl
    this.label = label
    this.commandTimeoutMs = commandTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.eventHandlers = new Map()
    this.ws = null
    this.exceptions = []
    this.consoleErrors = []
    this.consoleAll = []
    this.frameNavigations = []
    this.crashed = false
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.ws.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        this.ws.removeEventListener('open', onOpen)
        reject(new Error(`websocket connect failed: ${this.label}`))
      }
      this.ws.addEventListener('open', onOpen, { once: true })
      this.ws.addEventListener('error', onError, { once: true })
    })
    this.ws.addEventListener('message', ev => this._onMessage(ev))
    this.ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error(`ws closed: ${this.label}`))
      this.pending.clear()
    })

    this.on('Runtime.exceptionThrown', params => this.exceptions.push(params))
    this.on('Runtime.consoleAPICalled', params => {
      this.consoleAll.push(params)
      if (params.type === 'error') this.consoleErrors.push(params)
    })
    this.on('Page.frameNavigated', params => {
      if (params.frame && !params.frame.parentId) this.frameNavigations.push(params.frame.url)
    })
    this.on('Inspector.targetCrashed', () => {
      this.crashed = true
    })
  }

  _onMessage(ev) {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`CDP error [${p.method}] (${this.label}): ${JSON.stringify(msg.error)}`))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.method) {
      const handlers = this.eventHandlers.get(msg.method)
      if (handlers) for (const h of Array.from(handlers)) {
        try {
          h(msg.params)
        } catch {
          // handler failures must not break message pump
        }
      }
    }
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set())
    this.eventHandlers.get(method).add(handler)
    return () => this.eventHandlers.get(method)?.delete(handler)
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`ws not open for ${method} (${this.label})`))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timeout: ${method} (${this.label})`))
      }, this.commandTimeoutMs)
      this.pending.set(id, {
        method,
        resolve: v => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.ws.send(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
  }
}
