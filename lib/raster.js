// Chart exports: PNG through the host when there is no browser canvas, and
// SVG straight from the stored chart.
//
// The PNG encoder below is deliberately small: charts are flat colour, so it
// downsamples an RGBA raster with a box filter and writes an 8-bit truecolour
// PNG. That keeps the plugin dependency-free and works from the agent side,
// where no DOM (and therefore no canvas) exists.

import { deflateSync } from 'node:zlib'

import { crc32 } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/**
 * Encode an RGBA raster as PNG.
 * @param {Buffer} rgba - width*height*4 bytes, row major.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
  if (rgba.length < width * height * 4) throw new Error('RGBA buffer is smaller than width*height*4')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Box-filter downsample an RGBA raster.
 * @returns {Buffer} the smaller raster.
 */
export function downscaleRgba(rgba, width, height, targetWidth, targetHeight) {
  if (targetWidth === width && targetHeight === height) return rgba
  const out = Buffer.alloc(targetWidth * targetHeight * 4)
  const scaleX = width / targetWidth
  const scaleY = height / targetHeight
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)))
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)))
      const sum = [0, 0, 0, 0]
      let count = 0
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * width + sx) * 4
          sum[0] += rgba[at]
          sum[1] += rgba[at + 1]
          sum[2] += rgba[at + 2]
          sum[3] += rgba[at + 3]
          count += 1
        }
      }
      const to = (y * targetWidth + x) * 4
      out[to] = Math.round(sum[0] / count)
      out[to + 1] = Math.round(sum[1] / count)
      out[to + 2] = Math.round(sum[2] / count)
      out[to + 3] = Math.round(sum[3] / count)
    }
  }
  return out
}

/** Sample counts used for 2x antialiasing; more is slower with no visible gain. */
export const SAMPLE_GRID = 2

/**
 * Parse an SVG produced by `renderSvg` into drawable primitives.
 *
 * Only the subset the chart renderer emits is understood (rect, line, polyline,
 * circle, text). Anything else is ignored rather than mis-drawn, so a future
 * chart type degrades to a blank area instead of a corrupt picture.
 */
/** Same letters a browser accepts, otherwise a malformed attribute loops forever in drawLine. */
const NUMBER = /^\s*(-?\d+(?:\.\d+)?)\s*$/m

/** Attributes are numbers written by our own renderer; NaN here means a bug, not data. */
function num(value, fallback = 0) {
  const match = NUMBER.exec(String(value ?? ''))
  if (!match) return fallback
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : fallback
}

export function parseSvg(svg) {
  const text = String(svg ?? '')
  const root = /<svg\b([^>]*)>/i.exec(text)
  const attrs = (source) => {
    const map = {}
    // SVG attributes carry digits (x1, y2), so the name pattern must include
    // them: /[A-Za-z-]+/ stopped before the "1" and stored x1 under "x".
    for (const match of String(source).matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*=\s*"([^"]*)"/g)) map[match[1]] = match[2]
    return map
  }
  const rootAttrs = attrs(root?.[1] ?? '')
  const width = num(rootAttrs.width) || 560
  const height = num(rootAttrs.height) || 360
  const background = /<rect\b[^>]*>/i.exec(text)
  const primitives = []
  // Every element the renderer can emit has to be listed here; `ellipse` was
  // missing, so the ellipse branch below never received a single element and
  // an ellipse chart came out as an empty canvas.
  //
  // Groups are tracked because a composed grid places each chart inside
  // `<g transform="translate(x,y)">`. Without the offset every cell of a grid
  // was drawn at the origin, on top of the first one.
  const elements = /<(\/)?(g|rect|line|polyline|polygon|circle|ellipse|path|text)\b([^>]*)>/gi
  const offsets = []
  const translateOf = (source) => {
    const found = /transform\s*=\s*"\s*translate\(([^)]*)\)/i.exec(String(source ?? ''))
    if (!found) return [0, 0]
    const parts = found[1].split(/[\s,]+/).filter((piece) => piece !== '').map((piece) => num(piece, 0))
    return [parts[0] ?? 0, parts[1] ?? 0]
  }
  let match
  while ((match = elements.exec(text)) !== null) {
    const closing = match[1] === '/'
    const kind = match[2].toLowerCase()
    if (kind === 'g') {
      if (closing) offsets.pop()
      else offsets.push(translateOf(match[3]))
      continue
    }
    if (closing) continue
    const props = attrs(match[3])
    const [dx, dy] = offsets.reduce((acc, entry) => [acc[0] + entry[0], acc[1] + entry[1]], [0, 0])
    if (dx !== 0 || dy !== 0) {
      props.__dx = String(dx)
      props.__dy = String(dy)
    }
    primitives.push({ kind, props, content: '' })
  }
  return { width, height, background: background ? attrs(background[0]) : null, primitives }
}

