// 50+ consecutive repeats of a 4-200 char pattern in the last 8KB indicates a model generation loop
export const REPETITION_THRESHOLD = 50
export const REPETITION_WINDOW = 8000

export function detectRepetition(text: string): boolean {
  if (text.length < REPETITION_WINDOW) return false
  const tail = text.slice(-REPETITION_WINDOW)
  for (let len = 4; len <= 200; len++) {
    const pattern = tail.slice(-len)
    let count = 0
    let pos = tail.length - len
    while (pos >= 0) {
      if (tail.slice(pos, pos + len) === pattern) {
        count++
        pos -= len
      } else break
    }
    if (count >= REPETITION_THRESHOLD) return true
  }
  return false
}
