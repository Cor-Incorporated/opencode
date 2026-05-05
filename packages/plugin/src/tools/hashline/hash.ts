/**
 * Clean-room implementation. Functional spec inspired by the public README of
 * oh-my-openagent (SUL-1.0). Implementation, constants (alphabet, separator),
 * and structure are independently chosen. MIT-licensed under
 * Cor-Incorporated/opencode.
 *
 * Content-hash utilities for the hashline edit tool.
 *
 * Algorithm: xxHash32 (`Bun.hash.xxHash32`).
 * Encoding: lower 8 bits of the hash split into two nibbles, each
 * indexed into a fixed 16-character alphabet of unambiguous letters.
 *
 * The encoding is intentionally lossy. Two characters give 256 buckets;
 * collisions are tolerated because the line number (also part of the
 * anchor) further narrows the match. The point is to detect when the
 * agent's snapshot is stale, not to verify cryptographic integrity.
 */

/**
 * Fixed 16-character alphabet used for hash encoding.
 *
 * Independently chosen consonant set drawn from the basic Latin alphabet:
 *   - All vowels (A, E, I, O, U, Y) excluded — avoids accidental words and
 *     also drops the most common look-alikes (I/O).
 *   - L, W, X, Z excluded for visual clarity (L confuses with 1/I and W/X/Z
 *     are visually heavy when adjacent in fixed-width fonts).
 *   - Result: 16 visually distinct uppercase consonants.
 *
 * Not derived from any third-party source.
 */
export const HASH_ALPHABET = "BCDFGHJKMNPQRSTV"

/**
 * Length of an encoded hash (always 2 characters).
 */
export const HASH_LENGTH = 2

/**
 * Compute the 2-character hash of a single line of content.
 *
 * The input should be a single line WITHOUT the trailing newline.
 * Empty strings hash deterministically (same input → same hash).
 */
export function hashLine(content: string): string {
  const raw = Bun.hash.xxHash32(content)
  // Bun.hash.xxHash32 returns a number, but we only need the low byte.
  // Using bigint-safe arithmetic via Number coercion is fine for 32-bit.
  const byte = Number(raw) & 0xff
  const high = (byte >> 4) & 0xf
  const low = byte & 0xf
  return HASH_ALPHABET[high]! + HASH_ALPHABET[low]!
}

/**
 * Return true if every character in `value` is a valid hash character.
 * Useful for parser validation.
 */
export function isValidHashChars(value: string): boolean {
  if (value.length !== HASH_LENGTH) return false
  for (const ch of value) {
    if (!HASH_ALPHABET.includes(ch)) return false
  }
  return true
}
