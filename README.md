# Vibefind
*Catch the feeling, skip the search.*

Infinite 2D canvas of movie posters. Swipe in any direction — see similar movies appear. The more you explore, the more the canvas adapts to your taste. Random movies are mixed in to keep things fresh.

## How it works

~80k movies are represented as 16-dimensional vectors (UMAP-reduced from 768-dim text embeddings). When you scroll to the edge:

1. Visible neighbors' embeddings are averaged (weighted by distance), then a gradient is extrapolated along the scroll direction to continue genre trends
2. Noise is added for variety
3. Brute-force search finds the closest match (~1ms)
4. 5% of tiles are fully random to prevent similarity bubbles
5. If min-rating filter is set, generation runs on a prefiltered movie pool (`IMDb rating >= threshold`)

All computation runs client-side. No backend needed.

## Rating overlay

Each poster has a shape in the bottom-right corner that morphs from dot to star based on IMDb rating:

```
 · →  ●  →  ◆  →  ✦  →  ★
5.0  6.0   6.5   7.5   8.0+
```

Formula: `t = clamp((rating − 5) / 3, 0, 1)`. Rendered with `difference` blend mode (α 0.4). No rating → faint dot (α 0.08).

## Rating filter

Search panel has a minimum IMDb-rating slider (5.0–8.0). It does two things:

1. Rebuilds active movie pool before generation (`activeIndex`), so similarity picks only from allowed movies
2. Replaces already visible tiles that violate threshold

Similarity algorithm itself stays same (neighbor blend + gradient + noise + top-K pick).

## Language filter

Six toggle buttons filter the movie pool by language group:

| 🇺🇸 English | 🇮🇳 Indian | 🇪🇺 European | 🇯🇵 Japanese | 🇰🇷 Korean | 🌍 Other |

All on by default. Tap to toggle off/on. Disabled groups are excluded from generation and visible tiles are replaced. Works alongside rating and year filters.

## Year filter

Bidirectional slider with 11 positions (🦣 oldest → 📱 newest). Center = all films (default). Left side limits to older films (≤1930 at max), right side limits to newer films (≥last full year at max). Bounds are dynamic from current year.

Type to search — fuzzy title matching runs in a Web Worker (`metadata.bin`, ~0.5 MB). Include a 4-digit year (e.g. "matrix 1999") for exact year match. Tap a poster to open its IMDB page. Center poster swaps instantly, neighbors regenerate after a short delay.

## Quick start (mock data)

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173` with colored placeholder tiles (no real posters). Pan, zoom, and scroll work — you can verify the infinite canvas behavior immediately.

## Full setup (real movie data)

### 1. Generate embeddings

```bash
# Install Ollama (https://ollama.com) and pull the embedding model
ollama pull nomic-embed-text-v2-moe

# Set up Python env
python -m venv .venv
source .venv/bin/activate
pip install kagglehub pandas numpy umap-learn requests sentence-transformers

# Requires Kaggle API key in ~/.kaggle/kaggle.json
python scripts/pipeline.py
```

This downloads ~1M movies from Kaggle ([alanvourch/tmdb-movies-daily-updates](https://www.kaggle.com/datasets/alanvourch/tmdb-movies-daily-updates)), filters to ~80k, generates 768-dim embeddings via Ollama, runs UMAP to 16-dim, and outputs `public/data/embeddings.bin` (~4 MB) and `public/data/metadata.bin` (~0.5 MB).

First run takes a while (embedding generation + UMAP). Subsequent runs are fast — embeddings are cached in `scripts/embedding_cache.npz`.

### 2. Run the app

```bash
npm run dev
```

In dev mode, binaries are loaded locally from `public/data` via `/data/embeddings.bin` and `/data/metadata.bin`.

Posters load from TMDB CDN. The canvas is infinite in all directions.

## Build

```bash
npm run build
npm run preview
```

Output goes to `dist/`.

Pushing to `main` auto-deploys to GitHub Pages via Actions. Live at **https://0xBADC0FFEE.github.io/vibefind/**

Movie binary source depends on mode:

- Dev (`npm run dev`): local `/data/embeddings.bin` and `/data/metadata.bin` from `public/data`.
- Production/preview (`npm run build && npm run preview`): remote `data-latest` raw URLs:
  - `https://raw.githubusercontent.com/0xBADC0FFEE/vibefind/data-latest/data/embeddings.bin`
  - `https://raw.githubusercontent.com/0xBADC0FFEE/vibefind/data-latest/data/metadata.bin`

Weekly workflow `.github/workflows/weekly-data-release.yml` refreshes the `data-latest` binaries.

Installable as a PWA (offline-capable after first load).

## Project structure

```
src/
  main.ts                — entry point, wiring
  canvas/
    viewport.ts          — coordinate math, cell ranges, dynamic zoom limits
    gestures.ts          — pan/pinch/zoom with inertia + tap detection
    renderer.ts          — Canvas 2D render loop, culling
    animation.ts         — viewport lerp for search transitions
    poster-loader.ts     — image cache keyed by grid cell, adaptive LOD
  engine/
    grid.ts              — cell storage, expansion, eviction
    generator.ts         — similarity + random algorithm
    embeddings.ts        — .bin parser, brute-force search
    search.worker.ts     — fuzzy title search (Web Worker)
    titles.ts            — metadata.bin parser (titles, IMDB IDs, ratings, years)
  debug/
    overlay.ts             — FPS/viewport/grid debug HUD (2-finger double-tap)
scripts/
  pipeline.py            — Kaggle → embeddings (Ollama or sentence-transformers) → UMAP → quantize → .bin
```

## Debug mode

Activate: double right-click on canvas (desktop), or 2-finger double-tap on touchscreen.

Shows a minimap overlay (top-left corner) where each cell is colored by its embedding — similar movies share similar hues. A cyan rectangle marks the current viewport. Useful for visualizing how the similarity algorithm fills the grid.

## Tech

- Vanilla TypeScript, Vite, PWA (vite-plugin-pwa + Workbox)
- HTML5 Canvas 2D (no WebGL, no framework)
- Dynamic zoom limit — max ~78 visible posters to prevent rendering lag
- Posters from TMDB CDN (`image.tmdb.org`)
- Movie dataset: [alanvourch/tmdb-movies-daily-updates](https://www.kaggle.com/datasets/alanvourch/tmdb-movies-daily-updates) (updated daily)
- Embeddings: generated locally via [Ollama](https://ollama.com) + `nomic-embed-text-v2-moe`

## License

[MIT](LICENSE)
