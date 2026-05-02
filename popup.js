// Popup entry point — ES module.

import { getStorageArea, loadNotes, saveNotes, getActiveTab, safeHostname }
  from "./lib/storage.js";
import { sanitizeNoteHtml, previewText, isValidNoteShape, sanitizeNote, extractTags }
  from "./lib/sanitize.js";

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (sel) => document.querySelector(sel);

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Page context detection ────────────────────────────────────────────
  const PAGE_TYPES = {
    product:  { icon: "🛍️", label: "Product",  hint: "Product name, price, or review" },
    code:     { icon: "⌨️", label: "Code",     hint: "Bug, feature idea, or snippet" },
    research: { icon: "📚", label: "Research", hint: "Key finding, source, or quote" },
    video:    { icon: "▶️", label: "Video",    hint: "Thought or timestamp" },
    article:  { icon: "📰", label: "Article",  hint: "Key point or note on the text" },
    general:  { icon: "📄", label: "Page",     hint: "Todo, idea, or reminder" },
  };

  function classifyPage({ url = "", host = "", ogType = "" }) {
    const u = url.toLowerCase();
    const h = host.toLowerCase();
    if (ogType === "product" || /\/(product|item|shop|store|buy|cart)\//i.test(u)) return "product";
    if (/github|gitlab|stackoverflow|codepen|replit/i.test(h))                    return "code";
    if (/wikipedia|britannica/i.test(h))                                           return "research";
    if (/youtube|vimeo|twitch|dailymotion/i.test(h))                              return "video";
    if (/medium|substack|news|blog/i.test(h))                                     return "article";
    return "general";
  }

  async function detectAndShowContext(tab) {
    if (!tab?.id || !tab.url?.startsWith("http")) return;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url:    location.href,
          host:   location.hostname,
          ogType: document.querySelector('meta[property="og:type"]')?.content || "",
        }),
      });
      if (!result) return;
      const type = classifyPage(result);
      const pt   = PAGE_TYPES[type];
      $("#context-icon").textContent  = pt.icon;
      $("#context-label").textContent = pt.label;
      $("#context-badge").hidden      = false;
      $("#note-text").dataset.placeholder = pt.hint + "…";
    } catch { /* chrome:// or restricted page */ }
  }

  // ── Badge ─────────────────────────────────────────────────────────────
  async function updateBadge() {
    const notes = await loadNotes();
    const badge = $("#notes-badge");
    badge.textContent = notes.length;
    badge.hidden      = notes.length === 0;
  }
  await updateBadge();

  // ── Auto-inject notes for the active tab (activeTab strategy) ─────────
  (async () => {
    try {
      const tab  = await getActiveTab();
      if (!tab?.id || !tab.url?.startsWith("http")) return;
      const all      = await loadNotes();
      const tabHost  = safeHostname(tab.url);
      const hasMatch = all.some((n) =>
        n.matchType === "exact" ? n.url === tab.url : safeHostname(n.url) === tabHost
      );
      if (hasMatch) chrome.runtime.sendMessage({ type: "INJECT_NOTES_FOR_TAB", tabId: tab.id });
    } catch { /* tab may not be accessible */ }
  })();

  // ── Tab navigation ────────────────────────────────────────────────────
  function switchTab(name) {
    ["add", "list", "settings"].forEach((v) => {
      $(`#view-${v}`).hidden = v !== name;
      $(`#tab-${v}`).classList.toggle("active", v === name);
    });
    if (name === "list") renderList();
  }

  ["add", "list", "settings"].forEach((v) => {
    $(`#tab-${v}`).addEventListener("click", () => {
      switchTab(v);
      if (v === "add") getActiveTab().then(detectAndShowContext);
    });
  });

  getActiveTab().then(detectAndShowContext);

  // ── Status messages ───────────────────────────────────────────────────
  let statusTimer = null;
  function showStatus(msg, type = "success") {
    const el  = $("#status-message");
    el.textContent = msg;
    el.className   = `status-${type}`;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ""; el.className = ""; }, 3000);
  }

  // ── Undo toast ────────────────────────────────────────────────────────
  let undoTimer = null;
  function showUndoToast(label, onUndo) {
    document.getElementById("undo-toast")?.remove();
    clearTimeout(undoTimer);
    const toast = document.createElement("div");
    toast.id        = "undo-toast";
    toast.className = "undo-toast";
    toast.innerHTML = `<span>${escHtml(label)}</span><button class="undo-action">Undo</button>`;
    document.body.appendChild(toast);
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      toast.classList.add("hiding");
      setTimeout(() => toast.remove(), 260);
    };
    undoTimer = setTimeout(dismiss, 4500);
    toast.querySelector(".undo-action").addEventListener("click", () => {
      clearTimeout(undoTimer);
      dismiss();
      onUndo();
    });
  }

  // ── Command bar (Spotlight-style) ─────────────────────────────────────
  const cmdBar     = $("#cmd-bar");
  const cmdInput   = $("#cmd-input");
  const cmdResults = $("#cmd-results");
  let cmdSelectedIdx = -1;
  let cmdItems = [];

  const STATIC_COMMANDS = [
    {
      icon: "✏️", label: "New note",
      action: () => { closeCmdBar(); switchTab("add"); $("#note-title").focus(); },
    },
    {
      icon: "📋", label: "All notes",
      action: () => { closeCmdBar(); switchTab("list"); requestAnimationFrame(() => $("#search").focus()); },
    },
    {
      icon: "⚙️", label: "Settings",
      action: () => { closeCmdBar(); switchTab("settings"); },
    },
    {
      icon: "↳", label: "Capture selection",
      action: () => { closeCmdBar(); switchTab("add"); $("#capture-btn").click(); },
    },
  ];

  function openCmdBar() {
    cmdBar.hidden = false;
    cmdInput.value = "";
    renderCmdResults("");
    requestAnimationFrame(() => cmdInput.focus());
  }

  function closeCmdBar() {
    cmdBar.hidden    = true;
    cmdInput.value   = "";
    cmdSelectedIdx   = -1;
  }

  async function renderCmdResults(query) {
    const q = query.trim().toLowerCase();
    cmdItems = [];

    if (q) {
      // Quick "create" shortcut at the top.
      cmdItems.push({
        icon:   "✏️",
        label:  `Create note: "${query.slice(0, 40)}"`,
        type:   "create",
        action: () => { closeCmdBar(); switchTab("add"); setNoteText(query); $("#note-text").focus(); },
      });
      // Search through existing notes.
      const notes   = await loadNotes();
      const matches = notes
        .filter((n) =>
          n.title.toLowerCase().includes(q) ||
          previewText(n.content).toLowerCase().includes(q) ||
          (n.tags || []).some((t) => t.includes(q))
        )
        .slice(0, 4);
      matches.forEach((n) =>
        cmdItems.push({
          color: n.color, label: n.title, meta: safeHostname(n.url),
          type: "note",
          action: () => { closeCmdBar(); switchTab("list"); },
        })
      );
    }

    const filtered = q
      ? STATIC_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      : STATIC_COMMANDS;
    filtered.forEach((c) => cmdItems.push({ ...c, type: "action" }));

    cmdResults.innerHTML = "";
    cmdItems.forEach((item, i) => {
      const el       = document.createElement("div");
      el.className   = "cmd-item";
      el.dataset.idx = i;

      const iconEl = document.createElement("div");
      iconEl.className = "cmd-item-icon";
      if (item.color && item.type === "note") {
        const dot = document.createElement("div");
        dot.className       = "cmd-note-dot";
        dot.style.background = item.color;
        iconEl.appendChild(dot);
      } else {
        iconEl.textContent = item.icon || "📌";
      }

      const body = document.createElement("div");
      body.className = "cmd-item-body";
      body.innerHTML = `
        <div class="cmd-item-label">${escHtml(item.label)}</div>
        ${item.meta ? `<div class="cmd-item-meta">${escHtml(item.meta)}</div>` : ""}`;

      el.append(iconEl, body);
      el.addEventListener("mouseenter", () => setCmdSelected(i));
      el.addEventListener("mousedown",  (e) => e.preventDefault());
      el.addEventListener("click", () => {
        try { item.action(); } catch (err) { console.error("Command action failed:", err); closeCmdBar(); }
      });
      cmdResults.appendChild(el);
    });

    if (cmdItems.length > 0) setCmdSelected(0);
  }

  function setCmdSelected(idx) {
    cmdSelectedIdx = idx;
    cmdResults.querySelectorAll(".cmd-item").forEach((el, i) =>
      el.classList.toggle("selected", i === idx)
    );
  }

  cmdInput.addEventListener("input",   () => renderCmdResults(cmdInput.value));
  cmdInput.addEventListener("keydown", (e) => {
    const total = cmdItems.length;
    if (!total) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCmdSelected((cmdSelectedIdx + 1) % total); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setCmdSelected((cmdSelectedIdx - 1 + total) % total); }
    if (e.key === "Enter") {
      e.preventDefault();
      const idx = cmdSelectedIdx >= 0 ? cmdSelectedIdx : 0;
      try { cmdItems[idx]?.action(); } catch (err) { console.error(err); closeCmdBar(); }
    }
  });

  $("#cmd-backdrop").addEventListener("click", closeCmdBar);
  $("#cmd-trigger").addEventListener("click",  openCmdBar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !cmdBar.hidden) { closeCmdBar(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      cmdBar.hidden ? openCmdBar() : closeCmdBar();
    }
  });

  // ── Rich editor (new note form) ───────────────────────────────────────
  const noteText    = $("#note-text");
  const richToolbar = $("#rich-toolbar");

  const getNoteHtml  = ()  => noteText.innerHTML.trim();
  const getNoteText  = ()  => (noteText.textContent || "").trim();

  function setNoteText(plain) {
    if (!plain) {
      noteText.innerHTML = "";
    } else {
      noteText.innerHTML = plain
        .split("\n")
        .map((l) => `<div>${escHtml(l) || "<br>"}</div>`)
        .join("");
    }
    refreshEditor();
  }

  function clearNote() { noteText.innerHTML = ""; refreshEditor(); }

  function refreshEditor() {
    const empty = !noteText.textContent.trim() && !noteText.querySelector("input,img");
    noteText.classList.toggle("empty", empty);
    refreshToolbarState();
    updateCharCount();
  }

  function updateCharCount() {
    const n = noteText.textContent.length;
    $("#char-count").textContent = n > 0 ? `${n} chars` : "";
  }

  function refreshToolbarState() {
    const mapping = {
      bold:      "bold",
      italic:    "italic",
      underline: "underline",
      list:      "insertUnorderedList",
    };
    for (const [key, qc] of Object.entries(mapping)) {
      const btn = richToolbar.querySelector(`[data-cmd="${key}"]`);
      if (!btn) continue;
      try { btn.classList.toggle("active", document.queryCommandState(qc)); } catch { /* unsupported */ }
    }
    const block = getCurrentEditorBlock();
    richToolbar.querySelector('[data-cmd="heading"]')
      .classList.toggle("active", !!(block && /^H[1-6]$/i.test(block.tagName)));
  }

  function getCurrentEditorBlock() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    let node = sel.anchorNode;
    while (node && node !== noteText) {
      if (node.nodeType === 1 && /^(DIV|P|H[1-6]|LI)$/i.test(node.tagName)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function placeCursorAtEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function applyRichCommand(cmd) {
    noteText.focus();
    switch (cmd) {
      case "bold":      document.execCommand("bold");               break;
      case "italic":    document.execCommand("italic");             break;
      case "underline": document.execCommand("underline");          break;
      case "list":      document.execCommand("insertUnorderedList"); break;
      case "heading": {
        const block = getCurrentEditorBlock();
        const tag   = block?.tagName?.toLowerCase();
        if (tag === "h2")      document.execCommand("formatBlock", false, "h3");
        else if (tag === "h3") document.execCommand("formatBlock", false, "p");
        else                   document.execCommand("formatBlock", false, "h2");
        break;
      }
      case "checklist": {
        const existing = window.getSelection()?.anchorNode?.parentElement?.closest(".task-item");
        if (existing) {
          const div = document.createElement("div");
          div.textContent = existing.querySelector(".task-text")?.textContent || "";
          existing.replaceWith(div);
          placeCursorAtEnd(div);
        } else {
          const block = getCurrentEditorBlock() || noteText;
          const text  = block === noteText ? "" : block.textContent;
          const item  = buildChecklistItem(text);
          if (block === noteText) noteText.appendChild(item);
          else block.replaceWith(item);
          placeCursorAtEnd(item.querySelector(".task-text"));
        }
        break;
      }
    }
    refreshToolbarState();
  }

  function buildChecklistItem(text) {
    const item  = document.createElement("div");
    item.className = "task-item";
    const cb    = document.createElement("input");
    cb.type     = "checkbox";
    const span  = document.createElement("span");
    span.className       = "task-text";
    span.contentEditable = "true";
    span.textContent     = text || "";
    item.append(cb, span);
    return item;
  }

  richToolbar.addEventListener("mousedown", (e) => e.preventDefault());
  richToolbar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-cmd]");
    if (!btn) return;
    e.preventDefault();
    applyRichCommand(btn.dataset.cmd);
    refreshEditor();
  });

  noteText.addEventListener("keydown", (e) => {
    // Markdown shortcuts: "# " → heading, "- " → list, "[] " → task.
    if (e.key === " ") {
      const sel = window.getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const block = getCurrentEditorBlock();
        if (block) {
          const t = block.textContent;
          let kind = null;
          if (t === "#")                    kind = "h2";
          else if (t === "##")              kind = "h3";
          else if (t === "-" || t === "*")  kind = "ul";
          else if (t === "[]" || t === "[ ]") kind = "task";
          if (kind) {
            e.preventDefault();
            block.textContent = "";
            placeCursorAtEnd(block);
            if (kind === "h2" || kind === "h3") document.execCommand("formatBlock", false, kind);
            else if (kind === "ul")             document.execCommand("insertUnorderedList");
            else if (kind === "task")           applyRichCommand("checklist");
            refreshEditor();
            return;
          }
        }
      }
    }
    // Keyboard shortcuts: ⌘B / ⌘I / ⌘U.
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if      (key === "b") { e.preventDefault(); applyRichCommand("bold"); }
    else if (key === "i") { e.preventDefault(); applyRichCommand("italic"); }
    else if (key === "u") { e.preventDefault(); applyRichCommand("underline"); }
  });

  noteText.addEventListener("input",   refreshEditor);
  noteText.addEventListener("keyup",   refreshToolbarState);
  noteText.addEventListener("mouseup", refreshToolbarState);
  noteText.addEventListener("click", (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      e.target.closest(".task-item")?.classList.toggle("done", e.target.checked);
    }
  });
  noteText.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text/plain");
    document.execCommand("insertText", false, text);
  });

  // Image drag & drop into the popup editor.
  noteText.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  noteText.addEventListener("drop", (e) => {
    const images = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    images.forEach((file) => {
      if (file.size > 2 * 1024 * 1024) { showStatus("Image too large (max 2 MB).", "error"); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = document.createElement("img");
        img.src       = ev.target.result;
        img.alt       = file.name;
        img.style.cssText = "max-width:100%;height:auto;display:block;object-fit:contain";
        noteText.appendChild(img);
        refreshEditor();
      };
      reader.readAsDataURL(file);
    });
  });

  refreshEditor();

  // ── Color swatches ────────────────────────────────────────────────────
  let selectedColor = "#f0c929";
  document.querySelectorAll("#color-presets .color-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll("#color-presets .color-swatch")
        .forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      selectedColor = sw.dataset.color;
    });
  });

  // ── Context menu capture (right-click → "Create note from selection") ─
  const { pendingCapture } = await chrome.storage.local.get({ pendingCapture: null });
  if (pendingCapture?.text) {
    await chrome.storage.local.remove("pendingCapture");
    setNoteText(pendingCapture.text);
    if (pendingCapture.pageTitle) $("#note-title").value = pendingCapture.pageTitle.slice(0, 80);
    showStatus("Text captured from context menu ✓");
  }

  // ── Capture selection button ──────────────────────────────────────────
  $("#capture-btn").addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) { showStatus("No active page.", "error"); return; }
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func:   () => window.getSelection().toString().trim(),
      });
      if (result) {
        noteText.focus();
        document.execCommand("insertText", false, (getNoteText() ? "\n" : "") + result);
        refreshEditor();
        showStatus("Selection captured ✓");
      } else {
        showStatus("Nothing selected on the page.", "error");
      }
    } catch { showStatus("Cannot access this page.", "error"); }
  });

  // ── Save note ─────────────────────────────────────────────────────────
  async function saveCurrentNote() {
    const html  = sanitizeNoteHtml(getNoteHtml());
    const plain = getNoteText();
    if (!plain) { showStatus("Please add some content.", "error"); return; }

    const tab = await getActiveTab();
    if (!tab?.url) { showStatus("Could not detect the active page.", "error"); return; }

    const notes = await loadNotes();
    notes.push({
      id:        `note_${Date.now()}`,
      url:       tab.url,
      title:     $("#note-title").value.trim() || tab.title?.slice(0, 80) || "Note",
      content:   html,
      color:     selectedColor,
      matchType: $("input[name='match-type']:checked").value,
      tags:      extractTags(plain),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned:    false,
      ui:        { collapsed: false },
    });

    await saveNotes(notes);
    clearNote();
    $("#note-title").value = "";
    await updateBadge();
    showStatus("Note saved ✓");
  }

  $("#save-button").addEventListener("click", saveCurrentNote);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      if ($("#view-add").hidden) return;
      e.preventDefault();
      saveCurrentNote();
    }
  });

  // ── Tag filter state ──────────────────────────────────────────────────
  let activeTagFilter = null;

  function setTagFilter(tag) {
    activeTagFilter = activeTagFilter === tag ? null : tag;
    renderTagFilterRow();
    renderList();
  }

  function renderTagFilterRow() {
    loadNotes().then((notes) => {
      const allTags = [...new Set(notes.flatMap((n) => n.tags || []))].sort();
      const row     = $("#tag-filter-row");
      const chips   = $("#tag-filter-chips");
      const clearBtn = $("#tag-filter-clear");
      row.hidden    = allTags.length === 0;
      chips.innerHTML = "";
      allTags.forEach((tag) => {
        const chip = document.createElement("button");
        chip.className   = "tag-chip" + (activeTagFilter === tag ? " active" : "");
        chip.textContent = "#" + tag;
        chip.addEventListener("click", () => setTagFilter(tag));
        chips.appendChild(chip);
      });
      clearBtn.hidden  = !activeTagFilter;
      clearBtn.onclick = () => { activeTagFilter = null; renderTagFilterRow(); renderList(); };
    });
  }

  // ── Note list ─────────────────────────────────────────────────────────
  async function renderList() {
    let notes    = await loadNotes();
    const q      = $("#search").value.trim().toLowerCase();
    const sort   = $("#sort").value;
    const container = $("#all-notes-container");

    // Filter by search query.
    if (q) {
      notes = notes.filter((n) =>
        n.title.toLowerCase().includes(q) ||
        previewText(n.content).toLowerCase().includes(q) ||
        safeHostname(n.url).includes(q) ||
        (n.tags || []).some((t) => t.includes(q))
      );
    }
    // Filter by active tag.
    if (activeTagFilter) notes = notes.filter((n) => (n.tags || []).includes(activeTagFilter));

    // Sort.
    if (sort === "newest")      notes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else if (sort === "oldest") notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    else if (sort === "title")  notes.sort((a, b) => a.title.localeCompare(b.title, "en"));

    // Pinned notes always appear first.
    notes = [...notes.filter((n) => n.pinned), ...notes.filter((n) => !n.pinned)];

    if (!notes.length) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <p>${q ? `No results for "${escHtml(q)}"` : "No notes yet"}</p>
        </div>`;
      return;
    }

    const tab  = await getActiveTab();
    container.innerHTML = "";
    const list = document.createElement("div");
    list.className = "notes-list";

    notes.forEach((note) => {
      const isCurrentPage = tab?.url && (
        note.matchType === "exact"
          ? note.url === tab.url
          : safeHostname(note.url) === safeHostname(tab.url)
      );
      const date = new Date(note.createdAt).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "2-digit",
      });
      const host = safeHostname(note.url) || note.url;

      const card = document.createElement("div");
      card.className = "note-item";
      card.style.borderLeftColor = note.color || "var(--accent)";

      const tagHtml = (note.tags || []).length
        ? `<div class="note-tag-row">${note.tags
            .map((t) => `<span class="note-tag${activeTagFilter === t ? " active" : ""}" data-tag="${escHtml(t)}">#${escHtml(t)}</span>`)
            .join("")}</div>`
        : "";

      card.innerHTML = `
        <div class="top">
          <div class="title-block">
            <div class="title">
              ${note.pinned ? '<span class="pin-indicator">↑</span>' : ""}
              ${note.anchor ? '<span class="anchor-indicator" title="Pinned to an element">📍</span>' : ""}
              ${escHtml(note.title)}
              ${isCurrentPage ? '<span class="current-page-badge">This page</span>' : ""}
            </div>
            <div class="meta">${date} · ${escHtml(host)}</div>
          </div>
          <div class="actions">
            <button class="btn-icon pin-btn ${note.pinned ? "pinned" : ""}" title="${note.pinned ? "Unpin" : "Pin"}">${note.pinned ? "★" : "☆"}</button>
            <button class="btn-icon open-btn" title="Open page">↗</button>
            <button class="btn-icon copy-btn" title="Copy content">⎘</button>
            <button class="edit">Edit</button>
            <button class="delete">Delete</button>
          </div>
        </div>
        <div class="content"></div>
        ${tagHtml}`;

      // Set text content safely (not via innerHTML) to avoid XSS.
      card.querySelector(".content").textContent = previewText(note.content);

      // Tag chip clicks → set filter.
      card.querySelectorAll(".note-tag").forEach((el) => {
        el.addEventListener("click", () => setTagFilter(el.dataset.tag));
      });

      card.querySelector(".pin-btn").addEventListener("click", async () => {
        const all = await loadNotes();
        const idx = all.findIndex((n) => n.id === note.id);
        if (idx !== -1) { all[idx].pinned = !all[idx].pinned; await saveNotes(all); }
        renderList();
      });

      card.querySelector(".copy-btn").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(previewText(note.content));
          const btn = card.querySelector(".copy-btn");
          btn.textContent = "✓";
          btn.classList.add("copied");
          setTimeout(() => { btn.textContent = "⎘"; btn.classList.remove("copied"); }, 1800);
        } catch { showStatus("Copy failed.", "error"); }
      });

      card.querySelector(".open-btn").addEventListener("click", async () => {
        try {
          const tabs     = await chrome.tabs.query({});
          const existing = tabs.find((t) => t.url === note.url);
          if (existing) {
            await chrome.tabs.update(existing.id, { active: true });
            if (existing.windowId != null)
              await chrome.windows.update(existing.windowId, { focused: true });
          } else {
            await chrome.tabs.create({ url: note.url });
          }
          window.close();
        } catch { showStatus("Could not open the page.", "error"); }
      });

      // Edit button: uses named handlers instead of cloneNode (anti-pattern).
      const editBtn = card.querySelector(".edit");
      function onEditClick() {
        editBtn.removeEventListener("click", onEditClick);
        startEdit(card, note, editBtn, () => editBtn.addEventListener("click", onEditClick));
      }
      editBtn.addEventListener("click", onEditClick);

      card.querySelector(".delete").addEventListener("click", async () => {
        const all     = await loadNotes();
        const deleted = all.find((n) => n.id === note.id);
        if (!deleted) return;
        await saveNotes(all.filter((n) => n.id !== note.id));
        await updateBadge();
        renderTagFilterRow();
        renderList();
        showUndoToast(`"${deleted.title}" deleted`, async () => {
          const cur = await loadNotes();
          // Re-insert at its original chronological position.
          const at = cur.findIndex((n) => n.createdAt > deleted.createdAt);
          at === -1 ? cur.push(deleted) : cur.splice(at, 0, deleted);
          await saveNotes(cur);
          await updateBadge();
          renderList();
        });
      });

      list.appendChild(card);
    });

    container.appendChild(list);
    renderTagFilterRow();
  }

  // ── In-place note editor ──────────────────────────────────────────────
  function startEdit(card, note, editBtn, onDone) {
    const content = card.querySelector(".content");
    content.innerHTML       = sanitizeNoteHtml(note.content || "");
    content.contentEditable = "true";
    content.classList.add("editing");
    content.focus();
    placeCursorAtEnd(content);

    const toolbar = document.createElement("div");
    toolbar.className = "edit-mini-toolbar";
    toolbar.innerHTML = `
      <button data-cmd="heading"   title="Style">Aa</button>
      <span class="rt-sep"></span>
      <button data-cmd="bold"      title="Bold (⌘B)"><b>B</b></button>
      <button data-cmd="italic"    title="Italic (⌘I)"><i>I</i></button>
      <button data-cmd="underline" title="Underline (⌘U)"><u>U</u></button>
      <span class="rt-sep"></span>
      <button data-cmd="list"      title="Bullet list">•</button>
      <button data-cmd="checklist" title="To-do">☐</button>
      <span class="rt-sep"></span>
      <button data-cmd="anchor" class="ea-btn ${note.anchor ? "active" : ""}" title="Pin to element">📍</button>`;
    content.before(toolbar);

    toolbar.addEventListener("mousedown", (e) => e.preventDefault());
    toolbar.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-cmd]");
      if (!btn) return;
      e.preventDefault();
      const cmd = btn.dataset.cmd;

      if (cmd === "anchor") {
        await handleAnchorInEdit(note, content, toolbar);
        return;
      }

      content.focus();
      if (cmd === "heading") { showStylePopover(btn, content); return; }
      if (cmd === "bold")           document.execCommand("bold");
      else if (cmd === "italic")    document.execCommand("italic");
      else if (cmd === "underline") document.execCommand("underline");
      else if (cmd === "list")      document.execCommand("insertUnorderedList");
      else if (cmd === "checklist") {
        const item = buildChecklistItem(window.getSelection()?.toString() || "");
        const r    = window.getSelection()?.getRangeAt(0);
        if (r) { r.deleteContents(); r.insertNode(item); }
      }
    });

    // Named event handlers so we can cleanly remove them.
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if      (k === "b") { e.preventDefault(); document.execCommand("bold"); }
      else if (k === "i") { e.preventDefault(); document.execCommand("italic"); }
      else if (k === "u") { e.preventDefault(); document.execCommand("underline"); }
    };
    const onCheckbox = (e) => {
      if (e.target.matches('input[type="checkbox"]'))
        e.target.closest(".task-item")?.classList.toggle("done", e.target.checked);
    };
    const onPaste = (e) => {
      e.preventDefault();
      document.execCommand("insertText", false,
        (e.clipboardData || window.clipboardData).getData("text/plain"));
    };

    content.addEventListener("keydown", onKey);
    content.addEventListener("click",   onCheckbox);
    content.addEventListener("paste",   onPaste);

    editBtn.textContent = "Save";
    editBtn.className   = "save";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className   = "cancel";
    editBtn.after(cancelBtn);

    const originalHtml = note.content || "";

    const teardown = () => {
      content.removeEventListener("keydown", onKey);
      content.removeEventListener("click",   onCheckbox);
      content.removeEventListener("paste",   onPaste);
      toolbar.remove();
      content.classList.remove("editing");
      content.contentEditable = "false";
      cancelBtn.remove();
      editBtn.textContent = "Edit";
      editBtn.className   = "edit";
      onDone?.();
    };

    const onSave = async () => {
      editBtn.removeEventListener("click",  onSave);
      cancelBtn.removeEventListener("click", onCancel);
      const newHtml = sanitizeNoteHtml(content.innerHTML);
      teardown();
      if (newHtml === originalHtml) { renderList(); return; }
      const all = await loadNotes();
      const idx = all.findIndex((n) => n.id === note.id);
      if (idx !== -1) {
        all[idx].content   = newHtml;
        all[idx].tags      = extractTags(content.textContent || "");
        all[idx].updatedAt = new Date().toISOString();
        await saveNotes(all);
      }
      renderList();
    };

    const onCancel = () => {
      editBtn.removeEventListener("click",  onSave);
      cancelBtn.removeEventListener("click", onCancel);
      content.textContent = previewText(originalHtml);
      teardown();
      renderList();
    };

    editBtn.addEventListener("click",   onSave);
    cancelBtn.addEventListener("click", onCancel);
  }

  async function handleAnchorInEdit(note, content, toolbar) {
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url) { showStatus("No active page detected.", "error"); return; }

    const noteHost = safeHostname(note.url);
    const tabHost  = safeHostname(tab.url);
    const onCorrectPage = note.matchType === "exact"
      ? note.url === tab.url
      : noteHost && noteHost === tabHost;

    // Save current edits first so they aren't lost.
    const newHtml = sanitizeNoteHtml(content.innerHTML);
    const all     = await loadNotes();
    const idx     = all.findIndex((n) => n.id === note.id);
    if (idx !== -1) {
      all[idx].content   = newHtml;
      all[idx].updatedAt = new Date().toISOString();
      await saveNotes(all);
    }

    if (!onCorrectPage) {
      const go = confirm(`This note belongs to:\n${note.url}\n\nOpen that page to set an anchor?`);
      if (!go) return;
      await chrome.storage.local.set({ pendingAnchorEdit: { noteId: note.id } });
      const tabs     = await chrome.tabs.query({});
      const existing = tabs.find((t) => t.url === note.url);
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
        await chrome.scripting.executeScript({ target: { tabId: existing.id }, func: anchorPickerInPage });
      } else {
        const newTab = await chrome.tabs.create({ url: note.url });
        const onUpdated = (tabId, info) => {
          if (tabId === newTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.scripting.executeScript({ target: { tabId }, func: anchorPickerInPage }).catch(() => {});
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
      window.close();
      return;
    }

    await chrome.storage.local.set({ pendingAnchorEdit: { noteId: note.id } });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: anchorPickerInPage });
      window.close();
    } catch {
      showStatus("Cannot access this page.", "error");
      await chrome.storage.local.remove("pendingAnchorEdit");
    }
  }

  // ── Style popover (Aa button inside edit toolbar) ─────────────────────
  function showStylePopover(anchorEl, editorEl) {
    document.querySelector(".popup-style-popover")?.remove();
    const r   = anchorEl.getBoundingClientRect();
    const pop = document.createElement("div");
    pop.className = "popup-style-popover";
    pop.style.top  = (r.bottom + 4) + "px";
    pop.style.left = r.left + "px";
    pop.innerHTML = `
      <button data-style="title"      class="sp-title">Title</button>
      <button data-style="heading"    class="sp-h2">Heading</button>
      <button data-style="subheading" class="sp-h3">Subheading</button>
      <button data-style="body"       class="sp-body">Body</button>
      <button data-style="mono"       class="sp-mono">Monospaced</button>`;
    document.body.appendChild(pop);
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    pop.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-style]");
      if (!btn) return;
      editorEl.focus();
      const tagMap = { title: "h1", heading: "h2", subheading: "h3", body: "p", mono: "pre" };
      document.execCommand("formatBlock", false, tagMap[btn.dataset.style]);
      pop.remove();
      cleanup();
    });
    const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); cleanup(); } };
    const onEsc = (e) => { if (e.key === "Escape") { pop.remove(); cleanup(); } };
    const cleanup = () => {
      document.removeEventListener("click",   onOutside, true);
      document.removeEventListener("keydown", onEsc);
    };
    setTimeout(() => {
      document.addEventListener("click",   onOutside, true);
      document.addEventListener("keydown", onEsc);
    }, 0);
  }

  // ── Search & sort ─────────────────────────────────────────────────────
  $("#search").addEventListener("input",  renderList);
  $("#sort").addEventListener("change",   renderList);

  // ── JSON export ───────────────────────────────────────────────────────
  $("#export-btn").addEventListener("click", async () => {
    const notes = await loadNotes();
    const blob  = new Blob([JSON.stringify({ notes }, null, 2)], { type: "application/json" });
    downloadBlob(blob, `notes-${isoDate()}.json`);
  });

  // ── Markdown export ───────────────────────────────────────────────────
  $("#export-md-btn").addEventListener("click", async () => {
    const notes = await loadNotes();
    const md    = notes.map(noteToMarkdown).join("\n\n---\n\n");
    downloadBlob(new Blob([md], { type: "text/markdown" }), `notes-${isoDate()}.md`);
  });

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function isoDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function noteToMarkdown(note) {
    const lines = [`# ${note.title}`, ""];
    if (note.tags?.length) lines.push(`**Tags:** ${note.tags.map((t) => `#${t}`).join(" ")}`, "");
    lines.push(
      `**URL:** ${note.url}`,
      `**Date:** ${new Date(note.createdAt).toLocaleDateString("en-US")}`,
      "", "---", "",
      htmlToMarkdown(note.content)
    );
    return lines.join("\n");
  }

  function htmlToMarkdown(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = sanitizeNoteHtml(html || "");
    return nodeToMarkdown(tmp).replace(/\n{3,}/g, "\n\n").trim();
  }

  function nodeToMarkdown(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag   = child.tagName.toLowerCase();
      const inner = nodeToMarkdown(child);
      switch (tag) {
        case "h1":                      out += `\n# ${inner}\n`;             break;
        case "h2":                      out += `\n## ${inner}\n`;            break;
        case "h3":                      out += `\n### ${inner}\n`;           break;
        case "h4":                      out += `\n#### ${inner}\n`;          break;
        case "b": case "strong":        out += `**${inner}**`;               break;
        case "i": case "em":            out += `*${inner}*`;                 break;
        case "u":                       out += `__${inner}__`;               break;
        case "s":                       out += `~~${inner}~~`;               break;
        case "a":                       out += `[${inner}](${child.getAttribute("href") || ""})`; break;
        case "code":                    out += `\`${inner}\``;               break;
        case "pre":                     out += `\n\`\`\`\n${inner}\n\`\`\`\n`; break;
        case "blockquote":              out += `\n> ${inner.replace(/\n/g, "\n> ")}\n`; break;
        case "ul": case "ol":           out += inner;                        break;
        case "li":                      out += `\n- ${inner}`;               break;
        case "br":                      out += "\n";                         break;
        case "hr":                      out += "\n---\n";                    break;
        case "img":                     out += `![${child.getAttribute("alt") || "image"}](embedded)`; break;
        case "div": case "p":           out += `\n${inner}`;                 break;
        default:                        out += inner;                        break;
      }
    }
    return out;
  }

  // ── JSON import ───────────────────────────────────────────────────────
  $("#import-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showStatus("File too large (max 10 MB).", "error");
      e.target.value = "";
      return;
    }
    try {
      const raw  = await file.text();
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : Array.isArray(data?.notes) ? data.notes : null;
      if (!list) throw new Error("No notes array found in file");

      const valid   = [];
      const skipped = [];
      for (const item of list) {
        if (!isValidNoteShape(item)) { skipped.push(item); continue; }
        valid.push(sanitizeNote(item));
      }

      if (!valid.length) {
        showStatus("No valid notes found in the file.", "error");
        e.target.value = "";
        return;
      }

      const existing = await loadNotes();
      const ids      = new Set(existing.map((n) => n.id));
      const fresh    = valid.filter((n) => !ids.has(n.id));
      await saveNotes([...existing, ...fresh]);
      await updateBadge();
      showStatus(
        skipped.length
          ? `${fresh.length} imported ✓ (${skipped.length} skipped)`
          : `${fresh.length} note(s) imported ✓`
      );
      renderList();
    } catch (err) {
      console.error("Import failed:", err);
      showStatus("Invalid or corrupted file.", "error");
    }
    e.target.value = "";
  });

  // ── Settings — sync toggle ────────────────────────────────────────────
  const syncToggle   = $("#sync-toggle");
  const { useSync = false } = await chrome.storage.local.get({ useSync: false });
  syncToggle.checked = useSync;
  updateStorageInfo(useSync);

  syncToggle.addEventListener("change", async () => {
    await chrome.storage.local.set({ useSync: syncToggle.checked });
    updateStorageInfo(syncToggle.checked);
  });

  function updateStorageInfo(syncing) {
    $("#storage-kind").hidden      = false;
    $("#storage-kind-text").textContent = syncing
      ? "Active: cross-device sync (chrome.storage.sync)"
      : "Active: local storage (chrome.storage.local)";
  }

  // ── Settings — auto-load toggle (optional <all_urls> permission) ──────
  const autoLoadToggle = $("#auto-load-toggle");
  const hasPermission  = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  autoLoadToggle.checked = hasPermission;

  autoLoadToggle.addEventListener("change", async () => {
    if (autoLoadToggle.checked) {
      const granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
      if (!granted) {
        autoLoadToggle.checked = false;
        showStatus("Permission denied.", "error");
      } else {
        showStatus("Auto-load enabled ✓");
      }
    } else {
      await chrome.permissions.remove({ origins: ["<all_urls>"] });
      showStatus("Auto-load disabled.");
    }
  });

  // ── Anchor picker injected into the page (self-contained function) ────
  // This runs inside the page's context via chrome.scripting.executeScript,
  // so it has no access to any popup variables — it must be fully self-contained.
  function anchorPickerInPage() {
    const STABLE_DATA_ATTRS = ["data-testid","data-id","data-key","data-cy","data-qa","data-name"];

    function isStableId(id) {
      if (!id) return false;
      if (/^[0-9]+$/.test(id))         return false;
      if (/^[:].+[:]$/.test(id))       return false;
      if (/^[a-z]+-[0-9]+$/i.test(id)) return false;
      if (/^[a-f0-9]{8,}$/i.test(id))  return false;
      return true;
    }

    function buildCssPath(el) {
      const path = []; let curr = el, depth = 0;
      while (curr && curr.nodeType === 1 && curr.tagName !== "BODY" && depth < 6) {
        let part = curr.tagName.toLowerCase();
        if (curr.id && isStableId(curr.id)) {
          try { path.unshift(part + "#" + CSS.escape(curr.id)); } catch { path.unshift(part); }
          break;
        }
        if (typeof curr.className === "string") {
          const cls = curr.className.split(/\s+/)
            .filter((c) => c && /^[a-zA-Z][a-zA-Z-]*$/.test(c) && c.length <= 30)
            .slice(0, 2);
          if (cls.length) part += "." + cls.join(".");
        }
        const parent = curr.parentNode;
        if (parent?.children) {
          const sibs = Array.from(parent.children).filter((c) => c.tagName === curr.tagName);
          if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(curr) + 1})`;
        }
        path.unshift(part); curr = curr.parentElement; depth++;
      }
      return path.join(" > ");
    }

    function getRobustSelectorData(el) {
      for (const attr of STABLE_DATA_ATTRS) {
        const v = el.getAttribute(attr);
        if (v) return { type: "attr", attr, value: v };
      }
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return { type: "aria-label", value: ariaLabel };
      const name = el.getAttribute("name");
      if (name) return { type: "name", tag: el.tagName.toLowerCase(), value: name };
      if (el.id && isStableId(el.id)) return { type: "id", value: el.id };
      return { type: "css", value: buildCssPath(el) };
    }

    function createAnchorData(el) {
      return {
        id:           el.id && isStableId(el.id) ? el.id : null,
        selectorData: getRobustSelectorData(el),
        selector:     buildCssPath(el),
        tag:          el.tagName.toLowerCase(),
        text:         (el.textContent || "").trim().slice(0, 120),
        classes:      (typeof el.className === "string" ? el.className : "")
          .split(/\s+/)
          .filter((c) => c && /^[a-zA-Z][a-zA-Z-]*$/.test(c) && c.length <= 30)
          .slice(0, 3),
      };
    }

    function makeToast(msg, bg) {
      const t = document.createElement("div");
      t.textContent = msg;
      Object.assign(t.style, {
        position:     "fixed",
        bottom:       "24px",
        left:         "50%",
        transform:    "translateX(-50%)",
        background:   bg || "#1d1d1f",
        color:        "#fff",
        padding:      "10px 18px",
        borderRadius: "999px",
        font:         "600 13px/1 -apple-system, system-ui, sans-serif",
        boxShadow:    "0 8px 28px rgba(0,0,0,0.25)",
        zIndex:       "2147483647",
        pointerEvents:"none",
      });
      document.body.appendChild(t);
      return t;
    }

    (async () => {
      const data = await chrome.storage.local.get(["pendingAnchorDraft", "pendingAnchorEdit", "useSync"]);
      if (!data.pendingAnchorDraft && !data.pendingAnchorEdit) return;

      const styleTag = document.createElement("style");
      styleTag.textContent = "html,body,body *{cursor:crosshair !important}";
      document.head.appendChild(styleTag);

      const hint = makeToast("Click an element to anchor the note — Esc to cancel");
      let highlighted = null;
      let prevStyle   = { outline: "", offset: "" };

      const onMove = (e) => {
        const el = e.target;
        if (highlighted && highlighted !== el) {
          highlighted.style.outline       = prevStyle.outline;
          highlighted.style.outlineOffset = prevStyle.offset;
        }
        if (!el || el === document.body || el === document.documentElement || hint.contains(el)) return;
        if (highlighted !== el) prevStyle = { outline: el.style.outline, offset: el.style.outlineOffset };
        el.style.outline       = "3px solid #007AFF";
        el.style.outlineOffset = "2px";
        highlighted = el;
      };

      const cleanup = () => {
        if (highlighted) {
          highlighted.style.outline       = prevStyle.outline;
          highlighted.style.outlineOffset = prevStyle.offset;
        }
        hint.remove();
        styleTag.remove();
        document.removeEventListener("mousemove", onMove,  true);
        document.removeEventListener("click",     onClick, true);
        document.removeEventListener("keydown",   onEsc,   true);
      };

      const onClick = async (e) => {
        if (hint.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const anchor = createAnchorData(e.target);
        const area   = data.useSync && chrome.storage.sync
          ? chrome.storage.sync
          : chrome.storage.local;
        const { notes = [] } = await area.get({ notes: [] });

        if (data.pendingAnchorDraft) {
          notes.push({ ...data.pendingAnchorDraft, anchor });
          await area.set({ notes });
          await chrome.storage.local.remove("pendingAnchorDraft");
        } else if (data.pendingAnchorEdit) {
          const idx = notes.findIndex((n) => n.id === data.pendingAnchorEdit.noteId);
          if (idx >= 0) {
            notes[idx].anchor = anchor;
            if (notes[idx].ui) { delete notes[idx].ui.top; delete notes[idx].ui.left; }
            await area.set({ notes });
          }
          await chrome.storage.local.remove("pendingAnchorEdit");
        }

        cleanup();
        const ok = makeToast("✓ Note pinned to element", "#34C759");
        setTimeout(() => ok.remove(), 2400);
        try { chrome.runtime.sendMessage({ type: "RELOAD_NOTES_FOR_TAB" }); } catch { /* popup closed */ }
      };

      const onEsc = async (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        cleanup();
        await chrome.storage.local.remove(["pendingAnchorDraft", "pendingAnchorEdit"]);
      };

      document.addEventListener("mousemove", onMove,  true);
      document.addEventListener("click",     onClick, true);
      document.addEventListener("keydown",   onEsc,   true);
    })();
  }

  // ── Anchor button in the New Note view ───────────────────────────────
  $("#anchor-create-btn").addEventListener("click", async () => {
    const plain = getNoteText();
    if (!plain) { showStatus("Add some content first.", "error"); return; }
    const tab = await getActiveTab();
    if (!tab?.url?.startsWith("http")) { showStatus("Cannot anchor on this page.", "error"); return; }

    const draft = {
      id:        `note_${Date.now()}`,
      url:       tab.url,
      title:     $("#note-title").value.trim() || tab.title?.slice(0, 80) || "Note",
      content:   sanitizeNoteHtml(getNoteHtml()),
      color:     selectedColor,
      matchType: $("input[name='match-type']:checked").value,
      tags:      extractTags(plain),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pinned:    false,
      ui:        { collapsed: false },
    };

    await chrome.storage.local.set({ pendingAnchorDraft: draft });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: anchorPickerInPage });
      window.close();
    } catch (err) {
      console.error("Anchor picker injection failed:", err);
      showStatus("Cannot start anchor picker on this page.", "error");
      await chrome.storage.local.remove("pendingAnchorDraft");
    }
  });
});
