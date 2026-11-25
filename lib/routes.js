import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'

import { decodeText } from './dataset.js'
import { dictionaryFor, localize } from './i18n.js'
import { describeFsError } from './fserr.js'
import { checkPath, rootsFrom } from './paths.js'
import { pluginInfo } from './version.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function sendRaw(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * HTTP surface of one plugin instance. Every route delegates to the same
 * Workspace methods the agent tools use, so a UI action and a tool call
 * cannot diverge.
 */
export function createHandler({ registry, connection, getConnection, config, settings, updateCheck }) {
  // Every error the panel can show goes through one place: the panel is written
  // in Chinese, and an English panel showing a Chinese failure message is the
  // half-translated state this dictionary exists to avoid.
  const locale = () => (settings?.current?.().uiLanguage === 'en' ? 'en' : 'zh')
  const sendJson = (res, status, value) => {
    const language = locale()
    if (language === 'en' && value && value.ok === false && typeof value.error === 'string') {
      sendRaw(res, status, { ...value, error: localize(value.error, language) })
      return
    }
    sendRaw(res, status, value)
  }

  // The connection service can arrive after the web server, so resolving it once
  // at mount time can leave this handler holding `undefined` for the life of the
  // process — every request then fails closed with 401 and the panel cannot talk
  // to its own host. Resolve it per request instead.
  const connectionFor = typeof getConnection === 'function' ? getConnection : () => connection

  const authorize = (req) => {
    // No connection means no way to check the caller. Failing closed matters:
    // the previous `return undefined` let every route through, so a plugin
    // whose webServer arrived without a connection exposed the whole API.
    let link
    try {
      link = connectionFor()
    } catch {
      return 401
    }
    if (!link) return 401
    try {
      return link.requestRejection({ headers: req.headers })
    } catch {
      return 401
    }
  }

  // The session id becomes a directory name under the plugin's workspace
  // root. It arrives from a query string, so a `../` in it would create (and
  // later read back) directories outside that root; keep it to a filename.
  const safeSessionId = (value) => {
    const text = String(value ?? '').trim()
    if (!text) return 'default'
    return text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'default'
  }

  const workspaceFor = async (sessionId, cwd) => {
    const workspace = await registry.ensure(safeSessionId(sessionId), typeof cwd === 'string' && cwd ? cwd : undefined)
    // Cleared per request: a stale name would credit a tool call's write to the
    // last browser that spoke, and that browser would never see its own
    // "another window changed this" notice.
    workspace.currentWriter = null
    return workspace
  }

  return async function handler(req, res) {
    // One tiny read-only route stays open: the panel is served behind the
    // host's launch token, so a health probe from the same machine (installer,
    // doctor, a user typing the address) otherwise only ever sees 401. It
    // exposes the version and nothing else — no dataset, no session, no paths.
    const probe = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/(?:analytics-pspp|analytics)\/?/, '')
    // `api/update` joins the probe: it answers with a public release number and
    // nothing about this machine, and the panel may ask before the session
    // cookie is in place. Anything that touches a dataset stays behind the gate.
    if (probe === 'api/update' && req.method === 'GET') {
      if (!updateCheck) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: '更新检查没有接上（宿主半没有传 updateCheck）' }))
        return
      }
      const answer = await updateCheck(pluginInfo().version ?? config.pluginVersion ?? null)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...answer, ok: true }))
      return
    }
    if (probe === 'api/version') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      // Read the version at request time: the copy captured when the handler was
      // built goes stale the moment a hot reload swaps the code, and then the one
      // endpoint meant to answer "which build is running" reports the old number.
      const live = pluginInfo()
      res.end(JSON.stringify({ ok: true, plugin: 'dsh-analytics-pspp', version: live.version ?? config.pluginVersion ?? null }))
      return
    }
    const rejection = authorize(req)
    if (rejection) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    // `/analytics-pspp` is the pre-rename prefix: keep it working for open tabs.
    // The longer prefix must come first, or `analytics` matches and leaves
    // `-pspp/...` behind.
    const route = url.pathname.replace(/^\/(?:analytics-pspp|analytics)\/?/, '')
    const sessionId = url.searchParams.get('sessionId') ?? undefined

    try {
      if (req.method === 'GET' && route === 'api/state') {
        const workspace = await workspaceFor(sessionId, url.searchParams.get('cwd') ?? undefined)
        sendJson(res, 200, { ok: true, state: workspace.state() })
        return
      }

      if (req.method === 'GET' && route === 'api/locale') {
        // The panel asks for this once per language switch: the dictionary is
        // ~66 KB of JSON, so it is not something to ride along with every state.
        const language = url.searchParams.get('lang') === 'en' ? 'en' : 'zh'
        sendJson(res, 200, { ok: true, locale: language, strings: dictionaryFor(language) })
        return
      }

      if (req.method === 'GET' && route === 'api/update') {
        // "Is there a newer release" without leaving the panel. GitHub's public
        // API allows 60 unauthenticated calls an hour, so an answer is cached for
        // ten minutes; a failure is reported instead of thrown, because an
        // unreachable GitHub must not look like "you are up to date".
        if (!updateCheck) {
          sendJson(res, 503, { ok: false, error: '更新检查没有接上（宿主半没有传 updateCheck）' })
          return
        }
        const answer = await updateCheck(pluginInfo().version ?? config.pluginVersion ?? null)
        sendJson(res, 200, { ok: true, ...answer })
        return
      }

      if (req.method === 'GET' && route === 'api/settings') {
        // Reads the file each time: a hand edit to settings.json shows up on the
        // next panel refresh, and the panel needs `problems` to say what it had
        // to ignore instead of silently reverting a knob.
        if (!settings) {
          sendJson(res, 503, { ok: false, error: '设置存储没有接上（宿主半没有传 SettingsStore）' })
          return
        }
        sendJson(res, 200, { ok: true, ...settings.describe() })
        return
      }

      if (req.method === 'GET' && route === 'api/heartbeat') {
        // Polled by the open panel. Kept separate from api/state because state
        // carries every output matrix: a 3000-case frequency table is ~300 KB,
        // and polling that once a second was pure traffic.
        const workspace = await workspaceFor(sessionId, url.searchParams.get('cwd') ?? undefined)
        sendJson(res, 200, { ok: true, signal: workspace.signature() })
        return
      }

      if (req.method === 'GET' && route === 'api/workspaces') {
        // The left column's global panel opens without a Session, so it asks
        // what is already open before it draws anything.
        // `?limit=` keeps the caller honest when a machine has been running for
        // days: twenty is the default, and the answer says whether it was cut.
        const asked = Number(url.searchParams.get('limit') ?? '')
        const limit = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 20
        const all = await registry.recent({ limit: Number.MAX_SAFE_INTEGER })
        const workspaces = all.slice(0, limit)
        sendJson(res, 200, {
          ok: true,
          result: { workspaces, limit, total: all.length, truncated: all.length > workspaces.length },
        })
        return
      }

      if (req.method === 'GET' && route === 'api/artifact') {
        const workspace = await workspaceFor(sessionId)
        const runId = url.searchParams.get('runId') ?? ''
        const name = url.searchParams.get('name') ?? ''
        const bytes = await workspace.artifact(runId, name)
        if (!bytes) {
          sendJson(res, 404, { ok: false, error: 'artifact not found' })
          return
        }
        res.writeHead(200, {
          'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'private, max-age=3600',
        })
        res.end(bytes)
        return
      }

      if (req.method === 'GET' && route === 'api/report') {
        // The report card's preview: one entry per output item that can be
        // replayed, in output order.
        const workspace = await workspaceFor(sessionId, url.searchParams.get('cwd') ?? undefined)
        sendJson(res, 200, {
          ok: true,
          entries: workspace.items
            .filter((item) => item.kind === 'table' && item.script)
            .map((item) => ({ id: item.id, title: item.title ?? '', summary: item.summary ?? '' })),
        })
        return
      }
      if (req.method === 'GET' && route === 'api/dir') {
        const { readdir, stat } = await import('node:fs/promises')
        const { basename, dirname } = await import('node:path')
        // The browser half lists a directory to pick a file, so this is the one
        // endpoint that reports names and sizes of things the user did not
        // name. It follows the same whitelist as every other path (lib/paths.js)
        // plus the optional `listRoots` override from the deployment patch.
        const live = settings ? settings.current() : {}
        const extraRoots = Array.isArray(config?.listRoots) && config.listRoots.length > 0
          ? config.listRoots
          : []
        const allowedDirs = [...(live.allowedDirs ?? []), ...extraRoots]
        const roots = rootsFrom(allowedDirs, { cwd: process.cwd() })
        let target
        try {
          target = checkPath(url.searchParams.get('path') ?? process.cwd(), {
            cwd: process.cwd(),
            allowedDirs,
            roots,
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message, roots })
          return
        }
        let pick = null
        try {
          if ((await stat(target)).isFile()) {
            pick = basename(target)
            target = dirname(target)
          }
        } catch { /* 不存在就交给 readdir 报错 */ }
        let entries
        try {
          entries = await readdir(target, { withFileTypes: true })
        } catch (error) {
          // `ENOENT: no such file or directory, scandir '/mnt/zzz'` is an
          // English stack line in a panel that speaks Chinese.
          sendJson(res, 400, { ok: false, error: describeFsError(error, target) })
          return
        }
        const items = []
        for (const entry of entries.slice(0, 500)) {
          if (entry.name.startsWith('.')) continue
          let size = 0
          try { size = (await stat(join(target, entry.name))).size } catch { /* ignore */ }
          items.push({ name: entry.name, dir: entry.isDirectory(), size })
        }
        items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
        sendJson(res, 200, { ok: true, path: target, entries: items, pick })
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      const body = await readBody(req)
      const workspace = await workspaceFor(body.sessionId ?? sessionId, body.cwd)
      // Names the panel for this one request: the workspace records it on the
      // next write so another window can tell that its grid is stale.
      workspace.currentWriter = typeof body.writer === 'string' && body.writer ? body.writer : null
      // Optimistic concurrency: a panel that tells us which revision it was
      // looking at refuses to overwrite a change it has not seen. Without this
      // the losing window rewrites stale cells and the user is only told after
      // the fact (and after their own typing has been thrown away).
      const baseRevision = body.baseRevision === undefined || body.baseRevision === null
        ? null
        : Number(body.baseRevision)
      if (baseRevision !== null && Number.isFinite(baseRevision) && body.force !== true
        && Number(workspace.revision ?? 0) !== baseRevision) {
        // Kept, not just announced: five seconds after the toast the question
        // "did somebody overwrite my data?" has no answer left.
        // Snapshot first: recording the conflict writes dataset.json, which is
        // itself a write and bumps the revision — the answer has to describe the
        // state the caller lost the race against, not the state afterwards.
        const refusedAt = Number(workspace.revision ?? 0)
        const refusedOwner = workspace.lastWriter ?? null
        workspace.recordConflict({
          expected: baseRevision,
          actual: refusedAt,
          lastWriter: refusedOwner,
          writer: workspace.currentWriter,
          route,
        })
        // Read back from disk by the panel and by the next session: answer only
        // after the record is actually there.
        await workspace.settled?.()
        sendJson(res, 409, {
          ok: false,
          error: '另一个窗口已经改过这份数据：这次修改没有写入，请先载入最新内容',
          conflict: {
            expected: baseRevision,
            actual: refusedAt,
            lastWriter: refusedOwner,
          },
          state: workspace.state(),
        })
        return
      }

      switch (route) {
        case 'api/settings': {
          if (!settings) {
            sendJson(res, 503, { ok: false, error: '设置存储没有接上（宿主半没有传 SettingsStore）' })
            return
          }
          // `body.patch` keeps the envelope consistent with every other POST;
          // a bare body is accepted too so `curl -d '{"maxRows":5000}'` works.
          const patch = body.patch ?? body.settings ?? body
          try {
            const saved = settings.update(patch)
            sendJson(res, 200, { ok: true, ...settings.describe(), settings: saved })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error.message })
          }
          return
        }
        case 'api/open': {
          const result = await workspace.open(body.path, body.options ?? {})
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/new': {
          await workspace.createDataset(body.spec ?? body)
          sendJson(res, 200, { ok: true, state: workspace.state() })
          return
        }
        case 'api/rows': {
          sendJson(res, 200, { ok: true, page: workspace.page(body.offset, body.limit, body.variables) })
          return
        }
        case 'api/run': {
          const result = await workspace.runSyntax(body.syntax, {
            persist: body.persist === true,
            // The panel knows which variable/group an ANOVA came from; carrying
            // it on the items lets the output offer "pairwise comparison" for
            // exactly that run instead of asking again.
            pairwise: body.pairwise && typeof body.pairwise === 'object' ? body.pairwise : null,
            regression: body.regression && typeof body.regression === 'object' ? body.regression : null,
            roc: body.roc && typeof body.roc === 'object' ? body.roc : null,
            exact: body.exact === true,
            exactChi: body.exactChi === true,
            // Multi-factor GLM contrasts have no engine path, so the panel sends
            // the hypotheses and the host fits them on the same design matrix.
            contrasts: body.contrasts && typeof body.contrasts === 'object' ? body.contrasts : null,
          })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/publication': {
          const result = workspace.publicationTable(body.kind ?? 'baseline', body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/discriminant': {
          const result = workspace.discriminantTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/timeseries': {
          const result = await workspace.timeseriesTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/cluster': {
          const result = await workspace.clusterTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/cox': {
          const result = workspace.coxTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/multinomial': {
          const result = workspace.multinomialTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/twostage': {
          const result = workspace.twoStageTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/mds': {
          const result = await workspace.mdsTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/curve': {
          const result = await workspace.curveTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/mca': {
          const result = await workspace.mcaTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/correspondence': {
          const result = await workspace.correspondenceTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/distribution': {
          const result = workspace.distributionTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/wls': {
          const result = workspace.wlsTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/poisson': {
          const result = workspace.poissonTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/ordinal': {
          const result = workspace.ordinalTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/pairwise': {
          const result = workspace.pairwiseTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/partial': {
          const result = workspace.partialTable(body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/chart': {
          const chartOptions = body.options ?? body
          const result = await workspace.addChart(body.kind ?? chartOptions.kind, chartOptions)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/regressionPlot': {
          const result = await workspace.addRegressionPlot(body.kind ?? 'residual', body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/chart/redraw': {
          const result = await workspace.redrawChart(body.runId, body.type)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/chartGrid': {
          const result = await workspace.addChartGrid(body.items ?? [], body.layout ?? '2x2', {
            gap: body.gap,
            padding: body.padding,
          })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/chart/update': {
          const { runId, ...patch } = body
          const result = await workspace.updateChart(runId, patch)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/chart/options': {
          const result = await workspace.chartOptions(body.runId)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/chart/export': {
          const result = await workspace.exportChart({
            runId: body.runId,
            url: body.url,
            path: body.path,
            format: body.format,
            scale: body.scale,
          })
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/save': {
          const result = await workspace.save(body.path)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/export': {
          const result = await workspace.exportCsv(body.path)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/saveSyntax': {
          // The editor lives in the browser, so the text comes with the request
          // and the host is only the thing allowed to write a real path.
          if (!body.path) throw new Error('path is required')
          const target = workspace.resolvePath(String(body.path))
          if (!/\.sps$/i.test(target)) throw new Error('语法文件必须用 .sps 扩展名')
          if (basename(target).startsWith('.')) throw new Error(`不能写到 ${target}：这类隐藏文件不由本插件负责，换个文件名`)
          const text = String(body.text ?? '')
          try {
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, text.endsWith('\n') || text === '' ? text : `${text}\n`, 'utf8')
          } catch (error) {
            throw new Error(describeFsError(error, target))
          }
          sendJson(res, 200, { ok: true, result: { path: target, bytes: Buffer.byteLength(text) } })
          return
        }
        case 'api/writeText': {
          // One output table, exported on its own: the CSV text is already in
          // the browser, so the host only has to put it on disk.
          const result = await workspace.writeText(body.path, String(body.text ?? ''))
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/exportOffice': {
          // `items` may be whole output entries or just their ids (the panel's
          // "export this table" button sends an id); the ids are resolved here.
          const requested = Array.isArray(body.items) && body.items.length > 0 ? body.items : null
          const picked = requested
            ? requested
              .map((entry) => (typeof entry === 'string'
                ? workspace.state().items.find((item) => item.id === entry) ?? null
                : entry))
              .filter(Boolean)
            : null
          // Asking for something that is no longer there must not quietly fall
          // back to "export everything".
          if (requested && (picked ?? []).length === 0) {
            sendJson(res, 400, { ok: false, error: '指定的输出条目已经不在了：刷新面板后重新选择' })
            return
          }
          const result = await workspace.exportOffice(body.path, picked, { scope: body.scope, formulas: body.formulas, data: body.data === true })
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/exportDoc': {
          // The extension is the format: a caller that passes `.spv` gets an
          // SPSS output archive, `.pdf` a document.
          const format = body.format ?? (extname(String(body.path ?? '')).slice(1) || 'pdf')
          const result = await workspace.exportDocument(body.path, format)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/cell': {
          const result = workspace.setCell(body.row, body.variable, body.value)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/paste': {
          const result = workspace.setCells(body.cells, { extend: body.extend === true })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/case': {
          const result = body.action === 'delete'
            ? workspace.deleteCase(body.row)
            : body.action === 'insert'
              ? workspace.insertCase(body.row, body.values ?? {})
              : workspace.appendCase(body.values ?? {})
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/variable': {
          const action = body.action ?? 'update'
          const result = action === 'add'
            ? workspace.addVariable(body.spec ?? {})
            : action === 'delete'
              ? workspace.deleteVariable(body.name)
              : action === 'move'
                ? workspace.moveVariable(body.name, body.position)
                : action === 'updateMany'
                  ? workspace.updateVariables(body.names ?? [], body.patch ?? {})
                : workspace.updateVariable(body.name, body.patch ?? {})
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/readFile': {
          // Small text files only: this backs the value-label importer, not a
          // general file reader.
          if (!body.path) throw new Error('path is required')
          // Same whitelist as the data files: this reader backs the value-label
          // importer, not a way to reach arbitrary text on the machine.
          const path = workspace.resolvePath(String(body.path))
          const info = await stat(path)
          // A device or FIFO reports size 0, so the size check alone let
          // /dev/zero stream until the host ran out of memory. Only regular
          // files are readable, and only text-ish ones: this must not become a
          // way to read ~/.dsh/.credentials.yaml from the browser half.
          if (!info.isFile()) throw new Error(`不能读取 ${path}：只支持普通文件`)
          if (info.size > 4 * 1024 * 1024) throw new Error('文件太大（上限 4 MB）')
          const readable = new Set(['.csv', '.txt', '.tsv', '.tab', '.dat', '.sps', '.json', '.md', '.labels', '.lab', '.html', '.htm', '.log'])
          const extension = extname(path).toLowerCase()
          if (!readable.has(extension)) {
            throw new Error(`不能读取 ${path}：只支持 ${[...readable].join(' ')} 这类文本文件`)
          }
          const buffer = await readFile(path)
          sendJson(res, 200, { ok: true, result: { text: decodeText(buffer, body.encoding ?? 'auto'), bytes: info.size } })
          return
        }
        case 'api/valuelabels': {
          // `assign` applies a parsed <value>,<label> list wholesale; `parse`
          // only reports what the text would set, so the dialog can preview.
          const labels = body.labels ?? {}
          const result = body.action === 'parse'
            ? { labels }
            : workspace.setValueLabels(body.name, labels, { merge: body.merge === true })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/exportReport': {
          // The report card sends the syntax of the ticked results; the file
          // is written by replaying that script, not by `lastScript`.
          const format = String(body.format ?? 'pdf').toLowerCase()
          if (!body.path) throw new Error('a target path is required')
          const result = await workspace.exportScript(body.path, body.script, format)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/reportBook': {
          // Assembling the ticked tables into a bound report — the tables are
          // already computed, so nothing is replayed here (that is exportReport).
          if (!body.path) throw new Error('a target path is required')
          const ids = Array.isArray(body.items) ? body.items : []
          const result = await workspace.exportReportBook(body.path, ids, {
            title: body.title,
            subtitle: body.subtitle,
          })
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/mrset': {
          // PSPP cannot tabulate a multiple response set, so define/frequency/
          // crosstab/remove all land here and are counted in JavaScript.
          const action = String(body.action ?? 'define')
          if (action === 'define') {
            sendJson(res, 200, { ok: true, state: workspace.defineMrSet(body.set ?? body) })
            return
          }
          if (action === 'remove') {
            sendJson(res, 200, { ok: true, state: workspace.removeMrSet(String(body.name ?? '')) })
            return
          }
          if (action === 'read') {
            sendJson(res, 200, { ok: true, state: workspace.setMrRead(body.name ?? null) })
            return
          }
          if (action === 'frequency') {
            const value = await workspace.mrFrequency(String(body.name ?? ''), { percentBase: body.percentBase })
            sendJson(res, 200, { ok: true, result: { responses: value.result.responses, respondents: value.result.respondents, categories: value.result.categories }, state: value.state })
            return
          }
          if (action === 'crosstab') {
            const value = await workspace.mrCrosstab(String(body.name ?? ''), String(body.groupBy ?? ''))
            sendJson(res, 200, { ok: true, result: { matrix: value.result.matrix }, state: value.state })
            return
          }
          throw new Error(`unknown multiple response action: ${action}`)
        }
        case 'api/sort': {
          const result = workspace.sortCases(body.keys ?? [])
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/active': {
          // The panel tells the host which tab the user is looking at, so the
          // pspp_* tools act on that dataset instead of a stale one.
          // The panel keeps sessionId in the JSON body (it is not a query
          // parameter here), so reading the query only ever produced
          // 'default' and the agent tools followed the wrong tab.
          const activeSession = safeSessionId(body.sessionId ?? sessionId)
          registry.setActive(activeSession, body.docId ? String(body.docId) : activeSession)
          sendJson(res, 200, { ok: true, result: { active: registry.resolveForTools(activeSession) } })
          return
        }
        case 'api/close': {
          const result = await workspace.close()
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/merge': {
          const result = await workspace.mergeFile({ kind: body.kind, path: body.path, by: body.by }).catch((error) => {
            throw new Error(describeFsError(error, body.path))
          })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/restructure': {
          // PSPP has neither CASESTOVARS nor VARSTOCASES, so both restructures
          // are computed on the owned matrix and only hit disk on the next run.
          const mode = body.kind === 'varsToCases' ? 'varsToCases' : 'casesToVars'
          const result = mode === 'varsToCases'
            ? workspace.restructureVarsToCases({
              variables: body.variables,
              id: body.id,
              target: body.target,
              indexName: body.indexName,
              indexValues: body.indexValues,
            })
            : workspace.restructureCasesToVars({
              id: body.id,
              index: body.index,
              variables: body.variables,
            })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/duplicates': {
          // SPSS's "Identify Duplicate Cases" is a data step; PSPP has no such
          // command, so the plugin groups the rows itself.
          const result = workspace.identifyDuplicates({
            variables: body.variables,
            indicators: body.indicators === true,
          })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/outliers': {
          // Same story as the duplicate step: a data step with no PSPP syntax
          // behind it, so the host flags the cases on the matrix it holds.
          const result = workspace.identifyOutliers({
            variables: body.variables,
            percentiles: body.percentiles,
            indicators: body.indicators === true,
          })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/missing': {
          // MVA and RMV are not in PSPP 2.1.3; both are computed from the held
          // matrix so the analysis never disagrees with the tables around it.
          const mode = body.mode === 'replace' ? 'replace' : 'analyze'
          const result = mode === 'replace'
            ? workspace.replaceMissingValues({ variables: body.variables, method: body.method, span: body.span })
            : workspace.missingAnalysis({
              variables: body.variables,
              univariate: body.univariate,
              patterns: body.patterns,
            })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/flip': {
          const result = await workspace.flip({ force: body.force === true })
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/history': {
          const result = body.action === 'redo' ? workspace.redo() : workspace.undo()
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/find': {
          const result = workspace.find(body.query, body.options ?? body)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/replace': {
          const result = workspace.replace(body.find, body.replace, body.options ?? body)
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        case 'api/convert': {
          const result = await workspace.convert(body.path, { path: body.source })
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/previewImport': {
          if (!body.path) throw new Error('a file path is required')
          const result = await workspace.previewImport(body.path, body.options ?? {})
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/sheets': {
          if (!body.path) throw new Error('a file path is required')
          const result = await workspace.listSheets(body.path)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/upload': {
          const result = await workspace.saveUpload(body.name, body.data)
          sendJson(res, 200, { ok: true, result })
          return
        }
        case 'api/clear': {
          sendJson(res, 200, { ok: true, result: await workspace.clearOutput(), state: workspace.state() })
          return
        }
        case 'api/output': {
          const result = body.action === 'remove'
            ? workspace.removeOutput(body.id)
            : await workspace.clearOutput()
          sendJson(res, 200, { ok: true, result, state: workspace.state() })
          return
        }
        default:
          sendJson(res, 404, { ok: false, error: `unknown route: ${route}` })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message })
    }
  }
}

export { createReadStream }
