(function (root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.RBAudioCore;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RBAudioAdapter = api;
})(globalThis, function (core) {
  "use strict";
  function readContext(doc, href) {
    if (!core.isSiteURL(href, true)) return null;
    const view = new URL(href).pathname.slice(1, -4);
    for (const a of doc.querySelectorAll('a[href^="mailto:"]')) {
      try {
        const body = new URL(a.getAttribute("href")).searchParams.get("body");
        if (!core.isSiteURL(body)) continue;
        const p = new URL(body).searchParams;
        const c = { view, bookId: Number(p.get("book")), chapter: Number(p.get("chap")) };
        if (p.get("prog") === view && core.validContext(c)) return c;
      } catch { /* Other email links are unrelated to the chapter. */ }
    }
    const c = { view, bookId: Number(doc.querySelector('input[name="book"]')?.value), chapter: Number(doc.querySelector('input[name="chap"]')?.value) };
    return core.validContext(c) ? c : null;
  }
  function studyVerses(doc, count) {
    const records = [];
    for (const row of doc.querySelectorAll("table.mytable1 tr.mytr")) {
      const cells = row.cells;
      if (cells.length < 2) continue;
      const number = Number(cells[0].textContent.trim());
      if (!Number.isInteger(number) || number < 1 || number > count || !cells[1].textContent.trim()) continue;
      records.push({ verse: number, element: cells[1], highlights: [cells[0], cells[1]] });
    }
    return records;
  }
  function readerVerses(doc, count) {
    const records = [];
    for (const sup of doc.querySelectorAll("td > span > small > sup")) {
      const verse = Number(sup.textContent.trim());
      const marker = sup.parentElement.parentElement;
      const text = marker.nextElementSibling;
      if (verse >= 1 && verse <= count && text?.tagName === "SPAN" && text.textContent.trim()) {
        records.push({ verse, element: text, highlights: [marker, text] });
      }
    }
    if (records.length === count) return records;
    // When verse numbers are hidden, the reader still emits one direct span per verse.
    const candidates = [...doc.querySelectorAll("td")].map(td => [...td.children].filter(e =>
      e.tagName === "SPAN" && /font-family/i.test(e.getAttribute("style") || "") && e.textContent.trim() &&
      !e.querySelector("sup") && !e.querySelector(":scope > b") && !e.querySelector(":scope > strong")
    )).filter(spans => spans.length === count);
    if (candidates.length !== 1) return records;
    return candidates[0].map((element, i) => ({ verse: i + 1, element, highlights: [element] }));
  }
  function mapVerses(doc, c) {
    const count = core.books[c.bookId - 1].verses[c.chapter - 1];
    const records = c.view === "studyb" ? studyVerses(doc, count) : readerVerses(doc, count);
    const map = new Map(records.map(record => [record.verse, record]));
    return { map, complete: map.size === count && Array.from({ length: count }, (_, i) => map.has(i + 1)).every(Boolean), count };
  }
  function navigationURL(doc, href, target) {
    if (!core.validContext(target) || !core.isSiteURL(href, true)) return null;
    for (const a of doc.querySelectorAll("#Demo2 a[href], #Demo a[href]")) {
      try {
        const u = new URL(a.getAttribute("href"), href);
        if (!core.isSiteURL(u.href) || u.pathname !== "/fromgettopost.php" || u.searchParams.get("prog") !== target.view) continue;
        if (Number(u.searchParams.get("book")) === target.bookId && Number(u.searchParams.get("chap")) === target.chapter) return u.href;
      } catch { /* Ignore unrelated navigation entries. */ }
    }
    return null;
  }
  function verseText(record) {
    if (!record?.element) return "";
    const copy = record.element.cloneNode(true);
    for (const node of copy.querySelectorAll('script,style,sup,small,[aria-hidden="true"],.tooltiptext,.tooltip_text')) node.remove();
    for (const a of copy.querySelectorAll("a")) {
      if (/^[GH]\d{1,6}$/i.test(a.textContent.trim()) || /showstrong/i.test(a.getAttribute("href") || "")) a.replaceWith(" ");
    }
    for (const br of copy.querySelectorAll("br")) br.replaceWith(" ");
    return (copy.textContent || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  }
  return { readContext, mapVerses, navigationURL, verseText };
});
