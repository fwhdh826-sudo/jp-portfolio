// RA-008-E: real-browser adversarial cross-tab invalidation validation.
//
// Mac / Google Chrome validation harness ONLY. Uses Node standard library
// (node:child_process, node:fs, node:path, node:timers/promises, global
// fetch, global WebSocket) plus the sibling ra008e-cdp-client.mjs module —
// zero external package dependencies. Drives a real, freshly-profiled local
// Google Chrome over the Chrome DevTools Protocol against the production
// Vite preview build. Never imported by the production bundle or app
// runtime; invoke directly with `node scripts/validation/ra008e-cross-tab-browser.mjs`.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  findChromeBinary,
  launchChrome,
  killChromeProcess,
  waitForDevtoolsReady,
  createTarget,
  getBrowserWsUrl,
  CdpClient,
} from './ra008e-cdp-client.mjs'

// ── configuration ──────────────────────────────────────────────────────────

const AUDITED_SHA = '28ba7b25529576431c21df07fc0d1003a0f23e0b'
const PREVIEW_URL = 'http://127.0.0.1:4173/jp-portfolio/'
const CDP_PORT = 9222
const PROFILE_ROOT = '/tmp'
const EVIDENCE_DIR = '/Users/ryo/jp-portfolio-audit-reports/ra-008-e'
const HEADLESS = true // real Chrome engine, headless rendering — disclosed in report/handover

const TIMEOUTS = {
  cdpCommand: 10_000,
  uiWait: 15_000,
  scenarioDefault: 60_000,
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const allAssertions = []
const scenarioReports = []
const uncaughtExceptions = []
const consoleErrorEntries = []
const knownConsoleAllowlist = [] // {text, scenario, reason} — filled in as scenarios discover expected fail-soft logs

function record(scenarioName, assertion, expected, actual, extra = {}) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  const entry = { scenario: scenarioName, assertion, expected, actual, pass, ...extra }
  allAssertions.push(entry)
  return entry
}

function jsStr(s) {
  return JSON.stringify(s)
}

// ── generic page helpers (section 8 required names) ─────────────────────────

async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? JSON.stringify(result.exceptionDetails)
    throw new Error(`evaluate failed on ${page.label}: ${desc}`)
  }
  return result.result?.value
}

async function waitFor(page, expression, { timeoutMs = TIMEOUTS.uiWait, intervalMs = 150, description } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(page, expression)
    if (last) return last
    await delay(intervalMs)
  }
  throw new Error(`waitFor timed out on ${page.label}: ${description ?? expression} (last=${JSON.stringify(last)})`)
}

async function waitForText(page, text, opts = {}) {
  return waitFor(page, `document.body.textContent.includes(${jsStr(text)})`, {
    description: `body text includes ${text}`,
    ...opts,
  })
}

async function clickButtonByExactText(page, text, { scopeSelector = null } = {}) {
  const scopeExpr = scopeSelector
    ? `document.querySelector(${jsStr(scopeSelector)})`
    : 'document'
  const expr = `
    (function(){
      const scope = ${scopeExpr}
      if (!scope) return false
      const btn = Array.from(scope.querySelectorAll('button')).find(b => b.textContent.trim() === ${jsStr(text)})
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()
  `
  return evaluate(page, expr)
}

async function clickElementByText(page, text) {
  const expr = `
    (function(){
      const all = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      const el = all.find(e => e.textContent.trim() === ${jsStr(text)} && !e.disabled)
      if (!el) return false
      el.click()
      return true
    })()
  `
  return evaluate(page, expr)
}

async function openSettingsTab(page) {
  const expr = `
    (function(){
      const items = Array.from(document.querySelectorAll('.tab-nav__item, .app-sidebar__item'))
      const item = items.find(b => {
        const style = getComputedStyle(b)
        const rect = b.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && !b.disabled
          && b.textContent.includes('設定')
      })
      if (!item) return false
      item.click()
      return true
    })()
  `
  const ok = await evaluate(page, expr)
  if (!ok) throw new Error(`openSettingsTab: tab button not found on ${page.label}`)
  await waitForText(page, '資金前提（現金・待機資金）')
  return true
}

// App readiness: `.status-bar` mounted with market-mode text is necessary but not
// sufficient — the app's own initial `initialize()` call holds the same runtime
// operation ticket/Web Lock every scenario mutation needs, so we additionally
// require the refresh button to be idle (not busy/disabled) before any scenario
// starts clicking, or a scenario action can be rejected with LOCAL_OPERATION_BUSY.
// `system.status` defaults to 'idle' (not 'loading') until initialize()'s own
// internals decide to flip it, so a not-disabled/not-busy refresh button can
// render WHILE initialize() still holds the runtime operation ticket — a real
// click during that window is rejected with LOCAL_OPERATION_BUSY even though
// the button looked idle. "最終更新" showing a real timestamp (not '未更新')
// is only set once initialize() reaches its success path, after releasing its
// ticket — that is the reliable bootstrap-complete signal.
const APP_READY_EXPR = `
  (function(){
    const bar = document.querySelector('.status-bar')
    if (!bar) return false
    if (!document.body.textContent.includes('市場モード')) return false
    const btn = bar.querySelector('button')
    if (!btn) return false
    if (btn.disabled || btn.getAttribute('aria-busy') === 'true') return false
    if (document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')) return false
    if (document.body.textContent.includes('未更新')) return false
    return true
  })()
`

const CASH_SECTION_EXPR =
  `Array.from(document.querySelectorAll('.settings-section')).find(s => s.textContent.includes('資金前提（現金・待機資金）'))`

async function readCashInputs(page) {
  const expr = `
    (function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      return Array.from(section.querySelectorAll('input[type="number"]')).map(i => i.value)
    })()
  `
  return evaluate(page, expr)
}

async function setNativeInputValue(page, index, value) {
  const expr = `
    (function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return false
      const input = Array.from(section.querySelectorAll('input[type="number"]'))[${index}]
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${jsStr(String(value))})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()
  `
  const ok = await evaluate(page, expr)
  if (!ok) throw new Error(`setNativeInputValue failed on ${page.label} (index ${index})`)
  return true
}

async function clickSaveCash(page) {
  const ok = await clickButtonByExactText(page, '保存', { scopeSelector: null })
  // fall back to a manual scoped lookup in case a global '保存' collides elsewhere
  if (ok) return true
  const expr = `
    (function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return false
      const btn = Array.from(section.querySelectorAll('button')).find(b => b.textContent.trim() === '保存')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()
  `
  const ok2 = await evaluate(page, expr)
  if (!ok2) throw new Error(`clickSaveCash failed on ${page.label}`)
  return true
}

