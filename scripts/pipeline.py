"""
Data pipeline: Kaggle TMDB dataset -> embeddings -> UMAP -> binary output.

Outputs:
  public/data/embeddings.bin
  public/data/metadata.bin
"""

import argparse
import datetime as dt
import hashlib
import struct
import sys
from pathlib import Path

import numpy as np
import requests

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "nomic-embed-text-v2-moe"
BATCH_SIZE = 64
CACHE_PATH = Path(__file__).parent / "embedding_cache.npz"


def parse_args():
    parser = argparse.ArgumentParser(description="Build Vibefind data binaries")
    parser.add_argument("--ci", action="store_true", help="Fail fast, less noisy output")
    parser.add_argument(
        "--embed-backend",
        choices=["ollama", "sentence-transformers"],
        default="ollama",
        help="Embedding backend",
    )
    parser.add_argument(
        "--sentence-model",
        default="sentence-transformers/all-MiniLM-L6-v2",
        help="SentenceTransformer model when --embed-backend sentence-transformers",
    )
    parser.add_argument(
        "--only",
        choices=["embeddings", "metadata"],
        default=None,
        help="Build only embeddings.bin or metadata.bin (default: both)",
    )
    parser.add_argument("--cache-prune", action="store_true", help="Remove stale cache ids")
    parser.add_argument("--force-full-recompute", action="store_true", help="Ignore cached embeddings")
    parser.add_argument(
        "--full-recompute-every-weeks",
        type=int,
        default=0,
        help="Force full recompute every N ISO weeks (0 disables)",
    )
    return parser.parse_args()


def should_force_full_recompute(every_weeks: int) -> bool:
    if every_weeks <= 0:
        return False
    iso_week = dt.datetime.now(dt.timezone.utc).isocalendar().week
    return iso_week % every_weeks == 0


def compute_cache_scope(args) -> str:
    if args.embed_backend == "ollama":
        return f"ollama:{OLLAMA_MODEL}"
    return f"sentence-transformers:{args.sentence_model}"


def hash_text(text: str, cache_scope: str) -> str:
    # Scope in hash prevents accidental reuse across backend/model changes.
    return hashlib.sha256(f"{cache_scope}\n{text}".encode("utf-8")).hexdigest()


def check_ollama():
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        r.raise_for_status()
    except (requests.ConnectionError, requests.Timeout):
        print("ERROR: Ollama not running. Start with: ollama serve")
        sys.exit(1)

    models = [m["name"] for m in r.json().get("models", [])]
    if not any(OLLAMA_MODEL in m for m in models):
        print(f"ERROR: Model '{OLLAMA_MODEL}' not found. Pull with: ollama pull {OLLAMA_MODEL}")
        sys.exit(1)

    print(f"Ollama OK - model '{OLLAMA_MODEL}' available")


def load_dataset():
    import kagglehub
    import pandas as pd

    print("Downloading dataset from Kaggle...")
    path = kagglehub.dataset_download("alanvourch/tmdb-movies-daily-updates")
    csv_files = list(Path(path).glob("*.csv"))
    if not csv_files:
        print(f"ERROR: No CSV files found in {path}")
        sys.exit(1)

    csv_path = csv_files[0]
    print(f"Reading {csv_path.name}...")
    df = pd.read_csv(csv_path, low_memory=False)
    print(f"Loaded {len(df)} movies")
    return df


def filter_movies(df, cache_scope: str):
    print("Filtering movies...")
    filtered = []
    for _, row in df.iterrows():
        poster = row.get("poster_path")
        if not isinstance(poster, str) or not poster:
            continue

        imdb_rating_raw = row.get("imdb_rating", 0)
        imdb_votes_raw = row.get("imdb_votes", 0)
        if isinstance(imdb_votes_raw, str):
            imdb_votes_raw = imdb_votes_raw.replace(",", "").replace(" ", "")
        try:
            imdb_votes = float(imdb_votes_raw or 0)
            imdb_rating = float(imdb_rating_raw or 0)
        except (ValueError, TypeError):
            continue

        if not np.isfinite(imdb_votes) or not np.isfinite(imdb_rating):
            continue

        if imdb_votes <= 1000 or imdb_rating < 5.0:
            continue

        title = str(row.get("title") or row.get("original_title") or "").strip()
        if not title:
            continue

        tagline = str(row.get("tagline") or "").strip()
        overview = str(row.get("overview") or "").strip()
        tto = row.get("title_tagline_overview")
        if isinstance(tto, str) and tto.strip():
            text = tto.strip()
        else:
            parts = [p for p in [title, tagline, overview] if p]
            text = ". ".join(parts)

        if not text:
            continue

        tmdb_id = int(row.get("id", 0))
        if tmdb_id <= 0:
            continue

        imdb_raw = str(row.get("imdb_id") or "").strip()
        imdb_num = 0
        if imdb_raw.startswith("tt"):
            try:
                imdb_num = int(imdb_raw[2:])
            except ValueError:
                pass

        rating_x10 = min(100, max(0, int(round(imdb_rating * 10))))

        lang = str(row.get("original_language") or "").strip()[:2]

        release_date = str(row.get("release_date") or "").strip()
        year = 0
        if len(release_date) >= 4:
            try:
                year = int(release_date[:4])
            except ValueError:
                pass

        filtered.append({
            "tmdb_id": tmdb_id,
            "title": title,
            "poster_path": poster,
            "text": text,
            "cache_hash": hash_text(text, cache_scope),
            "imdb_num": imdb_num,
            "rating_x10": rating_x10,
            "lang": lang,
            "year": year,
        })

    print(f"Kept {len(filtered)} movies after filtering")
    return filtered


