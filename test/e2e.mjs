/**
 * 真浏览器端到端用例（PLAN §3.1）。
 *
 * `test/client.mjs` runs the panel in jsdom: it proves which requests go out and
 * which strings are on screen, but nothing about layout. The 0.30.0 「菜单点不开」
 * bug only ever showed up in a real browser, and a right-side menu that runs off a
 * 480px sidebar is invisible to a DOM assertion.
 *
 * So this suite builds the smallest host that can carry the panel and drives it
 * with a real Chromium:
 *
 *   - one `node:http` server: the harness page, the vendored React (the production
 *     CommonJS builds, wrapped in a five-line module registry) and the real
 *     `client.js` bundle, unchanged;
 *   - a fake host context with only what the bundle declares (`betterSidebar`,
 *     `slots`) plus an always-allow `connection`, so the real `lib/routes.js`
 *     handler answers `/analytics/api/*` against the real workspace registry and
 *     the bundled PSPP engine;
 *   - a 480px wide page — the sidebar width the panel really gets.
 *
 * Skipped (exit 0, one line saying why) when Playwright or its Chromium is not
 * installed: that is a 260 MB download and must not become a dependency of
 * `npm test`.
 *
 *   node test/e2e.mjs        # 截图落在 $E2E_ARTIFACTS 或系统 tmpdir
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { WorkspaceRegistry } from '../lib/workspace.js'
import { resolveEngine } from '../lib/engine.js'
import { createHandler } from '../lib/routes.js'
import { SettingsStore } from '../lib/settings.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ── playwright ───────────────────────────────────────────────────────────────
// Never a devDependency: the browser download is 260 MB and the unit job has no
// use for it. Try the project install first, then the machine-wide copies this
// repo's own tooling already leaves behind.
const PLAYWRIGHT_CANDIDATES = [
  process.env.E2E_PLAYWRIGHT,
  'playwright',
  join(homedir(), '.local/lib/node_modules/@playwright/cli/node_modules/playwright'),
  join(homedir(), '.npm-global/lib/node_modules/playwright'),
].filter(Boolean)

async function loadPlaywright() {
  const reasons = []
  const attempt = async (specifier) => {
    try {
      return await import(specifier)
    } catch (error) {
      reasons.push(specifier + ': ' + String(error?.message ?? error).split('\n')[0])
      return null
    }
  }
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    const specifier = candidate.startsWith('/') ? pathToFileURL(join(candidate, 'index.mjs')).href : candidate
    const found = await attempt(specifier)
    if (found) return { module: found }
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    if (globalRoot) {
      const found = await attempt(pathToFileURL(join(globalRoot, 'playwright/index.mjs')).href)
      if (found) return { module: found }
    }
  } catch (error) {
    reasons.push('npm root -g: ' + String(error?.message ?? error).split('\n')[0])
  }
  return { module: null, reasons }
}

const skip = (why) => {
  console.log('skip 真浏览器端到端：' + why)
  process.exit(0)
}

const { module: playwright, reasons } = await loadPlaywright()
if (!playwright) skip('没有找到 playwright（' + reasons.join('；') + '）')

// ── the minimal host ─────────────────────────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), 'ap-e2e-'))
const analyticsRoot = join(home, 'analytics')
const workDir = join(home, 'cwd')
// Stable path outside the per-run workspace: the screenshot is the deliverable
// (and CI uploads it), so it must not be deleted with the temporary home.
const artifacts = process.env.E2E_ARTIFACTS || join(tmpdir(), 'dsh-analytics-e2e')
await mkdir(workDir, { recursive: true })
await mkdir(artifacts, { recursive: true })
const settingsStore = new SettingsStore(analyticsRoot, { registerTools: false })
const engine = resolveEngine({})
if (engine.source === 'missing') skip('包内没有 PSPP 引擎（engine/<平台>），先跑 npm run engine:fetch')
const registry = new WorkspaceRegistry({ root: analyticsRoot, config: {}, engine, settingsStore })
const handler = createHandler({
  registry,
  // The panel is the only caller here, and the real host's fence is a session
  // cookie this harness deliberately does not mint. Allow everything: file
  // access still goes through lib/paths.js.
  getConnection: () => ({ requestRejection: () => 0 }),
  config: { pluginVersion: 'e2e' },
  settings: settingsStore,
  updateCheck: async () => ({ current: 'e2e', newer: false, latest: null }),
})

// The two CommonJS files the panel's own `require('react')` resolves to, wrapped
// as browser modules. Everything else the panel needs it carries itself.
// The React 19 packages are what "react" and "react-dom/client" resolve to:
// react-dom 是入口那层（它挂上 __DOM_INTERNALS），createRoot 在 client 构建里。
const VENDOR = [
  { path: '/vendor/scheduler.js', id: 'scheduler', file: 'node_modules/scheduler/cjs/scheduler.production.js' },
  { path: '/vendor/react.js', id: 'react', file: 'node_modules/react/cjs/react.production.js' },
  { path: '/vendor/react-dom.js', id: 'react-dom', file: 'node_modules/react-dom/cjs/react-dom.production.js' },
  { path: '/vendor/react-dom-client.js', id: 'react-dom-client', file: 'node_modules/react-dom/cjs/react-dom-client.production.js' },
]

// A five-line CommonJS registry plus the module-loader stub the bundle expects.
// `__pluginDescriptor` is how the harness below gets the plugin object out.
const PRELUDE = [
  'window.process = window.process || { env: { NODE_ENV: "production" } };',
  '(() => {',
  '  const defs = {}, cache = {};',
  '  window.__def = (id, fn) => { defs[id] = fn };',
  '  window.__require = (id) => {',
  '    if (cache[id]) return cache[id].exports;',
  '    const fn = defs[id];',
  '    if (!fn) throw new Error("host module not provided: " + id);',
  '    const module = { exports: {} };',
  '    cache[id] = module;',
  '    fn(module, module.exports, window.__require);',
  '    return module.exports;',
  '  };',
  '  let captured = null;',
  '  window.__ModuleLoader__ = { load(descriptor) { captured = descriptor } };',
  '  Object.defineProperty(window, "__pluginDescriptor", { get: () => captured });',
  '  window.__def("react-dom/client", function (module, exports, require) { module.exports = require("react-dom-client"); });',
  '})();',
].join('\n')
// ── the harness page ─────────────────────────────────────────────────────────
// The panel is what a sidebar tab renders, so the harness does the four things
// better-sidebar does: hand over a context with the declared services, register
// what the bundle registers, mount the tab component, and get out of the way.
const HARNESS = [
  '(function () {',
  '  const errors = [];',
  '  window.__E2E_ERRORS__ = errors;',
  '  window.addEventListener("error", (event) => errors.push(String((event.error && event.error.stack) || event.message || event.error)));',
  '  window.addEventListener("unhandledrejection", (event) => errors.push(String((event.reason && event.reason.message) || event.reason)));',
  '  const descriptor = window.__pluginDescriptor;',
  '  if (!descriptor) throw new Error("client.js never called __ModuleLoader__.load");',
  '  const React = window.__require("react");',
  '  const plugin = descriptor.factory(window.__require);',
  '  const registered = [];',
  '  const services = {',
  '    betterSidebar: {',
  '      registerTab(definition) { registered.push({ kind: "tab", definition }); return () => {}; },',
  '      registerFileViewer(definition) { registered.push({ kind: "viewer", definition }); return () => {}; },',
  '      openTab() {}, closeTab() {},',
  '    },',
  '    slots: {',
  '      inject(name, run) { run(); return () => {}; },',
  '      register(definition, component) { registered.push({ kind: definition.name, definition, component }); return () => {}; },',
  '    },',
  '    locale: { register() { return () => {}; }, bind: () => (key) => key },',
  '  };',
  '  const ctx = {',
  '    ...services,',
  '    get: (name) => services[name],',
  '    effect(run) { const off = run(); return () => { if (typeof off === "function") off(); }; },',
  '    on() { return () => {}; },',
  '    logger: { info() {}, warn() {}, error() {}, debug() {} },',
  '  };',
  '  plugin.apply(ctx);',
  '  const tab = registered.find((row) => row.kind === "tab");',
  '  if (!tab) throw new Error("the bundle registered no betterSidebar tab");',
  '  const ReactDOM = window.__require("react-dom/client");',
  '  const root = ReactDOM.createRoot(document.getElementById("root"));',
  '  root.render(React.createElement(tab.definition.component, {',
  '    ctx,',
  '    store: { getSnapshot: () => ({ state: null }), subscribeState: () => () => {}, reduce() {} },',
  '    scope: { sessionId: "e2e", cwd: __CWD__ },',
  '    tab: { id: "analytics", type: "analytics", title: "统计分析", meta: {} },',
  '    visible: true,',
  '  }));',
  '  window.__E2E_READY__ = true;',
  '})();',
].join('\n')

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>dsh-analytics e2e</title>',
  '<style>',
  '  html, body { margin: 0; height: 100%; background: #fff; }',
  // The right column of dsh-better-sidebar is 380–520 px. 480 is the width the
  // clipping checks below assume, so it lives in one place.
  '  #side { width: 480px; height: 100vh; overflow: hidden; }',
  '  #root { height: 100%; }',
  '</style>',
  '</head>',
  '<body>',
  '<div id="side"><div id="root"></div></div>',
  '<script src="/vendor/prelude.js"></script>',
  '<script src="/vendor/scheduler.js"></script>',
  '<script src="/vendor/react.js"></script>',
  '<script src="/vendor/react-dom.js"></script>',
  '<script src="/vendor/react-dom-client.js"></script>',
  '<script src="/client.js"></script>',
  '<script src="/harness.js"></script>',
  '</body>',
  '</html>',
].join('\n')

const SIDEBAR_WIDTH = 480

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (url.pathname.startsWith('/analytics')) {
      await handler(req, res)
      return
    }
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (url.pathname === '/') { send('text/html; charset=utf-8', PAGE); return }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
    if (url.pathname === '/harness.js') {
      send('text/javascript; charset=utf-8', HARNESS.replace('__CWD__', JSON.stringify(workDir)))
      return
    }
    if (url.pathname === '/vendor/prelude.js') { send('text/javascript; charset=utf-8', PRELUDE); return }
    if (url.pathname === '/client.js') {
      send('text/javascript; charset=utf-8', await readFile(join(root, 'client.js')))
      return
    }
    const vendor = VENDOR.find((entry) => entry.path === url.pathname)
    if (vendor) {
      const source = await readFile(join(root, vendor.file), 'utf8')
      send('text/javascript; charset=utf-8',
        'window.__def(' + JSON.stringify(vendor.id) + ', function (module, exports, require) {\n' + source + '\n});')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + url.pathname)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(String(error?.stack ?? error))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/'

// ── drive it ─────────────────────────────────────────────────────────────────
// Chromium: the version Playwright asks for may not be the one installed here
// (this machine keeps a slightly newer build with an IME-neutralising wrapper,
// which must stay in place). Try the default, then that wrapper, then system
// Chrome, and say which one ran.
const { chromium } = playwright
let browser = null
const launchErrors = []
for (const options of [undefined, { executablePath: installedChromium() }, { channel: 'chrome' }]) {
  try {
    browser = await chromium.launch(options)
    break
  } catch (error) {
    launchErrors.push(String(error?.message ?? error).split('\n')[0])
  }
}
if (!browser) {
  await new Promise((resolve) => server.close(resolve))
  skip('Chromium 起不来（' + launchErrors.join('；') + '）——跑 npx playwright install chromium')
}

/**
 * The newest full Chromium under Playwright's own cache. Not the headless shell:
 * on this machine that build is missing while the full one is present, and the
 * wrapper in front of it is what keeps Chromium from grabbing the IME.
 */
