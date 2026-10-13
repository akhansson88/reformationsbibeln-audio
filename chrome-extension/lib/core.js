(function (root, factory) {
  const books = typeof module === "object" && module.exports ? require("./books.js") : root.RBAudioBooks;
  const api = factory(books);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RBAudioCore = api;
})(globalThis, function (books) {
  "use strict";
  const REPO = "https://github.com/akhansson88/reformationsbibeln-audio";
  const CATALOG_URL = "https://raw.githubusercontent.com/akhansson88/reformationsbibeln-audio/main/catalog.json";
  const TRANSLATION = "reformationsbibeln2026";
  const SITE_HOSTS = new Set(["bibelonline.se", "www.bibelonline.se"]);
  const VIEWS = new Set(["biblereader", "studyb"]);
  const pad = n => String(n).padStart(3, "0");
  function validContext(c) {
    return !!c && Number.isInteger(c.bookId) && c.bookId >= 1 && c.bookId <= 66 &&
      Number.isInteger(c.chapter) && c.chapter >= 1 && c.chapter <= books[c.bookId - 1].verses.length && VIEWS.has(c.view);
  }
  function nextChapter(c) {
    if (!validContext(c)) return null;
    if (c.chapter < books[c.bookId - 1].verses.length) return { ...c, chapter: c.chapter + 1 };
    return c.bookId < 66 ? { ...c, bookId: c.bookId + 1, chapter: 1 } : null;
  }
  function sameContext(a, b) {
    return validContext(a) && validContext(b) && a.bookId === b.bookId && a.chapter === b.chapter && a.view === b.view;
  }
  function chapterLabel(c) { return `${books[c.bookId - 1].name} ${c.chapter}`; }
  function isSiteURL(value, requireReader = false) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password && !u.port && SITE_HOSTS.has(u.hostname) &&
        (!requireReader || ["/biblereader.php", "/studyb.php"].includes(u.pathname));
    } catch { return false; }
  }
  function chapterEntry(catalog, c) {
    if (!catalog || catalog.schemaVersion !== 1 || catalog.translation !== TRANSLATION || !catalog.chapters || !validContext(c)) {
      throw new Error("Ljudkatalogen har ett okänt format.");
    }
    const e = catalog.chapters[`${c.bookId}:${c.chapter}`];
    if (!e) return null;
    if (e.bookId !== c.bookId || e.chapter !== c.chapter || typeof e.revision !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(e.revision)) {
      throw new Error("Kapitlets ljudinformation är felaktig.");
    }
    const base = `${REPO}/releases/download/audio-${String(c.bookId).padStart(2, "0")}-${pad(c.chapter)}-${e.revision}/`;
    if (e.manifestUrl !== `${base}chapter.json`) throw new Error("Kapitlets ljudlänk är inte betrodd.");
    return { ...e, base };
  }
  function validateManifest(m, e, c) {
    const count = books[c.bookId - 1].verses[c.chapter - 1];
    if (!m || m.schemaVersion !== 1 || m.translation !== TRANSLATION || m.bookId !== c.bookId || m.chapter !== c.chapter ||
      m.revision !== e.revision || m.sourceHash !== e.sourceHash || !Array.isArray(m.verses) || m.verses.length !== count ||
      !Array.isArray(m.expectedVerses) || m.expectedVerses.length !== count) throw new Error("Kapitlets ljud är ofullständigt eller har ett okänt format.");
    const verses = m.verses.map((v, i) => {
      if (m.expectedVerses[i] !== i + 1 || v.verse !== i + 1 || !Number.isFinite(v.duration) || v.duration <= 0 || v.duration > 3600 ||
        typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256) || v.url !== `${e.base}verse-${pad(v.verse)}.mp3`) {
        throw new Error("En vers har felaktig ljudinformation.");
      }
      return { verse: v.verse, duration: v.duration, url: v.url, sha256: v.sha256 };
    });
    return verses;
  }
  function timeline(verses) {
    let total = 0;
    const segments = verses.map(v => { const s = { ...v, start: total, end: total + v.duration }; total = s.end; return s; });
    return { segments, total };
  }
  function positionAt(t, seconds) {
    if (!t.segments.length) return null;
    const value = Math.min(t.total, Math.max(0, Number(seconds) || 0));
    let low = 0, high = t.segments.length - 1;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (value < t.segments[mid].end) high = mid; else low = mid + 1; }
    const s = t.segments[low];
    return { index: low, verse: s.verse, offset: Math.min(s.duration, Math.max(0, value - s.start)), seconds: value };
  }
  function finishAction(mode, index, length) {
    if (mode === "verse") return { type: "track", index };
    if (index + 1 < length) return { type: "track", index: index + 1 };
    return mode === "chapter" ? { type: "track", index: 0 } : { type: "nextChapter" };
  }
  function formatTime(seconds) {
    const n = Math.max(0, Math.floor(seconds || 0));
    return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  }
  function abortError() { return new DOMException("Avbrutet", "AbortError"); }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const cancel = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
  async function fetchResponse(url, signal, fetcher = fetch, attempts = 3, read = response => response) {
    for (let n = 0; n < attempts; n++) {
      if (signal?.aborted) throw abortError();
      const control = new AbortController();
      const cancel = () => control.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 45000);
      let retryMs = 400 * 2 ** n;
      try {
        const response = await fetcher(url, { signal: control.signal, credentials: "omit", cache: "no-store", redirect: "follow" });
        if (response.ok) return await read(response);
        if (![408, 429].includes(response.status) && response.status < 500) throw Object.assign(new Error(`Ljudhämtningen misslyckades (HTTP ${response.status}).`), { permanent: true });
        const after = response.headers.get("retry-after");
        if (after) retryMs = Math.min(15000, Math.max(0, Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - Date.now()));
        throw new Error(`Ljudhämtningen misslyckades (HTTP ${response.status}).`);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error.permanent || n === attempts - 1) throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
      await delay(retryMs, signal);
    }
  }
  async function mapLimit(items, limit, fn, signal) {
    const result = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        if (signal?.aborted) throw abortError();
        const i = cursor++;
        result[i] = await fn(items[i], i);
      }
    }));
    return result;
  }
  function continuationMatches(record, context, now = Date.now()) {
    return !!record && record.expiresAt > now && record.expiresAt <= now + 60000 && sameContext(record.target, context);
  }
  return { books, REPO, CATALOG_URL, TRANSLATION, SITE_HOSTS, validContext, nextChapter, sameContext, chapterLabel, isSiteURL,
    chapterEntry, validateManifest, timeline, positionAt, finishAction, formatTime, fetchResponse, mapLimit, delay, abortError, continuationMatches };
});