function parseColor(value) {
  const text = String(value ?? '').trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const value6 = Number.parseInt(hex[1], 16)
    return [(value6 >> 16) & 255, (value6 >> 8) & 255, value6 & 255, 255]
  }
  // Browsers accept #abc, #abcd, #aabbcc and #aabbccdd; the renderer writes
  // colour literals straight through, so all four have to be understood.
  const rgbaHex = /^#([0-9a-f]{8})$/i.exec(text)
  if (rgbaHex) {
    const value8 = Number.parseInt(rgbaHex[1], 16)
    return [(value8 >>> 24) & 255, (value8 >>> 16) & 255, (value8 >>> 8) & 255, value8 & 255]
  }
  const rgbaShort = /^#([0-9a-f]{4})$/i.exec(text)
  if (rgbaShort) {
    const [r, g, b, a] = rgbaShort[1].split('').map((digit) => Number.parseInt(digit + digit, 16))
    return [r, g, b, a]
  }
  const short = /^#([0-9a-f]{3})$/i.exec(text)
  if (short) {
    const [r, g, b] = short[1].split('').map((digit) => Number.parseInt(digit + digit, 16))
    return [r, g, b, 255]
  }
  if (text === 'none' || text === 'transparent') return null
  const named = { white: [255, 255, 255, 255], black: [0, 0, 0, 255] }
  return named[text.toLowerCase()] ?? null
}

function fillRect(rgba, width, height, x0, y0, x1, y1, color) {
  const ax = Math.max(0, Math.round(x0))
  const ay = Math.max(0, Math.round(y0))
  const bx = Math.min(width, Math.round(x1))
  const by = Math.min(height, Math.round(y1))
  for (let y = ay; y < by; y += 1) {
    for (let x = ax; x < bx; x += 1) {
      const at = (y * width + x) * 4
      rgba[at] = color[0]
      rgba[at + 1] = color[1]
      rgba[at + 2] = color[2]
      rgba[at + 3] = color[3] ?? 255
    }
  }
}

/**
 * Fill every pixel whose centre lies inside a polygon.
 *
 * Even-odd on a horizontal scanline: enough for pie slices and rings, and it
 * needs no triangulation of the arc.
 */
function fillPoints(rgba, width, height, points, color, skipInside = null) {
  if (!points.length) return
  const ys = points.map(([, y]) => y)
  const y0 = Math.max(0, Math.floor(Math.min(...ys)))
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)))
  for (let y = y0; y <= y1; y += 1) {
    const cy = y + 0.5
    const crossings = []
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1_] = points[i]
      const [x2, y2_] = points[(i + 1) % points.length]
      if ((y1_ <= cy && y2_ > cy) || (y2_ <= cy && y1_ > cy)) {
        crossings.push(x1 + ((cy - y1_) / (y2_ - y1_)) * (x2 - x1))
      }
    }
    crossings.sort((left, right) => left - right)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i] - 0.5))
      const to = Math.min(width - 1, Math.floor(crossings[i + 1] - 0.5))
      for (let x = from; x <= to; x += 1) {
        if (skipInside && skipInside(x, y)) continue
        const at = (y * width + x) * 4
        rgba[at] = color[0]
        rgba[at + 1] = color[1]
        rgba[at + 2] = color[2]
        rgba[at + 3] = color[3] ?? 255
      }
    }
  }
}

/** Sample an SVG elliptical arc into points (SVG 1.1 implementation notes F.6). */
function arcPoints(from, to, rx, ry, large, sweep, steps = 64) {
  const [x1, y1] = from
  const [x2, y2] = to
  const radiusX = Math.abs(rx)
  const radiusY = Math.abs(ry)
  if (!radiusX || !radiusY || (x1 === x2 && y1 === y2)) return [to]
  const phi = 0
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY)
  const scaleUp = lambda > 1 ? Math.sqrt(lambda) : 1
  const ax = radiusX * scaleUp
  const ay = radiusY * scaleUp
  const numerator = ax * ax * ay * ay - ax * ax * y1p * y1p - ay * ay * x1p * x1p
  const denominator = ax * ax * y1p * y1p + ay * ay * x1p * x1p
  const coefficient = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator))
  const cxp = coefficient * ((ax * y1p) / ay)
  const cyp = coefficient * (-(ay * x1p) / ax)
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angleOf = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    const value = len === 0 ? 0 : Math.min(1, Math.max(-1, dot / len))
    return Math.acos(value) * (ux * vy - uy * vx < 0 ? -1 : 1)
  }
  const start = angleOf(1, 0, (x1p - cxp) / ax, (y1p - cyp) / ay)
  const delta = angleOf((x1p - cxp) / ax, (y1p - cyp) / ay, (-x1p - cxp) / ax, (-y1p - cyp) / ay)
  const sweepAngle = sweep === 1 ? (delta <= 0 ? delta + Math.PI * 2 : delta) : (delta >= 0 ? delta - Math.PI * 2 : delta)
  const out = []
  for (let step = 1; step <= steps; step += 1) {
    const theta = start + (sweepAngle * step) / steps
    const px = ax * Math.cos(theta)
    const py = ay * Math.sin(theta)
    out.push([cos * px - sin * py + cx, sin * px + cos * py + cy])
  }
  return out
}

