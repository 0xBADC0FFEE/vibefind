import { createViewport, centerOn, getVisibleRange, getCenterOutOffsets, PRELOAD_BUFFER, CELL_W, CELL_H, screenToWorld, worldToScreen } from './canvas/viewport.ts'
import { createGestureState, setupGestures, type TapIntent } from './canvas/gestures.ts'
import { render, preloadPosters } from './canvas/renderer.ts'
import type { FilterSwapFxEntry } from './canvas/renderer.ts'
import { createGrid, fillRange, evictOutside, clearGrid, setCell } from './engine/grid.ts'
import { generateMockIndex, parseEmbeddings } from './engine/embeddings.ts'
import type { EmbeddingsIndex, MovieEntry } from './engine/embeddings.ts'
import { setOnLoad, setMotionProfile, evictImages, clearAllImages, unstickLoader, stash, restore, pickSize, load as loadPoster } from './canvas/poster-loader.ts'
import { startWave, isWaveDone } from './canvas/wave.ts'
import type { WaveState, OldCellData } from './canvas/wave.ts'
import { createAnimation, animateViewport } from './canvas/animation.ts'
import { createDebugOverlay, type DebugOverlay } from './debug/overlay.ts'
import type { TitlesIndex } from './engine/titles.ts'
import { TOP_K, buildGenerationTarget, generateMovie } from './engine/generator.ts'
import { calcMotionDiversityMetrics } from './engine/motion-profile.ts'
import { buildRatingMorphPath, clampRatingX10 } from './ui/rating-morph.ts'
import { parseSearchCommand } from './ui/search-command.ts'
import { isBackgroundOpen } from './ui/link-open-intent.ts'

function getSafeAreaTop(): number {
  const el = document.createElement('div')
  el.style.height = 'env(safe-area-inset-top, 0px)'
  document.body.appendChild(el)
  const h = el.getBoundingClientRect().height
  document.body.removeChild(el)
  return h
}

function key(col: number, row: number): string {
  return `${col}:${row}`
}

function parseKey(cellKey: string): [number, number] {
  const [cs, rs] = cellKey.split(':')
  return [parseInt(cs), parseInt(rs)]
}

function formatRating(ratingX10: number): string {
  return (ratingX10 / 10).toFixed(1)
}

let safeTop = 0

const EVICT_BUFFER = 8
const GESTURE_BUFFER = 4
const GESTURE_VISIBLE_FILL = 1
const GESTURE_FILL = 4
const FILL_PER_FRAME = 6
const IDLE_FILL_MAX = 16
const SEARCH_DEBOUNCE = 150
const FILL_DELAY = 300
const MOTION_DPR_CAP = 0.75
const RESTORE_DEBOUNCE_MS = 160
const MOTION_VELOCITY_THRESHOLD = 0.35
const DPR_SWITCH_EPS = 0.05

const RATING_MIN_X10 = 50
const RATING_MAX_X10 = 80
const RATING_STEP_X10 = 5
const ICON_RATINGS_X10 = [50, 60, 65, 75, 80]
const FILTER_REPLACE_BATCH = 14
const FILTER_SWAP_TIMEOUT = 500
const HINT_DURATION_MS = 1200
const TRACKPAD_PREF_KEY = 'vibefind.trackpad_pan_mac'
const CENTER_TARGET_BIAS_PX = -4

const rIC: typeof requestIdleCallback = window.requestIdleCallback
  ?? ((cb) => setTimeout(() => cb({
    timeRemaining: () => 1, didTimeout: false,
  } as IdleDeadline), 1) as any)
const cIC: typeof cancelIdleCallback = window.cancelIdleCallback ?? clearTimeout

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const searchPanel = document.getElementById('search-panel') as HTMLDivElement
const searchInput = document.getElementById('search') as HTMLInputElement
const ratingStrip = document.getElementById('rating-strip') as HTMLDivElement
const ratingStars = Array.from(
  ratingStrip.querySelectorAll<HTMLButtonElement>('.rating-star'),
)
const searchHint = document.getElementById('search-hint') as HTMLDivElement
const filterToggle = document.getElementById('filter-toggle') as HTMLButtonElement
const filterRows = document.getElementById('filter-rows') as HTMLDivElement
const yearSlider = document.getElementById('year-slider') as HTMLInputElement

function computeVisibleCenterArea(pad = 0): { top: number; bottom: number; centerY: number } {
  const vv = window.visualViewport
  const visualTop = vv ? Math.max(0, vv.offsetTop) : 0
  const visualH = vv ? Math.max(1, vv.height) : window.innerHeight
  const safeTopY = visualTop + safeTop
  const panelH = Math.max(1, searchPanel.getBoundingClientRect().height)
  const panelBottomOffset = Math.max(0, parseFloat(getComputedStyle(searchPanel).bottom) || 0)
  const viewportBottomY = visualTop + visualH
  const panelTop = viewportBottomY - panelBottomOffset - panelH
  const centerY = (safeTopY + panelTop) / 2 + CENTER_TARGET_BIAS_PX
  const top = safeTopY + pad
  const bottom = Math.max(top + 1, panelTop - pad)
  return { top, bottom, centerY }
}

let nativeDpr = window.devicePixelRatio || 1
let motionDpr = Math.min(nativeDpr, nativeDpr * MOTION_DPR_CAP)
let idleDpr = nativeDpr
let currentDpr = idleDpr
let lastMotionTs = 0

function refreshDprTargets() {
  nativeDpr = window.devicePixelRatio || 1
  idleDpr = nativeDpr
  motionDpr = Math.min(nativeDpr, nativeDpr * MOTION_DPR_CAP)
}

