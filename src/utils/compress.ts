/**
 * Simple gzip helpers for large tool outputs.
 * Uses Bun's built-in Bun.gzipSync / Bun.gunzipSync.
 *
 * Outputs larger than COMPRESS_THRESHOLD_BYTES are stored compressed.
 * The tool_calls.output_compressed flag indicates which encoding is used.
 */

export const COMPRESS_THRESHOLD_BYTES = 10_240 // 10 KB

export function maybeCompress(text: string): {
  data: string
  compressed: boolean
  sizeBytes: number
} {
  const originalBytes = Buffer.byteLength(text, 'utf8')

  if (originalBytes < COMPRESS_THRESHOLD_BYTES) {
    return { data: text, compressed: false, sizeBytes: originalBytes }
  }

  try {
    const compressed = Bun.gzipSync(Buffer.from(text, 'utf8'))
    // Store as base64 so it fits in a TEXT column
    return {
      data: Buffer.from(compressed).toString('base64'),
      compressed: true,
      sizeBytes: originalBytes,
    }
  } catch {
    // Fall back to raw if compression fails
    return { data: text, compressed: false, sizeBytes: originalBytes }
  }
}

export function maybeDecompress(data: string, compressed: boolean): string {
  if (!compressed) return data
  try {
    const buf = Buffer.from(data, 'base64')
    return Buffer.from(Bun.gunzipSync(buf)).toString('utf8')
  } catch {
    return data
  }
}