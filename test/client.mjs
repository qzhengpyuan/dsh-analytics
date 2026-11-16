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
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3400)) })
  assert.ok(beatCalls() >= 1, 'the open panel polls the heartbeat')
  assert.equal(stateCalls(), 1, 'an unchanged signature does not pull the full state again')
  signalChanged = true
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3400)) })
  assert.ok(stateCalls() >= 2, 'a changed signature pulls the full state')
  await act(async () => { pollRoot.unmount() })
  console.log('ok  poll asks the heartbeat first and only pulls state on change')
}

// The settings page is what makes the knobs reachable without editing the
// profile patch, so it has to render the values it read, say where they live,
// and post a validated patch back.
{
  const posts = []
  const payload = {
    ok: true,
    settings: { maxRows: 5000, timeoutMs: 90000, safer: true, tableStyle: 'grid' },
    defaults: { maxRows: 200000, timeoutMs: 120000, safer: false, tableStyle: 'three-line' },
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
  assert.deepEqual(numbers, ['5000', '90'], 'cases and timeout (in seconds) come back from the file')
  const checkbox = root.querySelector('input[type="checkbox"]')
  assert.equal(checkbox.checked, true)
  const select = root.querySelector('select')
  assert.equal(select.value, 'grid')
  const save = [...root.querySelectorAll('button')].find((button) => button.textContent === '保存')
  assert.ok(save, 'there is a save button')
  await act(async () => { save.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 60)) })
  assert.equal(posts.length, 1, 'saving posts once')
  assert.deepEqual(posts[0].patch, { maxRows: 5000, timeoutMs: 90000, safer: true, tableStyle: 'grid' }, 'seconds go back as milliseconds')
  assert.match(root.textContent, /已保存/, 'the page says the save landed')
  await act(async () => { reactRoot.unmount() })
  console.log('ok  settings page reads the file, reports problems and posts a patch')
}
