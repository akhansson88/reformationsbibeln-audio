# Verification

`node --test tests/core.test.cjs` uses Node's standard library only.

`node --test tests/dom.test.cjs` uses jsdom (`npm install --no-save jsdom`).
It runs the shipped adapter, content bridge, player and service worker against
DOM fixtures and a controlled media model. It verifies their integration and
state transitions, but does not verify real Chrome audio decoding, autoplay
policy, extension permissions or rendered layout.

Build-environment verification: 9 core tests and 10 DOM/media-model tests pass.
The two live Psalm 117 MP3s also pass SHA-256 and FFprobe decoding checks.
The full Chrome suite could not start because the execution environment blocks
the local Chromium process's socket creation. Run it in an ordinary development
environment to complete real-browser verification.

`node tests/browser.cjs` runs an unpacked extension in a separate Chromium
profile. Install Playwright in your development environment and run
`npx playwright install chromium`. You can alternatively set
`RB_CHROMIUM_EXECUTABLE` to a full Chromium executable. The runtime used to
build this package resolves Playwright from `CODEX_PRIMARY_RUNTIME_NODE_MODULES`.

The browser suite serves fixtures through intercepted HTTPS URLs. Its HTML
reproduces the DOM structures observed on both Bibelonline pages. MP3 test
audio is generated locally with FFmpeg. All remote audio/catalog URLs are mocked;
there are no TTS requests. The suite verifies full chapter prefetch, playback,
verse highlighting, tooltip and seeking, follow controls, both loop modes,
next-chapter continuation, manual navigation stop, missing/corrupt media and
mobile-width player layout.

Screenshots and the report are written to a temporary output directory or
`RB_TEST_OUTPUT` when specified. Test fixtures do not get included in the ZIP.
