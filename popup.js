document.addEventListener("DOMContentLoaded", () => {
    const $ = (s, root = document) => root.querySelector(s);
    const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  
    // Tabs
    const views = { add: $("#view-add"), list: $("#view-list"), settings: $("#view-settings") };
    const tabs = { add: $("#tab-add"), list: $("#tab-list"), settings: $("#tab-settings") };
    Object.entries(tabs).forEach(([key, btn]) => btn.addEventListener("click", () => show(key)));
    function show(key) {
      Object.values(views).forEach((v) => (v.hidden = true));
      Object.values(tabs).forEach((b) => b.classList.remove("active"));
      views[key].hidden = false; tabs[key].classList.add("active");
      if (key === "list") renderList();
      if (key === "settings") updateStorageKind();
    }
  
    // Add view
    const titleEl = $("#note-title");
    const textEl = $("#note-text");
    const colorEl = $("#note-color");
    const saveBtn = $("#save-button");
    const status = $("#status-message");
  
    saveBtn.addEventListener("click", async () => {
      const content = textEl.value.trim();
      const title = (titleEl.value || "Notiz").trim();
      if (!content) return flash(status, "Bitte gib eine Notiz ein.", true);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return flash(status, "Konnte URL nicht ermitteln.", true);
  
      const matchType = document.querySelector("input[name='match-type']:checked").value;
      const storageArea = await getStorageArea();
      const { notes = [] } = await storageArea.get({ notes: [] });
      const newNote = {
        id: `note_${Date.now()}`,
        title,
        content,
        url: tab.url,
        matchType,
        color: colorEl.value,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ui: { collapsed: false }
      };
      notes.push(newNote);
      await storageArea.set({ notes });
      flash(status, "Notiz gespeichert!");
      titleEl.value = ""; textEl.value = "";
    });
  
    // List view
    const listContainer = $("#all-notes-container");
    const searchEl = $("#search");
    const sortEl = $("#sort");
    const exportBtn = $("#export-btn");
    const importInput = $("#import-input");
  
    searchEl.addEventListener("input", renderList);
    sortEl.addEventListener("change", renderList);
    exportBtn.addEventListener("click", doExport);
    importInput.addEventListener("change", doImport);
  
    async function renderList() {
      const storageArea = await getStorageArea();
      const { notes = [] } = await storageArea.get({ notes: [] });
      let arr = [...notes];
      const q = searchEl.value.trim().toLowerCase();
      if (q) arr = arr.filter((n) => `${n.title} ${n.content} ${n.url}`.toLowerCase().includes(q));
      const sort = sortEl.value;
      arr.sort((a, b) => {
        if (sort === "title") return (a.title || "").localeCompare(b.title || "");
        const da = new Date(a.createdAt).getTime();
        const db = new Date(b.createdAt).getTime();
        return sort === "oldest" ? da - db : db - da;
      });
  
      listContainer.innerHTML = "";
      if (!arr.length) {
        listContainer.innerHTML = '<p class="muted">Keine Notizen gefunden.</p>';
        return;
      }
  
      arr.forEach((note) => listContainer.appendChild(renderNoteItem(note)));
    }
  
    function renderNoteItem(note) {
      const el = document.createElement("div");
      el.className = "note-item";
      el.dataset.id = note.id;
      el.innerHTML = `
        <div class="top">
          <span class="dot" style="background:${note.color || "#f0c929"}"></span>
          <div>
            <div class="title">${escapeHtml(note.title || "Notiz")}</div>
            <div class="meta">${note.matchType} • ${escapeHtml(note.url)}</div>
          </div>
          <div class="actions">
            <button class="edit">Bearbeiten</button>
            <button class="save" hidden>Speichern</button>
            <button class="cancel" hidden>Abbrechen</button>
            <button class="delete">Löschen</button>
          </div>
        </div>
        <div class="content" contenteditable="false">${escapeHtml(note.content)}</div>
      `;
  
      const editBtn = el.querySelector(".edit");
      const saveBtn = el.querySelector(".save");
      const cancelBtn = el.querySelector(".cancel");
      const delBtn = el.querySelector(".delete");
      const content = el.querySelector(".content");
  
      editBtn.addEventListener("click", () => {
        content.setAttribute("contenteditable", "true");
        content.focus();
        editBtn.hidden = true; saveBtn.hidden = false; cancelBtn.hidden = false; delBtn.hidden = true;
      });
  
      cancelBtn.addEventListener("click", () => {
        content.textContent = note.content;
        content.setAttribute("contenteditable", "false");
        editBtn.hidden = false; saveBtn.hidden = true; cancelBtn.hidden = true; delBtn.hidden = false;
      });
  
      saveBtn.addEventListener("click", async () => {
        const storageArea = await getStorageArea();
        const { notes = [] } = await storageArea.get({ notes: [] });
        const idx = notes.findIndex((n) => n.id === note.id);
        if (idx < 0) return;
        notes[idx].content = content.textContent.trim();
        notes[idx].updatedAt = new Date().toISOString();
        await storageArea.set({ notes });
        content.setAttribute("contenteditable", "false");
        editBtn.hidden = false; saveBtn.hidden = true; cancelBtn.hidden = true; delBtn.hidden = false;
      });
  
      delBtn.addEventListener("click", async () => {
        if (!confirm("Diese Notiz wirklich löschen?")) return;
        const storageArea = await getStorageArea();
        const { notes = [] } = await storageArea.get({ notes: [] });
        await storageArea.set({ notes: notes.filter((n) => n.id !== note.id) });
        el.remove();
        // Versuche offene Note im aktiven Tab zu entfernen
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (id) => { document.querySelector(`.contextual-note-container[data-note-id='${id}']`)?.remove(); },
            args: [note.id]
          });
        }
      });
  
      return el;
    }
  
    async function doExport() {
      const storageArea = await getStorageArea();
      const { notes = [] } = await storageArea.get({ notes: [] });
      const blob = new Blob([JSON.stringify({ notes }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `notes-export-${new Date().toISOString().slice(0,10)}.json`;
      a.click(); URL.revokeObjectURL(url);
    }
  
    async function doImport(e) {
      const file = e.target.files?.[0]; if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        if (!Array.isArray(data.notes)) throw new Error("Ungültiges Format");
        const storageArea = await getStorageArea();
        const { notes = [] } = await storageArea.get({ notes: [] });
        const merged = [...notes];
        for (const n of data.notes) {
          if (!merged.some((m) => m.id === n.id)) merged.push(n);
        }
        await storageArea.set({ notes: merged });
        renderList();
      } catch (err) {
        alert("Import fehlgeschlagen: " + err.message);
      } finally {
        e.target.value = "";
      }
    }
  
    // Settings
    const syncToggle = $("#sync-toggle");
    const storageKindEl = $("#storage-kind");
    syncToggle.addEventListener("change", async () => {
      await chrome.storage.local.set({ useSync: syncToggle.checked });
    });
  
    (async () => {
      const { useSync = false } = await chrome.storage.local.get({ useSync: false });
      syncToggle.checked = useSync;
      updateStorageKind();
    })();
  
    async function updateStorageKind() {
      const res = await chrome.runtime.sendMessage({ type: "GET_STORAGE_KIND" }).catch(() => ({ kind: "local" }));
      storageKindEl.textContent = `Aktueller Speicher: ${res?.kind === "sync" ? "Synchronisiert" : "Lokal"}`;
    }
  
    // Helpers
    async function getStorageArea() {
      const { useSync = false } = await chrome.storage.local.get({ useSync: false });
      return useSync && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
    }
  
    function flash(el, msg, isErr = false) {
      el.textContent = msg; el.style.color = isErr ? "#dc2626" : "#16a34a"; setTimeout(() => (el.textContent = ""), 2000);
    }
  
    function escapeHtml(s) {
      return s.replace(/[&<>"]+/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    }
  
    // UX nicety: show current URL in label
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.url) return;
      const u = new URL(tab.url);
      const label = document.querySelector("label input[value='exact']").parentElement;
      label.innerHTML = `<input type="radio" name="match-type" value="exact" checked> Exakte URL (${u.hostname}${u.pathname.length > 20 ? u.pathname.slice(0, 17) + '…' : u.pathname})`;
    });
  });
  