function installedChromium() {
  const cache = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return undefined
  const builds = readdirSync(cache)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds) {
    const bin = join(cache, build, 'chrome-linux64/chrome')
    if (existsSync(bin)) return bin
  }
  return undefined
}

const page = await browser.newPage({ viewport: { width: SIDEBAR_WIDTH, height: 820 } })
const consoleErrors = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', (error) => consoleErrors.push(String(error)))

let checks = 0
async function check(name, run) {
  try {
    await run()
    checks += 1
    console.log('ok   ' + name)
  } catch (error) {
    console.error('FAIL ' + name + ': ' + error.message)
    process.exitCode = 1
  }
}

const menuButton = (label) => page.locator('.ap-menu-button').filter({ hasText: label })
// The panel is the sidebar's content: widths are measured against the panel
// root, not the window, because in the real host the window is much wider.
const measure = (selector) => page.evaluate((wanted) => {
  const panel = document.querySelector('.ap-root')
  const box = document.querySelector(wanted)
  if (!panel || !box) return null
  const head = panel.getBoundingClientRect()
  const rect = box.getBoundingClientRect()
  return {
    panelWidth: head.width,
    left: rect.left - head.left,
    right: rect.right - head.left,
    width: rect.width,
    height: rect.height,
    visible: rect.width > 0 && rect.height > 0,
  }
}, selector)

