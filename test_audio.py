import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

import audio


class AudioTests(unittest.TestCase):
    def setUp(self):
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

    def test_failed_verse_does_not_publish_manifest(self):
        def github(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout='{"assets": []}')
        with tempfile.TemporaryDirectory() as temp, patch.object(audio, "gh", side_effect=github) as github_mock, patch.object(audio, "synthesize", side_effect=RuntimeError("interrupted")):
            with self.assertRaises(RuntimeError):
                audio.generate_chapter(self.data, self.book, self.book["chapters"][0], audio.REPO, temp)
            self.assertFalse(list(Path(temp).glob("*.json")))
            self.assertFalse(any(call.args[:2] == ("release", "upload") for call in github_mock.call_args_list))

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