/**
 * Draw one arc-based path command sequence: M … L … A … [L … A …] Z.
 *
 * Rings are an outer arc followed by an inner arc running the other way; the
 * polygon is walked in order, so even-odd already cuts the hole out.
 */
function drawSvgPath(rgba, width, height, d, scale, fill, stroke, dx = 0, dy = 0) {
  const tokens = String(d ?? '').match(/[MLAmlaZz]|-?\d*\.?\d+(?:\.\d+)?/g) ?? []
  const outline = []
  let cursor = null
  let command = ''
  let index = 0
  const nextPoint = () => [num(tokens[index++]) * scale + dx, num(tokens[index++]) * scale + dy]
  while (index < tokens.length) {
    if (/^[MLAmlaZz]$/.test(tokens[index])) {
      command = tokens[index]
      index += 1
      if (command === 'Z' || command === 'z') continue
    }
    if (command === 'M' || command === 'L') {
      cursor = nextPoint()
      outline.push(cursor)
    } else if (command === 'A') {
      const rx = num(tokens[index++]) * scale
      const ry = num(tokens[index++]) * scale
      index += 1 // rotation
      const large = Number(tokens[index++]) === 1 ? 1 : 0
      const sweep = Number(tokens[index++]) === 1 ? 1 : 0
      const end = nextPoint()
      if (cursor) outline.push(...arcPoints(cursor, end, rx, ry, large, sweep))
      cursor = end
    } else {
      index += 1
    }
  }
  if (outline.length < 2) return
  // A line segment has no interior, so only a closed outline gets a fill.
  if (fill && outline.length >= 3) fillPoints(rgba, width, height, outline, fill)
  if (stroke) {
    for (let i = 0; i < outline.length - 1; i += 1) {
      drawLine(rgba, width, height, outline[i][0], outline[i][1], outline[i + 1][0], outline[i + 1][1], stroke, 1)
    }
  }
}

/** Bresenham line with a square brush of the given stroke width. */
function drawLine(rgba, width, height, x0, y0, x1, y1, color, stroke = 1) {
  let ax = Math.round(x0)
  let ay = Math.round(y0)
  const bx = Math.round(x1)
  const by = Math.round(y1)
  const dx = Math.abs(bx - ax)
  const dy = Math.abs(by - ay)
  const sx = ax < bx ? 1 : -1
  const sy = ay < by ? 1 : -1
  let error = dx - dy
  const half = Math.max(0, Math.floor(stroke / 2))
  for (;;) {
    fillRect(rgba, width, height, ax - half, ay - half, ax + half + 1, ay + half + 1, color)
    if (ax === bx && ay === by) break
    const doubled = error * 2
    if (doubled > -dy) { error -= dy; ax += sx }
    if (doubled < dx) { error += dx; ay += sy }
  }
}

/**
 * Rasterise a chart SVG to RGBA.
 *
 * Text is not drawn: without a font rasteriser the honest result is boxes, and
 * a chart people print will have its labels added in Word. The geometry, the
 * colours and the proportions are exact.
 * @returns {Buffer}
 */
