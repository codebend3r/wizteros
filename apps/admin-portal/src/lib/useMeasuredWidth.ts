import { useEffect, useRef, useState, type RefObject } from 'react'

// Phone-safe on purpose. A wide fallback inflates the layout on a narrow
// screen before ResizeObserver runs, and the observer then measures the box
// its own fallback inflated: the wrong width locks itself in. From below, the
// first measurement can only grow.
const FALLBACK_WIDTH = 280

/** The rendered width of a chart's box, tracked so the chart draws in real
    pixels: hairlines stay hairlines and label text never scales with a viewBox.
    Falls back to a fixed width where ResizeObserver cannot measure.

    Measured here rather than handed to Recharts' own ResponsiveContainer, which
    renders nothing at all inside a box reporting zero size - every chart test
    among them. */
export const useMeasuredWidth = (): { ref: RefObject<HTMLDivElement | null>; width: number } => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0
      if (measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}