def load_embedding_cache(cache_scope: str):
    if not CACHE_PATH.exists():
        return {}

    print(f"Loading embedding cache from {CACHE_PATH.name}...")
    data = np.load(CACHE_PATH, allow_pickle=False)

    scope = ""
    if "__scope" in data.files:
        scope_arr = data["__scope"]
        if scope_arr.size > 0:
            scope = str(scope_arr[0])

    if scope and scope != cache_scope:
        print(f"  Cache scope mismatch ({scope} != {cache_scope}), ignoring old cache")
        return {}

    cache = {}
    if {"__ids", "__hashes", "__embeddings"}.issubset(set(data.files)):
        ids = data["__ids"]
        hashes = data["__hashes"]
        embeddings = data["__embeddings"]
        for i in range(len(ids)):
            cache[int(ids[i])] = (str(hashes[i]), embeddings[i])
    else:
        # Backward compatibility: old format stored tmdb ids as keys, no hashes.
        for k in data.files:
            if not k.isdigit():
                continue
            cache[int(k)] = ("", data[k])

    print(f"  {len(cache)} cached embeddings")
    return cache


def save_embedding_cache(cache_scope: str, cache):
    print(f"Saving embedding cache ({len(cache)} entries)...")
    if not cache:
        np.savez_compressed(
            CACHE_PATH,
            __scope=np.array([cache_scope], dtype="<U256"),
            __ids=np.array([], dtype=np.uint32),
            __hashes=np.array([], dtype="<U64"),
            __embeddings=np.empty((0, 0), dtype=np.float32),
        )
        return

    ids_sorted = sorted(cache.keys())
    hashes = [cache[i][0] for i in ids_sorted]
    embeddings = np.stack([cache[i][1] for i in ids_sorted]).astype(np.float32)

    np.savez_compressed(
        CACHE_PATH,
        __scope=np.array([cache_scope], dtype="<U256"),
        __ids=np.array(ids_sorted, dtype=np.uint32),
        __hashes=np.array(hashes, dtype="<U64"),
        __embeddings=embeddings,
    )


def generate_with_ollama(movies):
    all_embeddings = []
    for i in range(0, len(movies), BATCH_SIZE):
        batch = movies[i:i + BATCH_SIZE]
        texts = [f"search_document: {m['text']}" for m in batch]

        r = requests.post(
            f"{OLLAMA_URL}/api/embed",
            json={"model": OLLAMA_MODEL, "input": texts},
            timeout=300,
        )
        r.raise_for_status()
        embeddings = r.json()["embeddings"]
        all_embeddings.extend(embeddings)

        done = min(i + BATCH_SIZE, len(movies))
        print(f"  Embedded {done}/{len(movies)}")

    return all_embeddings


def generate_with_sentence_transformers(movies, model_name: str):
    from sentence_transformers import SentenceTransformer

    print(f"Loading sentence-transformers model: {model_name}")
    model = SentenceTransformer(model_name)

    all_embeddings = []
    for i in range(0, len(movies), BATCH_SIZE):
        batch = movies[i:i + BATCH_SIZE]
        texts = [f"search_document: {m['text']}" for m in batch]
        embeddings = model.encode(
            texts,
            batch_size=min(BATCH_SIZE, len(batch)),
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=False,
        )
        all_embeddings.extend(embeddings)

        done = min(i + BATCH_SIZE, len(movies))
        print(f"  Embedded {done}/{len(movies)}")

    return all_embeddings