export function rasterizeSvg(svg, scale = 1) {
  const { width, height, background, primitives } = parseSvg(svg)
  const outWidth = Math.round(width * scale)
  const outHeight = Math.round(height * scale)
  const rgba = Buffer.alloc(outWidth * outHeight * 4)
  const backgroundFill = parseColor(background?.fill) ?? [255, 255, 255, 255]
  fillRect(rgba, outWidth, outHeight, 0, 0, outWidth, outHeight, backgroundFill)
  for (const { kind, props } of primitives) {
    const stroke = parseColor(props.stroke)
    const fill = parseColor(props.fill)
    const strokeWidth = Math.max(1, num(props['stroke-width']) || 1) * scale
    // A composed grid translates each chart into its cell; the offsets are
    // recorded per element by parseSvg.
    const ox = num(props.__dx) * scale
    const oy = num(props.__dy) * scale
    if (kind === 'rect') {
      const x = num(props.x) * scale + ox
      const y = num(props.y) * scale + oy
      const w = num(props.width) * scale
      const h = num(props.height) * scale
      if (fill) fillRect(rgba, outWidth, outHeight, x, y, x + w, y + h, fill)
      if (stroke) {
        drawLine(rgba, outWidth, outHeight, x, y, x + w, y, stroke, strokeWidth)
        drawLine(rgba, outWidth, outHeight, x, y + h, x + w, y + h, stroke, strokeWidth)
        drawLine(rgba, outWidth, outHeight, x, y, x, y + h, stroke, strokeWidth)
        drawLine(rgba, outWidth, outHeight, x + w, y, x + w, y + h, stroke, strokeWidth)
      }
    } else if (kind === 'line' && stroke) {
      drawLine(rgba, outWidth, outHeight, num(props.x1) * scale + ox, num(props.y1) * scale + oy,
        num(props.x2) * scale + ox, num(props.y2) * scale + oy, stroke, strokeWidth)
    } else if (kind === 'polyline' && stroke) {
      const numbers = String(props.points ?? '').trim().split(/[\s,]+/).map((value) => num(value, Number.NaN))
      if (numbers.some((value) => !Number.isFinite(value))) continue
      for (let index = 0; index + 3 < numbers.length; index += 2) {
        drawLine(rgba, outWidth, outHeight, numbers[index] * scale + ox, numbers[index + 1] * scale + oy,
          numbers[index + 2] * scale + ox, numbers[index + 3] * scale + oy, stroke, strokeWidth)
      }
    } else if (kind === 'polygon') {
      const numbers = String(props.points ?? '').trim().split(/[\s,]+/).map((value) => num(value, Number.NaN))
      if (numbers.length < 6 || numbers.some((value) => !Number.isFinite(value))) continue
      const outline = []
      for (let at = 0; at + 1 < numbers.length; at += 2) outline.push([numbers[at] * scale + ox, numbers[at + 1] * scale + oy])
      if (fill) fillPoints(rgba, outWidth, outHeight, outline, fill)
      if (stroke) {
        for (let at = 0; at < outline.length; at += 1) {
          const from = outline[at]
          const to = outline[(at + 1) % outline.length]
          drawLine(rgba, outWidth, outHeight, from[0], from[1], to[0], to[1], stroke, strokeWidth)
        }
      }
    } else if (kind === 'path' && (fill || stroke)) {
      drawSvgPath(rgba, outWidth, outHeight, props.d, scale, fill, stroke, ox, oy)
    } else if (kind === 'circle') {
      // A square in place of a circle turned a one-slice pie into a block and
      // made every line-chart node a white square (white fill, coloured
      // stroke — the stroke was never drawn at all, so the nodes vanished).
      const cx = num(props.cx) * scale + ox
      const cy = num(props.cy) * scale + oy
      const r = Math.max(0.5, (num(props.r) || 1) * scale)
      if (fill) {
        const y0 = Math.max(0, Math.floor(cy - r))
        const y1 = Math.min(outHeight - 1, Math.ceil(cy + r))
        for (let y = y0; y <= y1; y += 1) {
          const dy = y + 0.5 - cy
          const half = r * r - dy * dy
          if (half <= 0) continue
          const dx = Math.sqrt(half)
          fillRect(rgba, outWidth, outHeight, cx - dx, y, cx + dx, y + 1, fill)
        }
      }
      if (stroke) {
        const steps = 72
        for (let step = 0; step < steps; step += 1) {
          const from = (step / steps) * Math.PI * 2
          const to = ((step + 1) / steps) * Math.PI * 2
          drawLine(rgba, outWidth, outHeight,
            cx + r * Math.cos(from), cy + r * Math.sin(from),
            cx + r * Math.cos(to), cy + r * Math.sin(to), stroke, strokeWidth)
        }
      }
    } else if (kind === 'ellipse') {
      const cx = num(props.cx) * scale + ox
      const cy = num(props.cy) * scale + oy
      const rx = Math.max(0.5, (num(props.rx) || 1) * scale)
      const ry = Math.max(0.5, (num(props.ry) || 1) * scale)
      if (fill) {
        const y0 = Math.max(0, Math.floor(cy - ry))
        const y1 = Math.min(outHeight - 1, Math.ceil(cy + ry))
        for (let y = y0; y <= y1; y += 1) {
          const dy = (y + 0.5 - cy) / ry
          const half = 1 - dy * dy
          if (half <= 0) continue
          const dx = rx * Math.sqrt(half)
          fillRect(rgba, outWidth, outHeight, cx - dx, y, cx + dx, y + 1, fill)
        }
      }
    }
  }
  return { rgba, width: outWidth, height: outHeight }
}

/**
 * SVG to PNG at a given scale.
 * @param {string} svg
 * @param {number} [scale] - 1 keeps the chart's own pixel size.
 * @returns {Buffer}
 */
export function svgToPng(svg, scale = 1) {
  const { rgba, width, height } = rasterizeSvg(svg, scale)
  return encodePng(rgba, width, height)
}