function resize(dpr = currentDpr) {
  const useDpr = Math.max(0.1, dpr)
  const rect = canvas.getBoundingClientRect()
  const w = rect.width
  const h = rect.height
  canvas.width = Math.round(w * useDpr)
  canvas.height = Math.round(h * useDpr)
  ctx.setTransform(useDpr, 0, 0, useDpr, 0, 0)
  vp.width = w
  vp.height = h
}

function maybeApplyDpr(nextDpr: number): boolean {
  if (Math.abs(nextDpr - currentDpr) < DPR_SWITCH_EPS) return false
  currentDpr = nextDpr
  resize(currentDpr)
  return true
}

function onVisualViewportChange() {
  if (searchMode) {
    const vvp = window.visualViewport!

    // Cancel any running enterSearchMode animation so tick() can't overwrite
    cancelAnimationFrame(anim.id)
    anim.running = false

    centerCardForSearch(searchCell[0], searchCell[1], vvp.offsetTop, vvp.height, false)
  } else if (exitRecenterCell) {
    centerSearchCellOnCanvas()
    scheduleRepaint()
  }
}

const vp = createViewport(window.innerWidth, window.innerHeight)
const gs = createGestureState()
const grid = createGrid()
const anim = createAnimation()

const searchWorker = new Worker(new URL('./engine/search.worker.ts', import.meta.url), { type: 'module' })
const generationWorker = new Worker(new URL('./engine/generator.worker.ts', import.meta.url), { type: 'module' })
let searchSeq = 0
let searchReady = false
let generationReady = false
let generationEpoch = 0
let generationReqSeq = 0
const generationPendingByReq = new Map<number, { cellKey: string; col: number; row: number; epoch: number }>()
const generationPendingKeys = new Set<string>()

let index: EmbeddingsIndex
let activeIndex: EmbeddingsIndex
let movieByTmdbId = new Map<number, MovieEntry>()
let titlesIndex: TitlesIndex | null = null
let searchMode = false
let searchCell: [number, number] = [0, 0]
let searchRecenterTimer = 0
let exitRecenterCell: [number, number] | null = null
let searchDebounceId = 0
let fillCoherent = false
let fillDebounceId = 0
let fillPending = false
let idleId = 0
let suppressNextTap = false
let lpTimer = 0
let lpInterval = 0
let activeWave: WaveState | null = null
let debugOverlay: DebugOverlay | null = null

let minRatingX10 = RATING_MIN_X10
let ratingFilterSeq = 0
let ratingReplaceRaf = 0
let ratingReplaceQueue: string[] = []
let hintTimer = 0
let isDraggingFilter = false
let trackpadPanEnabled = false
let yearSliderPos = 5  // 0-10, center (5) = all years
let filtersVisible = false
const filterSwapFx = new Map<string, FilterSwapFxEntry>()
const allowAll = (_tmdbId: number): boolean => true
let lastEvictSig = ''
let lastPreloadSig = ''

function clampMinRatingX10(v: number): number {
  const clamped = Math.max(RATING_MIN_X10, Math.min(RATING_MAX_X10, clampRatingX10(v)))
  return Math.round(clamped / RATING_STEP_X10) * RATING_STEP_X10
}

function ratingForTmdb(tmdbId: number): number | null {
  if (!titlesIndex) return null
  const idx = titlesIndex.idToIdx.get(tmdbId)
  return idx === undefined ? null : titlesIndex.ratings[idx]
}

function isTmdbAllowed(tmdbId: number): boolean {
  const rating = ratingForTmdb(tmdbId)
  if (rating != null && rating < minRatingX10) return false
  if (titlesIndex) {
    const idx = titlesIndex.idToIdx.get(tmdbId)
    if (idx !== undefined) {
      const [minY, maxY] = titlesIndex.yearBounds[yearSliderPos]
      const y = titlesIndex.years[idx]
      if (y < minY || y > maxY) return false
    }
  }
  return true
}

function rebuildActiveIndex() {
  if (!titlesIndex) {
    activeIndex = index
    return
  }
  activeIndex = {
    movies: index.movies.filter((m) => isTmdbAllowed(m.tmdbId)),
  }
}

function cancelPendingGenerationRequests() {
  generationPendingByReq.clear()
  generationPendingKeys.clear()
}

function syncGenerationWorkerIndex() {
  generationEpoch++
  generationReady = false
  cancelPendingGenerationRequests()
  generationWorker.postMessage({
    type: 'init',
    epoch: generationEpoch,
    movies: activeIndex.movies.map((m) => ({ tmdbId: m.tmdbId, embedding: m.embedding })),
  })
}

function pickWeightedTmdbId(tmdbIds: number[]): number | null {
  if (tmdbIds.length === 0) return null
  let total = 0
  for (let i = 0; i < tmdbIds.length; i++) total += tmdbIds.length - i
  let r = Math.random() * total
  for (let i = 0; i < tmdbIds.length; i++) {
    r -= (tmdbIds.length - i)
    if (r <= 0) return tmdbIds[i]
  }
  return tmdbIds[0] ?? null
}

function pickRandomActiveEntry(): MovieEntry | null {
  const movies = activeIndex.movies
  if (movies.length === 0) return null
  for (let attempt = 0; attempt < 20; attempt++) {
    const entry = movies[Math.floor(Math.random() * movies.length)]
    if (!grid.onScreen.has(entry.tmdbId)) return entry
  }
  for (let i = 0; i < movies.length; i++) {
    const entry = movies[i]
    if (!grid.onScreen.has(entry.tmdbId)) return entry
  }
  return null
}

