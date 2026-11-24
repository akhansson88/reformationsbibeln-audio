#!/usr/bin/env python3
"""Publish AAC-LC verse audio into the public asset repository.

GitHub's release-asset API allows only a few hundred content-creating calls per
hour, which is far too slow for roughly 28,000 verse files. This publisher
writes the same M4A files into a separate public repository instead, one book
per commit. The app reads the files from raw.githubusercontent.com, which is
free and needs no API token.

Examples:
    python publish_repo.py --books 43 --workers 4
    python publish_repo.py --limit 20 --workers 4
    python publish_repo.py --all
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from transcode import (
    AAC,
    REPO,
    VERSION,
    digest_bytes,
    download,
    media_duration,
    request_json,
    revision_for,
    transcode,
    write_json,
)

ROOT = Path(__file__).resolve().parent
ASSET_REPOSITORY = "akhansson88/reformationsbibeln-audio-aac"
RAW_BASE = f"https://raw.githubusercontent.com/{ASSET_REPOSITORY}/main/"
DEFAULT_ASSET_REPO = ROOT.parent / "reformationsbibeln-audio-aac-assets"


def relative_url(path: Path, repository: Path) -> str:
    return RAW_BASE + path.relative_to(repository).as_posix()


def chapter_directory(repository: Path, entry: dict, revision: str) -> Path:
    return repository / "chapters" / f"{entry['bookId']:02d}" / f"{entry['chapter']:03d}-{revision}"


def read_catalog(path: Path, source: dict) -> dict:
    if path.exists():
        catalog = json.loads(path.read_text(encoding="utf-8"))
    else:
        catalog = {"schemaVersion": 1, "translation": source["translation"], "chapters": {}}
    for key, entry in source["chapters"].items():
        catalog["chapters"].setdefault(key, {**entry, "container": "mp3"})
    return catalog


def chapter_entry(entry: dict, manifest_url: str) -> dict:
    return {
        "bookId": entry["bookId"],
        "book": entry["book"],
        "bookName": entry["bookName"],
        "chapter": entry["chapter"],
        "revision": entry["revision"],
        "sourceHash": entry["sourceHash"],
        "manifestUrl": manifest_url,
        "container": "m4a",
    }


def convert_chapter(key: str, entry: dict, repository: Path, force: bool, verse_workers: int) -> dict:
    source = request_json(entry["manifestUrl"])
    if source.get("translation") != VERSION:
        raise RuntimeError(f"Unexpected translation in {entry['manifestUrl']}")
    verses = source.get("verses")
    expected = source.get("expectedVerses")
    if not isinstance(verses, list) or not isinstance(expected, list) or len(verses) != len(expected):
        raise RuntimeError(f"Incomplete source manifest for {key}")
    if [verse.get("verse") for verse in verses] != expected:
        raise RuntimeError(f"Verse order mismatch for {key}")

    revision = revision_for(entry)
    directory = chapter_directory(repository, entry, revision)
    manifest_path = directory / "chapter.json"
    files = [directory / f"verse-{verse['verse']:03d}.m4a" for verse in verses]
    if not force and manifest_path.exists() and all(path.exists() and path.stat().st_size > 100 for path in files):
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        return chapter_entry({**entry, "revision": revision}, relative_url(manifest_path, repository))

    directory.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"aac-repo-{entry['bookId']:02d}-{entry['chapter']:03d}-"))
    try:
        def get_verse(verse):
            destination = work / f"verse-{verse['verse']:03d}.mp3"
            download(verse["url"], destination)
            return destination

        with concurrent.futures.ThreadPoolExecutor(max_workers=verse_workers) as pool:
            sources = list(pool.map(get_verse, verses))

        def make_aac(pair):
            source_path, verse = pair
            destination = directory / f"verse-{verse['verse']:03d}.m4a"
            temporary = directory / f"verse-{verse['verse']:03d}.part.m4a"
            transcode(source_path, temporary)
            temporary.replace(destination)
            return {
                "verse": verse["verse"],
                "url": relative_url(destination, repository),
                "duration": round(media_duration(destination), 3),
                "sha256": digest_bytes(destination),
                "textHash": verse["textHash"],
            }

        with concurrent.futures.ThreadPoolExecutor(max_workers=verse_workers) as pool:
            encoded = list(pool.map(make_aac, zip(sources, verses)))

        manifest = {
            "schemaVersion": 1,
            "translation": VERSION,
            "sourceHash": entry["sourceHash"],
            "revision": revision,
            "bookId": entry["bookId"],
            "book": entry["book"],
            "bookName": entry["bookName"],
            "chapter": entry["chapter"],
            "expectedVerses": expected,
            "container": "m4a",
            "encoding": AAC,
            **{field: source[field] for field in ("provider", "model", "voice", "voiceId", "voiceName") if field in source},
            "verses": encoded,
        }
        write_json(manifest_path, manifest)
        return chapter_entry({**entry, "revision": revision}, relative_url(manifest_path, repository))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def git(repository: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repository, capture_output=True, text=True, encoding="utf-8", check=check)


def push(repository: Path) -> None:
    for attempt in range(4):
        result = git(repository, "push", "origin", "main", check=False)
        if result.returncode == 0:
            return
        print(f"push failed ({attempt + 1}/4): {(result.stderr or result.stdout).strip()[:300]}", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("Could not push the asset repository")


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish AAC verse audio into the asset repository")
    parser.add_argument("--asset-repo", default=str(DEFAULT_ASSET_REPO))
    parser.add_argument("--source-catalog", default=str(ROOT / "catalog.json"))
    parser.add_argument("--books", help="Comma-separated book numbers, default all")
    parser.add_argument("--keys", help="Comma-separated bookId:chapter keys")
    parser.add_argument("--limit", type=int, help="Stop after this many chapters")
    parser.add_argument("--all", action="store_true", help="Convert every remaining chapter (the default)")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--verse-workers", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-push", action="store_true")
    args = parser.parse_args()

    repository = Path(args.asset_repo).resolve()
    if not (repository / ".git").exists():
        print(f"Not a git repository: {repository}", file=sys.stderr)
        return 2
    git(repository, "config", "user.name", "Koino Audio")
    git(repository, "config", "user.email", "audio@koino.se")

    source = json.loads(Path(args.source_catalog).read_text(encoding="utf-8"))
    catalog_path = repository / "catalog-aac.json"
    catalog = read_catalog(catalog_path, source)
    write_json(catalog_path, catalog)

    keys = list(source["chapters"])
    if args.keys:
        from transcode import parse_keys
        keys = parse_keys(args.keys)
    if args.books:
        wanted = {int(value.strip()) for value in args.books.split(",") if value.strip()}
        keys = [key for key in keys if source["chapters"][key]["bookId"] in wanted]
    keys = [key for key in keys if args.force or catalog["chapters"].get(key, {}).get("container") != "m4a"]
    if args.limit is not None:
        keys = keys[: args.limit]
    if not keys:
        print("Nothing to convert")
        return 0

    by_book: dict[int, list[str]] = {}
    for key in keys:
        by_book.setdefault(source["chapters"][key]["bookId"], []).append(key)

    failures: list[tuple[str, str]] = []
    total = len(keys)
    done = 0
    started = time.time()
    for book_id in sorted(by_book):
        book_keys = by_book[book_id]
        print(f"Book {book_id}: {len(book_keys)} chapter(s)")
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futures = {pool.submit(convert_chapter, key, source["chapters"][key], repository, args.force, args.verse_workers): key for key in book_keys}
            for future in concurrent.futures.as_completed(futures):
                key = futures[future]
                try:
                    catalog["chapters"][key] = future.result()
                    write_json(catalog_path, catalog)
                    done += 1
                    print(f"[{done}/{total}] {key}")
                except Exception as error:
                    failures.append((key, str(error)))
                    print(f"FAILED {key}: {error}", file=sys.stderr)

        git(repository, "add", "chapters", "catalog-aac.json")
        staged = git(repository, "diff", "--cached", "--quiet", check=False)
        if staged.returncode != 0:
            git(repository, "commit", "-m", f"Add AAC audio for book {book_id}")
            if not args.no_push:
                push(repository)
                print(f"Pushed book {book_id}")

    elapsed = time.time() - started
    print(f"Finished {done}/{total} in {elapsed / 60:.1f} min; failures: {len(failures)}")
    for key, message in failures:
        print(f"  {key}: {message}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
