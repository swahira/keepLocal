/* ============================================================
   KEEPLOCAL — script.js
   Workspace system + Editor integration
   ============================================================ */
document.addEventListener("DOMContentLoaded", async () => {

	// ============================================================
	// GLOBAL STATE
	// ============================================================
	let workspaces = [];    // [{id, name, createdAt, lastOpenedAt, folderName, fileCount}]
	let openTabs = [];    // [fileId1, fileId2, ...] open tab IDs
	let isWordWrap = false; // word wrap toggle
	let activeWsId = null;  // currently open workspace id
	let files = [];    // files for active workspace
	let selectedId = null;
	let theme = "dark";
	let fontSize = 13;
	let searchQuery = "";
	let wsCardSearchQuery = "";
	let importIdCounter = 0;
	let workspaceHandle = null;  // FileSystemDirectoryHandle
	let editorMode = "block";
	let editorInstance = null;
	let isInitEditor = false;
	let editorSaveTimer = null;
	let draggedId = null;
	let inlineRenameId = null;

	// ============================================================
	// DOM REFS
	// ============================================================
	const welcomeScreen = document.getElementById("welcomeScreen");
	const appShell = document.getElementById("appShell");
	const tabsListEl = document.getElementById("tabsList");
	const workspacesList = document.getElementById("workspacesList");
	const workspacesEmpty = document.getElementById("workspacesEmpty");
	const wsCountBadge = document.getElementById("wsCountBadge");
	const sidebarWsName = document.getElementById("sidebarWsName");
	const workspacePathLabel = document.getElementById("workspacePathLabel");
	const wsSyncBtn = document.getElementById("wsSyncBtn");
	const wsStatusBadge = document.getElementById("wsStatusBadge");
	const saveWorkspaceBtn = document.getElementById("saveWorkspaceBtn");
	const browserSupportMsg = document.getElementById("browserSupportMessage");
	const fileTreeEl = document.getElementById("fileTree");
	const breadcrumbEl = document.getElementById("breadcrumb");
	const cursorPosSpan = document.getElementById("cursorPos");
	const editorStatusSpan = document.getElementById("editorStatus");
	const editorjsWrapper = document.getElementById("editorjs");
	const plainWrapper = document.getElementById("plainEditorWrapper");
	const lineNumbersEl = document.getElementById("lineNumbers");
	const editorTextarea = document.getElementById("editor");
	const modeBlockBtn = document.getElementById("modeBlockBtn");
	const modePlainBtn = document.getElementById("modePlainBtn");

	// ============================================================
	// FEATURE DETECTION
	// ============================================================
	const supportsFS = "showDirectoryPicker" in window;

	// ============================================================
	// INDEXEDDB — persist folder handles
	// ============================================================
	const IDB_NAME = "keeplocal_db";
	const IDB_STORE = "handles";

	function idbOpen() {
		return new Promise((res, rej) => {
			const r = indexedDB.open(IDB_NAME, 1);
			r.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
			r.onsuccess = e => res(e.target.result);
			r.onerror = () => rej(r.error);
		});
	}
	async function idbSet(key, val) {
		try {
			const db = await idbOpen();
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(val, key);
			return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
		} catch (e) { console.warn("idbSet:", e); }
	}
	async function idbGet(key) {
		try {
			const db = await idbOpen();
			return new Promise((res, rej) => {
				const tx = db.transaction(IDB_STORE, "readonly");
				const req = tx.objectStore(IDB_STORE).get(key);
				req.onsuccess = () => res(req.result);
				req.onerror = () => rej(req.error);
			});
		} catch { return null; }
	}
	async function idbDel(key) {
		try {
			const db = await idbOpen();
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).delete(key);
		} catch (e) { console.warn("idbDel:", e); }
	}

	// ============================================================
	// UNIQUE ID
	// ============================================================
	function uid(type) {
		importIdCounter++;
		return (type === "folder" ? "d_" : type === "ws" ? "ws_" : "f_")
			+ Date.now() + "_" + importIdCounter + "_" + Math.random().toString(36).slice(2, 6);
	}

	// ============================================================
	// WORKSPACE PERSISTENCE
	// ============================================================
	function saveWorkspaceMeta() {
		localStorage.setItem("keeplocal_workspaces", JSON.stringify(workspaces));
	}
	function loadWorkspaceMeta() {
		const raw = localStorage.getItem("keeplocal_workspaces");
		workspaces = raw ? JSON.parse(raw) : [];
	}

	function saveWsFiles(wsId) {
		localStorage.setItem(`keeplocal_files_${wsId}`, JSON.stringify(files));
	}
	function loadWsFiles(wsId) {
		const raw = localStorage.getItem(`keeplocal_files_${wsId}`);
		files = raw ? JSON.parse(raw) : [];
	}

	function saveWsConfig(wsId) {
		const sidebar = document.querySelector(".sidebar");
		localStorage.setItem(`keeplocal_cfg_${wsId}`, JSON.stringify({
			theme, fontSize, selectedId, editorMode, openTabs, isWordWrap,
			sidebarWidth: sidebar ? sidebar.offsetWidth : undefined
		}));
	}
	function loadWsConfig(wsId) {
		const raw = localStorage.getItem(`keeplocal_cfg_${wsId}`);
		if (raw) {
			const c = JSON.parse(raw);
			theme = c.theme || "dark";
			fontSize = Number.isFinite(Number(c.fontSize))
				? Number(c.fontSize)
				: 13;
			selectedId = c.selectedId || null;
			editorMode = c.editorMode || "block";
			openTabs = Array.isArray(c.openTabs) ? c.openTabs : [];
			isWordWrap = !!c.isWordWrap;
			if (c.sidebarWidth) {
				document.documentElement.style.setProperty("--sidebar-width", c.sidebarWidth + "px");
			}
		} else {
			openTabs = [];
			isWordWrap = false;
		}
	}

	function deleteWsData(wsId) {
		localStorage.removeItem(`keeplocal_files_${wsId}`);
		localStorage.removeItem(`keeplocal_cfg_${wsId}`);
		idbDel(`handle_${wsId}`);
	}

	function updateWsMeta(wsId, patch) {
		const idx = workspaces.findIndex(w => w.id === wsId);
		if (idx !== -1) {
			Object.assign(workspaces[idx], patch);
			saveWorkspaceMeta();
		}
	}

	// ============================================================
	// WELCOME SCREEN
	// ============================================================
	function showWelcome() {
		welcomeScreen.classList.remove("hidden");
		appShell.classList.add("hidden");
		document.title = "KeepLocal – Workspaces";
		renderWorkspaceCards();
		// FS banner
		if (!supportsFS) {
			document.getElementById("welcomeFsBanner").classList.remove("hidden");
			document.getElementById("openFolderBtn").disabled = true;
			document.getElementById("openFolderBtn").title = "Requires Chrome/Edge/Brave";
		}
	}

	function renderWorkspaceCards() {
		workspacesList.innerHTML = "";
		wsCountBadge.textContent = workspaces.length;

		if (workspaces.length === 0) {
			workspacesEmpty.querySelector("p").textContent = "No workspaces yet";
			workspacesEmpty.querySelector("small").textContent = 'Click "New Workspace" to get started';
			workspacesEmpty.classList.remove("hidden");
			return;
		}

		// Sort by lastOpenedAt desc
		const sorted = [...workspaces].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
		const filtered = wsCardSearchQuery
			? sorted.filter(w => w.name.toLowerCase().includes(wsCardSearchQuery))
			: sorted;

		if (filtered.length === 0) {
			workspacesEmpty.querySelector("p").textContent = "No matching workspaces";
			workspacesEmpty.querySelector("small").textContent = "Try a different search term";
			workspacesEmpty.classList.remove("hidden");
			return;
		}
		workspacesEmpty.classList.add("hidden");

		for (const ws of filtered) {
			const card = document.createElement("div");
			card.className = "ws-card";
			card.setAttribute("data-wsid", ws.id);

			const relTime = timeAgo(ws.lastOpenedAt || ws.createdAt);
			const folderBadge = ws.folderName
				? `<span class="ws-card-badge folder-badge"><i data-lucide="folder" size="10"></i>${ws.folderName}</span>`
				: `<span class="ws-card-badge local-badge"><i data-lucide="hard-drive" size="10"></i>Local</span>`;

			card.innerHTML = `
			<div class="ws-card-icon">
				<i data-lucide="${ws.folderName ? 'folder-open' : 'layers'}" size="22"></i>
			</div>
			<div class="ws-card-body">
				<div class="ws-card-name">${escHtml(ws.name)}</div>
				<div class="ws-card-meta">
					${folderBadge}
					<span class="ws-card-files">${ws.fileCount || 0} file${ws.fileCount !== 1 ? 's' : ''}</span>
					<span class="ws-card-time">${relTime}</span>
				</div>
			</div>
			<div class="ws-card-actions">
				<button class="ws-card-btn" title="Rename" onclick="event.stopPropagation(); renameWorkspace('${ws.id}')">
					<i data-lucide="pencil" size="13"></i>
				</button>
				<button class="ws-card-btn danger" title="Delete workspace" onclick="event.stopPropagation(); deleteWorkspace('${ws.id}')">
					<i data-lucide="trash-2" size="13"></i>
				</button>
			</div>
		`;

			card.addEventListener("click", () => openWorkspace(ws.id));
			workspacesList.appendChild(card);
		}

		if (window.lucide) lucide.createIcons();
	}

	function escHtml(str) {
		return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function timeAgo(ts) {
		if (!ts) return "Never opened";
		const s = Math.floor((Date.now() - ts) / 1000);
		if (s < 60) return "Just now";
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
		return new Date(ts).toLocaleDateString();
	}

	// ============================================================
	// WORKSPACE DROPDOWN (GitHub Style)
	// ============================================================
	const wsDropdown = document.getElementById("wsDropdown");
	const wsDropdownList = document.getElementById("wsDropdownList");
	const wsSearchInput = document.getElementById("wsSearchInput");

	window.toggleWsDropdown = function (e) {
		if (e) e.stopPropagation();
		const isHidden = wsDropdown.classList.contains("hidden");
		if (isHidden) {
			renderWsDropdownItems();
			wsDropdown.classList.remove("hidden");
			if (wsSearchInput) {
				wsSearchInput.value = "";
				setTimeout(() => wsSearchInput.focus(), 30);
			}
		} else {
			hideWsDropdown();
		}
	};

	window.hideWsDropdown = function () {
		if (wsDropdown) wsDropdown.classList.add("hidden");
	};

	window.filterWsDropdown = function () {
		const q = wsSearchInput.value.toLowerCase().trim();
		renderWsDropdownItems(q);
	};
	window.filterWorkspaceCards = function () {
		wsCardSearchQuery = document.getElementById("wsCardSearchInput").value.toLowerCase().trim();
		renderWorkspaceCards();
	};
	window.toggleWsCardSearch = function () {
		const input = document.getElementById("wsCardSearchInput");
		if (!input) return;
		const isHidden = input.classList.toggle("hidden");
		if (!isHidden) {
			setTimeout(() => input.focus(), 30);
		} else {
			input.value = "";
			wsCardSearchQuery = "";
			renderWorkspaceCards();
		}
	};

	document.getElementById("wsCardSearchInput")?.addEventListener("keydown", (e) => {
		if (e.key === "Escape") toggleWsCardSearch();
	});

	function renderWsDropdownItems(filter = "") {
		if (!wsDropdownList) return;
		wsDropdownList.innerHTML = "";
		const sorted = [...workspaces].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
		const filtered = sorted.filter(w => w.name.toLowerCase().includes(filter));

		if (filtered.length === 0) {
			const empty = document.createElement("div");
			empty.className = "ws-dropdown-item";
			empty.style.color = "var(--text-muted)";
			empty.textContent = "No workspaces found";
			wsDropdownList.appendChild(empty);
			return;
		}

		filtered.forEach(ws => {
			const item = document.createElement("div");
			const isActive = ws.id === activeWsId;
			item.className = `ws-dropdown-item${isActive ? " active" : ""}`;

			item.innerHTML = `
				<i data-lucide="${ws.folderName ? 'folder' : 'layers'}" size="14" class="ws-item-icon"></i>
				<span class="ws-item-name">${escHtml(ws.name)}</span>
				${isActive ? '<i data-lucide="check" size="14" class="ws-item-check"></i>' : ''}
			`;

			item.onclick = async (e) => {
				e.stopPropagation();
				hideWsDropdown();
				if (!isActive) {
					await openWorkspace(ws.id);
				}
			};

			wsDropdownList.appendChild(item);
		});

		if (window.lucide) lucide.createIcons();
	}

	window.addEventListener("click", (e) => {
		if (wsDropdown && !wsDropdown.contains(e.target) && !e.target.closest("#wsSwitcherBtn")) {
			hideWsDropdown();
		}
	});

	// ============================================================
	// WORKSPACE CRUD
	// ============================================================
	window.createNewWorkspace = function () {
		showInputModal("Workspace name", "My Notes", async (name) => {
			if (!name) return;
			if (wsNameExists(name)) {
				showAlertModal("Duplicate name", `A workspace named "${name}" already exists. Please choose a different name.`);
				return;
			}
			const ws = {
				id: uid("ws"),
				name,
				createdAt: Date.now(),
				lastOpenedAt: Date.now(),
				folderName: null,
				fileCount: 0
			};
			workspaces.push(ws);
			saveWorkspaceMeta();
			await openWorkspace(ws.id);
		});
	};

	window.openFolderWorkspace = async function () {
		if (!supportsFS) {
			showAlertModal("Not supported", "Folder sync requires Chrome, Edge, or Brave.");
			return;
		}
		try {
			const handle = await window.showDirectoryPicker({ mode: "readwrite" });
			// Check if a workspace already exists for this folder
			const existingWs = workspaces.find(w => w.folderName === handle.name);
			if (existingWs) {
				// Reconnect the handle and open it
				workspaceHandle = handle;
				await idbSet(`handle_${existingWs.id}`, handle);
				await openWorkspace(existingWs.id);
				return;
			}
			// Create new workspace from folder
			const ws = {
				id: uid("ws"),
				name: uniqueWsName(handle.name),
				createdAt: Date.now(),
				lastOpenedAt: Date.now(),
				folderName: handle.name,
				fileCount: 0
			};
			workspaces.push(ws);
			saveWorkspaceMeta();

			// Store handle
			await idbSet(`handle_${ws.id}`, handle);
			workspaceHandle = handle;

			// Read folder contents
			const readFiles = await readDirectoryHandle(handle);
			files = readFiles;
			ws.fileCount = countAllFiles(files);
			saveWorkspaceMeta();
			saveWsFiles(ws.id);

			await openWorkspace(ws.id, true /* skip file read, already done */);
		} catch (err) {
			if (err.name !== "AbortError") showAlertModal("Error", err.message);
		}
	};

	window.importZipOnWelcome = function () {
		document.getElementById("welcomeImportInput").click();
	};

	window.handleWelcomeImport = async function (event) {
		const file = event.target.files[0];
		if (!file) return;
		// Create workspace named after the zip
		const wsName = uniqueWsName(file.name.replace(/\.zip$/i, ""));
		const ws = {
			id: uid("ws"),
			name: wsName,
			createdAt: Date.now(),
			lastOpenedAt: Date.now(),
			folderName: null,
			fileCount: 0
		};
		workspaces.push(ws);
		saveWorkspaceMeta();
		activeWsId = ws.id;

		// Import the zip
		await new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = async (e) => {
				const zip = await JSZip.loadAsync(e.target.result);
				files = [];
				const promises = [];
				const folders = { "": files };
				zip.forEach((relativePath, zipEntry) => {
					if (zipEntry.dir) return;
					promises.push((async () => {
						const content = await zipEntry.async("string");
						const parts = relativePath.split("/");
						const fname = parts.pop();
						if (!fname) return;
						let arr = files, curPath = "";
						for (const dir of parts) {
							if (!dir) continue;
							const fp = curPath ? `${curPath}/${dir}` : dir;
							if (!folders[fp]) {
								const nf = { id: uid("folder"), name: dir, type: "folder", isOpen: true, children: [] };
								arr.push(nf); folders[fp] = nf.children;
							}
							arr = folders[fp]; curPath = fp;
						}
						if (!nameExistsInArray(arr, fname))
							arr.push({ id: uid("file"), name: fname, type: "file", content });
					})());
				});
				await Promise.all(promises);
				resolve();
			};
			reader.readAsArrayBuffer(file);
		});

		event.target.value = "";
		ws.fileCount = countAllFiles(files);
		saveWorkspaceMeta();
		saveWsFiles(ws.id);
		await openWorkspace(ws.id, true);
	};

	window.renameWorkspace = function (wsId) {
		const ws = workspaces.find(w => w.id === wsId);
		if (!ws) return;
		showInputModal("Rename workspace", ws.name, (name) => {
			if (!name || name === ws.name) return;
			if (wsNameExists(name, wsId)) {
				showAlertModal("Duplicate name", `A workspace named "${name}" already exists. Please choose a different name.`);
				return;
			}
			ws.name = name;
			saveWorkspaceMeta();
			renderWorkspaceCards();
		});
	};

	window.deleteWorkspace = function (wsId) {
		const ws = workspaces.find(w => w.id === wsId);
		if (!ws) return;
		showConfirmModal(
			"Delete workspace",
			`Delete "${ws.name}"? All files stored in KeepLocal for this workspace will be removed. Files in your system folder are untouched.`,
			(confirmed) => {
				if (!confirmed) return;
				workspaces = workspaces.filter(w => w.id !== wsId);
				deleteWsData(wsId);
				saveWorkspaceMeta();
				renderWorkspaceCards();
			},
			true
		);
	};

	// Open a workspace → switch to editor view
	async function openWorkspace(wsId, skipFileLoad = false) {
		const ws = workspaces.find(w => w.id === wsId);
		if (!ws) return;

		activeWsId = wsId;
		ws.lastOpenedAt = Date.now();
		saveWorkspaceMeta();

		// Load config for this workspace
		loadWsConfig(wsId);

		// Load files (unless already in memory from folder read)
		if (!skipFileLoad) {
			loadWsFiles(wsId);
		}

		// Try to restore folder handle from IDB
		workspaceHandle = null;
		if (supportsFS && ws.folderName) {
			try {
				const h = await idbGet(`handle_${wsId}`);
				if (h) {
					const perm = await h.queryPermission({ mode: "readwrite" });
					if (perm === "granted") {
						workspaceHandle = h;
					} else {
						// Will need to request permission
						workspaceHandle = h; // keep handle, request on first sync
					}
				}
			} catch (e) { console.warn("Could not restore handle:", e); }
		}

		// Validate selectedId
		if (selectedId && !findNode(files, selectedId)) selectedId = null;

		// Save active workspace ID so page reload returns here directly
		localStorage.setItem("keeplocal_active_ws_id", wsId);

		// Switch views
		welcomeScreen.classList.add("hidden");
		appShell.classList.remove("hidden");
		document.title = `${ws.name} – KeepLocal`;

		// Update UI
		sidebarWsName.textContent = ws.name;
		applyConfig();
		updateEditorModeUI();
		initWorkspaceButton();
		updateFolderUI();
		render();
		await loadFile();

		if (window.lucide) lucide.createIcons();
	}

	window.goHome = async function () {
		// Save current state before going home
		if (activeWsId) {
			await autoSaveCurrentFile();
			saveWsFiles(activeWsId);
			saveWsConfig(activeWsId);
			// update file count
			updateWsMeta(activeWsId, { fileCount: countAllFiles(files) });
		}
		localStorage.removeItem("keeplocal_active_ws_id");
		activeWsId = null;
		workspaceHandle = null;
		files = [];
		selectedId = null;
		// Destroy editor instance to avoid memory leak
		if (editorInstance) {
			try { editorInstance.destroy(); } catch (_) { }
			editorInstance = null;
		}
		showWelcome();
	};

	async function autoSaveCurrentFile() {
		const f = findNode(files, selectedId);
		if (!f || f.type !== "file") return;
		if (editorMode === "block" && editorInstance) {
			try { const d = await editorInstance.save(); f.content = blocksToText(d); } catch (_) { }
		} else {
			f.content = editorTextarea.value;
		}
	}

	// ============================================================
	// APPLY CONFIG
	// ============================================================
	function applyConfig() {
		document.body.setAttribute("data-theme", theme);

		const prismLink = document.getElementById("prismTheme");

		if (prismLink) {
			prismLink.href = theme === "dark"
				? "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css"
				: "https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css";
		}

		const themeButton = document.getElementById("themeToggle");

		if (themeButton) {
			themeButton.innerHTML = `
            <i data-lucide="${theme === "dark" ? "sun" : "moon"}" size="15"></i>
        `;

			if (window.lucide) {
				lucide.createIcons();
			}
		}

		// ============================================
		// FONT SIZE
		// ============================================

		// Main editor font-size variable
		document.documentElement.style.setProperty(
			"--editor-font-size",
			`${fontSize}px`
		);

		// Raw editor
		if (editorTextarea) {
			editorTextarea.style.fontSize = `${fontSize}px`;
		}

		// Line numbers
		// if (lineNumbersEl) {
		// 	lineNumbersEl.style.fontSize = `${fontSize}px`;
		// }

		// Line numbers
		if (lineNumbersEl) {
			const lineHeight = fontSize * 1.5385;

			// Number itself stays small
			lineNumbersEl.style.fontSize = "13px";

			// But each number occupies one full editor line
			lineNumbersEl.style.lineHeight = `${lineHeight}px`;

			lineNumbersEl.querySelectorAll("div").forEach((line) => {
				line.style.height = `${lineHeight}px`;
				line.style.lineHeight = `${lineHeight}px`;
				line.style.fontSize = "13px";
			});
		}
		// Code highlighting
		const codeHighlightPre =
			document.getElementById("codeHighlightPre");

		const codeHighlightContent =
			document.getElementById("codeHighlightContent");

		if (codeHighlightPre) {
			codeHighlightPre.style.fontSize = `${fontSize}px`;
		}

		if (codeHighlightContent) {
			codeHighlightContent.style.fontSize = `${fontSize}px`;
		}

		// Editor.js
		if (editorjsWrapper) {
			editorjsWrapper.style.setProperty(
				"--editor-font-size",
				`${fontSize}px`
			);

			editorjsWrapper.style.setProperty(
				"font-size",
				`${fontSize}px`,
				"important"
			);

			// Editor.js creates these elements dynamically
			editorjsWrapper
				.querySelectorAll(
					".ce-paragraph, .cdx-block, .ce-code__textarea, " +
					".cdx-quote, .cdx-list, .cdx-checklist, .tc-cell"
				)
				.forEach(el => {
					el.style.setProperty(
						"font-size",
						`${fontSize}px`,
						"important"
					);
				});

			// Headings
			editorjsWrapper
				.querySelectorAll(".ce-header")
				.forEach(el => {
					el.style.setProperty(
						"font-size",
						`${fontSize * 1.6}px`,
						"important"
					);
				});
		}

		applyWordWrapUI();
	}

	function updateEditorModeUI() {
		if (editorMode === "block") {
			modeBlockBtn?.classList.add("active");
			modePlainBtn?.classList.remove("active");
			editorjsWrapper?.classList.remove("hidden");
			plainWrapper?.classList.add("hidden");
			if (editorStatusSpan) editorStatusSpan.textContent = "Block Mode";
		} else {
			modePlainBtn?.classList.add("active");
			modeBlockBtn?.classList.remove("active");
			plainWrapper?.classList.remove("hidden");
			editorjsWrapper?.classList.add("hidden");
			if (editorStatusSpan) editorStatusSpan.textContent = "Raw Text";
		}
	}

	function updateFolderUI() {
		const pathBar = document.getElementById("workspacePathBar");
		const wsFolderLabel = document.getElementById("sidebarWsFolder");

		// Browser doesn't support folder sync at all — leave the
		// "unsupported browser" state from initWorkspaceButton() alone.
		if (!supportsFS) {
			if (workspacePathLabel) workspacePathLabel.textContent = "Local workspace";
			if (wsFolderLabel) {
				wsFolderLabel.textContent = "Local storage";
				wsFolderLabel.classList.remove("has-folder");
			}
			if (wsSyncBtn) wsSyncBtn.style.display = "none";
			if (wsStatusBadge) {
				wsStatusBadge.textContent = "No folder";
				wsStatusBadge.classList.remove("connected");
			}
			pathBar?.classList.remove("has-folder");
			if (window.lucide) lucide.createIcons();
			return;
		}

		if (workspaceHandle) {
			if (workspacePathLabel) workspacePathLabel.textContent = workspaceHandle.name;
			if (wsFolderLabel) {
				wsFolderLabel.textContent = workspaceHandle.name;
				wsFolderLabel.classList.add("has-folder");
			}
			if (wsSyncBtn) wsSyncBtn.style.display = "flex";
			if (wsStatusBadge) {
				wsStatusBadge.textContent = workspaceHandle.name;
				wsStatusBadge.classList.add("connected");
			}
			if (saveWorkspaceBtn) {
				saveWorkspaceBtn.innerHTML = '<i data-lucide="hard-drive" size="14"></i> <span>Change Folder</span>';
				saveWorkspaceBtn.title = `Currently synced with "${workspaceHandle.name}" — click to connect a different folder`;
			}
			pathBar?.classList.add("has-folder");
		} else {
			if (workspacePathLabel) workspacePathLabel.textContent = "Local workspace";
			if (wsFolderLabel) {
				wsFolderLabel.textContent = "Local storage";
				wsFolderLabel.classList.remove("has-folder");
			}
			if (wsSyncBtn) wsSyncBtn.style.display = "none";
			if (wsStatusBadge) {
				wsStatusBadge.textContent = "No folder";
				wsStatusBadge.classList.remove("connected");
			}
			if (saveWorkspaceBtn) {
				saveWorkspaceBtn.innerHTML = '<i data-lucide="hard-drive" size="14"></i> <span>Connect Folder</span>';
				saveWorkspaceBtn.title = "Connect a local folder to sync files";
			}
			pathBar?.classList.remove("has-folder");
		}
		if (window.lucide) lucide.createIcons();
	}

	function initWorkspaceButton() {
		if (!supportsFS) {
			saveWorkspaceBtn.disabled = true;
			saveWorkspaceBtn.classList.add("disabled");
			saveWorkspaceBtn.title = "Folder sync requires Chrome, Edge, or Brave";
			browserSupportMsg?.classList.remove("hidden");
		}
	}

	// ============================================================
	// HELPERS
	// ============================================================
	function findNode(nodes, id) {
		for (const n of nodes) {
			if (n.id === id) return n;
			if (n.children) { const f = findNode(n.children, id); if (f) return f; }
		}
		return null;
	}
	function findParent(nodes, id, p = null) {
		for (const n of nodes) {
			if (n.id === id) return p;
			if (n.children) { const f = findParent(n.children, id, n); if (f) return f; }
		}
		return null;
	}
	function findFirstFile(nodes) {
		for (const n of nodes) {
			if (n.type === "file") return n;
			if (n.children) { const f = findFirstFile(n.children); if (f) return f; }
		}
		return null;
	}
	function getPath(id) {
		const path = [];
		const search = (nodes) => {
			for (const n of nodes) {
				if (n.id === id) { path.push(n); return true; }
				if (n.children && search(n.children)) { path.unshift(n); return true; }
			}
			return false;
		};
		search(files);
		return path;
	}
	function nameExistsInArray(arr, name, excludeId = null) {
		return arr.some(n => n.name.toLowerCase() === name.toLowerCase() && n.id !== excludeId);
	}

	function wsNameExists(name, excludeId = null) {
		return workspaces.some(w => w.name.toLowerCase() === name.toLowerCase() && w.id !== excludeId);
	}
	function uniqueWsName(base) {
		let name = base, i = 2;
		while (wsNameExists(name)) name = `${base} (${i++})`;
		return name;
	}
	function countAllFiles(nodes) {
		let c = 0;
		for (const n of nodes) {
			if (n.type === "file") c++;
			else if (n.children) c += countAllFiles(n.children);
		}
		return c;
	}
	function flattenNodes(nodes, out = []) {
		for (const n of nodes) { out.push(n); if (n.children) flattenNodes(n.children, out); }
		return out;
	}

	// ============================================================
	// MODAL
	// ============================================================
	const modalOverlay = document.getElementById("modalOverlay");
	const modalTitle = document.getElementById("modalTitle");
	const modalInput = document.getElementById("modalInput");
	const modalMessage = document.getElementById("modalMessage");
	const modalInputHint = document.getElementById("modalInputHint");
	const modalConfirmBtns = document.getElementById("modalConfirmButtons");
	const modalConfirmBtn = document.getElementById("modalConfirmBtn");
	const modalCancelBtn = document.getElementById("modalCancelBtn");
	let modalCb = null;

	function showInputModal(title, def, cb) {
		modalTitle.textContent = title;
		modalInput.value = def || "";
		modalInput.classList.remove("hidden");
		modalMessage.classList.add("hidden");
		modalInputHint.classList.remove("hidden");
		modalInputHint.innerHTML = "Press <b>Enter</b> to confirm, <b>Esc</b> to cancel";
		modalConfirmBtns.classList.add("hidden");
		modalOverlay.classList.add("active");
		setTimeout(() => { modalInput.focus(); modalInput.select(); }, 30);
		modalCb = cb;
	}
	function showConfirmModal(title, msg, cb, danger = false) {
		modalTitle.textContent = title;
		modalMessage.textContent = msg;
		modalInput.classList.add("hidden");
		modalMessage.classList.remove("hidden");
		modalInputHint.classList.add("hidden");
		modalConfirmBtns.classList.remove("hidden");
		modalConfirmBtn.textContent = danger ? "Delete" : "Confirm";
		modalConfirmBtn.className = danger ? "modal-btn danger" : "modal-btn primary";
		modalOverlay.classList.add("active");
		modalCb = cb;
	}
	function showAlertModal(title, msg) {
		modalTitle.textContent = title;
		modalMessage.textContent = msg;
		modalInput.classList.add("hidden");
		modalMessage.classList.remove("hidden");
		modalConfirmBtns.classList.add("hidden");
		modalInputHint.classList.remove("hidden");
		modalInputHint.innerHTML = "Press <b>Esc</b> to close";
		modalOverlay.classList.add("active");
		modalCb = null;
	}
	function hideModal() { modalOverlay.classList.remove("active"); modalCb = null; }

	modalInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			const cb = modalCb;
			if (cb) cb(modalInput.value.trim());
			// If the callback opened a NEW modal (e.g. a duplicate-name alert),
			// modalCb will have changed — don't hide that new modal.
			if (modalCb === cb) hideModal();
		}
		if (e.key === "Escape") hideModal();
	});
	modalConfirmBtn.onclick = () => { if (modalCb) modalCb(true); hideModal(); };
	modalCancelBtn.onclick = () => hideModal();
	modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) hideModal(); });

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && modalOverlay.classList.contains("active")) {
			e.preventDefault();
			hideModal();
		}
	});
	// ============================================================
	// FILESYSTEM SYNC
	// ============================================================
	window.saveWorkspace = async function () {
		if (!supportsFS) { showAlertModal("Not supported", "Requires Chrome, Edge, or Brave."); return; }
		try {
			const handle = await window.showDirectoryPicker({ mode: "readwrite" });
			workspaceHandle = handle;
			await idbSet(`handle_${activeWsId}`, handle);
			updateWsMeta(activeWsId, { folderName: handle.name });

			const readFiles = await readDirectoryHandle(handle);
			if (readFiles.length > 0) {
				// Always load the chosen folder's content
				files = readFiles;
				saveWsFiles(activeWsId);
			} else {
				// Empty folder: push existing local files to it
				await saveNodes(handle, files);
			}

			updateFolderUI();
			render();
			if (!selectedId) { selectedId = findFirstFile(files)?.id || null; }
			await loadFile();
		} catch (err) {
			if (err.name !== "AbortError") showAlertModal("Error", err.message);
		}
	};

	window.resyncFromDisk = async function () {
		if (!workspaceHandle) {
			showAlertModal("No Folder Connected", "Connect a system folder to enable folder re-syncing.");
			return;
		}
		try {
			const perm = await workspaceHandle.requestPermission({ mode: "readwrite" });
			if (perm !== "granted") { showAlertModal("Permission denied", "Could not access the folder."); return; }
			files = await readDirectoryHandle(workspaceHandle);
			if (activeWsId) {
				saveWsFiles(activeWsId);
				updateWsMeta(activeWsId, { fileCount: countAllFiles(files) });
			}
			selectedId = null;
			render();
			await loadFile();
			wsStatusBadge.textContent = "Synced ✓";
			setTimeout(() => { wsStatusBadge.textContent = workspaceHandle.name; }, 1500);
		} catch (e) { showAlertModal("Sync error", e.message); }
	};

	async function readDirectoryHandle(dirHandle) {
		const SKIP = new Set(["node_modules", ".git", ".svn", "dist", "build", "__pycache__", ".next", ".cache"]);
		const TEXT_EXTS = new Set(["txt", "md", "js", "ts", "jsx", "tsx", "html", "css", "json", "yaml", "yml",
			"toml", "xml", "csv", "sh", "bash", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "php",
			"vue", "svelte", "env", "gitignore", "dockerfile", "sql", "graphql", "mdx", "ini", "cfg", "conf", "log"]);
		const result = [];

		async function readDir(handle, arr) {
			const entries = [];
			for await (const [name, entry] of handle.entries()) entries.push([name, entry]);
			entries.sort((a, b) => {
				if (a[1].kind !== b[1].kind) return a[1].kind === "directory" ? -1 : 1;
				return a[0].localeCompare(b[0]);
			});
			for (const [name, entry] of entries) {
				if (name.startsWith(".")) continue;
				if (entry.kind === "directory") {
					if (SKIP.has(name)) continue;
					const children = [];
					await readDir(entry, children);
					arr.push({ id: uid("folder"), name, type: "folder", isOpen: false, children });
				} else {
					const ext = name.split(".").pop()?.toLowerCase();
					if (!TEXT_EXTS.has(ext)) continue;
					try {
						const f = await entry.getFile();
						const content = await f.text();
						arr.push({ id: uid("file"), name, type: "file", content });
					} catch (e) { console.warn("Skip:", name, e); }
				}
			}
		}
		await readDir(dirHandle, result);
		return result;
	}

	async function writeFile(dirHandle, name, content) {
		const fh = await dirHandle.getFileHandle(name, { create: true });
		const w = await fh.createWritable();
		await w.write(content); await w.close();
	}

	async function saveNodes(dirHandle, nodes) {
		for (const n of nodes) {
			if (n.type === "file") await writeFile(dirHandle, n.name, n.content || "");
			else { const sub = await dirHandle.getDirectoryHandle(n.name, { create: true }); await saveNodes(sub, n.children || []); }
		}
	}

	async function syncWorkspace() {
		if (!workspaceHandle) return;
		try {
			// Clean disk directory to mirror deleted/removed items in UI state
			const activeNames = new Set(files.map(f => f.name));
			for await (const [name] of workspaceHandle.entries()) {
				if (!activeNames.has(name) && !name.startsWith(".")) {
					try {
						await workspaceHandle.removeEntry(name, { recursive: true });
					} catch (err) { console.warn("Could not remove entry:", name, err); }
				}
			}
			await saveNodes(workspaceHandle, files);
		} catch (e) { console.warn("Sync:", e); }
	}

	// ============================================================
	// FILE OPERATIONS
	// ============================================================
	function getTarget() {
		if (!selectedId) return { array: files, node: null };
		const n = findNode(files, selectedId);
		if (!n) return { array: files, node: null };
		if (n.type === "folder") return { array: n.children, node: n };
		const p = findParent(files, selectedId);
		return { array: p ? p.children : files, node: p };
	}

	window.addFile = function () {
		const t = getTarget();
		let name = "untitled.md", c = 1;
		while (nameExistsInArray(t.array, name)) name = `untitled-${c++}.md`;
		const nf = { id: uid("file"), name, type: "file", content: "" };
		t.array.push(nf);
		if (t.node) t.node.isOpen = true;
		selectedId = nf.id;
		persistCurrent();
		render();
		setTimeout(() => beginInlineRename(nf.id), 40);
		loadFile();
		syncWorkspace();
	};

	window.addFolder = function () {
		const t = getTarget();
		let name = "New Folder", c = 1;
		while (nameExistsInArray(t.array, name)) name = `New Folder ${c++}`;
		const nf = { id: uid("folder"), name, type: "folder", isOpen: true, children: [] };
		t.array.push(nf);
		if (t.node) t.node.isOpen = true;
		selectedId = nf.id;
		persistCurrent();
		render();
		setTimeout(() => beginInlineRename(nf.id), 40);
		syncWorkspace();
	};

	window.renameNode = function (id) {
		render();
		setTimeout(() => beginInlineRename(id), 30);
	};

	window.deleteNode = function (id) {
		const n = findNode(files, id);
		if (!n) return;
		showConfirmModal("Delete", `Delete "${n.name}"?`, (ok) => {
			if (!ok) return;
			const p = findParent(files, id);
			if (p) p.children = p.children.filter(c => c.id !== id);
			else files = files.filter(c => c.id !== id);
			if (selectedId === id) { selectedId = null; loadFile(); }
			persistCurrent(); render(); syncWorkspace();
		}, true);
	};

	window.moveNode = function (srcId, tgtId) {
		if (srcId === tgtId) return;
		const src = findNode(files, srcId);
		if (!src) return;
		if (src.type === "folder") {
			const hasD = (ns, id) => ns.some(n => n.id === id || (n.children && hasD(n.children, id)));
			if (hasD(src.children, tgtId)) return;
		}
		const op = findParent(files, srcId);
		if (op) op.children = op.children.filter(n => n.id !== srcId);
		else files = files.filter(n => n.id !== srcId);
		if (!tgtId) {
			files.push(src);
		} else {
			const tgt = findNode(files, tgtId);
			const arr = tgt.type === "folder" ? tgt.children : (findParent(files, tgtId)?.children || files);
			const tp = tgt.type === "folder" ? tgt : findParent(files, tgtId);
			arr.push(src);
			if (tp) tp.isOpen = true;
		}
		persistCurrent(); render(); syncWorkspace();
	};

	function persistCurrent() {
		if (!activeWsId) return;
		updateWsMeta(activeWsId, { fileCount: countAllFiles(files) });
		saveWsFiles(activeWsId);
		saveWsConfig(activeWsId);
	}

	// ============================================================
	// INLINE RENAME
	// ============================================================
	function beginInlineRename(id) {
		inlineRenameId = id;
		const el = fileTreeEl.querySelector(`[data-id="${id}"]`);
		const span = el?.querySelector(".item-name");
		if (!el || !span) return;
		const n = findNode(files, id);
		if (!n) return;

		const input = document.createElement("input");
		input.type = "text";
		input.value = n.name;
		input.className = "inline-rename-input";
		input.id = `inlineRename_${id}`;
		input.name = `inlineRename_${id}`;
		input.autocomplete = "off";
		span.replaceWith(input);
		input.focus();
		const dot = n.name.lastIndexOf(".");
		input.setSelectionRange(0, dot > 0 ? dot : n.name.length);

		const commit = () => {
			inlineRenameId = null;
			const newName = input.value.trim();
			if (!newName || newName === n.name) { render(); return; }
			const p = findParent(files, id);
			const arr = p ? p.children : files;
			if (nameExistsInArray(arr, newName, id)) {
				showAlertModal("Duplicate name", `"${newName}" already exists here.`);
				render(); return;
			}
			n.name = newName;
			persistCurrent(); syncWorkspace(); render();
		};

		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); input.blur(); }
			if (e.key === "Escape") { inlineRenameId = null; render(); }
		});
	}

	// ============================================================
	// EXPORT / IMPORT
	// ============================================================
	window.exportAll = async function () {
		const zip = new JSZip();
		addToZip(zip, files);
		const blob = await zip.generateAsync({ type: "blob" });
		downloadBlob(blob, `${sidebarWsName?.textContent || "export"}.zip`);
	};
	window.exportFolder = async function (id) {
		const n = findNode(files, id);
		if (!n || n.type !== "folder") return;
		const zip = new JSZip();
		addToZip(zip.folder(n.name), n.children);
		const blob = await zip.generateAsync({ type: "blob" });
		downloadBlob(blob, `${n.name}.zip`);
	};
	function addToZip(zipObj, nodes) {
		for (const n of nodes) {
			if (n.type === "file") zipObj.file(n.name, n.content || "");
			else addToZip(zipObj.folder(n.name), n.children || []);
		}
	}
	function downloadBlob(blob, name) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url; a.download = name; a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	window.handleImport = function (event) {
		const file = event.target.files[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = async (e) => {
			const zip = await JSZip.loadAsync(e.target.result);
			const folders = { "": files };
			const promises = [];
			zip.forEach((rel, entry) => {
				if (entry.dir) return;
				promises.push((async () => {
					const content = await entry.async("string");
					const parts = rel.split("/"), fname = parts.pop();
					if (!fname) return;
					let arr = files, cp = "";
					for (const dir of parts) {
						if (!dir) continue;
						const fp = cp ? `${cp}/${dir}` : dir;
						if (!folders[fp]) {
							const nf = { id: uid("folder"), name: dir, type: "folder", isOpen: true, children: [] };
							arr.push(nf); folders[fp] = nf.children;
						}
						arr = folders[fp]; cp = fp;
					}
					if (!nameExistsInArray(arr, fname))
						arr.push({ id: uid("file"), name: fname, type: "file", content });
				})());
			});
			await Promise.all(promises);
			persistCurrent(); render(); syncWorkspace();
			event.target.value = "";
			showAlertModal("Import complete", `Imported successfully.`);
		};
		reader.readAsArrayBuffer(file);
	};

	// ============================================================
	// CONTEXT MENU
	// ============================================================
	const contextMenu = document.getElementById("contextMenu");
	const ctxRename = document.getElementById("ctxRename");
	const ctxExport = document.getElementById("ctxExport");
	const ctxDelete = document.getElementById("ctxDelete");
	let ctxNodeId = null;

	window.addEventListener("click", () => contextMenu.classList.add("hidden"));
	ctxRename.onclick = () => { if (ctxNodeId) renameNode(ctxNodeId); contextMenu.classList.add("hidden"); };
	ctxExport.onclick = () => { if (ctxNodeId) exportFolder(ctxNodeId); contextMenu.classList.add("hidden"); };
	ctxDelete.onclick = () => { if (ctxNodeId) deleteNode(ctxNodeId); contextMenu.classList.add("hidden"); };

	// ============================================================
	// COLLAPSIBLE SECTIONS
	// ============================================================
	window.toggleSection = function (id) {
		const sec = document.getElementById(id);
		const chv = document.getElementById(id + "Chevron");
		if (!sec) return;
		const collapsed = sec.classList.toggle("collapsed");
		if (chv) chv.style.transform = collapsed ? "rotate(-90deg)" : "";
	};

	// ============================================================
	// THEME / FONT
	// ============================================================
	window.toggleWordWrap = function () {
		isWordWrap = !isWordWrap;
		applyWordWrapUI();
		if (activeWsId) saveWsConfig(activeWsId);
	};

	document.addEventListener("keydown", (e) => {
		if (e.altKey && e.key.toLowerCase() === "z") {
			e.preventDefault();
			toggleWordWrap();
		}
	});

	function applyWordWrapUI() {
		const appShellContainer = document.querySelector(".editor-container");
		const wrapBtn = document.getElementById("wrapToggle");
		if (appShellContainer) {
			appShellContainer.classList.toggle("word-wrap-active", isWordWrap);
		}
		if (wrapBtn) {
			wrapBtn.classList.toggle("active", isWordWrap);
		}
	}

	window.toggleTheme = function () {
		theme = theme === "light" ? "dark" : "light";
		applyConfig();
		if (activeWsId) saveWsConfig(activeWsId);
	};

	window.changeFontSize = function (delta) {
		const MIN_FONT_SIZE = 10;
		const MAX_FONT_SIZE = 30;

		fontSize = Math.max(
			MIN_FONT_SIZE,
			Math.min(MAX_FONT_SIZE, fontSize + delta)
		);

		// Save current scroll position
		const scrollTop = editorTextarea?.scrollTop || 0;
		const scrollLeft = editorTextarea?.scrollLeft || 0;

		applyConfig();
		updateLineNumbers();

		// Rebuild highlighting after browser recalculates font metrics
		requestAnimationFrame(() => {
			updateCodeHighlighting();

			requestAnimationFrame(() => {
				const preEl = document.getElementById("codeHighlightPre");

				if (editorTextarea && preEl) {
					preEl.scrollTop = scrollTop;
					preEl.scrollLeft = scrollLeft;
				}

				if (lineNumbersEl) {
					lineNumbersEl.scrollTop = scrollTop;
				}
			});
		});

		if (activeWsId) {
			saveWsConfig(activeWsId);
		}
	};
	window.toggleSearchBar = function () {
		const wrapper = document.getElementById("searchBarWrapper");
		const input = document.getElementById("searchInput");
		if (!wrapper) return;
		const isHidden = wrapper.classList.toggle("hidden");
		if (!isHidden && input) {
			input.focus();
		} else if (isHidden && input) {
			input.value = "";
			searchQuery = "";
			render();
		}
	};

	window.handleSearch = function () {
		searchQuery = document.getElementById("searchInput").value.toLowerCase();
		render();
	};

	// ============================================================
	// EDITOR TABS (VS Code Style)
	// ============================================================
	window.openTab = function (id) {
		if (!id) return;
		if (!openTabs.includes(id)) {
			openTabs.push(id);
		}
		selectedId = id;
		persistCurrent();
		renderTabs();
	};

	window.closeTab = async function (id, event) {
		if (event) event.stopPropagation();
		await autoSaveCurrentFile();

		const idx = openTabs.indexOf(id);
		if (idx !== -1) {
			openTabs.splice(idx, 1);
		}

		if (selectedId === id) {
			if (openTabs.length > 0) {
				const nextId = openTabs[Math.min(idx, openTabs.length - 1)];
				selectedId = nextId;
			} else {
				selectedId = null;
			}
			await loadFile();
		}

		persistCurrent();
		render();
	};

	window.selectTab = async function (id) {
		if (selectedId === id) return;
		await autoSaveCurrentFile();
		selectedId = id;
		document.querySelectorAll(".file-item.active").forEach(x => x.classList.remove("active"));
		const activeEl = fileTreeEl?.querySelector(`[data-id="${id}"]`);
		if (activeEl) activeEl.classList.add("active");
		persistCurrent();
		renderTabs();
		await loadFile();
	};

	function renderTabs() {
		if (!tabsListEl) return;
		tabsListEl.innerHTML = "";

		// Filter out deleted file IDs
		openTabs = openTabs.filter(id => !!findNode(files, id));

		// Auto-open selectedId tab if not present
		if (selectedId && findNode(files, selectedId)?.type === "file" && !openTabs.includes(selectedId)) {
			openTabs.push(selectedId);
		}

		openTabs.forEach(id => {
			const node = findNode(files, id);
			if (!node || node.type !== "file") return;

			const tab = document.createElement("div");
			const isActive = id === selectedId;
			tab.className = `tab-item${isActive ? " active" : ""}`;

			tab.innerHTML = `
				<i data-lucide="${getIcon(node)}" size="14" class="tab-icon"></i>
				<span class="tab-title">${escHtml(node.name)}</span>
				<span class="tab-close" title="Close (Middle Click / Cross)" onclick="closeTab('${id}', event)">
					<i data-lucide="x" size="12"></i>
				</span>
			`;

			tab.onclick = () => selectTab(id);
			tab.onauxclick = (e) => {
				if (e.button === 1) { // Middle click to close tab
					e.preventDefault();
					closeTab(id);
				}
			};

			tabsListEl.appendChild(tab);
		});

		if (window.lucide) lucide.createIcons();
	}

	// ============================================================
	// RENDER FILE TREE
	// ============================================================
	function render() {
		fileTreeEl.innerHTML = "";
		if (files.length === 0) {
			const em = document.createElement("div");
			em.className = "empty-state";
			em.innerHTML = `<i data-lucide="file-plus" size="24"></i><p>No files yet</p><small>Click File to create one</small>`;
			fileTreeEl.appendChild(em);
		} else {
			renderTree(files, fileTreeEl, 0);
		}
		renderTabs();
		updateBreadcrumbs();
		if (window.lucide) lucide.createIcons();
	}

	function renderTree(nodes, container, depth) {
		for (const node of nodes) {
			let show = true, hasChild = false;
			if (searchQuery) {
				if (node.type === "file")
					show = node.name.toLowerCase().includes(searchQuery) || (node.content?.toLowerCase().includes(searchQuery));
				else {
					hasChild = checkMatchingChild(node, searchQuery);
					show = hasChild;
				}
			}
			if (!show) continue;

			const el = document.createElement("div");
			el.className = "file-item" + (node.id === selectedId ? " active" : "");
			el.setAttribute("data-id", node.id);
			el.draggable = true;
			el.style.paddingLeft = (10 + depth * 14) + "px";

			// Drag
			el.ondragstart = (e) => { draggedId = node.id; el.classList.add("dragging"); e.dataTransfer.setData("text/plain", node.id); e.stopPropagation(); };
			el.ondragend = () => { el.classList.remove("dragging"); draggedId = null; };
			el.ondragover = (e) => { e.preventDefault(); if (draggedId !== node.id) el.classList.add("drag-over"); };
			el.ondragleave = () => el.classList.remove("drag-over");
			el.ondrop = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove("drag-over"); if (draggedId) moveNode(draggedId, node.id); };

			// Icon
			const icon = document.createElement("span");
			icon.className = "icon";
			icon.innerHTML = `<i data-lucide="${getIcon(node)}" size="15"></i>`;
			el.appendChild(icon);

			// Name
			const nameSpan = document.createElement("span");
			nameSpan.className = "item-name";
			nameSpan.textContent = node.name;
			el.appendChild(nameSpan);

			// Actions
			const acts = document.createElement("div");
			acts.className = "actions";
			acts.innerHTML = `
				<span class="action-btn" title="Rename" onclick="event.stopPropagation(); renameNode('${node.id}')"><i data-lucide="pencil" size="13"></i></span>
				<span class="action-btn action-btn-danger" title="Delete" onclick="event.stopPropagation(); deleteNode('${node.id}')"><i data-lucide="trash-2" size="13"></i></span>
			`;
			el.appendChild(acts);

			// Click
			el.onclick = (e) => {
				if (e.target.closest(".action-btn")) return;
				if (node.type === "folder") {
					node.isOpen = !node.isOpen;
					selectedId = node.id;
					document.querySelectorAll(".file-item.active").forEach(x => x.classList.remove("active"));
					el.classList.add("active");
					persistCurrent();
					// In-place DOM toggle without full tree re-render
					const iconEl = el.querySelector(".icon i");
					if (iconEl && window.lucide) {
						iconEl.setAttribute("data-lucide", node.isOpen ? "folder-open" : "folder");
						lucide.createIcons();
					}
					const childSubTree = el.nextElementSibling;
					if (childSubTree && childSubTree.classList.contains("folder-children")) {
						childSubTree.style.display = node.isOpen ? "block" : "none";
					} else {
						render();
					}
					updateBreadcrumbs();
				} else {
					openTab(node.id);
					document.querySelectorAll(".file-item.active").forEach(x => x.classList.remove("active"));
					el.classList.add("active");
					persistCurrent();
					loadFile();
					updateBreadcrumbs();
				}
			};

			// Right-click
			el.oncontextmenu = (e) => {
				e.preventDefault();
				ctxNodeId = node.id;
				ctxExport.style.display = node.type === "folder" ? "flex" : "none";
				let top = e.pageY, left = e.pageX;
				if (top + 110 > window.innerHeight) top = window.innerHeight - 110;
				if (left + 170 > window.innerWidth) left = window.innerWidth - 170;
				contextMenu.style.top = top + "px";
				contextMenu.style.left = left + "px";
				contextMenu.classList.remove("hidden");
			};

			container.appendChild(el);

			if (node.children) {
				const childrenGroup = document.createElement("div");
				childrenGroup.className = "folder-children";
				if (!node.isOpen && (!searchQuery || !hasChild)) {
					childrenGroup.style.display = "none";
				}
				renderTree(node.children, childrenGroup, depth + 1);
				container.appendChild(childrenGroup);
			}
		}
	}

	function getIcon(node) {
		if (node.type === "folder") return node.isOpen ? "folder-open" : "folder";
		const ext = node.name.split(".").pop()?.toLowerCase();
		const m = {
			md: "file-text", txt: "file-text", js: "file-code", ts: "file-code", jsx: "file-code",
			tsx: "file-code", html: "file-code", css: "file-code", json: "braces", yaml: "file-code",
			yml: "file-code", toml: "file-code", py: "file-code", go: "file-code", sh: "terminal",
			bash: "terminal", sql: "database"
		};
		return m[ext] || "file";
	}

	function checkMatchingChild(folder, q) {
		if (!folder.children) return false;
		return folder.children.some(c =>
			c.type === "file"
				? c.name.toLowerCase().includes(q) || (c.content?.toLowerCase().includes(q))
				: checkMatchingChild(c, q)
		);
	}

	function updateBreadcrumbs() {
		breadcrumbEl.innerHTML = "";
		const path = getPath(selectedId);
		path.forEach(n => {
			const span = document.createElement("span");
			span.className = "breadcrumb-item";
			span.textContent = n.name;
			span.onclick = () => { selectedId = n.id; if (n.type === "file") loadFile(); render(); };
			breadcrumbEl.appendChild(span);
		});
	}

	// ============================================================
	// EDITOR.JS MARKDOWN BRIDGE
	// ============================================================
	function textToBlocks(text) {
		if (!text?.trim()) return [{ type: "paragraph", data: { text: "" } }];
		const lines = text.split("\n");
		const blocks = [];
		let inCode = false, codeBuf = [], tableBuf = [];

		const flushCode = () => { if (codeBuf.length) { blocks.push({ type: "code", data: { code: codeBuf.join("\n") } }); codeBuf = []; } };
		const flushTable = () => {
			if (!tableBuf.length) return;
			const content = tableBuf.map(r => r.split("|").slice(1, -1).map(c => c.trim())).filter(r => r.length && !r.every(c => /^:?-+:?$/.test(c)));
			if (content.length) blocks.push({ type: "table", data: { content, withHeadings: true } });
			tableBuf = [];
		};

		for (const line of lines) {
			if (line.trim().startsWith("```")) { inCode ? (inCode = false, flushCode()) : (flushTable(), inCode = true); continue; }
			if (inCode) { codeBuf.push(line); continue; }
			if (line.trim().startsWith("|") && line.trim().endsWith("|")) { tableBuf.push(line.trim()); continue; }
			flushTable();
			const t = line.trim();
			if (!t) { blocks.push({ type: "paragraph", data: { text: "" } }); continue; }
			if (t.startsWith("#### ")) blocks.push({ type: "header", data: { text: md2h(t.slice(5)), level: 4 } });
			else if (t.startsWith("### ")) blocks.push({ type: "header", data: { text: md2h(t.slice(4)), level: 3 } });
			else if (t.startsWith("## ")) blocks.push({ type: "header", data: { text: md2h(t.slice(3)), level: 2 } });
			else if (t.startsWith("# ")) blocks.push({ type: "header", data: { text: md2h(t.slice(2)), level: 1 } });
			else if (t.startsWith("> ")) blocks.push({ type: "quote", data: { text: md2h(t.slice(2)), caption: "" } });
			else if (/^- \[[ xX]\] /.test(t)) {
				const checked = t[3].toLowerCase() === "x", text = md2h(t.slice(6)), last = blocks[blocks.length - 1];
				if (last?.type === "checklist") last.data.items.push({ text, checked });
				else blocks.push({ type: "checklist", data: { items: [{ text, checked }] } });
			}
			else if (t.startsWith("- ") || t.startsWith("* ")) {
				const text = md2h(t.slice(2)), last = blocks[blocks.length - 1];
				if (last?.type === "list") last.data.items.push({ content: text, items: [] });
				else blocks.push({ type: "list", data: { style: "unordered", items: [{ content: text, items: [] }] } });
			}
			else if (/^\d+\. /.test(t)) {
				const text = md2h(t.replace(/^\d+\. /, "")), last = blocks[blocks.length - 1];
				if (last?.type === "list") last.data.items.push({ content: text, items: [] });
				else blocks.push({ type: "list", data: { style: "ordered", items: [{ content: text, items: [] }] } });
			}
			else blocks.push({ type: "paragraph", data: { text: md2h(line) } });
		}
		flushCode(); flushTable();
		return blocks.length ? blocks : [{ type: "paragraph", data: { text: "" } }];
	}

	function md2h(s) {
		if (!s) return "";
		// Convert Markdown image links [![alt](img)](url) -> <a href="url"><img src="img" alt="alt"/></a>
		let res = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%; border-radius:6px; margin:4px 0;" />');
		// Convert Markdown links [text](url) -> <a href="url" target="_blank" rel="noopener">text</a>
		res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
		// Convert bold, italic, code
		res = res.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>").replace(/__(.*?)__/g, "<b>$1</b>")
			.replace(/\*(.*?)\*/g, "<i>$1</i>").replace(/_(.*?)_/g, "<i>$1</i>")
			.replace(/`(.*?)`/g, "<code>$1</code>");
		return res;
	}

	function h2md(s) {
		if (!s) return "";
		return s
			.replace(/<img[^>]*src="(.*?)"[^>]*alt="(.*?)"[^>]*>/gi, "![$2]($1)")
			.replace(/<img[^>]*src="(.*?)"[^>]*>/gi, "![]($1)")
			.replace(/<a [^>]*href="(.*?)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
			.replace(/<b>(.*?)<\/b>/gi, "**$1**").replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
			.replace(/<i>(.*?)<\/i>/gi, "*$1*").replace(/<em>(.*?)<\/em>/gi, "*$1*")
			.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
			.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
			.replace(/<[^>]+>/g, "");
	}
	function blocksToText(data) {
		if (!data?.blocks) return "";
		const lines = [];
		for (const b of data.blocks) {
			switch (b.type) {
				case "header": lines.push("#".repeat(b.data.level || 1) + " " + h2md(b.data.text)); break;
				case "paragraph": lines.push(h2md(b.data.text)); break;
				case "list":
					(function extractItems(items, depth = 0, style = b.data.style || "unordered") {
						(items || []).forEach((it, i) => {
							const text = typeof it === "string" ? it : (it.content || it.text || "");
							const indent = "  ".repeat(depth);
							const prefix = style === "ordered" ? `${i + 1}. ` : "- ";
							lines.push(indent + prefix + h2md(text));
							if (it.items && it.items.length) {
								extractItems(it.items, depth + 1, style);
							}
						});
					})(b.data.items);
					break;
				case "checklist": (b.data.items || []).forEach(it => lines.push(`- [${it.checked ? "x" : " "}] ${h2md(it.text)}`)); break;
				case "quote": lines.push(`> ${h2md(b.data.text)}`); break;
				case "code": lines.push("```", b.data.code || "", "```"); break;
				case "table": if (b.data.content?.length) { b.data.content.forEach((r, i) => { lines.push(`| ${r.map(c => h2md(c)).join(" | ")} |`); if (i === 0) lines.push(`| ${r.map(() => "---").join(" | ")} |`); }); } break;
				default: if (b.data?.text) { lines.push(h2md(b.data.text)); } break;
			}
		}
		return lines.join("\n").trim();
	}

	// ============================================================
	// EDITOR.JS
	// ============================================================
	window.switchEditorMode = async function (mode) {
		if (editorMode === mode) return;
		await autoSaveCurrentFile();
		editorMode = mode;
		updateEditorModeUI();
		if (activeWsId) saveWsConfig(activeWsId);
		await loadFile();
	};

	async function initOrUpdateEditorJs(content) {
		const blocks = textToBlocks(content);
		if (editorInstance) {
			try { await editorInstance.isReady; await editorInstance.render({ blocks }); return; }
			catch (e) { try { editorInstance.destroy(); } catch (_) { } editorInstance = null; }
		}
		createEditorJsInstance(blocks);
	}

	function createEditorJsInstance(blocks) {
		if (typeof EditorJS === "undefined") return;
		editorjsWrapper.innerHTML = "";
		const holder = document.createElement("div");
		holder.id = "editorjs-holder";
		editorjsWrapper.appendChild(holder);

		const tools = {};
		tools.paragraph = { config: { preserveBlank: true }, inlineToolbar: true }; // ← NEW
		if (typeof Header !== "undefined") tools.header = { class: Header };
		const ListTool = typeof NestedList !== "undefined" ? NestedList : (typeof List !== "undefined" ? List : null);
		if (ListTool) tools.list = { class: ListTool, inlineToolbar: true };
		if (typeof Checklist !== "undefined") tools.checklist = { class: Checklist, inlineToolbar: true };
		if (typeof Quote !== "undefined") tools.quote = { class: Quote, inlineToolbar: true };
		if (typeof CodeTool !== "undefined") tools.code = { class: CodeTool };
		if (typeof InlineCode !== "undefined") tools.inlineCode = { class: InlineCode };
		if (typeof Table !== "undefined") tools.table = { class: Table, inlineToolbar: true, config: { rows: 2, cols: 2 } };

		editorInstance = new EditorJS({
			holder: "editorjs-holder",
			autofocus: false,
			placeholder: "Start writing… or press / for blocks",
			data: { blocks },
			tools,
			onChange: async () => {
				if (isInitEditor) return;
				clearTimeout(editorSaveTimer);
				editorSaveTimer = setTimeout(async () => {
					const f = findNode(files, selectedId);
					if (f?.type === "file" && editorInstance) {
						try {
							const d = await editorInstance.save();
							f.content = blocksToText(d);
							editorTextarea.value = f.content;
							persistCurrent();
							syncWorkspace();
						} catch (_) { }
					}
				}, 400);
			}
		});
	}

	async function loadFile() {
		let file = findNode(files, selectedId);
		if (!file) {
			const fb = findFirstFile(files);
			if (fb) { selectedId = fb.id; file = fb; }
		}

		isInitEditor = true;

		if (file?.type === "file") {
			const text = file.content || "";
			editorTextarea.value = text;
			editorTextarea.disabled = false;
			editorTextarea.placeholder = "Start typing...";

			const codeEl = document.getElementById("codeHighlightContent");
			if (codeEl) codeEl.innerHTML = ""; // prevent stale highlight flash
			const ext = file.name.split(".").pop()?.toLowerCase();
			const isMarkdown = ext === "md" || ext === "markdown" || ext === "txt" || !ext;

			if (!isMarkdown) {
				// Code files (.html, .json, .js, .css, .py, etc.) must open in Raw mode to protect code structure
				editorMode = "plain";
				updateEditorModeUI();
				if (modeBlockBtn) modeBlockBtn.disabled = true;
			} else {
				if (modeBlockBtn) modeBlockBtn.disabled = false;
			}

			if (editorMode === "block" && isMarkdown) {
				editorjsWrapper.classList.remove("hidden");
				plainWrapper.classList.add("hidden");
				await initOrUpdateEditorJs(text);
			} else {
				plainWrapper.classList.remove("hidden");
				editorjsWrapper.classList.add("hidden");
			}
		} else {
			const hasF = !!findFirstFile(files);
			editorTextarea.value = "";
			editorTextarea.disabled = hasF;
			editorTextarea.placeholder = hasF ? "Select a file to edit" : "Create a file to start writing…";
			if (editorMode === "block") await initOrUpdateEditorJs("");
		}

		isInitEditor = false;
		updateLineNumbers();
		updateBreadcrumbs();
		updateCodeHighlighting();
	}

	// function updateCodeHighlighting() {
	// 	const codeEl = document.getElementById("codeHighlightContent");
	// 	const preEl = document.getElementById("codeHighlightPre");

	// 	if (!codeEl || !editorTextarea || !preEl) return;

	// 	const file = findNode(files, selectedId);
	// 	const ext = file?.name
	// 		? file.name.split(".").pop().toLowerCase()
	// 		: "";

	// 	const langMap = {
	// 		js: "javascript",
	// 		jsx: "jsx",
	// 		ts: "typescript",
	// 		tsx: "tsx",
	// 		html: "html",
	// 		css: "css",
	// 		json: "json",
	// 		py: "python",
	// 		sh: "bash",
	// 		bash: "bash",
	// 		go: "go",
	// 		rs: "rust",
	// 		java: "java",
	// 		c: "c",
	// 		cpp: "cpp",
	// 		h: "c",
	// 		sql: "sql",
	// 		yaml: "yaml",
	// 		yml: "yaml",
	// 		xml: "markup",
	// 		md: "markdown",
	// 		markdown: "markdown"
	// 	};

	// 	const lang = langMap[ext] || "clike";

	// 	codeEl.className = `language-${lang}`;

	// 	let val = editorTextarea.value || "";

	// 	if (val.endsWith("\n")) {
	// 		val += " ";
	// 	}

	// 	codeEl.textContent = val;

	// 	// Keep both rendering layers identical
	// 	const computed = getComputedStyle(editorTextarea);

	// 	preEl.style.fontFamily = computed.fontFamily;
	// 	preEl.style.fontSize = computed.fontSize;
	// 	preEl.style.lineHeight = computed.lineHeight;
	// 	preEl.style.letterSpacing = computed.letterSpacing;

	// 	codeEl.style.fontFamily = computed.fontFamily;
	// 	codeEl.style.fontSize = computed.fontSize;
	// 	codeEl.style.lineHeight = computed.lineHeight;
	// 	codeEl.style.letterSpacing = computed.letterSpacing;


	// 	if (lineNumbersEl) {
	// 		lineNumbersEl.style.lineHeight = computed.lineHeight;
	// 	}

	// 	if (typeof Prism !== "undefined") {
	// 		try {
	// 			Prism.highlightElement(codeEl);
	// 		} catch (_) { }
	// 	}
	// }

	// Sync overlay scroll
	function updateCodeHighlighting() {
		const codeEl = document.getElementById("codeHighlightContent");
		const preEl = document.getElementById("codeHighlightPre");

		if (!codeEl || !editorTextarea || !preEl) return;

		// Hard reset first — prevents any stale Prism markup from a
		// previous file lingering behind the placeholder text.
		codeEl.innerHTML = "";

		if (!editorTextarea.value) {
			// Nothing typed — let the native placeholder show alone,
			// don't render anything in the highlight layer.
			return;
		}

		const file = findNode(files, selectedId);
		const ext = file?.name
			? file.name.split(".").pop().toLowerCase()
			: "";

		const langMap = {
			js: "javascript",
			jsx: "jsx",
			ts: "typescript",
			tsx: "tsx",
			html: "html",
			css: "css",
			json: "json",
			py: "python",
			sh: "bash",
			bash: "bash",
			go: "go",
			rs: "rust",
			java: "java",
			c: "c",
			cpp: "cpp",
			h: "c",
			sql: "sql",
			yaml: "yaml",
			yml: "yaml",
			xml: "markup",
			md: "markdown",
			markdown: "markdown"
		};

		const lang = langMap[ext] || "clike";
		codeEl.className = `language-${lang}`;

		let val = editorTextarea.value;
		if (val.endsWith("\n")) val += " ";
		codeEl.textContent = val;

		const computed = getComputedStyle(editorTextarea);
		preEl.style.fontFamily = computed.fontFamily;
		preEl.style.fontSize = computed.fontSize;
		preEl.style.lineHeight = computed.lineHeight;
		preEl.style.letterSpacing = computed.letterSpacing;

		codeEl.style.fontFamily = computed.fontFamily;
		codeEl.style.fontSize = computed.fontSize;
		codeEl.style.lineHeight = computed.lineHeight;
		codeEl.style.letterSpacing = computed.letterSpacing;

		if (lineNumbersEl) {
			lineNumbersEl.style.lineHeight = computed.lineHeight;
		}

		if (typeof Prism !== "undefined") {
			try {
				Prism.highlightElement(codeEl);
			} catch (_) { }
		}
	}
	editorTextarea.addEventListener("scroll", () => {
		const preEl = document.getElementById("codeHighlightPre");
		if (preEl) {
			preEl.scrollTop = editorTextarea.scrollTop;
			preEl.scrollLeft = editorTextarea.scrollLeft;
		}
		if (lineNumbersEl) lineNumbersEl.scrollTop = editorTextarea.scrollTop;
	});

	// ============================================================
	// PLAIN TEXT HELPERS
	// ============================================================
	function updateLineNumbers() {
		if (!lineNumbersEl) return;
		const count = editorTextarea.value.split("\n").length;
		const nums = [];
		for (let i = 1; i <= count; i++) nums.push(i);
		lineNumbersEl.textContent = nums.join("\n");
	}
	function updateCursor() {
		const before = editorTextarea.value.substring(0, editorTextarea.selectionStart);
		const lines = before.split("\n");
		cursorPosSpan.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
	}

	editorTextarea.addEventListener("input", async () => {
		const f = findNode(files, selectedId);
		if (f?.type === "file") { f.content = editorTextarea.value; persistCurrent(); syncWorkspace(); }
		updateLineNumbers();
		updateCodeHighlighting();
	});
	editorTextarea.addEventListener("keydown", (e) => {
		if (e.key === "Tab") {
			e.preventDefault();
			const s = editorTextarea.selectionStart, end = editorTextarea.selectionEnd;
			editorTextarea.value = editorTextarea.value.substring(0, s) + "    " + editorTextarea.value.substring(end);
			editorTextarea.selectionStart = editorTextarea.selectionEnd = s + 4;
			editorTextarea.dispatchEvent(new Event("input"));
		}
	});
	editorTextarea.addEventListener("keyup", updateCursor);
	editorTextarea.addEventListener("click", updateCursor);
	editorTextarea.addEventListener("focus", updateCursor);
	editorTextarea.addEventListener("scroll", () => { if (lineNumbersEl) lineNumbersEl.scrollTop = editorTextarea.scrollTop; });

	// Ctrl+Wheel → editor font size only
	document.querySelector(".main")?.addEventListener("wheel", (e) => {
		if (e.ctrlKey) { e.preventDefault(); changeFontSize(e.deltaY < 0 ? 1 : -1); }
	}, { passive: false });

	// ============================================================
	// KEYBOARD SHORTCUTS
	// ============================================================
	document.addEventListener("keydown", async (e) => {
		if (e.ctrlKey && e.key === "s") {
			e.preventDefault();
			if (!activeWsId) return;
			if (workspaceHandle) {
				await autoSaveCurrentFile();
				persistCurrent();
				await syncWorkspace();
				const prev = wsStatusBadge.textContent;
				wsStatusBadge.textContent = "Saved ✓";
				setTimeout(() => { wsStatusBadge.textContent = workspaceHandle.name; }, 1500);
			} else {
				saveWorkspace();
			}
		}
		if (e.ctrlKey && e.key === "n" && activeWsId) {
			e.preventDefault(); addFile();
		}
	});

	document.addEventListener("keydown", (e) => {
		if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l") {
			e.preventDefault();
			toggleTheme();
		}
	});

	// ============================================================
	// SIDEBAR RESIZE
	// ============================================================
	const resizeHandle = document.getElementById("resizeHandle");
	const sidebar = document.querySelector(".sidebar");
	let isResizing = false, startX = 0, startWidth = 0;

	resizeHandle?.addEventListener("mousedown", (e) => {
		isResizing = true; startX = e.clientX; startWidth = sidebar.offsetWidth;
		resizeHandle.classList.add("active"); sidebar.classList.add("resizing");
		document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
		e.preventDefault();
	});
	document.addEventListener("mousemove", (e) => {
		if (!isResizing) return;
		sidebar.style.width = Math.max(180, Math.min(600, startWidth + (e.clientX - startX))) + "px";
	});
	document.addEventListener("mouseup", () => {
		if (!isResizing) return;
		isResizing = false;
		resizeHandle?.classList.remove("active"); sidebar?.classList.remove("resizing");
		document.body.style.cursor = "auto"; document.body.style.userSelect = "auto";
		if (activeWsId) saveWsConfig(activeWsId);
	});

	// ============================================================
	// FILE TREE DRAG DROP
	// ============================================================
	fileTreeEl.addEventListener("click", (e) => {
		if (e.target === fileTreeEl) { selectedId = null; render(); persistCurrent(); loadFile(); }
	});
	fileTreeEl.ondragover = (e) => e.preventDefault();
	fileTreeEl.ondrop = () => { if (draggedId) moveNode(draggedId, null); };

	// ============================================================
	// INIT
	// ============================================================
	loadWorkspaceMeta();

	// Migrate old data from previous single-workspace version
	const oldFiles = localStorage.getItem("keeplocal_files");
	const oldCfg = localStorage.getItem("keeplocal_config");
	if (oldFiles && workspaces.length === 0) {
		const wsId = uid("ws");
		const migFiles = JSON.parse(oldFiles);
		const migCfg = oldCfg ? JSON.parse(oldCfg) : {};
		workspaces.push({
			id: wsId, name: "My Notes", createdAt: Date.now(),
			lastOpenedAt: Date.now(), folderName: null, fileCount: countAllFiles(migFiles)
		});
		localStorage.setItem(`keeplocal_files_${wsId}`, oldFiles);
		if (oldCfg) localStorage.setItem(`keeplocal_cfg_${wsId}`, oldCfg);
		localStorage.removeItem("keeplocal_files");
		localStorage.removeItem("keeplocal_config");
		saveWorkspaceMeta();
	}

	// Apply last saved theme
	const globalTheme = localStorage.getItem("keeplocal_global_theme") || "dark";
	theme = globalTheme;
	document.body.setAttribute("data-theme", theme);

	// Check for last active workspace or show welcome screen
	const lastActiveWsId = localStorage.getItem("keeplocal_active_ws_id");
	const targetWs = workspaces.find(w => w.id === lastActiveWsId);

	if (targetWs) {
		await openWorkspace(targetWs.id);
	} else if (workspaces.length > 0) {
		const sorted = [...workspaces].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
		await openWorkspace(sorted[0].id);
	} else {
		showWelcome();
	}
});