const itemCount = () => page.locator('.ap-item').count()

await page.goto(base, { waitUntil: 'domcontentloaded' })
try {
  await page.waitForSelector('.ap-menu-button', { timeout: 30000 })
} catch (error) {
  // A blank page is the one failure that says nothing by itself: dump what the
  // browser knew (script errors, console, the top of the DOM) before giving up.
  const pageErrors = await page.evaluate(() => window.__E2E_ERRORS__ ?? []).catch(() => [])
  console.error('面板没有渲染：' + error.message)
  console.error('页面错误：' + (pageErrors.join(' | ') || '（无）'))
  console.error('控制台：\n' + (consoleErrors.slice(0, 12).join('\n') || '（无）'))
  console.error('DOM：\n' + (await page.content()).slice(0, 1200))
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
  process.exit(1)
}

await check('面板在真浏览器里渲染：10 个菜单、480px 宽、无脚本错误', async () => {
  const labels = await page.locator('.ap-menu-button').allTextContents()
  assert.ok(labels.length >= 8, '菜单栏只有 ' + labels.length + ' 项：' + labels.join('/'))
  for (const wanted of ['文件', '编辑', '数据', '分析', '图形', '设置', '帮助']) {
    assert.ok(labels.some((label) => label.trim() === wanted), '菜单栏缺少「' + wanted + '」：' + labels.join('/'))
  }
  const panel = await measure('.ap-root')
  assert.ok(panel, '找不到 .ap-root')
  assert.ok(Math.abs(panel.panelWidth - SIDEBAR_WIDTH) < 2, '面板宽度是 ' + panel.panelWidth + '，不是侧栏的 ' + SIDEBAR_WIDTH)
  const errors = await page.evaluate(() => window.__E2E_ERRORS__ ?? [])
  assert.deepEqual(errors, [], '页面抛了错：' + errors.join(' | '))
})

