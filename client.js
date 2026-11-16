/* eslint-disable react/prop-types */
/**
 * Client half: an SPSS-style workbench registered as a better-sidebar tab.
 * Everything talks to the Host half through /analytics/api, which is the
 * same surface the agent tools drive.
 */
window.__ModuleLoader__.load({
  id: 'dsh-analytics',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const API_BASE = '/analytics/'
    const apiUrl = (path) => new URL(API_BASE + path, document.baseURI).toString()

    // The open panel tells the host where the conversation lives, so relative
    // paths and the file dialogs resolve against the session, not the server.
    let ACTIVE_CWD

    // A hung request used to freeze the panel for good: the poll skipped while
    // busy and never ran again. Every call gets a deadline instead.
    const API_TIMEOUT_MS = 180000

    async function api(path, body) {
      const payload = body !== undefined && ACTIVE_CWD && body.cwd === undefined
        ? { ...body, cwd: ACTIVE_CWD }
        : body
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
          throw new Error(`请求超时（${Math.round(API_TIMEOUT_MS / 1000)} 秒没有回复）：宿主可能正忙，稍后再试`)
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
      if (!response.ok || value?.ok === false) throw new Error(value?.error ?? `request failed (${response.status})`)
      return value
    }

    // Sidebar tabs mint their own workspace ids; a module-level counter keeps
    // two tabs from picking the same suffix.
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
.ap-status .ap-chip { height:16px; font-size:11px; }
.ap-chip { display:inline-flex; align-items:center; gap:4px; padding:0 6px; border:1px solid var(--ap-line-4);
  border-radius:9px; background:var(--ap-button); color:var(--ap-text); height:16px; line-height:16px; }
.ap-chip .ap-chip-x { cursor:pointer; opacity:.7; font-weight:700; }
.ap-chip .ap-chip-x:hover { opacity:1; }

.ap-grid-wrap { flex:1; min-height:0; overflow:auto; background:var(--ap-panel); }
.ap-grid { border-collapse:collapse; table-layout:fixed; font-family:inherit; font-size:inherit; }
.ap-grid td.ap-spacer { height:auto; min-height:0; padding:0; border:0; line-height:0; }
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
/* 大表先画一屏：几千行的频率表全量渲染会让整页变慢，也让浏览器快照大到没法用 */
.ap-table-block { display:flex; flex-direction:column; gap:2px; }
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
.ap-settings { max-width: 640px; display: flex; flex-direction: column; gap: 10px; }
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
      const starts = (text.match(/<tr\b/gi) ?? []).length
      // The first <tr> is the header row; the count people care about is body rows.
      const total = Math.max(0, starts - 1)
      if (limit <= 0 || total <= limit) return { html: text, total, shown: total }
      const pattern = /<tr\b/gi
      let seen = 0
      let cut = text.length
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (seen === limit + 1) {
          cut = match.index
          break
        }
        seen += 1
      }
      return { html: `${text.slice(0, cut)}</table>`, total, shown: limit }
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
      if (mean && !facts.some((fact) => fact.startsWith('χ²='))) facts.push(`均值=${mean}`)
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
        ? `${count} 条可识别；${parsed.problems.length} 行看不懂：${parsed.problems.slice(0, 3).join(' / ')}`
        : count > 0 ? `${count} 条值标签` : '还没有内容'
      return h(Modal, {
        title: '批量导入值标签',
        onCancel: onClose,
        okText: '导入',
        okDisabled: !target || count === 0,
        onOk: async () => {
          if (parsed.problems.length > 0 && !window.confirm(`${parsed.problems.length} 行看不懂，将跳过它们继续导入。继续？`)) return
          await onAssign(target, parsed.labels, merge, applyAll === true && siblings.length > 0)
        },
      },
      h('div', { className: 'ap-row' },
        h('span', null, '目标变量'),
        h('select', { value: target, onChange: (event) => setTarget(event.target.value), style: { flex: 1 } },
          variables.map((variable) => h('option', { key: variable.name, value: variable.name },
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
          `同时套用到另外 ${siblings.length} 个同类型变量（${siblings.slice(0, 3).map((variable) => variable.name).join(' / ')}${siblings.length > 3 ? ' …' : ''}）`)
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
        title: initial ? `编辑多选题 — ${initial.name}` : '定义多选题',
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
            h('span', { style: { flex: 1 } }, variable.label ? `${variable.name}（${variable.label}）` : variable.name)))),
        h('div', { style: { width: 200, display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { className: 'ap-hint' }, `已选 ${picked.size} 个变量`),
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
                  `${current.kind === 'mdgroup' ? '多分类' : '二分法'} · ${current.variables.length} 个变量：${current.variables.join(' ')}`),
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
                    grouped.map((variable) => h('option', { key: variable.name, value: variable.name },
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
            h('span', null, variable.name),
            variable.label ? h('span', { className: 'ap-hint' }, ` ${variable.label}`) : null))))
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
            variables.map((variable) => h('option', { key: variable.name, value: variable.name }, variable.name)))),
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
          h('div', { className: 'ap-hint' }, `已选 ${chosen.length} 个变量${chosen.length ? '' : '（不选则用除分组外的全部变量）'}`))))
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
            }, variable.name)))),
        h('div', { className: 'ap-dlg-right' },
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '分组变量（必选）'),
            h('select', {
              value: group ?? '',
              onChange: (event) => setGroup(event.target.value || null),
            },
            h('option', { value: '' }, '（选一个分组变量）'),
            variables.map((variable) => h('option', { key: variable.name, value: variable.name }, variable.name)))),
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
          h('div', { className: 'ap-hint' }, `已选 ${chosen.length} 个变量${chosen.length ? '' : '（不选则用除分组外的全部数值变量）'}`))))
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
                }, variable.name)))),
          h('div', { className: 'ap-dlg-box' },
            h('div', { className: 'ap-dlg-caption' }, '表格形式'),
            h('select', { value: layout, onChange: (event) => setLayout(event.target.value) },
              h('option', { value: 'rows' }, '逐对一行（r、df、P、N、标记）'),
              h('option', { value: 'matrix' }, '矩阵（变量 × 变量，只标星号，论文排版用）'))),
          h('div', { className: 'ap-hint' }, '每个变量对做一次：两个变量分别对控制变量回归，再求残差的相关（PSPP 没有 PARTIAL CORR，这张表由插件计算）。'),
          h('div', { className: 'ap-hint' }, '缺失按列表删除，N 是分析变量与控制变量都齐全的个案数；P 用 t = r·√(df/(1-r²))，df = N − 控制变量个数 − 2。'),
          h('div', { className: 'ap-hint' }, `已选 ${chosen.length} 个分析变量、${controls.length} 个控制变量${chosen.length < 2 ? '（至少选两个分析变量）' : ''}`))))
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
                h('span', null, variable.name),
                variable.label ? h('span', { className: 'ap-hint' }, ` ${variable.label}`) : null)
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
          const options = (field.options ?? []).map((option) => (typeof option === 'string' ? { value: option, label: option } : option))
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
          return h('div', { key: field.key, className: 'ap-dlg-box ap-dlg-form' },
            h('div', { className: 'ap-dlg-caption' }, field.label),
            control,
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
        title: current ? `把 ${current} 加入 / 移出这个框` : '先在左侧点一个变量',
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
            const options = (item.options ?? []).map((option) => (typeof option === 'string' ? { value: option, label: option } : option))
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
        }, `${group.title}…`)),
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
          ] },
        ],
        build: (v, flags) => {
          const stats = mapKeys(onKeys(flags, 'statistics'), {
            mean: 'MEAN', std: 'STDDEV', min: 'MINIMUM', max: 'MAXIMUM', semean: 'SEMEAN', variance: 'VARIANCE',
            range: 'RANGE', skew: 'SKEWNESS', seskew: 'SESKEWNESS', kurt: 'KURTOSIS', sekurt: 'SEKURTOSIS',
            median: 'MEDIAN', mode: 'MODE', sum: 'SUM',
          })
          const variables = v.vars.join(' ')
          const wanted = String(v.percentiles ?? '').trim().split(/[\s,]+/).filter(Boolean)
          // DESCRIPTIVES rejects MEDIAN/MODE, so either one (or a percentile
          // list) sends the same request through FREQUENCIES without the table.
          const freqOnly = stats.filter((name) => name === 'MEDIAN' || name === 'MODE')
          if (wanted.length || freqOnly.length > 0) {
            const merged = [...new Set([...stats, 'MEDIAN'])]
            for (const token of wanted) {
              if (!/^\d+(\.\d+)?$/.test(token)) return { error: `百分位数只能是数字：${token}` }
            }
            const suffix = wanted.length > 0 ? ` /PERCENTILES=${wanted.join(' ')}` : ''
            return {
              syntax: `FREQUENCIES /VARIABLES=${variables} /FORMAT=NOTABLE /STATISTICS=${merged.join(' ')}${suffix}.`,
            }
          }
          return { syntax: `DESCRIPTIVES /VARIABLES=${variables}${stats.length ? ` /STATISTICS=${stats.join(' ')}` : ''}.` }
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
            { key: 'gamma', label: 'Gamma' },
            // Kappa needs a square table; PSPP prints it under Symmetric Measures.
            // Turning it on also keeps CHISQ on, because the Cramér's V line and
            // the small-sample Fisher hint hang off the chi-square table.
            { key: 'kappa', label: 'Kappa（方表一致性）' },
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
          const parts = [`CROSSTABS /TABLES=${v.row} BY ${v.col}${layer ? ` BY ${layer}` : ''}`]
          if (stats.length) parts.push(`/STATISTICS=${stats.join(' ')}`)
          parts.push(`/CELLS=${(cells.length ? cells : ['COUNT']).join(' ')}`)
          return { syntax: `${parts.join(' ')}.` }
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
          return { syntax: `EXAMINE ${v.vars.join(' ')}${v.by ? ` BY ${v.by}` : ''} /PLOT=${(plots.length ? plots : ['BOXPLOT']).join(' ')}.` }
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
        fields: [
          { key: 'variable', kind: 'single', label: '排序变量', required: true, accept: 'numeric' },
          { key: 'target', kind: 'text', label: '秩变量名', placeholder: 'rx', default: 'rx' },
        ],
        groups: [
          { key: 'ties', title: '结值处理', items: [
            { key: 'mean', label: '平均值（默认）', default: true },
            { key: 'low', label: '低值' },
            { key: 'high', label: '高值' },
          ] },
        ],
        build: (v, flags) => {
          const target = String(v.target ?? '').trim() || `r_${v.variable}`
          const ties = flags?.ties?.low ? 'LOW' : flags?.ties?.high ? 'HIGH' : 'MEAN'
          return { syntax: `RANK VARIABLES=${v.variable} /RANK INTO ${target} /TIES=${ties}.`, persist: true }
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
        fields: [
          { key: 'vars', kind: 'multi', label: '因变量', required: true, accept: 'numeric' },
          { key: 'by', kind: 'single', label: '固定因子', required: true, accept: 'any' },
        ],
        build: (v) => ({ syntax: `GLM ${v.vars.join(' ')} BY ${v.by}.`, pairwise: { group: v.by, variables: v.vars } }),
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
            { key: 'tol', label: '共线性诊断（容忍度 / VIF，由插件计算）', default: true },
          ] },
          { key: 'save', title: '保存（写回数据集）', items: [
            { key: 'pred', label: '未标准化预测值' },
            { key: 'resid', label: '未标准化残差' },
            { key: 'zpred', label: '标准化预测值' },
            { key: 'zresid', label: '标准化残差' },
            { key: 'sresid', label: '学生化残差' },
            { key: 'cook', label: "Cook's D" },
          ] },
        ],
        build: (v, flags) => {
          // TOL is never sent to the engine: with it PSPP 2.1.3 crashes inside
          // gsl_blas_dsymm on about one run in six and writes no output. The
          // tolerance/VIF table is computed from the dataset instead, and the
          // hint below tells the workspace to do so.
          const stats = mapKeys(onKeys(flags, 'statistics'), { r: 'R', coeff: 'COEFF', anova: 'ANOVA', ci: 'CI' })
          const save = mapKeys(onKeys(flags, 'save'), {
            pred: 'PRED', resid: 'RESID', zpred: 'ZPRED', zresid: 'ZRESID', sresid: 'SRESID', cook: 'COOK',
          })
          const parts = [`REGRESSION /DEPENDENT=${v.dep} /METHOD=ENTER ${v.ind.join(' ')}`]
          if (stats.length) parts.push(`/STATISTICS=${stats.join(' ')}`)
          if (save.length) parts.push(`/SAVE=${save.join(' ')}`)
          const collinearity = flags?.statistics?.tol !== false
          return {
            syntax: `${parts.join(' ')}.`,
            persist: save.length > 0,
            regression: collinearity ? { dependent: v.dep, independents: v.ind } : null,
          }
        },
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
          const title = String(v.title ?? '').trim() || `${v.row} 按 ${v.col} 统计`
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
        fields: [
          { key: 'target', kind: 'text', label: '目标变量', required: true },
          { key: 'expression', kind: 'text', label: '数字表达式', required: true, placeholder: 'age * 2' },
        ],
        build: (v) => ({ syntax: `COMPUTE ${v.target} = ${v.expression}.\nEXECUTE.`, persist: true }),
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
            variables.map((variable) => h('option', { key: variable.name, value: variable.name }, variable.name)))),
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

    function DataGrid({ variables, rows, total, onLoadMore, onEdit, selected, onSelect, showLabels, widths = {}, onWidth, onPaste, onNewVariable, onMoveVariable, onCellMenu, rowHeight: rowHeightProp = 22, freeze = { rows: true, cols: true } }) {
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
        h('table', { className: 'ap-grid', style: { width: gridWidth + spareCount * spareWidth } },
          h('thead', null,
            h('tr', null,
              h('th', { className: 'ap-rownum' }, ''),
              variables.map((variable, column) => h('th', {
                key: variable.name,
                className: `${freeze.cols !== false && column === 0 ? 'ap-freeze-col' : ''}${dragColumn === variable.name ? ' ap-col-dragging' : ''}`,
                title: `${variable.name}${variable.label ? ` — ${variable.label}` : ''}（拖动表头调整列顺序；拖动右边界改列宽，双击右边界恢复）`,
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
              h('span', { className: 'ap-head-name' }, variable.name),
              // SPSS prints the variable label under the name in the header, so
              // a sheet of v1..v9 still reads as age/sex/score. Only two lines:
              // a third would push the rows down for nothing.
              variable.label ? h('span', { className: 'ap-head-label' }, variable.label) : null,
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

    function VariableGrid({ variables, widths = {}, onWidth, onUpdate, onAdd, onRename, onDelete, onEditLabels, onMove }) {
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
            title: `${title}（拖动右边界改列宽，双击恢复）`,
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
                  title: '单击改名',
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
            className: 'ap-var-item ap-danger',
            onClick: () => {
              const names = menu.names
              setMenu(null)
              ;(async () => {
                for (const name of names) await onDelete?.(name)
              })()
            },
          }, menu.names.length > 1 ? `删除这 ${menu.names.length} 个变量` : '删除变量'))
          : null)
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
        title: `编辑表格 — ${item?.title ?? '表格'}`,
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
      h('span', { className: 'ap-edit-index' }, `第 ${index + 1} 列`),
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
      tableEdits = {}, onEditTable = () => {}, onPairwise = () => {}, onRoc = () => {},
      onExportItem = () => {},
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
            h('span', { className: 'ap-hint' }, `报告卡：已选 ${picks.size} 个结果`),
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
                nodes.push(h('div', { key: `run-${runKey}`, className: 'ap-ol-run' }, `运行 ${runKey}`))
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
            const pick = picks && item.script
              ? h('input', {
                type: 'checkbox',
                title: '放进报告卡',
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
              const opened = from.openedAt ? new Date(from.openedAt).toLocaleString('zh-CN', { hour12: false }) : null
              // A dataset built in the panel has no file, so its name must not be
              // printed as if it were one ("prov-probe · 3 例" reads like a path).
              const built = from.origin === 'new'
              const dropped = from.origin === 'upload' || from.temporary === true
              const label = built
                ? `新建数据集${name ? `（${name}，未保存）` : '（未保存）'} · ${from.caseCount} 例 · ${from.varCount} 变量`
                : name
                  ? `${name} · ${from.caseCount} 例 · ${from.varCount} 变量`
                  : `未命名数据 · ${from.caseCount} 例 · ${from.varCount} 变量`
              const size = typeof from.sourceSize === 'number'
                ? (from.sourceSize < 1024 ? `${from.sourceSize} B` : `${(from.sourceSize / 1024).toFixed(1)} KB`)
                : null
              const modified = from.sourceMtime ? new Date(from.sourceMtime).toLocaleString('zh-CN', { hour12: false }) : null
              const detail = [
                built
                  ? '这份数据没有对应的磁盘文件（在面板里新建的）'
                  : dropped
                    ? '这份数据是浏览器拖进来的副本，不是磁盘上的那份'
                    : name ? `数据文件：${name}` : '这份数据没有对应的磁盘文件',
                from.sourcePath ? `来源路径：${from.sourcePath}` : null,
                from.sourcePath && size ? `读入时文件 ${size}${modified ? `，磁盘修改时间 ${modified}` : ''}` : null,
                `计算时 ${from.caseCount} 个个案、${from.varCount} 个变量`,
                opened ? `打开于 ${opened}` : null,
                `会话：${from.sessionId}`,
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
                    onClick: () => copyText(csv()).then(() => copyHint('表格已复制为 CSV')).catch((error) => copyHint(`复制失败：${error.message}`)),
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
                  return h('div', { className: 'ap-table-block' }, [
                    h('div', {
                      key: 'table',
                      className: 'ap-table-wrap',
                      dangerouslySetInnerHTML: { __html: drawn.html },
                    }),
                    hidden > 0
                      ? h('div', { key: 'more', className: 'ap-table-more' }, [
                        h('span', { key: 'note' }, `这张表共 ${drawn.total} 行，面板先画前 ${drawn.shown} 行（复制 CSV 与导出仍是全部）`),
                        h('button', {
                          key: 'toggle',
                          className: 'ap-tool',
                          onClick: () => toggleTableRows(item.id),
                        }, '显示全部'),
                      ])
                      : full && drawn.total > PREVIEW_ROWS
                        ? h('div', { key: 'less', className: 'ap-table-more' }, [
                          h('span', { key: 'note' }, `正在显示全部 ${drawn.total} 行`),
                          h('button', { key: 'toggle', className: 'ap-tool', onClick: () => toggleTableRows(item.id) }, '只显示前 200 行'),
                        ])
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
                    title: '导出为 SVG（矢量，文字可编辑）',
                    onClick: () => onExportChart(item, 'svg'),
                  }, '导出 SVG'),
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

    function ChartEditDialog({ title, onClose, onApply }) {
      const [heading, setHeading] = useState(title ?? '')
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
            xLabel,
            yLabel,
            accent: accent || '',
            sortCategories: order,
          })
        },
      },
      field('标题', text(heading, setHeading, '图表标题')),
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

    // A dropped file only exists as a copy inside the workspace, so its real
    // location is unknown: name it, say so, and never show the copy's path as
    // if it were the user's own file. An opened file shows its full path.
    function describeSource(dataset) {
      if (!dataset) return ''
      if (dataset.temporary === true) return `${dataset.name ?? basenameOf(dataset.sourcePath)}（拖入副本 · 路径未知）`
      return dataset.sourcePath ? String(dataset.sourcePath) : '未命名数据集'
    }

    /* ------------------------------------------------------------------ app */

    function App({ ctx, scope, tab, visible = true }) {
      ensureStyle()
      const baseSessionId = scope?.sessionId
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
      const sessionId = docId
      const tabPath = typeof tab?.path === 'string' ? tab.path : (typeof tab?.meta?.openPath === 'string' ? tab.meta.openPath : '')
      const [st, setSt] = useState(null)
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
      const MENU_MNEMONICS = { f: '文件', e: '编辑', d: '数据', t: '转换', a: '分析', g: '图形', u: '实用程序', h: '帮助' }
      // Read the labels off the DOM: the menu list itself is built further down
      // this component, and a hook may not depend on something declared later.
      const menuButtonLabels = () => [...(menuBarRef.current?.querySelectorAll('.ap-menu-button') ?? [])].map((node) => node.textContent)
      useEffect(() => {
        const onKey = (event) => {
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

      const notify = (message) => {
        setToast(message)
        window.setTimeout(() => setToast(null), 4200)
      }

      const refresh = useCallback(async () => {
        const value = await api(stateUrl(sessionId))
        setSt(value.state)
        return value.state
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
            notify(error.message)
          } finally {
            setBusy(false)
          }
        }
        if (action === 'insertCase') return run3('已在第 ' + (row + 1) + ' 行插入个案', async () => {
          const value = await api('api/case', { sessionId, action: 'insert', row })
          setSt(value.state)
          const page = await loadRows(0, 500)
          setRows(page.rows); setTotal(page.total)
        })
        if (action === 'deleteCase') return run3('已删除第 ' + (row + 1) + ' 行', async () => {
          const value = await api('api/case', { sessionId, action: 'delete', row })
          setSt(value.state)
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
            setSt(value.state)
            const page = await loadRows(0, 500)
            setRows(page.rows); setTotal(page.total)
          })
        }
        if (action === 'missing') {
          if (!variable || target.numeric !== true) { notify('只有数值变量可以设为系统缺失值'); return }
          return run3('已设为系统缺失值', async () => {
            const value = await api('api/cell', { sessionId, row, variable, value: 'SYSMIS' })
            setSt(value.state)
            const page = await loadRows(0, 500)
            setRows(page.rows); setTotal(page.total)
          })
        }
        if (action === 'sortAsc' || action === 'sortDesc') {
          if (!variable) { notify('这个格子还没有变量，无法排序'); return }
          return run3(action === 'sortAsc' ? `已按 ${variable} 升序排序` : `已按 ${variable} 降序排序`, async () => {
            const value = await api('api/sort', { sessionId, keys: [{ name: variable, order: action === 'sortAsc' ? 'a' : 'd' }] })
            setSt(value.state)
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
            setSt(value.state)
            if ((value.state.items ?? []).length > (before?.items ?? []).length && viewRef.current !== 'output') {
              notify('PSPP 有新输出（切换到「输出」查看）')
            }
            // The data sheet only has to reload when the data itself moved:
            // a new variable, a different case count or another file.
            const dataMoved = (before?.dataset?.caseCount ?? -1) !== (value.state.dataset?.caseCount ?? -1)
              || (before?.dataset?.sourcePath ?? null) !== (value.state.dataset?.sourcePath ?? null)
              || (before?.dataset?.variables ?? []).length !== (value.state.dataset?.variables ?? []).length
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

      const run = useCallback(async (text, persist, title, pairwise, regression, roc) => {
        setBusy(true)
        try {
          const value = await api('api/run', { sessionId, syntax: text, persist, pairwise, regression, roc })
          setSt(value.state)
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
            ? `${title ?? '运行'}完成，但有 ${errors.length} 个错误：${detail}`
            : `${title ?? '运行'}完成：${items.filter((item) => item.kind === 'table').length} 个表、${items.filter((item) => item.kind === 'image').length} 个图`)
          setDialog(null)
        } catch (error) {
          notify(error.message)
        } finally {
          setBusy(false)
        }
      }, [sessionId, loadRows])

      // Everything a multiple response set can do: refresh its frequency table,
      // tabulate it against a grouping variable, or drop it.
      const mrAction = useCallback(async (action, name, extra = {}) => {
        setBusy(true)
        try {
          const value = await api('api/mrset', { sessionId, ...extra, action, name })
          if (value.state) setSt(value.state)
          if (action === 'frequency' || action === 'crosstab') {
            // The new table is appended to the output, so pull the items again.
            await refresh()
            setView('output')
          }
          if (action === 'remove') {
            setActiveMr(null)
            notify(`已删除多选题 ${name}`)
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
          setSt(value.state)
          setView('output')
          const notes = value.result?.notes ?? []
          notify(`已生成：${value.result?.item?.title ?? '表格'}${notes.length ? `（${notes.length} 条提示）` : ''}`)
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
          setSt(value.state)
          setView('output')
          const count = (value.result?.matrix?.length ?? 1) - 1
          notify(`两两比较：${count} 对${value.result?.notes?.length ? `（${value.result.notes.length} 条提示）` : ''}`)
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
          setSt(value.state)
          setView('output')
          const count = (value.result?.matrix?.length ?? 1) - 1
          notify(`偏相关：${count} 对变量${value.result?.notes?.length ? `（${value.result.notes.length} 条提示）` : ''}`)
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
          setSt(value.state)
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
          setSt(value.state)
          setView('output')
          notify(`已生成图表：${value.result?.chart?.title ?? '图表'}`)
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
          setSt(value.state)
          const page = await loadRows(0, 500)
          setRows(page.rows)
          setTotal(page.total)
          setSelected(null)
          notify(`${action === 'redo' ? '已重做' : '已撤销'}：${value.result?.label ?? ''}`)
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
        notify(`新标签页：${name ?? path}`)
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
        if (value?.state) setSt(value.state)
        setView('data')
        // Column headings that had to be renamed for PSPP's rules are worth a
        // notice: the column the user is looking for now carries a different
        // name, and its original heading is only in the variable label.
        const renamed = value?.result?.notes ?? []
        if (renamed.length > 0) {
          notify(`${renamed.length} 列的表头不符合 PSPP 变量名规则，已改名（原表头保留为标签）：${renamed[0]}${renamed.length > 1 ? ` 等 ${renamed.length} 条，细节见状态栏「导入说明」` : ''}`)
        }
        return 'data'
      }, [docId, setSyntax, notify])

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
            notify(kind === 'syntax' ? `已载入语法：${displayPath(path)}` : `已打开 ${displayPath(path)}`)
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
            notify(`已打开 ${displayPath(path)}`)
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
          notify(`已打开 ${displayPath(path)}`)
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
            notify(`已拖入 ${file.name}：原路径未知（浏览器不给路径），要写回原文件请用「文件 → 打开数据…」`)
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
        setSt(value.state)
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
          notify(`已保存 ${path}`)
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
          '<!doctype html><meta charset="utf-8"><title>PSPP 输出</title>',
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
            parts.push(stampStyle(tableEdits[item.id]
              ? matrixHtml(item.table?.matrix, `ap-tbl-${tableStyle}`, tableEdits[item.id])
              : item.table?.html?.includes?.('<table') ? item.table.html : matrixHtml(item.table?.matrix)))
            // One line per table saying which data it came from: the block at
            // the bottom lists every source in the session, which does not tell
            // a reader handed a single table where its numbers came from.
            if (item.provenance) {
              const from = item.provenance
              const which = from.origin === 'new'
                ? `新建数据集${from.name ? `（${from.name}）` : ''}`
                : (from.name ?? from.sourcePath ?? '未命名数据')
              const when = from.openedAt ? new Date(from.openedAt).toLocaleString('zh-CN', { hour12: false }) : null
              const size = typeof from.sourceSize === 'number'
                ? (from.sourceSize < 1024 ? `${from.sourceSize} B` : `${(from.sourceSize / 1024).toFixed(1)} KB`)
                : null
              parts.push(`<p class="ap-export-source">${escapeForExport(`来源：${which} · ${from.caseCount} 例${size ? ` · ${size}` : ''}${when ? ` · 打开于 ${when}` : ''}`)}</p>`)
            }
            // The caveats (separation, skipped variables) are part of the table:
            // an HTML copy without them reads as if nothing was wrong.
            for (const note of item.notes ?? []) {
              const text = String(note ?? '').trim()
              if (!text) continue
              const safe = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
              parts.push(`<p class="ap-export-note">注：${safe}</p>`)
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
            const when = from.openedAt ? new Date(from.openedAt).toLocaleString('zh-CN', { hour12: false }) : null
            const which = from.origin === 'new'
              ? `新建数据集${from.name ? `（${from.name}，未保存）` : '（未保存）'}`
              : (from.sourcePath ?? from.name ?? '未命名数据')
            const size = band(from.sourceSize)
            return `${escapeForExport(which)} · ${from.caseCount} 例 · ${from.varCount} 变量${size ? ` · ${size}` : ''}${when ? ` · 打开于 ${escapeForExport(when)}` : ''}`
          })
          parts.push('<hr><p class="ap-export-note"><b>数据来源：</b><br>' + lines.join('<br>') + '</p>')
          parts.push('<p class="ap-export-note">（由 dsh-analytics 生成，引擎 GNU PSPP；改动数据后请重新运行分析。）</p>')
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
          notify(error.message)
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
            { label: '新建数据', action: async () => { const value = await api('api/new', { sessionId }); setSt(value.state); setView('data') } },
            { label: '打开数据…', action: () => setBrowser({ mode: 'open' }) },
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
            { label: '关闭数据集', action: () => closeDoc(sessionId) },
            { label: '导出输出为 HTML…', action: () => exportOutput() },
            { label: '导出表格为 CSV…', action: () => exportOutputCsv() },
          ],
        },
        {
          label: '编辑', items: [
            {
              label: history.undo > 0 ? `撤销 ${history.undoLabel ?? ''}（Ctrl+Z）` : '撤销（Ctrl+Z）',
              disabled: history.undo === 0,
              action: () => applyHistory('undo'),
            },
            {
              label: history.redo > 0 ? `重做 ${history.redoLabel ?? ''}（Ctrl+Y）` : '重做（Ctrl+Y）',
              disabled: history.redo === 0,
              action: () => applyHistory('redo'),
            },
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
            { label: `${freezeRows ? '✓ ' : ''}冻结首行（表头）`, action: () => toggleFreeze('rows') },
            { label: `${freezeCols ? '✓ ' : ''}冻结首列（行号与第一个变量）`, action: () => toggleFreeze('cols') },
            { label: '跳转到个案…', action: () => setDialog({ kind: 'goto', value: String((selected?.row ?? 0) + 1) }) },
            { sep: true },
            { label: '在输出中查找…', action: () => setDialog({ kind: 'outputSearch', value: outputQuery }) },
            { label: '输出表格样式', sub: [
              { label: `${styleOverride === null ? '✓ ' : ''}跟随设置（${settingStyle === 'grid' ? '全框线' : '三线表'}）`, action: () => chooseTableStyle(null) },
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
              setSt(value.state)
              const page = await loadRows(0, 500)
              setRows(page.rows)
              setTotal(page.total)
            } },
            { label: '删除个案', action: async () => {
              if (!selected) { notify('先在数据视图里选中一个单元格'); return }
              const value = await api('api/case', { sessionId, action: 'delete', row: selected.row })
              setSt(value.state)
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
            { label: '合并文件', sub: [
              { label: '添加个案…', action: () => setDialog({ kind: 'merge', mode: 'add', path: '', by: '' }) },
              { label: '按关键变量合并…', action: () => setDialog({ kind: 'merge', mode: 'match', path: '', by: '' }) },
            ] },
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
            { label: '受引擎限制的功能', sub: [
              { label: '生存分析（KM / Cox）', action: () => notify('PSPP 2.1.3 没有实现生存分析（not yet implemented）。替代：把数据导出 CSV，用 R 的 survival 包（KM 曲线、Cox 回归都在那里）。') },
              { label: '复杂抽样', action: () => notify('PSPP 2.1.3 没有实现复杂抽样（CSDESCRIPTIVES / CSTABULATE）。替代：用「数据 → 加权个案」近似分层权重，或导出后用 R 的 survey 包。') },
              { label: '多重插补', action: () => notify('PSPP 2.1.3 根本不认识 MULTIPLE IMPUTATION（Unknown command）。替代：用「数据 → 选择个案」排除缺失，或用「计算变量」做均值/中位数填补（会低估方差，需在限制里写明）。') },
              { label: '协方差分析（ANCOVA）', action: () => notify('PSPP 2.1.3 的 GLM 不接受 WITH 协变量子句。替代：用「回归 → 线性」把分组变量当哑变量、协变量当预测变量，等价于 ANCOVA 的模型。') },
              { label: '曲线估计（CURVEFIT）', action: () => notify('PSPP 2.1.3 返回「CURVEFIT 尚未实现」。替代：用「转换 → 计算变量」造 x²、ln(x)、1/x 等项，再跑「回归 → 线性」。') },
              { label: '多选题直接进 CROSSTABS 等过程', action: () => notify('PSPP 不认 $ 变量。替代：多选题的频数与交叉表由本插件自己算——「转换 → 多选题面板」；要进其他过程，先把选项拆成二分变量。') },
              { label: 'Durbin-Watson 残差自相关', action: () => notify('PSPP 的 REGRESSION 没有 /STATISTICS=DURBIN（只支持 COEFF、R、ANOVA、BCOV、CI、TOL）。替代：回归时勾「保存残差」，导出 CSV 后按公式算 DW。') },
              { label: '偏相关…', action: () => setDialog({ kind: 'partial' }) },
              { label: '决策树 / 报表 / 概率图', action: () => notify('TREE、REPORT、PPLOT 在 PSPP 2.1.3 都没有实现。替代：P-P/Q-Q 图可用「分析 → 探索」里的正态概率图近似；报表用「表 1 / 表 2」或导出 Word。偏相关已经由插件自己实现，见「相关 → 偏相关…」。') },
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
            {
              label: '快速图形（用当前选中的列）',
              items: [
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
          label: '帮助', items: [
            { label: '关于 PSPP 分析', action: () => notify('内置 PSPP 引擎 + SPSS 风格工作台；统计过程由 PSPP 执行。') },
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
      const KEYS_RE = /^(.*?)（((?:Ctrl|Alt|Shift|F\d)[^）]*)）$/
      const menuLabel = (label) => {
        const match = KEYS_RE.exec(String(label ?? ''))
        return match
          ? [h('span', { key: 'text' }, match[1]), h('span', { key: 'keys', className: 'ap-keys' }, match[2])]
          : [h('span', { key: 'text' }, label)]
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
      const caseText = st
        ? (st.dataset
          ? `${st.dataset.caseCount} 个个案 · ${st.dataset.variables.length} 个变量${st.dataset.dirty ? ' · 未保存' : ''}`
          : '未打开数据集')
        : '正在连接分析引擎…'
      const sourceText = st?.dataset ? describeSource(st.dataset) : ''
      const status = sourceText ? `${caseText}  |  ${sourceText}` : caseText
      const engineHint = st
        ? `引擎：${st.engine.source === 'bundled' ? '内置' : st.engine.source === 'system' ? '系统' : '缺失'}（${st.engine.bin ?? '—'}）`
        : ''
      // SPLIT FILE / WEIGHT / FILTER survive between runs but are invisible in
      // the data grid, so a filter left on from ten minutes ago silently changes
      // every number below it. The chips make that state impossible to miss.
      const clearSession = (syntax) => { void run(syntax, false, '取消会话设置') }
      const sessionChips = [
        st?.splitBy?.length
          ? {
            label: `拆分：${st.splitBy.join(' ')}`,
            title: 'SPLIT FILE 正在生效：每个结果按该变量的取值分组输出',
            onClear: () => clearSession('SPLIT FILE OFF.'),
          }
          : null,
        st?.weightBy
          ? {
            label: `加权：${st.weightBy}`,
            title: 'WEIGHT BY 正在生效：频数/分析按该变量加权',
            onClear: () => clearSession('WEIGHT OFF.'),
          }
          : null,
        st?.filterBy
          ? {
            label: `筛选：${st.filterBy}`,
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
              ? `${cellMenu.variable} · 第 ${cellMenu.row + 1} 行`
              : `第 ${cellMenu.row + 1} 行（还没有变量）`),
          h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('copy') }, '复制这个值'),
          h('div', { className: 'ap-sep' }),
          h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('insertCase') }, `在第 ${cellMenu.row + 1} 行前插入个案`),
          h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('deleteCase') }, `删除第 ${cellMenu.row + 1} 个个案`),
          cellMenu.variable
            ? h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('sortAsc') }, `整表按 ${cellMenu.variable} 升序`)
            : null,
          cellMenu.variable
            ? h('button', { className: 'ap-var-item', onClick: () => cellMenuAction('sortDesc') }, `整表按 ${cellMenu.variable} 降序`)
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
            }, `画 ${cellMenu.variable} 的直方图`)
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
        h('div', { className: 'ap-toolbar' },
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
        docs.length > 1 || (docs.length === 1 && Boolean(st?.dataset))
          ? h('div', { className: 'ap-doctabs' },
            docs.map((doc) => h('div', {
              key: doc.id,
              className: `ap-doctab ${doc.id === sessionId ? 'ap-active' : ''}`,
            },
            h('button', {
              className: 'ap-doctab-title',
              title: doc.id === sessionId ? status : (doc.title || doc.id),
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
                widths: colWidths,
                onWidth: setColWidth,
                onPaste: async (cells, options) => {
                  try {
                    const value = await api('api/paste', { sessionId, cells, extend: options?.extend === true })
                    setSt(value.state)
                    const added = []
                    if (value.result?.addedCases) added.push(`新增 ${value.result.addedCases} 个个案`)
                    if (value.result?.addedVariables) added.push(`新增 ${value.result.addedVariables} 个变量`)
                    setToast(`已粘贴 ${cells.length} 个单元格${added.length ? `（${added.join('、')}）` : ''}`)
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
                    setSt(value.state)
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
                  widths: colWidths,
                  onWidth: setColWidth,
                  onUpdate: async (name, patch) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'update', name, patch })
                      setSt(value.state)
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onAdd: async (name) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'add', spec: { name } })
                      setSt(value.state)
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onRename: async (from, to) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'update', name: from, patch: { name: to } })
                      setSt(value.state)
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onMove: async (name, position) => {
                    try {
                      const value = await api('api/variable', { sessionId, action: 'move', name, position })
                      setSt(value.state)
                    } catch (error) {
                      notify(error.message)
                    }
                  },
                  onDelete: async (name) => {
                    const value = await api('api/variable', { sessionId, action: 'delete', name })
                    setSt(value.state)
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
                    title: item.title || item.alt || 'chart',
                  }),
                  tableStyle,
                  picks: reportPick,
                  onTogglePick: (id) => (id === '__clear__' ? setReportPick(new Set()) : toggleReportPick(id)),
                  onReportExport: () => setBrowser({ mode: 'report', format: 'pdf' }),
                  onRemove: async (id) => {
                    const value = await api('api/output', { sessionId, action: 'remove', id })
                    setSt(value.state)
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
          sessionChips.length > 0
            ? h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              ...sessionChips.map((chip) => h('span', { className: 'ap-chip', title: chip.title },
                chip.label,
                chip.onClear
                  ? h('span', { className: 'ap-chip-x', title: '取消这个设置', onClick: chip.onClear }, '×')
                  : null)))
            : null,
          outputQuery
            ? h('span', { className: 'ap-hint' }, `输出筛选「${outputQuery}」：${items.length}/${allItems.length}`,
              h('button', { className: 'ap-tool', style: { marginLeft: 6 }, onClick: () => setOutputQuery('') }, '清除'))
            : null,
          h('span', { className: 'ap-grow' }),
          h('span', { className: 'ap-status-right' },
            engineHint
              ? h('span', { title: engineHint }, st?.engine?.source === 'bundled' ? '引擎：内置' : (st?.engine?.source === 'system' ? '引擎：系统' : '引擎：缺失'))
              : null,
            h('span', { title: st?.lastError?.raw ?? '' },
              st?.lastError
                ? `最近错误：${st.lastError.message}${st.lastError.hint ? ` — ${st.lastError.hint}` : ''}`
                : '就绪'),
            // A toast is gone in four seconds; the list of renamed columns is
            // what the user goes looking for later, when a column is not where
            // the spreadsheet said it was.
            (st?.importNotes ?? []).length > 0
              ? h('button', {
                className: 'ap-tool',
                title: '导入时哪些列名被改过、原名保存在哪里',
                onClick: () => setDialog({ kind: 'importNotes', notes: st.importNotes }),
              }, `导入说明 ${st.importNotes.length}`)
              : null,
            st?.version
              ? h('span', { className: 'ap-status-version', title: `插件版本 ${st.version}（改后端代码后停用再启用本插件即可生效，但要重新打开数据文件）` }, `v${st.version}`)
              : null)),
        toast ? h('div', { className: 'ap-toast' }, toast) : null,
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
              if (built?.error) { notify(built.error); return }
              if (built.chart) {
                await runChart(built.chart)
                return
              }
              await run(built.syntax, built.persist === true, spec?.title, built.pairwise, built.regression, built.roc)
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
                setSt(value.state)
                notify('图表已更新')
              } catch (error) {
                notify(error.message)
              }
            },
          })
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
            h('span', null, dialog.kind === 'goto' ? `个案编号（1–${total || 1}）` : '关键字'),
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
                setSt(value.state)
                notify(`已定义多选题 ${setDefinition.name}`)
              } catch (error) { notify(error.message) }
            },
          })
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
                  setSt(value.state)
                }
                const count = Object.keys(labels).length
                notify(targets.length > 1
                  ? `已给 ${targets.length} 个变量各写入 ${count} 条值标签`
                  : `已给 ${name} 写入 ${count} 条值标签`)
              } catch (error) { notify(error.message) }
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
                notify(`找到 ${value.result.total}${value.result.truncated ? '+' : ''} 处，第一处在第 ${match.row + 1} 行的 ${match.variable}`)
              } catch (error) {
                notify(error.message)
              }
            },
            onReplace: async (spec) => {
              try {
                const value = await api('api/replace', { sessionId, find: spec.find, replace: spec.replace, options: spec })
                setSt(value.state)
                const page = await loadRows(0, 500)
                setRows(page.rows)
                setTotal(page.total)
                setDialog(null)
                notify(value.result.replaced > 0 ? `已替换 ${value.result.replaced} 处` : '没有可替换的内容')
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
                notify(`已转换为 ${String(value.result.format).toUpperCase()}：${value.result.path}（${Math.round(value.result.bytes / 1024)} KB）`)
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
                setSt(value.state)
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
            title: `值标签 — ${labelsDialog.name}`,
            onCancel: () => setLabelsDialog(null),
            onOk: async () => {
              const entries = labelsDialog.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
              const labels = {}
              for (const line of entries) {
                const at = line.indexOf('=')
                if (at < 0) { notify(`无法解析「${line}」，应为 值=标签`); return }
                labels[line.slice(0, at).trim()] = line.slice(at + 1).trim()
              }
              const value = await api('api/variable', { sessionId, action: 'update', name: labelsDialog.name, patch: { valueLabels: labels } })
              setSt(value.state)
              setLabelsDialog(null)
              notify(`已更新 ${labelsDialog.name} 的 ${Object.keys(labels).length} 个值标签`)
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
            message: `${st?.dataset?.name ?? '当前数据'} 有未保存的改动。关闭后这些改动只剩下工作文件里的一份副本，面板里没有入口再打开它。要先保存吗？`,
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
              chartExport: '导出图表到…',
              itemCsv: '导出表格到…',
              export: '导出为 CSV…',
              labelFile: '选择值标签文件',
            }[browser.mode] ?? '选择文件',
            extra: browser.mode === 'office'
              ? h('div', null,
                Array.isArray(browser.only) && browser.only.length > 0
                  ? h('div', { className: 'ap-row', style: { alignItems: 'center', gap: 8 } },
                    h('span', { className: 'ap-hint' }, '导出范围'),
                    h('strong', null, `只导出「${browser.title ?? '这一张表'}」`))
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
              if (mode === 'merge') { setDialog((prev) => (prev && prev.kind === 'merge' ? { ...prev, path } : prev)); return }
              if (mode === 'save') {
                setBusy(true)
                try { await api('api/save', { sessionId, path }); await refresh(); notify(`已保存 ${path}`) }
                catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'convert') { setConvertPath(path); setDialog({ kind: 'convert' }); return }
              if (mode === 'syntax') {
                if (!syntax.trim()) { notify('语法编辑器是空的，先写点东西再保存'); return }
                try {
                  const value = await api('api/saveSyntax', { sessionId, path, text: syntax })
                  notify(`已保存语法 ${value.result.path}（${value.result.bytes} 字节）`)
                } catch (error) { notify(error.message) }
                return
              }
              if (mode === 'office') {
                setBusy(true)
                try {
                  const value = await api('api/exportOffice', { sessionId, path, scope: browser.scope ?? 'session', formulas: browser.formulas !== false, data: browser.dataSheet === true, items: browser.only ?? null })
                  const r = value.result
                  notify(`已导出 ${r.path}（${Math.round(r.bytes / 1024)} KB，${r.tables} 个表、${r.images} 张图）`)
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'chartExport') {
                setBusy(true)
                try {
                  const value = await api('api/chart/export', { sessionId, runId: browser.runId, path, format: browser.format })
                  notify(`已导出 ${value.result.path}（${Math.round(value.result.bytes / 1024)} KB）`)
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
                try { await api('api/export', { sessionId, path }); notify(`已导出 ${path}`) }
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
                  notify(`已导出 ${value.result.path}（${Math.round(value.result.bytes / 1024)} KB）`)
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
                  notify(`已导出报告卡 ${value.result.path}（${Math.round(value.result.bytes / 1024)} KB，${scripts.length} 个结果）`)
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
                return
              }
              if (mode === 'exportdoc') {
                setBusy(true)
                try {
                  const value = await api('api/exportDoc', { sessionId, path, format: browser.format })
                  notify(`已导出 ${value.result.path}（${Math.round(value.result.bytes / 1024)} KB）`)
                } catch (error) { notify(error.message) }
                finally { setBusy(false) }
              }
            },
          })
          : null)
    }

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
            h('label', { className: 'ap-hint' }, `键变量（空格分隔，可选：${numeric.slice(0, 12).join(' ')}${numeric.length > 12 ? ' …' : ''}）`),
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
          h('div', null, `已交给「统计分析」打开 ${title ?? basenameOf(path)}。`),
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
        key: 'tableStyle',
        label: '输出表格样式',
        kind: 'select',
        options: [['three-line', '三线表（SPSS 默认）'], ['grid', '网格（带竖线）']],
        hint: '立即生效：面板、导出的 HTML、Word 与 Excel 都跟它走。',
      },
      {
        key: 'allowedDirs',
        label: '允许读写哪些目录（每行一个）',
        kind: 'lines',
        placeholder: '例如 /mnt/F/数据\n例如 D:\\实验室',
        hint: '插件的打开、保存、导出、合并、转换只在这些目录里工作。默认允许：主目录、当前工作目录、临时目录、/mnt、/tmp。~/.dsh、~/.ssh、~/.gnupg 永远不允许（里面有登录凭据）。要读写别处，把它的上级目录加到这里。',
      },
    ]

    function SettingsTab() {
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
            tableStyle: payload.settings.tableStyle,
            allowedDirs: (payload.settings.allowedDirs ?? []).join('\n'),
          })
          setError('')
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const save = useCallback(async () => {
        if (!form) return
        setBusy(true)
        setError('')
        setStatus('')
        try {
          const payload = await api('api/settings', {
            patch: {
              maxRows: Number(form.maxRows),
              timeoutMs: Number(form.timeoutMs) * 1000,
              safer: form.safer === true,
              tableStyle: form.tableStyle,
              allowedDirs: String(form.allowedDirs ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
            },
          })
          setData(payload)
          setStatus('已保存。表格样式、允许的目录立即生效；载入上限与超时在下一次使用生效。')
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [form])

      if (error && !data) return h('div', { className: 'ap-root ap-settings' }, h('p', { className: 'ap-error' }, `设置读不出来：${error}`))

      if (!data || !form) return h('div', { className: 'ap-root ap-settings' }, h('p', { className: 'ap-hint' }, '正在读取设置…'))

      const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

      return h('div', { className: 'ap-root ap-settings' }, [
        h('h3', { key: 'title', className: 'ap-settings-title' }, '统计分析'),
        h('p', { key: 'where', className: 'ap-hint' },
          `设置文件：${data.path}${data.exists ? '' : '（还没创建，保存后生成）'}`),
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
          h('strong', { key: 'h' }, `工具挂载（registerTools）：${data.deploymentOnly.registerTools.value ? '开' : '关'}`),
          h('p', { key: 'p', className: 'ap-hint' }, data.deploymentOnly.registerTools.note),
        ]),
        h('div', { key: 'actions', className: 'ap-settings-actions' }, [
          h('button', { key: 'save', type: 'button', className: 'ap-btn ap-primary', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存'),
          h('button', { key: 'reload', type: 'button', className: 'ap-btn', disabled: busy, onClick: load }, '重新读取'),
        ]),
        status ? h('p', { key: 'status', className: 'ap-hint ap-settings-ok' }, status) : null,
        error ? h('p', { key: 'err', className: 'ap-error' }, error) : null,
      ].filter(Boolean))
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
      // `slots` is the settings shell: without it the panel is reachable but the
      // plugin has no page in 设置, so every knob would stay a YAML edit.
      //
      // The seat is `settings.section`: this build's settings panel lists one
      // page per entry there (a whole page, unlike `settings.general.item`,
      // which contributes a single row). `settings.plugins.tab` does not exist
      // in this version — registering there silently mounts nothing.
      inject: ['betterSidebar', 'slots'],
      apply(ctx) {
        if (ctx.slots) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'analytics',
            order: 80,
            label: '统计分析',
          }, () => h(SettingsTab)))
        }
        if (!ctx.betterSidebar) return
        ctx.effect(() => ctx.betterSidebar.registerFileViewer({
          id: 'analytics:data',
          title: () => '统计分析',
          icon: (size) => ICON(size),
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
          title: () => '统计分析',
          description: () => '统计分析工作台（内置 GNU PSPP 引擎）：数据视图、语法、输出与常用过程',
          icon: (size) => ICON(size),
          // One tab per open data file (SPSS opens a Data Editor per file);
          // the primary tab is deduped under 'primary'.
          single: false,
          dedupeKey: (tab) => tab?.meta?.docId ?? 'primary',
          order: 30,
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
