import { describe, expect, test } from 'bun:test'

import { clampNavIndex, isPastReadLine, shouldAutoRead } from '../src/shared/reading'
import type { EntryId, FeedId } from '../src/shared/ids'

const entry = (s: string) => s as EntryId
const feed = (s: string) => s as FeedId

describe('shouldAutoRead', () => {
  const base = {
    viewMode: 'expanded' as const,
    userHasScrolled: true,
    disabledAutoReadFeeds: [feed('f9')] as FeedId[],
    keepUnreadIds: [entry('e77')] as EntryId[],
    feedId: feed('f1'),
    entryId: entry('e5'),
    status: 'unread' as const,
  }

  test('autoreads an unread entry with no blockers', () => {
    expect(shouldAutoRead(base)).toBe(true)
  })

  test('blocks in list view', () => {
    expect(shouldAutoRead({ ...base, viewMode: 'list' })).toBe(false)
  })

  test('blocks before the user has scrolled', () => {
    expect(shouldAutoRead({ ...base, userHasScrolled: false })).toBe(false)
  })

  test('blocks when the feed has auto-read disabled', () => {
    expect(shouldAutoRead({ ...base, feedId: feed('f9') })).toBe(false)
  })

  test('ignoreFeedSetting overrides a disabled feed', () => {
    expect(shouldAutoRead({ ...base, feedId: feed('f9'), ignoreFeedSetting: true })).toBe(true)
  })

  test('ignoreFeedSetting does not override the other guards', () => {
    expect(shouldAutoRead({ ...base, feedId: feed('f9'), ignoreFeedSetting: true, entryId: entry('e77') })).toBe(false)
    expect(shouldAutoRead({ ...base, feedId: feed('f9'), ignoreFeedSetting: true, status: 'read' })).toBe(false)
    expect(shouldAutoRead({ ...base, feedId: feed('f9'), ignoreFeedSetting: true, viewMode: 'list' })).toBe(false)
  })

  test('explicit reads an unread entry in list view', () => {
    expect(shouldAutoRead({ ...base, viewMode: 'list', explicit: true })).toBe(true)
  })

  test('explicit does not override keep-unread or read status', () => {
    expect(shouldAutoRead({ ...base, viewMode: 'list', explicit: true, entryId: entry('e77') })).toBe(false)
    expect(shouldAutoRead({ ...base, viewMode: 'list', explicit: true, status: 'read' })).toBe(false)
  })

  test('blocks explicitly kept-unread entries', () => {
    expect(shouldAutoRead({ ...base, entryId: entry('e77') })).toBe(false)
  })

  test('blocks read entries', () => {
    expect(shouldAutoRead({ ...base, status: 'read' })).toBe(false)
  })
})

describe('isPastReadLine', () => {
  // Read line at 150 in these fixtures (e.g. 15% of a 1000px root).
  const readLineY = 150

  test('entry whose top edge is above the line has been scrolled past', () => {
    expect(isPastReadLine({ top: -800, bottom: -20 }, readLineY)).toBe(true)
  })

  test('entry fully above the line has been scrolled past', () => {
    expect(isPastReadLine({ top: 20, bottom: 100 }, readLineY)).toBe(true)
  })

  test('tall entry whose top just crossed the line counts as passed', () => {
    expect(isPastReadLine({ top: 149.9, bottom: 5000 }, readLineY)).toBe(true)
  })

  test('entry with its top below the line has not been reached, however tall', () => {
    expect(isPastReadLine({ top: 200, bottom: 900 }, readLineY)).toBe(false)
    expect(isPastReadLine({ top: 151, bottom: 5000 }, readLineY)).toBe(false)
  })

  test('top edge exactly on the line is not yet past', () => {
    expect(isPastReadLine({ top: 150, bottom: 400 }, readLineY)).toBe(false)
  })
})

describe('clampNavIndex', () => {
  test('clamps low', () => {
    expect(clampNavIndex(-3, 10)).toBe(0)
  })

  test('clamps high', () => {
    expect(clampNavIndex(99, 10)).toBe(9)
  })

  test('passes through in-range values', () => {
    expect(clampNavIndex(4, 10)).toBe(4)
  })

  test('empty list returns 0', () => {
    expect(clampNavIndex(2, 0)).toBe(0)
  })
})
