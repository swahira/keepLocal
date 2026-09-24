# KeepLocal — Comprehensive Codebase Audit & Problem Tracker

This document contains a thorough technical audit of the KeepLocal codebase (`index.html`, `js/script.js`, `css/styles.css`, and related assets). Each issue includes its severity, exact file and line locations, root cause explanation, reproduction impact, and step-by-step instructions on how to fix it. Use the checkboxes to track progress as fixes are implemented.

---

## Audit Summary & Scorecard

| Category | Total Issues | Critical | High | Medium | Low |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Data Loss & State Corruption** | 6 | 4 | 2 | 0 | 0 |
| **File System API & Sync Engine** | 5 | 1 | 4 | 0 | 0 |
| **Editor, Tabs & Line Numbers** | 9 | 0 | 6 | 3 | 0 |
| **Markdown & Editor.js Bridge** | 5 | 1 | 1 | 3 | 0 |
| **ZIP Import / Export System** | 5 | 0 | 2 | 3 | 0 |
| **Search, Navigation & Explorer** | 3 | 0 | 0 | 3 | 0 |
| **Styling, Dead Code & CSS Defects** | 5 | 0 | 1 | 2 | 2 |
| **Accessibility, Responsiveness & Shortcuts** | 5 | 0 | 1 | 2 | 2 |
| **Architecture, Offline & Security** | 4 | 1 | 1 | 1 | 1 |
| **Total** | **47** | **7** | **18** | **17** | **5** |

---

## 1. Data Loss & State Corruption (Critical)

