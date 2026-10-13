(function (root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.RBAudioCore;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RBAudioReports = api;
})(globalThis, function (core) {
  "use strict";
  const MAX_DESCRIPTION = 1000, MAX_TEXT = 6000;
  function normalizeText(text) { return typeof text === "string" ? text.normalize("NFC").replace(/[\s\u0085]+/gu, " ").trim() : ""; }
  function words(text) { const clean = normalizeText(text); return clean ? clean.split(" ") : []; }
  function invalid(message) { throw Object.assign(new Error(message), { name: "ReportValidationError" }); }
  function buildDraft({ context, verse, audio, verseText, selectedIndices, description, extensionVersion, clientReportId }) {
    if (!core.validContext(context) || !Number.isInteger(verse) || verse < 1 || verse > core.books[context.bookId - 1].verses[context.chapter - 1]) invalid("Välj en vers i kapitlet.");
    const text = normalizeText(verseText), tokens = words(text);
    if (text.length > MAX_TEXT || tokens.length > 1000) invalid("Versens text kunde inte läsas korrekt. Ladda om sidan.");
    if (typeof description !== "string") invalid("Skriv en beskrivning av felet.");
    const detail = description.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "").normalize("NFC"), selectedWords = {};
    if (detail.length > MAX_DESCRIPTION) invalid(`Beskrivningen får innehålla högst ${MAX_DESCRIPTION} tecken.`);
    if (!Array.isArray(selectedIndices)) invalid("Markera orden som uttalas fel.");
    for (const index of [...new Set(selectedIndices)].sort((a, b) => a - b)) {
      if (!Number.isInteger(index) || index < 0 || index >= tokens.length) invalid("Ordmarkeringen stämmer inte med versen. Välj versen igen.");
      selectedWords[String(index)] = tokens[index];
    }
    if (!Object.keys(selectedWords).length && !detail) invalid("Markera minst ett ord eller skriv en beskrivning av felet.");
    if (!audio || !/^[A-Za-z0-9_-]{1,80}$/.test(audio.revision) || !/^[a-f0-9]{64}$/.test(audio.sha256)) invalid("Ljudfilens version saknas. Ladda om kapitlet.");
    const base = `${core.REPO}/releases/download/audio-${String(context.bookId).padStart(2, "0")}-${String(context.chapter).padStart(3, "0")}-${audio.revision}/`;
    if (audio.url !== `${base}verse-${String(verse).padStart(3, "0")}.mp3`) invalid("Ljudfilen stämmer inte med versen.");
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(extensionVersion) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(clientReportId)) invalid("Rapporten kunde inte förberedas. Öppna formuläret igen.");
    return {
      schemaVersion: 1, source: "chrome-extension", extensionVersion, clientReportId,
      translation: core.TRANSLATION, bookId: context.bookId, bookName: core.books[context.bookId - 1].name,
      chapter: context.chapter, verse, verseText: text, selectedWords, description: detail,
      audioRevision: audio.revision, audioUrl: audio.url, audioChecksum: audio.sha256, status: "new"
    };
  }
  return { MAX_DESCRIPTION, MAX_TEXT, normalizeText, words, buildDraft };
});
