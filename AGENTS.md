# vibefind

Semantic movie explorer: 2D canvas of UMAP-projected embeddings, vibe-based search.
Vanilla TypeScript + Vite 7 PWA. Python data pipeline (Kaggle TMDB → embeddings → binary).

## Commands

```bash
npm run dev          # vite dev server (--host)
npm run build        # tsc && vite build
npm test             # node --test --experimental-strip-types src/**/*.test.ts

# Python pipeline (requires .venv)
python -m venv .venv && source .venv/bin/activate
python scripts/pipeline.py          # full pipeline
python scripts/pipeline.py --skip-download  # reuse cached dataset
```

## Project Structure

```
src/
  main.ts              # entry point
  canvas/              # WebGL renderer, gestures, viewport, wave animation
  engine/              # embeddings, UMAP grid, search worker, title index
  ui/                  # search commands, rating morph, link intents
  debug/               # debug overlay
scripts/
  pipeline.py          # Kaggle TMDB → embeddings → public/data/*.bin
public/data/
  embeddings.bin       # UMAP coordinates (binary)
  metadata.bin         # title metadata (binary)
```

## Conventions

- Vanilla TS, no framework — `strict: true`
- Node native test runner, co-located `*.test.ts` files
- No linter/formatter beyond `tsc --noEmit`
- Commits: conventional-commits, concise subject + body with intent

## Boundaries

**Always:**
- Install deps locally (`npm install`, never global)
- Python work → activate `.venv` first
- Dataset analysis → use Python with `kagglehub` local cache (`~/.cache/kagglehub/`)

**Never:**
- Run `npm run dev` — assume dev server is already running
- Global installs
- Modify `.bin` files in `public/data/` by hand
- Push to `data-latest` branch manually
