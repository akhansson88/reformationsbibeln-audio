"use strict";
importScripts("lib/books.js", "lib/core.js");
const core = globalThis.RBAudioCore;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !core.isSiteURL(sender.url, true)) return false;
  const key = `continue:${sender.tab.id}`;
  (async () => {
    if (message?.type === "RB_CONSUME_CONTINUATION") {
      const record = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      return { ok: true, autoplay: core.continuationMatches(record, message.context) };
    }
    if (message?.type === "RB_CONTINUE") {
      const view = new URL(sender.url).pathname.slice(1, -4);
      if (message.current?.view !== view || !core.sameContext(core.nextChapter(message.current), message.target)) throw new Error("Ogiltigt kapitelbyte.");
      await chrome.storage.session.set({ [key]: { target: message.target, expiresAt: Date.now() + 45000 } });
      return { ok: true };
    }
    throw new Error("Okänt meddelande.");
  })().then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(`continue:${tabId}`).catch(() => {}); });
