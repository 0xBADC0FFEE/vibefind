export const LANG_GROUP_EN = 0
export const LANG_GROUP_IN = 1
export const LANG_GROUP_FR = 2
export const LANG_GROUP_JA = 3
export const LANG_GROUP_OTHER = 4
export const LANG_GROUP_COUNT = 5

export const INDIAN_LANGS = new Set(['hi', 'te', 'ta', 'ml', 'kn', 'bn', 'mr', 'pa'])

export function langToGroup(code: string): number {
  if (code === 'en') return LANG_GROUP_EN
  if (INDIAN_LANGS.has(code)) return LANG_GROUP_IN
  if (code === 'fr') return LANG_GROUP_FR
  if (code === 'ja') return LANG_GROUP_JA
  return LANG_GROUP_OTHER
}

export interface TitlesIndex {
  titles: string[]
  tmdbIds: Uint32Array
  imdbNums: Uint32Array
  ratings: Uint8Array  // IMDb rating × 10
  langGroups: Uint8Array  // group IDs 0-4
  idToIdx: Map<number, number>  // tmdbId → index in titles/tmdbIds
}

export function parseTitles(buffer: ArrayBuffer): TitlesIndex {
  const view = new DataView(buffer)
  const count = view.getUint32(0, true)
  const titles: string[] = []
  const ids: number[] = []
  const imdbNumsArr: number[] = []
  const ratingsArr: number[] = []
  const langGroupsArr: number[] = []
  const idToIdx = new Map<number, number>()
  let offset = 4

  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    const tmdbId = view.getUint32(offset, true)
    offset += 4

    const imdbNum = view.getUint32(offset, true)
    offset += 4

    const rating = view.getUint8(offset)
    offset += 1

    // 2-byte lang code
    const langB0 = view.getUint8(offset)
    const langB1 = view.getUint8(offset + 1)
    offset += 2
    let langCode = ''
    if (langB0) langCode += String.fromCharCode(langB0)
    if (langB1) langCode += String.fromCharCode(langB1)
    langGroupsArr.push(langToGroup(langCode))

    const titleLen = view.getUint8(offset)
    offset += 1

    const titleBytes = new Uint8Array(buffer, offset, titleLen)
    titles.push(decoder.decode(titleBytes))
    offset += titleLen

    ids.push(tmdbId)
    imdbNumsArr.push(imdbNum)
    ratingsArr.push(rating)
    idToIdx.set(tmdbId, i)
  }

  return {
    titles,
    tmdbIds: new Uint32Array(ids),
    imdbNums: new Uint32Array(imdbNumsArr),
    ratings: new Uint8Array(ratingsArr),
    langGroups: new Uint8Array(langGroupsArr),
    idToIdx,
  }
}

/** Find best match: word-level substring first, then word-level fuzzy. Returns tmdbId or null. */
export function searchBest(idx: TitlesIndex, query: string, minRatingX10 = 50, langEnabled?: Uint8Array): number | null {
  if (!query) return null
  const qWords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!qWords.length) return null

  // Phase 1: word-level substring — all query words must appear as substrings of title
  let bestSub: { i: number; len: number } | null = null
  for (let i = 0; i < idx.titles.length; i++) {
    if (idx.ratings[i] < minRatingX10) continue
    if (langEnabled && !langEnabled[idx.langGroups[i]]) continue
    const t = idx.titles[i].toLowerCase()
    let allMatch = true
    for (const w of qWords) {
      if (!t.includes(w)) { allMatch = false; break }
    }
    if (allMatch && (!bestSub || t.length < bestSub.len)) {
      bestSub = { i, len: t.length }
    }
  }
  if (bestSub) return idx.tmdbIds[bestSub.i]

  // Phase 2: word-level fuzzy — for each query word, find best title word by prefix distance
  let bestScore = Infinity
  let bestLen = Infinity
  let bestIdx = -1
  for (let i = 0; i < idx.titles.length; i++) {
    if (idx.ratings[i] < minRatingX10) continue
    if (langEnabled && !langEnabled[idx.langGroups[i]]) continue
    const tWords = idx.titles[i].toLowerCase().split(/\s+/)
    let score = 0
    for (const qw of qWords) {
      let minD = Infinity
      for (const tw of tWords) {
        minD = Math.min(minD, prefixDist(qw, tw))
        if (minD === 0) break
      }
      score += minD
    }
    const len = idx.titles[i].length
    if (score < bestScore || (score === bestScore && len < bestLen)) {
      bestScore = score
      bestLen = len
      bestIdx = i
    }
  }
  return bestIdx >= 0 ? idx.tmdbIds[bestIdx] : null
}

/** Prefix edit distance: min cost to transform `a` into any prefix of `b`. */
function prefixDist(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp = new Uint16Array((m + 1) * (n + 1))

  for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i
  // Row 0 stays 0: matching empty prefix of `a` against any prefix of `b` costs 0
  // (already zeroed by Uint16Array)

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i * (n + 1) + j] = Math.min(
        dp[(i - 1) * (n + 1) + j] + 1,
        dp[i * (n + 1) + (j - 1)] + 1,
        dp[(i - 1) * (n + 1) + (j - 1)] + cost,
      )
    }
  }
  // Min across last row = best prefix match
  let min = dp[m * (n + 1)]
  for (let j = 1; j <= n; j++) {
    min = Math.min(min, dp[m * (n + 1) + j])
  }
  return min
}
