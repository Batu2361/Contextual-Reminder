(async function () {
    const storageArea = await getStorageArea();
    const currentUrl = location.href;
    const currentHostname = location.hostname;
    const { notes = [] } = await storageArea.get({ notes: [] });
  
    const matchingNotes = notes.filter((n) =>
      n.matchType === "exact" ? n.url === currentUrl : safeHostname(n.url) === currentHostname
    );
  
    matchingNotes.forEach((note, index) => {
      if (document.querySelector(`.contextual-note-container[data-note-id='${note.id}']`)) return;
      createEditableNote(note, index);
    });
  
    function createEditableNote(note, index) {
      const container = document.createElement("div");
      container.className = "contextual-note-container";
      container.dataset.noteId = note.id;
  
      // Initial position/size (persisted)
      const ui = note.ui || {};
      const offset = index * 28;
      container.style.top = typeof ui.top === "number" ? ui.top + "px" : 20 + offset + "px";
      container.style.left = typeof ui.left === "number" ? ui.left + "px" : 20 + offset + "px";
      if (ui.width) container.style.width = ui.width + "px";
      if (ui.height) container.style.height = ui.height + "px";
  
      // Header
      const header = document.createElement("div");
      header.className = "crqn-header";
  
      const colorDot = document.createElement("span");
      colorDot.className = "crqn-color";
      colorDot.style.background = note.color || "#f0c929";
  
      const title = document.createElement("input");
      title.className = "crqn-title";
      title.value = note.title || "Notiz";
      title.placeholder = "Titel";
  
      const actions = document.createElement("div");
      actions.className = "crqn-actions";
  
      const collapseBtn = document.createElement("button");
      collapseBtn.className = "crqn-icon-btn";
      collapseBtn.title = "Minimieren";
      collapseBtn.textContent = "▾";
  
      const closeBtn = document.createElement("button");
      closeBtn.className = "crqn-icon-btn";
      closeBtn.title = "Schließen";
      closeBtn.textContent = "✕";
  
      actions.append(collapseBtn, closeBtn);
      header.append(colorDot, title, actions);
  
      // Editor
      const editor = document.createElement("textarea");
      editor.className = "crqn-editor";
      editor.value = note.content || "";
  
      // Footer
      const footer = document.createElement("div");
      footer.className = "crqn-footer";
  
      const hint = document.createElement("span");
      hint.className = "crqn-save-feedback";
  
      const saveBtn = document.createElement("button");
      saveBtn.className = "crqn-save-btn";
      saveBtn.textContent = "Speichern";
  
      footer.append(hint, saveBtn);
  
      container.append(header, editor, footer);
      document.body.appendChild(container);
  
      // State & events
      makeDraggable(container, header, persistPosition);
      enableSizePersistence(container, persistSize);
  
      saveBtn.addEventListener("click", persistContent);
  
      const debouncedAutoSave = debounce(() => {
        persistContent(true);
      }, 500);
      editor.addEventListener("input", debouncedAutoSave);
      title.addEventListener("input", debouncedAutoSave);
  
      collapseBtn.addEventListener("click", () => {
        container.classList.toggle("collapsed");
        collapseBtn.textContent = container.classList.contains("collapsed") ? "▸" : "▾";
        persistUi({ collapsed: container.classList.contains("collapsed") });
      });
  
      closeBtn.addEventListener("click", () => container.remove());
  
      // Helpers
      async function persistContent(isAuto = false) {
        const { notes = [] } = await storageArea.get({ notes: [] });
        const idx = notes.findIndex((n) => n.id === note.id);
        if (idx < 0) return;
        notes[idx].content = editor.value;
        notes[idx].title = title.value || "Notiz";
        notes[idx].updatedAt = new Date().toISOString();
        await storageArea.set({ notes });
        if (!isAuto) {
          hint.textContent = "Gespeichert!";
          setTimeout(() => (hint.textContent = ""), 1500);
        }
      }
  
      async function persistPosition(top, left) {
        persistUi({ top, left });
      }
  
      async function persistSize(width, height) {
        persistUi({ width, height });
      }
  
      async function persistUi(patch) {
        const { notes = [] } = await storageArea.get({ notes: [] });
        const idx = notes.findIndex((n) => n.id === note.id);
        if (idx < 0) return;
        notes[idx].ui = { ...(notes[idx].ui || {}), ...patch };
        await storageArea.set({ notes });
      }
    }
  
    function makeDraggable(el, handle, onPersist) {
      let startX, startY, origX, origY;
      handle.style.cursor = "move";
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startX = e.clientX; startY = e.clientY;
        const rect = el.getBoundingClientRect();
        origX = rect.left + window.scrollX; origY = rect.top + window.scrollY;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp, { once: true });
      });
      function onMove(e) {
        const dx = e.clientX - startX; const dy = e.clientY - startY;
        let nextLeft = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, origX + dx));
        let nextTop = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, origY + dy));
        el.style.left = nextLeft + "px";
        el.style.top = nextTop + "px";
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        const rect = el.getBoundingClientRect();
        onPersist(Math.round(rect.top + window.scrollY), Math.round(rect.left + window.scrollX));
      }
    }
  
    function enableSizePersistence(el, onPersist) {
      let width = el.offsetWidth, height = el.offsetHeight;
      const obs = new ResizeObserver(() => {
        const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
        if (w !== width || h !== height) {
          width = w; height = h;
          onPersist(width, height);
        }
      });
      obs.observe(el);
    }
  
    function debounce(fn, ms) {
      let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(null, args), ms); };
    }
  
    async function getStorageArea() {
      const { useSync = false } = await chrome.storage.local.get({ useSync: false });
      return useSync && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
    }
  
    function safeHostname(u) {
      try { return new URL(u).hostname; } catch { return ""; }
    }
  })();
  