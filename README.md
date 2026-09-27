# Reformationsbibeln audio

One MP3 per verse, generated with OpenAI `tts-1-hd`, Onyx, speed 1.
The initial publication is John 1. Full-Bible generation is never automatic.

## Commands

Install Python 3.12+, GitHub CLI (`gh auth login`), FFmpeg, and the packages in
`requirements.txt`. Dispatch and estimate do not require the OpenAI package/key.
From Koino use `python scripts/bible-audio/audio.py`; from the audio repository use
`python audio.py`.

```sh
python audio.py estimate --books John --chapters 1
python audio.py dispatch --books John --chapters 1
python audio.py dispatch --books 'John,Romans'
python audio.py dispatch --books 'Första Moseboken' --chapters '1-3,5'
python audio.py estimate --all
python audio.py dispatch --all
```

The command returns the workflow page. Closing the terminal does not stop the run.
The Actions UI also accepts these selections. For `entire`, clear books/chapters.
The selected chapter range applies to each selected book; invalid chapters fail.

## Hosting and recovery

Repository: https://github.com/akhansson88/reformationsbibeln-audio

Actions requires an `OPENAI_API_KEY` repository secret and contents write access.
Never commit keys. `GITHUB_TOKEN` publishes releases and the catalog; no additional
GitHub token is needed in CI. The consumer needs no credentials.

Each chapter revision has a prerelease containing individual verse MP3s and a
`chapter.json`. The public `catalog.json` lists only fully validated chapters.
There are no chapter-length audio files. The source snapshot retains its original
metadata (Reformationsbibeln 2016); Koino's existing translation ID is
`reformationsbibeln2026`. Original text source: https://bibelonline.se/studyb.php
and https://bibelonline.se/biblereader.php. This repository does not grant a new
license over the source Bible text. Narration is AI-generated.

Run the same dispatch again after a failure: existing valid verse assets are
downloaded, checked, and reused. Completed chapters publish even if other chapters
fail. A new `--revision` value intentionally regenerates selected chapters; old
revisions remain available to listeners. Do not delete assets referenced by the
catalog or saved listening positions.

Large selections use 25-chapter shards with two concurrent workers. Workflow runs
are serialized to protect catalog updates. An interrupted run can resume with the
same inputs; cancelled jobs do not mark partial chapters complete. GitHub Actions
may replace an older pending run if several are queued: wait for the active run
before dispatching more work. Costs shown by `estimate` assume $30 per million
characters, excluding retries. Repeated synthesis after a network interruption
can incur additional charges.

## Checks

```sh
python -m unittest discover -s scripts/bible-audio -p 'test_*.py'
```

Inside the audio repo use `-s .`. Test data uses temporary directories and mocked
speech/publishing, so checks do not spend API credits.
