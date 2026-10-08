/**
 * Paints a page of an Ichitaro document, as EZPZ File JTD lays it out, on a
 * canvas. Ported from EZPZ File JTD's editor (`web/editor/app.js`,
 * `paintItems` and `drawLine`), less what only an editor draws (marks for
 * returns, spaces and page breaks):
 *
 * Copyright 2026 EZPZ File (https://ezpzfile.com). MIT License — the full
 * text is in apps/web/public/vendor/ezpzjtd/LICENSE.
 */

/** A page in points (1/72 inch), and what to draw on it. */
export interface JtdPage {
  w: number
  h: number
  items: JtdItem[]
}

type JtdItem =
  | {
      t: 'Text'
      /** The left edge of each character. */
      xs: number[]
      y: number
      s: string
      size: number
      b?: boolean
      i?: boolean
      color?: string
    }
  | {
      t: 'Line'
      x1: number
      y1: number
      x2: number
      y2: number
      w: number
      color?: string
      /** Ichitaro's line type (線種): 0 and 1 solid, the others dashed, double or wavy. */
      k?: number
    }

/** CSS pixels per point at 100 %. */
export const PX_PER_PT = 96 / 72

const FONT_STACK =
  '"Hiragino Mincho ProN","Hiragino Mincho Pro","Yu Mincho","YuMincho","MS Mincho","Noto Serif CJK JP","Noto Serif JP",serif'

const LINE_DASH: Record<number, number[]> = {
  4: [3, 2],
  5: [3, 2],
  6: [3, 2],
  8: [0.8, 1.6],
  9: [6, 2.5],
  10: [5, 1.5, 1, 1.5],
  11: [5, 1.5, 1, 1.5],
  15: [1, 1],
}

/** Draw `page` on `g`, whose transform maps points to the canvas. */
export function paintPage(g: CanvasRenderingContext2D, page: JtdPage): void {
  g.fillStyle = '#fff'
  g.fillRect(0, 0, page.w, page.h)
  g.textBaseline = 'alphabetic'
  for (const it of page.items) {
    if (it.t === 'Text') {
      g.font = `${it.i ? 'italic ' : ''}${it.b ? 'bold ' : ''}${it.size}px ${FONT_STACK}`
      g.fillStyle = it.color || '#111'
      const chars = Array.from(it.s)
      for (let k = 0; k < chars.length; k++) {
        const ch = chars[k]!
        const x = it.xs[k]!
        const half = ch.charCodeAt(0) < 0x2000 || (ch >= '｡' && ch <= 'ﾟ')
        if (!half) {
          g.fillText(ch, x, it.y)
          continue
        }
        // A half-width cell: a narrow glyph centred, a wide one (W, M) squeezed,
        // so the text keeps Ichitaro's monospaced grid
        const cell = it.size / 2
        const w = g.measureText(ch).width
        if (w > cell) {
          g.save()
          g.translate(x, it.y)
          g.scale(cell / w, 1)
          g.fillText(ch, 0, 0)
          g.restore()
        } else g.fillText(ch, x + (cell - w) / 2, it.y)
      }
    } else drawLine(g, it)
  }
}

function drawLine(g: CanvasRenderingContext2D, it: Extract<JtdItem, { t: 'Line' }>): void {
  const k = it.k || 0
  g.save()
  g.strokeStyle = it.color || '#111'
  g.lineWidth = it.w
  g.setLineDash(LINE_DASH[k] || [])
  const dx = it.x2 - it.x1
  const dy = it.y2 - it.y1
  const len = Math.hypot(dx, dy) || 1
  // The unit normal, to offset a double or wavy line from its centre
  const nx = -dy / len
  const ny = dx / len
  const seg = (o: number) => {
    g.beginPath()
    g.moveTo(it.x1 + nx * o, it.y1 + ny * o)
    g.lineTo(it.x2 + nx * o, it.y2 + ny * o)
    g.stroke()
  }
  const wave = (o: number) => {
    const n = Math.max(1, Math.round(len / 2))
    g.beginPath()
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const a = (i % 2 ? 1.1 : -1.1) + o
      const x = it.x1 + dx * t + nx * a
      const y = it.y1 + dy * t + ny * a
      if (i) g.lineTo(x, y)
      else g.moveTo(x, y)
    }
    g.stroke()
  }
  if (k === 7) {
    g.lineWidth = 0.5
    seg(-0.9)
    seg(0.9)
  } else if (k === 12 || k === 13) wave(0)
  else if (k === 14) {
    g.lineWidth = 0.5
    wave(-1)
    wave(1)
  } else seg(0)
  g.restore()
}
