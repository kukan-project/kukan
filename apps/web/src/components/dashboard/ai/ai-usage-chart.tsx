'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@kukan/ui'

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
  notes: {
    /** Under the chart, when a column was drawn taller than its value */
    lifted: string
    /** After that, when there is a legend to leave series out with */
    legend: string
    /** Under each tooltip's total, when series are left out */
    excluded: string
  }
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
 * The least height of a column that is not zero, so an hour beside a much
 * larger one still shows that something ran. Its value is in the tooltip.
 */
const MIN_HEIGHT = 3
const NONE: ReadonlySet<string> = new Set()

/**
 * Stacked columns, one per bucket, with a tooltip per column and a legend that
 * leaves series out. Drawn in plain SVG at the container's width: the page has
 * no chart library, and this is one chart.
 */
export function UsageChart({
  series,
  columns,
  format,
  tickLabel,
  ariaLabel,
  notes,
}: UsageChartProps) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useWidth(ref)
  const [hovered, setHovered] = useState<number | null>(null)
  // Series left out of the chart; a key not in `series` hides nothing
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NONE)

  // Hiding every series would leave nothing to draw, so it shows them all
  const hiding = series.some((s) => !hidden.has(s.key)) ? hidden : NONE
  // From what the legend shows, not `hidden`, which may hide every series
  const toggle = (key: string) => {
    const next = new Set(hiding)
    if (!next.delete(key)) next.add(key)
    setHidden(next)
  }
  const drawn = useMemo(() => series.filter((s) => !hiding.has(s.key)), [series, hiding])
  const excluded = drawn.length < series.length

  const totals = useMemo(
    () => columns.map((c) => drawn.reduce((sum, s) => sum + (c.values[s.key] ?? 0), 0)),
    [columns, drawn]
  )
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
  // Kept across hover, which only changes the opacity
  const layouts = useMemo(
    () => columns.map((c, i) => layoutColumn(c, drawn, totals[i], max, plotHeight)),
    [columns, drawn, totals, max, plotHeight]
  )

  return (
    <div className="flex flex-col gap-2">
      {series.length > 1 && (
        <UsageLegend
          series={series}
          hidden={hiding}
          lastShown={drawn.length === 1}
          onToggle={toggle}
        />
      )}
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
              const { height, segments } = layouts[i]
              return (
                <g key={column.start}>
                  <clipPath id={`usage-col-${i}`}>
                    <rect
                      x={x}
                      y={base - height}
                      width={barWidth}
                      height={height + RADIUS}
                      rx={Math.min(RADIUS, barWidth / 2)}
                    />
                  </clipPath>
                  <g
                    clipPath={`url(#usage-col-${i})`}
                    opacity={hovered === null || hovered === i ? 1 : 0.5}
                  >
                    {segments.map((s) => (
                      <rect
                        key={s.key}
                        x={x}
                        y={base - s.top}
                        width={barWidth}
                        height={s.height}
                        fill={s.color}
                      />
                    ))}
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
            series={drawn}
            total={totals[hovered]}
            format={format}
            left={axisWidth + hovered * step + step / 2}
            width={width}
            note={excluded ? notes.excluded : undefined}
          />
        )}
        {layouts.some((l) => l.lifted) && (
          <p className="mt-1 text-xs text-muted-foreground">
            {series.length > 1 ? `${notes.lifted} ${notes.legend}` : notes.lifted}
          </p>
        )}
      </div>
    </div>
  )
}

interface Segment {
  key: string
  color: string
  /** Distance of the segment's top from the baseline */
  top: number
  height: number
}

/**
 * One column's stacked segments, bottom up, with the surface gap above each
 * but the top one. A column below the least height is lifted to it and drawn
 * as one segment in the colour of its largest part: too short to split.
 */
function layoutColumn(
  column: UsageColumn,
  series: UsageSeries[],
  value: number,
  max: number,
  plotHeight: number
): { height: number; lifted: boolean; segments: Segment[] } {
  if (value <= 0 || max <= 0) return { height: 0, lifted: false, segments: [] }
  const y = (v: number) => (v / max) * plotHeight
  const parts = series.map((s) => ({ s, h: y(column.values[s.key] ?? 0) })).filter((p) => p.h > 0)
  const total = y(value)
  if (total < MIN_HEIGHT) {
    const { s } = parts.reduce((a, b) => (b.h > a.h ? b : a))
    return {
      height: MIN_HEIGHT,
      lifted: true,
      segments: [{ key: s.key, color: s.color, top: MIN_HEIGHT, height: MIN_HEIGHT }],
    }
  }
  let top = 0
  const segments = parts.map(({ s, h }, i) => {
    top += h
    // A gap would swallow a segment no thicker than itself
    const gap = i < parts.length - 1 && h > GAP * 2 ? GAP : 0
    return { key: s.key, color: s.color, top: top - gap, height: h - gap }
  })
  return { height: total, lifted: false, segments }
}

function UsageTooltip({
  column,
  series,
  total,
  format,
  left,
  width,
  note,
}: {
  column: UsageColumn
  series: UsageSeries[]
  total: number
  format: (value: number) => string
  left: number
  width: number
  note?: string
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
      {note && <p className="mt-1 text-muted-foreground">{note}</p>}
    </div>
  )
}

/** One toggle per series; the last one shown stays */
function UsageLegend({
  series,
  hidden,
  lastShown,
  onToggle,
}: {
  series: UsageSeries[]
  hidden: ReadonlySet<string>
  lastShown: boolean
  onToggle: (key: string) => void
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => {
        const off = hidden.has(s.key)
        return (
          <li key={s.key}>
            <button
              type="button"
              aria-pressed={!off}
              disabled={!off && lastShown}
              onClick={() => onToggle(s.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:hover:text-muted-foreground',
                off && 'line-through opacity-50'
              )}
            >
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.label}
            </button>
          </li>
        )
      })}
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
