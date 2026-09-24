# KeepLocal

**A private, local-first notes editor and markdown workspace for the modern web.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Storage: LocalStorage & File System](https://img.shields.io/badge/Storage-Local-blue.svg)](#)
[![Privacy: 100%](https://img.shields.io/badge/Privacy-100%25-green.svg)](#)
[![Offline: PWA & Service Worker](https://img.shields.io/badge/Offline-Ready-success.svg)](#)

KeepLocal is a powerful, privacy-first note-taking application designed for speed and simplicity. It lives entirely in your browser, storing notes in local storage or syncing bidirectionally with local directories on your computer via the File System Access API — without cloud dependencies, subscriptions, or tracking.

## Features

- **Multi-Workspace Management**: Create and switch between independent workspaces, view workspace cards, and manage folders on a dedicated welcome screen.
- **Bi-directional Local Folder Sync**: Connect any folder on your machine via the Chromium File System Access API with automated real-time background sync.
- **Dual Editor Modes**:
  - **Block Editor (Editor.js)**: Rich slash-command (`/`) block editing with H1–H6 headings, checklists, nested lists, callouts/alerts, blockquotes, code blocks, horizontal delimiters, images, inline markers, and tables.
  - **Raw Markdown Mode**: Full source markdown editing with real-time Prism.js syntax highlighting and synchronized line numbers.
  - **100% Lossless Round-Trip Conversion**: Seamlessly switch between Block and Raw text modes without losing note structure or formatting.
- **VS Code-Style Multi-Tabs**: Open multiple files simultaneously, switch between active tabs, reorder, and close tabs with unsaved-change protection.
- **Code Indentation**: Multi-line `Tab` indentation (prepends 4 spaces) and `Shift+Tab` unindentation (removes leading spaces) preserving selection.
- **Offline-First PWA**: Built-in Service Worker (`sw.js`) caching all application assets and pinned dependencies for full offline usage.
- **Responsive & Mobile Ready**: Clean mobile layout with collapsible drawer explorer, touch backdrop, and responsive welcome screen.
- **Search & Explorer**: Real-time recursive search across notes and folders in the workspace tree.
- **ZIP Backup & Restore**: Export individual folders or entire workspaces to `.zip` archives, and restore archives seamlessly.
- **Cross-Platform Shortcuts**: Native support for both Windows/Linux (`Ctrl`) and macOS (`Cmd`) keybindings.

## Privacy First

KeepLocal operates on the principle of absolute privacy:

- **No Account Required**: Instant launch with no sign-ups.
- **No Cloud Database**: Your notes stay exclusively on your device.
- **Zero Telemetry**: No analytics, third-party cookies, or trackers.

## Installation & Running

Since KeepLocal is a client-side application, you can run it locally with any static HTTP server:

1. **Clone the repository**:

   ```bash
   git clone https://github.com/swahira/keepLocal.git
   cd keepLocal
   ```

2. **Serve locally**:

   ```bash
   # Using Python 3
   python3 -m http.server 8000

   # Or using Node.js npx
   npx serve .
   ```

3. **Open in Browser**:
   Navigate to `http://localhost:8000` (Chromium-based browsers like Chrome, Edge, or Brave recommended for direct folder sync).

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` / `Cmd+S` | Auto-save file and sync to connected directory |
| `Ctrl+N` / `Cmd+N` | Create a new note in active folder |
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Toggle Light / Dark theme |
| `Alt+Z` | Toggle word wrap in raw editor |
| `Tab` | Indent line or multi-line selection (4 spaces) |
| `Shift+Tab` | Unindent line or multi-line selection |
| `Ctrl/Cmd + Wheel` | Zoom editor font size |
| `/` (in Block Mode) | Open toolbox slash-command menu |
| `Esc` | Close active modals, search bars, and mobile drawer |

## Built With

- **HTML5 Semantic Structure & Web Components**
- **Modern CSS3** (Custom properties, Flexbox, CSS Grid, media breakpoints)
- **Vanilla JavaScript** (ES6+, async/await)
- **[Editor.js](https://editorjs.io/)** block editor ecosystem
- **[Prism.js](https://prismjs.com/)** syntax highlighting
- **[Lucide Icons](https://lucide.dev/)**
- **[JSZip](https://stuk.github.io/jszip/)** client-side archive engine
- **Service Worker API & File System Access API**

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.
