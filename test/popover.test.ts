import { describe, expect, test } from 'bun:test'

import {
  computePopoverPlacement,
  POPOVER_DESKTOP_WIDTH,
  POPOVER_GAP,
  POPOVER_MARGIN,
} from '../src/shared/popover'

describe('computePopoverPlacement', () => {
  test('mobile spans the viewport under the trigger', () => {
    const p = computePopoverPlacement({
      rect: { right: 200, bottom: 48 },
      viewportWidth: 390,
      viewportHeight: 844,
      isDesktop: false,
    })
    expect(p.top).toBe(48 + POPOVER_GAP)
    expect(p.left).toBe(POPOVER_MARGIN)
    expect(p.width).toBe(390 - POPOVER_MARGIN * 2)
    expect(p.maxHeight).toBe(844 - (48 + POPOVER_GAP) - POPOVER_MARGIN)
  })

  test('stays inside a 320px viewport', () => {
    const p = computePopoverPlacement({
      rect: { right: 160, bottom: 48 },
      viewportWidth: 320,
      viewportHeight: 568,
      isDesktop: false,
    })
    expect(p.left).toBe(POPOVER_MARGIN)
    expect(p.left + p.width).toBe(320 - POPOVER_MARGIN)
  })

  test('desktop right-aligns to the trigger', () => {
    const p = computePopoverPlacement({
      rect: { right: 900, bottom: 52 },
      viewportWidth: 1280,
      viewportHeight: 900,
      isDesktop: true,
    })
    expect(p.width).toBe(POPOVER_DESKTOP_WIDTH)
    expect(p.left).toBe(900 - POPOVER_DESKTOP_WIDTH)
    expect(p.maxHeight).toBe(900 - 52 - POPOVER_GAP - POPOVER_MARGIN)
  })

  test('desktop clamps to the viewport when the trigger sits at the right edge', () => {
    const p = computePopoverPlacement({
      rect: { right: 780, bottom: 52 },
      viewportWidth: 768,
      viewportHeight: 700,
      isDesktop: true,
    })
    expect(p.width).toBe(POPOVER_DESKTOP_WIDTH)
    expect(p.left).toBe(768 - POPOVER_MARGIN - POPOVER_DESKTOP_WIDTH)
    expect(p.left + p.width).toBe(768 - POPOVER_MARGIN)
  })

  test('desktop shrink-wraps the width on a viewport narrower than the card', () => {
    const p = computePopoverPlacement({
      rect: { right: 300, bottom: 52 },
      viewportWidth: 300,
      viewportHeight: 700,
      isDesktop: true,
    })
    expect(p.width).toBe(300 - POPOVER_MARGIN * 2)
    expect(p.left).toBe(POPOVER_MARGIN)
  })

  test('never returns a negative width or maxHeight', () => {
    const p = computePopoverPlacement({
      rect: { right: 10, bottom: 600 },
      viewportWidth: 10,
      viewportHeight: 610,
      isDesktop: true,
    })
    expect(p.width).toBeGreaterThanOrEqual(0)
    expect(p.maxHeight).toBeGreaterThanOrEqual(0)
  })
})