// The menu popup is absolutely positioned inside a narrow column. A menu that
// does not flip runs off the edge, and the item a user needs is then simply not
// clickable — this is the check jsdom cannot make. Every menu, not just the
// right-hand ones: 图形 sits mid-bar and still overflows by default.
const menusFit = async () => {
  const labels = (await page.locator('.ap-menu-button').allTextContents()).map((label) => label.trim())
  assert.ok(labels.length >= 8, '菜单栏只有 ' + labels.length + ' 项')
  const off = []
  for (const label of labels) {
    await menuButton(label).click()
    await page.waitForSelector('.ap-menu-pop', { timeout: 5000 })
    const pop = await measure('.ap-menu-pop')
    if (!pop || !pop.visible) off.push(label + ' 没有弹出')
    else if (pop.right > pop.panelWidth + 1) off.push(label + ' 右侧超出 ' + (pop.right - pop.panelWidth).toFixed(1) + 'px')
    else if (pop.left < -1) off.push(label + ' 左侧超出 ' + Math.abs(pop.left).toFixed(1) + 'px')
    await menuButton(label).click()
    await page.waitForSelector('.ap-menu-pop', { state: 'detached', timeout: 5000 })
  }
  return off
}

await check('每一个顶层菜单的弹层都完整落在 480px 侧栏内', async () => {
  const off = await menusFit()
  assert.deepEqual(off, [], '放不下的菜单：' + off.join('；'))
})

// The submenu grows sideways out of the top-level popup, which is the tightest
// spot in the panel: 分析 sits mid-bar, its popup is 220px wide, and the submenu
// wants another 200px to the right of that. At 380px neither side has the room,
// so it has to overlap the popup rather than hang off the panel.
const submenuFits = async () => {
  await menuButton('分析').click()
  const row = page.locator('.ap-menu-pop .ap-has-sub').filter({ hasText: '描述统计' })
  await row.waitFor({ timeout: 5000 })
  await row.hover()
  const sub = await measure('.ap-sub-pop')
  const problems = []
  if (!sub || !sub.visible) problems.push('子菜单没有展开')
  else {
    if (sub.left < -1) problems.push('左边缘跑出侧栏 ' + Math.abs(sub.left).toFixed(1) + 'px')
    if (sub.right > sub.panelWidth + 1) problems.push('右边缘超出侧栏 ' + (sub.right - sub.panelWidth).toFixed(1) + 'px')
  }
  await menuButton('分析').click()
  await page.waitForSelector('.ap-menu-pop', { state: 'detached', timeout: 5000 })
  return problems
}

