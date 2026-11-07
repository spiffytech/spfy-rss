// Placement math for the toolbar's feed popover.
//
// The panel is a top-layer `<dialog>`, so its containing block is the viewport
// and it does not follow its trigger the way an absolutely-positioned menu
// would: top/left/width have to be computed and re-applied. Kept pure (and in
// src/shared, alongside the other framework-free helpers) because jsdom has no
// dialog implementation — this is the only part of placement a test can reach.

/** Gap between the trigger and the panel. */
export const POPOVER_GAP = 4
/** Space kept between the panel and any viewport edge. */
export const POPOVER_MARGIN = 8
/** Panel width at md+, where it hangs off the trigger as a card. */
export const POPOVER_DESKTOP_WIDTH = 320

export interface PopoverRect {
  /** Viewport-relative, i.e. straight from getBoundingClientRect(). */
  right: number
  bottom: number
}

export interface PopoverPlacement {
  top: number
  left: number
  width: number
  maxHeight: number
}

export function computePopoverPlacement(input: {
  rect: PopoverRect
  viewportWidth: number
  viewportHeight: number
  /** True at md+ (48rem). Below that the panel spans the viewport instead. */
  isDesktop: boolean
}): PopoverPlacement {
  const { rect, viewportWidth, viewportHeight, isDesktop } = input
  const top = Math.round(rect.bottom + POPOVER_GAP)
  // Fill whatever room is left below the trigger; the panel scrolls past that.
  const maxHeight = Math.max(0, Math.round(viewportHeight - top - POPOVER_MARGIN))

  if (!isDesktop) {
    // The mobile trigger is squeezed between the hamburger and prev/next, so a
    // panel the width of the trigger would be too narrow for its rows. Span the
    // viewport instead, lined up with the toolbar's own px-2.
    return {
      top,
      left: POPOVER_MARGIN,
      width: Math.max(0, Math.round(viewportWidth - POPOVER_MARGIN * 2)),
      maxHeight,
    }
  }

  const width = Math.min(
    POPOVER_DESKTOP_WIDTH,
    Math.max(0, Math.round(viewportWidth - POPOVER_MARGIN * 2)),
  )
  // Right-align to the trigger, then clamp so a narrow window can't push it off.
  const left = Math.max(
    POPOVER_MARGIN,
    Math.min(Math.round(rect.right) - width, viewportWidth - POPOVER_MARGIN - width),
  )
  return { top, left, width, maxHeight }
}