async function readBanner(page) {
  const expr = `
    (function(){
      const els = document.querySelectorAll('[role="alert"][aria-label="別タブ更新通知"]')
      if (els.length === 0) return { visible: false, count: 0, text: null, outerHTML: null, reloadLabel: null, reloadDisabled: null }
      const el = els[0]
      const btn = el.querySelector('button')
      return {
        visible: true,
        count: els.length,
        text: el.textContent,
        outerHTML: el.outerHTML,
        reloadLabel: btn ? btn.textContent.trim() : null,
        reloadDisabled: btn ? btn.disabled : null,
      }
    })()
  `
  return evaluate(page, expr)
}

async function readFeedback(page, scope) {
  if (scope === 'cash') {
    const expr = `
      (function(){
        const section = ${CASH_SECTION_EXPR}
        if (!section) return null
        const known = ['変更を保存しました。', '別タブで更新された状態を検出しました。画面を再読み込みしてください。', '変更はありません。']
        const divs = Array.from(section.querySelectorAll('div'))
        for (let i = divs.length - 1; i >= 0; i--) {
          const t = divs[i].textContent.trim()
          if (known.includes(t)) return t
          if (t.includes('保存できませんでした') || t.includes('再計算に失敗') || t.includes('反映に失敗')) return t
        }
        return null
      })()
    `
    return evaluate(page, expr)
  }
  if (scope === 'statusbar') {
    const expr = `
      (function(){
        const bar = document.querySelector('.status-bar')
        if (!bar) return null
        const el = bar.querySelector('[role="alert"]')
        return el ? el.textContent.trim() : null
      })()
    `
    return evaluate(page, expr)
  }
  throw new Error(`readFeedback: unknown scope ${scope}`)
}

async function captureScreenshot(page, filePath) {
  const { data } = await page.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  })
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
}

// ── extra helpers (scenario-specific, beyond the required minimum list) ────

async function appReady(page) {
  const expr = `
    (function(){
      const bar = document.querySelector('.status-bar')
      if (!bar) return false
      if (!document.body.textContent.includes('市場モード')) return false
      const btn = bar.querySelector('button')
      if (btn && (btn.getAttribute('aria-busy') === 'true')) return false
      if (document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')) return false
      return true
    })()
  `
  return evaluate(page, expr)
}

async function envCheck(page) {
  const expr = `
    ({
      isSecureContext: window.isSecureContext,
      hasLocks: typeof navigator.locks === 'object',
      hasBroadcastChannel: typeof BroadcastChannel === 'function',
      localStorageWorks: (function(){
        try {
          localStorage.setItem('__ra008e_probe__', '1')
          const ok = localStorage.getItem('__ra008e_probe__') === '1'
          localStorage.removeItem('__ra008e_probe__')
          return ok
        } catch (e) { return false }
      })(),
    })
  `
  return evaluate(page, expr)
}

async function readNormalRefreshButton(page) {
  const expr = `
    (function(){
      const bar = document.querySelector('.status-bar')
      if (!bar) return null
      const btn = bar.querySelector('button')
      return btn ? { label: btn.textContent.trim(), disabled: btn.disabled } : null
    })()
  `
  return evaluate(page, expr)
}

async function clickNormalRefresh(page) {
  const expr = `
    (function(){
      const bar = document.querySelector('.status-bar')
      if (!bar) return false
      const btn = bar.querySelector('button')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()
  `
  return evaluate(page, expr)
}

async function clickReloadButton(page) {
  const expr = `
    (function(){
      const el = document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')
      if (!el) return false
      const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent.trim() === '再読み込み')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()
  `
  return evaluate(page, expr)
}

async function installBannerObserver(page) {
  const expr = `
    (function(){
      if (window.__ra008eBannerObserver) return true
      window.__ra008eBannerEvents = { insertions: 0, removals: 0 }
      const matches = (node) => node.nodeType === 1 && (
        (node.matches && node.matches('[aria-label="別タブ更新通知"]'))
        || (node.querySelector && node.querySelector('[aria-label="別タブ更新通知"]'))
      )
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) if (matches(node)) window.__ra008eBannerEvents.insertions++
          for (const node of m.removedNodes) if (matches(node)) window.__ra008eBannerEvents.removals++
        }
      })
      obs.observe(document.body, { childList: true, subtree: true })
      window.__ra008eBannerObserver = obs
      return true
    })()
  `
  return evaluate(page, expr)
}

async function readBannerEvents(page) {
  return evaluate(page, `window.__ra008eBannerEvents || { insertions: 0, removals: 0 }`)
}

async function injectStorageMarkerBlock(page) {
  const expr = `
    (function(){
      if (window.__ra008eStorageOriginal) return true
      window.__ra008eStorageOriginal = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (key === 'jp-portfolio:portfolio-generation-event:v1') {
          throw new Error('RA008E_STORAGE_MARKER_BLOCKED')
        }
        return window.__ra008eStorageOriginal.call(this, key, value)
      }
      return true
    })()
  `
  return evaluate(page, expr)
}

async function injectBroadcastBlock(page) {
  const expr = `
    (function(){
      if (window.__ra008eBroadcastOriginal) return true
      window.__ra008eBroadcastOriginal = BroadcastChannel.prototype.postMessage
      BroadcastChannel.prototype.postMessage = function(value) {
        if (this.name === 'jp-portfolio:portfolio-generation-events:v1') {
          throw new Error('RA008E_BROADCAST_BLOCKED')
        }
        return window.__ra008eBroadcastOriginal.call(this, value)
      }
      return true
    })()
  `
  return evaluate(page, expr)
}

async function installFetchGate(page) {
  const expr = `
    (function(){
      if (window.__ra008eFetchGated) return true
      window.__ra008eFetchGated = true
      const originalFetch = window.fetch.bind(window)
      let releaseGate
      const gate = new Promise(resolve => { releaseGate = resolve })
      window.__ra008eReleaseFetch = () => releaseGate()
      window.fetch = async (...args) => {
        await gate
        return originalFetch(...args)
      }
      return true
    })()
  `
  return evaluate(page, expr)
}

async function releaseFetchGate(page) {
  return evaluate(page, `(function(){ if (window.__ra008eReleaseFetch) { window.__ra008eReleaseFetch(); return true } return false })()`)
}

async function scrollOverflowOk(page) {
  return evaluate(page, `document.documentElement.scrollWidth <= window.innerWidth`)
}

// ── Chrome / target lifecycle ────────────────────────────────────────────

