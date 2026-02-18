/// <reference lib="webworker" />
import { parseTitles, searchBest } from './titles.ts'
import type { TitlesIndex } from './titles.ts'

let idx: TitlesIndex | null = null

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data
  if (type === 'init') {
    idx = parseTitles(e.data.buffer as ArrayBuffer)
    self.postMessage({ type: 'ready' })
  } else if (type === 'search') {
    if (!idx) return
    const yearBounds = e.data.yearBounds as [number, number] | undefined
    const tmdbId = searchBest(idx, e.data.query as string, {
      minRatingX10: e.data.minRatingX10 as number,
      yearBounds,
    })
    self.postMessage({ type: 'result', seq: e.data.seq, tmdbId })
  }
}
