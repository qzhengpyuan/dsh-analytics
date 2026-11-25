/**
 * Client-bundle tests: the panel is plain JS loaded through the module loader,
 * so there is nothing to import — the bundle is evaluated against a fake loader
 * the way the host evaluates it, then the tab it registers is rendered in jsdom.
 *
 * This is the shape dsh-plugin-toolkit's testkit uses for slot panels. Ours
 * registers a better-sidebar tab instead of a slot, so the harness below does
 * the same three things by hand: a loader, a context with the services the
 * plugin declares, and a real React root.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.MouseEvent = window.MouseEvent
globalThis.KeyboardEvent = window.KeyboardEvent
globalThis.localStorage = window.localStorage
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

const React = await import('react')
const { createRoot } = await import('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act } = React

const REQUIRED = { react: React }

function loadBundle(file) {
  globalThis.__AP_TEST_HOOKS__ = {}
  let captured
  window.__ModuleLoader__ = { load(descriptor) { captured = descriptor } }
  window.fetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true,"state":{}}' })
  const source = readFileSync(file, 'utf8')
  new Function('window', 'module', 'exports', 'require', source)(
    window,
    { exports: {} },
    {},
    (name) => {
      if (name in REQUIRED) return REQUIRED[name]
      throw new Error(`unexpected require(${name})`)
    },
  )
  assert.ok(captured, 'the bundle never called __ModuleLoader__.load')
  return captured.factory((name) => {
    if (name in REQUIRED) return REQUIRED[name]
    throw new Error(`unexpected require(${name})`)
  })
}

const registered = { tabs: [], viewers: [], settings: [], panels: [], main: [] }
function makeContext() {
  const services = {
    betterSidebar: {
      registerTab(definition) { registered.tabs.push(definition); return () => {} },
      registerFileViewer(definition) { registered.viewers.push(definition); return () => {} },
      openTab() {},
      closeTab() {},
    },
    slots: {
      inject(name, run) {
        assert.ok(
          ['sidebar.panellist', 'main'].includes(name),
          `unexpected slot: ${name}`,
        )
        run()
        return () => {}
      },
      register(definition, component) {
        const bucket = definition.name === 'sidebar.panellist' ? registered.panels
          : definition.name === 'main' ? registered.main
            : registered.settings
        bucket.push({ ...definition, component })
        return () => {}
      },
    },
    locale: { register() { return () => {} }, bind: () => (key) => key },
  }
  const ctx = {
    ...services,
    get: (name) => services[name],
    effect(run) { const off = run(); return () => { if (typeof off === 'function') off() } },
    on() { return () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return ctx
}

const plugin = loadBundle(join(root, 'client.js'))
assert.deepEqual(plugin.inject, ['betterSidebar', 'slots'], 'the plugin must declare every service it reads')

const ctx = makeContext()
// A plugin body must survive a context whose services were not injected yet.
assert.doesNotThrow(() => plugin.apply({ ...ctx, betterSidebar: undefined, slots: undefined, get: () => undefined }), 'apply must not throw without the services')

plugin.apply(ctx)
assert.equal(registered.tabs.length, 1, 'exactly one tab is registered')
assert.equal(registered.tabs[0].id, 'analytics')
assert.equal(registered.viewers.length, 1, 'exactly one data-file viewer is registered')
// The harness settings page is deliberately left alone: the knobs belong to
// the workbench's own 设置 menu, and a second copy in 设置 → 插件 meant two
// places to look for the same value.
assert.equal(registered.settings.length, 0, 'no page is added to the harness settings')
assert.equal(registered.viewers[0].id, 'analytics:data')
assert.deepEqual(registered.viewers[0].exts, ['sav', 'por', 'sys', 'dta'])

// The left column's global panel list is the entry a user actually looks for.
// A better-sidebar tab alone stays invisible while the bottom panel is
// collapsed, which is exactly how the workbench went missing after a restart.
assert.equal(registered.panels.length, 1, 'one row in the left global panel list')
assert.equal(registered.panels[0].id, 'analytics')
assert.equal(registered.panels[0].order, 60)
assert.equal(registered.panels[0].label(), '统计分析', 'the left row is named plainly, without the panel suffix')
assert.equal(typeof registered.panels[0].component, 'function', 'the row draws an icon')
// The row sits next to outline glyphs from the harness' own set (16×16 box,
// fill="none", round caps, currentColor), so a filled blue badge read as a
// guest from another app. Assert the vocabulary, not the picture.
const rowIcon = registered.panels[0].component()
assert.equal(rowIcon.type, 'svg', 'the row icon is an svg element')
assert.equal(rowIcon.props.viewBox, '0 0 16 16', 'the row icon uses the harness 16-unit box')
assert.equal(rowIcon.props.fill, 'none', 'line art, not a filled badge')
assert.equal(rowIcon.props.stroke, 'currentColor', 'one asset serves the light and the dark theme')
assert.equal(rowIcon.props.strokeLinecap, 'round')
assert.equal(Number(rowIcon.props.strokeWidth) > 0, true, 'the stroke has a width')
assert.equal(registered.main.length, 1, 'one main-column page for the row to open')
assert.equal(registered.main[0].key, 'analytics', 'the row id and the main key must match')
assert.equal(typeof registered.main[0].component, 'function', 'the main-column page must render')

const container = window.document.getElementById('root')
const clientRoot = createRoot(container)
const props = {
  ctx,
  store: { getSnapshot: () => ({ state: null }), subscribeState: () => () => {}, reduce() {} },
  scope: { sessionId: 'session-test', cwd: '/tmp' },
  tab: { id: 'analytics', type: 'analytics', title: '统计分析', meta: {} },
  visible: true,
}
await act(async () => {
  clientRoot.render(React.createElement(registered.tabs[0].component, props))
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const text = () => container.textContent.replace(/\s+/g, ' ')
assert.match(text(), /文件/, 'the menu bar renders')
assert.match(text(), /分析/, 'the analysis menu renders')
assert.match(text(), /设置/, 'the workbench carries its own 设置 menu')
assert.equal(container.querySelector('.ap-doctabs'), null, 'an empty workbench shows no document strip')

await act(async () => { clientRoot.unmount() })

// The Files-panel viewer hands the path over and must retire its own tab. The
// close went wrong twice for two different reasons (the service read threw, and
// the tab record carries a title but no path), so this asserts the outcome.
const closed = []
const handoffCtx = makeContext()
handoffCtx.get = (name) => (name === 'sidebarRight'
  ? {
    tabsIn: () => [{ id: 'tab2', kind: 'editor', title: 'demo.sav' }, { id: 'tab3', kind: 'analytics', title: '统计分析' }],
    closeIn: (sessionId, id) => { closed.push({ sessionId, id }) },
    close: (id) => { closed.push({ id }) },
  }
  : undefined)
window.__analyticsHandoff = null
const viewer = registered.viewers[0].component
const viewerHost = window.document.createElement('div')
window.document.body.appendChild(viewerHost)
const viewerRoot = createRoot(viewerHost)
await act(async () => {
  viewerRoot.render(React.createElement(viewer, {
    ctx: handoffCtx,
    store: props.store,
    scope: { sessionId: 'session-test', cwd: '/tmp' },
    path: '/tmp/demo.sav',
    title: 'demo.sav',
  }))
  await new Promise((resolve) => setTimeout(resolve, 50))
})
// Timers scheduled by the effect run outside act: let the 120 ms close land.
await new Promise((resolve) => setTimeout(resolve, 400))
assert.match(viewerHost.textContent, /已交给「统计分析」打开/, 'the viewer says where the file went')
assert.deepEqual(closed, [{ sessionId: 'session-test', id: 'tab2' }],
  'the handoff closes the editor tab and leaves the analytics tab alone')
await act(async () => { viewerRoot.unmount() })

// The harness settings page must stay free of a 统计分析 page: the knobs live
// in the panel's own menu now, and two copies of one value is how a user ends
// up editing the wrong one.
const bundleSource = readFileSync(join(root, 'client.js'), 'utf8')
assert.ok(!bundleSource.includes("inject('settings.section'"), 'no page is registered in the harness settings')
// A refused write leaves a mark in the status bar, because a toast that faded
// five seconds ago cannot answer "did somebody overwrite my data".
assert.match(bundleSource, /ap-status-conflicts/, 'the status bar can show a conflict count')
// The right panel's tab is the same workbench as the left row, so it wears the
// same outline glyph instead of the product badge.
const tabIcon = registered.tabs[0].icon(16)
assert.equal(tabIcon.props.viewBox, '0 0 16 16', 'the sidebar tab icon is 16-unit line art too')
assert.equal(tabIcon.props.fill, 'none')
assert.equal(tabIcon.props.stroke, 'currentColor')
// A refused write is a question, not a lost edit: the three answers and the
// force-retry they need must all be in the bundle.
assert.match(bundleSource, /覆盖：仍然写入我这次修改（会盖掉对方刚写的内容）/, 'the dialog offers to write anyway, and says what that costs')
assert.match(bundleSource, /重载：丢弃我的修改/, 'the dialog offers to drop the edit')
assert.match(bundleSource, /关闭（放弃这次修改）/, 'closing is the do-nothing exit, and the footer says so')
assert.match(bundleSource, /error\.retry = \(\) => api\(path/, 'the force retry re-sends the same request')

const hooks = globalThis.__AP_TEST_HOOKS__

// The file dialog is the one place the panel sees raw host paths. On Windows
// they are 'C:\data\x.sav' with backslashes and a drive letter; a '/' split
// made '.. 上级目录' reopen the same folder and built children like
// 'C:\data\x.sav/y.sav'.
assert.equal(hooks.pathDirname('C:\\psppdata\\中文目录\\保存.sav'), 'C:\\psppdata\\中文目录')
assert.equal(hooks.pathDirname('C:\\psppdata\\保存.sav'), 'C:\\psppdata')
assert.equal(hooks.pathDirname('C:\\'), 'C:\\', 'a drive root stays itself')
assert.equal(hooks.pathDirname('/tmp/SPSS数据文件/a.sav'), '/tmp/SPSS数据文件')
assert.equal(hooks.pathDirname('/a.sav'), '/', 'a file at the root has the root as parent')
assert.equal(hooks.pathJoin('C:\\psppdata\\中文目录', 'new.sav'), 'C:\\psppdata\\中文目录\\new.sav')
assert.equal(hooks.pathJoin('C:\\', 'a.sav'), 'C:\\a.sav', 'joining at a drive root keeps one separator')
assert.equal(hooks.pathJoin('/tmp/数据', 'a.sav'), '/tmp/数据/a.sav')

// Agent preset (0.47.0): the panel works without the 统计分析 preset, but the
// agent cannot see the pspp_* tools, so the panel says so and better-sidebar
// greys the "+" entry out. The only source is the host projection; anything it
// cannot answer is "unknown" and must change nothing.
assert.equal(hooks.sessionPreset({ sessions: { projectionValues: () => ({ agentPreset: 'analytics' }) } }, 's1'), 'analytics')
assert.equal(hooks.sessionPreset({ sessions: { projectionValues: () => ({}) } }, 's1'), null,
  'a projection without agentPreset is unknown')
assert.equal(hooks.sessionPreset({ sessions: { projectionValues: () => { throw new Error('x') } } }, 's1'), null,
  'a throwing service is unknown, not fatal')
assert.equal(hooks.sessionPreset({ sessions: { projectionValues: () => ({ agentPreset: '' }) } }, 's1'), null,
  'an empty preset id is unknown')
assert.equal(hooks.sessionPreset(undefined, 's1'), null, 'no ctx is unknown')
assert.equal(hooks.sessionPreset({}, 's1'), null, 'no ctx.sessions is unknown')
// Cordis refuses `ctx.sessions` for a plugin that did not inject it, so the
// real host is reached through `ctx.get('sessions')`; without this the banner
// would be dead code in the browser while every unit test still passed.
// The real client service has NO `projectionValues` of its own: the preset
// picker reads the list snapshot, so both shapes have to work.
assert.equal(
  hooks.sessionPreset({
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ ids: ['s1'], byId: { s1: { projectionValues: { agentPreset: 'other' } } } }) } }
      : undefined),
  }, 's1'),
  'other',
  'the unguarded ctx.get reader finds the projection through the list snapshot',
)
assert.equal(
  hooks.sessionPreset({
    get: () => ({ manager: { projectionValues: () => ({ agentPreset: 'analytics' }) } }),
  }, 's1'),
  'analytics',
  'the manager behind the service answers projectionValues(id) too',
)
assert.equal(
  hooks.sessionPreset({ get: () => ({ list: { getSnapshot: () => ({ byId: {} }) } }) }, 's1'),
  null,
  'a session the snapshot does not know yet is unknown, not fatal',
)
assert.equal(
  hooks.sessionPreset({
    get: () => undefined,
    sessions: { projectionValues: () => ({ agentPreset: 'analytics' }) },
  }, 's1'),
  'analytics',
  'a host that hands the service over still works',
)
assert.equal(
  hooks.sessionPreset({ get: () => ({ projectionValues: () => { throw new Error('boom') } }) }, 's1'),
  null,
  'a throwing projection service through ctx.get is unknown, not fatal',
)

const tabDefinition = registered.tabs[0]
assert.equal(typeof tabDefinition.available, 'function', 'better-sidebar can grey the + entry out')
const availableWith = (preset) => tabDefinition.available(
  { sessions: { projectionValues: () => (preset === undefined ? undefined : { agentPreset: preset }) } },
  { sessionId: 's1' },
)
assert.equal(availableWith('analytics'), true, 'the panel stays available under its own preset')
assert.equal(availableWith('other'), false, 'another preset greys the + entry out')
assert.equal(availableWith(undefined), true, 'an unknown preset leaves the menu unchanged')
assert.equal(tabDefinition.available({}, { sessionId: 's1' }), true, 'an old host without ctx.sessions stays available')

// The notice bar: present (and still a working panel) on another preset, absent
// under the right one, and dismissible for good.
const mountWithPreset = async (preset) => {
  const panelCtx = makeContext()
  // null stands for a host that cannot answer at all: no ctx.sessions.
  if (preset !== null) panelCtx.sessions = { projectionValues: () => ({ agentPreset: preset }) }
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(tabDefinition.component, { ...props, ctx: panelCtx }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, root }
}

const otherPreset = await mountWithPreset('other')
const presetBar = otherPreset.host.querySelector('.ap-preset-bar')
assert.ok(presetBar, 'a session on another preset gets the notice bar, not a blank panel')
assert.match(presetBar.textContent, /统计分析/, 'the notice names the preset')
assert.match(presetBar.textContent, /pspp_\*/, 'and says what the agent loses')
assert.match(otherPreset.host.textContent, /分析/, 'the panel itself still renders')
await act(async () => { presetBar.querySelector('.ap-preset-bar-close').click() })
assert.equal(otherPreset.host.querySelector('.ap-preset-bar'), null, 'the dismiss button hides the bar')
assert.equal(window.localStorage.getItem('ap.hidePresetBanner'), '1', 'and remembers the choice')
await act(async () => { otherPreset.root.unmount() })
otherPreset.host.remove()
window.localStorage.removeItem('ap.hidePresetBanner')

const rightPreset = await mountWithPreset('analytics')
assert.equal(rightPreset.host.querySelector('.ap-preset-bar'), null, 'the right preset gets no notice')
await act(async () => { rightPreset.root.unmount() })
rightPreset.host.remove()

const unknownPreset = await mountWithPreset(null)
assert.equal(unknownPreset.host.querySelector('.ap-preset-bar'), null, 'an unknown preset (old host) says nothing')
await act(async () => { unknownPreset.root.unmount() })
unknownPreset.host.remove()
console.log('ok  the session preset drives the notice bar and the + menu availability')


// Table layout edits: three-line tables need a wider first column, a rewritten
// header and the note line under the table.
const edited = hooks.matrixHtml(
  [['', 'Mean', 'SD'], ['score', '14.05', '2.69']],
  'ap-tbl-three',
  { headers: ['变量', '均数', '标准差'], widths: [120, 0, 0], footnote: '注：数据以均数±标准差表示' },
)
assert.match(edited, /<colgroup><col style="width:120px"><col><col><\/colgroup>/, 'only the given column is pinned')
assert.match(edited, /<th>变量<\/th>/, 'the header wording is replaced')
assert.match(edited, /<td>14.05<\/td>/, 'the numbers are untouched')
assert.match(edited, /<tfoot><tr><td colspan="3" class="ap-footnote">注：/, 'the footnote spans the table')
assert.equal(hooks.matrixHtml([['', 'Mean']], '', null).includes('<colgroup>'), false, 'no edits means no colgroup')

// Value-label import: both shapes a user pastes, and the reversed column order.
const pasted = hooks.parseValueLabelLines("1,男\n2,女")
assert.deepEqual(pasted.labels, { 1: '男', 2: '女' })
assert.equal(pasted.problems.length, 0)
const reversed = hooks.parseValueLabelLines("男,1\n女,2")
assert.deepEqual(reversed.labels, { 1: '男', 2: '女' }, 'label,value order is recognised')
const fromSyntax = hooks.parseValueLabelLines("VALUE LABELS sex 1 '男' 2 '女'.")
assert.deepEqual(fromSyntax.labels, { 1: '男', 2: '女' })
assert.equal(hooks.parseValueLabelLines('garbage').problems.length, 1)

// Syntax completion: variables while typing an operand, commands by prefix.
const script = 'FREQUENCIES /VARIABLES=sc'
const candidates = hooks.completionCandidates(script, script.length, ['score', 'gender'])
assert.equal(candidates[0].name, 'score', 'the dataset variable comes first')
const command = hooks.completionCandidates('FREQ', 4, [])
assert.ok(command.some((item) => item.name === 'FREQUENCIES'), 'a command prefix completes to the command')
assert.deepEqual(hooks.completionCandidates('* comment sco', 12, ['score']), [], 'no completion inside a comment')
// A "/" starts a subcommand, "=" or "," starts an option keyword.
const subs = hooks.completionCandidates('FREQUENCIES /VA', 15, ['score'])
assert.ok(subs.length > 0 && subs.every((item) => item.kind === '子命令'), 'after a slash only subcommands are offered')
assert.ok(subs.some((item) => item.name === 'VARIABLES'), 'VARIABLES completes from a subcommand prefix')
const keys = hooks.completionCandidates('DESCRIPTIVES /STATISTICS=ME', 28, ['score'])
assert.ok(keys.length > 0 && keys.every((item) => item.kind === '选项'), 'after "=" only keywords are offered')
assert.ok(keys.some((item) => item.name === 'MEAN'), 'MEAN completes from a keyword prefix')


// Output outline summaries: the numbers a reader looks for first.
const anova = hooks.summarizeTable({
  matrix: [
    ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
    ['Between Groups', '80.08', '2', '40.04', '139.28', '.000'],
    ['Within Groups', '6.04', '21', '.29', '', ''],
  ],
})
assert.equal(anova, 'F=139.28 · df=2 · p=.000', `summary of an ANOVA table: ${anova}`)
const descriptives = hooks.summarizeTable({
  matrix: [
    ['', 'N', 'Mean', 'Std. Deviation'],
    ['score', '60', '59.3450', '9.07276'],
  ],
})
assert.equal(descriptives, 'N=60 · 均值=59.3450 · SD=9.07276', `summary of a descriptives table: ${descriptives}`)
assert.equal(hooks.summarizeTable({ matrix: [['a', 'b'], ['1', '2']] }), '', 'a table without known headers gets no summary')
assert.equal(hooks.summarizeTable(undefined), '', 'a missing table gets no summary')


/** The variable view formats and parses missing codes in the bundle itself. */
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
const missingStart = clientSource.indexOf('    function missingToText')
const missingEnd = clientSource.indexOf('    function parseValueLabelLines')
assert.ok(missingStart > 0 && missingEnd > missingStart, 'the missing-value helpers are in the bundle')
const missingHelpers = new Function(
  clientSource.slice(missingStart, missingEnd) + '; return { missingToText, parseMissingInput }',
)()

// A THRU range used to show as [object Object] and blur without a keystroke
// cleared it (`Number("[object Object]")` is NaN, filtered out).
assert.equal(missingHelpers.missingToText([{ lo: 90, hi: 99 }, 999]), '90 THRU 99 999')
assert.equal(missingHelpers.missingToText([]), '')
const rangeText = missingHelpers.missingToText([{ lo: 90, hi: 99 }])
assert.deepEqual(missingHelpers.parseMissingInput(rangeText, 'numeric'), [{ lo: 90, hi: 99 }])
assert.deepEqual(missingHelpers.parseMissingInput('90 THRU 99, 999', 'numeric'), [{ lo: 90, hi: 99 }, 999])
assert.deepEqual(missingHelpers.parseMissingInput('1 2 3', 'numeric'), [1, 2, 3])
assert.deepEqual(missingHelpers.parseMissingInput("'a' 'b'", 'string'), ['a', 'b'])
// A string range keeps its shape: splitting it into two codes rewrote the
// field on blur.
const stringRange = [{ lo: 'AA', hi: 'ZZ', text: true }]
assert.equal(missingHelpers.missingToText(stringRange), 'AA THRU ZZ')
assert.deepEqual(missingHelpers.parseMissingInput('AA THRU ZZ', 'string'), [{ lo: 'AA', hi: 'ZZ', text: true }])
console.log('ok  missing-value field shows and parses THRU ranges')

console.log('ok  client bundle: tab + viewer registration, menu bar, empty strip hidden, handoff closes its tab, label import, completion, outline summary')

