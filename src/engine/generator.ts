import type { EmbeddingsIndex, MovieEntry } from './embeddings.ts'
import { EMBED_DIM, findTopK } from './embeddings.ts'
import type { Grid, MovieCell } from './grid.ts'

const NOISE_FACTOR = 0.08
const RANDOM_CHANCE = 0.05
const NEIGHBOR_RADIUS = 3
export const TOP_K = 10
const MOMENTUM = 0.5

export const lastGenStats = { neighborCount: 0, noise: 0, diversityMode: false }

interface NeighborSample {
  cell: MovieCell
  weight: number
  dc: number
  dr: number
}

export interface GenerationTarget {
  target: Float32Array
  neighborCount: number
  noise: number
  diversityMode: boolean
}

function collectNeighbors(col: number, row: number, grid: Grid): NeighborSample[] {
  const neighbors: NeighborSample[] = []
  for (let dr = -NEIGHBOR_RADIUS; dr <= NEIGHBOR_RADIUS; dr++) {
    for (let dc = -NEIGHBOR_RADIUS; dc <= NEIGHBOR_RADIUS; dc++) {
      if (dc === 0 && dr === 0) continue
      const cell = grid.cells.get(`${col + dc}:${row + dr}`)
      if (!cell) continue
      const d = Math.sqrt(dc * dc + dr * dr)
      neighbors.push({ cell, weight: 1 / d, dc, dr })
    }
  }
  return neighbors
}

export function buildGenerationTarget(
  col: number,
  row: number,
  grid: Grid,
  coherent = false,
  noiseFactor?: number,
  randomChance?: number,
): GenerationTarget | null {
  const neighbors = collectNeighbors(col, row, grid)
  if (neighbors.length === 0) {
    lastGenStats.neighborCount = 0
    lastGenStats.noise = 0
    lastGenStats.diversityMode = false
    return null
  }

  // Diversity injection: use neighbor blend with high noise instead of pure random
  const diversityMode = !coherent && Math.random() < (randomChance ?? RANDOM_CHANCE)
  // diversityMode: don't bail — fall through to build target with 4x noise

  // Weighted average embedding
  const target = new Float32Array(EMBED_DIM)
  let totalW = 0
  for (const { cell, weight } of neighbors) {
    for (let j = 0; j < EMBED_DIM; j++) {
      target[j] += cell.embedding[j] * weight
    }
    totalW += weight
  }
  for (let j = 0; j < EMBED_DIM; j++) {
    target[j] /= totalW
  }

  // Gradient extrapolation — continue genre trends along scroll direction
  let centDc = 0, centDr = 0
  for (const { weight, dc, dr } of neighbors) {
    centDc += dc * weight
    centDr += dr * weight
  }
  centDc /= totalW
  centDr /= totalW

  let dirDc = -centDc, dirDr = -centDr
  const dirLen = Math.sqrt(dirDc * dirDc + dirDr * dirDr)
  if (dirLen > 0.01) {
    dirDc /= dirLen
    dirDr /= dirLen

    let varC = 0, varR = 0
    for (const { weight, dc, dr } of neighbors) {
      varC += weight * (dc - centDc) ** 2
      varR += weight * (dr - centDr) ** 2
    }

    for (let j = 0; j < EMBED_DIM; j++) {
      let gC = 0, gR = 0
      for (const { cell, weight, dc, dr } of neighbors) {
        const delta = cell.embedding[j] - target[j]
        gC += weight * (dc - centDc) * delta
        gR += weight * (dr - centDr) * delta
      }
      if (varC > 0) gC /= varC
      if (varR > 0) gR /= varR
      target[j] += (gC * dirDc + gR * dirDr) * MOMENTUM
    }

    for (let j = 0; j < EMBED_DIM; j++) {
      target[j] = Math.max(0, Math.min(255, target[j]))
    }
  }

  // Add noise (reduced in coherent mode, amplified in diversity mode)
  const baseNoise = noiseFactor ?? NOISE_FACTOR
  const noise = coherent ? 0.15 : diversityMode ? baseNoise * 3 : baseNoise
  lastGenStats.neighborCount = neighbors.length
  lastGenStats.noise = noise
  lastGenStats.diversityMode = diversityMode
  for (let j = 0; j < EMBED_DIM; j++) {
    target[j] += (Math.random() - 0.5) * 255 * noise
    target[j] = Math.max(0, Math.min(255, target[j]))
  }

  return {
    target,
    neighborCount: neighbors.length,
    noise,
    diversityMode,
  }
}

export function generateMovie(
  col: number,
  row: number,
  grid: Grid,
  index: EmbeddingsIndex,
  isAllowed: (tmdbId: number) => boolean,
  coherent = false,
  noiseFactor?: number,
  randomChance?: number,
): MovieCell | null {
  const generationTarget = buildGenerationTarget(col, row, grid, coherent, noiseFactor, randomChance)

  // No neighbors — pick random
  if (!generationTarget) {
    return pickRandom(index, grid.onScreen, isAllowed)
  }

  const k = generationTarget.diversityMode ? TOP_K * 5 : TOP_K
  const candidates = findTopK(index, generationTarget.target, k, grid.onScreen, isAllowed)
  if (candidates.length === 0) return null

  // Weighted random pick: favor closer matches
  return movieEntryToCell(weightedPick(candidates))
}

function pickRandom(
  index: EmbeddingsIndex,
  exclude: Set<number>,
  isAllowed: (tmdbId: number) => boolean,
): MovieCell | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const entry = index.movies[Math.floor(Math.random() * index.movies.length)]
    if (!exclude.has(entry.tmdbId) && isAllowed(entry.tmdbId)) return movieEntryToCell(entry)
  }

  for (let i = 0; i < index.movies.length; i++) {
    const entry = index.movies[i]
    if (!exclude.has(entry.tmdbId) && isAllowed(entry.tmdbId)) return movieEntryToCell(entry)
  }
  return null
}

function weightedPick(candidates: MovieEntry[]): MovieEntry {
  // Linear rank weighting: favors closer matches but allows diversity
  const weights = candidates.map((_, i) => candidates.length - i)
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i]
    if (r <= 0) return candidates[i]
  }
  return candidates[0]
}

function movieEntryToCell(entry: MovieEntry): MovieCell {
  return {
    tmdbId: entry.tmdbId,
    posterPath: entry.posterPath,
    embedding: entry.embedding,
  }
}
