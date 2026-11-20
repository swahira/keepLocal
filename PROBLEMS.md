# KeepLocal — Active Problems & Issues Tracker

This document tracks all currently **unresolved** bugs, edge cases, and architectural issues in KeepLocal. As each issue is resolved, it is verified and removed from this list.

---

## Active Issues Summary

| Issue ID | Severity | Category | Status |
| :--- | :---: | :--- | :---: |
| **AUDIT-22** | Medium | Markdown & Editor.js Bridge | Open |
| **AUDIT-23** | Medium | Markdown & Editor.js Bridge | Open |
| **AUDIT-25** | Medium | Editor, Tabs & Line Numbers | Open |

---

## Active Issues Details

### 1. AUDIT-22: Standard GFM Tables Without Outer Pipes Ignored by `textToBlocks()`
- **Severity:** Medium
- **Location:** [`js/markdown.js#L485`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L485) (`textToBlocks`)
- **Root Cause:** `textToBlocks()` strictly requires `line.trim().startsWith("|") && line.trim().endsWith("|")`. CommonMark and GitHub Flavored Markdown (GFM Spec 4.10) explicitly allow tables without leading/trailing outer pipes (e.g. `Col 1 | Col 2\n--- | ---\nVal 1 | Val 2`).
- **Impact:** CommonMark/GFM tables copied from external documentation, READMEs, or LLMs without outer pipes are parsed as plain paragraph blocks instead of table blocks.
- **How to Fix:** Update table start detection in `textToBlocks()` to recognize lines containing unescaped pipes when immediately followed by a delimiter row (matching `/^:?-+:?$/`), and continue table accumulation while lines contain pipe delimiters.

---

### 2. AUDIT-23: Unescaped `<br>` and Missing Strikethrough `~~` in Markdown Parser
- **Severity:** Medium
- **Location:** [`js/markdown.js#L257-L297`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L257-L297) (`md2h`) and [`js/markdown.js#L299-L330`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L299-L330) (`h2md`)
- **Root Cause:** `escHtml()` in `md2h()` escapes `<br>` to `&lt;br&gt;`. Unlike `<u>` and `<mark>`, `<br>` is never restored, rendering literal `&lt;br&gt;` text inside paragraphs and table cells. In addition, standard GFM strikethrough syntax `~~text~~` is not transformed to `<s>` / `<del>` in `md2h`, nor is `<s>` / `<del>` transformed back to `~~` in `h2md`.
- **Impact:** Notes containing manual line breaks display ugly `&lt;br&gt;` markup in the editor; strikethrough markdown cannot be rendered or saved.
- **How to Fix:**
  1. In `md2h()`, restore `&lt;br\s*\/?&gt;` to `<br>` and convert `~~(.*?)~~` to `<s>$1</s>`.
  2. In `h2md()`, convert `<(?:s|strike|del)[^>]*>(.*?)<\/(?:s|strike|del)>` to `~~$1~~`.

---

### 3. AUDIT-25: Dropped Tab Switching Clicks During In-Flight Tab Loading
- **Severity:** Medium
- **Location:** [`js/script.js#L3260`](file:///home/raja/Workspace/keepLocal/js/script.js#L3260) (`openTab`)
- **Root Cause:** When `isOpenTabInProgress` is true, clicking another tab immediately returns without queuing the target ID.
- **Impact:** Fast multi-tab switching causes tab clicks to be silently dropped, making the app feel unresponsive.
- **How to Fix:** Store `pendingOpenTabId = id;` when `isOpenTabInProgress` is active, and dispatch the pending switch in a `finally` block once the in-flight tab finishes loading.
