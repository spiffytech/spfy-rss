import { describe, expect, test } from 'bun:test'

import { describeWriteFailure } from '../src/lib/reader'

describe('describeWriteFailure', () => {
  test('names the session when the write was rejected as unauthenticated', () => {
    expect(describeWriteFailure(new Response('', { status: 401 }), 'mark that read')).toContain(
      'session expired',
    )
  })

  test('says the action is not allowed for a forbidden write', () => {
    expect(describeWriteFailure(new Response('', { status: 403 }), 'rename that')).toBe(
      'You cannot rename that.',
    )
  })

  test('falls back to what failed, without leaking the exception text', () => {
    const message = describeWriteFailure(new Error('SQLITE_BUSY: database is locked'), 'star that')
    expect(message).toBe('Could not star that. Nothing was saved.')
    expect(message).not.toContain('SQLITE')
  })

  test('reads the status off a wrapped error as well as a Response', () => {
    expect(describeWriteFailure(Object.assign(new Error('nope'), { status: 401 }), 'x')).toContain(
      'session expired',
    )
  })
})
