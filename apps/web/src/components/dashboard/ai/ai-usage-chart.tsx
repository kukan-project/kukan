'use client'

import { useEffect, useRef, useState } from 'react'

export interface UsageSeries {
  key: string
  label: string
  color: string
}

export interface UsageColumn {
  /** Bucket start, as an instant */
  start: string
  label: string
  /** Value per series key; a missing key is zero */
  values: Record<string, number>
}

interface UsageChartProps {
  series: UsageSeries[]
  columns: UsageColumn[]
  format: (value: number) => string
  /** Short label under the axis, shown for about one column in six */
  tickLabel: (column: UsageColumn) => string
  ariaLabel: string
}

const HEIGHT = 200
/** Room above the plot for the top tick's label */
const PAD_TOP = 8
/** Roughly what one character of a 10px axis label takes */
const AXIS_CHAR_WIDTH = 6
const AXIS_HEIGHT = 20
const GAP = 2
const RADIUS = 4

/**
 * Stacked columns, one per bucket, with a tooltip per column. Drawn in plain
 * SVG at the container's width: the page has no chart library, and this is
 * one chart.
 */
export function UsageChart({ series, columns, format, tickLabel, ariaLabel }: UsageChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useWidth(ref)
  const [hovered, setHovered] = useState<number | null>(null)

  const totals = columns.map((c) => series.reduce((sum, s) => sum + (c.values[s.key] ?? 0), 0))
  const max = niceMax(Math.max(0, ...totals))
  // One baseline where everything is zero (Ollama, or only unpriced calls)
  const ticks = max > 0 ? [0, max / 2, max] : [0]
  // Wide enough for the longest label: a sub-cent cost runs to many digits
  const axisWidth = Math.max(...ticks.map((tick) => format(tick).length)) * AXIS_CHAR_WIDTH + 10
  const plotWidth = Math.max(0, width - axisWidth)
  const plotHeight = HEIGHT - AXIS_HEIGHT - PAD_TOP
  const base = PAD_TOP + plotHeight
  const step = columns.length ? plotWidth / columns.length : 0
  const barWidth = Math.max(1, step - GAP)
  const y = (value: number) => (max > 0 ? (value / max) * plotHeight : 0)
  const labelEvery = Math.max(1, Math.ceil(columns.length / 6))

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={axisWidth}
                x2={width}
                y1={base - y(tick)}
                y2={base - y(tick)}
                className="stroke-border"
              />
              <text
                x={axisWidth - 6}
                y={base - y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {format(tick)}
              </text>
            </g>
          ))}
          {columns.map((column, i) => {
            const x = axisWidth + i * step + GAP / 2
            const total = totals[i]
            let top = base
            return (
              <g key={column.start}>
                <clipPath id={`usage-col-${i}`}>
                  <rect
                    x={x}
                    y={base - y(total)}
                    width={barWidth}
                    height={y(total) + RADIUS}
                    rx={Math.min(RADIUS, barWidth / 2)}
                  />
                </clipPath>
                <g
                  clipPath={`url(#usage-col-${i})`}
                  opacity={hovered === null || hovered === i ? 1 : 0.5}
                >
                  {series.map((s) => {
                    const h = y(column.values[s.key] ?? 0)
                    if (h <= 0) return null
                    top -= h
                    // The surface gap between stacked segments
                    return (
                      <rect
                        key={s.key}
                        x={x}
                        y={top}
                        width={barWidth}
                        height={Math.max(0, h - (top > base - y(total) ? GAP : 0))}
                        fill={s.color}
                      />
                    )
                  })}
                </g>
                {i % labelEvery === 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={HEIGHT - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[10px]"
                  >
                    {tickLabel(column)}
                  </text>
                )}
                {/* Hit target: the whole column, taller than the mark */}
                <rect
                  x={axisWidth + i * step}
                  y={PAD_TOP}
                  width={step}
                  height={plotHeight}
                  fill="transparent"
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                />
              </g>
            )
          })}
        </svg>
      )}
      {hovered !== null && totals[hovered] > 0 && (
        <UsageTooltip
          column={columns[hovered]}
          series={series}
          total={totals[hovered]}
          format={format}
          left={axisWidth + hovered * step + step / 2}
          width={width}
        />
      )}
    </div>
  )
}

function UsageTooltip({
  column,
  series,
  total,
  format,
  left,
  width,
}: {
  column: UsageColumn
  series: UsageSeries[]
  total: number
  format: (value: number) => string
  left: number
  width: number
}) {
  const present = series.filter((s) => (column.values[s.key] ?? 0) > 0)
  const flip = left > width / 2
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-md border bg-popover p-2 text-xs shadow-md"
      style={flip ? { right: width - left + 8 } : { left: left + 8 }}
    >
      <p className="mb-1 font-medium">{column.label}</p>
      {present.map((s) => (
        <p key={s.key} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="text-muted-foreground">{s.label}</span>
          </span>
          <span className="tabular-nums">{format(column.values[s.key] ?? 0)}</span>
        </p>
      ))}
      {present.length > 1 && (
        <p className="mt-1 flex justify-between gap-3 border-t pt-1 font-medium">
          <span />
          <span className="tabular-nums">{format(total)}</span>
        </p>
      )}
    </div>
  )
}

export function UsageLegend({ series }: { series: UsageSeries[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  )
}

/** The axis top: the maximum rounded up to 1, 2 or 5 of its power of ten */
function niceMax(value: number): number {
  if (value <= 0) return 0
  const power = 10 ** Math.floor(Math.log10(value))
  const n = value / power
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}
