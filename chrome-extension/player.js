(() => {
  "use strict";
  const core = globalThis.RBAudioCore;
  const params = new URL(location.href).searchParams;
  const parentOrigin = params.get("origin"), token = params.get("session");
  const ui = Object.fromEntries(["chapter", "follow", "loop", "speed", "previous", "play", "play-symbol", "next", "verse", "time", "seek", "seek-wrap", "tooltip", "ticks", "volume", "status", "download", "retry", "progress"].map(id => [id, document.getElementById(id)]));
  const audio = new Audio(); audio.preload = "auto";
  let context = null, catalog = null, controller = null, tracks = [], clock = core.timeline([]), index = 0;
  let phase = "loading", loop = "off", follow = true, currentVerse = 0, pendingPlay = false, seeking = false;
  let operation = 0, transition = false, switchAbort = null, generation = 0, raf = null;
  let preferences = { follow: true, speed: 1, volume: 1 };
  function post(type, data = {}) {
    if (core.isSiteURL(parentOrigin)) parent.postMessage({ channel: "RB_AUDIO", token, type, ...data }, parentOrigin);
  }
  function status(text) { ui.status.textContent = text; }
  function setPhase(next) { phase = next; updateControls(); }
  function updateControls() {
    const ready = tracks.length > 0 && !["loading", "error"].includes(phase);
    ui.play.disabled = !ready;
    ui.seek.disabled = !ready;
    ui.previous.disabled = !ready || index === 0;
    ui.next.disabled = !ready || index === tracks.length - 1;
    const active = phase === "playing" || pendingPlay;
    ui["play-symbol"].textContent = active ? "Ⅱ" : "▶";
    ui.play.setAttribute("aria-label", active ? "Pausa" : "Spela"); ui.play.title = active ? "Pausa" : "Spela";
    ui.loop.textContent = loop === "verse" ? `Loop: vers ${tracks[index]?.verse || 1}` : loop === "chapter" ? "Loop: kapitel" : "Loop: av";
    ui.loop.setAttribute("aria-pressed", String(loop !== "off"));
    ui.follow.textContent = follow ? "Följ vers: på" : "Följ vers: av"; ui.follow.setAttribute("aria-pressed", String(follow));
  }
  function announceVerse() {
    const verse = tracks[index]?.verse;
    if (verse && verse !== currentVerse) { currentVerse = verse; post("VERSE", { verse, follow }); }
  }
  function drawTime(value = null) {
    if (!tracks.length) return;
    const seconds = value ?? Math.min(clock.total, clock.segments[index].start + (audio.currentTime || 0));
    const p = core.positionAt(clock, seconds);
    if (!seeking || value !== null) ui.seek.value = String(seconds);
    ui.verse.textContent = `Vers ${p.verse} av ${tracks.length}`;
    ui.time.textContent = `${core.formatTime(seconds)} / ${core.formatTime(clock.total)}`;
    ui.seek.setAttribute("aria-valuetext", `Vers ${p.verse}, ${core.formatTime(seconds)} av ${core.formatTime(clock.total)}`);
  }
  function animation() {
    if (phase === "playing" && !seeking && !transition) drawTime();
    raf = phase === "playing" ? requestAnimationFrame(animation) : null;
  }
  function startAnimation() { if (raf === null) raf = requestAnimationFrame(animation); }
  function releaseTracks() {
    audio.pause(); audio.removeAttribute("src"); audio.load();
    for (const track of tracks) URL.revokeObjectURL(track.blobURL);
    tracks = []; clock = core.timeline([]); currentVerse = 0;
    ui.ticks.replaceChildren(); ui.seek.value = "0"; ui.seek.max = "1";
    ui.time.textContent = "0:00 / 0:00"; ui.verse.textContent = "Vers –";
    post("CLEAR");
  }
  function stop() {
    generation++; operation++; controller?.abort(); switchAbort?.abort(); pendingPlay = false; transition = false;
    cancelAnimationFrame(raf); raf = null; releaseTracks(); setPhase("ready");
  }
  async function readJSON(url, signal) {
    return core.fetchResponse(url, signal, fetch, 3, response => response.json());
  }
  async function downloadVerse(verse, signal) {
    const bytes = await core.fetchResponse(verse.url, signal, fetch, 3, async response => {
      if (Number(response.headers.get("content-length")) > 16 * 1024 * 1024) throw Object.assign(new Error("En ljudfil är för stor."), { permanent: true });
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength || buffer.byteLength > 16 * 1024 * 1024) throw Object.assign(new Error("En ljudfil har felaktig storlek."), { permanent: true });
      return buffer;
    });
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
    if (signal.aborted) throw core.abortError();
    if (hash !== verse.sha256) throw new Error(`Ljudfilen för vers ${verse.verse} klarade inte integritetskontrollen.`);
    return { ...verse, bytes: bytes.byteLength, blobURL: URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })) };
  }
  async function loadChapter(c, autoplay = false, mappingComplete = true) {
    if (!core.validContext(c)) { status("Kunde inte identifiera kapitlet på sidan."); return; }
    stop(); context = c; index = 0; pendingPlay = false;
    const run = ++generation, control = controller = new AbortController(), allocated = [];
    const signal = control.signal;
    setPhase("loading"); ui.retry.hidden = true; ui.progress.hidden = false; ui.progress.value = 0;
    ui.download.textContent = ""; ui.chapter.textContent = core.chapterLabel(c); status("Förladdar hela kapitlet före uppspelning…");
    let count = 0, bytesTotal = 0;
    try {
      catalog = await readJSON(core.CATALOG_URL, signal);
      const entry = core.chapterEntry(catalog, c);
      if (!entry) { setPhase("error"); status("Ljud saknas för detta kapitel i ljudkatalogen."); ui.progress.hidden = true; ui.retry.hidden = false; return; }
      const manifest = await readJSON(entry.manifestUrl, signal);
      const verses = core.validateManifest(manifest, entry, c);
      ui.progress.max = verses.length;
      const result = await core.mapLimit(verses, 4, async verse => {
        const track = await downloadVerse(verse, signal);
        allocated.push(track);
        bytesTotal += track.bytes;
        if (bytesTotal > 256 * 1024 * 1024) throw new Error("Kapitlets ljudfiler är för stora.");
        if (generation === run) {
          count++; ui.progress.value = count; ui.download.textContent = `${count}/${verses.length} verser · ${Math.round(count / verses.length * 100)} %`;
        }
        return track;
      }, signal);
      if (signal.aborted || run !== generation) throw core.abortError();
      tracks = result; clock = core.timeline(result); ui.seek.max = String(clock.total);
      ui.progress.hidden = true; ui.download.textContent = `${verses.length} verser förladdade`;
      const fragment = document.createDocumentFragment();
      for (const s of clock.segments.slice(1)) { const tick = document.createElement("span"); tick.style.left = `${s.start / clock.total * 100}%`; fragment.append(tick); }
      ui.ticks.replaceChildren(fragment);
      setPhase("ready"); drawTime(0);
      status(mappingComplete ? "Klart att spela · Nästa kapitel fortsätter automatiskt" : "Ljudet är klart. Vissa verser kunde inte kopplas till sidans text.");
      if (autoplay) await playPosition(0, true);
    } catch (error) {
      const wasCanceled = signal.aborted || run !== generation;
      control.abort();
      // Other workers may be finishing their checksum when cancellation happens.
      for (const t of allocated) URL.revokeObjectURL(t.blobURL);
      if (wasCanceled) return;
      tracks = []; clock = core.timeline([]); setPhase("error"); ui.progress.hidden = true; ui.download.textContent = ""; ui.retry.hidden = false;
      status(`${error.name === "AbortError" ? "Det tog för lång tid att hämta ljudet." : error.message || "Kunde inte hämta ljudet."} Försök igen.`);
    }
  }
  function metadataReady(signal) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); audio.removeEventListener("loadedmetadata", loaded); audio.removeEventListener("error", failed); signal.removeEventListener("abort", canceled); error ? reject(error) : resolve(); };
      const loaded = () => finish();
      const failed = () => finish(new Error("Ljudfilen kunde inte spelas upp."));
      const canceled = () => finish(core.abortError());
      const timer = setTimeout(() => finish(new Error("Ljudspelaren svarade inte. Försök igen.")), 15000);
      audio.addEventListener("loadedmetadata", loaded, { once: true }); audio.addEventListener("error", failed, { once: true }); signal.addEventListener("abort", canceled, { once: true });
      if (signal.aborted) canceled();
    });
  }
  async function playPosition(seconds, play = phase === "playing" || pendingPlay) {
    if (!tracks.length) return;
    const p = core.positionAt(clock, seconds), own = ++operation;
    switchAbort?.abort(); switchAbort = new AbortController();
    pendingPlay = play; transition = true; audio.pause(); index = p.index;
    updateControls(); drawTime(p.seconds);
    try {
      if (audio.getAttribute("src") !== tracks[index].blobURL) { audio.src = tracks[index].blobURL; audio.load(); }
      await metadataReady(switchAbort.signal);
      if (own !== operation) return;
      audio.currentTime = Math.min(p.offset, Math.max(0, (Number.isFinite(audio.duration) ? audio.duration : tracks[index].duration) - 0.01));
      audio.loop = loop === "verse"; audio.playbackRate = preferences.speed; audio.volume = preferences.volume;
      announceVerse(); transition = false;
      if (play) { await audio.play(); if (own === operation) { pendingPlay = false; setPhase("playing"); status(loop === "verse" ? "Spelar · Den aktuella versen upprepas" : loop === "chapter" ? "Spelar · Kapitlet upprepas" : "Spelar · Nästa kapitel fortsätter automatiskt"); startAnimation(); } }
      else { pendingPlay = false; setPhase("paused"); status("Pausad"); drawTime(); }
    } catch (error) {
      if (own !== operation || error.name === "AbortError") return;
      pendingPlay = false; transition = false; setPhase("paused");
      status(error.name === "NotAllowedError" ? "Kapitlet är förladdat. Tryck på spela för att starta ljudet." : error.message);
    }
  }
  function pause() {
    operation++; switchAbort?.abort(); transition = false; pendingPlay = false; audio.pause(); setPhase("paused"); status("Pausad"); drawTime();
  }
  async function togglePlay() {
    if (!tracks.length || phase === "loading") return;
    if (phase === "playing" || pendingPlay) pause();
    else await playPosition(phase === "ended" ? 0 : Number(ui.seek.value), true);
  }
  audio.addEventListener("timeupdate", () => { if (!transition && !seeking && tracks.length) drawTime(); });
  audio.addEventListener("ended", () => {
    if (transition || !tracks.length) return;
    const action = core.finishAction(loop, index, tracks.length);
    if (action.type === "track") { playPosition(clock.segments[action.index].start, true); return; }
    pendingPlay = false; setPhase("ended"); drawTime(clock.total);
    const target = core.nextChapter(context);
    if (!target) { status("Bibeln är slut. Tryck på spela för att lyssna på kapitlet igen."); return; }
    try {
      if (!core.chapterEntry(catalog, target)) { status(`Nästa kapitel, ${core.chapterLabel(target)}, saknar ljud. Uppspelningen stannar här.`); return; }
      status(`Fortsätter till ${core.chapterLabel(target)}…`); post("NEXT", { target });
    } catch (error) { status(error.message); }
  });
  audio.addEventListener("error", () => {
    if (!tracks.length || transition) return;
    pendingPlay = false; setPhase("paused"); status("Ljudet kunde inte spelas upp. Försök igen."); ui.retry.hidden = false;
  });
  async function savePreferences() {
    preferences = { follow, speed: Number(ui.speed.value), volume: Number(ui.volume.value) };
    audio.volume = preferences.volume; audio.playbackRate = preferences.speed;
    try { await chrome.storage.local.set({ playerPreferences: preferences }); } catch { /* Settings are optional; playback can continue. */ }
  }
  ui.play.addEventListener("click", togglePlay);
  ui.previous.addEventListener("click", () => playPosition(clock.segments[Math.max(0, index - 1)].start));
  ui.next.addEventListener("click", () => playPosition(clock.segments[Math.min(tracks.length - 1, index + 1)].start));
  ui.follow.addEventListener("click", () => { follow = !follow; updateControls(); post("FOLLOW", { follow }); savePreferences(); });
  ui.loop.addEventListener("click", () => {
    loop = loop === "off" ? "chapter" : loop === "chapter" ? "verse" : "off";
    audio.loop = loop === "verse"; updateControls();
    status(loop === "verse" ? "Den aktuella versen upprepas. Spola till en annan vers för att välja den." : loop === "chapter" ? "Hela kapitlet upprepas." : "Loop av · Nästa kapitel fortsätter automatiskt");
  });
  ui.speed.addEventListener("change", savePreferences); ui.volume.addEventListener("input", savePreferences);
  ui.retry.addEventListener("click", () => { if (context) loadChapter(context); });
  function showTooltip(value, ratio = value / clock.total) {
    const p = core.positionAt(clock, value); if (!p) return;
    ui.tooltip.textContent = `Vers ${p.verse} · ${core.formatTime(value)}`; ui.tooltip.hidden = false;
    const width = ui["seek-wrap"].clientWidth, half = ui.tooltip.offsetWidth / 2 + 3;
    ui.tooltip.style.left = `${Math.min(width - half, Math.max(half, ratio * width))}px`;
  }
  ui.seek.addEventListener("pointermove", event => {
    if (!tracks.length) return;
    const r = ui.seek.getBoundingClientRect(), ratio = Math.min(1, Math.max(0, (event.clientX - r.left - 7) / Math.max(1, r.width - 14)));
    showTooltip(seeking ? Number(ui.seek.value) : ratio * clock.total, ratio);
  });
  ui.seek.addEventListener("pointerleave", () => { if (!seeking) ui.tooltip.hidden = true; });
  ui.seek.addEventListener("focus", () => { if (tracks.length) showTooltip(Number(ui.seek.value)); });
  ui.seek.addEventListener("blur", () => { if (!seeking) ui.tooltip.hidden = true; });
  ui.seek.addEventListener("input", () => { seeking = true; drawTime(Number(ui.seek.value)); showTooltip(Number(ui.seek.value)); });
  ui.seek.addEventListener("change", () => { const seconds = Number(ui.seek.value); seeking = false; ui.tooltip.hidden = true; playPosition(seconds); });
  ui.seek.addEventListener("pointercancel", () => { seeking = false; ui.tooltip.hidden = true; drawTime(); });
  document.addEventListener("keydown", event => {
    if ((event.code === "Space" || event.key === " ") && !event.target.closest("input,select,button")) { event.preventDefault(); togglePlay(); }
  });
  window.addEventListener("message", event => {
    const m = event.data;
    if (event.source !== parent || event.origin !== parentOrigin || m?.channel !== "RB_AUDIO" || m.token !== token) return;
    if (m.type === "LOAD") loadChapter(m.context, !!m.autoplay, !!m.mappingComplete);
    else if (m.type === "STOP") stop();
    else if (m.type === "NAV_ERROR") { setPhase("ended"); status("Kunde inte öppna nästa kapitel. Välj det med sidans kapitelmeny."); }
  });
  window.addEventListener("pagehide", stop);
  const resize = new ResizeObserver(() => post("HEIGHT", { height: document.querySelector(".player").getBoundingClientRect().height + 2 }));
  resize.observe(document.querySelector(".player"));
  (async () => {
    if (!token || !core.isSiteURL(parentOrigin) || parent === window) { status("Öppna spelaren genom Läs bibeln eller Studera bibeln på Bibelonline."); return; }
    try {
      const stored = (await chrome.storage.local.get("playerPreferences")).playerPreferences;
      if (stored) {
        follow = typeof stored.follow === "boolean" ? stored.follow : true;
        const speed = [0.75, 1, 1.25, 1.5, 2].includes(stored.speed) ? stored.speed : 1;
        const volume = Number.isFinite(stored.volume) && stored.volume >= 0 && stored.volume <= 1 ? stored.volume : 1;
        preferences = { follow, speed, volume }; ui.speed.value = String(speed); ui.volume.value = String(volume);
      }
    } catch { /* Use the built-in settings. */ }
    updateControls(); post("READY");
  })();
})();