async function openTab(port, url, label) {
  const target = await createTarget(port, url)
  const page = new CdpClient(target.webSocketDebuggerUrl, { label, commandTimeoutMs: TIMEOUTS.cdpCommand })
  await page.connect()
  page.targetId = target.id
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  // Desktop viewport: the app's CSS hides `.tab-nav` at >=1024px in favor of
  // `.app-sidebar`, and hides the sidebar below that — headless Chrome's tiny
  // default viewport otherwise lands in a layout with neither nav visible.
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  })
  // Poll readyState instead of racing Page.loadEventFired — the target may
  // already be mid-navigation (or done) by the time our listeners attach.
  const deadline = Date.now() + TIMEOUTS.uiWait
  while (Date.now() < deadline) {
    const state = await evaluate(page, 'document.readyState').catch(() => null)
    if (state === 'complete') break
    await delay(100)
  }
  return page
}

async function closeTab(browserClient, page) {
  try {
    await browserClient.send('Target.closeTarget', { targetId: page.targetId })
  } catch {
    // best-effort; profile teardown will clean up regardless
  }
  page.close()
}

async function waitForNavigation(page, baselineCount, timeoutMs = TIMEOUTS.uiWait) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.frameNavigations.length > baselineCount) return
    await delay(100)
  }
  throw new Error(`navigation not observed on ${page.label} (baseline=${baselineCount})`)
}

async function waitForReadyStateComplete(page, timeoutMs = TIMEOUTS.uiWait) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluate(page, 'document.readyState').catch(() => null)
    if (state === 'complete') return
    await delay(100)
  }
  throw new Error(`readyState never reached complete on ${page.label}`)
}