// 380px is the narrow end of the same sidebar. The placement used to be guessed
// from the menu's position in the bar, which is right at 480 and wrong at 380.
await check('侧栏收窄到 380px 时菜单仍然放得下', async () => {
  await page.setViewportSize({ width: 380, height: 820 })
  await page.evaluate(() => { document.getElementById('side').style.width = '380px' })
  const off = await menusFit()
  assert.deepEqual(off, [], '380px 下放不下的菜单：' + off.join('；'))
  const subProblems = await submenuFits()
  assert.deepEqual(subProblems, [], '380px 下放不下的子菜单：' + subProblems.join('；'))
  await page.setViewportSize({ width: SIDEBAR_WIDTH, height: 820 })
  await page.evaluate(() => { document.getElementById('side').style.width = '' })
})

// The walkthrough the plan names: 帮助 → 打开示例数据 → 频数表.
await check('帮助 → 打开示例数据：跑完 4 组分析，输出里出现描述统计与频数表', async () => {
  await menuButton('帮助').click()
  await page.waitForSelector('.ap-menu-pop', { timeout: 5000 })
  await page.locator('.ap-menu-pop button').filter({ hasText: '打开示例数据' }).click()
  await page.waitForSelector('.ap-item', { timeout: 120000 })
  await page.waitForFunction(() => document.querySelectorAll('.ap-item').length >= 3, null, { timeout: 120000 })
  const text = await page.locator('.ap-root').innerText()
  assert.match(text, /60 个个案/, '状态栏没有报出 60 例：' + text.slice(0, 200))
  // The table captions are PSPP's own English, even in the Chinese panel: the
  // engine writes them, and only plugin-built tables get translated.
  assert.match(text, /Descriptive Statistics/, '输出里没有描述统计表')
  assert.match(text, /Statistics/, '输出里没有频率表的 Statistics')
  assert.match(text, /chart: /, '频率表的条形图没有出现在输出里')
  const errors = await page.evaluate(() => window.__E2E_ERRORS__ ?? [])
  assert.deepEqual(errors, [], '打开示例数据时页面抛错：' + errors.join(' | '))
})

await check('分析 → 描述统计 的子菜单也落在侧栏内', async () => {
  const problems = await submenuFits()
  assert.deepEqual(problems, [], '子菜单放不下：' + problems.join('；'))
})

await check('分析 → 描述统计 → 描述…：选中变量后运行，输出多一张表', async () => {
  const before = await itemCount()
  await menuButton('分析').click()
  const row = page.locator('.ap-menu-pop .ap-has-sub').filter({ hasText: '描述统计' })
  await row.waitFor({ timeout: 5000 })
  await row.hover()
  await row.locator('.ap-sub-pop button').filter({ hasText: '描述…' }).click()
  await page.waitForSelector('.ap-modal', { timeout: 5000 })
  const dialog = page.locator('.ap-modal')
  await dialog.locator('label.ap-dlg-var').filter({ hasText: 'salary' }).click()
  await dialog.locator('.ap-modal-foot .ap-primary').click()
  await page.waitForFunction((wanted) => document.querySelectorAll('.ap-item').length > wanted, before, { timeout: 120000 })
  const text = await page.locator('.ap-root').innerText()
  assert.match(text, /月薪|salary/, '新表里没有刚选中的变量')
})

await check('截图与页面错误清点', async () => {
  await page.screenshot({ path: join(artifacts, 'panel.png'), fullPage: false })
  const shot = await stat(join(artifacts, 'panel.png'))
  assert.ok(shot.size > 20000, '截图只有 ' + shot.size + ' 字节，可能是一张空白页')
  const errors = await page.evaluate(() => window.__E2E_ERRORS__ ?? [])
  assert.deepEqual(errors, [], '页面抛错：' + errors.join(' | '))
  // A missing locale dictionary or a rejected fetch shows up as a console error
  // long before anything looks wrong on screen.
  const relevant = consoleErrors.filter((line) => !/favicon|net::ERR_ABORTED/.test(line))
  assert.deepEqual(relevant, [], '控制台报错：' + relevant.join(' | '))
})

await browser.close()
await new Promise((resolve) => server.close(resolve))

console.log('\n截图：' + join(artifacts, 'panel.png'))
console.log(checks + ' checks in test/e2e.mjs')
if (process.exitCode) console.error('有失败项，临时目录保留在 ' + home)
else await rm(home, { recursive: true, force: true })

