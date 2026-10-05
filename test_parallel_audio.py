"""Exercise real request admission and recovery with mocked provider/GitHub I/O."""
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

import audio


class Response(io.BytesIO):
    def __init__(self, content, headers=None):
        super().__init__(content)
        self.headers = headers or {}


def rejection(code, status, headers=None):
    return urllib.error.HTTPError("https://example.test", code, "Rejected", headers or {},
                                  io.BytesIO(json.dumps({"detail": {"status": status}}).encode()))


class Releases:
    def __init__(self):
        self.assets = {}
        self.lock = threading.Lock()
        self.failed_uploads = False

    def __call__(self, *args, **kwargs):
        tag = args[2]
        with self.lock:
            files = self.assets.setdefault(tag, {})
            if args[:2] == ("release", "view"):
                return SimpleNamespace(returncode=0, stdout=json.dumps({"assets": [{"name": n} for n in files]}))
            if args[:2] == ("release", "download"):
                name = args[args.index("--pattern") + 1]
                (Path(args[args.index("--dir") + 1]) / name).write_bytes(files[name])
            if args[:2] == ("release", "upload"):
                if self.failed_uploads:
                    raise RuntimeError("Upload unavailable")
                path = Path(args[3])
                files[path.name] = path.read_bytes()
        return SimpleNamespace(returncode=0, stdout="")


class ParallelAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.releases = Releases()
        self.chapter = {"number": 1, "verses": [{"number": n, "text": f"Verse {n}."} for n in range(1, 9)]}
        self.book = {"number": 43, "name": "Johannesevangeliet", "chapters": [self.chapter]}
        self.data = {"translation": "Test source", "books": [self.book]}
        for target, options in [("gh", {"side_effect": self.releases}),
                                ("previous_manifest", {"return_value": None}),
                                ("previous_verses", {"return_value": {}}),
                                ("inspect_mp3", {"return_value": 1.5})]:
            mock = patch.object(audio, target, **options)
            mock.start()
            self.addCleanup(mock.stop)

    def generate(self, control, *, revision="", overwrite=False):
        audio.generate_chapter(self.data, self.book, self.chapter, audio.REPO, self.root,
                               revision, overwrite=overwrite, control=control)

    def assert_incomplete(self):
        self.assertFalse((self.root / "43-001.json").exists())
        self.assertTrue(all("chapter.json" not in files for files in self.releases.assets.values()))

    def test_worker_values_rejected_before_any_io(self):
        for value in ("0", "16", "-1", "2.5", "", "automatic"):
            with self.subTest(value=value), patch.object(sys, "argv", ["audio.py", "generate", "--all", "--workers", value]), patch.object(audio, "eleven_request") as request, patch.object(audio, "recover_pending") as recovery, patch.object(sys, "stderr", io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    audio.main()
                self.assertEqual(error.exception.code, 2)
                request.assert_not_called()
                recovery.assert_not_called()
        self.assertEqual(audio.worker_setting(" AUTO "), "auto")
        self.assertEqual(audio.worker_setting(" 15 "), "15")

    def test_automatic_limits_and_throttle_recovery(self):
        control = audio.RunControl()
        self.assertEqual(control.target, 2)
        for headers in ({}, {"maximum-concurrent-requests": "invalid"}, {"maximum-concurrent-requests": "0"}):
            control.succeeded(headers)
            self.assertEqual(control.target, 2)
        control.succeeded({"maximum-concurrent-requests": "100"})
        self.assertEqual(control.target, 15)
        control.succeeded({"maximum-concurrent-requests": "5"})
        self.assertEqual(control.target, 5)
        control.throttled()
        self.assertEqual(control.target, 2)
        for _ in range(9):
            control.succeeded({"maximum-concurrent-requests": "5"})
        self.assertEqual(control.target, 2)
        control.succeeded({})
        self.assertEqual(control.target, 3)
        fixed = audio.RunControl("3")
        fixed.succeeded({"maximum-concurrent-requests": "15"})
        self.assertEqual(fixed.target, 3)
        fixed.throttled()
        fixed.throttled()
        self.assertEqual(fixed.target, 1)
        for _ in range(20):
            fixed.succeeded({})
        self.assertEqual(fixed.target, 3)

    def test_retry_after_seconds_and_date(self):
        self.assertEqual(audio.retry_delay({"Retry-After": "7.5"}, 0), 7.5)
        with patch.object(audio.time, "time", return_value=1000):
            self.assertEqual(audio.retry_delay({"Retry-After": formatdate(1009, usegmt=True)}, 0), 9)
        self.assertEqual(audio.retry_delay({"Retry-After": "bad date"}, 2), 8)

    def test_parallel_speech_is_bounded_and_manifest_order_is_stable(self):
        # An actual rendezvous proves concurrency without relying on elapsed time.
        barrier = threading.Barrier(3, timeout=5)
        calls, completion_order = [], []
        lock = threading.Lock()
        first_finished = threading.Event()
        control = audio.RunControl("3")

        def speech(endpoint, payload):
            number = int(payload["text"].split()[1].rstrip("."))
            with lock:
                calls.append(number)
            if number <= 3:
                barrier.wait()
            if number == 1:
                self.assertTrue(first_finished.wait(5))
            else:
                first_finished.set()
            with lock:
                completion_order.append(number)
            return Response(payload["text"].encode())

        with patch.object(audio, "eleven_request", side_effect=speech):
            self.generate(control)
        manifest = json.loads((self.root / "43-001.json").read_text())
        self.assertEqual([v["verse"] for v in manifest["verses"]], list(range(1, 9)))
        self.assertNotEqual(completion_order[0], 1)
        self.assertEqual(sorted(calls), list(range(1, 9)))
        self.assertEqual(control.peak, 3)
        self.assertEqual((control.verses, control.chapters), (8, 1))
        self.assertFalse(list(self.root.rglob("*.request.json")))
        count = len(calls)
        with patch.object(audio, "eleven_request", side_effect=speech):
            self.generate(audio.RunControl("1"))
        self.assertEqual(len(calls), count, "changing workers must not change the audio revision")

    def test_auto_adapts_from_two_to_provider_limit(self):
        control = audio.RunControl()
        initial = threading.Barrier(2, timeout=5)
        expanded = threading.Barrier(4, timeout=5)
        lock = threading.Lock()
        calls = 0

        def speech(endpoint, payload):
            nonlocal calls
            with lock:
                calls += 1
                number = calls
            if number <= 2:
                initial.wait()
            elif number <= 6:
                expanded.wait()
            return Response(payload["text"].encode(), {"maximum-concurrent-requests": "4"})

        with patch.object(audio, "eleven_request", side_effect=speech):
            self.generate(control)
        self.assertEqual(control.target, 4)
        self.assertEqual(control.peak, 4)

    def test_quota_stops_new_requests_and_drains_inflight_before_resume(self):
        control = audio.RunControl("2")
        both_started = threading.Barrier(2, timeout=5)
        lock = threading.Lock()
        calls = []
        successful = []

        def speech(endpoint, payload):
            with lock:
                calls.append(payload["text"])
                number = len(calls)
            both_started.wait()
            if number == 1:
                raise rejection(402, "quota_exceeded")
            with control.condition:
                self.assertTrue(control.condition.wait_for(lambda: control.error is not None, timeout=5))
            successful.append(payload["text"])
            return Response(payload["text"].encode())

        # An overwrite keeps the same session/release on a different worker setting.
        session = audio.overwrite_session(self.root, audio.REPO, [(self.book, self.chapter)])
        revision = session[1][session[2]]["revision"]
        with patch.object(audio, "eleven_request", side_effect=speech):
            with self.assertRaises(audio.GenerationPaused):
                self.generate(control, revision=revision, overwrite=True)
        self.assertEqual(len(calls), 2)
        self.assert_incomplete()
        self.assertEqual(control.verses, 1)
        self.assertFalse(list(self.root.rglob("*.request.json")), "provider rejections are safe to retry")
        resumed = audio.overwrite_session(self.root, audio.REPO, [(self.book, self.chapter)])
        self.assertEqual(resumed[1][resumed[2]]["revision"], revision)
        with patch.object(audio, "eleven_request", side_effect=lambda endpoint, payload: Response(payload["text"].encode())) as request:
            self.generate(audio.RunControl("5"), revision=revision, overwrite=True)
        self.assertEqual(request.call_count, 7)
        self.assertNotIn(successful[0], [c.args[1]["text"] for c in request.call_args_list])
        self.assertEqual(len(self.releases.assets), 1)

    def test_deadline_preserves_inflight_audio_and_existing_chapters(self):
        control = audio.RunControl("2")
        barrier = threading.Barrier(2, timeout=5)
        audio.write_json(self.root / "43-000.json", {"completed": True})

        def speech(endpoint, payload):
            barrier.wait()
            with control.condition:
                control.deadline = time.monotonic() - 1
            return Response(payload["text"].encode())

        with patch.object(audio, "eleven_request", side_effect=speech) as request:
            with self.assertRaisesRegex(audio.GenerationPaused, "Time budget"):
                self.generate(control)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(control.verses, 2)
        self.assert_incomplete()
        self.assertTrue((self.root / "43-000.json").exists())
        self.assertFalse(list(self.root.rglob("*.request.json")))

    def test_uncertain_request_retains_marker_and_blocks_parallel_rerun(self):
        for failure in (TimeoutError("Connection lost"), rejection(503, "server_error")):
            with self.subTest(failure=type(failure).__name__):
                # Use a fresh chapter so the previous scenario cannot supply assets.
                self.chapter["number"] += 1
                self.chapter["verses"] = [{"number": 1, "text": "First."}, {"number": 2, "text": "Second."}]
                with patch.object(audio, "eleven_request", side_effect=failure) as request:
                    with self.assertRaises((TimeoutError, RuntimeError)):
                        self.generate(audio.RunControl("1"))
                self.assertEqual(request.call_count, 1)
                markers = list(self.root.rglob("*.request.json"))
                self.assertTrue(markers)
                # Move the uncertain marker to a later verse: pre-scan still blocks all requests.
                markers[-1].rename(markers[-1].with_name("verse-002.request.json"))
                with patch.object(audio, "eleven_request") as request:
                    with self.assertRaisesRegex(RuntimeError, "Uncertain previous speech request"):
                        self.generate(audio.RunControl("5"))
                    request.assert_not_called()

    def test_failed_upload_keeps_receipt_and_never_resynthesizes(self):
        self.chapter["verses"] = self.chapter["verses"][:3]
        barrier = threading.Barrier(3, timeout=5)
        self.releases.failed_uploads = True

        def speech(endpoint, payload):
            barrier.wait()
            return Response(payload["text"].encode())

        with patch.object(audio, "eleven_request", side_effect=speech) as request, patch.object(audio.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "Upload unavailable"):
                self.generate(audio.RunControl("3"))
        self.assertEqual(request.call_count, 3)
        self.assertEqual(len(list(self.root.rglob("*.receipt.json"))), 3)
        self.assert_incomplete()
        self.releases.failed_uploads = False
        with patch.object(audio, "eleven_request") as request:
            self.generate(audio.RunControl("2"))
            request.assert_not_called()
        self.assertFalse(list(self.root.rglob("*.receipt.json")))
        self.assertTrue((self.root / "43-001.json").exists())

    def test_429_is_bounded_and_honors_backoff_without_leaving_uncertain_marker(self):
        control = audio.RunControl("4")
        path = self.root / "verse.mp3"
        with patch.object(audio, "eleven_request", side_effect=lambda *args: (_ for _ in ()).throw(rejection(429, "too_many_concurrent_requests", {"Retry-After": "3"}))) as request, patch.object(control, "backoff") as backoff:
            with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
                audio.synthesize("Text", path, control=control)
        self.assertEqual(request.call_count, 6)
        self.assertEqual(backoff.call_count, 5)
        self.assertTrue(all(c.args == (3.0,) for c in backoff.call_args_list))
        self.assertEqual(control.target, 1)
        self.assertFalse(path.with_suffix(".request.json").exists())

    def test_waiting_request_and_backoff_wake_when_run_stops(self):
        control = audio.RunControl("1")
        waiting = threading.Barrier(3, timeout=5)

        def wait_for_slot():
            waiting.wait()
            with control.request():
                self.fail("Stopped run admitted a new request")

        def wait_for_retry():
            waiting.wait()
            control.backoff(120)

        with control.request(), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(wait_for_slot), pool.submit(wait_for_retry)]
            waiting.wait()
            control.stop(audio.GenerationPaused("Stop"))
            for future in futures:
                with self.assertRaises(audio.GenerationStopped):
                    future.result(timeout=5)


if __name__ == "__main__":
    unittest.main()