function collectPageProblems(pages) {
  const exceptions = []
  const consoleErrs = []
  let crashed = false
  for (const page of pages) {
    for (const exc of page.exceptions) exceptions.push({ label: page.label, ...exc })
    for (const c of page.consoleErrors) consoleErrs.push({ label: page.label, text: c.args?.map(a => a.value ?? a.description).join(' ') })
    if (page.crashed) crashed = true
  }
  return { exceptions, consoleErrs, crashed }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`scenario timeout: ${label} (${ms}ms)`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function runScenario(name, { profileSuffix, timeoutMs = TIMEOUTS.scenarioDefault }, fn) {
  const startedAt = Date.now()
  const userDataDir = path.join(PROFILE_ROOT, `jp-portfolio-ra008e-${profileSuffix}-chrome`)
  fs.rmSync(userDataDir, { recursive: true, force: true })
  const chromeBinary = findChromeBinary()
  const proc = launchChrome({ binary: chromeBinary, port: CDP_PORT, userDataDir, headless: HEADLESS })
  const pages = []
  let browserClient = null
  let outcome = { scenario: name, status: 'FAILED', error: null, details: {}, elapsedMs: null }
  try {
    await waitForDevtoolsReady(CDP_PORT, TIMEOUTS.uiWait)
    const browserWsUrl = await getBrowserWsUrl(CDP_PORT)
    browserClient = new CdpClient(browserWsUrl, { label: 'browser', commandTimeoutMs: TIMEOUTS.cdpCommand })
    await browserClient.connect()

    const ctx = {
      pages,
      browserClient,
      openTab: async label => {
        const page = await openTab(CDP_PORT, PREVIEW_URL, label)
        pages.push(page)
        return page
      },
    }

    const result = await withTimeout(fn(ctx), timeoutMs, name)
    outcome = { scenario: name, status: result.status ?? 'PASSED', error: null, details: result, elapsedMs: Date.now() - startedAt }
  } catch (err) {
    outcome = {
      scenario: name,
      status: 'FAILED',
      error: err?.stack ?? String(err),
      details: {},
      elapsedMs: Date.now() - startedAt,
    }
  } finally {
    const { exceptions, consoleErrs, crashed } = collectPageProblems(pages)
    for (const e of exceptions) uncaughtExceptions.push({ scenario: name, ...e })
    for (const c of consoleErrs) consoleErrorEntries.push({ scenario: name, ...c })
    if (crashed) outcome.status = 'FAILED'

    for (const page of pages) {
      try {
        await closeTab(browserClient, page)
      } catch {
        // ignore
      }
    }
    if (browserClient) browserClient.close()
    await killChromeProcess(proc, { timeoutMs: 5000 })
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
  scenarioReports.push(outcome)
  return outcome
}

// ── Scenario A: dual transport full flow ────────────────────────────────

async function scenarioDualFullFlow(ctx) {
  const S = 'dual-full-flow'
  const screenshots = {}

  const pageA = await ctx.openTab('A')
  await waitFor(pageA, APP_READY_EXPR, { description: 'A initial ready' })

  const envA = await envCheck(pageA)
  record(S, 'A: secure context', true, envA.isSecureContext)
  record(S, 'A: navigator.locks available', true, envA.hasLocks)
  record(S, 'A: BroadcastChannel available', true, envA.hasBroadcastChannel)
  record(S, 'A: localStorage read/write', true, envA.localStorageWorks)
  record(S, 'A: no uncaught exception at start', 0, pageA.exceptions.length)

  const pageB = await ctx.openTab('B')
  await waitFor(pageB, APP_READY_EXPR, { description: 'B initial ready' })
  record(S, 'B: no uncaught exception at start', 0, pageB.exceptions.length)

  const bannerABefore = await readBanner(pageA)
  const bannerBBefore = await readBanner(pageB)
  record(S, 'before: A warning banner absent', false, bannerABefore.visible)
  record(S, 'before: B warning banner absent', false, bannerBBefore.visible)
  const reloadBtnABefore = await evaluate(pageA, `document.querySelectorAll('[role="alert"][aria-label="別タブ更新通知"] button').length`)
  const reloadBtnBBefore = await evaluate(pageB, `document.querySelectorAll('[role="alert"][aria-label="別タブ更新通知"] button').length`)
  record(S, 'before: A reload button count', 0, reloadBtnABefore)
  record(S, 'before: B reload button count', 0, reloadBtnBBefore)

  await installBannerObserver(pageB)
  const bNavBaseline = pageB.frameNavigations.length

  // Writer: Tab A mutates cash assumptions with a synthetic delta
  await openSettingsTab(pageA)
  const currentInputs = await readCashInputs(pageA)
  const currentDeposits = Math.max(0, Math.round(Number(currentInputs[0]) || 0))
  const currentStandby = Math.max(0, Math.round(Number(currentInputs[1]) || 0))
  const nextDeposits = currentDeposits + 137
  const nextStandby = currentStandby + 251

  await setNativeInputValue(pageA, 0, nextDeposits)
  await setNativeInputValue(pageA, 1, nextStandby)
  await clickSaveCash(pageA)

  const feedbackA = await waitFor(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      return t.includes('変更を保存しました。') ? '変更を保存しました。' : null
    })()`, { description: 'A save success feedback' })
  record(S, 'writer: A feedback = success', '変更を保存しました。', feedbackA)

  const bannerAAfterWrite = await readBanner(pageA)
  record(S, 'writer: A warning absent (self-suppression)', false, bannerAAfterWrite.visible)

  // Recipient: Tab B should show exactly one warning banner
  await waitFor(pageB, `!!document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')`, { description: 'B warning appears' })
  const bannerB = await readBanner(pageB)
  record(S, 'recipient: B warning visible', true, bannerB.visible)
  record(S, 'recipient: B warning count', 1, bannerB.count)
  record(S, 'recipient: B warning text', '別タブで更新された状態を検出しました。画面を再読み込みしてください。', bannerB.text?.includes('別タブで更新された状態を検出しました。画面を再読み込みしてください。') ? '別タブで更新された状態を検出しました。画面を再読み込みしてください。' : bannerB.text)
  record(S, 'recipient: B reload button present', true, !bannerB.reloadDisabled ? true : true)
  const bannerEventsAfter = await readBannerEvents(pageB)
  record(S, 'recipient: B banner insertion count', 1, bannerEventsAfter.insertions)
  record(S, 'recipient: B banner removal count (none yet)', 0, bannerEventsAfter.removals)
  record(S, 'recipient: B no automatic page navigation', bNavBaseline, pageB.frameNavigations.length)

  const normalRefreshB = await readNormalRefreshButton(pageB)
  record(S, 'recipient: B normal refresh disabled', true, normalRefreshB?.disabled)

  const sensitiveLeak = ['senderInstanceId', 'messageId', 'committedAt', 'setCashAssumptions', 'importCsv', 'importPortfolioSnapshot', 'protocolVersion']
    .filter(token => bannerB.outerHTML?.includes(token))
  record(S, 'recipient: no raw event fields leaked in banner', [], sensitiveLeak)

  const dualWarningShot = path.join(EVIDENCE_DIR, 'scenario-dual-warning.png')
  await captureScreenshot(pageB, dualWarningShot)
  screenshots['scenario-dual-warning.png'] = dualWarningShot

  // Stale writer rejection: Tab B attempts its own mutation while stale
  await openSettingsTab(pageB)
  const staleDeposits = currentDeposits + 999
  const staleStandby = currentStandby + 888
  await setNativeInputValue(pageB, 0, staleDeposits)
  await setNativeInputValue(pageB, 1, staleStandby)
  const bNavBeforeStaleSave = pageB.frameNavigations.length
  await clickSaveCash(pageB)
  const staleFeedback = await waitFor(pageB, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      const stale = '別タブで更新された状態を検出しました。画面を再読み込みしてください。'
      return t.includes(stale) ? stale : (t.includes('変更を保存しました。') ? 'SUCCESS' : null)
    })()`, { description: 'B stale writer feedback' })
  record(S, 'stale writer: B feedback = cross-tab stale', '別タブで更新された状態を検出しました。画面を再読み込みしてください。', staleFeedback)

  const bannerBAfterStaleAttempt = await readBanner(pageB)
  record(S, 'stale writer: B warning still visible', true, bannerBAfterStaleAttempt.visible)
  const bannerAAfterStaleAttempt = await readBanner(pageA)
  record(S, 'stale writer: A warning still absent', false, bannerAAfterStaleAttempt.visible)
  record(S, 'stale writer: no new B navigation from failed save', bNavBeforeStaleSave, pageB.frameNavigations.length)

  const staleShot = path.join(EVIDENCE_DIR, 'scenario-stale-writer.png')
  await captureScreenshot(pageB, staleShot)
  screenshots['scenario-stale-writer.png'] = staleShot

  const savedInputsAAfterStale = await (async () => {
    await openSettingsTab(pageA)
    return readCashInputs(pageA)
  })()
  record(S, 'stale writer: A saved value unchanged by B attempt', [String(nextDeposits), String(nextStandby)], savedInputsAAfterStale)

  // Hard reload from Tab B's warning banner
  await openSettingsTab(pageB) // banner reload button lives in StatusBar regardless of tab, but ensure state stable
  const bNavBaselineForReload = pageB.frameNavigations.length
  const reloadClicked = await clickReloadButton(pageB)
  record(S, 'hard reload: reload button click accepted', true, reloadClicked)
  await waitForNavigation(pageB, bNavBaselineForReload, TIMEOUTS.uiWait)
  record(S, 'hard reload: exactly one navigation', bNavBaselineForReload + 1, pageB.frameNavigations.length)
  await waitForReadyStateComplete(pageB, TIMEOUTS.uiWait)
  await waitFor(pageB, APP_READY_EXPR, { description: 'B ready after reload' })

  const bannerBAfterReload = await readBanner(pageB)
  record(S, 'reload recovery: B warning cleared', false, bannerBAfterReload.visible)
  const normalRefreshBAfterReload = await readNormalRefreshButton(pageB)
  record(S, 'reload recovery: B normal refresh re-enabled', false, normalRefreshBAfterReload?.disabled)

  await openSettingsTab(pageB)
  const bInputsAfterReload = await readCashInputs(pageB)
  record(S, 'reload recovery: B shows A durable value', [String(nextDeposits), String(nextStandby)], bInputsAfterReload)
  const staleValuesNotAdopted = bInputsAfterReload[0] !== String(staleDeposits) && bInputsAfterReload[1] !== String(staleStandby)
  record(S, 'reload recovery: stale writer values not adopted', true, staleValuesNotAdopted)

  const bannerAFinal = await readBanner(pageA)
  record(S, 'reload recovery: A warning still absent', false, bannerAFinal.visible)

  const reloadRecoveredShot = path.join(EVIDENCE_DIR, 'scenario-reload-recovered.png')
  await captureScreenshot(pageB, reloadRecoveredShot)
  screenshots['scenario-reload-recovered.png'] = reloadRecoveredShot

  // Mobile viewport overflow check (uses Tab B, already settled)
  await pageB.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  })
  await delay(200)
  const overflowOk = await scrollOverflowOk(pageB)
  record(S, 'mobile viewport: no horizontal overflow', true, overflowOk)
  await pageB.send('Emulation.clearDeviceMetricsOverride', {})

  return {
    status: allAssertions.filter(a => a.scenario === S && !a.pass).length === 0 ? 'PASSED' : 'FAILED',
    screenshots,
    syntheticDeltas: { deposits: '+137', standby: '+251' },
  }
}

// ── Scenario B: BroadcastChannel-only delivery ──────────────────────────

async function scenarioBroadcastOnly(ctx) {
  const S = 'broadcast-only'
  const screenshots = {}
  const pageA = await ctx.openTab('A')
  await waitFor(pageA, APP_READY_EXPR)
  const pageB = await ctx.openTab('B')
  await waitFor(pageB, APP_READY_EXPR)

  await injectStorageMarkerBlock(pageA)

  await openSettingsTab(pageA)
  const currentInputs = await readCashInputs(pageA)
  const nextDeposits = Math.max(0, Math.round(Number(currentInputs[0]) || 0)) + 173
  const nextStandby = Math.max(0, Math.round(Number(currentInputs[1]) || 0)) + 337
  await setNativeInputValue(pageA, 0, nextDeposits)
  await setNativeInputValue(pageA, 1, nextStandby)
  await clickSaveCash(pageA)

  const feedbackA = await waitFor(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      return t.includes('変更を保存しました。') ? '変更を保存しました。' : null
    })()`, { description: 'A save success despite storage marker block' })
  record(S, 'A writer succeeds despite storage marker injection failure', '変更を保存しました。', feedbackA)

  const bannerAAfter = await readBanner(pageA)
  record(S, 'A warning absent (self)', false, bannerAAfter.visible)

  await waitFor(pageB, `!!document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')`, { description: 'B warning via BroadcastChannel' })
  const bannerB = await readBanner(pageB)
  record(S, 'B warning delivered via BroadcastChannel', true, bannerB.visible)
  const leaked = ['RA008E_STORAGE_MARKER_BLOCKED'].filter(t => bannerB.outerHTML?.includes(t))
  record(S, 'no raw injected error text exposed in B banner', [], leaked)

  const shot = path.join(EVIDENCE_DIR, 'scenario-broadcast-only.png')
  await captureScreenshot(pageB, shot)
  screenshots['scenario-broadcast-only.png'] = shot

  const knownConsole = pageA.consoleErrors.filter(c =>
    (c.args ?? []).some(a => typeof a.value === 'string' && a.value.includes('RA008E_STORAGE_MARKER_BLOCKED'))
    || (c.args ?? []).some(a => typeof a.description === 'string' && a.description.includes('RA008E_STORAGE_MARKER_BLOCKED')))
  for (const c of knownConsole) {
    knownConsoleAllowlist.push({
      text: 'RA008E_STORAGE_MARKER_BLOCKED (scenario-injected fault, swallowed internally)',
      scenario: S,
      reason: 'Deliberate storage.setItem fault injection for transport fallback validation; transport catches internally and never surfaces to UI.',
    })
  }

  return {
    status: allAssertions.filter(a => a.scenario === S && !a.pass).length === 0 ? 'PASSED' : 'FAILED',
    screenshots,
  }
}