- [x] **DATA-01: Disastrous Deletion of Non-Text Files and Build Directories on Local Disk** (FIXED)
  - **Severity:** Critical
  - **Location:** [`js/script.js#L1048-L1062`](file:///home/raja/Workspace/keepLocal/js/script.js#L1048-L1062) (`syncWorkspace`) & [`js/script.js#L999-L1033`](file:///home/raja/Workspace/keepLocal/js/script.js#L999-L1033) (`readDirectoryHandle`)
  - **Problem Description:** When reading a connected directory, `readDirectoryHandle` explicitly skips directories in `SKIP` (`node_modules`, `dist`, `build`, etc.) and any file whose extension is not in `TEXT_EXTS` (such as `.png`, `.jpg`, `.pdf`, `.zip`, `.docx`). Consequently, these files are not loaded into `files`. Later, when `syncWorkspace()` runs, it performs disk cleanup:

    ```javascript
    const activeNames = new Set(files.map(f => f.name));
    for await (const [name] of workspaceHandle.entries()) {
        if (!activeNames.has(name) && !name.startsWith(".")) {
            await workspaceHandle.removeEntry(name, { recursive: true });
        }
    }
    ```

    Any non-hidden disk file or folder that was skipped (e.g. `dist/`, `build/`, `image.png`, `document.pdf`) is **permanently deleted from the user's hard drive**!
  - **Impact:** Permanent, unrecoverable data loss in user project directories.
  - **How to Fix:** Never unconditionally delete unmanaged entries in a connected folder. Only delete an entry on disk if it was an item explicitly deleted by the user inside KeepLocal (e.g. by recording deleted filenames into a `deletedTombstones` set or keeping track of known managed files).

- [x] **DATA-02: Race Condition and Overwrite When Switching Files/Tabs During EditorJS Debounce** (FIXED)
  - **Severity:** Critical
  - **Location:** [`js/script.js#L1381-L1389`](file:///home/raja/Workspace/keepLocal/js/script.js#L1381-L1389) (`openTab`), [`js/script.js#L1556`](file:///home/raja/Workspace/keepLocal/js/script.js#L1556), [`js/script.js#L1775-L1791`](file:///home/raja/Workspace/keepLocal/js/script.js#L1775-L1791)
  - **Problem Description:** When clicking another file in the tree, `openTab(node.id)` immediately sets `selectedId = id;` without first calling `autoSaveCurrentFile()`. In Block Mode, `editorInstance.save()` is debounced by 400ms:

    ```javascript
    editorSaveTimer = setTimeout(async () => {
        const f = findNode(files, selectedId);
        if (f?.type === "file" && editorInstance) {
            const d = await editorInstance.save();
            f.content = blocksToText(d);
        ...
    ```

    If the user was typing in Note A and clicks Note B within 400ms, `selectedId` now points to Note B. When the timer fires, it saves Note A's content into Note B! Note B's original content is overwritten and lost, and Note A's unsaved edits are placed into the wrong file.
  - **Impact:** Silent data corruption and loss of content across different notes.
  - **How to Fix:**
    1. Await `autoSaveCurrentFile()` before switching `selectedId` in both `openTab` and tree click handlers.
    2. Cancel `clearTimeout(editorSaveTimer)` immediately upon switching tabs.
    3. Bind the active file ID in a closure or pass it explicitly to `editorSaveTimer` so a delayed save cannot write to a newly selected file.

- [x] **DATA-03: Switching Workspaces via Dropdown Discards Unsaved Changes** (FIXED)
  - **Severity:** Critical
  - **Location:** [`js/script.js#L342-L349`](file:///home/raja/Workspace/keepLocal/js/script.js#L342-L349) & [`js/script.js#L527-L534`](file:///home/raja/Workspace/keepLocal/js/script.js#L527-L534) (`openWorkspace`)
  - **Problem Description:** In `wsDropdownList`, clicking a workspace calls `await openWorkspace(ws.id);`. Inside `openWorkspace`, `activeWsId = wsId;` is set immediately. Unlike `goHome()`, which calls `autoSaveCurrentFile()`, `saveWsFiles(activeWsId)`, and `saveWsConfig(activeWsId)`, `openWorkspace()` performs no flush of the previous workspace's state.
  - **Impact:** Unsaved edits in the previous workspace are lost, and any pending debounced timers write the previous workspace's text into the new workspace's localStorage key.
  - **How to Fix:** In `openWorkspace()`, check if `activeWsId` is currently open and different from `wsId`. If so, await `autoSaveCurrentFile()`, `saveWsFiles(activeWsId)`, and `saveWsConfig(activeWsId)` before loading the new workspace configuration.

- [x] **DATA-04: Connecting Folder Silently Erases Existing Local Notes Without Warning** (FIXED)
  - **Severity:** Critical
  - **Location:** [`js/script.js#L951-L976`](file:///home/raja/Workspace/keepLocal/js/script.js#L951-L976) (`saveWorkspace`)
  - **Problem Description:** In `saveWorkspace()` (the "Connect Folder" / "Change Folder" button in the sidebar footer), if the user picks an existing non-empty directory:

    ```javascript
    const readFiles = await readDirectoryHandle(handle);
    if (readFiles.length > 0) {
        files = readFiles;
        saveWsFiles(activeWsId);
    }
    ```

    If the user already had 10 local notes in KeepLocal and connected an existing directory with even 1 file, all 10 local notes are immediately replaced in `files` and overwritten in `localStorage` without any prompt or confirmation!
  - **Impact:** Irreversible loss of notes created prior to folder connection.
  - **How to Fix:** Check if `files.length > 0` before overwriting. If so, display a confirmation modal offering to merge local notes with the folder, keep both, or cancel the connection.

- [x] **DATA-05: Missing `beforeunload` Handler Loses In-Flight Edits on Tab Close or Refresh** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js`](file:///home/raja/Workspace/keepLocal/js/script.js)
  - **Problem Description:** There is no `window.addEventListener("beforeunload", ...)` handler. If a user edits a note in Block Mode and refreshes the browser tab or closes the window before the 400ms debounce completes, all recently typed characters are lost because they were never flushed to `localStorage`.
  - **Impact:** Unsaved content loss on accidental browser navigation, reload, or crash.
  - **How to Fix:** Add a `beforeunload` listener that forces an immediate flush of the current editor's content into `files` and saves to `localStorage`.

- [x] **DATA-06: Unhandled LocalStorage `QuotaExceededError` Halts JavaScript Execution** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L113-L135`](file:///home/raja/Workspace/keepLocal/js/script.js#L113-L135) (`saveWorkspaceMeta`, `saveWsFiles`, `saveWsConfig`), [`js/script.js#L1146-L1151`](file:///home/raja/Workspace/keepLocal/js/script.js#L1146-L1151)
  - **Problem Description:** All note contents and workspace configs are stored in `localStorage` as JSON strings. Browsers enforce a strict 5MB quota per domain. When `files` grows beyond 5MB (common with large notes or imported archives), `localStorage.setItem()` throws an uncaught `QuotaExceededError`. Since none of these calls are wrapped in `try...catch`, the exception bubbles up and terminates all subsequent JS logic.
  - **Impact:** Complete failure to save notes, frozen UI, and corrupted storage state.
  - **How to Fix:** Wrap all `localStorage.setItem` calls in `try...catch` blocks. If quota is exceeded, warn the user with an alert modal indicating storage is full, and migrate large file content storage to IndexedDB.

---

## 2. File System API & Sync Engine (High)

- [x] **FS-01: Keystroke Disk-Write Thrashing and Asynchronous I/O Race Conditions** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L2018-L2023`](file:///home/raja/Workspace/keepLocal/js/script.js#L2018-L2023)
  - **Problem Description:** In the plain text editor, the `input` event listener executes `syncWorkspace()` on **every single keystroke**:

    ```javascript
    editorTextarea.addEventListener("input", async () => {
        const f = findNode(files, selectedId);
        if (f?.type === "file") { f.content = editorTextarea.value; persistCurrent(); syncWorkspace(); }
    ...
    ```

    Typing at normal speed fires 5–10 asynchronous directory iterations and disk file writes per second concurrently. In Chrome, concurrent calls to `createWritable()` on the same file handle cause write collisions, `AbortError`, and severe typing stutter.
  - **Impact:** Massive browser UI lag, CPU spikes, and potential disk write corruption.
  - **How to Fix:** Debounce `syncWorkspace()` by 1000–1500ms so disk writes only occur after the user pauses typing. Maintain an `isSyncing` flag and queue to serialize disk writes.

- [x] **FS-02: Workspace Overlap Bug Due to Basename Comparison in `openFolderWorkspace`** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L394-L401`](file:///home/raja/Workspace/keepLocal/js/script.js#L394-L401)
  - **Problem Description:** When connecting a folder on the welcome screen:

    ```javascript
    const existingWs = workspaces.find(w => w.folderName === handle.name);
    if (existingWs) {
        workspaceHandle = handle;
        await idbSet(`handle_${existingWs.id}`, handle);
        await openWorkspace(existingWs.id);
        return;
    }
    ```

    `handle.name` is merely the directory name (e.g., `notes` or `docs`). If a user opens `/home/user/work/notes` and later opens `/home/user/personal/notes`, both have `handle.name === "notes"`. KeepLocal mistakenly overwrites the work workspace's handle and opens it instead of creating a new workspace.
  - **Impact:** Accidental overwriting of workspace folder handles and mixing of unrelated workspaces.
  - **How to Fix:** Do not assume identical directory basenames represent the same workspace. Check handle equality using `await handle.isSameEntry(storedHandle)` with stored IndexedDB handles, or prompt the user if a workspace with the same folder name already exists.

- [x] **FS-03: Restored File System Handles Silently Fail to Sync Due to Unhandled Permission Prompt** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L544-L558`](file:///home/raja/Workspace/keepLocal/js/script.js#L544-L558) (`openWorkspace`) & [`js/script.js#L1048-L1062`](file:///home/raja/Workspace/keepLocal/js/script.js#L1048-L1062) (`syncWorkspace`)
  - **Problem Description:** When a page reloads, browsers do not automatically grant read-write access to directory handles retrieved from IndexedDB without user activation. `queryPermission()` returns `"prompt"`. In `syncWorkspace()`, `workspaceHandle.entries()` throws a `NotAllowedError`. The error is silently swallowed by `console.warn("Sync:", e);`. Meanwhile, the UI status badge still displays the folder name in green as if connected.
  - **Impact:** The user believes files are being synced to their system, but disk sync is completely dead.
  - **How to Fix:** If `queryPermission` returns anything other than `"granted"`, mark `workspaceHandle` as `needsPermission: true`, update the status badge to say "Click to Re-authorize Folder", and call `requestPermission()` on the first user click.

- [x] **FS-04: `resyncFromDisk` Deselects and Closes Currently Active File** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L978-L997`](file:///home/raja/Workspace/keepLocal/js/script.js#L978-L997)
  - **Problem Description:** In `resyncFromDisk()`, line 991 hardcodes `selectedId = null; render(); await loadFile();`. Even when the active file still exists on disk, clicking refresh closes the file and clears the editor, forcing the user to find and reopen their note from the sidebar.
  - **Impact:** Annoying UX interruption and loss of editor context.
  - **How to Fix:** Preserve `selectedId`. Only reset `selectedId` if `findNode(files, selectedId)` is null after re-reading the directory.

- [ ] **FS-05: False "Requires Chromium" Warning on `0.0.0.0` Due to Insecure Context (`python3 -m http.server`)**
  - **Severity:** High
  - **Location:** [`js/script.js#L58`](file:///home/raja/Workspace/keepLocal/js/script.js#L58) (`supportsFS`), [`js/script.js#L180-L185`](file:///home/raja/Workspace/keepLocal/js/script.js#L180-L185), [`js/script.js#L808-L815`](file:///home/raja/Workspace/keepLocal/js/script.js#L808-L815), [`index.html#L99-L102`](file:///home/raja/Workspace/keepLocal/index.html#L99-L102), [`index.html#L222-L224`](file:///home/raja/Workspace/keepLocal/index.html#L222-L224)
  - **Problem Description:** When developers start a local test server using `python3 -m http.server`, the terminal outputs `Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...`. Under the W3C Secure Contexts specification, Chromium does **not** treat `0.0.0.0` as a trustworthy loopback address (only `127.0.0.1` and `localhost` are treated as secure). Consequently:
    1. On `http://0.0.0.0:8000`, `window.isSecureContext === false`.
    2. Because `showDirectoryPicker` has the `[SecureContext]` restriction, Chromium removes it from `window`.
    3. `const supportsFS = "showDirectoryPicker" in window;` evaluates to `false`.
    4. KeepLocal assumes a `false` result means the user is not running a Chromium browser, displaying: `⚠ Folder sync requires a Chromium-based browser.` and `Folder sync requires Chrome, Edge, or Brave.` even when running inside **Google Chrome**!
  - **Impact:** Folder sync is completely disabled for users running local servers on `0.0.0.0`, with a confusing and inaccurate error message that misidentifies their browser.
  - **How to Fix:**
    1. Detect insecure origins and distinguish between an unsupported browser and an insecure context:

       ```javascript
       const isSecure = window.isSecureContext;
       const isChromium = !!(window.chrome || (navigator.userAgentData && navigator.userAgentData.brands?.some(b => ["Chromium", "Google Chrome", "Microsoft Edge", "Brave"].includes(b.brand))));
       ```

    2. If the user loads KeepLocal on `0.0.0.0` (`location.hostname === "0.0.0.0"`), automatically suggest or redirect to `http://localhost:${location.port || 8000}` or `http://127.0.0.1:${location.port || 8000}`.
    3. Update the UI message to accurately explain: *"Folder sync requires a Secure Context. Please access via <http://localhost:8000> or <http://127.0.0.1:8000> instead of 0.0.0.0."* with a clickable link.

---

## 3. Editor, Tabs & Line Numbers (High / Medium)

- [x] **EDIT-01: Broken In-Place Folder Icon Toggle Due to Lucide SVG Replacement** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L1543-L1547`](file:///home/raja/Workspace/keepLocal/js/script.js#L1543-L1547)
  - **Problem Description:** When `render()` executes, `lucide.createIcons()` transforms all `<i data-lucide="..."></i>` tags into `<svg class="lucide ...">` elements. In the tree item click handler:

    ```javascript
    const iconEl = el.querySelector(".icon i");
    if (iconEl && window.lucide) {
        iconEl.setAttribute("data-lucide", node.isOpen ? "folder-open" : "folder");
        lucide.createIcons();
    }
    ```

    Because `<i>` no longer exists, `iconEl` is always `null`! The icon is never toggled and folders permanently display the closed folder icon even when expanded.
  - **Impact:** Folders do not indicate open/closed state visually.
  - **How to Fix:** Target the icon container directly:

    ```javascript
    const iconWrap = el.querySelector(".icon");
    if (iconWrap && window.lucide) {
        iconWrap.innerHTML = `<i data-lucide="${node.isOpen ? 'folder-open' : 'folder'}" size="15"></i>`;
        lucide.createIcons();
    }
    ```

- [x] **EDIT-02: Line Numbers De-synchronize and Misalign When Word Wrap Is Enabled** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L2005-L2011`](file:///home/raja/Workspace/keepLocal/js/script.js#L2005-L2011) & [`css/styles.css#L978-L987`](file:///home/raja/Workspace/keepLocal/css/styles.css#L978-L987)
  - **Problem Description:** In `updateLineNumbers()`, line numbers are rendered by counting newlines (`\n`) and joining integers. When Word Wrap (`Alt+Z`) is enabled, `#editor` and `#codeHighlightPre` wrap long lines onto multiple visual lines. However, `.line-numbers` does not wrap. Consequently, line numbers become severely displaced, with line 2 pointing to the wrapped tail of line 1.
  - **Impact:** Misleading line numbers that point to the wrong physical and visual lines of code.
  - **How to Fix:** Either:
    1. Automatically hide `.line-numbers` while word wrap is active (`.word-wrap-active .line-numbers { display: none; }`).
    2. Dynamically measure each line element's height and match it in `.line-numbers`.

- [x] **EDIT-03: Syntax Highlighting Layer and Textarea Drift Apart in Word Wrap Mode** (FIXED)
  - **Severity:** High
  - **Location:** [`css/styles.css#L921-L976`](file:///home/raja/Workspace/keepLocal/css/styles.css#L921-L976) & [`css/styles.css#L985`](file:///home/raja/Workspace/keepLocal/css/styles.css#L985)
  - **Problem Description:** `#editor` has `overflow: auto;`, meaning a vertical scrollbar consumes 8–15px of horizontal width when content overflows. `#codeHighlightPre` has `overflow: hidden;` and no scrollbar. In Word Wrap mode, the wrapping width in `#editor` is narrower than in `#codeHighlightPre`. Long lines wrap at different character boundaries in the two layers, creating a blurred "double vision" effect where the highlighted tokens detach from the cursor and selection. Furthermore, `word-break: break-all !important;` unnaturally splits regular English words across lines.
  - **Impact:** Unusable syntax highlighting and cursor misalignment in raw editor wrap mode.
  - **How to Fix:**
    1. Ensure both layers share identical padding, scrollbar gutter (`scrollbar-gutter: stable;`), and box sizing.
    2. Change `word-break: break-all !important;` to `overflow-wrap: break-word; word-break: normal;`.

- [x] **EDIT-04: EditorJS Heading Font Sizes Overwritten to Uniform 1.6x on Font Size Change** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L720-L728`](file:///home/raja/Workspace/keepLocal/js/script.js#L720-L728) (`applyConfig`)
  - **Problem Description:** When `changeFontSize()` is called, `applyConfig()` iterates through all `.ce-header` elements and sets:

    ```javascript
    editorjsWrapper.querySelectorAll(".ce-header").forEach(el => {
        el.style.setProperty("font-size", `${fontSize * 1.6}px`, "important");
    });
    ```

    This destroys the CSS heading hierarchy (H1 is 2.2x, H2 is 1.9x, H3 is 1.6x, H4 is 1.4x), making all heading levels identical in size. Furthermore, any newly added heading blocks do not get this inline style, resulting in mismatched headers.
  - **Impact:** Broken typographic hierarchy in Block Mode.
  - **How to Fix:** Delete lines 720–728 in `js/script.js`. CSS rules in `css/styles.css#L1324-L1350` already use `calc(var(--editor-font-size) * ...)` to scale headers accurately.

- [x] **EDIT-05: Creating Folder Leaves Editor in Stale State with `selectedId` Pointing to Folder** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1091-L1103`](file:///home/raja/Workspace/keepLocal/js/script.js#L1091-L1103) (`addFolder`)
  - **Problem Description:** `addFolder()` sets `selectedId = nf.id;` (the new folder's ID) but does not call `loadFile()`. The editor continues displaying whatever file was previously open. If the user edits text, the raw input event handler checks `if (f?.type === "file")`, which fails because `selectedId` is a folder. Edits are silently discarded.
  - **Impact:** Discarded user edits and UI inconsistency.
  - **How to Fix:** Either call `loadFile()` after creating a folder (displaying an empty/folder placeholder state and disabling the textarea), or leave `selectedId` pointing to the active file.

- [x] **EDIT-06: Deleting Folder Leaves Deleted Child Files Open in Tabs and Editor** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1110-L1121`](file:///home/raja/Workspace/keepLocal/js/script.js#L1110-L1121) (`deleteNode`)
  - **Problem Description:** `deleteNode(id)` only checks `if (selectedId === id)`. If a user deletes a folder while one of its nested child files is active, `selectedId` remains set to that child file. The editor continues to edit a deleted file that no longer exists in `files`, and edits cannot be saved.
  - **Impact:** Ghost tabs and un-savable file editing state.
  - **How to Fix:** In `deleteNode`, collect all descendant IDs of the deleted node. Filter `openTabs = openTabs.filter(tid => !deletedIds.has(tid))`. If `deletedIds.has(selectedId)`, reset `selectedId` and call `loadFile()`.

- [x] **EDIT-07: Inline Rename Escape Key Cancels But Blur Immediately Commits** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1176-L1195`](file:///home/raja/Workspace/keepLocal/js/script.js#L1176-L1195) (`beginInlineRename`)
  - **Problem Description:** In `beginInlineRename()`, when the user presses `Escape`, line 1193 runs `inlineRenameId = null; render();`. Calling `render()` removes the `<input>` element from the DOM, which triggers the browser's `blur` event. The `blur` handler calls `commit()`, which reads the input value and commits the rename anyway!
  - **Impact:** Inability to cancel an inline rename with Escape.
  - **How to Fix:** Set a boolean flag `let isCancelled = false;` in the Escape key handler:

    ```javascript
    if (e.key === "Escape") { isCancelled = true; inlineRenameId = null; render(); }
    ```

    In `commit()`, check `if (isCancelled) return;`.

- [x] **EDIT-08: Drag and Drop Allows Duplicate Filenames in the Same Folder** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1123-L1145`](file:///home/raja/Workspace/keepLocal/js/script.js#L1123-L1145) (`moveNode`)
  - **Problem Description:** When moving an item via drag-and-drop into a folder (or root), `moveNode` performs no name collision check. If `folderA` already contains `notes.md` and the user drops another `notes.md` into it, `folderA.children` now contains two files with the exact same name.
  - **Impact:** Confusing UI, broken tab selection, and file overwrite bugs during disk sync and ZIP exports.
  - **How to Fix:** Before appending `src` to `arr`, check `if (nameExistsInArray(arr, src.name, src.id))`. If a collision occurs, generate a unique name using `uniqueName(arr, src.name)` or show a duplicate warning modal.

- [x] **EDIT-09: Active Note Content Replaced by Other Note in Tab List When Pressing New File (+)** (FIXED)
  - **Severity:** High
  - **Location:** [`js/script.js#L874-L895`](file:///home/raja/Workspace/keepLocal/js/script.js#L874-L895) (`autoSaveCurrentFile`), [`js/script.js#L1726-L1750`](file:///home/raja/Workspace/keepLocal/js/script.js#L1726-L1750) (`addFile`), [`js/script.js#L2090-L2125`](file:///home/raja/Workspace/keepLocal/js/script.js#L2090-L2125) (`openTab`), [`js/script.js#L2510-L2575`](file:///home/raja/Workspace/keepLocal/js/script.js#L2510-L2575) (`loadFile`)
  - **Problem Description:** When pressing the New File (`+`) button multiple times (e.g. on the 3rd press) or switching tabs rapidly, asynchronous EditorJS rendering and auto-save calls race against each other. `selectedId` was switched to the new file before `loadFile()` finished asynchronously rendering in Editor.js (`await editorInstance.render()`). A subsequent `autoSaveCurrentFile()` call targeted `selectedId` (the newly created/opened file) while `editorInstance` still contained blocks from the previously active note. Consequently, the previous note's content was saved into the newly active note, causing active notes to have their content replaced by another note from the tab list.
  - **Impact:** Content clobbering and silent data loss across open tabs during repeated file creation or rapid tab switching.
  - **How to Fix:**
    1. Introduce an `editorLoadedFileId` variable to explicitly track which file is currently rendered in `editorInstance`. In `autoSaveCurrentFile()`, write to `targetId || editorLoadedFileId || selectedId`, ensuring Editor.js blocks are saved only to the file they originated from.
    2. Guard `autoSaveCurrentFile()` so that it immediately returns if `isInitEditor` is active, preventing incomplete/transition states from overwriting notes.
    3. Add re-entrancy locks (`isAddingFile` and `isOpenTabInProgress`) to serialize `addFile()` and `openTab()` execution and prevent concurrent asynchronous render races.

---

## 4. Markdown & Block Editor (Editor.js) Bridge (Medium)

- [x] **MD-01: Cross-Site Scripting (XSS) Vulnerability in Markdown Link & Image Parsing** (FIXED)
  - **Severity:** Critical / Security
  - **Location:** [`js/script.js#L1675-L1686`](file:///home/raja/Workspace/keepLocal/js/script.js#L1675-L1686) (`md2h`)
  - **Problem Description:** `md2h()` uses naive regex replacements without HTML escaping or URL scheme validation:

    ```javascript
    let res = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" ... />');
    res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    ```

    If markdown content contains `[Click](javascript:alert(document.domain))` or raw `<img src=x onerror=...>`, it gets injected straight into the DOM inside Editor.js contenteditable blocks.
  - **Impact:** Arbitrary JavaScript execution when opening untrusted or imported notes.
  - **How to Fix:** Escape HTML entities (`&`, `<`, `>`, `"`) before applying formatting, and validate that URL protocols are restricted to `http:`, `https:`, `mailto:`, or relative anchors.

- [x] **MD-02: Code Block Language Identifiers Discarded in Conversion** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1643-L1645`](file:///home/raja/Workspace/keepLocal/js/script.js#L1643-L1645) & [`js/script.js#L1722`](file:///home/raja/Workspace/keepLocal/js/script.js#L1722)
  - **Problem Description:** When parsing markdown into blocks, `if (line.trim().startsWith("```"))` ignores everything after the triple backticks. The language tag (e.g. ```` ```python ````) is discarded. When converting back via `blocksToText`, line 1722 always outputs plain ```` ``` ```` without a language identifier.
  - **Impact:** Permanent loss of syntax highlighting language metadata in code blocks.
  - **How to Fix:** Extract the language tag `line.trim().slice(3).trim()` in `textToBlocks`, store it in the block data, and restore it in `blocksToText`.

- [x] **MD-03: Nested Lists Flattened During `textToBlocks` Conversion** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1647`](file:///home/raja/Workspace/keepLocal/js/script.js#L1647) & [`js/script.js#L1659-L1668`](file:///home/raja/Workspace/keepLocal/js/script.js#L1659-L1668)
  - **Problem Description:** `const t = line.trim();` strips all leading spaces from every line before parsing list markers. Indented sub-items (e.g. `- Sub item`) lose their indentation and are pushed as flat root items.
  - **Impact:** Nested list structures are completely destroyed upon switching between raw and block editor modes.
  - **How to Fix:** Preserve leading whitespace count in `textToBlocks` and build a nested tree structure for `@editorjs/nested-list`.

- [x] **MD-04: Tables Always Forced to Have Headers in `blocksToText`** (FIXED)
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1638`](file:///home/raja/Workspace/keepLocal/js/script.js#L1638) & [`js/script.js#L1723`](file:///home/raja/Workspace/keepLocal/js/script.js#L1723)
  - **Problem Description:** `flushTable()` always sets `withHeadings: true`. In `blocksToText`, line 1723 unconditionally injects `| --- | --- |` under row 0, even for tables that had no headers.
  - **Impact:** Corrupted table markdown format and inability to create header-less tables.
  - **How to Fix:** Check whether row 1 contains markdown delimiter dashes (`:?---+:?`) before setting `withHeadings: true`. Only emit the separator line in `blocksToText` if `withHeadings` is true.

- [x] **MD-05: Unescaped Folder Name in Workspace Cards (DOM XSS)** (FIXED)
  - **Severity:** Medium / Security
  - **Location:** [`js/script.js#L218-L220`](file:///home/raja/Workspace/keepLocal/js/script.js#L218-L220)
  - **Problem Description:** While `ws.name` is escaped via `escHtml()`, `ws.folderName` is inserted into `card.innerHTML` unescaped:

    ```javascript
    const folderBadge = ws.folderName
        ? `<span class="ws-card-badge folder-badge"><i data-lucide="folder" size="10"></i>${ws.folderName}</span>`
        : ...
    ```

  - **Impact:** Potential DOM injection if a folder on disk contains special characters or script tags.
  - **How to Fix:** Wrap `ws.folderName` in `escHtml(ws.folderName)`.

---

## 5. ZIP Import & Export System (Medium)

- [ ] **ZIP-01: Windows Backslash Path Splitting Fails on Import**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L464`](file:///home/raja/Workspace/keepLocal/js/script.js#L464) & [`js/script.js#L1239`](file:///home/raja/Workspace/keepLocal/js/script.js#L1239)
  - **Problem Description:** ZIP archives created on Windows frequently use backslashes (`\`) as directory separators. The import logic only splits on forward slashes (`rel.split("/")`). As a result, paths like `folder\note.md` are not recognized as directories and are imported as a single file named `folder\note.md`.
  - **Impact:** Broken folder structures when importing ZIP archives generated on Windows.
  - **How to Fix:** Normalize paths with `rel.replace(/\\/g, "/").split("/")`.

- [ ] **ZIP-02: Async Concurrency Race in ZIP Import Creates Duplicate Folders**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L460-L481`](file:///home/raja/Workspace/keepLocal/js/script.js#L460-L481) & [`js/script.js#L1235-L1254`](file:///home/raja/Workspace/keepLocal/js/script.js#L1235-L1254)
  - **Problem Description:** Inside `zip.forEach`, an async function is launched for each entry and pushed into `promises`. Because entries run concurrently, two files in the same directory (e.g. `docs/a.md` and `docs/b.md`) both evaluate `if (!folders[fp])` simultaneously before either folder is created. Duplicate folders are created and added to `files`.
  - **Impact:** Duplicate identical folders appear in the tree on import.
  - **How to Fix:** Pre-process the zip entries synchronously to build the folder hierarchy before asynchronously loading file text contents.

- [ ] **ZIP-03: Corrupted ZIP Import Leaves Zombie Workspace on Welcome Screen**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L435-L457`](file:///home/raja/Workspace/keepLocal/js/script.js#L435-L457) (`handleWelcomeImport`)
  - **Problem Description:** In `handleWelcomeImport`, the new workspace object `ws` is pushed to `workspaces` and saved to `localStorage` *before* `JSZip.loadAsync()` finishes. If the uploaded file is corrupt or not a valid ZIP, `loadAsync` throws an unhandled rejection, leaving an empty, broken workspace on the welcome screen.
  - **Impact:** Corrupted workspace list requiring manual deletion.
  - **How to Fix:** Wrap `JSZip.loadAsync` in a `try...catch` block. Only instantiate and persist the workspace after the zip has loaded successfully.

- [ ] **ZIP-04: ZIP Export Omits Active File's Unsaved Changes**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1200-L1213`](file:///home/raja/Workspace/keepLocal/js/script.js#L1200-L1213) (`exportAll`, `exportFolder`)
  - **Problem Description:** Clicking "Export ZIP" immediately reads `files` from memory without calling `await autoSaveCurrentFile()`. Any recent edits in the active editor tab are missing from the exported archive.
  - **Impact:** Incomplete or stale backup archives.
  - **How to Fix:** Add `await autoSaveCurrentFile();` at the beginning of `exportAll` and `exportFolder`.

- [ ] **ZIP-05: `downloadBlob` Fails in Firefox Due to Detached Anchor Tag**
  - **Severity:** Low
  - **Location:** [`js/script.js#L1220-L1225`](file:///home/raja/Workspace/keepLocal/js/script.js#L1220-L1225) (`downloadBlob`)
  - **Problem Description:** In Firefox, calling `a.click()` on an anchor element that is not appended to the document body often fails silently.
  - **Impact:** ZIP downloads fail to trigger in Firefox.
  - **How to Fix:** Append `a` to `document.body` before calling `click()`, then remove it:

    ```javascript
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    ```

---

## 6. Search, Navigation & Explorer (Medium / Low)

- [ ] **SRCH-01: Explorer File Search Hides Folders Matching the Search Query**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1492-L1496`](file:///home/raja/Workspace/keepLocal/js/script.js#L1492-L1496) & [`js/script.js#L1604-L1611`](file:///home/raja/Workspace/keepLocal/js/script.js#L1604-L1611)
  - **Problem Description:** In `renderTree()`, folders are only displayed if `checkMatchingChild()` returns true. If a folder's name matches the query (e.g. user searches for `assets`), but its child files do not contain that word, the folder itself is hidden!
  - **Impact:** Users cannot find folders by name using explorer search.
  - **How to Fix:** Update folder visibility check:

    ```javascript
    const nameMatches = node.name.toLowerCase().includes(searchQuery);
    hasChild = checkMatchingChild(node, searchQuery);
    show = nameMatches || hasChild;
    ```

- [ ] **SRCH-02: Search Input in Sidebar Lacks Escape Key Handler**
  - **Severity:** Low
  - **Location:** [`index.html#L207`](file:///home/raja/Workspace/keepLocal/index.html#L207) & [`js/script.js#L1359-L1376`](file:///home/raja/Workspace/keepLocal/js/script.js#L1359-L1376)
  - **Problem Description:** Unlike the welcome screen search input which closes on `Escape`, `#searchInput` in the sidebar has no keydown listener. Pressing `Escape` does not clear or close the search bar.
  - **Impact:** Clunky search UX requiring manual mouse clicks to dismiss.
  - **How to Fix:** Add a `keydown` listener on `#searchInput` for `e.key === "Escape"` that calls `toggleSearchBar()`.

- [ ] **SRCH-03: No Filename Character Validation Allows Illegal Path Separators**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1178-L1187`](file:///home/raja/Workspace/keepLocal/js/script.js#L1178-L1187)
  - **Problem Description:** There is no input sanitization when renaming or creating files. If a user enters `notes/v1.md` or `test:file.md`, the File System Access API throws a `TypeError` when calling `getFileHandle()`.
  - **Impact:** Sync engine crashes on illegal filenames.
  - **How to Fix:** Validate filenames against illegal characters (`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) and reject invalid names with an informative message.

---

## 7. Styling, Dead Code & CSS Defects (Medium / Low)

- [ ] **STYLE-01: Workspace Switcher Dropdown Clipped by Sidebar `overflow: hidden`**
  - **Severity:** High
  - **Location:** [`css/styles.css#L105-L115`](file:///home/raja/Workspace/keepLocal/css/styles.css#L105-L115) & [`css/styles.css#L189-L203`](file:///home/raja/Workspace/keepLocal/css/styles.css#L189-L203)
  - **Problem Description:** `.sidebar` has `overflow: hidden;` and min-width `180px` (default `220px`). `.ws-dropdown` has `min-width: 240px;`. Whenever the sidebar is narrower than 240px, the right side of the dropdown (including active checkmarks) is clipped off-screen.
  - **Impact:** Switcher dropdown is cut off and broken on standard sidebar widths.
  - **How to Fix:** Set `width: 100%; min-width: 0; box-sizing: border-box;` on `.ws-dropdown`, or change `.sidebar-header` overflow handling.

- [ ] **STYLE-02: Global Theme Setting Is Never Persisted to LocalStorage**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L1315-L1319`](file:///home/raja/Workspace/keepLocal/js/script.js#L1315-L1319) (`toggleTheme`) & [`js/script.js#L2131`](file:///home/raja/Workspace/keepLocal/js/script.js#L2131)
  - **Problem Description:** Line 2131 attempts to read `localStorage.getItem("keeplocal_global_theme")`. However, `toggleTheme()` only writes to `saveWsConfig(activeWsId)`. The key `"keeplocal_global_theme"` is **never written anywhere in the codebase**. As a result, the welcome screen always reverts to `"dark"` on reload.
  - **Impact:** Theme toggle does not persist across welcome screen reloads.
  - **How to Fix:** Add `localStorage.setItem("keeplocal_global_theme", theme);` inside `toggleTheme()`.

- [ ] **STYLE-03: Sidebar Inline Width Overrides Workspace-Specific Saved Widths**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L2088`](file:///home/raja/Workspace/keepLocal/js/script.js#L2088) & [`js/script.js#L149`](file:///home/raja/Workspace/keepLocal/js/script.js#L149)
  - **Problem Description:** Dragging the resize handle sets an inline DOM style `sidebar.style.width = ... px`. When switching workspaces, `loadWsConfig()` sets `document.documentElement.style.setProperty("--sidebar-width", ...)`. Because the inline DOM style takes precedence over the CSS variable, the sidebar remains permanently frozen at the last dragged width across all workspaces.
  - **Impact:** Per-workspace sidebar width settings fail to apply.
  - **How to Fix:** Set `document.documentElement.style.setProperty("--sidebar-width", ...)` during drag, or update `sidebar.style.width` directly in `loadWsConfig()`.

- [ ] **STYLE-04: Dead Elements Queried in JavaScript (`workspacePathLabel`, `wsSyncBtn`, `workspacePathBar`)**
  - **Severity:** Low
  - **Location:** [`js/script.js#L39-L40`](file:///home/raja/Workspace/keepLocal/js/script.js#L39-L40), [`js/script.js#L751-L804`](file:///home/raja/Workspace/keepLocal/js/script.js#L751-L804)
  - **Problem Description:** JavaScript queries `workspacePathLabel`, `wsSyncBtn`, and `workspacePathBar` via `document.getElementById()`, but none of these IDs exist in `index.html`. They are dead leftovers from an earlier revision.
  - **Impact:** Dead code, useless DOM queries, and maintenance confusion.
  - **How to Fix:** Clean up unused variables and references in `js/script.js`.

- [ ] **STYLE-05: Redundant Duplicate Selectors in `css/styles.css`**
  - **Severity:** Low
  - **Location:** [`css/styles.css#L300-L327`](file:///home/raja/Workspace/keepLocal/css/styles.css#L300-L327) vs [`css/styles.css#L400-L422`](file:///home/raja/Workspace/keepLocal/css/styles.css#L400-L422); [`css/styles.css#L943`](file:///home/raja/Workspace/keepLocal/css/styles.css#L943) vs [`css/styles.css#L1018`](file:///home/raja/Workspace/keepLocal/css/styles.css#L1018)
  - **Problem Description:** `.section-header`, `.section-title`, `.section-chevron`, and `#codeHighlightPre code` are defined twice with conflicting font sizes (`11px` vs `10px`).
  - **Impact:** Cluttered stylesheet and unintended CSS rule overrides.
  - **How to Fix:** Merge duplicate selectors into single canonical rule blocks.

---

## 8. Accessibility, Responsiveness & Shortcuts (Medium / Low)

- [ ] **A11Y-01: Zero `@media` Queries Causing Total UI Collapse on Mobile & Small Screens**
  - **Severity:** High
  - **Location:** [`css/styles.css`](file:///home/raja/Workspace/keepLocal/css/styles.css)
  - **Problem Description:** `css/styles.css` contains zero media queries. On screens narrower than 768px (e.g. mobile phones at 375px width or split-screen windows), `.welcome-left` has a hardcoded `380px` width that overflows the viewport, pushing `.welcome-right` completely off-screen. Users cannot see or access their workspaces. In the editor view, the sidebar cannot be toggled or collapsed on mobile.
  - **Impact:** Unusable on mobile devices and narrow browser viewports.
  - **How to Fix:** Add responsive breakpoints (`@media (max-width: 768px)`):
    1. Stack the welcome screen panels vertically and let `.welcome-left` take `width: 100%`.
    2. Add a mobile sidebar toggle button and backdrop.

- [ ] **A11Y-02: Confirmation & Alert Modals Lack Focus Management & Close Buttons**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L903-L926`](file:///home/raja/Workspace/keepLocal/js/script.js#L903-L926) & [`index.html#L288-L301`](file:///home/raja/Workspace/keepLocal/index.html#L288-L301)
  - **Problem Description:** When `showConfirmModal()` opens, `modalInput` is hidden, but focus is not transferred to `modalConfirmBtn`. Pressing `Enter` does nothing. When `showAlertModal()` opens, it displays "Press Esc to close" with **no button at all**, making it impossible for touch/mobile users without a keyboard to dismiss alerts easily.
  - **Impact:** Broken keyboard navigation and mobile modal entrapment.
  - **How to Fix:** Focus `modalConfirmBtn` when opening confirmation modals. Add an "OK" button to alert modals for touch and mouse users. Trap focus inside `.modal-container`.

- [ ] **A11Y-03: Keyboard Shortcuts Do Not Support Mac `Command` (`Cmd`) Key**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L2046-L2072`](file:///home/raja/Workspace/keepLocal/js/script.js#L2046-L2072)
  - **Problem Description:** All shortcuts check `e.ctrlKey` exclusively. On macOS, users expect `Cmd+S`, `Cmd+N`, and `Cmd+Shift+L`. Pressing `Cmd+S` on Mac triggers the browser's native "Save Page As" prompt instead of saving.
  - **Impact:** Broken shortcut conventions for all macOS users.
  - **How to Fix:** Check `(e.ctrlKey || e.metaKey)` in all keyboard event handlers.

- [ ] **A11Y-04: Multi-Line Selection Tab Indentation Replaces Text with Spaces**
  - **Severity:** Medium
  - **Location:** [`js/script.js#L2024-L2032`](file:///home/raja/Workspace/keepLocal/js/script.js#L2024-L2032)
  - **Problem Description:** In `editorTextarea`, pressing `Tab` replaces whatever text is currently selected with 4 spaces. If a user selects 10 lines of code and presses `Tab` to indent them, all 10 lines are deleted and replaced by 4 spaces! `Shift+Tab` (unindent) is also unhandled.
  - **Impact:** Accidental deletion of selected code blocks upon pressing Tab.
  - **How to Fix:** Detect multi-line selection on `Tab`. If lines are selected, prepend 4 spaces to each line. On `Shift+Tab`, strip up to 4 leading spaces from each selected line.

- [ ] **A11Y-05: Context Menu Uses Page Coordinates for Fixed Position Element**
  - **Severity:** Low
  - **Location:** [`js/script.js#L1570-L1575`](file:///home/raja/Workspace/keepLocal/js/script.js#L1570-L1575) & [`css/styles.css#L1526-L1535`](file:///home/raja/Workspace/keepLocal/css/styles.css#L1526-L1535)
  - **Problem Description:** `.context-menu` is styled as `position: fixed;`, but line 1570 calculates its position using `e.pageY` and `e.pageX` (document-relative coordinates) instead of `e.clientY` and `e.clientX` (viewport-relative coordinates).
  - **Impact:** If the page has any scroll offset, the right-click menu spawns at an incorrect position off-screen.
  - **How to Fix:** Use `e.clientY` and `e.clientX` for positioning `position: fixed` elements.

---

## 9. Architecture, Offline & Security Concerns (Medium / Low)

- [ ] **ARCH-01: Zero Offline Support in a Self-Described "Local-First" App**
  - **Severity:** High
  - **Location:** [`index.html#L14-L32`](file:///home/raja/Workspace/keepLocal/index.html#L14-L32)
  - **Problem Description:** KeepLocal is marketed as a "private, local-first note editor", yet it loads 11 external scripts from CDNs (`unpkg.com`, `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`) and Google Fonts. If the user has no internet connection, none of these scripts load and the application fails to start.
  - **Impact:** Contradicts the "local-first" privacy model; fails completely when offline.
  - **How to Fix:** Bundle libraries locally in a `vendor/` or `lib/` directory or register a Service Worker that caches CDN scripts for offline use.

- [ ] **ARCH-02: Unpinned `@latest` CDN Dependencies Risk Breaking Changes**
  - **Severity:** Medium
  - **Location:** [`index.html#L17-L26`](file:///home/raja/Workspace/keepLocal/index.html#L17-L26)
  - **Problem Description:** Scripts use unversioned `@latest` tags:
    - `@editorjs/editorjs@latest`
    - `@editorjs/header@latest`
    - `@editorjs/nested-list@latest`
    - `@editorjs/checklist@latest`
    - `lucide@latest`
    Any upstream breaking release by these libraries will automatically break KeepLocal in production without code changes.
  - **Impact:** High vulnerability to unexpected production breakage.
  - **How to Fix:** Pin all CDN URLs to specific, tested semver tags (e.g. `@editorjs/editorjs@2.30.7`).

- [ ] **ARCH-03: Duplicate Scroll Event Listeners on `editorTextarea`**
  - **Severity:** Low
  - **Location:** [`js/script.js#L1993-L2000`](file:///home/raja/Workspace/keepLocal/js/script.js#L1993-L2000) & [`js/script.js#L2036`](file:///home/raja/Workspace/keepLocal/js/script.js#L2036)
  - **Problem Description:** `lineNumbersEl.scrollTop = editorTextarea.scrollTop;` is registered twice in two separate scroll event listeners on `editorTextarea`.
  - **Impact:** Redundant event processing on high-frequency scroll events.
  - **How to Fix:** Remove line 2036 and consolidate in line 1993.

- [ ] **ARCH-04: Outdated Documentation & Name Mismatch in `README.md`**
  - **Severity:** Low
  - **Location:** [`README.md#L1`](file:///home/raja/Workspace/keepLocal/README.md#L1), [`README.md#L68-L74`](file:///home/raja/Workspace/keepLocal/README.md#L68-L74)
  - **Problem Description:** The README refers to the application as `localKeep` rather than `KeepLocal`, and its "Known Limitations" section claims "The Tab key does not insert a tab character in the editor", which is no longer accurate.
  - **Impact:** Misleading project branding and inaccurate developer documentation.
  - **How to Fix:** Update `README.md` with accurate branding (`KeepLocal`) and current feature capabilities.
