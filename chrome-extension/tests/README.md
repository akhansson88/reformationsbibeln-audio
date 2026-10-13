# Verification

Install development dependencies with `npm ci` from `chrome-extension`.
`npm run build` rebuilds the locally packaged Firebase SDK.
`npm test` runs 34 tests of core playback, DOM integration, reporting UI,
validation and actual bundled Firebase client requests with mock server responses.

`node --test tests/dom.test.cjs` uses jsdom.
It runs the shipped adapter, content bridge, player and service worker against
DOM fixtures and a controlled media model. It verifies their integration and
state transitions, but does not verify real Chrome audio decoding, autoplay
policy, extension permissions or rendered layout.

`npm run test:rules` runs nine Firestore Security Rules tests in the official
emulator with a demo project, never the production Firebase project. Java 21
is required. They verify authenticated create-only reporting, required
descriptions when no words are selected, Unicode whitespace, exact audio
references, private receipts, canonical chapter boundaries and long selections.

Build-environment verification: 34 local tests and nine emulator tests pass.
The two live Psalm 117 MP3s also pass SHA-256 and FFprobe decoding checks.
The local execution environment blocks Chromium's socket creation; the
repository's `Chrome extension` workflow runs the real-browser suite in GitHub
Actions. It also rebuilds the SDK and rules and checks that generated files match.

`npm run test:browser` runs an unpacked extension in a separate Chromium
profile. After `npm ci`, run
`npx playwright install chromium`. FFmpeg and FFprobe must be installed. You can alternatively set
`RB_CHROMIUM_EXECUTABLE` to a full Chromium executable. The runtime used to
build this package resolves Playwright from `CODEX_PRIMARY_RUNTIME_NODE_MODULES`.

The browser suite serves fixtures through intercepted HTTPS URLs. Its HTML
reproduces the DOM structures observed on both Bibelonline pages. MP3 test
audio is generated locally with FFmpeg. All remote audio/catalog URLs are mocked;
there are no TTS requests. The suite verifies full chapter prefetch, playback,
verse highlighting, tooltip and seeking, follow controls, both loop modes,
next-chapter continuation, manual navigation stop, missing/corrupt media and
mobile-width player layout.
It also checks the report dialog, verse text without Strongs numbers, word
selection, required descriptions, Firebase request payloads, retry after an
error, success only after acknowledgement and dialog sizing in a narrow window.
Authentication and database requests are mocked; no real user accounts or
production reports are created. CI disables autoplay heuristics with a browser
flag to exercise automatic chapter continuation. The separate media-model test
verifies the UI's manual-play fallback when Chrome raises `NotAllowedError`.

Screenshots and the report are written to a temporary output directory or
`RB_TEST_OUTPUT` when specified. Test fixtures do not get included in the ZIP.
