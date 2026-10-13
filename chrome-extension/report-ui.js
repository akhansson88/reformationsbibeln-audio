(() => {
  "use strict";
  const reports = globalThis.RBAudioReports, core = globalThis.RBAudioCore;
  function create({ getSnapshot, pause, post, requestText, store = globalThis.RBReportStore }) {
    const ui = Object.fromEntries(["dialog", "reference", "form", "verse", "word-help", "words", "selection", "description", "required", "count", "error", "state", "submit", "close", "cancel", "success", "done"].map(name => [name, document.getElementById(`report-${name}`)]));
    let snapshot = null, text = "", selected = new Set(), loading = false, busy = false, succeeded = false;
    let textRequest = 0, draftId = null, lastSignature = null;
    function error(message = "") { ui.error.textContent = message; ui.error.hidden = !message; }
    function update() {
      const n = selected.size;
      ui.selection.textContent = n ? `${n} ${n === 1 ? "ord markerat" : "ord markerade"}` : "Inga ord markerade";
      ui.required.textContent = n ? "(valfri)" : "(krävs utan markerade ord)";
      ui.description.required = !n;
      ui.count.textContent = `${ui.description.value.length}/${reports.MAX_DESCRIPTION}`;
      ui.submit.disabled = loading || busy; ui.verse.disabled = busy;
      ui.description.disabled = busy;
      for (const button of ui.words.querySelectorAll("button")) button.disabled = busy;
      ui.submit.textContent = busy ? "Skickar…" : "Skicka anmälan";
      ui.cancel.textContent = busy ? "Stäng" : "Avbryt";
    }
    async function chooseVerse() {
      const own = ++textRequest, verse = Number(ui.verse.value);
      selected = new Set(); text = ""; loading = true;
      ui.words.replaceChildren(); ui.description.value = ""; error();
      ui.state.textContent = ""; ui["word-help"].textContent = "Hämtar versens text…"; update();
      try {
        const result = await requestText(snapshot.context, verse);
        if (own !== textRequest) return;
        text = reports.normalizeText(result);
        if (text.length > reports.MAX_TEXT || reports.words(text).length > 1000) text = "";
      } catch { if (own !== textRequest) return; text = ""; }
      loading = false;
      ui["word-help"].textContent = text ? "Klicka på orden som uttalas fel. Du kan markera flera." : "Versens text kunde inte läsas. Beskriv felet i fältet nedan.";
      const fragment = document.createDocumentFragment();
      reports.words(text).forEach((word, index) => {
        const button = document.createElement("button"); button.type = "button"; button.textContent = word;
        button.setAttribute("aria-pressed", "false"); button.setAttribute("aria-label", `${word}, ord ${index + 1}`);
        button.dataset.index = String(index);
        button.addEventListener("click", () => {
          if (busy) return;
          selected.has(index) ? selected.delete(index) : selected.add(index);
          button.setAttribute("aria-pressed", String(selected.has(index))); error(); update();
        });
        fragment.append(button, document.createTextNode(" "));
      });
      ui.words.replaceChildren(fragment); update();
    }
    function close() {
      if (ui.dialog.open) ui.dialog.close();
      post("REPORT_LAYOUT", { open: false });
      if (!busy) textRequest++;
    }
    function open() {
      if (ui.dialog.open) return;
      const next = getSnapshot(); if (!next) return;
      pause();
      if (!busy) {
        snapshot = next; draftId = crypto.randomUUID(); lastSignature = null; succeeded = false;
        ui.reference.textContent = core.chapterLabel(snapshot.context);
        const fragment = document.createDocumentFragment();
        for (const track of snapshot.tracks) { const option = document.createElement("option"); option.value = String(track.verse); option.textContent = `Vers ${track.verse}`; fragment.append(option); }
        ui.verse.replaceChildren(fragment); ui.verse.value = String(snapshot.verse);
        ui.form.hidden = false; ui.success.hidden = true; chooseVerse();
      } else { ui.form.hidden = !succeeded; ui.success.hidden = succeeded; }
      post("REPORT_LAYOUT", { open: true }); ui.dialog.showModal(); ui.verse.focus();
    }
    ui.form.addEventListener("submit", async event => {
      event.preventDefault(); if (busy || loading || !snapshot) return;
      error();
      let draft;
      try {
        const verse = Number(ui.verse.value), track = snapshot.tracks.find(t => t.verse === verse);
        draft = reports.buildDraft({ context: snapshot.context, verse, audio: { ...track, revision: snapshot.revision }, verseText: text,
          selectedIndices: [...selected], description: ui.description.value, extensionVersion: snapshot.version, clientReportId: draftId });
        const signature = JSON.stringify({ ...draft, clientReportId: "" });
        if (lastSignature !== null && signature !== lastSignature) { draftId = crypto.randomUUID(); draft.clientReportId = draftId; }
        lastSignature = signature;
      } catch (failure) { error(failure.message); ui.description.focus(); return; }
      busy = true; ui.state.textContent = "Skickar anmälan…"; update();
      try {
        await store.submit(draft);
        succeeded = true; ui.form.hidden = true; ui.success.hidden = false;
        if (ui.dialog.open) ui.done.focus();
      } catch (failure) { ui.state.textContent = ""; error(failure.message || "Kunde inte skicka anmälan. Försök igen."); }
      finally { busy = false; update(); }
    });
    ui.verse.addEventListener("change", chooseVerse);
    ui.description.addEventListener("input", () => { error(); update(); });
    for (const button of [ui.close, ui.cancel, ui.done]) button.addEventListener("click", close);
    ui.dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    ui.dialog.addEventListener("close", () => post("REPORT_LAYOUT", { open: false }));
    return { open, close, isOpen: () => ui.dialog.open };
  }
  globalThis.RBAudioReportUI = { create };
})();
