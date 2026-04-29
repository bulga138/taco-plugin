/**
 * Content-addressable SHA-256 hash helper (Bun built-in crypto).
 */

export function sha256hex(text: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(text)
  return hasher.digest('hex')
}