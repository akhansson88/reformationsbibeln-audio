(() => {
  "use strict";
  const core = globalThis.RBAudioCore, adapter = globalThis.RBAudioAdapter;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  let session = null, timer = null, suspended = false;
  const style = document.createElement("style");
  style.textContent = `
    [data-rb-spoken="true"] { background-color: #fce3a5 !important; color: #302716 !important;
      box-shadow: 0 2px 0 #b1792f !important; border-radius: 3px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    [data-rb-spoken="true"] a { color: #493400 !important; }
    @media print { #rb-audio-dock, #rb-audio-spacer { display: none !important; } }
  `;
  document.head.append(style);
  function clearHighlight() {
    if (!session) return;
    for (const node of session.highlighted) node.removeAttribute("data-rb-spoken");
    session.highlighted = [];
  }
  function scrollToVerse(record, force = false) {
    if (!record || !session?.follow) return;
    const rect = record.element.getBoundingClientRect();
    const bottom = window.innerHeight - session.height - 24;
    if (force || rect.top < 35 || rect.bottom > bottom) {
      record.element.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center", inline: "nearest" });
    }
  }
  function markVerse(verse, follow) {
    if (!session) return;
    session.follow = !!follow;
    if (session.verse !== verse || session.highlighted.some(node => !node.isConnected)) {
      clearHighlight();
      session.verse = verse;
      const record = session.verses.map.get(verse);
      if (record) {
        session.highlighted = record.highlights;
        for (const node of record.highlights) node.setAttribute("data-rb-spoken", "true");
        scrollToVerse(record);
      }
    }
  }
  function send(type, data = {}) {
    session?.frame.contentWindow?.postMessage({ channel: "RB_AUDIO", token: session.token, type, ...data }, extensionOrigin);
  }
  function destroy() {
    if (!session) return;
    send("STOP");
    clearHighlight();
    session.host.remove(); session.spacer.remove();
    session = null;
  }
  async function initialize() {
    if (suspended) return;
    const context = adapter.readContext(document, location.href);
    if (!context) { destroy(); return; }
    if (session && core.sameContext(session.context, context) && session.host.isConnected) {
      session.verses = adapter.mapVerses(document, context);
      if (session.verse) markVerse(session.verse, session.follow);
      return;
    }
    destroy();
    const token = crypto.randomUUID();
    const host = document.createElement("div"); host.id = "rb-audio-dock";
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto 0 0 0!important;width:100%!important;z-index:2147483647!important;display:block!important;";
    const shadow = host.attachShadow({ mode: "open" });
    const frame = document.createElement("iframe"); frame.name = "rb-audio-player"; frame.title = "Reformationsbibeln ljudspelare";
    frame.allow = "autoplay"; frame.referrerPolicy = "no-referrer";
    frame.style.cssText = "display:block;border:0;width:100%;height:134px;color-scheme:light;";
    const url = new URL(chrome.runtime.getURL("player.html"));
    url.searchParams.set("origin", location.origin); url.searchParams.set("session", token); frame.src = url.href;
    const spacer = document.createElement("div"); spacer.id = "rb-audio-spacer"; spacer.setAttribute("aria-hidden", "true"); spacer.style.height = "158px";
    session = { context, token, host, frame, spacer, height: 134, follow: true, verse: 0, highlighted: [],
      verses: adapter.mapVerses(document, context), autoplay: false, consumed: false, ready: false, started: false };
    shadow.append(frame); document.body.append(spacer, host);
    const active = session;
    try {
      const response = await chrome.runtime.sendMessage({ type: "RB_CONSUME_CONTINUATION", context });
      if (session === active) active.autoplay = !!response?.autoplay;
    } catch { /* Playback remains available without automatic continuation. */ }
    if (session === active) { active.consumed = true; loadWhenReady(); }
  }
  function loadWhenReady() {
    if (session?.ready && session.consumed && !session.started) {
      session.started = true;
      send("LOAD", { context: session.context, autoplay: session.autoplay, mappingComplete: session.verses.complete });
    }
  }
  window.addEventListener("message", async event => {
    const active = session, data = event.data;
    if (!active || event.source !== active.frame.contentWindow || event.origin !== extensionOrigin || data?.channel !== "RB_AUDIO" || data.token !== active.token) return;
    if (data.type === "READY") { active.ready = true; loadWhenReady(); }
    else if (data.type === "HEIGHT" && Number.isFinite(data.height)) {
      active.height = Math.min(280, Math.max(90, Math.ceil(data.height)));
      active.frame.style.height = `${active.height}px`; active.spacer.style.height = `${active.height + 24}px`;
    } else if (data.type === "VERSE" && Number.isInteger(data.verse) && active.verses.map.has(data.verse)) markVerse(data.verse, data.follow);
    else if (data.type === "FOLLOW") {
      active.follow = !!data.follow;
      if (active.follow) scrollToVerse(active.verses.map.get(active.verse), true);
    } else if (data.type === "CLEAR") { clearHighlight(); active.verse = 0; }
    else if (data.type === "NEXT") {
      const target = core.nextChapter(active.context);
      const href = target && adapter.navigationURL(document, location.href, target);
      if (!target || !href || !core.sameContext(target, data.target)) { send("NAV_ERROR"); return; }
      try {
        const response = await chrome.runtime.sendMessage({ type: "RB_CONTINUE", current: active.context, target });
        if (!response?.ok || session !== active) throw new Error("Kunde inte byta kapitel.");
        location.assign(href);
      } catch { if (session === active) send("NAV_ERROR"); }
    }
  });
  const observer = new MutationObserver(changes => {
    if (changes.every(change => session?.host.contains(change.target) || change.target === session?.spacer)) return;
    clearTimeout(timer); timer = setTimeout(initialize, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => { suspended = true; clearTimeout(timer); destroy(); });
  window.addEventListener("pageshow", event => { if (event.persisted) { suspended = false; initialize(); } });
  initialize();
})();
