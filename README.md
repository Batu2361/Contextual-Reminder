# Contextual Reminder & Quick Note

A Chrome extension that lets you attach sticky notes directly to URLs or entire domains. Instead of keeping notes in a separate app, they appear right where the information is relevant — on the page itself.

![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---
## 📺 Demo


https://github.com/user-attachments/assets/c7ac6cb3-157f-4e99-b0c7-da5eb011ca25





## Features

### Core
- **Page-aware notes** — attach notes to an exact URL or an entire domain
- **Floating widgets** — draggable, resizable, collapsible note cards injected into the page
- **Rich text editor** — headings, bold/italic/underline, bullet lists, to-do checklists, inline links, and code blocks
- **Image support** — drag & drop images into any note (stored as Base64, max 2 MB)
- **#Tag system** — add `#tags` anywhere in a note, then filter the list by tag
- **Element anchoring** — pin a note to a specific DOM element on the page (📍); the note repositions itself next to the element even after the page reflows
- **Auto-load** — optionally grant `<all_urls>` to show notes automatically on page load without opening the popup

### Popup
- **Spotlight-style command bar** (⌘K) — search notes or trigger any action from the keyboard
- **Smart context detection** — recognizes product pages, GitHub repos, Wikipedia articles, YouTube videos, and more; adapts the placeholder hint accordingly
- **Capture selection** — one click to pull the current text selection into a new note
- **Right-click → Create note** — context menu integration for quick captures
- **Pin & sort** — pin important notes to the top; sort by newest, oldest, or A–Z
- **Copy content** — one-click clipboard copy for any note
- **Open page** — jump directly to the URL a note belongs to (focuses existing tab if open)

### Data
- **JSON export / import** — full backup and restore with schema validation
- **Markdown export** — export all notes as a single `.md` file
- **Cross-device sync** — optional `chrome.storage.sync` mode
- **Undo delete** — 4.5-second undo toast after deleting a note
- **In-memory cache** — no redundant `storage.get()` calls on every keystroke

### Design
- Apple Notes-inspired glassmorphism UI
- Full dark mode support via `prefers-color-scheme`
- Smooth animations and spring easing throughout

---

## Screenshots

> Notes appear as floating panels on any page, styled to stay out of the way until you need them.

| New Note | Note List | On-page Widget |
|----------|-----------|----------------|
| Spotlight command bar, rich editor, color picker | Search, tag filter, sort, export | Draggable, collapsible, with formatting toolbar |

---

## Installation

### From source (developer mode)

1. Clone the repository:
   ```bash
   git clone https://github.com/Batu2361/Contextual-Reminder.git
   cd Contextual-Reminder
   ```

2. Open Chrome and navigate to `chrome://extensions`

3. Enable **Developer mode** (top-right toggle)

4. Click **Load unpacked** and select the project folder

5. The extension icon appears in the toolbar — click it to open the popup

---

## Usage

### Create a note
1. Open the popup on any page
2. Write your note in the rich text editor
3. Choose whether it applies to the **exact URL** or the **entire domain**
4. Pick a color and click **Save Note**

The note will appear as a floating widget the next time you open the popup on that page (or immediately if Auto-Load is enabled).

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Open command bar |
| `⌘S` / `Ctrl+S` | Save current note |
| `Alt+Shift+N` | Show notes on the current page |
| `⌘B` / `Ctrl+B` | Bold |
| `⌘I` / `Ctrl+I` | Italic |
| `⌘U` / `Ctrl+U` | Underline |

### Markdown shortcuts (in editor)
Type these at the start of a line, then press `Space`:

| Input | Result |
|-------|--------|
| `#` | Heading |
| `##` | Subheading |
| `-` or `*` | Bullet list |
| `[]` | To-do checkbox |

### Element anchoring
Click 📍 in a note header, then click any element on the page to pin the note next to it. The note follows the element even after page reflows. Click 📍 again to remove the anchor.

### Auto-Load
Go to **Settings → Show notes automatically** and grant the `<all_urls>` permission. Notes will appear on page load without needing to open the popup first.

---

## Project structure

```
├── manifest.json          # MV3 manifest — permissions, commands, icons
├── background.js          # Service worker — badge, auto-inject, context menu, IPC
├── content.js             # Injected into pages — renders floating note widgets
├── popup.html             # Extension popup markup
├── popup.js               # Popup logic — editor, list, settings, command bar
├── popup.css              # Popup styles (Apple HIG design system)
├── styles.css             # Content-script styles (namespaced crqn-*)
└── lib/
    ├── sanitize.js        # DOMPurify wrapper with note-specific config
    ├── storage.js         # Storage helpers (local/sync abstraction)
    └── purify.min.js      # DOMPurify v3 (bundled, no CDN dependency)
```

---

## Security

- All note HTML is sanitized through **DOMPurify** before rendering
- Only a strict allowlist of tags and attributes is permitted
- External images are blocked — only `data:image/*` Base64 URIs are allowed
- `style` attributes are stripped entirely to prevent CSS injection
- All links get `target="_blank" rel="noopener noreferrer"` automatically
- Import validation rejects any note that doesn't conform to the expected schema

---

## Permissions

| Permission | Why it's needed |
|------------|-----------------|
| `storage` | Save notes locally or via sync |
| `tabs` | Read the current tab URL for badge count and note matching |
| `scripting` | Inject the note widget CSS and JS into pages |
| `activeTab` | Inject on popup open without broad host access |
| `contextMenus` | Right-click → "Create note from selection" |
| `<all_urls>` *(optional)* | Auto-load notes without opening the popup |

The `<all_urls>` permission is **optional** and only requested when you explicitly enable Auto-Load in Settings.

---

## Development notes

The extension uses **Manifest V3** with a module-type service worker. `content.js` is a plain IIFE (not an ES module) because MV3 content scripts don't support `import`. The note list uses an in-memory cache updated via `chrome.storage.onChanged` to avoid redundant `storage.get()` round-trips on every auto-save.

---

## License

MIT
