// 复现包：把「这次分析是怎么来的」整理成一堆能带走、能重跑的文件。
//
// 一份结果不写清数据来源、跑过哪些语法、用的是哪个版本，过三个月自己都复现不了。
// 这里不猜：数据字典、每次运行的真语法（引擎收到的那一份）、运行日志、版本号
// 全部照实抄进包里，跑不出来是缺数据而不是缺信息。

const pad = (value, width = 3) => String(value).padStart(width, '0')

/** 变量字典 → 一行一个变量的纯文本表（也写进 dataset.json）。 */
export function dictionaryRows(dataset) {
  return (dataset?.variables ?? []).map((variable, index) => ({
    order: index + 1,
    name: variable.name,
    label: variable.label || '',
    type: variable.type ?? 'numeric',
    measure: variable.measure ?? '',
    width: variable.width ?? null,
    decimals: variable.decimals ?? null,
    missing: variable.missing ?? [],
    valueLabels: variable.valueLabels ?? {},
  }))
}

/** 数据来源的一句话摘要（面板与包里都用同一份口径）。 */
export function datasetSummary(dataset, cases) {
  const name = dataset?.name ?? 'New dataset'
  const source = dataset?.sourcePath ?? '（尚未保存到文件）'
  return `${name} · ${cases} 例 · ${source}`
}

/**
 * 包里每个文件的内容。
 *
 * 返回 `[{ path, text }]`，`path` 是相对包目录的路径（用 `/` 分隔）。
 * 二进制（数据副本）不在这里，由调用方复制。
 */
export function bundleFiles({ dataset, cases, runs, log, versions, datasetFile }) {
  const files = []
  const summary = datasetSummary(dataset, cases)
  const syntaxFiles = []
  for (const run of runs ?? []) {
    if (!run.script) continue
    const name = `syntax/${pad(run.runId)}-${run.label || 'run'}.sps`
    syntaxFiles.push({ runId: run.runId, path: name })
    files.push({
      path: name,
      text: [
        `* 第 ${run.runId} 次运行${run.at ? `（${new Date(run.at).toISOString()}）` : ''}${run.title ? `：${run.title}` : ''}.`,
        // 每次运行都从工作文件读起，包里带的是引擎真正收到的那一份脚本，
        // 换一台机器上重跑时把 GET FILE 换成自己的数据文件即可。
        ...String(run.script).trimEnd().split('\n'),
        '',
      ].join('\n'),
    })
  }
  files.push({
    path: 'dataset.json',
    text: `${JSON.stringify({
      summary,
      cases,
      engine: versions?.engine ?? null,
      plugin: versions?.plugin ?? null,
      settings: versions?.settings ?? null,
      dataFile: datasetFile ?? null,
      variables: dictionaryRows(dataset),
      runs: (runs ?? []).map((run) => ({ runId: run.runId, at: run.at ?? null, title: run.title ?? null, script: syntaxFiles.find((entry) => entry.runId === run.runId)?.path ?? null })),
    }, null, 2)}\n`,
  })
  files.push({
    path: 'log.txt',
    text: (log ?? []).map((entry) => `${entry.at ? new Date(entry.at).toISOString() : '—'}\t${entry.text}`).join('\n') + '\n',
  })
  files.push({
    path: 'README.md',
    text: [
      '# 复现包',
      '',
      `- 数据：${summary}`,
      `- 引擎：${versions?.engine ?? '未知'}`,
      `- 插件：${versions?.plugin ?? '未知'}`,
      ...(datasetFile ? [`- 包内数据文件：\`${datasetFile}\``] : ['- 数据文件没有打进包：把原始数据放在同目录，或改脚本里的 `GET FILE` 路径']),
      '- 脚本开头的 `*` 注释记录了这次运行的顺序，删掉不影响重跑。',
      '',
      '## 怎么重跑',
      '',
      '1. 用上面的数据文件打开 PSPP（或本插件的 `pspp_open`）。',
      '2. 打开 `syntax/` 里的脚本，把 `GET FILE=\'…\'` 那一行（脚本开头，前面可能有一行 `*` 注释）换成本机数据文件的路径。',
      '3. 按编号顺序执行 —— 编号就是当初运行的先后，后面的脚本可能依赖前面的变换。',
      '',
      '## 包里有什么',
      '',
      '- `dataset.json`：数据字典（变量名、标签、类型、测量级别、缺失值、值标签）、版本号与每次运行对应的脚本。',
      '- `syntax/*.sps`：引擎真正收到的语法，不是界面上填的参数。',
      '- `log.txt`：这次会话里做过的动作（含导出、保存、定义多选题等），用于对照。',
      '',
      `脚本 ${syntaxFiles.length} 个。`,
      '',
    ].join('\n'),
  })
  return files
}
