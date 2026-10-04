"""Generate and publish verse audio. Run --help for selection and dispatch options."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import uuid

REPO = "akhansson88/reformationsbibeln-audio"
VERSION = "reformationsbibeln2026"
MODEL = "eleven_v4"
VOICE = "qAZH0aMXY8tw1QufPN0D"
PROFILE = {"provider": "elevenlabs", "model": MODEL, "voice": VOICE, "voiceId": VOICE,
           "voiceName": "ElevenLabs", "language": "sv", "format": "mp3_44100_128",
           "voiceSettings": {"stability": 0.5, "similarity_boost": 0.75}}
DEADLINE = float("inf")


class GenerationPaused(RuntimeError):
    """Completed recordings remain uploaded; rerun with the same selection."""


def summary(message):
    print(message, flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write(message + "\n\n")


def eleven_request(path, payload=None):
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Add the ELEVENLABS_API_KEY repository secret before generation")
    return urllib.request.urlopen(urllib.request.Request(
        "https://api.elevenlabs.io/v1/" + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    ), timeout=120)


def preflight():
    check = "models"
    try:
        with eleven_request("models") as response:
            models = json.load(response)
        if not any(model.get("model_id") == MODEL and model.get("can_do_text_to_speech") for model in models):
            raise RuntimeError(f"The ElevenLabs account cannot access {MODEL}; no substitute model will be used")
        check = "selected voice"
        with eleven_request(f"voices/{VOICE}") as response:
            voice = json.load(response)
        if voice.get("voice_id") != VOICE:
            raise RuntimeError("The requested voice is unavailable")
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read()).get("detail", {})
            status = detail.get("status") if isinstance(detail, dict) else None
        except (ValueError, AttributeError):
            status = None
        finally:
            error.close()
        # Map provider responses to fixed messages: never log bodies, keys or headers.
        reasons = {
            "missing_permissions": "The key is missing permissions. Enable Models: Read, Voices: Read and Text to Speech: Access in ElevenLabs.",
            "invalid_api_key": "The API key is invalid or revoked. Replace the ELEVENLABS_API_KEY GitHub secret with an active ElevenLabs API key.",
            "unauthorized": "The key was rejected. Check that it is active and belongs to the intended ElevenLabs workspace.",
            "voice_not_found": "The selected voice is not available in this ElevenLabs workspace.",
            "quota_exceeded": "The ElevenLabs account or API key has no credits available.",
        }
        reason = reasons.get(status, "Check the key's validity and Models: Read / Voices: Read permissions in ElevenLabs.")
        message = f"ElevenLabs {check} check failed (HTTP {error.code}). {reason}"
        summary(message)
        raise RuntimeError(message) from None
    summary(f"Verified ElevenLabs {MODEL}, voice {VOICE}.")
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
    partial = destination.with_suffix(".part")
    for attempt in range(6):
        try:
            with eleven_request(f"text-to-speech/{VOICE}?output_format={PROFILE['format']}", {
                "model_id": MODEL, "text": text, "language_code": "sv",
                "voice_settings": PROFILE["voiceSettings"],
            }) as response, partial.open("wb") as output:
                import shutil
                shutil.copyfileobj(response, output)
            partial.replace(destination)
            return
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read()).get("detail", {})
                status = detail.get("status", "") if isinstance(detail, dict) else ""
            except (ValueError, AttributeError):
                status = ""
            finally:
                error.close()
            if error.code == 402 or status in ("quota_exceeded", "insufficient_credits", "insufficient_credit_balance"):
                raise GenerationPaused("ElevenLabs credits exhausted. Refill credits and rerun the same selection.") from None
            if error.code == 429 and attempt < 5:
                time.sleep(min(60, 2 ** (attempt + 1)))
                continue
            # A rejection is safe to resume. An uncertain server/connection failure
            # leaves a request marker so a rerun cannot silently charge twice.
            if error.code < 500 and error.code != 408:
                destination.with_suffix(".request.json").unlink(missing_ok=True)
            raise RuntimeError(f"Speech request failed (HTTP {error.code}); no automatic paid retry") from None


def upload(tag, path, repo):
    for attempt in range(4):
        try:
            gh("release", "upload", tag, str(path), "--repo", repo, "--clobber")
            return
        except RuntimeError:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def generation_id(source_hash, revision=""):
    return digest({"source": source_hash, **PROFILE, "revision": revision})[:20]


def complete_manifest(value, *, book, chapter, source_hash, generation, repo, tag, numbers):
    if not isinstance(value, dict):
        return False
    expected = {
        "schemaVersion": 1,
        "translation": VERSION,
        "sourceHash": source_hash,
        "revision": generation,
        **PROFILE,
        "bookId": book["number"],
        "book": BOOKS[book["number"] - 1],
        "bookName": book["name"],
        "chapter": chapter["number"],
        "expectedVerses": numbers,
    }
    if any(value.get(key) != item for key, item in expected.items()):
        return False
    verses = value.get("verses")
    if not isinstance(verses, list) or not all(isinstance(item, dict) for item in verses) or [item.get("verse") for item in verses] != numbers:
        return False
    for item in verses:
        verse = item["verse"]
        expected_url = f"https://github.com/{repo}/releases/download/{tag}/verse-{verse:03d}.mp3"
        if (
            item.get("url") != expected_url
            or not isinstance(item.get("duration"), (int, float))
            or not math.isfinite(item["duration"])
            or item["duration"] <= 0
            or not isinstance(item.get("sha256"), str)
            or len(item["sha256"]) != 64
            or not isinstance(item.get("textHash"), str)
            or len(item["textHash"]) != 64
        ):
            return False
    return True


def previous_manifest(book, chapter, repo):
    """Read the current published chapter, including overwrite revisions."""
    catalog_path = Path(__file__).with_name("catalog.json")
    if catalog_path.exists():
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    else:
        # Direct local generation gets the same reuse protection as Actions.
        # A failed catalog lookup must stop before charging for possibly existing audio.
        catalog = json.loads(gh("api", f"repos/{repo}/contents/catalog.json", "-H", "Accept: application/vnd.github.raw+json").stdout)
    entry = catalog.get("chapters", {}).get(f"{book['number']}:{chapter['number']}")
    if not entry:
        return None
    prefix = f"https://github.com/{repo}/releases/download/"
    if not entry["manifestUrl"].startswith(prefix):
        raise ValueError("Unexpected previous audio repository")
    with urllib.request.urlopen(entry["manifestUrl"], timeout=60) as response:
        manifest = json.load(response)
    if any(manifest.get(key) != value for key, value in PROFILE.items()):
        return None  # A different provider/voice must never supply replacement verses.
    if manifest.get("bookId") != book["number"] or manifest.get("chapter") != chapter["number"]:
        raise ValueError("Existing chapter identity mismatch")
    return manifest


def previous_verses(book, chapter, repo):
    """Reuse unchanged verses when another verse changed the chapter revision."""
    manifest = previous_manifest(book, chapter, repo)
    return {verse["verse"]: verse for verse in manifest["verses"]} if manifest else {}


def generate_chapter(data, book, chapter, repo, output, revision="", *, overwrite=False):
    if revision and not overwrite:
        raise ValueError("Regeneration is disabled unless --overwrite is selected")
    if overwrite and not revision:
        raise ValueError("Overwrite generation requires a resumable revision")
    verses = [{"verse": v["number"], "text": clean(v["text"])} for v in chapter["verses"]]
    numbers = [v["verse"] for v in verses]
    if not verses or len(set(numbers)) != len(numbers) or numbers != sorted(numbers):
        raise ValueError("Invalid source verse numbering")
    if any(not v["text"] or len(v["text"]) > 4096 for v in verses):
        raise ValueError("Source verse is empty or exceeds the speech input limit")
    source_hash = digest(verses)
    if not overwrite:
        previous = previous_manifest(book, chapter, repo)
        if previous and previous.get("sourceHash") == source_hash:
            # Keep using the latest replacement on normal runs, rather than
            # reverting the catalog to the original deterministic release.
            revision = previous.get("revision", "")
            tag = previous["verses"][0]["url"].split("/releases/download/", 1)[1].split("/", 1)[0] if previous.get("verses") else ""
            if complete_manifest(previous, book=book, chapter=chapter, source_hash=source_hash,
                                 generation=revision, repo=repo, tag=tag, numbers=numbers):
                previous["manifestUrl"] = f"https://github.com/{repo}/releases/download/{tag}/chapter.json"
                write_json(Path(output) / f"{book['number']:02d}-{chapter['number']:03d}.json", previous)
                print(f"Already published; skipped {book['number']}:{chapter['number']}", flush=True)
                return
            revision = ""
    generation = generation_id(source_hash, revision)
    tag = f"audio-{book['number']:02d}-{chapter['number']:03d}-{generation}"
    existing = gh("release", "view", tag, "--repo", repo, "--json", "assets", check=False)
    if existing.returncode:
        gh("release", "create", tag, "--repo", repo, "--title", f"{book['name']} {chapter['number']} · {VOICE}", "--notes", "AI narration of the bundled Reformationsbibeln source. Individual verse MP3 files.", "--prerelease")
        assets = set()
    else:
        assets = {a["name"] for a in json.loads(existing.stdout)["assets"]}
    manifest_url = f"https://github.com/{repo}/releases/download/{tag}/chapter.json"
    pending = Path(output) / "pending" / tag
    pending.mkdir(parents=True, exist_ok=True)
    directory = str(pending)
    if "chapter.json" in assets:
        manifest_path = Path(directory) / "chapter.json"
        gh("release", "download", tag, "--repo", repo, "--pattern", "chapter.json", "--dir", directory, "--clobber")
        try:
            published = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            published = None
        if all(f"verse-{number:03d}.mp3" in assets for number in numbers) and complete_manifest(
            published,
            book=book,
            chapter=chapter,
            source_hash=source_hash,
            generation=generation,
            repo=repo,
            tag=tag,
            numbers=numbers,
        ):
            manifest_path.unlink(missing_ok=True)
            published["manifestUrl"] = manifest_url
            write_json(Path(output) / f"{book['number']:02d}-{chapter['number']:03d}.json", published)
            print(f"Already complete; skipped {book['number']}:{chapter['number']} ({len(numbers)} verses)", flush=True)
            return
        manifest_path.unlink(missing_ok=True)

    manifest = {"schemaVersion": 1, "translation": VERSION, "sourceLabel": data["translation"], "sourceHash": source_hash, "revision": generation, **PROFILE, "bookId": book["number"], "book": BOOKS[book["number"] - 1], "bookName": book["name"], "chapter": chapter["number"], "expectedVerses": numbers, "verses": []}
    reusable = previous_verses(book, chapter, repo) if not overwrite and any(f"verse-{n:03d}.mp3" not in assets for n in numbers) else {}
    for verse in verses:
        if time.monotonic() >= DEADLINE:
            raise GenerationPaused(f"Time budget reached before {book['number']}:{chapter['number']}:{verse['verse']}; rerun to resume.")
        name = f"verse-{verse['verse']:03d}.mp3"
        path = Path(directory) / name
        marker = path.with_suffix(".request.json")
        receipt = path.with_suffix(".receipt.json")
        if name in assets:
            gh("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", directory, "--clobber")
            try:
                duration = inspect_mp3(path)
            except (ValueError, subprocess.CalledProcessError):
                raise ValueError(f"Existing audio {tag}/{name} failed validation; refusing to regenerate it")
        if name not in assets:
            previous = reusable.get(verse["verse"])
            if path.exists():
                if receipt.exists() and json.loads(receipt.read_text(encoding="utf-8"))["sha256"] != digest(path.read_bytes()):
                    raise ValueError("Pending upload checksum mismatch; refusing regeneration")
            elif marker.exists():
                raise RuntimeError(f"Uncertain previous speech request for {tag}/{name}; recover audio from ElevenLabs history before retrying")
            elif previous and previous.get("textHash") == digest(verse["text"]):
                if not previous["url"].startswith(f"https://github.com/{repo}/releases/download/"):
                    raise ValueError("Unexpected verse repository")
                with urllib.request.urlopen(previous["url"], timeout=60) as response:
                    path.write_bytes(response.read())
                if digest(path.read_bytes()) != previous["sha256"]:
                    raise ValueError("Existing verse checksum mismatch; refusing regeneration")
                print(f"Reused {book['number']}:{chapter['number']}:{verse['verse']}", flush=True)
            else:
                write_json(marker, {"textHash": digest(verse["text"]), **PROFILE})
                try:
                    synthesize(verse["text"], path)
                except GenerationPaused as error:
                    marker.unlink(missing_ok=True)
                    raise GenerationPaused(f"{error} Next verse: {book['number']}:{chapter['number']}:{verse['verse']}.") from None
            duration = inspect_mp3(path)
            write_json(receipt, {"sha256": digest(path.read_bytes()), "textHash": digest(verse["text"]), **PROFILE})
            upload(tag, path, repo)
        manifest["verses"].append({"verse": verse["verse"], "url": f"https://github.com/{repo}/releases/download/{tag}/{name}", "duration": duration, "sha256": digest(path.read_bytes()), "textHash": digest(verse["text"])})
        path.unlink(missing_ok=True)
        marker.unlink(missing_ok=True)
        receipt.unlink(missing_ok=True)
        path.with_suffix(".part").unlink(missing_ok=True)
        print(f"Validated {book['number']}:{chapter['number']}:{verse['verse']}", flush=True)
    manifest_path = Path(directory) / "chapter.json"
    write_json(manifest_path, manifest)
    upload(tag, manifest_path, repo)
    manifest_path.unlink(missing_ok=True)
    manifest["manifestUrl"] = manifest_url
    write_json(Path(output) / f"{book['number']:02d}-{chapter['number']:03d}.json", manifest)


def publish(directory, catalog_path):
    path = Path(catalog_path)
    catalog = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schemaVersion": 1, "translation": VERSION, "chapters": {}}
    for file in sorted(Path(directory).glob("*.json")):
        manifest = json.loads(file.read_text(encoding="utf-8"))
        if manifest.get("translation") != VERSION or [v["verse"] for v in manifest["verses"]] != manifest["expectedVerses"]:
            raise ValueError("Refusing to publish incomplete chapter")
        if any(manifest.get(key) != value for key, value in PROFILE.items()):
            raise ValueError("Refusing to publish a different narration profile")
        # The release manifest is uploaded only after every audio file is validated.
        with urllib.request.urlopen(manifest["manifestUrl"], timeout=60) as response:
            remote = json.load(response)
        if any(remote.get(key) != value for key, value in manifest.items() if key != "manifestUrl"):
            raise ValueError("Published chapter does not match validated output")
        catalog["chapters"][f"{manifest['bookId']}:{manifest['chapter']}"] = {
            key: manifest[key] for key in ("bookId", "book", "bookName", "chapter", "revision", "sourceHash", "manifestUrl")
        }
    write_json(path, catalog)


def prepare_migration(catalog_path, migration_path):
    """Persist original manifests before withdrawing legacy catalog entries."""
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    path = Path(migration_path)
    migration = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"profile": PROFILE, "chapters": {}}
    if migration["profile"] != PROFILE:
        migration["profile"] = PROFILE  # Retain original legacy snapshots when changing voice.
    for key, entry in list(catalog["chapters"].items()):
        with urllib.request.urlopen(entry["manifestUrl"], timeout=60) as response:
            manifest = json.load(response)
        if manifest.get("model", "").startswith("tts-") or manifest.get("provider") == "openai":
            migration["chapters"][key] = {"entry": entry, "manifest": manifest}
            del catalog["chapters"][key]
    # The checkpoint must reach disk before the catalog loses its entries.
    write_json(path, migration)
    write_json(catalog_path, catalog)
    summary(f"Legacy migration saved: {len(migration['chapters'])} chapters. Incomplete replacements are hidden.")


def migration_selection(data, migration_path):
    migration = json.loads(Path(migration_path).read_text(encoding="utf-8"))
    if migration["profile"] != PROFILE:
        raise ValueError("Migration narration profile changed")
    keys = set(migration["chapters"])
    return [(book, chapter) for book, chapter in select(data, entire=True)
            if f"{book['number']}:{chapter['number']}" in keys]


def recover_pending(output, repo):
    """Carry the most recent recovery checkpoint across workflow runs."""
    pending = Path(output) / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    pages = json.loads(gh("api", "--paginate", "--slurp", f"repos/{repo}/actions/artifacts?name=pending-audio&per_page=100").stdout)
    artifacts = [item for page in pages for item in page["artifacts"]
                 if not item["expired"] and str(item["workflow_run"]["id"]) != os.environ.get("GITHUB_RUN_ID")]
    if artifacts:
        latest = max(artifacts, key=lambda item: item["created_at"])
        with tempfile.TemporaryDirectory() as directory:
            gh("run", "download", str(latest["workflow_run"]["id"]), "--repo", repo,
               "--name", "pending-audio", "--dir", directory)
            import shutil
            for source in Path(directory).rglob("*"):
                if source.is_file():
                    target = pending / source.relative_to(directory)
                    if target.exists() and target.name == "overwrites.json":
                        continue  # Local session state is newer than the downloaded checkpoint.
                    if target.exists() and target.read_bytes() != source.read_bytes() and target.name != "state.json":
                        raise ValueError("Conflicting pending audio; refusing to overwrite recovery data")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, target)
    write_json(pending / "state.json", {"schemaVersion": 1})
    # Flush completed recordings even if the speech credential is missing or empty.
    for receipt in pending.glob("audio-*/*.receipt.json"):
        record = json.loads(receipt.read_text(encoding="utf-8"))
        path = receipt.with_name(receipt.name.replace(".receipt.json", ".mp3"))
        if any(record.get(key) != value for key, value in PROFILE.items()):
            continue  # Preserve checkpoints for the previous voice without reusing them.
        if not path.exists() or digest(path.read_bytes()) != record["sha256"]:
            raise ValueError("Invalid pending recording; refusing regeneration")
        inspect_mp3(path)
        tag = path.parent.name
        existing = json.loads(gh("release", "view", tag, "--repo", repo, "--json", "assets").stdout)
        if any(asset["name"] == path.name for asset in existing["assets"]):
            with tempfile.TemporaryDirectory() as directory:
                gh("release", "download", tag, "--repo", repo, "--pattern", path.name, "--dir", directory)
                if digest((Path(directory) / path.name).read_bytes()) != record["sha256"]:
                    raise ValueError("Remote verse differs from pending recording")
        else:
            upload(tag, path, repo)
        path.unlink()
        receipt.unlink()
        path.with_suffix(".request.json").unlink(missing_ok=True)


def overwrite_session(output, repo, selection):
    """Resume interrupted replacements; start a fresh revision after completion."""
    path = Path(output) / "pending" / "overwrites.json"
    sessions = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    key = digest({"repo": repo, **PROFILE, "selection": [
        {"book": book["number"], "chapter": chapter["number"],
         "verses": [{"number": v["number"], "text": clean(v["text"])} for v in chapter["verses"]]}
        for book, chapter in selection]})
    if key not in sessions or sessions[key].get("complete"):
        sessions[key] = {"revision": uuid.uuid4().hex, "complete": False}
        write_json(path, sessions)
    return path, sessions, key


def main():
    global DEADLINE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["estimate", "dispatch", "matrix", "generate", "publish", "prepare", "preflight"])
    parser.add_argument("--source", default=str(Path(__file__).with_name("reformationsbibeln.json")))
    parser.add_argument("--books", default="")
    parser.add_argument("--chapters", default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--repo", default=REPO)
    parser.add_argument("--output", default="generated")
    parser.add_argument("--catalog", default="catalog.json")
    parser.add_argument("--replace-legacy", action="store_true")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing audio for the selected chapters")
    parser.add_argument("--migration", default="migration-jessica.json")
    parser.add_argument("--max-seconds", type=int, default=18000)
    parser.add_argument("--shard", type=int)
    parser.add_argument("--shard-size", type=int, default=25)
    parser.add_argument("--revision", default="", help="Optional resume ID; only valid with --overwrite")
    args = parser.parse_args()
    if args.command == "preflight":
        preflight()
        return
    if args.revision and not args.overwrite:
        parser.error("--revision requires --overwrite")
    if args.shard_size < 1 or (args.shard is not None and args.shard < 0):
        parser.error("Shard size must be positive and shard index nonnegative")
    if args.command == "publish":
        publish(args.output, args.catalog)
        return
    if args.command == "prepare":
        if args.replace_legacy:
            prepare_migration(args.catalog, args.migration)
        return
    if not Path(args.source).exists():
        args.source = str(Path(__file__).parents[2] / "assets/bible/reformationsbibeln.json")
    data = load_source(args.source)
    selection = [] if args.command == "dispatch" and args.replace_legacy else migration_selection(data, args.migration) if args.replace_legacy else select(data, args.books, args.chapters, args.all)
    if args.command == "estimate":
        texts = [clean(v["text"]) for _, c in selection for v in c["verses"]]
        count = sum(map(len, texts))
        print(json.dumps({"chapters": len(selection), "verses": len(texts), "characters": count, "model": MODEL, "voice": VOICE, "overwrite": args.overwrite, "note": "Credits depend on your ElevenLabs plan; counts include already generated verses."}))
    elif args.command == "dispatch":
        request_id = uuid.uuid4().hex[:12]
        inputs = {"books": args.books, "chapters": args.chapters, "entire": str(args.all).lower(), "revision": args.revision, "request_id": request_id, "replace_legacy": str(args.replace_legacy).lower(), "overwrite": str(args.overwrite).lower()}
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
        recover_pending(args.output, args.repo)
        preflight()
        DEADLINE = time.monotonic() + args.max_seconds
        selected_shard = selection if args.shard is None else selection[args.shard * args.shard_size:(args.shard + 1) * args.shard_size]
        session = overwrite_session(args.output, args.repo, selected_shard) if args.overwrite and not args.revision else None
        revision = session[1][session[2]]["revision"] if session else args.revision
        for book, chapter in selected_shard:
            try:
                generate_chapter(data, book, chapter, args.repo, args.output, revision, overwrite=args.overwrite)
            except GenerationPaused as error:
                summary(str(error))
                raise SystemExit(2) from None
            except Exception as error:
                summary(f"Stopped at {book['number']}:{chapter['number']}. Completed verses are preserved. {error}")
                raise
        if session:
            path, sessions, key = session
            sessions[key]["complete"] = True
            write_json(path, sessions)
        summary(f"Finished selection: {len(selected_shard)} chapters. {'Replacement audio is ready.' if args.overwrite else 'Existing recordings were reused.'}")


if __name__ == "__main__":
    main()
