chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete" || !tab.url || !tab.url.startsWith("http")) return;
  
    const storageArea = await getStorageArea();
    const { notes = [] } = await storageArea.get({ notes: [] });
    if (!notes.length) return;
  
    const hasMatchingNote = notes.some((note) => doesNoteMatchUrl(note, tab.url));
    if (!hasMatchingNote) return;
  
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["styles.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (e) {
      console.error("Failed to inject scripts:", e);
    }
  });
  
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_STORAGE_KIND") {
      getStorageArea()
        .then((area) => sendResponse({ kind: area === chrome.storage.sync ? "sync" : "local" }))
        .catch(() => sendResponse({ kind: "local" }));
      return true; // async
    }
  });
  
  function doesNoteMatchUrl(note, url) {
    if (note.matchType === "exact") return url === note.url;
    if (note.matchType === "domain") {
      try {
        return new URL(url).hostname === new URL(note.url).hostname;
      } catch {
        return false;
      }
    }
    return false;
  }
  
  async function getStorageArea() {
    const { useSync = false } = await chrome.storage.local.get({ useSync: false });
    return useSync && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
  }
  