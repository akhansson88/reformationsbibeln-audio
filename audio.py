"""Generate and publish verse audio. Run --help for selection and dispatch options."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

REPO = "akhansson88/reformationsbibeln-audio"
VERSION = "reformationsbibeln2026"
MODEL = "tts-1-hd"
VOICE = "onyx"
BOOKS = "Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|1 Samuel|2 Samuel|1 Kings|2 Kings|1 Chronicles|2 Chronicles|Ezra|Nehemiah|Esther|Job|Psalms|Proverbs|Ecclesiastes|Solomon's Song|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|1 Corinthians|2 Corinthians|Galatians|Ephesians|Philippians|Colossians|1 Thessalonians|2 Thessalonians|1 Timothy|2 Timothy|Titus|Philemon|Hebrews|James|1 Peter|2 Peter|1 John|2 John|3 John|Jude|Revelation".split("|")


def clean(text):
    return " ".join(text.replace("*", "").replace("#", "").split())


def digest(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    return hashlib.sha256(value).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def gh(*args, check=True):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    if check and result.returncode:
        raise RuntimeError(f"GitHub command failed ({args[0]} {args[1]}): {result.stderr.strip()}")
    return result


def load_source(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if len(data["books"]) != 66:
        raise ValueError("Expected 66 source books")
    return data


def select(data, books="", chapters="", entire=False):
    if entire and (books or chapters):
        raise ValueError("--all cannot be combined with --books or --chapters")
    if not entire and not books:
        raise ValueError("Select --books or --all")
    aliases = {}
    for book in data["books"]:
        n = book["number"]
        for alias in (str(n), BOOKS[n - 1], book["name"], book.get("abbreviation", "")):
            aliases[alias.casefold().strip().rstrip(".")] = n
    requested = set(range(1, 67)) if entire else set()
    for value in books.split(",") if books else []:
        key = value.strip().casefold().rstrip(".")
        if key not in aliases:
            raise ValueError(f"Unknown book: {value}")
        requested.add(aliases[key])
    chapter_numbers = set()
    for value in chapters.split(",") if chapters else []:
        parts = value.strip().split("-")
        if len(parts) > 2:
            raise ValueError("Invalid chapter range")
        start, end = int(parts[0]), int(parts[-1])
        if start < 1 or end < start or end > 150:
            raise ValueError("Invalid chapter range")
        chapter_numbers.update(range(start, end + 1))
    result = []
    for book in data["books"]:
        if book["number"] not in requested:
            continue
        available = {c["number"] for c in book["chapters"]}
        if chapter_numbers - available:
            raise ValueError(f"Chapter does not exist in {book['name']}")
        for chapter in book["chapters"]:
            if chapter_numbers and chapter["number"] not in chapter_numbers:
                continue
            result.append((book, chapter))
    return result


def inspect_mp3(path):
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], check=True, capture_output=True)
    output = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)])
    duration = float(json.loads(output)["format"]["duration"])
    if duration <= 0 or path.stat().st_size < 100:
        raise ValueError("Invalid audio file")
    return duration


def synthesize(text, destination):
    from openai import OpenAI, APIConnectionError, APIStatusError
    client = OpenAI(max_retries=0, timeout=120)
    for attempt in range(6):
        try:
            with client.audio.speech.with_streaming_response.create(
                model=MODEL, voice=VOICE, input=text, response_format="mp3", speed=1,
            ) as response:
                response.stream_to_file(destination)
            return
        except (APIConnectionError, APIStatusError) as error:
            code = getattr(error, "status_code", None)
            if attempt == 5 or (code is not None and code not in (408, 429) and code < 500):
                # Do not include request objects or credentials in workflow output.
                raise RuntimeError(f"Speech request failed (status {code or 'connection'})") from None
            time.sleep(min(60, 2 ** (attempt + 1)))


def generate_chapter(data, book, chapter, repo, output, revision=""):
    verses = [{"verse": v["number"], "text": clean(v["text"])} for v in chapter["verses"]]
    numbers = [v["verse"] for v in verses]
    if not verses or len(set(numbers)) != len(numbers) or numbers != sorted(numbers):
        raise ValueError("Invalid source verse numbering")
    if any(not v["text"] or len(v["text"]) > 4096 for v in verses):
        raise ValueError("Source verse is empty or exceeds the speech input limit")
    source_hash = digest(verses)
    generation = digest({"source": source_hash, "model": MODEL, "voice": VOICE, "speed": 1, "format": "mp3", "revision": revision})[:20]
    tag = f"audio-{book['number']:02d}-{chapter['number']:03d}-{generation}"
    existing = gh("release", "view", tag, "--repo", repo, "--json", "assets", check=False)
    if existing.returncode:
        gh("release", "create", tag, "--repo", repo, "--title", f"{book['name']} {chapter['number']} · {VOICE}", "--notes", "AI narration of the bundled Reformationsbibeln source. Individual verse MP3 files.", "--prerelease")
        assets = set()
    else:
        assets = {a["name"] for a in json.loads(existing.stdout)["assets"]}
    manifest = {"schemaVersion": 1, "translation": VERSION, "sourceLabel": data["translation"], "sourceHash": source_hash, "revision": generation, "model": MODEL, "voice": VOICE, "bookId": book["number"], "book": BOOKS[book["number"] - 1], "bookName": book["name"], "chapter": chapter["number"], "expectedVerses": numbers, "verses": []}
    with tempfile.TemporaryDirectory() as directory:
        for verse in verses:
            name = f"verse-{verse['verse']:03d}.mp3"
            path = Path(directory) / name
            if name in assets:
                gh("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", directory)
                try:
                    duration = inspect_mp3(path)
                except (ValueError, subprocess.CalledProcessError):
                    path.unlink(missing_ok=True)
                    assets.remove(name)
            if name not in assets:
                synthesize(verse["text"], path)
                duration = inspect_mp3(path)
                gh("release", "upload", tag, str(path), "--repo", repo, "--clobber")
            manifest["verses"].append({"verse": verse["verse"], "url": f"https://github.com/{repo}/releases/download/{tag}/{name}", "duration": duration, "sha256": digest(path.read_bytes()), "textHash": digest(verse["text"])})
            print(f"Validated {book['number']}:{chapter['number']}:{verse['verse']}", flush=True)
        manifest_path = Path(directory) / "chapter.json"
        write_json(manifest_path, manifest)
        gh("release", "upload", tag, str(manifest_path), "--repo", repo, "--clobber")
    manifest["manifestUrl"] = f"https://github.com/{repo}/releases/download/{tag}/chapter.json"
    write_json(Path(output) / f"{book['number']:02d}-{chapter['number']:03d}.json", manifest)


def publish(directory, catalog_path):
    path = Path(catalog_path)
    catalog = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schemaVersion": 1, "translation": VERSION, "chapters": {}}
    for file in sorted(Path(directory).glob("**/*.json")):
        manifest = json.loads(file.read_text(encoding="utf-8"))
        if manifest.get("translation") != VERSION or [v["verse"] for v in manifest["verses"]] != manifest["expectedVerses"]:
            raise ValueError("Refusing to publish incomplete chapter")
        # The release manifest is uploaded only after every audio file is validated.
        with urllib.request.urlopen(manifest["manifestUrl"], timeout=60) as response:
            remote = json.load(response)
        if remote["verses"] != manifest["verses"] or remote["sourceHash"] != manifest["sourceHash"]:
            raise ValueError("Published chapter does not match validated output")
        catalog["chapters"][f"{manifest['bookId']}:{manifest['chapter']}"] = {
            key: manifest[key] for key in ("bookId", "book", "bookName", "chapter", "revision", "sourceHash", "manifestUrl")
        }
    write_json(path, catalog)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["estimate", "dispatch", "matrix", "generate", "publish"])
    parser.add_argument("--source", default=str(Path(__file__).with_name("reformationsbibeln.json")))
    parser.add_argument("--books", default="")
    parser.add_argument("--chapters", default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--repo", default=REPO)
    parser.add_argument("--output", default="generated")
    parser.add_argument("--catalog", default="catalog.json")
    parser.add_argument("--shard", type=int)
    parser.add_argument("--shard-size", type=int, default=25)
    parser.add_argument("--revision", default="", help="New explicit revision for intentional regeneration")
    args = parser.parse_args()
    if args.shard_size < 1 or (args.shard is not None and args.shard < 0):
        parser.error("Shard size must be positive and shard index nonnegative")
    if args.command == "publish":
        publish(args.output, args.catalog)
        return
    if not Path(args.source).exists():
        args.source = str(Path(__file__).parents[2] / "assets/bible/reformationsbibeln.json")
    data = load_source(args.source)
    selection = select(data, args.books, args.chapters, args.all)
    if args.command == "estimate":
        texts = [clean(v["text"]) for _, c in selection for v in c["verses"]]
        count = sum(map(len, texts))
        print(json.dumps({"chapters": len(selection), "verses": len(texts), "characters": count, "estimatedUSD": round(count * 30 / 1_000_000, 2)}))
    elif args.command == "dispatch":
        request_id = uuid.uuid4().hex[:12]
        inputs = {"books": args.books, "chapters": args.chapters, "entire": str(args.all).lower(), "revision": args.revision, "request_id": request_id}
        command = ["workflow", "run", "generate.yml", "--repo", args.repo]
        for name, value in inputs.items():
            command += ["-f", f"{name}={value}"]
        gh(*command)
        for _ in range(6):
            runs = json.loads(gh("run", "list", "--repo", args.repo, "--workflow", "generate.yml", "--limit", "20", "--json", "displayTitle,url").stdout)
            match = next((run for run in runs if request_id in run["displayTitle"]), None)
            if match:
                print(f"Generation dispatched: {match['url']}")
                break
            time.sleep(2)
        else:
            print(f"Generation dispatched ({request_id}): https://github.com/{args.repo}/actions/workflows/generate.yml")
    elif args.command == "matrix":
        print(json.dumps({"shard": list(range((len(selection) + args.shard_size - 1) // args.shard_size))}))
    elif args.command == "generate":
        failures = []
        selected_shard = selection if args.shard is None else selection[args.shard * args.shard_size:(args.shard + 1) * args.shard_size]
        for book, chapter in selected_shard:
            try:
                generate_chapter(data, book, chapter, args.repo, args.output, args.revision)
            except Exception as error:
                failures.append(f"{book['number']}:{chapter['number']} ({type(error).__name__})")
        if failures:
            raise RuntimeError("Failed chapters; rerun to resume: " + ", ".join(failures))


if __name__ == "__main__":
    main()
