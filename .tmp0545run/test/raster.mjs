// Chart rasteriser: PNG structure, downsampling and the SVG subset the chart
// renderer emits. Pure functions, so no PSPP build is needed.

import assert from 'node:assert/strict'

import { encodePng, downscaleRgba, parseSvg, rasterizeSvg, svgToPng } from '../lib/raster.js'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    process.stdout.write(`ok  ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`not ok  ${name}\n${String(error?.stack ?? error).split('\n').map((line) => `    ${line}`).join('\n')}\n`)
  }
}

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80">
<rect x="0" y="0" width="120" height="80" fill="#ffffff" stroke="none"/>
<rect x="20" y="30" width="20" height="40" fill="#b4453a" stroke="none"/>
<line x1="10" y1="70" x2="110" y2="70" stroke="#333" stroke-width="2"/>
<polyline points="10,10 30,20 50,10" fill="none" stroke="#3f6f9f" stroke-width="1"/>
<circle cx="60" cy="20" r="3" fill="#3f6f9f"/>
<text x="10" y="12" fill="#000000">Label</text>
</svg>`

check('encodePng writes a PNG signature and a matching IHDR', () => {
  const rgba = Buffer.alloc(2 * 2 * 4, 0xff)
  const png = encodePng(rgba, 2, 2)
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  assert.equal(png.readUInt32BE(16), 2) // width in IHDR
  assert.equal(png.readUInt32BE(20), 2) // height in IHDR
  assert.equal(png[24], 8) // bit depth
  assert.equal(png[25], 6) // RGBA
})

check('encodePng refuses a buffer that is too small', () => {
  assert.throws(() => encodePng(Buffer.alloc(4), 2, 2), /smaller than width\*height\*4/)
})

check('downscaleRgba averages a 2x2 block', () => {
  const rgba = Buffer.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ])
  const small = downscaleRgba(rgba, 2, 2, 1, 1)
  assert.deepEqual([...small], [128, 128, 128, 255])
})

check('parseColor understands every hex length the renderer may emit', () => {
  const rgba = (fill) => rasterizeSvg(`<svg width="1" height="1"><rect x="0" y="0" width="1" height="1" fill="${fill}"/></svg>`, 1).rgba
  assert.deepEqual([...rgba('#333')].slice(0, 4), [0x33, 0x33, 0x33, 255])
  assert.deepEqual([...rgba('#334')].slice(0, 4), [0x33, 0x33, 0x44, 255])
  assert.deepEqual([...rgba('#334455')].slice(0, 4), [0x33, 0x44, 0x55, 255])
  assert.deepEqual([...rgba('#33445577')].slice(0, 4), [0x33, 0x44, 0x55, 0x77])
})

check('parseSvg reads the canvas, the background and the primitives', () => {
  const { width, height, background, primitives } = parseSvg(SVG)
  assert.equal(width, 120)
  assert.equal(height, 80)
  assert.equal(background.fill, '#ffffff')
  const kinds = primitives.map((entry) => entry.kind)
  assert.deepEqual(kinds, ['rect', 'rect', 'line', 'polyline', 'circle', 'text'])
})

check('parseSvg falls back to the default size', () => {
  const { width, height } = parseSvg('<svg></svg>')
  assert.equal(width, 560)
  assert.equal(height, 360)
})

check('rasterizeSvg paints the bar and the background', () => {
  const { rgba, width, height } = rasterizeSvg(SVG, 1)
  assert.equal(width, 120)
  assert.equal(height, 80)
  const at = (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  assert.deepEqual(at(30, 50), [0xb4, 0x45, 0x3a, 255]) // inside the bar
  assert.deepEqual(at(5, 5), [255, 255, 255, 255]) // empty corner stays white
  // The axis uses the three-digit colour the renderer really emits.
  // stroke-width 2 puts the line on rows 69 and 70, so sample only row 70.
  const axisAt = (70 * width + 60) * 4
  assert.deepEqual([...rgba.subarray(axisAt, axisAt + 4)], [0x33, 0x33, 0x33, 255])
  assert.deepEqual(at(60, 20 + 10), [255, 255, 255, 255]) // beside the circle
})

check('rasterizeSvg scales with the factor', () => {
  const { width, height } = rasterizeSvg(SVG, 2)
  assert.equal(width, 240)
  assert.equal(height, 160)
})

check('svgToPng returns an encoded PNG', () => {
  const png = svgToPng(SVG)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.readUInt32BE(16), 120)
})

check('a ring path fills its arc and leaves the hole empty', () => {
  // A half ring: outer arc across the top, inner arc back, the way renderSvg
  // draws a donut slice.
  const ring = `<svg width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="#ffffff"/>
<path d="M 20 50 A 30 30 0 0 1 80 50 L 66 50 A 16 16 0 0 0 34 50 Z" fill="#b4453a"/></svg>`
  const { rgba, width } = rasterizeSvg(ring, 1)
  const at = (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  assert.deepEqual(at(50, 30), [0xb4, 0x45, 0x3a, 255], 'the outer band is painted')
  assert.deepEqual(at(50, 50), [255, 255, 255, 255], 'the hole stays empty')
  assert.deepEqual(at(50, 80), [255, 255, 255, 255], 'below the arc stays empty')
})

check('stroke-only paths are outlined, not filled', () => {
  const svg = '<svg width="40" height="40"><path d="M 5 5 L 35 5" stroke="#000000"/></svg>'
  const { rgba, width } = rasterizeSvg(svg, 1)
  const at = (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  assert.deepEqual(at(20, 5), [0, 0, 0, 255])
  assert.deepEqual(at(20, 20), [255, 255, 255, 255])
})

check('a polygon fills its interior', () => {
  const svg = '<svg width="60" height="60"><polygon points="10,50 30,10 50,50" fill="#3f6f9f"/></svg>'
  const { rgba, width } = rasterizeSvg(svg, 1)
  const at = (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]
  assert.deepEqual(at(30, 40), [0x3f, 0x6f, 0x9f, 255], 'inside the triangle')
  assert.deepEqual(at(12, 12), [255, 255, 255, 255], 'outside stays empty')
})

check('an unknown paint or element is ignored rather than drawn wrong', () => {
  const { rgba } = rasterizeSvg('<svg width="10" height="10"><rect x="0" y="0" width="10" height="10" fill="magenta"/></svg>', 1)
  // magenta is not a colour we understand, so the canvas keeps its white fill
  assert.deepEqual([...rgba.subarray(0, 4)], [255, 255, 255, 255])
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed) process.exitCode = 1