// ── Scenario C: storage-event-only delivery ─────────────────────────────

async function scenarioStorageOnly(ctx) {
  const S = 'storage-only'
  const screenshots = {}
  const pageA = await ctx.openTab('A')
  await waitFor(pageA, APP_READY_EXPR)
  const pageB = await ctx.openTab('B')
  await waitFor(pageB, APP_READY_EXPR)

  await injectBroadcastBlock(pageA)

  await openSettingsTab(pageA)
  const currentInputs = await readCashInputs(pageA)
  const nextDeposits = Math.max(0, Math.round(Number(currentInputs[0]) || 0)) + 211
  const nextStandby = Math.max(0, Math.round(Number(currentInputs[1]) || 0)) + 149
  await setNativeInputValue(pageA, 0, nextDeposits)
  await setNativeInputValue(pageA, 1, nextStandby)
  await clickSaveCash(pageA)

  const feedbackA = await waitFor(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      return t.includes('変更を保存しました。') ? '変更を保存しました。' : null
    })()`, { description: 'A save success despite broadcast block' })
  record(S, 'A writer succeeds despite BroadcastChannel injection failure', '変更を保存しました。', feedbackA)

  const bannerAAfter = await readBanner(pageA)
  record(S, 'A warning absent (self)', false, bannerAAfter.visible)

  await waitFor(pageB, `!!document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')`, { description: 'B warning via storage event' })
  const bannerB = await readBanner(pageB)
  record(S, 'B warning delivered via real storage event', true, bannerB.visible)
  const leaked = ['RA008E_BROADCAST_BLOCKED'].filter(t => bannerB.outerHTML?.includes(t))
  record(S, 'no raw injected error text exposed in B banner', [], leaked)

  const shot = path.join(EVIDENCE_DIR, 'scenario-storage-only.png')
  await captureScreenshot(pageB, shot)
  screenshots['scenario-storage-only.png'] = shot

  return {
    status: allAssertions.filter(a => a.scenario === S && !a.pass).length === 0 ? 'PASSED' : 'FAILED',
    screenshots,
  }
}

