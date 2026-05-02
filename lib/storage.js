// Storage helpers — abstracts local/sync selection and common note operations.

export async function getStorageArea() {
  const { useSync = false } = await chrome.storage.local.get({ useSync: false });
  return useSync && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
}

export async function loadNotes() {
  const area = await getStorageArea();
  const { notes = [] } = await area.get({ notes: [] });
  return notes;
}

export async function saveNotes(notes) {
  const area = await getStorageArea();
  await area.set({ notes });
}

export async function patchNote(id, patcher) {
  const area = await getStorageArea();
  const { notes = [] } = await area.get({ notes: [] });
  const idx = notes.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const updated = patcher({ ...notes[idx] });
  notes[idx] = { ...notes[idx], ...updated, updatedAt: new Date().toISOString() };
  await area.set({ notes });
  return notes[idx];
}

// Returns the active tab. Uses lastFocusedWindow so it works correctly when
// called from a popup (where currentWindow would point to the popup itself).
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}
