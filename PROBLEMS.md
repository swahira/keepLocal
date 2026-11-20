# KeepLocal — Active Problems & Issues Tracker

This document tracks all currently **unresolved** bugs, edge cases, and architectural issues in KeepLocal. As each issue is resolved, it is verified and removed from this list.

---

## Active Issues Summary

| Issue ID | Severity | Category | Status |
| :--- | :---: | :--- | :---: |
| **AUDIT-21** | High | Markdown & Editor.js Bridge | Open |
| **AUDIT-22** | Medium | Markdown & Editor.js Bridge | Open |
| **AUDIT-23** | Medium | Markdown & Editor.js Bridge | Open |
| **AUDIT-25** | Medium | Editor, Tabs & Line Numbers | Open |

---

## Active Issues Details

### 1. AUDIT-21: Table Column Desynchronization on Escaped Pipes `\|`, Inline Code Pipes, and Cell Line Breaks
- **Severity:** High
- **Location:** [`js/markdown.js#L450-L461`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L450-L461) (`flushTable`) and [`js/markdown.js#L406-L417`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L406-L417) (`blocksToText`)
- **Root Cause:**
  1. `flushTable()` naively splits table rows using `r.split("|").slice(1, -1)`. When a row contains escaped pipes `\|` (e.g. `| a \| b | c |`) or code spans containing pipes (e.g. `| `x | y` | c |`), `r.split("|")` splits across those pipes, turning 2 columns into 3 or 4 columns.
  2. In `blocksToText()`, table cells are serialized with `row.map(c => h2md(c)).join(" | ")`. If cell HTML contains `<br>`, `h2md` converts it to literal `\n`, producing multiline table rows which completely breaks markdown table syntax on disk. Additionally, if the cell contains a literal pipe `|`, it is serialized without escaping as `\|`, corrupting column counts on subsequent loads.
- **Impact:** Corrupts markdown table structures on save/load; splits cells into wrong columns; can cause `@editorjs/table` to fail or render deformed tables on asymmetric row shapes.
- **How to Fix:**
  1. Implement a dedicated `splitTableRow(rowStr)` tokenizer that accounts for backslash escapes `\|` and backtick code spans `` `...` `` when splitting cells.
  2. Normalize all row lengths in `flushTable()` to `maxCols` so `@editorjs/table` receives a uniform 2D grid.
  3. In `blocksToText()`, introduce `formatTableCellForMd(cellHtml)` that preserves `<br>` instead of generating literal newlines, and escapes unescaped `|` characters (outside of backtick spans) as `\|`.

---

### 2. AUDIT-22: Standard GFM Tables Without Outer Pipes Ignored by `textToBlocks()`
- **Severity:** Medium
- **Location:** [`js/markdown.js#L485`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L485) (`textToBlocks`)
- **Root Cause:** `textToBlocks()` strictly requires `line.trim().startsWith("|") && line.trim().endsWith("|")`. CommonMark and GitHub Flavored Markdown (GFM Spec 4.10) explicitly allow tables without leading/trailing outer pipes (e.g. `Col 1 | Col 2\n--- | ---\nVal 1 | Val 2`).
- **Impact:** CommonMark/GFM tables copied from external documentation, READMEs, or LLMs without outer pipes are parsed as plain paragraph blocks instead of table blocks.
- **How to Fix:** Update table start detection in `textToBlocks()` to recognize lines containing unescaped pipes when immediately followed by a delimiter row (matching `/^:?-+:?$/`), and continue table accumulation while lines contain pipe delimiters.

---

### 3. AUDIT-23: Unescaped `<br>` and Missing Strikethrough `~~` in Markdown Parser
- **Severity:** Medium
- **Location:** [`js/markdown.js#L257-L297`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L257-L297) (`md2h`) and [`js/markdown.js#L299-L330`](file:///home/raja/Workspace/keepLocal/js/markdown.js#L299-L330) (`h2md`)
- **Root Cause:** `escHtml()` in `md2h()` escapes `<br>` to `&lt;br&gt;`. Unlike `<u>` and `<mark>`, `<br>` is never restored, rendering literal `&lt;br&gt;` text inside paragraphs and table cells. In addition, standard GFM strikethrough syntax `~~text~~` is not transformed to `<s>` / `<del>` in `md2h`, nor is `<s>` / `<del>` transformed back to `~~` in `h2md`.
- **Impact:** Notes containing manual line breaks display ugly `&lt;br&gt;` markup in the editor; strikethrough markdown cannot be rendered or saved.
- **How to Fix:**
  1. In `md2h()`, restore `&lt;br\s*\/?&gt;` to `<br>` and convert `~~(.*?)~~` to `<s>$1</s>`.
  2. In `h2md()`, convert `<(?:s|strike|del)[^>]*>(.*?)<\/(?:s|strike|del)>` to `~~$1~~`.

---

### 4. AUDIT-25: Dropped Tab Switching Clicks During In-Flight Tab Loading
- **Severity:** Medium
- **Location:** [`js/script.js#L3260`](file:///home/raja/Workspace/keepLocal/js/script.js#L3260) (`openTab`)
- **Root Cause:** When `isOpenTabInProgress` is true, clicking another tab immediately returns without queuing the target ID.
- **Impact:** Fast multi-tab switching causes tab clicks to be silently dropped, making the app feel unresponsive.
- **How to Fix:** Store `pendingOpenTabId = id;` when `isOpenTabInProgress` is active, and dispatch the pending switch in a `finally` block once the in-flight tab finishes loading.