function queueWorkerFill(
  range: { minCol: number; maxCol: number; minRow: number; maxRow: number },
  maxNew: number,
  noiseFactor: number,
  randomChance: number,
): number {
  if (maxNew <= 0) return 0
  const cols = range.maxCol - range.minCol + 1
  const rows = range.maxRow - range.minRow + 1
  let queued = 0

  for (const [dc, dr] of getCenterOutOffsets(cols, rows)) {
    if (queued >= maxNew) break
    const col = range.minCol + dc
    const row = range.minRow + dr
    const cellKey = key(col, row)
    if (grid.cells.has(cellKey) || generationPendingKeys.has(cellKey)) continue

    const target = buildGenerationTarget(col, row, grid, false, noiseFactor, randomChance)
    if (!target) {
      const randomEntry = pickRandomActiveEntry()
      if (!randomEntry) continue
      setCell(grid, col, row, {
        tmdbId: randomEntry.tmdbId,
        posterPath: randomEntry.posterPath,
        embedding: randomEntry.embedding,
      })
      queued++
      continue
    }

    if (!generationReady) continue

    const reqId = ++generationReqSeq
    generationPendingKeys.add(cellKey)
    generationPendingByReq.set(reqId, { cellKey, col, row, epoch: generationEpoch })
    generationWorker.postMessage({
      type: 'topk',
      reqId,
      epoch: generationEpoch,
      target: target.target,
      exclude: [...grid.onScreen],
      k: TOP_K,
    })
    queued++
  }

  return queued
}

function handleGenerationWorkerMessage(e: MessageEvent) {
  const { type } = e.data

  if (type === 'ready') {
    if (e.data.epoch === generationEpoch) generationReady = true
    return
  }

  if (type !== 'result') return
  const reqId = e.data.reqId as number
  const epoch = e.data.epoch as number
  const req = generationPendingByReq.get(reqId)
  if (!req) return

  generationPendingByReq.delete(reqId)
  generationPendingKeys.delete(req.cellKey)

  if (epoch !== generationEpoch || req.epoch !== generationEpoch) return
  if (grid.cells.has(req.cellKey)) return

  const tmdbIds = e.data.tmdbIds as number[]
  const candidateIds = tmdbIds.filter((id) => !grid.onScreen.has(id) && isTmdbAllowed(id))
  const pickedTmdbId = pickWeightedTmdbId(candidateIds)
  if (!pickedTmdbId) return
  const entry = movieByTmdbId.get(pickedTmdbId)
  if (!entry) return

  setCell(grid, req.col, req.row, {
    tmdbId: entry.tmdbId,
    posterPath: entry.posterPath,
    embedding: entry.embedding,
  })
  scheduleRepaint()
}

function hasVisibleSwapFx(): boolean {
  if (filterSwapFx.size === 0) return false
  const range = getVisibleRange(vp)
  for (const cellKey of filterSwapFx.keys()) {
    const [col, row] = parseKey(cellKey)
    if (
      col >= range.minCol && col <= range.maxCol
      && row >= range.minRow && row <= range.maxRow
    ) return true
  }
  return false
}

function updateFilterToggleIcon() {
  const ratingAboveMin = minRatingX10 > RATING_MIN_X10
  const yearActive = yearSliderPos !== 5
  filterToggle.classList.toggle('active-filter', ratingAboveMin || yearActive)
}

function updateRatingUI() {
  for (let i = 0; i < ratingStars.length; i++) {
    const star = ratingStars[i]
    const iconRatingX10 = Number(star.dataset.ratingX10 || ICON_RATINGS_X10[i] || RATING_MIN_X10)
    const active = Number.isFinite(iconRatingX10) && iconRatingX10 >= minRatingX10
    star.classList.toggle('active', active)
    star.classList.toggle('inactive', !active)
  }
  updateFilterToggleIcon()
}

function showHint(text: string) {
  searchHint.textContent = text
  searchHint.classList.add('show')
  clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    searchHint.classList.remove('show')
  }, HINT_DURATION_MS)
}

