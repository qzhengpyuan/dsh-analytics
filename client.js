/* eslint-disable react/prop-types */
/**
 * Client half: an SPSS-style workbench registered as a better-sidebar tab.
 * Everything talks to the Host half through /analytics/api, which is the
 * same surface the agent tools drive.
 */
window.__ModuleLoader__.load({
  id: 'dsh-analytics-pspp',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

    // ── language ───────────────────────────────────────────────────────────────
    // The panel is written in Chinese, and every Chinese string it shows doubles
    // as its own translation key. The English dictionary arrives from the host
    // (`api/locale`) and is applied inside the element factory below: that is the
    // one place all text passes through, so the ~750 strings did not each need a
    // t() call at the call site.
    //
    // Strings without a Chinese character (numbers, PSPP's own English output,
    // paths) return untouched, and results are memoised because a data grid asks
    // a few thousand times per frame.
    let DICT = null
    let DICT_TEMPLATES = []
    let LANG = 'zh'
    const TR_CACHE = new Map()
    // Templates whose capture is one of our own sentences, not user data: a
    // variable called 保存 must not turn into "Save" in the English panel.
    const RECURSIVE_TEMPLATES = new Set(['{0}：不可估（{1}）'])
    // Help → 快捷键一览. Only what the panel really binds: a help page that lists
    // keys nobody implemented is worse than none.
    const SHORTCUTS = [
      { title: '菜单', rows: [['Alt+F / E / V / D / T / A / G / U / S / H', '打开对应菜单'], ['↑ ↓ / ← →', '在菜单项之间移动'], ['Esc', '关闭菜单']] },
      { title: '语法编辑器', rows: [['Ctrl+Space', '打开补全列表'], ['Enter / Tab', '接受选中的补全'], ['↑ ↓', '在补全列表里移动'], ['Esc', '关闭补全列表']] },
      { title: '数据视图', rows: [['Ctrl+C / Ctrl+X / Ctrl+V', '复制 / 剪切 / 粘贴单元格'], ['Delete', '清除选中的单元格'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'], ['方向键 / Tab / Enter', '在单元格之间移动']] },
      { title: '变量视图', rows: [['Shift 点击', '连选一段变量'], ['Ctrl 点击', '加选或取消一个变量'], ['右键', '批量修改、移动、删除']] },
      { title: '运行与输出', rows: [['Ctrl+Enter', '运行语法编辑器里的语法'], ['Alt+1 … Alt+4', '切到数据 / 变量 / 语法 / 输出']] },
    ]

    const TRANSLATED_PROPS = ['title', 'placeholder', 'aria-label', 'alt']

    function setDictionary(strings) {
      DICT = strings && typeof strings === 'object' ? strings : null
      DICT_TEMPLATES = DICT
        ? Object.entries(DICT)
          .filter(([key, value]) => /\{\d+\}/.test(key) && typeof value === 'string' && /\{\d+\}/.test(value))
          .map(([key, value]) => {
            const parts = key.split(/\{\d+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            const literal = key.replace(/\{\d+\}/g, '').length
            return { key, pattern: new RegExp(`^${parts.join('(.+?)')}$`), value, literal }
          })
          // Sort by how much literal text the key carries, not by the length of
          // the generated regex: `{0}：{1}` is long as a pattern but says nothing,
          // and it used to shadow `拆分：{0}` and friends, producing "拆分: grp".
          .sort((a, b) => b.literal - a.literal)
        : []
      TR_CACHE.clear()
    }

    // Whole-string lookup first; then `{0}` templates for the labels that carry
    // a number or a variable name; then the "✓ " a checked menu item carries.
    // There is deliberately no "replace every key found inside the text" step:
    // on long sentences it produced mixed text (`Homogeneity of variance test的
    // p < 0.001…`), which reads worse than leaving the sentence in Chinese.
    function tr(text, ...args) {
      if (typeof text !== 'string' || text === '') return text
      let out = text
      if (DICT) {
        const cached = TR_CACHE.get(text)
        if (cached !== undefined) out = cached
        else {
          out = translateOne(text)
          TR_CACHE.set(text, out)
        }
      }
      // `{0}` style templates work in both languages: English comes from the
      // dictionary, Chinese is the template filled in place.
      if (args.length === 0) return out
      return out.replace(/\{(\d+)\}/g, (whole, index) => (args[Number(index)] === undefined ? whole : String(args[Number(index)])))
    }

    function translateOne(text, depth = 0) {
      const exact = DICT[text]
      if (typeof exact === 'string') return exact
      if (!/[\u4e00-\u9fff]/.test(text) || text.length > 600) return text
      // Both the checked marker and the collapsed marker ride in front of an
      // otherwise translatable label; peel them off instead of failing the match.
      const marked = /^([✓▸▾]\s*)(.*)$/.exec(text)
      if (marked) return `${marked[1]}${translateOne(marked[2], depth)}`
      for (const { key, pattern, value } of DICT_TEMPLATES) {
        const match = pattern.exec(text)
        if (!match) continue
        // Only templates whose capture is one of our own sentences recurse; a
        // capture is usually user data (a variable called 保存 became "Save").
        const pieces = match.slice(1).map((piece) => (RECURSIVE_TEMPLATES.has(key) && depth < 3 ? translateOne(piece, depth + 1) : piece))
        return value.replace(/\{(\d+)\}/g, (whole, index) => pieces[Number(index)] ?? whole)
      }
      return text
    }

    function mapText(child) {
      if (typeof child === 'string') return tr(child)
      if (Array.isArray(child)) return child.map(mapText)
      return child
    }

    // Wrapper, not an alias: text children and the handful of text props are
    // translated on the way in, everything else goes to React unchanged.
    function h(type, props, ...children) {
      let next = props
      // Data values, variable names and labels are content, not interface: the
      // dictionary has short Chinese keys such as 保存/缺失/总计, so running a
      // data cell through tr() turns a value into a menu label. `translate:false`
      // switches the walk off for that subtree.
      const keepText = props?.translate === false
      if (props && props.translate !== undefined) {
        next = { ...props }
        delete next.translate
      }
      if (props && DICT && !keepText) {
        for (const key of TRANSLATED_PROPS) {
          if (typeof props[key] === 'string') {
            if (next === props) next = { ...props }
            next[key] = tr(props[key])
          }
        }
      }
      if (children.length === 0) return React.createElement(type, next)
      return React.createElement(type, next, ...children.map(keepText ? (child) => child : mapText))
    }

    // One timestamp, one format, wherever it is shown: the panel used to call
    // toLocaleString('zh-CN') while the Word/Excel/HTML exports wrote
    // "2026-11-16 13:20", so the same provenance line looked different in the
    // two places — and stayed in the zh-CN layout even in an English panel.
    function formatWhen(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    // The 编辑 menu lives in the panel, but copy/cut/paste/clear belong to the
    // data grid (only it knows the selected rectangle). Rather than thread a
    // ref through three components, the grid publishes a tiny command table and
    // the menu calls into whichever grid is on screen.
    let GRID_COMMANDS = null

    function gridCommand(name, payload) {
      const sink = GRID_COMMANDS
      if (!sink || typeof sink[name] !== 'function') return false
      return sink[name](payload) !== false
    }

    const API_BASE = '/analytics/'
    const apiUrl = (path) => new URL(API_BASE + path, document.baseURI).toString()

    // The open panel tells the host where the conversation lives, so relative
    // paths and the file dialogs resolve against the session, not the server.
    let ACTIVE_CWD

    // Names this panel instance to the host. Two panels can show one workspace
    // (the left column's launcher and a Session's tab both open the same
    // docId), each with its own rows and undo stack: without a name the second
    // writer silently wins and the first one never learns its grid is stale.
    // Which window is this? Kept in localStorage so the same browser keeps the
    // same name across reloads (a fresh name every time made "another window"
    // impossible to tell apart from "me, five minutes ago"), plus a per-tab
    // suffix so two windows of that browser are still distinct.
    const WRITER = (() => {
      let base = ''
      try { base = localStorage.getItem('ap.writerBase') ?? '' } catch { /* private mode */ }
      if (!/^panel-[a-z0-9]{6,12}$/.test(base)) {
        base = `panel-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`
        try { localStorage.setItem('ap.writerBase', base) } catch { /* private mode */ }
      }
      return `${base}-${Math.random().toString(36).slice(2, 6)}`
    })()
    // The revision this panel last saw. Writes carry it so the host can refuse a
    // change made on top of data this window has not read.
    const REVISION_GUARDED = new Set([
      'api/cell', 'api/paste', 'api/case', 'api/variable', 'api/run', 'api/sort',
      'api/flip', 'api/restructure', 'api/merge', 'api/missing', 'api/replace',
      'api/mrset', 'api/valuelabels', 'api/duplicates', 'api/outliers',
    ])
    let KNOWN_REVISION = null

    // A hung request used to freeze the panel for good: the poll skipped while
    // busy and never ran again. Every call gets a deadline instead.
    const API_TIMEOUT_MS = 180000

    async function api(path, body) {
      const base = body !== undefined && ACTIVE_CWD && body.cwd === undefined
        ? { ...body, cwd: ACTIVE_CWD }
        : body
      // Every POST names the panel that sent it; the host records it on writes
      // so the other window can be told that its copy is stale.
      const named = base !== undefined && base && typeof base === 'object' && base.sessionId !== undefined
      const payload = named
        ? {
          ...base,
          writer: WRITER,
          ...(KNOWN_REVISION !== null && REVISION_GUARDED.has(path) && base.baseRevision === undefined && base.force !== true
            ? { baseRevision: KNOWN_REVISION }
            : {}),
        }
        : base
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
      let response
      try {
        response = await fetch(apiUrl(path), {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          credentials: 'same-origin',
          signal: controller.signal,
          body: body === undefined ? undefined : JSON.stringify(payload),
        })
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(tr('请求超时（{0} 秒没有回复）：宿主可能正忙，稍后再试', Math.round(API_TIMEOUT_MS / 1000)))
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
      const text = await response.text()
      let value
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200) || `request failed (${response.status})`)
      }
      if (!response.ok || value?.ok === false) {
        const error = new Error(value?.error ?? `request failed (${response.status})`)
        if (value && typeof value.conflict === 'object' && value.conflict) error.conflict = value.conflict
        if (value && typeof value.state === 'object' && value.state) error.state = value.state
        // A conflict is the one error the user can answer: 覆盖 re-sends this
        // very request with force, so the button needs the request itself, not
        // a copy of the values it happened to carry.
        if (error.conflict && body !== undefined) {
          error.retry = () => api(path, { ...body, force: true })
        }
        // The losing state is the true one: a retry has to be based on it.
        if (error.state && Number.isFinite(Number(error.state.revision))) KNOWN_REVISION = Number(error.state.revision)
        throw error
      }
      // Every answer that carries a state keeps this panel's idea of the
      // revision fresh, so the next write is checked against what it has
      // actually read rather than against the previous render.
      const answered = value?.state ?? value?.result?.state
      if (answered && Number.isFinite(Number(answered.revision))) KNOWN_REVISION = Number(answered.revision)
      return value
    }

    /**
     * The workspace state out of an API answer.
     *
     * The host wraps it (`{ ok: true, state: {…} }`). A panel driven from a test
     * stub, or a host that grows a different envelope, may hand the state itself;
     * accepting both costs one line and stops a whole panel from painting
     * "尚未打开数据集" while the data was right there in the response.
     */
    /**
     * Should this panel announce that somebody else changed the data?
     *
     * Two panels can show one workspace (the left column's launcher and a
     * Session's tab name the same docId); each keeps its own rows and undo
     * stack, so a write by one silently invalidates the other. Returns the text
     * to show, or null when this state is the panel's own write (or the first
     * one it has seen, which is not news).
     */
    function foreignWriteNotice(previous, next, selfWriter) {
      if (!next || typeof next !== 'object') return null
      if (!previous || previous.revision === null || previous.revision === undefined) return null
      const revision = Number(next.revision ?? 0)
      const lastWriter = typeof next.lastWriter === 'string' ? next.lastWriter : null
      if (revision === Number(previous.revision)) return null
      // No name means a tool call (or a client that does not identify itself):
      // the numbers changed under this window all the same.
      if (!lastWriter) return '数据已被对话里的分析改写：已载入最新内容'
      if (lastWriter === selfWriter) return null
      return '数据已被另一个窗口修改：已载入最新内容，正在编辑的格子请重新确认'
    }

    function stateOf(value) {
      if (value && typeof value === 'object') {
        if (value.state && typeof value.state === 'object') return value.state
        if (Array.isArray(value.items) && value.dataset) return value
      }
      throw new Error('宿主返回的数据形状不认识：需要 { ok:true, state:{…} }，或者直接给状态对象')
    }

    // Sidebar tabs mint their own workspace ids; a module-level counter keeps
    // two tabs from picking the same suffix.
    /**
     * Give a bottom-workbench PSPP tab the name of the file it loaded.
     *
     * Several tabs each own a dataset, so four tabs called "PSPP" is how a user
     * edits the wrong one. The primary tab keeps the plugin's own title, and a
     * failure here must never fail the open: the tab strip is decoration.
     */
    function renameDocTab(service, docId, baseSessionId, datasetName) {
      if (!datasetName || docId === baseSessionId) return false
      if (typeof service?.updateTab !== 'function') return false
      try {
        service.updateTab(`analytics:${docId}`, { title: String(datasetName) })
        return true
      } catch {
        return false
      }
    }

    let DOC_SEQ = 1

    const CSS = `.ap-prov {
  font-size: 11px;
  color: var(--ap-text-3);
  background: var(--ap-surface-2);
  border-radius: 9px;
  padding: 1px 8px;
  margin-left: 6px;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: help;
}
.ap-root {
  /* Every colour below resolves through the harness design tokens and falls
     back to the old SPSS-like literals, so a skin or the dark theme applies to
     this panel without any theme-specific code here. Tokens live on <body>
     (light) and body[data-ds-dark-theme]; reading them is enough to follow. */
  --ap-bg: var(--dsw-alias-bg-base, #eef0f3);
  --ap-panel: var(--dsw-alias-bg-base, #fff);
  /* The harness layers (--dsw-alias-bg-layer-1..3) are the same colour in
     several themes — the dark one is #0A0A0A for all four — so chrome is tinted
     from the text colour instead: visible in both schemes, and it cannot
     alternate the way the layer tokens did. */
  --ap-surface: color-mix(in srgb, var(--ap-text) 5%, var(--ap-panel));
  --ap-surface-2: color-mix(in srgb, var(--ap-text) 8%, var(--ap-panel));
  --ap-bar: color-mix(in srgb, var(--ap-text) 6%, var(--ap-panel));
  --ap-head: color-mix(in srgb, var(--ap-text) 10%, var(--ap-panel));
  --ap-head-2: color-mix(in srgb, var(--ap-text) 7%, var(--ap-panel));
  /* The border tokens are deliberately faint (4–12% black); a data grid needs
     the visible rules the SPSS look has, so the four levels are mixed from the
     text colour at increasing strength — same appearance in light, correct in
     dark, and a skin cannot make the grid disappear. */
  --ap-line: color-mix(in srgb, var(--ap-text) 12%, var(--ap-panel));
  --ap-line-2: color-mix(in srgb, var(--ap-text) 20%, var(--ap-panel));
  --ap-line-3: color-mix(in srgb, var(--ap-text) 28%, var(--ap-panel));
  --ap-line-4: color-mix(in srgb, var(--ap-text) 45%, var(--ap-panel));
  --ap-text: var(--dsw-alias-label-primary, #111);
  --ap-text-2: var(--dsw-alias-label-secondary, #555);
  --ap-text-3: var(--dsw-alias-label-tertiary, #8f96a3);
  --ap-accent: var(--dsw-alias-brand-primary, #2f6fbb);
  --ap-danger: var(--dsw-alias-state-error-primary, #b42318);
  /* SPSS 26's menu / tree selection tint, falling back to the harness hover
     token. The dark scheme overrides both below with text/accent mixes, so no
     light-only literal can leak into the dark theme. */
  --ap-hover: var(--dsw-alias-interactive-bg-hover, #d6e6f7);
  --ap-select: #cce8ff;
  /* A selected cell and the row stripe must stay readable in both schemes, so
     derive them from the accent/text instead of naming a fixed tint. */
  --ap-selected: color-mix(in srgb, var(--ap-accent) 18%, var(--ap-panel));
  --ap-stripe: color-mix(in srgb, var(--ap-text) 4%, var(--ap-panel));
  --ap-shadow: var(--dsw-elevation-panel, 0 6px 18px rgba(0,0,0,.18));
  --ap-shadow-strong: var(--dsw-elevation-prominent, 0 14px 40px rgba(0,0,0,.35));
  /* Older rules read these three names while nothing defined them; aliasing
     them here is cheaper than chasing every use, and keeps one source. */
  --ap-muted: var(--ap-text-3);
  --ap-button: var(--ap-surface);
  --ap-head-1: var(--ap-head);
  --ap-line-subtle: var(--ap-line);
}

/* Dark scheme: SPSS has no dark mode, but every tint above has to stay legible
   on the harness dark surface, so the two literals become mixes of the text and
   accent colours — the same recipe the panel already uses for its borders. */
body[data-ds-dark-theme] .ap-root {
  --ap-hover: color-mix(in srgb, var(--ap-text) 8%, var(--ap-panel));
  --ap-select: color-mix(in srgb, var(--ap-accent) 25%, var(--ap-panel));
}

.ap-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--ap-bg);
  color:var(--ap-text);
  /* SPSS 26 body text: 12px Segoe UI, CJK falls back to YaHei / Noto. */
  font-family:"Segoe UI","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
  font-size:12px; line-height:1.45; }
.ap-root * { box-sizing:border-box; }
/* Colours come from the harness design tokens (--dsw-alias-*), so switching
   the skin or the dark theme restyles this panel too; the literals are the
   pre-theme fallbacks. */
.ap-root button, .ap-root input, .ap-root textarea, .ap-root select { color:var(--ap-text); font:inherit; }
/* ── 菜单栏：24px 高，项 8px 内边距，悬停用 --ap-hover ─────────────────── */
.ap-menu { display:flex; align-items:stretch; gap:0; height:24px; background:var(--ap-surface);
  border-bottom:1px solid var(--ap-line-3); padding:0 2px; flex:none; }
/* 注意：菜单栏不能 overflow:hidden —— 下拉菜单是它的绝对定位子节点，剪掉就点不开了。*/
.ap-menu-item { position:relative; display:flex; }
.ap-menu-button { background:none; border:0; height:24px; padding:0 8px; font:inherit; color:var(--ap-text);
  cursor:default; border-radius:0; }
.ap-menu-button:hover, .ap-menu-button.ap-open { background:var(--ap-hover); }
.ap-menu-pop.ap-flip { left:auto; right:0; }
.ap-menu-pop { position:absolute; top:100%; left:0; min-width:220px; background:var(--ap-panel); border:1px solid var(--ap-line-2);
  box-shadow:2px 2px 2px color-mix(in srgb, var(--ap-text) 22%, transparent); padding:2px 0; z-index:40; }
/* 22px 行高；快捷键靠右、灰字（renderMenuItems 把「（Ctrl+Z）」拆进 .ap-keys） */
.ap-menu-pop button { display:flex; width:100%; align-items:center; justify-content:space-between; gap:16px;
  background:none; border:0; text-align:left; min-height:22px; line-height:22px; padding:0 12px; font:inherit; cursor:default; }
.ap-menu-pop button:hover { background:var(--ap-hover); }
.ap-menu-pop .ap-keys { margin-left:auto; color:var(--ap-text-3); font-size:11px; white-space:nowrap; }
.ap-menu-pop .ap-sep { height:1px; background:var(--ap-line); margin:4px 0; }
.ap-menu-pop .ap-sub { color:var(--ap-text-2); font-size:11px; }
.ap-check { display:flex; align-items:center; gap:6px; margin-top:6px; font-size:12px; }
.ap-drop { position:absolute; inset:0; z-index:60; background:color-mix(in srgb, var(--ap-accent) 14%, transparent);
  border:2px dashed var(--ap-accent); display:flex; align-items:center; justify-content:center;
  color:var(--ap-text); font-size:13px; pointer-events:none; }
.ap-grid-wrap { user-select:none; -webkit-user-select:none; }
.ap-grid input, .ap-grid select, .ap-cell-input { user-select:text; -webkit-user-select:text; }
.ap-grid th { position:relative; }
.ap-col-resize { position:absolute; top:0; right:-2px; width:8px; height:100%; cursor:col-resize; z-index:3; }
.ap-grid th:hover .ap-col-resize { background:var(--ap-line-2); opacity:.9; }
.ap-cell-selected { background:var(--ap-selected); }
.ap-doctabs { display:flex; align-items:stretch; gap:2px; padding:2px 4px 0; flex:none; overflow-x:auto;
  background:var(--ap-bar); border-bottom:1px solid var(--ap-line-3); }
.ap-doctab { display:flex; align-items:center; gap:4px; padding:2px 8px; border:1px solid var(--ap-line-3);
  border-bottom:0; border-radius:3px 3px 0 0; background:var(--ap-surface); cursor:default;
  max-width:230px; white-space:nowrap; font-size:11px; }
.ap-doctab.ap-active { background:var(--ap-panel); font-weight:600; }
.ap-doctab-title { border:0; background:none; padding:0; margin:0; font:inherit; color:inherit;
  cursor:default; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ap-doctab-close { border:0; background:none; padding:0 2px; font:inherit; line-height:1; cursor:default;
  color:var(--ap-text-2); }
.ap-doctab-close:hover { color:var(--ap-danger); }
/* ── 工具条：30px 高、按钮 24×24（文字按钮按内容放宽）、悬停内凹 1px ──── */
.ap-toolbar { display:flex; align-items:center; gap:1px; padding:3px 4px; min-height:30px; background:var(--ap-bar);
  border-bottom:1px solid var(--ap-line-3); flex:none; flex-wrap:wrap; }
.ap-tool { display:inline-flex; align-items:center; justify-content:center; gap:4px; height:24px; min-width:24px;
  background:transparent; border:1px solid transparent; border-radius:2px; padding:0 8px; font:inherit;
  color:var(--ap-text); cursor:default; white-space:nowrap; }
.ap-tool:hover { background:var(--ap-panel); border-color:var(--ap-line-2);
  box-shadow:inset 1px 1px 0 var(--ap-line), inset -1px -1px 0 var(--ap-line); }
.ap-tool:active { box-shadow:inset 1px 1px 2px color-mix(in srgb, var(--ap-text) 30%, transparent); }
.ap-tool:disabled { opacity:.45; }
/* 图标按钮：SPSS 的工具栏只有图，字在 title 里（也是读屏名） */
.ap-icon-btn { width:26px; min-width:26px; padding:0; }
.ap-icon { flex:none; display:block; }
/* 按钮之间的 1px 分隔竖线（原来用写死 #b7bcc5 的行内 span，深色下是白点） */
.ap-tool-sep { flex:none; width:1px; height:16px; background:var(--ap-line-2); margin:0 3px; align-self:center; }
/* ── 视图页签：移到内容区下方，26px，选中白底 ─────────────────────────── */
.ap-tabstrip { display:flex; align-items:flex-end; gap:2px; padding:2px 6px 0; height:26px; background:var(--ap-surface-2);
  border-top:1px solid var(--ap-line-2); flex:none; overflow:hidden; }
.ap-view-tab { height:24px; padding:0 12px; border:1px solid var(--ap-line-2); border-bottom:0; border-radius:0;
  background:var(--ap-surface); color:var(--ap-text-2); cursor:default; font-size:12px; }
.ap-view-tab.ap-active { background:var(--ap-panel); color:var(--ap-text); font-weight:600;
  border-top:1px solid var(--ap-line-3); box-shadow:0 -1px 0 var(--ap-panel); }
.ap-body { flex:1; min-height:0; background:var(--ap-panel); border-top:1px solid var(--ap-line-2); display:flex; flex-direction:column; }
/* ── 状态栏：22px，左「N 个个案 · M 个变量」，右引擎 ─────────────────── */
.ap-status { flex:none; display:flex; align-items:center; gap:10px; height:22px; padding:0 8px;
  border-top:1px solid var(--ap-line-3); background:var(--ap-bar); color:var(--ap-text);
  font-size:11px; white-space:nowrap; overflow:hidden; }
.ap-status .ap-grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ap-status .ap-status-cases { flex:none; font-variant-numeric:tabular-nums; }
.ap-status .ap-status-right { flex:0 1 auto; display:flex; align-items:center; gap:8px; color:var(--ap-text-2);
  min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ap-status .ap-status-right > * { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ap-status .ap-status-version { color:var(--ap-text-3); font-variant-numeric:tabular-nums; cursor:default; }
/* A refused write is not a warning that goes away: the count stays for as long
   as the data does, and the title says where the detail lives. */
.ap-status .ap-status-conflicts { color: var(--ap-danger); font-variant-numeric:tabular-nums; cursor:default; }
.ap-status .ap-chip { height:16px; font-size:11px; }
.ap-chip { display:inline-flex; align-items:center; gap:4px; padding:0 6px; border:1px solid var(--ap-line-4);
  border-radius:9px; background:var(--ap-button); color:var(--ap-text); height:16px; line-height:16px; }
.ap-chip .ap-chip-x { cursor:pointer; opacity:.7; font-weight:700; }
.ap-chip .ap-chip-x:hover { opacity:1; }

.ap-grid-wrap { flex:1; min-height:0; overflow:auto; background:var(--ap-panel); }
.ap-grid { border-collapse:collapse; table-layout:fixed; font-family:inherit; font-size:inherit; }
.ap-grid td.ap-spacer { height:auto; min-height:0; padding:0; border:0; line-height:0; }
/* 视图 → 网格线 off: keep the table structure, drop the ruling. */
.ap-grid.ap-nogrid th, .ap-grid.ap-nogrid td { border-color: transparent; }
.ap-grid th, .ap-grid td { border-right:1px solid var(--ap-line); border-bottom:1px solid var(--ap-line); padding:1px 6px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; height:max(22px, 1.7em); }
.ap-grid thead th { position:sticky; top:0; z-index:2; background:var(--ap-head); font-weight:600; text-align:center;
  border-bottom:1px solid var(--ap-line-4); }
/* 表头两行：上面变量名，下面变量标签（SPSS 数据编辑器的样子），行高按内容长 */
.ap-grid thead th .ap-head-name { display:block; line-height:1.25; }
.ap-grid thead th .ap-head-label { display:block; font-weight:400; font-size:10px; line-height:1.2;
  color:var(--ap-text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ap-grid thead th:has(.ap-head-label) { height:auto; padding-top:1px; padding-bottom:1px; }
.ap-grid-wrap.ap-freeze-rows-false thead th { position:static; }
.ap-grid th.ap-freeze-col, .ap-grid td.ap-freeze-col { position:sticky; left:var(--ap-freeze-x, 52px); }
.ap-grid th.ap-freeze-col { z-index:2; background:var(--ap-head); }
.ap-grid td.ap-freeze-col { z-index:1; background:var(--ap-panel); }
.ap-grid td.ap-freeze-col.ap-sel { background:var(--ap-selected); }
.ap-grid tbody tr.ap-striped td.ap-freeze-col { background:var(--ap-stripe); }
.ap-grid .ap-rownum { position:sticky; left:0; z-index:1; background:var(--ap-head-2); color:var(--ap-text-2); text-align:right;
  width:52px; min-width:52px; }
.ap-grid thead .ap-rownum { z-index:3; }
/* The row number is pinned harder than the first data column: it always sits
   at left 0, while that column sticks at the row number's width. Both are
   sticky, and without this the column rule would push the numbers aside. */
.ap-grid td.ap-rownum { left:0; }
.ap-grid td.ap-num { text-align:right; font-variant-numeric:tabular-nums; }
.ap-grid td.ap-left { text-align:left; }
.ap-grid td.ap-center { text-align:center; }
.ap-grid td.ap-sel, .ap-grid td.ap-sel:focus { outline:2px solid var(--ap-accent); outline-offset:-2px; background:var(--ap-selected); }
/* The rectangle's fill has to out-rank the zebra rule, which is more specific. */
.ap-grid td.ap-cell-selected { background:var(--ap-selected); }
/* Absorbs the width the columns do not use, so the grid reaches the right
   edge without stretching the row numbers. */
.ap-grid .ap-filler { border-right:0; padding:0; background:var(--ap-panel); }
.ap-grid th.ap-spare-head { background:var(--ap-head-2); cursor:cell; }
.ap-grid th.ap-spare-head:hover { background:var(--ap-head-1); }
.ap-grid td.ap-spare { cursor:cell; background:var(--ap-panel); }
.ap-grid td.ap-spare:hover { background:var(--ap-hover); }
.ap-grid td.ap-spare-num { color:var(--ap-text-3); }
.ap-grid tbody tr.ap-striped td.ap-cell-selected { background:var(--ap-selected); }
.ap-grid tbody tr.ap-striped td { background:var(--ap-stripe); }
/* The blank rows below the data are not cases: a striped one reads as a real
   empty case wedged between two filled ones. */
.ap-grid tbody tr.ap-blank-row td { background:var(--ap-panel); }
.ap-grid tbody tr.ap-blank-row td.ap-spare:hover { background:var(--ap-hover); }
.ap-grid td.ap-hover { background:var(--ap-hover); }
.ap-grid tbody tr.ap-striped td.ap-sel { background:var(--ap-selected); }
.ap-cell-input { width:100%; border:0; outline:2px solid var(--ap-accent); font:inherit; padding:0 4px; }

.ap-pane { flex:1; min-height:0; display:flex; }
.ap-syntax { flex:1; display:flex; flex-direction:column; min-height:0; }
.ap-code { flex:1; display:flex; min-height:0; border-top:1px solid var(--ap-line); background:var(--ap-panel); }
.ap-gutter { flex:none; overflow:hidden; padding:8px 6px 8px 8px; text-align:right; user-select:none;
  color:var(--ap-text-3); background:var(--ap-surface-2); border-right:1px solid var(--ap-line);
  font-family:var(--dsh-font-family-code, "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace);
  font-size:var(--dsh-code-font-size, 12.5px); line-height:1.6; }
.ap-gutter-line { min-height:1.6em; }
.ap-code-box { position:relative; flex:1; min-width:0; }
.ap-complete { position:absolute; right:12px; bottom:10px; z-index:6; min-width:200px; max-width:320px;
  background:var(--ap-panel); border:1px solid var(--ap-line); border-radius:4px; box-shadow:0 6px 18px rgba(0,0,0,.18);
  font-family:var(--dsh-font-family-code, "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace); font-size:12.5px;
  overflow:hidden; }
.ap-complete-item { display:flex; justify-content:space-between; gap:12px; padding:3px 8px; cursor:pointer; }
.ap-complete-item:hover { background:var(--ap-surface-2); }
.ap-complete-item.ap-active { background:var(--ap-selected); }
.ap-complete-name { color:var(--ap-text); }
.ap-complete-kind { color:var(--ap-text-3); font-size:11.5px; }
.ap-complete-hint { padding:3px 8px; border-top:1px solid var(--ap-line); color:var(--ap-text-3); font-size:11px; }
.ap-code-hl, .ap-code-input { position:absolute; inset:0; margin:0; border:0; padding:8px 10px; overflow:auto;
  font-family:var(--dsh-font-family-code, "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace);
  font-size:var(--dsh-code-font-size, 12.5px); line-height:1.6; white-space:pre; tab-size:2; }
.ap-code-hl { pointer-events:none; color:var(--ap-text); background:var(--ap-panel); overflow:hidden; }
.ap-code-input { resize:none; outline:none; background:transparent; color:transparent; caret-color:var(--ap-accent);
  -webkit-text-fill-color:transparent; }
.ap-code-input::selection { background:var(--ap-selected); }
.ap-code-input::placeholder { color:var(--ap-text-3); -webkit-text-fill-color:var(--ap-text-3); }
.ap-hl-cmd { color:var(--ap-accent); font-weight:600; }
.ap-hl-sub { color:#8a5a00; font-weight:600; }
.ap-hl-str { color:#1a7f37; }
.ap-hl-num { color:#8250df; }
.ap-hl-com { color:var(--ap-text-3); font-style:italic; }
/* The three colours above assume a light sheet; lift them on a dark one. */
body[data-ds-dark-theme] .ap-hl-sub { color:#e0b25e; }
body[data-ds-dark-theme] .ap-hl-str { color:#8fce8f; }
body[data-ds-dark-theme] .ap-hl-num { color:#c3a6e8; }
.ap-syntax-bar { display:flex; gap:6px; padding:4px 6px; background:var(--ap-surface-2); border-top:1px solid var(--ap-line); }

/* ── 输出：左大纲 190px / 右内容，树选中用系统选中蓝 ────────────────── */
.ap-output { position:relative; flex:1; display:flex; min-height:0; }
.ap-outline { width:190px; min-width:150px; border-right:1px solid var(--ap-line); overflow:auto; background:var(--ap-surface-2); }
.ap-output-grid { display:grid; grid-template-columns:auto 1fr; grid-template-rows:auto 1fr; }
.ap-report-bar { grid-column:1 / -1; grid-row:1; display:flex; align-items:center; gap:6px; padding:3px 8px;
  background:var(--ap-surface-2); border-bottom:1px solid var(--ap-line-2); }
.ap-outline-resize { flex:none; width:6px; margin-left:-3px; cursor:col-resize; }
.ap-outline-resize:hover { background:var(--ap-line-2); }
.ap-outline button { display:block; width:100%; text-align:left; border:0; background:none; font:inherit;
  padding:2px 8px; color:var(--ap-text); cursor:default; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ap-outline button:hover { background:var(--ap-hover); }
/* SPSS 的导航树选中项：浅色 #cce8ff / 深色 25% 强调混色，均经 --ap-select */
.ap-outline button.ap-ol-active { background:var(--ap-select); color:var(--ap-text); }
.ap-outline button.ap-ol-active:hover { background:var(--ap-select); }
.ap-outline .ap-ol-table::before { content:"▦ "; color:var(--ap-accent); }
.ap-outline .ap-ol-image::before { content:"▣ "; color:var(--ap-accent); }
.ap-outline .ap-ol-heading { font-weight:600; padding:6px 8px 2px; color:var(--ap-text); }
/* 每次运行的分组标题：SPSS 输出树按过程分组，这里按 run 分组 */
.ap-outline .ap-ol-run { padding:5px 8px 1px; font-size:11px; font-weight:600; letter-spacing:.04em;
  color:var(--ap-text-3); text-transform:none; border-top:1px solid var(--ap-line-3); }
.ap-outline > .ap-ol-run:first-child { border-top:0; }
/* 运行分组：标题一行，右侧两个小动作（插语法 / 重跑）。动作只在悬停该行时出现。 */
.ap-outline .ap-ol-run { display:flex; align-items:center; gap:4px; }
.ap-outline .ap-run-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ap-outline .ap-run-tool { border:0; background:none; font:inherit; font-size:10px; color:var(--ap-text-3);
  padding:0 3px; margin-left:0; width:auto; display:none; cursor:default; border-radius:3px; }
.ap-outline .ap-ol-run:hover .ap-run-tool { display:inline-block; }
.ap-outline .ap-run-tool:hover { background:var(--ap-hover); color:var(--ap-accent); }
/* 工具栏提示：SPSS 那种第一个延迟、接着立即切换的提示（原生 title 做不到定时） */
/* 固定的深底浅字：皮肤里的 --ap-panel 可能是半透明的，用 color-mix 算出来的
   文字色会跟着变透明，于是提示与背景同色、什么都看不见。 */
.ap-tip { position:fixed; transform:translateX(-50%); z-index:60; pointer-events:none;
  background:#232323; color:#f7f7f7; text-shadow:none;
  border:1px solid #555; border-radius:3px; padding:2px 7px; font-size:11px;
  white-space:nowrap; box-shadow:1px 2px 4px rgba(0,0,0,.35); }
/* 语法模板库 */
.ap-tmpl { display:flex; flex-direction:column; gap:10px; max-height:52vh; overflow:auto; padding:2px; }
.ap-tmpl-head { font-size:11px; font-weight:600; letter-spacing:.04em; color:var(--ap-text-3); padding:2px 0 3px; }
.ap-tmpl-group { display:flex; flex-direction:column; gap:2px; }
.ap-tmpl-item { display:flex; flex-direction:column; gap:1px; text-align:left; padding:4px 8px;
  border:1px solid transparent; border-radius:4px; background:var(--ap-surface-2); font:inherit; color:var(--ap-text); cursor:default; }
.ap-tmpl-item:hover { border-color:var(--ap-line-2); background:var(--ap-hover); }
.ap-tmpl-label { font-size:12px; }
.ap-tmpl-code { font-family:ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size:10.5px;
  color:var(--ap-text-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* 运行历史 */
.ap-runs { display:flex; flex-direction:column; gap:2px; max-height:52vh; overflow:auto; }
.ap-run-row { display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:4px; }
.ap-run-row:hover { background:var(--ap-hover); }
.ap-run-when { font-size:11px; color:var(--ap-text-3); min-width:52px; font-variant-numeric:tabular-nums; }
.ap-run-title { font-size:12px; max-width:96px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ap-run-syntax { font-family:ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size:10.5px;
  color:var(--ap-text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px; }
.ap-outline .ap-ol-facts { display:block; margin-top:1px; font-size:11px; color:var(--ap-text-3); font-variant-numeric:tabular-nums;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ap-doc { flex:1; overflow:auto; padding:10px 12px 32px; background:var(--ap-panel); }
.ap-doc h3 { font-size:12px; margin:14px 0 6px; color:var(--ap-text); }
.ap-item { margin:0 0 14px; }
.ap-item-head { display:flex; align-items:center; flex-wrap:wrap; row-gap:2px; gap:6px;
  border-bottom:1px solid var(--ap-line); padding-bottom:2px; }
.ap-item-head h3 { margin:0; flex:none; font-size:12px; font-weight:700; }
.ap-item-toggle { border:0; background:none; font:inherit; color:var(--ap-text-3); cursor:default; padding:0 2px; width:14px; }
.ap-item-toggle:hover { color:var(--ap-accent); }
.ap-item-head .ap-grow { flex:1; }
.ap-item-head .ap-tool { font-size:11px; padding:0 6px; height:20px; min-width:0; }
.ap-var-tools { display:flex; gap:6px; padding:4px 6px; background:var(--ap-bar); border-bottom:1px solid var(--ap-line-2); align-items:center; }
.ap-var-tools .ap-tool { flex:none; white-space:nowrap; }
.ap-var-tools th { position:relative; }
.ap-grid th.ap-col-dragging { opacity:.45; }
.ap-grid tbody tr.ap-var-drop td { box-shadow: inset 0 2px 0 var(--ap-accent); }
.ap-grid tbody tr.ap-var-new td { border-top:1px dashed var(--ap-line-2); color:var(--ap-text-3); }
.ap-grid tbody tr.ap-var-new:hover td { background:var(--ap-hover); }
.ap-grid tbody tr.ap-var-sel td { background:var(--ap-selected); color:var(--ap-text); }
.ap-grid tbody tr.ap-var-sel td.ap-rownum { background:color-mix(in srgb, var(--ap-accent) 26%, var(--ap-panel)); color:var(--ap-text-2); }
.ap-grid tbody tr.ap-var-sel input, .ap-grid tbody tr.ap-var-sel select { background:var(--ap-panel); }
.ap-var-menu { min-width:150px; background:var(--ap-panel); border:1px solid var(--ap-line-2); border-radius:4px;
  box-shadow:2px 2px 2px color-mix(in srgb, var(--ap-text) 22%, transparent); padding:3px 0; font-size:12px; }
.ap-var-menu .ap-menu-label { padding:4px 12px; font-size:11px; color:var(--ap-text-3); }
.ap-var-menu .ap-var-item { display:block; width:100%; text-align:left; padding:3px 12px; background:none; border:0; font:inherit; color:var(--ap-text); cursor:default; }
.ap-var-menu .ap-var-item:hover { background:var(--ap-hover); }
.ap-var-menu .ap-var-item.ap-danger { color:var(--ap-danger); }
.ap-var-menu .ap-sep { height:1px; background:var(--ap-line); margin:4px 0; }
/* ── 输出表：SPSS 三线表（外框 1px、表头上下双线、无竖线） ──────────── */
.ap-doc table { border-collapse:collapse; margin:0 0 14px; font-size:12px; width:100%;
  border-top:1px solid var(--ap-line-3); border-bottom:1px solid var(--ap-line-3); }
.ap-doc table td, .ap-doc table th { white-space:normal; word-break:break-word; }
/* 中文表头按「词」换行：宁可整词掉下一行，也不要「次/数」拆成两行 */
.ap-doc table th { word-break:keep-all; }
.ap-doc table caption { caption-side:top; text-align:left; font-weight:700; font-size:12px; padding:0 0 4px; color:var(--ap-text); }
.ap-doc th, .ap-doc td { border:0; border-bottom:1px solid var(--ap-line); padding:3px 6px; text-align:left; }
.ap-doc th, .ap-doc td.ap-num { white-space:nowrap; }
.ap-doc thead th, .ap-doc th { background:var(--ap-head-2); font-weight:600; text-align:center;
  border-top:0; border-bottom:1px solid var(--ap-line-4); }
/* 表头双线：只有每组第一行带 2px 上框（PSPP 的表头行在 thead，本地面板渲染的在裸 tr 里） */
.ap-doc table thead tr:first-child th, .ap-doc table tr:first-child th { border-top:2px solid var(--ap-line-3); }
/* 行标题（频数的「18-25」这类）不是表头：左对齐、不加底色 */
.ap-doc tbody th { background:transparent; font-weight:400; text-align:left; border-bottom:1px solid var(--ap-line); }
/* 数值列右对齐：matrixHtml 给纯数字单元格加 .ap-num */
.ap-doc td.ap-num { text-align:right; font-variant-numeric:tabular-nums; }
.ap-doc img { max-width:100%; border:1px solid var(--ap-line); background:var(--ap-panel); }
.ap-table-wrap { overflow-x:auto; max-width:100%; }
/* 展开的长表按滚动窗口渲染：盒子自己滚，别把整页带走；上下 spacer 行撑起滚动条 */
.ap-tbl-vscroll { overflow:auto; max-height:560px; overscroll-behavior:contain; }
.ap-tbl-vscroll > .ap-tbl-vbody { min-width:100%; }
.ap-tbl-vscroll table { margin-bottom:0; }
.ap-tbl-spacer td { padding:0 !important; border:0 !important; line-height:0; background:transparent; }
/* 打印时把滚动盒撑开：纸上没有滚动条，别只印出一个 520px 的窗口框 */
@media print { .ap-tbl-vscroll { max-height:none !important; overflow:visible !important; } }
/* 大表先画一屏：几千行的频率表全量渲染会让整页变慢，也让浏览器快照大到没法用 */
.ap-table-block { display:flex; flex-direction:column; gap:2px; }
/* 表注：跟着表走，不翻译（里面是变量名和数字） */
.ap-wiz-controls { flex-wrap:wrap; gap:10px; align-items:flex-end; }
.ap-wiz-field { display:flex; flex-direction:column; gap:2px; font-size:11px; color:var(--ap-text-2); }
.ap-wiz-field select, .ap-wiz-field input { font-size:12px; }
.ap-wiz-preview { max-height:260px; overflow:auto; border:1px solid var(--ap-line); border-radius:3px; margin:4px 0 6px; }
.ap-wiz-preview table { border-collapse:collapse; width:100%; font-size:11px; }
.ap-wiz-preview th, .ap-wiz-preview td { border-right:1px solid var(--ap-line); border-bottom:1px solid var(--ap-line); padding:1px 5px; white-space:nowrap; text-align:left; }
.ap-wiz-preview thead th { background:var(--ap-head); position:sticky; top:0; z-index:1; }
.ap-wiz-name { width:92px; font-size:11px; }
.ap-wiz-type { font-size:11px; }
.ap-missing { color:var(--ap-text-3); font-style:italic; }
.ap-notes { list-style:none; margin:2px 0 6px; padding:0; display:flex; flex-direction:column; gap:2px; }
.ap-note { font-size:11px; font-style:italic; color:var(--ap-text-3); line-height:1.45; }
.ap-table-more { display:flex; align-items:center; gap:8px; padding:2px 2px 4px;
  color:var(--ap-text-3); font-size:11px; }
.ap-table-more .ap-tool { font-size:11px; padding:1px 8px; }
.ap-edit-table { display:flex; flex-direction:column; gap:6px; max-height:320px; overflow:auto; }
.ap-edit-row { display:flex; align-items:center; gap:8px; }
.ap-edit-index { width:64px; color:var(--ap-text-3); font-size:12px; }
/* 表注：11px 斜体灰（原来是写死的 #9aa1ad / #444） */
.ap-doc table .ap-footnote, table .ap-footnote { border-top:1px solid var(--ap-line); border-bottom:0; text-align:left;
  color:var(--ap-text-2); font-size:11px; font-style:italic; padding:2px 6px; }
/* Output table presets: the default already is the SPSS three-line table; the
   'three' preset is the heavier journal variant, 'grid' the full-ruled one. */
.ap-doc table.ap-tbl-three { border-top:2px solid var(--ap-text); border-bottom:2px solid var(--ap-text); }
.ap-doc table.ap-tbl-three th, .ap-doc table.ap-tbl-three td { border-left:0; border-right:0; border-top:0;
  border-bottom:1px solid var(--ap-line); }
.ap-doc table.ap-tbl-three thead th { border-bottom:1px solid var(--ap-text); }
.ap-doc table.ap-tbl-plain th, .ap-doc table.ap-tbl-plain td { border-color:transparent; background:transparent; }
.ap-doc table.ap-tbl-grid th, .ap-doc table.ap-tbl-grid td { border:1px solid var(--ap-line); }
.ap-doc table.ap-tbl-grid thead th { border-top:1px solid var(--ap-line); border-bottom:1px solid var(--ap-line); }
.ap-table-tools { display:flex; gap:6px; margin:0 0 3px; }
.ap-table-tools .ap-tool { font-size:11px; height:20px; padding:0 6px; }
.ap-out-hint { position:absolute; right:18px; bottom:14px; background:var(--dsw-alias-tooltip-bg, #1f2b3a); color:var(--dsw-static-neutral-bluish-00, #fff); padding:6px 12px; border-radius:4px; font-size:12px; box-shadow:var(--ap-shadow); }
.ap-chart-button { border:0; background:transparent; padding:0; cursor:zoom-in; display:block; }
.ap-chart-button:hover img { border-color:var(--ap-accent); }
.ap-dlg-var.ap-disabled { color:var(--ap-text-3); }
.ap-chip.ap-chip-on { background:var(--ap-selected); border-color:var(--ap-accent); }
.ap-empty { margin:auto; color:var(--ap-text-2); padding:30px; text-align:center; line-height:2; }
.ap-toast { position:absolute; right:14px; bottom:56px; max-width:70%; background:var(--dsw-alias-tooltip-bg, #1f2a37); color:var(--dsw-static-neutral-bluish-00, #fff);
  padding:7px 12px; border-radius:4px; box-shadow:var(--ap-shadow); z-index:60; }
.ap-has-sub > .ap-sub-pop { display:none; position:absolute; left:100%; top:-4px; min-width:200px;
  background:var(--ap-panel); border:1px solid var(--ap-line-2); box-shadow:2px 2px 2px color-mix(in srgb, var(--ap-text) 22%, transparent); padding:2px 0; z-index:45; }
.ap-has-sub:hover > .ap-sub-pop { display:block; }
.ap-flip .ap-has-sub > .ap-sub-pop { left:auto; right:100%; }
.ap-menu-pop button:disabled { color:var(--ap-text-3); }
/* ── 对话框：520px、13px 加粗标题、页脚 确定/粘贴/重置/取消/帮助 ───────── */
.ap-modal-mask { position:absolute; inset:0; background:var(--dsw-alias-bg-mask-1, rgba(15,20,30,.35)); display:flex; align-items:center;
  justify-content:center; z-index:50; }
.ap-modal { background:var(--ap-surface-2); border:1px solid var(--ap-line-3); border-radius:3px; box-shadow:var(--ap-shadow-strong);
  width:min(520px, calc(100% - 24px)); min-width:0; max-width:none; max-height:86%; display:flex; flex-direction:column; }
.ap-modal-title { padding:5px 10px; background:linear-gradient(var(--ap-surface-2),var(--ap-head-2)); border-bottom:1px solid var(--ap-line-3);
  font-weight:700; font-size:13px; }
.ap-modal-body { padding:10px 12px; overflow:auto; display:flex; flex-direction:column; gap:9px; }
.ap-modal-foot { display:flex; align-items:center; justify-content:flex-end; gap:6px; padding:6px 10px; border-top:1px solid var(--ap-line); }
.ap-modal.ap-wide { width:min(560px, calc(100% - 24px)); }
/* 页脚按钮：24px 高、左右 12px；确定（默认）加粗边框双线 */
.ap-modal-foot .ap-tool { height:24px; padding:0 12px; min-width:64px; }
.ap-modal-foot .ap-tool.ap-primary { font-weight:600; border-color:var(--ap-line-3);
  box-shadow:inset 0 0 0 1px var(--ap-line-2); background:var(--ap-panel); }
.ap-modal-foot .ap-tool.ap-primary:hover { border-color:var(--ap-accent); }
.ap-mr-panel { position:absolute; left:0; right:0; bottom:22px; max-height:260px; display:flex; flex-direction:column;
  background:var(--ap-surface-2); border-top:1px solid var(--ap-line-2); box-shadow:0 -2px 6px rgba(0,0,0,.18); z-index:20; }
.ap-mr-head { display:flex; align-items:center; gap:6px; padding:4px 8px; border-bottom:1px solid var(--ap-line); font-weight:600; }
.ap-mr-body { display:flex; min-height:0; overflow:auto; }
.ap-mr-list { width:190px; display:flex; flex-direction:column; gap:1px; padding:4px; border-right:1px solid var(--ap-line); overflow:auto; }
.ap-mr-detail { flex:1; display:flex; flex-direction:column; gap:6px; padding:6px 10px; min-width:0; }
.ap-mr-item { display:block; width:100%; text-align:left; padding:3px 8px; background:none; border:0; font:inherit;
  color:var(--ap-text); cursor:default; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ap-mr-item:hover { background:var(--ap-hover); }
.ap-mr-item.ap-chosen { background:var(--ap-selected); }
.ap-modal-foot-left { margin-right:auto; display:flex; gap:6px; }
/* ── SPSS 式对话框主体：左变量列表 | 28px ▶ 箭头 | 右目标框 ────────── */
.ap-dlg { display:flex; gap:8px; min-height:270px; }
.ap-dlg-left { width:190px; flex:none; display:flex; flex-direction:column; gap:4px; min-width:0; }
.ap-dlg-right { flex:1; display:flex; flex-direction:column; gap:6px; min-width:0; }
.ap-dlg-caption { font-weight:600; color:var(--ap-text); font-size:12px; }
/* 白底 + 1px 内凹边框：列表要像被「按」进面板里 */
.ap-dlg-list { border:1px solid var(--ap-line-3); background:var(--ap-panel); flex:1; min-height:0; max-height:250px; overflow:auto;
  box-shadow:inset 1px 1px 2px color-mix(in srgb, var(--ap-text) 10%, transparent); }
.ap-dlg-var { display:flex; align-items:center; gap:5px; padding:2px 6px; }
.ap-dlg-var:hover { background:var(--ap-hover); }
.ap-dlg-var.ap-chosen { background:var(--ap-selected); }
.ap-dlg-var.ap-current { outline:1px solid var(--ap-accent); outline-offset:-1px; }
.ap-dlg-box { border:1px solid var(--ap-line-2); background:var(--ap-panel); padding:4px 6px; display:flex; flex-direction:column;
  gap:4px; min-height:44px; flex:1 1 auto; min-width:0; }
.ap-dlg-box.ap-active-box { outline:2px solid var(--ap-accent); outline-offset:-1px; }
.ap-dlg-box.ap-dlg-form input, .ap-dlg-box.ap-dlg-form select { border:1px solid var(--ap-line-3); padding:2px 6px; font:inherit; background:var(--ap-panel); border-radius:2px; }
/* 每个目标框左侧的 28px 箭头按钮（SPSS 的 ▶/◀，这里一个键切换加入/移出） */
/* 第一个目标框与左列表同高（SPSS 的变量列表 / 目标框是一对），其余按内容高 */
.ap-dlg-field { display:flex; align-items:stretch; gap:6px; flex:none; min-height:0; }
.ap-dlg-field:first-of-type { flex:1 1 auto; }
.ap-dlg-arrow { flex:none; width:28px; align-self:center; height:24px; padding:0; border:1px solid var(--ap-line-2);
  background:var(--ap-surface); color:var(--ap-text-2); cursor:default; font-size:12px; border-radius:2px; }
.ap-dlg-arrow:hover { background:var(--ap-panel); border-color:var(--ap-accent); color:var(--ap-text); }
.ap-dlg-arrow:disabled { opacity:.4; }
/* 帮助面板：显示「确定」将要执行的 PSPP 语法（也是「粘贴」放进编辑器的内容） */
.ap-dlg-help { border:1px solid var(--ap-line-2); background:var(--ap-panel); padding:6px 8px;
  display:flex; flex-direction:column; gap:4px; max-height:190px; overflow:auto; }
.ap-dlg-help-code { margin:0; white-space:pre-wrap; word-break:break-word; color:var(--ap-text);
  font-family:var(--dsh-font-family-code, "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace); font-size:11.5px; }
.ap-dlg-chips { display:flex; flex-wrap:wrap; gap:4px; }
.ap-chip { display:inline-flex; align-items:center; gap:3px; background:var(--ap-surface-2); border:1px solid var(--ap-line-2);
  border-radius:2px; padding:1px 5px; }
.ap-chip-x { border:0; background:transparent; color:var(--ap-text-2); cursor:pointer; padding:0 2px; line-height:1; }
.ap-check { display:flex; align-items:center; gap:6px; padding:2px 0; }
.ap-field { display:flex; flex-direction:column; gap:3px; }
.ap-field > label { font-weight:600; color:var(--ap-text); }
.ap-field input[type=text], .ap-field input[type=number], .ap-field select { border:1px solid var(--ap-line-3);
  background:var(--ap-panel); padding:2px 6px; font:inherit; border-radius:2px; }
.ap-picker { display:flex; gap:6px; }
.ap-picker-list { flex:1; min-width:140px; height:150px; overflow:auto; border:1px solid var(--ap-line-3); background:var(--ap-panel); }
.ap-picker-list label { display:flex; gap:6px; align-items:center; padding:2px 6px; }
.ap-picker-list label:hover { background:var(--ap-hover); }
.ap-row { display:flex; gap:8px; align-items:center; }
/* 11px 是正文下限：说明文字/状态栏之外不再出现更小的字 */
.ap-hint { color:var(--ap-text-2); font-size:11px; }
.ap-suggest { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-top:4px; }
.ap-keys { display:flex; flex-direction:column; gap:12px; }
.ap-keys-group { display:flex; flex-direction:column; gap:4px; }
.ap-keys-title { font-weight:600; color:var(--ap-text); }
.ap-keys-row { display:flex; gap:10px; align-items:baseline; }
.ap-keys-key { font-family:var(--ap-mono, monospace); font-size:11px; color:var(--ap-text-2); min-width:230px; }
.ap-keys-what { color:var(--ap-text); }
.ap-about { display:flex; flex-direction:column; gap:5px; }
.ap-about-name { font-weight:600; font-size:14px; }
.ap-about-line { color:var(--ap-text-2); }
.ap-about-note { color:var(--ap-text-3); font-size:11px; line-height:1.5; margin-top:4px; }
.ap-suggest-btn { padding:1px 6px; font:inherit; font-size:11px; background:var(--ap-button); color:var(--ap-text);
  border:1px solid var(--ap-line-2); border-radius:3px; cursor:pointer; }
.ap-suggest-btn:hover { background:var(--ap-hover); }
.ap-var-batch { display:flex; flex-direction:column; gap:6px; min-width:280px; }
.ap-var-batch .ap-row { display:flex; gap:8px; align-items:center; }
.ap-var-batch label { display:flex; gap:8px; align-items:center; font-size:12px; }
.ap-var-batch span.ap-hint { margin-left:auto; }
/* 预设提示条：会话没选「统计分析」预设时，智能体看不到 pspp_* 工具，但面板
   照常可用。底色从 --ap-accent 混出来（不写死亮色），暗色主题下不会刷白。 */
.ap-preset-bar { display:flex; align-items:center; gap:8px; flex:none; padding:4px 8px;
  background:color-mix(in srgb, var(--ap-accent) 12%, var(--ap-panel));
  border-bottom:1px solid var(--ap-line-2); color:var(--ap-text-2); font-size:11px; }
.ap-preset-bar-text { flex:1 1 auto; min-width:0; }
.ap-preset-bar-close { flex:none; background:none; border:1px solid var(--ap-line-2); border-radius:3px;
  padding:0 6px; font:inherit; font-size:11px; color:var(--ap-text-2); cursor:pointer; }
.ap-preset-bar-close:hover { background:var(--ap-hover); color:var(--ap-text); }
.ap-settings { max-width: 640px; display: flex; flex-direction: column; gap: 10px; }
/* Inside the modal the dialog already provides the frame and the padding. */
.ap-settings.ap-settings-embedded { max-width: none; }
.ap-conflict p { margin: 0 0 10px; line-height: 1.6; }
.ap-conflict-actions { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.ap-conflict-actions .ap-btn { text-align: left; }
.ap-conflict-actions .ap-btn.ap-danger { color: var(--ap-danger); }
.ap-settings-title { margin: 0; font-size: 13px; font-weight: 600; }
.ap-settings-row { display: flex; flex-direction: column; gap: 4px; }
.ap-settings-row label { font-size: 12px; }
.ap-settings-row input[type=number], .ap-settings-row select { width: 220px; }
.ap-settings-lines { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; padding: 4px 6px; resize: vertical; }
.ap-settings-actions { display: flex; gap: 8px; }
.ap-settings-problems { border: 1px solid #e0b4b4; background: #fdf3f3; padding: 6px 8px; font-size: 12px; }
.ap-settings-problems ul { margin: 4px 0 0 18px; padding: 0; }
.ap-settings-ok { color: #2e7d32; }
.ap-settings-deploy { border-top: 1px solid var(--ap-line); padding-top: 8px; font-size: 12px; }
.ap-dir { height:220px; overflow:auto; border:1px solid var(--ap-line-3); background:var(--ap-panel); }
.ap-dir button { display:block; width:100%; text-align:left; border:0; background:none; font:inherit; padding:2px 8px; }
.ap-dir button:hover { background:var(--ap-hover); }
`

    function ensureStyle() {
      // A plugin reload keeps the document, so an existing <style> tag holds
      // the OLD css; always overwrite it instead of bailing out.
      let style = document.querySelector('style[data-analytics]')
      if (!style) {
        style = document.createElement('style')
        style.dataset.analytics = 'true'
        document.head.appendChild(style)
      }
      if (style.textContent !== CSS) style.textContent = CSS
    }

    const ICON = (size) => h('svg', {
      width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': true, style: { display: 'block' },
    }, [
      h('rect', { key: 'bg', x: 3, y: 3, width: 58, height: 58, rx: 12, fill: '#12508f' }),
      h('rect', { key: 'b1', x: 13, y: 34, width: 7, height: 16, rx: 1.5, fill: '#fff' }),
      h('rect', { key: 'b2', x: 24, y: 26, width: 7, height: 24, rx: 1.5, fill: '#fff' }),
      h('rect', { key: 'b3', x: 35, y: 31, width: 7, height: 19, rx: 1.5, fill: '#fff' }),
      h('rect', { key: 'b4', x: 46, y: 20, width: 7, height: 30, rx: 1.5, fill: '#fff' }),
      h('path', { key: 'line', d: 'M12 24 C22 12, 30 30, 40 18 S54 12, 54 12', fill: 'none', stroke: '#8cc8ff', strokeWidth: 2.6, strokeLinecap: 'round' }),
    ])

    /**
     * The line-art twin of the panel's icon.
     *
     * Every other row in 全局面板 is an outline glyph from the harness' icon set
     * (16×16 box, fill="none", round caps, stroke = currentColor, width 1–1.3),
     * so a filled blue badge with white bars looked like a guest from another
     * app. This is drawn in the same vocabulary. `currentColor` is what makes
     * one asset work on a light and a dark theme — there is no need for a black
     * copy and a white copy.
     */
    const ICON_LINE = (size = 16, strokeWidth = 1.3) => h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style: { display: 'block' },
    }, [
      h('path', { key: 'axis', d: 'M2.6 2.4v11h10.8' }),
      h('path', { key: 'b1', d: 'M5.2 11.2V8.4' }),
      h('path', { key: 'b2', d: 'M8 11.2V5.6' }),
      h('path', { key: 'b3', d: 'M10.8 11.2V7' }),
      h('path', { key: 'trend', d: 'M4.6 6.1 7.2 3.9l2 1.5L13 2.8' }),
    ])

    /* ------------------------------------------------------------- dialogs */

    // SPSS's dialog footer runs 确定 / 粘贴 / 重置 / 取消 / 帮助, left to right,
    // with 确定 carrying the double border. 粘贴/重置/帮助 only appear for the
    // dialogs that can actually honour them (the analysis dialogs), because a
    // button that does nothing is worse than a missing one.
    function Modal({
      title, children, onOk, onCancel, okText = '确定', cancelText = '取消', okDisabled, wide, leading, hideCancel,
      onPaste, onReset, onHelp,
    }) {
      return h('div', { className: 'ap-modal-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel?.() } },
        h('div', { className: `ap-modal ${wide ? 'ap-wide' : ''}`, role: 'dialog' },
          h('div', { className: 'ap-modal-title' }, title),
          h('div', { className: 'ap-modal-body' }, children),
          h('div', { className: 'ap-modal-foot' },
            h('div', { className: 'ap-modal-foot-left' }, leading ?? null),
            h('button', { className: 'ap-tool ap-primary', onClick: onOk, disabled: okDisabled }, okText),
            onPaste ? h('button', { className: 'ap-tool', onClick: onPaste, title: '把这次设置生成的语法放进语法编辑器，不运行' }, '粘贴') : null,
            onReset ? h('button', { className: 'ap-tool', onClick: onReset, title: '把对话框恢复成刚打开时的样子' }, '重置') : null,
            hideCancel ? null : h('button', { className: 'ap-tool', onClick: onCancel }, cancelText),
            onHelp ? h('button', { className: 'ap-tool', onClick: onHelp, title: '这个过程会执行什么' }, '帮助') : null)))
    }

    // Delimited text is not self-describing in practice: Chinese exports are
    // often GBK, Windows tools write ';' or tabs, and .txt rarely has a header.
    function ImportDialog({ path, hasHeader, onClose, onRun }) {
      const [encoding, setEncoding] = useState('auto')
      const [delimiter, setDelimiter] = useState('auto')
      const [header, setHeader] = useState(hasHeader)
      return h(Modal, {
        title: '导入文本数据',
        onCancel: onClose,
        okText: '导入',
        onOk: () => onRun({ encoding, delimiter, hasHeader: header }),
      },
      h('div', { className: 'ap-row' },
        h('span', null, '文件'),
        h('span', { className: 'ap-hint', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, path)),
      h('div', { className: 'ap-row' },
        h('span', null, '编码'),
        h('select', { value: encoding, onChange: (event) => setEncoding(event.target.value), style: { flex: 1 } },
          h('option', { value: 'auto' }, '自动（先按 UTF-8，失败再按 GB18030）'),
          h('option', { value: 'utf-8' }, 'UTF-8'),
          h('option', { value: 'gbk' }, 'GBK / GB2312'),
          h('option', { value: 'gb18030' }, 'GB18030'),
          h('option', { value: 'big5' }, 'Big5'),
          h('option', { value: 'latin1' }, 'Latin-1'))),
      h('div', { className: 'ap-row' },
        h('span', null, '分隔符'),
        h('select', { value: delimiter, onChange: (event) => setDelimiter(event.target.value), style: { flex: 1 } },
          h('option', { value: 'auto' }, '自动识别'),
          h('option', { value: ',' }, '逗号 ,'),
          h('option', { value: ';' }, '分号 ;'),
          h('option', { value: '\t' }, '制表符 Tab'),
          h('option', { value: '|' }, '竖线 |'))),
      h('div', { className: 'ap-row' },
        h('span', null, '首行'),
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: header, onChange: (event) => setHeader(event.target.checked) }),
          '第一行是变量名')))
    }

    /**
     * The import wizard: show what the file will become before it becomes it.
     *
     * A delimited file carries no encoding, no delimiter and no column types, so
     * the import guesses — and a guess that turns 「年龄」 into V1 or a numeric
     * column into text is expensive to notice after the fact. Here the file is
     * read again on every change and the first rows are shown, so the choice is
     * made against the data instead of against its name.
     */
    function ImportWizard({ path, preview, busy, onClose, onPreview, onRun }) {
      const [encoding, setEncoding] = useState('auto')
      const [delimiter, setDelimiter] = useState('auto')
      const [header, setHeader] = useState(preview?.hasHeader !== false)
      const [skipRows, setSkipRows] = useState(String(preview?.skipRows ?? 0))
      const [skipTail, setSkipTail] = useState(String(preview?.skipTailRows ?? 0))
      const [missing, setMissing] = useState('NA, -9')
      const [sheet, setSheet] = useState(preview?.sheet ?? '')
      const [names, setNames] = useState({})
      const [types, setTypes] = useState({})
      const kind = preview?.kind ?? 'delimited'
      const columns = preview?.columns ?? []
      const settings = () => ({
        encoding,
        delimiter,
        hasHeader: header,
        skipRows: Number(skipRows) || 0,
        skipTailRows: Number(skipTail) || 0,
        missing: missing.split(/[,，;；\s]+/).filter(Boolean),
        sheet,
      })
      const ask = (patch = {}) => onPreview({ ...settings(), ...patch })
      const nameOf = (index) => names[index] ?? columns[index]?.name ?? ''
      const typeOf = (index) => types[index] ?? columns[index]?.type ?? 'numeric'
      const importOptions = () => ({
        ...settings(),
        names: columns.map((_, index) => nameOf(index)),
        types: columns.map((_, index) => typeOf(index)),
      })
      return h(Modal, {
        title: '导入向导',
        onCancel: onClose,
        okText: '导入',
        wide: true,
        onOk: () => onRun(importOptions()),
      },
      h('div', { className: 'ap-row' },
        h('span', null, '文件'),
        h('span', { className: 'ap-hint', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, path)),
      h('div', { className: 'ap-row ap-wiz-controls' },
        kind === 'sheet'
          ? h('label', { className: 'ap-wiz-field' },
            h('span', null, '工作表'),
            h('select', {
              value: sheet,
              onChange: (event) => { setSheet(event.target.value); ask({ sheet: event.target.value }) },
            }, (preview?.sheets ?? []).map((name) => h('option', { key: name, value: name }, name))))
          : h('label', { className: 'ap-wiz-field' },
            h('span', null, '编码'),
            h('select', {
              value: encoding,
              onChange: (event) => { setEncoding(event.target.value); ask({ encoding: event.target.value }) },
            },
            h('option', { value: 'auto' }, '自动（UTF-8 优先，失败再 GB18030）'),
            h('option', { value: 'utf-8' }, 'UTF-8'),
            h('option', { value: 'gbk' }, 'GBK / GB2312'),
            h('option', { value: 'gb18030' }, 'GB18030'),
            h('option', { value: 'big5' }, 'Big5'),
            h('option', { value: 'latin1' }, 'Latin-1'))),
        kind === 'sheet'
          ? null
          : h('label', { className: 'ap-wiz-field' },
            h('span', null, '分隔符'),
            h('select', {
              value: delimiter,
              onChange: (event) => { setDelimiter(event.target.value); ask({ delimiter: event.target.value }) },
            },
            h('option', { value: 'auto' }, `自动（当前识别为 ${preview?.delimiter === '\t' ? 'Tab' : preview?.delimiter || '逗号'}）`),
            h('option', { value: ',' }, '逗号 ,'),
            h('option', { value: ';' }, '分号 ;'),
            h('option', { value: '\t' }, '制表符 Tab'),
            h('option', { value: '|' }, '竖线 |'))),
        h('label', { className: 'ap-wiz-field' },
          h('span', null, '跳过开头'),
          h('input', {
            type: 'number',
            min: 0,
            value: skipRows,
            style: { width: 70 },
            onChange: (event) => setSkipRows(event.target.value),
            onBlur: () => ask(),
          }),
          h('span', { className: 'ap-hint' }, '行')),
        h('label', { className: 'ap-wiz-field' },
          h('span', null, '跳过末尾'),
          h('input', {
            type: 'number',
            min: 0,
            value: skipTail,
            style: { width: 70 },
            onChange: (event) => setSkipTail(event.target.value),
            onBlur: () => ask(),
          }),
          h('span', { className: 'ap-hint' }, '行（合计行）')),
        h('label', { className: 'ap-wiz-field' },
          h('span', null, '缺失值标记'),
          h('input', {
            type: 'text',
            value: missing,
            placeholder: 'NA, -9',
            style: { width: 120 },
            onChange: (event) => setMissing(event.target.value),
            onBlur: () => ask(),
          }))),
      h('label', { className: 'ap-check' },
        h('input', {
          type: 'checkbox',
          checked: header,
          onChange: (event) => { setHeader(event.target.checked); ask({ hasHeader: event.target.checked }) },
        }), '第一行是变量名（不勾则按 V1、V2… 命名）'),
      busy
        ? h('div', { className: 'ap-hint' }, tr('正在读取…'))
        : h('div', { className: 'ap-wiz-preview' },
          h('table', { className: 'ap-tbl-grid' },
            h('thead', null,
              h('tr', null, columns.map((column, index) => h('th', { key: index },
                h('input', {
                  className: 'ap-wiz-name',
                  type: 'text',
                  value: nameOf(index),
                  title: column.label ? tr('原表头：{0}', column.label) : tr('变量名'),
                  onChange: (event) => setNames((current) => ({ ...current, [index]: event.target.value })),
                }),
                h('select', {
                  className: 'ap-wiz-type',
                  value: typeOf(index),
                  onChange: (event) => setTypes((current) => ({ ...current, [index]: event.target.value })),
                },
                h('option', { value: 'numeric' }, '数值'),
                h('option', { value: 'string' }, '字符串')))))),
            h('tbody', null,
              (preview?.rows ?? []).map((row, rowIndex) => h('tr', { key: rowIndex },
                columns.map((_, index) => h('td', { key: index }, row[index] === null || row[index] === undefined ? h('span', { className: 'ap-missing' }, '缺失') : String(row[index])))))))),
      h('div', { className: 'ap-hint' },
        tr('共 {0} 行、{1} 列；预览显示前 {2} 行。改了编码/分隔符/行数会重新读取。', preview?.totalRows ?? 0, columns.length, (preview?.rows ?? []).length)),
      (preview?.notes ?? []).length > 0
        ? h('ul', { className: 'ap-notes' }, preview.notes.map((note, index) => h('li', { key: index }, note)))
        : null)
    }

    /**
     * Pick the numbers a reader looks for first out of a PSPP table.
     *
     * PSPP writes every statistic as its own column with a header, so the
     * summary is a header-to-value lookup rather than a formula: the labels
     * here are the English ones the engine emits, and a table without any of
     * them simply gets no summary.
     */
    // SPSS right-aligns a numeric column and left-aligns its label column. The
    // PSPP tables arrive as bare <td> text, so the only signal is the cell's
    // own content: a cell that is nothing but a number (sign, thousands
    // separators, decimals) is a number, anything else is text.
    const NUMERIC_CELL = /^-?\d+(?:,\d{3})*(?:\.\d+)?$/
    const isNumericCell = (text) => NUMERIC_CELL.test(String(text ?? '').trim())

    /** Draw a matrix as a table when the host could not render one. */
    // A frequency table of a categorical variable is one row per category, and
    // a real dataset has thousands. Drawing them all makes every scroll, DOM
    // query and browser snapshot expensive for numbers nobody reads; the first
    // screenful is enough to see the shape, and 显示全部 is one click away.
    // Copying CSV and exporting always use the whole table, never this window.
    const PREVIEW_ROWS = 200
    // Exports keep far more rows than the screen does, but still not everything:
    // a 3000-row frequency table produced a 7 MB document. Host exports read
    // this from settings (maxExportRows); the browser-side HTML export has no
    // host round trip, so it uses the same default.
    const EXPORT_ROWS = 2000

    /**
     * Cut a rendered table down to `limit` body rows.
     *
     * PSPP's own HTML cannot be sliced safely by structure, so this counts the
     * `<tr` starts and cuts before the first row over the limit. The head is
     * left intact (thead, colgroup, the first rows) and the table is closed, and
     * browsers auto-close whatever container was still open.
     */
    function truncateTableHtml(html, limit = PREVIEW_ROWS) {
      const text = String(html ?? '')
      // PSPP writes the header row inside <tbody> as a row of <th> cells, and a
      // data row may carry <th> too (a row label such as "Valid"). So the header
      // is "the leading rows that hold no <td at all", not simply the first row:
      // crosstabs have two of them, and a table with none must not lose a row.
      const rowPattern = /<tr\b[\s\S]*?<\/tr>/gi
      const rows = []
      let match
      while ((match = rowPattern.exec(text)) !== null) rows.push({ at: match.index, html: match[0] })
      let headerRows = 0
      for (const row of rows) {
        if (/<td/i.test(row.html)) break
        headerRows += 1
      }
      const total = Math.max(0, rows.length - headerRows)
      if (limit <= 0 || total <= limit) return { html: text, total, shown: total }
      const cut = rows[headerRows + limit]?.at ?? text.length
      return { html: `${text.slice(0, cut)}</table>`, total, shown: limit }
    }

    /**
     * Break a rendered table into the rows above its first body row, the body
     * rows themselves, and whatever follows them.
     *
     * A long table is drawn a window at a time (VirtualTable), and PSPP's own
     * markup has to survive that: the caption, colgroup and header rows are kept
     * as the exact prefix PSPP produced, and a footer (matrixHtml's footnote) is
     * kept as the exact tail, so only whole <tr> elements are added or removed.
     * Returns null when the HTML has no body row to window.
     */
    function splitTableHtml(html) {
      const text = String(html ?? '')
      const rowPattern = /<tr\b[\s\S]*?<\/tr>/gi
      const rows = []
      let match
      while ((match = rowPattern.exec(text)) !== null) rows.push({ at: match.index, html: match[0] })
      if (rows.length === 0) return null
      // The same rule as truncateTableHtml: the header is the leading rows that
      // hold no <td> at all (crosstabs have two, and a row label may be a <th>).
      let headerRows = 0
      for (const row of rows) {
        if (/<td/i.test(row.html)) break
        headerRows += 1
      }
      // A footer belongs to the table, not to the scrolled data: it stays in the
      // tail instead of being counted as a body row.
      let bodyEnd = rows.length
      const footAt = text.search(/<tfoot\b/i)
      if (footAt >= 0) {
        const firstFoot = rows.findIndex((row) => row.at >= footAt)
        if (firstFoot > headerRows) bodyEnd = firstFoot
      }
      const body = rows.slice(headerRows, bodyEnd)
      if (body.length === 0) return null
      const first = rows[headerRows]
      const last = body[body.length - 1]
      const columns = Math.max(1, (body[0].html.match(/<t[dh]\b/gi) ?? []).length)
      return {
        prefix: text.slice(0, first.at),
        body,
        tail: text.slice(last.at + last.html.length),
        columns,
      }
    }

    // A fully expanded table is drawn a window at a time once it holds more body
    // rows than this. Shorter tables keep the plain whole-table render on
    // purpose: the copy/print/export paths and the existing tests all assume a
    // small table is simply there, and 200 rows is not worth a scroll layer.
    const VIRT_TABLE_MIN = 200
    // PSPP's output is 12px text in 3px-padded cells, so a body row is about
    // this tall. It is only a fallback: the real height is measured off the
    // first drawn row and used as soon as the browser can report one.
    const VIRT_ROW_PX = 26
    const VIRT_OVERSCAN = 10
    const VIRT_VIEWPORT_PX = 520

    /**
     * The rows to draw for a scroll position.
     *
     * Pure on purpose: the client test calls it directly, and the same numbers
     * drive both the drawn rows and the two spacer rows that hold the scrollbar
     * at the length of the whole table.
     */
    function virtualWindow(total, scrollTop, viewport, rowHeight = VIRT_ROW_PX, overscan = VIRT_OVERSCAN) {
      const count = Math.max(0, Number(total) || 0)
      const height = Math.max(1, Number(rowHeight) || VIRT_ROW_PX)
      const perScreen = Math.max(1, Math.ceil(Math.max(0, Number(viewport) || 0) / height))
      const first = Math.floor(Math.max(0, Number(scrollTop) || 0) / height)
      const start = Math.max(0, Math.min(Math.max(0, count - 1), first - overscan))
      const end = Math.min(count, Math.max(start + 1, start + perScreen + overscan * 2))
      return { start, end }
    }

    /**
     * Draw a long table a window at a time inside a box that scrolls itself.
     *
     * The header rows stay in the DOM (they are the prefix of PSPP's markup),
     * the rows in the window are real <tr> elements, and a spacer row above and
     * below them keeps the scrollbar at the length of the whole table. When the
     * box cannot be measured -- jsdom has no layout at all, and a hidden panel
     * reports 0 -- the table falls back to the whole-table render rather than
     * computing a window from a 0px viewport, which would draw one row and hide
     * the rest behind a scrollbar that is not there.
     */
    function VirtualTable({ html }) {
      const split = useMemo(() => splitTableHtml(html), [html])
      const scrollRef = useRef(null)
      const [box, setBox] = useState({ height: VIRT_VIEWPORT_PX, top: 0, rowHeight: VIRT_ROW_PX })
      // Height and offset only: this runs on every scroll event, so it must not
      // walk the table.
      const measure = useCallback(() => {
        const node = scrollRef.current
        if (!node) return
        const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
        const height = Math.max(0, Math.round(node.clientHeight || 0), Math.round(rect?.height || 0))
        const top = Math.max(0, Math.round(node.scrollTop || 0))
        setBox((current) => (current.height === height && current.top === top ? current : { ...current, height, top }))
      }, [])
      useLayoutEffect(() => { measure() }, [measure, html])
      useEffect(() => {
        const node = scrollRef.current
        if (!node) return undefined
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(() => measure())
          observer.observe(node)
          return () => observer.disconnect()
        }
        const onResize = () => measure()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [measure, html])
      // The real row height is preferred over the constant, so the window and
      // the spacers advance at the pace the browser actually scrolls. One rect
      // read per render is enough; a box without layout reports 0 and keeps the
      // constant.
      useEffect(() => {
        const node = scrollRef.current
        if (!node) return
        const row = node.querySelector('tbody tr td, tr td')?.parentElement
        const measured = Math.round(row?.getBoundingClientRect?.().height || 0)
        if (measured > 6 && measured !== box.rowHeight) setBox((current) => ({ ...current, rowHeight: measured }))
      })
      const total = split ? split.body.length : 0
      const virtual = total > VIRT_TABLE_MIN && box.height > 0
      if (!virtual) {
        // No measurable box (jsdom never has one, a hidden panel reports 0):
        // draw the table whole rather than a window computed from 0px. The ref
        // stays on it so becoming visible can still turn the window back on.
        return h('div', {
          key: 'table',
          ref: scrollRef,
          className: 'ap-table-wrap',
          dangerouslySetInnerHTML: { __html: html },
        })
      }
      const height = Math.max(VIRT_ROW_PX, Math.min(box.height, VIRT_VIEWPORT_PX))
      const { start, end } = virtualWindow(total, box.top, height, box.rowHeight, VIRT_OVERSCAN)
      const spacer = (px) => (px > 0
        ? `<tr class="ap-tbl-spacer" aria-hidden="true"><td colspan="${split.columns}" style="height:${Math.round(px)}px"></td></tr>`
        : '')
      // The window lives in its own content div: replacing that div's HTML must
      // not touch the scroller above it, or the scroll position would jump on
      // every step.
      const inner = `${split.prefix}${spacer(start * box.rowHeight)}${split.body.slice(start, end).map((row) => row.html).join('')}${spacer((total - end) * box.rowHeight)}${split.tail}`
      return h('div', {
        key: 'table',
        ref: scrollRef,
        className: 'ap-table-wrap ap-tbl-vscroll',
        style: { maxHeight: `${height}px` },
        onScroll: measure,
      }, h('div', { className: 'ap-tbl-vbody', dangerouslySetInnerHTML: { __html: inner } }))
    }

    /**
     * Toolbar glyphs, drawn as inline SVG so the bar works offline, follows the
     * theme colour, and stays crisp on a HiDPI screen. SPSS has an icon-only
     * toolbar; the words live in `title`, which is also the screen-reader name.
     */
    const ICON_PATHS = {
      open: [['M2.5 5.4V4h4l1.2 1.4h5.8v6.6h-11z']],
      save: [['M2.6 3.6h8.2l2.6 2.6v6.2h-10.8z'], ['M5 3.6h5v3.2H5z'], ['M5.2 9h5.6v3.4H5.2z']],
      labels: [['M3 3.2h4.6L13 8.6l-4.4 4.4L3 7.8z'], ['M5.4 5.6', 'dot']],
      frequency: [['M3.4 12.6h9.2'], ['M4.6 12.2V8.4h2v3.8z'], ['M7.6 12.2V5.4h2v6.8z'], ['M10.6 12.2V9.6h2v2.6z']],
      descriptives: [['M3.6 4.4h8.8'], ['M3.6 8h8.8'], ['M3.6 11.6h8.8'], ['M2.2 4.4', 'dot'], ['M2.2 8', 'dot'], ['M2.2 11.6', 'dot']],
      crosstabs: [['M3 3.6h10v8.8H3z'], ['M8 3.6v8.8'], ['M3 8h10']],
      correlation: [['M2.6 12.8l10.8-9.6'], ['M4.6 10.6', 'dot'], ['M7.4 7.4', 'dot'], ['M10.4 4.6', 'dot']],
      regression: [['M2.6 12.4l10.8-8.4'], ['M4 7.4', 'dot'], ['M8.4 10.2', 'dot'], ['M11.4 5.2', 'dot']],
      syntax: [['M5.8 4.6L2.6 8l3.2 3.4'], ['M10.2 4.6L13.4 8l-3.2 3.4']],
      clear: [['M3.2 4.4h9.6'], ['M5 4.4l.8 8.2h4.4l.8-8.2'], ['M6.6 4.4V3.2h2.8v1.2']],
    }
    function apIcon(name) {
      const parts = ICON_PATHS[name] ?? []
      return h('svg', {
        key: `icon-${name}`,
        className: 'ap-icon',
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true',
        focusable: 'false',
      }, parts.map((part, index) => (part[1] === 'dot'
        ? h('circle', { key: index, cx: Number(part[0].split(' ')[0]), cy: Number(part[0].split(' ')[1]), r: 1.1, fill: 'currentColor', stroke: 'none' })
        : h('path', { key: index, d: part[0], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))))
    }

    function matrixHtml(matrix, className = '', edits = null, limit = 0) {
      const all = Array.isArray(matrix) ? matrix : []
      const rows = limit > 0 && all.length > limit + 1 ? all.slice(0, limit + 1) : all
      if (rows.length === 0) return ''
      const escape = (text) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      const width = Array.isArray(edits?.widths) ? edits.widths : []
      const headers = Array.isArray(edits?.headers) ? edits.headers : []
      const columns = Math.max(...all.map((row) => (Array.isArray(row) ? row.length : 1)))
      const colgroup = width.some((value) => Number(value) > 0)
        ? `<colgroup>${Array.from({ length: columns }, (_, index) => {
          const value = Number(width[index])
          return value > 0 ? `<col style="width:${value}px">` : '<col>'
        }).join('')}</colgroup>`
        : ''
      const body = rows.map((row, index) => {
        const tag = index === 0 ? 'th' : 'td'
        return `<tr>${(Array.isArray(row) ? row : [row]).map((cell, cellIndex) => {
          // A paper-ready table often needs its header wording changed but its
          // numbers left exactly as PSPP produced them.
          const text = index === 0 && headers[cellIndex] !== undefined && headers[cellIndex] !== ''
            ? headers[cellIndex]
            : cell
          return `<${tag}>${escape(text)}</${tag}>`
        }).join('')}</tr>`
      }).join('')
      const footnote = String(edits?.footnote ?? '').trim()
      const foot = footnote
        ? `<tfoot><tr><td colspan="${columns}" class="ap-footnote">${escape(footnote)}</td></tr></tfoot>`
        : ''
      return `<table class="${className}">${colgroup}${body}${foot}</table>`
    }

    function summarizeTable(table) {
      const matrix = table?.matrix
      if (!Array.isArray(matrix) || matrix.length < 2) return ''
      const header = matrix[0].map((cell) => String(cell ?? '').trim())
      const pick = (row, labels) => {
        for (const label of labels) {
          const index = header.indexOf(label)
          if (index >= 0) {
            const value = String(row[index] ?? '').trim()
            if (value !== '') return value
          }
        }
        return null
      }
      const facts = []
      // N belongs to a descriptives header row; in a test table the count is
      // not what a reader wants first, and the first column is a label.
      const n = header.includes('N') ? pick(matrix[1], ['N']) ?? matrix.slice(1).map((r) => pick(r, ['N'])).find(Boolean) : null
      if (n) facts.push(`N=${n}`)
      let row = null
      // A test statistic is the interesting row; a descriptives table is not.
      for (const candidate of matrix.slice(1)) {
        const test = pick(candidate, ['t', 'F', 'Chi-Square', 'χ²', 'U', 'Z', 'df'])
        if (test !== null) { row = candidate; break }
      }
      if (row) {
        for (const [labels, prefix] of [
          [['t'], 't'],
          [['F'], 'F'],
          [['Chi-Square'], 'χ²'],
          [['U', 'Mann-Whitney U'], 'U'],
          [['Z'], 'Z'],
          [['df'], 'df'],
        ]) {
          const value = pick(row, labels)
          if (value !== null && !facts.some((fact) => fact?.startsWith?.(`${prefix}=`))) facts.push(`${prefix}=${value}`)
        }
      }
      const p = pick(row ?? matrix[1], ['Sig. (2-tailed)', 'Sig. (1-tailed)', 'Sig.', 'p'])
      if (p) facts.push(`p=${p}`)
      // Descriptives put the mean in the first data row; a test table's rows
      // are the statistics themselves and have no such column.
      const mean = pick(matrix[1], ['Mean'])
      if (mean && !facts.some((fact) => fact.startsWith('χ²='))) facts.push(tr(`均值=${mean}`))
      const sd = pick(matrix[1], ['Std. Deviation', 'Std Dev'])
      if (sd) facts.push(`SD=${sd}`)
      return facts.join(' · ')
    }

    /**
     * Ask the host to turn a chart into a raster file.
     * @returns {Promise<{url: string, bytes: number}>}
     */
    async function exportChartPng(path, url) {
      const value = await api('api/chart/export', { path, url })
      return value.result
    }

    // Kept outside the module loader's closure so the jsdom test can call them.
    if (typeof globalThis !== 'undefined' && globalThis.__AP_TEST_HOOKS__) {
      globalThis.__AP_TEST_HOOKS__.completionCandidates = completionCandidates
      globalThis.__AP_TEST_HOOKS__.parseValueLabelLines = parseValueLabelLines
      globalThis.__AP_TEST_HOOKS__.summarizeTable = summarizeTable
      globalThis.__AP_TEST_HOOKS__.matrixHtml = matrixHtml
      globalThis.__AP_TEST_HOOKS__.truncateTableHtml = truncateTableHtml
      globalThis.__AP_TEST_HOOKS__.splitTableHtml = splitTableHtml
      globalThis.__AP_TEST_HOOKS__.virtualWindow = virtualWindow
      globalThis.__AP_TEST_HOOKS__.VIRT_TABLE_MIN = VIRT_TABLE_MIN
      globalThis.__AP_TEST_HOOKS__.VIRT_ROW_PX = VIRT_ROW_PX
      globalThis.__AP_TEST_HOOKS__.parseContrasts = parseContrasts
      globalThis.__AP_TEST_HOOKS__.checkExpression = checkExpression
      globalThis.__AP_TEST_HOOKS__.PREVIEW_ROWS = PREVIEW_ROWS
      globalThis.__AP_TEST_HOOKS__.stateOf = stateOf
      globalThis.__AP_TEST_HOOKS__.tr = tr
      globalThis.__AP_TEST_HOOKS__.setDictionary = setDictionary
      globalThis.__AP_TEST_HOOKS__.h = h
      globalThis.__AP_TEST_HOOKS__.gridCommand = gridCommand
      globalThis.__AP_TEST_HOOKS__.foreignWriteNotice = foreignWriteNotice
    }

    /**
     * Turn a pasted `<value>,<label>` block into a value-label map.
     *
     * Judges by columns rather than by a delimiter argument, because the two
     * things a user pastes here are SPSS syntax and a spreadsheet range, and
     * they disagree about whether the label comes first.
     */
    /**
     * A missing-value code is a number, a string, or a `{ lo, hi }` range.
     * `String({lo,hi})` is "[object Object]", and Number("[object Object]") is
     * NaN — the variable view showed that text and then cleared every range
     * the moment the field lost focus.
     */
    function missingToText(missing) {
      if (!Array.isArray(missing)) return ''
      return missing.map((entry) => {
        if (entry !== null && typeof entry === 'object') {
          const low = Array.isArray(entry) ? entry[0] : entry.lo
          const high = Array.isArray(entry) ? entry[1] : entry.hi
          if (low === undefined && high === undefined) return ''
          return `${low ?? ''} THRU ${high ?? ''}`.trim()
        }
        return String(entry ?? '')
      }).filter((text) => text !== '').join(' ')
    }

    /** Read the same syntax the field shows: `90 THRU 99`, `1, 2`, `'a'`. */
    function parseMissingInput(text, type) {
      const source = String(text ?? '').trim()
      if (source === '') return []
      const clean = (token) => {
        let value = String(token ?? '').trim()
        if (value === '') return null
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1).trim()
        }
        if (type === 'string') return value === '' ? null : value
        const number = Number(value)
        return Number.isFinite(number) ? number : null
      }
      const out = []
      const atom = "'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|[^\\s,]+"
      const rangePattern = new RegExp(`(${atom})\\s+THRU\\s+(${atom})`, 'gi')
      const rest = source.replace(rangePattern, (match, lowText, highText) => {
        const low = clean(lowText)
        const high = clean(highText)
        if (low !== null && high !== null) {
          // Keep the range as a range for strings too: splitting it into two
          // codes made the field rewrite `AA THRU ZZ` as `AA ZZ` on blur.
          if (typeof low === 'number' && typeof high === 'number') out.push({ lo: Math.min(low, high), hi: Math.max(low, high) })
          else out.push({ lo: String(low), hi: String(high), text: true })
        }
        return ' '
      })
      for (const token of rest.split(/[\s,]+/)) {
        const value = clean(token)
        if (value !== null) out.push(value)
      }
      return out
    }

    function parseValueLabelLines(text) {
      const labels = {}
      const problems = []
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim()
        if (line === '' || line.startsWith('*') || line.startsWith('/*')) continue
        const syntax = /^VALUE\s+LABELS\s+[^\s]+\s+(.*)$/i.exec(line)
        if (syntax) {
          // `VALUE LABELS sex 1 '男' 2 '女'.` — read the pairs the engine would.
          const body = syntax[1].replace(/\.\s*$/, '')
          const pairs = body.matchAll(/(\S+)\s+('(?:[^']|'')*'|"(?:[^"]|"")*")/g)
          let found = false
          for (const pair of pairs) {
            const value = pair[1].replace(/^["']|["']$/g, '')
            const label = pair[2].slice(1, -1).replaceAll(pair[2][0] + pair[2][0], pair[2][0])
            labels[value] = label
            found = true
          }
          if (!found) problems.push(line)
          continue
        }
        const parts = line.split(/[,;\t]/).map((part) => part.trim().replace(/^["']|["']$/g, ''))
        if (parts.length < 2) { problems.push(line); continue }
        const [first, second] = parts
        // Numeric second column means the user pasted `label,value`; otherwise
        // the first column is the code, which is how SPSS export reads.
        const secondNumeric = /^-?\d+(\.\d+)?$/.test(second)
        const firstNumeric = /^-?\d+(\.\d+)?$/.test(first)
        const [value, label] = secondNumeric && !firstNumeric ? [second, first] : [first, second]
        labels[value] = label
      }
      return { labels, problems }
    }

    function ValueLabelDialog({ variables, initial, onClose, onAssign }) {
      const [target, setTarget] = useState(initial ?? variables[0]?.name ?? '')
      const [text, setText] = useState('')
      const [fileName, setFileName] = useState(null)
      const [merge, setMerge] = useState(false)
      const [applyAll, setApplyAll] = useState(false)
      const [error, setError] = useState(null)
      // Reading the file here keeps the dialog self-contained: the same parser
      // then judges a pasted range and a .csv alike.
      const readFile = async (path) => {
        try {
          const value = await api('api/readFile', { path })
          setText(value.result?.text ?? '')
          setFileName(path.slice(path.lastIndexOf('/') + 1))
          setError(null)
        } catch (problem) {
          setError(problem.message)
        }
      }
      useEffect(() => {
        if (readFile.pending) return
        readFile.pending = true
        const pending = LABEL_FILE_PICKED
        LABEL_FILE_PICKED = null
        if (pending) readFile(pending)
      }, [])
      const parsed = useMemo(() => parseValueLabelLines(text), [text])
      const count = Object.keys(parsed.labels).length
      // A Likert block or a set of yes/no items always shares one code table;
      // retyping it per variable is the tedious part of SPSS data prep.
      const targetType = variables.find((variable) => variable.name === target)?.type
      const siblings = variables.filter((variable) => variable.name !== target && variable.type === targetType)
      const preview = parsed.problems.length > 0
        ? tr('{0} 条可识别；{1} 行看不懂：{2}', count, parsed.problems.length, parsed.problems.slice(0, 3).join(' / '))
        : count > 0 ? tr('{0} 条值标签', count) : '还没有内容'
      return h(Modal, {
        title: '批量导入值标签',
        onCancel: onClose,
        okText: '导入',
        okDisabled: !target || count === 0,
        onOk: async () => {
          if (parsed.problems.length > 0 && !window.confirm(tr('{0} 行看不懂，将跳过它们继续导入。继续？', parsed.problems.length))) return
          await onAssign(target, parsed.labels, merge, applyAll === true && siblings.length > 0)
        },
      },
      h('div', { className: 'ap-row' },
        h('span', null, '目标变量'),
        h('select', { value: target, onChange: (event) => setTarget(event.target.value), style: { flex: 1 } },
          variables.map((variable) => h('option', { key: variable.name, value: variable.name, translate: false },
            variable.label ? `${variable.name}（${variable.label}）` : variable.name)))),
      h('div', { className: 'ap-hint' }, '每行「值,标签」（或「标签,值」），也可以直接粘贴 VALUE LABELS 语句。'),
      h('textarea', {
        className: 'ap-textarea',
        rows: 9,
        value: text,
        spellCheck: false,
        placeholder: "1,男\n2,女\n\n或者：\nVALUE LABELS sex 1 '男' 2 '女'.",
        onChange: (event) => setText(event.target.value),
      }),
      h('div', { className: 'ap-row' },
        h('button', { className: 'ap-tool', onClick: () => setBrowser({ mode: 'labelFile' }) }, '从文件读取…'),
        fileName ? h('span', { className: 'ap-hint' }, fileName) : null),
      h('div', { className: 'ap-row' },
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: merge, onChange: (event) => setMerge(event.target.checked) }),
          '保留原有标签（只覆盖本次出现的值）')),
      siblings.length > 0
        ? h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', {
            type: 'checkbox',
            checked: applyAll,
            onChange: (event) => setApplyAll(event.target.checked),
          }),
          tr('同时套用到另外 {0} 个同类型变量（{1}{2}）', siblings.length, siblings.slice(0, 3).map((variable) => variable.name).join(' / '), siblings.length > 3 ? ' …' : ''))
        : null,
      h('div', { className: 'ap-hint', style: error ? { color: '#a33' } : null }, error ?? preview))
    }


    // Multiple response sets: PSPP stores the definition but cannot tabulate
    // it, so the counts come back from the host (lib/mrsets.js).
    function MrSetDialog({ variables, initial, existing, onClose, onSave }) {
      const numeric = variables.filter((variable) => variable.type === 'numeric')
      const [name, setName] = useState(initial?.name ?? '$q1')
      const [label, setLabel] = useState(initial?.label ?? '')
      const [kind, setKind] = useState(initial?.kind ?? 'mcgroup')
      const [picked, setPicked] = useState(() => new Set(initial?.variables ?? []))
      const [valueText, setValueText] = useState(
        initial?.value ? initial.value.join(' ') : '1 2 3',
      )
      const [counted, setCounted] = useState(initial?.counted ?? 'counted')
      const [includeEmpty, setIncludeEmpty] = useState(initial?.empty === true)
      const [error, setError] = useState(null)
      const toggle = (variableName) => {
        setPicked((previous) => {
          const next = new Set(previous)
          if (next.has(variableName)) next.delete(variableName)
          else next.add(variableName)
          return next
        })
      }
      const submit = () => {
        const values = valueText.trim().split(/[\s,]+/).filter(Boolean)
        if (!picked.size) { setError('先在左边选要合并的变量'); return }
        if (kind === 'mdgroup' && values.length === 0) { setError('多分类要写出计数哪些值，例如 1 2 3'); return }
        const clash = existing.find((entry) => entry.name === name.trim() && entry.name !== initial?.name)
        if (clash) { setError(`已经有叫 ${name.trim()} 的多选题了`); return }
        onSave({
          name: name.trim(),
          label: label.trim(),
          kind,
          variables: numeric.filter((variable) => picked.has(variable.name)).map((variable) => variable.name),
          ...(kind === 'mdgroup' ? { value: values.map((entry) => Number(entry)), counted } : {}),
          empty: includeEmpty,
        })
      }
      return h(Modal, {
        title: initial ? tr('编辑多选题 — {0}', initial.name) : '定义多选题',
        wide: true,
        onCancel: onClose,
        okText: '保存',
        onOk: submit,
      },
      h('div', { className: 'ap-row' },
        h('span', { style: { width: 64 } }, '名称'),
        h('input', { value: name, style: { width: 140 }, onChange: (event) => setName(event.target.value), placeholder: '$q1' }),
        h('span', { style: { width: 40 } }, '标签'),
        h('input', { value: label, style: { flex: 1 }, onChange: (event) => setLabel(event.target.value), placeholder: '例如：认同的品牌' })),
      h('div', { className: 'ap-row' },
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'radio', checked: kind === 'mcgroup', onChange: () => setKind('mcgroup') }),
          '二分法（每个变量是一个是/否题，勾选的算一次）')),
      h('div', { className: 'ap-row' },
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'radio', checked: kind === 'mdgroup', onChange: () => setKind('mdgroup') }),
          '多分类（同一组值出现在多个变量里，例如第一/第二/第三选择）')),
      kind === 'mdgroup'
        ? h('div', { className: 'ap-row' },
          h('span', { style: { width: 64 } }, '计数值'),
          h('input', { value: valueText, style: { width: 160 }, onChange: (event) => setValueText(event.target.value), placeholder: '1 2 3' }),
          h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: counted === 'respondents', onChange: (event) => setCounted(event.target.checked ? 'respondents' : 'counted') }),
            '每个响应者只算一次'))
        : null,
      h('div', { className: 'ap-dlg-cols', style: { display: 'flex', gap: 10, marginTop: 6 } },
        h('div', { className: 'ap-dlg-list', style: { flex: 1, maxHeight: 240, overflow: 'auto', border: '1px solid var(--ap-line-2)' } },
          numeric.length === 0
            ? h('div', { className: 'ap-hint', style: { padding: 6 } }, '没有数值变量：多选题只能用数值变量')
            : numeric.map((variable) => h('div', {
              key: variable.name,
              className: `ap-dlg-var ${picked.has(variable.name) ? 'ap-chosen' : ''}`,
              onClick: () => toggle(variable.name),
            },
            h('span', { style: { flex: 1 }, translate: false }, variable.label ? `${variable.name}（${variable.label}）` : variable.name)))),
        h('div', { style: { width: 200, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { className: 'ap-hint' }, tr('已选 {0} 个变量', picked.size)),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            [...picked].map((entry) => h('span', { key: entry, className: 'ap-chip' }, entry,
              h('button', { className: 'ap-chip-x', onClick: () => toggle(entry) }, '×')))))),
      h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: includeEmpty, onChange: (event) => setIncludeEmpty(event.target.checked) }),
        '把没人勾的类别也列出来（计数为 0）'),
      h('div', { className: 'ap-hint', style: error ? { color: '#a33' } : null },
        error ?? 'PSPP 只把定义存进字典、不会替我们算；频数与交叉表由本插件在数据上直接统计。'))
    }


    // The multiple response panel mirrors the set editing in SPSS: the list of
    // sets on the left, the frequency table and its actions on the right.
    function MrPanel({ sets, variables, active, percentBase, onAction, onPercentBase, onEdit, onClose, addAria }) {
      const [groupBy, setGroupBy] = useState('')
      const current = sets.find((entry) => entry.name === active) ?? sets[0] ?? null
      const grouped = variables.filter((variable) => variable.type !== 'string' && !(current?.variables ?? []).includes(variable.name))
      return h('div', { className: 'ap-mr-panel' },
        h('div', { className: 'ap-mr-head' },
          h('span', null, '多选题'),
          h('span', { className: 'ap-grow' }),
          h('button', { className: 'ap-tool', onClick: addAria, title: '定义一个新的多选题集合' }, '定义…'),
          h('button', { className: 'ap-tool', onClick: onClose }, '收起')),
        sets.length === 0
          ? h('div', { className: 'ap-hint', style: { padding: 8 } },
            '还没有多选题。选「定义…」把几个是/否变量合并成一个集合，或者把第 1/2/3 选择合成一个类别集合。')
          : h('div', { className: 'ap-mr-body' },
            h('div', { className: 'ap-mr-list' },
              sets.map((entry) => h('button', {
                key: entry.name,
                className: `ap-var-item ap-mr-item ${current?.name === entry.name ? 'ap-chosen' : ''}`,
                onClick: () => onAction('read', entry.name),
              }, entry.label ? `${entry.name} · ${entry.label}` : entry.name))),
            current
              ? h('div', { className: 'ap-mr-detail' },
                h('div', { className: 'ap-hint' },
                  tr('{0} · {1} 个变量：{2}', tr(current.kind === 'mdgroup' ? '多分类' : '二分法'), current.variables.length, current.variables.join(' '))),
                h('div', { className: 'ap-row' },
                  h('button', { className: 'ap-tool', onClick: () => onAction('frequency', current.name, { percentBase }) }, '频数表'),
                  h('button', { className: 'ap-tool', onClick: () => onEdit(current) }, '编辑…'),
                  h('button', { className: 'ap-tool', onClick: () => onAction('remove', current.name) }, '删除')),
                h('div', { className: 'ap-row' },
                  h('span', null, '百分比基数'),
                  h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                    h('input', { type: 'radio', checked: percentBase !== 'cases', onChange: () => onPercentBase('responses') }),
                    '响应'),
                  h('label', { style: { display: 'flex', gap: 4, alignItems: 'center' } },
                    h('input', { type: 'radio', checked: percentBase === 'cases', onChange: () => onPercentBase('cases') }),
                    '个案')),
                h('div', { className: 'ap-row' },
                  h('span', null, '交叉表：按'),
                  h('select', { value: groupBy, onChange: (event) => setGroupBy(event.target.value), style: { flex: 1 } },
                    h('option', { value: '' }, '（不分）'),
                    grouped.map((variable) => h('option', { key: variable.name, value: variable.name, translate: false },
                      variable.label ? `${variable.name}（${variable.label}）` : variable.name))),
                  h('button', {
                    className: 'ap-tool',
                    disabled: !groupBy,
                    onClick: () => onAction('crosstab', current.name, { groupBy }),
                  }, '生成')),
                null)
              : null))
    }

    // A workbook usually has more than one sheet, and which one you want is
    // not something a guess can decide.
    function SheetDialog({ path, sheets, hasHeader, onClose, onRun }) {
      const [sheet, setSheet] = useState(sheets[0] ?? '')
      const [header, setHeader] = useState(hasHeader)
      return h(Modal, {
        title: '导入 Excel 工作表',
        onCancel: onClose,
        okText: '导入',
        onOk: () => onRun({ sheet, hasHeader: header }),
      },
      h('div', { className: 'ap-row' },
        h('span', null, '文件'),
        h('span', { className: 'ap-hint', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, path)),
      h('div', { className: 'ap-row' },
        h('span', null, '工作表'),
        h('select', { value: sheet, onChange: (event) => setSheet(event.target.value), style: { flex: 1 } },
          sheets.map((name) => h('option', { key: name, value: name }, name)))),
      h('div', { className: 'ap-row' },
        h('span', null, '首行'),
        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: header, onChange: (event) => setHeader(event.target.checked) }),
          '第一行是变量名')))
    }

    function VariablePicker({ variables, value, onChange, multiple = true, height }) {
      const selected = multiple ? value : (value ? [value] : [])
      const toggle = (name) => {
        if (!multiple) {
          onChange(value === name ? null : name)
          return
        }
        const next = selected.includes(name) ? selected.filter((entry) => entry !== name) : [...selected, name]
        onChange(next)
      }
      return h('div', { className: 'ap-picker' },
        h('div', { className: 'ap-picker-list', style: height ? { height } : undefined },
          variables.map((variable) => h('label', { key: variable.name },
            h('input', {
              type: multiple ? 'checkbox' : 'radio',
              checked: selected.includes(variable.name),
              onChange: () => toggle(variable.name),
            }),
            h('span', { translate: false }, variable.name),
            variable.label ? h('span', { className: 'ap-hint', translate: false }, ` ${variable.label}`) : null))))
    }

    function Field({ label, children, hint }) {
      return h('div', { className: 'ap-field' },
        h('label', null, label),
        children,
        hint ? h('div', { className: 'ap-hint' }, hint) : null)
    }

    /**
     * Table 1 / table 2 builder: pick the grouping variable, tick the rows, and
     * choose how numeric variables are summarised.
     */
    function PublicationDialog({ kind, variables, onRun, onClose }) {
      const [group, setGroup] = useState(null)
      const [chosen, setChosen] = useState([])
      const [continuous, setContinuous] = useState('mean')
      const numeric = variables.filter((variable) => variable.type === 'numeric')
      const others = variables.filter((variable) => variable.name !== group)
      const toggle = (name) => setChosen((current) => (current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name]))
      const chip = (name, onPick, active) => h('span', {
        key: name,
        className: `ap-chip${active ? ' ap-chip-on' : ''}`,
        onClick: () => onPick(name),
        translate: false,
      }, name)
      return h(Modal, {
        title: kind === 'baseline' ? '表 1：基线特征' : '表 2：组间比较',
        wide: true,
        okDisabled: !group,
        onCancel: onClose,
        onOk: () => onRun({ kind, options: { group, variables: chosen, continuous } }),
      },
      h('div', { className: 'ap-dlg' },
        h('div', { className: 'ap-dlg-left' }, h('div', { className: 'ap-dlg-caption' }, '变量'),
          h('div', { className: 'ap-dlg-list' }, others.map((variable) => chip(variable.name, toggle, chosen.includes(variable.name))))),
        h('div', { className: 'ap-dlg-right' },
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '分组变量（必选）'),
            h('select', {
              value: group ?? '',
              onChange: (event) => setGroup(event.target.value || null),
            },
            h('option', { value: '' }, '（选一个分组变量）'),
            variables.map((variable) => h('option', { key: variable.name, value: variable.name, translate: false }, variable.name)))),
          group && chosen.includes(group)
            ? h('div', { className: 'ap-hint' }, '分组变量不会同时作为分析变量（已自动略过）。')
            : null,
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '连续变量的汇总方式'),
            h('select', { value: continuous, onChange: (event) => setContinuous(event.target.value) },
              h('option', { value: 'mean' }, '均数±标准差（P 用 t 检验 / 方差分析）'),
              h('option', { value: 'median' }, '中位数（四分位数间距）（P 仍用 t / F，仅供描述）'))),
          h('div', { className: 'ap-hint' },
            kind === 'baseline'
              ? '分类变量按 n（%）列出，P 值用 Pearson 卡方。'
              : '与表 1 相同，但去掉「总体」列。'),
          h('div', { className: 'ap-hint' }, tr('已选 {0} 个变量{1}', chosen.length, chosen.length ? '' : tr('（不选则用除分组外的全部变量）'))))))
    }

    /**
     * Two-way comparison of the groups of one variable.
     *
     * This is the table a paper needs behind an overall group difference, so it
     * lives next to table 1 / table 2 in the menu and can be reopened from the
     * head of an ANOVA result.
     */
    function PairwiseDialog({ variables, defaults, onRun, onClose }) {
      const numeric = variables.filter((variable) => variable.type === 'numeric')
      const [group, setGroup] = useState(defaults?.group ?? null)
      const [chosen, setChosen] = useState(() => (defaults?.variables ?? [])
        .filter((name) => numeric.some((variable) => variable.name === name)))
      const [adjust, setAdjust] = useState(defaults?.adjust ?? 'bonferroni')
      const [layout, setLayout] = useState(defaults?.layout ?? 'rows')
      const toggle = (name) => setChosen((current) => (current.includes(name)
        ? current.filter((entry) => entry !== name)
        : [...current, name]))
      return h(Modal, {
        title: '两两比较',
        wide: true,
        okDisabled: !group,
        onCancel: onClose,
        onOk: () => onRun({ group, variables: chosen, adjust, layout }),
      },
      h('div', { className: 'ap-dlg' },
        h('div', { className: 'ap-dlg-left' }, h('div', { className: 'ap-dlg-caption' }, '数值变量'),
          numeric.length === 0
            ? h('div', { className: 'ap-hint' }, '这个数据集里没有数值变量')
            : h('div', { className: 'ap-dlg-list' }, numeric.map((variable) => h('span', {
              key: variable.name,
              className: `ap-chip${chosen.includes(variable.name) ? ' ap-chip-on' : ''}`,
              title: variable.label ?? '',
              onClick: () => toggle(variable.name),
              translate: false,
            }, variable.name)))),
        h('div', { className: 'ap-dlg-right' },
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '分组变量（必选）'),
            h('select', {
              value: group ?? '',
              onChange: (event) => setGroup(event.target.value || null),
            },
            h('option', { value: '' }, '（选一个分组变量）'),
            variables.map((variable) => h('option', { key: variable.name, value: variable.name, translate: false }, variable.name)))),
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '多重比较校正'),
            h('select', { value: adjust, onChange: (event) => setAdjust(event.target.value) },
              h('option', { value: 'bonferroni' }, 'Bonferroni（推荐：P × 比较对数，标记按校正后判定）'),
              h('option', { value: 'none' }, '不校正（只在明确需要原始 P 时用）'))),
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '表格形式'),
            h('select', { value: layout, onChange: (event) => setLayout(event.target.value) },
              h('option', { value: 'rows' }, '逐对一行（均数差、标准误、t、df、P、CI、d）'),
              h('option', { value: 'matrix' }, '矩阵表（变量 × 组对，只标星号）'))),
          h('div', { className: 'ap-hint' }, '每一对组做 Welch t 检验，不要求方差齐；矩阵表适合多组论文排版。'),
          h('div', { className: 'ap-hint' }, tr('已选 {0} 个变量{1}', chosen.length, chosen.length ? '' : tr('（不选则用除分组外的全部数值变量）'))))))
    }

    // PSPP has no PARTIAL CORR, so this dialog drives the plugin's own table:
    // pick two or more analysis variables and, optionally, what to control for.
    function PartialDialog({ variables, defaults, onRun, onClose }) {
      const numeric = variables.filter((variable) => variable.type === 'numeric')
      const [chosen, setChosen] = useState(() => (defaults?.variables ?? [])
        .filter((name) => numeric.some((variable) => variable.name === name)))
      const [controls, setControls] = useState(() => (defaults?.controls ?? [])
        .filter((name) => numeric.some((variable) => variable.name === name)))
      const [layout, setLayout] = useState(defaults?.layout ?? 'rows')
      const toggle = (list, setList) => (name) => setList(list.includes(name)
        ? list.filter((entry) => entry !== name)
        : [...list, name])
      return h(Modal, {
        title: '偏相关',
        wide: true,
        okDisabled: chosen.length < 2,
        onCancel: onClose,
        onOk: () => onRun({ variables: chosen, controls, layout }),
      },
      h('div', { className: 'ap-dlg' },
        h('div', { className: 'ap-dlg-left' }, h('div', { className: 'ap-dlg-caption' }, '分析变量（至少两个）'),
          numeric.length === 0
            ? h('div', { className: 'ap-hint' }, '这个数据集里没有数值变量')
            : h('div', { className: 'ap-dlg-list' }, numeric.map((variable) => h('span', {
              key: variable.name,
              className: `ap-chip${chosen.includes(variable.name) ? ' ap-chip-on' : ''}`,
              title: variable.label ?? '',
              onClick: () => toggle(chosen, setChosen)(variable.name),
              translate: false,
            }, variable.name)))),
        h('div', { className: 'ap-dlg-right' },
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '控制变量（可空，选中的变量的影响会被剔除）'),
            numeric.length === 0
              ? null
              : h('div', { className: 'ap-dlg-list' }, numeric
                .filter((variable) => !chosen.includes(variable.name))
                .map((variable) => h('span', {
                  key: variable.name,
                  className: `ap-chip${controls.includes(variable.name) ? ' ap-chip-on' : ''}`,
                  title: variable.label ?? '',
                  onClick: () => toggle(controls, setControls)(variable.name),
                  translate: false,
                }, variable.name)))),
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '表格形式'),
            h('select', { value: layout, onChange: (event) => setLayout(event.target.value) },
              h('option', { value: 'rows' }, '逐对一行（r、df、P、N、标记）'),
              h('option', { value: 'matrix' }, '矩阵（变量 × 变量，只标星号，论文排版用）'))),
          h('div', { className: 'ap-hint' }, '每个变量对做一次：两个变量分别对控制变量回归，再求残差的相关（PSPP 没有 PARTIAL CORR，这张表由插件计算）。'),
          h('div', { className: 'ap-hint' }, '缺失按列表删除，N 是分析变量与控制变量都齐全的个案数；P 用 t = r·√(df/(1-r²))，df = N − 控制变量个数 − 2。'),
          h('div', { className: 'ap-hint' }, tr('已选 {0} 个分析变量、{1} 个控制变量{2}', chosen.length, controls.length, chosen.length < 2 ? tr('（至少选两个分析变量）') : '')))))
    }

    // PSPP's FLIP keeps numeric columns only: a string column comes back as
    // missing values. A silent loss of whole columns is worse than a refusal,
    // so the dialog states what will be lost and needs an explicit tick.
    /**
     * One question with a default answer, used before a close that would throw
     * unsaved edits away. Closing used to call api/close straight away and the
     * only copy of the edits lived in work.sav, with no way back to it.
     */
    function ConfirmDialog({ title, message, okText = '确定', onOk, onClose }) {
      return h(Modal, {
        title,
        okText,
        onCancel: onClose,
        onOk,
      }, h('div', { className: 'ap-hint' }, message))
    }

    function FlipDialog({ strings, onRun, onClose }) {
      const [sure, setSure] = useState(false)
      return h(Modal, {
        title: '转置数据',
        okDisabled: !sure,
        okText: '仍然转置',
        onCancel: onClose,
        onOk: () => onRun(true),
      },
      h('div', { className: 'ap-row' },
        h('span', null, '字符串变量'),
        h('span', { className: 'ap-hint' }, strings.join('、'))),
      h('div', { className: 'ap-hint' }, 'PSPP 的转置只保留数值列：上面这些变量的内容会全部变成缺失值，变量名也会变成 VAR000、VAR001…。要保住内容，请先把它们「重新编码为不同变量」成数值，或者先导出 CSV 处理。'),
      h('label', { className: 'ap-row' },
        h('input', { type: 'checkbox', checked: sure, onChange: (event) => setSure(event.target.checked) }),
        h('span', null, '我明白字符串列的内容会丢失')))
    }

    /**
     * A dialog select writes its options one of three ways: a bare string, a
     * {value,label} object, or a [value, label] tuple. Only the first two were
     * understood, so every tuple select (confidence level, ntiles, post-hoc
     * method, outlier band) rendered as blank rows.
     */
    /**
 * 「因子 = 系数」形式的对比：两个因子以上的模型用。
 *
 * 单因子的「2 -1 -1」走 ONEWAY（引擎自己印 Contrast Tests）；多因子没有引擎通路，
 * 系数必须说清是哪个因子的，所以写成 `a = 2 -1 -1; b = 0 0 1`。
 */
function parseNamedContrasts(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { list: [] }
  const list = []
  for (const chunk of raw.split(/[;；]+/)) {
    const piece = chunk.trim()
    if (piece === '') continue
    const match = piece.match(/^([^=]+)=(.+)$/)
    if (!match) return { error: `多因子对比要写成「因子 = 系数」，例如 a = 2 -1 -1；这一条看不懂：${piece}` }
    const factor = match[1].trim()
    const coefficients = match[2].trim().split(/[\s,，]+/).filter(Boolean).map(Number)
    if (coefficients.some((value) => !Number.isFinite(value))) {
      return { error: `对比系数要是数字，收到「${match[2].trim()}」` }
    }
    if (coefficients.length < 2) return { error: `每个对比至少要两个系数：${piece}` }
    list.push({ label: `${factor}：${coefficients.join(' ')}`, term: { factor, coefficients } })
  }
  return { list }
}

function parseContrasts(text) {
  // Same rules as lib/tools.js: one coefficient per factor level, a semicolon
  // between contrasts. Returning { error } lets the dialog show the reason
  // instead of shipping a statement the engine will silently ignore.
  const raw = String(text ?? '').trim()
  if (raw === '') return { list: [] }
  const list = []
  for (const chunk of raw.split(/[;；\n]+/)) {
    const body = chunk.trim()
    if (body === '') continue
    const coeffs = []
    for (const token of body.split(/[\s,，]+/).filter(Boolean)) {
      const value = Number(token)
      if (!Number.isFinite(value)) return { error: `对比系数要是数字，收到「${token}」` }
      coeffs.push(value)
    }
    if (coeffs.length < 2) return { error: '一个对比至少要两个系数（每个因子水平一个数）' }
    list.push(coeffs)
  }
  if (list.length === 0) return { list: [] }
  const width = list[0].length
  const odd = list.find((coeffs) => coeffs.length !== width)
  if (odd) return { error: `每个对比的系数个数要一样（第一个有 ${width} 个，这一组有 ${odd.length} 个）` }
  return { list }
}

// Names PSPP knows inside an expression: functions, and the few bare words
// that stand for values. Anything else has to be a variable, otherwise the
// engine fails with its own English message and the user cannot tell which
// word was wrong.
const EXPRESSION_WORDS = new Set([
  'MEAN', 'SUM', 'MIN', 'MAX', 'ABS', 'SQRT', 'LN', 'LG10', 'EXP', 'TRUNC', 'RND', 'MOD',
  'SD', 'VARIANCE', 'CFVAR', 'NVALID', 'NMISS', 'MISSING', 'SYSMIS', 'NMISS', 'ANY', 'RANGE',
  'CONCAT', 'SUBSTR', 'UPCASE', 'LOWCASE', 'LENGTH', 'LTRIM', 'RTRIM', 'NUMBER', 'STRING',
  'AND', 'OR', 'NOT', 'TO', 'THRU', 'BY', 'WITH',
])

/**
 * The two mistakes the engine reports in English and at one character of the
 * expression: an unbalanced bracket and a variable that does not exist.
 * Catching them here keeps the panel's own vocabulary.
 */
function checkExpression(expression, target, variables) {
  let depth = 0
  for (const char of expression) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth < 0) return '表达式的括号不成对：多了一个右括号'
  }
  if (depth > 0) return '表达式的括号不成对：少了一个右括号'
  const known = new Set((variables ?? []).map((variable) => String(variable.name).toLowerCase()))
  if (target) known.add(String(target).toLowerCase())
  const words = expression.match(/[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*/g) ?? []
  for (const word of words) {
    const upper = word.toUpperCase()
    if (EXPRESSION_WORDS.has(upper)) continue
    if (known.has(word.toLowerCase())) continue
    return `表达式里的「${word}」不是当前数据集里的变量：变量名区分大小写之外按原样写，函数名请从下面点选`
  }
  return null
}

function normalizeChoices(list) {
      return (Array.isArray(list) ? list : []).map((option) => {
        if (Array.isArray(option)) return { value: String(option[0] ?? ''), label: String(option[1] ?? option[0] ?? '') }
        if (typeof option === 'string') return { value: option, label: option }
        return option
      })
    }

    function AnalysisDialog({ spec, variables, rows, onRun, onClose, onPaste, initial = null }) {
      const fields = spec.fields ?? []
      const groups = spec.groups ?? []
      // Named factories so 重置 can rebuild exactly what opening the dialog did.
      const freshValues = () => ({ ...(spec.defaults ?? {}), ...(initial ?? {}) })
      const freshFlags = () => {
        const start = {}
        for (const group of groups) {
          start[group.key] = Object.fromEntries((group.items ?? []).map((item) => [item.key, item.default === true]))
        }
        return start
      }
      const [values, setValues] = useState(freshValues)
      const [flags, setFlags] = useState(freshFlags)
      const [active, setActive] = useState(fields[0]?.key ?? null)
      const [sheet, setSheet] = useState(null)
      const [helpOpen, setHelpOpen] = useState(false)
      // SPSS highlights one variable in the list and moves it with ▶; the
      // checkboxes stay as the fast path for people used to ticking.
      const [current, setCurrent] = useState(null)
      const activeField = fields.find((field) => field.key === active) ?? fields[0] ?? null
      const setValue = (key, value) => setValues((current) => ({ ...current, [key]: value }))
      const setFlag = (groupKey, itemKey, value) => setFlags((current) => ({
        ...current,
        [groupKey]: { ...current[groupKey], [itemKey]: value },
      }))

      const toggle = (name) => {
        if (!activeField) return
        if (activeField.kind === 'single') {
          setValue(activeField.key, values[activeField.key] === name ? null : name)
          return
        }
        if (activeField.kind !== 'multi') return
        const list = values[activeField.key] ?? []
        setValue(activeField.key, list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name])
      }

      const distinctValues = (name) => {
        const index = (variables ?? []).findIndex((variable) => variable.name === name)
        const found = []
        if (index < 0) return found
        for (const row of rows ?? []) {
          const value = row?.[index]
          if (value === null || value === undefined || value === '') continue
          if (!found.includes(value)) found.push(value)
          if (found.length >= 12) break
        }
        return found
      }

      const valueChoices = (field) => {
        const source = (variables ?? []).find((variable) => variable.name === values[field.from])
        const labeled = Object.entries(source?.valueLabels ?? {}).map(([value, label]) => ({ value, label }))
        if (labeled.length > 0) return labeled
        return distinctValues(values[field.from]).map((value) => ({ value: String(value), label: String(value) }))
      }

      const ready = fields.every((field) => {
        if (!field.required) return true
        const value = values[field.key]
        if (field.kind === 'values') {
          const chosen = Array.isArray(value) ? value : String(value ?? '').trim() ? [String(value)] : []
          return chosen.length >= 2
        }
        return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value) !== ''
      })

      // A field accepts a variable only of the kind it declares; the list greys
      // the rest out, and the arrow has to respect the same rule.
      const compatibleWith = (field, name) => {
        const variable = (variables ?? []).find((entry) => entry.name === name)
        if (!field || !variable) return false
        return !field.accept || field.accept === 'any'
          || (field.accept === 'numeric' ? variable.type === 'numeric' : variable.type === 'string')
      }
      const toggleInField = (field, name) => {
        if (!compatibleWith(field, name)) return
        if (field.kind === 'single') { setValue(field.key, values[field.key] === name ? null : name); return }
        if (field.kind !== 'multi') return
        const list = values[field.key] ?? []
        setValue(field.key, list.includes(name) ? list.filter((entry) => entry !== name) : [...list, name])
      }

      const variableList = h('div', { className: 'ap-dlg-left' },
        h('div', { className: 'ap-dlg-caption' }, '变量列表'),
        h('div', { className: 'ap-dlg-list' },
          variables.length === 0
            ? h('span', { className: 'ap-hint' }, '没有变量')
            : variables.map((variable) => {
              const chosen = activeField
                ? (activeField.kind === 'single'
                  ? values[activeField.key] === variable.name
                  : (values[activeField.key] ?? []).includes(variable.name))
                : false
              const compatible = !activeField?.accept || activeField.accept === 'any'
                || (activeField.accept === 'numeric' ? variable.type === 'numeric' : variable.type === 'string')
              return h('label', {
                key: variable.name,
                className: `ap-dlg-var ${chosen ? 'ap-chosen' : ''} ${compatible ? '' : 'ap-disabled'} ${current === variable.name ? 'ap-current' : ''}`,
                title: compatible ? '' : (activeField?.accept === 'numeric' ? '需要数值变量' : '需要字符串变量'),
                onClick: () => setCurrent(variable.name),
              },
                h('input', { type: 'checkbox', checked: chosen, disabled: !compatible, onChange: () => toggle(variable.name) }),
                h('span', { translate: false }, variable.name),
                variable.label ? h('span', { className: 'ap-hint', translate: false }, ` ${variable.label}`) : null)
            })))

      const fieldBox = (field) => {
        if (field.kind === 'values') {
          const choices = valueChoices(field)
          const chosen = Array.isArray(values[field.key]) ? values[field.key] : []
          const chips = choices.length === 0
            ? h('input', {
              type: 'text',
              value: Array.isArray(values[field.key]) ? values[field.key].join(' ') : (values[field.key] ?? ''),
              placeholder: field.placeholder ?? '1 2',
              onChange: (event) => setValue(field.key, event.target.value),
            })
            : h('div', { className: 'ap-dlg-chips' }, choices.map((choice) => h('label', {
              key: choice.value,
              className: `ap-chip ${chosen.includes(choice.value) ? 'ap-chip-on' : ''}`,
              title: choice.label,
              translate: false,
            },
            h('input', {
              type: 'checkbox',
              checked: chosen.includes(choice.value),
              onChange: () => {
                const next = chosen.includes(choice.value)
                  ? chosen.filter((entry) => entry !== choice.value)
                  : [...chosen, choice.value]
                setValue(field.key, next.slice(0, 2))
              },
            }),
            choice.label === choice.value ? choice.value : `${choice.value} = ${choice.label}`)))
          return h('div', { key: field.key, className: 'ap-dlg-box ap-dlg-form' },
            h('div', { className: 'ap-dlg-caption' }, field.label),
            chips,
            field.hint ? h('div', { className: 'ap-hint' }, field.hint) : null)
        }
        if (field.kind === 'text' || field.kind === 'number' || field.kind === 'select') {
          const options = normalizeChoices(field.options)
          const control = field.kind === 'select'
            ? h('select', {
              value: values[field.key] ?? options[0]?.value,
              onChange: (event) => setValue(field.key, event.target.value),
            }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
            : h('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              value: values[field.key] ?? '',
              placeholder: field.placeholder ?? '',
              onChange: (event) => setValue(field.key, event.target.value),
            })
          // SPSS's Compute Variable dialog has a function list beside the
          // expression box. A dropdown of every PSPP function would be noise, so
          // the dialog carries the handful people actually reach for, plus the
          // variables themselves; a click appends to the expression.
          const suggestions = [
            ...(field.suggestions ?? []),
            ...(field.suggestVariables ? (variables ?? []).map((variable) => variable.name) : []),
          ]
          const append = (piece) => {
            const current = Array.isArray(values[field.key]) ? values[field.key].join(' ') : String(values[field.key] ?? '')
            const glued = /[\s(,]$/.test(current) || current === '' ? '' : ' '
            setValue(field.key, `${current}${glued}${piece}`)
          }
          return h('div', { key: field.key, className: 'ap-dlg-box ap-dlg-form' },
            h('div', { className: 'ap-dlg-caption' }, field.label),
            control,
            suggestions.length === 0
              ? null
              : h('div', { className: 'ap-suggest' },
                h('span', { className: 'ap-hint' }, tr('插入：')),
                suggestions.map((piece) => h('button', {
                  key: piece,
                  className: 'ap-suggest-btn',
                  translate: false,
                  onClick: () => append(piece),
                }, piece))),
            field.hint ? h('div', { className: 'ap-hint' }, field.hint) : null)
        }
        const list = field.kind === 'single'
          ? (values[field.key] ? [values[field.key]] : [])
          : (values[field.key] ?? [])
        const chips = list.length === 0
          ? h('span', { className: 'ap-hint' }, '（空）')
          : list.map((name) => h('span', { key: name, className: 'ap-chip' },
            name,
            h('button', {
              className: 'ap-chip-x',
              onClick: (event) => { event.stopPropagation(); toggle(name) },
            }, '×')))
        return h('div', {
          key: field.key,
          className: `ap-dlg-box ${active === field.key ? 'ap-active-box' : ''}`,
          onClick: () => setActive(field.key),
        },
        h('div', { className: 'ap-dlg-caption' }, field.label),
        h('div', { className: 'ap-dlg-chips' }, chips))
      }

      // SPSS puts a 28px column of ▶ between the list and the target boxes; here
      // the boxes are stacked, so each box carries its own arrow at its left
      // edge — same width, and it lines up with the box it fills.
      const fieldColumn = h('div', { className: 'ap-dlg-right' }, fields.map((field) => h('div', {
        key: `row-${field.key}`,
        className: 'ap-dlg-field',
      },
      h('button', {
        className: 'ap-dlg-arrow',
        disabled: !current || !compatibleWith(field, current),
        title: current ? tr('把 {0} 加入 / 移出这个框', current) : '先在左侧点一个变量',
        onClick: () => toggleInField(field, current),
      }, '▶'),
      fieldBox(field))))
      const body = h('div', { className: 'ap-dlg' }, variableList, fieldColumn)
      // 帮助 is not decoration: it shows the PSPP syntax 确定 would run, which
      // is also what 粘贴 hands to the syntax editor.
      const preview = ready ? spec.build(values, flags, variables) : null
      const previewSyntax = typeof preview?.syntax === 'string' ? preview.syntax : null
      const helpNode = !helpOpen ? null : h('div', { className: 'ap-dlg-help' },
        h('div', { className: 'ap-dlg-caption' }, '这个过程会执行什么'),
        previewSyntax
          ? h('pre', { className: 'ap-dlg-help-code' }, previewSyntax)
          : h('div', { className: 'ap-hint' }, ready
            ? '这个对话框直接画图（或在插件里计算），不生成 PSPP 语法。'
            : '先把左边必填的变量选上，这里会显示「确定」将要执行的语法。'),
        h('div', { className: 'ap-hint' }, '确定 = 运行；粘贴 = 只把语法放进语法编辑器，不运行；重置 = 恢复成刚打开时的设置。'))
      const sheetGroup = groups.find((group) => group.key === sheet)
      const sheetNode = sheetGroup
        ? h(Modal, {
          title: sheetGroup.title,
          onCancel: () => setSheet(null),
          onOk: () => setSheet(null),
          okText: '继续',
        }, (sheetGroup.items ?? []).map((item) => {
          const current = (flags[sheetGroup.key] ?? {})[item.key]
          if (item.kind === 'select') {
            const options = normalizeChoices(item.options)
            return h('label', { key: item.key, className: 'ap-check ap-check-row' },
              h('span', null, item.label),
              h('select', {
                value: current === true || current === false || current === undefined
                  ? (item.default ?? options[0]?.value)
                  : current,
                onChange: (event) => setFlag(sheetGroup.key, item.key, event.target.value),
              }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))))
          }
          return h('label', { key: item.key, className: 'ap-check' },
            h('input', {
              type: 'checkbox',
              // Before the user touches it the flag is undefined; show the
              // item's own default so a box that starts on does not look off.
              checked: current === undefined ? item.default === true : current === true,
              onChange: (event) => setFlag(sheetGroup.key, item.key, event.target.checked),
            }),
            h('span', null, item.label))
        }))
        : null

      return h(Modal, {
        title: spec.title,
        wide: true,
        okDisabled: !ready,
        onCancel: onClose,
        leading: groups.map((group) => h('button', {
          key: group.key,
          className: 'ap-tool',
          onClick: () => setSheet(group.key),
        }, `${tr(group.title)}…`)),
        onPaste: onPaste && ready && previewSyntax
          ? () => onPaste(previewSyntax)
          : undefined,
        onReset: () => {
          setValues(freshValues())
          setFlags(freshFlags())
          setCurrent(null)
          setHelpOpen(false)
          setActive(fields[0]?.key ?? null)
        },
        onHelp: () => setHelpOpen((open) => !open),
        onOk: () => {
          const built = spec.build(values, flags, variables)
          onRun(built, spec)
        },
      }, body, helpNode, sheetNode)
    }

    const onKeys = (flags, group) => Object.entries(flags?.[group] ?? {}).filter(([, on]) => on).map(([key]) => key)
    const mapKeys = (keys, table) => keys.map((key) => table[key]).filter(Boolean)

    const ANALYSIS_SPECS = {
      frequencies: {
        title: '频率',
        fields: [
          { key: 'vars', kind: 'multi', label: '变量', required: true, accept: 'numeric' },
          { key: 'percentiles', kind: 'text', label: '百分位', placeholder: '25 50 75' },
        ],
        groups: [
          { key: 'statistics', title: '统计量', items: [
            { key: 'mean', label: '均值', default: true },
            { key: 'std', label: '标准差', default: true },
            { key: 'median', label: '中位数', default: true },
            { key: 'mode', label: '众数' },
            { key: 'min', label: '最小值', default: true },
            { key: 'max', label: '最大值', default: true },
            { key: 'sum', label: '总和' },
            { key: 'variance', label: '方差' },
            { key: 'skew', label: '偏度' },
            { key: 'kurt', label: '峰度' },
          ] },
          { key: 'charts', title: '图表', items: [
            { key: 'bar', label: '条形图' },
            { key: 'histogram', label: '直方图' },
          ] },
        ],
        build: (v, flags) => {
          const stats = mapKeys(onKeys(flags, 'statistics'), {
            mean: 'MEAN', std: 'STDDEV', median: 'MEDIAN', mode: 'MODE', min: 'MIN', max: 'MAX',
            sum: 'SUM', variance: 'VARIANCE', skew: 'SKEWNESS', kurt: 'KURTOSIS',
          })
          const parts = [`FREQUENCIES /VARIABLES=${v.vars.join(' ')}`]
          if (stats.length) parts.push(`/STATISTICS=${stats.join(' ')}`)
          const percentiles = String(v.percentiles ?? '').trim()
          if (percentiles) parts.push(`/PERCENTILES=${percentiles}`)
          if (flags?.charts?.bar) parts.push('/BARCHART')
          if (flags?.charts?.histogram) parts.push('/HISTOGRAM')
          return { syntax: `${parts.join(' ')}.` }
        },
      },
      descriptives: {
        title: '描述',
        fields: [
          { key: 'vars', kind: 'multi', label: '变量', required: true, accept: 'numeric' },
          { key: 'percentiles', kind: 'text', label: '百分位数（可选）', placeholder: '25 50 75' },
        ],
        groups: [
          { key: 'statistics', title: '统计量', items: [
            { key: 'mean', label: '均值', default: true },
            { key: 'std', label: '标准差', default: true },
            { key: 'min', label: '最小值', default: true },
            { key: 'max', label: '最大值', default: true },
            { key: 'semean', label: '均值标准误' },
            { key: 'variance', label: '方差' },
            { key: 'range', label: '极差' },
            { key: 'skew', label: '偏度' },
            { key: 'seskew', label: '偏度标准误' },
            { key: 'kurt', label: '峰度' },
            { key: 'sekurt', label: '峰度标准误' },
            { key: 'median', label: '中位数' },
            { key: 'mode', label: '众数' },
            { key: 'sum', label: '总和' },
            { key: 'save', label: '将标准化值另存为变量（Z<变量名>）' },
          ] },
        ],
        build: (v, flags) => {
          const stats = mapKeys(onKeys(flags, 'statistics'), {
            mean: 'MEAN', std: 'STDDEV', min: 'MINIMUM', max: 'MAXIMUM', semean: 'SEMEAN', variance: 'VARIANCE',
            range: 'RANGE', skew: 'SKEWNESS', seskew: 'SESKEWNESS', kurt: 'KURTOSIS', sekurt: 'SEKURTOSIS',
            median: 'MEDIAN', mode: 'MODE', sum: 'SUM', save: '',
          })
          const variables = v.vars.join(' ')
          const wanted = String(v.percentiles ?? '').trim().split(/[\s,]+/).filter(Boolean)
          // DESCRIPTIVES rejects MEDIAN/MODE, so either one (or a percentile
          // list) sends the same request through FREQUENCIES without the table.
          const freqOnly = stats.filter((name) => name === 'MEDIAN' || name === 'MODE')
          // /SAVE only exists on DESCRIPTIVES, so the Z variables are asked for
          // in their own statement when the table has to go through FREQUENCIES.
          const save = flags?.statistics?.save === true
          const zScores = save ? `DESCRIPTIVES /VARIABLES=${variables} /SAVE.\n` : ''
          if (wanted.length || freqOnly.length > 0) {
            const merged = [...new Set([...stats, 'MEDIAN'])]
            for (const token of wanted) {
              if (!/^\d+(\.\d+)?$/.test(token)) return { error: `百分位数只能是数字：${token}` }
            }
            const suffix = wanted.length > 0 ? ` /PERCENTILES=${wanted.join(' ')}` : ''
            return {
              syntax: `${zScores}FREQUENCIES /VARIABLES=${variables} /FORMAT=NOTABLE /STATISTICS=${merged.join(' ')}${suffix}.`,
              persist: save,
            }
          }
          const statList = stats.filter((name) => name !== 'SAVE')
          return {
            syntax: `DESCRIPTIVES /VARIABLES=${variables}${statList.length ? ` /STATISTICS=${statList.join(' ')}` : ''}${save ? ' /SAVE' : ''}.`,
            persist: save,
          }
        },
      },
      crosstabs: {
        title: '交叉表',
        fields: [
          { key: 'row', kind: 'single', label: '行变量', required: true },
          { key: 'col', kind: 'single', label: '列变量', required: true },
          { key: 'layer', kind: 'single', label: '分层变量（可选）' },
        ],
        groups: [
          { key: 'statistics', title: '统计量', items: [
            { key: 'chisq', label: '卡方', default: true },
            { key: 'phi', label: 'Phi / Cramer V' },
            { key: 'cc', label: '列联系数' },
            { key: 'lambda', label: 'Lambda' },
            { key: 'uc', label: '不确定性系数' },
            { key: 'gamma', label: 'Gamma' },
            { key: 'btau', label: "Kendall tau-b" },
            { key: 'ctau', label: 'Kendall tau-c' },
            { key: 'somersd', label: "Somers' d" },
            { key: 'eta', label: 'Eta' },
            { key: 'corr', label: 'Spearman / Pearson R' },
            { key: 'risk', label: '风险估计（2×2）' },
            // Kappa needs a square table; PSPP prints it under Symmetric Measures.
            // Turning it on also keeps CHISQ on, because the Cramér's V line and
            // the small-sample Fisher hint hang off the chi-square table.
            { key: 'kappa', label: 'Kappa（方表一致性）' },
            // PSPP prints Fisher only for 2×2 and rejects /METHOD=EXACT, so the
            // exact p for a bigger table is computed in the plugin and written
            // as a note on the crosstab the engine prints.
            { key: 'exact', label: '精确检验（插件按边际枚举）' },
            // Same machinery, different statistic: the exact p of Pearson's
            // chi-square and of the likelihood ratio, which SPSS offers under
            // Crosstabs → Exact Tests.
            { key: 'exactchi', label: '精确卡方 p（插件按边际枚举）' },
            // PSPP rejects CMH outright, so the keyword is stripped before the
            // engine runs and the statistic is computed from the per-layer
            // counts in the plugin (see dropCmhStatistic in the host half).
            { key: 'cmh', label: '分层卡方 CMH（插件计算，需层变量）' },
          ] },
          { key: 'cells', title: '单元格', items: [
            { key: 'count', label: '计数', default: true },
            { key: 'row', label: '行百分比' },
            { key: 'col', label: '列百分比' },
            { key: 'total', label: '总百分比' },
            { key: 'expected', label: '期望频数' },
            { key: 'resid', label: '残差' },
            { key: 'sresid', label: '标准化残差' },
            { key: 'asresid', label: '调整后标准化残差' },
          ] },
        ],
        build: (v, flags) => {
          const stats = mapKeys(onKeys(flags, 'statistics'), {
            chisq: 'CHISQ', phi: 'PHI', cc: 'CC', lambda: 'LAMBDA', gamma: 'GAMMA', kappa: 'KAPPA',
            uc: 'UC', btau: 'BTAU', ctau: 'CTAU', somersd: 'D', eta: 'ETA', corr: 'CORR', risk: 'RISK',
            exact: 'EXACT',
            exactchi: 'EXACTCHI',
            cmh: 'CMH',
          })
          // Kappa also implies the chi-square table: the Cramér's V line and the
          // small-sample "look at Fisher's Exact Test" note are written onto it.
          if (stats.includes('KAPPA') && !stats.includes('CHISQ')) stats.push('CHISQ')
          const cells = mapKeys(onKeys(flags, 'cells'), {
            count: 'COUNT',
            row: 'ROW',
            col: 'COLUMN',
            total: 'TOTAL',
            expected: 'EXPECTED',
            resid: 'RESID',
            sresid: 'SRESID',
            asresid: 'ASRESID',
          })
          const layer = (v.layer ?? '').trim()
          // 精确检验不写进语法（PSPP 的 /METHOD=EXACT 是语法错误），而是让宿主
          // 在引擎那张交叉表上补一条注：所以它单独作为标志返回。
          const exact = onKeys(flags, 'statistics').includes('exact')
          const exactChi = onKeys(flags, 'statistics').includes('exactchi')
          const parts = [`CROSSTABS /TABLES=${v.row} BY ${v.col}${layer ? ` BY ${layer}` : ''}`]
          const printable = stats.filter((name) => name !== 'EXACT' && name !== 'EXACTCHI')
          if (printable.length) parts.push(`/STATISTICS=${printable.join(' ')}`)
          parts.push(`/CELLS=${(cells.length ? cells : ['COUNT']).join(' ')}`)
          return { syntax: `${parts.join(' ')}.`, exact, exactChi }
        },
      },
      explore: {
        title: '探索',
        fields: [
          { key: 'vars', kind: 'multi', label: '因变量列表', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '因子列表（可选）', accept: 'any' },
        ],
        groups: [
          { key: 'plots', title: '绘图', items: [
            { key: 'boxplot', label: '箱线图', default: true },
            { key: 'histogram', label: '直方图' },
            { key: 'npplot', label: '正态概率图' },
          ] },
        ],
        build: (v, flags) => {
          const plots = mapKeys(onKeys(flags, 'plots'), { boxplot: 'BOXPLOT', histogram: 'HISTOGRAM', npplot: 'NPPLOT' })
          const plotList = (plots.length ? plots : ['BOXPLOT']).join(' ')
          // PSPP 2.1.3 prints the normality test for the first variable only when
          // one EXAMINE lists several, so give each variable its own command.
          const lines = v.vars.map((name) => `EXAMINE ${name}${v.by ? ` BY ${v.by}` : ''} /PLOT=${plotList}.`)
          return { syntax: lines.join('\n') }
        },
      },
      means: {
        title: '平均值',
        fields: [
          { key: 'vars', kind: 'multi', label: '因变量列表', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '自变量列表', required: true, accept: 'any' },
        ],
        groups: [
          { key: 'cells', title: '单元格统计', items: [
            { key: 'mean', label: '均值', default: true },
            { key: 'count', label: '个案数', default: true },
            { key: 'std', label: '标准差', default: true },
            { key: 'min', label: '最小值' },
            { key: 'max', label: '最大值' },
            { key: 'sum', label: '总和' },
            { key: 'variance', label: '方差' },
            { key: 'range', label: '极差' },
          ] },
        ],
        build: (v, flags) => {
          const cells = mapKeys(onKeys(flags, 'cells'), {
            mean: 'MEAN', count: 'COUNT', std: 'STDDEV', min: 'MIN', max: 'MAX',
            sum: 'SUM', variance: 'VARIANCE', range: 'RANGE',
          })
          return { syntax: `MEANS ${v.vars.join(' ')} BY ${v.by} /CELLS=${(cells.length ? cells : ['MEAN COUNT STDDEV']).join(' ')}.` }
        },
      },
      ttest: {
        title: '独立样本 T 检验',
        fields: [
          { key: 'vars', kind: 'multi', label: '检验变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '分组变量', required: true, accept: 'any' },
          { key: 'groups', kind: 'values', from: 'by', label: '组值（选两个）', placeholder: '1 2', required: true, hint: '从该分组变量的观测值里选两个；没有可选值时手填' },
        ],
        defaults: { groups: '1 2' },
        groups: [
          { key: 'options', title: '选项', items: [
            { key: 'ci', label: '置信区间 95%', default: true },
          ] },
        ],
        build: (v, flags, variables) => {
          const target = (variables ?? []).find((variable) => variable.name === v.by)
          const isString = target?.type === 'string'
          const raw = Array.isArray(v.groups)
            ? v.groups.map((entry) => String(entry))
            : (String(v.groups ?? '').match(/'[^']*'|\S+/g) ?? [])
          const values = raw.map((token) => (isString && !token.startsWith("'") ? `'${token}'` : token))
          return {
            syntax: `T-TEST GROUPS=${v.by}(${values.join(' ')}) /VARIABLES=${v.vars.join(' ')}${flags?.options?.ci ? ' /CRITERIA=CI(.95)' : ''}.`,
            // The two groups are already fixed here; a pairwise table over them
            // is the same Welch test, so offer the button on the result.
            pairwise: { group: v.by, variables: v.vars },
          }
        },
      },
      ttest1: {
        title: '单样本 T 检验',
        fields: [
          { key: 'vars', kind: 'multi', label: '检验变量', required: true, accept: 'numeric' },
          { key: 'testValue', kind: 'text', label: '检验值', placeholder: '0', default: '0' },
        ],
        groups: [
          { key: 'options', title: '选项', items: [
            { key: 'ci', label: '置信区间 95%', default: true },
          ] },
        ],
        build: (v, flags) => {
          const testValue = String(v.testValue ?? '').trim() || '0'
          return {
            syntax: `T-TEST /TESTVAL=${testValue} /VARIABLES=${v.vars.join(' ')}${flags?.options?.ci ? ' /CRITERIA=CI(.95)' : ''}.`,
          }
        },
      },
      sample: {
        title: '随机抽样',
        fields: [
          { key: 'percent', kind: 'text', label: '抽样比例（%）', placeholder: '25', default: '25' },
        ],
        hint: '按近似比例抽取个案；结果直接写回数据集（不可撤销）',
        build: (v) => {
          const percent = Number(String(v.percent ?? '').trim() || '25')
          if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('抽样比例需为 1–100 之间的数字')
          const fraction = Math.min(1, percent / 100)
          return { syntax: `SAMPLE ${fraction}.`, persist: true }
        },
      },
      count: {
        title: '计数',
        fields: [
          { key: 'target', kind: 'text', label: '目标变量名', placeholder: 'cnt', required: true },
          { key: 'vars', kind: 'multi', label: '被计数的变量', required: true },
          { key: 'value', kind: 'text', label: '计数的值', placeholder: '1', required: true },
        ],
        hint: '统计每个个案在所选变量中出现该值的次数，生成新变量',
        build: (v) => {
          const target = String(v.target ?? '').trim()
          if (!/^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_.\u4e00-\u9fa5]*$/.test(target)) throw new Error('目标变量名不合法')
          const raw = String(v.value ?? '').trim()
          const literal = /^-?\d+(\.\d+)?$/.test(raw) ? raw : `'${raw.replace(/'/g, '')}'`
          return { syntax: `COUNT ${target} = ${v.vars.join(' ')} (${literal}).`, persist: true }
        },
      },
      rank: {
        title: '排秩',
        hint: 'PSPP 的 RANK 支持 RANK / N / PERCENT / PROPORTION / RFRACTION / NORMAL / SAVAGE / NTILES；新变量名按类型自动取，避免重名时再改一次。',
        fields: [
          { key: 'variable', kind: 'single', label: '排序变量', required: true, accept: 'numeric' },
          { key: 'target', kind: 'text', label: '秩变量名', placeholder: 'rx', default: 'rx' },
        ],
        groups: [
          { key: 'types', title: '秩类型', items: [
            { key: 'rank', label: '秩（RANK）', default: true },
            { key: 'n', label: '累计个案数（N）' },
            { key: 'percent', label: '百分位（PERCENT）' },
            { key: 'proportion', label: '比例估计（PROPORTION）' },
            { key: 'rfraction', label: '相对秩（RFRACTION）' },
            { key: 'normal', label: '正态得分（NORMAL）' },
            { key: 'savage', label: 'Savage 得分（SAVAGE）' },
            { key: 'ntiles', label: '分位数（NTILES）', kind: 'select', default: '0', options: [
              ['0', '不做'],
              ['2', '2 分位（中位数）'],
              ['4', '4 分位'],
              ['5', '5 分位'],
              ['10', '10 分位'],
              ['100', '100 分位'],
            ] },
          ] },
          { key: 'ties', title: '结值处理', items: [
            { key: 'mean', label: '平均值（默认）', default: true },
            { key: 'low', label: '低值' },
            { key: 'high', label: '高值' },
          ] },
        ],
        build: (v, flags) => {
          const name = String(v.variable ?? '')
          const base = name.replace(/[^A-Za-z0-9_]/g, '_')
          const target = String(v.target ?? '').trim() || `r_${base}`
          const ties = flags?.ties?.low ? 'LOW' : flags?.ties?.high ? 'HIGH' : 'MEAN'
          const on = (key, fallback = false) => (flags?.types?.[key] === undefined ? fallback : flags.types[key] === true)
          const parts = []
          if (on('rank', true)) parts.push(`/RANK INTO ${target}`)
          if (on('n')) parts.push(`/N INTO n_${base}`)
          if (on('percent')) parts.push(`/PERCENT INTO p_${base}`)
          if (on('proportion')) parts.push(`/PROPORTION INTO prop_${base}`)
          if (on('rfraction')) parts.push(`/RFRACTION INTO rf_${base}`)
          if (on('normal')) parts.push(`/NORMAL INTO z_${base}`)
          if (on('savage')) parts.push(`/SAVAGE INTO sv_${base}`)
          const ntiles = Number(flags?.types?.ntiles ?? 0)
          if (Number.isFinite(ntiles) && ntiles >= 2) parts.push(`/NTILES(${Math.round(ntiles)}) INTO q_${base}`)
          if (parts.length === 0) return { error: '至少勾一种秩类型' }
          return { syntax: `RANK VARIABLES=${name} ${parts.join(' ')} /TIES=${ties}.`, persist: true }
        },
      },
      tpaired: {
        title: '配对样本 T 检验',
        fields: [{ key: 'vars', kind: 'multi', label: '成对变量（按顺序两两配对）', required: true }],
        build: (v) => {
          const pairs = []
          for (let index = 0; index + 1 < v.vars.length; index += 2) pairs.push(`${v.vars[index]} ${v.vars[index + 1]}`)
          return { syntax: `T-TEST PAIRS=${pairs.join(' ')}.` }
        },
      },
      oneway: {
        title: '单因素 ANOVA',
        fields: [
          { key: 'vars', kind: 'multi', label: '因变量列表', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '因子', required: true, accept: 'any' },
        ],
        groups: [
          { key: 'statistics', title: '统计量', items: [
            { key: 'desc', label: '描述性', default: true },
            { key: 'homog', label: '方差齐性检验' },
          ] },
          // PSPP 2.1.3 only implements these five; Dunnett/Duncan/SNK/Gabriel
          // are rejected by the engine, so they are not offered.
          { key: 'posthoc', title: '事后检验', items: [
            { key: 'tukey', label: 'Tukey' },
            { key: 'lsd', label: 'LSD' },
            { key: 'bonferroni', label: 'Bonferroni' },
            { key: 'sidak', label: 'Sidak' },
            { key: 'scheffe', label: 'Scheffé' },
          ] },
        ],
        build: (v, flags) => {
          const stats = mapKeys(onKeys(flags, 'statistics'), { desc: 'DESCRIPTIVES', homog: 'HOMOGENEITY' })
          const posthoc = mapKeys(onKeys(flags, 'posthoc'), { tukey: 'TUKEY', lsd: 'LSD', bonferroni: 'BONFERRONI', sidak: 'SIDAK', scheffe: 'SCHEFFE' })
          const parts = [`ONEWAY ${v.vars.join(' ')} BY ${v.by}`]
          if (stats.length) parts.push(`/STATISTICS=${stats.join(' ')}`)
          if (posthoc.length) parts.push(`/POSTHOC=${posthoc.join(' ')}`)
          return { syntax: `${parts.join(' ')}.`, pairwise: { group: v.by, variables: v.vars } }
        },
      },
      glm: {
        title: '一般线性模型（单变量）',
        hint: 'PSPP 的 GLM 没有事后检验（/POSTHOC 会报语法错误），勾了事后检验时插件会另跑一条 ONEWAY——同一个单因子模型，事后表就是 SPSS「事后多重比较」那张。PSPP 2.1.3 的 GLM 也不接受 WITH，所以这里没有协变量栏（SPSS 的「协变量」框在本插件里没有对应项）；要调整协变量请用分析 → 回归 → 线性回归。',
        fields: [
          { key: 'vars', kind: 'multi', label: '因变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '固定因子', required: true, accept: 'any' },
          { key: 'by2', kind: 'single', label: '第二因子（可选，加了就是双因子模型）', accept: 'any' },
        ],
        groups: [
          { key: 'model', title: '模型', items: [
            { key: 'design', label: '设计', kind: 'select', default: 'auto', options: [
              ['auto', '自动（因子主效应 + 二阶交互 + 协变量）'],
              ['main', '只要主效应（因子与协变量都不交互）'],
              ['custom', '自定义（自己写 /DESIGN 的右侧）'],
            ] },
            { key: 'custom', label: '自定义设计（写在 /DESIGN= 后面的部分）', kind: 'text',
              hint: '例如 g x 或 a b a*b x；只写右边，不要写 /DESIGN=' },
          ] },
          { key: 'options', title: '选项', items: [
            { key: 'contrasts', label: '对比系数（每个水平一个数；双因子写成「因子 = 数」）', kind: 'text', hint: '单因子：三个水平想让「第 1 组对其余两组」写 2 -1 -1，两个对比写 2 -1 -1; 0 1 -1，走 ONEWAY 由引擎印 Contrast Tests。双因子：写成 a = 2 -1 -1; b = 0 0 1，插件在自己的设计矩阵上算（PSPP 的 GLM 没有 /CONTRAST），主效应用等权组合，与 SPSS 的 Type III 一致。' },
            { key: 'posthoc', label: '事后检验', kind: 'select', default: '0', options: [
              ['0', '不做'],
              ['LSD', 'LSD（最小显著差）'],
              ['BONFERRONI', 'Bonferroni'],
              ['SIDAK', 'Sidak'],
              ['TUKEY', 'Tukey HSD'],
              ['SCHEFFE', 'Scheffé'],
            ] },
          ] },
        ],
        build: (v, flags) => {
          const posthoc = String(flags?.options?.posthoc ?? '0')
          const usePosthoc = posthoc !== '0'
          const by2 = String(v.by2 ?? '').trim()
          const mode = String(flags?.model?.design ?? 'auto')
          const custom = String(flags?.model?.custom ?? '').trim()
          const dependent = v.vars[0]
          if (mode === 'custom') {
            if (!custom) return { error: '自定义设计是空的：写 /DESIGN 后面的部分，例如 g x' }
            const byAll = [v.by, by2].filter(Boolean).join(' ')
            return { syntax: `GLM ${dependent} BY ${byAll} /DESIGN=${custom}.` }
          }
          // A second factor means the design has an interaction, and then there is
          // no engine path for contrasts at all: fit them on our design matrix.
          if (by2 !== '') {
            if (usePosthoc) return { error: '双因子模型没有引擎事后检验（PSPP 的 GLM 不收 /POSTHOC，ONEWAY 只做单因子）：去掉事后检验，或者只用单因子' }
            const named = parseNamedContrasts(flags?.options?.contrasts)
            if (named.error) return { error: named.error }
            const design = [v.by, by2, ...(mode === 'main' ? [] : [`${v.by}*${by2}`])].join(' ')
            return {
              syntax: `GLM ${dependent} BY ${v.by} ${by2} /DESIGN=${design}.`,
              contrasts: named.list.length > 0
                ? { dependent, factors: [v.by, by2], covariates: [], hypotheses: named.list }
                : null,
            }
          }
          const parsed = parseContrasts(flags?.options?.contrasts)
          if (parsed.error) return { error: parsed.error }
          const glm = `GLM ${v.vars.join(' ')} BY ${v.by} /DESIGN=${v.by}.`
          const dependentList = v.vars.join(' ') || v.vars[0]
          let syntax = glm
          if (usePosthoc || parsed.list.length > 0) {
            const parts = [`ONEWAY ${dependentList} BY ${v.by}`]
            if (usePosthoc) parts.push('/STATISTICS=DESCRIPTIVES HOMOGENEITY', `/POSTHOC=${posthoc} ALPHA(0.05)`)
            parsed.list.forEach((coeffs) => parts.push(`/CONTRAST=${coeffs.join(' ')}`))
            syntax = `${glm}\n${parts.join(' ')}.`
          }
          return { syntax, pairwise: { group: v.by, variables: v.vars } }
        },
      },
      correlation: {
        title: '双变量相关',
        fields: [{ key: 'vars', kind: 'multi', label: '变量', required: true, accept: 'numeric' }],
        groups: [
          { key: 'options', title: '选项', items: [
            { key: 'twotail', label: '双尾显著性', default: true },
            { key: 'onetail', label: '单尾显著性' },
            { key: 'pairwise', label: '成对排除缺失值' },
            { key: 'listwise', label: '整行排除缺失值', default: true },
          ] },
        ],
        build: (v, flags) => {
          const print = [flags?.options?.onetail ? 'ONETAIL' : 'TWOTAIL', 'NOSIG']
          const missing = flags?.options?.pairwise ? 'PAIRWISE' : 'LISTWISE'
          return { syntax: `CORRELATIONS /VARIABLES=${v.vars.join(' ')} /PRINT=${print.join(' ')} /MISSING=${missing}.` }
        },
      },
      regression: {
        title: '线性回归',
        fields: [
          { key: 'dep', kind: 'single', label: '因变量', required: true },
          { key: 'ind', kind: 'multi', label: '自变量', required: true, accept: 'numeric' },
        ],
        groups: [
          { key: 'statistics', title: '统计量', items: [
            { key: 'r', label: '模型摘要（R 方）', default: true },
            { key: 'coeff', label: '系数', default: true },
            { key: 'anova', label: '方差分析', default: true },
            { key: 'ci', label: '系数置信区间', default: true },
            { key: 'bcov', label: '系数相关性矩阵' },
            { key: 'tol', label: '共线性诊断（容忍度 / VIF，由插件计算）', default: true },
            { key: 'influence', label: '影响诊断（杠杆值 / Cook\'s D / Mahalanobis，由插件计算）' },
          ] },
          { key: 'options', title: '选项', items: [
            { key: 'ciLevel', label: '置信区间水平', kind: 'select', default: '95', options: [['90', '90%'], ['95', '95%'], ['99', '99%']] },
          ] },
          { key: 'save', title: '保存（写回数据集）', items: [
            { key: 'pred', label: '未标准化预测值' },
            { key: 'resid', label: '未标准化残差' },
            { key: 'zpred', label: '标准化预测值' },
            { key: 'zresid', label: '标准化残差' },
            { key: 'sresid', label: '学生化残差' },
            { key: 'cook', label: "Cook's D" },
          ] },
          { key: 'plots', title: '图（PSPP 不画，由插件按同一次拟合作图）', items: [
            { key: 'residual', label: '残差散点图（残差 × 预测值）' },
            { key: 'pp', label: '标准化残差正态 P-P 图' },
          ] },
        ],
        build: (v, flags) => {
          // TOL is never sent to the engine: with it PSPP 2.1.3 crashes inside
          // gsl_blas_dsymm on about one run in six and writes no output. The
          // tolerance/VIF table is computed from the dataset instead, and the
          // hint below tells the workspace to do so.
          const level = ['90', '95', '99'].includes(String(flags?.options?.ciLevel)) ? String(flags.options.ciLevel) : '95'
          const stats = mapKeys(onKeys(flags, 'statistics'), { r: 'R', coeff: 'COEFF', anova: 'ANOVA', ci: `CI(${level})`, bcov: 'BCOV' })
          const save = mapKeys(onKeys(flags, 'save'), {
            pred: 'PRED', resid: 'RESID', zpred: 'ZPRED', zresid: 'ZRESID', sresid: 'SRESID', cook: 'COOK',
          })
          const parts = [`REGRESSION /DEPENDENT=${v.dep} /METHOD=ENTER ${v.ind.join(' ')}`]
          if (stats.length) parts.push(`/STATISTICS=${stats.join(' ')}`)
          if (save.length) parts.push(`/SAVE=${save.join(' ')}`)
          const collinearity = flags?.statistics?.tol !== false
          const influence = flags?.statistics?.influence === true
          // Always carry the model: the residual plots need the same fit even
          // when neither collinearity nor influence was asked for.
          const regression = { dependent: v.dep, independents: v.ind, influence, collinearity }
          const plots = onKeys(flags, 'plots')
          return {
            syntax: `${parts.join(' ')}.`,
            persist: save.length > 0,
            regression,
            plots,
          }
        },
      },
      missing: {
        title: '缺失值分析',
        hint: 'PSPP 2.1.3 没有实现 MVA，这两张表由插件自己从当前数据集算（与其它表的缺失口径一致：空白与 MISSING VALUES 声明的码都算缺失）。',
        fields: [
          { key: 'variables', kind: 'multi', label: '变量', required: true },
        ],
        groups: [
          { key: 'tables', title: '表格', items: [
            { key: 'univariate', label: '单变量统计量', default: true },
            { key: 'patterns', label: '缺失模式（哪些变量同时缺）', default: true },
          ] },
        ],
        build: (v, flags) => ({
          missing: {
            variables: v.variables,
            univariate: flags?.tables?.univariate !== false,
            patterns: flags?.tables?.patterns !== false,
          },
        }),
      },
      replaceMissing: {
        title: '替换缺失值',
        hint: 'PSPP 2.1.3 没有 RMV。三种方法都只用这个变量自己的值，不引入外部数据；替换会作为一步撤销记录，跑下一次分析时才写回文件。',
        fields: [
          { key: 'variables', kind: 'multi', label: '要替换的变量', required: true, accept: 'numeric' },
        ],
        groups: [
          { key: 'method', title: '方法', items: [
            { key: 'method', label: '替换方法', kind: 'select', default: 'mean', options: [
              ['mean', '序列平均值'],
              ['linear', '线性趋势（相邻值内插）'],
              ['nearby', '临近点'],
            ] },
          ] },
        ],
        build: (v, flags) => ({
          missing: {
            mode: 'replace',
            variables: v.variables,
            method: String(flags?.method?.method ?? 'mean'),
          },
        }),
      },
      logistic: {
        title: '二元 Logistic 回归',
        fields: [
          { key: 'dep', kind: 'single', label: '因变量（0/1）', required: true },
          { key: 'ind', kind: 'multi', label: '协变量', required: true, accept: 'numeric' },
        ],
        groups: [
          { key: 'options', title: '选项', items: [{ key: 'ci', label: '输出 Exp(B) 的 95% 置信区间', type: 'check', default: true }] },
        ],
        build: (v, flags) => {
          const print = flags?.options?.ci === false ? 'SUMMARY' : 'CI(95) SUMMARY'
          // The result head offers a ROC curve next to the table; it needs the
          // outcome and the predictors this model already has.
          return {
            syntax: `LOGISTIC REGRESSION ${v.dep} WITH ${v.ind.join(' ')} /PRINT=${print}.`,
            roc: { by: v.dep, variables: v.ind },
          }
        },
      },
      factor: {
        title: '因子分析',
        fields: [
          { key: 'vars', kind: 'multi', label: '变量', required: true, accept: 'numeric' },
          { key: 'rotation', kind: 'select', label: '旋转', options: ['VARIMAX', 'EQUAMAX', 'QUARTIMAX', 'PROMAX', 'NONE'] },
        ],
        defaults: { rotation: 'VARIMAX' },
        groups: [
          { key: 'print', title: '输出', items: [
            { key: 'initial', label: '初始解', default: true },
            { key: 'extraction', label: '提取结果', default: true },
            { key: 'kmo', label: 'KMO 与 Bartlett', default: true },
          ] },
        ],
        build: (v, flags) => {
          // PSPP rejects /ROTATION=NONE; the keyword is NOROTATE, and a
          // rotation print is pointless without one.
          const keyword = v.rotation === 'NONE' ? 'NOROTATE' : v.rotation
          const print = mapKeys(onKeys(flags, 'print'), { initial: 'INITIAL', extraction: 'EXTRACTION', kmo: 'KMO' })
          if (keyword !== 'NOROTATE') print.push('ROTATION')
          return { syntax: `FACTOR /VARIABLES=${v.vars.join(' ')}${print.length ? ` /PRINT=${print.join(' ')}` : ''} /ROTATION=${keyword}.` }
        },
      },
      reliability: {
        title: '可靠性分析',
        fields: [{ key: 'vars', kind: 'multi', label: '项目', required: true, accept: 'numeric' }],
        build: (v) => ({ syntax: `RELIABILITY /VARIABLES=${v.vars.join(' ')} /SCALE('all') ALL /MODEL=ALPHA.` }),
      },
      npar: {
        title: '卡方检验（非参数）',
        fields: [{ key: 'variable', kind: 'single', label: '变量', required: true }],
        build: (v) => ({ syntax: `NPAR TESTS /CHISQUARE=${v.variable}.` }),
      },
      nparBinomial: {
        title: '二项式检验',
        fields: [
          { key: 'variable', kind: 'single', label: '变量', required: true },
          { key: 'p', kind: 'text', label: '检验比例', placeholder: '0.5' },
        ],
        defaults: { p: '0.5' },
        hint: '变量必须是二分变量（两个不同取值）',
        build: (v) => ({ syntax: `NPAR TESTS /BINOMIAL(${String(v.p || '0.5').trim()})=${v.variable}.` }),
      },
      nparKs: {
        title: 'K-S 正态性检验',
        fields: [{ key: 'variable', kind: 'single', label: '变量', required: true, accept: 'numeric' }],
        build: (v) => ({ syntax: `NPAR TESTS /K-S(NORMAL)=${v.variable}.` }),
      },
      nparRuns: {
        title: '游程检验',
        fields: [{ key: 'variable', kind: 'single', label: '变量', required: true }],
        build: (v) => ({ syntax: `NPAR TESTS /RUNS(MEDIAN)=${v.variable}.` }),
      },
      nparWilcoxon: {
        title: '2 个相关样本（Wilcoxon）',
        fields: [{ key: 'vars', kind: 'multi', label: '成对变量', required: true, accept: 'numeric' }],
        build: (v) => {
          if (v.vars.length < 2) throw new Error('至少选择两个变量')
          return { syntax: `NPAR TESTS /WILCOXON=${v.vars.join(' ')}.` }
        },
      },
      nparSign: {
        title: '2 个相关样本（符号检验）',
        fields: [{ key: 'vars', kind: 'multi', label: '成对变量', required: true, accept: 'numeric' }],
        build: (v) => {
          if (v.vars.length < 2) throw new Error('至少选择两个变量')
          return { syntax: `NPAR TESTS /SIGN=${v.vars.join(' ')}.` }
        },
      },
      nparMannWhitney: {
        title: '2 个独立样本（Mann-Whitney）',
        fields: [
          { key: 'variable', kind: 'single', label: '检验变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '分组变量', required: true },
          { key: 'values', kind: 'text', label: '分组值（两组）', placeholder: '1 2', required: true },
        ],
        defaults: { values: '1 2' },
        build: (v) => ({ syntax: `NPAR TESTS /MANN-WHITNEY=${v.variable} BY ${v.by}(${String(v.values).trim()}).` }),
      },
      nparKruskal: {
        title: 'K 个独立样本（Kruskal-Wallis）',
        fields: [
          { key: 'variable', kind: 'single', label: '检验变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '分组变量', required: true },
          { key: 'range', kind: 'text', label: '分组值范围（最小 最大）', placeholder: '1 3', required: true },
        ],
        defaults: { range: '1 3' },
        build: (v) => ({ syntax: `NPAR TESTS /KRUSKAL-WALLIS=${v.variable} BY ${v.by}(${String(v.range).trim()}).` }),
      },
      nparJonckheere: {
        title: 'K 个独立样本（Jonckheere-Terpstra，有序备择）',
        fields: [
          { key: 'variable', kind: 'single', label: '检验变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '分组变量', required: true },
          { key: 'range', kind: 'text', label: '分组值范围（最小 最大）', placeholder: '1 3', required: true },
        ],
        defaults: { range: '1 3' },
        build: (v) => ({
          syntax: `NPAR TESTS /JONCKHEERE-TERPSTRA=${v.variable} BY ${v.by}(${String(v.range).trim()}).`,
          hint: '组顺序有意义时用它：检验「随组别升高，结局单调变化」。',
        }),
      },
      nparFriedman: {
        title: 'K 个相关样本（Friedman）',
        fields: [{ key: 'vars', kind: 'multi', label: '变量', required: true, accept: 'numeric' }],
        build: (v) => {
          if (v.vars.length < 2) throw new Error('至少选择两个变量')
          return { syntax: `NPAR TESTS /FRIEDMAN=${v.vars.join(' ')}.` }
        },
      },
      nparMcNemar: {
        title: '2 个相关样本（McNemar）',
        fields: [
          { key: 'var1', kind: 'single', label: '变量 1（二分类）', required: true },
          { key: 'var2', kind: 'single', label: '变量 2（二分类）', required: true },
        ],
        hint: '两个变量都必须是二分类（同一批个案前后两次测量）；报告的是不一致格的精确检验。',
        build: (v) => {
          if (v.var1 === v.var2) throw new Error('两个变量不能是同一个')
          return { syntax: `NPAR TESTS /MCNEMAR=${v.var1} WITH ${v.var2} (PAIRED).` }
        },
      },
      nparCochran: {
        title: 'K 个相关样本（Cochran Q）',
        fields: [{ key: 'vars', kind: 'multi', label: '变量（至少 3 个，均为二分类）', required: true }],
        build: (v) => {
          if (v.vars.length < 3) throw new Error('Cochran Q 至少需要三个变量')
          return { syntax: `NPAR TESTS /COCHRAN=${v.vars.join(' ')}.` }
        },
      },
      nparKendall: {
        title: 'K 个相关样本（Kendall W）',
        fields: [{ key: 'vars', kind: 'multi', label: '变量（至少 3 个）', required: true }],
        build: (v) => {
          if (v.vars.length < 3) throw new Error('Kendall W 至少需要三个变量')
          return { syntax: `NPAR TESTS /KENDALL=${v.vars.join(' ')}.` }
        },
      },
      ctables: {
        title: '自定义表',
        fields: [
          { key: 'row', kind: 'single', label: '行（数值变量）', required: true, accept: 'numeric' },
          { key: 'col', kind: 'single', label: '列（分类变量）', required: true },
          { key: 'title', kind: 'text', label: '标题（可选）', placeholder: '留空自动生成' },
          { key: 'ciLevel', kind: 'number', label: 'CI 水平', placeholder: '95' },
        ],
        defaults: { ciLevel: 95 },
        groups: [
          { key: 'statistics', title: '统计量', items: [
            { key: 'count', label: '计数', default: true },
            { key: 'mean', label: '均值', default: true },
            { key: 'std', label: '标准差', default: true },
            { key: 'minimum', label: '最小值', default: true },
            { key: 'maximum', label: '最大值', default: true },
            { key: 'sum', label: '总和' },
            { key: 'median', label: '中位数' },
            { key: 'variance', label: '方差' },
            { key: 'semean', label: '均值标准误' },
            { key: 'mode', label: '众数' },
            { key: 'validn', label: '有效 N' },
            { key: 'missing', label: '缺失 N' },
          ] },
          { key: 'categories', title: '类别', items: [
            { key: 'includeMissing', label: '列变量含缺失值类别' },
          ] },
        ],
        build: (v, flags, variables) => {
          const stats = mapKeys(onKeys(flags, 'statistics'), {
            count: 'COUNT', mean: 'MEAN', std: 'STDDEV', minimum: 'MINIMUM', maximum: 'MAXIMUM',
            sum: 'SUM', median: 'MEDIAN', variance: 'VARIANCE', semean: 'SEMEAN', mode: 'MODE',
            validn: 'VALIDN', missing: 'MISSING',
          })
          const title = String(v.title ?? '').trim() || tr('{0} 按 {1} 统计', v.row, v.col)
          const level = Number(v.ciLevel)
          const cilevel = Number.isFinite(level) && level > 0 && level < 100 ? level : 95
          const includeMissing = onKeys(flags, 'categories').includes('includeMissing')
          // 自定义表的列轴必须是分类变量：数值编码列先在本条语法里临时降级为名义
          const columnVar = (variables ?? []).find((variable) => variable.name === v.col)
          const demote = columnVar?.measure === 'scale' ? [`VARIABLE LEVEL ${v.col} (NOMINAL).`] : []
          return {
            syntax: [
              ...demote,
              `CTABLES /TABLE=${v.row}${stats.length ? ` [${stats.join(', ')}]` : ''} BY ${v.col}`,
              `/TITLES TITLE='${title.replace(/'/g, "''")}'`,
              `/CATEGORIES VARIABLES=${v.col} ORDER=A${includeMissing ? ' MISSING=INCLUDE' : ''}`,
              `/CRITERIA CILEVEL ${cilevel}.`,
            ].join('\n'),
          }
        },
      },
      roc: {
        title: 'ROC 曲线',
        fields: [
          { key: 'variable', kind: 'single', label: '检验变量', required: true },
          { key: 'by', kind: 'single', label: '状态变量', required: true },
          { key: 'value', kind: 'text', label: '状态值', placeholder: '1' },
        ],
        groups: [
          { key: 'options', title: '选项', items: [{ key: 'coordinates', label: '输出曲线坐标（灵敏度 / 1-特异度）', type: 'check', default: true }] },
        ],
        defaults: { value: '1' },
        build: (v, flags) => ({
          syntax: `ROC ${v.variable} BY ${v.by}(${v.value || 1}) /PLOT=CURVE${flags?.options?.coordinates === false ? '' : ' /PRINT=COORDINATES'}.`,
        }),
      },
      cluster: {
        title: '快速聚类',
        fields: [
          { key: 'vars', kind: 'multi', label: '变量', required: true, accept: 'numeric' },
          { key: 'k', kind: 'number', label: '聚类数', placeholder: '2' },
        ],
        defaults: { k: 2 },
        build: (v) => ({ syntax: `QUICK CLUSTER ${v.vars.join(' ')} /CRITERIA=CLUSTER(${v.k || 2}).` }),
      },
      compute: {
        title: '计算变量',
        hint: '目标变量可以是不存在的名字（会新建一列）；表达式里的函数与变量名点下面的按钮插入。保存 = 写回数据集。',
        fields: [
          { key: 'target', kind: 'text', label: '目标变量', required: true },
          { key: 'expression', kind: 'text', label: '数字表达式', required: true, placeholder: 'age * 2',
            suggestions: ['MEAN(', 'SUM(', 'MIN(', 'MAX(', 'ABS(', 'SQRT(', 'LN(', 'EXP(', 'TRUNC(', 'RND(', '(', ')'],
            suggestVariables: true,
            hint: '括号要成对；变量名必须是当前数据集里的（表达式里写新名字不会算出来）。' },
        ],
        build: (v, flags, variables) => {
          const expression = String(v.expression ?? '').trim()
          const problem = checkExpression(expression, v.target, variables)
          if (problem) return { error: problem }
          return { syntax: `COMPUTE ${v.target} = ${expression}.\nEXECUTE.`, persist: true }
        },
      },
      recode: {
        title: '重新编码为不同变量',
        fields: [
          { key: 'variable', kind: 'single', label: '输入变量', required: true },
          { key: 'target', kind: 'text', label: '输出变量', required: true },
          { key: 'mapping', kind: 'text', label: '映射', required: true, placeholder: '(1 THRU 3=1) (ELSE=2)' },
        ],
        build: (v) => ({ syntax: `RECODE ${v.variable} ${v.mapping} INTO ${v.target}.\nEXECUTE.`, persist: true }),
      },
      autorecode: {
        title: '自动重新编码',
        fields: [
          { key: 'variable', kind: 'single', label: '输入变量（多为字符串）', required: true, accept: 'any' },
          { key: 'target', kind: 'text', label: '输出变量', required: true, placeholder: 'n_变量名' },
        ],
        build: (v) => ({ syntax: `AUTORECODE VARIABLES=${v.variable} /INTO ${v.target}.\nEXECUTE.`, persist: true }),
      },
      sort: {
        title: '排序个案',
        fields: [
          { key: 'vars', kind: 'multi', label: '排序依据', required: true },
          { key: 'order', kind: 'select', label: '顺序', options: [{ value: 'A', label: '升序' }, { value: 'D', label: '降序' }] },
        ],
        defaults: { order: 'A' },
        build: (v) => ({ syntax: `SORT CASES BY ${v.vars.map((name) => `${name} (${v.order})`).join(' ')}.`, persist: true }),
      },
      select: {
        title: '选择个案',
        fields: [{ key: 'expression', kind: 'text', label: '条件表达式', required: true, placeholder: 'score > 60', hint: '不满足条件的个案会被从数据集中删除' }],
        build: (v) => ({ syntax: `SELECT IF ${v.expression}.\nEXECUTE.`, persist: true }),
      },
      weight: {
        title: '加权个案',
        fields: [{ key: 'variable', kind: 'single', label: '加权变量', required: true }],
        build: (v) => ({ syntax: `WEIGHT BY ${v.variable}.\nEXECUTE.`, persist: true }),
      },
      split: {
        title: '拆分文件',
        fields: [{ key: 'vars', kind: 'multi', label: '分组依据', required: true }],
        build: (v) => ({ syntax: `SPLIT FILE BY ${v.vars.join(' ')}.`, persist: true }),
      },
      aggregate: {
        title: '汇总',
        fields: [
          { key: 'break', kind: 'single', label: '分组变量', required: true },
          { key: 'variable', kind: 'single', label: '汇总变量', required: true },
          { key: 'fn', kind: 'select', label: '函数', options: ['MEAN', 'SUM', 'MAX', 'MIN', 'COUNT'] },
          { key: 'target', kind: 'text', label: '新变量名', required: true },
        ],
        defaults: { fn: 'MEAN' },
        build: (v) => ({ syntax: `AGGREGATE /OUTFILE=* MODE=ADDVARIABLES /BREAK=${v.break} /${v.target}=${v.fn}(${v.variable}).`, persist: true }),
      },
      // The two restructures have no PSPP syntax behind them (2.1.3 lacks
      // CASESTOVARS / VARSTOCASES), so build() hands the payload to the host
      // route instead of returning a program.
      duplicates: {
        title: '标识重复个案',
        hint: 'SPSS 的这条命令 PSPP 没有，所以由插件按你选的键变量比对当前数据集：留空表示用全部变量。勾了「创建指示变量」会新增 dupSeq（组内序号，0 表示唯一）与 dupLast（重复组的末条），随后可用「数据 → 选择个案」按 dupSeq > 1 筛出重复。',
        fields: [
          { key: 'variables', kind: 'multi', label: '定义重复的键变量（留空用全部变量）' },
        ],
        groups: [
          { key: 'options', title: '选项', items: [
            { key: 'indicators', label: '创建指示变量（dupSeq / dupLast）', default: true },
          ] },
        ],
        build: (v, flags) => ({
          duplicates: {
            variables: Array.isArray(v?.variables) ? v.variables : [],
            indicators: flags?.options?.indicators === true,
          },
        }),
      },
      outliers: {
        title: '标识异常个案',
        hint: '先界定「异常」的口径再点确定：插件对每个选中的变量取它自己的百分位界值，落在带外的取值就算越界（PSPP 没有这条命令，这一步在宿主侧算）。留空变量表示所有数值变量。勾了「创建指示变量」会新增 outlier（1 = 至少一个变量越界）与 outlierN（越界的变量个数），随后可用「数据 → 选择个案」按 outlier = 1 筛出这些个案。',
        fields: [
          { key: 'variables', kind: 'multi', label: '要检查的变量（留空用全部数值变量）' },
        ],
        groups: [
          { key: 'options', title: '选项', items: [
            { key: 'percentiles', label: '界值（百分位带）', kind: 'select', default: '5,95', options: [
              ['5,95', '第 5 与第 95 百分位（默认）'],
              ['10,90', '第 10 与第 90 百分位'],
              ['2.5,97.5', '第 2.5 与第 97.5 百分位'],
              ['1,99', '第 1 与第 99 百分位'],
            ] },
            { key: 'indicators', label: '创建指示变量（outlier / outlierN）', default: true },
          ] },
        ],
        build: (v, flags) => {
          const pair = String(flags?.options?.percentiles ?? '5,95').split(',').map((part) => Number(part.trim()))
          return {
            outliers: {
              variables: Array.isArray(v?.variables) ? v.variables : [],
              percentiles: pair.filter((value) => Number.isFinite(value)),
              indicators: flags?.options?.indicators === true,
            },
          }
        },
      },
      casesToVars: {
        title: '个案转变量',
        fields: [
          { key: 'id', kind: 'multi', label: '标识变量（每个组合保留一行）' },
          { key: 'index', kind: 'single', label: '索引变量（它的取值变成新列）', required: true },
          { key: 'variables', kind: 'multi', label: '要展开的变量', required: true },
        ],
        build: (v) => ({ restructure: { kind: 'casesToVars', id: v.id, index: v.index, variables: v.variables } }),
      },
      varstocases: {
        title: '变量转个案',
        fields: [
          { key: 'variables', kind: 'multi', label: '要堆叠的变量（类型必须一致）', required: true },
          { key: 'id', kind: 'multi', label: '标识变量（原样带到每一行）' },
          { key: 'targetName', kind: 'text', label: '数值列名', placeholder: 'value' },
          { key: 'indexName', kind: 'text', label: '索引列名', placeholder: 'index' },
          { key: 'indexValues', kind: 'select', label: '索引值', options: [{ value: 'names', label: '原变量名' }, { value: 'numbers', label: '堆叠顺序号' }] },
        ],
        defaults: { indexValues: 'names', targetName: 'value', indexName: 'index' },
        build: (v) => ({ restructure: { kind: 'varsToCases', variables: v.variables, id: v.id, target: v.targetName, indexName: v.indexName, indexValues: v.indexValues } }),
      },
    }

    /* ----------------------------------------------------------- components */

    function FindReplaceDialog({ mode, variables, onClose, onFind, onReplace }) {
      const [query, setQuery] = useState('')
      const [replacement, setReplacement] = useState('')
      const [column, setColumn] = useState('')
      const [matchCase, setMatchCase] = useState(false)
      const [whole, setWhole] = useState(false)
      const spec = {
        query,
        find: query,
        replace: replacement,
        column: column || undefined,
        matchCase,
        whole,
      }
      return h(Modal, {
        title: mode === 'replace' ? '替换' : '查找',
        onCancel: onClose,
        okText: mode === 'replace' ? '全部替换' : '查找下一个',
        okDisabled: query === '',
        onOk: () => (mode === 'replace' ? onReplace(spec) : onFind(spec)),
      },
        h(Field, { label: '查找内容' },
          h('input', { autoFocus: true, value: query, onChange: (event) => setQuery(event.target.value), style: { width: '100%' } })),
        mode === 'replace'
          ? h(Field, { label: '替换为' },
            h('input', { value: replacement, onChange: (event) => setReplacement(event.target.value), style: { width: '100%' } }))
          : null,
        h(Field, { label: '限定变量', hint: '留空表示在所有变量里查找' },
          h('select', { value: column, onChange: (event) => setColumn(event.target.value), style: { width: '100%' } },
            h('option', { value: '' }, '（全部变量）'),
            variables.map((variable) => h('option', { key: variable.name, value: variable.name, translate: false }, variable.name)))),
        h('label', { className: 'ap-check' },
          h('input', { type: 'checkbox', checked: matchCase, onChange: (event) => setMatchCase(event.target.checked) }), '区分大小写'),
        h('label', { className: 'ap-check' },
          h('input', { type: 'checkbox', checked: whole, onChange: (event) => setWhole(event.target.checked) }), '整格匹配'),
        h('div', { className: 'ap-hint' }, mode === 'replace'
          ? '数值变量的替换只改整格；文本变量按子串替换。'
          : '找到后跳到数据视图里的那个单元格。'))
    }

    function ConvertDialog({ path, onPath, onClose, onRun, onBrowse }) {
      const setPath = onPath
      const formats = [
        ['.sav', 'SPSS 系统文件 .sav'],
        ['.por', '可移植文件 .por'],
        ['.csv', '逗号分隔 .csv'],
        ['.dta', 'Stata .dta'],
      ]
      const extensionFor = (value) => formats.find(([ext]) => value.toLowerCase().endsWith(ext))?.[0] ?? '.csv'
      return h(Modal, {
        title: '转换数据格式',
        wide: true,
        onCancel: onClose,
        okText: '转换',
        okDisabled: path.trim() === '',
        onOk: () => onRun({ path: path.trim() }),
        leading: h('button', { className: 'ap-tool', onClick: onBrowse }, '浏览…'),
      },
        h(Field, { label: '目标文件', hint: '格式由扩展名决定；源文件是当前数据集（必要时先写回 work.sav）' },
          h('div', { style: { display: 'flex', gap: 6 } },
            h('input', { autoFocus: true, value: path, onChange: (event) => setPath(event.target.value), style: { flex: 1 } }),
            h('select', {
              value: extensionFor(path),
              onChange: (event) => {
                const base = path.replace(/\.(sav|por|csv|dta)$/i, '')
                setPath(`${base || 'output'}${event.target.value}`)
              },
            }, formats.map(([ext, label]) => h('option', { key: ext, value: ext }, label))))),
        h('div', { className: 'ap-hint' }, '由引擎自带的 pspp-convert 完成，不经过语法解析。'))
    }

    if (typeof globalThis !== 'undefined' && globalThis.__AP_TEST_HOOKS__) globalThis.__AP_TEST_HOOKS__.ANALYSIS_SPECS = ANALYSIS_SPECS

    // PSPP commands get the accent colour, subcommands a muted one; comments,
    // strings and numbers are the three other things worth seeing at a glance.
    const PSPP_COMMANDS = new Set(('FREQUENCIES DESCRIPTIVES EXPLORE CROSSTABS MEANS T-TEST ONEWAY GLM ' +
      'CORRELATIONS REGRESSION LOGISTIC FACTOR RELIABILITY NPAR EXAMINE CTABLES ROC QUICK CLUSTER ' +
      'GET SAVE DATA INPUT PROGRAM COMPUTE RECODE IF ELSE DO VARIABLE VALUE LABELS MISSING FORMATS ' +
      'WEIGHT SPLIT SORT SELECT SAMPLE COUNT RANK AGGREGATE AUTORECODE FLIP MERGE MATCH ADD FILES ' +
      'STRING NUMERIC PRINT DISPLAY LIST WRITE EXPORT OUTPUT SET SHOW TITLE SUBTITLE COMMENT DOCUMENT ' +
      'ECHO INCLUDE INSERT RUN EXECUTE BEGIN END LOOP VECTOR MATRIX DEFINE !ENDDEFINE TEMPORARY ' +
      'PRESERVE RESTORE DATASET SCALE ANOVA MANOVA UNIANOVA DISCRIMINANT PARTIAL PROPORTIONS ' +
      'NONPARAMETRIC RELIABILITY ADD DROP DELETE RENAME FORMAT NEWFILE ').split(/\s+/))

    // The subcommands whose "=" takes a keyword list rather than names.
    const KEYWORD_SUBCOMMANDS = new Set(['STATISTICS', 'CELLS', 'CRITERIA', 'FORMAT', 'PRINT'])

    // Keywords that make sense after "=" or ",": statistic names, cell
    // contents and the enum-like switches the procedures take.
    const PSPP_KEYWORDS = new Set(('MEAN MEDIAN MODE STDDEV VARIANCE MIN MAX RANGE SUM SEMEAN ' +
      'KURTOSIS SKEWNESS SESKEW SEKURT PERCENTILES COUNT EXPECTED RESID SRESID ASRESID ROW COLUMN ' +
      'TOTAL CHISQ PHI CC LAMBDA GAMMA KAPPA ETA RISK ONETAIL TWOTAIL SIG NOSIG PAIRWISE LISTWISE ' +
      'DESCRIPTIVES HOMOGENEITY LSD BONFERRONI SIDAK TUKEY SCHEFFE LEFT RIGHT CENTER NOMINAL ' +
      'ORDINAL SCALE ASCENDING DESCENDING NORMAL NONE ALL').split(/\s+/))

    const PSPP_SUBCOMMANDS = new Set(('VARIABLES STATISTICS CELLS PLOT TABLE TABLES CRITERIA FORMAT FMT ' +
      'TITLE SUBTITLE FOOTNOTE CAPTION TESTVAL GROUPS PAIRED DEPENDENT INDEPENDENT METHOD ENTER REMOVE ' +
      'SELECT VARIABLE LEVEL MEASURE ROLE ALIGNMENT WIDTH DECIMALS LABEL VALUES MISSING OUTFILE IN ' +
      'TYPE TXT CSV FIRSTCASE DELIMITERS QUALIFIER ARRANGEMENT ORDER CATEGORIES MISSING SAVE PRINT ' +
      'BARCHART HISTOGRAM SCATTERPLOT NPPLOT BOXPLOT SPREADLEVEL COMPARE ADJUST LMATRIX CONTRAST ' +
      'POSTHOC EMMEANS DESIGN BY WITH SPLIT FILE DATA LIST END DATA').split(/\s+/))

    const escapeHtml = (value) => String(value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

    const highlightHtml = (source) => {
      const lines = String(source ?? '').split('\n')
      let inComment = false
      return lines.map((line) => {
        let out = ''
        let index = 0
        // A whole-line comment is the PSPP `*` form; it must be first.
        if (!inComment && /^\s*\*/.test(line) && !/^\s*\*\//.test(line)) {
          return `<span class="ap-hl-com">${escapeHtml(line)}</span>`
        }
        let firstWord = true
        while (index < line.length) {
          const rest = line.slice(index)
          if (inComment) {
            const end = rest.indexOf('*/')
            if (end < 0) {
              out += `<span class="ap-hl-com">${escapeHtml(rest)}</span>`
              index = line.length
              break
            }
            out += `<span class="ap-hl-com">${escapeHtml(rest.slice(0, end + 2))}</span>`
            index += end + 2
            inComment = false
            continue
          }
          if (rest.startsWith('/*')) {
            inComment = true
            continue
          }
          const quote = rest[0]
          if (quote === "'" || quote === '"') {
            let end = 1
            while (end < rest.length && rest[end] !== quote) end += 1
            const token = rest.slice(0, Math.min(end + 1, rest.length))
            out += `<span class="ap-hl-str">${escapeHtml(token)}</span>`
            index += token.length
            firstWord = false
            continue
          }
          const word = /^[A-Za-z_!][\w!]*/.exec(rest)
          if (word) {
            const upper = word[0].toUpperCase()
            const isCommand = firstWord && PSPP_COMMANDS.has(upper)
            const known = PSPP_COMMANDS.has(upper) || PSPP_SUBCOMMANDS.has(upper)
            if (isCommand) out += `<span class="ap-hl-cmd">${escapeHtml(word[0])}</span>`
            else if (known && /^[A-Z!]/.test(word[0])) out += `<span class="ap-hl-sub">${escapeHtml(word[0])}</span>`
            else out += escapeHtml(word[0])
            index += word[0].length
            firstWord = false
            continue
          }
          const number = /^-?\d+(\.\d+)?/.exec(rest)
          if (number) {
            out += `<span class="ap-hl-num">${escapeHtml(number[0])}</span>`
            index += number[0].length
            continue
          }
          out += escapeHtml(rest[0])
          if (!/\s/.test(rest[0])) firstWord = false
          index += 1
        }
        return out
      }).join('\n')
    }

    // `highlightHtml` rebuilds its state from the whole script each call, so the
    // editor's autocomplete needs the same state for the text before the caret.
    function completionContext(text, caret) {
      const before = String(text ?? '').slice(0, caret)
      const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before)
      const prefix = word ? word[0] : ''
      const line = before.slice(before.lastIndexOf('\n') + 1)
      const afterWord = before.slice(0, word ? before.length - word[0].length : before.length)
      let inComment = false
      let comment = false
      for (let index = 0; index < afterWord.length; index += 1) {
        if (inComment) {
          const end = afterWord.indexOf('*/', index)
          if (end < 0) break
          index = end + 1
          inComment = false
          continue
        }
        if (afterWord.startsWith('/*', index)) {
          inComment = true
          index += 1
          continue
        }
        if (afterWord[index] === "'" || afterWord[index] === '"') {
          const end = afterWord.indexOf(afterWord[index], index + 1)
          if (end < 0) break
          index = end
        }
      }
      comment = inComment
      if (/^\s*\*/.test(line) && !/^\s*\*\//.test(line)) comment = true
      // Variables anywhere before the caret: they are the other half of what a
      // user types here, and PSPP command words are meaningless as operands.
      const variables = new Set()
      for (const match of before.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        if (!PSPP_COMMANDS.has(match[0].toUpperCase()) && !PSPP_SUBCOMMANDS.has(match[0].toUpperCase())) {
          variables.add(match[0])
        }
      }
      // What the caret sits after decides which vocabulary makes sense: a "/"
      // starts a subcommand, "=" or "," starts an option keyword, anything
      // else is a plain identifier (variable or command).
      const anchor = afterWord.replace(/\s+$/, '').slice(-1)
      // Only a few subcommands take a keyword list; VARIABLES=, TABLES= and
      // BY take names, so an "=" alone must not switch the vocabulary.
      const sub = /\/([A-Za-z]+)[^/]*$/.exec(afterWord)
      const keywordSlot = sub ? KEYWORD_SUBCOMMANDS.has(sub[1].toUpperCase()) : false
      const slot = anchor === '/'
        ? 'subcommand'
        : ((anchor === '=' || anchor === ',') && keywordSlot ? 'keyword' : 'word')
      return { prefix: prefix.toLowerCase(), comment, variables: [...variables], slot }
    }

    /** Candidates for the word ending at the caret. */
    function completionCandidates(text, caret, variableNames = []) {
      const { prefix, comment, variables, slot } = completionContext(text, caret)
      if (comment || prefix.length < 1) return []
      if (slot === 'subcommand') {
        return [...PSPP_SUBCOMMANDS]
          .filter((name) => name.toLowerCase().startsWith(prefix))
          .sort((left, right) => left.length - right.length)
          .slice(0, 8)
          .map((name) => ({ name, kind: '子命令' }))
      }
      if (slot === 'keyword') {
        return [...PSPP_KEYWORDS]
          .filter((name) => name.toLowerCase().startsWith(prefix))
          .sort((left, right) => left.length - right.length)
          .slice(0, 8)
          .map((name) => ({ name, kind: '选项' }))
      }
      const command = PSPP_COMMANDS.has(prefix.toUpperCase())
      const seen = new Set()
      const items = []
      const add = (name, kind) => {
        if (!name.toLowerCase().startsWith(prefix)) return
        const key = name.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        items.push({ name, kind })
      }
      if (!command) {
        for (const name of variableNames) add(name, '变量')
        if (prefix.length >= 2) for (const name of variables) add(name, '已用变量')
      }
      // `FREQ` -> FREQUENCIES, but never inside an operand list where a bare
      // uppercase word is far more likely a subcommand than a missed command.
      if (prefix.length >= 2) for (const name of PSPP_COMMANDS) add(name, '命令')
      items.sort((left, right) => (left.kind === '变量' ? -1 : right.kind === '变量' ? 1 : left.name.length - right.name.length))
      return items.slice(0, 8)
    }

    // Gutter + highlighted layer under a transparent textarea: the textarea
    // keeps real editing behaviour (selection, IME, undo) while the layer
    // behind it carries colour and line numbers.
    function SyntaxEditor({ value, onChange, onRun, placeholder, variableNames = [] }) {
      const preRef = useRef(null)
      const gutterRef = useRef(null)
      const [completions, setCompletions] = useState([])
      const [completionIndex, setCompletionIndex] = useState(0)
      const refreshCompletions = (text, caret) => {
        setCompletions(completionCandidates(text, caret, variableNames))
        setCompletionIndex(0)
      }
      const accept = (item) => {
        const target = document.querySelector('.ap-code-input')
        const caret = target?.selectionStart ?? value.length
        if (!item) return
        const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(value.slice(0, caret))
        const start = caret - (word ? word[0].length : 0)
        const next = `${value.slice(0, start)}${item.name}${value.slice(caret)}`
        onChange(next)
        setCompletions([])
        requestAnimationFrame(() => {
          if (!target) return
          target.focus()
          const at = start + item.name.length
          target.selectionStart = at
          target.selectionEnd = at
        })
      }
      const lines = useMemo(() => String(value ?? '').split('\n'), [value])
      const html = useMemo(() => highlightHtml(value), [value])
      const sync = useCallback((event) => {
        const { scrollTop, scrollLeft } = event.target
        if (preRef.current) {
          preRef.current.scrollTop = scrollTop
          preRef.current.scrollLeft = scrollLeft
        }
        if (gutterRef.current) gutterRef.current.scrollTop = scrollTop
      }, [])
      return h('div', { className: 'ap-code' },
        h('div', { className: 'ap-gutter', ref: gutterRef },
          lines.map((_, index) => h('div', { className: 'ap-gutter-line', key: index }, index + 1))),
        h('div', { className: 'ap-code-box' },
          h('pre', { className: 'ap-code-hl', ref: preRef, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: `${html}\n` } }),
          h('textarea', {
            className: 'ap-code-input',
            value,
            spellCheck: false,
            wrap: 'off',
            placeholder,
            onChange: (event) => {
              onChange(event.target.value)
              refreshCompletions(event.target.value, event.target.selectionStart)
            },
            onScroll: sync,
            onKeyDown: (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault()
                onRun()
                return
              }
              if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
                event.preventDefault()
                refreshCompletions(value, event.target.selectionStart)
                return
              }
              if (completions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setCompletionIndex((current) => (current + step + completions.length) % completions.length)
                return
              }
              if (completions.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
                event.preventDefault()
                accept(completions[completionIndex])
                return
              }
              if (completions.length > 0 && event.key === 'Escape') {
                event.preventDefault()
                setCompletions([])
                return
              }
              if (event.key === 'Tab') {
                // Keep Tab inside the editor: two spaces, like PSPP's own.
                event.preventDefault()
                const target = event.target
                const start = target.selectionStart
                const end = target.selectionEnd
                const next = `${value.slice(0, start)}  ${value.slice(end)}`
                onChange(next)
                requestAnimationFrame(() => {
                  target.selectionStart = start + 2
                  target.selectionEnd = start + 2
                })
              }
            },
          }),
          completions.length > 0
            ? h('div', { className: 'ap-complete', role: 'listbox' },
              completions.map((item, index) => h('div', {
                key: `${item.kind}:${item.name}`,
                className: `ap-complete-item ${index === completionIndex ? 'ap-active' : ''}`,
                role: 'option',
                'aria-selected': index === completionIndex,
                onMouseDown: (event) => { event.preventDefault(); accept(item) },
              }, h('span', { className: 'ap-complete-name' }, item.name), h('span', { className: 'ap-complete-kind' }, item.kind))),
              h('div', { className: 'ap-complete-hint' }, '↑↓ 选择 · Enter/Tab 补全 · Esc 关闭 · Ctrl+Space 打开'))
            : null))
    }

    // SPSS's data editor keeps going past the last variable and the last case:
    // the spare cells are clickable, and typing in one starts a new variable
    // or a new case right there.
    const SPARE_COLUMN_WIDTH = 96
    const SPARE_ROWS = 40

    function DataGrid({ variables, rows, total, onLoadMore, onEdit, selected, onSelect, showLabels, gridLines = true, widths = {}, onWidth, onPaste, onNewVariable, onMoveVariable, onCellMenu, rowHeight: rowHeightProp = 22, freeze = { rows: true, cols: true } }) {
      // SPSS lines every cell up by the variable's own alignment setting: the
      // sheet defaults to right for numbers and left for text, and switching a
      // variable to 「左」 must win over that default.
      const alignOf = alignmentClass
      // Column drag state for reordering variables from the data view.
      const [dragColumn, setDragColumn] = useState(null)
      const [dragOverColumn, setDragOverColumn] = useState(null)
      const wrapRef = useRef(null)
      // Sticky offsets for frozen panes: the row-number column is 52 px wide
      // and every header row is one line tall, so only the left offset needs
      // measuring per column.
      const [freezeX, setFreezeX] = useState(52)
      const [spare, setSpare] = useState(null)
      const measureFreeze = useCallback(() => {
        const head = wrapRef.current?.querySelector('.ap-grid thead .ap-rownum')
        if (head) setFreezeX(head.getBoundingClientRect().width || 52)
      }, [])
      useEffect(() => { measureFreeze() }, [measureFreeze, variables.length])
      // Columns keep their own widths, but the table still has to reach the
      // right edge: an empty filler column absorbs whatever is left over, which
      // is what SPSS does (a bare table stretched to 100% would scale the row
      // numbers up along with everything else).
      const [wrapWidth, setWrapWidth] = useState(0)
      useEffect(() => {
        const node = wrapRef.current
        if (!node) return undefined
        const sync = () => setWrapWidth(node.clientWidth)
        sync()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(sync)
        observer.observe(node)
        return () => observer.disconnect()
      }, [])
      const [editing, setEditing] = useState(null) // {row, column, value}
      const rowHeight = rowHeightProp
      const [window_, setWindow] = useState({ start: 0, end: 60 })
      const [scrollTop, setScrollTop] = useState(0)
      const containerHeight = wrapRef.current?.clientHeight ?? 480

      const onScroll = (event) => {
        const top = event.currentTarget.scrollTop
        setScrollTop(top)
        const start = Math.max(0, Math.floor(top / rowHeight) - 8)
        const visible = Math.ceil((event.currentTarget.clientHeight || containerHeight) / rowHeight) + 16
        setWindow({ start, end: start + visible })
        if (rows.length < total && top + event.currentTarget.clientHeight >= (rows.length - 8) * rowHeight) onLoadMore?.()
      }

      const start = window_.start
      const end = Math.min(rows.length, window_.end)
      const columnWidth = 96
      // Widths live in the app so the variable view's "列" column can edit the
      // same numbers; the header, the body and the table width all agree.
      const widthOf = (variable) => widths[variable.name] ?? columnWidth
      // SPSS-style multiple selection: click, Ctrl+click for extra cells,
      // Shift+click for a rectangle, Ctrl+A for everything, Ctrl+C to copy.
      const [selection, setSelection] = useState(null)
      const keyOf = (row, column) => `${row}:${column}`
      const inSelection = (row, column) => {
        if (!selection) return false
        const { anchor, focus } = selection
        const [r1, r2] = [Math.min(anchor.row, focus.row), Math.max(anchor.row, focus.row)]
        const [c1, c2] = [Math.min(anchor.column, focus.column), Math.max(anchor.column, focus.column)]
        if (row >= r1 && row <= r2 && column >= c1 && column <= c2) return true
        return (selection.extras ?? []).includes(keyOf(row, column))
      }
      const selectCell = (row, column, event) => {
        const additive = event.ctrlKey || event.metaKey
        if (event.shiftKey && selection) {
          setSelection((current) => ({ anchor: current?.anchor ?? { row, column }, focus: { row, column }, extras: current?.extras ?? [] }))
        } else if (additive) {
          setSelection((current) => {
            const base = current ?? { anchor: { row, column }, focus: { row, column }, extras: [] }
            const key = keyOf(row, column)
            const extras = base.extras.includes(key) ? base.extras.filter((entry) => entry !== key) : [...base.extras, key]
            return { ...base, extras }
          })
        } else {
          setSelection({ anchor: { row, column }, focus: { row, column }, extras: [] })
        }
        onSelect?.({ row, column })
      }
      // SPSS lets you type straight into the sheet: the first printable key
      // opens the editor on the current cell with that character as its seed,
      // Enter and Tab then walk down or across while still in edit mode.
      const selectedCell = () => {
        if (selected && Number.isInteger(selected.row) && Number.isInteger(selected.column)) return selected
        if (selection) return selection.focus
        return null
      }
      useEffect(() => {
        const wrap = wrapRef.current
        if (!wrap) return undefined
        const onKey = (event) => {
          if (editing || spare) return
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (typeof event.key !== 'string' || event.key.length !== 1) return
          const target = event.target
          if (target && target !== wrap && target.closest?.('input, textarea, select, [contenteditable="true"]')) return
          const cell = selectedCell()
          if (!cell) return
          const variable = variables[cell.column]
          if (!variable) return
          if (cell.row >= (total ?? rows.length)) {
            event.preventDefault()
            setSpare({ row: cell.row, column: cell.column, variable: variable.name, value: event.key })
            return
          }
          event.preventDefault()
          setEditing({ row: cell.row, column: cell.column, seed: event.key })
        }
        wrap.addEventListener('keydown', onKey)
        return () => wrap.removeEventListener('keydown', onKey)
      }, [editing, spare, selected, selection, variables, rows.length, total])
      const selectionText = () => {
        if (!selection) return ''
        const { anchor, focus } = selection
        const rowsIn = [Math.min(anchor.row, focus.row), Math.max(anchor.row, focus.row)]
        const columnsIn = [Math.min(anchor.column, focus.column), Math.max(anchor.column, focus.column)]
        const out = []
        for (let row = rowsIn[0]; row <= rowsIn[1] && row < rows.length; row += 1) {
          const line = []
          for (let column = columnsIn[0]; column <= columnsIn[1] && column < variables.length; column += 1) {
            const value = (rows[row] ?? [])[column]
            line.push(value === null || value === undefined ? '' : String(value))
          }
          out.push(line.join('\t'))
        }
        return out.join('\n')
      }
      // Ctrl+V pastes a tab/newline block into the selection anchor. The
      // browser only gives us text, so the top-left cell decides the layout.
      // Excel and Calc put an HTML table on the clipboard next to the plain
      // text. The HTML carries the real cell boundaries, which the tab-separated
      // fallback loses whenever a cell itself contains a tab or a newline.
      const readClipboardTable = async () => {
        if (!navigator.clipboard?.read) return null
        let items = []
        try { items = await navigator.clipboard.read() } catch { return null }
        for (const item of items) {
          if (!item.types.includes('text/html')) continue
          const html = await item.getType('text/html').then((blob) => blob.text())
          const doc = new DOMParser().parseFromString(html, 'text/html')
          const table = doc.querySelector('table')
          if (!table) continue
          const grid = []
          for (const tr of table.querySelectorAll('tr')) {
            const line = []
            for (const td of tr.querySelectorAll('td,th')) {
              line.push((td.textContent ?? '').replace(/\s+/g, ' ').trim())
            }
            if (line.length) grid.push(line)
          }
          if (grid.length) return grid
        }
        return null
      }
      // 清除/剪切 blanks the rectangle through the same host route a paste
      // uses, so one undo step covers the whole block.
      const clearSelection = () => {
        if (!selection) return false
        const { anchor, focus } = selection
        const [r1, r2] = [Math.min(anchor.row, focus.row), Math.max(anchor.row, focus.row)]
        const [c1, c2] = [Math.min(anchor.column, focus.column), Math.max(anchor.column, focus.column)]
        const cells = []
        for (let row = r1; row <= r2 && row < rows.length; row += 1) {
          for (let column = c1; column <= c2 && column < variables.length; column += 1) {
            cells.push({ row, variable: variables[column].name, value: null })
          }
        }
        if (cells.length === 0) return false
        onPaste?.(cells, {})
        return true
      }
      const pasteFromClipboard = async () => {
        if (!selection || !navigator.clipboard?.readText) return
        let text = ''
        try { text = await navigator.clipboard.readText() } catch { return }
        if (!text) return
        const htmlGrid = await readClipboardTable()
        let lines = text.replace(/\r\n?/g, '\n').split('\n')
        while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
        if (htmlGrid) lines = htmlGrid.map((line) => line.join('\t'))
        const startRow = Math.min(selection.anchor.row, selection.focus.row)
        const startColumn = Math.min(selection.anchor.column, selection.focus.column)
        const cells = []
        // Columns past the last variable are named V<n> by the host, which
        // appends them when `extend` is set; the same for cases past the end.
        let extra = 0
        lines.forEach((line, offset) => {
          line.split('\t').forEach((value, index) => {
            const column = startColumn + index
            const row = startRow + offset
            let name = variables[column]?.name
            if (!name) {
              extra += column >= variables.length ? 1 : 0
              name = `\u0000extra-${column}`
            }
            cells.push({ row, variable: name, value })
          })
        })
        const beyond = lines.some((line, offset) => startRow + offset >= total) || lines.some((line) => startColumn + line.split('\t').length > variables.length)
        if (cells.length) onPaste?.(cells, { extend: beyond })
      }

      // Right-click opens a menu for the cell under the pointer, the way the
      // SPSS data editor does; the menu itself lives in the parent so it can
      // reach the host routes. An empty cell still needs a menu (insert and
      // jump stay available), so the variable is only optional here.
      const openCellMenu = (event, row, column) => {
        event.preventDefault()
        const variable = variables[column]
        setSelection({ anchor: { row, column }, focus: { row, column }, extras: [] })
        const cell = rows[row]?.[column]
        const shown = cell === null || cell === undefined ? '' : String(cell)
        onCellMenu?.({
          x: event.clientX,
          y: event.clientY,
          row,
          column,
          variable: variable?.name ?? null,
          text: variable && showLabels !== false ? valueLabels(variable, cell) : shown,
          numeric: variable?.type === 'numeric',
        })
      }

      // Press and drag paints a rectangle, the way a spreadsheet does.
      const startMarquee = (event, row, column) => {
        if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return
        setSelection({ anchor: { row, column }, focus: { row, column }, extras: [] })
        const onMove = (moveEvent) => {
          const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
          const cell = element?.closest?.('td[data-row]')
          if (!cell) return
          const nextRow = Number(cell.dataset.row)
          const nextColumn = Number(cell.dataset.column)
          setSelection((current) => ({ anchor: current?.anchor ?? { row, column }, focus: { row: nextRow, column: nextColumn }, extras: current?.extras ?? [] }))
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      const resizeRef = useRef(null)
      const startResize = (event, variable) => {
        event.preventDefault()
        event.stopPropagation()
        resizeRef.current = { name: variable.name, x: event.clientX, width: widthOf(variable) }
        const onMove = (moveEvent) => {
          const state = resizeRef.current
          if (!state) return
          const next = Math.max(40, Math.min(600, state.width + (moveEvent.clientX - state.x)))
          onWidth?.(state.name, next)
        }
        const onUp = () => {
          resizeRef.current = null
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      const scrollToRow = (row) => {
        const element = wrapRef.current
        if (!element) return
        const top = row * rowHeight
        const header = 26
        if (top < element.scrollTop + header) element.scrollTop = Math.max(0, top - header)
        else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight
      }

      const move = (dRow, dCol) => {
        if (!variables.length) return
        const base = selected ?? { row: 0, column: 0 }
        const maxRow = Math.max(0, (rows.length || 1) - 1)
        const row = Math.max(0, Math.min(maxRow, base.row + dRow))
        const column = Math.max(0, Math.min(variables.length - 1, base.column + dCol))
        onSelect?.({ row, column })
        scrollToRow(row)
      }

      // Two things the 编辑 menu needs from this component: the selected
      // rectangle (to copy or clear) and the paste entry point. The rest of the
      // grid state stays private.
      // The functions themselves are rebuilt every render (they read that
      // render's selection and rows); the published table only forwards, so the
      // one registered at mount always calls the newest closure.
      const liveRef = useRef({})
      liveRef.current = {
        selection,
        copy: () => {
          if (!selection) return false
          copyText(selectionText()).catch(() => { /* clipboard blocked */ })
          return true
        },
        cut: async () => {
          if (!selection) return false
          await copyText(selectionText()).catch(() => { /* clipboard blocked */ })
          return clearSelection()
        },
        paste: async () => {
          if (!selection) return false
          await pasteFromClipboard()
          return true
        },
        clear: () => clearSelection(),
      }
      useEffect(() => {
        const commands = {
          copy: () => liveRef.current.copy(),
          cut: () => liveRef.current.cut(),
          paste: () => liveRef.current.paste(),
          clear: () => liveRef.current.clear(),
          hasSelection: () => Boolean(liveRef.current.selection),
        }
        GRID_COMMANDS = commands
        return () => { if (GRID_COMMANDS === commands) GRID_COMMANDS = null }
      }, [])

      const onKeyDown = (event) => {
        if (editing || !variables.length) return
        const base = selected ?? { row: 0, column: 0 }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
          event.preventDefault()
          setSelection({ anchor: { row: 0, column: 0 }, focus: { row: Math.max(0, rows.length - 1), column: variables.length - 1 }, extras: [] })
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'C') && selection) {
          event.preventDefault()
          copyText(selectionText()).catch(() => { /* clipboard blocked */ })
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'x' || event.key === 'X') && selection) {
          event.preventDefault()
          copyText(selectionText()).then(() => clearSelection()).catch(() => { /* clipboard blocked */ })
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'v' || event.key === 'V')) {
          event.preventDefault()
          pasteFromClipboard()
          return
        }
        if (event.key === 'ArrowUp') { event.preventDefault(); move(-1, 0) }
        else if (event.key === 'ArrowDown') { event.preventDefault(); move(1, 0) }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); move(0, -1) }
        else if (event.key === 'ArrowRight') { event.preventDefault(); move(0, 1) }
        // Tab crosses the row and wraps onto the next one, like the SPSS editor.
        else if (event.key === 'Tab') {
          event.preventDefault()
          if (!event.shiftKey && base.column === variables.length - 1) move(1, -base.column)
          else if (event.shiftKey && base.column === 0) { move(-1, 0); onSelect?.({ row: Math.max(0, base.row - 1), column: variables.length - 1 }) }
          else move(0, event.shiftKey ? -1 : 1)
        }
        else if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault()
          if (base.row < (total ?? 0)) setEditing({ row: base.row, column: base.column })
          else onEdit?.(Math.max(total ?? 0, rows.length), variables[base.column].name, '', { focus: true })
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          if (base.row < (total ?? 0)) onEdit?.(base.row, variables[base.column].name, '', { focus: true })
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          // Typing straight into the selected cell, no F2 first.
          const target = selected
          if (target && target.row < (total ?? 0) && variables[target.column]) {
            event.preventDefault()
            setEditing({ row: target.row, column: target.column, value: event.key })
          }
        }
      }

      const freezeClass = `ap-freeze-rows-${freeze.rows !== false} ap-freeze-cols-${freeze.cols !== false}`
      const gridWidth = 52 + variables.reduce((sum, variable) => sum + widthOf(variable), 0)
      // Left over when the columns are narrower than the panel; zero when they
      // already overflow and the wrap scrolls.
      const filler = Math.max(0, wrapWidth - gridWidth)
      // Spare columns soak up the leftover width first; past that they keep
      // coming at their own width and the panel scrolls sideways, like SPSS.
      const spareCount = Math.max(2, filler > 0 ? Math.round(filler / SPARE_COLUMN_WIDTH) : 2)
      const spareWidth = filler > 0 ? Math.ceil(filler / spareCount) : SPARE_COLUMN_WIDTH
      const columnCount = variables.length + 1 + spareCount
      return h('div', { className: `ap-grid-wrap ${freezeClass}`, ref: wrapRef, onScroll, tabIndex: 0, onKeyDown, style: { outline: 'none', '--ap-freeze-x': `${freezeX}px` } },
        h('table', { className: `ap-grid${gridLines ? '' : ' ap-nogrid'}`, style: { width: gridWidth + spareCount * spareWidth } },
          h('thead', null,
            h('tr', null,
              h('th', { className: 'ap-rownum' }, ''),
              variables.map((variable, column) => h('th', {
                key: variable.name,
                className: `${freeze.cols !== false && column === 0 ? 'ap-freeze-col' : ''}${dragColumn === variable.name ? ' ap-col-dragging' : ''}`,
                title: `${variable.name}${variable.label ? ` — ${variable.label}` : ''}${tr('（拖动表头调整列顺序；拖动右边界改列宽，双击右边界恢复）')}`,
                style: { width: widthOf(variable), minWidth: widthOf(variable) },
                draggable: true,
                onDragStart: (event) => {
                  setDragColumn(variable.name)
                  event.dataTransfer?.setData('text/plain', variable.name)
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                },
                onDragEnd: () => { setDragColumn(null); setDragOverColumn(null) },
                onDragOver: (event) => {
                  event.preventDefault()
                  if (dragOverColumn !== variable.name) setDragOverColumn(variable.name)
                },
                onDrop: (event) => {
                  event.preventDefault()
                  // The dragged name travels in the data transfer, so a drop
                  // still works if React has not re-rendered since dragstart.
                  const name = dragColumn ?? event.dataTransfer?.getData('text/plain')
                  setDragColumn(null)
                  setDragOverColumn(null)
                  if (!name || name === variable.name) return
                  // Drop to the left half puts it before the target, right half after.
                  const box = event.currentTarget.getBoundingClientRect()
                  const before = event.clientX < box.left + box.width / 2
                  const rest = variables.filter((entry) => entry.name !== name).map((entry) => entry.name)
                  const target = rest.indexOf(variable.name)
                  rest.splice(before ? target : target + 1, 0, name)
                  onMoveVariable?.(name, rest.indexOf(name) + 1)
                },
                onMouseDown: (event) => {
                  // A wider hit area than a 7 px handle: anywhere in the last
                  // 8 px of the header cell starts a resize.
                  const box = event.currentTarget.getBoundingClientRect()
                  if (box.right - event.clientX <= 8) startResize(event, variable)
                },
                onDoubleClick: (event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  if (box.right - event.clientX > 8) return
                  // Double-clicking the boundary auto-fits the column.
                  const longest = rows.reduce((longest, row) => Math.max(longest, String(row[variables.indexOf(variable)] ?? '').length), variable.name.length)
                  onWidth?.(variable.name, Math.max(48, Math.min(600, 16 + longest * 8)))
                },
              },
              h('span', { className: 'ap-head-name', translate: false }, variable.name),
              // SPSS prints the variable label under the name in the header, so
              // a sheet of v1..v9 still reads as age/sex/score. Only two lines:
              // a third would push the rows down for nothing.
              variable.label ? h('span', { className: 'ap-head-label', translate: false }, variable.label) : null,
              h('span', { className: 'ap-col-resize' }))),
            Array.from({ length: spareCount }, (unused, offset) => h('th', {
              key: `__spare-${offset}`,
              className: 'ap-spare-head',
              style: { width: spareWidth, minWidth: spareWidth },
              title: '空列：双击建立新变量',
              onDoubleClick: () => setSpare({ row: 0, column: variables.length + offset }),
            }, '')))),

          h('tbody', null,
            // The spacer above the virtual window stands in for the rows that
            // scrolled away and replaces them byte-for-byte. It must be
            // display:none when nothing is scrolled: an empty <tr> still draws a
            // 22px band, which showed up as a phantom blank row between the last
            // case and the first empty row.
            // A spacer cell inherits the grid's cell padding/border, so an
            // empty row still measures one full row tall; when nothing is
            // scrolled it must not exist at all.
            start > 0
              ? h('tr', { 'aria-hidden': 'true', style: { height: start * rowHeight } },
                h('td', { colSpan: columnCount, className: 'ap-spacer', style: { height: start * rowHeight } }, ''))
              : null,
            Array.from({ length: end - start }, (_, offset) => {
              const rowIndex = start + offset
              const row = rows[rowIndex] ?? []
              // Shade on the displayed case number (1-based, odd rows plain), so
              // blank rows after the last case never look like an extra record.
              return h('tr', { key: rowIndex, className: rowIndex % 2 === 1 ? 'ap-striped' : '' },
                // The first number column stays put next to the row numbers.
                h('td', { className: 'ap-rownum' }, String(rowIndex + 1)),
                variables.map((variable, column) => {
                  const isEditing = editing && editing.row === rowIndex && editing.column === column
                  const value = row[column]
                  const isSelected = selected && selected.row === rowIndex && selected.column === column
                  // Typing into an empty cell below the last case goes through
                  // the spare-row editor, which appends the cases on commit.
                  const isSpareEdit = spare && spare.row === rowIndex && spare.column === column && typeof spare.value === 'string'
                  if (isSpareEdit) {
                    return h('td', { key: variable.name, className: `${alignOf(variable)} ${freeze.cols !== false && column === 0 ? 'ap-freeze-col' : ''}`.trim() },
                      h('input', {
                        className: 'ap-cell-input',
                        autoFocus: true,
                        ref: (element) => {
                          if (!element) return
                          element.value = spare.value
                          element.setSelectionRange(spare.value.length, spare.value.length)
                        },
                        defaultValue: spare.value,
                        onBlur: (event) => {
                          const text = event.target.value
                          setSpare(null)
                          if (text) onEdit?.(rowIndex, variable.name, labelToValue(variable, text), { focus: true })
                        },
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            const text = event.currentTarget.value
                            if (text) onEdit?.(rowIndex, variable.name, labelToValue(variable, text), { focus: true })
                            setSpare({ row: rowIndex + 1, column, value: '' })
                          } else if (event.key === 'Tab') {
                            event.preventDefault()
                            const text = event.currentTarget.value
                            if (text) onEdit?.(rowIndex, variable.name, labelToValue(variable, text), { focus: true })
                            const nextColumn = Math.max(0, Math.min(variables.length - 1, column + (event.shiftKey ? -1 : 1)))
                            setSpare({ row: rowIndex, column: nextColumn, value: '' })
                          } else if (event.key === 'Escape') setSpare(null)
                        },
                      }))
                  }
                  if (isEditing) {
                    // The editor opens with the same text the cell shows: with
                    // labels on, "男" must not silently become "1".
                    const edited = showLabels === false
                      ? (value === null || value === undefined ? '' : String(value))
                      : valueLabels(variable, value)
                    // A printable key opened this editor: it starts with that
                    // character and the caret at the end, so typing feels like
                    // typing into the cell itself.
                    const seed = typeof editing.value === 'string' ? editing.value : null
                    const commit = (text) => {
                      onEdit?.(rowIndex, variable.name, labelToValue(variable, text), { focus: true })
                      setEditing(null)
                    }
                    const commitAndMove = (text, dRow, dCol) => {
                      onEdit?.(rowIndex, variable.name, labelToValue(variable, text), { focus: true })
                      setEditing(null)
                      const nextRow = rowIndex + dRow
                      if (nextRow >= (total ?? rows.length)) {
                        // Past the last case the blank rows take over, so a
                        // column can be typed in one Enter at a time.
                        const column0 = Math.max(0, Math.min(variables.length - 1, column + dCol))
                        setSpare({ row: nextRow, column: column0, variable: variables[column0].name, value: '' })
                        return
                      }
                      const nextColumn = Math.max(0, Math.min(variables.length - 1, column + dCol))
                      onSelect?.({ row: nextRow, column: nextColumn })
                      setEditing({ row: nextRow, column: nextColumn })
                      scrollToRow(nextRow)
                    }
                    return h('td', { key: variable.name, className: `${alignOf(variable)} ${freeze.cols !== false && column === 0 ? 'ap-freeze-col' : ''}`.trim() },
                      h('input', {
                        className: 'ap-cell-input',
                        autoFocus: true,
                        ref: (element) => {
                          if (!element) return
                          if (seed === null) element.select()
                          else { element.value = seed; element.setSelectionRange(seed.length, seed.length) }
                        },
                        defaultValue: seed ?? edited,
                        onBlur: (event) => commit(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') { event.preventDefault(); commitAndMove(event.currentTarget.value, 1, 0) }
                          else if (event.key === 'Tab') { event.preventDefault(); commitAndMove(event.currentTarget.value, 0, event.shiftKey ? -1 : 1) }
                          else if (event.key === 'Escape') setEditing(null)
                        },
                      }))
                  }
                  // SPSS lets the editor show either the stored value or its
                  // label; the tooltip always carries the other one.
                  const raw = value === null || value === undefined ? '' : String(value)
                  const labelled = valueLabels(variable, value)
                  const display = showLabels === false ? raw : labelled
                  const picked = inSelection(rowIndex, column)
                  return h('td', {
                    key: variable.name,
                    className: `${alignOf(variable)} ${isSelected ? 'ap-sel' : ''} ${picked ? 'ap-cell-selected' : ''} ${freeze.cols !== false && column === 0 ? 'ap-freeze-col' : ''}`.trim(),
                    // A cell holds a value, not a caption.
                    translate: false,
                    title: showLabels === false ? labelled : raw,
                    onDoubleClick: () => { setEditing({ row: rowIndex, column }); onSelect?.({ row: rowIndex, column }) },
                    onMouseDown: (event) => startMarquee(event, rowIndex, column),
                    onClick: (event) => { wrapRef.current?.focus(); selectCell(rowIndex, column, event) },
                    // The row itself may re-render between a right-click and the
                    // menu opening (selection change), so it is dispatched after
                    // the current event finishes; a stale row/column in this
                    // closure would otherwise open the menu on the wrong cell.
                    onContextMenu: (event) => {
                      const { clientX, clientY } = event
                      event.preventDefault()
                      window.setTimeout(() => openCellMenu({ preventDefault() {}, clientX, clientY }, rowIndex, column), 0)
                    },
                    'data-row': rowIndex,
                    'data-column': column,
                  }, display)
                }),
                Array.from({ length: spareCount }, (unused, offset) => h('td', {
                  key: `__spare-${offset}`,
                  className: 'ap-spare ap-num',
                  style: { width: spareWidth },
                  title: '空单元格：双击建立新变量',
                  onDoubleClick: () => setSpare({ row: rowIndex, column: variables.length + offset }),
                }, (spare && spare.row === rowIndex && spare.column === variables.length + offset) || (editing && editing.row === rowIndex && editing.column === offset + variables.length)
                  // The value goes straight into the column about to exist, so
                  // one edit both creates the variable and fills the cell;
                  // Enter drops to the next case so a whole column can be typed.
                  ? h('input', {
                    className: 'ap-cell-input',
                    autoFocus: true,
                    ref: (element) => {
                      if (!element) return
                      if (typeof spare.value === 'string') { element.value = spare.value; element.setSelectionRange(spare.value.length, spare.value.length) }
                    },
                    defaultValue: typeof spare.value === 'string' ? spare.value : '',
                    onBlur: (event) => { const text = event.target.value; setSpare(null); if (text) onNewVariable?.(offset, text, rowIndex) },
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        const text = event.currentTarget.value
                        if (text) onNewVariable?.(offset, text, rowIndex)
                        setSpare({ row: rowIndex + 1, column: variables.length + offset, offset, value: '' })
                      } else if (event.key === 'Escape') setSpare(null)
                    },
                  })
                  : '')))}),
            // The tail spacer stands in for cases not yet paged in. When every
            // case is already rendered it must vanish: an empty <tr> still
            // draws a one-row-tall band, which is exactly the phantom blank
            // line users saw between the last case and the first empty row.
            (total - end) > 0
              ? h('tr', { 'aria-hidden': 'true', className: 'ap-spacer-row', style: { height: (total - end) * rowHeight } },
                h('td', { colSpan: columnCount, className: 'ap-spacer', style: { height: (total - end) * rowHeight } }, ''))
              : null,
            Array.from({ length: SPARE_ROWS }, (unused, offset) => h('tr', { key: `__spare-row-${offset}`, className: 'ap-blank-row' },
              h('td', { className: 'ap-rownum ap-spare-num' }, String((total ?? 0) + offset + 1)),
              variables.map((variable, column) => h('td', {
                key: variable.name,
                className: `${alignOf(variable)} ap-spare`,
                title: '这一行还不是个案：双击或直接输入会新建个案',
                onDoubleClick: () => onEdit?.(Math.max(total ?? 0, rows.length) + offset, variable.name, '', { focus: true }),
                onClick: () => {
                  wrapRef.current?.focus()
                  onSelect?.({ row: Math.max(total ?? 0, rows.length) + offset, column })
                },
              }, '')),
              Array.from({ length: spareCount }, (unused, inner) => h('td', { key: `__spare-${inner}`, className: 'ap-spare' }, '')))))))
    }

    function valueLabels(variable, value) {
      if (value === null || value === undefined) return ''
      const label = variable.valueLabels?.[String(value)]
      return label === undefined ? String(value) : label
    }

    // A plain click opens an editor that is empty on screen but keeps the old
    // value as its placeholder, so typing replaces and Enter keeps.
    const EDIT_SELECT_ALL = '\u0000select-all'

    // Typing a label back into a cell stores the value it stands for; anything
    // else is left for the host to parse (numbers stay numbers).
    function labelToValue(variable, text) {
      const raw = String(text ?? '')
      const labels = variable.valueLabels ?? {}
      for (const [key, label] of Object.entries(labels)) {
        if (String(label) === raw) return key
      }
      return raw
    }

    function tableToCsv(matrix) {
      return (matrix ?? []).map((row) => (row ?? []).map((cell) => {
        const text = cell === null || cell === undefined ? '' : String(cell)
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
      }).join(',')).join('\n')
    }

    function saveTextFile(name, text, type = 'text/csv;charset=utf-8') {
      const blob = new Blob([text], { type })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 3000)
    }

    async function copyText(text) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }

    // Cells 0-2 are the row number, the name and the type drop-down; the typed
    // columns start at index 3, in the order of TYPED.
    const TYPED_COLUMNS = ['name', 'width', 'decimals', 'label', 'missing']
    // Shared by the data sheet and the variable sheet's preview column so the
    // two views can never disagree about which side a value hugs.
    // PSPP gives every numeric variable RIGHT and strings LEFT; that default is
    // what the sheet shows, because the user sets alignment in the variable
    // sheet only when they mean it.
    const alignmentClass = (variable) => {
      const chosen = variable?.alignment
      if (chosen === 'left') return 'ap-left'
      if (chosen === 'center') return 'ap-center'
      return 'ap-num'
    }

    // The in-sheet editor owns its input node: nothing above it re-renders the
    // value, and every commit reads the live node value, because a window-level
    // listener can commit before React has delivered the matching keystroke.
    function CellEditor({ initial, id, placeholder, onCommit, onCancel }) {
      const inputRef = useRef(null)
      const done = useRef(false)
      const selectAll = initial === EDIT_SELECT_ALL
      useEffect(() => { done.current = false }, [id])
      // A plain click opens an empty editor with the old value waiting as a
      // placeholder: nothing is selected, so the old text must survive Enter.
      const value = () => {
        const node = inputRef.current
        const text = typeof node?.value === 'string' ? node.value : String(initial ?? '')
        return selectAll && text === '' ? String(placeholder ?? '') : text
      }
      const fire = (step) => {
        if (done.current) return
        done.current = true
        onCommit(value(), step)
      }
      return h('input', {
        key: id,
        ref: inputRef,
        type: 'text',
        autoFocus: true,
        defaultValue: selectAll ? '' : String(initial ?? ''),
        placeholder: selectAll ? (placeholder ?? '') : undefined,
        style: { width: '100%', boxSizing: 'border-box' },
        onMouseDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
        onBlur: () => fire(0),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); fire(1); return }
          if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); fire(event.shiftKey ? -1 : 1); return }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done.current = true; onCancel() }
        },
      })
    }

    function VariableGrid({ variables, widths = {}, onWidth, onUpdate, onAdd, onRename, onDelete, onEditLabels, onMove, onBatch, jumpTo = null }) {
      const columns = [
        ['name', '名称'], ['type', '类型'], ['width', '宽度'], ['decimals', '小数'],
        ['label', '标签'], ['values', '值'], ['missing', '缺失'], ['columns', '列'], ['measure', '测量'],
        ['alignment', '对齐'], ['role', '角色'],
      ]
      // A fresh variable starts as a plain numeric one; the sheet edits the rest.
      const [draft, setDraft] = useState(null)
      const [dragging, setDragging] = useState(null)
      const [dropAt, setDropAt] = useState(null)
      // The variable view selects whole rows: click selects one, Shift extends
      // the range, Ctrl toggles, the way SPSS lets you pick several at once.
      const [selected, setSelected] = useState([])
      const [anchor, setAnchor] = useState(null)
      const [menu, setMenu] = useState(null)
      // SPSS types the variable properties straight into the sheet: a key opens
      // an editor in the focused cell, Enter commits and steps down.
      const [cellEdit, setCellEdit] = useState(null)
      const wrapRef = useRef(null)
      const focusRow = (index) => {
        const rows = wrapRef.current?.querySelectorAll('tbody tr')
        rows?.[index]?.focus?.()
      }
      useEffect(() => { setCellEdit(null) }, [variables.length])
      // 转到变量 / 粘贴变量 land here: select the row, focus it and bring it
      // into view, which is what SPSS does when you jump to a variable.
      useEffect(() => {
        if (!jumpTo?.name) return
        const index = variables.findIndex((variable) => variable.name === jumpTo.name)
        if (index < 0) return
        setSelected([jumpTo.name])
        setAnchor(index)
        const row = wrapRef.current?.querySelectorAll('tbody tr')?.[index]
        row?.scrollIntoView?.({ block: 'center' })
        row?.focus?.()
      }, [jumpTo, variables])
      const selectRow = (index, event) => {
        if (event?.shiftKey && anchor !== null) {
          const [from, to] = [Math.min(anchor, index), Math.max(anchor, index)]
          setSelected(variables.slice(from, to + 1).map((variable) => variable.name))
          return
        }
        if (event?.ctrlKey || event?.metaKey) {
          setSelected((current) => (current.includes(variables[index].name)
            ? current.filter((name) => name !== variables[index].name)
            : [...current, variables[index].name]))
          setAnchor(index)
          return
        }
        setSelected([variables[index].name])
        setAnchor(index)
      }
      useEffect(() => {
        if (!menu) return
        const close = (event) => {
          if (!event.target.closest?.('.ap-var-menu')) setMenu(null)
        }
        window.addEventListener('mousedown', close, true)
        return () => window.removeEventListener('mousedown', close, true)
      }, [menu])
      // Columns you can type into; the rest are drop-downs or buttons.
      const TYPED = ['name', 'width', 'decimals', 'label', 'missing']
      const currentOf = (variable, column) => (column === 'label' ? variable.label ?? ''
        : column === 'missing' ? (variable.missing ?? []).join(' ') : String(variable[column] ?? ''))
      useEffect(() => {
        const onArm = (event) => {
          if (!wrapRef.current?.contains(event.target)) return
          if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return
          // The cell's own control already handles the key: a <select> needs
          // letters for type-ahead, and an <input> that is still mounted would
          // otherwise open a second editor one cell to its right.
          if (event.target.closest?.('input, textarea, select')) return
          // Keys reach here from the cell, from one of its buttons (值, 排序)
          // or from the row itself, so locate the row first, then the cell.
          const row = event.target.closest?.('tr')
          if (!row || row.className.includes('ap-var-new')) return
          const direct = event.target === row
          const cell = direct ? row.children[1] : [...row.children].find((entry) => entry.contains(event.target))
          const column = cell ? TYPED_COLUMNS[cell.cellIndex - 3] : null
          const index = [...wrapRef.current.querySelectorAll('tbody tr')].filter((tr) => !tr.className.includes('ap-var-new')).indexOf(row)
          if (index < 0 || !column) return
          event.preventDefault()
          event.stopPropagation()
          // Remember what the editor was opened with: its own onCommit closure
          // predates this state update and would compare against a stale copy.
          openRef.current = { index, column, value: currentOf(variables[index], column) }
          setCellEdit({ index, column, value: event.key })
        }
        window.addEventListener('keydown', onArm, true)
        return () => window.removeEventListener('keydown', onArm, true)
        // Deliberately no dependency on cellEdit: the listener must always see
        // the freshest state, and re-registering it mid-render would drop the
        // keystroke that opened the editor.
      }, [variables.length, selected.length])
      // Typing into the focused cell opens an editor in place; the app-level
      // window listener reaches this even when the focus sits on an input.
      useEffect(() => {
        if (!cellEdit) return
        const onKey = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); setCellEdit(null); focusRow(cellEdit.index) }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [cellEdit])
      // The editor is mounted from the render in which this cell was armed.
      // Opening the editor and pressing Enter can happen inside one React
      // batch, so the commit may see `cellEdit === null`; the cell that was
      // armed is remembered here instead and consumed on the next commit.
      const openRef = useRef(null)
      const commitEdit = (raw, step = 1) => {
        const target = cellEdit ?? openRef.current
        if (!target) return
        const { index, column, value } = target
        const opened = openRef.current
        const before = opened && opened.index === index && opened.column === column ? opened.value : value
        const variable = variables[index]
        openRef.current = null
        setCellEdit(null)
        const typed = String(raw).trim()
        const dirty = opened && opened.index === index && opened.column === column
          ? typed !== String(before ?? '').trim()
          : Boolean(typed)
        if (dirty && variable) {
          if (column === 'name') {
            const next = typed
            if (next && next !== variable.name) onRename?.(variable.name, next)
          } else if (column === 'missing') {
            const numbers = raw.split(/[\s,]+/).map((item) => Number(item)).filter((item) => Number.isFinite(item))
            save(variable.name, 'missing', numbers)
          } else save(variable.name, column, typed)
        }
        const next = index + step
        if (next >= 0 && next < variables.length) {
          selectRow(next, {})
          focusRow(next)
        }
      }
      const save = (name, key, raw) => {
        const patch = {}
        if (key === 'width' || key === 'decimals') patch[key] = Number(raw) || 0
        else patch[key] = raw
        onUpdate?.(name, patch)
      }
      // Column widths of the variable sheet itself (separate from the data
      // view's cell widths): drag the header boundary, double-click to reset.
      const defaults = { name: 140, type: 84, width: 66, decimals: 66, label: 200, values: 92, missing: 112, columns: 66, measure: 84, alignment: 84, role: 72 }
      const [colWidths, setColWidths] = useState(() => {
        try {
          const stored = JSON.parse(localStorage.getItem('ap.varWidths') ?? '{}')
          return stored && typeof stored === 'object' ? stored : {}
        } catch { return {} }
      })
      const widthOf = (key) => colWidths[key] ?? defaults[key] ?? 100
      const rememberWidths = (next) => {
        setColWidths(next)
        try { localStorage.setItem('ap.varWidths', JSON.stringify(next)) } catch { /* quota */ }
      }
      const startColResize = (event, key) => {
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const startWidth = widthOf(key)
        const onMove = (moveEvent) => {
          const next = Math.max(48, Math.min(600, startWidth + (moveEvent.clientX - startX)))
          rememberWidths({ ...colWidths, [key]: next })
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      const commitDraft = () => {
        const text = draft?.trim()
        setDraft(null)
        if (text) onAdd?.(text)
      }
      // Dropping row `name` onto row `index` moves it to that slot; the target
      // position is one-based on the host side.
      // Wrap a typed cell so a key pressed on its input becomes the editor seed,
      // and so a click into it arms the row for the next keystroke.
      const editable = (column, variable, index, ...content) => h('td', {
        className: 'ap-var-cell',
        // A click on the cell's padding, or on its <select>/value button,
        // arms the editor in place; clicks on the text input are left alone so
        // the caret keeps its position. The window-level listener covers keys
        // that arrive while the whole row (not the cell) has the focus.
        onClick: (event) => {
          selectRow(index, event)
          if (cellEdit) return
          // Clicks on plain text, the drag handle or the row padding all open
          // the editor; a click inside an existing control keeps its focus.
          if (event.target.closest?.('input, textarea, select, button')) return
          openRef.current = { index, column, value: currentOf(variables[index], column) }
          setCellEdit({ index, column, value: EDIT_SELECT_ALL })
        },
      }, cellEdit && cellEdit.index === index && cellEdit.column === column
        ? h(CellEditor, {
          initial: cellEdit.value,
          placeholder: openRef.current?.value ?? '',
          id: `${index}:${column}`,
          onCommit: (text, step) => commitEdit(text, step),
          onCancel: () => { setCellEdit(null); focusRow(index) },
        })
        : content)
      const drop = (index, fallback) => {
        const name = dragging ?? fallback
        setDragging(null)
        setDropAt(null)
        if (!name) return
        const from = variables.findIndex((variable) => variable.name === name)
        if (from < 0 || from === index) return
        onMove?.(name, index + 1)
      }
      return h('div', { className: 'ap-grid-wrap', ref: wrapRef },
        h('div', { className: 'ap-var-tools' },
          h('button', { className: 'ap-tool', style: { flex: 'none', whiteSpace: 'nowrap' }, onClick: () => setDraft('') }, '新建变量'),
          h('div', { className: 'ap-hint' }, '拖动左侧把手调整变量顺序（数据视图的列顺序跟着变）；双击单元格编辑；拖动表头右边界改列宽。')),
        h('table', { className: 'ap-grid', style: { width: 88 + columns.reduce((sum, [key]) => sum + widthOf(key), 0) } },
          h('thead', null, h('tr', null, h('th', { className: 'ap-rownum' }, '顺序'), columns.map(([key, title]) => h('th', {
            key,
            style: { width: widthOf(key), minWidth: widthOf(key) },
            title: tr('{0}（拖动右边界改列宽，双击恢复）', tr(title)),
            onMouseDown: (event) => {
              const box = event.currentTarget.getBoundingClientRect()
              if (box.right - event.clientX <= 8) startColResize(event, key)
            },
            onDoubleClick: (event) => {
              const box = event.currentTarget.getBoundingClientRect()
              if (box.right - event.clientX > 8) return
              const next = { ...colWidths }
              delete next[key]
              rememberWidths(next)
            },
          }, title, h('span', { className: 'ap-col-resize' }))))),
          h('tbody', null,
            variables.map((variable, index) => h('tr', {
              key: variable.name,
              tabIndex: 0,
              className: `${dropAt === index ? 'ap-var-drop ' : ''}${selected.includes(variable.name) ? 'ap-var-sel' : ''}`,
              onClick: (event) => selectRow(index, event),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                const at = selected.indexOf(variable.name)
                if (event.key === 'Escape') { setSelected([]); setAnchor(null); return }
                if ((event.key === 'Delete' || event.key === 'Backspace') && selected.length) {
                  event.preventDefault()
                  onDelete?.(selected.length === 1 ? selected[0] : [...selected])
                  setSelected([])
                  return
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const next = event.key === 'ArrowDown' ? index + 1 : index - 1
                  if (next >= 0 && next < variables.length) {
                    selectRow(next, { shiftKey: event.shiftKey })
                    event.currentTarget.parentElement.children[next]?.focus()
                  }
                  return
                }
                // A printable key starts editing the name cell, the way SPSS
                // opens the cell when you simply type.
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                  event.preventDefault()
                  setCellEdit({ index, column: 'name', value: event.key })
                }
                if (event.key === 'Enter' || event.key === 'F2') {
                  event.preventDefault()
                  setCellEdit({ index, column: 'name', value: '' })
                }
              },
              onContextMenu: (event) => {
                event.preventDefault()
                selectRow(index, event)
                const box = event.currentTarget.getBoundingClientRect()
                setMenu({ x: event.clientX, y: Math.min(event.clientY, box.top + 24), names: selected.includes(variable.name) ? selected : [variable.name] })
              },
              draggable: true,
              onDragStart: (event) => {
                setDragging(variable.name)
                event.dataTransfer?.setData('text/plain', variable.name)
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              },
              onDragEnd: () => { setDragging(null); setDropAt(null) },
              onDragOver: (event) => { event.preventDefault(); setDropAt(index) },
              onDrop: (event) => { event.preventDefault(); drop(index, event.dataTransfer?.getData('text/plain')) },
            },
              h('td', { className: 'ap-rownum' }, String(index + 1)),
              editable('name', variable, index,
                h('span', {
                  className: 'ap-var-drag',
                  title: '拖动调整顺序',
                  style: { cursor: 'grab', color: 'var(--ap-text-3)', marginRight: 6, userSelect: 'none' },
                }, '⠿'),
                h('span', {
                  key: 'name',
                  className: 'ap-var-name',
                  style: { color: 'var(--ap-text)', fontWeight: 600 },
                  title: tr('单击改名'),
                  translate: false,
                }, variable.name),
                h('button', {
                  className: 'ap-tool',
                  style: { padding: '0 4px', fontSize: 10, marginLeft: 6 },
                  onClick: (event) => { event.stopPropagation(); onDelete?.(variable.name) },
                  title: '删除变量',
                }, '×')),
              h('td', null, h('select', {
                value: variable.type,
                onChange: (event) => onUpdate?.(variable.name, { type: event.target.value, format: event.target.value === 'string' ? `A${variable.width}` : `F${variable.width}.${variable.decimals}` }),
              }, h('option', { value: 'numeric' }, '数值'), h('option', { value: 'string' }, '字符串'))),
              editable('width', variable, index, h('input', {
                type: 'number', defaultValue: variable.width, style: { width: '100%' },
                onBlur: (event) => save(variable.name, 'width', event.target.value),
              })),
              editable('decimals', variable, index, h('input', {
                type: 'number', defaultValue: variable.decimals, style: { width: '100%' },
                onBlur: (event) => save(variable.name, 'decimals', event.target.value),
              })),
              editable('label', variable, index, h('input', {
                type: 'text', defaultValue: variable.label ?? '', style: { width: '100%' },
                onBlur: (event) => save(variable.name, 'label', event.target.value),
              })),
              h('td', { title: Object.entries(variable.valueLabels ?? {}).map(([key, label]) => `${key}=${label}`).join('\n') },
                h('button', {
                  className: 'ap-tool',
                  style: { padding: '0 4px', fontSize: 10 },
                  onClick: () => onEditLabels?.(variable),
                }, Object.keys(variable.valueLabels ?? {}).length ? `${Object.keys(variable.valueLabels).length} 个` : '编辑…')),
              h('td', { title: JSON.stringify(variable.missing ?? []) },
                h('input', {
                  type: 'text',
                  defaultValue: missingToText(variable.missing),
                  placeholder: '空格分隔，区间写 90 THRU 99',
                  title: '用空格或逗号分隔；区间写成 90 THRU 99',
                  style: { width: '100%' },
                  onBlur: (event) => {
                    const missing = parseMissingInput(event.target.value, variable.type)
                    // Blur without a change must not rewrite the variable: a
                    // range that came back as "[object Object]" was cleared by
                    // simply clicking into the field and leaving it.
                    const before = JSON.stringify(variable.missing ?? [])
                    if (JSON.stringify(missing) === before) return
                    onUpdate?.(variable.name, { missing })
                  },
                })),
              h('td', { title: '数据视图里的显示宽度（像素）' }, h('input', {
                type: 'number', min: 40, max: 600, step: 8,
                defaultValue: widths[variable.name] ?? 96,
                style: { width: '100%' },
                onBlur: (event) => {
                  const value = Number(event.target.value)
                  onWidth?.(variable.name, Number.isFinite(value) && value >= 40 ? Math.min(600, value) : null)
                },
              })),
              h('td', null, h('select', {
                value: variable.measure, onChange: (event) => onUpdate?.(variable.name, { measure: event.target.value }),
              }, h('option', { value: 'scale' }, '度量'), h('option', { value: 'ordinal' }, '有序'), h('option', { value: 'nominal' }, '名义'))),
              h('td', null, h('select', {
                value: variable.alignment, onChange: (event) => onUpdate?.(variable.name, { alignment: event.target.value }),
              }, h('option', { value: 'left' }, '左'), h('option', { value: 'right' }, '右'), h('option', { value: 'center' }, '居中'))),
              h('td', null, variable.role ?? 'input')))),
            // The row below the last variable creates one, the way SPSS lets you
            // type into the empty row at the bottom of the Variable View.
            h('tr', {
              className: 'ap-var-new',
              onClick: () => { if (draft === null) setDraft('') },
              onDragOver: (event) => { event.preventDefault(); setDropAt(variables.length) },
              onDrop: (event) => { event.preventDefault(); drop(variables.length, event.dataTransfer?.getData('text/plain')) },
            },
            h('td', { className: 'ap-rownum' }, '+'),
            // The draft lives in the name cell only: stretching an input across
            // every column made the sheet jump sideways while typing.
            h('td', { className: 'ap-name' },
              draft === null
                ? h('span', { className: 'ap-hint', style: { cursor: 'pointer' } }, '＋ 单击这一行新建变量')
                : h('input', {
                  type: 'text',
                  autoFocus: true,
                  value: draft,
                  placeholder: '变量名，回车新建',
                  style: { width: '100%', boxSizing: 'border-box' },
                  onClick: (event) => event.stopPropagation(),
                  onChange: (event) => setDraft(event.target.value),
                  onBlur: commitDraft,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); commitDraft() }
                    if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
                  },
                })),
            Array.from({ length: columns.length - 1 }, (unused, offset) => h('td', { key: `__new-${offset}` }, '')))),
        menu
          ? h('div', {
            className: 'ap-var-menu',
            style: { position: 'fixed', left: menu.x, top: menu.y, zIndex: 40 },
          },
          h('div', { className: 'ap-menu-label' }, `${menu.names.length} 个变量`),
          h('button', {
            className: 'ap-var-item',
            onClick: () => {
              setMenu(null)
              onAdd?.(menu.names.length === 1 ? menu.names[0] : undefined)
            },
          }, '新建变量…'),
          h('button', {
            className: 'ap-var-item',
            onClick: () => {
              const names = menu.names
              setMenu(null)
              ;(async () => {
                for (const name of names) await onMove?.(name, 1)
              })()
            },
          }, '移到最前面'),
          h('button', {
            className: 'ap-var-item',
            onClick: () => {
              const names = menu.names
              const end = variables.length
              setMenu(null)
              ;(async () => {
                for (const name of names) await onMove?.(name, end)
              })()
            },
          }, '移到最后面'),
          h('button', {
            className: 'ap-var-item',
            onClick: () => {
              const names = menu.names
              setMenu(null)
              onBatch?.(names)
            },
          }, menu.names.length > 1 ? tr('批量修改这 {0} 个变量…', menu.names.length) : '批量修改变量属性…'),
          h('button', {
            className: 'ap-var-item ap-danger',
            onClick: () => {
              const names = menu.names
              setMenu(null)
              ;(async () => {
                for (const name of names) await onDelete?.(name)
              })()
            },
          }, menu.names.length > 1 ? tr('删除这 {0} 个变量', menu.names.length) : '删除变量'))
          : null)
    }

    /**
     * Batch edit for the variable view. The grid allows shift-click selection
     * but edits one cell at a time; ten variables sharing 小数位 = 2 is a common
     * after-import fix, and doing it row by row is also ten undo steps.
     */
    function VariableBatchDialog({ names, onClose, onRun }) {
      const [decimals, setDecimals] = useState('')
      const [measure, setMeasure] = useState('')
      const [width, setWidth] = useState('')
      const [type, setType] = useState('')
      const patch = () => {
        const out = {}
        if (String(decimals).trim() !== '') out.decimals = Number(decimals)
        if (String(width).trim() !== '') out.width = Number(width)
        if (measure !== '') out.measure = measure
        if (type !== '') out.type = type
        return out
      }
      const chosen = patch()
      return h(Modal, {
        title: tr('批量修改变量属性'),
        okText: '应用',
        okDisabled: Object.keys(chosen).length === 0,
        onCancel: onClose,
        onOk: () => onRun(patch()),
      },
      h('div', { className: 'ap-hint' }, tr('将要修改这 {0} 个变量：{1}', names.length, names.join('、'))),
      h('div', { className: 'ap-var-batch' },
        h('label', null,
          h('span', null, '类型'),
          h('select', { value: type, onChange: (event) => setType(event.target.value) },
            h('option', { value: '' }, '不改'),
            h('option', { value: 'numeric' }, '数值'),
            h('option', { value: 'string' }, '字符串'))),
        h('label', null,
          h('span', null, '小数位'),
          h('input', {
            type: 'number', min: 0, max: 16, value: decimals, style: { width: 80 },
            placeholder: '不改', onChange: (event) => setDecimals(event.target.value),
          })),
        h('label', null,
          h('span', null, '宽度'),
          h('input', {
            type: 'number', min: 1, max: 255, value: width, style: { width: 80 },
            placeholder: '不改', onChange: (event) => setWidth(event.target.value),
          })),
        h('label', null,
          h('span', null, '测量'),
          h('select', { value: measure, onChange: (event) => setMeasure(event.target.value) },
            h('option', { value: '' }, '不改'),
            h('option', { value: 'scale' }, '标度'),
            h('option', { value: 'ordinal' }, '有序'),
            h('option', { value: 'nominal' }, '名义')))),
      h('div', { className: 'ap-hint' }, '留空的项不改；一次「撤销」能全部还原。'))
    }

    /**
     * Column widths, header wording and a footnote for one output table.
     *
     * SPSS's own table editor is much larger; this covers what a thesis table
     * actually needs: three-line style, adjusted column widths, a rewritten
     * header and the "note:" line under the table.
     */
    function TableEditDialog({ item, edits, onSave, onReset, onClose }) {
      const matrix = Array.isArray(item?.table?.matrix) ? item.table.matrix : []
      const header = Array.isArray(matrix[0]) ? matrix[0] : []
      const columns = Math.max(header.length, 1)
      const [headers, setHeaders] = useState(() => Array.from({ length: columns }, (_, index) => (
        edits?.headers?.[index] ?? (header[index] === undefined ? '' : String(header[index]))
      )))
      const [widths, setWidths] = useState(() => Array.from({ length: columns }, (_, index) => (
        edits?.widths?.[index] ?? ''
      )))
      const [footnote, setFootnote] = useState(edits?.footnote ?? '')
      const setAt = (list, index, value) => list.map((entry, position) => (position === index ? value : entry))
      return h(Modal, {
        title: tr('编辑表格 — {0}', item?.title ?? tr('表格')),
        wide: true,
        okText: '保存',
        onCancel: onClose,
        onOk: () => onSave({
          headers,
          widths: widths.map((value) => Number(value) || 0),
          footnote,
        }),
        leading: [
          h('button', { key: 'reset', className: 'ap-tool', onClick: onReset }, '恢复默认'),
        ],
      },
      h('div', { className: 'ap-dlg-caption' }, '列设置（表头文字 / 列宽像素，留空则自动）'),
      h('div', { className: 'ap-edit-table' }, Array.from({ length: columns }, (_, index) => h('div', {
        key: index,
        className: 'ap-edit-row',
      },
      h('span', { className: 'ap-edit-index' }, tr('第 {0} 列', index + 1)),
      h('input', {
        type: 'text',
        className: 'ap-grow',
        value: headers[index] ?? '',
        placeholder: String(header[index] ?? ''),
        onChange: (event) => setHeaders(setAt(headers, index, event.target.value)),
      }),
      h('input', {
        type: 'number',
        style: { width: 88 },
        value: widths[index] ?? '',
        placeholder: '自动',
        onChange: (event) => setWidths(setAt(widths, index, event.target.value)),
      })))),
      h('div', { className: 'ap-dlg-caption', style: { marginTop: 12 } }, '脚注（如「注：数据以均数±标准差表示」）'),
      h('input', {
        type: 'text',
        style: { width: '100%' },
        value: footnote,
        onChange: (event) => setFootnote(event.target.value),
      }),
      h('div', { className: 'ap-hint' }, '保存后这张表按新排版显示，导出 HTML 时一并生效；导出的 Word/Excel 仍是 PSPP 原始表格。'))
    }

    function OutputDoc({
      items, state, onRemove, onEditChart, onExportChart = () => {}, tableStyle = 'default',
      picks = null, onTogglePick = null, onReportExport = null,
      onReplayRun = null, onInsertRunSyntax = null,
      tableEdits = {}, onEditTable = () => {}, onPairwise = () => {}, onRoc = () => {},
      onExportItem = () => {}, pngScale = 1, onPickScale = () => {}, onRedrawChart = () => {},
    }) {
      const [active, setActive] = useState(null)
      // Which big tables the user asked to see in full. View-only, like the
      // collapse state: exports and copies always use the whole table.
      const [expandedTables, setExpandedTables] = useState({})
      const toggleTableRows = (id) => setExpandedTables((current) => {
        const next = { ...current }
        if (next[id]) delete next[id]
        else next[id] = true
        return next
      })
      // Collapse is view-only state: the host keeps every item, so exporting
      // and the outline still see them.
      const [collapsed, setCollapsed] = useState(() => {
        try { return JSON.parse(localStorage.getItem('ap.collapsed') ?? '{}') ?? {} } catch { return {} }
      })
      const toggleItem = (id) => {
        setCollapsed((current) => {
          const next = { ...current, [id]: !current[id] }
          if (!next[id]) delete next[id]
          try { localStorage.setItem('ap.collapsed', JSON.stringify(next)) } catch { /* quota */ }
          return next
        })
      }
      // SPSS's navigation tree is 190px in the Viewer; the sidebar is narrow, so
      // 150 is the floor and the drag handle still goes up to 460.
      const [outlineWidth, setOutlineWidth] = useState(() => {
        const stored = Number(localStorage.getItem('ap.outlineWidth'))
        return Number.isFinite(stored) && stored >= 150 && stored <= 460 ? stored : 190
      })
      const startOutlineResize = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = outlineWidth
        const onMove = (moveEvent) => {
          const next = Math.max(150, Math.min(460, startWidth + (moveEvent.clientX - startX)))
          setOutlineWidth(next)
          try { localStorage.setItem('ap.outlineWidth', String(next)) } catch { /* quota */ }
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      const [zoom, setZoom] = useState(null)
      const [hint, setHint] = useState(null)
      const copyHint = (message) => {
        setHint(message)
        window.setTimeout(() => setHint(null), 2500)
      }
      const docRef = useRef(null)
      useEffect(() => {
        if (!active || !docRef.current) return
        const target = docRef.current.querySelector(`[data-item-id="${active}"]`)
        target?.scrollIntoView({ block: 'start' })
      }, [active])
      // SPSS right-aligns numeric columns. PSPP's table HTML arrives as bare
      // <td> text with no column type, so the only signal is the cell itself:
      // after every render, tag the all-number cells. Doing it on the DOM (not
      // in matrixHtml) keeps the exported HTML byte-identical.
      useEffect(() => {
        const root = docRef.current
        if (!root) return
        for (const cell of root.querySelectorAll('td')) {
          if (cell.classList.contains('ap-footnote')) continue
          const text = (cell.textContent ?? '').trim()
          if (text && isNumericCell(text)) cell.classList.add('ap-num')
        }
      })
      if (!items.length) {
        return h('div', { className: 'ap-empty' }, '尚无输出。运行语法或通过「分析」菜单执行一个过程。')
      }
      // The bar spans both columns, so the output area becomes a two-row grid
      // whenever it is visible.
      const showReportBar = Boolean(onReportExport && picks?.size > 0)
      return h('div', { className: `ap-output${showReportBar ? ' ap-output-grid' : ''}` },
        showReportBar
          ? h('div', { className: 'ap-report-bar' },
            h('span', { className: 'ap-hint' }, tr('报告卡：已选 {0} 个结果', picks.size)),
            h('span', { className: 'ap-grow' }),
            h('button', { className: 'ap-tool', onClick: onReportExport, title: '按勾选顺序重放这些分析，导出成文档' }, '导出报告卡…'),
            h('button', { className: 'ap-tool', onClick: () => onTogglePick?.('__clear__') }, '清空选择'))
          : null,
        h('div', { className: 'ap-outline', style: { width: outlineWidth, minWidth: outlineWidth } },
          (() => {
            // SPSS's Viewer groups results under the procedure that produced
            // them; ours came back as one flat list, so three runs in a row were
            // indistinguishable. One grey heading per run, in the order the runs
            // happened.
            const nodes = []
            let lastRun = null
            for (const item of items) {
              const runKey = item.runId ?? null
              if (runKey !== null && runKey !== lastRun) {
                lastRun = runKey
                // Two small actions per run: paste the syntax back into the
                // editor, or run it again as it was. SPSS's viewer has neither,
                // but a script the user cannot get back is a script they retype.
                nodes.push(h('div', { key: `run-${runKey}`, className: 'ap-ol-run' },
                  h('span', { className: 'ap-run-label' }, tr('运行 {0}', String(runKey))),
                  onInsertRunSyntax
                    ? h('button', {
                      className: 'ap-run-tool',
                      title: '把这一批的语法插到语法页',
                      onClick: (event) => { event.stopPropagation(); onInsertRunSyntax(runKey) },
                    }, '语法')
                    : null,
                  onReplayRun
                    ? h('button', {
                      className: 'ap-run-tool',
                      title: '按原样再跑一次',
                      onClick: (event) => { event.stopPropagation(); onReplayRun(runKey) },
                    }, '重跑')
                    : null))
              }
              const summary = item.kind === 'table' ? summarizeTable(item.table) : ''
              nodes.push(h('button', {
                key: item.id,
                // SPSS's Viewer highlights the tree item whose content is on the
                // right; ap-ol-active is that highlight (see --ap-select).
                className: `${item.kind === 'image' ? 'ap-ol-image' : item.kind === 'table' ? 'ap-ol-table' : 'ap-ol-heading'}${summary ? ' ap-ol-summary' : ''}${active === item.id ? ' ap-ol-active' : ''}`,
                title: summary ? `${item.title ?? ''}\n${summary}` : item.title,
                style: collapsed[item.id] ? { opacity: 0.55 } : null,
                onClick: () => setActive(item.id),
              },
              `${collapsed[item.id] ? '▸ ' : ''}${item.title || (item.kind === 'table' ? '表格' : '图')}`,
              summary ? h('span', { className: 'ap-ol-facts' }, summary) : null))
            }
            return nodes
          })()),
        h('span', { className: 'ap-outline-resize', onMouseDown: startOutlineResize, title: '拖动改变导航栏宽度' }),

        h('div', { className: 'ap-doc', ref: docRef },
          items.map((item) => {
            const shut = collapsed[item.id] === true
            const remove = onRemove
              ? h('button', {
                className: 'ap-tool',
                title: '从输出里删除这一项（不改变数据）',
                onClick: () => onRemove(item.id),
              }, '删除')
              : null
            // Everything that can be replayed into a report card gets a tick
            // box, not only the results computed here.
            // A chart has no `script` — it was not computed by a statement, it
            // was drawn from data — so keying the tick box on `script` alone left
            // the one output a report is most often made of without a box.
            const pick = picks && (item.script || item.kind === 'image')
              ? h('input', {
                type: 'checkbox',
                title: item.kind === 'image' ? '放进报告（成册）' : '放进报告卡',
                checked: picks.has(item.id),
                onChange: () => onTogglePick?.(item.id),
              })
              : null
            // Which data produced these numbers. The panel and the agent share
            // one workspace per session, but a session can hold several
            // documents and two sessions can open two files with the same name,
            // so a table on screen has no other way of saying where it came
            // from. Without it a screenshot of a table cannot be traced back.
            const provenance = (() => {
              const from = item.provenance
              if (!from) return null
              const name = from.name ?? (from.sourcePath ? basenameOf(from.sourcePath) : null)
              const opened = formatWhen(from.openedAt)
              // A dataset built in the panel has no file, so its name must not be
              // printed as if it were one ("prov-probe · 3 例" reads like a path).
              const built = from.origin === 'new'
              const dropped = from.origin === 'upload' || from.temporary === true
              const label = built
                ? tr('新建数据集{0} · {1} 例 · {2} 变量', name ? tr('（{0}，未保存）', name) : tr('（未保存）'), from.caseCount, from.varCount)
                : name
                  ? `${name} · ${from.caseCount} 例 · ${from.varCount} 变量`
                  : tr('未命名数据 · {0} 例 · {1} 变量', from.caseCount, from.varCount)
              const size = typeof from.sourceSize === 'number'
                ? (from.sourceSize < 1024 ? `${from.sourceSize} B` : `${(from.sourceSize / 1024).toFixed(1)} KB`)
                : null
              const modified = formatWhen(from.sourceMtime)
              const detail = [
                built
                  ? tr('这份数据没有对应的磁盘文件（在面板里新建的）')
                  : dropped
                    ? tr('这份数据是浏览器拖进来的副本，不是磁盘上的那份')
                    : name ? tr('数据文件：{0}', name) : tr('这份数据没有对应的磁盘文件'),
                from.sourcePath ? tr('来源路径：{0}', from.sourcePath) : null,
                from.sourcePath && size ? tr('读入时文件 {0}{1}', size, modified ? tr('，磁盘修改时间 {0}', modified) : '') : null,
                tr('计算时 {0} 个个案、{1} 个变量', from.caseCount, from.varCount),
                opened ? tr('打开于 {0}', opened) : null,
                from.sessionId ? tr('会话：{0}', from.sessionId) : null,
              ].filter(Boolean).join('\n')
              return h('span', { className: 'ap-prov', title: detail }, label)
            })()
            const head = (title, extra = []) => h('div', { className: 'ap-item-head' },
              pick,
              h('button', {
                className: 'ap-item-toggle',
                title: shut ? '展开这一项' : '折叠这一项',
                onClick: () => toggleItem(item.id),
              }, shut ? '▸' : '▾'),
              h('h3', null, title),
              h('span', { className: 'ap-grow' }),
              provenance,
              ...extra,
              remove)
            if (item.kind === 'table') {
              const caption = item.table?.caption?.trim()
              const csv = () => tableToCsv(item.table?.matrix)
              return h('div', { key: item.id, 'data-item-id': item.id, className: 'ap-item' },
                head(item.title || caption || '表格', [
                  item.roc
                    ? h('button', {
                      className: 'ap-tool',
                      title: '用这次模型的因变量做状态变量、第一个协变量做检验变量，画出 ROC 曲线',
                      onClick: () => onRoc?.(item.roc),
                    }, 'ROC 曲线…')
                    : null,
                  item.pairwise
                    ? h('button', {
                      className: 'ap-tool',
                      title: '对这几个变量做两两比较（Welch t，默认 Bonferroni）',
                      onClick: () => onPairwise?.(item.pairwise),
                    }, '两两比较')
                    : null,
                  h('button', {
                    className: 'ap-tool',
                    title: '改列宽、表头文字、加脚注（三线表排版用）',
                    onClick: () => onEditTable?.(item),
                  }, '编辑表格'),
                  h('button', {
                    className: 'ap-tool',
                    title: '只把这一张表导成 .docx 或 .xlsx（按文件名后缀决定格式）',
                    onClick: () => onExportItem?.(item),
                  }, '单独导出…'),
                  h('button', {
                    className: 'ap-tool',
                    title: '复制为 CSV',
                    onClick: () => copyText(csv()).then(() => copyHint('表格已复制为 CSV')).catch((error) => copyHint(tr('复制失败：{0}', error.message))),
                  }, '复制 CSV'),
                  h('button', {
                    className: 'ap-tool',
                    title: '下载为 CSV',
                    onClick: () => saveTextFile(`${(caption || item.title || 'table').replace(/[\\/:*?"<>|]/g, '_')}.csv`, csv()),
                  }, '下载 CSV'),
                  h('button', {
                    className: 'ap-tool',
                    title: '选一个路径保存这张表（不进浏览器下载目录）',
                    onClick: () => {
                      const name = (caption || item.title || 'table').replace(/[\\/:*?"<>|]/g, '_')
                      ITEM_CSV_PENDING = { name, text: csv() }
                      setBrowser({ mode: 'itemCsv', format: 'csv', title: name })
                    },
                  }, '导出 CSV…'),
                ]),
                shut ? null : (() => {
                  // The host renders PSPP's own tables; results computed here
                  // (multiple response frequencies and cross tabs) only have a
                  // matrix, so those are drawn from it. Once the user widens a
                  // column or rewrites a header we redraw from the matrix, since
                  // PSPP's own HTML cannot carry those edits.
                  const full = expandedTables[item.id] === true
                  const limit = full ? 0 : PREVIEW_ROWS
                  const edits = tableEdits[item.id]
                  const matrix = item.table.matrix
                  const matrixRows = Array.isArray(matrix) ? matrix.length : 0
                  const bodyRows = Math.max(0, matrixRows - 1)
                  const shownRows = limit > 0 ? Math.min(limit, bodyRows) : bodyRows
                  const drawn = edits
                    ? { html: matrixHtml(matrix, `ap-tbl-${tableStyle}`, edits, limit), total: bodyRows, shown: shownRows }
                    : item.table.html?.includes?.('<table')
                      ? (() => {
                        const { html, total, shown } = truncateTableHtml(item.table.html, limit > 0 ? limit : 0)
                        return { html: html.replace('<table', `<table class="ap-tbl-${tableStyle}"`), total, shown }
                      })()
                      : { html: matrixHtml(matrix, `ap-tbl-${tableStyle}`, null, limit), total: bodyRows, shown: shownRows }
                  const hidden = Math.max(0, drawn.total - drawn.shown)
                  // 显示全部 on a long table draws a scroll window instead of
                  // every row: the window is built from the same full HTML, so
                  // the header/colgroup/footer are still PSPP's own markup and
                  // the CSV/export paths (which read the matrix and the original
                  // html string, never this DOM) keep the whole table.
                  const virtualHtml = full && drawn.total > VIRT_TABLE_MIN
                    ? (edits
                      ? matrixHtml(matrix, `ap-tbl-${tableStyle}`, edits, 0)
                      : item.table.html?.includes?.('<table')
                        ? item.table.html.replace('<table', `<table class="ap-tbl-${tableStyle}"`)
                        : matrixHtml(matrix, `ap-tbl-${tableStyle}`, null, 0))
                    : null
                  // 表注（前提不满足、被跳过的变量、空结果原因）是插件自己写的
                  // 句子，和表的数字一样是结论的一部分：只在工具结果与导出里出现、
                  // 面板上看不到，等于没写。原文照排，不经过界面字典（表注里带
                  // 变量名与数字，逐词替换会拼出中英混排）。
                  const noteLines = (item.notes ?? [])
                    .map((note) => String(note ?? '').trim())
                    .filter((text) => text !== '')
                  return h('div', { className: 'ap-table-block' }, [
                    virtualHtml !== null
                      ? h(VirtualTable, { key: 'table', html: virtualHtml })
                      : h('div', {
                        key: 'table',
                        className: 'ap-table-wrap',
                        dangerouslySetInnerHTML: { __html: drawn.html },
                      }),
                    hidden > 0
                      ? h('div', { key: 'more', className: 'ap-table-more' }, [
                        h('span', { key: 'note' }, tr('这张表共 {0} 行，面板先画前 {1} 行（复制 CSV 与导出仍是全部）', drawn.total, drawn.shown)),
                        h('button', {
                          key: 'toggle',
                          className: 'ap-tool',
                          onClick: () => toggleTableRows(item.id),
                        }, '显示全部'),
                      ])
                      : full && drawn.total > PREVIEW_ROWS
                        ? h('div', { key: 'less', className: 'ap-table-more' }, [
                          h('span', { key: 'note' }, tr('正在显示全部 {0} 行', drawn.total)),
                          h('button', { key: 'toggle', className: 'ap-tool', onClick: () => toggleTableRows(item.id) }, '只显示前 200 行'),
                        ])
                        : null,
                    noteLines.length > 0
                      ? h('ul', { key: 'notes', className: 'ap-notes' },
                        noteLines.map((text, index) => h('li', { key: index, className: 'ap-note', translate: false }, tr('注：{0}', text))))
                      : null,
                  ])
                })())
            }
            if (item.kind === 'image') {
              const src = new URL(item.artifactUrl, document.baseURI).toString()
              return h('div', { key: item.id, 'data-item-id': item.id, className: 'ap-item' },
                head(item.title || item.alt || '图', [
                  h('button', {
                    className: 'ap-tool',
                    title: '改标题、配色与类别排序',
                    onClick: () => onEditChart({ runId: item.runId, title: item.title }),
                  }, '编辑图表'),
                  h('button', {
                    className: 'ap-tool',
                    title: '导出为 PNG（几何与颜色精确，标签请在图下写）',
                    onClick: () => onExportChart(item, 'png'),
                  }, '导出 PNG'),
                  h('button', {
                    className: 'ap-tool',
                    title: '换成另一种图看同一组数据（旧图仍在输出里）',
                    onClick: () => onRedrawChart?.(item),
                  }, '重绘…'),
                  h('button', {
                    className: 'ap-tool',
                    title: '导出为 SVG（矢量，文字可编辑）',
                    onClick: () => onExportChart(item, 'svg'),
                  }, '导出 SVG'),
                  h('select', {
                    className: 'ap-tool ap-export-scale',
                    title: 'PNG 导出倍率（1× 是图上看到的尺寸）',
                    value: String(pngScale),
                    onChange: (event) => onPickScale?.(Number(event.target.value)),
                  },
                  [1, 2, 3, 4].map((value) => h('option', { key: value, value: String(value) }, `${value}×`))),
                  h('button', {
                    className: 'ap-tool',
                    title: '只把这一张图导成 .docx 或 .xlsx（Word 里是内嵌图片，Excel 里图占独立工作表）',
                    onClick: () => onExportItem?.(item),
                  }, '单独导出…'),
                ]),
                shut ? null : h('button', {
                  className: 'ap-chart-button',
                  title: '点击放大；双击编辑标题、配色与排序',
                  onClick: () => setZoom({ src, title: item.title || item.alt || '图表' }),
                  onDoubleClick: () => onEditChart({ runId: item.runId, title: item.title }),
                }, h('img', { src, alt: item.alt || item.title })))
            }
            return h('div', { key: item.id, 'data-item-id': item.id, className: 'ap-item' },
              head(item.title || '输出'))
          })),
        zoom
          ? h(Modal, { title: zoom.title, wide: true, hideCancel: true, onCancel: () => setZoom(null), okText: '关闭', onOk: () => setZoom(null) },
            h('img', { src: zoom.src, alt: zoom.title, style: { maxWidth: '100%', background: '#fff' } }))
          : null,
        hint ? h('div', { className: 'ap-out-hint' }, hint) : null)
    }

    // The SPSS chart editor, reduced to what this renderer can honour: titles,
    // one accent colour and the order of the categories.
    const CHART_ACCENTS = [
      { key: '', label: '默认', color: '' },
      { key: '#3f6f9f', label: '蓝', color: '#3f6f9f' },
      { key: '#2f8f8a', label: '青', color: '#2f8f8a' },
      { key: '#4f9d5d', label: '绿', color: '#4f9d5d' },
      { key: '#c98a3c', label: '橙', color: '#c98a3c' },
      { key: '#7b5ea7', label: '紫', color: '#7b5ea7' },
      { key: '#b4453a', label: '红', color: '#b4453a' },
      { key: '#5b636e', label: '灰', color: '#5b636e' },
    ]

    /**
     * Draw the same data as another kind of chart.
     *
     * The variables stay the same and only the picture changes, so this is one
     * small dialog rather than a second visit to the chart dialog.
     */
    function RedrawChartDialog({ runId, title, from, onClose, onRun }) {
      const [type, setType] = useState(from && from !== 'grid' ? from : 'histogram')
      const TYPES = [
        ['bar', '条形图'],
        ['histogram', '直方图'],
        ['boxplot', '箱线图'],
        ['line', '折线图'],
        ['pie', '饼图'],
        ['area', '面积图'],
        ['scatterplot', '散点图'],
      ]
      return h(Modal, {
        title: '重绘为另一种图',
        onCancel: onClose,
        okText: '重绘',
        onOk: () => onRun({ runId, type }),
      },
      h('div', { className: 'ap-hint' }, tr('「{0}」用同一组变量重画；原图保留在输出里。', title ?? '')),
      h('label', { className: 'ap-field' },
        h('span', null, '新类型'),
        h('select', { value: type, onChange: (event) => setType(event.target.value) },
          TYPES.map(([value, label]) => h('option', { key: value, value }, tr(label))))),
      from === 'grid' ? h('div', { className: 'ap-error' }, '拼版不能重绘：先取消拼版，重画单图') : null)
    }

    /**
     * Bind several charts into one picture.
     *
     * Four small charts side by side answer "how do these compare" better than
     * four separate pictures scrolled apart, and the grid is one more output —
     * the individual charts stay in the tree.
     */
    function ChartGridDialog({ items, preselected, onClose, onRun }) {
      const charts = (items ?? []).filter((item) => item.kind === 'image')
      const [picked, setPicked] = useState(() => {
        const initial = (preselected ?? []).filter((id) => charts.some((item) => item.id === id))
        return initial.length > 0 ? initial : charts.map((item) => item.id)
      })
      const [layout, setLayout] = useState('2x2')
      const capacity = layout === '1x2' ? 2 : layout === '2x1' ? 2 : 4
      const order = picked.map((id) => charts.find((item) => item.id === id)).filter(Boolean)
      const toggle = (id) => {
        setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
      }
      return h(Modal, {
        title: '图表拼版',
        wide: true,
        onCancel: onClose,
        okText: '拼版',
        okDisabled: order.length === 0 || order.length > capacity,
        onOk: () => onRun({ items: order.map((item) => item.id), layout }),
      },
      h('div', { className: 'ap-row' },
        h('span', null, '版式'),
        h('select', { value: layout, onChange: (event) => setLayout(event.target.value), style: { flex: 1 } },
          h('option', { value: '2x2' }, '2 × 2（最多 4 张，左上→右下）'),
          h('option', { value: '1x2' }, '1 × 2（左右并排，最多 2 张）'),
          h('option', { value: '2x1' }, '2 × 1（上下叠放，最多 2 张）'))),
      h('div', { className: 'ap-hint' }, tr('勾选要拼的图，勾选顺序就是格子顺序（当前 {0} 张，这种版式放 {1} 张）。', order.length, capacity)),
      charts.length === 0
        ? h('div', { className: 'ap-hint' }, '输出里还没有图：先用「图形」菜单画一张。')
        : h('div', { className: 'ap-picker-list', style: { maxHeight: 220 } },
          charts.map((item) => h('label', { key: item.id },
            h('input', {
              type: 'checkbox',
              checked: picked.includes(item.id),
              onChange: () => toggle(item.id),
            }),
            tr('{0}（第 {1} 次运行）', item.title ?? item.id, item.runId ?? '?')))),
      order.length > capacity
        ? h('div', { className: 'ap-error' }, tr('勾了 {0} 张，这种版式只放 {1} 张：换 2 × 2 或取消几张。', order.length, capacity))
        : null)
    }

    function ChartEditDialog({ title, onClose, onApply }) {
      const [heading, setHeading] = useState(title ?? '')
      const [subtitle, setSubtitle] = useState('')
      const [xLabel, setXLabel] = useState('')
      const [yLabel, setYLabel] = useState('')
      const [accent, setAccent] = useState('')
      const [order, setOrder] = useState('none')
      const [error, setError] = useState(null)
      const field = (label, node) => h('label', { className: 'ap-field' }, h('span', null, label), node)
      const text = (value, setter, placeholder) => h('input', {
        type: 'text',
        value,
        placeholder,
        onChange: (event) => setter(event.target.value),
      })
      return h(Modal, {
        title: '图表编辑器',
        wide: true,
        onCancel: onClose,
        okText: '应用',
        onOk: () => {
          if (!heading.trim()) {
            setError('标题不能为空')
            return
          }
          onApply({
            title: heading.trim(),
            subtitle,
            xLabel,
            yLabel,
            accent: accent || '',
            sortCategories: order,
          })
        },
      },
      field('标题', text(heading, setHeading, '图表标题')),
      field('副标题', text(subtitle, setSubtitle, '留空则不显示（写统计量、样本量或筛选条件）')),
      field('X 轴标题', text(xLabel, setXLabel, '留空则保留原样')),
      field('Y 轴标题', text(yLabel, setYLabel, '留空则保留原样')),
      field('主色', h('select', { value: accent, onChange: (event) => setAccent(event.target.value) },
        CHART_ACCENTS.map((entry) => h('option', { key: entry.key || 'default', value: entry.key }, entry.label)))),
      field('类别顺序', h('select', { value: order, onChange: (event) => setOrder(event.target.value) },
        h('option', { value: 'none' }, '保持原顺序'),
        h('option', { value: 'asc' }, '按数值从小到大'),
        h('option', { value: 'desc' }, '按数值从大到小'))),
      h('div', { className: 'ap-hint' }, '数值会按同一份数据重新计算，改的只是外观与排序。'),
      error ? h('div', { className: 'ap-error' }, error) : null)
    }

    // Paths arrive from the host, which may be Windows ('C:\data\a.sav':
    // backslashes, drive letters). Splitting on '/' alone turned the parent of
    // such a path into the whole path and produced children like
    // 'C:\data\a.sav/b.sav', so both separators are handled here.
    const pathSep = (path) => (String(path ?? '').includes('\\') && !String(path ?? '').includes('/') ? '\\' : '/')
    const pathDirname = (path) => {
      const text = String(path ?? '')
      if (text === '') return ''
      const sep = pathSep(text)
      const trimmed = text.replace(/[\\/]+$/, '')
      // 'C:\' is its own parent; stripping the separator first would turn it
      // into the drive-relative 'C:'.
      if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}${sep}`
      const cut = trimmed.lastIndexOf(sep)
      if (cut === 0) return sep
      if (cut < 0) return ''
      // 'C:\data' → 'C:\' rather than 'C:'
      if (/^[A-Za-z]:$/.test(trimmed.slice(0, cut))) return `${trimmed.slice(0, cut)}${sep}`
      return trimmed.slice(0, cut)
    }
    const pathJoin = (dir, name) => {
      const base = String(dir ?? '')
      if (base === '') return String(name ?? '')
      const sep = pathSep(base)
      return `${base.replace(/[\\/]+$/, '')}${sep}${String(name ?? '').replace(/^[\\/]+/, '')}`
    }

    if (typeof globalThis !== 'undefined' && globalThis.__AP_TEST_HOOKS__) {
      // Windows paths only break in the real panel, so the split rule is
      // covered directly instead of through a rendered dialog.
      globalThis.__AP_TEST_HOOKS__.pathDirname = pathDirname
      globalThis.__AP_TEST_HOOKS__.pathJoin = pathJoin
      globalThis.__AP_TEST_HOOKS__.renameDocTab = renameDocTab
      globalThis.__AP_TEST_HOOKS__.stateOf = stateOf
      // Declared below this block, but function declarations hoist: the hooks
      // object is filled while the factory body runs, so the order is safe.
      globalThis.__AP_TEST_HOOKS__.sessionPreset = sessionPreset
    }

    function FileBrowser({ onPick, onClose, initialPath, extra = null, title = '选择文件' }) {
      const [path, setPath] = useState(initialPath || '')
      const [entries, setEntries] = useState([])
      const [error, setError] = useState(null)
      const [manual, setManual] = useState(initialPath || '')
      const load = useCallback(async (target) => {
        try {
          const value = await api(`api/dir?path=${encodeURIComponent(target ?? path ?? '')}`)
          setPath(value.path)
          setManual(value.pick ? `${value.path.replace(/\/$/, '')}/${value.pick}` : value.path)
          setEntries(value.entries)
          setError(null)
        } catch (problem) {
          const message = String(problem?.message ?? '')
          // A save target that does not exist yet is normal here; the entry
          // just is not a directory to list.
          if (/ENOTDIR|ENOENT/.test(message)) {
            const directory = pathDirname(target)
            setManual(String(target ?? ''))
            if (directory && directory !== target) {
              await load(directory)
              return
            }
          }
          setError(message)
        }
      }, [path])
      useEffect(() => { load(initialPath) }, [])
      const parent = pathDirname(path) || (pathSep(path) === '\\' ? '' : '/')
      return h(Modal, { title, onCancel: onClose, okText: '选择路径', onOk: () => { if (manual) onPick(manual) } },
        h('div', { className: 'ap-row' },
          h('input', { type: 'text', value: manual, onChange: (event) => setManual(event.target.value), style: { flex: 1 } }),
          h('button', { className: 'ap-tool', onClick: () => load(manual) }, '转到')),
        error ? h('div', { className: 'ap-hint', style: { color: '#a33' } }, error) : null,
        extra,
        h('div', { className: 'ap-dir' },
          h('button', { onClick: () => load(parent) }, '.. 上级目录'),
          entries.map((entry) => h('button', {
            key: entry.name,
            onDoubleClick: () => { if (entry.dir) load(pathJoin(path, entry.name)); else onPick(pathJoin(path, entry.name)) },
            onClick: () => {
              if (entry.dir) return
              setManual(pathJoin(path, entry.name))
            },
            title: entry.dir ? '双击进入' : '双击打开',
          }, `${entry.dir ? '📁' : '📄'} ${entry.name}`)))
      )
    }

    // A click on `.sav`/`.por`/`.sys`/`.dta` in the Files panel is answered by
    // better-sidebar with a viewer tab of its own. That tab is not a second
    // window we want: it hands the path to the one workbench panel and closes
    // itself, so every dataset lives as a document inside the panel.
    const FILE_HANDOFFS = []
    const FILE_HANDOFF_EVENT = 'analytics-pspp:file-handoff'
    const requestFileHandoff = (sessionId, path) => {
      if (!sessionId || !path) return
      FILE_HANDOFFS.push({ sessionId, path })
      if (FILE_HANDOFFS.length > 20) FILE_HANDOFFS.splice(0, FILE_HANDOFFS.length - 20)
      try {
        window.dispatchEvent(new CustomEvent(FILE_HANDOFF_EVENT, { detail: { sessionId, path } }))
      } catch { /* the panel also drains on its poll */ }
    }
    const takeFileHandoffs = (sessionId) => {
      if (!sessionId) return []
      const mine = []
      const rest = []
      for (const entry of FILE_HANDOFFS) (entry.sessionId === sessionId ? mine : rest).push(entry)
      FILE_HANDOFFS.length = 0
      FILE_HANDOFFS.push(...rest)
      return mine
    }

    // The file picker is a separate dialog state, so the path it returns is
    // handed back through this slot instead of through the dialog tree.
    let LABEL_FILE_PICKED = null
let ITEM_CSV_PENDING = null

    // Tabs created by this page (a dropped file, a second dataset) must open
    // their file once. Tabs restored by a page reload must not: the workspace
    // is either restored by the host or left empty.
    const PENDING_OPEN = new Set()

    function basenameOf(path) {
      const text = typeof path === 'string' ? path : ''
      const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      const base = at >= 0 ? text.slice(at + 1) : text
      // Files the panel stored for a drop carry a unique numeric prefix; it is
      // storage bookkeeping, not part of the name the user knows.
      return /[\\/]uploads[\\/]/.test(text) ? base.replace(/^\d{10,}-/, '') : base
    }

    // Never print the workspace copy's location as if the user had opened it.
    function displayPath(path) {
      const text = String(path ?? '')
      return /[\\/]uploads[\\/]/.test(text) ? basenameOf(text) : text
    }

    // The agent preset the session runs under, as the host projects it. A
    // session without a preset (or an old host with no `ctx.sessions`) answers
    // null, and null means "unknown": no banner and nothing disabled, so the
    // panel behaves exactly as it did before presets existed.
    function sessionPreset(ctx, sessionId) {
      try {
        // Cordis guards `ctx.<service>` behind the plugin's inject list and
        // throws `cannot get property "sessions" without inject`; `ctx.get` is
        // the unguarded reader (the same reason the handoff code below uses it
        // for `sidebarRight`). Falling back to `ctx.sessions` keeps the unit
        // tests and any host that hands the service to a plugin that did inject.
        const service = (typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined) ?? ctx?.sessions
        if (!service) return null
        // The client service has no `projectionValues` of its own: the DSH
        // preset picker reads the list snapshot's `byId[id].projectionValues`
        // (`dsh-client-ui-agent-preset` does exactly this), and the manager
        // behind the service answers `projectionValues(id)`.
        const row = service.list?.getSnapshot?.()?.byId?.[sessionId]
        const value = row?.projectionValues
          ?? service.manager?.projectionValues?.(sessionId)
          ?? (typeof service.projectionValues === 'function' ? service.projectionValues(sessionId) : undefined)
        const preset = value?.agentPreset
        if (typeof preset !== 'string' || preset === '') return null
        return preset
      } catch {
        return null
      }
    }

    // A dropped file only exists as a copy inside the workspace, so its real
    // location is unknown: name it, say so, and never show the copy's path as
    // if it were the user's own file. An opened file shows its full path.
    function describeSource(dataset) {
      if (!dataset) return ''
      if (dataset.temporary === true) return tr('{0}（拖入副本 · 路径未知）', dataset.name ?? basenameOf(dataset.sourcePath))
      return dataset.sourcePath ? String(dataset.sourcePath) : tr('未命名数据集')
    }

    /* ------------------------------------------------------------------ app */

    function App({ ctx, scope, tab, visible = true }) {
      ensureStyle()
      const baseSessionId = scope?.sessionId
      // The preset this session was created under. The projection snapshot is
      // cached by the host, so this is a cheap read per render, not a poll; a
      // preset cannot change inside a live session. null = unknown = say nothing.
      const presetId = sessionPreset(ctx, baseSessionId)
      const [presetBannerHidden, setPresetBannerHidden] = useState(() => {
        try { return window.localStorage?.getItem('ap.hidePresetBanner') === '1' } catch { return false }
      })
      // SPSS opens a new Data Editor per file. Each sidebar tab owns one
      // workspace: the primary tab uses the session id, extra tabs carry their
      // own `<session>~<n>` in `tab.meta.docId`, so closing a tab keeps the
      // others' datasets, output and undo history intact.
      const initialDocId = tab?.meta?.docId ?? baseSessionId
      // The right sidebar keeps one tab per tool type, so a second file cannot
      // become a second tab there. That panel therefore holds its own document
      // list (SPSS opens a Data Editor per file); the bottom workbench still
      // uses real tabs, and its panels keep this list at a single entry.
      const [docId, setDocId] = useState(initialDocId)
      const [docs, setDocs] = useState([{ id: initialDocId, title: '' }])
      // The left column's global panel is root-scoped: it inherits no Session,
      // so it used to start on the empty 'default' document while the
      // conversation beside it already held data, and the two looked like
      // different programs. Adopt the dataset that is already open instead —
      // the most recently used one — and put the rest in the document strip.
      const [adopted, setAdopted] = useState(Boolean(initialDocId))
      useEffect(() => {
        if (adopted) return undefined
        let alive = true
        api('api/workspaces')
          .then((payload) => {
            if (!alive) return
            const rows = Array.isArray(payload?.result?.workspaces) ? payload.result.workspaces : []
            if (rows.length === 0) return
            // Where a document came from decides whether a stale one is
            // expected: 'default' is the panel's own scratch document, which
            // outlives every session, so the tab has to say so.
            setDocs(rows.map((row) => ({
              id: row.docId,
              title: row.name || '',
              dirty: row.dirty === true,
              sessionId: row.sessionId ?? '',
            })))
            setDocId(rows[0].docId)
          })
          .catch(() => { /* nothing open yet: stay on the empty document */ })
          .finally(() => { if (alive) setAdopted(true) })
        return () => { alive = false }
      }, [adopted])
      const sessionId = docId
      const tabPath = typeof tab?.path === 'string' ? tab.path : (typeof tab?.meta?.openPath === 'string' ? tab.meta.openPath : '')
      const [st, setSt] = useState(null)
      // Language travels with the state (the host reads it from settings.json),
      // so an open panel follows a switch in the panel's own settings page.
      const locale = st?.locale === 'en' ? 'en' : 'zh'
      useEffect(() => {
        if (locale === LANG) return undefined
        let alive = true
        const apply = (strings) => {
          if (!alive) return
          setDictionary(strings)
          LANG = locale
          // Pictures the new text: the dictionary is module state, so a re-render
          // has to be asked for explicitly.
          setSt((prev) => (prev ? { ...prev } : prev))
        }
        if (locale === 'zh') {
          apply(null)
          return () => { alive = false }
        }
        api(`api/locale?lang=${locale}`)
          .then((payload) => apply(payload?.strings ?? null))
          .catch(() => { alive = false })
        return () => { alive = false }
      }, [locale])

      // Saving the language in the settings page should not wait for the next
      // heartbeat: that page lives in its own slot with no props from here, so it
      // announces the change on the window and the panel adopts it at once.
      useEffect(() => {
        const onLocale = (event) => {
          const next = event?.detail === 'en' ? 'en' : 'zh'
          setSt((prev) => (prev && prev.locale !== next ? { ...prev, locale: next } : prev))
        }
        window.addEventListener('ap:locale', onLocale)
        return () => window.removeEventListener('ap:locale', onLocale)
      }, [])
      // The panel is asked for the session's own working directory, so 打开/保存
      // start where the conversation lives instead of the dsh server's cwd.
      const readSessionCwd = useCallback(() => {
        try {
          const scopeCwd = ctx?.sessions?.list?.getSnapshot?.()?.byId?.[baseSessionId]?.cwd
          return typeof scopeCwd === 'string' && scopeCwd ? scopeCwd : undefined
        } catch {
          return undefined
        }
      }, [ctx, baseSessionId])
      const sessionCwd = readSessionCwd()
      if (sessionCwd) ACTIVE_CWD = sessionCwd
      const stateUrl = useCallback((id) => `api/state?sessionId=${encodeURIComponent(id)}`
        + (sessionCwd ? `&cwd=${encodeURIComponent(sessionCwd)}` : ''), [sessionCwd])
      // The poll asks for this instead: the full state carries every output
      // matrix (a 3000-case frequency table is ~300 KB), which at one poll a
      // second was pure traffic. The signature is a few hundred bytes and says
      // whether anything moved at all.
      const signalUrl = useCallback((id) => `api/heartbeat?sessionId=${encodeURIComponent(id)}`
        + (sessionCwd ? `&cwd=${encodeURIComponent(sessionCwd)}` : ''), [sessionCwd])
      // SPSS's editor can show either the stored value or its label.
      const [showLabels, setShowLabels] = useState(() => {
        try { return localStorage.getItem('ap.showLabels') !== '0' } catch { return true }
      })
      // SPSS's View menu hides the gridlines and the toolbar; both are only
      // display preferences, so the browser keeps them.
      const [showGridLines, setShowGridLines] = useState(() => {
        try { return localStorage.getItem('ap.gridLines') !== '0' } catch { return true }
      })
      const [showToolbar, setShowToolbar] = useState(() => {
        try { return localStorage.getItem('ap.toolbar') !== '0' } catch { return true }
      })
      // { name, seq }: the seq makes every jump look new even to the same variable.
      const [variableJump, setVariableJump] = useState(null)
      // Output table preset: 'default' (the on-screen look), 'three' (the
      // journal three-line table), 'plain' (no rules), 'grid' (full borders).
      const [outputQuery, setOutputQuery] = useState('')
      // Per-table layout overrides (column widths, header wording, footnote),
      // keyed by output item id. They survive collapse and are used by the HTML
      // export; the Word/Excel export still writes PSPP's own numbers.
      const [tableEdits, setTableEdits] = useState({})
      // The 设置 page owns the persistent preset (`three-line` | `grid`) and it
      // arrives with every state; the 视图 menu is a per-browser override on top
      // of it, so a user who wants plain tables for one afternoon does not have
      // to change the shared setting for everyone.
      const settingStyle = st?.tableStyle === 'grid' ? 'grid' : st?.tableStyle === 'three-line' ? 'three' : null
      const [styleOverride, setStyleOverride] = useState(() => {
        try {
          const stored = localStorage.getItem('ap.tableStyle')
          return ['three', 'plain', 'grid'].includes(stored) ? stored : null
        } catch { return null }
      })
      const tableStyle = styleOverride ?? settingStyle ?? 'default'
      // Frozen header row / first data column. SPSS freezes both by default;
      // the switch is here because a wide dataset sometimes wants the space.
      const [freezeRows, setFreezeRows] = useState(() => {
        try { return localStorage.getItem('ap.freezeRows') !== '0' } catch { return true }
      })
      const [freezeCols, setFreezeCols] = useState(() => {
        try { return localStorage.getItem('ap.freezeCols') !== '0' } catch { return true }
      })
      const toggleFreeze = (which) => {
        const setter = which === 'rows' ? setFreezeRows : setFreezeCols
        const key = which === 'rows' ? 'ap.freezeRows' : 'ap.freezeCols'
        setter((current) => {
          const next = !current
          try { localStorage.setItem(key, next ? '1' : '0') } catch { /* quota */ }
          return next
        })
      }
      const chooseTableStyle = (value) => {
        setStyleOverride(value)
        try {
          if (value) localStorage.setItem('ap.tableStyle', value)
          else localStorage.removeItem('ap.tableStyle')
        } catch { /* quota */ }
      }
      const [dragging, setDragging] = useState(false)
      const [convertPath, setConvertPath] = useState('')
      const [view, setView] = useState('data')
      const [menu, setMenu] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [toast, setToast] = useState(null)
      const rootRef = useRef(null)
      const menuBarRef = useRef(null)
      // Which multiple response set the panel is reading, and how its
      // frequency table is laid out.
      const [activeMr, setActiveMr] = useState(null)
      const [mrPercentBase, setMrPercentBase] = useState('responses')
      const [mrOpen, setMrOpen] = useState(false)
      // Report card: which output items the document should contain. The
      // export replays their syntax, so the selection is by item id.
      const [reportPick, setReportPick] = useState(() => new Set())
      // PNG export magnification. 1x is the chart as drawn; 3x is for print.
      const [pngScale, setPngScale] = useState(1)
      // Every successful run is remembered with the syntax that produced it, so
      // a run in the output tree can be repeated or pasted back into the editor.
      // Kept in localStorage because the browser refresh the panel is reloaded
      // with must not lose the last hour of work; the syntax itself lives in
      // `syntaxByDoc`, this is only the run -> text map.
      const [runHistory, setRunHistory] = useState(() => {
        try {
          const parsed = JSON.parse(localStorage.getItem('ap.runHistory') ?? '[]')
          return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.text === 'string') : []
        } catch { return [] }
      })
      const rememberRun = useCallback((runId, text, title, persist) => {
        if (runId === null || runId === undefined) return
        // `persist` travels with the entry: replaying a data step as an analysis
        // (or the other way round) silently skips the SAVE OUTFILE and the run
        // looks like it did nothing.
        const entry = { runId, text: String(text ?? ''), title: title ?? '', persist: persist === true, at: Date.now() }
        setRunHistory((current) => {
          const next = [entry, ...current.filter((item) => String(item.runId) !== String(runId))].slice(0, 40)
          try { localStorage.setItem('ap.runHistory', JSON.stringify(next)) } catch { /* quota */ }
          return next
        })
      }, [])
      const syntaxForRun = useCallback((runId) => {
        const hit = runHistory.find((entry) => String(entry.runId) === String(runId))
        return hit ? hit.text : ''
      }, [runHistory])
      const toggleReportPick = useCallback((id) => {
        setReportPick((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])
      // SPSS's menu bar works without the mouse: Alt+F/E/D/T/A/G/U/H drops a
      // menu, Up/Down walks its items, Enter runs one, Esc closes. The panel had
      // no keyboard path into the menus at all, which also made it untestable in
      // a browser that cannot click a 12 px target reliably.
      const MENU_MNEMONICS = { f: '文件', e: '编辑', v: '视图', d: '数据', t: '转换', a: '分析', g: '图形', u: '实用程序', s: '设置', h: '帮助' }
      // Read the labels off the DOM: the menu list itself is built further down
      // this component, and a hook may not depend on something declared later.
      const menuButtonLabels = () => [...(menuBarRef.current?.querySelectorAll('.ap-menu-button') ?? [])].map((node) => node.textContent)
      useEffect(() => {
        const onKey = (event) => {
          // Alt+1…4 switches the view the way SPSS does; the menu mnemonics
          // below share the Alt modifier, so digits are handled first.
          if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            const view = { 1: 'data', 2: 'variables', 3: 'syntax', 4: 'output' }[String(event.key)]
            if (view) {
              event.preventDefault()
              setView(view)
              return
            }
          }
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          const wanted = MENU_MNEMONICS[String(event.key).toLowerCase()]
          if (!wanted || !menuButtonLabels().includes(wanted)) return
          event.preventDefault()
          setMenu(wanted)
          const button = [...(menuBarRef.current?.querySelectorAll('.ap-menu-button') ?? [])].find((node) => node.textContent === wanted)
          button?.focus?.()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [])
      useEffect(() => {
        if (!menu) return
        const bar = menuBarRef.current
        const items = () => [...(bar?.querySelectorAll('.ap-menu-pop button') ?? [])]
        // Focus the first entry so Up/Down/Enter work straight away.
        items()[0]?.focus?.()
        const focusMenuButton = () => {
          const button = [...(bar?.querySelectorAll('.ap-menu-button') ?? [])].find((node) => node.textContent === menu)
          button?.focus?.()
        }
        const step = (delta) => {
          const list = items()
          if (!list.length) return
          const at = list.indexOf(document.activeElement)
          const next = at < 0 ? 0 : (at + delta + list.length) % list.length
          list[next]?.focus?.()
        }
        const walk = (delta) => {
          const labels = menuButtonLabels()
          const at = labels.indexOf(menu)
          if (at < 0) return
          const next = labels[(at + delta + labels.length) % labels.length]
          const button = [...(bar?.querySelectorAll('.ap-menu-button') ?? [])].find((node) => node.textContent === next)
          button?.click?.()
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setMenu(null)
            focusMenuButton()
            return
          }
          if (event.key === 'ArrowDown') { event.preventDefault(); step(1); return }
          if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); return }
          if (event.key === 'ArrowRight') { event.preventDefault(); walk(1); return }
          if (event.key === 'ArrowLeft') { event.preventDefault(); walk(-1) }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [menu])
      const [busy, setBusy] = useState(false)
      // Set when the host refused a write: the dialog at the bottom of this
      // component turns it into a question instead of a lost edit.
      const [conflict, setConflict] = useState(null)
      // Column widths live here so the data grid and the variable view's
      // "列" column edit the same numbers (localStorage remembers them).
      const [rowHeight, setRowHeight] = useState(() => {
        const stored = Number(localStorage.getItem('ap.rowHeight'))
        return Number.isFinite(stored) && stored >= 16 && stored <= 48 ? stored : 22
      })
      const applyRowHeight = useCallback((value) => {
        setRowHeight(value)
        try { localStorage.setItem('ap.rowHeight', String(value)) } catch { /* quota */ }
      }, [])
      const [colWidths, setColWidths] = useState(() => {
        try { return JSON.parse(localStorage.getItem('ap.colWidths') ?? '{}') ?? {} } catch { return {} }
      })
      const setColWidth = useCallback((name, width) => {
        setColWidths((current) => {
          const next = { ...current }
          if (width === null) delete next[name]
          else next[name] = width
          try { localStorage.setItem('ap.colWidths', JSON.stringify(next)) } catch { /* quota */ }
          return next
        })
      }, [])
      const [rows, setRows] = useState([])
      const [total, setTotal] = useState(0)
      const [selected, setSelected] = useState(null)
      // Each document keeps its own syntax draft: a script belongs to the
      // dataset it was written for, and switching tabs must not carry it over
      // (that once made the .sps text follow every other tab).
      const [syntaxByDoc, setSyntaxByDoc] = useState(() => {
        try { return JSON.parse(localStorage.getItem('ap.syntaxByDoc') ?? '{}') ?? {} } catch { return {} }
      })
      const syntax = syntaxByDoc[docId] ?? ''
      const setSyntax = useCallback((text) => {
        setSyntaxByDoc((current) => {
          const value = typeof text === 'function' ? text(current[docId] ?? '') : text
          if ((current[docId] ?? '') === value) return current
          const next = { ...current, [docId]: value }
          try { localStorage.setItem('ap.syntaxByDoc', JSON.stringify(next)) } catch { /* quota */ }
          return next
        })
      }, [docId])
      const [browser, setBrowser] = useState(null)
      const [labelsDialog, setLabelsDialog] = useState(null)

      const toastTimer = useRef(0)
      const notify = (message) => {
        setToast(message)
        // Keep the handle: two notices in a row used to leave the first timer
        // running, and it cleared the second toast about a second after it
        // appeared (which is exactly when a user is still reading it).
        if (toastTimer.current) window.clearTimeout(toastTimer.current)
        toastTimer.current = window.setTimeout(() => { toastTimer.current = 0; setToast(null) }, 5000)
      }

      // The bar shows a tip the moment the pointer lands on an icon. The native
      // title attribute cannot be timed (the delay is the OS's), so the bar drives
      // its own tip and takes `title` away while the pointer is inside it —
      // otherwise two tooltips appear, one over the other.
      const [toolTip, setToolTip] = useState(null)
      const tipState = useRef({ timer: 0, visible: false, anchor: null, stripped: new Map() })
      // Every button visited loses its `title` while the bar owns the tip, so
      // every one of them has to get it back — restoring only the last button
      // left a trail of icons whose native tooltip was gone for good.
      const restoreTitles = () => {
        for (const [button, title] of tipState.current.stripped) {
          if (button?.isConnected && !button.hasAttribute('title')) button.setAttribute('title', title)
        }
        tipState.current.stripped.clear()
      }
      const hideToolTip = () => {
        window.clearTimeout(tipState.current.timer)
        tipState.current.timer = 0
        restoreTitles()
        if (tipState.current.visible) {
          tipState.current.visible = false
          setToolTip(null)
        }
      }
      const placeToolTip = (button, text) => {
        const rect = button.getBoundingClientRect()
        tipState.current.visible = true
        setToolTip({ text, x: rect.left + rect.width / 2, y: rect.bottom + 6 })
      }
      const onToolbarOver = (event) => {
        const button = event.target?.closest?.('.ap-tool')
        if (!button || button === tipState.current.anchor) return
        // aria-label first: it is the short name SPSS shows. The title on some
  // buttons is a long sentence, and a tip that changes length per button reads
  // as a different kind of hint.
  const text = button.getAttribute('aria-label') || button.getAttribute('title') || ''
        if (!text) return
        if (button.hasAttribute('title')) {
          tipState.current.stripped.set(button, button.getAttribute('title'))
          button.removeAttribute('title')
        }
        tipState.current.anchor = button
        window.clearTimeout(tipState.current.timer)
        // Straight away: a tooltip that waits is a tooltip the user reads after
        // guessing the icon. Switching between neighbours is the same code path.
        placeToolTip(button, text)
      }
      const onToolbarOut = (event) => {
        const button = event.target?.closest?.('.ap-tool')
        if (!button) return
        // Moving to another button in the bar keeps the tip warm; only leaving
        // the bar resets the delay.
        if (event.relatedTarget?.closest?.('.ap-tool')) { tipState.current.anchor = null; return }
        hideToolTip()
        tipState.current.anchor = null
      }
      const onToolbarLeave = () => {
        hideToolTip()
        tipState.current.anchor = null
      }
      useEffect(() => () => restoreTitles(), [])

      // Templates append instead of replacing: a user who is halfway through a
      // script wants the new program after it, and a blank one is unaffected.
      const insertSyntax = useCallback((text, { replace = false } = {}) => {
        const block = String(text ?? '')
        if (!block.trim()) return
        setSyntax((current) => (replace || !String(current ?? '').trim()
          ? block
          : `${String(current).replace(/\s+$/, '')}\n\n${block}`))
        setView('syntax')
        setDialog(null)
        notify(tr('已插入语法（{0} 行）', block.split('\n').length))
      }, [setSyntax])

      // Three outcomes and no fourth: a newer release, this is the newest, or the
      // check itself failed. Silence after a click reads as "nothing happened".
      const checkForUpdate = async () => {
        notify(tr('正在检查更新…'))
        try {
          const answer = await api('api/update')
          const current = answer.current ?? state?.version ?? '?'
          if (answer.error) notify(tr('检查更新失败：{0}', answer.error))
          else if (answer.newer) notify(tr('有新版本 {0}（当前 {1}）：{2}', answer.latest, current, answer.url))
          else notify(tr('已是最新版本（{0}）', current))
        } catch (error) {
          notify(tr('检查更新失败：{0}', error.message))
        }
      }

      // Another window may be editing the same workspace: each panel keeps its
      // own rows and undo stack, so the one that did not write would otherwise
      // keep showing (and keep editing) data the host no longer has.
      // The settings dialog's footer owns 保存: a form tall enough to need
      // scrolling would otherwise hide its own buttons below the fold.
      const settingsSave = useRef(null)
      const lastWrite = useRef({ revision: null, writer: null })
      useEffect(() => {
        if (!st) return
        const revision = Number(st.revision ?? 0)
        const writer = typeof st.lastWriter === 'string' ? st.lastWriter : null
        const seen = lastWrite.current
        // The first state is the baseline: opening the panel is not a change
        // somebody else just made.
        if (seen.revision === null) {
          lastWrite.current = { revision, writer }
          return
        }
        const notice = foreignWriteNotice(seen, st, WRITER)
        if (notice) {
          notify(notice)
          // The state carries shape and metadata; the cells on screen came from
          // api/rows, so the values have to be re-read or the notice would sit
          // on top of a grid that still shows the numbers the other window just
          // replaced.
          loadRows(0, Math.max(500, rows.length))
            .then((page) => { setRows(page.rows); setTotal(page.total) })
            .catch(() => { /* the next interaction will read them anyway */ })
        }
        lastWrite.current = { revision, writer }
      }, [st])

      // A 409 from the host means this window tried to write on top of data it
      // had not read. The change did not happen. Rather than deciding for the
      // user — silently dropping their edit, or silently overwriting the other
      // window — the panel asks: 覆盖 re-sends the request with force, 重载
      // throws this edit away and reads what won, 取消 leaves the screen alone.
      const writeFailed = (error) => {
        if (error?.conflict) {
          setConflict(error)
          return
        }
        notify(error.message)
      }

      const reloadRows = async () => {
        const page = await loadRows(0, Math.max(500, rows.length))
        setRows(page.rows)
        setTotal(page.total)
      }

      const resolveConflict = async (choice) => {
        const error = conflict
        setConflict(null)
        if (!error) return
        if (choice === 'cancel') return
        setBusy(true)
        try {
          if (choice === 'override') {
            const value = await error.retry()
            setSt(stateOf(value))
            notify('这次修改已经强制写入')
          } else {
            if (error.state) setSt(error.state)
            notify('已丢弃这次修改，载入了最新的数据')
          }
          await reloadRows()
        } catch (next) {
          if (next?.conflict) { setConflict(next); return }
          notify(next.message)
        } finally {
          setBusy(false)
        }
      }

      const refresh = useCallback(async () => {
        const value = await api(stateUrl(sessionId))
        const state = stateOf(value)
        setSt(state)
        return state
      }, [sessionId, stateUrl])

      const loadRows = useCallback(async (offset, limit) => {
        const value = await api('api/rows', { sessionId, offset, limit })
        return value.page
      }, [sessionId])

      // Right-click target of the data sheet. The menu is plain DOM because it
      // has to land at the pointer, outside the table's own layout.
      const [cellMenu, setCellMenu] = useState(null)
      useEffect(() => {
        if (!cellMenu) return undefined
        const close = (event) => {
          if (!event.target.closest?.('.ap-var-menu')) setCellMenu(null)
        }
        window.addEventListener('mousedown', close, true)
        return () => window.removeEventListener('mousedown', close, true)
      }, [cellMenu])
      // Everything the right-click menu can do goes through the same routes the
      // menu bar uses, so undo labels and dirty flags stay consistent.
      const cellMenuAction = async (action) => {
        const target = cellMenu
        setCellMenu(null)
        if (!target) return
        const { row, variable } = target
        const run3 = async (label, work) => {
          setBusy(true)
          try {
            await work()
            if (label) notify(label)
          } catch (error) {
            writeFailed(error)
          } finally {
            setBusy(false)
          }
        }
        if (action === 'insertCase') return run3(tr('已在第 {0} 行插入个案', row + 1), async () => {
          const value = await api('api/case', { sessionId, action: 'insert', row })
          setSt(stateOf(value))
          const page = await loadRows(0, 500)
          setRows(page.rows); setTotal(page.total)
        })
        if (action === 'deleteCase') return run3(tr('已删除第 {0} 行', row + 1), async () => {
          const value = await api('api/case', { sessionId, action: 'delete', row })
          setSt(stateOf(value))
          const page = await loadRows(0, 500)
          setRows(page.rows); setTotal(page.total)
        })
        if (action === 'copy') {
          return run3('已复制到剪贴板', async () => {
            await navigator.clipboard?.writeText?.(String(target.text ?? ''))
          })
        }
        if (action === 'clear') {
          if (!variable) { notify('这个格子还没有变量，无法清空'); return }
          return run3('已清空', async () => {
            const value = await api('api/cell', { sessionId, row, variable, value: '' })
            setSt(stateOf(value))
            const page = await loadRows(0, 500)
            setRows(page.rows); setTotal(page.total)
          })
        }
        if (action === 'missing') {
          if (!variable || target.numeric !== true) { notify('只有数值变量可以设为系统缺失值'); return }
          return run3('已设为系统缺失值', async () => {
            const value = await api('api/cell', { sessionId, row, variable, value: 'SYSMIS' })
            setSt(stateOf(value))
            const page = await loadRows(0, 500)
            setRows(page.rows); setTotal(page.total)
          })
        }
        if (action === 'sortAsc' || action === 'sortDesc') {
          if (!variable) { notify('这个格子还没有变量，无法排序'); return }
          return run3(action === 'sortAsc' ? tr('已按 {0} 升序排序', variable) : tr('已按 {0} 降序排序', variable), async () => {
            const value = await api('api/sort', { sessionId, keys: [{ name: variable, order: action === 'sortAsc' ? 'a' : 'd' }] })
            setSt(stateOf(value))
            const page = await loadRows(0, 500)
            setRows(page.rows); setTotal(page.total)
          })
        }
        if (action === 'jump') return setDialog({ kind: 'goto' })
      }

      // The agent drives the same workspace from the conversation, so the
      // panel has to notice state it did not produce. Poll while visible and
      // idle; the payload is small and only changes on real work.
      const stateRef = useRef(null)
      const busyRef = useRef(false)
      useEffect(() => { stateRef.current = st }, [st])
      useEffect(() => { busyRef.current = busy }, [busy])
      const viewRef = useRef(view)
      useEffect(() => { viewRef.current = view }, [view])
      // Filled in below, once openPath exists: the poll effect must not depend
      // on a callback declared later in this component.
      const drainRef = useRef(() => {})
      useEffect(() => {
        if (!visible || !sessionId) return undefined
        let stopped = false
        const tick = async () => {
          if (stopped || document.visibilityState === 'hidden' || busyRef.current) return
          try {
            // Stage one: a few hundred bytes saying whether anything moved.
            // The full state carries every output matrix, so pulling it every
            // tick made an idle panel with a big table ship hundreds of KB a
            // second for nothing.
            const probe = await api(signalUrl(sessionId))
            if (stopped) return
            const next = probe.signal ?? null
            const current = stateRef.current
            const previous = current?.signal ?? null
            if (previous && next && JSON.stringify(previous) === JSON.stringify(next)) return
            drainRef.current()
            // Stage two: something did move, so read the whole thing.
            const value = await api(stateUrl(sessionId))
            if (stopped) return
            const before = current
            const fresh = stateOf(value)
            setSt(fresh)
            if ((fresh.items ?? []).length > (before?.items ?? []).length && viewRef.current !== 'output') {
              notify('PSPP 有新输出（切换到「输出」查看）')
            }
            // The undo stack has a memory budget; when a step is dropped the next
            // 撤销 goes further back than the user expects, so say it once.
            const droppedBefore = Number(before?.history?.dropped ?? 0)
            const droppedNow = Number(fresh.history?.dropped ?? 0)
            if (droppedNow > droppedBefore) {
              notify(tr('数据集较大，撤销记录超出内存预算：最早的 {0} 步已丢弃', droppedNow - droppedBefore))
            }
            // The data sheet only has to reload when the data itself moved:
            // a new variable, a different case count or another file.
            const dataMoved = (before?.dataset?.caseCount ?? -1) !== (fresh.dataset?.caseCount ?? -1)
              || (before?.dataset?.sourcePath ?? null) !== (fresh.dataset?.sourcePath ?? null)
              || (before?.dataset?.variables ?? []).length !== (fresh.dataset?.variables ?? []).length
              || (next?.dataset?.vars ?? null) !== (previous?.dataset?.vars ?? null)
            if (dataMoved) {
              const page = await loadRows(0, 500)
              if (stopped) return
              setRows(page.rows)
              setTotal(page.total)
            }
          } catch {
            /* transient: the next tick retries */
          }
        }
        const timer = window.setInterval(tick, 3000)
        return () => { stopped = true; window.clearInterval(timer) }
      }, [visible, sessionId, loadRows, stateUrl, signalUrl, notify])


      useEffect(() => {
        refresh().catch((error) => notify(error.message))
      }, [refresh])

      // Tell the host which tab is on screen so pspp_* tools follow the panel
      // instead of always hitting the primary dataset.
      useEffect(() => {
        if (!visible) return
        api('api/active', { sessionId: baseSessionId, docId: sessionId }).catch(() => { /* older host */ })
      }, [visible, baseSessionId, sessionId])

      useEffect(() => {
        if (!st?.dataset) { setRows([]); setTotal(0); return }
        setTotal(st.dataset.caseCount)
        loadRows(0, 500).then((page) => { setRows(page.rows); setTotal(page.total) }).catch((error) => notify(error.message))
      }, [st?.dataset?.sourcePath, st?.dataset?.caseCount, loadRows])

      // Two fast scrolls used to append the same page twice.
      const loadMoreBusy = useRef(false)
      const loadMore = useCallback(async () => {
        if (loadMoreBusy.current || rows.length >= total) return
        loadMoreBusy.current = true
        try {
          const page = await loadRows(rows.length, 500)
          setRows((current) => (current.length >= page.total ? current : [...current, ...page.rows]))
        } finally {
          loadMoreBusy.current = false
        }
      }, [rows.length, total, loadRows])

      // Jumping to a record loads that page and selects it, so the grid can
      // scroll straight to it (virtual windows are otherwise 500 rows long).
      const gotoCase = useCallback(async (number, column = 0) => {
        const target = Math.max(1, Math.min(total || 1, Math.floor(Number(number) || 1)))
        const offset = target - 1
        const from = Math.max(0, offset - 200)
        const page = await loadRows(from, 500)
        setRows(page.rows)
        const localOffset = Math.max(0, Math.min(page.rows.length - 1, offset - from))
        setSelected({ row: localOffset, column })
        setView('data')
        window.setTimeout(() => {
          const cell = document.querySelector(`.ap-grid td[data-row="${localOffset}"]`)
          if (cell) cell.scrollIntoView({ block: 'center' })
        }, 60)
      }, [total, loadRows])

      const run = useCallback(async (text, persist, title, pairwise, regression, roc, exact, exactChi, contrasts) => {
        setBusy(true)
        try {
          const value = await api('api/run', { sessionId, syntax: text, persist, pairwise, regression, roc, exact: exact === true, exactChi: exactChi === true, contrasts: contrasts ?? null })
          setSt(stateOf(value))
          rememberRun(value.result?.runId ?? null, text, title, persist)
          const items = value.result.items ?? []
          // A data transform (sort/filter/compute) produces no tables: stay in
          // the data editor and refresh the rows the host just rewrote.
          if (items.length > 0) setView('output')
          else if (persist) {
            setView('data')
            const page = await loadRows(0, 500)
            setRows(page.rows)
            setTotal(page.total)
            setSelected(null)
          }
          const errors = (value.result.diagnostics ?? []).filter((entry) => entry.severity === 'error')
          const first = errors[0]
          // The engine's sentence is English and assumes the reader knows the
          // command; the hint is the part a student can act on.
          const detail = first ? `${first.message}${first.hint ? ` —— ${first.hint}` : ''}` : ''
          notify(errors.length
            ? tr('{0}完成，但有 {1} 个错误：{2}', tr(title ?? '运行'), errors.length, detail)
            : tr('{0}完成：{1} 个表、{2} 个图', tr(title ?? '运行'), items.filter((item) => item.kind === 'table').length, items.filter((item) => item.kind === 'image').length))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows, rememberRun])

      // Restructuring replaces the matrix on the host instead of running a
      // program, so it cannot go through run(): the reply carries counts, not
      // tables, and the grid has to be reloaded from case 1.
      const runRestructure = useCallback(async (payload, title) => {
        setBusy(true)
        try {
          const value = await api('api/restructure', { sessionId, ...payload })
          setSt(stateOf(value))
          const result = value.result ?? {}
          const page = await loadRows(0, 500)
          setRows(page.rows)
          setTotal(page.total)
          setSelected(null)
          setView('data')
          const extra = result.duplicates ? tr('，重复的「标识+索引」保留了第一个，共 {0} 处', result.duplicates) : ''
          notify(tr('{0}完成：{1} 个个案、{2} 个变量{3}{4}', tr(title ?? '重构'), result.cases ?? 0, result.variables ?? 0, result.created ? tr('（新增 {0} 列）', result.created) : '', extra))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows])

      // MVA 与 RMV 都由宿主从当前数据集算，不经过语法；两者共用一条路由，
      // 用 mode 区分。替换是改数据的操作，完成后必须把数据视图重画一次。
      const runDuplicates = useCallback(async (payload, title) => {
        setBusy(true)
        try {
          const value = await api('api/duplicates', { sessionId, ...payload })
          setSt(stateOf(value))
          const result = value.result ?? {}
          if ((result.created ?? []).length > 0) {
            const page = await loadRows(0, Math.max(500, rows.length))
            setRows(page.rows)
            setTotal(page.total)
          }
          notify(tr('{0}：{1} 组重复、共 {2} 个个案{3}', tr(title ?? '标识重复个案'), result.groups ?? 0, result.duplicates ?? 0, (result.created ?? []).length ? tr('；已新增 {0}', result.created.join('、')) : ''))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows, rows.length])

      const runOutliers = useCallback(async (payload, title) => {
        setBusy(true)
        try {
          const value = await api('api/outliers', { sessionId, ...payload })
          setSt(stateOf(value))
          const result = value.result ?? {}
          if ((result.created ?? []).length > 0) {
            const page = await loadRows(0, Math.max(500, rows.length))
            setRows(page.rows)
            setTotal(page.total)
          }
          const band = `${result.lowPercent ?? 5}%–${result.highPercent ?? 95}%`
          notify(tr('{0}：按 {1} 界值查出 {2} 处越界、落在 {3} 个个案上{4}', tr(title ?? '标识异常个案'), band, result.hits ?? 0, result.flagged ?? 0, (result.created ?? []).length ? tr('；已新增 {0}', result.created.join('、')) : ''))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows, rows.length])

      const runMissing = useCallback(async (payload, title) => {
        setBusy(true)
        try {
          const value = await api('api/missing', { sessionId, ...payload })
          setSt(stateOf(value))
          const result = value.result ?? {}
          if (payload.mode === 'replace') {
            const page = await loadRows(0, 500)
            setRows(page.rows)
            setTotal(page.total)
            setSelected(null)
            setView('data')
            const names = (result.variables ?? []).join('、')
            notify(result.filled > 0
              ? tr('{0}完成：在 {1} 上补了 {2} 个格子（{3}），一次撤销可以整批退回', tr(title ?? '替换缺失值'), names, result.filled, result.method === 'mean' ? tr('序列平均值') : result.method === 'linear' ? tr('线性趋势') : tr('临近点'))
              : tr('{0} 没有缺失值，什么也没改', names))
          } else {
            notify(tr('{0}完成：{1} 张表，基于 {2} 个个案', tr(title ?? '缺失值分析'), result.tables ?? 0, result.cases ?? 0))
          }
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows])

      // SPSS's 粘贴变量 pastes names into a dialog box; our dialogs take clicks,
      // so the same clipboard is read as a list of names and the variable view
      // jumps to the first one that exists.
      const pasteVariablesFromClipboard = useCallback(async () => {
        let text = ''
        try { text = (await navigator.clipboard?.readText?.()) ?? '' } catch { notify('浏览器没给读剪贴板的权限：先点一下面板再试'); return }
        const names = [...new Set(String(text).split(/[\s,，;；、]+/).map((entry) => entry.trim()).filter(Boolean))]
        if (names.length === 0) { notify('剪贴板里没有内容'); return }
        const known = (st?.dataset?.variables ?? []).map((variable) => variable.name)
        const found = names.filter((name) => known.some((entry) => entry.toLowerCase() === name.toLowerCase()))
        if (found.length === 0) { notify(tr('剪贴板里的 {0} 个名字都不是当前数据集的变量', names.length)); return }
        setView('variables')
        setVariableJump({ name: found[0], seq: Date.now() })
        notify(tr('剪贴板里有 {0} 个变量：{1}{2}{3}', found.length, found.slice(0, 6).join('、'), found.length > 6 ? '…' : '', found.length < names.length ? tr('；另有 {0} 个名字没有匹配到变量', names.length - found.length) : ''))
      }, [st])

      // Everything a multiple response set can do: refresh its frequency table,
      // tabulate it against a grouping variable, or drop it.
      const mrAction = useCallback(async (action, name, extra = {}) => {
        setBusy(true)
        try {
          const value = await api('api/mrset', { sessionId, ...extra, action, name })
          if (value.state) setSt(stateOf(value))
          if (action === 'frequency' || action === 'crosstab') {
            // The new table is appended to the output, so pull the items again.
            await refresh()
            setView('output')
          }
          if (action === 'remove') {
            setActiveMr(null)
            notify(tr('已删除多选题 {0}', name))
          }
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, refresh])

      const runPublication = useCallback(async (payload) => {
        setBusy(true)
        try {
          const value = await api('api/publication', { sessionId, ...payload })
          setSt(stateOf(value))
          setView('output')
          const notes = value.result?.notes ?? []
          notify(tr('已生成：{0}{1}', value.result?.item?.title ?? tr('表格'), notes.length ? tr('（{0} 条提示）', notes.length) : ''))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      const runPairwise = useCallback(async (payload) => {
        setBusy(true)
        try {
          const value = await api('api/pairwise', { sessionId, options: payload })
          setSt(stateOf(value))
          setView('output')
          const count = (value.result?.matrix?.length ?? 1) - 1
          notify(tr('两两比较：{0} 对{1}', count, value.result?.notes?.length ? tr('（{0} 条提示）', value.result.notes.length) : ''))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      const runPartial = useCallback(async (payload) => {
        setBusy(true)
        try {
          const value = await api('api/partial', { sessionId, options: payload })
          setSt(stateOf(value))
          setView('output')
          const count = (value.result?.matrix?.length ?? 1) - 1
          notify(tr('偏相关：{0} 对变量{1}', count, value.result?.notes?.length ? tr('（{0} 条提示）', value.result.notes.length) : ''))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      const doFlip = useCallback(async (force) => {
        setBusy(true)
        try {
          const value = await api('api/flip', { sessionId, force: force === true })
          setSt(stateOf(value))
          const page = await loadRows(0, 500)
          setRows(page.rows)
          setTotal(page.total)
          setSelected(null)
          notify('已转置')
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows])

      const runChart = useCallback(async (chart) => {
        setBusy(true)
        try {
          rememberChartTarget(chart.tableId ?? '')
          const value = await api('api/chart', { sessionId, kind: chart.kind, options: chart })
          setSt(stateOf(value))
          setView('output')
          notify(tr('已生成图表：{0}', value.result?.chart?.title ?? tr('图表')))
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      // One-click charts for the column the cursor is on: SPSS users draw the
      // same four pictures over and over, and the dialog asks for the variable
      // they already selected.
      const quickChart = useCallback(async (kind) => {
        const list = st?.dataset?.variables ?? []
        if (!list.length) { notify('先打开一个数据集'); return }
        const picked = selected && rows[selected.row]
          ? list[selected.column]
          : null
        const numeric = list.filter((variable) => variable.type === 'numeric')
        const nominal = list.filter((variable) => variable.type !== 'numeric' || variable.measure === 'nominal')
        const variable = picked && kind !== 'pie' && picked.type !== 'numeric' && numeric.length
          ? numeric[0].name
          : (picked ? picked.name : (numeric[0] ?? list[0]).name)
        const by = picked && picked.name === variable ? null : (picked ? picked.name : null)
        const chart = { kind, variable: variable.name ?? variable }
        if (kind === 'line' || kind === 'area') {
          chart.by = by ?? (nominal.find((entry) => entry.name !== variable) ?? {}).name ?? null
          if (!chart.by) { notify('折线图和面积图需要再加一个类别变量：先选一列，或改用「折线图…」对话框'); return }
        }
        if (kind === 'bar') {
          const cluster = nominal.find((entry) => entry.name !== variable && entry.name !== chart.by)
          if (cluster) chart.cluster = cluster.name
        }
        await runChart(chart)
      }, [selected, rows, st, runChart])

      const applyHistory = useCallback(async (action) => {
        setBusy(true)
        try {
          const value = await api('api/history', { sessionId, action })
          setSt(stateOf(value))
          const page = await loadRows(0, 500)
          setRows(page.rows)
          setTotal(page.total)
          setSelected(null)
          const verb = action === 'redo' ? tr('已重做') : tr('已撤销')
          const what = value.result?.label ?? ''
          notify(what === '' ? verb : tr('{0}：{1}', verb, what))
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows])

      // Ctrl+Z / Ctrl+Y work anywhere in the panel, like SPSS; inside a cell
      // editor the native text undo keeps priority.
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.ctrlKey || event.metaKey)) return
          // A panel that is not the visible tab must not eat the harness's own
          // Ctrl+F, and a cell editor keeps its native text undo: this handler
          // used to hijack both.
          const root = rootRef.current
          if (!root || root.offsetParent === null) return
          const target = event.target
          if (target instanceof HTMLElement && (target.isContentEditable || target.contentEditable === 'true')) return
          const key = String(event.key).toLowerCase()
          if (key === 'f') {
            event.preventDefault()
            setDialog({ kind: 'find', mode: 'find' })
            return
          }
          if (key !== 'z' && key !== 'y') return
          const tag = event.target && event.target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA') return
          event.preventDefault()
          applyHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo')
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [applyHistory])

      // Outside clicks close a menu (clicking the menu button again also does).
      useEffect(() => {
        if (!menu) return undefined
        const onDown = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('.ap-menu')) return
          setMenu(null)
        }
        window.addEventListener('mousedown', onDown, true)
        return () => window.removeEventListener('mousedown', onDown, true)
      }, [menu])

      const toggleLabels = useCallback(() => {
        setShowLabels((current) => {
          const next = !current
          try { localStorage.setItem('ap.showLabels', next ? '1' : '0') } catch { /* storage may be blocked */ }
          return next
        })
      }, [])

      // Opening a second file must not throw the first one away: the sidebar
      // gets one more PSPP tab, and that tab's own tab.meta.docId keys a
      // workspace of its own on the host (SPSS opens a Data Editor per file).
      // `path` is what the sidebar shows under a tab; `open` is the file to
      // load. A dropped file has no path worth showing, so it only passes the
      // workspace copy to `open` and the tab stays nameless.
      const openInNewTab = useCallback((path, name, open, importOptions) => {
        const service = ctx?.betterSidebar
        if (!service?.openTab) return false
        // openTab defaults to the RIGHT sidebar; a panel living in the bottom
        // workbench has to ask for 'bottom' or the new tab appears elsewhere.
        const root = rootRef.current
        const bottom = Boolean(root && root.closest('.nArs4W_pane'))
        // The right sidebar keeps one tab per tool type: there a second file
        // becomes a document inside this panel, and openPath handles it.
        if (!bottom) return false
        const docId = `${baseSessionId}~${(DOC_SEQ += 1)}`
        PENDING_OPEN.add(docId)
        service.openTab({
          type: 'analytics',
          // Without an explicit id the bottom workbench reuses the type id and
          // focuses the open tab instead of creating a second one.
          id: `analytics:${docId}`,
          title: 'PSPP',
          ...(path ? { path } : {}),
          target: 'bottom',
          meta: { docId, ...(open ? { openPath: open } : {}), ...(importOptions ? { import: importOptions } : {}) },
        })
        notify(tr('新标签页：{0}', name ?? path))
        return true
      }, [ctx, baseSessionId, notify])

      // One place decides what an `api/open` answer means: a data file swaps
      // the dataset, a syntax file only fills the editor.
      const applyOpenResult = useCallback((value, targetDocId) => {
        const result = value?.result ?? {}
        if (result.kind === 'syntax') {
          const text = typeof result.text === 'string' ? result.text : ''
          if (targetDocId && targetDocId !== docId) {
            setSyntaxByDoc((current) => {
              const next = { ...current, [targetDocId]: text }
              try { localStorage.setItem('ap.syntaxByDoc', JSON.stringify(next)) } catch { /* quota */ }
              return next
            })
          } else {
            setSyntax(text)
          }
          setView('syntax')
          return 'syntax'
        }
        if (value?.state) setSt(stateOf(value))
        setView('data')
        // A tab that just loaded a file should say which file: several PSPP
        // tabs each hold their own dataset, and four tabs all called "PSPP"
        // is how a user edits the wrong one. Only bottom-workbench tabs have a
        // title to change; an in-panel document already carries its own name.
        renameDocTab(ctx?.betterSidebar, docId, baseSessionId, value?.state?.dataset?.name)
        // Column headings that had to be renamed for PSPP's rules are worth a
        // notice: the column the user is looking for now carries a different
        // name, and its original heading is only in the variable label.
        const renamed = value?.result?.notes ?? []
        // The grid shows fewer rows than the file has, and looks exactly like a
        // smaller file. Only the panel knows why, so it says so once per open.
        if (renamed.length === 0 && value?.state?.dataset?.truncated === true) {
          notify(tr('已按「数据视图最多载入个案数」只显示前 {0} 例；分析、保存与导出仍在完整数据上跑', value.state.dataset.caseCount))
        }
        if (renamed.length > 0) {
          notify(tr('{0} 列的表头不符合 PSPP 变量名规则，已改名（原表头保留为标签）：{1}{2}', renamed.length, renamed[0], renamed.length > 1 ? tr(' 等 {0} 条，细节见状态栏「导入说明」', renamed.length) : ''))
        }
        return 'data'
      }, [docId, baseSessionId, ctx, setSyntax, notify])

      const openPath = useCallback(async (path, options = {}) => {
        // options.seed   - path the sidebar may show (omit for a dropped copy)
        // options.title  - name to put in the document list
        // options.import - encoding/delimiter/header for .csv/.txt/.tsv
        const seed = 'seed' in options ? options.seed : path
        const title = options.title ?? basenameOf(path)
        if (!options.import && /\.(csv|txt|tsv)$/i.test(path)) {
          // Ask before importing: the file cannot say its own encoding.
          setDialog({ kind: 'import', path, seed, title, hasHeader: !/\.txt$/i.test(path) })
          return
        }
        if (!options.import && /\.(xlsx|ods)$/i.test(path)) {
          try {
            const listed = await api('api/sheets', { path })
            const sheets = listed.result?.sheets ?? []
            if (sheets.length > 1) {
              setDialog({ kind: 'sheet', path, seed, title, sheets, hasHeader: true })
              return
            }
            options = { ...options, import: { sheet: sheets[0] ?? 0, hasHeader: true } }
          } catch (error) {
            notify(error.message)
            return
          }
        }
        if (/\.sps$/i.test(path)) {
          // A syntax file is not a dataset: it must not mint a document (that
          // empty document is what made the *next* file look like this one).
          setBusy(true)
          try {
            const value = await api('api/open', { sessionId, path })
            const kind = applyOpenResult(value)
            setBrowser(null)
            notify(kind === 'syntax' ? tr('已载入语法：{0}', displayPath(path)) : tr('已打开 {0}', displayPath(path)))
          } catch (error) {
            notify(error.message)
          } finally {
            setBusy(false)
          }
          return
        }
        if (st?.dataset && openInNewTab(seed, title, path, options.import)) {
          setBrowser(null)
          return
        }
        if (st?.dataset) {
          // A panel that cannot open tabs (the right sidebar) starts a new
          // document inside itself instead of throwing the current one away.
          const nextId = `${baseSessionId}~${(DOC_SEQ += 1)}`
          setDocs((list) => [...list, { id: nextId, title }])
          setBusy(true)
          try {
            const value = await api('api/open', { sessionId: nextId, path, options: options.import })
            setDocId(nextId)
            applyOpenResult(value)
            setBrowser(null)
            notify(tr('已打开 {0}', displayPath(path)))
          } catch (error) {
            setDocs((list) => list.filter((doc) => doc.id !== nextId))
            notify(error.message)
          } finally {
            setBusy(false)
          }
          return
        }
        setBusy(true)
        try {
          const value = await api('api/open', { sessionId, path, options: options.import })
          applyOpenResult(value)
          setBrowser(null)
          notify(tr('已打开 {0}', displayPath(path)))
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, st?.dataset, openInNewTab])

      // A file clicked in the Files panel arrives here (its viewer tab hands the
      // path over and closes): open it in this panel, as its own document.
      const drainFileHandoffs = useCallback(() => {
        const entries = takeFileHandoffs(baseSessionId)
        if (entries.length === 0) return
        ;(async () => {
          for (const entry of entries) {
            try {
              await openPath(entry.path, { seed: entry.path, title: basenameOf(entry.path) })
            } catch (error) {
              notify(error.message)
            }
          }
        })()
      }, [baseSessionId, openPath, notify])

      useEffect(() => { drainRef.current = drainFileHandoffs }, [drainFileHandoffs])

      useEffect(() => {
        drainFileHandoffs()
        const onHandoff = (event) => {
          if (event?.detail?.sessionId === baseSessionId) drainFileHandoffs()
        }
        window.addEventListener(FILE_HANDOFF_EVENT, onHandoff)
        return () => window.removeEventListener(FILE_HANDOFF_EVENT, onHandoff)
      }, [drainFileHandoffs, baseSessionId])

      // A browser drop hands us the bytes, not a path, so the file is stored in
      // the workspace first and then opened through the normal route.
      const uploadFiles = useCallback(async (fileList) => {
        const files = Array.from(fileList ?? [])
        if (files.length === 0) return
        setBusy(true)
        try {
          for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer())
            let binary = ''
            for (let at = 0; at < bytes.length; at += 0x8000) {
              binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000))
            }
            const value = await api('api/upload', { sessionId, name: file.name, data: btoa(binary) })
            await openPath(value.result.path, { seed: '', title: value.result.name ?? file.name })
            // The browser never reveals where a dropped file came from, so say
            // it plainly instead of showing the copy's path as if it were real.
            notify(tr('已拖入 {0}：原路径未知（浏览器不给路径），要写回原文件请用「文件 → 打开数据…」', file.name))
          }
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, openPath, notify])

      // The tab was minted with a path (a second file, or a restored layout):
      // open it once, into this tab's own workspace.
      const openedFromTab = useRef(false)
      useEffect(() => {
        if (openedFromTab.current || !tabPath) return
        // The Files panel hands us a tab the page never created, so there is no
        // handshake to wait for: its workspace is keyed by the file path, which
        // makes reopening it on mount the correct behaviour.
        const fromViewer = tab?.meta?.fromViewer === true
        // A tab the page created carries its file in `path`; a tab restored
        // from an earlier layout must not re-open it behind the user's back.
        if (!fromViewer && !PENDING_OPEN.has(sessionId)) return
        if (!fromViewer) PENDING_OPEN.delete(sessionId)
        openedFromTab.current = true
        ;(async () => {
          try {
            // A restored tab already owns its workspace (work.sav on disk), so
            // re-opening the seed path would silently replace the data the user
            // had. Only a genuinely empty workspace opens the file again.
            const current = await api(stateUrl(sessionId))
            if (current?.state?.dataset) {
              setSt(current.state)
              return
            }
            const opened = await api('api/open', { sessionId, path: tabPath, options: tab?.meta?.import })
            applyOpenResult(opened)
          } catch (error) {
            notify(error.message)
          }
        })()
      }, [tabPath, sessionId])

      // A document's tab must name itself even while another one is on screen,
      // so every open records the dataset name it ended up with.
      const renameDoc = useCallback((id, name) => {
        if (!id || typeof name !== 'string' || name === '') return
        setDocs((list) => list.map((doc) => (doc.id === id ? { ...doc, title: name } : doc)))
      }, [])

      // Whatever brought the data in (open dialog, drop, tool call, restore),
      // the document is named after it once the dataset is there.
      useEffect(() => {
        const name = st?.dataset?.name
        if (name) renameDoc(sessionId, name)
      }, [st?.dataset?.name, sessionId, renameDoc])

      const switchDoc = useCallback((id) => {
        if (id === sessionId) return
        // Remember whether the tab we are leaving has unsaved edits, so closing
        // it later can ask instead of dropping them silently.
        setDocs((list) => list.map((doc) => (doc.id === sessionId ? { ...doc, dirty: st?.dataset?.dirty === true } : doc)))
        setDocId(id)
        setSelected({ row: 0, column: 0 })
        setView('data')
      }, [sessionId, st?.dataset?.dirty])

      const closeDocNow = useCallback(async (id) => {
        try {
          await api('api/close', { sessionId: id })
        } catch {
          // the workspace is already gone; dropping the entry is still right
        }
        setSyntaxByDoc((current) => {
          if (!(id in current)) return current
          const next = { ...current }
          delete next[id]
          try { localStorage.setItem('ap.syntaxByDoc', JSON.stringify(next)) } catch { /* quota */ }
          return next
        })
        setDocs((list) => {
          const rest = list.filter((doc) => doc.id !== id)
          if (rest.length === 0) return list
          if (id === sessionId) setDocId(rest[rest.length - 1].id)
          return rest
        })
      }, [sessionId])

      // Closing throws the edits away: the copy in work.sav is the only one and
      // the panel has no way back to it, so ask first.
      const [pendingClose, setPendingClose] = useState(null)
      const closeSession = useCallback(async () => {
        const value = await api('api/close', { sessionId })
        setSt(stateOf(value))
        setRows([])
        setTotal(0)
        setSelected(null)
      }, [sessionId])
      const closeDoc = useCallback((id, dirty) => {
        const unsaved = dirty ?? (id === sessionId ? st?.dataset?.dirty === true : false)
        if (unsaved) {
          setPendingClose({ id, current: id === sessionId })
          setDialog({ kind: 'close' })
          return
        }
        if (id === sessionId) closeSession()
        else closeDocNow(id)
      }, [sessionId, st?.dataset?.dirty, closeSession, closeDocNow])


      const saveAs = useCallback(async () => {
        const path = st?.dataset?.sourcePath
        if (!path || st?.dataset?.temporary === true) {
          // A dropped file is only a copy in the workspace: ask where to write.
          setBrowser({ mode: 'save' })
          if (st?.dataset?.temporary === true) notify('这是拖入文件的副本，请选择保存位置')
          return
        }
        setBusy(true)
        try {
          await api('api/save', { sessionId, path })
          await refresh()
          notify(tr('已保存 {0}', path))
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, st, refresh])

      // Static HTML snapshot of the output view; images keep their host URLs.
      // Titles can carry quotes from a variable label; the export is a
      // standalone HTML file, so they have to be escaped like the notes are.
      const escapeForExport = (text) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
      const exportOutput = useCallback(() => {
        const list = st?.items ?? []
        if (list.length === 0) { notify('还没有输出'); return }
        // PSPP's own HTML comes back with a bare `<table>`; the panel's tables
        // carry a class. Both get the preset stamped on, so one stylesheet
        // covers every table in the file.
        const stampStyle = (html) => {
          const text = String(html ?? '')
          if (!text.includes('<table')) return text
          return text.replace(/<table\b([^>]*)>/i, (match, attrs) => (
            /class\s*=\s*"([^"]*)"/i.test(attrs)
              ? match.replace(/class\s*=\s*"([^"]*)"/i, (whole, current) => `class="${current}${current ? ' ' : ''}ap-tbl-${tableStyle}"`)
              : `<table${attrs} class="ap-tbl-${tableStyle}">`
          ))
        }
        const parts = [
          '<!doctype html><meta charset="utf-8"><title>' + escapeForExport(tr('PSPP 输出')) + '</title>',
          '<style>body{font:13px/1.6 "Segoe UI","Noto Sans CJK SC",sans-serif;padding:24px;color:#111}' +
          'table{border-collapse:collapse;margin:0 0 18px}caption{caption-side:top;text-align:left;font-weight:600;padding:2px 0 4px}' +
          'th,td{border:1px solid #9aa1ad;padding:3px 7px}th{background:#f0f2f6}img{max-width:100%;border:1px solid #d5d8dd}' +
          // The preset travels with the export: a three-line table printed from
          // the panel and the same table saved as HTML must not be two looks.
          'table.ap-tbl-three{border-collapse:collapse;border-top:2px solid #222;border-bottom:2px solid #222}' +
          'table.ap-tbl-three th,table.ap-tbl-three td{border:0;border-bottom:1px solid #e6e8ee;padding:4px 8px}' +
          'table.ap-tbl-three tr:first-child th{border-bottom:1px solid #222}' +
          'table.ap-tbl-grid th,table.ap-tbl-grid td{border:1px solid #9aa1ad}' +
          'table.ap-tbl-plain th,table.ap-tbl-plain td{border-color:transparent;background:transparent}' +
          '.ap-export-note{font-style:italic;font-size:12px;color:#333;margin:-10px 0 18px}' +
          '.ap-export-source{font-size:11px;color:#555;margin:-12px 0 16px}</style>',
        ]
        for (const item of list) {
          if (item.kind === 'table') {
            // Same cap as the Word/Excel writers: a saved HTML file has to stay
            // openable, and the note below says what was left out.
            const edits = tableEdits[item.id]
            const matrixRows = Array.isArray(item.table?.matrix) ? item.table.matrix.length : 0
            const bodyRows = Math.max(0, matrixRows - 1)
            // The cap the host exports use, so all three files agree (0.31.3).
            const exportRows = Number(st?.maxExportRows) > 0 ? Number(st?.maxExportRows) : EXPORT_ROWS
            const clipBody = bodyRows > exportRows
            const limit = clipBody ? exportRows : 0
            const drawn = edits
              ? { html: matrixHtml(item.table?.matrix, `ap-tbl-${tableStyle}`, edits, limit), total: bodyRows, shown: limit > 0 ? Math.min(limit, bodyRows) : bodyRows }
              : item.table?.html?.includes?.('<table')
                ? truncateTableHtml(item.table.html, limit)
                : { html: matrixHtml(item.table?.matrix, `ap-tbl-${tableStyle}`, null, limit), total: bodyRows, shown: limit > 0 ? Math.min(limit, bodyRows) : bodyRows }
            parts.push(stampStyle(drawn.html))
            if (clipBody && drawn.total > drawn.shown) {
              parts.push(`<div class="ap-export-note">${tr('表太长：这张表共 {0} 行，这个文件里只放了前 {1} 行；完整数据请用「导出表格为 CSV」。', drawn.total, drawn.shown)}</div>`)
            }
            // One line per table saying which data it came from: the block at
            // the bottom lists every source in the session, which does not tell
            // a reader handed a single table where its numbers came from.
            if (item.provenance) {
              const from = item.provenance
              // Each piece is translated here: `tr()` only fills the outer
              // template, it never looks inside an interpolated value.
              const which = from.origin === 'new'
                ? tr('新建数据集{0}', from.name ? tr('（{0}）', from.name) : '')
                : (from.name ?? from.sourcePath ?? tr('未命名数据'))
              const when = formatWhen(from.openedAt)
              const size = typeof from.sourceSize === 'number'
                ? (from.sourceSize < 1024 ? `${from.sourceSize} B` : `${(from.sourceSize / 1024).toFixed(1)} KB`)
                : null
              const runNo = Number.isFinite(Number(from.runId)) && Number(from.runId) > 0 ? tr(' · 运行 #{0}', Number(from.runId)) : ''
              const digest = typeof from.digest === 'string' && from.digest ? tr(' · 数据指纹 {0}', from.digest) : ''
              parts.push(`<p class="ap-export-source">${escapeForExport(tr('来源：{0} · {1} 例{2}{3}{4}{5}', which, from.caseCount, size ? ` · ${size}` : '', when ? tr(' · 打开于 {0}', when) : '', runNo, digest))}</p>`)
            }
            // The caveats (separation, skipped variables) are part of the table:
            // an HTML copy without them reads as if nothing was wrong.
            for (const note of item.notes ?? []) {
              const text = String(note ?? '').trim()
              if (!text) continue
              const safe = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
              parts.push(`<p class="ap-export-note">${tr('注：')}${safe}</p>`)
            }
          }
          else if (item.kind === 'image') parts.push(`<h3>${escapeForExport(item.title ?? '')}</h3><img src="${new URL(item.artifactUrl, document.baseURI)}" alt="${escapeForExport(item.alt ?? '')}">`)
          else parts.push(`<h3>${escapeForExport(item.title ?? '')}</h3>`)
        }
        // Same rule as the Word export: an HTML file that leaves the panel has to
        // say which data its tables were computed from.
        const seenSources = new Map()
        for (const item of list) {
          const from = item.provenance
          if (!from) continue
          const key = [from.sessionId, from.origin ?? '', from.sourcePath ?? '', from.openedAt ?? ''].join('|')
          if (!seenSources.has(key)) seenSources.set(key, from)
        }
        if (seenSources.size > 0) {
          const band = (value) => (typeof value === 'number'
            ? (value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`)
            : null)
          const lines = [...seenSources.values()].map((from) => {
            const when = formatWhen(from.openedAt)
            const which = from.origin === 'new'
              ? tr('新建数据集{0}', from.name ? tr('（{0}，未保存）', from.name) : tr('（未保存）'))
              : (from.sourcePath ?? from.name ?? tr('未命名数据'))
            const size = band(from.sourceSize)
            // Filled once with translated pieces: `tr()` only replaces at render
            // time, so interpolating ` · 打开于 …` first left that fragment in
            // Chinese inside the English file.
            return tr('{0} · {1} 例 · {2} 变量{3}{4}', escapeForExport(which), from.caseCount, from.varCount,
              size ? ` · ${size}` : '', when ? tr(' · 打开于 {0}', escapeForExport(when)) : '')
          })
          parts.push(`<hr><p class="ap-export-note"><b>${tr('数据来源：')}</b><br>` + lines.join('<br>') + '</p>')
          parts.push(`<p class="ap-export-note">${tr('（由 dsh-analytics-pspp 生成，引擎 GNU PSPP；改动数据后请重新运行分析。）')}</p>`)
        }
        const blob = new Blob([parts.join('\n')], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'pspp-output.html'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 3000)
        notify('已导出 pspp-output.html')
      }, [st, notify, tableEdits, tableStyle])

      // 所有表格按顺序拼成一个 CSV，TABLE 行标出表名。
      const exportOutputCsv = useCallback(() => {
        const tables = (st?.items ?? []).filter((item) => item.kind === 'table' && item.table?.matrix?.length)
        if (tables.length === 0) { notify('还没有表格输出'); return }
        const parts = []
        for (const item of tables) {
          const name = (item.table?.caption || item.title || 'table').replace(/\s+/g, ' ').trim()
          parts.push(`TABLE,${name}`)
          parts.push(tableToCsv(item.table.matrix))
          parts.push('')
        }
        saveTextFile('pspp-output.csv', parts.join('\n'))
        notify('已导出 pspp-output.csv')
      }, [st, notify])

      const editCell = useCallback(async (row, variable, value, cause = null) => {
        try {
          // Typing below the last case adds the missing cases first, the way
          // SPSS lets you keep entering data past the bottom of the sheet.
          let target = row
          if (row >= (st?.dataset?.caseCount ?? 0)) {
            for (let index = st?.dataset?.caseCount ?? 0; index <= row; index += 1) {
              const appended = await api('api/case', { sessionId, action: 'append', values: {} })
              setSt(appended.state)
            }
            target = row
          }
          const result = await api('api/cell', { sessionId, row: target, variable, value })
          setSt(result.state)
          setRows((current) => {
            const next = current.map((entry) => [...entry])
            if (next[target]) {
              const column = result.state.dataset.variables.findIndex((entry) => entry.name === variable)
              next[target][column] = result.result.value
            }
            return next
          })
          // The keystroke lives in an input that is about to unmount; Kafka
          // style focus forwarding is unnecessary, but without it the next
          // keypress goes nowhere.
          if (cause?.focus) window.setTimeout(() => document.querySelector('.ap-grid-wrap')?.focus({ preventScroll: true }), 0)
        } catch (error) {
          writeFailed(error)
        }
      }, [sessionId, st])

      const runAnalysis = (key) => {
        const spec = ANALYSIS_SPECS[key]
        setDialog({ kind: 'analysis', spec })
      }

      // Plain array (no memo): menu actions must always close over the
      // current selection/state, and the render cost is negligible.
      const history = st?.history ?? { undo: 0, redo: 0, undoLabel: null, redoLabel: null }
      const menus = ([
        {
          label: '文件', items: [
            { label: '新建数据', action: async () => { const value = await api('api/new', { sessionId }); setSt(stateOf(value)); setView('data') } },
            { label: '打开数据…', action: () => setBrowser({ mode: 'open' }) },
            { label: '导入向导…', action: () => setBrowser({ mode: 'importWizard' }) },
            { label: '保存数据', action: saveAs },
            { label: '另存为…', action: () => setBrowser({ mode: 'save' }) },
            { sep: true },
            { label: '保存语法文件（.sps）…', action: () => setBrowser({ mode: 'syntax' }) },
            { label: '转换数据格式（pspp-convert）…', action: () => setDialog({ kind: 'convert' }) },
            { label: '导出为 CSV…', action: () => setBrowser({ mode: 'export' }) },
            { label: '导出输出为 PDF…', action: () => setBrowser({ mode: 'exportdoc', format: 'pdf' }) },
            { label: '导出输出为 ODT…', action: () => setBrowser({ mode: 'exportdoc', format: 'odt' }) },
            { label: '导出输出为 SPSS 输出（.spv）…', action: () => setBrowser({ mode: 'exportdoc', format: 'spv' }) },
            { label: '导出输出为 Word（.docx）…', action: () => setBrowser({ mode: 'office', format: 'docx', scope: 'session' }) },
            { label: '导出输出为 Excel（.xlsx）…', action: () => setBrowser({ mode: 'office', format: 'xlsx', scope: 'session' }) },
            { label: '导出报告（成册，勾选的表）…', action: () => setBrowser({ mode: 'reportBook', format: 'docx', reportTitle: '', reportSubtitle: '' }) },
            { sep: true },
            { label: '语法模板库…', action: () => setDialog({ kind: 'templates' }) },
            { label: '运行历史…', action: () => setDialog({ kind: 'runs' }) },
            { label: '关闭数据集', action: () => closeDoc(sessionId) },
            { label: '导出输出为 HTML…', action: () => exportOutput() },
            { label: '导出表格为 CSV…', action: () => exportOutputCsv() },
          ],
        },
        {
          label: '编辑', items: [
            {
              label: history.undo > 0 ? tr('撤销 {0}（Ctrl+Z）', tr(history.undoLabel ?? '')) : '撤销（Ctrl+Z）',
              disabled: history.undo === 0,
              action: () => applyHistory('undo'),
            },
            {
              label: history.redo > 0 ? tr('重做 {0}（Ctrl+Y）', tr(history.redoLabel ?? '')) : '重做（Ctrl+Y）',
              disabled: history.redo === 0,
              action: () => applyHistory('redo'),
            },
            { sep: true },
            { label: '剪切（Ctrl+X）', action: () => { if (!gridCommand('cut')) notify('先在数据视图里选中要剪切的单元格'); } },
            { label: '复制（Ctrl+C）', action: () => { if (!gridCommand('copy')) notify('先在数据视图里选中要复制的单元格'); } },
            { label: '粘贴（Ctrl+V）', action: () => { if (!gridCommand('paste')) notify('先在数据视图里点一下要粘贴到的单元格'); } },
            { label: '清除', action: () => { if (!gridCommand('clear')) notify('先在数据视图里选中要清除的单元格'); } },
            { label: '粘贴变量…', action: () => pasteVariablesFromClipboard() },
            { sep: true },
            { label: '转到个案…', action: () => setDialog({ kind: 'goto', value: String((selected?.row ?? 0) + 1) }) },
            { label: '转到变量…', action: () => setDialog({ kind: 'gotoVariable', value: '' }) },
            { sep: true },
            { label: '查找…（Ctrl+F）', action: () => setDialog({ kind: 'find', mode: 'find' }) },
            { label: '替换…', action: () => setDialog({ kind: 'find', mode: 'replace' }) },
          ],
        },
        {
          label: '视图', items: [
            { label: `${showLabels ? '✓ ' : ''}显示值标签`, action: toggleLabels },
            { sep: true },
            { label: '列宽全部恢复默认', action: () => setColWidth(null, null) },
            { sep: true },
            { label: `${showGridLines ? '✓ ' : ''}网格线`, action: () => {
              setShowGridLines((current) => {
                const next = !current
                try { localStorage.setItem('ap.gridLines', next ? '1' : '0') } catch { /* private mode */ }
                return next
              })
            } },
            { label: `${showToolbar ? '✓ ' : ''}工具栏`, action: () => {
              setShowToolbar((current) => {
                const next = !current
                try { localStorage.setItem('ap.toolbar', next ? '1' : '0') } catch { /* private mode */ }
                return next
              })
            } },
            { sep: true },
            { label: `${freezeRows ? '✓ ' : ''}冻结首行（表头）`, action: () => toggleFreeze('rows') },
            { label: `${freezeCols ? '✓ ' : ''}冻结首列（行号与第一个变量）`, action: () => toggleFreeze('cols') },
            { label: '跳转到个案…', action: () => setDialog({ kind: 'goto', value: String((selected?.row ?? 0) + 1) }) },
            { sep: true },
            { label: '在输出中查找…', action: () => setDialog({ kind: 'outputSearch', value: outputQuery }) },
            { label: '输出表格样式', sub: [
              { label: `${styleOverride === null ? '✓ ' : ''}${tr('{0}（{1}）', tr('跟随设置'), tr(settingStyle === 'grid' ? '全框线' : '三线表'))}`, action: () => chooseTableStyle(null) },
              { label: `${tableStyle === 'default' ? '✓ ' : ''}引擎原样（不套样式）`, action: () => chooseTableStyle('default') },
              { label: `${tableStyle === 'three' ? '✓ ' : ''}三线表（论文用）`, action: () => chooseTableStyle('three') },
              { label: `${tableStyle === 'grid' ? '✓ ' : ''}全框线`, action: () => chooseTableStyle('grid') },
              { label: `${tableStyle === 'plain' ? '✓ ' : ''}无框线`, action: () => chooseTableStyle('plain') },
            ] },
          ],
        },
        {
          label: '数据', items: [
            { label: '新建变量（转到变量视图最后一行）', action: () => setView('variables') },
            { label: '批量导入值标签…', action: () => setDialog({ kind: 'valueLabels' }) },
            { label: '插入个案', action: async () => {
              const value = await api('api/case', { sessionId, action: 'append', values: {} })
              setSt(stateOf(value))
              const page = await loadRows(0, 500)
              setRows(page.rows)
              setTotal(page.total)
            } },
            { label: '删除个案', action: async () => {
              if (!selected) { notify('先在数据视图里选中一个单元格'); return }
              const value = await api('api/case', { sessionId, action: 'delete', row: selected.row })
              setSt(stateOf(value))
              const page = await loadRows(0, 500)
              setRows(page.rows)
              setTotal(page.total)
              setSelected(null)
            } },
            { label: '转置', action: async () => {
              const strings = (st?.dataset?.variables ?? []).filter((variable) => variable.type === 'string').map((variable) => variable.name)
              if (strings.length > 0) { setDialog({ kind: 'flip', strings }); return }
              await doFlip(false)
            } },
            { sep: true },
            { label: '排序个案…', action: () => runAnalysis('sort') },
            { label: '选择个案…', action: () => runAnalysis('select') },
            { label: '加权个案…', action: () => runAnalysis('weight') },
            { label: '关闭加权', action: () => run('WEIGHT OFF.\nEXECUTE.', true, '关闭加权') },
            { label: '拆分文件…', action: () => runAnalysis('split') },
            { label: '随机抽样…', action: () => runAnalysis('sample') },
            { sep: true },
            { label: '重构', sub: [
              { label: '个案转变量…', action: () => runAnalysis('casesToVars') },
              { label: '变量转个案…', action: () => runAnalysis('varstocases') },
            ] },
            { label: '合并文件', sub: [
              { label: '添加个案…', action: () => setDialog({ kind: 'merge', mode: 'add', path: '', by: '' }) },
              { label: '按关键变量合并…', action: () => setDialog({ kind: 'merge', mode: 'match', path: '', by: '' }) },
            ] },
            { label: '标识重复个案…', action: () => runAnalysis('duplicates') },
            { label: '标识异常个案…', action: () => runAnalysis('outliers') },
          ],
        },
        {
          label: '转换', items: [
            { label: '计算变量…', action: () => runAnalysis('compute') },
            { label: '重新编码为不同变量…', action: () => runAnalysis('recode') },
            { label: '自动重新编码（字符串转数值）…', action: () => runAnalysis('autorecode') },
            { label: '汇总…', action: () => runAnalysis('aggregate') },
            { label: '计数…', action: () => runAnalysis('count') },
            { label: '排秩…', action: () => runAnalysis('rank') },
            { label: '替换缺失值…', action: () => runAnalysis('replaceMissing') },
            { label: '定义多选题…', action: () => { setMrOpen(true); setDialog({ kind: 'mrsets' }) } },
            { label: '多选题面板…', action: () => setMrOpen(true) },
          ],
        },
        {
          label: '分析', items: [
            { label: '描述统计', sub: [
              { label: '频率…', action: () => runAnalysis('frequencies') },
              { label: '描述…', action: () => runAnalysis('descriptives') },
              { label: '探索…', action: () => runAnalysis('explore') },
              { label: '交叉表…', action: () => runAnalysis('crosstabs') },
            ] },
            { label: '比较平均值', sub: [
              { label: '平均值…', action: () => runAnalysis('means') },
              { label: '单样本 T 检验…', action: () => runAnalysis('ttest1') },
              { label: '独立样本 T 检验…', action: () => runAnalysis('ttest') },
              { label: '配对样本 T 检验…', action: () => runAnalysis('tpaired') },
              { label: '单因素 ANOVA…', action: () => runAnalysis('oneway') },
              { sep: true },
              { label: '两两比较…', action: () => setDialog({ kind: 'pairwise' }) },
            ] },
            { label: '一般线性模型', sub: [
              { label: '单变量…', action: () => runAnalysis('glm') },
            ] },
            { label: '相关', sub: [
              { label: '双变量…', action: () => runAnalysis('correlation') },
              { label: '偏相关…', action: () => setDialog({ kind: 'partial' }) },
            ] },
            { label: '回归', sub: [
              { label: '线性…', action: () => runAnalysis('regression') },
              { label: '二元 Logistic…', action: () => runAnalysis('logistic') },
            ] },
            { label: '降维', sub: [
              { label: '因子…', action: () => runAnalysis('factor') },
              { label: '快速聚类…', action: () => runAnalysis('cluster') },
            ] },
            { label: '刻度', sub: [
              { label: '可靠性分析…', action: () => runAnalysis('reliability') },
            ] },
            { label: '非参数检验', sub: [
              { label: '卡方…', action: () => runAnalysis('npar') },
              { label: '二项式…', action: () => runAnalysis('nparBinomial') },
              { label: 'K-S 正态性…', action: () => runAnalysis('nparKs') },
              { label: '游程…', action: () => runAnalysis('nparRuns') },
              { sep: true },
              { label: '2 个相关样本（Wilcoxon）…', action: () => runAnalysis('nparWilcoxon') },
              { label: '2 个相关样本（符号）…', action: () => runAnalysis('nparSign') },
              { label: '2 个独立样本（Mann-Whitney）…', action: () => runAnalysis('nparMannWhitney') },
              { label: 'K 个独立样本（Kruskal-Wallis）…', action: () => runAnalysis('nparKruskal') },
              { label: 'K 个独立样本（Jonckheere-Terpstra，有序）…', action: () => runAnalysis('nparJonckheere') },
              { label: 'K 个相关样本（Friedman）…', action: () => runAnalysis('nparFriedman') },
              { label: '2 个相关样本（McNemar）…', action: () => runAnalysis('nparMcNemar') },
              { label: 'K 个相关样本（Cochran Q）…', action: () => runAnalysis('nparCochran') },
              { label: 'K 个相关样本（Kendall W）…', action: () => runAnalysis('nparKendall') },
            ] },
            { label: '表', sub: [
              { label: '自定义表…', action: () => runAnalysis('ctables') },
              { sep: true },
              { label: '表 1：基线特征…', action: () => setDialog({ kind: 'publication', tableKind: 'baseline' }) },
              { label: '表 2：组间比较…', action: () => setDialog({ kind: 'publication', tableKind: 'compare' }) },
            ] },
            { label: 'ROC 曲线…', action: () => runAnalysis('roc') },
            { sep: true },
            { label: '缺失值分析…', action: () => runAnalysis('missing') },
            { sep: true },
            { label: '受引擎限制的功能', sub: [
              { label: '生存分析（KM / Cox）', action: () => notify('PSPP 2.1.3 没有实现生存分析（not yet implemented）。替代：把数据导出 CSV，用 R 的 survival 包（KM 曲线、Cox 回归都在那里）。') },
              { label: '复杂抽样', action: () => notify('PSPP 2.1.3 没有实现复杂抽样（CSDESCRIPTIVES / CSTABULATE）。替代：用「数据 → 加权个案」近似分层权重，或导出后用 R 的 survey 包。') },
              { label: '多重插补', action: () => notify('PSPP 2.1.3 根本不认识 MULTIPLE IMPUTATION（Unknown command）。插件给了两件替代：分析 → 缺失值分析（看缺失集中在哪些变量、哪些模式）与 转换 → 替换缺失值（序列平均值 / 线性趋势 / 临近点）。这两件都不是多重插补，会低估方差，写限制时要说明。') },
              { label: '协方差分析（ANCOVA）', action: () => notify('PSPP 2.1.3 的 GLM 不接受 WITH 协变量子句。替代：用「回归 → 线性」把分组变量当哑变量、协变量当预测变量，等价于 ANCOVA 的模型。') },
              { label: '曲线估计（CURVEFIT）', action: () => notify('PSPP 2.1.3 返回「CURVEFIT 尚未实现」。替代：用「转换 → 计算变量」造 x²、ln(x)、1/x 等项，再跑「回归 → 线性」。') },
              { label: '多选题直接进 CROSSTABS 等过程', action: () => notify('PSPP 不认 $ 变量。替代：多选题的频数与交叉表由本插件自己算——「转换 → 多选题面板」；要进其他过程，先把选项拆成二分变量。') },
              { label: 'Durbin-Watson 残差自相关', action: () => notify('PSPP 的 REGRESSION 没有 /STATISTICS=DURBIN（只支持 COEFF、R、ANOVA、BCOV、CI、TOL）。替代：回归时勾「保存残差」，导出 CSV 后按公式算 DW。') },
              { label: '决策树 / 报表 / 概率图', action: () => notify('TREE、REPORT、PPLOT 在 PSPP 2.1.3 都没有实现。替代：P-P/Q-Q 图可用「分析 → 探索」里的正态概率图近似；报表用「表 1 / 表 2」或导出 Word。偏相关由插件自己实现，在「相关 → 偏相关…」。') },
            ] },
          ],
        },
        {
          label: '图形', items: [
            { label: '条形图…', action: () => setDialog({ kind: 'chart', type: 'bar' }) },
            { label: '直方图…', action: () => setDialog({ kind: 'chart', type: 'histogram' }) },
            { label: '箱线图…', action: () => setDialog({ kind: 'chart', type: 'boxplot' }) },
            { label: '折线图…', action: () => setDialog({ kind: 'chart', type: 'line' }) },
            { label: '饼图…', action: () => setDialog({ kind: 'chart', type: 'pie' }) },
            { label: '面积图…', action: () => setDialog({ kind: 'chart', type: 'area' }) },
            { label: '散点图…', action: () => setDialog({ kind: 'chart', type: 'scatterplot' }) },
            { label: '图表拼版…', action: () => setDialog({ kind: 'chartGrid' }) },
            {
              label: '快速图形（用当前选中的列）',
              sub: [
                { label: '柱状图', action: () => quickChart('bar') },
                { label: '直方图', action: () => quickChart('histogram') },
                { label: '箱线图', action: () => quickChart('boxplot') },
                { label: '饼图', action: () => quickChart('pie') },
                { label: '折线图', action: () => quickChart('line') },
              ],
            },
          ],
        },
        {
          label: '实用程序', items: [
            { label: '运行语法', action: () => run(syntax, false, '语法') },
            { label: '清除输出', action: async () => { await api('api/clear', { sessionId }); await refresh() } },
          ],
        },
        {
          label: '设置', items: [
            { label: '选项…', action: () => setDialog({ kind: 'settings' }) },
            { sep: true },
            { label: '关于本插件…', action: () => notify('内置 PSPP 引擎 + SPSS 风格工作台；统计过程由 PSPP 执行。') },
          ],
        },
        {
          label: '帮助', items: [
            { label: '快捷键一览…', action: () => setDialog({ kind: 'shortcuts' }) },
            { label: '检查更新…', action: () => { void checkForUpdate() } },
            { label: '关于 PSPP 分析', action: () => setDialog({ kind: 'about' }) },
          ],
        },
      ])

      const variables = st?.dataset?.variables ?? []
      const allItems = st?.items ?? []
      // Output search narrows the document list to the items whose title, table
      // or figure alt text contains the query; the status bar shows the count.
      const items = outputQuery
        ? allItems.filter((item) => {
          const haystack = [item.title, item.alt, item.table?.caption, tableToCsv(item.table?.matrix)]
            .filter(Boolean).join('\n').toLowerCase()
          return haystack.includes(outputQuery.toLowerCase())
        })
        : allItems

      const command = async (key) => {
        if (key === 'open') setBrowser({ mode: 'open' })
        else if (key === 'save') await saveAs()
        else if (key === 'frequencies') runAnalysis('frequencies')
        else if (key === 'descriptives') runAnalysis('descriptives')
        else if (key === 'crosstabs') runAnalysis('crosstabs')
        else if (key === 'correlation') runAnalysis('correlation')
        else if (key === 'regression') runAnalysis('regression')
        else if (key === 'clear') { await api('api/clear', { sessionId }); await refresh() }
      }

      const runAction = (action) => {
        setMenu(null)
        Promise.resolve(action?.()).catch((error) => notify(error.message))
      }

      // SPSS right-aligns the accelerator in grey at the far edge of the item.
      // Menu labels carry it inline ("撤销（Ctrl+Z）"), so split that tail off
      // and render it as its own span — the button's textContent is unchanged.
      const KEYS_RE = /^(.*?)[（(]((?:Ctrl|Alt|Shift|F\d)[^）)]*)[）)]$/
      const menuLabel = (label) => {
        const match = KEYS_RE.exec(String(label ?? ''))
        // Translate first, split second. Splitting first meant `撤销（Ctrl+Z）`
        // reached the dictionary as two pieces, the key never matched, and the
        // menu kept its Chinese word in English mode.
        if (!match) return [h('span', { key: 'text' }, tr(label))]
        // The dictionary can carry the whole entry (`撤销（Ctrl+Z）`) or just the
        // word; try the whole string first so a menu item is never left in
        // Chinese while its shortcut is shown separately.
        const whole = tr(label)
        if (whole !== label) return [h('span', { key: 'text' }, whole)]
        const word = tr(match[1])
        return word === match[1]
          ? [h('span', { key: 'text' }, label)]
          : [h('span', { key: 'text' }, word), h('span', { key: 'keys', className: 'ap-keys' }, match[2])]
      }
      const renderMenuItems = (list) => list.map((item, index) => item.sep
        ? h('div', { key: `sep-${index}`, className: 'ap-sep' })
        : h('div', {
          key: item.label,
          className: item.sub ? 'ap-has-sub' : undefined,
          style: { position: 'relative' },
        },
        h('button', {
          disabled: item.disabled === true,
          onClick: () => { if (!item.sub) runAction(item.action) },
        }, ...menuLabel(item.label), item.sub ? h('span', { className: 'ap-sub' }, '▸') : null),
        item.sub ? h('div', { className: 'ap-sub-pop' }, renderMenuItems(item.sub)) : null))

      // SPSS puts the open dataset's shape at the left of the status bar and
      // the engine/status chatter at the right. Keeping the two strings apart
      // is what lets the bar pin them to opposite edges.
      // A truncated dataset looks exactly like a small one: the case count is the
      // only number that would tell, and nobody knows how many rows the file had.
      // Say it, and say that the analysis still runs on everything.
      const clipped = st?.dataset?.truncated === true
      const caseText = st
        ? (st.dataset
          ? [`${tr('{0} 个个案', st.dataset.caseCount)}${clipped ? '+' : ''}`, tr('{0} 个变量', st.dataset.variables.length), st.dataset.dirty ? tr('未保存') : null]
            .filter(Boolean).join(' · ')
          : '未打开数据集')
        : '正在连接分析引擎…'
      const sourceText = st?.dataset ? describeSource(st.dataset) : ''
      const status = sourceText ? `${caseText}  |  ${sourceText}` : caseText
      const engineHint = st
        ? (() => { const kind = tr(st.engine.source === 'bundled' ? '内置' : st.engine.source === 'system' ? '系统' : '缺失'); return tr('引擎：{0}（{1}）', kind, st.engine.bin ?? '—') })()
        : ''
      // SPLIT FILE / WEIGHT / FILTER survive between runs but are invisible in
      // the data grid, so a filter left on from ten minutes ago silently changes
      // every number below it. The chips make that state impossible to miss.
      const clearSession = (syntax) => { void run(syntax, false, '取消会话设置') }
      const sessionChips = [
        st?.splitBy?.length
          ? {
            label: tr('拆分：{0}', st.splitBy.join(' ')),
            title: 'SPLIT FILE 正在生效：每个结果按该变量的取值分组输出',
            onClear: () => clearSession('SPLIT FILE OFF.'),
          }
          : null,
        st?.weightBy
          ? {
            label: tr('加权：{0}', st.weightBy),
            title: 'WEIGHT BY 正在生效：频数/分析按该变量加权',
            onClear: () => clearSession('WEIGHT OFF.'),
          }
          : null,
        st?.filterBy
          ? {
            label: tr('筛选：{0}', st.filterBy),
            title: 'FILTER BY 正在生效：该变量为 0 或缺失的个案被临时排除',
            onClear: () => clearSession('FILTER OFF.'),
          }
          : null,
        st?.selectIf
          ? {
            label: st.selectIf,
            title: 'SELECT IF 已经把不满足条件的个案从数据集里删除，无法用 × 取消',
            onClear: null,
          }
          : null,
      ].filter(Boolean)

      return h('div', {
        className: 'ap-root',
        ref: rootRef,
        style: { position: 'relative' },
        // The skin centre's second level may style `[data-dsh-plugin=…]`, and a
        // skin can then target parts of this panel without guessing class names.
        'data-dsh-plugin': 'analytics',
        'data-dsh-surface': 'panel',
        'data-dsh-part': 'panel',
        onDragEnter: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(true)
        },
        onDragOver: (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!dragging) setDragging(true)
        },
        // dragleave also fires when the pointer crosses into a child node, so
        // only a leave that leaves the panel entirely ends the drop state.
        onDragLeave: (event) => {
          event.stopPropagation()
          const next = event.relatedTarget
          if (!next || !event.currentTarget.contains(next)) setDragging(false)
        },
        onDrop: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          uploadFiles(event.dataTransfer?.files)
        },
      },
        dragging ? h('div', { className: 'ap-drop' }, '松开即可打开这个数据文件') : null,
        st?.mrSets?.length > 0
          ? h(MrPanel, {
            sets: st.mrSets,
            variables,
            active: activeMr ?? st.mrRead,
            percentBase: mrPercentBase,
            onAction: mrAction,
            onPercentBase: setMrPercentBase,
            onEdit: (entry) => setDialog({ kind: 'mrsets', set: entry }),
            onClose: () => setMrOpen(false),
            addAria: () => setDialog({ kind: 'mrsets' }),
          })
          : null,
        cellMenu ? (() => {
          // Keep a menu opened near the bottom edge on screen: it is ~300px
          // tall, and a clipped item is an item the user cannot reach.
          const menuHeight = 320
          const menuWidth = 230
          const top = Math.min(cellMenu.y, Math.max(8, window.innerHeight - menuHeight))
          const left = Math.min(cellMenu.x, Math.max(8, window.innerWidth - menuWidth))
          return h('div', {
            className: 'ap-var-menu',
            style: { position: 'fixed', left, top, zIndex: 60 },
            // The sheet re-renders on every poll; the menu itself must not be
            // dismissed by a click that lands inside it.
            onMouseDown: (event) => event.stopPropagation(),
          },
          h('div', { className: 'ap-menu-label' },
            cellMenu.variable
              ? tr('{0} · 第 {1} 行', cellMenu.variable, cellMenu.row + 1)
              : tr('第 {0} 行（还没有变量）', cellMenu.row + 1)),
          h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('copy') }, '复制这个值'),
          h('div', { className: 'ap-sep' }),
          h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('insertCase') }, tr('在第 {0} 行前插入个案', cellMenu.row + 1)),
          h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('deleteCase') }, tr('删除第 {0} 个个案', cellMenu.row + 1)),
          cellMenu.variable
            ? h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('sortAsc') }, tr('整表按 {0} 升序', cellMenu.variable))
            : null,
          cellMenu.variable
            ? h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('sortDesc') }, tr('整表按 {0} 降序', cellMenu.variable))
            : null,
          h('div', { className: 'ap-sep' }),
          cellMenu.variable
            ? h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('clear') }, '清空这个格子')
            : null,
          cellMenu.variable && cellMenu.numeric
            ? h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('missing') }, '设为系统缺失值')
            : null,
          h('button', { className: 'ap-var-item', onClick: () => { const row = cellMenu.row; setCellMenu(null); setDialog({ kind: 'goto', value: String(row + 1) }) } }, '跳转到个案…'),
          cellMenu.variable && cellMenu.numeric
            ? h('div', { className: 'ap-sep' })
            : null,
          cellMenu.variable && cellMenu.numeric
            ? h('button', {
              className: 'ap-var-item',
              onClick: () => { setCellMenu(null); quickChart('histogram') },
            }, tr('画 {0} 的直方图', cellMenu.variable))
            : null)
        })()
          : null,
        h('div', { className: 'ap-menu', ref: menuBarRef },
          menus.map((entry, index) => h('div', { key: entry.label, className: 'ap-menu-item' },
            h('button', {
              className: `ap-menu-button ${menu === entry.label ? 'ap-open' : ''}`,
              onClick: () => setMenu(menu === entry.label ? null : entry.label),
            }, entry.label),
            menu === entry.label
              ? h('div', {
                // The sidebar is narrow: right-side menus must grow leftwards
                // or their popup runs off the edge of the panel.
                className: `ap-menu-pop ${index >= menus.length - 3 ? 'ap-flip' : ''}`,
              }, renderMenuItems(entry.items))
              : null))),
        !showToolbar ? null : h('div', {
          className: 'ap-toolbar',
          onMouseOver: onToolbarOver,
          onMouseOut: onToolbarOut,
          onMouseLeave: onToolbarLeave,
        },
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '打开数据', 'aria-label': '打开数据', onClick: () => command('open'),
          }, apIcon('open')),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '保存数据', 'aria-label': '保存数据', onClick: () => command('save'), disabled: !st?.dataset,
          }, apIcon('save')),
          h('button', {
            className: 'ap-tool ap-icon-btn',
            onClick: toggleLabels,
            disabled: !variables.length,
            title: showLabels ? '数据视图正在显示值标签，点一下改显示原始数值' : '数据视图正在显示原始数值，点一下改显示值标签',
            'aria-label': showLabels ? '显示：标签' : '显示：数值',
          }, apIcon('labels')),
          h('span', { className: 'ap-tool-sep' }),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '频率', 'aria-label': '频率', onClick: () => command('frequencies'), disabled: !variables.length,
          }, apIcon('frequency')),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '描述', 'aria-label': '描述', onClick: () => command('descriptives'), disabled: !variables.length,
          }, apIcon('descriptives')),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '交叉表', 'aria-label': '交叉表', onClick: () => command('crosstabs'), disabled: !variables.length,
          }, apIcon('crosstabs')),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '相关', 'aria-label': '相关', onClick: () => command('correlation'), disabled: !variables.length,
          }, apIcon('correlation')),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '回归', 'aria-label': '回归', onClick: () => command('regression'), disabled: !variables.length,
          }, apIcon('regression')),
          h('span', { className: 'ap-tool-sep' }),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '运行语法', 'aria-label': '运行语法', onClick: () => run(syntax, false, '语法'),
          }, apIcon('syntax')),
          h('button', {
            className: 'ap-tool ap-icon-btn', title: '清除输出', 'aria-label': '清除输出', onClick: () => command('clear'),
          }, apIcon('clear')),
          busy ? h('span', { className: 'ap-hint' }, '处理中…') : null),
        // Above the document tabs, below the toolbar: a notice, not a
        // replacement — the panel keeps working without the preset.
        presetId && presetId !== 'analytics' && !presetBannerHidden
          ? h('div', { className: 'ap-preset-bar', role: 'status' },
            h('span', { className: 'ap-preset-bar-text' },
              tr('本会话没有启用「统计分析」预设：智能体看不到 pspp_* 工具，但面板本身仍可直接操作数据。新建会话时选「统计分析」预设即可同时启用工具。')),
            h('button', {
              className: 'ap-preset-bar-close',
              onClick: () => {
                try { window.localStorage?.setItem('ap.hidePresetBanner', '1') } catch { /* 存不下就只隐藏这一次 */ }
                setPresetBannerHidden(true)
              },
            }, tr('不再提示')))
          : null,
        docs.length > 1 || (docs.length === 1 && Boolean(st?.dataset))
          ? h('div', { className: 'ap-doctabs' },
            docs.map((doc) => h('div', {
              key: doc.id,
              className: `ap-doctab ${doc.id === sessionId ? 'ap-active' : ''}`,
            },
            h('button', {
              className: 'ap-doctab-title',
              title: doc.id === sessionId
                ? status
                : doc.sessionId === 'default'
                  ? tr('{0}（面板默认文档，可能来自上一轮）', doc.title || doc.id)
                  : doc.sessionId ? tr('{0}（会话 {1}）', doc.title || doc.id, doc.sessionId.slice(-6)) : (doc.title || doc.id),
              onClick: () => switchDoc(doc.id),
            }, doc.title || (doc.id === sessionId ? st?.dataset?.name : '') || '数据集'),
            h('button', {
              className: 'ap-doctab-close',
              title: '关闭这个数据集',
              onClick: () => closeDoc(doc.id, doc.dirty === true),
            }, '×'))))
          : null,
        h('div', { className: 'ap-body' },
          view === 'data'
            ? (!st?.dataset
              ? h('div', { className: 'ap-empty' },
                h('div', null, '尚未打开数据集'),
                h('div', null, h('button', { className: 'ap-tool', onClick: () => setBrowser({ mode: 'open' }) }, '打开数据文件…')),
                h('div', { className: 'ap-hint' }, '支持 .sav / .por / .csv / .txt / .tsv'))
              : h(DataGrid, {
                variables,
                rows,
                total,
                onLoadMore: loadMore,
                onEdit: editCell,
                selected,
                onSelect: setSelected,
                showLabels,
                gridLines: showGridLines,
                widths: colWidths,
                onWidth: setColWidth,
                onPaste: async (cells, options) => {
                  try {
                    const value = await api('api/paste', { sessionId, cells, extend: options?.extend === true })
                    setSt(stateOf(value))
                    const added = []
                    if (value.result?.addedCases) added.push(tr('新增 {0} 个个案', value.result.addedCases))
                    if (value.result?.addedVariables) added.push(tr('新增 {0} 个变量', value.result.addedVariables))
                    // The host answers with state only, which carries the shape
                    // but not the cells: patch the rows we already show, and
                    // reload the window when the paste changed the shape.
                    if (added.length > 0) {
                      await loadRows(0, Math.max(500, rows.length))
                    } else {
                      const byName = new Map((value.state?.dataset?.variables ?? st?.dataset?.variables ?? [])
                        .map((variable, column) => [variable.name, column]))
                      setRows((current) => {
                        const next = current.map((entry) => [...entry])
                        for (const cell of cells) {
                          const column = byName.get(cell.variable)
                          if (next[cell.row] && column !== undefined) next[cell.row][column] = cell.value
                        }
                        return next
                      })
                    }
                    setToast(tr('已粘贴 {0} 个单元格{1}', cells.length, added.length ? tr('（{0}）', added.join('、')) : ''))
                    window.setTimeout(() => setToast(null), 2500)
                  } catch (error) {
                    notify(error.message)
                  }
                },
                // A spare cell starts a new variable: name it V<n>, add it, then
                // open the variable editor with that name ready to be changed.
                onNewVariable: async (_offset, value, row) => {
                  const taken = new Set(variables.map((variable) => variable.name))
                  let index = variables.length + 1
                  while (taken.has(`V${index}`)) index += 1
                  const name = `V${index}`
                  const numeric = value !== undefined && value !== '' && Number.isFinite(Number(value))
                  try {
                    await api('api/variable', { sessionId, action: 'add', spec: { name, type: numeric ? 'numeric' : 'string', width: numeric ? 12 : Math.max(8, Math.min(255, String(value ?? '').length)), decimals: numeric ? 2 : 0 } })
                    const state = await refresh()
                    if (value !== undefined && value !== '') {
                      const lastRow = Math.max(0, (state?.dataset?.caseCount ?? 1) - 1)
                      const target = Math.min(row ?? 0, lastRow)
                      const fill = await api('api/cell', { sessionId, row: target, variable: name, value })
                      setSt(fill.state)
                      setRows((current) => current.map((entry, line) => (line === target ? [...entry, fill.result.value] : entry)))
                    }
                  } catch (error) {
                    notify(error.message)
                  }
                },
                rowHeight,
                freeze: { rows: freezeRows, cols: freezeCols },
                onMoveVariable: async (name, position) => {
                  try {
                    const value = await api('api/variable', { sessionId, action: 'move', name, position })
                    setSt(stateOf(value))
                  } catch (error) {
                    notify(error.message)
                  }
                },
                onCellMenu: (target) => setCellMenu(target),
              }))
            : view === 'variables'
              ? (st?.dataset
                ? h(VariableGrid, {
                  variables,
                  jumpTo: variableJump,
                  widths: colWidths,
                  onWidth: setColWidth,
                  onUpdate: async (name, patch) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'update', name, patch })
                      setSt(stateOf(value))
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onBatch: (names) => setDialog({ kind: 'variableBatch', names }),
                  onAdd: async (name) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'add', spec: { name } })
                      setSt(stateOf(value))
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onRename: async (from, to) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'update', name: from, patch: { name: to } })
                      setSt(stateOf(value))
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onMove: async (name, position) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'move', name, position })
                      setSt(stateOf(value))
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onDelete: async (name) => {
                    const value = await api('api/variable', { sessionId, action: 'delete', name })
                    setSt(stateOf(value))
                  },
                  onEditLabels: (variable) => setLabelsDialog({
                    name: variable.name,
                    text: Object.entries(variable.valueLabels ?? {}).map(([key, label]) => `${key}=${label}`).join('\n'),
                  }),
                })
                : h('div', { className: 'ap-empty' }, '尚未打开数据集'))
              : view === 'syntax'
                ? h('div', { className: 'ap-syntax' },
                  h(SyntaxEditor, {
                    value: syntax,
                    onChange: setSyntax,
                    onRun: () => run(syntax, false, '语法'),
                    variableNames: variables.map((variable) => variable.name),
                    placeholder: '在此输入 PSPP 语法或导入 sps 语法文件，例如：\nFREQUENCIES /VARIABLES=gender.\n\nCtrl+Enter 运行',
                  }),
                  h('div', { className: 'ap-syntax-bar' },
                    h('button', { className: 'ap-tool', onClick: () => run(syntax, false, '语法'), disabled: busy }, '运行'),
                    h('button', { className: 'ap-tool', onClick: () => run(syntax, true, '语法（写入数据）'), disabled: busy || !st?.dataset }, '运行并保存数据'),
                    h('span', { className: 'ap-hint' }, 'Ctrl+Enter 运行；会产生数据变更的语法请用「运行并保存数据」')))
                : h(OutputDoc, {
                  items,
                  state: st ?? { id: sessionId },
                  onEditChart: (chart) => setDialog({ kind: 'chart', ...chart }),
                  tableEdits,
                  onEditTable: (item) => setDialog({ kind: 'tableedit', item }),
                  // SPSS 的导出能只导选中的输出；这张表就在眼前，比先在菜单里
                  // 选范围再回头找表更快。
                  onExportItem: (item) => setBrowser({ mode: 'office', format: 'xlsx', scope: 'session', only: [item.id], title: item.title }),
                  onPairwise: (defaults) => setDialog({ kind: 'pairwise', defaults }),
                  // A ROC curve on the fitted model would need the saved
                  // probability; without it the honest prefill is the raw
                  // predictor, and the dialog says which one it picked.
                  onRoc: (defaults) => setDialog({
                    kind: 'analysis',
                    spec: ANALYSIS_SPECS.roc,
                    initial: {
                      variable: (defaults.variables ?? [])[0] ?? null,
                      by: defaults.by ?? null,
                    },
                  }),
                  onExportChart: (item, format) => setBrowser({
                    mode: 'chartExport',
                    runId: item.runId,
                    format,
                    scale: pngScale,
                    title: item.title || item.alt || 'chart',
                  }),
                  pngScale,
                  onPickScale: (value) => setPngScale(value),
                  onRedrawChart: (item) => setDialog({ kind: 'redraw', runId: item.runId, title: item.title, from: item.chartSpec?.kind ?? null }),
                  tableStyle,
                  picks: reportPick,
                  onInsertRunSyntax: (runId) => {
                    const text = syntaxForRun(runId)
                    if (!text) { notify(tr('这一批运行的语法没有记下来（升级前的运行）')); return }
                    insertSyntax(text, { replace: true })
                  },
                  onReplayRun: (runId) => {
                    const entry = runHistory.find((item) => String(item.runId) === String(runId))
                    if (!entry) { notify(tr('这一批运行的语法没有记下来（升级前的运行）')); return }
                    void run(entry.text, entry.persist === true, entry.title)
                  },
                  onTogglePick: (id) => (id === '__clear__' ? setReportPick(new Set()) : toggleReportPick(id)),
                  onReportExport: () => setBrowser({ mode: 'report', format: 'pdf' }),
                  onRemove: async (id) => {
                    const value = await api('api/output', { sessionId, action: 'remove', id })
                    setSt(stateOf(value))
                  },
                })),
        // SPSS 的 Data Editor 与 Viewer 都把视图页签放在内容区下方，
        // 状态栏再压在页签下面：内容区 → 页签条 → 状态栏。
        h('div', { className: 'ap-tabstrip' },
          ['data', 'variables', 'syntax', 'output'].map((key) => h('button', {
            key,
            className: `ap-view-tab ${view === key ? 'ap-active' : ''}`,
            onClick: () => setView(key),
          }, { data: '数据视图', variables: '变量视图', syntax: '语法', output: '输出' }[key]))),
        // 状态栏 22px：左边是数据的形状（个案/变量），右边是来源、引擎与告警。
        h('div', { className: 'ap-status' },
          h('span', { className: 'ap-status-cases', title: status }, caseText),
          clipped
            ? h('span', {
              className: 'ap-chip',
              title: tr('数据视图按「数据视图最多载入个案数」只载入了前 {0} 例（设置 → 统计分析 可改）。分析、保存与导出仍在完整数据上跑。', st.dataset.caseCount),
            }, tr('截断显示 {0} 例', st.dataset.caseCount))
            : null,
          sessionChips.length > 0
            ? h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              ...sessionChips.map((chip) => h('span', { className: 'ap-chip', title: chip.title },
                chip.label,
                chip.onClear
                  ? h('span', { className: 'ap-chip-x', title: '取消这个设置', onClick: chip.onClear }, '×')
                  : null)))
            : null,
          outputQuery
            ? h('span', { className: 'ap-hint' }, tr('输出筛选「{0}」：{1}/{2}', outputQuery, items.length, allItems.length),
              h('button', { className: 'ap-tool', style: { marginLeft: 6 }, onClick: () => setOutputQuery('') }, '清除'))
            : null,
          h('span', { className: 'ap-grow' }),
          h('span', { className: 'ap-status-right' },
            engineHint
              ? h('span', { title: engineHint }, st?.engine?.source === 'bundled' ? '引擎：内置' : (st?.engine?.source === 'system' ? '引擎：系统' : '引擎：缺失'))
              : null,
            h('span', { title: st?.lastError?.raw ?? '' },
              st?.lastError
                ? `${tr('最近错误：{0}', st.lastError.message)}${st.lastError.hint ? ` — ${st.lastError.hint}` : ''}`
                : '就绪'),
            // A toast is gone in four seconds; the list of renamed columns is
            // what the user goes looking for later, when a column is not where
            // the spreadsheet said it was.
            (st?.importNotes ?? []).length > 0
              ? h('button', {
                className: 'ap-tool',
                title: '导入时哪些列名被改过、原名保存在哪里',
                onClick: () => setDialog({ kind: 'importNotes', notes: st.importNotes }),
              }, tr('导入说明 {0}', st.importNotes.length))
              : null,
            st?.conflictCount > 0
              ? h('span', {
                key: 'conflicts',
                className: 'ap-status-conflicts',
                title: tr('{0} 次写入被拒：另一个窗口在你编辑期间改过这份数据，那几次修改没有写入（原因见 设置 → 选项 → 冲突记录；导出的表格会带上次数）', st.conflictCount),
              }, tr(`冲突 ${st.conflictCount}`))
              : null,
            st?.version
              ? h('span', { className: 'ap-status-version', title: tr('插件版本 {0}（改后端代码后停用再启用本插件即可生效，但要重新打开数据文件）', st.version) }, `v${st.version}`)
              : null)),
        toast ? h('div', { className: 'ap-toast' }, toast) : null,
        // The refused write becomes a question. Three answers, and the one the
        // user picks is the one that happens — nothing here overwrites data or
        // throws an edit away on its own.
        conflict
          ? h(Modal, {
            title: '这次修改没有写入',
            wide: true,
            hideCancel: true,
            okText: '关闭（放弃这次修改）',
            onOk: () => resolveConflict('cancel'),
            onCancel: () => resolveConflict('cancel'),
          }, h('div', { className: 'ap-conflict' }, [
            h('p', null, conflict.conflict.lastWriter
              ? '另一个窗口在你编辑期间改过这份数据，所以这次修改被拒绝了。磁盘上现在是对方的那一版。'
              : '对话里的分析在你编辑期间改过这份数据，所以这次修改被拒绝了。磁盘上现在是分析结果那一版。'),
            h('p', { className: 'ap-hint' },
              tr('你的版本：第 {0} 次改动 · 磁盘上的版本：第 {1} 次改动', conflict.conflict.expected ?? '?', conflict.conflict.actual ?? '?')),
            h('div', { className: 'ap-conflict-actions' }, [
              h('button', {
                className: 'ap-btn ap-danger',
                onClick: () => resolveConflict('override'),
                title: '带着 force 重发刚才那次修改，覆盖对方写进去的内容',
              }, '覆盖：仍然写入我这次修改（会盖掉对方刚写的内容）'),
              h('button', {
                className: 'ap-btn',
                onClick: () => resolveConflict('reload'),
                title: '放弃刚才那次修改，把磁盘上最新的数据读进来',
              }, '重载：丢弃我的修改，载入最新数据'),
            ]),
            h('p', { className: 'ap-hint' }, '关闭 = 放弃这次修改，不会写入任何东西（下次写入会按磁盘上的最新版本判定），被拒的值不会留存。'),
            h('p', { className: 'ap-hint' }, '无论选哪个，都已经被记进「冲突记录」：状态栏的角标和导出的表格都会带上次数。'),
          ]))
          : null,
        dialog?.kind === 'settings'
          ? h(Modal, {
            title: '设置：统计分析',
            wide: true,
            okText: '保存',
            cancelText: '取消',
            onOk: async () => {
              const save = settingsSave.current
              const saved = typeof save === 'function' ? await save() : true
              if (saved) setDialog(null)
            },
            onCancel: () => setDialog(null),
          }, h(SettingsForm, { onDone: () => setDialog(null), saveRef: settingsSave }))
          : null,
        dialog?.kind === 'importNotes'
          ? h(Modal, {
            title: '导入说明：列名为什么改了',
            wide: true,
            hideCancel: true,
            okText: '知道了',
            onOk: () => setDialog(null),
            onCancel: () => setDialog(null),
          },
          h('div', { className: 'ap-hint', style: { marginBottom: 8, lineHeight: 1.6 } },
            'PSPP 的变量名只能用 ASCII 字母、数字和下划线，最多 64 个字符，且不能重名。下面这些列的表头不符合规则，已经改名；原表头保留为变量标签（「变量视图 → 标签」列，输出表通常按标签显示），数据本身没有丢。'),
          h('ul', { style: { margin: 0, paddingLeft: 18, lineHeight: 1.7 } },
            ...dialog.notes.map((note, index) => h('li', { key: index }, note))))
          : null,
        dialog?.kind === 'gotoVariable'
          ? h(Modal, {
            title: '转到变量',
            okText: '跳转',
            okDisabled: String(dialog.value ?? '').trim() === '',
            onCancel: () => setDialog(null),
            onOk: () => {
              const name = String(dialog.value ?? '').trim()
              if (!name) return
              const exists = (st?.dataset?.variables ?? []).some((variable) => variable.name === name)
              setDialog(null)
              setView('variables')
              setVariableJump({ name, seq: Date.now() })
              if (!exists) notify(tr('没有这个变量：{0}', name))
            },
          },
          h(Field, { label: '变量名', hint: '输入名字后点「跳转」，下面列出全部变量' },
            h('input', {
              autoFocus: true,
              value: dialog.value ?? '',
              list: 'ap-goto-variables',
              onChange: (event) => setDialog({ ...dialog, value: event.target.value }),
            })),
          h('datalist', { id: 'ap-goto-variables' },
            variables.map((variable) => h('option', { key: variable.name, value: variable.name }))))
          : null,
        dialog?.kind === 'analysis'
          ? h(AnalysisDialog, {
            spec: dialog.spec,
            initial: dialog.initial ?? null,
            variables,
            rows,
            onClose: () => setDialog(null),
            // 粘贴 keeps the dialog's work without spending a run: the syntax
            // lands in the editor, the dialog closes, nothing executes.
            onPaste: (syntax) => {
              // SPSS appends: 粘贴 in three dialogs in a row builds one program.
              // Replacing would silently throw away what the user already wrote.
              setSyntax((current) => {
                const text = String(current ?? '').replace(/\s+$/, '')
                return text ? `${text}\n${syntax}` : syntax
              })
              setView('syntax')
              setDialog(null)
            },
            onRun: async (built, spec) => {
              if (built?.error) { notify(tr(built.error)); return }
              if (built?.restructure) {
                await runRestructure(built.restructure, spec?.title)
                return
              }
              if (built?.duplicates) {
                await runDuplicates(built.duplicates, spec?.title)
                return
              }
              if (built?.outliers) {
                await runOutliers(built.outliers, spec?.title)
                return
              }
              if (built?.missing) {
                await runMissing(built.missing, spec?.title)
                return
              }
              if (built.chart) {
                await runChart(built.chart)
                return
              }
              await run(built.syntax, built.persist === true, spec?.title, built.pairwise, built.regression, built.roc, built.exact, built.exactChi, built.contrasts)
              // Regression plots are drawn after the tables, from the same fit,
              // so a failed run leaves no orphan picture behind.
              if (Array.isArray(built.plots) && built.plots.length > 0 && built.regression) {
                for (const plot of built.plots) {
                  try {
                    const value = await api('api/regressionPlot', { sessionId, kind: plot, regression: built.regression })
                    setSt(stateOf(value))
                  } catch (error) {
                    notify(error.message)
                  }
                }
              }
            },
          })
          : null,
        dialog?.kind === 'redraw'
          ? h(RedrawChartDialog, {
            runId: dialog.runId,
            title: dialog.title,
            from: dialog.from,
            onClose: () => setDialog(null),
            onRun: async ({ runId, type }) => {
              setDialog(null)
              setBusy(true)
              try {
                const value = await api('api/chart/redraw', { sessionId, runId, type })
                setSt(stateOf(value))
                notify(tr('已重绘（{0}）', tr(type)))
              } catch (error) {
                notify(error.message)
              } finally {
                setBusy(false)
              }
            },
          })
          : null,
        dialog?.kind === 'chartGrid'
          ? h(ChartGridDialog, {
            items: st?.items ?? [],
            preselected: [...reportPick],
            onClose: () => setDialog(null),
            onRun: async ({ items: ids, layout }) => {
              setDialog(null)
              setBusy(true)
              try {
                const value = await api('api/chartGrid', { sessionId, items: ids, layout })
                setSt(stateOf(value))
                notify(tr('已拼版 {0} 张图（{1}）', ids.length, layout === '1x2' ? '1 × 2' : layout === '2x1' ? '2 × 1' : '2 × 2'))
              } catch (error) {
                notify(error.message)
              } finally {
                setBusy(false)
              }
            },
          })
          : null,
        dialog?.kind === 'chart'
          ? h(ChartEditDialog, {
            title: dialog.title,
            onClose: () => setDialog(null),
            onApply: async (patch) => {
              setDialog(null)
              try {
                const value = await api('api/chart/update', { sessionId, runId: dialog.runId, ...patch })
                setSt(stateOf(value))
                notify('图表已更新')
              } catch (error) {
                notify(error.message)
              }
            },
          })
          : null,
        toolTip
          ? h('div', {
            className: 'ap-tip',
            style: { left: toolTip.x, top: toolTip.y },
            // The tip must never eat the hover that produced it.
            // role="tooltip" is deliberately absent: the host skins style
            // [role=tooltip] with their own background and colour tokens at a
            // higher specificity, which turned this tip into dark text on a dark
            // bar (measured 1.06:1). The tooltip is also announced through
            // aria-describedby on the button, so no role is needed here.
            'aria-hidden': 'true',
          }, tr(toolTip.text))
          : null,
        dialog?.kind === 'variableBatch'
          ? h(VariableBatchDialog, {
            names: dialog.names,
            onClose: () => setDialog(null),
            onRun: async (patch) => {
              setDialog(null)
              try {
                const value = await api('api/variable', { sessionId, action: 'updateMany', names: dialog.names, patch })
                setSt(stateOf(value))
                notify(tr('已修改 {0} 个变量', dialog.names.length))
              } catch (error) {
                notify(error.message)
              }
            },
          })
          : null,
        dialog?.kind === 'templates'
          ? h(Modal, {
            title: '语法模板库',
            wide: true,
            onCancel: () => setDialog(null),
            okText: '关闭',
            onOk: () => setDialog(null),
          },
          h('div', { className: 'ap-hint' }, tr('点一条就插到语法页末尾：尖括号里的是占位符，换成你自己的变量名再运行。')),
          h('div', { className: 'ap-tmpl' },
            TEMPLATE_GROUPS.map((group) => h('div', { className: 'ap-tmpl-group', key: group },
              h('div', { className: 'ap-tmpl-head' }, tr(group)),
              SYNTAX_TEMPLATES
                .filter((entry) => entry.group === group)
                .map((entry) => h('button', {
                  key: entry.label,
                  className: 'ap-tmpl-item',
                  title: entry.syntax,
                  onClick: () => insertSyntax(entry.syntax),
                },
                h('span', { className: 'ap-tmpl-label' }, tr(entry.label)),
                h('code', { className: 'ap-tmpl-code' }, entry.syntax.split('\n')[0])))))))
          : null,
        dialog?.kind === 'runs'
          ? h(Modal, {
            title: '运行历史',
            wide: true,
            onCancel: () => setDialog(null),
            okText: '关闭',
            onOk: () => setDialog(null),
          },
          runHistory.length === 0
            ? h('div', { className: 'ap-hint' }, tr('这次会话还没有运行过分析。'))
            : h('div', { className: 'ap-runs' },
              runHistory.map((entry) => h('div', { className: 'ap-run-row', key: `${entry.runId}-${entry.at}` },
                h('span', { className: 'ap-run-when' }, tr('运行 {0}', String(entry.runId))),
                h('span', { className: 'ap-run-title' }, entry.title ? tr(entry.title) : tr('（未命名）')),
                h('code', { className: 'ap-run-syntax' }, String(entry.text).split('\n')[0].slice(0, 60)),
                h('span', { className: 'ap-grow' }),
                h('button', { className: 'ap-tool', onClick: () => insertSyntax(entry.text, { replace: true }) }, '插入语法'),
                h('button', {
                  className: 'ap-tool',
                  onClick: () => { setDialog(null); void run(entry.text, entry.persist === true, entry.title) },
                }, '重跑')))))
          : null,
        dialog?.kind === 'import'
          ? h(ImportDialog, {
            path: dialog.path,
            hasHeader: dialog.hasHeader,
            onClose: () => setDialog(null),
            onRun: async (importOptions) => {
              const { path, seed, title } = dialog
              setDialog(null)
              await openPath(path, { seed, title, import: importOptions })
            },
          })
          : null,
        dialog?.kind === 'goto' || dialog?.kind === 'outputSearch'
          ? h(Modal, {
            title: dialog.kind === 'goto' ? '跳转到个案' : '在输出中查找',
            onCancel: () => setDialog(null),
            okText: dialog.kind === 'goto' ? '跳转' : '查找',
            onOk: () => {
              if (dialog.kind === 'goto') { setDialog(null); gotoCase(dialog.value, selected?.column ?? 0) }
              else { setDialog(null); setOutputQuery(dialog.value.trim()) }
            },
          },
          h('div', { className: 'ap-row' },
            h('span', null, dialog.kind === 'goto' ? tr('个案编号（1–{0}）', total || 1) : '关键字'),
            h('input', {
              type: 'text',
              autoFocus: true,
              value: dialog.value ?? '',
              style: { flex: 1 },
              onChange: (event) => setDialog((current) => ({ ...current, value: event.target.value })),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                if (dialog.kind === 'goto') { setDialog(null); gotoCase(event.currentTarget.value, selected?.column ?? 0) }
                else { setDialog(null); setOutputQuery(String(event.currentTarget.value).trim()) }
              },
            })),
          dialog.kind === 'goto' ? null : h('div', { className: 'ap-hint' }, '留空并确定表示清除筛选。'))
          : null,
        dialog?.kind === 'mrsets'
          ? h(MrSetDialog, {
            variables,
            initial: dialog.set ?? null,
            existing: st?.mrSets ?? [],
            onClose: () => setDialog(null),
            onSave: async (setDefinition) => {
              setDialog(null)
              try {
                const value = await api('api/mrset', { sessionId, action: 'define', set: setDefinition })
                setSt(stateOf(value))
                notify(tr('已定义多选题 {0}', setDefinition.name))
              } catch (error) { notify(error.message) }
            },
          })
          : null,
        dialog?.kind === 'shortcuts'
          ? h(Modal, {
            title: '快捷键一览',
            wide: true,
            onCancel: () => setDialog(null),
            okText: '关闭',
            onOk: () => setDialog(null),
          }, h('div', { className: 'ap-keys' },
            SHORTCUTS.map((group) => h('div', { key: group.title, className: 'ap-keys-group' },
              h('div', { className: 'ap-keys-title' }, tr(group.title)),
              group.rows.map((row) => h('div', { key: row[0], className: 'ap-keys-row' },
                h('span', { className: 'ap-keys-key', translate: false }, row[0]),
                h('span', { className: 'ap-keys-what' }, tr(row[1]))))))))
          : null,
        dialog?.kind === 'about'
          ? h(Modal, {
            title: '关于 PSPP 分析',
            onCancel: () => setDialog(null),
            okText: '关闭',
            onOk: () => setDialog(null),
          }, h('div', { className: 'ap-about' },
            h('div', { className: 'ap-about-name' }, 'dsh-analytics-pspp'),
            h('div', { className: 'ap-about-line' }, tr('版本 {0}', st?.version ?? '?')),
            h('div', { className: 'ap-about-line' }, tr('引擎：{0}（GNU PSPP 2.1.3）', st?.engine?.version ?? tr('未知'))),
            h('div', { className: 'ap-about-line' }, tr('引擎来源：{0}', st?.engine?.source ?? '?')),
            h('div', { className: 'ap-about-line' }, tr('数据目录：{0}', '~/.dsh/analytics')),
            h('div', { className: 'ap-about-note' }, tr('统计过程由内置 GNU PSPP 执行；界面与注文由插件提供。PSPP 是自由软件（GPLv3），与 IBM SPSS Statistics 没有关系。')),
            h('div', { className: 'ap-about-note' }, tr('MIT License · github.com/qzhengpyuan/dsh-analytics'))))
          : null,
        dialog?.kind === 'valueLabels'
          ? h(ValueLabelDialog, {
            key: `valueLabels:${dialog.reopen ?? 0}`,
            variables,
            initial: dialog.variable,
            onClose: () => setDialog(null),
            onAssign: async (name, labels, merge, allSameType) => {
              setDialog(null)
              const type = variables.find((variable) => variable.name === name)?.type
              const targets = allSameType === true
                ? variables.filter((variable) => variable.name === name || variable.type === type).map((variable) => variable.name)
                : [name]
              try {
                for (const entry of targets) {
                  const value = await api('api/valuelabels', { sessionId, name: entry, labels, merge })
                  setSt(stateOf(value))
                }
                const count = Object.keys(labels).length
                notify(targets.length > 1
                  ? tr('已给 {0} 个变量各写入 {1} 条值标签', targets.length, count)
                  : tr('已给 {0} 写入 {1} 条值标签', name, count))
              } catch (error) { notify(error.message) }
            },
          })
          : null,
        dialog?.kind === 'importWizard'
          ? h(ImportWizard, {
            path: dialog.path,
            preview: dialog.preview,
            busy,
            onClose: () => setDialog(null),
            onPreview: async (options) => {
              try {
                const value = await api('api/previewImport', { sessionId, path: dialog.path, options })
                setDialog((current) => (current && current.kind === 'importWizard' ? { ...current, preview: value.result } : current))
              } catch (error) {
                notify(error.message)
              }
            },
            onRun: async (options) => {
              const { path, title } = dialog
              setDialog(null)
              await openPath(path, { title, import: options })
            },
          })
          : null,
        dialog?.kind === 'sheet'
          ? h(SheetDialog, {
            path: dialog.path,
            sheets: dialog.sheets,
            hasHeader: dialog.hasHeader,
            onClose: () => setDialog(null),
            onRun: async (sheetOptions) => {
              const { path, seed, title } = dialog
              setDialog(null)
              await openPath(path, { seed, title, import: sheetOptions })
            },
          })
          : null,
        dialog?.kind === 'find'
          ? h(FindReplaceDialog, {
            mode: dialog.mode,
            variables,
            onClose: () => setDialog(null),
            onFind: async (spec) => {
              try {
                const value = await api('api/find', { sessionId, query: spec.query, options: spec })
                const match = value.result.matches[0]
                if (!match) { notify('没有找到匹配的内容'); return }
                setDialog(null)
                setView('data')
                if (match.row >= rows.length) {
                  const page = await loadRows(match.row, 500)
                  setRows(page.rows)
                  setTotal(page.total)
                  setSelected({ row: 0, column: match.column })
                } else {
                  setSelected({ row: match.row, column: match.column })
                }
                notify(tr('找到 {0}{1} 处，第一处在第 {2} 行的 {3}', value.result.total, value.result.truncated ? '+' : '', match.row + 1, match.variable))
              } catch (error) {
                notify(error.message)
              }
            },
            onReplace: async (spec) => {
              try {
                const value = await api('api/replace', { sessionId, find: spec.find, replace: spec.replace, options: spec })
                setSt(stateOf(value))
                const page = await loadRows(0, 500)
                setRows(page.rows)
                setTotal(page.total)
                setDialog(null)
                notify(value.result.replaced > 0 ? tr('已替换 {0} 处', value.result.replaced) : '没有可替换的内容')
              } catch (error) {
                notify(error.message)
              }
            },
          })
          : null,
        dialog?.kind === 'convert'
          ? h(ConvertDialog, {
            path: convertPath,
            onPath: setConvertPath,
            onClose: () => setDialog(null),
            onBrowse: () => setBrowser({ mode: 'convert' }),
            onRun: async (spec) => {
              setBusy(true)
              try {
                const value = await api('api/convert', { sessionId, path: spec.path })
                setDialog(null)
                notify(tr('已转换为 {0}：{1}（{2} KB）', String(value.result.format).toUpperCase(), value.result.path, Math.round(value.result.bytes / 1024)))
              } catch (error) {
                notify(error.message)
              } finally {
                setBusy(false)
              }
            },
          })
          : null,
        dialog?.kind === 'merge'
          ? h(MergeDialog, {
            mode: dialog.mode,
            variables,
            initial: dialog,
            onBrowse: () => setBrowser({ mode: 'merge' }),
            onClose: () => setDialog(null),
            onRun: async (spec) => {
              if (!spec) { notify('请填写对方文件路径'); return }
              setBusy(true)
              try {
                const value = await api('api/merge', { sessionId, kind: dialog.mode, path: spec.path, by: spec.by })
                setSt(stateOf(value))
                const page = await loadRows(0, 500)
                setRows(page.rows)
                setTotal(page.total)
                setDialog(null)
                notify(dialog.mode === 'match' ? '已按关键变量合并' : '已添加个案')
              } catch (error) {
                notify(error.message)
              } finally {
                setBusy(false)
              }
            },
          })
          : null,
        labelsDialog
          ? h(Modal, {
            title: tr('值标签 — {0}', labelsDialog.name),
            onCancel: () => setLabelsDialog(null),
            onOk: async () => {
              const entries = labelsDialog.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
              const labels = {}
              for (const line of entries) {
                const at = line.indexOf('=')
                if (at < 0) { notify(tr('无法解析「{0}」，应为 值=标签', line)); return }
                labels[line.slice(0, at).trim()] = line.slice(at + 1).trim()
              }
              const value = await api('api/variable', { sessionId, action: 'update', name: labelsDialog.name, patch: { valueLabels: labels } })
              setSt(stateOf(value))
              setLabelsDialog(null)
              notify(tr('已更新 {0} 的 {1} 个值标签', labelsDialog.name, Object.keys(labels).length))
            },
          },
          h('div', { className: 'ap-hint' }, '每行一个：值=标签。保存后数据视图显示标签，写回数据文件时写入 VALUE LABELS。'),
          h('textarea', {
            style: { width: '100%', height: 180, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
            value: labelsDialog.text,
            onChange: (event) => setLabelsDialog({ ...labelsDialog, text: event.target.value }),
          }))
          : null,
        dialog?.kind === 'publication'
          ? h(PublicationDialog, {
            kind: dialog.tableKind,
            variables,
            onRun: (payload) => runPublication(payload),
            onClose: () => setDialog(null),
          })
          : null,
        dialog?.kind === 'close'
          ? h(ConfirmDialog, {
            title: '关闭数据集',
            message: tr('{0} 有未保存的改动。关闭后这些改动只剩下工作文件里的一份副本，面板里没有入口再打开它。要先保存吗？', st?.dataset?.name ?? tr('当前数据')),
            okText: '仍然关闭',
            onOk: () => {
              const target = pendingClose ?? { id: sessionId, current: true }
              setPendingClose(null)
              setDialog(null)
              if (target.current) closeSession()
              else closeDocNow(target.id)
            },
            onClose: () => { setPendingClose(null); setDialog(null) },
          })
          : null,
        dialog?.kind === 'flip'
          ? h(FlipDialog, {
            strings: dialog.strings,
            onRun: (force) => { setDialog(null); doFlip(force) },
            onClose: () => setDialog(null),
          })
          : null,
        dialog?.kind === 'pairwise'
          ? h(PairwiseDialog, {
            variables,
            defaults: dialog.defaults,
            onRun: (payload) => runPairwise(payload),
            onClose: () => setDialog(null),
          })
          : null,
        dialog?.kind === 'partial'
          ? h(PartialDialog, {
            variables,
            defaults: dialog.defaults,
            onRun: (payload) => runPartial(payload),
            onClose: () => setDialog(null),
          })
          : null,
        dialog?.kind === 'tableedit'
          ? h(TableEditDialog, {
            item: dialog.item,
            edits: tableEdits[dialog.item.id] ?? null,
            onSave: (next) => {
              setTableEdits((current) => ({ ...current, [dialog.item.id]: next }))
              setDialog(null)
            },
            onReset: () => {
              setTableEdits((current) => {
                const copy = { ...current }
                delete copy[dialog.item.id]
                return copy
              })
              setDialog(null)
            },
            onClose: () => setDialog(null),
          })
          : null,
        dialog?.kind === 'chart'
          ? h(ChartDialog, {
            type: dialog.type,
            variables,
            rows,
            tables: (st?.items ?? []).filter((item) => item.kind === 'table'),
            onClose: () => setDialog(null),
            onChart: (chart) => runChart(chart),
          })
          : null,
        browser
          ? h(FileBrowser, {
            title: {
              open: '打开数据文件',
              save: '保存数据集到…',
              merge: '选择要合并的文件',
              convert: '选择源文件（.sav/.por/.sys）',
              syntax: '保存语法文件到…',
              office: '导出输出到…',
              exportdoc: '导出输出到…',
              report: '导出报告卡到…',
              reportBook: '导出报告（成册）到…',
              chartExport: '导出图表到…',
              itemCsv: '导出表格到…',
              export: '导出为 CSV…',
              labelFile: '选择值标签文件',
            }[browser.mode] ?? '选择文件',
            extra: browser.mode === 'reportBook'
              ? h('div', null,
                h('div', { className: 'ap-row', style: { alignItems: 'center', gap: 8 } },
                  h('span', { className: 'ap-hint' }, '标题'),
                  h('input', {
                    type: 'text',
                    style: { flex: 1 },
                    value: browser.reportTitle ?? '',
                    placeholder: tr('默认用数据集名'),
                    onChange: (event) => setBrowser((current) => (current ? { ...current, reportTitle: event.target.value } : current)),
                  })),
                h('div', { className: 'ap-row', style: { alignItems: 'center', gap: 8 } },
                  h('span', { className: 'ap-hint' }, '副标题'),
                  h('input', {
                    type: 'text',
                    style: { flex: 1 },
                    value: browser.reportSubtitle ?? '',
                    placeholder: tr('课程、项目或作者（可留空）'),
                    onChange: (event) => setBrowser((current) => (current ? { ...current, reportSubtitle: event.target.value } : current)),
                  })),
                h('div', { className: 'ap-hint' }, tr('文件名后缀决定格式：.docx 或 .html（.html 用浏览器打开、可直接打印成 PDF）。')),
                h('div', { className: 'ap-hint' }, tr('报告只装订勾选的输出（当前 {0} 项）：在输出树里点每项左侧的框勾选，勾选顺序就是装订顺序。', reportPick.size)))
              : browser.mode === 'office'
              ? h('div', null,
                Array.isArray(browser.only) && browser.only.length > 0
                  ? h('div', { className: 'ap-row', style: { alignItems: 'center', gap: 8 } },
                    h('span', { className: 'ap-hint' }, '导出范围'),
                    h('strong', null, tr('只导出「{0}」', browser.title ?? tr('这一张表'))))
                  : null,
                h('div', { className: 'ap-row', style: { alignItems: 'center', gap: 8, display: Array.isArray(browser.only) && browser.only.length > 0 ? 'none' : 'flex' } },
                  h('span', { className: 'ap-hint' }, '导出范围'),
                  h('select', {
                    value: browser.scope ?? 'session',
                    onChange: (event) => setBrowser((current) => (current ? { ...current, scope: event.target.value } : current)),
                  },
                  h('option', { value: 'session' }, '整个会话（全部表与图）'),
                  h('option', { value: 'last' }, '最近一次运行')),
                  h('span', { className: 'ap-hint' }, '最近一次运行 = 最后生成的那批表/图，例如刚做的两两比较或表 1')),
                h('label', { className: 'ap-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: browser.formulas !== false,
                    onChange: (event) => setBrowser((current) => (current ? { ...current, formulas: event.target.checked } : current)),
                  }), '写入 Excel 公式（仅 .xlsx）'),
                h('span', { className: 'ap-hint' }, '公式只覆盖表内自洽的量（百分比、合计、df、CI、p 值），打开时看到的是 PSPP 打印值；xlsx 刻意不带强制重算标记，改数后按 Ctrl+Alt+F9 手动重算'),
                h('label', { className: 'ap-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: browser.dataSheet === true,
                    onChange: (event) => setBrowser((current) => (current ? { ...current, dataSheet: event.target.checked } : current)),
                  }), '附带原始数据页（.xlsx，隐藏）'),
                h('span', { className: 'ap-hint' }, '原始个案会作为一张隐藏工作表附在文件末尾；报告里没打印的量（均数、标准差）可以用 AVERAGE / STDEV.S 自己算。默认关，含敏感数据时不要勾'))
              : null,
            initialPath: browser.mode === 'save'
              ? (st?.dataset?.temporary === true
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${st?.dataset?.name ?? 'data.sav'}`
                : (st?.dataset?.sourcePath ?? readSessionCwd() ?? st?.cwd ?? ''))
              : browser.mode === 'itemCsv'
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${String(browser.title ?? 'table')}.csv`
              : browser.mode === 'report'
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${String(st?.dataset?.name ?? 'report').replace(/\.[^.]+$/, '')}-报告卡.${browser.format}`
              : browser.mode === 'reportBook'
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${String(st?.dataset?.name ?? 'report').replace(/\.[^.]+$/, '')}-报告.${browser.format === 'html' ? 'html' : 'docx'}`
              : browser.mode === 'office' && Array.isArray(browser.only) && browser.only.length > 0
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${String(browser.title ?? 'table').replace(/[\\/:*?"<>|]/g, '_')}.${browser.format}`
              : browser.mode === 'office' || browser.mode === 'exportdoc'
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${String(st?.dataset?.name ?? 'pspp-output').replace(/\.[^.]+$/, '')}-output.${browser.format}`
                : browser.mode === 'chartExport'
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${String(browser.title ?? 'chart').replace(/[\\/:*?"<>|]/g, '_')}.${browser.format}`
                : browser.mode === 'syntax'
                ? `${String(readSessionCwd() ?? st?.cwd ?? '').replace(/\/$/, '')}/${(st?.dataset?.name ?? 'analysis').replace(/\.[^.]+$/, '')}.sps`
                : (st?.dataset?.sourcePath ? st.dataset.sourcePath.replace(/\/[^/]*$/, '') : (readSessionCwd() ?? st?.cwd ?? '')),
            onClose: () => setBrowser(null),
            onPick: async (path) => {
              const mode = browser.mode
              setBrowser(null)
              if (mode === 'open') return openPath(path)
              if (mode === 'importWizard') {
                setBusy(true)
                try {
                  // The wizard opens on the file as the import would guess it;
                  // every change re-asks, so the preview is never stale.
                  const value = await api('api/previewImport', { sessionId, path, options: {} })
                  setDialog({ kind: 'importWizard', path, preview: value.result, title: basenameOf(path) })
                } catch (error) {
                  notify(error.message)
                } finally {
                  setBusy(false)
                }
                return
              }
              if (mode === 'merge') { setDialog((prev) => (prev && prev.kind === 'merge' ? { ...prev, path } : prev)); return }
              if (mode === 'save') {
                setBusy(true)
                try { await api('api/save', { sessionId, path }); await refresh(); notify(tr('已保存 {0}', path)) }
                catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'convert') { setConvertPath(path); setDialog({ kind: 'convert' }); return }
              if (mode === 'syntax') {
                if (!syntax.trim()) { notify('语法编辑器是空的，先写点东西再保存'); return }
                try {
                  const value = await api('api/saveSyntax', { sessionId, path, text: syntax })
                  notify(tr('已保存语法 {0}（{1} 字节）', value.result.path, value.result.bytes))
                } catch (error) { notify(error.message) }
                return
              }
              if (mode === 'office') {
                setBusy(true)
                try {
                  const value = await api('api/exportOffice', { sessionId, path, scope: browser.scope ?? 'session', formulas: browser.formulas !== false, data: browser.dataSheet === true, items: browser.only ?? null })
                  const r = value.result
                  notify(tr('已导出 {0}（{1} KB，{2} 个表、{3} 张图）', r.path, Math.round(r.bytes / 1024), r.tables, r.images))
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'chartExport') {
                setBusy(true)
                try {
                  const value = await api('api/chart/export', { sessionId, runId: browser.runId, path, format: browser.format, scale: browser.scale })
                  notify(tr('已导出 {0}（{1} KB）', value.result.path, Math.round(value.result.bytes / 1024)))
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'labelFile') {
                LABEL_FILE_PICKED = path
                setDialog((prev) => (prev && prev.kind === 'valueLabels' ? { ...prev, reopen: Date.now() } : prev))
                return
              }
              if (mode === 'export') {
                setBusy(true)
                try { await api('api/export', { sessionId, path }); notify(tr('已导出 {0}', path)) }
                catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'itemCsv') {
                const pending = ITEM_CSV_PENDING
                ITEM_CSV_PENDING = null
                if (!pending) { notify('没有可导出的表格：重新点一次「导出 CSV…」'); return }
                setBusy(true)
                try {
                  const value = await api('api/writeText', { sessionId, path, text: pending.text })
                  notify(tr('已导出 {0}（{1} KB）', value.result.path, Math.round(value.result.bytes / 1024)))
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'reportBook') {
                // Ticking in the output tree is the selection; the order there is
                // the order of the report. Nothing is recomputed here — the host
                // assembles the tables it already has.
                const chosen = items.filter((item) => reportPick.has(item.id)).map((item) => item.id)
                if (chosen.length === 0) { notify(tr('先勾选要装订的表或图：输出树里每项左侧的框')); return }
                const lower = String(path).toLowerCase()
                if (!lower.endsWith('.docx') && !lower.endsWith('.html') && !lower.endsWith('.htm')) {
                  notify(tr('文件名要以 .docx 或 .html 结尾：它决定报告格式'))
                  return
                }
                setBusy(true)
                try {
                  const value = await api('api/reportBook', {
                    sessionId,
                    path,
                    items: chosen,
                    title: browser.reportTitle ?? '',
                    subtitle: browser.reportSubtitle ?? '',
                  })
                  const result = value.result ?? {}
                  notify(tr('已生成报告 {0}（{1} 表 {2} 图，{3} KB）', result.path, result.tables ?? 0, result.figures ?? 0, Math.round((result.bytes ?? 0) / 1024)))
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'report') {
                // The syntax of every ticked result, in output order.
                const scripts = items
                  .filter((item) => reportPick.has(item.id) && item.script)
                  .map((item) => String(item.script).trim())
                  .filter(Boolean)
                if (scripts.length === 0) { notify('报告卡里还没有可重放的语法'); return }
                setBusy(true)
                try {
                  const value = await api('api/exportReport', {
                    sessionId,
                    path,
                    format: browser.format,
                    script: scripts.join('\n'),
                  })
                  notify(tr('已导出报告卡 {0}（{1} KB，{2} 个结果）', value.result.path, Math.round(value.result.bytes / 1024), scripts.length))
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'exportdoc') {
                setBusy(true)
                try {
                  const value = await api('api/exportDoc', { sessionId, path, format: browser.format })
                  notify(tr('已导出 {0}（{1} KB）', value.result.path, Math.round(value.result.bytes / 1024)))
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
              }
            },
          })
          : null)
    }

    // Every template is a complete, runnable program with placeholder variable
    // names in angle brackets: the user replaces them, and the dialog says so.
    // They are grouped the way the Analyze menu is, not alphabetically, because
    // someone who does not know the syntax looks for the procedure's name first.
    const TEMPLATE_GROUPS = ['描述', '比较均值', '相关与回归', '降维与信度', '非参数', '数据整理']
    const SYNTAX_TEMPLATES = [
      { group: '描述', label: '描述统计（均数/标准差/极值）', syntax: 'DESCRIPTIVES /VARIABLES=<变量1> <变量2> /STATISTICS=MEAN STDDEV MIN MAX.' },
      { group: '描述', label: '频率与集中趋势', syntax: 'FREQUENCIES /VARIABLES=<变量> /STATISTICS=MEAN MEDIAN MODE.' },
      { group: '描述', label: '交叉表 + 卡方', syntax: 'CROSSTABS /TABLES=<行变量> BY <列变量> /STATISTICS=CHISQ.' },
      { group: '描述', label: '均值过程（分组均数）', syntax: 'MEANS TABLES=<因变量> BY <分组变量>.' },
      { group: '比较均值', label: '独立样本 t 检验', syntax: 'T-TEST GROUPS=<分组变量>(1 2) /VARIABLES=<因变量>.' },
      { group: '比较均值', label: '配对样本 t 检验', syntax: 'T-TEST PAIRS=<变量1> WITH <变量2>.' },
      { group: '比较均值', label: '单样本 t 检验', syntax: 'T-TEST /TESTVAL=0 /VARIABLES=<变量>.' },
      { group: '比较均值', label: '单因素方差分析', syntax: 'ONEWAY <因变量> BY <因子> /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=TUKEY.' },
      { group: '相关与回归', label: '双变量相关', syntax: 'CORRELATIONS /VARIABLES=<变量1> <变量2> <变量3>.' },
      { group: '相关与回归', label: '线性回归', syntax: 'REGRESSION /DEPENDENT=<因变量> /METHOD=ENTER <自变量1> <自变量2> /STATISTICS=COEFF R ANOVA.' },
      { group: '相关与回归', label: '二元 Logistic 回归', syntax: 'LOGISTIC REGRESSION <因变量> WITH <自变量1> <自变量2>.' },
      { group: '降维与信度', label: '信度（Cronbach α）', syntax: 'RELIABILITY /VARIABLES=<题项1> <题项2> <题项3>.' },
      { group: '降维与信度', label: '因子分析', syntax: 'FACTOR /VARIABLES=<题项1> <题项2> <题项3> /CRITERIA=FACTORS(1).' },
      { group: '降维与信度', label: '快速聚类（K 均值）', syntax: 'QUICK CLUSTER <变量1> <变量2> /CRITERIA=CLUSTERS(3).' },
      { group: '非参数', label: 'Mann-Whitney U', syntax: 'NPAR TESTS /MANN-WHITNEY=<因变量> BY <分组变量>(1 2).' },
      { group: '非参数', label: 'Wilcoxon 符号秩', syntax: 'NPAR TESTS /WILCOXON=<变量1> WITH <变量2>.' },
      { group: '非参数', label: '单样本 K-S 正态性', syntax: 'NPAR TESTS /K-S(NORMAL)=<变量>.' },
      { group: '数据整理', label: '计算新变量', syntax: 'COMPUTE <新变量> = <表达式>.\nEXECUTE.' },
      { group: '数据整理', label: '重编码成分组', syntax: 'RECODE <变量> (LO THRU 30=1) (31 THRU HI=2) INTO <新变量>.\nEXECUTE.' },
      { group: '数据整理', label: '排序与筛选', syntax: 'SORT CASES BY <变量>(A).\nSELECT IF (<条件>).\nEXECUTE.' },
      { group: '数据整理', label: '按组聚合（保存汇总值）', syntax: 'AGGREGATE /OUTFILE=* MODE=ADDVARIABLES /BREAK=<分组变量> /<新变量>_mean=MEAN(<变量>).' },
    ]

    const CHART_SPECS = {
      bar: {
        title: '条形图',
        fields: [
          { key: 'variable', kind: 'single', label: '变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '类别轴（可选）', accept: 'any' },
          { key: 'cluster', kind: 'single', label: '分组（并列，可选）', accept: 'any' },
          { key: 'stack', kind: 'single', label: '堆叠（可选）', accept: 'any' },
        ],
        groups: [{
          key: 'barOptions',
          title: '条形图选项',
          items: [
            { key: 'errorBars', kind: 'select', label: '误差线', options: [
              { value: '', label: '不显示' },
              { value: 'sd', label: '±1 个标准差（SD）' },
              { value: 'se', label: '±1 个标准误（SE）' },
              { value: 'ci95', label: '95% 置信区间（CI）' },
            ] },
            { key: 'significance', label: '自动标注组间差异（Welch t 检验）' },
            { key: 'percentStack', label: '堆叠按百分比（每根柱合计 100%）' },
          ],
        }],
        build: (v, flags) => ({
          chart: {
            kind: 'bar',
            variable: v.variable,
            by: v.by,
            cluster: v.cluster,
            stack: v.stack,
            statistic: 'MEAN',
            errorBars: flags?.barOptions?.errorBars || false,
            significance: flags?.barOptions?.significance === true ? 'auto' : undefined,
            shape: flags?.barOptions?.percentStack === true && v.stack ? 'stacked100' : undefined,
          },
        }),
      },
      histogram: {
        title: '直方图',
        fields: [{ key: 'variable', kind: 'single', label: '变量', required: true, accept: 'numeric' }],
        build: (v) => ({ chart: { kind: 'histogram', variable: v.variable } }),
      },
      boxplot: {
        title: '箱线图',
        fields: [
          { key: 'variable', kind: 'single', label: '变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '分组变量（可选）', accept: 'any' },
        ],
        build: (v) => ({ chart: { kind: 'boxplot', variable: v.variable, by: v.by } }),
      },
      line: {
        title: '折线图',
        fields: [
          { key: 'variable', kind: 'single', label: '变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '类别轴', required: true, accept: 'any' },
          { key: 'cluster', kind: 'single', label: '分线变量（可选）', accept: 'any' },
          { key: 'y2', kind: 'single', label: '第二变量（右轴，可选）', accept: 'numeric' },
        ],
        groups: [{
          key: 'lineOptions',
          title: '折线图选项',
          items: [{
            key: 'errorBars',
            kind: 'select',
            label: '误差线',
            options: [
              { value: '', label: '不显示' },
              { value: 'sd', label: '±1 个标准差（SD）' },
              { value: 'se', label: '±1 个标准误（SE）' },
              { value: 'ci95', label: '95% 置信区间（CI）' },
            ],
          }],
        }],
        build: (v, flags) => ({
          chart: {
            kind: 'line',
            variable: v.variable,
            by: v.by,
            cluster: v.cluster,
            statistic: 'MEAN',
            errorBars: flags?.lineOptions?.errorBars || false,
            y2: v.y2 || undefined,
          },
        }),
      },
      pie: {
        title: '饼图',
        fields: [{ key: 'variable', kind: 'single', label: '类别变量', required: true, accept: 'any' }],
        groups: [{ key: 'pieOptions', title: '饼图选项', items: [{ key: 'donut', label: '显示为环形图' }] }],
        build: (v, flags) => ({ chart: { kind: 'pie', variable: v.variable, donut: flags?.pieOptions?.donut === true } }),
      },
      area: {
        title: '面积图',
        fields: [
          { key: 'variable', kind: 'single', label: '变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '类别轴', required: true, accept: 'any' },
          { key: 'cluster', kind: 'single', label: '分层变量（可选）', accept: 'any' },
        ],
        build: (v) => ({ chart: { kind: 'area', variable: v.variable, by: v.by, cluster: v.cluster, statistic: 'MEAN' } }),
      },
      scatterplot: {
        title: '散点图',
        fields: [
          { key: 'x', kind: 'single', label: 'X 轴', required: true, accept: 'numeric' },
          { key: 'y', kind: 'single', label: 'Y 轴', required: true, accept: 'numeric' },
        ],
        build: (v) => ({ chart: { kind: 'scatterplot', x: v.x, y: v.y } }),
      },
    }

    /** Merge another .sav: ADD FILES (append cases) or MATCH FILES /BY (join variables). */
    function MergeDialog({ mode, variables, initial, onBrowse, onRun, onClose }) {
      const [path, setPath] = useState(initial?.path ?? '')
      const [by, setBy] = useState(initial?.by ?? '')
      useEffect(() => { if (initial?.path) setPath(initial.path) }, [initial?.path])
      const title = mode === 'match' ? '按关键变量合并文件' : '添加个案（合并文件）'
      const numeric = (variables ?? []).filter((variable) => variable.type !== 'string').map((variable) => variable.name)
      return h(Modal, {
        title,
        onCancel: onClose,
        onOk: () => {
          if (!String(path).trim()) return onRun(null)
          onRun({ path: String(path).trim(), by })
        },
      },
        h('div', { className: 'ap-row' },
          h('input', {
            type: 'text',
            value: path,
            placeholder: '对方系统文件路径（.sav/.por/.sys）',
            onChange: (event) => setPath(event.target.value),
            style: { flex: 1 },
          }),
          h('button', { className: 'ap-tool', onClick: onBrowse }, '浏览…')),
        mode === 'match'
          ? h('div', null,
            h('label', { className: 'ap-hint' }, tr('键变量（空格分隔，可选：{0}{1}）', numeric.slice(0, 12).join(' '), numeric.length > 12 ? ' …' : '')),
            h('input', {
              type: 'text',
              value: by,
              placeholder: 'id',
              onChange: (event) => setBy(event.target.value),
              style: { width: '100%' },
            }))
          : null,
        h('div', { className: 'ap-hint' },
          mode === 'match'
            ? '把对方文件的变量按键变量匹配到当前数据（MATCH FILES /BY）。'
            : '把对方文件的个案追加到当前数据末尾（ADD FILES）。'))
    }

    // The viewer body for a data file clicked in the Files panel: hand the path
    // over, reveal the workbench, and retire the tab better-sidebar minted so
    // the file does not appear twice.
    function FileHandoff({ ctx, store, scope, path, title }) {
      const closeRef = useRef(null)
      // useLayoutEffect, not useEffect: the handoff tab has to be gone in the
      // same commit that mounted it, before the browser paints the chip.
      useLayoutEffect(() => {
        const sessionId = scope?.sessionId
        if (!sessionId || !path) return undefined
        requestFileHandoff(sessionId, path)
        const service = ctx?.betterSidebar
        try {
          service?.openTab?.({ type: 'analytics', title: '统计分析', id: 'analytics', target: 'right' })
        } catch { /* the panel opens on its own the next time it is shown */ }
        // The tab better-sidebar minted has to go: the file now lives in the
        // panel. `editor:<path>` is only the id of one open path, though — a
        // path click goes through the native surface as a resource address, so
        // ask the sidebar-right controller which tab holds this path.
        // Cordis guards `ctx.<service>` behind the plugin's inject list and throws
        // `cannot get property "sidebarRight" without inject`; `ctx.get` is the
        // unguarded reader, which is how better-sidebar itself reaches it.
        const nativeColumn = () => (typeof ctx?.get === 'function' ? ctx.get('sidebarRight') : undefined)
        // Every retry sees the same tab until the sidebar drops it; asking twice
        // would be a second close of a live tab, so remember what we closed.
        const closedIds = new Set()
        const closeMine = () => {
          let closed = false
          // Reading a service we did not inject is the one call cordis may
          // refuse, so the whole probe sits inside the guard.
          try {
            const sidebarRight = nativeColumn()
            const tabs = sidebarRight?.tabsIn?.(sessionId) ?? []
            // TabRecord carries id / kind / title only — no address or path — so
            // the file is recognised by its basename as well as by the full path.
            const base = path.slice(path.lastIndexOf('/') + 1)
            for (const tab of tabs) {
              const id = tab?.id ?? tab?.tabId
              if (!id) continue
              const fields = [tab.address, tab.params?.path, tab.params?.address, tab.params?.title, tab.title, String(id)]
                .filter((value) => typeof value === 'string')
              if (fields.some((value) => value.includes('analytics'))) continue
              const mine = fields.some((value) => value === path
                || value.includes(path)
                || value === base
                || value.endsWith('/' + base))
              if (!mine || closedIds.has(id)) continue
              closedIds.add(id)
              if (typeof sidebarRight.closeIn === 'function') sidebarRight.closeIn(sessionId, id)
              else sidebarRight.close?.(id)
              closed = true
            }
          } catch { /* no sidebarRight, or the tab is not in that column */ }
          if (closed) return
          for (const id of [`editor:${path}`, `file:${path}`]) {
            try { service?.closeTab?.(id, { sessionId }) } catch { /* already closed */ }
          }
        }
        // Last resort: the native tab's own close control. Both ids above are
        // guesses about how the surface names a resource tab, so if the tab is
        // still on screen, click the X of the tab whose title is this file.
        const closeViaDom = () => {
          try {
            const name = title ?? basenameOf(path)
            if (!name) return
            const leaves = Array.from(document.querySelectorAll('span,div'))
              .filter((node) => node.children.length === 0 && node.textContent.trim() === name)
            const isTabElement = (node) => {
              const token = String(node.className).split(/\s+/).find((part) => /_tab(Active)?$/.test(part))
              return Boolean(token) && !/Title|Close|List|Bar|Strip|Badge|Body|Content/.test(String(node.className))
            }
            for (const leaf of leaves) {
              let tab = leaf.parentElement
              while (tab && !isTabElement(tab)) tab = tab.parentElement
              if (!tab) continue
              const button = tab.querySelector('[class*="tabClose"], [aria-label*="关闭"], [title*="关闭"], button')
              if (button) {
                button.click()
                return
              }
            }
          } catch { /* the tab is already gone, or the shell markup moved */ }
        }
        // Closing our own tab unmounts this component, so do it after the
        // handoff is queued and the panel has been asked to appear.
        closeRef.current = closeMine
        // Close right away — inside the mounting commit — so the chip is never
        // painted. The page store may still be recording the tab at that point,
        // hence the retries; the closing tab unmounts this component, so the
        // timers only matter when the first attempt missed.
        closeMine()
        const first = window.setTimeout(closeMine, 60)
        const second = window.setTimeout(closeMine, 320)
        const third = window.setTimeout(closeViaDom, 1200)
        return () => {
          window.clearTimeout(first)
          window.clearTimeout(second)
          window.clearTimeout(third)
        }
      }, [ctx, store, scope, path])
      return h('div', { className: 'ap-root' },
        h('div', { className: 'ap-empty' },
          h('div', null, tr('已交给「统计分析」打开 {0}。', title ?? basenameOf(path))),
          h('div', { className: 'ap-hint' }, '这个中转标签应该会自动关闭；没关掉就点下面的按钮。'),
          h('div', null, h('button', { className: 'ap-tool', onClick: () => closeRef.current?.() }, '关闭这个标签页'))))
    }

    // A picture belongs to a table, and guessing that from titles gets it wrong
    // the moment two procedures mention the same variable. The dialog therefore
    // offers the tables already in the output: pick one and the exporter puts
    // the image inside exactly that table, in both Word and Excel.
    // The table a picture belongs to is a judgement, not a fact, so the dialog
    // offers the tables already in the output: pick one and the exporter puts
    // the image inside exactly that table, in both Word and Excel. The last
    // choice is remembered: drawing five pictures for one table should not cost
    // five identical selections.
    const CHART_TARGET_KEY = 'ap.chartTarget'
    function readChartTarget() {
      try { return localStorage.getItem(CHART_TARGET_KEY) ?? '' } catch { return '' }
    }
    function rememberChartTarget(value) {
      try { localStorage.setItem(CHART_TARGET_KEY, value ?? '') } catch { /* quota */ }
    }

    function ChartDialog({ type, variables, rows, tables = [], onChart, onClose }) {
      const spec = CHART_SPECS[type]
      if (!spec) return null
      const remembered = readChartTarget()
      const options = [
        { value: '', label: '自动（按来源配到对应表）' },
        ...tables.map((table) => ({ value: table.id, label: `${table.title ?? table.id}` })),
      ]
      const withTarget = {
        ...spec,
        defaults: {
          ...(spec.defaults ?? {}),
          tableId: tables.some((table) => table.id === remembered) ? remembered : '',
        },
        fields: [
          ...(spec.fields ?? []),
          {
            key: 'tableId',
            kind: 'select',
            label: '导出时图表归属（可选）',
            options,
            hint: '选一张输出表：导出的 Word/Excel 里这张图嵌在那张表里；留空按来源自动配对',
          },
        ],
        build: (values, flags) => {
          const built = spec.build(values, flags)
          return { ...built, chart: { ...built.chart, tableId: values.tableId || null } }
        },
      }
      return h(AnalysisDialog, { spec: withTarget, variables, rows, onClose, onRun: (built) => onChart(built.chart) })
    }

    /**
     * Settings live in ~/.dsh/analytics/settings.json, not in the profile patch,
     * so the knobs a user actually turns while working do not need a YAML edit
     * and a plugin restart. `registerTools` is the one switch shown but not
     * editable here: it decides whether 23 tools mount in every session, which
     * is a deployment decision.
     */
    const SETTINGS_FIELDS = [
      {
        key: 'maxRows',
        label: '数据视图最多载入个案数',
        kind: 'number',
        min: 1000,
        max: 5000000,
        step: 1000,
        hint: '超过这个数量只载入前 N 个个案（分析仍可用语法在完整数据上跑）。重新打开数据时生效。',
      },
      {
        key: 'timeoutMs',
        label: '单次运行超时（秒）',
        kind: 'seconds',
        hint: '引擎跑得比这个久就中止。下一次运行生效。',
      },
      {
        key: 'safer',
        label: '用 --safer 运行（禁用写入文件与外部命令）',
        kind: 'boolean',
        hint: '处理来路不明的数据时打开。下一次运行生效。',
      },
      {
        key: 'uiLanguage',
        label: '界面语言',
        kind: 'select',
        options: [['zh', '中文'], ['en', 'English']],
        hint: '立即生效：面板与它给出的错误提示都换成这个语言。分析结果的表头、变量名、数据值仍是数据本来的样子。工具（agent 侧）的说明始终是英文。',
      },
      {
        key: 'tableStyle',
        label: '输出表格样式',
        kind: 'select',
        options: [['three-line', '三线表（SPSS 默认）'], ['grid', '网格（带竖线）']],
        hint: '立即生效：面板、导出的 HTML、Word 与 Excel 都跟它走。',
      },
      {
        key: 'maxExportRows',
        label: '导出时每张表最多放多少行',
        kind: 'number',
        min: 100,
        max: 100000,
        step: 100,
        hint: '导出上限立即生效（面板、Word、Excel、HTML 四个出口同一数值）：频率表这类「一个取值一行」的表很容易几千行，超过上限的导出会在文件里注明只放了前 N 行。',
      },
      {
        key: 'allowedDirs',
        label: '允许读写哪些目录（每行一个）',
        kind: 'lines',
        placeholder: '例如 ~/data\n例如 D:\\data',
        hint: '插件的打开、保存、导出、合并、转换只在这些目录里工作。默认允许：主目录、当前工作目录、临时目录、/mnt、/tmp。~/.dsh、~/.ssh、~/.gnupg 永远不允许（里面有登录凭据）。要读写别处，把它的上级目录加到这里。',
      },
    ]

    /**
     * The settings form, drawn inside the panel's own dialog.
     *
     * It used to live in the harness' settings page (`settings.section`). Two
     * places to change the same three knobs meant the user had to remember
     * which one they had opened, and the panel's copy could not say "these are
     * this workbench's settings" at all.
     */
    function SettingsForm({ onDone, saveRef }) {
      const [data, setData] = useState(null)
      const [form, setForm] = useState(null)
      const [status, setStatus] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const payload = await api('api/settings')
          setData(payload)
          setForm({
            maxRows: payload.settings.maxRows,
            timeoutMs: Math.round(payload.settings.timeoutMs / 1000),
            safer: payload.settings.safer === true,
            uiLanguage: payload.settings.uiLanguage ?? 'zh',
            tableStyle: payload.settings.tableStyle,
            // Falls back to the shipped default so a settings file written before
            // this field existed still shows a number instead of an empty box.
            maxExportRows: payload.settings.maxExportRows ?? payload.defaults?.maxExportRows ?? '',
            allowedDirs: (payload.settings.allowedDirs ?? []).join('\n'),
          })
          setError('')
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const save = useCallback(async () => {
        if (!form) return false
        setBusy(true)
        setError('')
        setStatus('')
        let savedOk = false
        try {
          const payload = await api('api/settings', {
            patch: {
              maxRows: Number(form.maxRows),
              timeoutMs: Number(form.timeoutMs) * 1000,
              safer: form.safer === true,
              uiLanguage: form.uiLanguage,
              tableStyle: form.tableStyle,
              // A blank box means "leave the current value alone": sending an
              // empty string would make the host reject the whole patch.
              ...(String(form.maxExportRows ?? '').trim() === '' ? {} : { maxExportRows: Number(form.maxExportRows) }),
              allowedDirs: String(form.allowedDirs ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
            },
          })
          setData(payload)
          setStatus('已保存。界面语言、表格样式、允许的目录、导出上限立即生效；载入上限与超时在下一次使用生效。')
          savedOk = true
          // The panel adopts the language without waiting for the 3 s heartbeat.
          try {
            window.dispatchEvent(new window.CustomEvent('ap:locale', { detail: form.uiLanguage }))
          } catch {
            // A host without CustomEvent keeps the heartbeat path, which still works.
          }
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
        return savedOk
      }, [form])

      // The dialog footer calls this; without the dialog (a test, or a caller
      // that renders the form on its own) nothing has to be registered.
      useEffect(() => {
        if (!saveRef) return undefined
        saveRef.current = save
        return () => { saveRef.current = null }
      }, [save, saveRef])

      if (error && !data) return h('div', { className: 'ap-settings' }, h('p', { className: 'ap-error' }, tr('设置读不出来：{0}', error)))

      if (!data || !form) return h('div', { className: 'ap-settings' }, h('p', { className: 'ap-hint' }, '正在读取设置…'))

      const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      return h('div', { className: 'ap-settings ap-settings-embedded' }, [
        h('p', { key: 'where', className: 'ap-hint' },
          tr('设置文件：{0}{1}', data.path, data.exists ? '' : tr('（还没创建，保存后生成）'))),
        data.problems?.length > 0
          ? h('div', { key: 'problems', className: 'ap-settings-problems' }, [
            h('strong', { key: 'h' }, '下面这些值没被采用：'),
            h('ul', { key: 'ul' }, data.problems.map((text, index) => h('li', { key: index }, text))),
          ])
          : null,
        ...SETTINGS_FIELDS.map((field) => {
          const labelId = `ap-set-${field.key}`
          let control
          if (field.kind === 'boolean') {
            control = h('input', {
              key: 'c',
              id: labelId,
              type: 'checkbox',
              checked: form[field.key] === true,
              onChange: (event) => set(field.key, event.target.checked),
            })
          } else if (field.kind === 'lines') {
            control = h('textarea', {
              key: 'c',
              id: labelId,
              className: 'ap-settings-lines',
              rows: 4,
              spellCheck: false,
              placeholder: field.placeholder ?? '',
              value: form[field.key] ?? '',
              onChange: (event) => set(field.key, event.target.value),
            })
          } else if (field.kind === 'select') {
            control = h('select', {
              key: 'c',
              id: labelId,
              value: form[field.key],
              onChange: (event) => set(field.key, event.target.value),
            }, field.options.map(([value, text]) => h('option', { key: value, value }, text)))
          } else {
            control = h('input', {
              key: 'c',
              id: labelId,
              type: 'number',
              value: form[field.key],
              min: field.kind === 'seconds' ? 5 : field.min,
              max: field.kind === 'seconds' ? 1800 : field.max,
              step: field.kind === 'seconds' ? 5 : field.step,
              onChange: (event) => set(field.key, event.target.value),
            })
          }
          return h('div', { key: field.key, className: 'ap-settings-row' }, [
            h('label', { key: 'l', htmlFor: labelId }, field.label),
            control,
            h('p', { key: 'hint', className: 'ap-hint' }, field.hint),
          ])
        }),
        h('div', { key: 'deploy', className: 'ap-settings-deploy' }, [
          h('strong', { key: 'h' }, tr(`工具挂载（registerTools）：${data.deploymentOnly.registerTools.value ? '开' : '关'}`)),
          h('p', { key: 'p', className: 'ap-hint' }, data.deploymentOnly.registerTools.note),
        ]),
        h('div', { key: 'actions', className: 'ap-settings-actions' }, [
          // 保存 lives in the dialog footer; this row only carries the reread.
          h('button', { key: 'reload', type: 'button', className: 'ap-btn', disabled: busy, onClick: load }, '重新读取'),
          busy ? h('span', { key: 'busy', className: 'ap-hint' }, '保存中…') : null,
        ].filter(Boolean)),
        status ? h('p', { key: 'status', className: 'ap-hint ap-settings-ok' }, status) : null,
        error ? h('p', { key: 'err', className: 'ap-error' }, error) : null,
      ].filter(Boolean))
    }

    if (typeof globalThis !== 'undefined' && globalThis.__AP_TEST_HOOKS__) {
      // The form moved out of the harness settings page and into the panel's own
      // dialog; tests still need a handle on it, and a dialog is one click away
      // from a test that does not want to drive the menu.
      globalThis.__AP_TEST_HOOKS__.settingsForm = SettingsForm
    }

    // Data files that only a statistics tool can make sense of. Clicking one in
    // the Files panel opens this workbench on it instead of the text viewer,
    // and every file gets its own workspace (`file-<hash>`), so two open
    // datasets never share a workspace. `.csv`/`.xlsx` are deliberately NOT
    // claimed: a user may well want to read those as text, and the analytics
    // panel also imports them from its own 打开 dialog.
    const DATA_VIEWER_EXTS = ['sav', 'por', 'sys', 'dta']
    const fileKey = (path) => {
      let hash = 0x811c9dc5
      for (let index = 0; index < path.length; index += 1) {
        hash ^= path.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0')
    }

    return {
      // `slots` is the sidebar shell: the left column's panel list and the main
      // area are slots, not services. The harness' own settings page is
      // deliberately left alone — this plugin's knobs live in its own 设置 menu.
      inject: ['betterSidebar', 'slots'],
      apply(ctx) {
        // The tab label and the data-file viewer title are drawn by the sidebar,
        // not by the panel's element factory, so the dictionary is loaded up
        // front instead of waiting for a panel to mount.
        api('api/settings')
          .then((payload) => (payload?.settings?.uiLanguage === 'en'
            ? api('api/locale?lang=en').then((dict) => {
              setDictionary(dict?.strings ?? null)
              LANG = 'en'
            })
            : null))
          .catch(() => { /* the panel will ask again when it opens */ })
        if (ctx.slots) {
          // Deliberately NOT registered in `settings.section`: the knobs belong
          // to this workbench (编辑 → 设置…), and a second copy in the harness'
          // settings page meant two places to look and two ways to get it wrong.
          // The left column's global panel list — the same rows 免费搜索, SSH and
          // 上下文洞察 sit in. A better-sidebar tab lives in the right column and
          // the bottom workbench: without this registration the workbench cannot
          // be reached from the place a user actually looks, and a collapsed
          // bottom panel leaves no visible entry at all.
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'analytics',
            order: 60,
            // The left-hand row and the right-hand tab open the same workbench,
            // so the row says which half of the screen it is.
            label: () => tr('统计分析（数据面板）'),
          }, () => ICON_LINE(16)))
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'analytics',
          }, () => h(App, { ctx, visible: true })))
        }
        if (!ctx.betterSidebar) return
        ctx.effect(() => ctx.betterSidebar.registerFileViewer({
          id: 'analytics:data',
          title: () => tr('统计分析 · 数据文件'),
          icon: (size) => ICON_LINE(size || 16),
          exts: DATA_VIEWER_EXTS,
          priority: 5,
          fetchStrategy: 'none',
          // The viewer tab IS the workbench: no extra tab, and the file's
          // workspace is keyed by the path so reopening it restores the data.
          component: (props) => h(FileHandoff, {
            ctx: props.ctx,
            store: props.store,
            scope: props.scope,
            path: props.path,
            title: props.title,
          }),
        }))
        ctx.effect(() => ctx.betterSidebar.registerTab({
          id: 'analytics',
          title: () => tr('统计分析'),
          description: () => tr('统计分析工作台（内置 GNU PSPP 引擎）：与左侧「统计分析」面板是同一份数据、同一个引擎'),
          icon: (size) => ICON_LINE(size || 16),
          // One tab per open data file (SPSS opens a Data Editor per file);
          // the primary tab is deduped under 'primary'.
          single: false,
          dedupeKey: (tab) => tab?.meta?.docId ?? 'primary',
          order: 30,
          // Greyed out in better-sidebar's "+" menu unless the session runs the
          // 统计分析 preset: without it the agent cannot see the pspp_* tools,
          // so opening a fresh tab from the menu is the wrong move. null means
          // the host told us nothing (old host, test context) — stay available.
          available: (tabCtx, tabScope) => {
            const value = sessionPreset(tabCtx ?? ctx, tabScope?.sessionId)
            return value === null || value === 'analytics'
          },
          onClose: (tab) => {
            const docId = tab?.meta?.docId
            if (!docId) return
            // Free the host workspace of a closed tab (its dataset and runs).
            api('api/close', { sessionId: docId }).catch(() => { /* the tab is gone either way */ })
          },
          component: (props) => h(App, props),
        }))
      },
    }
  },
})
