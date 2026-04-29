/**
 * Unit tests for src/utils/compress.ts
 *
 * Tests maybeCompress() and maybeDecompress() using Bun's built-in gzip.
 */

import { describe, it, expect } from 'bun:test'
import { maybeCompress, maybeDecompress, COMPRESS_THRESHOLD_BYTES } from '../src/utils/compress.js'

// ─── maybeCompress ────────────────────────────────────────────────────────────

describe('maybeCompress', () => {
  it('does NOT compress text below the threshold', () => {
    const small = 'hello world'
    const result = maybeCompress(small)
    expect(result.compressed).toBe(false)
    expect(result.data).toBe(small)
    expect(result.sizeBytes).toBe(Buffer.byteLength(small, 'utf8'))
  })

  it('does NOT compress text exactly at threshold - 1 byte', () => {
    const text = 'x'.repeat(COMPRESS_THRESHOLD_BYTES - 1)
    const result = maybeCompress(text)
    expect(result.compressed).toBe(false)
    expect(result.data).toBe(text)
  })

  it('compresses text at or above the threshold', () => {
    const large = 'a'.repeat(COMPRESS_THRESHOLD_BYTES)
    const result = maybeCompress(large)
    expect(result.compressed).toBe(true)
    // data should be base64 (not the original plain text)
    expect(result.data).not.toBe(large)
    // base64 chars only
    expect(result.data).toMatch(/^[A-Za-z0-9+/]+=*$/)
    // sizeBytes should reflect original byte length
    expect(result.sizeBytes).toBe(Buffer.byteLength(large, 'utf8'))
  })

  it('compresses data significantly for repetitive text', () => {
    const repetitive = 'repeat '.repeat(3000) // ~21 KB
    const result = maybeCompress(repetitive)
    expect(result.compressed).toBe(true)
    // base64 compressed should be much smaller than original
    expect(result.data.length).toBeLessThan(repetitive.length)
  })

  it('handles empty string without crashing', () => {
    const result = maybeCompress('')
    expect(result.compressed).toBe(false)
    expect(result.data).toBe('')
    expect(result.sizeBytes).toBe(0)
  })
})

// ─── maybeDecompress ──────────────────────────────────────────────────────────

describe('maybeDecompress', () => {
  it('returns input unchanged when compressed=false', () => {
    const text = 'some plain text'
    expect(maybeDecompress(text, false)).toBe(text)
  })

  it('round-trips large text: compress → decompress returns original', () => {
    const original = 'The quick brown fox jumps over the lazy dog. '.repeat(300) // ~13 KB
    const { data, compressed } = maybeCompress(original)
    expect(compressed).toBe(true)
    const restored = maybeDecompress(data, true)
    expect(restored).toBe(original)
  })

  it('handles decompressing an empty compressed payload gracefully', () => {
    // maybeCompress('') → compressed=false so this path is edge case;
    // simulate a corrupt/empty base64 payload — should not throw
    const result = maybeDecompress('', true)
    // Either returns empty string or original (both acceptable — just no crash)
    expect(typeof result).toBe('string')
  })
})

// ─── COMPRESS_THRESHOLD_BYTES export ─────────────────────────────────────────

describe('COMPRESS_THRESHOLD_BYTES', () => {
  it('is 10240 (10 KB)', () => {
    expect(COMPRESS_THRESHOLD_BYTES).toBe(10_240)
  })
})