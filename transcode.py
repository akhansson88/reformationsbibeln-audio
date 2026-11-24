#!/usr/bin/env python3
"""Publish a 64 kbps AAC-LC copy of every published Bible verse.

The source of truth stays catalog.json and the original MP3 releases. Each
converted chapter gets a new GitHub release and an entry in catalog-aac.json.
The script is resumable: chapters already marked as m4a in catalog-aac.json are
skipped, so rerunning after an interruption continues where it stopped.

Examples:
    python transcode.py --keys 43:1,19:23,45:8,1:1
    python transcode.py --limit 20 --workers 3
    python transcode.py --all
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = "akhansson88/reformationsbibeln-audio"
CATALOG = ROOT / "catalog.json"
AAC_CATALOG = ROOT / "catalog-aac.json"
VERSION = "reformationsbibeln2026"
CONTENT_TYPE = "audio/mp4"
AAC = {
    "name": "aac",
    "profile": "aac_low",
    "bitrate": 64000,
    "sampleRate": 44100,
    "channels": 1,
    "container": "m4a",
    "encoder": "ffmpeg aac",
    "version": "aac64-v1",
}
USER_AGENT = "koino-bible-audio-transcoder"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def digest_bytes(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def request_json(url: str, attempts: int = 4):
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last = error
            if attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Could not read {url}: {last}")


def download(url: str, destination: Path, attempts: int = 4) -> None:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=90) as response, destination.open("wb") as output:
                shutil.copyfileobj(response, output)
            if destination.stat().st_size < 100:
                raise ValueError("empty download")
            return
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            last = error
            destination.unlink(missing_ok=True)
            if attempt + 1 < attempts:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Could not download {url}: {last}")


def gh(args: list[str], *, check: bool = True, attempts: int = 5) -> subprocess.CompletedProcess:
    last: subprocess.CompletedProcess | None = None
    for attempt in range(attempts):
        result = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
        if result.returncode == 0:
            return result
        last = result
        message = (result.stderr or result.stdout).strip().lower()
        retryable = any(token in message for token in ("rate limit", "secondary", "timed out", "timeout", "connection", "http 5"))
        if attempt + 1 < attempts and retryable:
            time.sleep(min(60, 3 * (attempt + 1) ** 2))
            continue
        break
    if check and last is not None:
        raise RuntimeError(f"gh {' '.join(args[:3])} failed: {(last.stderr or last.stdout).strip()}")
    return last  # type: ignore[return-value]


def release_assets(tag: str) -> set[str] | None:
    result = gh(["release", "view", tag, "--repo", REPO, "--json", "assets", "--jq", ".assets[].name"], check=False, attempts=1)
    if result is None or result.returncode:
        return None
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def media_duration(path: Path) -> float:
    output = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path),
    ])
    duration = float(json.loads(output)["format"]["duration"])
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Invalid duration for {path}")
    return duration


def transcode(source: Path, destination: Path) -> None:
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(source),
        "-map_metadata", "-1", "-c:a", "aac", "-profile:a", "aac_low",
        "-b:a", "64k", "-ac", "1", "-ar", "44100", "-movflags", "+faststart",
        str(destination),
    ], check=True, capture_output=True)


def revision_for(entry: dict) -> str:
    material = json.dumps({
        "source": entry["sourceHash"],
        "from": entry["revision"],
        "codec": AAC,
    }, ensure_ascii=False, sort_keys=True)
    return "aac64-" + hashlib.sha256(material.encode()).hexdigest()[:12]


def publish(tag: str, files: list[Path], existing: set[str] | None, notes: str, force: bool = False) -> None:
    expected = {path.name for path in files}
    if existing is None:
        try:
            gh(["release", "create", tag, "--repo", REPO, "--title", tag, "--notes", notes])
        except RuntimeError:
            existing = release_assets(tag)
            if existing is None:
                raise
            existing = existing
        else:
            existing = set()
    missing = files if force else [path for path in files if path.name not in existing]
    if not missing:
        return
    try:
        gh(["release", "upload", tag, *[str(path) for path in missing], "--repo", REPO, "--clobber"])
    except RuntimeError:
        for path in missing:
            gh(["release", "upload", tag, str(path), "--repo", REPO, "--clobber"])
    uploaded = release_assets(tag) or set()
    absent = expected - uploaded
    if absent:
        raise RuntimeError(f"Release {tag} is missing assets: {', '.join(sorted(absent))}")


def convert_chapter(key: str, entry: dict, catalog_aac: dict, args) -> dict:
    chapter_manifest = request_json(entry["manifestUrl"])
    if chapter_manifest.get("translation") != VERSION:
        raise RuntimeError(f"Unexpected translation in {entry['manifestUrl']}")
    verses = chapter_manifest.get("verses")
    expected = chapter_manifest.get("expectedVerses")
    if not isinstance(verses, list) or not isinstance(expected, list) or len(verses) != len(expected):
        raise RuntimeError(f"Incomplete source manifest for {key}")
    if [verse.get("verse") for verse in verses] != expected:
        raise RuntimeError(f"Verse order mismatch for {key}")

    revision = revision_for(entry)
    tag = f"audio-{entry['bookId']:02d}-{entry['chapter']:03d}-{revision}"
    names = {"chapter.json"} | {f"verse-{verse['verse']:03d}.m4a" for verse in verses}
    existing = release_assets(tag)
    if existing is not None and names <= existing and not args.force:
        return aac_entry(entry, tag, revision)

    work = Path(tempfile.mkdtemp(prefix=f"aac-{entry['bookId']:02d}-{entry['chapter']:03d}-", dir=args.work))
    try:
        def get_verse(verse):
            destination = work / f"verse-{verse['verse']:03d}.mp3"
            download(verse["url"], destination)
            return destination

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.verse_workers) as pool:
            sources = list(pool.map(get_verse, verses))

        def make_aac(pair):
            source, verse = pair
            destination = work / f"verse-{verse['verse']:03d}.m4a"
            transcode(source, destination)
            return {
                "verse": verse["verse"],
                "url": f"https://github.com/{REPO}/releases/download/{tag}/verse-{verse['verse']:03d}.m4a",
                "duration": round(media_duration(destination), 3),
                "sha256": digest_bytes(destination),
                "textHash": verse["textHash"],
            }

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.verse_workers) as pool:
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
            **{field: chapter_manifest[field] for field in ("provider", "model", "voice", "voiceId", "voiceName") if field in chapter_manifest},
            "verses": encoded,
        }
        manifest_path = work / "chapter.json"
        write_json(manifest_path, manifest)
        files = [manifest_path, *[work / f"verse-{verse['verse']:03d}.m4a" for verse in verses]]
        publish(tag, files, existing, f"AAC-LC 64 kbps mono copy of {entry['bookName']} {entry['chapter']}.", force=args.force)
        return aac_entry(entry, tag, revision)
    finally:
        if args.keep:
            print(f"  kept {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


def aac_entry(entry: dict, tag: str, revision: str) -> dict:
    return {
        "bookId": entry["bookId"],
        "book": entry["book"],
        "bookName": entry["bookName"],
        "chapter": entry["chapter"],
        "revision": revision,
        "sourceHash": entry["sourceHash"],
        "manifestUrl": f"https://github.com/{REPO}/releases/download/{tag}/chapter.json",
        "container": "m4a",
    }


def parse_keys(value: str) -> list[str]:
    keys: list[str] = []
    for raw in value.split(","):
        token = raw.strip()
        if not token:
            continue
        if "-" in token:
            prefix, _, range_value = token.partition(":")
            start, _, end = range_value.partition("-")
            if not prefix or not start or not end:
                raise ValueError(f"Invalid key range: {token}")
            keys.extend(f"{prefix}:{number}" for number in range(int(start), int(end) + 1))
        else:
            keys.append(token)
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish AAC-LC copies of the verse audio")
    parser.add_argument("--keys", help="Comma-separated bookId:chapter keys, ranges allowed (43:1-3)")
    parser.add_argument("--limit", type=int, help="Stop after this many chapters")
    parser.add_argument("--workers", type=int, default=3, help="Chapters converted in parallel")
    parser.add_argument("--verse-workers", type=int, default=4, help="Downloads/encodes per chapter")
    parser.add_argument("--work", help="Temporary directory (defaults to the system temp folder)")
    parser.add_argument("--force", action="store_true", help="Re-upload even when the release is complete")
    parser.add_argument("--keep", action="store_true", help="Keep temporary files")
    parser.add_argument("--push", action="store_true", help="Commit and push catalog-aac.json when finished")
    parser.add_argument("--all", action="store_true", help="Convert every remaining chapter")
    args = parser.parse_args()

    if not shutil.which("ffmpeg") or not shutil.which("ffprobe") or not shutil.which("gh"):
        print("ffmpeg, ffprobe and gh must be on PATH", file=sys.stderr)
        return 2

    source = load_json(CATALOG)
    catalog_aac = load_json(AAC_CATALOG) if AAC_CATALOG.exists() else {
        "schemaVersion": 1, "translation": source["translation"], "chapters": {},
    }
    if catalog_aac.get("translation") != source["translation"]:
        print("catalog-aac.json belongs to another translation", file=sys.stderr)
        return 2

    # Keep every published chapter in the AAC catalog; unconverted entries stay MP3.
    for key, entry in source["chapters"].items():
        catalog_aac["chapters"].setdefault(key, {**entry, "container": "mp3"})

    if args.keys:
        keys = parse_keys(args.keys)
        unknown = [key for key in keys if key not in source["chapters"]]
        if unknown:
            print(f"Unknown chapters: {', '.join(unknown)}", file=sys.stderr)
            return 2
    else:
        keys = [key for key, entry in source["chapters"].items() if args.force or catalog_aac["chapters"].get(key, {}).get("container") != "m4a"]
    if args.limit is not None:
        keys = keys[: args.limit]
    if not keys:
        print("Nothing to convert")
        return 0

    print(f"Converting {len(keys)} chapter(s) with {args.workers} worker(s)")
    failures: list[tuple[str, str]] = []
    done = 0
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(convert_chapter, key, source["chapters"][key], catalog_aac, args): key for key in keys}
        for future in concurrent.futures.as_completed(futures):
            key = futures[future]
            try:
                entry = future.result()
                catalog_aac["chapters"][key] = entry
                write_json(AAC_CATALOG, catalog_aac)
                done += 1
                print(f"[{done}/{len(keys)}] {key} -> {entry['manifestUrl']}")
            except Exception as error:  # keep other chapters going
                failures.append((key, str(error)))
                print(f"FAILED {key}: {error}", file=sys.stderr)

    elapsed = time.time() - started
    print(f"Finished {done}/{len(keys)} in {elapsed / 60:.1f} min; failures: {len(failures)}")
    for key, message in failures:
        print(f"  {key}: {message}", file=sys.stderr)

    if args.push:
        subprocess.run(["git", "add", "catalog-aac.json"], cwd=ROOT, check=True)
        check = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
        if check.returncode != 0:
            subprocess.run(["git", "commit", "-m", "Publish AAC audio catalog"], cwd=ROOT, check=True)
            subprocess.run(["git", "push", "origin", "HEAD"], cwd=ROOT, check=True)
            print("Pushed catalog-aac.json")
        else:
            print("catalog-aac.json unchanged; nothing to push")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
