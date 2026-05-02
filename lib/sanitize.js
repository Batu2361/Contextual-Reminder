// Sanitization helpers — XSS prevention for note content via DOMPurify.
// DOMPurify is loaded globally via <script> in the popup and injected as a
// content script file; this module wraps it with note-specific configuration.

const NOTE_CONFIG = {
  // Only allow formatting-relevant tags needed for note content.
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "div", "span", "br", "hr",
    "b", "strong", "i", "em", "u", "s",
    "ul", "ol", "li",
    "a", "pre", "code", "blockquote",
    "input",  // only type="checkbox" — enforced via hook below
    "img",    // only data:image/* src — enforced via hook below
  ],
  ALLOWED_ATTR: [
    "href", "target", "rel",
    "class", "contenteditable",
    "type", "checked",
    "src", "alt",
  ],
  // Allow http(s), mailto, tel, and base64-encoded images. Reject everything else.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|data:image\/[a-z+]+;base64,|[#/])/i,
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "meta", "link", "base"],
  FORBID_ATTR: [
    "onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur",
    "onsubmit", "onchange", "onkeydown", "onkeyup", "onkeypress",
    "formaction", "srcdoc",
  ],
  ADD_ATTR: ["target"],
};

function getDOMPurify() {
  return typeof globalThis.DOMPurify !== "undefined" ? globalThis.DOMPurify : null;
}

// Install hooks once per DOMPurify instance. The flag is stored on the
// instance itself to avoid re-registering when the module is re-evaluated.
function installHooks(dp) {
  if (dp.__notesHooksInstalled) return;

  dp.addHook("uponSanitizeElement", (node, data) => {
    // Only allow checkboxes — remove any other <input> type.
    if (data.tagName === "input") {
      const type = (node.getAttribute?.("type") || "").toLowerCase();
      if (type !== "checkbox") node.parentNode?.removeChild(node);
    }
    // Block external images (tracking pixels). Only data URIs are allowed.
    if (data.tagName === "img") {
      const src = node.getAttribute?.("src") || "";
      if (!src.startsWith("data:image/")) node.parentNode?.removeChild(node);
    }
  });

  dp.addHook("afterSanitizeAttributes", (node) => {
    // Force all links to open in a new tab safely.
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    // Strip style attributes entirely — they can contain CSS injection.
    if (node.hasAttribute?.("style")) node.removeAttribute("style");
  });

  dp.__notesHooksInstalled = true;
}

/**
 * Sanitizes HTML for note content. Returns an empty string if DOMPurify is
 * not available (secure default — never render raw untrusted HTML).
 */
export function sanitizeNoteHtml(html) {
  const dp = getDOMPurify();
  if (!dp) {
    console.warn("[Notes] DOMPurify not loaded — content cleared as a security default.");
    return "";
  }
  installHooks(dp);
  return dp.sanitize(html || "", NOTE_CONFIG);
}

/** Strips all HTML tags and returns plain text for list previews and search. */
export function previewText(html) {
  if (!html) return "";
  const dp = getDOMPurify();
  if (dp) {
    return dp.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
  }
  // Fallback — should not happen in practice since DOMPurify is always loaded.
  return String(html).replace(/<[^>]+>/g, "").trim();
}

/** Validates the shape of a note object before import or storage. */
export function isValidNoteShape(note) {
  if (!note || typeof note !== "object") return false;
  if (typeof note.id !== "string" || !note.id) return false;
  if (typeof note.url !== "string" || !note.url) return false;
  if (typeof note.title !== "string") return false;
  if (typeof note.content !== "string") return false;
  if (note.matchType !== "exact" && note.matchType !== "domain") return false;
  if (typeof note.color !== "string" || !/^#[0-9A-Fa-f]{3,8}$/.test(note.color)) return false;
  if (typeof note.createdAt !== "string") return false;
  if (note.tags !== undefined && !Array.isArray(note.tags)) return false;
  return true;
}

/** Sanitizes and normalizes a note before writing it to storage. */
export function sanitizeNote(note) {
  if (!isValidNoteShape(note)) return null;

  // Tags: alphanumeric only, max 32 chars each, max 20 tags total.
  const safeTags = Array.isArray(note.tags)
    ? note.tags
        .filter((t) => typeof t === "string" && /^[a-z0-9_-]{1,32}$/.test(t))
        .slice(0, 20)
    : [];

  return {
    id:        note.id,
    url:       note.url,
    title:     String(note.title).slice(0, 200),
    content:   sanitizeNoteHtml(note.content),
    color:     note.color,
    matchType: note.matchType,
    tags:      safeTags,
    createdAt: note.createdAt,
    updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : note.createdAt,
    pinned:    !!note.pinned,
    ui:        note.ui && typeof note.ui === "object" ? note.ui : { collapsed: false },
    anchor:    note.anchor && typeof note.anchor === "object" ? note.anchor : null,
  };
}

/**
 * Extracts #hashtags from plain text.
 * Tags must start with a letter and contain only alphanumeric, dash, or underscore.
 */
export function extractTags(plainText) {
  const matches = (plainText || "").match(/#([a-zA-Z][a-zA-Z0-9_-]{0,31})/g) || [];
  return [...new Set(matches.map((t) => t.slice(1).toLowerCase()))].slice(0, 20);
}
