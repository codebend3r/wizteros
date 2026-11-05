import { useEffect, useRef, useState, type RefObject } from 'react'
import { COLLAPSED_CHART_HEIGHT } from '@/components/Chart/chartFrame'

// Phone-safe on purpose. A wide fallback inflates the layout on a narrow
// screen before ResizeObserver runs, and the observer then measures the box
// its own fallback inflated: the wrong width locks itself in. From below, the
// first measurement can only grow.
const FALLBACK_WIDTH = 280

type MeasuredBox = {
  readonly ref: RefObject<HTMLDivElement | null>
  readonly width: number
  readonly height: number
}

/** The rendered content box of a chart's container, tracked so the chart draws
    in real pixels: hairlines stay hairlines and label text never scales with a
    viewBox. Falls back to fixed numbers where ResizeObserver cannot measure.

    Measured here rather than handed to Recharts' own ResponsiveContainer, which
    renders nothing at all inside a box reporting zero size - every chart test
    among them.

    The height is only worth reading on a box whose height its stylesheet sets
    regardless of the chart inside it (`contain: size`, a grid row): anywhere
    else the chart sizes the box, and measuring it back would only report the
    chart's own height. */
export const useMeasuredBox = (): MeasuredBox => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  const [height, setHeight] = useState(COLLAPSED_CHART_HEIGHT)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      // whole pixels down, so a fractional box never draws an SVG a hair taller
      // than its row and grows a scrollbar for it
      const measuredWidth = rect?.width ?? 0
      const measuredHeight = Math.floor(rect?.height ?? 0)
      if (measuredWidth > 0) setWidth(measuredWidth)
      if (measuredHeight > 0) setHeight(measuredHeight)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width, height }
}
