# Reformationsbibeln audio

One MP3 per verse, generated with ElevenLabs `eleven_v4` and voice
`qAZH0aMXY8tw1QufPN0D`. Swedish, MP3 44.1 kHz/128 kbps, stability 0.5,
similarity 0.75. Asterisks and Markdown heading markers are removed before speech.

## Generate in the background

Repository: https://github.com/akhansson88/reformationsbibeln-audio

Add `ELEVENLABS_API_KEY` in repository Settings > Secrets and variables > Actions.
The key needs access to Text to Speech, the selected voice, and model/voice reads.
Never paste keys into workflow inputs, source files, or issue comments.

Open Actions > Generate verse audio > Run workflow. Choose books and chapters,
leave chapters blank for every chapter in those books, or select Entire Bible
and clear books/chapters. Closing the browser does not stop the workflow.

For the command line, install Python 3.12+ and GitHub CLI (`gh auth login`). From
Koino, use `python scripts/bible-audio/audio.py`; inside this repository, use
`python audio.py`. Estimates and dispatch do not need an ElevenLabs credential.

```sh
python audio.py estimate --books John --chapters 1-3
python audio.py dispatch --books John --chapters 1-3
python audio.py dispatch --books 'John,Romans'
python audio.py dispatch --books 'Första Moseboken' --chapters '1-3,5'
python audio.py dispatch --all
python audio.py dispatch --replace-legacy
python audio.py dispatch --books John --chapters 1 --overwrite
```

Estimates show text counts including existing recordings. Credit usage depends on
your ElevenLabs subscription. The workflow verifies the exact model and voice;
it never silently falls back to another model. For local generation also install
FFmpeg and expose `ELEVENLABS_API_KEY` in your environment. No Python SDK is needed.

## Overwrite existing audio

Select **Overwrite existing audio** in Run workflow or pass `--overwrite` to
`dispatch`/`generate`. It generates new recordings for the selected chapters,
even when the voice and text match. Each replacement has a new revision; the
catalog switches only after a complete chapter is uploaded and validated.
Existing releases remain available, and ordinary runs reuse the latest audio.

An interrupted overwrite resumes the same revision when rerun with the same
selection and option. Completed verses are reused without another speech request.
After that selection finishes, selecting overwrite again starts a new replacement.
Normally leave `revision` blank; an explicit resume ID requires `--overwrite`.
The pending-audio checkpoint preserves automatic resume IDs for 90 days.

## Replace legacy OpenAI audio

Choose **Replace legacy audio** (or `--replace-legacy`). This ignores the book and
chapter fields. Before hiding anything, the workflow saves the old entries and
manifests in `migration-jessica.json`, then removes legacy chapters from the public
catalog. Each chapter becomes playable again only after all its selected-voice verses
are uploaded and validated. Old release assets remain available for recovery.
Rerun the same migration option to continue, even though the old chapters are
no longer listed. Completed chapters for the selected voice and verses are reused.

## Credits, interruptions, and recovery

The workflow runs one generator at a time. Each verse is decoded and uploaded
immediately before the next paid request. The public `catalog.json` contains only
complete chapters; `chapter.json` is uploaded only when every verse is ready.

If credits run out, generation stops with a resume point in the Actions summary.
Completed verses stay in GitHub releases, and completed chapters are published
even though the generation step reports failure. Refill credits and **run the
workflow again with the same inputs**. Existing matching audio is not charged for
again. The workflow also stops gracefully after five hours; rerun to continue.

If GitHub uploads fail, completed local MP3s, checksums, and pending request markers
are saved in a `pending-audio` Actions artifact. The next run restores the latest
checkpoint and retries uploads before contacting ElevenLabs. These fallback
artifacts last 90 days; uploaded release assets do not expire. Download the artifact
if you need to preserve an upload failure longer. Avoid cancelling runs while
speech is being generated; forced runner termination can prevent artifact saving.

An uncertain speech response (connection loss/server failure) leaves a request
marker. The generator stops instead of blindly paying for the same verse again.
Recover the corresponding recording from ElevenLabs history, validate it, and
place it at the marker's matching `.mp3` path in the recovery checkpoint before
continuing. If no recording was created, verify that in ElevenLabs before removing
the marker. Corrupt existing recordings also stop generation for review.

Narration fingerprints include provider, exact model/voice, settings and text.
Legacy OpenAI recordings cannot be reused as recordings for the selected voice. Unchanged verses
can be reused across source revisions only when their full narration profile and
text match. Normally leave the `revision` field blank.

## Checks and playback

```sh
python -m unittest discover -s . -p 'test_*.py'
```

From Koino use `-s scripts/bible-audio`. Tests mock speech and publishing and spend
no credits. GitHub Actions needs contents-write and actions-read permissions.
Wait for an active generation to finish before dispatching another selection.

Koino downloads the whole selected chapter before starting its native TrackPlayer
queue. Catalog refreshes on startup and foregrounding withdraw old revisions and
stop their sessions; offline clients receive withdrawals after reconnecting.
The small player always exposes Follow spoken verse, including while paused.
Both close buttons stop playback and clear the session.

Native background playback requires the existing runtime 1.3.0 build, not Expo Go.
These voice/Follow changes do not add a new native dependency. Verify screen-lock
playback on physical iPhone and Android hardware. A powered-off phone cannot play.

The source snapshot retains its original metadata (Reformationsbibeln 2016);
Koino's translation ID is `reformationsbibeln2026`. Source:
https://bibelonline.se/studyb.php and https://bibelonline.se/biblereader.php.
This repository does not grant a new license over the Bible text. Narration is AI.
