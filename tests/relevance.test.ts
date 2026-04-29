/**
 * Unit tests for src/analysis/relevance.ts
 *
 * Tests the two offline scoring methods independently of the DB.
 */

import { describe, it, expect } from 'bun:test'
import { scoreLineOverlap, scoreSubstringMatch } from '../src/analysis/relevance.js'

// ─── scoreLineOverlap ─────────────────────────────────────────────────────────

describe('scoreLineOverlap', () => {
  it('returns ratio 1.0 when every output line appears in the response', () => {
    const output   = 'const x = 1\nconst y = 2\nconst z = 3'
    const response = 'I see: const x = 1, const y = 2, const z = 3'
    const result   = scoreLineOverlap(output, response)

    expect(result.relevanceRatio).toBe(1)
    expect(result.referencedLines).toBe(3)
    expect(result.fetchedLines).toBe(3)
  })

  it('returns ratio 0.0 when no output lines appear in the response', () => {
    const output   = 'completely unrelated content line one\nline two here'
    const response = 'The answer is forty-two.'
    const result   = scoreLineOverlap(output, response)

    expect(result.relevanceRatio).toBe(0)
    expect(result.referencedLines).toBe(0)
  })

  it('returns partial ratio for partial overlap', () => {
    const output   = 'function foo() {\n  return 42\n}\nfunction bar() {}'
    const response = 'The model references function foo() { and return 42 in its analysis.'
    const result   = scoreLineOverlap(output, response)

    // At least the two referenced lines should score > 0
    expect(result.relevanceRatio).toBeGreaterThan(0)
    expect(result.relevanceRatio).toBeLessThan(1)
    expect(result.referencedLines).toBeGreaterThanOrEqual(1)
  })

  it('skips trivially short lines (< 4 chars)', () => {
    const output   = 'ok\nyes\nno\nsome real content here'
    const response = 'ok yes no some real content here'
    // Short lines (ok, yes, no) are skipped; only "some real content here" counts
    const result   = scoreLineOverlap(output, response)
    expect(result.fetchedLines).toBe(4)
    // Only 1 real line was evaluated
    expect(result.referencedLines).toBeLessThanOrEqual(1)
  })

  it('clamps ratio to 1.0 even if estimate overshoots', () => {
    // Degenerate case: tiny output, huge response
    const output   = 'x'  // too short, won't be scored
    const response = 'x'.repeat(10_000)
    const result   = scoreLineOverlap(output, response)
    expect(result.relevanceRatio).toBeLessThanOrEqual(1)
  })

  it('handles empty output gracefully', () => {
    const result = scoreLineOverlap('', 'some response')
    expect(result.relevanceRatio).toBe(0)
    expect(result.fetchedLines).toBe(0)
    expect(result.referencedLines).toBe(0)
  })

  it('handles empty response gracefully', () => {
    const result = scoreLineOverlap('some output line here', '')
    expect(result.relevanceRatio).toBe(0)
    expect(result.referencedLines).toBe(0)
  })
})

// ─── scoreSubstringMatch ──────────────────────────────────────────────────────

describe('scoreSubstringMatch', () => {
  it('returns ratio > 0 when identifiers from output appear in response', () => {
    const output   = '{"functionName": "handleRequest", "filePath": "src/server.ts"}'
    const response = 'The handleRequest function in src/server.ts is the entry point.'
    const result   = scoreSubstringMatch(output, response)

    expect(result.relevanceRatio).toBeGreaterThan(0)
    expect(result.referencedTokens).toBeGreaterThan(0)
  })

  it('returns ratio 0.0 when output identifiers do not appear in response', () => {
    const output   = '{"foo": "xyzAbcDef123", "bar": "completelyUnrelated"}'
    const response = 'The answer involves a different concept entirely.'
    const result   = scoreSubstringMatch(output, response)

    expect(result.relevanceRatio).toBe(0)
  })

  it('returns ratio 1.0 for full match', () => {
    const content  = 'handleAuthentication validateSession refreshToken'
    const result   = scoreSubstringMatch(content, content)
    expect(result.relevanceRatio).toBe(1)
  })

  it('handles empty output gracefully', () => {
    const result = scoreSubstringMatch('', 'some response text here')
    expect(result.relevanceRatio).toBe(0)
    expect(result.fetchedTokens).toBe(0)
  })

  it('handles empty response gracefully', () => {
    const output = 'function handleRequest(req, res) { return res.send(200) }'
    const result = scoreSubstringMatch(output, '')
    expect(result.relevanceRatio).toBe(0)
  })

  it('clamps ratio to 1.0', () => {
    // All identifiers match → ratio should be exactly 1.0
    const output   = 'myFunctionName anotherIdentifier'
    const response = 'myFunctionName anotherIdentifier and more myFunctionName anotherIdentifier'
    const result   = scoreSubstringMatch(output, response)
    expect(result.relevanceRatio).toBeLessThanOrEqual(1)
  })

  it('extracts file paths correctly', () => {
    const output   = 'Found issue in src/utils/helper.ts at line 42'
    const response = 'The bug is in src/utils/helper.ts'
    const result   = scoreSubstringMatch(output, response)
    expect(result.relevanceRatio).toBeGreaterThan(0)
  })
})