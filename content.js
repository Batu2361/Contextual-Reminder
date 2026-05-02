// Content script — injected into pages to render floating note widgets.
// Runs as an IIFE to avoid polluting the page's global scope.
// Injection is idempotent: a guard at the top prevents double-rendering.

(async function () {
  if (window.__contextualNotesLoaded) return;
  window.__contextualNotesLoaded = true;

  // ── DOMPurify ─────────────────────────────────────────────────────────
  // Capture a local reference. Content scripts run in an isolated world, so
  // there is no real risk of namespace collision, but we avoid touching
  // window.DOMPurify to be safe and to keep the reference stable.
  const _dp = typeof DOMPurify !== "undefined" ? DOMPurify : null;
  let _hooksInstalled = false;

  const SAN_CONFIG = {
    ALLOWED_TAGS: [
      "h1","h2","h3","h4","h5","h6","p","div","span","br","hr",
      "b","strong","i","em","u","s","ul","ol","li",
      "a","pre","code","blockquote","input","img",
    ],
    ALLOWED_ATTR: ["href","target","rel","class","contenteditable","type","checked","src","alt"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|data:image\/[a-z+]+;base64,|[#/])/i,
    FORBID_TAGS: ["script","style","iframe","object","embed","form","meta","link","base"],
    FORBID_ATTR: [
      "onerror","onload","onclick","onmouseover","onfocus","onblur",
      "onsubmit","onchange","onkeydown","onkeyup","onkeypress","formaction","srcdoc",
    ],
    ADD_ATTR: ["target"],
  };

  function sanitizeHtml(html) {
    if (!_dp) {
      console.warn("[Notes] DOMPurify not available — content cleared for safety.");
      return "";
    }
    if (!_hooksInstalled) {
      _dp.addHook("uponSanitizeElement", (node, data) => {
        if (data.tagName === "input") {
          const type = (node.getAttribute?.("type") || "").toLowerCase();
          if (type !== "checkbox") node.parentNode?.removeChild(node);
        }
        if (data.tagName === "img") {
          const src = node.getAttribute?.("src") || "";
          if (!src.startsWith("data:image/")) node.parentNode?.removeChild(node);
        }
      });
      _dp.addHook("afterSanitizeAttributes", (node) => {
        if (node.tagName === "A" && node.hasAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
        if (node.hasAttribute?.("style")) node.removeAttribute("style");
      });
      _hooksInstalled = true;
    }
    return _dp.sanitize(html || "", SAN_CONFIG);
  }

  // ── Storage ───────────────────────────────────────────────────────────
  async function getStorageArea() {
    const { useSync = false } = await chrome.storage.local.get({ useSync: false });
    return useSync && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
  }

  function safeHostname(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  }

  const storageArea  = await getStorageArea();
  const currentUrl   = location.href;
  const currentHost  = location.hostname;

  // Load all notes once and cache them in memory. All writes go directly
  // through the cache — no extra storage.get() per keystroke.
  const { notes: _initial = [] } = await storageArea.get({ notes: [] });
  let notesCache = _initial;

  // Keep the cache in sync when other tabs or the popup make changes.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.notes) notesCache = changes.notes.newValue || [];
  });

  // ── Render matching notes ─────────────────────────────────────────────
  const matchingNotes = notesCache.filter((n) =>
    n.matchType === "exact" ? n.url === currentUrl : safeHostname(n.url) === currentHost
  );

  matchingNotes.forEach((note, index) => {
    // Guard: do not create a duplicate if the script was injected twice.
    if (document.querySelector(`.contextual-note-container[data-note-id="${note.id}"]`)) return;
    createNoteWidget(note, index);
  });

  // ── Anchor picker (triggered from popup) ─────────────────────────────
  const pending = await chrome.storage.local.get(["pendingAnchorDraft", "pendingAnchorEdit"]);
  if (pending.pendingAnchorDraft || pending.pendingAnchorEdit) {
    startAnchorPickerMode(pending);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Robust element selector
  // Priority: data-* attrs → aria-label → name → stable ID → CSS path.
  // Avoids dynamic class names produced by CSS-in-JS or Tailwind.
  // ═══════════════════════════════════════════════════════════════════════
  const STABLE_DATA_ATTRS = ["data-testid","data-id","data-key","data-cy","data-qa","data-name"];

  function isStableId(id) {
    if (!id) return false;
    if (/^[0-9]+$/.test(id)) return false;         // purely numeric
    if (/^[:].+[:]$/.test(id)) return false;        // React ":r0:" style
    if (/^[a-z]+-[0-9]+$/i.test(id)) return false; // "ember-123", "mui-456"
    if (/^[a-f0-9]{8,}$/i.test(id)) return false;  // hash IDs
    return true;
  }

  function buildCssPath(el) {
    const path = [];
    let curr  = el;
    let depth = 0;
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
        const siblings = Array.from(parent.children).filter((c) => c.tagName === curr.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(curr) + 1})`;
      }
      path.unshift(part);
      curr = curr.parentElement;
      depth++;
    }
    return path.join(" > ");
  }

  function getRobustSelectorData(el) {
    for (const attr of STABLE_DATA_ATTRS) {
      const val = el.getAttribute(attr);
      if (val) return { type: "attr", attr, value: val };
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
      selector:     buildCssPath(el), // legacy fallback field
      tag:          el.tagName.toLowerCase(),
      text:         (el.textContent || "").trim().slice(0, 120),
      classes:      (typeof el.className === "string" ? el.className : "")
        .split(/\s+/)
        .filter((c) => c && /^[a-zA-Z][a-zA-Z-]*$/.test(c) && c.length <= 30)
        .slice(0, 3),
    };
  }

  function findAnchorElement(anchor) {
    if (!anchor) return null;
    const sd = anchor.selectorData;
    if (sd) {
      try {
        if (sd.type === "id")         return document.getElementById(sd.value);
        if (sd.type === "attr")       return document.querySelector(`[${sd.attr}="${CSS.escape(sd.value)}"]`);
        if (sd.type === "aria-label") return document.querySelector(`[aria-label="${CSS.escape(sd.value)}"]`);
        if (sd.type === "name")       return document.querySelector(`${sd.tag}[name="${CSS.escape(sd.value)}"]`);
        if (sd.type === "css")        return document.querySelector(sd.value);
      } catch { /* invalid selector — fall through to legacy */ }
    }
    // Legacy fallback for notes created before selectorData was added.
    if (anchor.id) {
      const el = document.getElementById(anchor.id);
      if (el) return el;
    }
    if (anchor.selector) {
      try {
        const el = document.querySelector(anchor.selector);
        if (el) return el;
      } catch { /* invalid */ }
    }
    // Last resort: fuzzy match on tag + text content.
    if (anchor.text && anchor.tag) {
      const candidates = document.getElementsByTagName(anchor.tag);
      for (const c of candidates) {
        if ((c.textContent || "").trim().slice(0, 120) === anchor.text) return c;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Note widget
  // ═══════════════════════════════════════════════════════════════════════
  function createNoteWidget(note, index) {
    const container = document.createElement("div");
    container.className  = "contextual-note-container";
    container.dataset.noteId = note.id;
    container.style.setProperty("--note-color", note.color || "#f0c929");

    const ui     = note.ui || {};
    const offset = index * 28;
    container.style.top  = (typeof ui.top  === "number" ? ui.top  : 20 + offset) + "px";
    container.style.left = (typeof ui.left === "number" ? ui.left : 20 + offset) + "px";
    if (ui.width) container.style.width = ui.width + "px";
    // Height is intentionally NOT restored. CSS flexbox determines height
    // naturally; a stale saved value would clip the editor via overflow:hidden.
    if (ui.collapsed) container.classList.add("collapsed");

    // ── Header ──────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "crqn-header";

    const dragGrip = document.createElement("span");
    dragGrip.className = "crqn-drag-grip";
    dragGrip.title = "Drag to move";
    dragGrip.innerHTML = "&#8942;&#8942;";

    const colorDot = document.createElement("span");
    colorDot.className = "crqn-color";
    colorDot.style.background = note.color || "#f0c929";

    const titleInput = document.createElement("input");
    titleInput.className   = "crqn-title";
    titleInput.value       = note.title || "Note";
    titleInput.placeholder = "Title";

    const actions = document.createElement("div");
    actions.className = "crqn-actions";

    const anchorBtn = document.createElement("button");
    anchorBtn.className   = "crqn-icon-btn anchor-btn";
    anchorBtn.title       = "Pin to a page element";
    anchorBtn.textContent = "📍";
    if (note.anchor) anchorBtn.classList.add("active");

    const collapseBtn = document.createElement("button");
    collapseBtn.className   = "crqn-icon-btn";
    collapseBtn.title       = "Collapse";
    collapseBtn.textContent = ui.collapsed ? "▸" : "▾";

    const closeBtn = document.createElement("button");
    closeBtn.className   = "crqn-icon-btn";
    closeBtn.title       = "Close";
    closeBtn.textContent = "✕";

    actions.append(anchorBtn, collapseBtn, closeBtn);
    header.append(dragGrip, colorDot, titleInput, actions);

    // ── Formatting toolbar ───────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "crqn-toolbar";
    toolbar.innerHTML = `
      <button class="crqn-tb-btn" data-cmd="heading"   title="Heading style">Aa</button>
      <span class="crqn-tb-sep"></span>
      <button class="crqn-tb-btn" data-cmd="bold"      title="Bold (⌘B)"><b>B</b></button>
      <button class="crqn-tb-btn" data-cmd="italic"    title="Italic (⌘I)"><i>I</i></button>
      <button class="crqn-tb-btn" data-cmd="underline" title="Underline (⌘U)"><u>U</u></button>
      <span class="crqn-tb-sep"></span>
      <button class="crqn-tb-btn" data-cmd="list"      title="Bullet list">•</button>
      <button class="crqn-tb-btn" data-cmd="checklist" title="To-do item">☐</button>
      <button class="crqn-tb-btn" data-cmd="link"      title="Insert link">🔗</button>`;

    // ── Editor ───────────────────────────────────────────────────────────
    const editor = document.createElement("div");
    editor.className       = "crqn-editor";
    editor.contentEditable = "true";
    editor.spellcheck      = true;
    editor.dataset.placeholder = "Your note…";
    editor.style.minHeight = "80px"; // fallback if CSS fails to load

    const isHtml = /<[a-z][\s\S]*>/i.test(note.content || "");
    if (isHtml) {
      editor.innerHTML = sanitizeHtml(note.content);
    } else if (note.content) {
      editor.innerHTML = note.content
        .split("\n")
        .map((line) => `<div>${escapeHtml(line) || "<br>"}</div>`)
        .join("");
    }
    refreshPlaceholder();

    // ── Footer ───────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.className = "crqn-footer";

    const feedbackSpan = document.createElement("span");
    feedbackSpan.className = "crqn-save-feedback";

    const saveBtn = document.createElement("button");
    saveBtn.className   = "crqn-save-btn";
    saveBtn.textContent = "Save";

    footer.append(feedbackSpan, saveBtn);
    container.append(header, toolbar, editor, footer);
    document.body.appendChild(container);

    // ── Drag & resize ────────────────────────────────────────────────────
    makeDraggable(container, dragGrip, persistPosition);
    enableSizePersistence(container, persistSize);

    // ── Auto-save & manual save ──────────────────────────────────────────
    const debouncedSave = debounce(() => persistContent(true), 500);
    saveBtn.addEventListener("click",  () => persistContent(false));
    editor.addEventListener("input",   () => { refreshPlaceholder(); refreshToolbarState(); debouncedSave(); });
    titleInput.addEventListener("input", debouncedSave);

    // ── Collapse ─────────────────────────────────────────────────────────
    collapseBtn.addEventListener("click", () => {
      const collapsed = container.classList.toggle("collapsed");
      collapseBtn.textContent = collapsed ? "▸" : "▾";
      collapseBtn.title = collapsed ? "Expand" : "Collapse";
      persistUi({ collapsed });
    });

    closeBtn.addEventListener("click", () => container.remove());

    // ── Formatting toolbar clicks ─────────────────────────────────────────
    toolbar.addEventListener("mousedown", (e) => e.preventDefault());
    toolbar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-cmd]");
      if (!btn) return;
      e.preventDefault();
      editor.focus();
      applyCommand(btn.dataset.cmd);
      refreshToolbarState();
      debouncedSave();
    });

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    editor.addEventListener("keydown", (e) => {
      // Markdown shortcut triggers on Space (e.g. "# " → heading).
      if (e.key === " " && handleMarkdownShortcut(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if      (key === "b") { e.preventDefault(); applyCommand("bold");      refreshToolbarState(); }
      else if (key === "i") { e.preventDefault(); applyCommand("italic");    refreshToolbarState(); }
      else if (key === "u") { e.preventDefault(); applyCommand("underline"); refreshToolbarState(); }
      else if (key === "k") { e.preventDefault(); applyCommand("link"); }
    });

    editor.addEventListener("keyup",   refreshToolbarState);
    editor.addEventListener("mouseup", refreshToolbarState);
    editor.addEventListener("focus",   refreshToolbarState);

    // ── Checklist checkbox clicks ─────────────────────────────────────────
    editor.addEventListener("click", (e) => {
      if (e.target.matches('input[type="checkbox"]')) {
        e.target.closest(".task-item")?.classList.toggle("done", e.target.checked);
        debouncedSave();
      }
    });

    // ── Paste: plain text only ────────────────────────────────────────────
    editor.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
    });

    // ── Drag & drop — text and images ─────────────────────────────────────
    container.addEventListener("dragenter", (e) => {
      const types = e.dataTransfer?.types || [];
      if (types.includes("text/plain") || types.includes("Files")) {
        e.preventDefault();
        container.classList.add("drag-over");
      }
    });
    container.addEventListener("dragover", (e) => {
      const types = e.dataTransfer?.types || [];
      if (types.includes("text/plain") || types.includes("Files")) e.preventDefault();
    });
    container.addEventListener("dragleave", (e) => {
      if (!container.contains(e.relatedTarget)) container.classList.remove("drag-over");
    });
    container.addEventListener("drop", (e) => {
      e.preventDefault();
      container.classList.remove("drag-over");

      const imageFiles = Array.from(e.dataTransfer?.files || []).filter((f) =>
        f.type.startsWith("image/")
      );

      if (imageFiles.length > 0) {
        imageFiles.forEach((file) => {
          if (file.size > 2 * 1024 * 1024) {
            flashFeedback("Image too large (max 2 MB)");
            return;
          }
          const reader = new FileReader();
          reader.onload = (ev) => {
            if (container.classList.contains("collapsed")) {
              container.classList.remove("collapsed");
              collapseBtn.textContent = "▾";
              collapseBtn.title = "Collapse";
              persistUi({ collapsed: false });
            }
            editor.focus();
            const img = document.createElement("img");
            img.src       = ev.target.result;
            img.className = "crqn-note-image";
            img.alt       = file.name;
            img.style.cssText = "max-width:100%;height:auto;display:block;object-fit:contain";
            const range = window.getSelection()?.getRangeAt(0);
            if (range) { range.collapse(false); range.insertNode(img); }
            else editor.appendChild(img);
            debouncedSave();
          };
          reader.onerror = () => flashFeedback("Could not read image file");
          reader.readAsDataURL(file);
        });
        flashFeedback("Image inserted ✓");
        return;
      }

      const text = (e.dataTransfer?.getData("text/plain") || "").trim();
      if (text) {
        if (container.classList.contains("collapsed")) {
          container.classList.remove("collapsed");
          collapseBtn.textContent = "▾";
          persistUi({ collapsed: false });
        }
        editor.focus();
        document.execCommand("insertText", false, "\n" + text);
        debouncedSave();
        flashFeedback("Inserted ✓");
      }
    });

    // ── Idle dim: fade after 3 minutes of no interaction ─────────────────
    let dimTimer = null;
    let collapseTimer = null;

    const resetTimers = () => {
      clearTimeout(dimTimer);
      clearTimeout(collapseTimer);
      container.style.opacity   = "";
      container.style.transition = "";
    };

    const startTimers = () => {
      clearTimeout(dimTimer);
      clearTimeout(collapseTimer);
      dimTimer = setTimeout(() => {
        container.style.transition = "opacity 2s ease";
        container.style.opacity    = "0.55";
      }, 170_000); // 2 min 50 s
      collapseTimer = setTimeout(() => {
        if (!container.classList.contains("collapsed")) {
          container.classList.add("collapsed");
          collapseBtn.textContent = "▸";
          container.style.opacity    = "";
          container.style.transition = "";
          persistUi({ collapsed: true });
        }
      }, 180_000); // 3 min
    };

    container.addEventListener("mouseenter", resetTimers);
    container.addEventListener("mouseleave", startTimers);
    editor.addEventListener("focus",     resetTimers);
    titleInput.addEventListener("focus", resetTimers);
    startTimers();

    // ── Anchor button ─────────────────────────────────────────────────────
    anchorBtn.addEventListener("click", () => {
      if (note.anchor) {
        if (confirm("Remove anchor? The note will float freely again.")) {
          note.anchor = null;
          anchorBtn.classList.remove("active");
          container.classList.remove("anchored");
          container.style.position = "fixed";
          document.querySelectorAll(`.crqn-anchored-target[data-for-note="${note.id}"]`)
            .forEach((el) => { el.classList.remove("crqn-anchored-target"); el.removeAttribute("data-for-note"); });
          persistAnchor(null);
        }
        return;
      }
      startInlineAnchorMode();
    });

    if (note.anchor) requestAnimationFrame(() => attachToAnchor(note.anchor));

    // ── Inline anchor picker ──────────────────────────────────────────────
    function startInlineAnchorMode() {
      document.body.classList.add("crqn-anchor-mode");
      container.style.opacity       = "0.4";
      container.style.pointerEvents = "none";

      const hint = document.createElement("div");
      hint.className   = "crqn-anchor-hint";
      hint.textContent = "Click an element to anchor the note — Esc to cancel";
      document.body.appendChild(hint);

      let highlighted = null;

      const onMove = (e) => {
        if (highlighted) highlighted.classList.remove("crqn-anchor-target");
        const el = e.target;
        if (el === document.body || el === document.documentElement) return;
        if (container.contains(el) || hint.contains(el)) return;
        el.classList.add("crqn-anchor-target");
        highlighted = el;
      };

      const cleanup = () => {
        document.body.classList.remove("crqn-anchor-mode");
        if (highlighted) highlighted.classList.remove("crqn-anchor-target");
        container.style.opacity       = "";
        container.style.pointerEvents = "";
        hint.remove();
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click",     onClick, true);
        document.removeEventListener("keydown",   onEsc,   true);
      };

      const onClick = async (e) => {
        if (container.contains(e.target) || hint.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const anchor = createAnchorData(e.target);
        note.anchor = anchor;
        await persistAnchor(anchor);
        anchorBtn.classList.add("active");
        cleanup();
        attachToAnchor(anchor);
        flashFeedback("Pinned to element ✓");
      };

      const onEsc = (e) => {
        if (e.key === "Escape") { e.preventDefault(); cleanup(); }
      };

      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click",     onClick, true);
      document.addEventListener("keydown",   onEsc,   true);
    }

    function attachToAnchor(anchor) {
      const target = findAnchorElement(anchor);
      if (!target) {
        flashFeedback("Anchor element not found");
        anchorBtn.title = "Anchor set, but element not found on this page";
        return;
      }
      target.classList.add("crqn-anchored-target");
      target.dataset.forNote = note.id;
      target.style.setProperty("--anchor-color", note.color || "#007AFF");
      container.classList.add("anchored");
      container.style.position = "absolute";
      positionAtAnchor(target);
      // Re-position when the page layout changes (e.g. lazy-loaded content).
      new ResizeObserver(() => positionAtAnchor(target)).observe(document.body);
    }

    function positionAtAnchor(target) {
      const r      = target.getBoundingClientRect();
      const noteW  = container.offsetWidth || 320;
      const margin = 12;
      let left = r.right + margin;
      let top  = r.top;
      // Flip left if it would overflow the right edge.
      if (left + noteW > window.innerWidth - 8) left = r.left - noteW - margin;
      // Fall back to below the element if it still overflows left.
      if (left < 8) { left = Math.max(8, r.left); top = r.bottom + margin; }
      left = Math.max(8, Math.min(window.innerWidth - noteW - 8, left));
      container.style.left = (left + window.scrollX) + "px";
      container.style.top  = (top  + window.scrollY) + "px";
    }

    async function persistAnchor(anchor) {
      const idx = notesCache.findIndex((n) => n.id === note.id);
      if (idx < 0) return;
      notesCache[idx].anchor = anchor;
      if (anchor) {
        // Saved position is irrelevant when anchored; clear it.
        delete notesCache[idx].ui?.top;
        delete notesCache[idx].ui?.left;
      }
      await storageArea.set({ notes: notesCache });
    }

    // ── Formatting commands ───────────────────────────────────────────────
    function applyCommand(cmd) {
      switch (cmd) {
        case "bold":      document.execCommand("bold");               break;
        case "italic":    document.execCommand("italic");             break;
        case "underline": document.execCommand("underline");          break;
        case "list":      document.execCommand("insertUnorderedList"); break;
        case "heading":   showHeadingPopover();                        break;
        case "checklist": toggleChecklist();                           break;
        case "link":      insertLink();                                break;
      }
    }

    function showHeadingPopover() {
      document.querySelector(".crqn-style-popover")?.remove();
      const aaBtn = toolbar.querySelector('[data-cmd="heading"]');
      const r     = aaBtn.getBoundingClientRect();
      const pop   = document.createElement("div");
      pop.className = "crqn-style-popover";
      pop.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${r.left}px`;
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
        applyStyle(btn.dataset.style);
        pop.remove();
        cleanup();
        debouncedSave();
      });
      const onOutside = (e) => {
        if (!pop.contains(e.target) && e.target !== aaBtn) { pop.remove(); cleanup(); }
      };
      const onEsc = (e) => { if (e.key === "Escape") { pop.remove(); cleanup(); } };
      const cleanup = () => {
        document.removeEventListener("click",   onOutside, true);
        document.removeEventListener("keydown", onEsc);
      };
      // Defer so the current click event doesn't immediately close the popover.
      setTimeout(() => {
        document.addEventListener("click",   onOutside, true);
        document.addEventListener("keydown", onEsc);
      }, 0);
    }

    function applyStyle(style) {
      editor.focus();
      const tagMap = { title: "h1", heading: "h2", subheading: "h3", body: "p", mono: "pre" };
      document.execCommand("formatBlock", false, tagMap[style]);
      refreshToolbarState();
    }

    function toggleChecklist() {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const existing = sel.anchorNode?.parentElement?.closest(".task-item");
      if (existing) {
        // Convert back to a plain div.
        const div = document.createElement("div");
        div.textContent = existing.querySelector(".task-text")?.textContent || "";
        existing.replaceWith(div);
        placeCursorIn(div);
        return;
      }
      const block = getCurrentBlock() || editor;
      const text  = block === editor ? "" : block.textContent;
      const item  = createChecklistItem(text || "Task");
      if (block === editor) editor.appendChild(item);
      else block.replaceWith(item);
      placeCursorIn(item.querySelector(".task-text"));
    }

    function createChecklistItem(text) {
      const item = document.createElement("div");
      item.className = "task-item";
      const cb   = document.createElement("input");
      cb.type    = "checkbox";
      const span = document.createElement("span");
      span.className       = "task-text";
      span.contentEditable = "true";
      span.textContent     = text;
      item.append(cb, span);
      return item;
    }

    function insertLink() {
      const sel          = window.getSelection();
      const selectedText = sel?.toString() || "";
      const url = window.prompt("Enter URL:", "https://");
      if (!url) return;
      if (selectedText) {
        document.execCommand("createLink", false, url);
        const a = sel.anchorNode?.parentElement?.closest("a");
        if (a) { a.target = "_blank"; a.rel = "noopener"; }
      } else {
        const a   = document.createElement("a");
        a.href    = url;
        a.target  = "_blank";
        a.rel     = "noopener";
        a.textContent = url;
        sel?.getRangeAt(0)?.insertNode(a);
      }
    }

    // Markdown-style shortcuts: "# " → h2, "## " → h3, "- " → list, "[] " → task.
    function handleMarkdownShortcut(e) {
      const sel = window.getSelection();
      if (!sel?.rangeCount || !sel.isCollapsed) return false;
      const block = getCurrentBlock();
      if (!block) return false;
      const text = block.textContent;
      let kind = null;
      if (text === "#")                    kind = "h2";
      else if (text === "##")              kind = "h3";
      else if (text === "-" || text === "*") kind = "ul";
      else if (text === "[]" || text === "[ ]") kind = "task";
      if (!kind) return false;
      e.preventDefault();
      block.textContent = "";
      placeCursorIn(block);
      if (kind === "h2" || kind === "h3") document.execCommand("formatBlock", false, kind);
      else if (kind === "ul")  document.execCommand("insertUnorderedList");
      else if (kind === "task") {
        const item = createChecklistItem("");
        block.replaceWith(item);
        placeCursorIn(item.querySelector(".task-text"));
      }
      refreshToolbarState();
      debouncedSave();
      return true;
    }

    function getCurrentBlock() {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return null;
      let node = sel.anchorNode;
      while (node && node !== editor) {
        if (node.nodeType === 1 && /^(DIV|P|H[1-6]|LI)$/i.test(node.tagName)) return node;
        node = node.parentNode;
      }
      return null;
    }

    function placeCursorIn(el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function refreshToolbarState() {
      const mapping = {
        bold:      "bold",
        italic:    "italic",
        underline: "underline",
        list:      "insertUnorderedList",
      };
      for (const [key, qc] of Object.entries(mapping)) {
        const btn = toolbar.querySelector(`[data-cmd="${key}"]`);
        if (!btn) continue;
        try { btn.classList.toggle("active", document.queryCommandState(qc)); } catch { /* unsupported */ }
      }
      const block = getCurrentBlock();
      toolbar.querySelector('[data-cmd="heading"]')
        .classList.toggle("active", !!(block && /^H[1-6]$/i.test(block.tagName)));
    }

    function refreshPlaceholder() {
      const isEmpty = !editor.textContent.trim() && !editor.querySelector("input,img");
      editor.classList.toggle("empty", isEmpty);
    }

    function flashFeedback(msg) {
      feedbackSpan.textContent = msg;
      setTimeout(() => { feedbackSpan.textContent = ""; }, 1800);
    }

    // ── Persist helpers (write to cache, no extra storage.get) ────────────
    async function persistContent(isAutoSave) {
      const idx = notesCache.findIndex((n) => n.id === note.id);
      if (idx < 0) return;
      notesCache[idx].content   = sanitizeHtml(editor.innerHTML);
      notesCache[idx].title     = titleInput.value.trim() || "Note";
      notesCache[idx].updatedAt = new Date().toISOString();
      await storageArea.set({ notes: notesCache });
      if (!isAutoSave) flashFeedback("Saved ✓");
    }

    async function persistPosition(top, left) {
      await persistUi({ top, left });
    }

    // Height is not persisted — see note above createNoteWidget.
    async function persistSize(width) {
      await persistUi({ width });
    }

    async function persistUi(patch) {
      const idx = notesCache.findIndex((n) => n.id === note.id);
      if (idx < 0) return;
      notesCache[idx].ui = { ...(notesCache[idx].ui || {}), ...patch };
      await storageArea.set({ notes: notesCache });
    }
  } // end createNoteWidget

  // ═══════════════════════════════════════════════════════════════════════
  // Global anchor picker (launched from popup via pendingAnchorDraft/Edit)
  // ═══════════════════════════════════════════════════════════════════════
  async function startAnchorPickerMode(pending) {
    const styleTag = document.createElement("style");
    styleTag.textContent = "html,body,body *{cursor:crosshair !important}";
    document.head.appendChild(styleTag);

    const hint = document.createElement("div");
    hint.textContent = "Click an element to anchor the note — Esc to cancel";
    Object.assign(hint.style, {
      position:     "fixed",
      bottom:       "24px",
      left:         "50%",
      transform:    "translateX(-50%)",
      background:   "#1d1d1f",
      color:        "#fff",
      padding:      "10px 18px",
      borderRadius: "999px",
      font:         "600 13px/1 -apple-system, system-ui, sans-serif",
      boxShadow:    "0 8px 28px rgba(0,0,0,0.25)",
      zIndex:       "2147483647",
      pointerEvents:"none",
    });
    document.body.appendChild(hint);

    let highlighted = null;
    let prevStyle   = { outline: "", offset: "" };

    const onMove = (e) => {
      const el = e.target;
      if (highlighted && highlighted !== el) {
        highlighted.style.outline       = prevStyle.outline;
        highlighted.style.outlineOffset = prevStyle.offset;
      }
      if (!el || el === document.body || el === document.documentElement || hint.contains(el)) return;
      if (highlighted !== el) {
        prevStyle = { outline: el.style.outline, offset: el.style.outlineOffset };
      }
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

      const { useSync } = await chrome.storage.local.get({ useSync: false });
      const area = useSync && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
      const { notes = [] } = await area.get({ notes: [] });

      if (pending.pendingAnchorDraft) {
        notes.push({ ...pending.pendingAnchorDraft, anchor });
        await area.set({ notes });
        await chrome.storage.local.remove("pendingAnchorDraft");
      } else if (pending.pendingAnchorEdit) {
        const idx = notes.findIndex((n) => n.id === pending.pendingAnchorEdit.noteId);
        if (idx >= 0) {
          notes[idx].anchor = anchor;
          if (notes[idx].ui) { delete notes[idx].ui.top; delete notes[idx].ui.left; }
          await area.set({ notes });
        }
        await chrome.storage.local.remove("pendingAnchorEdit");
      }

      cleanup();

      const confirmation = document.createElement("div");
      confirmation.textContent = "✓ Note pinned to element";
      Object.assign(confirmation.style, {
        position:     "fixed",
        bottom:       "24px",
        left:         "50%",
        transform:    "translateX(-50%)",
        background:   "#34C759",
        color:        "#fff",
        padding:      "10px 18px",
        borderRadius: "999px",
        font:         "600 13px/1 -apple-system, system-ui, sans-serif",
        zIndex:       "2147483647",
        pointerEvents:"none",
      });
      document.body.appendChild(confirmation);
      setTimeout(() => confirmation.remove(), 2400);

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
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Shared utilities
  // ═══════════════════════════════════════════════════════════════════════

  function makeDraggable(el, grip, onPersist) {
    grip.style.cursor = "grab";
    // Prevent the browser's native drag-image from appearing.
    grip.addEventListener("dragstart", (e) => e.preventDefault());

    grip.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // prevent text selection while dragging

      const rect       = el.getBoundingClientRect();
      const startPtrX  = e.clientX;
      const startPtrY  = e.clientY;
      const startElX   = rect.left;
      const startElY   = rect.top;
      const savedTrans = el.style.transition;

      el.style.transition        = "none"; // disable CSS transitions during drag
      document.body.style.userSelect = "none";
      grip.style.cursor          = "grabbing";

      const onMove = (ev) => {
        el.style.left = Math.max(8, Math.min(
          window.innerWidth  - el.offsetWidth  - 8,
          startElX + ev.clientX - startPtrX
        )) + "px";
        el.style.top = Math.max(8, Math.min(
          window.innerHeight - el.offsetHeight - 8,
          startElY + ev.clientY - startPtrY
        )) + "px";
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup",   onUp,   true);
        grip.style.cursor              = "grab";
        el.style.transition            = savedTrans;
        document.body.style.userSelect = "";
        const r = el.getBoundingClientRect();
        onPersist(Math.round(r.top), Math.round(r.left));
      };

      // Capture phase ensures we receive events even if the page stops propagation.
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup",   onUp,   true);
    });
  }

  function enableSizePersistence(el, onPersist) {
    let lastWidth  = el.offsetWidth;
    let lastHeight = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (w !== lastWidth || h !== lastHeight) {
        lastWidth  = w;
        lastHeight = h;
        onPersist(w, h);
      }
    });
    ro.observe(el);
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
