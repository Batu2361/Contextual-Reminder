// Background service worker — Manifest V3, ES module.
//
// Injection strategy:
//   • On popup open or keyboard shortcut (Alt+Shift+N): inject via activeTab.
//   • On tabs.onUpdated: auto-inject only when the user has granted <all_urls>.
//   • chrome://, edge://, file://, and restricted pages are silently skipped.

import { getStorageArea, safeHostname } from "./lib/storage.js";

const SCRIPTS = ["lib/purify.min.js", "content.js"];
const STYLES  = ["styles.css"];

// Checks if a note matches the given URL based on its matchType setting.
function noteMatchesUrl(note, url) {
  if (note.matchType === "exact") return note.url === url;
  if (note.matchType === "domain") {
    try { return new URL(url).hostname === new URL(note.url).hostname; }
    catch { return false; }
  }
  return false;
}

// Updates the toolbar badge with the number of notes for the given URL.
async function updateBadge(tabId, url) {
  if (!url || !url.startsWith("http")) {
    chrome.action.setBadgeText({ text: "", tabId });
    return;
  }
  try {
    const area = await getStorageArea();
    const { notes = [] } = await area.get({ notes: [] });
    const count = notes.filter((n) => noteMatchesUrl(n, url)).length;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
    if (count > 0) chrome.action.setBadgeBackgroundColor({ color: "#007AFF", tabId });
  } catch {
    // Tab may have been closed before the async work finished.
  }
}

// Injects the note widget CSS and JS into a tab. Idempotent — the content
// script guards against running twice on the same page.
async function injectNotesForTab(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: STYLES });
    await chrome.scripting.executeScript({ target: { tabId }, files: SCRIPTS });
    return { ok: true };
  } catch (err) {
    // Injection fails silently on chrome://, extension pages, and PDFs.
    return { ok: false, error: err.message };
  }
}

// Auto-injects notes when the user has granted optional <all_urls> permission.
// Only runs if the page actually has matching notes — avoids unnecessary work.
async function maybeAutoInject(tabId, url) {
  if (!url?.startsWith("http")) return;

  const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) return;

  const area = await getStorageArea();
  const { notes = [] } = await area.get({ notes: [] });
  const hostname = safeHostname(url);

  const hasMatchingNotes = notes.some((n) =>
    n.matchType === "exact" ? n.url === url : safeHostname(n.url) === hostname
  );

  if (hasMatchingNotes) await injectNotesForTab(tabId);
}

// Badge: update when user switches tabs.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadge(tabId, tab.url);
  } catch {
    // Tab was closed during the await.
  }
});

// Badge + optional auto-inject when a page finishes loading.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  await updateBadge(tabId, tab.url);
  await maybeAutoInject(tabId, tab.url);
});

// Re-calculate badge for all active tabs when notes change (e.g. from popup).
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.notes) return;
  const tabs = await chrome.tabs.query({ active: true });
  for (const tab of tabs) await updateBadge(tab.id, tab.url);
});

// Keyboard shortcut: Alt+Shift+N injects notes into the current tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "show-notes") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) await injectNotesForTab(tab.id);
});

// Context menu: "Create note from selection" — saves selected text as a draft
// that popup.js picks up on next open.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       "create-note-from-selection",
    title:    "Create note from selection",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "create-note-from-selection") return;
  const text = info.selectionText?.trim();
  if (!text) return;
  await chrome.storage.local.set({
    pendingCapture: { text, pageTitle: tab?.title || "" },
  });
});

// Message passing from popup and content scripts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === "GET_STORAGE_KIND") {
    getStorageArea()
      .then((area) => sendResponse({ kind: area === chrome.storage.sync ? "sync" : "local" }))
      .catch(() => sendResponse({ kind: "local" }));
    return true;
  }

  // Popup requests injection for a specific tab (e.g. after saving a note).
  if (msg.type === "INJECT_NOTES_FOR_TAB" && typeof msg.tabId === "number") {
    injectNotesForTab(msg.tabId).then(sendResponse);
    return true;
  }

  // Content script requests re-injection after anchor picker completes.
  if (msg.type === "INJECT_NOTES" && sender.tab?.id) {
    injectNotesForTab(sender.tab.id).then(sendResponse);
    return true;
  }

  // Legacy alias kept for backwards compatibility with older anchor picker code.
  if (msg.type === "RELOAD_NOTES_FOR_TAB" && sender.tab?.id) {
    injectNotesForTab(sender.tab.id).then(sendResponse);
    return true;
  }
});

export {};
