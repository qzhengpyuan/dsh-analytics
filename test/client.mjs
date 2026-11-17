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

const registered = { tabs: [], viewers: [], settings: [] }
function makeContext() {
  const services = {
    betterSidebar: {
      registerTab(definition) { registered.tabs.push(definition); return () => {} },
      registerFileViewer(definition) { registered.viewers.push(definition); return () => {} },
      openTab() {},
      closeTab() {},
    },
    slots: {
      inject(name, run) { assert.equal(name, 'settings.section'); run(); return () => {} },
      register(definition, component) { registered.settings.push({ ...definition, component }); return () => {} },
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
assert.equal(registered.settings.length, 1, 'the plugin puts one page under 设置 → 插件')
assert.equal(registered.settings[0].id, 'analytics')
assert.equal(registered.settings[0].label, '统计分析')
assert.equal(typeof registered.settings[0].component, 'function', 'the settings page must render something')
assert.equal(registered.viewers[0].id, 'analytics:data')
assert.deepEqual(registered.viewers[0].exts, ['sav', 'por', 'sys', 'dta'])

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
    for (const wanted of ["Somers' d", 'Eta', '风险估计（2×2）', '不确定性系数', 'Kendall tau-b']) {
      assert.ok(sheetLabels.some((text) => text.includes(wanted)), `the statistics sheet offers ${wanted}`)
    }
    for (const wanted of ["Somers' d", 'Eta']) {
      const label = [...sheet.querySelectorAll('.ap-check')].find((node) => node.textContent.trim().includes(wanted))
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
  const badge = [...stateHost.querySelectorAll('.ap-status button')].find((node) => /导入说明/.test(node.textContent))
  assert.ok(badge, 'the status bar keeps an import-notes entry')
  assert.match(badge.textContent, /导入说明 1/)
  await act(async () => {
    badge.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const noteModal = stateHost.querySelector('.ap-modal')
  assert.ok(noteModal && /原表头保留为标签/.test(noteModal.textContent), 'the dialog lists why each column was renamed')
  await act(async () => { stateRoot.unmount() })

  // A dataset built in the panel has no file: the chip must not print its label
  // as if it were a path ("prov-probe · 3 例" read like a file name).
  payload.state.items[0].provenance = { sessionId: 'session-test', origin: 'new', sourcePath: null, name: 'prov-probe', caseCount: 3, varCount: 1, openedAt: null, at: 1794740000002 }
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
    items: [{ id: 'run-1-0', kind: 'table', title: '年龄', table: { caption: '年龄', matrix: [['', 'N'], ['年龄', '5']] }, runId: 1 }],
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
  await act(async () => {
    reactRoot.render(React.createElement(registered.settings[0].component))
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
  const save = [...root.querySelectorAll('button')].find((button) => button.textContent === '保存')
  assert.ok(save, 'there is a save button')
  await act(async () => { save.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 60)) })
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
  hooks.setDictionary({ 保存: 'Save', 个个案: 'cases', 尚未打开数据集: 'No dataset open' })
  assert.equal(hooks.tr('保存'), 'Save', 'an exact key is translated')
  assert.equal(hooks.tr('3000 个个案'), '3000 cases', 'a template is translated through its substring key')
  assert.equal(hooks.tr('/tmp/a.sav'), '/tmp/a.sav', 'a path is left alone')
  const node = hooks.h('button', { title: '保存', className: 'ap-tool' }, '保存')
  assert.equal(node.props.title, 'Save', 'the title prop is translated')
  assert.equal(node.props.className, 'ap-tool', 'other props are untouched')
  assert.equal(node.props.children, 'Save', 'a text child is translated')
  hooks.setDictionary(null)
  assert.equal(hooks.tr('保存'), '保存', 'clearing the dictionary falls back to Chinese')
  console.log('ok  the i18n wrapper translates text and props, and falls back to Chinese')
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
  const leftovers = [...new Set((fullHost.textContent.match(/[\u4e00-\u9fff]+/g) ?? []))]
  assert.deepEqual(leftovers, [], `translated panel still shows Chinese: ${leftovers.join(' / ')}`)
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
}