function isMacOS(): boolean {
  const uaData = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = (uaData.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase()
  return platform.includes('mac')
}

function loadTrackpadPanPreference(): boolean {
  if (!isMacOS()) return false
  try {
    return localStorage.getItem(TRACKPAD_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function persistTrackpadPanPreference() {
  if (!isMacOS()) return
  try {
    localStorage.setItem(TRACKPAD_PREF_KEY, trackpadPanEnabled ? '1' : '0')
  } catch {
    // Ignore storage failures (private mode, denied storage)
  }
}

function applyTrackpadPanEnabled(enabled: boolean) {
  trackpadPanEnabled = enabled
  gs.trackpadPanEnabled = enabled
}

function handleSlashCommand(query: string): boolean {
  const command = parseSearchCommand(query)
  if (command !== 'trackpad') return false

  if (!isMacOS()) {
    showHint('Trackpad command: macOS only')
    return true
  }

  applyTrackpadPanEnabled(!trackpadPanEnabled)
  persistTrackpadPanPreference()
  showHint(`Trackpad swipe pan: ${trackpadPanEnabled ? 'ON' : 'OFF'}`)
  return true
}

function pointsToPathD(points: Array<{ x: number, y: number }>): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x.toFixed(3)} ${points[0].y.toFixed(3)}`
  for (let i = 1; i < points.length; i++) {
    const pt = points[i]
    d += ` L ${pt.x.toFixed(3)} ${pt.y.toFixed(3)}`
  }
  d += ' Z'
  return d
}

function initRatingStripIcons() {
  for (let i = 0; i < ratingStars.length; i++) {
    const star = ratingStars[i]
    const ratingX10 = Number(star.dataset.ratingX10 || ICON_RATINGS_X10[i] || RATING_MIN_X10)
    const path = star.querySelector('path')
    if (!path) continue
    const { points } = buildRatingMorphPath({ ratingX10, cx: 8, cy: 8, radius: 4.4 })
    path.setAttribute('d', pointsToPathD(points))
  }
  updateRatingUI()
}

function setMinRating(next: number) {
  const clamped = clampMinRatingX10(next)
  if (clamped === minRatingX10) return
  minRatingX10 = clamped
  updateRatingUI()
  rebuildActiveIndex()
  syncGenerationWorkerIndex()
  enforceMinRating()

  const q = searchInput.value.trim()
  if (q) handleSearch(q)
}

function enforceMinRating() {
  ratingFilterSeq++
  const seq = ratingFilterSeq
  ratingReplaceQueue = [...grid.cells.keys()]

  const [cc, cr] = findCenterCell()
  const centerKey = key(cc, cr)
  const centerIdx = ratingReplaceQueue.indexOf(centerKey)
  if (centerIdx > 0) {
    ratingReplaceQueue.splice(centerIdx, 1)
    ratingReplaceQueue.unshift(centerKey)
  }

  if (ratingReplaceRaf) {
    cancelAnimationFrame(ratingReplaceRaf)
    ratingReplaceRaf = 0
  }

  const runBatch = () => {
    if (seq !== ratingFilterSeq) return

    const now = performance.now()
    const visible = getVisibleRange(vp)
    const targetSize = pickSize(vp.scale, currentDpr)
    let changed = 0
    let processed = 0
    while (processed < FILTER_REPLACE_BATCH && ratingReplaceQueue.length > 0) {
      const cellKey = ratingReplaceQueue.shift()!
      processed++

      const existing = grid.cells.get(cellKey)
      if (!existing || isTmdbAllowed(existing.tmdbId)) continue

      const oldImgs = stash(cellKey)
      evictImages([cellKey])

      const [col, row] = parseKey(cellKey)
      grid.cells.delete(cellKey)
      grid.onScreen.delete(existing.tmdbId)

      const replacement = generateMovie(col, row, grid, activeIndex, allowAll, fillCoherent)
      if (replacement) {
        setCell(grid, col, row, replacement)
        if (
          col >= visible.minCol && col <= visible.maxCol
          && row >= visible.minRow && row <= visible.maxRow
        ) {
          filterSwapFx.set(cellKey, {
            oldCell: existing,
            oldImgs,
            createdAt: now,
            startAt: 0,
            timeoutMs: FILTER_SWAP_TIMEOUT,
          })
          loadPoster(cellKey, replacement.posterPath, targetSize)
        } else {
          filterSwapFx.delete(cellKey)
        }
        changed++
      } else {
        filterSwapFx.delete(cellKey)
      }
    }

    if (changed > 0) {
      activeWave = null
      scheduleRepaint()
      maybePreloadPosters(true)
    }

    if (ratingReplaceQueue.length > 0) {
      ratingReplaceRaf = requestAnimationFrame(runBatch)
    } else {
      ratingReplaceRaf = 0
      scheduleRender()
    }
  }

  ratingReplaceRaf = requestAnimationFrame(runBatch)
}

function rangeSig(buffer: number): string {
  const range = getVisibleRange(vp, buffer)
  return `${range.minCol}:${range.maxCol}:${range.minRow}:${range.maxRow}`
}

function maybeEvictOutside() {
  const sig = rangeSig(EVICT_BUFFER)
  if (sig === lastEvictSig) return
  lastEvictSig = sig
  evictOutside(grid, getVisibleRange(vp, EVICT_BUFFER), (keys) => {
    evictImages(keys)
    for (const k of keys) filterSwapFx.delete(k)
  })
}

function maybePreloadPosters(force = false) {
  const dpr = currentDpr
  const size = pickSize(vp.scale, dpr)
  const sig = `${rangeSig(PRELOAD_BUFFER)}:${size}`
  if (!force && sig === lastPreloadSig) return
  lastPreloadSig = sig
  preloadPosters(vp, grid, currentDpr)
}

function cancelIdleFill() {
  if (idleId) { cIC(idleId); idleId = 0 }
}

function scheduleIdleFill() {
  if (idleId || fillPending) return
  idleId = rIC((deadline) => {
    idleId = 0
    if (gs.active) return
    const range = getVisibleRange(vp, PRELOAD_BUFFER)
    let n = 0
    while (deadline.timeRemaining() > 1 && n < IDLE_FILL_MAX) {
      if (fillRange(grid, range, activeIndex, allowAll, false, 1) === 0) return
      n++
    }
    if (n > 0) {
      scheduleRepaint()
      maybePreloadPosters(true)
    }
    scheduleIdleFill()
  })
}

let repaintScheduled = false
function scheduleRepaint() {
  if (repaintScheduled || renderScheduled) return
  repaintScheduled = true
  requestAnimationFrame(() => {
    repaintScheduled = false
    if (searchMode) alignSearchCellToCenterLine()
    render(ctx, vp, grid, titlesIndex, activeWave, filterSwapFx, currentDpr)
  })
}

setOnLoad(() => scheduleRepaint())

let renderScheduled = false
function scheduleRender(immediate?: boolean) {
  if (immediate) {
    renderScheduled = false
    update()
    return
  }
  if (renderScheduled) return
  renderScheduled = true
  requestAnimationFrame(() => {
    renderScheduled = false
    update()
  })
}

function update() {
  const now = performance.now()
  const metrics = calcMotionDiversityMetrics(gs.velocityX, gs.velocityY, gs.active)
  const speed = metrics.speed
  const isInMotion = gs.active || speed > MOTION_VELOCITY_THRESHOLD
  if (isInMotion) {
    lastMotionTs = now
    cancelIdleFill()
    if (activeWave && speed > 1 && !lpInterval) activeWave = null
  }
  setMotionProfile(isInMotion)
  let targetDpr = currentDpr
  if (isInMotion) targetDpr = motionDpr
  else if (now - lastMotionTs >= RESTORE_DEBOUNCE_MS) targetDpr = idleDpr
  if (maybeApplyDpr(targetDpr)) {
    lastPreloadSig = ''
  }
  if (searchMode) alignSearchCellToCenterLine()

  let n = 0
  if (!fillPending) {
    if (gs.active) {
      queueWorkerFill(getVisibleRange(vp), GESTURE_VISIBLE_FILL, metrics.noiseFactor, metrics.randomChance)
      queueWorkerFill(getVisibleRange(vp, GESTURE_BUFFER), GESTURE_FILL, metrics.noiseFactor, metrics.randomChance)
    } else {
      n = fillRange(grid, getVisibleRange(vp, PRELOAD_BUFFER), activeIndex, allowAll, fillCoherent, FILL_PER_FRAME)
    }
  }

  render(ctx, vp, grid, titlesIndex, activeWave, filterSwapFx, currentDpr)

  if (activeWave) {
    if (isWaveDone(activeWave, performance.now())) {
      activeWave = null
    } else {
      scheduleRender()
    }
  }
  if (hasVisibleSwapFx()) scheduleRender()

  if (n > 0) scheduleRender()
  if (!gs.active) {
    maybeEvictOutside()
    maybePreloadPosters(n > 0)
  }
  scheduleIdleFill()
  debugOverlay?.update(vp, gs, grid, metrics)
}

/** Find cell col,row closest to screen center */
function findCenterCell(): [number, number] {
  const [wx, wy] = screenToWorld(vp, vp.width / 2, vp.height / 2)
  return [Math.round(wx / CELL_W - 0.5), Math.round(wy / CELL_H - 0.5)]
}

function getVisualTop(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  const byTop = vv.offsetTop
  const byBottom = vv.offsetTop + vv.height - vp.height
  // iOS standalone can report a large offsetTop while canvas coords are closer to bottom-derived offset.
  return Math.abs(byBottom) < Math.abs(byTop) ? byBottom : byTop
}

function alignSearchCellToCenterLine() {
  if (!searchMode) return
  const area = computeVisibleCenterArea(24)
  const [, sy] = worldToScreen(vp, searchCell[0] * CELL_W, searchCell[1] * CELL_H)
  const currentScreenCenterY = sy + (CELL_H * vp.scale) / 2 + getVisualTop()
  const delta = area.centerY - currentScreenCenterY
  if (Number.isFinite(delta) && Math.abs(delta) > 0.25) vp.offsetY += delta
}

function focusOn(col: number, row: number, seed?: MovieEntry, delay = 0, center = true) {
  activeWave = null
  filterSwapFx.clear()
  cancelPendingGenerationRequests()
  clearGrid(grid, clearAllImages)
  lastEvictSig = ''
  lastPreloadSig = ''

  const validSeed = seed && isTmdbAllowed(seed.tmdbId) ? seed : undefined
  if (validSeed) {
    setCell(grid, col, row, {
      tmdbId: validSeed.tmdbId,
      posterPath: validSeed.posterPath,
      embedding: validSeed.embedding,
    })
    fillCoherent = true
  } else {
    fillCoherent = false
  }
  if (center) centerOn(vp, col, row)

  if (delay > 0) {
    fillPending = true
    clearTimeout(fillDebounceId)
    fillDebounceId = window.setTimeout(() => {
      fillPending = false
      scheduleRender()
    }, delay)
  }

  scheduleRender()
}

/** Center+fit one card in visible area above search panel */
function centerCardForSearch(col: number, row: number, viewTop: number, viewH: number, animate = true) {
  const panelH = Math.max(60, searchPanel.getBoundingClientRect().height)
  const pad = 24
  const availH = viewH - safeTop - panelH - pad * 2
  const availW = vp.width - pad * 2
  const keyboardOpen = searchMode

  const scaleH = availH / CELL_H
  const scaleW = availW / CELL_W
  const targetScale = Math.min(scaleH, scaleW)
  const targetOffsetX = vp.width / 2 - (col + 0.5) * CELL_W * targetScale
  const worldCenterYScaled = (row + 0.5) * CELL_H * targetScale
  let targetOffsetY = 0

  if (keyboardOpen) {
    const area = computeVisibleCenterArea(pad)
    const desiredScreenCenterY = area.centerY
    targetOffsetY = desiredScreenCenterY - getVisualTop() - worldCenterYScaled
  } else {
    const centerY = viewTop + (viewH - panelH + safeTop) / 2
    targetOffsetY = centerY - worldCenterYScaled
  }

  if (animate) {
    animateViewport(anim, vp, targetOffsetX, targetOffsetY, targetScale, scheduleRender)
  } else {
    vp.offsetX = targetOffsetX
    vp.offsetY = targetOffsetY
    vp.scale = targetScale
    if (keyboardOpen) {
      const desiredScreenCenterY = computeVisibleCenterArea(pad).centerY
      const [, sy] = worldToScreen(vp, col * CELL_W, row * CELL_H)
      const currentScreenCenterY = sy + (CELL_H * vp.scale) / 2 + getVisualTop()
      const correction = desiredScreenCenterY - currentScreenCenterY
      if (Number.isFinite(correction) && Math.abs(correction) > 0.5) {
        vp.offsetY += correction
      }
    }
    scheduleRender()
  }
}

function recenterSearchCardNow() {
  if (!searchMode) return
  const vvp = window.visualViewport
  const viewTop = vvp ? Math.max(0, vvp.offsetTop) : 0
  const viewH = vvp ? Math.max(1, vvp.height) : vp.height
  centerCardForSearch(searchCell[0], searchCell[1], viewTop, viewH, false)
}

function scheduleSearchRecenterBurst() {
  if (!searchMode) return
  clearTimeout(searchRecenterTimer)
  let step = 0
  const tick = () => {
    if (!searchMode) return
    recenterSearchCardNow()
    step++
    if (step >= 10) return
    searchRecenterTimer = window.setTimeout(tick, step < 4 ? 45 : 90)
  }
  tick()
}

/** Enter search mode: animate viewport to center+fit one card above input */
function enterSearchMode() {
  if (searchMode) return
  searchMode = true
  gs.disabled = true
  searchPanel.classList.add('active')

  searchCell = findCenterCell()
  centerCardForSearch(searchCell[0], searchCell[1], 0, vp.height)
  // burst recentering only needed on mobile where virtual keyboard resizes viewport
  if ('ontouchstart' in window) scheduleSearchRecenterBurst()
}

function centerSearchCellOnCanvas() {
  if (!exitRecenterCell) return
  const [col, row] = exitRecenterCell
  const s = vp.scale
  vp.offsetX = vp.width / 2 - (col + 0.5) * CELL_W * s
  vp.offsetY = (safeTop + vp.height) / 2 - (row + 0.5) * CELL_H * s
}

/** Exit search mode */
function exitSearchMode() {
  if (!searchMode) return
  if (isDraggingFilter) return

  searchMode = false
  clearTimeout(searchRecenterTimer)
  searchRecenterTimer = 0
  gs.disabled = false
  fillCoherent = false
  searchPanel.classList.remove('active')
  searchInput.blur()
  searchInput.value = ''
  searchHint.classList.remove('show')

  exitRecenterCell = [searchCell[0], searchCell[1]]
  centerSearchCellOnCanvas()
  setTimeout(() => { exitRecenterCell = null }, 600)
  scheduleRender()
}

/** Handle search input: post query to worker */
function handleSearch(query: string) {
  const normalized = query.trim()
  if (!searchReady || !normalized) return
  if (normalized.startsWith('/')) return
  const yearBounds = titlesIndex
    ? titlesIndex.yearBounds[yearSliderPos]
    : null
  searchWorker.postMessage({ type: 'search', seq: ++searchSeq, query: normalized, minRatingX10, yearBounds })
}

/** Handle worker responses */
function handleWorkerMessage(e: MessageEvent) {
  const { type } = e.data
  if (type === 'ready') {
    searchReady = true
    return
  }
  if (type === 'result') {
    if (e.data.seq !== searchSeq) return // stale
    const tmdbId = e.data.tmdbId as number | null
    if (tmdbId == null) {
      showHint(`No matches for >= ${formatRating(minRatingX10)}`)
      return
    }

    const entry = movieByTmdbId.get(tmdbId)
    if (!entry) return

    if (searchMode) {
      const [col, row] = searchCell
      focusOn(col, row, entry, FILL_DELAY, false)
      const vvp = window.visualViewport
      const viewTop = vvp ? Math.max(0, vvp.offsetTop) : 0
      const viewH = vvp ? Math.max(1, vvp.height) : vp.height
      centerCardForSearch(col, row, viewTop, viewH, false)
      return
    }
    const [col, row] = findCenterCell()
    focusOn(col, row, entry, FILL_DELAY)
  }
}

async function loadEmbeddings(): Promise<EmbeddingsIndex> {
  const remote = 'https://raw.githubusercontent.com/0xBADC0FFEE/vibefind/data-latest/data/embeddings.bin'
  const local = `${import.meta.env.BASE_URL}data/embeddings.bin`
  const source = import.meta.env.DEV ? local : remote

  try {
    const resp = await fetch(source)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buffer = await resp.arrayBuffer()
    return parseEmbeddings(buffer)
  } catch {
    const from = import.meta.env.DEV ? 'local dev data/*.bin' : 'production remote data-latest'
    console.error(`Failed to load embeddings from ${from}`)
    console.warn('No embeddings.bin found, using mock data')
    return generateMockIndex(5000)
  }
}

async function initTitlesFromBuffer(buffer: ArrayBuffer): Promise<boolean> {
  // Parse in main thread (keeps imdbNums/ratings accessible)
  const { parseTitles } = await import('./engine/titles.ts')
  titlesIndex = parseTitles(buffer)

  // Transfer a copy to the worker (original backing data stays with main thread)
  const workerBuffer = buffer.slice(0)
  return new Promise<boolean>((resolve) => {
    searchWorker.onmessage = (e) => {
      if (e.data.type === 'ready') {
        searchReady = true
        searchWorker.onmessage = handleWorkerMessage
        resolve(true)
      }
    }
    searchWorker.postMessage({ type: 'init', buffer: workerBuffer }, [workerBuffer])
  })
}

async function loadTitles(): Promise<boolean> {
  const remote = 'https://raw.githubusercontent.com/0xBADC0FFEE/vibefind/data-latest/data/metadata.bin'
  const local = `${import.meta.env.BASE_URL}data/metadata.bin`
  const source = import.meta.env.DEV ? local : remote

  try {
    const resp = await fetch(source)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buffer = await resp.arrayBuffer()
    return initTitlesFromBuffer(buffer)
  } catch {
    const from = import.meta.env.DEV ? 'local dev data/*.bin' : 'production remote data-latest'
    console.error(`Failed to load metadata from ${from}`)
    console.warn('No metadata.bin found, search disabled')
    return false
  }
}

function setupSearch() {
  searchInput.addEventListener('focus', () => {
    enterSearchMode()
    if ('ontouchstart' in window) scheduleSearchRecenterBurst()
  })

  searchInput.addEventListener('blur', () => {
    exitSearchMode()
  })

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      exitSearchMode()
      return
    }
    if (e.key === 'Enter') {
      const query = searchInput.value.trim()
      if (!query) {
        exitSearchMode()
        return
      }
      if (query.startsWith('/')) {
        if (!handleSlashCommand(query)) showHint('Unknown command')
        searchSeq++
        exitSearchMode()
        return
      }
      handleSearch(query)
      exitSearchMode()
    }
  })

  searchInput.addEventListener('input', () => {
    if (searchMode && 'ontouchstart' in window) scheduleSearchRecenterBurst()
    clearTimeout(searchDebounceId)
    searchHint.classList.remove('show')
    searchDebounceId = window.setTimeout(() => {
      const query = searchInput.value.trim()
      if (query.startsWith('/')) {
        searchSeq++
        return
      }
      handleSearch(searchInput.value)
    }, SEARCH_DEBOUNCE)
  })
}

function setupRatingFilter() {
  let pointerId = -1
  let dragging = false
  let prevGsDisabled = false

  function ratingFromClientX(clientX: number): number {
    const rect = ratingStrip.getBoundingClientRect()
    if (rect.width <= 0) return minRatingX10
    const left = rect.left
    const right = rect.right
    const x = Math.max(left, Math.min(right, clientX))
    const t = (x - left) / Math.max(1, right - left)
    return RATING_MIN_X10 + t * (RATING_MAX_X10 - RATING_MIN_X10)
  }

  ratingStrip.addEventListener('contextmenu', (e) => e.preventDefault())

  searchPanel.addEventListener('pointerdown', (e) => {
    const target = e.target as Element | null
    if (!target?.closest('#rating-filter')) return
    if (e.button !== 0 || pointerId !== -1) return
    e.preventDefault()
    const star = target.closest<HTMLButtonElement>('.rating-star')
    const ratingX10 = Number(star?.dataset.ratingX10)
    pointerId = e.pointerId
    dragging = true
    isDraggingFilter = true
    searchPanel.classList.add('dragging')
    searchInput.readOnly = true
    searchInput.blur()
    prevGsDisabled = gs.disabled
    gs.disabled = true
    if (star && Number.isFinite(ratingX10)) setMinRating(ratingX10)
    else setMinRating(ratingFromClientX(e.clientX))
    searchPanel.setPointerCapture(pointerId)
  })

  searchPanel.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId || !dragging) return
    e.preventDefault()
    setMinRating(ratingFromClientX(e.clientX))
  })

  function finishDrag(e: PointerEvent) {
    if (e.pointerId !== pointerId) return
    if (searchPanel.hasPointerCapture(pointerId)) searchPanel.releasePointerCapture(pointerId)
    pointerId = -1
    if (!dragging) return

    dragging = false
    isDraggingFilter = false
    searchPanel.classList.remove('dragging')
    searchInput.readOnly = false
    gs.disabled = prevGsDisabled
  }

  searchPanel.addEventListener('pointerup', finishDrag)
  searchPanel.addEventListener('pointercancel', finishDrag)
}

function setYearSliderPos(pos: number) {
  if (pos === yearSliderPos) return
  yearSliderPos = pos
  yearSlider.value = String(pos)
  updateFilterToggleIcon()
  rebuildActiveIndex()
  syncGenerationWorkerIndex()
  enforceMinRating()
  const q = searchInput.value.trim()
  if (q) handleSearch(q)
}

function setupYearFilter() {
  yearSlider.addEventListener('input', () => {
    setYearSliderPos(Number(yearSlider.value))
  })
}

function setupFilterToggle() {
  filterToggle.addEventListener('pointerdown', (e) => {
    e.preventDefault() // prevent blurring search input
  })
  filterToggle.addEventListener('click', () => {
    filtersVisible = !filtersVisible
    filterRows.classList.toggle('open', filtersVisible)
  })
}

function getImdbLinkAtScreen(sx: number, sy: number): string | null {
  if (!titlesIndex) return null
  const [wx, wy] = screenToWorld(vp, sx, sy)
  const col = Math.floor(wx / CELL_W)
  const row = Math.floor(wy / CELL_H)
  const cell = grid.cells.get(`${col}:${row}`)
  if (!cell) return null
  const idx = titlesIndex.idToIdx.get(cell.tmdbId)
  if (idx === undefined) return null
  const imdbNum = titlesIndex.imdbNums[idx]
  if (!imdbNum) return null
  return `https://www.imdb.com/title/tt${String(imdbNum).padStart(7, '0')}/`
}

function openMovieLink(sx: number, sy: number, tap?: TapIntent) {
  if (suppressNextTap) { suppressNextTap = false; return }
  if (searchMode) return
  const url = getImdbLinkAtScreen(sx, sy)
  if (!url) return

  if (isBackgroundOpen(tap)) {
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    win?.blur()
    window.focus()
    return
  }
  window.open(url, '_blank')
}

function handleLongPress(col: number, row: number) {
  if (searchMode) return
  const cell = grid.cells.get(`${col}:${row}`)
  if (!cell) return
  suppressNextTap = true

  // Stash ALL old cells + images before clearing
  const old = new Map<string, OldCellData>()
  for (const [cellKey, c] of grid.cells) {
    old.set(cellKey, { cell: c, imgs: stash(cellKey) })
  }

  const seedKey = `${col}:${row}`
  const savedImgs = old.get(seedKey)?.imgs
  const seedCell = isTmdbAllowed(cell.tmdbId)
    ? cell
    : generateMovie(col, row, grid, activeIndex, allowAll, true)

  // Clear and regenerate
  filterSwapFx.clear()
  cancelPendingGenerationRequests()
  clearGrid(grid, clearAllImages)
  lastEvictSig = ''
  lastPreloadSig = ''
  if (seedCell) {
    setCell(grid, col, row, {
      tmdbId: seedCell.tmdbId,
      posterPath: seedCell.posterPath,
      embedding: seedCell.embedding,
    })
    if (savedImgs && seedCell.tmdbId === cell.tmdbId) restore(seedKey, savedImgs)
  }
  fillCoherent = true
  fillPending = false
  clearTimeout(fillDebounceId)

  // Fill entire visible range NOW (no budget limit)
  fillRange(grid, getVisibleRange(vp, PRELOAD_BUFFER), activeIndex, allowAll, true)

  // Start seismic wave animation
  const range = getVisibleRange(vp)
  const maxRing = Math.max(
    col - range.minCol, range.maxCol - col,
    row - range.minRow, range.maxRow - row,
  )
  activeWave = startWave(col, row, maxRing, old)

  scheduleRender()
}

async function init() {
  safeTop = getSafeAreaTop()
  generationWorker.onmessage = handleGenerationWorkerMessage
  initRatingStripIcons()
  refreshDprTargets()
  currentDpr = idleDpr
  setMotionProfile(false)
  resize()
  applyTrackpadPanEnabled(loadTrackpadPanPreference())
  window.addEventListener('resize', () => {
    safeTop = getSafeAreaTop()
    refreshDprTargets()
    const speed = Math.hypot(gs.velocityX, gs.velocityY)
    const isInMotion = gs.active || speed > MOTION_VELOCITY_THRESHOLD
    currentDpr = isInMotion ? motionDpr : idleDpr
    setMotionProfile(isInMotion)
    resize()
    lastEvictSig = ''
    lastPreloadSig = ''
    scheduleRender()
  })
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onVisualViewportChange)
    window.visualViewport.addEventListener('scroll', onVisualViewportChange)
  }
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      unstickLoader()
      lastEvictSig = ''
      lastPreloadSig = ''
      scheduleRender()
    }
  })

  index = await loadEmbeddings()
  movieByTmdbId = new Map(index.movies.map((m) => [m.tmdbId, m]))
  activeIndex = index
  const titlesLoaded = await loadTitles()

  if (!titlesLoaded) {
    searchPanel.style.display = 'none'
  } else {
    updateRatingUI()
  }
  rebuildActiveIndex()
  syncGenerationWorkerIndex()

  focusOn(0, 0)
  setupGestures(canvas, vp, gs, scheduleRender, openMovieLink)

  // Long-press (500ms) -> refresh grid around pressed card
  lpTimer = 0
  lpInterval = 0
  let lpStartX = 0
  let lpStartY = 0

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clearTimeout(lpTimer); lpTimer = 0; clearInterval(lpInterval); lpInterval = 0; return }
    const t = e.touches[0]
    lpStartX = t.clientX
    lpStartY = t.clientY
    lpTimer = window.setTimeout(() => {
      lpTimer = 0
      gs.panning = false; gs.velocityX = gs.velocityY = 0; cancelAnimationFrame(gs.animId)
      const [wx, wy] = screenToWorld(vp, lpStartX, lpStartY)
      const c = Math.floor(wx / CELL_W), r = Math.floor(wy / CELL_H)
      handleLongPress(c, r)
      lpInterval = window.setInterval(() => handleLongPress(c, r), 3000)
      gs.panning = true
    }, 1000)
  }, { passive: true })

  canvas.addEventListener('touchmove', (e) => {
    if (!lpTimer && !lpInterval) return
    const t = e.touches[0]
    const dx = t.clientX - lpStartX
    const dy = t.clientY - lpStartY
    if (lpTimer && dx * dx + dy * dy > 100) { clearTimeout(lpTimer); lpTimer = 0 }
  }, { passive: true })

  canvas.addEventListener('touchend', () => { clearTimeout(lpTimer); lpTimer = 0; clearInterval(lpInterval); lpInterval = 0 })

  canvas.addEventListener('mousedown', (e) => {
    lpStartX = e.clientX
    lpStartY = e.clientY
    lpTimer = window.setTimeout(() => {
      lpTimer = 0
      gs.panning = false; gs.velocityX = gs.velocityY = 0; cancelAnimationFrame(gs.animId)
      const [wx, wy] = screenToWorld(vp, lpStartX, lpStartY)
      const c = Math.floor(wx / CELL_W), r = Math.floor(wy / CELL_H)
      handleLongPress(c, r)
      lpInterval = window.setInterval(() => handleLongPress(c, r), 3000)
    }, 1000)
  })

  canvas.addEventListener('mousemove', (e) => {
    if (!lpTimer && !lpInterval) return
    const dx = e.clientX - lpStartX
    const dy = e.clientY - lpStartY
    if (lpTimer && dx * dx + dy * dy > 100) { clearTimeout(lpTimer); lpTimer = 0 }
  })

  canvas.addEventListener('mouseup', () => { clearTimeout(lpTimer); lpTimer = 0; clearInterval(lpInterval); lpInterval = 0 })

  // Prevent OS/browser context menu so right-button dbl click can toggle minimap
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  // Desktop: right-button double click toggles debug overlay
  let lastRightClickTime = 0
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return
    const now = performance.now()
    if (now - lastRightClickTime < 400) {
      if (!debugOverlay) {
        debugOverlay = createDebugOverlay()
      } else {
        debugOverlay.toggle()
      }
      scheduleRender()
      lastRightClickTime = 0
    } else {
      lastRightClickTime = now
    }
  })

  // 2-finger double-tap toggles debug overlay
  let lastDblTouchTime = 0
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return
    const now = performance.now()
    if (now - lastDblTouchTime < 400) {
      if (!debugOverlay) {
        debugOverlay = createDebugOverlay()
      } else {
        debugOverlay.toggle()
      }
      scheduleRender()
      lastDblTouchTime = 0
    } else {
      lastDblTouchTime = now
    }
  })

  setupSearch()
  setupRatingFilter()
  setupYearFilter()
  setupFilterToggle()
  scheduleRender()
}

init()