// Right-clicking a cell in the data sheet opens the cell menu; the cell's
// variable name heads it, and a command that needs a variable is hidden when
// the cell has none. This broke silently once (the menu was never mounted), so
// it is asserted through the rendered DOM rather than the source.
{
  const apiCalls = []
  const sheetCtx = makeContext()
  const sheetRoot = createRoot(container)
  window.fetch = async (url, options) => {
    apiCalls.push(String(url))
    const body = options?.body ? JSON.parse(options.body) : null
    if (String(url).includes('api/state')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(globalThis.__sheetPayload ??= {
          ok: true,
          state: {
            id: 'session-test',
            engine: { source: 'bundled', bin: '/x/pspp' },
            cwd: '/tmp',
            dataset: {
              sourcePath: '/tmp/a.sav',
              caseCount: 3,
              dirty: false,
              temporary: false,
              name: 'a.sav',
              variables: [
                { name: 'score', label: '得分', position: 1, type: 'numeric', width: 8, decimals: 2, format: 'F8.2', measure: 'scale', alignment: 'right', missing: [], valueLabels: {} },
                { name: 'note', label: '', position: 2, type: 'string', width: 8, decimals: 0, format: 'A8', measure: 'nominal', alignment: 'left', missing: [], valueLabels: {} },
              ],
              history: { undo: 0, redo: 0 },
            },
            items: [{
              kind: 'table',
              id: 'run-1-0',
              runId: 1,
              title: 'ANOVA',
              table: { caption: 'ANOVA', matrix: [['', '平方和'], ['组间', '12.5']], html: '' },
              pairwise: { group: 'gender', variables: ['score'] },
              roc: { by: 'gender', variables: ['score'] },
            }, {
              // A chart is an output entry too; it has to offer the same
              // single-entry export, not just the batch one.
              kind: 'image',
              id: 'chart-1-0',
              runId: 1,
              title: 'score 的直方图',
              artifactUrl: '/analytics/api/artifact?runId=1&name=chart.svg',
              alt: 'score 的直方图',
            }],
            splitBy: ['gender'],
            weightBy: 'freq',
            filterBy: null,
            selectIf: null,
          },
        }),
      }
    }
    if (String(url).includes('api/rows')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, page: { rows: [[1, 'a'], [2, 'b'], [3, 'c']], total: 3, offset: 0 } }),
      }
    }
    // The export dialog opens a file browser, which lists a directory first.
    if (String(url).includes('api/dir')) {
      return {
        ok: true,
        status: 200,
        text: async () => {
          // Echo the requested path back: the browser lists a directory and
          // keeps the name the caller typed, so the test can assert on it.
          const asked = decodeURIComponent(String(url).split('path=')[1] ?? '')
          return JSON.stringify({ ok: true, path: asked || '/tmp', entries: [{ name: 'out.xlsx', dir: false, size: 0 }], pick: null })
        },
      }
    }
    if (String(url).includes('api/run')) globalThis.__lastRunBody = body
    if (String(url).includes('api/paste')) {
      globalThis.__lastPasteBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { addedCases: 0, addedVariables: 0 }, state: globalThis.__sheetPayload?.state ?? null }) }
    }
    if (String(url).includes('api/partial')) {
      if (body) globalThis.__lastPartialBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { matrix: [['变量对'], ['age × score']], notes: [] }, state: globalThis.__sheetPayload?.state ?? null }) }
    }
    if (String(url).includes('api/exportOffice')) {
      if (body) globalThis.__lastOfficeBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { path: '/tmp/out.xlsx', format: 'xlsx', bytes: 1234, tables: 1, images: 0 } }) }
    }
    if (String(url).includes('api/chart')) {
      if (body) globalThis.__lastChartBody = body
      // The real route answers with the whole state; the panel keeps polling,
      // so a null state here would tear the sheet down mid-test.
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: globalThis.__sheetPayload?.state ?? null }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: null, ...(body ? {} : {}) }) }
  }
  // The panel calls the bare global `fetch`, not `window.fetch`.
  globalThis.fetch = window.fetch
  await act(async () => {
    sheetRoot.render(React.createElement(registered.tabs[0].component, { ...props, ctx: sheetCtx }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const cell = container.querySelector('td[data-row="0"][data-column="0"]')
  assert.ok(cell, 'the data sheet renders a cell')
  await act(async () => {
    cell.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const menu = () => container.querySelector('.ap-var-menu')
  assert.ok(menu(), 'right-clicking a cell opens the cell menu')
  const items = [...menu().querySelectorAll('.ap-var-item')].map((node) => node.textContent)
  assert.equal(menu().querySelector('.ap-menu-label').textContent, 'score · 第 1 行', 'the menu names the cell it came from')
  assert.ok(items.includes('复制这个值'), 'the copy command is offered')
  assert.ok(items.includes('清空这个格子'), 'the clear command is offered for a real variable')
  assert.ok(items.includes('删除第 1 个个案'), 'case commands are offered')
  assert.ok(items.includes('设为系统缺失值'), 'a numeric cell can be marked missing')
  await act(async () => {
    window.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.equal(menu(), null, 'clicking outside closes the cell menu')

  // A run that came from the ANOVA dialog carries its variable and group, so
  // the result can offer the pairwise table without asking for them again.
  const outputTab = [...container.querySelectorAll('.ap-view-tab')].find((tab) => tab.textContent.includes('输出'))
  assert.ok(outputTab, 'the output view has a tab')
  await act(async () => {
    outputTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const pairwiseButton = [...container.querySelectorAll('.ap-tool')].find((button) => button.textContent === '两两比较')
  assert.ok(pairwiseButton, 'an ANOVA result offers a pairwise comparison button')

  // A logistic result carries its outcome and predictors; the head offers a ROC
  // curve pre-filled with them instead of asking for both variables again.
  const rocButton = [...container.querySelectorAll('.ap-tool')].find((button) => button.textContent === 'ROC 曲线…')
  assert.ok(rocButton, 'a logistic result offers a ROC curve button')
  await act(async () => {
    rocButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const rocDialog = [...container.querySelectorAll('.ap-modal')].find((node) => node.offsetParent !== null || node.textContent.includes('ROC 曲线'))
  assert.ok(rocDialog, 'clicking the button opens the ROC dialog')
  assert.match(rocDialog.textContent, /检验变量/, 'the ROC dialog is the one the spec declares')
  assert.match(rocDialog.textContent, /score|gender/, 'the ROC dialog arrives pre-filled from the model')

  // A picture can be bound to one output table at draw time. The dialog lists
  // the tables already in the output and sends the chosen id, which is what the
  // Word/Excel exporter uses instead of guessing from titles.
  const rocCancel = [...rocDialog.querySelectorAll('.ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    rocCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const graphicsButton = [...container.querySelectorAll('.ap-menu-button')].find((button) => button.textContent === '图形')
  assert.ok(graphicsButton, 'the menu bar has a graphics menu')
  await act(async () => {
    graphicsButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const histogramItem = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '直方图…')
  assert.ok(histogramItem, 'the graphics menu offers a histogram')
  await act(async () => {
    histogramItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const chartDialog = [...container.querySelectorAll('.ap-modal')].filter((node) => String(node.className).includes('ap-modal')).at(-1)
  assert.ok(chartDialog, 'the histogram dialog opens')
  assert.match(chartDialog.textContent, /导出时图表归属/, 'the dialog asks which table the picture belongs to')
  const ownerSelect = [...chartDialog.querySelectorAll('select')]
    .find((node) => [...node.options].some((option) => option.value === 'run-1-0'))
  assert.ok(ownerSelect, 'the tables in the output are offered by id')
  assert.ok([...ownerSelect.options].some((option) => option.textContent === 'ANOVA'), 'the option is labelled with the table title')
  const scoreBox = [...chartDialog.querySelectorAll('.ap-dlg-var')].find((node) => node.textContent.trim().startsWith('score'))?.querySelector('input')
  assert.ok(scoreBox, 'the variable list offers score')
  await act(async () => {
    scoreBox.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(ownerSelect, 'run-1-0')
    ownerSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const chartOk = [...chartDialog.querySelectorAll('.ap-tool')].find((button) => button.textContent === '确定')
  await act(async () => {
    chartOk.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.equal(globalThis.__lastChartBody?.options?.tableId, 'run-1-0', 'the chosen table id travels with the chart request')

  // The choice is remembered: drawing a second picture for the same table
  // should not ask the same question again.
  assert.equal(window.localStorage.getItem('ap.chartTarget'), 'run-1-0', 'the chosen table id is remembered')
  await act(async () => {
    graphicsButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const histogramAgain = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '直方图…')
  await act(async () => {
    histogramAgain.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const secondDialog = [...container.querySelectorAll('.ap-modal')].filter((node) => String(node.className).includes('ap-modal')).at(-1)
  const rememberedSelect = [...secondDialog.querySelectorAll('select')]
    .find((node) => [...node.options].some((option) => option.value === 'run-1-0'))
  assert.equal(rememberedSelect?.value, 'run-1-0', 'the remembered table is preselected')
  const secondCancel = [...secondDialog.querySelectorAll('.ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    secondCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // The Excel writer can be asked for plain numbers; the dialog has to expose
  // that, and the flag has to reach the route.
  const fileButton = [...container.querySelectorAll('.ap-menu-button')].find((button) => button.textContent === '文件')
  await act(async () => {
    fileButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const excelItem = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '导出输出为 Excel（.xlsx）…')
  assert.ok(excelItem, 'the file menu offers an Excel export')
  await act(async () => {
    excelItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const exportDialog = [...container.querySelectorAll('.ap-modal')].filter((node) => String(node.className).includes('ap-modal')).at(-1)
  assert.match(exportDialog.textContent, /写入 Excel 公式/, 'the export dialog offers the formula switch')
  const formulaBox = [...exportDialog.querySelectorAll('input[type=checkbox]')]
    .find((box) => box.parentElement?.textContent?.includes('写入 Excel 公式'))
  assert.equal(formulaBox?.checked, true, 'formulas are on by default')
  // The raw-data sheet is opt-in, so a report of sensitive cases never grows an
  // extra copy of the data unless the exporter asked for it.
  assert.match(exportDialog.textContent, /附带原始数据页/, 'the export dialog offers the raw data sheet')
  const dataBox = [...exportDialog.querySelectorAll('input[type=checkbox]')]
    .find((box) => box.parentElement?.textContent?.includes('附带原始数据页'))
  assert.equal(dataBox?.checked, false, 'the data sheet starts off')
  const exportCancel = [...exportDialog.querySelectorAll('.ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    exportCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // A single table can go straight to a file, which is the SPSS "export the
  // selected output" habit without a scope dropdown first.
  const singleButton = [...container.querySelectorAll('.ap-item .ap-tool')].find((button) => button.textContent === '单独导出…')
  assert.ok(singleButton, 'every table offers a one-table export')
  const chartItem = [...container.querySelectorAll('.ap-item')]
    .find((node) => node.getAttribute('data-item-id') === 'chart-1-0')
  assert.ok(chartItem, 'the mock output has a chart entry')
  const chartExport = [...chartItem.querySelectorAll('.ap-tool')]
    .find((button) => button.textContent === '单独导出…')
  assert.ok(chartExport, 'a chart offers the same single-entry export as a table')
  let singleBody = null
  await act(async () => {
    singleButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const singleDialog = [...container.querySelectorAll('.ap-modal')].filter((node) => String(node.className).includes('ap-modal')).at(-1)
    const singleInputValue = singleDialog.querySelector('input')?.value ?? ''
  assert.match(singleInputValue, /\.xlsx$/, 'the path is prefilled with an .xlsx name')
  const singleInput = singleDialog.querySelector('input')
  assert.match(singleDialog.textContent, /只导出/, 'the dialog says which table it will write')

  const singleOk = [...singleDialog.querySelectorAll('.ap-tool')].find((button) => button.textContent === '选择路径')
  await act(async () => {
    singleOk.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  singleBody = globalThis.__lastOfficeBody
  assert.ok(Array.isArray(singleBody?.items) && singleBody.items.length === 1, 'only that table travels with the request')

  // Partial correlation is computed by the plugin (PSPP has no PARTIAL CORR),
  // so its menu entry must open a dialog rather than a "not supported" notice.
  const analysisButton = [...container.querySelectorAll('.ap-menu-button')].find((button) => button.textContent === '分析')
  await act(async () => {
    analysisButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const partialEntry = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent.startsWith('偏相关'))
  assert.ok(partialEntry, 'the analysis menu offers a partial correlation entry')
  assert.ok(!partialEntry.disabled, 'it is enabled whenever a dataset is open')
  await act(async () => {
    partialEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const partialDialog = [...container.querySelectorAll('.ap-modal')].find((node) => /偏相关/.test(node.textContent))
  assert.ok(partialDialog, 'clicking it opens the partial correlation dialog')
  assert.match(partialDialog.textContent, /分析变量/, 'the dialog names the analysis variables box')
  assert.match(partialDialog.textContent, /控制变量/, 'the dialog names the control box')
  // With fewer than two numeric variables the run button stays disabled, which
  // is the guard the dialog is built around (the request itself is covered by
  // test/routes.mjs, which has a dataset with two numeric variables).
  const partialChips = [...partialDialog.querySelectorAll('.ap-dlg-left .ap-chip')]
  assert.ok(partialChips.length >= 1, 'the numeric variables are offered as chips')
  const partialOk = [...partialDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '确定')
  assert.ok(partialOk, 'the dialog has an OK button')
  assert.equal(partialOk.disabled, partialChips.length < 2, 'two variables are needed before it can run')
  const partialCancel = [...partialDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    partialCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // Transposing silently throws away every string column in PSPP, so the panel
  // has to stop and ask before it sends the request at all.
  const dataButton = [...container.querySelectorAll('.ap-menu-button')].find((button) => button.textContent === '数据')
  await act(async () => {
    dataButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const flipEntry = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '转置')
  assert.ok(flipEntry, 'the data menu offers transpose')
  await act(async () => {
    flipEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const flipDialog = [...container.querySelectorAll('.ap-modal')].find((node) => /转置数据/.test(node.textContent))
  assert.ok(flipDialog, 'a dataset with string columns opens the transpose confirmation')
  assert.match(flipDialog.textContent, /note/, 'the dialog names the string columns it would lose')
  const flipOk = [...flipDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '仍然转置')
  assert.ok(flipOk && flipOk.disabled === true, 'transposing stays blocked until the loss is acknowledged')
  const flipBox = [...flipDialog.querySelectorAll('input[type=checkbox]')][0]
  await act(async () => {
    flipBox.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const flipOkAfter = [...flipDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '仍然转置')
  assert.equal(flipOkAfter.disabled, false, 'acknowledging the loss enables the button')
  const flipCancel = [...flipDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    flipCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // 数据 → 重构: PSPP 2.1.3 has neither CASESTOVARS nor VARSTOCASES, so both
  // entries must open a dialog that collects the boxes the plugin needs rather
  // than pasting a program PSPP would reject.
  await act(async () => {
    dataButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const restructureEntry = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '个案转变量…')
  assert.ok(restructureEntry, 'the data menu offers cases to variables')
  await act(async () => {
    restructureEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const caseDialog = [...container.querySelectorAll('.ap-modal')].find((node) => /个案转变量/.test(node.textContent))
  assert.ok(caseDialog, 'clicking it opens the pivot dialog')
  assert.match(caseDialog.textContent, /标识变量/, 'the dialog asks for the identifier boxes')
  assert.match(caseDialog.textContent, /索引变量/, 'and for the index variable whose values become columns')
  assert.match(caseDialog.textContent, /要展开的变量/, 'and for the variables to spread')
  const caseHelp = [...caseDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '帮助')
  assert.ok(caseHelp, 'the pivot dialog keeps the 帮助 button')
  await act(async () => {
    caseHelp.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.match(caseDialog.textContent, /先把左边必填的变量选上/, 'the help panel explains what is missing before it can run')
  const caseOk = [...caseDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '确定')
  assert.equal(caseOk.disabled, true, 'the pivot cannot run before an index and a variable are chosen')
  const caseCancel = [...caseDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    caseCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  await act(async () => {
    dataButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const stackEntry = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '变量转个案…')
  assert.ok(stackEntry, 'the data menu offers variables to cases')
  await act(async () => {
    stackEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const stackDialog = [...container.querySelectorAll('.ap-modal')].find((node) => /变量转个案/.test(node.textContent))
  assert.ok(stackDialog, 'the inverse pivot opens its own dialog')
  assert.match(stackDialog.textContent, /要堆叠的变量/, 'it names the stack box')
  assert.match(stackDialog.textContent, /索引列名/, 'and the index column name')
  const stackCancel = [...stackDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    stackCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // 编辑 has the clipboard entries SPSS has, and 转到变量 opens a picker instead
  // of doing nothing (the grid keeps its own selection, so the menu routes
  // through a command table the grid publishes).
  const editButton = [...container.querySelectorAll('.ap-menu-button')].find((button) => button.textContent === '编辑')
  await act(async () => {
    editButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const editLabels = [...container.querySelectorAll('.ap-menu-pop button')].map((button) => button.textContent)
  // menuLabel renders the key hint as its own span, so textContent is
  // "剪切Ctrl+X" rather than "剪切（Ctrl+X）".
  for (const wanted of ['剪切', '复制', '粘贴', '清除', '粘贴变量…', '转到个案…', '转到变量…']) {
    assert.ok(editLabels.some((label) => label.startsWith(wanted)), `the edit menu offers ${wanted}`)
  }
  const gotoVariable = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent === '转到变量…')
  await act(async () => {
    gotoVariable.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const gotoDialog = [...container.querySelectorAll('.ap-modal')].find((node) => /转到变量/.test(node.textContent))
  assert.ok(gotoDialog, '转到变量 opens a picker')
  assert.ok(gotoDialog.querySelector('datalist#ap-goto-variables'), 'the picker lists every variable it knows')
  const gotoCancel = [...gotoDialog.querySelectorAll('.ap-modal-foot .ap-tool')].find((button) => button.textContent === '取消')
  await act(async () => {
    gotoCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // 视图 → 网格线 / 工具栏 are display toggles with a check mark that survives
  // reopening the menu.
  // The grid only exists on the data view; an earlier case left the panel on
  // another tab, so switch back before asserting on the rendering.
  const dataTab = [...container.querySelectorAll('.ap-view-tab')].find((tab) => tab.textContent === '数据视图')
  if (dataTab) {
    await act(async () => {
      dataTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }
  const viewButton = [...container.querySelectorAll('.ap-menu-button')].find((button) => button.textContent === '视图')
  await act(async () => {
    viewButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const gridEntry = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent.trim() === '✓ 网格线')
  assert.ok(gridEntry, 'the view menu shows gridlines as on')
  assert.ok([...container.querySelectorAll('.ap-menu-pop button')].some((button) => button.textContent.trim() === '✓ 工具栏'), 'and the toolbar as on')
  await act(async () => {
    gridEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.ok(container.querySelector('.ap-grid.ap-nogrid'), 'turning gridlines off drops the ruling but keeps the table')
  await act(async () => {
    viewButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  // The grid publishes its command table once at mount, so it has to forward
  // to the newest closures: a stale one would make 复制/清除 silently do
  // nothing after the second render (which is what the menu always sees).
  // 交叉表统计量：对话框要能把整套 PSPP /STATISTICS 关键字发出去，不只卡方。
  // 走「帮助」而不是「确定」：帮助里显示的就是确定会跑的语法，而且不需要宿主。
  {
    const analysisButton = [...container.querySelectorAll('.ap-menu-button')].find((node) => node.textContent.trim() === '分析')
    await act(async () => { analysisButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const crosstabsItem = [...container.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent.trim() === '交叉表…')
    await act(async () => { crosstabsItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const dialog = container.querySelector('.ap-modal')
    const boxes = [...dialog.querySelectorAll('.ap-dlg-box')]
    const captionOf = (node) => node.querySelector('.ap-dlg-caption')?.textContent.trim()
    const labels = [...dialog.querySelectorAll('.ap-dlg-var')]
    assert.ok(labels.length >= 2, 'the variable list is filled')
    const pick = async (box, variable) => {
      await act(async () => { box.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 10)) })
      const label = labels.find((node) => node.textContent.trim().startsWith(variable))
      await act(async () => { label.querySelector('input').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
    const firstName = labels[0].textContent.trim().split(/\s+/)[0]
    const secondName = labels[1].textContent.trim().split(/\s+/)[0]
    await pick(boxes.find((node) => captionOf(node) === '行变量'), firstName)
    await pick(boxes.find((node) => captionOf(node) === '列变量'), secondName)
    const statsButton = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim().startsWith('统计量'))
    await act(async () => { statsButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const sheet = [...container.querySelectorAll('.ap-modal')].at(-1)
    const sheetLabels = [...sheet.querySelectorAll('.ap-check')].map((node) => node.textContent.trim())
    for (const wanted of ["Somers' d", 'Eta', '风险估计（2×2）', '不确定性系数', 'Kendall tau-b', '精确卡方 p']) {
      assert.ok(sheetLabels.some((text) => text.includes(wanted)), `the statistics sheet offers ${wanted}`)
    }
    for (const wanted of ["Somers' d", 'Eta']) {
      const label = [...sheet.querySelectorAll('.ap-check')].find((node) => node.textContent.trim().includes(wanted))
      await act(async () => { label.querySelector('input').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
    // The exact chi-square p is a flag too: it must not leak into /STATISTICS
    // as a keyword PSPP would reject.
    {
      const label = [...sheet.querySelectorAll('.ap-check')].find((node) => node.textContent.trim().includes('精确卡方 p'))
      await act(async () => { label.querySelector('input').dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
    const cont = [...sheet.querySelectorAll('button')].find((node) => node.textContent.trim() === '继续')
    await act(async () => { cont.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const help = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '帮助')
    await act(async () => { help.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const syntax = dialog.querySelector('.ap-dlg-help-code')?.textContent ?? ''
    assert.match(syntax, new RegExp(`CROSSTABS /TABLES=${firstName} BY ${secondName}`))
    assert.match(syntax, /\/STATISTICS=.*CHISQ/)
    assert.match(syntax, /\/STATISTICS=.*\bD\b/, "Somers' d travels as D")
    assert.match(syntax, /\/STATISTICS=.*ETA/)
    assert.ok(!/EXACTCHI/.test(syntax), 'the exact chi-square flag stays out of the syntax')
    const cancel = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
    await act(async () => { cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    assert.equal(container.querySelector('.ap-modal'), null, 'the dialog closes again')
    // The clear/blank checks below expect the 视图 menu to be the open one.
    await act(async () => { viewButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
  }

  // 下拉框的三种写法都要能显示：元组 [value, label] 此前渲染成空白项，
  // 连带 ciLevel / ntiles / posthoc / 百分位带都没法选（0.42.0 修）。
  {
    const openMenu = async (label) => {
      const button = [...container.querySelectorAll('.ap-menu-button')].find((node) => node.textContent.trim() === label)
      await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    const clickItem = async (text) => {
      const item = [...container.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent.trim() === text)
      await act(async () => { item.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    const clickButton = async (dialog, text) => {
      const button = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim().startsWith(text))
      await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    }
    const optionText = (select) => [...select.querySelectorAll('option')].map((node) => node.textContent.trim())
    const optionValue = (select) => [...select.querySelectorAll('option')].map((node) => node.value)

    // 标识异常个案 → 选项 → 界值下拉应该有四挡，而且能选中非默认值。
    await openMenu('数据')
    await clickItem('标识异常个案…')
    const outliers = container.querySelector('.ap-modal')
    assert.ok(outliers, 'the outlier dialog opens')
    await clickButton(outliers, '选项')
    const outlierSheet = [...container.querySelectorAll('.ap-modal')].at(-1)
    const band = outlierSheet.querySelector('select')
    assert.ok(band, 'the band is a select, not free text')
    assert.deepEqual(optionValue(band), ['5,95', '10,90', '2.5,97.5', '1,99'], 'the band offers four choices')
    assert.ok(optionText(band)[1].includes('第 10 与第 90 百分位'), `the second choice has a label, got ${JSON.stringify(optionText(band))}`)
    await act(async () => {
      band.value = '10,90'
      band.dispatchEvent(new window.Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await clickButton(outlierSheet, '继续')
    await clickButton(outliers, '帮助')
    const outlierHelp = outliers.querySelector('.ap-dlg-help')?.textContent ?? ''
    assert.ok(outlierHelp.includes('在插件里计算'), `the outlier dialog says the work is local, got ${outlierHelp}`)
    assert.equal(outliers.querySelector('.ap-dlg-help-code'), null, 'there is no engine syntax to preview')
    await clickButton(outliers, '取消')
    const outlierBuild = hooks.ANALYSIS_SPECS.outliers.build({ variables: ['score'] }, { options: { percentiles: '10,90', indicators: false } })
    assert.deepEqual(outlierBuild.outliers.percentiles, [10, 90], 'the picked band survives the sheet')

    // 线性回归 → 选项 → 置信区间水平：元组标签 90% / 95% / 99%。
    await openMenu('分析')
    const regressionItem = [...container.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent.trim() === '线性…')
    await act(async () => { regressionItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const regression = container.querySelector('.ap-modal')
    await clickButton(regression, '选项')
    const regressionSheet = [...container.querySelectorAll('.ap-modal')].at(-1)
    const level = regressionSheet.querySelector('select')
    assert.deepEqual(optionValue(level), ['90', '95', '99'], 'the confidence level offers three choices')
    assert.deepEqual(optionText(level), ['90%', '95%', '99%'], `the confidence level has visible labels, got ${JSON.stringify(optionText(level))}`)
    await clickButton(regressionSheet, '继续')
    await clickButton(regression, '取消')
    // Leave the 视图 menu open again: the gridline toggles below read from it.
    await openMenu('视图')
  }

  const gridWrap = container.querySelector('.ap-grid-wrap')
  assert.ok(gridWrap, 'the data grid is on screen')
  await act(async () => {
    gridWrap.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  let cleared = false
  await act(async () => {
    cleared = globalThis.__AP_TEST_HOOKS__.gridCommand('clear')
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.equal(cleared, true, 'the published command table sees the live selection')
  const pasteBody = globalThis.__lastPasteBody
  assert.ok(pasteBody && Array.isArray(pasteBody.cells) && pasteBody.cells.length > 0, 'clearing goes through api/paste')
  assert.ok(pasteBody.cells.every((cell) => cell.value === null), 'every cleared cell is sent as null')
  // The host answers with state only, so the panel has to patch the rows it is
  // showing; otherwise the sheet keeps the old numbers until the next reload.
  const firstCell = container.querySelector('.ap-grid td[data-row="0"][data-column="0"]')
  assert.ok(firstCell, 'the first cell is on screen')
  assert.equal(firstCell.textContent.trim(), '', 'the cleared cell goes blank without a reload')

  const gridEntryOff = [...container.querySelectorAll('.ap-menu-pop button')].find((button) => button.textContent.trim() === '网格线')
  assert.ok(gridEntryOff, 'reopening shows it off')
  await act(async () => {
    gridEntryOff.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  // Session settings are invisible in the grid, so they get permanent chips:
  // a SPLIT or WEIGHT left behind changes every number without any other sign.
  assert.match(text(), /拆分：gender/, 'an active SPLIT FILE is shown in the status bar')
  assert.match(text(), /加权：freq/, 'an active WEIGHT is shown in the status bar')
  const chipClose = [...container.querySelectorAll('.ap-chip')]
    .find((chip) => chip.textContent.includes('拆分：gender'))
    ?.querySelector('.ap-chip-x')
  assert.ok(chipClose, 'the split chip offers a way to turn it off')
  await act(async () => {
    chipClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const lastRun = globalThis.__lastRunBody
  assert.ok(lastRun && /SPLIT FILE OFF/.test(lastRun.syntax || ''), 'clicking the chip clears the split with SPLIT FILE OFF')
  await act(async () => { sheetRoot.unmount() })
}

// Closing a dataset with unsaved edits must ask first: api/close used to be
// called straight away and the only copy of those edits was work.sav.
{
  const calls = []
  const dirtyCtx = makeContext()
  const dirtyRoot = createRoot(container)
  globalThis.__sheetPayload.state.dataset.dirty = true
  window.fetch = async (url) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(globalThis.__sheetPayload ?? {}),
    }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    dirtyRoot.render(React.createElement(registered.tabs[0].component, { ...props, ctx: dirtyCtx }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const fileButton = [...container.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === '文件')
  assert.ok(fileButton, 'the menu bar has a 文件 menu')
  await act(async () => {
    fileButton.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  const closeItem = [...container.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent === '关闭数据集')
  assert.ok(closeItem, 'the file menu offers 关闭数据集')
  await act(async () => {
    closeItem.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const modal = container.querySelector('.ap-modal')
  assert.ok(modal, 'closing a dirty dataset opens a confirmation')
  assert.ok(modal.textContent.includes('未保存'), 'the confirmation says the edits are unsaved')
  assert.equal(calls.filter((url) => url.includes('api/close')).length, 0, 'nothing is closed before the user answers')
  await act(async () => { dirtyRoot.unmount() })
  globalThis.__sheetPayload.state.dataset.dirty = false
}


// Help → 检查更新. Three outcomes have to be visible, and the one that matters is
// "the check itself failed": silence there reads as "you are up to date".
{
  const updateHost = window.document.createElement('div')
  window.document.body.appendChild(updateHost)
  const updateRoot = createRoot(updateHost)
  let answer = { ok: true, current: '0.56.3', latest: '0.57.0', newer: true, url: 'https://example/release' }
  window.fetch = async (url) => {
    const text = String(url).includes('api/update')
      ? JSON.stringify(globalThis.__updateAnswer ?? answer)
      : JSON.stringify({ ok: true, state: { id: 'session-u', version: '0.56.3', engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true }, dataset: null, items: [], log: [], history: { undo: 0, redo: 0 } } })
    return { ok: true, status: 200, text: async () => text }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    updateRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const askHelp = async () => {
    const help = [...updateHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent.trim() === '帮助')
    assert.ok(help, 'the menu bar has a 帮助 menu')
    await act(async () => { help.click(); await new Promise((resolve) => setTimeout(resolve, 20)) })
    const item = [...updateHost.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent.trim() === '检查更新…')
    assert.ok(item, 'the help menu offers 检查更新…')
    await act(async () => { item.click(); await new Promise((resolve) => setTimeout(resolve, 60)) })
    const toast = updateHost.querySelector('.ap-toast')
    return toast ? toast.textContent : ''
  }
  const newer = await askHelp()
  assert.match(newer, /0\.57\.0/, `a newer release is named: ${newer}`)
  assert.match(newer, /https:\/\/example\/release/, 'the release page is offered')
  globalThis.__updateAnswer = { ok: true, current: '0.56.3', latest: '0.56.3', newer: false }
  const same = await askHelp()
  assert.match(same, /已是最新版本/, `being current says so: ${same}`)
  globalThis.__updateAnswer = { ok: true, current: '0.56.3', latest: null, newer: false, error: 'GitHub 返回 403' }
  const failed = await askHelp()
  assert.match(failed, /检查更新失败/, `a failed check is not silence: ${failed}`)
  assert.match(failed, /403/, 'the reason is carried through')
  await act(async () => { updateRoot.unmount() })
  delete globalThis.__updateAnswer
}

// Provenance chip and the import-rename list: the panel has to say which data a
// table came from, and keep the rename notes after the toast is gone.
{
  const stateHost = window.document.createElement('div')
  window.document.body.appendChild(stateHost)
  const stateRoot = createRoot(stateHost)
  const payload = {
    ok: true,
    state: {
      id: 'session-test',
      version: '0.25.0',
      engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
      dataset: {
        sourcePath: '/tmp/a.sav',
        name: 'a.sav',
        caseCount: 5,
        variables: [{ name: 'age', label: '年龄', type: 'numeric', format: 'F8.0', alignment: 'right', measure: 'scale', width: 8, decimals: 0, missing: [], valueLabels: {} }],
      },
      items: [{
        id: 'run-1-0',
        kind: 'table',
        title: '年龄',
        table: { caption: '年龄', matrix: [['', 'N'], ['年龄', '5']] },
        runId: 1,
        provenance: { sessionId: 'session-test', sourcePath: '/tmp/a.sav', name: 'a.sav', caseCount: 5, varCount: 1, openedAt: 1794740000000, at: 1794740000001 },
      }],
      importNotes: ['第 1 列的表头「年龄」没有可用的 ASCII 字符，变量名改为「V1」，原表头保留为标签'],
      log: [],
      mrSets: [],
      splitBy: [],
      history: { undo: 0, redo: 0 },
    },
    signal: { id: 'session-test', items: 1, dataset: { caseCount: 5, vars: 'abc' } },
  }
  window.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  globalThis.fetch = window.fetch
  await act(async () => {
    stateRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  // Output items live in the 输出 view; the panel opens on 数据视图.
  const outTab = [...stateHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  assert.ok(outTab, 'the panel has an 输出 tab')
  await act(async () => {
    outTab.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const prov = stateHost.querySelector('.ap-prov')
  assert.ok(prov, 'a table carries a provenance chip')
  assert.match(prov.textContent, /a\.sav · 5 例 · 1 变量/, 'the chip names the file and the case count')
  assert.match(prov.getAttribute('title'), /来源路径：\/tmp\/a\.sav/, 'the tooltip has the full path')
  // One timestamp, one format: the panel used to say 2026/1/2 03:44:05 while the
  // exports of the same provenance said 2026-01-02 03:44, and stayed in the
  // zh-CN layout even when the panel was English.
  // The exact value, not just the shape: a helper that switched to UTC would keep
  // the format and silently move the stamp by the machine's offset, and the two
  // exits (panel chip, Word/Excel/HTML stamp) would disagree by that much.
  const expectedWhen = (() => {
    const date = new Date(1794740000000)
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  })()
  assert.ok(prov.getAttribute('title').includes(`打开于 ${expectedWhen}`),
    `the panel writes the export's local timestamp: ${prov.getAttribute('title')} vs ${expectedWhen}`)
  // A provenance injected without a sessionId used to render the placeholder
  // itself ("Session: {0}"), because tr() leaves an argument-less {0} alone.
  assert.ok(!prov.getAttribute('title').includes('{0}'),
    `the tooltip never shows a raw placeholder: ${prov.getAttribute('title')}`)
  assert.ok(!/\d{1,2}:\d{2}:\d{2}/.test(prov.getAttribute('title')),
    `the panel keeps no seconds the export drops: ${prov.getAttribute('title')}`)
  const badge = [...stateHost.querySelectorAll('.ap-status button')].find((node) => /导入说明/.test(node.textContent))
  assert.ok(badge, 'the status bar keeps an import-notes entry')
  assert.match(badge.textContent, /导入说明 1/)
  await act(async () => {
    badge.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const noteModal = stateHost.querySelector('.ap-modal')
  assert.ok(noteModal && /原表头保留为标签/.test(noteModal.textContent), 'the dialog lists why each column was renamed')
  // Notes arrive from three different annotators and are appended, never
  // sorted: a table with three of them must read in the order they were added,
  // each carrying the prefix exactly once.
  payload.state.items[0].notes = ['甲：第一', '乙条不含冒号', '丙：第三']
  window.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  globalThis.fetch = window.fetch
  const noteHost = window.document.createElement('div')
  window.document.body.appendChild(noteHost)
  const noteRoot = createRoot(noteHost)
  await act(async () => {
    noteRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const noteTab = [...noteHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  await act(async () => {
    noteTab.click()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const rendered = [...noteHost.querySelectorAll('.ap-note')].map((node) => node.textContent)
  assert.deepEqual(rendered, ['注：甲：第一', '注：乙条不含冒号', '注：丙：第三'],
    `three notes keep their order and get one prefix each: ${rendered.join(' | ')}`)
  await act(async () => { noteRoot.unmount() })
  await act(async () => { stateRoot.unmount() })

  // A dataset built in the panel has no file: the chip must not print its label
  // as if it were a path ("prov-probe · 3 例" read like a file name).
  payload.state.items[0].provenance = { sessionId: 'session-test', origin: 'new', sourcePath: null, name: 'prov-probe', caseCount: 3, varCount: 1, openedAt: null, at: 1794740000002 }
  // And one that arrives without it (an item injected straight into appendItems
  // keeps whatever provenance it was handed).
  payload.state.items[1] = {
    ...payload.state.items[0],
    id: 'run-1-1',
    title: '年龄（无会话）',
    provenance: { origin: 'new', sourcePath: null, name: 'prov-no-session', caseCount: 2, varCount: 1, openedAt: null, at: 1794740000003 },
  }
  window.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  globalThis.fetch = window.fetch
  const builtHost = window.document.createElement('div')
  window.document.body.appendChild(builtHost)
  const builtRoot = createRoot(builtHost)
  await act(async () => {
    builtRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const builtTab = [...builtHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  await act(async () => {
    builtTab.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const builtChip = builtHost.querySelector('.ap-prov')
  assert.ok(builtChip, 'a table from a built dataset still carries a chip')
  // The second item's provenance has no sessionId at all; the tooltip must skip
  // that line instead of printing the template's {0}.
  const chips = [...builtHost.querySelectorAll('.ap-prov')]
  assert.equal(chips.length, 2, `both tables carry a chip: ${chips.length}`)
  // The title does not repeat the dataset name, so pick the second chip by order.
  assert.ok(!chips[1].getAttribute('title').includes('{0}'),
    `a provenance without a session prints no placeholder: ${chips[1].getAttribute('title')}`)
  assert.match(builtChip.textContent, /新建数据集（prov-probe，未保存） · 3 例 · 1 变量/, 'a built dataset is named as data, not as a file')
  assert.equal((builtChip.textContent.match(/prov-probe · /) ?? []).length, 0, 'the old file-looking label is gone')
  assert.match(builtChip.getAttribute('title'), /没有对应的磁盘文件/, 'the tooltip explains why there is no path')
  await act(async () => { builtRoot.unmount() })
  console.log('ok  provenance chip and import-notes list')
}

// The poll: heartbeat first, full state only when the signature moved. This is
// the contract the panel's "the agent changed something" behaviour rests on, so
// it is asserted against a stub instead of by hand in a browser.
{
  const pollHost = window.document.createElement('div')
  window.document.body.appendChild(pollHost)
  const pollRoot = createRoot(pollHost)
  const calls = []
  let signalChanged = false
  const baseSignal = { id: 'session-test', items: 1, dataset: { caseCount: 5, vars: 'abc' } }
  const state = {
    id: 'session-test',
    version: '0.25.0',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: { sourcePath: '/tmp/a.sav', name: 'a.sav', caseCount: 5, variables: [] },
    items: [{
      id: 'run-1-0',
      kind: 'table',
      title: '年龄',
      table: { caption: '年龄', matrix: [['', 'N'], ['年龄', '5']] },
      // The caveats are part of the result: a panel that shows the table and
      // hides "variance is unequal" leaves the reader with half the finding.
      notes: ['方差齐性检验：p = 0.003，方差不齐'],
      runId: 1,
    }],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    // The 设置 page's table preset travels with the state; the panel must draw
    // the output tables with it instead of ignoring it (it used to be a knob
    // that wrote a file nothing read).
    tableStyle: 'grid',
    signal: baseSignal,
  }
  window.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('api/heartbeat')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, signal: signalChanged ? { ...baseSignal, items: 2 } : baseSignal }),
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state }) }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    pollRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  const stateCalls = () => calls.filter((url) => url.includes('api/state')).length
  const beatCalls = () => calls.filter((url) => url.includes('api/heartbeat')).length
  assert.equal(stateCalls(), 1, 'the mount reads the full state once')
  // The preset only matters where tables are drawn.
  const styleTab = [...pollHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  await act(async () => {
    styleTab.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.ok(
    pollHost.querySelector('table.ap-tbl-grid'),
    'the table preset from the settings reaches the drawn table',
  )
  const shownNotes = [...pollHost.querySelectorAll('.ap-note')].map((node) => node.textContent)
  assert.equal(shownNotes.length, 1, 'the table note is drawn with the table')
  assert.match(shownNotes[0], /方差不齐/, 'the note keeps its own wording')
  // …and the same preset has to reach the HTML export, or the printed copy and
  // the screen disagree (the settings page used to claim it did, and it did not).
  const exportedFiles = []
  const realCreate = window.URL.createObjectURL
  const realGlobalUrl = globalThis.URL
  globalThis.URL = window.URL
  window.URL.createObjectURL = (blob) => {
    exportedFiles.push(blob)
    return 'blob:stub'
  }
  const realClick = window.HTMLAnchorElement.prototype.click
  window.HTMLAnchorElement.prototype.click = function noop() {}
  const fileMenu = [...pollHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === '文件')
  await act(async () => {
    fileMenu.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const htmlEntry = [...pollHost.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent === '导出输出为 HTML…')
  assert.ok(htmlEntry, 'the file menu offers an HTML export')
  await act(async () => {
    htmlEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  window.URL.createObjectURL = realCreate
  globalThis.URL = realGlobalUrl
  window.HTMLAnchorElement.prototype.click = realClick
  assert.equal(exportedFiles.length, 1, 'the export produced one file')
  const exportedHtml = await exportedFiles[0].text()
  assert.match(exportedHtml, /<table[^>]*class="[^"]*ap-tbl-grid/, 'the exported table carries the preset class')
  assert.match(exportedHtml, /table\.ap-tbl-grid/, 'the exported stylesheet defines the preset')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3400)) })
  assert.ok(beatCalls() >= 1, 'the open panel polls the heartbeat')
  assert.equal(stateCalls(), 1, 'an unchanged signature does not pull the full state again')
  signalChanged = true
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3400)) })
  assert.ok(stateCalls() >= 2, 'a changed signature pulls the full state')
  await act(async () => { pollRoot.unmount() })
  console.log('ok  poll asks the heartbeat first and only pulls state on change')
}

// A frequency table of a categorical variable is one row per category, and
// people run those on 3000-case files: drawing every row made the panel slow and
// the page unreadably large. The first screenful is what anyone reads, so the
// panel draws 200 rows and offers the rest -- while CSV and exports stay whole.
{
  const bigHost = window.document.createElement('div')
  window.document.body.appendChild(bigHost)
  const bigRoot = createRoot(bigHost)
  const bigRows = [['', 'N', 'Percent']]
  for (let index = 1; index <= 300; index += 1) bigRows.push(['取值' + index, String(index), ((index / 300) * 100).toFixed(1)])
  const bigState = {
    id: 'session-test',
    version: '0.29.0',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: { sourcePath: '/tmp/big.sav', name: 'big.sav', caseCount: 300, variables: [] },
    items: [{ id: 'run-1-0', kind: 'table', title: '大表', table: { caption: '大表', matrix: bigRows }, runId: 1 }],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    signal: { id: 'session-test', items: 1 },
  }
  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(url).includes('api/heartbeat') ? { ok: true, signal: bigState.signal } : { ok: true, state: bigState }),
  })
  globalThis.fetch = window.fetch
  await act(async () => {
    bigRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  const outputTab = [...bigHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  await act(async () => {
    outputTab.click()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const table = bigHost.querySelector('.ap-table-block table')
  assert.ok(table, 'the big table is drawn')
  const drawnRows = table.querySelectorAll('tr').length
  assert.equal(drawnRows, 201, 'a 300-row table draws 200 body rows plus the header, got ' + drawnRows)
  const note = bigHost.querySelector('.ap-table-more')
  assert.match(note.textContent, /共 300 行/, 'the note says how many rows the table really has')
  assert.match(note.textContent, /先画前 200 行/, 'and that the panel drew only the first screenful')
  const expand = [...note.querySelectorAll('button')].find((node) => node.textContent === '显示全部')
  assert.ok(expand, 'the rest is one click away')
  await act(async () => {
    expand.click()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const allRows = bigHost.querySelectorAll('.ap-table-block table tr').length
  assert.equal(allRows, 301, '显示全部 draws every row, got ' + allRows)
  const collapse = [...bigHost.querySelectorAll('.ap-table-more button')].find((node) => node.textContent === '只显示前 200 行')
  assert.ok(collapse, 'and there is a way back to the short table')
  await act(async () => {
    collapse.click()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.equal(bigHost.querySelectorAll('.ap-table-block table tr').length, 201, 'collapsing goes back to 200 rows')
  assert.equal(Boolean(bigHost.querySelector('.ap-status .ap-chip')), false, 'a full dataset gets no truncation chip')
  await act(async () => { bigRoot.unmount() })
  console.log('ok  a big table draws 200 rows and offers the rest')

  // 显示全部 on a 3000-row table must not put 3000 rows in the DOM. jsdom has no
  // layout, so the windowed renderer cannot measure its box and has to fall back
  // to the whole table -- that fallback is the contract, and it is what the
  // client does in a panel that is hidden as well. The window math itself is
  // asserted directly below.
  {
    const rows = [['', 'N', 'Percent']]
    const body = []
    for (let index = 1; index <= 3000; index += 1) {
      rows.push(['取值' + index, String(index), ((index / 3000) * 100).toFixed(1)])
      body.push(`<tr><td>取值${index}</td><td>${index}</td><td>${((index / 3000) * 100).toFixed(1)}</td></tr>`)
    }
    const tableHtml = `<table><caption>大表</caption><tbody><tr><th></th><th>N</th><th>Percent</th></tr>${body.join('')}</tbody></table>`

    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const bigRoot = createRoot(host)
    const state = {
      id: 'session-test',
      version: '0.48.0',
      engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
      dataset: { sourcePath: '/tmp/huge.sav', name: 'huge.sav', caseCount: 3000, variables: [] },
      items: [{ id: 'run-1-0', kind: 'table', title: '大表', table: { caption: '大表', matrix: rows, html: tableHtml }, runId: 1 }],
      importNotes: [],
      log: [],
      mrSets: [],
      splitBy: [],
      history: { undo: 0, redo: 0 },
      tableStyle: 'three-line',
      maxExportRows: 5000,
      signal: { id: 'session-test', items: 1 },
    }
    window.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(String(url).includes('api/heartbeat') ? { ok: true, signal: state.signal } : { ok: true, state }),
    })
    globalThis.fetch = window.fetch
    await act(async () => {
      bigRoot.render(React.createElement(registered.tabs[0].component, props))
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    const outputTab = [...host.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
    await act(async () => {
      outputTab.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    // (a) the first paint is the 200-row preview, not the whole table.
    const firstRows = host.querySelectorAll('.ap-table-block table tr').length
    assert.equal(firstRows, 201, 'a 3000-row table first paints 200 body rows plus the header, got ' + firstRows)
    assert.ok(hooks.VIRT_TABLE_MIN === 200, 'the windowing threshold is 200 body rows')
    // The window math never asks for thousands of rows at once.
    const head = hooks.virtualWindow(3000, 0, 520, 26, 10)
    assert.ok(head.start === 0 && head.end - head.start < 100, 'a 520px viewport shows a screenful, got ' + (head.end - head.start))
    const deep = hooks.virtualWindow(3000, 26 * 2500, 520, 26, 10)
    assert.ok(deep.start > 2400 && deep.end - deep.start < 100, 'a scrolled window stays small and follows the offset')
    // Boundaries of the window itself: an empty table, a one-row table, a scroll
    // offset past the end, and a viewport the browser reports as 0 (a hidden
    // panel) must all stay inside [0, total] and never draw nothing.
    const bounds = [
      [0, 0, 520],
      [1, 0, 520],
      [1, 26 * 5, 520],
      [3000, 26 * 3000, 520],
      [3000, -50, 520],
      [3000, 0, 0],
      [3000, 0, 26],
    ]
    for (const [total, top, viewport] of bounds) {
      const window = hooks.virtualWindow(total, top, viewport)
      assert.ok(window.start >= 0 && window.start <= total,
        `start ${window.start} is inside [0, ${total}] at top=${top}`)
      assert.ok(window.end <= total, `end ${window.end} is inside [0, ${total}] at top=${top}`)
      // A table with no body rows draws nothing, and that is the answer: any
      // other total must yield at least one row.
      assert.equal(window.end > window.start, total > 0,
        `the window is ${total > 0 ? 'non-empty' : 'empty'} for ${total} rows at top=${top}`)
    }
    // A footnote is table furniture, not a body row: windowing must not count it
    // as data or drop it out of the drawn table.
    const footHtml = hooks.matrixHtml([['', 'N'], ['a', '1'], ['b', '2']], 'ap-tbl-three', { footnote: '注：示例' }, 0)
    const footSplit = hooks.splitTableHtml(footHtml)
    assert.equal(footSplit.body.length, 2, 'the footnote row is not counted as body data')
    assert.match(footSplit.tail, /<tfoot>/, 'the footnote stays pinned under the window')
    const expand = [...host.querySelectorAll('.ap-table-more button')].find((node) => node.textContent === '显示全部')
    assert.ok(expand, 'the rest is one click away')
    await act(async () => {
      expand.click()
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    // 硬要求：量不到容器高度（jsdom 没有布局）时退回整表，而不是画 0 行。
    assert.equal(
      host.querySelectorAll('.ap-table-block table tr').length,
      3001,
      'without a measurable box the whole table is drawn, never an empty window',
    )
    assert.equal(host.querySelectorAll('.ap-tbl-spacer').length, 0, 'the fallback has no spacer rows')
    assert.match(host.querySelector('.ap-table-more').textContent, /正在显示全部 3000 行/, 'the note still says all rows are shown')
    await act(async () => { bigRoot.unmount() })

    // With a measurable box the same table is drawn as a window, and the copy /
    // download / export paths still see all 3000 rows (they read the matrix and
    // the original html string, not this DOM).
    const realRect = window.Element.prototype.getBoundingClientRect
    window.Element.prototype.getBoundingClientRect = function measureRect() {
      if (this.classList?.contains('ap-tbl-vscroll')) {
        return { x: 0, y: 0, width: 600, height: 560, top: 0, left: 0, right: 600, bottom: 560, toJSON() {} }
      }
      return realRect.call(this)
    }
    const virtHost = window.document.createElement('div')
    window.document.body.appendChild(virtHost)
    const virtRoot = createRoot(virtHost)
    try {
      await act(async () => {
        virtRoot.render(React.createElement(registered.tabs[0].component, props))
        await new Promise((resolve) => setTimeout(resolve, 150))
      })
      const virtTab = [...virtHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
      await act(async () => {
        virtTab.click()
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      const virtExpand = [...virtHost.querySelectorAll('.ap-table-more button')].find((node) => node.textContent === '显示全部')
      await act(async () => {
        virtExpand.click()
        await new Promise((resolve) => setTimeout(resolve, 60))
      })
      const scroller = virtHost.querySelector('.ap-tbl-vscroll')
      assert.ok(scroller, 'a measurable long table gets a scroller of its own')
      assert.equal(scroller.style.maxHeight, '520px', 'the scroller is capped at the viewport height')
      assert.ok(scroller.querySelector('table.ap-tbl-three'), 'the table preset class survives the windowed render')
      const windowRows = () => scroller.querySelectorAll('tbody tr').length
      assert.ok(windowRows() < 200, 'the expanded table draws a window, got ' + windowRows() + ' rows')
      // The drawn rows must be exactly what virtualWindow asks for, not merely
      // "fewer than the table": a renderer that hard-codes a different size would
      // still pass the loose check above.
      const drawnBody = [...scroller.querySelectorAll('tbody tr')]
        .filter((row) => !row.classList.contains('ap-tbl-spacer')).length - 1
      const expectedWindow = hooks.virtualWindow(3000, 0, 520, 26, 10)
      assert.equal(
        drawnBody,
        expectedWindow.end - expectedWindow.start,
        `the first window draws virtualWindow's rows (drawn ${drawnBody}, expected ${expectedWindow.end - expectedWindow.start})`,
      )

      // (b) the two spacer rows hold the scrollbar at the real length, and the
      // window follows the offset.
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 26 * 2500, set: () => {} })
      await act(async () => {
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      const spacers = [...scroller.querySelectorAll('tr.ap-tbl-spacer')]
      assert.equal(spacers.length, 2, 'a spacer row sits above and below the window')
      const spacerPx = (row) => Number(String(row.querySelector('td')?.getAttribute('style') ?? '').match(/height:(\d+)px/)?.[1] ?? 0)
      const topPx = spacerPx(spacers[0])
      const bottomPx = spacerPx(spacers[1])
      const drawnRows = scroller.querySelectorAll('tbody tr').length - 1 - 2
      assert.equal(
        topPx + drawnRows * 26 + bottomPx,
        3000 * 26,
        `spacers plus drawn rows must add up to the real row count (top ${topPx}, drawn ${drawnRows}, bottom ${bottomPx})`,
      )
      assert.ok(topPx > 60000 && bottomPx > 5000, 'the spacers cover the rows outside the window')
      const inner = scroller.querySelector('.ap-tbl-vbody').innerHTML
      assert.match(inner, /取值2[45]\d\d/, 'the window moved to the scrolled region')
      assert.equal(/<td>取值1<\/td>/.test(inner), false, 'the first row is no longer in the DOM')

      // (c) 复制 CSV / 下载 CSV still see every row.
      let copied = null
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { copied = text } },
      })
      const copyButton = [...virtHost.querySelectorAll('.ap-tool')].find((node) => node.textContent === '复制 CSV')
      assert.ok(copyButton, 'the table still offers 复制 CSV')
      await act(async () => {
        copyButton.click()
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      assert.ok(copied, '复制 CSV wrote to the clipboard')
      assert.equal(copied.split('\n').length, 3001, 'the copied CSV carries all 3000 body rows, got ' + copied.split('\n').length)
      assert.match(copied, /取值3000,3000,/, 'the last row is in the copied CSV')
      delete window.navigator.clipboard

      const downloaded = []
      const realCreate = window.URL.createObjectURL
      const realGlobalUrl = globalThis.URL
      globalThis.URL = window.URL
      window.URL.createObjectURL = (blob) => { downloaded.push(blob); return 'blob:stub-csv' }
      const realClick = window.HTMLAnchorElement.prototype.click
      window.HTMLAnchorElement.prototype.click = function noop() {}
      const downloadButton = [...virtHost.querySelectorAll('.ap-tool')].find((node) => node.textContent === '下载 CSV')
      await act(async () => {
        downloadButton.click()
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      window.URL.createObjectURL = realCreate
      globalThis.URL = realGlobalUrl
      window.HTMLAnchorElement.prototype.click = realClick
      assert.equal(downloaded.length, 1, '下载 CSV produced one file')
      const downloadedCsv = await downloaded[0].text()
      assert.equal(downloadedCsv.split('\n').length, 3001, 'the downloaded CSV carries all 3000 body rows')

      // The HTML export reads item.table.html, not the window in the DOM.
      const exported = []
      globalThis.URL = window.URL
      window.URL.createObjectURL = (blob) => { exported.push(blob); return 'blob:stub-html' }
      window.HTMLAnchorElement.prototype.click = function noop() {}
      const fileMenu = [...virtHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === '文件')
      await act(async () => {
        fileMenu.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      const htmlEntry = [...virtHost.querySelectorAll('.ap-menu-pop button')].find((node) => node.textContent === '导出输出为 HTML…')
      await act(async () => {
        htmlEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      window.URL.createObjectURL = realCreate
      globalThis.URL = realGlobalUrl
      window.HTMLAnchorElement.prototype.click = realClick
      assert.equal(exported.length, 1, 'the HTML export produced one file')
      const exportedHtml = await exported[0].text()
      const exportedRows = (exportedHtml.match(/<tr\b/g) ?? []).length
      assert.equal(exportedRows, 3001, 'the exported HTML carries all 3000 body rows, got ' + exportedRows)
      assert.match(exportedHtml, /取值3000/, 'the last row is in the exported HTML')
      await act(async () => { virtRoot.unmount() })
    } finally {
      window.Element.prototype.getBoundingClientRect = realRect
    }
    console.log('ok  a 3000-row table renders as a window and CSV/export keep every row')
  }

  // (d) a table at or under the threshold keeps the plain whole-table render:
  // 150 rows are all drawn, with no scroller and no spacers around them.
  {
    const smallHost = window.document.createElement('div')
    window.document.body.appendChild(smallHost)
    const smallRoot = createRoot(smallHost)
    const rows = [['', 'N']]
    for (let index = 1; index <= 150; index += 1) rows.push(['取值' + index, String(index)])
    const state = {
      id: 'session-test',
      version: '0.48.0',
      engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
      dataset: { sourcePath: '/tmp/small.sav', name: 'small.sav', caseCount: 150, variables: [] },
      items: [{
        id: 'run-1-0',
        kind: 'table',
        title: '小表',
        table: {
          caption: '小表',
          matrix: rows,
          html: `<table><tbody><tr><th></th><th>N</th></tr>${rows.slice(1).map((row) => `<tr><td>${row[0]}</td><td>${row[1]}</td></tr>`).join('')}</tbody></table>`,
        },
        runId: 1,
      }],
      importNotes: [],
      log: [],
      mrSets: [],
      splitBy: [],
      history: { undo: 0, redo: 0 },
      tableStyle: 'three-line',
      signal: { id: 'session-test', items: 1 },
    }
    window.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(String(url).includes('api/heartbeat') ? { ok: true, signal: state.signal } : { ok: true, state }),
    })
    globalThis.fetch = window.fetch
    await act(async () => {
      smallRoot.render(React.createElement(registered.tabs[0].component, props))
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    const smallTab = [...smallHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
    await act(async () => {
      smallTab.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    assert.equal(smallHost.querySelectorAll('.ap-table-block table tr').length, 151, 'a 150-row table is drawn whole')
    assert.equal(smallHost.querySelector('.ap-tbl-vscroll'), null, 'a small table gets no scroller')
    assert.equal(smallHost.querySelectorAll('.ap-tbl-spacer').length, 0, 'and no spacer rows')
    assert.equal(smallHost.querySelector('.ap-table-more'), null, 'and no 显示全部 button, because nothing is hidden')
    await act(async () => { smallRoot.unmount() })
    console.log('ok  a table under the windowing threshold still renders whole')
  }
}

// A truncated dataset (more cases than "数据视图最多载入个案数") looks exactly
// like a small one, so the panel has to say it, and say that the numbers below
// were computed on everything.
{
  const cutHost = window.document.createElement('div')
  window.document.body.appendChild(cutHost)
  const cutRoot = createRoot(cutHost)
  const cutState = {
    id: 'session-test',
    version: '0.31.2',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: { sourcePath: '/tmp/huge.sav', name: 'huge.sav', caseCount: 200000, truncated: true, variables: [{ name: 'x', type: 'numeric' }] },
    items: [],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    signal: { id: 'session-test', items: 0 },
    cwd: '/tmp',
  }
  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(url).includes('api/heartbeat') ? { ok: true, signal: cutState.signal } : { ok: true, state: cutState }),
  })
  globalThis.fetch = window.fetch
  await act(async () => {
    cutRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  const chip = cutHost.querySelector('.ap-status .ap-chip')
  assert.ok(chip, 'a truncated dataset gets a chip in the status bar')
  assert.match(chip.textContent, /截断显示 200000 例/, 'the chip says how many cases are on screen')
  assert.match(chip.title, /分析、保存与导出仍在完整数据上跑/, 'and that the analysis used everything')
  await act(async () => { cutRoot.unmount() })
  console.log('ok  a truncated dataset says so in the status bar')
}

// The other half of the big-table cap: PSPP hands us the table as HTML, and it
// cannot be sliced by structure. Counting <tr starts and closing the table keeps
// the header, the colgroup and the widths, which is what makes it readable.
{
  const rows = []
  for (let index = 1; index <= 300; index += 1) rows.push(`<tr><td>取值${index}</td><td>${index}</td></tr>`)
  const html = `<table class="x"><colgroup><col style="width:120px"></colgroup>`
    + '<thead><tr><th>值</th><th>N</th></tr></thead><tbody>'
    + rows.join('')
    + '</tbody></table>'
  const cut = hooks.truncateTableHtml(html, 200)
  assert.equal(cut.total, 300, 'the note counts body rows, not the header')
  assert.equal(cut.shown, 200, 'the panel draws 200 of them')
  assert.equal((cut.html.match(/<tr\b/gi) ?? []).length, 201, 'header plus 200 body rows survive the cut')
  assert.ok(cut.html.trimEnd().endsWith('</table>'), 'the table is closed so the browser can parse it')
  assert.ok(cut.html.includes('<colgroup><col style="width:120px"></colgroup>'), 'the column widths are kept')
  assert.ok(cut.html.includes('<th>值</th>'), 'so is the header')
  assert.equal(cut.html.includes('取值201'), false, 'nothing past the limit leaks through')
  const whole = hooks.truncateTableHtml(html, 0)
  assert.equal(whole.total, 300, 'a zero limit means no cut')
  assert.equal((whole.html.match(/<tr\b/gi) ?? []).length, 301, 'the whole table comes back')
  const small = hooks.truncateTableHtml('<table><tr><th>a</th></tr><tr><td>1</td></tr></table>', 200)
  assert.equal(small.shown, 1, 'a small table is left alone')
  assert.equal(small.html.includes('</table>'), true)

  // PSPP's real shape: the header sits in <tbody> as the first row of <th>s.
  const psppRows = []
  for (let index = 1; index <= 301; index += 1) psppRows.push(`<tr><td>${index}</td><td>${index}</td></tr>`)
  const psppHtml = '<table> <caption>x</caption> <tbody> <tr> <th></th> <th></th> <th>Frequency</th> </tr>'
    + psppRows.join('') + ' </tbody> </table>'
  const psppCut = hooks.truncateTableHtml(psppHtml, 200)
  assert.equal(psppCut.total, 301, 'the header row is not counted as a body row')
  assert.equal((psppCut.html.match(/<tr\b/gi) ?? []).length, 201, 'the header row survives with 200 body rows')
  assert.ok(psppCut.html.includes('<caption>x</caption>'), 'the caption is above the cut and stays')

  // A table with no header row at all must not lose a data row.
  const bare = '<table><tbody>' + psppRows.join('') + '</tbody></table>'
  const bareCut = hooks.truncateTableHtml(bare, 200)
  assert.equal(bareCut.total, 301, 'no header means every row is a body row')
  assert.equal((bareCut.html.match(/<tr\b/gi) ?? []).length, 200, 'exactly the limit is drawn')

  // Two leading header rows (a crosstab's column groups) both stay.
  const twoHeads = '<table><tbody><tr><th>x</th><th>a</th><th>b</th></tr><tr><th></th><th>N</th><th>N</th></tr>'
    + psppRows.join('') + '</tbody></table>'
  const twoCut = hooks.truncateTableHtml(twoHeads, 200)
  assert.equal(twoCut.total, 301, 'both header rows are excluded from the count')
  assert.equal((twoCut.html.match(/<tr\b/gi) ?? []).length, 202, 'and both are drawn')
}

// The host wraps state as { ok, state }, but a stub (or a host that grows a
// different envelope) may hand the state itself. Refusing that shape painted an
// empty panel while the data sat right there in the response -- the Windows
// verifier hit exactly this and could not tell whether the panel was broken.
{
  const bareHost = window.document.createElement('div')
  window.document.body.appendChild(bareHost)
  const bareRoot = createRoot(bareHost)
  const bareState = {
    id: 'session-test',
    version: '0.31.0',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: { sourcePath: '/tmp/bare.sav', name: 'bare.sav', caseCount: 7, variables: [
      { name: 'score', label: '得分', type: 'numeric', width: 8, decimals: 2, measure: 'scale', alignment: 'right' },
    ] },
    items: [{ id: 'run-1-0', kind: 'table', title: '裸状态', table: { caption: '裸状态', matrix: [['', 'N'], ['score', '7']] }, runId: 1 }],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    signal: { id: 'session-test', items: 1 },
  }
  // No envelope at all: the state object is the whole body.
  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(url).includes('api/heartbeat') ? { ok: true, signal: bareState.signal } : bareState),
  })
  globalThis.fetch = window.fetch
  await act(async () => {
    bareRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  assert.match(bareHost.textContent, /7 个个案/, 'a bare state object is accepted, not painted as an empty panel')
  assert.ok([...bareHost.querySelectorAll('.ap-grid thead th .ap-head-label')].some((node) => node.textContent === '得分'),
    'and its variables reach the header')
  // A body that is neither shape must fail loudly rather than silently empty.
  window.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
  globalThis.fetch = window.fetch
  assert.throws(() => hooks.stateOf({ ok: true }), /形状不认识/, 'an unrecognisable answer is reported')
  assert.equal(hooks.stateOf({ ok: true, state: bareState }).id, 'session-test', 'the wrapped shape still wins')
  // Several PSPP tabs each hold their own dataset, so a tab has to be named
  // after the file it loaded; the primary tab keeps the plugin's own title.
  const renamed = []
  const service = { updateTab: (id, patch) => { renamed.push([id, patch.title]) } }
  assert.equal(hooks.renameDocTab(service, 'session-test~7', 'session-test', 'sixty.csv'), true)
  assert.deepEqual(renamed, [['analytics:session-test~7', 'sixty.csv']], 'the tab carries the dataset name')
  assert.equal(hooks.renameDocTab(service, 'session-test', 'session-test', 'sixty.csv'), false, 'the primary tab is left alone')
  assert.equal(hooks.renameDocTab(service, 'session-test~8', 'session-test', null), false, 'no dataset name, no rename')
  assert.equal(hooks.renameDocTab({ updateTab: () => { throw new Error('tab strip broke') } }, 'session-test~9', 'session-test', 'a.sav'), false,
    'a tab strip that throws must not fail the open')
  await act(async () => { bareRoot.unmount() })
  console.log('ok  the state envelope is read either way and refuses anything else')
}

// SPSS's menu bar works without the mouse. Two Windows users hit this trying to
// drive the panel from a screenshot: there was no keyboard path into the menus
// at all, so a miscalculated click meant nothing happened.
{
  const menuHost = window.document.createElement('div')
  window.document.body.appendChild(menuHost)
  const menuRoot = createRoot(menuHost)
  const menuState = {
    id: 'session-test',
    version: '0.30.0',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: {
      sourcePath: '/tmp/a.sav',
      name: 'a.sav',
      caseCount: 5,
      variables: [
        { name: 'x', label: '测试标签', type: 'numeric', width: 8, decimals: 2, measure: 'scale', alignment: 'right' },
        { name: 'y', label: '', type: 'numeric', width: 8, decimals: 2, measure: 'scale', alignment: 'right' },
      ],
    },
    items: [
      { id: 'run-1-0', kind: 'table', title: '第一张', table: { caption: '第一张', matrix: [['', 'N'], ['x', '5']] }, runId: 1 },
      { id: 'run-2-0', kind: 'table', title: '第二张', table: { caption: '第二张', matrix: [['', 'N'], ['y', '5']] }, runId: 2 },
    ],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    signal: { id: 'session-test', items: 2 },
  }
  window.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(String(url).includes('api/heartbeat') ? { ok: true, signal: menuState.signal } : { ok: true, state: menuState }),
  })
  globalThis.fetch = window.fetch
  await act(async () => {
    menuRoot.render(React.createElement(registered.tabs[0].component, props))
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  // SPSS prints the variable label under the name in the header; a sheet of
  // x/y means nothing without it.
  const headLabels = [...menuHost.querySelectorAll('.ap-grid thead th .ap-head-label')].map((node) => node.textContent)
  assert.deepEqual(headLabels, ['测试标签'], 'only the labelled variable gets a second header line')
  assert.ok([...menuHost.querySelectorAll('.ap-grid thead th .ap-head-name')].some((node) => node.textContent === 'x'),
    'the variable name stays on the first line')
  const key = (name, init = {}) => new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    window.dispatchEvent(key('f', { altKey: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.ok(menuHost.querySelector('.ap-menu-pop'), 'Alt+F drops the 文件 menu')
  const firstItem = window.document.activeElement
  assert.ok(menuHost.querySelector('.ap-menu-pop')?.contains(firstItem), 'the first entry takes focus')
  await act(async () => {
    window.dispatchEvent(key('ArrowDown'))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.notEqual(window.document.activeElement, firstItem, 'ArrowDown moves through the entries')
  await act(async () => {
    window.dispatchEvent(key('Escape'))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.equal(menuHost.querySelector('.ap-menu-pop'), null, 'Escape closes the menu')
  // Alt+V had no mnemonic, so the view menu was the one menu a keyboard could not
  // reach. The quick-chart group was a leaf: its five entries were defined under
  // `items`, which the renderer does not read, so they were unreachable too.
  await act(async () => {
    window.dispatchEvent(key('v', { altKey: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const viewMenu = menuHost.querySelector('.ap-menu-pop')
  assert.ok(viewMenu, 'Alt+V drops the 视图 menu')
  assert.match(viewMenu.textContent, /显示值标签/, 'the view menu really opened')
  await act(async () => {
    window.dispatchEvent(key('Escape'))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const chartButton = [...menuHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === '图形')
  await act(async () => {
    chartButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const chartPop = menuHost.querySelector('.ap-menu-pop')
  const quick = [...chartPop.querySelectorAll('button')].find((node) => node.textContent.startsWith('快速图形'))
  await act(async () => {
    quick?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.deepEqual(
    [...(quick?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].map((node) => node.textContent),
    ['柱状图', '直方图', '箱线图', '饼图', '折线图'],
    'the quick-chart group opens and lists its five charts',
  )
  await act(async () => {
    window.dispatchEvent(key('Escape'))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const analyseButton = [...menuHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === '分析')
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop = menuHost.querySelector('.ap-menu-pop')
  const correlate = [...analysePop.querySelectorAll('button')].find((node) => node.textContent.startsWith('相关'))
  await act(async () => {
    correlate.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    correlate.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.ok([...analysePop.querySelectorAll('.ap-sub-pop button')].some((node) => node.textContent.startsWith('偏相关')),
    'partial correlation sits under 相关, where SPSS and the docs put it')
  const limits = [...analysePop.querySelectorAll('button')].find((node) => node.textContent.startsWith('受引擎限制的功能'))
  const limitsText = limits?.parentElement?.querySelector('.ap-sub-pop')?.textContent ?? ''
  assert.doesNotMatch(limitsText, /偏相关/, 'partial correlation is no longer listed as an engine limitation')
  // 生存分析这一组现在有两件：KM 由插件算曲线，Cox 由插件拟合偏似然。
  const survivalGroup = [...analysePop.querySelectorAll('button')].find((node) => node.textContent.startsWith('生存分析'))
  await act(async () => {
    survivalGroup?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const survivalItems = [...(survivalGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].map((node) => node.textContent)
  assert.ok(survivalItems.some((text) => text.startsWith('Kaplan–Meier')), `the survival group lists Kaplan–Meier, got ${JSON.stringify(survivalItems)}`)
  assert.ok(survivalItems.some((text) => text.startsWith('Cox 回归')), `and Cox regression, got ${JSON.stringify(survivalItems)}`)
  assert.doesNotMatch(limitsText, /生存分析（KM \/ Cox）/, 'survival analysis is no longer advertised as an engine limitation')
  const coxItem = [...(survivalGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('Cox 回归'))
  await act(async () => {
    coxItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const coxDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.ok(coxDialog, 'the Cox dialog opens from the menu')
  assert.match(coxDialog.textContent, /Cox 回归（比例风险）/, 'the dialog is titled like the procedure')
  assert.match(coxDialog.textContent, /生存时间（必选，数值）/, 'and asks for the survival time')
  assert.match(coxDialog.textContent, /事件指示（必选：1 = 发生，0 = 删失）/, 'and for the event indicator')
  const coxOk = [...coxDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(coxOk.disabled, true, 'nothing is fitted until the three choices are made')
  const coxCancel = [...coxDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    coxCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.equal([...menuHost.querySelectorAll('.ap-modal')].length, 0, 'and it closes again')
  assert.match(clientSource, /api\('api\/cox', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/cox')
  assert.match(clientSource, /\{ time, event, covariates: chosen \}/, 'sending exactly the three choices the host needs')
  // 判别分析：PSPP 没有 DISCRIMINANT，四张表由插件拟合，菜单位置对标 SPSS 的分类。
  // 关掉对话框之后菜单是重新渲染的，早先抓到的 pop 已经脱开文档，得再点开一次。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop2 = menuHost.querySelector('.ap-menu-pop')
  const classifyGroup = [...analysePop2.querySelectorAll('button')].find((node) => node.textContent.startsWith('分类'))
  await act(async () => {
    classifyGroup?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const classifyItems = [...(classifyGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].map((node) => node.textContent)
  assert.ok(classifyItems.some((text) => text.startsWith('判别')), `the classify group lists discriminant analysis, got ${JSON.stringify(classifyItems)}`)
  const discriminantItem = [...(classifyGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('判别'))
  await act(async () => {
    discriminantItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const discriminantDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.ok(discriminantDialog, 'the discriminant dialog opens from the menu')
  assert.match(discriminantDialog.textContent, /判别分析/, 'the dialog is titled like the procedure')
  assert.match(discriminantDialog.textContent, /先验概率/, 'and offers the prior rule')
  const discriminantOk = [...discriminantDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(discriminantOk.disabled, true, 'nothing is fitted until a group and a variable are chosen')
  const discriminantCancel = [...discriminantDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    discriminantCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/discriminant', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/discriminant')
  // 多项 Logistic：PSPP 只做二分类，拟合在宿主侧，对话框只描述模型形状。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop3 = menuHost.querySelector('.ap-menu-pop')
  const regressionGroup = [...analysePop3.querySelectorAll('button')].find((node) => node.textContent.startsWith('回归'))
  await act(async () => {
    regressionGroup?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const regressionItems = [...(regressionGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].map((node) => node.textContent)
  assert.ok(regressionItems.some((text) => text.startsWith('多项 Logistic')), `the regression group lists multinomial logistic, got ${JSON.stringify(regressionItems)}`)
  const multinomialItem = [...(regressionGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('多项 Logistic'))
  await act(async () => {
    multinomialItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const multinomialDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.ok(multinomialDialog, 'the multinomial dialog opens from the menu')
  assert.match(multinomialDialog.textContent, /多项 Logistic 回归/, 'the dialog is titled like the procedure')
  assert.match(multinomialDialog.textContent, /参照类别/, 'and offers the reference category')
  assert.match(multinomialDialog.textContent, /牛顿法/, 'the hint says who fits the model')
  const multinomialOk = [...multinomialDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(multinomialOk.disabled, true, 'nothing is fitted until a dependent and a predictor are chosen')
  const multinomialCancel = [...multinomialDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    multinomialCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/multinomial', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/multinomial')
  assert.match(clientSource, /reference: reference\.trim\(\) === '' \? undefined : reference\.trim\(\)/, 'an empty reference box stays out of the request')
  // 有序 Logistic：比例优势模型。同一个「回归」组里紧跟着多项 Logistic，
  // 两者共用牛顿法的骨架，但这里没有参照类别——阈值就是切点。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop4 = menuHost.querySelector('.ap-menu-pop')
  const regressionGroup2 = [...analysePop4.querySelectorAll('button')].find((node) => node.textContent.startsWith('回归'))
  await act(async () => {
    regressionGroup2?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const ordinalItems = [...(regressionGroup2?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].map((node) => node.textContent)
  assert.ok(ordinalItems.some((text) => text.startsWith('有序 Logistic')), `the regression group lists ordinal logistic, got ${JSON.stringify(ordinalItems)}`)
  const ordinalItem = [...(regressionGroup2?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('有序 Logistic'))
  await act(async () => {
    ordinalItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const ordinalDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.ok(ordinalDialog, 'the ordinal dialog opens from the menu')
  assert.match(ordinalDialog.textContent, /有序 Logistic 回归/, 'the dialog is titled like the procedure')
  assert.match(ordinalDialog.textContent, /平行线检验/, 'and says the parallel-lines test decides whether the assumption holds')
  assert.doesNotMatch(ordinalDialog.textContent, /参照类别/, 'the proportional-odds model has no reference category')
  const ordinalOk = [...ordinalDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(ordinalOk.disabled, true, 'nothing is fitted until a dependent and a predictor are chosen')
  const ordinalCancel = [...ordinalDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    ordinalCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/ordinal', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/ordinal')
  // 泊松回归：计数因变量的对数连接模型，同样在宿主侧拟合。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop5 = menuHost.querySelector('.ap-menu-pop')
  const regressionGroup3 = [...analysePop5.querySelectorAll('button')].find((node) => node.textContent.startsWith('回归'))
  await act(async () => {
    regressionGroup3?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const poissonItem = [...(regressionGroup3?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('泊松回归'))
  assert.ok(poissonItem, 'the regression group lists Poisson regression')
  await act(async () => {
    poissonItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const poissonDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.ok(poissonDialog, 'the Poisson dialog opens from the menu')
  assert.match(poissonDialog.textContent, /泊松回归/, 'the dialog is titled like the procedure')
  assert.match(poissonDialog.textContent, /离散参数/, 'the hint explains what the dispersion parameter means')
  const poissonOk = [...poissonDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(poissonOk.disabled, true, 'nothing is fitted until a dependent and a predictor are chosen')
  const poissonCancel = [...poissonDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    poissonCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/poisson', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/poisson')
  // 权重估计：与泊松同一个回归组，多一个权重变量下拉。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop6 = menuHost.querySelector('.ap-menu-pop')
  const regressionGroup4 = [...analysePop6.querySelectorAll('button')].find((node) => node.textContent.startsWith('回归'))
  await act(async () => {
    regressionGroup4?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const wlsItem = [...(regressionGroup4?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('权重估计'))
  assert.ok(wlsItem, 'the regression group lists weight estimation')
  await act(async () => {
    wlsItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const wlsDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(wlsDialog?.textContent ?? '', /权重估计/, 'the dialog is titled like the procedure')
  assert.match(wlsDialog.textContent, /权重变量/, 'and asks for the weight column')
  assert.match(wlsDialog.textContent, /0 或负数会被剔除/, 'and says what happens to bad weights')
  const wlsOk = [...wlsDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(wlsOk.disabled, true, 'three choices are required before it can run')
  const wlsCancel = [...wlsDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    wlsCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/wls', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/wls')
  // 分布计算器：在「实用程序」里（不依赖数据集，所以不像分析过程那样在分析菜单）。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const utilityButton = [...menuHost.querySelectorAll('.ap-menu-button')]
    .find((node) => node.textContent.startsWith('实用程序'))
  assert.ok(utilityButton, 'the menu bar has a utility menu')
  await act(async () => {
    utilityButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const utilityPop = menuHost.querySelector('.ap-menu-pop')
  const distributionItem = [...utilityPop.querySelectorAll('button')].find((node) => node.textContent.startsWith('分布计算器'))
  assert.ok(distributionItem, 'the utility menu lists the distribution calculator')
  await act(async () => {
    distributionItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const distributionDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(distributionDialog?.textContent ?? '', /分布计算器/, 'the dialog is titled like the procedure')
  assert.match(distributionDialog.textContent, /点 x/, 'and asks for the point to evaluate')
  assert.match(distributionDialog.textContent, /累积概率/, 'and offers the quantile lookup')
  assert.match(distributionDialog.textContent, /正态（z）/, 'the normal distribution is the starting choice')
  assert.match(distributionDialog.textContent, /真实分布不需要自由度/, 'the hint says which distributions need parameters')
  const distributionOk = [...distributionDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(distributionOk.disabled, false, 'a point with a default value is enough to run')
  const distributionCancel = [...distributionDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    distributionCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/distribution', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/distribution')
  // 对应分析：在「分析 → 降维」里，与因子、快速聚类同一组。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePopCa = menuHost.querySelector('.ap-menu-pop')
  const dimensionGroup = [...analysePopCa.querySelectorAll('button')].find((node) => node.textContent.startsWith('降维'))
  await act(async () => {
    dimensionGroup?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const correspondenceItem = [...(dimensionGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])]
    .find((node) => node.textContent.startsWith('对应分析'))
  assert.ok(correspondenceItem, 'the dimension group lists correspondence analysis')
  await act(async () => {
    correspondenceItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const correspondenceDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(correspondenceDialog?.textContent ?? '', /对应分析/, 'the dialog is titled like the procedure')
  assert.match(correspondenceDialog.textContent, /行变量/, 'and asks for the row variable')
  assert.match(correspondenceDialog.textContent, /列变量/, 'and for the column variable')
  assert.match(correspondenceDialog.textContent, /惯量 = 卡方 \/ 个案数/, 'and explains what inertia is')
  const correspondenceOk = [...correspondenceDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(correspondenceOk.disabled, true, 'two variables are required before it can run')
  const correspondenceCancel = [...correspondenceDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    correspondenceCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/correspondence', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/correspondence')

  // 多重对应分析：同一组「降维」菜单里，勾两个以上分类变量才能确定。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePopMca = menuHost.querySelector('.ap-menu-pop')
  const dimensionGroupMca = [...analysePopMca.querySelectorAll('button')].find((node) => node.textContent.startsWith('降维'))
  await act(async () => {
    dimensionGroupMca?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const mcaItem = [...(dimensionGroupMca?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])]
    .find((node) => node.textContent.startsWith('多重对应分析'))
  assert.ok(mcaItem, 'the dimension group lists multiple correspondence analysis')
  await act(async () => {
    mcaItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const mcaDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(mcaDialog?.textContent ?? '', /多重对应分析/, 'the dialog is titled like the procedure')
  assert.match(mcaDialog.textContent, /分类变量（两个起）/, 'and asks for two or more categorical variables')
  assert.match(mcaDialog.textContent, /已选 0 个变量/, 'and counts what has been picked')
  const mcaOk = [...mcaDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(mcaOk.disabled, true, 'one variable is not enough')
  const chips = [...mcaDialog.querySelectorAll('.ap-chip')]
  assert.ok(chips.length >= 2, 'the dialog offers the categorical variables as chips')
  await act(async () => {
    chips[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.equal(mcaOk.disabled, true, 'still not enough with one chip')
  await act(async () => {
    chips[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.equal(mcaOk.disabled, false, 'two variables enable the run button')
  assert.match(mcaDialog.textContent, /已选 2 个变量/, 'and the counter agrees')
  const mcaCancel = [...mcaDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    mcaCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/mca', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/mca')

  // 曲线估计：11 个模型一次全勾，Logistic 的上界可以留空。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePopCurveFit = menuHost.querySelector('.ap-menu-pop')
  const regressionGroupFit = [...analysePopCurveFit.querySelectorAll('button')].find((node) => node.textContent.startsWith('回归'))
  await act(async () => {
    regressionGroupFit?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const curveItemFit = [...(regressionGroupFit?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])]
    .find((node) => node.textContent.startsWith('曲线估计'))
  assert.ok(curveItemFit, 'the regression group lists curve estimation')
  await act(async () => {
    curveItemFit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const curveDialogFit = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(curveDialogFit?.textContent ?? '', /曲线估计/, 'the dialog is titled like the procedure')
  assert.match(curveDialogFit.textContent, /已选 11 个模型/, 'all eleven models start checked')
  assert.match(curveDialogFit.textContent, /Logistic 上界 u/, 'the logistic bound is offered')
  assert.match(curveDialogFit.textContent, /原始尺度 R²/, 'and the original-scale R² is explained')
  const curveOkFit = [...curveDialogFit.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(curveOkFit.disabled, false, 'two numeric variables are enough to run')
  const curveCancelFit = [...curveDialogFit.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    curveCancelFit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/curve', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/curve')

  // 多维标度：降维组里的第二张图（经典解，勾几个数值变量就是几个维度）。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePopMds = menuHost.querySelector('.ap-menu-pop')
  const dimensionGroupMds = [...analysePopMds.querySelectorAll('button')].find((node) => node.textContent.startsWith('降维'))
  await act(async () => {
    dimensionGroupMds?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const mdsItem = [...(dimensionGroupMds?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])]
    .find((node) => node.textContent.startsWith('多维标度'))
  assert.ok(mdsItem, 'the dimension group lists multidimensional scaling')
  await act(async () => {
    mdsItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const mdsDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(mdsDialog?.textContent ?? '', /多维标度/, 'the dialog is titled like the procedure')
  assert.match(mdsDialog.textContent, /距离测度/, 'and asks for a distance measure')
  assert.match(mdsDialog.textContent, /经典多维标度/, 'and says which algorithm it uses')
  assert.match(mdsDialog.textContent, /已选 2 个变量/, 'two numeric variables start selected')
  const mdsOk = [...mdsDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(mdsOk.disabled, false, 'two variables are enough')
  const mdsCancel = [...mdsDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    mdsCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/mds', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/mds')



  // 二阶段最小二乘：工具数不足时确定按钮不可点（识别不足是代数问题）。
  await act(async () => {
    analyseButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const analysePop7 = menuHost.querySelector('.ap-menu-pop')
  const regressionGroup5 = [...analysePop7.querySelectorAll('button')].find((node) => node.textContent.startsWith('回归'))
  await act(async () => {
    regressionGroup5?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const tslsItem = [...(regressionGroup5?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])].find((node) => node.textContent.startsWith('二阶段最小二乘'))
  assert.ok(tslsItem, 'the regression group lists two-stage least squares')
  await act(async () => {
    tslsItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const tslsDialog = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(tslsDialog?.textContent ?? '', /二阶段最小二乘/, 'the dialog is titled like the procedure')
  assert.match(tslsDialog.textContent, /内生自变量/, 'it separates endogenous regressors')
  assert.match(tslsDialog.textContent, /工具变量/, 'from the instruments')
  assert.match(tslsDialog.textContent, /识别不足/, 'and explains what happens when there are too few instruments')
  const tslsOk = [...tslsDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确定')
  assert.equal(tslsOk.disabled, true, 'nothing is fitted until the sets are chosen')
  const tslsCancel = [...tslsDialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
  await act(async () => {
    tslsCancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(clientSource, /api\('api\/twostage', \{ sessionId, options: payload \}\)/, 'the dialog posts to api/twostage')

  // 「查找过程」：整条菜单路径可搜，选中即执行。路径是唯一的区分手段，
  // 所以断言里连「分析 → 回归 →」这一段也要对。
  const commands = hooks.flattenCommands([
    { label: '分析', items: [
      { label: '回归', sub: [
        { label: '线性…', action: () => {} },
        { label: '泊松回归…（计数因变量）', action: () => {} },
      ] },
      { sep: true },
      { label: '描述统计', sub: [{ label: '频率…', action: () => {} }] },
    ] },
    { label: '帮助', items: [{ label: '关于', action: () => {}, disabled: true }] },
  ])
  assert.equal(commands.length, 4, JSON.stringify(commands.map((entry) => entry.path)))
  assert.equal(commands[1].path, '分析 → 回归 → 泊松回归…（计数因变量）', commands[1].path)
  assert.equal(commands[3].disabled, true, 'a disabled entry stays disabled')
  const helpButton = [...menuHost.querySelectorAll('.ap-menu-button')].find((button) => button.textContent.startsWith('帮助'))
  assert.ok(helpButton, `help menu button: ${[...menuHost.querySelectorAll('.ap-menu-button')].map((b) => b.textContent).join('|')}`)
  await act(async () => {
    helpButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const helpPop = [...menuHost.querySelectorAll('.ap-menu-pop')].at(-1)
  const finderItem = [...helpPop.querySelectorAll('button')].find((node) => node.textContent.startsWith('查找过程'))
  assert.ok(finderItem, 'the help menu lists the procedure finder')
  await act(async () => {
    finderItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const finder = [...menuHost.querySelectorAll('.ap-finder')].at(-1)
  assert.ok(finder, 'the finder dialog opens')
  const finderInput = finder.querySelector('.ap-finder-input')
  assert.ok(finderInput, 'the finder has a search box')
  const typeInto = (node, text) => {
    const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, text)
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  await act(async () => {
    typeInto(finderInput, '泊松')
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const finderLive = [...menuHost.querySelectorAll('.ap-finder')].at(-1)
  const paths = [...finderLive.querySelectorAll('.ap-finder-row')].map((node) => node.textContent)
  assert.ok(paths.length >= 1 && paths.every((path) => path.includes('泊松')), JSON.stringify(paths))
  assert.match(paths[0], /分析 → 回归 → 泊松回归/, paths[0])
  await act(async () => {
    finderLive.querySelector('.ap-finder-row').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const afterFinder = [...menuHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(afterFinder?.textContent ?? '', /泊松回归/, 'running a found command opens its dialog')

  const outTab = [...menuHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  await act(async () => {
    outTab.click()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  assert.match(menuHost.querySelector('.ap-outline')?.textContent ?? '', /运行 1/, 'the outline groups results under the run that produced them')
  assert.match(menuHost.querySelector('.ap-outline')?.textContent ?? '', /运行 2/, 'a second run gets its own heading')
  await act(async () => { menuRoot.unmount() })
  console.log('ok  the menu bar opens from the keyboard and the outline groups runs')
}

// 系统聚类：PSPP 只做 k-means，所以对话框只交矩阵变换的入参，树在宿主侧算。
{
  const specs = hooks.ANALYSIS_SPECS
  assert.ok(specs?.hierarchicalCluster?.build, 'the hierarchical cluster dialog exists')
  const built = specs.hierarchicalCluster.build(
    { variables: ['x', 'y'], clusters: '2' },
    { clusterOptions: { linkage: 'single', measure: 'cityblock', chart: true } },
  )
  assert.deepEqual(built.cluster, { variables: ['x', 'y'], clusters: 2, linkage: 'single', measure: 'cityblock' },
    `unexpected cluster request: ${JSON.stringify(built.cluster)}`)
  assert.equal(built.chart, 'dendrogram', 'the checkbox asks for the tree')
  const defaults = specs.hierarchicalCluster.build({ variables: ['x'] }, {})
  assert.equal(defaults.cluster.linkage, 'average', 'average linkage is the default')
  assert.equal(defaults.cluster.measure, 'euclidean', 'and Euclidean distance')
  assert.equal(defaults.cluster.clusters, 3, 'three groups unless the user says otherwise')
  assert.equal(defaults.chart, null, 'no tree unless it is asked for')
  // Ward on plain Euclidean distance would silently change the merge order.
  const ward = specs.hierarchicalCluster.build({ variables: ['x'] }, { clusterOptions: { linkage: 'ward', measure: 'euclidean' } })
  assert.match(ward.error, /欧氏距离平方/, `ward should be refused: ${JSON.stringify(ward)}`)
  assert.match(clientSource, /api\('api\/cluster', \{ sessionId, options \}\)/, 'the runner posts to api/cluster')
}

// 时间序列：拟合在宿主侧算，所以对话框只挑方法并把该方法的参数带上；
// 不该用到的参数不能混进请求体，否则界面会显示一个用户没填过的值。
{
  const specs = hooks.ANALYSIS_SPECS
  assert.ok(specs?.timeseries?.build, 'the time-series dialog exists')
  const moving = specs.timeseries.build({ variable: 'score', periods: '2' },
    { tsOptions: { method: 'ma', span: '3', alpha: '0.5', beta: '0.5', chart: true } })
  assert.deepEqual(moving.timeseries, { variable: 'score', method: 'ma', periods: 2, span: 3 },
    `unexpected smoothing request: ${JSON.stringify(moving.timeseries)}`)
  assert.equal(moving.chart, 'timeseries', 'the checkbox asks for the series chart')
  const holt = specs.timeseries.build({ variable: 'score' },
    { tsOptions: { method: 'des', span: '9', alpha: '0.4', beta: '0.1' } })
  assert.deepEqual(holt.timeseries, { variable: 'score', method: 'des', periods: 0, alpha: 0.4, beta: 0.1 },
    'Holt carries alpha and beta but never the moving-average window')
  const defaults = specs.timeseries.build({ variable: 'score' }, {})
  assert.equal(defaults.timeseries.method, 'ses', 'simple smoothing is the default')
  assert.equal(defaults.timeseries.periods, 0, 'and nothing is extrapolated unless asked')
  assert.equal(defaults.chart, null, 'no chart unless it is asked for')
  assert.match(clientSource, /api\('api\/timeseries', \{ sessionId, options \}\)/, 'the runner posts to api/timeseries')
}

// The settings page is what makes the knobs reachable without editing the
// profile patch, so it has to render the values it read, say where they live,
// and post a validated patch back.
{
  const posts = []
  const payload = {
    ok: true,
    settings: { maxRows: 5000, timeoutMs: 90000, safer: true, uiLanguage: 'zh', tableStyle: 'grid', allowedDirs: ['/mnt/F/data'] },
    defaults: { maxRows: 200000, timeoutMs: 120000, safer: false, uiLanguage: 'zh', tableStyle: 'three-line', allowedDirs: [] },
    path: '/home/someone/.dsh/analytics/settings.json',
    exists: true,
    problems: ['decimals 必须是整数，收到 "x"'],
    deploymentOnly: { registerTools: { value: false, note: '这个开关决定 pspp_* 工具是否进每个会话' } },
  }
  window.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(init.body))
      const patch = JSON.parse(init.body).patch ?? {}
      return { ok: true, status: 200, text: async () => JSON.stringify({ ...payload, settings: { ...payload.settings, ...patch } }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  }
  globalThis.fetch = window.fetch
  const root = window.document.createElement('div')
  const reactRoot = createRoot(root)
  // 保存 lives in the dialog footer now (a tall form would hide its own buttons
  // below the fold), so the form hands its save function to whoever renders it.
  const saveRef = { current: null }
  await act(async () => {
    reactRoot.render(React.createElement(hooks.settingsForm, { onDone: () => {}, saveRef }))
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  const text = root.textContent
  assert.match(text, /设置文件：\/home\/someone\/\.dsh\/analytics\/settings\.json/, 'the page names the file it writes')
  assert.match(text, /下面这些值没被采用/, 'a broken field is reported instead of silently reverted')
  assert.match(text, /工具挂载（registerTools）：关/, 'the deployment-only switch is shown with its value')
  const numbers = [...root.querySelectorAll('input[type="number"]')].map((input) => input.value)
  assert.deepEqual(numbers, ['5000', '90', ''], 'cases and timeout (in seconds) come back from the file; the export cap shows the file value or blank')
  const checkbox = root.querySelector('input[type="checkbox"]')
  assert.equal(checkbox.checked, true)
  const selects = [...root.querySelectorAll('select')]
  assert.equal(selects[0].value, 'zh', 'the language select comes back from the file')
  assert.equal(selects[1].value, 'grid', 'the table style select comes back from the file')
  assert.equal(typeof saveRef.current, 'function', 'the form hands its save function to the dialog')
  await act(async () => { await saveRef.current(); await new Promise((resolve) => setTimeout(resolve, 60)) })
  assert.equal(posts.length, 1, 'saving posts once')
  const textarea = root.querySelector('textarea')
  assert.equal(textarea.value, '/mnt/F/data', 'the allowed directories come back one per line')
  assert.deepEqual(posts[0].patch, { maxRows: 5000, timeoutMs: 90000, safer: true, uiLanguage: 'zh', tableStyle: 'grid', allowedDirs: ['/mnt/F/data'] }, 'seconds go back as milliseconds and directories go back as a list')
  assert.match(root.textContent, /已保存/, 'the page says the save landed')
  await act(async () => { reactRoot.unmount() })
  console.log('ok  settings page reads the file, reports problems and posts a patch')
}

// The English UI is one wrapper over the element factory rather than a t() call
// at every one of ~750 strings, so two things have to be true: the wrapper
// translates text and the text props, and the panel actually fetches the
// dictionary when the host says the language changed.
{
  hooks.setDictionary({ 保存: 'Save', 尚未打开数据集: 'No dataset open', '{0} 个个案': '{0} cases' })
  assert.equal(hooks.tr('保存'), 'Save', 'an exact key is translated')
  assert.equal(hooks.tr('3000 个个案'), '3000 cases', 'a slot template is filled in')
  // The old fallback replaced every key found inside a sentence, which is how
  // `Homogeneity of variance test的 p < 0.001` happened. A sentence without a
  // template must stay whole.
  assert.equal(hooks.tr('方差齐性检验的 p < 0.001'), '方差齐性检验的 p < 0.001', 'no accidental glue')
  assert.equal(hooks.tr('✓未翻译'), '✓未翻译', 'the check mark is not a key')
  assert.equal(hooks.tr('✓ 保存'), '✓ Save', 'the check mark survives around a translated label')
  assert.equal(hooks.tr('/tmp/a.sav'), '/tmp/a.sav', 'a path is left alone')
  const node = hooks.h('button', { title: '保存', className: 'ap-tool' }, '保存')
  assert.equal(node.props.title, 'Save', 'the title prop is translated')
  assert.equal(node.props.className, 'ap-tool', 'other props are untouched')
  assert.equal(node.props.children, 'Save', 'a text child is translated')
  hooks.setDictionary(null)
  assert.equal(hooks.tr('保存'), '保存', 'clearing the dictionary falls back to Chinese')
  console.log('ok  the i18n wrapper translates text and props, and falls back to Chinese')
}

// A cell holds a value, not a caption: the dictionary has short Chinese keys
// such as 保存/缺失/总计, so running data through tr() turned 总计 into "Total"
// and a variable named 保存 into "Save" in the English panel.
{
  hooks.setDictionary({ 保存: 'Save', 缺失: 'Missing', 总计: 'Total', '{0} 个': '{0}' })
  const cell = hooks.h('td', { translate: false }, '总计')
  assert.equal(cell.props.children, '总计', 'a value marked as content stays verbatim')
  assert.equal(cell.props.translate, undefined, 'the marker never reaches the DOM')
  const header = hooks.h('span', { className: 'ap-head-name', translate: false }, '保存')
  assert.equal(header.props.children, '保存', 'a variable name stays verbatim')
  assert.equal(hooks.h('td', null, '总计').props.children, 'Total', 'interface text still translates')
  hooks.setDictionary(null)
  console.log('ok  data values and variable names are not translated')
}

// Panel side of the same feature: state.locale drives one fetch of api/locale,
// and the panel redraws in English without a reload.
{
  const enHost = window.document.createElement('div')
  window.document.body.appendChild(enHost)
  const enRoot = createRoot(enHost)
  const enState = {
    id: 'session-en',
    version: '0.32.0',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: null,
    items: [],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    maxRows: null,
    maxExportRows: null,
    locale: 'en',
    signal: { id: 'session-en', items: 0 },
  }
  const asked = []
  window.fetch = async (url) => {
    const target = String(url)
    if (target.includes('api/locale')) {
      asked.push(target)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          locale: 'en',
          strings: { 尚未打开数据集: 'No dataset open', 统计分析: 'Statistics' },
        }),
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(target.includes('api/heartbeat') ? { ok: true, signal: enState.signal } : { ok: true, state: enState }),
    }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    enRoot.render(React.createElement(registered.tabs[0].component, { ...props, scope: { sessionId: 'session-en', cwd: '/tmp' }, tab: null }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
  assert.ok(asked.length >= 1, 'the panel asked for the dictionary once it saw locale=en')
  assert.match(enHost.textContent, /No dataset open/, 'the empty state is in English')
  await act(async () => { enRoot.unmount() })
  console.log('ok  locale=en pulls the dictionary and redraws the panel in English')
}

// The English panel has to be English all the way: a half-translated frame is
// worse than a Chinese one for the reader this feature exists for. The real
// dictionary is used here, and the assertion is simply that no Chinese is left
// in the rendered panel.
{
  const dict = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8')).strings
  const fullHost = window.document.createElement('div')
  window.document.body.appendChild(fullHost)
  const fullRoot = createRoot(fullHost)
  const fullState = {
    id: 'session-en2',
    version: '0.32.1',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: {
      sourcePath: '/tmp/en.sav',
      name: 'en.sav',
      caseCount: 12,
      variables: [
        { name: 'score', label: 'Score', type: 'numeric', width: 8, decimals: 2, measure: 'scale', alignment: 'right' },
      ],
      truncated: false,
    },
    items: [
      {
        id: 'run-1-0',
        kind: 'table',
        title: 'Descriptive Statistics',
        runId: 1,
        table: { caption: 'Descriptive Statistics', matrix: [['', 'N', 'Mean'], ['score', '12', '50.25']] },
        // The prefix is produced by the panel, not by the note: it used to be
        // written as 注： directly, so an English panel showed a Chinese prefix.
        // The second note carries a full-width colon on purpose: the panel used
        // to run the whole line through the translator again, and the generic
        // "{0}：{1}" template turned that colon into a half-width one.
        // A note with Chinese text is what the second tr() pass actually breaks:
        // translateOne() only walks strings that contain Han characters, so a
        // Latin note with a full-width colon slipped through untouched and left
        // this assertion green even with translate: false removed.
        notes: ['Levene p = 0.003', 'Levene test：variances differ', '方差齐性检验：各组方差不等'],
        // A dataset built in the panel: the export's source line assembles its
        // label from pieces, and a piece that skipped tr() stayed Chinese while
        // Word/Excel said "New dataset".
        provenance: { sessionId: 'session-test', origin: 'new', sourcePath: null, name: 'd', caseCount: 12, varCount: 1, openedAt: null, at: 1794740000004 },
      },
      {
        // A 250-row table, so the truncation bar is on screen while the panel
        // claims to be English. It was the one place with a bare template.
        id: 'run-2-0',
        kind: 'table',
        title: 'Frequency',
        runId: 2,
        table: {
          caption: 'Frequency',
          matrix: [['', 'N', 'Percent'], ...Array.from({ length: 250 }, (_, index) => [String(index), '1', '0.4'])]
        },
        notes: [],
      },
    ],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    maxRows: null,
    maxExportRows: null,
    locale: 'en',
    signal: { id: 'session-en2', items: 1 },
  }
  window.fetch = async (url) => {
    const target = String(url)
    if (target.includes('api/locale')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, locale: 'en', strings: dict }) }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(target.includes('api/heartbeat') ? { ok: true, signal: fullState.signal } : { ok: true, state: fullState }),
    }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    fullRoot.render(React.createElement(registered.tabs[0].component, { ...props, scope: { sessionId: 'session-en2', cwd: '/tmp' }, tab: null }))
    await new Promise((resolve) => setTimeout(resolve, 220))
  })
  // Switch to the output view, which is where most of the text lives.
  await act(async () => {
    const tab = [...fullHost.querySelectorAll('.ap-view-tab')].find((node) => /Output/.test(node.textContent))
    assert.ok(tab, 'the output view tab is labelled in English')
    tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  // Opening a menu is where the shortcut label used to fall apart: the
  // dictionary carries `撤销（Ctrl+Z）` as one entry, and translating only the word
  // half left `撤销Ctrl+Z` on screen.
  {
    const buttons = [...fullHost.querySelectorAll('.ap-menu-button')]
    const edit = buttons.find((node) => node.textContent === 'Edit')
    assert.ok(edit, `the menubar is translated: ${buttons.map((node) => node.textContent).join(' / ')}`)
    await act(async () => {
      edit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const pop = fullHost.querySelector('.ap-menu-pop')
    assert.ok(pop, 'the edit menu opened')
    assert.match(pop.textContent, /Undo \(Ctrl\+Z\)/, `the undo entry keeps its shortcut: ${pop.textContent.slice(0, 120)}`)
    assert.match(pop.textContent, /Copy \(Ctrl\+C\)/, 'copy keeps its shortcut too')
  }
  // The 视图 menu builds its labels from a tick plus the item name; the tick used
  // to be glued on before translating, so "✓ 显示值标签" never matched the
  // dictionary and the menu stayed Chinese inside an English panel.
  {
    // Every top-level menu, not just the two the other cases open: the transparent
    // ones were where a glued-on tick defeated the dictionary.
    const buttons = [...fullHost.querySelectorAll('.ap-menu-button')]
    assert.ok(buttons.length >= 8, `the panel has its menus in English: ${buttons.map((node) => node.textContent).join(' / ')}`)
    for (const button of buttons) {
      const name = button.textContent
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
      const pop = fullHost.querySelector('.ap-menu-pop')
      assert.ok(pop, `the ${name} menu opened`)
      const text = pop.textContent
      // Han characters are not the whole story: the sub-menu used to keep its
      // full-width parens (U+FF08/FF09) after translating, which a CJK-only scan
      // cannot see. Cover the full-width block and CJK punctuation too.
      assert.deepEqual([...new Set(text.match(/[\u4e00-\u9fff\uFF00-\uFFEF\u3000-\u303F]+/g) ?? [])], [],
        `the ${name} menu still shows Chinese: ${text.slice(0, 240)}`)
      if (name === 'View') {
        assert.match(text, /Show value labels/, `the tick does not defeat the dictionary: ${text.slice(0, 200)}`)
        // The one place that really was broken: the sub-menu label was assembled
        // from two translated parts with a raw full-width paren between them.
        assert.match(text, /Follow settings \(Three-line\)/,
          `the sub-menu parens follow the language: ${text.slice(0, 240)}`)
      }
      await act(async () => {
        document.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
  }
  {
    const note = fullHost.querySelector('.ap-note')
    assert.ok(note, 'the table note is drawn in the english panel')
    assert.match(note.textContent, /^Note: Levene p = 0\.003$/, `the note prefix follows the language: ${note.textContent}`)
    const notes = [...fullHost.querySelectorAll('.ap-note')].map((node) => node.textContent)
    assert.ok(notes.includes('Note: Levene test：variances differ'),
      `the note body keeps its own punctuation: ${notes.join(' | ')}`)
    assert.ok(notes.includes('Note: 方差齐性检验：各组方差不等'),
      `a Chinese note body keeps its full-width colon: ${notes.join(' | ')}`)
    const truncation = fullHost.querySelector('.ap-table-more')
    assert.ok(truncation, 'the truncation bar is drawn for the 250-row table')
    assert.match(truncation.textContent, /This table has 250 rows/, `the truncation bar follows the language: ${truncation.textContent}`)
  }
  // Note bodies are Chinese by design (they carry variable names and numbers, so
  // they are never run through the dictionary). Scanning them would force the
  // fixture to stay free of Chinese notes, which is exactly how the untranslated
  // truncation bar stayed hidden. Scan the chrome only.
  const chromeText = [...fullHost.querySelectorAll('*')]
    .filter((node) => !node.closest('.ap-note'))
    .filter((node) => node.childElementCount === 0)
    .map((node) => node.textContent)
    .join(' ')
  const leftovers = [...new Set((chromeText.match(/[\u4e00-\u9fff]+/g) ?? []))]
  assert.deepEqual(leftovers, [], `translated panel still shows Chinese: ${leftovers.join(' / ')}`)
  // Tooltips are text the reader sees too, and they were the last place a raw
  // string could hide: `tr()` fills the outer template but never looks inside an
  // interpolated value, and `translate: false` freezes the props as well.
  {
    const titles = [...fullHost.querySelectorAll('[title]')]
      .filter((node) => !node.closest('.ap-note'))
      .map((node) => node.getAttribute('title') ?? '')
    const cjk = [...new Set(titles.join(' \n ').match(/[\u4e00-\u9fff]+/g) ?? [])]
    assert.deepEqual(cjk, [], `translated panel still shows Chinese tooltips: ${cjk.join(' / ')}`)
    // `translate: false` keeps the variable name itself, but it used to freeze the
    // element's tooltip too, so the cell said 单击改名 in an English panel.
    const varTab = [...fullHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === 'Variable View')
    assert.ok(varTab, 'the variable view tab is translated')
    await act(async () => {
      varTab.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const nameCell = fullHost.querySelector('.ap-var-name')
    assert.ok(nameCell, 'the variable view draws a name cell')
    assert.equal(nameCell.getAttribute('title'), 'Click to rename',
      `the variable-name tooltip follows the language: ${nameCell.getAttribute('title')}`)
    const backTab = [...fullHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === 'Output')
    await act(async () => {
      backTab.click()
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    // The collapsed marker rides in front of the label just like the checked one,
    // and only an item with no title can reach the fallback word.
    assert.equal(hooks.tr('▸ 表格'), '▸ Table', 'the collapsed marker does not stop translation')
    assert.equal(hooks.tr('▸ 图'), '▸ Graphs', 'the collapsed marker does not stop translation')
    assert.equal(hooks.tr('▾ 表格'), '▾ Table', 'the expanded marker does not stop translation either')
  }
  // The HTML export leaves the panel, so its chrome has to follow the same
  // language: a file whose title says "PSPP 输出" and whose notes say "注：" is a
  // half-translated document, which is what the reader keeps.
  {
    const realCreate = window.URL.createObjectURL
    const realGlobalUrl = globalThis.URL
    const realClick = window.HTMLAnchorElement.prototype.click
    globalThis.URL = window.URL
    const files = []
    window.URL.createObjectURL = (blob) => { files.push(blob); return 'blob:stub' }
    window.HTMLAnchorElement.prototype.click = function noop() {}
    const fileButton = [...fullHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === 'File')
    assert.ok(fileButton, 'the file menu is translated')
    await act(async () => {
      fileButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const entry = [...fullHost.querySelectorAll('.ap-menu-pop button')].find((node) => /HTML/.test(node.textContent))
    assert.ok(entry, 'the file menu offers the HTML export in English')
    await act(async () => {
      entry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    window.URL.createObjectURL = realCreate
    globalThis.URL = realGlobalUrl
    window.HTMLAnchorElement.prototype.click = realClick
    assert.equal(files.length, 1, 'the english export produced a file')
    const html = await files[0].text()
    assert.match(html, /<title>PSPP Output<\/title>/, `the exported title follows the language: ${html.slice(0, 80)}`)
    assert.doesNotMatch(html, /PSPP 输出/, 'the exported title is not left in Chinese')
    // The per-table source line is built from interpolated pieces: a raw label
    // inside the template stayed Chinese while Word/Excel said "New dataset".
    const sourceLines = [...html.matchAll(/<p class="ap-export-source">([^<]*)<\/p>/g)].map((m) => m[1])
    assert.ok(sourceLines.some((line) => line.includes('New dataset')),
      `the source line names a built dataset in English: ${sourceLines.join(' | ').slice(0, 200)}`)
    assert.doesNotMatch(html, /新建数据集/, 'the source line is not left in Chinese')
  }
  await act(async () => { fullRoot.unmount() })
  console.log('ok  the rendered english panel has no chinese text left in it')
}

// Saving the language in the settings page has to show up at once. Waiting for
// the next heartbeat made the switch take 3.5 s, which the verifier called out.
{
  const dict = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8')).strings
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const langRoot = createRoot(host)
  const emptyState = {
    id: 'session-lang',
    version: '0.32.2',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: null,
    items: [],
    importNotes: [],
    log: [],
    mrSets: [],
    splitBy: [],
    history: { undo: 0, redo: 0 },
    tableStyle: 'three-line',
    maxRows: null,
    maxExportRows: null,
    locale: 'zh',
    signal: { id: 'session-lang', items: 0 },
  }
  window.fetch = async (url) => {
    const target = String(url)
    if (target.includes('api/locale')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, locale: 'en', strings: dict }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: emptyState }) }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    langRoot.render(React.createElement(registered.tabs[0].component, { ...props, scope: { sessionId: 'session-lang', cwd: '/tmp' }, tab: null }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
  assert.match(host.textContent, /尚未打开数据集/, 'the panel starts in chinese')
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('ap:locale', { detail: 'en' }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  assert.match(host.textContent, /No dataset open/, 'the panel switches as soon as the setting is saved')
  await act(async () => { langRoot.unmount() })
  console.log('ok  the language announced by the settings page is adopted without waiting for the heartbeat')
}

// 回归对话框：置信区间水平要跟着关键字走，系数相关性矩阵要有独立开关。
{
  const specs = hooks.ANALYSIS_SPECS
  assert.ok(specs?.regression?.build, 'the regression spec is exported for the panel tests')
  const base = { dep: 'score', ind: ['age'] }
  const plain = specs.regression.build(base, { statistics: { r: true, coeff: true, anova: true, ci: true } })
  assert.match(plain.syntax, /\/STATISTICS=.*CI\(95\)/, 'the interval defaults to 95%')
  const wide = specs.regression.build(base, { statistics: { ci: true }, options: { ciLevel: '99' } })
  assert.match(wide.syntax, /CI\(99\)/, 'the chosen level travels with CI')
  const bcov = specs.regression.build(base, { statistics: { r: true, bcov: true } })
  assert.match(bcov.syntax, /\/STATISTICS=.*BCOV/, 'the coefficient correlation matrix can be asked for')
  const noCi = specs.regression.build(base, { statistics: { r: true, ci: false } })
  assert.ok(!/CI/.test(noCi.syntax), 'turning the interval off leaves no CI keyword')
  console.log('ok  the regression dialog carries the interval level and the coefficient matrix')
}

// 中位数检验：PSPP 认这条语法（0.68.0 探过），所以对话框只负责拼对格式。
{
  const specs = hooks.ANALYSIS_SPECS
  assert.ok(specs?.nparMedian?.build, 'the median test dialog exists')
  const built = specs.nparMedian.build({ variable: 'score', by: 'group', range: ' 1 3 ' })
  assert.equal(built.syntax, 'NPAR TESTS /MEDIAN=score BY group(1 3).', `unexpected median syntax: ${built.syntax}`)
  assert.ok(built.hint && built.hint.length > 10, 'the dialog explains what the test asks')
  console.log('ok  the median test dialog writes NPAR TESTS /MEDIAN=')
}

// P-P / Q-Q：SPSS 用 EXAMINE 的图选项，PSPP 只给检验表，所以对话框直接交图模型。
{
  const specs = hooks.CHART_SPECS
  assert.ok(specs?.ppplot?.build, 'the probability plot dialog exists')
  assert.deepEqual(
    specs.ppplot.build({ variable: 'score', plot: 'qq' }),
    { chart: { kind: 'ppplot', variable: 'score', plot: 'qq' } },
    'it hands the chart model to the host instead of syntax',
  )
  assert.equal(specs.ppplot.build({ variable: 'score' }).chart.plot, 'pp', 'P-P is the default')
  console.log('ok  the probability plot dialog sends a chart model, not syntax')
}

// 频率对话框的四种图、散点图的拟合线：都只交给宿主，不拼额外语法。
{
  const specs = hooks.ANALYSIS_SPECS
  const pie = specs.frequencies.build({ vars: ['score'] }, { statistics: {}, charts: { pie: true } })
  assert.equal(pie.syntax, 'FREQUENCIES /VARIABLES=score /PIECHART.', pie.syntax)
  const normal = specs.frequencies.build({ vars: ['score'] }, { statistics: {}, charts: { histNormal: true, histogram: true } })
  assert.equal(normal.syntax, 'FREQUENCIES /VARIABLES=score /HISTOGRAM NORMAL.', 'the curve already implies a histogram, so it is asked for once')
  const chartSpecs = hooks.CHART_SPECS
  const fit = chartSpecs.scatterplot.build({ x: 'age', y: 'score' }, { scatterOptions: { fit: true } })
  assert.equal(fit.chart.fit, 'linear', 'the fit checkbox travels with the chart request')
  assert.equal(chartSpecs.scatterplot.build({ x: 'age', y: 'score' }, {}).chart.fit, undefined, 'and nothing is asked for by default')
  console.log('ok  the frequency charts and the scatter fit line are wired to the request')
}

// 图表对话框的包装器必须把 variables 传到 spec：0.65.0 起条形图靠它判断
// 文本变量，两个实参就会对分类变量发 MEAN，引擎 400（Win10 0660 报告的 P1）。
{
  const build = hooks.buildChartRequest
  assert.ok(build, 'the chart request wrapper is exported for the panel tests')
  const variables = [
    { name: 'gender', type: 'string', label: '性别' },
    { name: 'score', type: 'numeric', label: '得分' },
  ]
  const textual = build(hooks.CHART_SPECS.bar, { variable: 'gender' }, {}, variables)
  assert.equal(textual.chart.statistic, 'COUNT', 'a text variable is counted, not averaged')
  const percent = build(hooks.CHART_SPECS.bar, { variable: 'gender' }, { barOptions: { percent: true } }, variables)
  assert.equal(percent.chart.percent, true, 'and the percent option survives the wrapper')
  const numeric = build(hooks.CHART_SPECS.bar, { variable: 'score' }, {}, variables)
  assert.equal(numeric.chart.statistic, 'MEAN', 'a numeric variable is still averaged')
  assert.equal(textual.chart.tableId, null, 'the table id defaults to null')
  assert.equal(build(hooks.CHART_SPECS.bar, { variable: 'score', tableId: 'run-1-0' }, {}, variables).chart.tableId, 'run-1-0', 'and travels when chosen')
  // 生存分析：对话框交时间、事件指示与可选分组，曲线与 log-rank 在插件里算。
  const km = build(hooks.CHART_SPECS.km, { time: 'score', event: 'gender', group: 'gender' }, {}, variables)
  assert.equal(km.chart.kind, 'km', 'the dialog asks for a survival model')
  assert.equal(km.chart.time, 'score')
  assert.equal(km.chart.event, 'gender')
  assert.equal(km.chart.group, 'gender')
  assert.equal(build(hooks.CHART_SPECS.km, { time: 'score', event: 'gender', group: '' }, {}, variables).chart.group, null, 'no grouping means one curve')
  // 控制图：对话框只交变量、子组变量与子组大小，限值与越界判断在图模型里。
  const control = build(hooks.CHART_SPECS.control, { variable: 'score', subgroup: 'gender', size: '4' }, {}, variables)
  assert.equal(control.chart.kind, 'control', 'the dialog asks for a control-chart model')
  assert.equal(control.chart.size, 4, 'the subgroup size travels as a number')
  assert.equal(control.chart.subgroup, 'gender', 'and so does the subgroup variable')
  assert.equal(build(hooks.CHART_SPECS.control, { variable: 'score', subgroup: '' }, {}, variables).chart.subgroup, null, 'an empty subgroup choice means "split by order"')
  // 帕累托图：对话框只发类别变量与两个选项，计数与排序在图表模型里做。
  const pareto = build(hooks.CHART_SPECS.pareto, { variable: 'score', reference: '90', maxCategories: '3' }, {}, variables)
  assert.equal(pareto.chart.kind, 'pareto', 'the pareto dialog asks for a pareto model')
  assert.equal(pareto.chart.reference, 90, 'the reference line travels as a number')
  assert.equal(pareto.chart.maxCategories, 3, 'and so does the category cap')
  assert.equal(build(hooks.CHART_SPECS.pareto, { variable: 'score' }, {}, variables).chart.reference, 80, 'the default reference is 80%')
  // 每个图型都必须是扁平的：宿主拿 body.options 当参数，再套一层 options 就
  // 只剩外壳，变量全是 undefined（Win10 0740 的 P1-4，km/control/pareto 三处）。
  for (const [name, spec] of Object.entries(hooks.CHART_SPECS)) {
    const built = spec.build({ variable: 'score', time: 'score', event: 'gender', plot: 'qq' }, {})
    assert.ok(built?.chart, `${name} builds a chart request`)
    assert.ok(!('options' in built.chart), `${name} must not nest its options`)
  }
  // 字符串分组要加引号，否则 PSPP 把 grp(A B) 当数值范围（P1-3）。
  const stringMedian = hooks.ANALYSIS_SPECS.nparMedian.build(
    { variable: 'score', by: 'group', range: 'A B' }, {}, [{ name: 'group', type: 'string' }],
  )
  assert.equal(stringMedian.syntax, "NPAR TESTS /MEDIAN=score BY group('A' 'B').", stringMedian.syntax)
  const numericMedian = hooks.ANALYSIS_SPECS.nparMedian.build(
    { variable: 'score', by: 'group', range: '1 3' }, {}, [{ name: 'group', type: 'numeric' }],
  )
  assert.equal(numericMedian.syntax, 'NPAR TESTS /MEDIAN=score BY group(1 3).', numericMedian.syntax)
  // 同一族的另外两个非参数检验曾漏掉同一个引号规则（Win10 0820 的 P2-1），
  // 现在三者共用 groupRangeCodes，所以一起钉住。
  for (const [name, command] of [['nparKruskal', 'KRUSKAL-WALLIS'], ['nparJonckheere', 'JONCKHEERE-TERPSTRA']]) {
    const quoted = hooks.ANALYSIS_SPECS[name].build(
      { variable: 'score', by: 'group', range: 'A B' }, {}, [{ name: 'group', type: 'string' }],
    )
    assert.equal(quoted.syntax, `NPAR TESTS /${command}=score BY group('A' 'B').`, `${name}: ${quoted.syntax}`)
    const plain = hooks.ANALYSIS_SPECS[name].build(
      { variable: 'score', by: 'group', range: '1 3' }, {}, [{ name: 'group', type: 'numeric' }],
    )
    assert.equal(plain.syntax, `NPAR TESTS /${command}=score BY group(1 3).`, `${name}: ${plain.syntax}`)
  }
  // 调用点本身也要守住：包装器修好而 ChartDialog 又只传两个实参，等于白修。
  assert.match(
    clientSource,
    /build: \(values, flags, variables\) => buildChartRequest\(spec, values, flags, variables\)/,
    'ChartDialog hands the variables to the wrapper',
  )
  console.log('ok  the chart wrapper passes variables through, so text variables are counted')
}

// 转置：FLIP 引擎支持（探过），所以对话框只负责拼对语法并标记持久化。
{
  const spec = hooks.ANALYSIS_SPECS.transpose
  assert.ok(spec?.build, 'the transpose dialog exists')
  const plain = spec.build({ vars: ['a', 'b'] })
  assert.equal(plain.syntax, 'FLIP VARIABLES=a b.', plain.syntax)
  assert.equal(plain.persist, true, 'the flip replaces the dataset, so it has to persist')
  assert.equal(spec.build({ vars: ['a', 'b'], newNames: 'k' }).syntax, 'FLIP VARIABLES=a b /NEWNAMES=k.', 'a name variable picks the new column names')
  console.log('ok  the transpose dialog writes FLIP and persists the result')
}

// 缺失值分析 / 替换缺失值：两个对话框都不产出语法（引擎没有 MVA 与 RMV），
// 它们交给宿主算，所以这里断言的是交给谁、带什么参数。
{
  const specs = hooks.ANALYSIS_SPECS
  assert.ok(specs?.missing?.build, 'the missing-value dialog exists')
  const analysed = specs.missing.build({ variables: ['age', 'score'] }, { tables: { univariate: true, patterns: false } })
  assert.deepEqual(analysed, { missing: { variables: ['age', 'score'], univariate: true, patterns: false } })
  const defaults = specs.missing.build({ variables: ['age'] }, undefined)
  assert.deepEqual(defaults.missing, { variables: ['age'], univariate: true, patterns: true }, 'both tables are on by default')
  const filled = specs.replaceMissing.build({ variables: ['score'] }, { method: { method: 'linear' } })
  assert.deepEqual(filled, { missing: { mode: 'replace', variables: ['score'], method: 'linear' } })
  assert.equal(specs.replaceMissing.fields[0].accept, 'numeric', 'the replace dialog only offers numeric variables')
  const fallback = specs.replaceMissing.build({ variables: ['score'] }, undefined)
  assert.equal(fallback.missing.method, 'mean', 'the method falls back to the series mean')
  const options = specs.replaceMissing.groups[0].items[0].options.map((entry) => entry[1])
  assert.deepEqual(options, ['序列平均值', '临近点的平均值', '临近点的中位数', '线性插值', '线性趋势处的点'],
    'the five methods carry the SPSS names')
  const nearby = specs.replaceMissing.build({ variables: ['score'] }, { method: { method: 'nearbyMedian', span: '3' } })
  assert.deepEqual(nearby.missing, { mode: 'replace', variables: ['score'], method: 'nearbyMedian', span: 3 },
    'the nearby methods carry the span, and it travels as a number')
  // 面板一打开就带默认方法：flags 若是把所有项都当复选框，method 会变 false，
  // 默认路径的请求体就成了 {"method":"false"}，宿主 400（Win10 0740 的 P1-1）。
  const dialogDefaults = hooks.freshDialogFlags(specs.replaceMissing)
  assert.equal(dialogDefaults.method.method, 'mean', `the select keeps its own default, got ${JSON.stringify(dialogDefaults)}`)
  assert.equal(dialogDefaults.method.span, 2, 'and the number keeps its own default')
  const checkboxSpec = hooks.ANALYSIS_SPECS.frequencies
  const boxDefaults = hooks.freshDialogFlags(checkboxSpec)
  assert.equal(boxDefaults.charts.pie, false, 'a checkbox still starts off unless it says otherwise')
  // 数字项必须是 number 输入框，不是复选框（P1-2：span 只能 0/1，永远拿不到 2）。
  assert.match(clientSource, /item\.kind === 'number'/, 'the dialog has a number branch')
  assert.match(clientSource, /type: 'number'/, 'and renders a number input')
  assert.equal(specs.replaceMissing.groups[0].items[1].kind, 'number', 'the span field is declared as a number')
  const mean = specs.replaceMissing.build({ variables: ['score'] }, { method: { method: 'mean', span: '3' } })
  assert.ok(!('span' in mean.missing), 'the series mean ignores the span instead of resending it')
  console.log('ok  the missing-value dialogs hand the work to the host, not the engine')
}

// 排秩的秩类型与「描述」的标准化值（0.37.0）：PSPP 的 RANK 有八种，名字不能拍脑袋写。
{
  const specs = hooks.ANALYSIS_SPECS
  const rank = specs.rank
  const defaultRank = rank.build({ variable: 'x' }, null)
  assert.equal(defaultRank.syntax, 'RANK VARIABLES=x /RANK INTO r_x /TIES=MEAN.')
  assert.equal(defaultRank.persist, true)
  const many = rank.build({ variable: 'x', target: '' }, {
    types: { rank: true, percent: true, normal: true, ntiles: '4' },
    ties: { mean: true },
  })
  assert.equal(many.syntax, 'RANK VARIABLES=x /RANK INTO r_x /PERCENT INTO p_x /NORMAL INTO z_x /NTILES(4) INTO q_x /TIES=MEAN.')
  assert.equal(rank.build({ variable: 'x' }, { types: { rank: false } }).error, '至少勾一种秩类型')

  const desc = specs.descriptives
  const withSave = desc.build({ vars: ['x'] }, { statistics: { mean: true, std: true, save: true } })
  assert.match(withSave.syntax, /DESCRIPTIVES \/VARIABLES=x \/STATISTICS=MEAN STDDEV \/SAVE\.$/)
  assert.equal(withSave.persist, true, 'saving Z scores writes the data file, so the run must persist')
  const plain = desc.build({ vars: ['x'] }, { statistics: { mean: true } })
  assert.equal(plain.persist, false, 'nothing is written back when the box is off')
  assert.equal(/SAVE/.test(plain.syntax), false, 'no save keyword unless the box is ticked')
  console.log('ok  the rank dialog offers every type, and descriptives can save Z scores')
}

// 标识重复个案：对话框只挑键变量，指示变量默认打开（0.40.0）。
{
  const spec = hooks.ANALYSIS_SPECS.duplicates
  const plain = spec.build({ variables: ['id', 'score'] }, { options: { indicators: true } })
  assert.deepEqual(plain.duplicates.variables, ['id', 'score'])
  assert.equal(plain.duplicates.indicators, true)
  assert.equal(plain.syntax, undefined, 'nothing goes to the engine: PSPP has no duplicate command')
  const off = spec.build({ variables: [] }, { options: { indicators: false } })
  assert.deepEqual(off.duplicates.variables, [], 'no key variables means every variable')
  assert.equal(off.duplicates.indicators, false)
  console.log('ok  the duplicate dialog sends key variables only, with the indicators on by default')
}

// 标识异常个案：对话框要能把百分位带传到宿主（0.41.0）。
{
  const spec = hooks.ANALYSIS_SPECS.outliers
  const plain = spec.build({ variables: ['score'] }, { options: { percentiles: '5,95', indicators: true } })
  assert.deepEqual(plain.outliers, { variables: ['score'], percentiles: [5, 95], indicators: true })
  assert.equal(plain.syntax, undefined, 'nothing goes to the engine: PSPP has no unusual-case command')
  const wide = spec.build({ variables: [] }, { options: { percentiles: '1,99', indicators: false } })
  assert.deepEqual(wide.outliers.percentiles, [1, 99], 'the picked band reaches the host as two numbers')
  assert.deepEqual(wide.outliers.variables, [], 'no variables means every numeric one')
  assert.equal(wide.outliers.indicators, false)
  const fallback = spec.build({ variables: ['score'] }, undefined)
  assert.deepEqual(fallback.outliers.percentiles, [5, 95], 'the default band is 5 to 95')
  console.log('ok  the outlier dialog carries the percentile band, and the indicators default off')
}

// GLM 的事后检验：面板要能选，构建时走 ONEWAY 那条线（0.38.0）。
{
  const glm = hooks.ANALYSIS_SPECS.glm
  const plain = glm.build({ vars: ['score'], by: 'g' }, undefined)
  assert.equal(plain.syntax, 'GLM score BY g /DESIGN=g.')
  assert.deepEqual(plain.pairwise, { group: 'g', variables: ['score'] })
  const tukey = glm.build({ vars: ['score'], by: 'g' }, { options: { posthoc: 'TUKEY' } })
  assert.equal(tukey.syntax, 'GLM score BY g /DESIGN=g.\nONEWAY score BY g /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=TUKEY ALPHA(0.05).')
  assert.match(tukey.pairwise.group, /^g$/, 'the pairwise hint survives the extra statement')
  const off = glm.build({ vars: ['score'], by: 'g' }, { options: { posthoc: '0' } })
  assert.equal(off.syntax.includes('ONEWAY'), false, 'picking 不做 leaves GLM alone')
  console.log('ok  the GLM dialog can ask for post-hoc, and it goes through ONEWAY')
  // 对比系数：面板里是一个文本框，解析规则与工具侧一致（0.43.0）。
  const one = glm.build({ vars: ['score'], by: 'g' }, { options: { contrasts: '2 -1 -1' } })
  assert.equal(one.syntax, 'GLM score BY g /DESIGN=g.\nONEWAY score BY g /CONTRAST=2 -1 -1.')
  const both = glm.build({ vars: ['score'], by: 'g' }, { options: { posthoc: 'LSD', contrasts: '2 -1 -1; 0 1 -1' } })
  assert.equal(
    both.syntax,
    'GLM score BY g /DESIGN=g.\nONEWAY score BY g /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=LSD ALPHA(0.05) /CONTRAST=2 -1 -1 /CONTRAST=0 1 -1.',
  )
  assert.deepEqual(hooks.parseContrasts('2 -1 -1; 0,1,-1'), { list: [[2, -1, -1], [0, 1, -1]] })
  assert.deepEqual(hooks.parseContrasts('  '), { list: [] })
  assert.match(hooks.parseContrasts('2 x -1').error, /要是数字/)
  assert.match(hooks.parseContrasts('2 -1; 0 1 -1').error, /系数个数要一样/)
  assert.match(glm.build({ vars: ['score'], by: 'g' }, { options: { contrasts: '2' } }).error, /至少要两个系数/)
  console.log('ok  the GLM contrast box parses coefficients the same way the tool does')
}

// 探索：一个 EXAMINE 列多个变量时，PSPP 2.1.3 只给第一个变量做正态性检验（0.54.8）。
{
  const examine = hooks.ANALYSIS_SPECS.explore
  const built = examine.build({ vars: ['a', 'b'], by: '' }, { options: {} })
  assert.equal(built.syntax, 'EXAMINE a /PLOT=BOXPLOT.\nEXAMINE b /PLOT=BOXPLOT.')
  console.log('ok  the explore dialog gives each variable its own EXAMINE')
}

// 双因子 GLM：对比必须按因子写，交给宿主算；单因子仍旧走 ONEWAY（0.48.0）。
{
  const glm = hooks.ANALYSIS_SPECS.glm
  const single = glm.build({ vars: ['y'], by: 'a' }, { options: { contrasts: '2 -1 -1', posthoc: '0' } })
  assert.match(single.syntax, /ONEWAY y BY a \/CONTRAST=2 -1 -1\.$/)
  assert.equal(single.contrasts, undefined, 'the single factor path leaves the numbers to the engine')
  const both = glm.build({ vars: ['y'], by: 'a', by2: 'b' }, { options: { contrasts: 'a = 2 -1 -1; b = 0 0 1', posthoc: '0' } })
  assert.equal(both.syntax, 'GLM y BY a b /DESIGN=a b a*b.')
  assert.deepEqual(both.contrasts?.factors, ['a', 'b'])
  assert.deepEqual(both.contrasts?.hypotheses?.map((entry) => entry.term), [
    { factor: 'a', coefficients: [2, -1, -1] },
    { factor: 'b', coefficients: [0, 0, 1] },
  ])
  // A post-hoc with two factors has no engine path at all.
  const refused = glm.build({ vars: ['y'], by: 'a', by2: 'b' }, { options: { posthoc: 'TUKEY' } })
  assert.match(String(refused.error), /双因子模型没有引擎事后检验/)
  // Coefficients written without a factor name are ambiguous here, not silently
  // applied to the wrong factor.
  const vague = glm.build({ vars: ['y'], by: 'a', by2: 'b' }, { options: { contrasts: '2 -1 -1' } })
  assert.match(String(vague.error), /因子 = 系数/)
  console.log('ok  a two-factor GLM sends its contrast terms instead of guessing')
}

// 回归的影响诊断是插件算的，所以面板必须把开关带进 regression 提示（0.44.0）。
{
  const regression = hooks.ANALYSIS_SPECS.regression
  const plain = regression.build({ dep: 'y', ind: ['x1'] }, { statistics: { r: true, coeff: true, anova: true, ci: true, tol: true } })
  assert.equal(plain.regression.influence, false, 'the influence table is opt-in')
  const wanted = regression.build({ dep: 'y', ind: ['x1'] }, { statistics: { tol: false, influence: true } })
  assert.equal(wanted.regression.influence, true)
  assert.deepEqual(wanted.regression.independents, ['x1'])
  const only = regression.build({ dep: 'y', ind: ['x1'] }, { statistics: { tol: false, influence: true } })
  assert.notEqual(only.regression, null, 'influence alone still needs the hint, even with tolerance off')
  console.log('ok  the regression dialog carries the influence switch next to the syntax')
}

// The preset notice is one whole sentence, so it needs a whole-key entry in the
// English dictionary; the substring rule alone would leave it Chinese.
{
  const dict = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8')).strings
  const notice = '本会话没有启用「统计分析」预设：智能体看不到 pspp_* 工具，但面板本身仍可直接操作数据。新建会话时选「统计分析」预设即可同时启用工具。'
  hooks.setDictionary(dict)
  assert.match(hooks.tr(notice), /not using the Statistics preset/, 'the notice has an English sentence')
  assert.equal(hooks.tr(notice).includes('统计分析'), false, 'and no Chinese is left in it')
  assert.equal(hooks.tr('不再提示'), "Don't show again", 'the dismiss button is translated too')
  hooks.setDictionary(null)
  console.log('ok  the preset notice and its dismiss button are in the English dictionary')
}

// 左栏的全局面板没有会话来继承（0.50.1）：它必须自己去认已经打开的数据集，
// 否则会话里明明有数据，面板却停在一个空文档上、看起来像另一套数据。
{
  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = createRoot(host)
  const posts = []
  const state = {
    id: 'session-recent',
    version: '0.50.1',
    engine: { source: 'bundled', bin: '/engine/pspp' },
    locale: 'zh',
    tableStyle: 'three-line',
    dataset: {
      name: 'sixty.sav',
      sourcePath: '/tmp/sixty.sav',
      caseCount: 60,
      variables: [{ name: 'age', label: '年龄' }],
    },
    items: [],
    log: [],
  }
  window.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null
    posts.push({ url: String(url), body })
    if (String(url).includes('api/workspaces')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          result: {
            workspaces: [
              { docId: 'session-recent', name: 'sixty.sav', caseCount: 60, dirty: false },
              { docId: 'session-older', name: 'extra.sav', caseCount: 6, dirty: true },
            ],
          },
        }),
      }
    }
    if (String(url).includes('api/heartbeat')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, signal: {} }) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state }) }
  }
  globalThis.fetch = window.fetch
  console.log('   before render')
  await act(async () => {
    root.render(React.createElement(registered.main[0].component))
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  console.log('   after render')
  assert.ok(posts.some((call) => call.url.includes('api/workspaces')), 'the launcher asks what is already open')
  // The first state read happens before the answer arrives (there is nothing to
  // ask about yet); the adoption has to re-read with the dataset it chose.
  const stateCalls = posts.filter((call) => call.url.includes('api/state'))
  assert.match(String(stateCalls.at(-1)?.url), /sessionId=session-recent/, 'it opens the most recently used dataset')
  const titles = [...host.querySelectorAll('.ap-doctab-title')].map((node) => node.textContent)
  assert.deepEqual(titles, ['sixty.sav', 'extra.sav'], 'every open dataset is listed, newest first')
  assert.ok(host.textContent.includes('sixty.sav'), 'the adopted dataset is the one on screen')
  await act(async () => { root.unmount() })
  host.remove()
  // A note can be built around a value: `${head}：不可估（${reason}）`. The wrapper
  // is a template key and the reason is its own key, so the capture has to be
  // translated too - without that the English panel shows a half-Chinese note.
  {
    // The English panel gets its dictionary from api/locale; here the real file is
    // loaded instead of the two-string stub some fixtures use.
    const dictionary = JSON.parse(readFileSync(join(here, '..', 'locale/en.json'), 'utf8')).strings
    hooks.setDictionary(dictionary)
    // A capture is user data: 保存/总计 are dictionary keys, and recursing into
    // them renamed a variable called 保存 to "Save" in the English panel.
    assert.equal(hooks.tr('保存 的直方图'), 'Histogram of 保存', 'a variable name is not translated')
    assert.equal(hooks.tr('总计 · 5 例 · 1 变量'), '总计 · 5 cases · 1 variables', 'a dataset name is not translated')
    assert.equal(hooks.tr('注：分层变量：甲（共 3 层：0.013）'), 'Note: 分层变量：甲（共 3 层：0.013）', 'a note body stays as written')
    const note = 'A − B：不可估（该对比在数据里没有对应的自由度，通常是某一格没有观测）'
    const english = hooks.tr(note)
    assert.match(english, /^A − B: not estimable \(/, `a composed note translates whole: ${english}`)
    assert.doesNotMatch(english, /[\u4e00-\u9fff]/, `no Chinese is left in the composed note: ${english}`)
    assert.equal(hooks.tr(note), english, 'the note translates the same way twice')
    hooks.setDictionary(null)
    console.log('ok  a note composed around a value translates both halves')
  }

  console.log('ok  the left panel adopts the dataset that is already open')
}

// 两个窗口可以同时显示同一个工作区（左栏那行和会话页签指向同一个 docId）。
// 判断「这一份是不是别人刚改的」必须是一个能单测的纯函数，否则只能靠肉眼。
{
  const notice = hooks.foreignWriteNotice
  const self = 'panel-me'
  assert.equal(
    notice({ revision: 4 }, { revision: 5, lastWriter: 'panel-other' }, self),
    '数据已被另一个窗口修改：已载入最新内容，正在编辑的格子请重新确认',
  )
  assert.equal(notice(null, { revision: 5, lastWriter: 'panel-other' }, self), null, 'the first state is the baseline')
  assert.equal(notice({ revision: 4 }, { revision: 5, lastWriter: self }, self), null, 'my own write is not news')
  assert.equal(notice({ revision: 5 }, { revision: 5, lastWriter: 'panel-other' }, self), null, 'an unchanged revision is not news')
  assert.equal(
    notice({ revision: 4 }, { revision: 5, lastWriter: null }, self),
    '数据已被对话里的分析改写：已载入最新内容',
    'a write with no name is a tool call, and it still gets said out loud',
  )
  assert.equal(notice({ revision: 4 }, { revision: 5 }, self), '数据已被对话里的分析改写：已载入最新内容', 'a host without lastWriter is treated the same way')
  console.log('ok  a write from another window is announced, a self-write and the first state are not')
}

// The syntax workbench and the bound report are the two features of 0.57.0.
// Both live behind the 文件 menu, and the toolbar tip is the one place where the
// delay is a behaviour rather than a style, so it is asserted with timers.
{
  const workHost = window.document.createElement('div')
  window.document.body.appendChild(workHost)
  const workRoot = createRoot(workHost)
  const calls = []
  const workState = {
    id: 'session-work',
    version: '0.57.0',
    engine: { source: 'bundled', bin: '/tmp/pspp', bundled: true },
    dataset: {
      sourcePath: '/tmp/work.sav', name: 'work.sav', caseCount: 30, varCount: 2, dirty: false, origin: 'file',
      variables: [
        { name: 'score', label: '成绩', type: 'numeric', measure: 'scale' },
        { name: 'gender', label: '性别', type: 'numeric', measure: 'nominal' },
      ],
    },
    locale: 'zh',
    variables: [
      { name: 'score', label: '成绩', type: 'numeric', measure: 'scale' },
      { name: 'gender', label: '性别', type: 'numeric', measure: 'nominal' },
    ],
    items: [{
      kind: 'table', id: 'item-1', runId: 1, title: '频率',
      script: 'FREQUENCIES /VARIABLES=score.',
      table: { caption: 'score', matrix: [['', 'N'], ['score', '30']] },
      notes: [],
    }, {
      // A chart is an output without a script: it is drawn from data.
      kind: 'image', id: 'chart-1-0', runId: 1, title: 'score 的直方图',
      artifactUrl: '/analytics/api/artifact?runId=1&name=chart.svg', alt: 'score 的直方图',
    }],
    tables: [], charts: [],
    splitBy: [], weightBy: null, filterBy: null, selectIf: null,
    settings: { tableStyle: 'three-line', maxRows: 200000 },
    tableStyle: 'three-line',
    runs: [{ runId: 1, title: '频率', at: Date.now() }],
    task: null,
  }
  window.fetch = async (url, options) => {
    calls.push(String(url))
    const body = options?.body ? JSON.parse(String(options.body)) : null
    if (String(url).includes('api/previewImport')) {
      // The route answers what the file would become; the stub answers with the
      // options it was given, which is what the wizard must round-trip.
      globalThis.__previewBody = body
      const options = body?.options ?? {}
      const names = options.names ?? ['V1', 'V2']
      const types = options.types ?? ['numeric', 'string']
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          result: {
            path: body?.path,
            kind: 'delimited',
            encoding: options.encoding ?? 'auto',
            delimiter: options.delimiter ?? ',',
            hasHeader: options.hasHeader !== false,
            skipRows: options.skipRows ?? 0,
            sheet: null,
            sheets: [],
            totalRows: 2,
            columns: names.map((name, index) => ({ name, label: index === 0 ? '年龄' : '性别', type: types[index] ?? 'numeric', width: 12, missing: [] })),
            rows: [[21, '男'], [34, '女']],
            notes: ['第 1 列的表头「年龄」没有可用的 ASCII 字符，变量名改为「V1」，原表头保留为标签'],
          },
        }),
      }
    }
    if (String(url).includes('api/chart/redraw')) {
      globalThis.__redrawBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { runId: 11, redrawnFrom: body?.runId }, state: workState }) }
    }
    if (String(url).includes('api/chart/export')) {
      globalThis.__chartExportBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { path: body?.path, bytes: 4096 } }) }
    }
    if (String(url).includes('api/chartGrid')) {
      globalThis.__gridBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { runId: 9, charts: body?.items?.length ?? 0, layout: body?.layout }, state: workState }) }
    }
    if (String(url).includes('api/chart/options')) {
      globalThis.__chartOptionsBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: {
        runId: Number(body?.runId),
        title: 'score 的直方图',
        subtitle: 'N = 30',
        xLabel: '得分',
        yLabel: '',
        accent: '#2f6fbb',
        sortCategories: 'none',
      } }) }
    }
    if (String(url).includes('api/chart/update')) {
      globalThis.__chartPatchBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: workState }) }
    }
    if (String(url).includes('api/variable')) {
      globalThis.__variableBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: workState }) }
    }
    if (String(url).includes('api/reportBook')) {
      globalThis.__lastBookBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { path: body?.path, format: 'docx', bytes: 4096, tables: 1, figures: 0 } }) }
    }
    if (String(url).includes('api/dir')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, path: decodeURIComponent(String(url).split('path=')[1] ?? ''), entries: [], pick: null }) }
    }
    if (String(url).includes('api/open')) {
      globalThis.__openBody = body
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { kind: 'dataset', caseCount: 2 }, state: workState }) }
    }
    if (String(url).includes('api/heartbeat')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, signal: workState.signal }) }
    }
    if (String(url).includes('api/run')) {
      globalThis.__workRunBody = body
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { runId: 7, items: [] }, state: workState }),
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, state: workState }) }
  }
  globalThis.fetch = window.fetch
  await act(async () => {
    workRoot.render(React.createElement(registered.tabs[0].component, {
      ...props, scope: { sessionId: 'session-work', cwd: '/tmp' }, tab: null,
    }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  })

  const openMenu = async (label) => {
    const button = [...workHost.querySelectorAll('.ap-menu-button')].find((node) => node.textContent === label)
    assert.ok(button, `the ${label} menu exists`)
    await act(async () => {
      button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    return workHost.querySelector('.ap-menu-pop')
  }
  const clickIn = async (root, text) => {
    // A template button carries its label and the first line of its syntax, so
    // the match is on the leading text rather than the whole button.
    const target = [...root.querySelectorAll('button')]
      .find((node) => node.textContent === text || node.textContent.startsWith(text))
    assert.ok(target, `a button labelled ${text} is there: ${root.textContent.slice(0, 200)}`)
    await act(async () => {
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    return target
  }

  // 文件 → 语法模板库: clicking a template appends it to the syntax tab.
  let pop = await openMenu('文件')
  const labels = [...pop.querySelectorAll('button')].map((node) => node.textContent)
  assert.ok(labels.includes('语法模板库…'), `the file menu offers the template library: ${labels.join(' / ')}`)
  assert.ok(labels.includes('运行历史…'), 'and the run history')
  assert.ok(labels.includes('导出报告（成册，勾选的表）…'), 'and the bound report')
  await clickIn(pop, '语法模板库…')
  const tmpl = workHost.querySelector('.ap-modal')
  assert.match(tmpl.textContent, /描述/, 'the library is grouped like an analysis menu')
  await clickIn(tmpl, '交叉表 + 卡方')
  const editor = workHost.querySelector('.ap-code-input')
  assert.ok(editor, 'the syntax tab has its editor')
  assert.match(editor.value, /CROSSTABS[\s\S]*CHISQ/, `the template landed in the editor: ${editor.value}`)
  // Appending, not replacing: a second click keeps the first program.
  pop = await openMenu('文件')
  await clickIn(pop, '语法模板库…')
  await clickIn(workHost.querySelector('.ap-modal'), '频率与集中趋势')
  assert.match(workHost.querySelector('.ap-code-input').value, /CROSSTABS/, 'the first template survives the second one')
  assert.match(workHost.querySelector('.ap-code-input').value, /FREQUENCIES/, 'and the second one is appended after it')

  // 文件 → 运行历史: a run made in the panel can be pasted back or replayed.
  const runButton = [...workHost.querySelectorAll('.ap-icon-btn')].find((node) => node.getAttribute('title') === '运行语法' || node.getAttribute('aria-label') === '运行语法')
  assert.ok(runButton, 'the toolbar has a run button')
  await act(async () => {
    runButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
  assert.match(String(globalThis.__workRunBody?.syntax ?? ''), /CROSSTABS/, 'the editor content is what ran')
  pop = await openMenu('文件')
  await clickIn(pop, '运行历史…')
  const runs = workHost.querySelector('.ap-modal')
  assert.match(runs.textContent, /运行 7/, 'the history lists the run by its id')
  assert.match(runs.textContent, /CROSSTABS/, 'and keeps the syntax that ran')
  await clickIn(runs, '插入语法')
  assert.match(workHost.querySelector('.ap-code-input').value, /^CROSSTABS/, 'inserting a run replaces the editor with that run')
  // The history survives a reload: it is the only copy of a script the user did
  // not save, so it has to be on disk-ish storage rather than in React state.
  const stored = globalThis.window.localStorage.getItem('ap.runHistory') ?? ''
  assert.match(stored, /CROSSTABS/, `the history is persisted: ${stored.slice(0, 120)}`)
  assert.match(stored, /"persist":false|"persist": true|persist/, 'and it records whether the run changed data')

  // 文件 → 导出报告（成册）: the tick selection is the binding order, and the
  // extension picks the format before anything is written.
  await act(async () => {
    const outputTab = [...workHost.querySelectorAll('.ap-view-tab')].find((node) => /输出/.test(node.textContent))
    outputTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
  })
  const tick = workHost.querySelector('.ap-item input[type=checkbox]')
  assert.ok(tick, 'an output with a script can be ticked for the report')
  // A chart has no script: it was drawn from data, not computed by a statement.
  // Keying the tick box on `script` left the one output a report is most often
  // made of without a box at all.
  const chartBoxes = [...workHost.querySelectorAll('.ap-item')]
    .filter((node) => node.querySelector('img, .ap-chart'))
    .flatMap((node) => [...node.querySelectorAll('input[type=checkbox]')])
  assert.ok(chartBoxes.length >= 1, 'a chart row carries a tick box too, so it can be bound into a report')
  await act(async () => {
    tick.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  pop = await openMenu('文件')
  await clickIn(pop, '导出报告（成册，勾选的表）…')
  const book = workHost.querySelector('.ap-modal')
  assert.ok(book, 'the report dialog opened')
  assert.match(book.textContent, /\.html/, 'it says the extension picks the format')
  assert.match(book.textContent, /当前 1 项|1 项/, 'it counts what will be bound')
  const pathInput = book.querySelector('input[type=text]')
  assert.match(pathInput.value, /\.docx$/, `the path is prefilled with a docx name: ${pathInput.value}`)
  await clickIn(book, '选择路径')
  const body = globalThis.__lastBookBody
  assert.ok(Array.isArray(body?.items) && body.items.length === 1, 'only the ticked output travels')
  assert.equal(body.items[0], 'item-1', 'by id, in tick order')

  // The toolbar tip answers immediately — a tooltip that waits is one the user
  // reads after guessing the icon — and it must be readable: the colour pair is
  // fixed, because the skin's tokens can be translucent and the old colour-mix
  // tip ended up printed in the background colour.
  const toolbar = workHost.querySelector('.ap-toolbar')
  const icons = [...toolbar.querySelectorAll('.ap-icon-btn')]
  assert.ok(icons.length >= 5, 'the toolbar has its icons')
  const hover = async (node, wait = 30) => {
    await act(async () => {
      node.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, wait))
    })
  }
  await hover(icons[0])
  const firstTip = workHost.querySelector('.ap-tip')
  assert.ok(firstTip, 'the tip appears at once, with no pause')
  assert.equal(firstTip.textContent, icons[0].getAttribute('aria-label'), 'the tip names the icon under the pointer')
  // role="tooltip" would be restyled by the host skins' [role=tooltip] rule at a
  // higher specificity (measured 1.06:1 in the blue-fantasy skin), so this tip
  // deliberately carries no role.
  assert.notEqual(firstTip.getAttribute('role'), 'tooltip', 'the tip is not a skin-styled tooltip role')
  // The data-view button titles a whole sentence; the tip must still read like
  // the other icons, so the text comes from aria-label, not title.
  assert.match(String(icons[2].getAttribute('title') ?? ''), /数据视图正在显示/, 'that button keeps its long title')
  await hover(icons[2])
  const longTip = workHost.querySelector('.ap-tip')
  assert.equal(longTip.textContent, icons[2].getAttribute('aria-label'), 'the tip prefers the short name over the long title')
  assert.equal(icons[0].hasAttribute('title'), false, 'the native tooltip is taken away while the bar owns the tip')
  // The stylesheet, not the inline style: `--ap-panel` can be translucent, and
  // the colour-mix tip then printed its text in the background colour.
  const tipRule = /(\.ap-tip\s*\{[^}]*\})/.exec(readFileSync(join(root, 'client.js'), 'utf8'))?.[0] ?? ''
  assert.ok(tipRule.length > 0, 'the tip has its own rule')
  assert.doesNotMatch(tipRule, /color-mix/, 'the tip colours are fixed, not mixed from tokens')
  assert.match(tipRule, /background:#232323/i, 'dark chip')
  assert.match(tipRule, /color:#f7f7f7/i, 'light text')
  await hover(icons[1])
  const secondTip = workHost.querySelector('.ap-tip')
  assert.ok(secondTip, 'moving to the next icon switches at once')
  assert.equal(secondTip.textContent, icons[1].getAttribute('aria-label'), 'and it is the new icon name, not the old one')
  await act(async () => {
    toolbar.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: window.document.body }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.equal(workHost.querySelector('.ap-tip'), null, 'leaving the bar hides the tip')
  assert.equal(icons[1].hasAttribute('title'), true, 'and gives the native title back')
  // Every icon the pointer passed over loses its title while the bar owns the
  // tip; restoring only the last one left the earlier icons without a title for
  // the rest of the session.
  assert.equal(icons[0].hasAttribute('title'), true, 'the icon passed through earlier got its title back too')

  // 文件 → 导入向导…: the file is read as a preview first, and every change
  // re-asks before anything is imported. Without this, a Chinese heading that
  // turns into V1 or a numeric column read as text is only noticed afterwards.
  pop = await openMenu('文件')
  await clickIn(pop, '导入向导…')
  // The browser lists the cwd on mount and fills the path box when the listing
  // arrives; typing before that would be overwritten.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)) })
  const picker = workHost.querySelector('.ap-modal')
  assert.ok(picker, 'the file browser opens for the wizard')
  const wizardPathInput = picker.querySelector('input[type=text]')
  assert.ok(wizardPathInput, 'the browser has a path box')
  // React installs its own value setter on the input, so a plain assignment
  // moves the tracker too and onChange never sees a change. Go through the
  // prototype setter, which is what a real keystroke does.
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setValue.call(wizardPathInput, '/tmp/wizard.csv')
    wizardPathInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  await clickIn(picker, '选择路径')
  const wizard = [...workHost.querySelectorAll('.ap-modal')].at(-1)
  assert.match(wizard.textContent, /导入向导/, 'the wizard is what opened')
  assert.equal(globalThis.__previewBody?.path, '/tmp/wizard.csv', 'the preview was asked for that file')
  const nameBox = wizard.querySelector('.ap-wiz-name')
  assert.equal(nameBox.value, 'V1', 'the column name the import would use is shown and editable')
  assert.equal(nameBox.getAttribute('title'), '原表头：年龄', 'the heading that could not be kept is still visible')
  assert.match(wizard.textContent, /共 2 行、2 列/, 'the preview counts the rows and columns')
  assert.match(wizard.textContent, /年龄/, 'and repeats the rename note')
  const skipBox = [...wizard.querySelectorAll('input[type=number]')][0]
  assert.ok(skipBox, 'the skip-rows field is there')
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setValue.call(skipBox, '1')
    skipBox.dispatchEvent(new window.Event('input', { bubbles: true }))
    // React listens for focusout, not blur (blur does not bubble).
    skipBox.dispatchEvent(new window.Event('focusout', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  assert.equal(globalThis.__previewBody?.options?.skipRows, 1, 'changing the skipped lines reads the file again')
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setValue.call(nameBox, 'age')
    nameBox.dispatchEvent(new window.Event('input', { bubbles: true }))
    const typeSelect = wizard.querySelector('.ap-wiz-type')
    typeSelect.value = 'string'
    typeSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  await clickIn(wizard, '导入')
  assert.equal(globalThis.__openBody?.path, '/tmp/wizard.csv', 'importing opens the file the wizard previewed')
  assert.deepEqual(globalThis.__openBody?.options?.names, ['age', 'V2'], 'the edited variable name is used')
  assert.deepEqual(globalThis.__openBody?.options?.types, ['string', 'string'], 'so is the edited type')
  assert.equal(globalThis.__openBody?.options?.skipRows, 1, 'and the skipped lines')
  assert.deepEqual(globalThis.__openBody?.options?.missing, ['NA', '-9'], 'the missing markers are passed as a list')
  // 图形 → 图表拼版…: the ticked charts become one picture, in tick order.
  pop = await openMenu('图形')
  await clickIn(pop, '图表拼版…')
  const gridSheet = workHost.querySelector('.ap-modal')
  assert.match(gridSheet.textContent, /图表拼版/, 'the grid dialog opens')
  const chartCount = (workState.items ?? []).filter((item) => item.kind === 'image').length
  const boxes = [...gridSheet.querySelectorAll('input[type=checkbox]')]
  assert.ok(chartCount >= 1, 'the fixture has a chart')
  assert.equal(boxes.length, chartCount, 'every chart in the output is offered')
  assert.ok(boxes.every((box) => box.checked), 'and all of them start ticked')
  const layoutSelect = gridSheet.querySelector('select')
  assert.deepEqual([...layoutSelect.options].map((option) => option.value), ['2x2', '1x2', '2x1'], 'the three layouts are there')
  await act(async () => {
    layoutSelect.value = '1x2'
    layoutSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  await clickIn(gridSheet, '拼版')
  assert.equal(globalThis.__gridBody?.items?.length, chartCount, 'every ticked chart is sent')
  assert.equal(globalThis.__gridBody?.layout, '1x2', 'with the chosen layout')

  // 图表编辑器 → 副标题: what the title cannot say, without retyping the title.
  const workOutTab = [...workHost.querySelectorAll('.ap-view-tab')].find((node) => node.textContent === '输出')
  await act(async () => {
    workOutTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const editButton = [...workHost.querySelectorAll('.ap-tool')].find((node) => node.textContent === '编辑图表')
  assert.ok(editButton, 'the chart row has an edit button')
  await act(async () => {
    editButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const chartEditor = workHost.querySelector('.ap-modal')
  assert.match(chartEditor.textContent, /副标题/, 'the editor offers a subtitle')
  assert.equal(Number(globalThis.__chartOptionsBody?.runId), 1, 'the editor first reads what the chart looks like')
  const editorInputs = [...chartEditor.querySelectorAll('input[type=text]')]
  assert.equal(editorInputs.length, 4, 'title, subtitle and the two axis titles')
  assert.equal(editorInputs[0].value, 'score 的直方图', 'the title is prefilled, not blank')
  assert.equal(editorInputs[1].value, 'N = 30', 'so is the subtitle it already has')
  assert.equal(editorInputs[2].value, '得分', 'and the axis title')
  const subtitleInput = editorInputs[1]
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setValue.call(subtitleInput, 'N = 30，M = 4.2')
    subtitleInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  await clickIn(chartEditor, '应用')
  assert.equal(globalThis.__chartPatchBody?.subtitle, 'N = 30，M = 4.2', 'the subtitle travels with the patch')
  assert.equal(globalThis.__chartPatchBody?.xLabel, undefined, 'an untouched axis title is not sent, so it cannot be cleared')
  assert.equal(globalThis.__chartPatchBody?.accent, undefined, 'nor the colour')
  assert.equal(globalThis.__chartPatchBody?.title, undefined, 'nor the title')

  // 重绘…: the same data as another kind, and the old chart stays.
  const redrawButton = [...workHost.querySelectorAll('.ap-tool')].find((node) => node.textContent === '重绘…')
  assert.ok(redrawButton, 'the chart row offers a redraw')
  await act(async () => {
    redrawButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const redrawSheet = workHost.querySelector('.ap-modal')
  assert.match(redrawSheet.textContent, /重绘为另一种图/, 'the redraw dialog opens')
  const typeSelect = redrawSheet.querySelector('select')
  await act(async () => {
    typeSelect.value = 'boxplot'
    typeSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  await clickIn(redrawSheet, '重绘')
  assert.equal(globalThis.__redrawBody?.type, 'boxplot', 'the chosen type is sent')
  assert.equal(Number(globalThis.__redrawBody?.runId), 1, 'and the chart it came from')

  // PNG 倍率: the select in the row decides what the export writes.
  const scaleSelect = [...workHost.querySelectorAll('.ap-export-scale')][0]
  assert.ok(scaleSelect, 'the row offers an export magnification')
  assert.deepEqual([...scaleSelect.options].map((option) => option.value), ['1', '2', '3', '4'], 'four steps, 1x to 4x')
  await act(async () => {
    scaleSelect.value = '3'
    scaleSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const pngButton = [...workHost.querySelectorAll('.ap-tool')].find((node) => node.textContent === '导出 PNG')
  await act(async () => {
    pngButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const exportSheet = workHost.querySelector('.ap-modal')
  const exportPick = exportSheet?.querySelector('.ap-picker, .ap-file-list, ul')
  assert.ok(exportSheet, 'the file chooser opens')
  await clickIn(exportSheet, '选择路径')
  assert.equal(globalThis.__chartExportBody?.scale, 3, 'the chosen magnification reaches the export call')

  // 线性回归 has a 图 tab: PSPP prints no regression plots, so they are drawn
  // from the same fit and must be offered where SPSS offers them.
  pop = await openMenu('分析')
  const regressionGroup = [...pop.querySelectorAll('button')].find((node) => String(node.textContent).startsWith('回归'))
  await act(async () => {
    regressionGroup?.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const linearEntry = [...(regressionGroup?.parentElement?.querySelectorAll('.ap-sub-pop button') ?? [])]
    .find((node) => String(node.textContent).startsWith('线性'))
  assert.ok(linearEntry, 'the regression dialog is reachable')
  await act(async () => {
    linearEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const regressionSheet = workHost.querySelector('.ap-modal')
  assert.match(regressionSheet.textContent, /图（PSPP 不画/, 'the regression dialog offers plots')
  await clickIn(regressionSheet, '图（PSPP 不画')
  assert.match(workHost.querySelector('.ap-modal').textContent, /残差散点图/, 'the residual plot is offered')
  assert.match(workHost.querySelector('.ap-modal').textContent, /正态 P-P 图/, 'and the normal P-P plot')
  await clickIn(workHost.querySelector('.ap-modal'), '取消')

  // The compute builder: suggestions come from the spec, and the expression is
  // checked before anything reaches the engine.
  assert.equal(hooks.checkExpression('score * 2 + gender', 'double', workState.variables ?? []), null,
    'a plain expression over existing variables passes')
  assert.match(String(hooks.checkExpression('score * 2)', 'double', workState.variables ?? [])),
    /多了一个右括号/)
  assert.match(String(hooks.checkExpression('score * (2', 'double', workState.variables ?? [])),
    /少了一个右括号/)
  assert.match(String(hooks.checkExpression('scor * 2', 'double', workState.variables ?? [])),
    /不是当前数据集里的变量/)
  assert.match(String(hooks.checkExpression('score *', 'double', workState.variables ?? [])),
    /还缺一个运算对象/, 'a dangling operator is caught here, not by the engine')
  assert.equal(hooks.checkExpression('MEAN(score, gender)', 'double', workState.variables ?? []), null,
    'a known function is allowed')

  pop = await openMenu('转换')
  const computeEntry = [...pop.querySelectorAll('button')].find((node) => String(node.textContent).startsWith('计算变量'))
  assert.ok(computeEntry, 'the compute dialog is reachable')
  await act(async () => {
    computeEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const computeSheet = workHost.querySelector('.ap-modal')
  assert.ok(computeSheet, 'the compute dialog opens')
  const expressionInput = [...computeSheet.querySelectorAll('input')].find((node) => node.getAttribute('placeholder') === 'age * 2')
  assert.ok(expressionInput, 'the expression box is there')
  const suggestButtons = [...computeSheet.querySelectorAll('.ap-suggest-btn')]
  assert.ok(suggestButtons.length >= 10, 'the functions and variables are offered as buttons')
  await act(async () => {
    const mean = suggestButtons.find((node) => node.textContent === 'MEAN(')
    mean.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  assert.equal(expressionInput.value, 'MEAN(', 'clicking a function inserts it')
  await clickIn(computeSheet, '取消')

  // 变量视图的批量修改：右键菜单进入，一次提交一个 patch。
  const varTab = [...workHost.querySelectorAll('.ap-view-tab')].find((node) => String(node.textContent) === '变量视图')
  await act(async () => {
    varTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const varRows = [...workHost.querySelectorAll('.ap-grid tbody tr')]
  assert.ok(varRows.length >= 2, 'the variable grid has rows')
  await act(async () => {
    varRows[0].dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const batchEntry = [...workHost.querySelectorAll('button.ap-var-item')]
    .find((node) => String(node.textContent).includes('批量修改'))
  assert.ok(batchEntry, 'the batch entry is in the context menu')
  await act(async () => {
    batchEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const batchSheet = workHost.querySelector('.ap-modal')
  assert.ok(batchSheet, 'the batch dialog opens')
  const measureSelect = [...batchSheet.querySelectorAll('select')].pop()
  await act(async () => {
    measureSelect.value = 'nominal'
    measureSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  await clickIn(batchSheet, '应用')
  assert.equal(globalThis.__variableBody?.action, 'updateMany', 'one call carries the whole batch')
  assert.deepEqual(globalThis.__variableBody?.patch?.measure, 'nominal', 'and only the fields the user set')

  // Alt+1…4 switches the view; Ctrl+Enter is documented in the shortcuts
  // table, so the two rows in that table must match something real.
  await act(async () => {
    workHost.dispatchEvent(new window.KeyboardEvent('keydown', { key: '3', altKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  assert.ok([...workHost.querySelectorAll('.ap-view-tab')].some((tab) => tab.textContent === '语法' && String(tab.className).includes('ap-active')), 'Alt+3 lands on the syntax view')

  // Ctrl+Shift+F 是「查找过程」，不能落到数据「查找」上。两个 keydown 处理
  // 函数都会响应：菜单栏那个原来被 Alt 守卫挡死，数据网格那个不判 Shift。
  await act(async () => {
    workHost.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const finderModal = [...workHost.querySelectorAll('.ap-modal')].at(-1)
  assert.equal(finderModal?.querySelector('input[type="search"]') !== null, true, 'Ctrl+Shift+F opens the procedure finder')
  assert.match(finderModal.textContent, /查找过程/, 'and it is the procedure finder, not the data one')
  assert.equal(finderModal.textContent.includes('查找内容'), false, 'the data find dialog stays closed')
  await act(async () => {
    const cancel = [...finderModal.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
    cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  // 数据「查找」那一支在 jsdom 里跑不起来（它要求 root.offsetParent 非空，
  // 而 jsdom 对任何元素都返回 null），所以只在源码层面钉住「Shift 不再被抢」。
  assert.match(
    clientSource,
    /if \(key === 'f'\) \{[\s\S]{0,200}?if \(event\.shiftKey\) return/,
    'the data find dialog ignores Ctrl+Shift+F so the procedure finder keeps it',
  )

  await openMenu('帮助')
  const helpPop = workHost.querySelector('.ap-menu-pop')
  const shortcutsEntry = [...helpPop.querySelectorAll('button')].find((node) => node.textContent === '快捷键一览…')
  assert.ok(shortcutsEntry, 'the help menu offers the shortcut sheet')
  shortcutsEntry.click()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })
  const keysSheet = workHost.querySelector('.ap-modal')
  assert.ok(keysSheet && keysSheet.textContent.includes('Ctrl+Enter'), 'the sheet lists Ctrl+Enter')
  assert.ok(keysSheet.textContent.includes('Alt+1'), 'and the view switch')
  await clickIn(keysSheet, '关闭')

  const backToVars = [...workHost.querySelectorAll('.ap-view-tab')].find((tab) => tab.textContent === '变量视图')
  await clickIn(workHost, '变量视图')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })


  await act(async () => { workRoot.unmount() })
  console.log('ok  syntax templates, run history, bound report, the toolbar tip, the grid, the subtitle, the redraw, the export scale, the regression plots and the compute builder')
}
