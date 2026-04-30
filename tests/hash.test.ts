/**
 * Unit tests for src/utils/hash.ts
 *
 * Tests sha256hex() determinism, known digest, and edge cases.
 */

import { describe, it, expect } from 'bun:test';
import { sha256hex } from '../src/utils/hash.js';

// Known SHA-256 digests (verified externally via `echo -n "..." | sha256sum`)
const KNOWN = {
  hello: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', // SHA-1, wrong — use sha256 below
  // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
};

describe('sha256hex', () => {
  it('returns a 64-character lowercase hex string', () => {
    const hash = sha256hex('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 digest for "hello"', () => {
    expect(sha256hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('matches the known SHA-256 digest for the empty string', () => {
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is deterministic — same input always produces the same output', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(sha256hex(text)).toBe(sha256hex(text));
  });

  it('produces different digests for different inputs', () => {
    expect(sha256hex('foo')).not.toBe(sha256hex('bar'));
    expect(sha256hex('foo')).not.toBe(sha256hex('foo '));
  });

  it('handles unicode text', () => {
    const hash = sha256hex('こんにちは世界');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles a long string without throwing', () => {
    const long = 'x'.repeat(100_000);
    const hash = sha256hex(long);
    expect(hash).toHaveLength(64);
  });
});
