import { CELL_W } from './viewport.ts'

const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/'
const DEFAULT_MAX_CONCURRENT = 36
const MOTION_MAX_CONCURRENT = 18
const TMDB_SIZES = [92, 154, 185, 342, 500, 780] as const

export type TmdbSize = (typeof TMDB_SIZES)[number]

/** Map<cellKey, Map<TmdbSize, HTMLImageElement>> */
const store = new Map<string, Map<TmdbSize, HTMLImageElement>>()
let inFlight = 0
const queue: { cellKey: string; posterPath: string; size: TmdbSize }[] = []
const queued = new Set<string>()
let onLoad: (() => void) | undefined
let currentMaxConcurrent = DEFAULT_MAX_CONCURRENT

function queueKey(cellKey: string, size: TmdbSize): string {
  return `${cellKey}@${size}`
}

export function setOnLoad(cb: () => void) {
  onLoad = cb
}

export function setMaxConcurrent(n: number) {
  const next = Math.max(1, Math.round(n))
  if (next === currentMaxConcurrent) return
  currentMaxConcurrent = next
  drainQueue()
}

export function setMotionProfile(active: boolean) {
  setMaxConcurrent(active ? MOTION_MAX_CONCURRENT : DEFAULT_MAX_CONCURRENT)
}

export function pickSize(scale: number, dpr: number): TmdbSize {
  const needed = CELL_W * scale * dpr
  for (const s of TMDB_SIZES) {
    if (s >= needed) return s
  }
  return TMDB_SIZES[TMDB_SIZES.length - 1]
}

export function get(cellKey: string, size: TmdbSize): HTMLImageElement | undefined {
  return store.get(cellKey)?.get(size)
}

export function getBestAvailable(cellKey: string, size: TmdbSize): HTMLImageElement | undefined {
  const cell = store.get(cellKey)
  if (!cell) return undefined
  // Walk sizes downward from requested
  for (let i = TMDB_SIZES.indexOf(size); i >= 0; i--) {
    const img = cell.get(TMDB_SIZES[i])
    if (img?.complete && img.naturalWidth > 0) return img
  }
  // Check sizes above requested
  for (let i = TMDB_SIZES.indexOf(size) + 1; i < TMDB_SIZES.length; i++) {
    const img = cell.get(TMDB_SIZES[i])
    if (img?.complete && img.naturalWidth > 0) return img
  }
  return undefined
}

export function load(cellKey: string, posterPath: string, size: TmdbSize): void {
  if (!posterPath) return
  if (store.get(cellKey)?.has(size)) return
  if (inFlight >= currentMaxConcurrent) {
    // O(1) dedupe for hot scroll/preload path
    const qk = queueKey(cellKey, size)
    if (!queued.has(qk)) {
      queue.push({ cellKey, posterPath, size })
      queued.add(qk)
    }
    return
  }
  fireLoad(cellKey, posterPath, size)
}

function fireLoad(cellKey: string, posterPath: string, size: TmdbSize): void {
  let cell = store.get(cellKey)
  if (!cell) {
    cell = new Map()
    store.set(cellKey, cell)
  }

  inFlight++
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.decoding = 'async'
  img.src = `${TMDB_IMG_BASE}w${size}${posterPath}`
  const done = () => { inFlight--; drainQueue() }
  img.onload = () => { done(); onLoad?.() }
  img.onerror = () => { cell!.delete(size); done() }
  cell.set(size, img)
}

function drainQueue(): void {
  while (inFlight < currentMaxConcurrent && queue.length > 0) {
    const item = queue.shift()!
    queued.delete(queueKey(item.cellKey, item.size))
    if (store.get(item.cellKey)?.has(item.size)) continue
    fireLoad(item.cellKey, item.posterPath, item.size)
  }
}

export function evictImages(keys: string[]) {
  const evicted = new Set(keys)
  for (const k of keys) store.delete(k)
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i]
    if (!evicted.has(item.cellKey)) continue
    queued.delete(queueKey(item.cellKey, item.size))
    queue.splice(i, 1)
  }
}

export function stash(cellKey: string) {
  return store.get(cellKey)
}

export function restore(cellKey: string, imgs: Map<TmdbSize, HTMLImageElement>) {
  store.set(cellKey, imgs)
}

export function clearAllImages() {
  store.clear()
  queue.length = 0
  queued.clear()
  inFlight = 0
}

/** Reset loader state after bfcache restore, keeping completed images */
export function unstickLoader() {
  inFlight = 0
  queue.length = 0
  queued.clear()
  for (const [cellKey, cell] of store) {
    for (const [size, img] of cell) {
      if (!img.complete || img.naturalWidth === 0) cell.delete(size)
    }
    if (cell.size === 0) store.delete(cellKey)
  }
}