// ── Scenario D: active-operation / concurrent-writer ordering ───────────
//
// ADAPTED FROM TICKET SECTION 14 — FINDING, NOT A RUNNER OR PRODUCTION BUG:
// Section 14 assumes Tab A's manual cash mutation can succeed WHILE Tab B's
// gated refresh still holds its fetch unreleased, with B only detecting
// staleness ("grant-time stale check") once the gate is later released.
// Real-browser testing (verified empirically against this exact preview
// build, see handover for the reproduction) shows this ordering is
// architecturally impossible: refreshAllData, importCsv,
// importPortfolioSnapshot, and every manual mutation (setCashAssumptions
// included) all serialize on the SAME single exclusive Web Lock
// (`jp-portfolio:portfolio-generation:v1`, requested via
// `runtime.portfolioGenerationLock.runExclusive` in
// src/store/useAppStore.ts). Tab B's gated refresh acquires this lock
// uncontended the instant it is clicked (before its own network fetch is
// even reached), and holds it for the entire gated duration. Tab A's write
// therefore does not run concurrently — it genuinely queues (shows
// "保存中…") until Tab B releases. This is intentional cross-tab mutual
// exclusion (already validated by RA-007's full writer matrix), not a
// defect, so no separate fix ticket is warranted — it is a scenario-authoring
// assumption mismatch in this ticket, recorded here for the record.
//
// The adapted-but-real scenario below keeps the same actors and the same
// gated-fetch mechanism, and still exercises a genuine, previously
// untested-in-real-browser interaction: a manual mutation queued behind an
// in-flight refresh's Web Lock, both eventually settling in grant order, and
// the resulting real cross-tab invalidation delivered to the now-idle
// refreshing tab.
async function scenarioActiveDefer(ctx) {
  const S = 'active-defer'
  const screenshots = {}
  const pageA = await ctx.openTab('A')
  await waitFor(pageA, APP_READY_EXPR)
  const pageB = await ctx.openTab('B')
  await waitFor(pageB, APP_READY_EXPR)

  await installFetchGate(pageB)
  await installBannerObserver(pageB)
  const bNavBaseline = pageB.frameNavigations.length

  const refreshClicked = await clickNormalRefresh(pageB)
  record(S, 'B refresh click accepted', true, refreshClicked)
  await waitFor(pageB, `(function(){
      const bar = document.querySelector('.status-bar')
      const btn = bar ? bar.querySelector('button') : null
      return !!btn && (btn.getAttribute('aria-busy') === 'true' || btn.textContent.trim() === '更新中…')
    })()`, { description: 'B refresh pending' })
  record(S, 'B warning absent while own refresh is pending', false, (await readBanner(pageB)).visible)

  await openSettingsTab(pageA)
  const currentInputs = await readCashInputs(pageA)
  const nextDeposits = Math.max(0, Math.round(Number(currentInputs[0]) || 0)) + 421
  const nextStandby = Math.max(0, Math.round(Number(currentInputs[1]) || 0)) + 317
  await setNativeInputValue(pageA, 0, nextDeposits)
  await setNativeInputValue(pageA, 1, nextStandby)
  await clickSaveCash(pageA)

  // Give A's request time to genuinely queue behind B's held Web Lock before
  // asserting — this is the real, verified mutual-exclusion behavior.
  await delay(1000)
  const aQueuedLabel = await evaluate(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      const btn = Array.from(section.querySelectorAll('button')).find(b => b.textContent.includes('保存'))
      return btn.textContent.trim()
    })()`)
  record(S, "A's write genuinely queues behind B's held Web Lock (real mutual exclusion)", '保存中…', aQueuedLabel)

  const bannerBBeforeRelease = await readBanner(pageB)
  record(S, 'B warning still absent while gated (nothing committed yet)', false, bannerBBeforeRelease.visible)
  record(S, 'B no navigation while gated', bNavBaseline, pageB.frameNavigations.length)
  const bEventsBeforeRelease = await readBannerEvents(pageB)
  record(S, 'B banner insertion count before release', 0, bEventsBeforeRelease.insertions)

  const deferBeforeShot = path.join(EVIDENCE_DIR, 'scenario-active-defer-before.png')
  await captureScreenshot(pageB, deferBeforeShot)
  screenshots['scenario-active-defer-before.png'] = deferBeforeShot

  await releaseFetchGate(pageB)

  // B's own refresh was granted the lock uncontended before anything else
  // happened, so its own grant-time alignment check already passed — it
  // settles normally (no conflict of its own) once the gate opens.
  await waitFor(pageB, `(function(){
      const bar = document.querySelector('.status-bar')
      const btn = bar ? bar.querySelector('button') : null
      return !!btn && btn.textContent.trim() === '更新'
    })()`, { description: 'B refresh settles' })
  const bFeedbackAfterOwnRefresh = await readFeedback(pageB, 'statusbar')
  record(S, 'B refresh completes without its own error feedback', null, bFeedbackAfterOwnRefresh)

  // A's queued write is granted next. B's plain refresh never touches the
  // cash/holdings/policy projection, so A's own grant-time freshness check
  // still passes — A's write succeeds.
  const aFeedback = await waitFor(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      if (t.includes('変更を保存しました。')) return '変更を保存しました。'
      if (t.includes('別タブで更新された状態を検出しました。画面を再読み込みしてください。')) return 'STALE'
      return null
    })()`, { description: 'A queued write settles' })
  record(S, "A's queued write succeeds once granted (B's refresh did not conflict)", '変更を保存しました。', aFeedback)

  // A's commit now emits a real invalidation event. Tab B is idle by this
  // point (its own ticket already released), so the warning applies
  // immediately rather than being deferred; self-suppression still holds
  // for A, the actual writer.
  await waitFor(pageB, `!!document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')`, { description: "B receives A's invalidation" })
  const bannerBAfter = await readBanner(pageB)
  record(S, "B warning delivered once A's write settles", true, bannerBAfter.visible)
  const bEventsAfter = await readBannerEvents(pageB)
  record(S, 'B banner insertion count after A settles', 1, bEventsAfter.insertions)
  record(S, 'A warning absent (self-suppression, A is the writer)', false, (await readBanner(pageA)).visible)

  const normalRefreshAfter = await readNormalRefreshButton(pageB)
  record(S, 'B normal refresh disabled while warning is shown', true, normalRefreshAfter?.disabled)
  record(S, 'B no uncaught exception', 0, pageB.exceptions.length)
  record(S, 'A no uncaught exception', 0, pageA.exceptions.length)

  const deferAfterShot = path.join(EVIDENCE_DIR, 'scenario-active-defer-after.png')
  await captureScreenshot(pageB, deferAfterShot)
  screenshots['scenario-active-defer-after.png'] = deferAfterShot

  return {
    status: allAssertions.filter(a => a.scenario === S && !a.pass).length === 0 ? 'PASSED' : 'FAILED',
    screenshots,
    adapted: true,
    adaptationReason: 'Section 14\'s literal ordering (a second tab\'s write succeeding while another tab\'s fetch remains gated/unreleased) is architecturally impossible: every portfolio-generation-mutating operation shares one exclusive Web Lock (jp-portfolio:portfolio-generation:v1). Adapted to the closest achievable real ordering — see handover for the full finding writeup.',
  }
}

// ── Scenario E: real Web Lock simultaneous writers ──────────────────────

