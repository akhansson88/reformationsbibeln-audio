import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import shutil
import subprocess
import sys
import io
import unittest
from unittest.mock import patch

import audio


class AudioTests(unittest.TestCase):
    def setUp(self):
        previous = patch.object(audio, "previous_verses", return_value={})
        self.previous = previous.start()
        self.addCleanup(previous.stop)
        self.book = {"number": 43, "name": "Johannesevangeliet", "abbreviation": "Joh.", "chapters": [{"number": 1, "verses": [{"number": 1, "text": "I begynnelsen* var Ordet.**"}, {"number": 2, "text": "Ordet var hos Gud."}]}]}
        self.data = {"translation": "Reformationsbibeln 2016", "books": [self.book]}

    def test_cleaning_preserves_swedish(self):
        self.assertEqual(audio.clean("  Gud**\n älskar* världen. #"), "Gud älskar världen.")

    def test_selection_aliases_ranges_and_invalid_input(self):
        for name in ["John", "43", "Johannesevangeliet", "Joh."]:
            self.assertEqual(len(audio.select(self.data, name, "1")), 1)
        for books, chapters, entire in [("John", "2", False), ("unknown", "", False), ("John", "0", False), ("John", "1", True), ("", "", False)]:
            with self.assertRaises(ValueError):
                audio.select(self.data, books, chapters, entire)

    def test_resume_skips_synthesis_and_complete_manifest(self):
        assets = {"verse-001.mp3": b"existing verse", "verse-002.mp3": b"existing verse"}
        def github(*args, **kwargs):
            if args[:2] == ("release", "view"):
                return SimpleNamespace(returncode=0, stdout=json.dumps({"assets": [{"name": name} for name in assets]}))
            if args[:2] == ("release", "download"):
                name = args[args.index("--pattern") + 1]
                (Path(args[args.index("--dir") + 1]) / name).write_bytes(assets[name])
            return SimpleNamespace(returncode=0, stdout="")
        with tempfile.TemporaryDirectory() as temp, patch.object(audio, "gh", side_effect=github), patch.object(audio, "inspect_mp3", return_value=2.5), patch.object(audio, "synthesize") as synthesize:
            audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, temp)
            synthesize.assert_not_called()
            manifest = json.loads((Path(temp) / "43-001.json").read_text(encoding="utf-8"))
            self.assertEqual([v["verse"] for v in manifest["verses"]], [1, 2])
            self.assertEqual(manifest["verses"][0]["sha256"], audio.digest(assets["verse-001.mp3"]))

    def test_complete_chapter_skips_every_speech_request(self):
        verses = [{"verse": 1, "text": audio.clean(self.book["chapters"][0]["verses"][0]["text"])}, {"verse": 2, "text": audio.clean(self.book["chapters"][0]["verses"][1]["text"])}]
        source_hash = audio.digest(verses)
        generation = audio.digest({"source": source_hash, "model": audio.MODEL, "voice": audio.VOICE, "speed": 1, "format": "mp3", "revision": ""})[:20]
        tag = f"audio-43-001-{generation}"
        manifest = {"schemaVersion": 1, "translation": audio.VERSION, "sourceLabel": self.data["translation"], "sourceHash": source_hash, "revision": generation, "model": audio.MODEL, "voice": audio.VOICE, "bookId": 43, "book": "John", "bookName": self.book["name"], "chapter": 1, "expectedVerses": [1, 2], "verses": []}
        for verse in verses:
            manifest["verses"].append({"verse": verse["verse"], "url": f"https://github.com/{audio.REPO}/releases/download/{tag}/verse-{verse['verse']:03d}.mp3", "duration": 2.5, "sha256": "a" * 64, "textHash": audio.digest(verse["text"])})

        def github(*args, **kwargs):
            if args[:2] == ("release", "view"):
                return SimpleNamespace(returncode=0, stdout=json.dumps({"assets": [{"name": name} for name in ["chapter.json", "verse-001.mp3", "verse-002.mp3"]]}))
            if args[:2] == ("release", "download"):
                (Path(args[args.index("--dir") + 1]) / "chapter.json").write_text(json.dumps(manifest), encoding="utf-8")
            return SimpleNamespace(returncode=0, stdout="")

        with tempfile.TemporaryDirectory() as temp, patch.object(audio, "gh", side_effect=github) as github_mock, patch.object(audio, "synthesize") as synthesize, patch.object(audio, "inspect_mp3") as inspect:
            audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, temp)
            synthesize.assert_not_called()
            inspect.assert_not_called()
            calls = [call.args[:2] for call in github_mock.call_args_list]
            self.assertEqual(calls, [("release", "view"), ("release", "download")])
            output = json.loads((Path(temp) / "43-001.json").read_text(encoding="utf-8"))
            self.assertEqual(output["manifestUrl"], f"https://github.com/{audio.REPO}/releases/download/{tag}/chapter.json")

    def test_changed_source_does_not_reuse_completed_manifest(self):
        self.assertFalse(audio.complete_manifest({}, book=self.book, chapter=self.book["chapters"][0], source_hash="new", generation="new", repo=audio.REPO, tag="tag", numbers=[1, 2]))

    def test_revision_cannot_force_duplicate_audio(self):
        with patch.object(audio, "gh") as github, patch.object(audio, "synthesize") as synthesize:
            with self.assertRaisesRegex(ValueError, "Regeneration is disabled"):
                audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, "unused", "new")
            github.assert_not_called()
            synthesize.assert_not_called()

    def test_existing_corrupt_audio_is_not_automatically_regenerated(self):
        def github(*args, **kwargs):
            if args[:2] == ("release", "view"):
                return SimpleNamespace(returncode=0, stdout='{"assets":[{"name":"verse-001.mp3"}]}')
            if args[:2] == ("release", "download"):
                (Path(args[args.index("--dir") + 1]) / "verse-001.mp3").write_bytes(b"corrupt")
        with tempfile.TemporaryDirectory() as temp, patch.object(audio, "gh", side_effect=github), patch.object(audio, "inspect_mp3", side_effect=ValueError("corrupt")), patch.object(audio, "synthesize") as synthesize:
            with self.assertRaisesRegex(ValueError, "refusing to regenerate"):
                audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, temp)
            synthesize.assert_not_called()

    def test_unchanged_verses_reused_across_chapter_revisions(self):
        payload = b"previous recording"
        self.previous.return_value = {v["number"]: {"textHash": audio.digest(audio.clean(v["text"])), "sha256": audio.digest(payload), "url": f"https://github.com/{audio.REPO}/releases/download/old/verse.mp3"} for v in self.book["chapters"][0]["verses"]}
        with tempfile.TemporaryDirectory() as temp, patch.object(audio, "gh", return_value=SimpleNamespace(returncode=0, stdout='{"assets":[]}')), patch.object(audio.urllib.request, "urlopen", side_effect=lambda *a, **k: io.BytesIO(payload)), patch.object(audio, "inspect_mp3", return_value=2), patch.object(audio, "synthesize") as synthesize:
            audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, temp)
            synthesize.assert_not_called()
            manifest = json.loads((Path(temp) / "43-001.json").read_text(encoding="utf-8"))
            self.assertEqual(len(manifest["verses"]), 2)

    def test_failed_verse_does_not_publish_manifest(self):
        def github(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout='{"assets": []}')
        with tempfile.TemporaryDirectory() as temp, patch.object(audio, "gh", side_effect=github) as github_mock, patch.object(audio, "synthesize", side_effect=RuntimeError("interrupted")):
            with self.assertRaises(RuntimeError):
                audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, temp)
            self.assertFalse(list(Path(temp).glob("*.json")))
            self.assertFalse(any(call.args[:2] == ("release", "upload") for call in github_mock.call_args_list))

    def test_speech_retry_is_bounded_and_auth_errors_are_not_retried(self):
        class ConnectionError(Exception):
            pass
        class StatusError(Exception):
            def __init__(self, status):
                self.status_code = status
        for code, expected_calls in [(429, 6), (503, 6), (401, 1)]:
            from unittest.mock import Mock
            create = Mock(side_effect=StatusError(code))
            client = SimpleNamespace(audio=SimpleNamespace(speech=SimpleNamespace(with_streaming_response=SimpleNamespace(create=create))))
            module = SimpleNamespace(OpenAI=lambda **kwargs: client, APIConnectionError=ConnectionError, APIStatusError=StatusError)
            with patch.dict(sys.modules, {"openai": module}), patch.object(audio.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, str(code)):
                    audio.synthesize("Text", Path("unused.mp3"))
            self.assertEqual(create.call_count, expected_calls)

    def test_publisher_preserves_existing_chapters(self):
        manifest = {"translation": audio.VERSION, "bookId": 43, "book": "John", "bookName": "Johannesevangeliet", "chapter": 1, "revision": "revision", "sourceHash": "source", "manifestUrl": "https://example.test/chapter.json", "expectedVerses": [1], "verses": [{"verse": 1}]}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            audio.write_json(root / "catalog.json", {"schemaVersion": 1, "translation": audio.VERSION, "chapters": {"1:1": {"existing": True}}})
            audio.write_json(root / "generated/43-001.json", manifest)
            with patch.object(audio.urllib.request, "urlopen", return_value=io.StringIO(json.dumps(manifest))):
                audio.publish(root / "generated", root / "catalog.json")
            catalog = json.loads((root / "catalog.json").read_text(encoding="utf-8"))
            self.assertEqual(catalog["chapters"]["1:1"], {"existing": True})
            self.assertEqual(catalog["chapters"]["43:1"]["revision"], "revision")
            self.assertNotIn("verses", catalog["chapters"]["43:1"], "catalog should stay small")

    def test_publisher_rejects_incomplete_chapter_without_changing_catalog(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "generated"
            audio.write_json(root / "catalog.json", {"chapters": {"existing": True}})
            audio.write_json(output / "partial.json", {"translation": audio.VERSION, "expectedVerses": [1, 2], "verses": [{"verse": 1}]})
            with self.assertRaises(ValueError):
                audio.publish(output, root / "catalog.json")
            self.assertEqual(json.loads((root / "catalog.json").read_text())["chapters"], {"existing": True})

    def test_source_counts_and_model_input_lengths(self):
        source = Path(__file__).with_name("reformationsbibeln.json")
        if not source.exists():
            source = Path(__file__).parents[2] / "assets/bible/reformationsbibeln.json"
        data = audio.load_source(source)
        selection = audio.select(data, entire=True)
        texts = [audio.clean(v["text"]) for _, c in selection for v in c["verses"]]
        self.assertEqual(len(selection), 1189)
        self.assertEqual(len(texts), 31170)
        self.assertTrue(all(0 < len(text) <= 4096 and "*" not in text for text in texts))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is not installed")
    def test_real_decoder_accepts_mp3_and_rejects_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "verse.mp3"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", str(path)], check=True)
            self.assertGreater(audio.inspect_mp3(path), 0)
            path.write_bytes(b"not an MP3")
            with self.assertRaises(subprocess.CalledProcessError):
                audio.inspect_mp3(path)


if __name__ == "__main__":
    unittest.main()