def generate_embeddings(movies, cache, args, cache_scope):
    to_embed = []
    reused = 0

    for movie in movies:
        if not args.force_full_recompute:
            cached = cache.get(movie["tmdb_id"])
            if cached and cached[0] == movie["cache_hash"]:
                movie["embedding"] = cached[1]
                reused += 1
                continue
        to_embed.append(movie)

    print(f"Embeddings: {reused} cached, {len(to_embed)} to generate")

    if to_embed:
        if args.embed_backend == "ollama":
            new_embeddings = generate_with_ollama(to_embed)
        else:
            new_embeddings = generate_with_sentence_transformers(to_embed, args.sentence_model)

        for movie, emb in zip(to_embed, new_embeddings):
            emb_arr = np.array(emb, dtype=np.float32)
            movie["embedding"] = emb_arr
            cache[movie["tmdb_id"]] = (movie["cache_hash"], emb_arr)

    if args.cache_prune:
        valid_ids = {m["tmdb_id"] for m in movies}
        stale = [tmdb_id for tmdb_id in cache if tmdb_id not in valid_ids]
        for tmdb_id in stale:
            del cache[tmdb_id]
        if stale:
            print(f"Pruned stale cache entries: {len(stale)}")

    save_embedding_cache(cache_scope, cache)


def reduce_dimensions(movies, target_dim=16, verbose=False):
    import umap

    embeddings = np.stack([m["embedding"] for m in movies])
    print(f"Running UMAP {embeddings.shape[1]}-dim -> {target_dim}-dim...")

    reducer = umap.UMAP(
        n_components=target_dim,
        metric="cosine",
        n_neighbors=30,
        min_dist=0.1,
        random_state=42,
        verbose=verbose,
    )
    reduced = reducer.fit_transform(embeddings)
    print(f"UMAP done. Shape: {reduced.shape}")
    return reduced


def quantize(embeddings):
    print("Quantizing to uint8...")
    mins = embeddings.min(axis=0)
    maxs = embeddings.max(axis=0)
    ranges = maxs - mins
    ranges[ranges == 0] = 1
    normalized = (embeddings - mins) / ranges
    quantized = (normalized * 255).clip(0, 255).astype(np.uint8)
    print(f"Quantized shape: {quantized.shape}")
    return quantized


def write_metadata_binary(movies, output_path):
    print(f"Writing {output_path}...")
    with open(output_path, "wb") as f:
        f.write(struct.pack("<I", len(movies)))
        for movie in movies:
            title = movie["title"].encode("utf-8")[:255]
            f.write(struct.pack("<I", movie["tmdb_id"]))
            f.write(struct.pack("<I", movie["imdb_num"]))
            f.write(struct.pack("<B", movie["rating_x10"]))
            lang = movie["lang"].encode("ascii", errors="replace")[:2].ljust(2, b'\x00')
            f.write(lang)
            f.write(struct.pack("<H", movie["year"]))
            f.write(struct.pack("<B", len(title)))
            f.write(title)

    size = Path(output_path).stat().st_size
    print(f"Written {len(movies)} metadata, {size:,} bytes ({size / 1024 / 1024:.1f} MB)")


def write_embeddings_binary(movies, quantized, output_path):
    print(f"Writing {output_path}...")
    with open(output_path, "wb") as f:
        f.write(struct.pack("<I", len(movies)))
        for i, movie in enumerate(movies):
            poster_path = movie["poster_path"].encode("utf-8")
            f.write(struct.pack("<I", movie["tmdb_id"]))
            f.write(struct.pack("<B", len(poster_path)))
            f.write(poster_path)
            f.write(quantized[i].tobytes())

    size = Path(output_path).stat().st_size
    print(f"Written {len(movies)} movies, {size:,} bytes ({size / 1024 / 1024:.1f} MB)")


def main():
    args = parse_args()
    build_embed = args.only in (None, "embeddings")
    build_meta = args.only in (None, "metadata")

    if build_embed:
        if should_force_full_recompute(args.full_recompute_every_weeks):
            args.force_full_recompute = True
        if args.force_full_recompute:
            print("Full recompute is enabled for this run")
        if args.embed_backend == "ollama":
            check_ollama()

    output_dir = Path(__file__).parent.parent / "public" / "data"
    output_dir.mkdir(parents=True, exist_ok=True)

    cache_scope = compute_cache_scope(args) if build_embed else ""

    df = load_dataset()
    movies = filter_movies(df, cache_scope)
    if not movies:
        print("ERROR: No movies passed filters")
        return 1

    if build_embed:
        cache = load_embedding_cache(cache_scope)
        generate_embeddings(movies, cache, args, cache_scope)

        missing = [m["tmdb_id"] for m in movies if "embedding" not in m]
        if missing:
            print(f"ERROR: Missing embeddings for {len(missing)} movies")
            return 1

        reduced = reduce_dimensions(movies, target_dim=16, verbose=not args.ci)
        quantized = quantize(reduced)
        write_embeddings_binary(movies, quantized, output_dir / "embeddings.bin")

    if build_meta:
        write_metadata_binary(movies, output_dir / "metadata.bin")

    print(f"\nDone! Movies: {len(movies)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