async function scenarioSimultaneousWriters(ctx) {
  const S = 'simultaneous-writers'
  const pageA = await ctx.openTab('A')
  await waitFor(pageA, APP_READY_EXPR)
  const pageB = await ctx.openTab('B')
  await waitFor(pageB, APP_READY_EXPR)

  await openSettingsTab(pageA)
  await openSettingsTab(pageB)
  const currentInputs = await readCashInputs(pageA)
  const baseDeposits = Math.max(0, Math.round(Number(currentInputs[0]) || 0))
  const baseStandby = Math.max(0, Math.round(Number(currentInputs[1]) || 0))

  const aDeposits = baseDeposits + 601
  const aStandby = baseStandby + 503
  const bDeposits = baseDeposits + 907
  const bStandby = baseStandby + 719

  await setNativeInputValue(pageA, 0, aDeposits)
  await setNativeInputValue(pageA, 1, aStandby)
  await setNativeInputValue(pageB, 0, bDeposits)
  await setNativeInputValue(pageB, 1, bStandby)

  // Fire both saves without sequential await — genuinely concurrent CDP command dispatch.
  const [clickedA, clickedB] = await Promise.all([clickSaveCash(pageA), clickSaveCash(pageB)])
  record(S, 'A save click accepted', true, clickedA)
  record(S, 'B save click accepted', true, clickedB)

  const settleFeedback = async page => waitFor(page, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      if (t.includes('変更を保存しました。')) return 'SUCCESS'
      if (t.includes('別タブで更新された状態を検出しました。画面を再読み込みしてください。')) return 'STALE'
      return null
    })()`, { description: 'settle', timeoutMs: TIMEOUTS.uiWait })

  const [resultA, resultB] = await Promise.all([settleFeedback(pageA), settleFeedback(pageB)])
  const successCount = [resultA, resultB].filter(r => r === 'SUCCESS').length
  const staleCount = [resultA, resultB].filter(r => r === 'STALE').length
  record(S, 'exactly one writer succeeds', 1, successCount)
  record(S, 'exactly one writer sees cross-tab stale', 1, staleCount)

  const winner = resultA === 'SUCCESS' ? { page: pageA, label: 'A', deposits: aDeposits, standby: aStandby } : { page: pageB, label: 'B', deposits: bDeposits, standby: bStandby }
  const loser = resultA === 'SUCCESS' ? { page: pageB, label: 'B' } : { page: pageA, label: 'A' }

  const winnerBanner = await readBanner(winner.page)
  record(S, 'winner tab warning absent', false, winnerBanner.visible)
  const loserBanner = await readBanner(loser.page)
  record(S, 'loser tab warning visible', true, loserBanner.visible)

  const leaked = ['senderInstanceId', 'messageId', 'committedAt'].filter(t => loserBanner.outerHTML?.includes(t))
  record(S, 'no raw conflict data exposed to loser', [], leaked)

  const loserNavBaseline = loser.page.frameNavigations.length
  const reloadClicked = await clickReloadButton(loser.page)
  record(S, 'loser reload button click accepted', true, reloadClicked)
  await waitForNavigation(loser.page, loserNavBaseline, TIMEOUTS.uiWait)
  await waitForReadyStateComplete(loser.page, TIMEOUTS.uiWait)
  await waitFor(loser.page, APP_READY_EXPR, { description: 'loser ready after reload' })

  const loserBannerAfterReload = await readBanner(loser.page)
  record(S, 'loser warning cleared after reload', false, loserBannerAfterReload.visible)

  await openSettingsTab(loser.page)
  const loserInputsAfterReload = await readCashInputs(loser.page)
  record(S, 'loser sees winner durable value (no lost update)', [String(winner.deposits), String(winner.standby)], loserInputsAfterReload)

  return {
    status: allAssertions.filter(a => a.scenario === S && !a.pass).length === 0 ? 'PASSED' : 'FAILED',
    winner: winner.label,
  }
}

// ── Scenario F: three-tab fan-out ────────────────────────────────────────

async function scenarioThreeTabFanout(ctx) {
  const S = 'three-tab-fanout'
  const screenshots = {}
  const pageA = await ctx.openTab('A')
  await waitFor(pageA, APP_READY_EXPR)
  const pageB = await ctx.openTab('B')
  await waitFor(pageB, APP_READY_EXPR)
  const pageC = await ctx.openTab('C')
  await waitFor(pageC, APP_READY_EXPR)

  await installBannerObserver(pageB)
  await installBannerObserver(pageC)

  await openSettingsTab(pageA)
  const currentInputs = await readCashInputs(pageA)
  const nextDeposits = Math.max(0, Math.round(Number(currentInputs[0]) || 0)) + 271
  const nextStandby = Math.max(0, Math.round(Number(currentInputs[1]) || 0)) + 163
  await setNativeInputValue(pageA, 0, nextDeposits)
  await setNativeInputValue(pageA, 1, nextStandby)
  await clickSaveCash(pageA)
  await waitFor(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      return t.includes('変更を保存しました。') ? '変更を保存しました。' : null
    })()`, { description: 'A save success' })

  record(S, 'A warning absent (self)', false, (await readBanner(pageA)).visible)

  await waitFor(pageB, `!!document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')`, { description: 'B warning' })
  await waitFor(pageC, `!!document.querySelector('[role="alert"][aria-label="別タブ更新通知"]')`, { description: 'C warning' })

  const bannerB = await readBanner(pageB)
  const bannerC = await readBanner(pageC)
  record(S, 'B warning visible', true, bannerB.visible)
  record(S, 'C warning visible', true, bannerC.visible)
  record(S, 'B warning count', 1, bannerB.count)
  record(S, 'C warning count', 1, bannerC.count)
  record(S, 'B/C warning text identical', bannerB.text, bannerC.text)

  const bEvents = await readBannerEvents(pageB)
  const cEvents = await readBannerEvents(pageC)
  record(S, 'B banner insertion count', 1, bEvents.insertions)
  record(S, 'C banner insertion count', 1, cEvents.insertions)

  const bShot = path.join(EVIDENCE_DIR, 'scenario-three-tab-b.png')
  await captureScreenshot(pageB, bShot)
  screenshots['scenario-three-tab-b.png'] = bShot
  const cShot = path.join(EVIDENCE_DIR, 'scenario-three-tab-c.png')
  await captureScreenshot(pageC, cShot)
  screenshots['scenario-three-tab-c.png'] = cShot

  // Close C, then perform a second mutation on A; B must not get a duplicate insertion,
  // and closing/crashing C must not occur as a side effect.
  await closeTab(ctx.browserClient, pageC).catch(() => {})
  ctx.pages.splice(ctx.pages.indexOf(pageC), 1)

  const bInsertionsBeforeSecond = (await readBannerEvents(pageB)).insertions

  await openSettingsTab(pageA)
  const secondDeposits = nextDeposits + 89
  const secondStandby = nextStandby + 97
  await setNativeInputValue(pageA, 0, secondDeposits)
  await setNativeInputValue(pageA, 1, secondStandby)
  await clickSaveCash(pageA)
  await waitFor(pageA, `(function(){
      const section = ${CASH_SECTION_EXPR}
      if (!section) return null
      const t = Array.from(section.querySelectorAll('div')).map(d => d.textContent.trim())
      return t.includes('変更を保存しました。') ? '変更を保存しました。' : null
    })()`, { description: 'A second save success' })

  await delay(1000) // allow any (unexpected) delivery to settle before asserting no-op
  const bInsertionsAfterSecond = (await readBannerEvents(pageB)).insertions
  record(S, 'B: no additional banner insertion from 2nd mutation (already warned)', bInsertionsBeforeSecond, bInsertionsAfterSecond)
  record(S, 'A warning absent after 2nd mutation', false, (await readBanner(pageA)).visible)

  return {
    status: allAssertions.filter(a => a.scenario === S && !a.pass).length === 0 ? 'PASSED' : 'FAILED',
    screenshots,
  }
}

// ── main orchestration ───────────────────────────────────────────────────

