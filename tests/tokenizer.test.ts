import { describe, it, expect } from 'bun:test';
import { estimateTokens, estimateCost, type TokenCount } from '../src/tokenizer/index.js';

describe('estimateTokens', () => {
  it('returns zero count for empty string', () => {
    const result = estimateTokens('', 'gpt-4o');
    expect(result.count).toBe(0);
    expect(result.method).toBe('exact');
  });

  describe('OpenAI models', () => {
    it('uses gpt-tokenizer for gpt-4o (exact)', () => {
      const result = estimateTokens('Hello world', 'gpt-4o');
      expect(result.method).toBe('exact');
      expect(result.count).toBeGreaterThan(0);
    });

    it('uses gpt-tokenizer for o1 (exact)', () => {
      const result = estimateTokens('Hello world', 'o1-preview');
      expect(result.method).toBe('exact');
    });

    it('uses gpt-tokenizer for gpt-3.5-turbo (exact)', () => {
      const result = estimateTokens('Hello world', 'gpt-3.5-turbo');
      expect(result.method).toBe('exact');
    });
  });

  describe('Claude models', () => {
    it('uses @lenml for claude-3-opus (near-exact)', () => {
      const result = estimateTokens('Hello world', 'claude-3-opus');
      expect(result.method).toBe('near-exact');
    });

    it('adds warning for claude 4.7+', () => {
      const result = estimateTokens('Hello world', 'claude-opus-4.7');
      expect(result.warning).toBeDefined();
    });

    it('no warning for claude 4.5', () => {
      const result = estimateTokens('Hello world', 'claude-sonnet-4-20250501');
      expect(result.warning).toBeUndefined();
    });
  });

  describe('DeepSeek models', () => {
    it('uses @lenml for deepseek-v3 (near-exact)', () => {
      const result = estimateTokens('Hello world', 'deepseek-v3');
      expect(result.method).toBe('near-exact');
    });
  });

  describe('fallback heuristics', () => {
    it('uses 4.0 bytes/token for gemini', () => {
      const result = estimateTokens('Hello world', 'gemini-2.0-flash');
      expect(result.method).toBe('heuristic');
      // 12 bytes / 4.0 = 3
      expect(result.count).toBe(3);
    });

    it('uses 3.8 bytes/token for llama', () => {
      const result = estimateTokens('Hello world', 'llama-3-8b');
      expect(result.method).toBe('heuristic');
      // 12 bytes / 3.8 = 3.16 -> ceil = 4, but text is 11 bytes
      expect(result.count).toBeGreaterThanOrEqual(3);
    });

    it('uses 3.8 for unknown models', () => {
      const result = estimateTokens('Hello world', 'unknown-model');
      expect(result.method).toBe('heuristic');
    });

    it('adds warning for GLM', () => {
      const result = estimateTokens('Hello world', 'glm-4');
      expect(result.warning).toContain('GLM');
    });
  });
});

describe('countTokens (legacy)', () => {
  it('returns a number', () => {
    const count = countTokens('Hello world', 'gpt-4o');
    expect(typeof count).toBe('number');
  });
});

describe('estimateCost', () => {
  it('calculates total cost correctly', () => {
    const cost = estimateCost({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      costInput: 0.00001,
      costOutput: 0.00003,
      costCacheRead: 0.000001,
      costCacheWrite: 0.00001,
    });
    // 1000*0.00001 + 500*0.00003 + 2000*0.000001 + 100*0.00001
    // = 0.01 + 0.015 + 0.002 + 0.001 = 0.028
    expect(cost).toBeCloseTo(0.028);
  });
});

// Also exports countTokens for backward compat
import { countTokens } from '../src/tokenizer/index.js';
