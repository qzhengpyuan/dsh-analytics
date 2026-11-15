// Word/Excel export: the archive itself and the XML inside it.
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import assert from 'node:assert'

import { buildZip, xmlEscape } from '../lib/zip.js'
import { buildDocx, buildXlsx, cellRuns, escapeSheetName, formulaMap, imageExtent, pairCharts, pngSize, sheetName, sheetXml, tableXml } from '../lib/office.js'

let checks = 0
const failures = []
const check = async (name, fn) => {
  checks += 1
  try {
    await fn()
    console.log(`ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

/** Minimal reader: walk the central directory and return `{ name: Buffer }`. */
function unzip(buffer) {
  const entries = {}
  let end = buffer.length - 22
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1
  assert.ok(end >= 0, 'no end-of-central-directory record')
  const count = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'central header signature')
    const method = buffer.readUInt16LE(cursor + 10)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtra = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtra
    const raw = buffer.subarray(start, start + size)
    entries[name] = method === 0 ? raw : inflateRawSync(raw)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

await check('buildZip round-trips names and bytes', () => {
  const archive = buildZip({ 'a.txt': 'hello', 'dir/b.bin': Buffer.from([1, 2, 3]) })
  const files = unzip(archive)
  assert.equal(files['a.txt'].toString('utf8'), 'hello')
  assert.deepEqual([...files['dir/b.bin']], [1, 2, 3])
})

await check('xmlEscape removes markup and control characters', () => {
  assert.equal(xmlEscape('a<b>&"'), 'a&lt;b&gt;&amp;&quot;')
  assert.equal(xmlEscape('x\u0001y'), 'xy')
})

await check('buildDocx carries every table and its caption', () => {
  const docx = buildDocx({
    title: '报告',
    items: [
      { kind: 'table', table: { caption: 'Descriptives', matrix: [['变量', 'N'], ['score', '60']] } },
      { kind: 'table', title: 'ANOVA', table: { matrix: [['F', 'p'], ['3.2', '.048']] } },
      { kind: 'image', title: '直方图', url: '/analytics/api/artifact?name=chart.svg' },
    ],
    images: [{ url: '/analytics/api/artifact?name=chart.svg', bytes: Buffer.from('PNGDATA'), width: 560, height: 360 }],
  })
  const files = unzip(docx)
  const document = files['word/document.xml'].toString('utf8')
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/media/chart1.png']) {
    assert.ok(files[part], `missing ${part}`)
  }
  assert.match(document, /Descriptives/)
  assert.match(document, /ANOVA/, 'a table without a caption uses its title')
  assert.match(document, /rIdImg1/, 'the picture is referenced')
  assert.match(files['word/_rels/document.xml.rels'].toString('utf8'), /media\/chart1\.png/)
})

await check('buildXlsx gives each table a sheet and keeps numbers numeric', () => {
  const xlsx = buildXlsx({
    items: [
      { kind: 'table', table: { caption: 'Descriptives', matrix: [['变量', 'N'], ['score', '60']] } },
      { kind: 'table', table: { caption: '描述统计', matrix: [['均值'], ['59.34']] } },
    ],
  })
  const files = unzip(xlsx)
  const sheet1 = files['xl/worksheets/sheet1.xml'].toString('utf8')
  assert.match(sheet1, /<c r="B3" s="0"><v>60<\/v><\/c>/, 'numeric cells stay numeric so Excel can sum them')
  assert.match(sheet1, /<c r="A2" t="inlineStr"/, 'text cells are inline strings')
  assert.match(files['xl/workbook.xml'].toString('utf8'), /name="Descriptives"/)
  assert.ok(files['xl/worksheets/sheet2.xml'], 'the second table gets its own sheet')
  assert.match(files['xl/worksheets/sheet2.xml'].toString('utf8'), /描述统计/)
})

await check('a significance marker is a superscript run, not plain text', () => {
  // A journal table writes "-10.000**" with the stars raised. Word only raises
  // them through a separate run with <w:vertAlign w:val="superscript"/>, so the
  // cell has to be split; a plain run would print them on the baseline.
  const runs = cellRuns('-10.000 **').match(/<w:r>.*?<\/w:r>/g) ?? []
  assert.equal(runs.length, 2, 'the value and the marker are separate runs')
  assert.match(runs[0], /<w:t xml:space="preserve">-10\.000<\/w:t>/, 'the value keeps its own run')
  assert.doesNotMatch(runs[0], /\*/, 'the stars are not in the value run')
  assert.match(runs[1], /<w:vertAlign w:val="superscript"\/>/, 'the marker carries superscript')
  assert.match(runs[1], /<w:t>\*\*<\/w:t>/, 'both stars travel together')
  // Header cells are never split: a header that ends in a star is not a marker.
  assert.doesNotMatch(cellRuns('P（Bonferroni）*', true), /vertAlign/)
  // Text without a marker stays one run, unchanged.
  assert.equal((cellRuns('0.51').match(/<w:r>/g) ?? []).length, 1)
  // A whole table keeps ordinals and the marker in one cell paragraph.
  const table = tableXml([['变量', '男 vs 女'], ['score', '-10.000 **']])
  assert.match(table, /<w:vertAlign w:val="superscript"\/>/)
})

await check('a second run of the same model points at its own ANOVA sheet', () => {
  // Both runs write "ANOVA (score)" and "Coefficients (score)". Keying the
  // cross-sheet reference on the caption alone made one run's t tests read the
  // other run's residual df, which silently changes every p value.
  const anova = (runId, df) => ({
    kind: 'table',
    runId,
    table: {
      caption: 'ANOVA (score)',
      matrix: [
        ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
        ['Regression', '142.39', '2', '71.20', '1051.92', '.000'],
        ['Residual', '.61', df, '.07', '', ''],
        ['Total', '143.00', '11', '', '', ''],
      ],
    },
  })
  const coefficients = (runId, t) => ({
    kind: 'table',
    runId,
    table: {
      caption: 'Coefficients (score)',
      matrix: [
        ['', 'Unstandardized Coefficients', '', 'Standardized Coefficients', 't', 'Sig.'],
        ['', 'B', 'Std. Error', 'Beta', '', ''],
        ['(Constant)', '-.02', '.19', '', '-.12', '.911'],
        ['x1', '.37', '.06', '.72', t, '.000'],
      ],
    },
  })
  const files = unzip(buildXlsx({ items: [anova(1, '9'), coefficients(1, '5.94'), anova(2, '4'), coefficients(2, '2.36')] }))
  const names = (files['xl/workbook.xml'].toString('utf8').match(/name="[^"]+"/g) ?? [])
    .map((entry) => entry.slice(6, -1))
  const first = files['xl/worksheets/sheet2.xml'].toString('utf8')
  const second = files['xl/worksheets/sheet4.xml'].toString('utf8')
  assert.match(first, new RegExp(`'${names[0].replace(/[()]/g, '\\$&')}'!C4`), 'run 1 reads the first ANOVA sheet')
  assert.match(second, new RegExp(`'${names[2].replace(/[()]/g, '\\$&')}'!C4`), 'run 2 reads the second ANOVA sheet')
  assert.notEqual(names[0], names[2], 'the two sheets are told apart')
})

await check('docx matches charts by artifactUrl, not just url', () => {
  const docx = buildDocx({
    // The panel's items carry artifactUrl; a mismatch here once shipped a
    // document with no pictures at all while the byte count looked right.
    items: [{ kind: 'image', title: '直方图', artifactUrl: '/analytics/api/artifact?runId=3&name=output-1.png' }],
    images: [{ url: '/analytics/api/artifact?runId=3&name=output-1.png', bytes: Buffer.from('PNG'), width: 640, height: 480 }],
  })
  const files = unzip(docx)
  assert.ok(files['word/media/chart1.png'], 'the picture is in the archive')
  assert.equal(files['word/media/chart1.png'].toString('utf8'), 'PNG')
})

await check('pngSize reads the IHDR chunk', () => {
  const buffer = Buffer.alloc(24)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(640, 16)
  buffer.writeUInt32BE(480, 20)
  assert.deepEqual(pngSize(buffer), { width: 640, height: 480 })
  assert.deepEqual(pngSize(Buffer.from('not a png at all, sorry')), { width: null, height: null })
})

await check('sheet names are sanitised, unique and short', () => {
  const used = new Set()
  assert.equal(sheetName('a/b:c*d', 0, used), 'a b c d')
  assert.equal(sheetName('', 3, used), 'Sheet4')
  const long = sheetName('x'.repeat(40), 0, used)
  assert.equal(long.length, 31)
  const duplicate = sheetName('x'.repeat(40), 1, used)
  assert.notEqual(duplicate, long, 'duplicates get a suffix')
  assert.ok(duplicate.length <= 31)
})

await check('sheetXml merges the caption row across the table width', () => {
  const xml = sheetXml([['a', 'b'], ['1', '2']], ' título ')
  assert.match(xml, /mergeCell ref="A1:B1"/)
  assert.match(xml, /<row r="2"><c r="A2" t="inlineStr"/, 'the matrix starts under the caption')
  assert.match(xml, /<row r="3">/, 'and the second row follows it')
})

await check('an empty export still produces an openable workbook', () => {
  const files = unzip(buildXlsx({ items: [] }))
  assert.ok(files['xl/worksheets/sheet1.xml'])
  assert.match(files['xl/worksheets/sheet1.xml'].toString('utf8'), /没有表格输出/)
})

await check('docx keeps table notes as italic paragraphs under the table', () => {
  // A separation warning that only exists in the panel is worthless: the Word
  // file is what a supervisor reads.
  const docx = buildDocx({
    items: [{
      kind: 'table',
      table: { caption: 'Variables in the Equation', matrix: [['', 'B'], ['score', '23.06']] },
      notes: ['预测变量的标准误异常大：这通常是分离', '本例可用 Firth 惩罚似然复核'],
    }],
  })
  const document = unzip(docx)['word/document.xml'].toString('utf8')
  assert.match(document, /<w:i\/>/, 'a note is italic')
  assert.match(document, /<w:sz w:val="21"\/>/, 'a note is 10.5 pt')
  assert.equal((document.match(/注：/g) ?? []).length, 2, 'one paragraph per note')
  assert.match(document, /注：预测变量的标准误异常大：这通常是分离/)
  assert.ok(document.indexOf('注：') > document.indexOf('</w:tbl>'), 'notes follow their table')
})

await check('docx puts a chart inside the table it belongs to', () => {
  const docx = buildDocx({
    items: [
      { kind: 'table', runId: 2, table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
      { kind: 'image', title: '直方图', sourceRunId: 2, artifactUrl: '/analytics/api/artifact?runId=7&name=chart.svg' },
    ],
    images: [{ url: '/analytics/api/artifact?runId=7&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }],
  })
  const document = unzip(docx)['word/document.xml'].toString('utf8')
  const table = document.slice(document.indexOf('<w:tbl>'), document.indexOf('</w:tbl>'))
  assert.match(table, /<wp:inline/, 'the picture is an inline anchor, never floating')
  assert.doesNotMatch(document, /<wp:anchor/, 'no floating anchor sneaks in')
  assert.match(table, /<w:gridSpan w:val="2"\/>/, 'one merged row holds it')
})

await check('xlsx writes notes under the matrix with an italic style', () => {
  const xlsx = buildXlsx({
    items: [{
      kind: 'table',
      table: { caption: 'Coefficients', matrix: [['变量', 'B'], ['age', '.13']] },
      notes: ['容忍度与 VIF 见下面的共线性诊断'],
    }],
  })
  const sheet = unzip(xlsx)['xl/worksheets/sheet1.xml'].toString('utf8')
  assert.match(sheet, /t="inlineStr" s="3"/, 'notes use the italic style')
  assert.match(sheet, /注：容忍度与 VIF 见下面的共线性诊断/)
  assert.match(sheet, /mergeCell ref="A4:B4"/, 'the note spans the table width')
})

await check('xlsx anchors a chart to the first cell of its table and reserves rows', () => {
  const xlsx = buildXlsx({
    items: [
      { kind: 'table', runId: 3, table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
      { kind: 'image', title: '直方图', sourceRunId: 3, artifactUrl: '/analytics/api/artifact?runId=8&name=chart.svg' },
    ],
    images: [{ url: '/analytics/api/artifact?runId=8&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }],
  })
  const files = unzip(xlsx)
  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8')
  assert.match(sheet, /<drawing r:id="rId1"\/>/, 'the sheet points at a drawing')
  const drawing = files['xl/drawings/drawing1.xml'].toString('utf8')
  assert.match(drawing, /<xdr:oneCellAnchor>/, 'a one-cell anchor, not a float')
  assert.match(drawing, /<xdr:from><xdr:col>0<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>0<\/xdr:row>/, 'pinned to the first cell')
  assert.ok(files['xl/media/image1-1.png'], 'the picture travels in the archive')
  assert.ok(files['xl/worksheets/_rels/sheet1.xml.rels'], 'sheet relationships exist')
  // The caption no longer sits in row 1: blank rows make room for the picture,
  // otherwise Excel draws the chart on top of the numbers.
  assert.doesNotMatch(sheet, /<row r="1"><c r="A1"/, 'row 1 is reserved')
  assert.match(sheet, /customHeight="1"/, 'the reserved rows have a fixed height')
  const drawAt = Number(/<drawing r:id/.exec(sheet) ? 1 : 0)
  assert.equal(drawAt, 1)
})

await check('an xlsx with only a chart still produces a sheet', () => {
  const xlsx = buildXlsx({
    items: [{ kind: 'image', title: '直方图', url: '/analytics/api/artifact?runId=4&name=chart.svg' }],
    images: [{ url: '/analytics/api/artifact?runId=4&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }],
  })
  const files = unzip(xlsx)
  assert.ok(files['xl/drawings/drawing1.xml'], 'the drawing is there')
  assert.match(files['xl/workbook.xml'].toString('utf8'), /name="图表"/)
})

await check('a chart from another run never lands in a table it does not explain', () => {
  // The D11 case: a distribution chart drawn right after a logistic regression
  // used to be embedded in the coefficients table because that table happened to
  // be above it. A multi-table run gives no way to know which table the chart
  // belongs to, so the chart has to stay on its own.
  const items = [
    { kind: 'table', runId: 6, id: 't1', table: { caption: 'Variables in the Equation', matrix: [['', 'B'], ['score', '36.5']] } },
    { kind: 'table', runId: 6, id: 't2', table: { caption: 'Classification Table', matrix: [['', 'y'], ['1', '1990']] } },
    { kind: 'image', id: 'c1', title: '两组均分', sourceRunId: 6, chartSpec: { kind: 'bar', variable: 'score', by: 'y' }, artifactUrl: '/analytics/api/artifact?runId=9&name=chart.svg' },
  ]
  const images = [{ url: '/analytics/api/artifact?runId=9&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }]
  const { paired, standalone } = pairCharts(items)
  assert.equal(paired.size, 0, 'no table claims the picture')
  assert.equal(standalone.size, 1)
  const docx = buildDocx({ items, images })
  const document = unzip(docx)['word/document.xml'].toString('utf8')
  const tables = document.split('<w:tbl>').slice(1).map((chunk) => chunk.split('</w:tbl>')[0])
  assert.ok(tables.every((table) => !table.includes('<wp:inline')), 'no table holds the picture')
  assert.match(document, /<wp:inline/, 'it is still in the document, on its own')
})

await check('a chart from a single-table run goes into that table', () => {
  const items = [
    { kind: 'table', runId: 4, id: 't1', table: { caption: 'Frequencies', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'image', id: 'c1', title: '直方图', sourceRunId: 4, chartSpec: { kind: 'histogram', variable: 'score' }, artifactUrl: '/analytics/api/artifact?runId=10&name=chart.svg' },
  ]
  const { paired } = pairCharts(items)
  assert.deepEqual([...paired.keys()].map((table) => table.id), ['t1'])
})

await check('an unambiguous text match still pairs a chart', () => {
  const items = [
    { kind: 'table', runId: 5, id: 't1', table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'table', runId: 5, id: 't2', table: { caption: '单样本检验', matrix: [['检验值', 't'], ['60', '.56']] } },
    { kind: 'image', id: 'c1', title: '均分按 score 分组', sourceRunId: 5, chartSpec: { kind: 'bar', variable: 'score' }, artifactUrl: '/analytics/api/artifact?runId=11&name=chart.svg' },
  ]
  const { paired } = pairCharts(items)
  assert.deepEqual([...paired.keys()].map((table) => table.id), ['t1'])
})

await check('an explicit table id wins over the automatic pairing', () => {
  const items = [
    { kind: 'table', runId: 6, id: 't1', table: { caption: 'Variables in the Equation', matrix: [['', 'B'], ['score', '36.5']] } },
    { kind: 'table', runId: 6, id: 't2', table: { caption: 'score 的分布', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'image', id: 'c1', title: '两组均分', tableId: 't2', sourceRunId: 6, chartSpec: { kind: 'bar', variable: 'score', by: 'y' }, artifactUrl: '/analytics/api/artifact?runId=9&name=chart.svg' },
  ]
  const { paired, standalone } = pairCharts(items)
  assert.deepEqual([...paired.keys()].map((table) => table.id), ['t2'], 'the chosen table takes it')
  assert.equal(standalone.size, 0)
})

await check('a table id that no longer exists leaves the chart on its own', () => {
  const items = [
    { kind: 'table', runId: 4, id: 't1', table: { caption: 'Frequencies', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'image', id: 'c1', title: '直方图', tableId: 'run-1-9', sourceRunId: 4, chartSpec: { kind: 'histogram', variable: 'score' }, artifactUrl: '/analytics/api/artifact?runId=10&name=chart.svg' },
  ]
  const { paired, standalone } = pairCharts(items)
  assert.equal(paired.size, 0, 'a stale choice never falls back to a guess')
  assert.equal(standalone.size, 1)
})

await check('the chosen table is the sheet that carries the picture in excel', () => {
  const items = [
    { kind: 'table', runId: 1, id: 't1', table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'table', runId: 1, id: 't2', table: { caption: 'score 的分布', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'image', id: 'c1', title: '直方图', tableId: 't2', sourceRunId: 1, chartSpec: { kind: 'histogram', variable: 'score' }, artifactUrl: '/analytics/api/artifact?runId=12&name=chart.svg' },
  ]
  const images = [{ url: '/analytics/api/artifact?runId=12&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }]
  const xlsx = unzip(buildXlsx({ items, images }))
  assert.ok(!/drawing/.test(xlsx['xl/worksheets/sheet1.xml'].toString('utf8')), 'the first table stays picture-free')
  assert.match(xlsx['xl/worksheets/sheet2.xml'].toString('utf8'), /<drawing r:id="rId1"\/>/, 'the second table carries it')
})

await check('word and excel give the same picture the same size', () => {
  const items = [
    { kind: 'table', runId: 1, table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
    { kind: 'image', title: '直方图', sourceRunId: 1, artifactUrl: '/analytics/api/artifact?runId=12&name=chart.svg' },
  ]
  const images = [{ url: '/analytics/api/artifact?runId=12&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }]
  const docx = unzip(buildDocx({ items, images }))['word/document.xml'].toString('utf8')
  const xlsx = unzip(buildXlsx({ items, images }))
  const wordExtent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(docx)
  const excelExtent = /<xdr:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xlsx['xl/drawings/drawing1.xml'].toString('utf8'))
  assert.ok(wordExtent && excelExtent, 'both writers emit an extent')
  assert.deepEqual([wordExtent[1], wordExtent[2]], [excelExtent[1], excelExtent[2]], 'same size in both files')
})

await check('a chart-only sheet actually references its drawing', () => {
  const xlsx = buildXlsx({
    items: [
      { kind: 'table', runId: 1, table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
      { kind: 'image', title: '另一张图', sourceRunId: 99, artifactUrl: '/analytics/api/artifact?runId=13&name=chart.svg' },
    ],
    images: [{ url: '/analytics/api/artifact?runId=13&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }],
  })
  const files = unzip(xlsx)
  const chartSheet = Object.keys(files).filter((name) => /worksheets\/sheet\d+\.xml$/.test(name))
    .find((name) => /图表见上方/.test(files[name].toString('utf8')))
  assert.ok(chartSheet, 'the chart sheet exists')
  assert.match(files[chartSheet].toString('utf8'), /<drawing r:id="rId1"\/>/, 'without this reference Excel shows an empty sheet')
})

await check('two tables matching the variable: the one titled after it wins', () => {
  const items = [
    { kind: 'table', runId: 6, id: 'stats', table: { caption: 'Statistics', matrix: [['', 'score'], ['Mean', '60.08']] } },
    { kind: 'table', runId: 6, id: 'dist', table: { caption: 'score', matrix: [['', 'Frequency'], ['43.30', '1']] } },
    { kind: 'image', id: 'c1', title: '得分分布', sourceRunId: 6, chartSpec: { kind: 'histogram', variable: 'score' }, artifactUrl: '/analytics/api/artifact?runId=14&name=chart.svg' },
  ]
  const { paired } = pairCharts(items)
  assert.deepEqual([...paired.keys()].map((table) => table.id), ['dist'])
})

await check('docx puts the picture between the caption and the header row', () => {
  const docx = buildDocx({
    items: [
      { kind: 'table', runId: 2, table: { caption: '描述统计', matrix: [['变量', 'N'], ['score', '60']] } },
      { kind: 'image', title: '直方图', sourceRunId: 2, artifactUrl: '/analytics/api/artifact?runId=7&name=chart.svg' },
    ],
    images: [{ url: '/analytics/api/artifact?runId=7&name=chart.svg', bytes: Buffer.from('PNG'), width: 560, height: 360 }],
  })
  const document = unzip(docx)['word/document.xml'].toString('utf8')
  const table = document.slice(document.indexOf('<w:tbl>'), document.indexOf('</w:tbl>'))
  const picture = table.indexOf('<wp:inline')
  const header = table.indexOf('变量')
  assert.ok(picture > 0 && header > 0, 'both the picture and the header are in the table')
  assert.ok(picture < header, 'the picture comes first: caption, picture, then the header line')
})

await check('a frequency table writes its percentages and total as formulas', () => {
  const matrix = [
    ['', '', 'Frequency', 'Percent', 'Valid Percent', 'Cumulative Percent'],
    ['Valid', 'F', '2', '3.2%', '3.2%', '3.2%'],
    ['', 'M', '1', '1.6%', '1.6%', '4.8%'],
    ['', '男', '60', '95.2%', '95.2%', '100.0%'],
    ['Total', '', '63', '100.0%', '', ''],
  ]
  const formulas = formulaMap(matrix, 'gender')
  const percent = formulas.get('1:3')
  assert.ok(percent, 'the percent cell has a formula')
  assert.equal(percent.cached, 3.2, 'the printed value stays the cached result')
  assert.equal(percent.style, 4, 'a percentage needs the percent number format')
  assert.equal(percent.build((row, column) => `R${row}C${column}`), 'R1C2/R4C2*100', 'count over the total row')
  assert.equal(formulas.get('1:4').build((row, column) => `R${row}C${column}`), 'R1C2/SUM(R1C2:R3C2)*100', 'valid percent over the summed valid counts')
  assert.equal(formulas.get('1:5').build((row, column) => `R${row}C${column}`), 'R1C4', 'the first cumulative cell is the valid percent itself')
  assert.equal(formulas.get('3:5').build((row, column) => `R${row}C${column}`), 'SUM(R1C4:R3C4)', 'later cells accumulate')
  assert.equal(formulas.get('4:2').build((row, column) => `R${row}C${column}`), 'SUM(R1C2:R3C2)', 'the total row sums the counts')
  assert.equal(formulas.get('4:3').cached, 100, 'the total percent keeps its printed value')
})

await check('a coefficient table writes Wald, Sig., Exp(B) and its interval as formulas', () => {
  const matrix = [
    ['', '', 'B', 'S.E.', 'Wald', 'df', 'Sig.', 'Exp(B)', '95% CI for Exp(B)', ''],
    ['', '', '', '', '', '', '', '', 'Lower', 'Upper'],
    ['Step 1', 'age', '.13', '.03', '14.67', '1', '.000', '1.14', '1.07', '1.22'],
    ['', 'Constant', '-5.06', '1.32', '14.70', '1', '.000', '.01', '', ''],
  ]
  const formulas = formulaMap(matrix, 'Variables in the Equation')
  const ref = (row, column) => `R${row}C${column}`
  assert.equal(formulas.get('2:4').build(ref), '(R2C2/R2C3)^2', 'Wald is (B/S.E.)^2')
  assert.equal(formulas.get('2:6').build(ref), '_xlfn.CHISQ.DIST.RT(R2C4,1)', 'Sig. is the upper tail of chi-square with 1 df')
  assert.equal(formulas.get('2:7').build(ref), 'EXP(R2C2)', 'Exp(B) is exp of B')
  assert.equal(formulas.get('2:8').build(ref), 'EXP(R2C2-1.96*R2C3)', 'lower bound is exp(B - 1.96 SE)')
  assert.equal(formulas.get('2:9').build(ref), 'EXP(R2C2+1.96*R2C3)', 'upper bound is exp(B + 1.96 SE)')
  assert.equal(formulas.get('2:8').cached, 1.07, 'the printed interval stays cached')
  assert.ok(!formulas.has('3:8'), 'an empty interval cell gets no formula')
})

await check('a t test writes its p value as the tail of the t distribution', () => {
  const matrix = [
    ['', '', 'Levene', '', 'T-Test for Equality of Means', '', '', '', '', ''],
    ['', '', 'F', 'Sig.', 't', 'df', 'Sig. (2-tailed)', 'Mean Difference', 'Std. Error Difference', ''],
    ['score', 'assumed', '+Infinit', '.000', '.05', '1.00', '.969', '.50', '10.39', ''],
    ['', 'not assumed', '', '', 'NaN', 'NaN', 'NaN', '.50', 'NaN', ''],
  ]
  const formulas = formulaMap(matrix, 'Independent Samples Test')
  const ref = (row, column) => `R${row}C${column}`
  assert.equal(formulas.get('2:6').build(ref), '_xlfn.T.DIST.2T(ABS(R2C4),R2C5)', 'p is 2*P(T>|t|) with that df')
  assert.equal(formulas.get('2:6').cached, 0.969, 'the printed p stays cached')
  assert.ok(!formulas.has('3:6'), 'a NaN row gets no formula')
})

await check('a chi-square test writes its p value as the chi-square tail', () => {
  const matrix = [
    ['', 'Chi-square', 'df', 'Asymp. Sig.'],
    ['gender', '61.89', '3', '.000'],
  ]
  const formulas = formulaMap(matrix, 'Test Statistics')
  assert.equal(formulas.get('1:3').build((row, column) => `R${row}C${column}`), '_xlfn.CHISQ.DIST.RT(R1C1,R1C2)')
})

await check('a crosstab chi-square table names the test in the row label', () => {
  const matrix = [
    ['', 'Value', 'df', 'Asymptotic Sig. (2-tailed)'],
    ['Pearson Chi-Square', '15.00', '39', '1.000'],
    ['Likelihood Ratio', '20.93', '39', '.992'],
    ["Fisher's Exact Test", '', '', ''],
    ['N of Valid Cases', '60', '', ''],
  ]
  const formulas = formulaMap(matrix, 'Chi-Square Tests')
  const ref = (row, column) => `R${row}C${column}`
  assert.equal(formulas.size, 2, 'only the chi-square-based rows get a formula')
  assert.equal(formulas.get('1:3').build(ref), '_xlfn.CHISQ.DIST.RT(R1C1,R1C2)', 'Pearson row')
  assert.equal(formulas.get('2:3').build(ref), '_xlfn.CHISQ.DIST.RT(R2C1,R2C2)', 'likelihood ratio row')
  assert.ok(!formulas.has('3:3'), 'Fisher is exact, not a chi-square tail')
  assert.ok(!formulas.has('4:3'), 'the case count is not a test')
})

await check('a crosstab writes its row and column totals as SUM', () => {
  const matrix = [
    ['', '', '', 'gender', '', '', '', 'Total'],
    ['', '', '', 'F', 'M', '女', '男', ''],
    ['group', '1.00', 'Count', '1', '0', '8', '14', '23'],
    ['', '2.00', 'Count', '0', '1', '7', '14', '22'],
    ['Total', '', 'Count', '1', '1', '15', '28', '45'],
  ]
  const formulas = formulaMap(matrix, 'group × gender')
  const ref = (row, column) => `R${row}C${column}`
  assert.equal(formulas.get('2:7').build(ref), 'SUM(R2C3:R2C6)', 'the row total sums its counts')
  assert.equal(formulas.get('4:3').build(ref), 'SUM(R2C3:R3C3)', 'the column total sums the column')
})

await check('an ANOVA row writes its F test as a formula inside the same sheet', () => {
  const matrix = [
    ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
    ['Regression', '142.39', '2', '71.20', '1051.92', '.000'],
    ['Residual', '.61', '9', '.07', '', ''],
    ['Total', '143.00', '11', '', '', ''],
  ]
  const formulas = formulaMap(matrix, 'ANOVA (y)')
  const ref = (row, column) => `R${row}C${column}`
  assert.equal(formulas.size, 1, 'only the F row carries a test')
  assert.equal(formulas.get('1:5').build(ref), '_xlfn.F.DIST.RT(R1C4,R1C2,R2C2)', 'df1 is the model row, df2 the residual row')
  assert.equal(formulas.get('1:5').cached, 0, 'the printed p stays cached')
})

await check('a coefficient row without df takes the residual df from the ANOVA sheet', () => {
  const matrix = [
    ['', 'Unstandardized Coefficients', '', 'Standardized Coefficients', 't', 'Sig.', '95% Confidence Interval for B', ''],
    ['', 'B', 'Std. Error', 'Beta', '', '', 'Lower Bound', 'Upper Bound'],
    ['(Constant)', '-.02', '.19', '', '-.12', '.911', '-.45', '.41'],
    ['x1', '.37', '.06', '.72', '5.94', '.000', '.23', '.51'],
  ]
  const plain = formulaMap(matrix, 'Coefficients (y)')
  assert.equal(plain.size, 0, 'without a df reference the p value stays a constant')
  const formulas = formulaMap(matrix, 'Coefficients (y)', { residualDf: "'ANOVA (y)'!C4" })
  const ref = (row, column) => `R${row}C${column}`
  assert.equal(formulas.size, 2, 'every coefficient row with t and Sig. gets a formula')
  assert.equal(formulas.get('2:5').build(ref), "_xlfn.T.DIST.2T(ABS(R2C4),'ANOVA (y)'!C4)", 'the constant row')
  assert.equal(formulas.get('2:5').cached, 0.911, 'the printed p stays cached')
})

await check('sheet names are quoted for formulas only when they need it', () => {
  assert.equal(escapeSheetName('Sheet1'), 'Sheet1', 'a plain name stays bare')
  assert.equal(escapeSheetName('统计'), '统计', 'a Chinese name stays bare')
  assert.equal(escapeSheetName('ANOVA (y)'), "'ANOVA (y)'", 'spaces and parentheses need quotes')
  assert.equal(escapeSheetName("it's"), "'it''s'", 'a quote inside the name is doubled')
})

await check('the regression export carries both the F test and the cross-sheet p values', () => {
  const items = [
    {
      kind: 'table',
      table: {
        caption: 'ANOVA (y)',
        matrix: [
          ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
          ['Regression', '142.39', '2', '71.20', '1051.92', '.000'],
          ['Residual', '.61', '9', '.07', '', ''],
          ['Total', '143.00', '11', '', '', ''],
        ],
      },
    },
    {
      kind: 'table',
      table: {
        caption: 'Coefficients (y)',
        matrix: [
          ['', 'Unstandardized Coefficients', '', 'Standardized Coefficients', 't', 'Sig.', '95% Confidence Interval for B', ''],
          ['', 'B', 'Std. Error', 'Beta', '', '', 'Lower Bound', 'Upper Bound'],
          ['x1', '.37', '.06', '.72', '5.94', '.000', '.23', '.51'],
        ],
      },
    },
  ]
  const files = unzip(buildXlsx({ items }))
  const anova = files['xl/worksheets/sheet1.xml'].toString('utf8')
  const coefficients = files['xl/worksheets/sheet2.xml'].toString('utf8')
  assert.match(anova, /<f>_xlfn\.F\.DIST\.RT\(E3,C3,C4\)<\/f>/, 'the ANOVA p value is a formula in its own sheet')
  assert.match(coefficients, /<f>_xlfn\.T\.DIST\.2T\(ABS\(E4\),'ANOVA \(y\)'!C4\)<\/f>/, 'the coefficient p value points at the residual df')
})

await check('R Square and its adjusted form follow from the ANOVA sums of squares', () => {
  const summary = [['R', 'R Square', 'Adjusted R Square', 'Std. Error of the Estimate'], ['1.00', '1.00', '1.00', '.36']]
  const anova = {
    ssResidual: "'ANOVA (y)'!B4",
    ssTotal: "'ANOVA (y)'!B5",
    dfResidual: "'ANOVA (y)'!C4",
    dfRegression: "'ANOVA (y)'!C3",
  }
  const formulas = formulaMap(summary, 'Model Summary (y)', { anova })
  assert.equal(formulas.size, 3, 'R, R Square and Adjusted R Square all become formulas')
  assert.equal(formulas.get('1:1').build(() => 'A1'), "(1-'ANOVA (y)'!B4/'ANOVA (y)'!B5)", 'R Square is one minus the ratio of the sums of squares')
  assert.equal(formulas.get('1:0').build(() => 'A1'), "SQRT((1-'ANOVA (y)'!B4/'ANOVA (y)'!B5))", 'R is the square root of R Square')
  assert.equal(formulas.get('1:2').build(() => 'A1'), "1-(1-(1-'ANOVA (y)'!B4/'ANOVA (y)'!B5))*('ANOVA (y)'!C4+'ANOVA (y)'!C3)/'ANOVA (y)'!C4", 'adjusted uses the two ANOVA df as n-1 and n-p-1')
  const alone = formulaMap(summary, 'Model Summary (y)')
  assert.equal(alone.size, 0, 'without the ANOVA sheet nothing is recoverable and the values stay constants')
})

await check('the regression export links Model Summary to the ANOVA sheet', () => {
  const items = [
    {
      kind: 'table',
      table: {
        caption: 'Model Summary (y)',
        matrix: [['R', 'R Square', 'Adjusted R Square', 'Std. Error of the Estimate'], ['1.00', '0.99', '0.99', '.36']],
      },
    },
    {
      kind: 'table',
      table: {
        caption: 'ANOVA (y)',
        matrix: [
          ['', 'Sum of Squares', 'df', 'Mean Square', 'F', 'Sig.'],
          ['Regression', '142.39', '2', '71.20', '1051.92', '.000'],
          ['Residual', '.61', '9', '.07', '', ''],
          ['Total', '143.00', '11', '', '', ''],
        ],
      },
    },
  ]
  const files = unzip(buildXlsx({ items }))
  const summary = files['xl/worksheets/sheet1.xml'].toString('utf8')
  assert.match(summary, /<f>\(1-'ANOVA \(y\)'!B4\/'ANOVA \(y\)'!B5\)<\/f>/, 'R Square points at the Residual and Total sums of squares')
  assert.match(summary, /<f>SQRT\(/, 'R is written as a square root')
})

await check('the optional data sheet is appended and stays hidden', () => {
  const items = [{ kind: 'table', table: { caption: 'gender', matrix: [['', 'Frequency', 'Percent'], ['男', '2', '50.0%'], ['Total', '4', '100.0%']] } }]
  const files = unzip(buildXlsx({
    items,
    data: { variables: [{ name: 'gender' }, { name: 'age' }], rows: [['男', '23'], ['女', '31']] },
  }))
  const workbook = files['xl/workbook.xml'].toString('utf8')
  assert.match(workbook, /<sheet name="数据" sheetId="2" state="hidden"/, 'the data sheet is marked hidden in the workbook')
  const data = files['xl/worksheets/sheet2.xml'].toString('utf8')
  assert.match(data, /<t xml:space="preserve">gender<\/t>/, 'the header carries the variable names')
  assert.match(data, /<t xml:space="preserve">女<\/t>/, 'the cases are written out')
  assert.equal((data.match(/<row r=/g) ?? []).length, 3, 'one header row plus two cases')
  const without = unzip(buildXlsx({ items }))
  assert.doesNotMatch(without['xl/workbook.xml'].toString('utf8'), /数据/, 'no data sheet unless asked for')
})

await check('a missing value in the data sheet leaves the cell out entirely', () => {
  const items = [{ kind: 'table', table: { caption: 'm', matrix: [['', 'N'], ['m', '2']] } }]
  const files = unzip(buildXlsx({
    items,
    data: { variables: [{ name: 'm' }, { name: 'n' }], rows: [[1, null], [2, 3], [null, 5]] },
  }))
  const data = files['xl/worksheets/sheet2.xml'].toString('utf8')
  assert.doesNotMatch(data, /<v>0<\/v>/, 'a missing value is not written as 0')
  assert.doesNotMatch(data, /r="B2"/, 'B2 has no cell at all instead of an empty string')
  assert.doesNotMatch(data, /r="A4"/, 'A4 is missing for the same reason')
  assert.match(data, /<c r="B4" s="0"><v>5<\/v><\/c>/, 'the neighbouring value is still written')
  const cells = (data.match(/<c r=/g) ?? []).length
  assert.equal(cells, 6, 'header 2 + row2 1 + row3 2 + row4 1: the two blanks are skipped')
})

await check('a correlation column writes its Sig. as a t tail of r and N', () => {
  const matrix = [
    ['', '', 'age', 'score'],
    ['age', 'Pearson Correlation', '1.000', '.554'],
    ['', 'Sig. (2-tailed)', '', '.000'],
    ['', 'N', '63', '63'],
    ['score', 'Pearson Correlation', '.554', '1.000'],
    ['', 'Sig. (2-tailed)', '.000', ''],
    ['', 'N', '63', '63'],
  ]
  const formulas = formulaMap(matrix, 'Correlations')
  assert.equal(formulas.size, 2, 'the two off-diagonal p values are formulas; the diagonal has no Sig.')
  assert.equal(
    formulas.get('2:3').build((row, column) => `${String.fromCharCode(65 + column)}${row + 1}`),
    '_xlfn.T.DIST.2T(ABS(D2*SQRT((D4-2)/(1-D2^2))),D4-2)',
    'r and N come from the same column, so the t and its df are local',
  )
})

await check('a non-parametric test statistics column writes its p value from the statistic above', () => {
  const chi = [['', 'score'], ['Chi-Square', '.26'], ['df', '2'], ['Asymp. Sig.', '.878']]
  const chiFormulas = formulaMap(chi, 'Test Statistics')
  assert.equal(chiFormulas.size, 1, 'one p value cell')
  assert.equal(chiFormulas.get('3:1').build((row, column) => `${String.fromCharCode(65 + column)}${row + 1}`), '_xlfn.CHISQ.DIST.RT(B2,B3)', 'chi-square is the tail of its own df')
  const z = [['', 'age - score'], ['Z', '-6.90'], ['Asymp. Sig. (2-tailed)', '.000']]
  const zFormulas = formulaMap(z, 'Test Statistics')
  assert.equal(
    zFormulas.get('2:1').build((row, column) => `${String.fromCharCode(65 + column)}${row + 1}`),
    '2*(1-_xlfn.NORM.S.DIST(ABS(B2),TRUE))',
    'a two-tailed Wilcoxon p value is twice the upper normal tail of |Z|',
  )
  const binomial = [['', 'score'], ['Category', '<= 60'], ['Asymp. Sig. (2-tailed)', '.000']]
  assert.equal(formulaMap(binomial, 'Test Statistics').size, 0, 'with no statistic printed there is nothing to recompute')
})

await check('a table with no self-consistent quantity gets no formula', () => {
  const formulas = formulaMap([['变量', 'N', '均数'], ['score', '60', '60.08']], '描述统计')
  assert.equal(formulas.size, 0, 'a mean cannot be recovered from the printed table')
})

await check('sheetXml writes a formula with its cached value and a percent style', () => {
  const matrix = [['', 'Frequency', 'Percent'], ['男', '60', '95.2%'], ['Total', '63', '100.0%']]
  const xml = sheetXml(matrix, 'gender', { formulas: formulaMap(matrix, 'gender') })
  // The caption occupies row 1, so matrix row 0 is Excel row 2.
  assert.match(xml, /<c r="C3" s="4"><f>B3\/B4\*100<\/f><v>95.2<\/v><\/c>/, 'both the formula and the printed value are written')
  assert.match(xml, /<c r="B4" s="0"><f>SUM\(B3:B3\)<\/f><v>63<\/v><\/c>/, 'the total row is a SUM')
})

await check('the xlsx export can turn the formulas off', () => {
  const items = [{ kind: 'table', table: { caption: 'gender', matrix: [['', 'Frequency', 'Percent'], ['男', '60', '95.2%'], ['Total', '63', '100.0%']] } }]
  const on = unzip(buildXlsx({ items }))
  const off = unzip(buildXlsx({ items, formulas: false }))
  const sheetOf = (files) => files['xl/worksheets/sheet1.xml'].toString('utf8')
  assert.match(sheetOf(on), /<f>/, 'formulas are on by default')
  assert.doesNotMatch(sheetOf(off), /<f>/, 'formulas:false keeps plain numbers')
  assert.match(on['xl/styles.xml'].toString('utf8'), /numFmtId="164" formatCode="0\.0&quot;%&quot;"/, 'the stylesheet carries the percent format')
})

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.dependencies, undefined, 'the plugin still ships with no runtime dependencies')

// Word is strict about the order inside w:tc: cell properties come first and
// the content follows. A tcBorders element after </w:p> is invalid there, and
// Word drops the rule instead of complaining.
await check('docx cell properties stay inside tcPr', () => {
  const xml = tableXml([['变量', '值'], ['score', '-10.000 **']])
  assert.ok(!/\/w:p><w:tcBorders>/.test(xml), 'no border element after the paragraph')
  const cells = (xml.match(/<w:tc>/g) ?? []).length
  const borderSets = (xml.match(/<w:tcBorders>/g) ?? []).length
  assert.equal(borderSets, cells, 'every cell carries exactly one border set')
  assert.ok(/<w:tcPr><w:tcBorders>[^]*?<\/w:tcBorders><\/w:tcPr><w:p>/.test(xml), 'tcPr precedes the paragraph')
})

console.log(`\n${checks} checks passed${process.exitCode ? ' (with failures)' : ''}`)