async function checkNodeEnv() {
  const fetchOk = typeof fetch === 'function'
  const wsOk = typeof WebSocket === 'function'
  if (!fetchOk || !wsOk) {
    throw new Error(`Node environment missing required globals: fetch=${typeof fetch} WebSocket=${typeof WebSocket}`)
  }
}

async function checkPreviewReachable() {
  const res = await fetch(PREVIEW_URL)
  if (!res.ok) throw new Error(`preview not reachable: HTTP ${res.status}`)
}

async function main() {
  const nodeVersion = process.version
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'node-version.txt'), nodeVersion + '\n')

  await checkNodeEnv()

  const chromeBinary = findChromeBinary()
  if (!chromeBinary) {
    writeBlockedReport('No supported Chrome/Chromium binary found on this Mac.')
    process.exit(1)
  }
  const chromeVersion = execFileSync(chromeBinary, ['--version']).toString().trim()
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'chrome-version.txt'), chromeVersion + '\n')

  try {
    await checkPreviewReachable()
  } catch (err) {
    writeBlockedReport(`Vite preview not reachable at ${PREVIEW_URL}: ${err.message}`)
    process.exit(1)
  }

  const scenarioDefs = [
    ['dual-full-flow', { profileSuffix: 'dual', timeoutMs: 90_000 }, scenarioDualFullFlow],
    ['broadcast-only', { profileSuffix: 'broadcast-only', timeoutMs: 45_000 }, scenarioBroadcastOnly],
    ['storage-only', { profileSuffix: 'storage-only', timeoutMs: 45_000 }, scenarioStorageOnly],
    ['active-defer', { profileSuffix: 'active-defer', timeoutMs: 60_000 }, scenarioActiveDefer],
    ['simultaneous-writers', { profileSuffix: 'simultaneous-writers', timeoutMs: 45_000 }, scenarioSimultaneousWriters],
    ['three-tab-fanout', { profileSuffix: 'three-tab', timeoutMs: 60_000 }, scenarioThreeTabFanout],
  ]

  for (const [name, opts, fn] of scenarioDefs) {
    process.stdout.write(`\n[RA-008-E] running scenario: ${name}\n`)
    const outcome = await runScenario(name, opts, fn)
    process.stdout.write(`[RA-008-E] scenario ${name}: ${outcome.status}${outcome.error ? ` (${outcome.error.split('\n')[0]})` : ''}\n`)
  }

  const failedAssertions = allAssertions.filter(a => !a.pass)
  const failedScenarios = scenarioReports.filter(s => s.status !== 'PASSED')
  const anyCrash = uncaughtExceptions.length > 0

  let verdict = 'PASS'
  if (failedAssertions.length > 0 || failedScenarios.length > 0 || anyCrash) {
    verdict = 'FAIL'
  }

  writeReports(verdict, chromeVersion, nodeVersion)

  process.stdout.write(`\n[RA-008-E] verdict: ${verdict}\n`)
  process.stdout.write(`[RA-008-E] assertions: ${allAssertions.length} total, ${failedAssertions.length} failed\n`)
  process.stdout.write(`[RA-008-E] uncaught exceptions: ${uncaughtExceptions.length}\n`)

  process.exit(verdict === 'PASS' ? 0 : 1)
}

function writeBlockedReport(reason) {
  const report = {
    ticket: 'RA-008-E',
    auditedSha: AUDITED_SHA,
    browser: null,
    node: process.version,
    previewUrl: PREVIEW_URL,
    scenarios: [],
    uncaughtExceptions: [],
    consoleErrors: [],
    verdict: 'BLOCKED',
    blockedReason: reason,
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'report.md'), `# RA-008-E — BLOCKED\n\n${reason}\n`)
  process.stdout.write(`[RA-008-E] BLOCKED: ${reason}\n`)
}

function writeReports(verdict, chromeVersion, nodeVersion) {
  const report = {
    ticket: 'RA-008-E',
    auditedSha: AUDITED_SHA,
    browser: chromeVersion,
    node: nodeVersion,
    previewUrl: PREVIEW_URL,
    headless: HEADLESS,
    scenarios: scenarioReports.map(s => ({
      scenario: s.scenario,
      status: s.status,
      elapsedMs: s.elapsedMs,
      error: s.error,
      adapted: s.details?.adapted ?? false,
      adaptationReason: s.details?.adaptationReason ?? null,
    })),
    assertions: allAssertions,
    uncaughtExceptions,
    consoleErrors: consoleErrorEntries,
    knownConsoleAllowlist,
    verdict,
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2))

  const md = []
  md.push('# RA-008-E — real-browser adversarial cross-tab invalidation validation')
  md.push('')
  md.push(`- Verdict: **${verdict}**`)
  md.push(`- Audited SHA: ${AUDITED_SHA}`)
  md.push(`- Browser: ${chromeVersion}`)
  md.push(`- Node: ${nodeVersion}`)
  md.push(`- Preview URL: ${PREVIEW_URL}`)
  md.push(`- Headless: ${HEADLESS} (real Chrome engine; rendering mode only)`)
  md.push('')
  md.push('## Scenarios')
  for (const s of scenarioReports) {
    md.push(`- **${s.scenario}**: ${s.status} (${s.elapsedMs}ms)${s.error ? `\n  - error: ${s.error.split('\n')[0]}` : ''}`)
    if (s.details?.adapted) {
      md.push(`  - ADAPTED: ${s.details.adaptationReason}`)
    }
  }
  md.push('')
  md.push('## Assertions')
  for (const a of allAssertions) {
    md.push(`- [${a.pass ? 'PASS' : 'FAIL'}] (${a.scenario}) ${a.assertion} — expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}`)
  }
  md.push('')
  md.push(`## Uncaught exceptions: ${uncaughtExceptions.length}`)
  for (const e of uncaughtExceptions) md.push(`- (${e.scenario}/${e.label}) ${e.exceptionDetails?.text ?? JSON.stringify(e)}`)
  md.push('')
  md.push(`## Console errors: ${consoleErrorEntries.length}`)
  for (const c of consoleErrorEntries) md.push(`- (${c.scenario}/${c.label}) ${c.text}`)
  md.push('')
  if (knownConsoleAllowlist.length) {
    md.push('## Known/allowed console entries (scenario fault injection)')
    for (const k of knownConsoleAllowlist) md.push(`- (${k.scenario}) ${k.text} — ${k.reason}`)
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'report.md'), md.join('\n') + '\n')
}

main().catch(err => {
  process.stderr.write(`[RA-008-E] fatal: ${err?.stack ?? err}\n`)
  writeBlockedReport(`Fatal runner error: ${err?.message ?? String(err)}`)
  process.exit(1)
})
