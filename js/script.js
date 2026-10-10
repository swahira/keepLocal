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
	let fsPermissionGranted = false; // true if workspaceHandle has granted readwrite permission
	let editorMode = (typeof localStorage !== "undefined" && localStorage.getItem("keeplocal_editor_mode")) || "block";
	let editorInstance = null;
	let isInitEditor = false;
	let editorLoadedFileId = null;
	let isAddingFile = false;
	let isOpenTabInProgress = false;
	let editorSaveTimer = null;
	let draggedId = null;
	let inlineRenameId = null;
	let pendingDeletions = []; // [{ pathParts: string[], name: string }]

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
	const wsStatusBadge = document.getElementById("wsStatusBadge");
	const saveWorkspaceBtn = document.getElementById("saveWorkspaceBtn");
	const browserSupportMsg = document.getElementById("browserSupportMessage");
	const fileTreeEl = document.getElementById("fileTree");
	const breadcrumbEl = document.getElementById("breadcrumb");
	const cursorPosSpan = document.getElementById("cursorPos");
	const editorStatusSpan = document.getElementById("editorStatus");
	const editorjsWrapper = document.getElementById("editorjs");
	const plainWrapper = document.getElementById("plainEditorWrapper");
	const editorEmptyState = document.getElementById("editorEmptyState");
	const lineNumbersEl = document.getElementById("lineNumbers");
	const editorTextarea = document.getElementById("editor");
	const modeSwitchGroup = document.getElementById("modeSwitchGroup");
	const modeBlockBtn = document.getElementById("modeBlockBtn");
	const modePlainBtn = document.getElementById("modePlainBtn");
	const textControlsGroup = document.getElementById("textControlsGroup");
	const editorLoadingOverlay = document.getElementById("editorLoadingOverlay");
	const editorLoadingText = document.getElementById("editorLoadingText");

	function showEditorLoading(message = "Loading note…") {
		if (!editorLoadingOverlay) return;
		if (editorLoadingText) editorLoadingText.textContent = message;
		editorLoadingOverlay.classList.remove("hidden");
	}

	function hideEditorLoading() {
		if (!editorLoadingOverlay) return;
		editorLoadingOverlay.classList.add("hidden");
	}

	function isMarkdownFile(filename) {
		if (!filename) return false;
		const ext = filename.split(".").pop()?.toLowerCase();
		return ext === "md" || ext === "markdown";
	}

	function isImageFile(filename) {
		if (!filename) return false;
		const ext = filename.split(".").pop()?.toLowerCase();
		return ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "avif"].includes(ext);
	}

	function getImageMimeType(filename) {
		if (!filename) return "image/png";
		const ext = filename.split(".").pop()?.toLowerCase();
		const map = {
			webp: "image/webp",
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			svg: "image/svg+xml",
			bmp: "image/bmp",
			ico: "image/x-icon",
			avif: "image/avif"
		};
		return map[ext] || "image/png";
	}

	// ============================================================
	// FEATURE DETECTION
	// ============================================================
	if (window.location.hostname === "0.0.0.0") {
		const redirectUrl = `${window.location.protocol}//localhost:${window.location.port || 8000}${window.location.pathname}${window.location.search}${window.location.hash}`;
		window.location.replace(redirectUrl);
	}

	const isSecure = window.isSecureContext;
	const supportsFS = "showDirectoryPicker" in window;

	// ============================================================
	// INDEXEDDB DELEGATION (KeepLocalDB)
	// ============================================================
	const idbSet = (key, val) => KeepLocalDB.set(KeepLocalDB.STORES.HANDLES, key, val);
	const idbGet = (key) => KeepLocalDB.get(KeepLocalDB.STORES.HANDLES, key);
	const idbDel = (key) => KeepLocalDB.del(KeepLocalDB.STORES.HANDLES, key);

	// ============================================================
	// UNIQUE ID
	// ============================================================
	function uid(type) {
		importIdCounter++;
		return (type === "folder" ? "d_" : type === "ws" ? "ws_" : "f_")
			+ Date.now() + "_" + importIdCounter + "_" + Math.random().toString(36).slice(2, 6);
	}

	// ============================================================
	// WORKSPACE PERSISTENCE & STORAGE QUOTA MONITORING
	// ============================================================
	let lastQuotaWarningTime = 0;
	const QUOTA_WARNING_COOLDOWN_MS = 60000;

	function isQuotaExceededError(err) {
		return (
			err instanceof DOMException &&
			(err.code === 22 ||
				err.code === 1014 ||
				err.name === "QuotaExceededError" ||
				err.name === "NS_ERROR_DOM_QUOTA_REACHED")
		);
	}

	function handleStorageError(err, context = "") {
		console.warn(`Storage error in ${context}:`, err);
		if (isQuotaExceededError(err)) {
			updateStorageQuotaUI(true /* isFull */);
			notifyStorageQuotaExceeded();
		}
	}

	async function checkStorageQuota() {
		if (workspaceHandle && fsPermissionGranted) {
			updateStorageQuotaUI(false, 0);
			return;
		}
		try {
			const est = await KeepLocalDB.getStorageEstimate();
			if (est && est.isSupported && est.quota > 0) {
				const pct = est.percentage;
				if (pct >= 80) {
					updateStorageQuotaUI(pct >= 95, pct);
				} else {
					updateStorageQuotaUI(false, pct);
				}
			} else {
				updateStorageQuotaUI(false, 0);
			}
		} catch (_) {
			updateStorageQuotaUI(false, 0);
		}
	}

	function updateStorageQuotaUI(isFull, pct = 0) {
		const banner = document.getElementById("storageQuotaBanner");
		const text = document.getElementById("storageQuotaText");
		if (!banner) return;

		if (workspaceHandle && fsPermissionGranted) {
			banner.classList.add("hidden");
			return;
		}

		const quotaBtn = banner.querySelector(".storage-quota-btn");
		const isUnauthorizedFolder = workspaceHandle && !fsPermissionGranted;

		if (quotaBtn) {
			if (isUnauthorizedFolder) {
				quotaBtn.textContent = "Authorize";
				quotaBtn.onclick = () => requestReauthorization();
			} else {
				quotaBtn.textContent = "Connect";
				quotaBtn.onclick = () => saveWorkspace();
			}
		}

		if (isFull) {
			banner.className = "storage-quota-banner danger";
			if (text) {
				text.textContent = isUnauthorizedFolder
					? "Storage full! Re-authorize folder"
					: "Storage full! Connect folder";
			}
			banner.classList.remove("hidden");
			if (window.lucide) window.lucide.createIcons();
		} else if (pct >= 80) {
			banner.className = "storage-quota-banner warning";
			if (text) text.textContent = `Storage ~${pct}% full`;
			banner.classList.remove("hidden");
			if (window.lucide) window.lucide.createIcons();
		} else {
			banner.classList.add("hidden");
		}
	}

	function notifyStorageQuotaExceeded() {
		if (workspaceHandle && fsPermissionGranted) return; // files are safely on physical disk
		const now = Date.now();
		if (now - lastQuotaWarningTime < QUOTA_WARNING_COOLDOWN_MS) return;
		lastQuotaWarningTime = now;

		if (supportsFS) {
			const isUnauthorizedFolder = workspaceHandle && !fsPermissionGranted;
			showChoiceModal({
				title: "Browser Storage Limit Reached",
				message: isUnauthorizedFolder
					? `Your browser's storage limit has been reached, and folder "${workspaceHandle.name}" is not authorized. Grant folder access to save unlimited notes directly to your hard drive.`
					: "Your browser's storage quota has been reached. New changes cannot be saved locally. Connect a computer folder to save unlimited notes directly to your hard drive, or export your notes.",
				choices: [
					{
						label: isUnauthorizedFolder ? "Re-authorize Folder (Recommended)" : "Connect Folder (Recommended)",
						description: isUnauthorizedFolder
							? `Grant disk write permission to "${workspaceHandle.name}".`
							: "Save unlimited files directly to your computer's hard drive.",
						action: isUnauthorizedFolder ? "reauth" : "connect",
						primary: true
					},
					{
						label: "Export ZIP Backup",
						description: "Download a ZIP archive containing all your workspace notes.",
						action: "export"
					},
					{
						label: "Dismiss",
						description: "Continue editing (unsaved changes will not persist across browser reloads).",
						action: "dismiss"
					}
				],
				onSelect: (action) => {
					if (action === "reauth") {
						requestReauthorization();
					} else if (action === "connect") {
						saveWorkspace();
					} else if (action === "export") {
						exportAll();
					}
				}
			});
		} else {
			showAlertModal(
				"Browser Storage Full",
				"Your browser's storage limit has been reached. Please export your notes or delete unneeded files to free up space."
			);
		}
	}

	function saveWorkspaceMeta() {
		try {
			KeepLocalDB.saveWorkspaces(workspaces).catch(e => handleStorageError(e, "saveWorkspaceMeta"));
		} catch (e) {
			handleStorageError(e, "saveWorkspaceMeta");
		}
	}
	async function loadWorkspaceMeta() {
		try {
			workspaces = await KeepLocalDB.getWorkspaces();
		} catch (e) {
			console.warn("loadWorkspaceMeta:", e);
			workspaces = [];
		}
	}

	let isOptimizingWsFiles = false;
	async function optimizeOversizedFiles(wsId) {
		if (isOptimizingWsFiles) return;
		isOptimizingWsFiles = true;
		try {
			let modified = false;
			const processNode = async (node) => {
				if (node.type === "file" && typeof node.content === "string") {
					if (node.content.includes("data:image/") && node.content.length > 150 * 1024) {
						const regex = /data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]{1000,}/g;
						const matches = node.content.match(regex);
						if (matches && matches.length > 0) {
							let newContent = node.content;
							for (const match of matches) {
								if (match.length > 80 * 1024) {
									const comp = await compressDataUrl(match);
									if (comp && comp.length < match.length) {
										newContent = newContent.replace(match, comp);
										modified = true;
									}
								}
							}
							node.content = newContent;
						}
					}
				}
				if (node.children) {
					for (const child of node.children) {
						await processNode(child);
					}
				}
			};
			for (const f of files) {
				await processNode(f);
			}
			if (modified && wsId) {
				await KeepLocalDB.saveFiles(wsId, files);
				checkStorageQuota();
			}
		} catch (_) { }
		finally {
			isOptimizingWsFiles = false;
		}
	}

	function saveWsFiles(wsId) {
		if (!wsId) return Promise.resolve();
		return KeepLocalDB.saveFiles(wsId, files).then(() => {
			checkStorageQuota();
		}).catch(e => {
			handleStorageError(e, "saveWsFiles");
			if (isQuotaExceededError(e)) {
				optimizeOversizedFiles(wsId);
			}
		});
	}
	async function loadWsFiles(wsId) {
		try {
			files = await KeepLocalDB.getFiles(wsId);
			checkStorageQuota();
		} catch (e) {
			console.warn("loadWsFiles:", e);
			files = [];
		}
	}

	function saveWsConfig(wsId) {
		if (!wsId) return Promise.resolve();
		const sidebar = document.querySelector(".sidebar");
		return KeepLocalDB.saveConfig(wsId, {
			theme, fontSize, selectedId, editorMode, openTabs, isWordWrap,
			sidebarWidth: sidebar ? sidebar.offsetWidth : undefined
		}).catch(e => {
			handleStorageError(e, "saveWsConfig");
		});
	}
	async function loadWsConfig(wsId) {
		try {
			const c = await KeepLocalDB.getConfig(wsId);
			const sidebar = document.querySelector(".sidebar");
			if (c) {
				const globalTheme = localStorage.getItem("keeplocal_global_theme");
				theme = globalTheme || c.theme || "dark";
				fontSize = Number.isFinite(Number(c.fontSize))
					? Number(c.fontSize)
					: 13;
				selectedId = c.selectedId || null;
				editorMode = c.editorMode || (typeof localStorage !== "undefined" && localStorage.getItem("keeplocal_editor_mode")) || "block";
				openTabs = Array.isArray(c.openTabs) ? c.openTabs : [];
				isWordWrap = !!c.isWordWrap;
				if (c.sidebarWidth) {
					document.documentElement.style.setProperty("--sidebar-width", c.sidebarWidth + "px");
				} else {
					document.documentElement.style.removeProperty("--sidebar-width");
				}
				if (sidebar) sidebar.style.width = "";
			} else {
				openTabs = [];
				isWordWrap = false;
				document.documentElement.style.removeProperty("--sidebar-width");
				if (sidebar) sidebar.style.width = "";
			}
		} catch (e) {
			console.warn("loadWsConfig:", e);
			openTabs = [];
			isWordWrap = false;
			document.documentElement.style.removeProperty("--sidebar-width");
			const sidebar = document.querySelector(".sidebar");
			if (sidebar) sidebar.style.width = "";
		}
	}

	async function deleteWsData(wsId) {
		if (!wsId) return;
		try {
			await KeepLocalDB.deleteWorkspaceData(wsId);
		} catch (_) { }
		checkStorageQuota();
	}

	function queueDiskDeletion(pathParts, name) {
		if (!name) return;
		pendingDeletions.push({ pathParts: [...pathParts], name });
		if (activeWsId) saveWsDeletions(activeWsId);
	}

	function saveWsDeletions(wsId) {
		if (!wsId) return Promise.resolve();
		return KeepLocalDB.saveDeletions(wsId, pendingDeletions).catch(e => {
			handleStorageError(e, "saveWsDeletions");
		});
	}

	async function loadWsDeletions(wsId) {
		try {
			pendingDeletions = await KeepLocalDB.getDeletions(wsId);
		} catch {
			pendingDeletions = [];
		}
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
		if (window.location.hash !== "#/workspaces" && !window.location.search.includes("view=workspaces")) {
			try { history.replaceState(null, "", "#/workspaces"); } catch (_) { }
		}
		renderWorkspaceCards();
		// FS banner
		if (!supportsFS) {
			const fsBanner = document.getElementById("welcomeFsBanner");
			if (fsBanner) {
				fsBanner.classList.remove("hidden");
				if (!isSecure) {
					fsBanner.innerHTML = `<i data-lucide="alert-triangle" size="14"></i> Folder sync requires a Secure Context. Access via <a href="http://localhost:${window.location.port || 8000}" style="color:var(--accent-color);text-decoration:underline;">localhost</a>.`;
					if (window.lucide) window.lucide.createIcons();
				}
			}
			const openFolderBtn = document.getElementById("openFolderBtn");
			if (openFolderBtn) {
				openFolderBtn.disabled = true;
				openFolderBtn.title = !isSecure ? "Requires Secure Context (localhost/HTTPS)" : "Requires Chrome/Edge/Brave";
			}
		}
	}

	function renderWorkspaceCards() {
		workspacesList.innerHTML = "";
		wsCountBadge.textContent = workspaces.length;

		if (workspaces.length === 0) {
			const p = workspacesEmpty?.querySelector("p");
			if (p) p.textContent = "No workspaces yet";
			const small = workspacesEmpty?.querySelector("small");
			if (small) small.textContent = 'Click "New Workspace" to get started';
			workspacesEmpty?.classList.remove("hidden");
			return;
		}

		// Sort by lastOpenedAt desc
		const sorted = [...workspaces].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
		const filtered = wsCardSearchQuery
			? sorted.filter(w => w.name.toLowerCase().includes(wsCardSearchQuery))
			: sorted;

		if (filtered.length === 0) {
			const p = workspacesEmpty?.querySelector("p");
			if (p) p.textContent = "No matching workspaces";
			const small = workspacesEmpty?.querySelector("small");
			if (small) small.textContent = "Try a different search term";
			workspacesEmpty?.classList.remove("hidden");
			return;
		}
		workspacesEmpty?.classList.add("hidden");

		for (const ws of filtered) {
			const card = document.createElement("div");
			card.className = "ws-card";
			card.setAttribute("data-wsid", ws.id);

			const relTime = timeAgo(ws.lastOpenedAt || ws.createdAt);
			const folderBadge = ws.folderName
				? `<span class="ws-card-badge folder-badge"><i data-lucide="folder" size="10"></i>${escHtml(ws.folderName)}</span>`
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

		if (window.lucide) window.lucide.createIcons();
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

		if (window.lucide) window.lucide.createIcons();
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
			const trimmed = (name || "").trim();
			if (!trimmed) return;
			if (wsNameExists(trimmed)) {
				showAlertModal("Duplicate name", `A workspace named "${trimmed}" already exists. Please choose a different name.`);
				return;
			}
			const ws = {
				id: uid("ws"),
				name: trimmed,
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

	async function findWorkspaceByHandle(handle) {
		if (!handle) return null;
		for (const w of workspaces) {
			if (w.folderName) {
				try {
					const storedHandle = await idbGet(`handle_${w.id}`);
					if (storedHandle && typeof handle.isSameEntry === "function") {
						if (await handle.isSameEntry(storedHandle)) {
							return w;
						}
					}
				} catch (e) {
					console.warn("isSameEntry check failed:", e);
				}
			}
		}
		return null;
	}

	async function createNewWorkspaceFromHandle(handle) {
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
		fsPermissionGranted = true;

		// Read folder contents
		const readFiles = await readDirectoryHandle(handle);
		files = readFiles;
		ws.fileCount = countAllFiles(files);
		saveWorkspaceMeta();
		saveWsFiles(ws.id);

		await openWorkspace(ws.id, true /* skip file read, already done */);
	}

	window.openFolderWorkspace = async function () {
		if (!supportsFS) {
			if (!isSecure) {
				showAlertModal("Insecure Context", `Folder sync requires a Secure Context (HTTPS or localhost). Please access via http://localhost:${window.location.port || 8000}.`);
			} else {
				showAlertModal("Not supported", "Folder sync requires Chrome, Edge, or Brave.");
			}
			return;
		}
		try {
			const handle = await window.showDirectoryPicker({ mode: "readwrite" });

			// Check if a workspace already exists for this exact folder on disk
			const matchedWs = await findWorkspaceByHandle(handle);
			if (matchedWs) {
				// Reconnect the handle and open it
				workspaceHandle = handle;
				fsPermissionGranted = true;
				await idbSet(`handle_${matchedWs.id}`, handle);
				await openWorkspace(matchedWs.id);
				return;
			}

			// Check if an existing workspace had this folder name but lost its IndexedDB handle
			const orphanedWs = workspaces.find(w => w.folderName === handle.name);
			if (orphanedWs) {
				const hasStoredHandle = await idbGet(`handle_${orphanedWs.id}`);
				if (!hasStoredHandle) {
					showChoiceModal({
						title: "Reconnect Workspace?",
						message: `A workspace named "${orphanedWs.name}" was previously linked to a folder named "${handle.name}", but its connection handle was lost. Would you like to reconnect it, or create a new workspace?`,
						choices: [
							{
								label: `Reconnect to "${orphanedWs.name}"`,
								description: "Update the existing workspace with this folder.",
								action: "reconnect",
								primary: true
							},
							{
								label: "Create New Workspace",
								description: "Keep the existing workspace separate and create a new one.",
								action: "create"
							},
							{
								label: "Cancel",
								description: "Do not open this folder.",
								action: "cancel"
							}
						],
						onSelect: async (action) => {
							if (action === "reconnect") {
								workspaceHandle = handle;
								fsPermissionGranted = true;
								await idbSet(`handle_${orphanedWs.id}`, handle);
								const readFiles = await readDirectoryHandle(handle);
								files = readFiles;
								orphanedWs.fileCount = countAllFiles(files);
								saveWorkspaceMeta();
								saveWsFiles(orphanedWs.id);
								await openWorkspace(orphanedWs.id, true);
							} else if (action === "create") {
								await createNewWorkspaceFromHandle(handle);
							}
						}
					});
					return;
				}
			}

			// Create new workspace from folder
			await createNewWorkspaceFromHandle(handle);
		} catch (err) {
			if (err.name !== "AbortError") showAlertModal("Error", err.message);
		}
	};

	function resolveSafeZipPath(rawPath) {
		return KeepLocalMarkdown ? KeepLocalMarkdown.resolveSafeZipPath(rawPath) : [];
	}

	window.importZipOnWelcome = function () {
		document.getElementById("welcomeImportInput").click();
	};

	window.handleWelcomeImport = async function (event) {
		const file = event.target.files[0];
		if (!file) return;

		try {
			const buffer = await file.arrayBuffer();
			const zip = await JSZip.loadAsync(buffer);
			const importedFiles = [];
			const folders = { "": importedFiles };

			const fileEntries = [];
			zip.forEach((rel, entry) => {
				if (entry.dir) return;
				const normalized = rel.replace(/\\/g, "/");
				fileEntries.push({ path: normalized, entry });
			});

			// Synchronously build folder hierarchy to prevent race conditions (ZIP-01, ZIP-02, AUDIT-12)
			for (const { path } of fileEntries) {
				const parts = resolveSafeZipPath(path);
				const fname = parts.pop();
				if (!fname) continue;
				let arr = importedFiles, curPath = "";
				for (const dir of parts) {
					const fp = curPath ? `${curPath}/${dir}` : dir;
					if (!folders[fp]) {
						let existingFolder = arr.find(n => n.type === "folder" && n.name.toLowerCase() === dir.toLowerCase());
						if (!existingFolder) {
							existingFolder = { id: uid("folder"), name: dir, type: "folder", isOpen: true, children: [] };
							arr.push(existingFolder);
						}
						folders[fp] = existingFolder.children;
					}
					arr = folders[fp];
					curPath = fp;
				}
			}

			// Asynchronously read all file contents
			await Promise.all(fileEntries.map(async ({ path, entry }) => {
				const parts = resolveSafeZipPath(path);
				const fname = parts.pop();
				if (!fname) return;
				const isImg = isImageFile(fname);
				let content;
				if (isImg) {
					content = await entry.async("blob");
				} else {
					content = await entry.async("string");
				}
				const dirPath = parts.join("/");
				const arr = folders[dirPath] || importedFiles;
				const safeName = uniqueNodeName(arr, fname);
				arr.push({
					id: uid("file"),
					name: safeName,
					type: "file",
					content,
					isBinary: isImg,
					mimeType: isImg ? getImageMimeType(fname) : "text/plain"
				});
			}));

			// Only instantiate and persist workspace after successful load (ZIP-03)
			const wsName = uniqueWsName(file.name.replace(/\.zip$/i, ""));
			const ws = {
				id: uid("ws"),
				name: wsName,
				createdAt: Date.now(),
				lastOpenedAt: Date.now(),
				folderName: null,
				fileCount: countAllFiles(importedFiles)
			};
			workspaces.push(ws);
			files = importedFiles;
			activeWsId = ws.id;
			saveWorkspaceMeta();
			saveWsFiles(ws.id);
			await openWorkspace(ws.id, true);
		} catch (err) {
			console.error("Failed to import ZIP:", err);
			showAlertModal("Import Failed", "The selected file is not a valid ZIP archive: " + (err.message || err));
		} finally {
			event.target.value = "";
		}
	};

	window.renameWorkspace = function (wsId) {
		const ws = workspaces.find(w => w.id === wsId);
		if (!ws) return;
		showInputModal("Rename workspace", ws.name, (name) => {
			const trimmed = (name || "").trim();
			if (!trimmed || trimmed === ws.name) return;
			if (wsNameExists(trimmed, wsId)) {
				showAlertModal("Duplicate name", `A workspace named "${trimmed}" already exists. Please choose a different name.`);
				return;
			}
			ws.name = trimmed;
			saveWorkspaceMeta();
			renderWorkspaceCards();
			if (wsId === activeWsId) {
				if (sidebarWsName) sidebarWsName.textContent = trimmed;
				document.title = `${trimmed} – KeepLocal`;
			}
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
				if (localStorage.getItem("keeplocal_active_ws_id") === wsId) {
					localStorage.removeItem("keeplocal_active_ws_id");
				}
				if (activeWsId === wsId) {
					activeWsId = null;
					workspaceHandle = null;
					fsPermissionGranted = false;
					files = [];
					selectedId = null;
					openTabs = [];
					editorLoadedFileId = null;
					pendingDeletions = [];
					if (editorInstance) {
						try { editorInstance.destroy(); } catch (_) { }
						editorInstance = null;
					}
					showWelcome();
				}
				renderWorkspaceCards();
			},
			true
		);
	};

	// Open a workspace → switch to editor view
	async function openWorkspace(wsId, skipFileLoad = false) {
		const ws = workspaces.find(w => w.id === wsId);
		if (!ws) {
			showWelcome();
			return;
		}

		try {
			// Save current active workspace before opening the new one
			if (activeWsId && activeWsId !== wsId) {
				await autoSaveCurrentFile();
				saveWsFiles(activeWsId);
				saveWsConfig(activeWsId);
				updateWsMeta(activeWsId, { fileCount: countAllFiles(files) });
				if (typeof attachmentBlobUrlMap !== "undefined") {
					attachmentBlobUrlMap.forEach(url => URL.revokeObjectURL(url));
					attachmentBlobUrlMap.clear();
				}
			}

			activeWsId = wsId;
			ws.lastOpenedAt = Date.now();
			saveWorkspaceMeta();

			// Load config for this workspace
			await loadWsConfig(wsId);
			await loadWsDeletions(wsId);

			// Load files (unless already in memory from folder read)
			if (!skipFileLoad) {
				await loadWsFiles(wsId);
			}

			// Try to restore folder handle from IDB
			workspaceHandle = null;
			fsPermissionGranted = false;
			if (supportsFS && ws.folderName) {
				try {
					const h = await idbGet(`handle_${wsId}`);
					if (h) {
						workspaceHandle = h;
						const perm = await h.queryPermission({ mode: "readwrite" });
						fsPermissionGranted = (perm === "granted");
					}
				} catch (e) { console.warn("Could not restore handle:", e); }
			}

			// Validate selectedId
			if (selectedId && !findNode(files, selectedId)) selectedId = null;

			// If no selectedId, but openTabs has valid files, select the first valid tab
			if (!selectedId && openTabs.length > 0) {
				const validTab = openTabs.find(tid => {
					const n = findNode(files, tid);
					return n && n.type === "file";
				});
				if (validTab) selectedId = validTab;
			}

			// Save active workspace ID so page reload returns here directly
			try {
				localStorage.setItem("keeplocal_active_ws_id", wsId);
			} catch (e) {
				handleStorageError(e, "openWorkspace");
			}

			// Switch views
			welcomeScreen.classList.add("hidden");
			appShell.classList.remove("hidden");
			document.title = `${ws.name} – KeepLocal`;

			// Update hash route if needed
			if (window.location.hash !== `#/workspace/${wsId}`) {
				try { history.replaceState(null, "", `#/workspace/${wsId}`); } catch (_) { }
			}

			// Update UI
			sidebarWsName.textContent = ws.name;
			applyConfig();
			updateEditorModeUI();
			initWorkspaceButton();
			updateFolderUI();
			render();
			await loadFile();
			checkStorageQuota();

			if (window.lucide) window.lucide.createIcons();
		} catch (err) {
			console.error("[KeepLocal] Error opening workspace:", err);
			try {
				localStorage.removeItem("keeplocal_active_ws_id");
			} catch (_) { }
			activeWsId = null;
			showWelcome();
			showAlertModal(
				"Workspace Error",
				`There was a problem loading workspace "${ws.name}". The workspace manager has been opened so you can choose another workspace, export a backup, or manage your notes.`
			);
		}
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
		try {
			localStorage.removeItem("keeplocal_active_ws_id");
			if (window.location.hash !== "#/workspaces") {
				history.pushState(null, "", "#/workspaces");
			}
		} catch (_) { }
		activeWsId = null;
		workspaceHandle = null;
		fsPermissionGranted = false;
		files = [];
		selectedId = null;
		openTabs = [];
		editorLoadedFileId = null;
		pendingDeletions = [];
		// Destroy editor instance to avoid memory leak
		if (editorInstance) {
			try { editorInstance.destroy(); } catch (_) { }
			editorInstance = null;
		}
		showWelcome();
	};

	async function autoSaveCurrentFile(targetId = null) {
		clearTimeout(editorSaveTimer);
		editorSaveTimer = null;
		if (isInitEditor) return;
		const idToSave = targetId || editorLoadedFileId || selectedId;
		if (!idToSave) return;
		const f = findNode(files, idToSave);
		if (!f || f.type !== "file") return;
		if (isImageFile(f.name) || f.isBinary) return; // Binary images are not overwritten by text editor
		const isMarkdown = isMarkdownFile(f.name);
		if (editorMode === "block" && isMarkdown && editorInstance) {
			try {
				const d = await editorInstance.save();
				f.content = blocksToText(d);
				if (editorTextarea) editorTextarea.value = f.content;
			} catch (_) { }
		} else if (editorTextarea) {
			f.content = editorTextarea.value;
		}
		persistCurrent();
		if (workspaceHandle) {
			await syncWorkspace();
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
				window.lucide.createIcons();
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

			// Editor.js creates these elements dynamically (headings scale via CSS calc)
			editorjsWrapper
				.querySelectorAll(
					".ce-paragraph, .cdx-block:not(.ce-header), .ce-code__textarea, " +
					".cdx-quote, .cdx-list, .cdx-checklist, .tc-cell"
				)
				.forEach(el => {
					el.style.setProperty(
						"font-size",
						`${fontSize}px`,
						"important"
					);
				});
		}

		applyWordWrapUI();
	}

	function updateEditorModeUI() {
		const f = selectedId ? findNode(files, selectedId) : null;
		const hasFile = !!(f && f.type === "file");
		const isImg = hasFile && isImageFile(f.name);
		const isMarkdown = hasFile && !isImg && isMarkdownFile(f.name);

		if (modeSwitchGroup) {
			if (isMarkdown) {
				modeSwitchGroup.classList.remove("hidden");
			} else {
				modeSwitchGroup.classList.add("hidden");
			}
		}

		if (textControlsGroup) {
			if (hasFile && !isImg) {
				textControlsGroup.classList.remove("hidden");
			} else {
				textControlsGroup.classList.add("hidden");
			}
		}

		if (editorMode === "block") {
			modeBlockBtn?.classList.add("active");
			modePlainBtn?.classList.remove("active");
			if (hasFile && isMarkdown) {
				editorjsWrapper?.classList.remove("hidden");
				plainWrapper?.classList.add("hidden");
				if (editorStatusSpan) editorStatusSpan.textContent = "Block Mode";
			} else if (hasFile) {
				plainWrapper?.classList.remove("hidden");
				editorjsWrapper?.classList.add("hidden");
				if (editorStatusSpan) editorStatusSpan.textContent = "Raw Text";
			}
		} else {
			modePlainBtn?.classList.add("active");
			modeBlockBtn?.classList.remove("active");
			if (hasFile) {
				plainWrapper?.classList.remove("hidden");
				editorjsWrapper?.classList.add("hidden");
				if (editorStatusSpan) editorStatusSpan.textContent = "Raw Text";
			}
		}
	}

	function updateFolderUI() {
		const wsFolderLabel = document.getElementById("sidebarWsFolder");

		// Browser doesn't support folder sync at all — leave the
		// "unsupported browser" state from initWorkspaceButton() alone.
		if (!supportsFS) {
			if (wsFolderLabel) {
				wsFolderLabel.textContent = "Local storage";
				wsFolderLabel.classList.remove("has-folder");
			}
			if (wsStatusBadge) {
				wsStatusBadge.textContent = "No folder";
				wsStatusBadge.classList.remove("connected");
			}
			if (window.lucide) window.lucide.createIcons();
			return;
		}

		if (workspaceHandle) {
			if (wsFolderLabel) {
				wsFolderLabel.textContent = fsPermissionGranted
					? workspaceHandle.name
					: `${workspaceHandle.name} (not authorized)`;
				wsFolderLabel.classList.add("has-folder");
			}
			if (wsStatusBadge) {
				if (fsPermissionGranted) {
					wsStatusBadge.textContent = workspaceHandle.name;
					wsStatusBadge.className = "ws-status-badge connected";
					wsStatusBadge.title = `Synced with folder "${workspaceHandle.name}"`;
					wsStatusBadge.onclick = null;
				} else {
					wsStatusBadge.textContent = `⚠️ Re-authorize "${workspaceHandle.name}"`;
					wsStatusBadge.className = "ws-status-badge needs-permission";
					wsStatusBadge.title = `Click to re-authorize disk sync with "${workspaceHandle.name}"`;
					wsStatusBadge.onclick = () => requestReauthorization();
				}
			}
			if (saveWorkspaceBtn) {
				if (fsPermissionGranted) {
					saveWorkspaceBtn.innerHTML = '<i data-lucide="hard-drive" size="14"></i> <span>Change Folder</span>';
					saveWorkspaceBtn.title = `Currently synced with "${workspaceHandle.name}" — click to connect a different folder`;
					saveWorkspaceBtn.onclick = () => saveWorkspace();
				} else {
					saveWorkspaceBtn.innerHTML = '<i data-lucide="shield-alert" size="14"></i> <span>Re-authorize Folder</span>';
					saveWorkspaceBtn.title = `Click to grant permission to sync with "${workspaceHandle.name}"`;
					saveWorkspaceBtn.onclick = () => requestReauthorization();
				}
			}
		} else {
			if (wsFolderLabel) {
				wsFolderLabel.textContent = "Local storage";
				wsFolderLabel.classList.remove("has-folder");
			}
			if (wsStatusBadge) {
				wsStatusBadge.textContent = "No folder";
				wsStatusBadge.classList.remove("connected");
			}
			if (saveWorkspaceBtn) {
				saveWorkspaceBtn.innerHTML = '<i data-lucide="hard-drive" size="14"></i> <span>Connect Folder</span>';
				saveWorkspaceBtn.title = "Connect a local folder to sync files";
			}
		}
		checkStorageQuota();
		if (window.lucide) window.lucide.createIcons();
	}

	window.requestReauthorization = async function () {
		if (!workspaceHandle) return;
		try {
			const perm = await workspaceHandle.requestPermission({ mode: "readwrite" });
			if (perm === "granted") {
				fsPermissionGranted = true;
				updateFolderUI();
				await syncWorkspace(true);
			} else {
				showAlertModal(
					"Permission Required",
					`Permission to access folder "${workspaceHandle.name}" was not granted. Notes will only be saved in browser storage until access is granted.`
				);
			}
		} catch (err) {
			showAlertModal("Authorization Error", err.message);
		}
	};

	function initWorkspaceButton() {
		if (!supportsFS) {
			saveWorkspaceBtn.disabled = true;
			saveWorkspaceBtn.classList.add("disabled");
			saveWorkspaceBtn.title = !isSecure ? "Folder sync requires a Secure Context (localhost/HTTPS)" : "Folder sync requires Chrome, Edge, or Brave";
			if (browserSupportMsg) {
				browserSupportMsg.classList.remove("hidden");
				if (!isSecure) {
					browserSupportMsg.innerHTML = `⚠ Folder sync requires a Secure Context. Access via <a href="http://localhost:${window.location.port || 8000}" style="color:var(--accent-color);text-decoration:underline;">localhost</a>.`;
				}
			}
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

	function findNodeByPath(nodes, targetPath) {
		const search = (items, curPath = "") => {
			for (const item of items) {
				const p = curPath ? `${curPath}/${item.name}` : item.name;
				if (p === targetPath) return item;
				if (item.children) {
					const found = search(item.children, p);
					if (found) return found;
				}
			}
			return null;
		};
		return search(nodes);
	}
	function nameExistsInArray(arr, name, excludeId = null) {
		return arr.some(n => n.name.toLowerCase() === name.toLowerCase() && n.id !== excludeId);
	}

	function uniqueNodeName(arr, name, excludeId = null) {
		if (!nameExistsInArray(arr, name, excludeId)) return name;
		const dot = name.lastIndexOf(".");
		const base = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		let c = 1;
		let newName = `${base} (${c})${ext}`;
		while (nameExistsInArray(arr, newName, excludeId)) {
			c++;
			newName = `${base} (${c})${ext}`;
		}
		return newName;
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
	// ATTACHMENTS & IMAGE MANAGEMENT
	// ============================================================
	const attachmentBlobUrlMap = new Map();
	if (typeof window !== "undefined") {
		window.attachmentBlobUrlMap = attachmentBlobUrlMap;
	}

	function resolveAttachmentUrl(url) {
		if (!url || typeof url !== "string") return "";
		const trimmed = url.trim();
		if (/^(?:https?:\/\/|data:|blob:)/i.test(trimmed)) {
			return trimmed;
		}

		if (attachmentBlobUrlMap.has(trimmed)) {
			return attachmentBlobUrlMap.get(trimmed);
		}

		const cleanPath = trimmed.replace(/^(\.\/|\/)/, "");
		if (attachmentBlobUrlMap.has(cleanPath)) {
			return attachmentBlobUrlMap.get(cleanPath);
		}
		try {
			const decPath = decodeURIComponent(cleanPath);
			if (attachmentBlobUrlMap.has(decPath)) {
				return attachmentBlobUrlMap.get(decPath);
			}
		} catch (_) { }

		const parts = cleanPath.split("/").map(p => {
			try { return decodeURIComponent(p); } catch (_) { return p; }
		});
		const targetFilename = (parts[parts.length - 1] || "").split("?")[0].split("#")[0];
		if (!targetFilename) return "";

		if (attachmentBlobUrlMap.has(targetFilename)) {
			return attachmentBlobUrlMap.get(targetFilename);
		}

		let targetNode = null;
		const attachmentsFolder = files.find(n => n.type === "folder" && n.name.toLowerCase() === "attachments");
		if (attachmentsFolder && attachmentsFolder.children) {
			targetNode = attachmentsFolder.children.find(n => n.type === "file" && n.name.toLowerCase() === targetFilename.toLowerCase());
		}
		if (!targetNode) {
			const allNodes = flattenNodes(files);
			targetNode = allNodes.find(n => n.type === "file" && n.name.toLowerCase() === targetFilename.toLowerCase());
		}

		if (targetNode) {
			if (targetNode.content instanceof Blob) {
				let existing = attachmentBlobUrlMap.get(targetNode.id);
				if (!existing) {
					existing = URL.createObjectURL(targetNode.content);
					attachmentBlobUrlMap.set(targetNode.id, existing);
					attachmentBlobUrlMap.set(`attachments/${targetNode.name}`, existing);
					attachmentBlobUrlMap.set(`./attachments/${targetNode.name}`, existing);
					attachmentBlobUrlMap.set(`/attachments/${targetNode.name}`, existing);
					attachmentBlobUrlMap.set(targetNode.name, existing);
				}
				return existing;
			} else if (typeof targetNode.content === "string") {
				if (targetNode.content.startsWith("data:image/")) {
					return targetNode.content;
				} else if (targetNode.content) {
					const dataUrl = `data:${targetNode.mimeType || getImageMimeType(targetNode.name)};base64,${targetNode.content}`;
					attachmentBlobUrlMap.set(targetNode.id, dataUrl);
					attachmentBlobUrlMap.set(`attachments/${targetNode.name}`, dataUrl);
					attachmentBlobUrlMap.set(`./attachments/${targetNode.name}`, dataUrl);
					attachmentBlobUrlMap.set(targetNode.name, dataUrl);
					return dataUrl;
				}
			} else if (targetNode.content instanceof ArrayBuffer || (targetNode.content && targetNode.content.buffer instanceof ArrayBuffer)) {
				let existing = attachmentBlobUrlMap.get(targetNode.id);
				if (!existing) {
					const blob = new Blob([targetNode.content], { type: targetNode.mimeType || getImageMimeType(targetNode.name) });
					existing = URL.createObjectURL(blob);
					attachmentBlobUrlMap.set(targetNode.id, existing);
					attachmentBlobUrlMap.set(`attachments/${targetNode.name}`, existing);
					attachmentBlobUrlMap.set(`./attachments/${targetNode.name}`, existing);
					attachmentBlobUrlMap.set(`/attachments/${targetNode.name}`, existing);
					attachmentBlobUrlMap.set(targetNode.name, existing);
				}
				return existing;
			}
		}

		return "";
	}
	if (typeof window !== "undefined") {
		window.resolveAttachmentUrl = resolveAttachmentUrl;
	}

	async function imageToWebpBlob(source, quality = 0.82, maxWidth = 1920, maxHeight = 1920) {
		if (source instanceof Blob && source.type === "image/svg+xml") {
			return { blob: source, ext: "svg", mimeType: "image/svg+xml" };
		}
		if (typeof source === "string" && source.startsWith("data:image/svg+xml")) {
			const parts = source.split(",");
			const decoded = decodeURIComponent(parts[1] || "");
			const blob = new Blob([decoded], { type: "image/svg+xml" });
			return { blob, ext: "svg", mimeType: "image/svg+xml" };
		}

		return new Promise((resolve) => {
			let srcUrl = "";
			let isObjUrl = false;
			if (source instanceof Blob) {
				srcUrl = URL.createObjectURL(source);
				isObjUrl = true;
			} else if (typeof source === "string") {
				srcUrl = source;
			}

			const img = new Image();
			img.onload = () => {
				if (isObjUrl) URL.revokeObjectURL(srcUrl);
				let { width, height } = img;
				if (width > maxWidth || height > maxHeight) {
					const ratio = Math.min(maxWidth / width, maxHeight / height);
					width = Math.round(width * ratio);
					height = Math.round(height * ratio);
				}
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, width);
				canvas.height = Math.max(1, height);
				const ctx = canvas.getContext("2d");
				ctx.drawImage(img, 0, 0, width, height);

				canvas.toBlob((blob) => {
					if (blob) {
						resolve({ blob, ext: "webp", mimeType: "image/webp" });
					} else {
						canvas.toBlob((fallbackBlob) => {
							resolve({
								blob: fallbackBlob || (source instanceof Blob ? source : new Blob([])),
								ext: fallbackBlob?.type === "image/png" ? "png" : "jpeg",
								mimeType: fallbackBlob?.type || "image/jpeg"
							});
						}, "image/jpeg", quality);
					}
				}, "image/webp", quality);
			};
			img.onerror = () => {
				if (isObjUrl) URL.revokeObjectURL(srcUrl);
				if (source instanceof Blob) {
					const ext = source.type.split("/")[1] || "png";
					resolve({ blob: source, ext, mimeType: source.type });
				} else {
					resolve({ blob: new Blob([]), ext: "png", mimeType: "image/png" });
				}
			};
			img.src = srcUrl;
		});
	}

	function getOrCreateAttachmentsFolder() {
		let folder = files.find(n => n.type === "folder" && n.name.toLowerCase() === "attachments");
		if (!folder) {
			folder = {
				id: uid("folder"),
				name: "attachments",
				type: "folder",
				isOpen: true,
				children: []
			};
			files.push(folder);
		}
		return folder;
	}

	async function saveImageToAttachments(fileOrDataUrl, preferredName = "") {
		const { blob, ext, mimeType } = await imageToWebpBlob(fileOrDataUrl);
		const now = new Date();
		const pad = (n) => String(n).padStart(2, "0");
		const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

		let baseName = preferredName ? preferredName.replace(/\.[^.]+$/, "") : `image_${dateStr}`;
		baseName = baseName.replace(/[/\\:*?"<>|]/g, "_").trim() || `image_${dateStr}`;
		const filename = `${baseName}.${ext}`;

		const folder = getOrCreateAttachmentsFolder();
		const safeName = uniqueNodeName(folder.children, filename);

		const fileNode = {
			id: uid("file"),
			name: safeName,
			type: "file",
			isBinary: true,
			mimeType: mimeType || "image/webp",
			content: blob,
			size: blob.size,
			_diskContent: null
		};

		folder.children.push(fileNode);

		if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
			try {
				const blobUrl = URL.createObjectURL(blob);
				attachmentBlobUrlMap.set(fileNode.id, blobUrl);
				attachmentBlobUrlMap.set(`attachments/${safeName}`, blobUrl);
				attachmentBlobUrlMap.set(`./attachments/${safeName}`, blobUrl);
				attachmentBlobUrlMap.set(safeName, blobUrl);
			} catch (_) { }
		}

		persistCurrent();
		render();
		if (workspaceHandle) {
			syncWorkspace();
		}

		return `attachments/${safeName}`;
	}
	if (typeof window !== "undefined") {
		window.saveImageToAttachments = saveImageToAttachments;
	}

	function loadImageInViewer(file) {
		const imgEl = document.getElementById("imageViewerImg");
		const infoEl = document.getElementById("imageViewerInfo");
		const copyBtn = document.getElementById("imageViewerCopyBtn");
		const downloadBtn = document.getElementById("imageViewerDownloadBtn");
		if (!imgEl) return;

		let srcUrl = "";
		let blobToUse = null;

		if (file.content instanceof Blob) {
			blobToUse = file.content;
			srcUrl = resolveAttachmentUrl(file.name);
			if (!srcUrl) {
				srcUrl = URL.createObjectURL(file.content);
				attachmentBlobUrlMap.set(file.id, srcUrl);
				attachmentBlobUrlMap.set(`attachments/${file.name}`, srcUrl);
				attachmentBlobUrlMap.set(`./attachments/${file.name}`, srcUrl);
				attachmentBlobUrlMap.set(file.name, srcUrl);
			}
		} else if (typeof file.content === "string") {
			if (file.content.startsWith("data:image/")) {
				srcUrl = file.content;
			} else if (file.content) {
				srcUrl = resolveAttachmentUrl(file.name) || resolveAttachmentUrl(file.content) || `data:${file.mimeType || getImageMimeType(file.name)};base64,${file.content}`;
			}
		} else if (file.content instanceof ArrayBuffer || (file.content && file.content.buffer instanceof ArrayBuffer)) {
			blobToUse = new Blob([file.content], { type: file.mimeType || getImageMimeType(file.name) });
			srcUrl = resolveAttachmentUrl(file.name);
			if (!srcUrl) {
				srcUrl = URL.createObjectURL(blobToUse);
				attachmentBlobUrlMap.set(file.id, srcUrl);
				attachmentBlobUrlMap.set(`attachments/${file.name}`, srcUrl);
				attachmentBlobUrlMap.set(`./attachments/${file.name}`, srcUrl);
				attachmentBlobUrlMap.set(file.name, srcUrl);
			}
		}

		imgEl.src = srcUrl;

		const formatBytes = (bytes) => {
			if (!bytes || bytes <= 0) return "";
			const k = 1024;
			const sizes = ["B", "KB", "MB"];
			const i = Math.floor(Math.log(bytes) / Math.log(k));
			return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
		};

		const updateMeta = () => {
			const sizeStr = blobToUse ? formatBytes(blobToUse.size) : (file.size ? formatBytes(file.size) : "");
			const dims = (imgEl.naturalWidth && imgEl.naturalHeight) ? `${imgEl.naturalWidth} × ${imgEl.naturalHeight}` : "";
			const metaParts = [file.name];
			if (dims) metaParts.push(dims);
			if (sizeStr) metaParts.push(sizeStr);
			if (infoEl) infoEl.textContent = metaParts.join(" • ");
			if (cursorPosSpan) cursorPosSpan.textContent = dims || file.name;
		};

		imgEl.onload = updateMeta;
		updateMeta();

		if (copyBtn) {
			copyBtn.onclick = () => {
				const pathNodes = getPath(file.id);
				let relPath = `attachments/${file.name}`;
				if (pathNodes && pathNodes.length > 1) {
					relPath = pathNodes.map(n => n.name).slice(1).join("/");
				}
				const mdLink = `![${file.name}](${relPath})`;
				navigator.clipboard.writeText(mdLink).then(() => {
					const orig = copyBtn.innerHTML;
					copyBtn.innerHTML = `<i data-lucide="check" size="14"></i> <span>Copied!</span>`;
					if (window.lucide) window.lucide.createIcons();
					setTimeout(() => {
						copyBtn.innerHTML = orig;
						if (window.lucide) window.lucide.createIcons();
					}, 1500);
				}).catch(() => {
					showAlertModal("Copy Link", mdLink);
				});
			};
		}

		if (downloadBtn) {
			downloadBtn.onclick = () => {
				if (blobToUse) {
					downloadBlob(blobToUse, file.name);
				} else if (srcUrl.startsWith("data:image/")) {
					const a = document.createElement("a");
					a.href = srcUrl;
					a.download = file.name;
					a.click();
				}
			};
		}
		if (window.lucide) window.lucide.createIcons();
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
	const modalChoiceBtns = document.getElementById("modalChoiceButtons");
	const modalAlertBtns = document.getElementById("modalAlertButtons");
	const modalAlertOkBtn = document.getElementById("modalAlertOkBtn");
	if (modalAlertOkBtn) {
		modalAlertOkBtn.onclick = () => hideModal();
	}
	let modalCb = null;

	function showInputModal(title, def, cb) {
		modalTitle.textContent = title;
		modalInput.value = def || "";
		modalInput.classList.remove("hidden");
		modalMessage.classList.add("hidden");
		modalInputHint.classList.remove("hidden");
		modalInputHint.innerHTML = "Press <b>Enter</b> to confirm, <b>Esc</b> to cancel";
		modalConfirmBtns.classList.add("hidden");
		if (modalAlertBtns) modalAlertBtns.classList.add("hidden");
		if (modalChoiceBtns) { modalChoiceBtns.innerHTML = ""; modalChoiceBtns.classList.add("hidden"); }
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
		if (modalAlertBtns) modalAlertBtns.classList.add("hidden");
		if (modalChoiceBtns) { modalChoiceBtns.innerHTML = ""; modalChoiceBtns.classList.add("hidden"); }
		modalConfirmBtn.textContent = danger ? "Delete" : "Confirm";
		modalConfirmBtn.className = danger ? "modal-btn danger" : "modal-btn primary";
		modalOverlay.classList.add("active");
		modalCb = cb;
		setTimeout(() => { if (modalConfirmBtn) modalConfirmBtn.focus(); }, 30);
	}
	function showAlertModal(title, msg) {
		modalTitle.textContent = title;
		modalMessage.textContent = msg;
		modalInput.classList.add("hidden");
		modalMessage.classList.remove("hidden");
		modalConfirmBtns.classList.add("hidden");
		if (modalAlertBtns) modalAlertBtns.classList.remove("hidden");
		modalInputHint.classList.remove("hidden");
		modalInputHint.innerHTML = "Press <b>Esc</b> or click OK to close";
		if (modalChoiceBtns) { modalChoiceBtns.innerHTML = ""; modalChoiceBtns.classList.add("hidden"); }
		modalOverlay.classList.add("active");
		modalCb = null;
		setTimeout(() => { if (modalAlertOkBtn) modalAlertOkBtn.focus(); }, 30);
	}
	function showChoiceModal({ title, message, choices, onSelect }) {
		modalTitle.textContent = title;
		modalMessage.textContent = message;
		modalInput.classList.add("hidden");
		modalMessage.classList.remove("hidden");
		modalConfirmBtns.classList.add("hidden");
		if (modalAlertBtns) modalAlertBtns.classList.add("hidden");
		modalInputHint.classList.remove("hidden");
		modalInputHint.innerHTML = "Press <b>Esc</b> to cancel";

		if (modalChoiceBtns) {
			modalChoiceBtns.innerHTML = "";
			modalChoiceBtns.classList.remove("hidden");

			choices.forEach(ch => {
				const btn = document.createElement("button");
				btn.className = `modal-choice-btn ${ch.primary ? "primary" : ch.danger ? "danger" : ""}`;
				btn.innerHTML = `
					<span class="modal-choice-btn-title">${escHtml(ch.label)}</span>
					${ch.description ? `<span class="modal-choice-btn-desc">${escHtml(ch.description)}</span>` : ""}
				`;
				btn.onclick = () => {
					hideModal();
					if (onSelect) onSelect(ch.action);
				};
				modalChoiceBtns.appendChild(btn);
			});
		}

		modalOverlay.classList.add("active");
		modalCb = (confirmed) => {
			if (!confirmed && onSelect) onSelect("cancel");
		};
		setTimeout(() => {
			const firstChoice = modalChoiceBtns?.querySelector("button");
			if (firstChoice) firstChoice.focus();
		}, 30);
	}
	function hideModal() {
		modalOverlay.classList.remove("active");
		if (modalConfirmBtns) modalConfirmBtns.classList.add("hidden");
		if (modalAlertBtns) modalAlertBtns.classList.add("hidden");
		if (modalChoiceBtns) {
			modalChoiceBtns.innerHTML = "";
			modalChoiceBtns.classList.add("hidden");
		}
		modalCb = null;
	}
	window.showInputModal = showInputModal;
	window.showConfirmModal = showConfirmModal;
	window.showAlertModal = showAlertModal;
	window.showChoiceModal = showChoiceModal;
	window.hideModal = hideModal;

	modalInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			const cb = modalCb;
			if (cb) cb(modalInput.value.trim());
			// If the callback opened a NEW modal (e.g. a duplicate-name alert),
			// modalCb will have changed — don't hide that new modal.
			if (modalCb === cb) hideModal();
		}
		if (e.key === "Escape") {
			if (modalCb) modalCb(false);
			hideModal();
		}
	});
	modalConfirmBtn.onclick = () => { if (modalCb) modalCb(true); hideModal(); };
	modalCancelBtn.onclick = () => { if (modalCb) modalCb(false); hideModal(); };
	modalOverlay.addEventListener("click", (e) => {
		if (e.target === modalOverlay) {
			if (modalCb) modalCb(false);
			hideModal();
		}
	});

	document.addEventListener("keydown", (e) => {
		if (!modalOverlay.classList.contains("active")) return;
		if (e.key === "Escape") {
			e.preventDefault();
			if (modalCb) modalCb(false);
			hideModal();
			return;
		}
		if (e.key === "Tab") {
			const container = document.querySelector(".modal-container");
			if (!container) return;
			const focusable = Array.from(
				container.querySelectorAll(
					'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			).filter(el => el.offsetParent !== null && !el.closest(".hidden"));

			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];

			if (e.shiftKey) {
				if (document.activeElement === first || !container.contains(document.activeElement)) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last || !container.contains(document.activeElement)) {
					e.preventDefault();
					first.focus();
				}
			}
		}
	});

	// ============================================================
	// HELP / ONBOARDING MODAL
	// ============================================================
	const helpModalOverlay = document.getElementById("helpModalOverlay");

	function openHelpModal() {
		if (!helpModalOverlay) return;
		helpModalOverlay.classList.add("active");
		if (window.lucide) window.lucide.createIcons();
		const focusBtn = helpModalOverlay.querySelector(".help-got-it-btn") || helpModalOverlay.querySelector(".help-close-btn");
		setTimeout(() => { if (focusBtn) focusBtn.focus(); }, 30);
	}

	function hideHelpModal() {
		if (!helpModalOverlay) return;
		helpModalOverlay.classList.remove("active");
	}

	function toggleHelpModal() {
		if (helpModalOverlay?.classList.contains("active")) {
			hideHelpModal();
		} else {
			openHelpModal();
		}
	}

	window.openHelpModal = openHelpModal;
	window.hideHelpModal = hideHelpModal;
	window.toggleHelpModal = toggleHelpModal;

	helpModalOverlay?.addEventListener("click", (e) => {
		if (e.target === helpModalOverlay) hideHelpModal();
	});

	document.addEventListener("keydown", (e) => {
		if (!helpModalOverlay || !helpModalOverlay.classList.contains("active")) return;
		if (e.key === "Escape" || e.key === "?" || e.key === "F1" || (e.altKey && (e.key.toLowerCase() === "h" || e.code === "KeyH"))) {
			e.preventDefault();
			e.stopImmediatePropagation();
			hideHelpModal();
			return;
		}
		if (e.key === "Tab") {
			const container = helpModalOverlay.querySelector(".help-modal-container");
			if (!container) return;
			const focusable = Array.from(
				container.querySelectorAll(
					'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			).filter(el => el.offsetParent !== null && !el.closest(".hidden"));

			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];

			if (e.shiftKey) {
				if (document.activeElement === first || !container.contains(document.activeElement)) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last || !container.contains(document.activeElement)) {
					e.preventDefault();
					first.focus();
				}
			}
		}
	});

	// ============================================================
	// FILESYSTEM SYNC
	// ============================================================
	function mergeFileTrees(baseFolderFiles, localFiles) {
		const merged = JSON.parse(JSON.stringify(baseFolderFiles));

		function mergeNodes(targetArr, sourceNodes) {
			for (const src of sourceNodes) {
				if (src.type === "file") {
					const existing = targetArr.find(x => x.name.toLowerCase() === src.name.toLowerCase());
					if (!existing) {
						targetArr.push(JSON.parse(JSON.stringify(src)));
					} else if (existing.content !== src.content) {
						const dot = src.name.lastIndexOf(".");
						const baseName = dot > 0 ? src.name.slice(0, dot) : src.name;
						const ext = dot > 0 ? src.name.slice(dot) : "";
						let counter = 1;
						let uniqueName = `${baseName} (local)${ext}`;
						while (nameExistsInArray(targetArr, uniqueName)) {
							counter++;
							uniqueName = `${baseName} (local ${counter})${ext}`;
						}
						targetArr.push({ ...JSON.parse(JSON.stringify(src)), id: uid("file"), name: uniqueName });
					}
				} else if (src.type === "folder") {
					const existingFolder = targetArr.find(x => x.type === "folder" && x.name.toLowerCase() === src.name.toLowerCase());
					if (!existingFolder) {
						targetArr.push(JSON.parse(JSON.stringify(src)));
					} else {
						existingFolder.children = existingFolder.children || [];
						mergeNodes(existingFolder.children, src.children || []);
					}
				}
			}
		}

		mergeNodes(merged, localFiles);
		return merged;
	}

	window.saveWorkspace = async function () {
		if (!supportsFS) {
			if (!isSecure) {
				showAlertModal("Insecure Context", `Folder sync requires a Secure Context (HTTPS or localhost). Please access via http://localhost:${window.location.port || 8000}.`);
			} else {
				showAlertModal("Not supported", "Requires Chrome, Edge, or Brave.");
			}
			return;
		}
		await autoSaveCurrentFile();
		try {
			const handle = await window.showDirectoryPicker({ mode: "readwrite" });

			// Check if another workspace is already linked to this exact folder handle
			const otherWs = await findWorkspaceByHandle(handle);
			if (otherWs && otherWs.id !== activeWsId) {
				const proceed = await new Promise(res => {
					showChoiceModal({
						title: "Folder Already Connected",
						message: `The folder "${handle.name}" is already linked to another workspace ("${otherWs.name}"). Connecting it here will share this folder across both workspaces. Do you want to proceed?`,
						choices: [
							{
								label: "Connect Anyway",
								description: "Share this folder with both workspaces.",
								action: "connect",
								primary: true
							},
							{
								label: "Cancel",
								description: "Do not connect this folder.",
								action: "cancel"
							}
						],
						onSelect: action => res(action === "connect")
					});
				});
				if (!proceed) return;
			}

			const readFiles = await readDirectoryHandle(handle);

			const finalizeConnection = async (chosenFiles, pushToDisk = false) => {
				workspaceHandle = handle;
				fsPermissionGranted = true;
				await idbSet(`handle_${activeWsId}`, handle);
				updateWsMeta(activeWsId, { folderName: handle.name, fileCount: countAllFiles(chosenFiles) });
				files = chosenFiles;
				saveWsFiles(activeWsId);
				if (pushToDisk) {
					await saveNodes(handle, files);
				}
				updateFolderUI();
				render();
				if (!selectedId || !findNode(files, selectedId)) {
					selectedId = findFirstFile(files)?.id || null;
				}
				await loadFile();
			};

			const localFileCount = countAllFiles(files);
			const folderFileCount = countAllFiles(readFiles);

			// Case 1: Folder has files AND local workspace has existing notes -> Smart Prompt
			if (localFileCount > 0 && folderFileCount > 0) {
				showChoiceModal({
					title: "Connect Folder: Existing Files Detected",
					message: `The folder "${handle.name}" contains ${folderFileCount} note${folderFileCount === 1 ? "" : "s"}, but your workspace already has ${localFileCount} local note${localFileCount === 1 ? "" : "s"}. What would you like to do?`,
					choices: [
						{
							label: "Merge Notes (Recommended)",
							description: "Keep both: copy local notes into the folder and import folder notes.",
							action: "merge",
							primary: true
						},
						{
							label: "Use Folder Notes Only",
							description: "Replace current local notes with the files from the chosen folder.",
							action: "replace",
							danger: true
						},
						{
							label: "Cancel",
							description: "Do not connect this folder. Pick an empty folder if you want a clean sync.",
							action: "cancel"
						}
					],
					onSelect: async (action) => {
						if (action === "merge") {
							const merged = mergeFileTrees(readFiles, files);
							await finalizeConnection(merged, true /* push local notes to folder */);
						} else if (action === "replace") {
							await finalizeConnection(readFiles, false);
						}
					}
				});
				return;
			}

			// Case 2: Folder is empty -> push local files to it
			if (folderFileCount === 0) {
				await finalizeConnection(files, true);
				return;
			}

			// Case 3: Local workspace is empty -> load folder's files
			await finalizeConnection(readFiles, false);

		} catch (err) {
			if (err.name !== "AbortError") showAlertModal("Error", err.message);
		}
	};

	window.resyncFromDisk = async function () {
		if (!workspaceHandle) {
			showAlertModal("No Folder Connected", "Connect a system folder to enable folder re-syncing.");
			return;
		}
		await autoSaveCurrentFile();
		try {
			const perm = await workspaceHandle.requestPermission({ mode: "readwrite" });
			if (perm !== "granted") {
				fsPermissionGranted = false;
				updateFolderUI();
				showAlertModal("Permission denied", "Could not access the folder.");
				return;
			}
			fsPermissionGranted = true;
			updateFolderUI();

			// Cancel pending debounced disk sync so stale memory isn't written back to disk
			if (diskSyncTimer) {
				clearTimeout(diskSyncTimer);
				diskSyncTimer = null;
			}
			if (isSyncing) {
				await new Promise(r => syncWaiters.push(r));
			}

			const prevSelectedId = selectedId;
			const prevSelectedPath = selectedId ? getPath(selectedId).map(n => n.name).join("/") : null;

			files = await readDirectoryHandle(workspaceHandle, files);
			if (activeWsId) {
				saveWsFiles(activeWsId);
				updateWsMeta(activeWsId, { fileCount: countAllFiles(files) });
			}

			// Preserve selectedId if file still exists on disk
			if (prevSelectedId && findNode(files, prevSelectedId)) {
				selectedId = prevSelectedId;
			} else if (prevSelectedPath) {
				const found = findNodeByPath(files, prevSelectedPath);
				selectedId = found ? found.id : null;
			} else {
				selectedId = null;
			}

			render();
			await loadFile();
			wsStatusBadge.textContent = "Synced ✓";
			setTimeout(() => {
				if (workspaceHandle && fsPermissionGranted) wsStatusBadge.textContent = workspaceHandle.name;
			}, 1500);
		} catch (e) { showAlertModal("Sync error", e.message); }
	};

	async function readDirectoryHandle(dirHandle, existingNodes = null) {
		const SKIP = new Set(["node_modules", ".git", ".svn", "dist", "build", "__pycache__", ".next", ".cache"]);
		const TEXT_EXTS = new Set(["txt", "md", "js", "ts", "jsx", "tsx", "html", "css", "json", "yaml", "yml",
			"toml", "xml", "csv", "sh", "bash", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "php",
			"vue", "svelte", "env", "gitignore", "dockerfile", "sql", "graphql", "mdx", "ini", "cfg", "conf", "log"]);
		const result = [];

		async function readDir(handle, arr, existingArr = null) {
			const entries = [];
			for await (const [name, entry] of handle.entries()) entries.push([name, entry]);
			entries.sort((a, b) => {
				if (a[1].kind !== b[1].kind) return a[1].kind === "directory" ? -1 : 1;
				return a[0].localeCompare(b[0]);
			});
			for (const [name, entry] of entries) {
				if (name.startsWith(".")) continue;
				const matchedExisting = Array.isArray(existingArr)
					? existingArr.find(n => n.name === name && (n.type === (entry.kind === "directory" ? "folder" : "file")))
					: null;

				if (entry.kind === "directory") {
					if (SKIP.has(name)) continue;
					const children = [];
					await readDir(entry, children, matchedExisting?.children);
					arr.push({
						id: matchedExisting?.id || uid("folder"),
						name,
						type: "folder",
						isOpen: matchedExisting ? !!matchedExisting.isOpen : false,
						children
					});
				} else {
					const ext = name.split(".").pop()?.toLowerCase();
					const isText = TEXT_EXTS.has(ext);
					const isImg = isImageFile(name);
					if (!isText && !isImg) continue;
					try {
						const f = await entry.getFile();
						let content;
						if (isImg) {
							const buf = await f.arrayBuffer();
							content = new Blob([buf], { type: f.type || getImageMimeType(name) });
						} else {
							content = await f.text();
						}
						arr.push({
							id: matchedExisting?.id || uid("file"),
							name,
							type: "file",
							isBinary: isImg,
							mimeType: f.type || (isImg ? getImageMimeType(name) : "text/plain"),
							content,
							_diskContent: content
						});
					} catch (e) { console.warn("Skip:", name, e); }
				}
			}
		}
		await readDir(dirHandle, result, existingNodes);
		return result;
	}

	async function writeFile(dirHandle, name, content) {
		const fh = await dirHandle.getFileHandle(name, { create: true });
		const w = await fh.createWritable();
		await w.write(content);
		await w.close();
	}

	async function saveNodes(dirHandle, nodes) {
		for (const n of nodes) {
			if (n.type === "file") {
				if (n._diskContent !== n.content) {
					await writeFile(dirHandle, n.name, n.content || "");
					n._diskContent = n.content || "";
				}
			} else {
				const sub = await dirHandle.getDirectoryHandle(n.name, { create: true });
				await saveNodes(sub, n.children || []);
			}
		}
	}

	let diskSyncTimer = null;
	let isSyncing = false;
	let syncPending = false;
	let syncWaiters = [];

	function requestDiskSync(delay = 1000) {
		if (!workspaceHandle) return;
		clearTimeout(diskSyncTimer);
		diskSyncTimer = setTimeout(() => {
			diskSyncTimer = null;
			performDiskSync();
		}, delay);
	}

	async function flushDiskSync() {
		if (diskSyncTimer) {
			clearTimeout(diskSyncTimer);
			diskSyncTimer = null;
		}
		if (!workspaceHandle) return;
		if (isSyncing) {
			syncPending = true;
			return new Promise((resolve) => {
				syncWaiters.push(resolve);
			});
		}
		return performDiskSync();
	}

	async function performDiskSync() {
		if (!workspaceHandle) return;
		if (!fsPermissionGranted) {
			updateFolderUI();
			return;
		}
		if (isSyncing) {
			syncPending = true;
			return new Promise((resolve) => {
				syncWaiters.push(resolve);
			});
		}

		isSyncing = true;
		if (wsStatusBadge && workspaceHandle) {
			wsStatusBadge.textContent = "Saving…";
		}

		try {
			// Process only explicitly tracked deletions (never purge unmanaged disk entries)
			if (pendingDeletions.length > 0) {
				const remaining = [];
				for (const item of pendingDeletions) {
					try {
						let dir = workspaceHandle;
						for (const part of item.pathParts) {
							dir = await dir.getDirectoryHandle(part, { create: false });
						}
						await dir.removeEntry(item.name, { recursive: true });
					} catch (err) {
						if (err.name === "NotAllowedError") {
							fsPermissionGranted = false;
							updateFolderUI();
							remaining.push(item);
						} else if (err.name !== "NotFoundError") {
							console.warn("Could not remove entry from disk:", item, err);
						}
					}
				}
				pendingDeletions = remaining;
				if (activeWsId) saveWsDeletions(activeWsId);
			}

			// Write managed files to disk (with dirty checking)
			await saveNodes(workspaceHandle, files);

			if (wsStatusBadge && workspaceHandle && fsPermissionGranted) {
				wsStatusBadge.textContent = "Saved ✓";
				setTimeout(() => {
					if (workspaceHandle && fsPermissionGranted && !isSyncing && !syncPending) {
						wsStatusBadge.textContent = workspaceHandle.name;
					}
				}, 1500);
			}
		} catch (e) {
			if (e.name === "NotAllowedError") {
				fsPermissionGranted = false;
				updateFolderUI();
			} else {
				console.warn("Sync error:", e);
			}
		} finally {
			isSyncing = false;
			const waiters = [...syncWaiters];
			syncWaiters = [];

			if (syncPending) {
				syncPending = false;
				performDiskSync()
					.catch(err => {
						console.warn("Subsequent sync error:", err);
					})
					.finally(() => {
						waiters.forEach(res => res());
					});
			} else {
				waiters.forEach(res => res());
			}
		}
	}

	async function syncWorkspace(immediate = true) {
		if (immediate) {
			return flushDiskSync();
		} else {
			requestDiskSync(1000);
		}
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

	window.addFile = async function () {
		if (isAddingFile) return;
		isAddingFile = true;
		try {
			await autoSaveCurrentFile();
			const t = getTarget();
			let name = "untitled.md", c = 1;
			while (nameExistsInArray(t.array, name)) name = `untitled-${c++}.md`;
			const nf = { id: uid("file"), name, type: "file", content: "" };
			t.array.push(nf);
			if (t.node) t.node.isOpen = true;
			if (!openTabs.includes(nf.id)) {
				openTabs.push(nf.id);
			}
			selectedId = nf.id;
			persistCurrent();
			render();
			setTimeout(() => beginInlineRename(nf.id), 40);
			await loadFile();
			syncWorkspace();
		} finally {
			isAddingFile = false;
		}
	};

	window.addFolder = async function () {
		if (selectedId && findNode(files, selectedId)?.type === "file") {
			await autoSaveCurrentFile();
		}
		const t = getTarget();
		let name = "New Folder", c = 1;
		while (nameExistsInArray(t.array, name)) name = `New Folder ${c++}`;
		const nf = { id: uid("folder"), name, type: "folder", isOpen: true, children: [] };
		t.array.push(nf);
		if (t.node) t.node.isOpen = true;
		// Leave selectedId pointing to current active file to prevent stale un-savable editor state
		persistCurrent();
		render();
		setTimeout(() => beginInlineRename(nf.id), 40);
		syncWorkspace();
	};

	window.renameNode = function (id) {
		render();
		setTimeout(() => beginInlineRename(id), 30);
	};

	function collectDescendantIds(node, set = new Set()) {
		set.add(node.id);
		if (node.children) {
			for (const child of node.children) collectDescendantIds(child, set);
		}
		return set;
	}

	window.deleteNode = function (id) {
		const n = findNode(files, id);
		if (!n) return;
		showConfirmModal("Delete", `Delete "${n.name}"?`, async (ok) => {
			if (!ok) return;
			const fullPath = getPath(id);
			const pathParts = fullPath.slice(0, -1).map(x => x.name);
			queueDiskDeletion(pathParts, n.name);

			const deletedIds = collectDescendantIds(n);
			if (deletedIds.has(selectedId)) {
				clearTimeout(editorSaveTimer);
				editorSaveTimer = null;
			}
			const p = findParent(files, id);
			if (p) p.children = p.children.filter(c => c.id !== id);
			else files = files.filter(c => c.id !== id);

			openTabs = openTabs.filter(tid => !deletedIds.has(tid));
			if (typeof attachmentBlobUrlMap !== "undefined") {
				deletedIds.forEach(did => {
					const u = attachmentBlobUrlMap.get(did);
					if (u) {
						URL.revokeObjectURL(u);
						attachmentBlobUrlMap.delete(did);
					}
				});
			}
			if (deletedIds.has(selectedId)) {
				selectedId = openTabs.length > 0 ? openTabs[openTabs.length - 1] : null;
				await loadFile();
			}
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

		const oldName = src.name;
		const oldFullPath = getPath(srcId);
		const oldPathParts = oldFullPath.slice(0, -1).map(x => x.name);

		const op = findParent(files, srcId);
		if (op) op.children = op.children.filter(n => n.id !== srcId);
		else files = files.filter(n => n.id !== srcId);

		let arr = files;
		let tp = null;
		if (tgtId) {
			const tgt = findNode(files, tgtId);
			if (tgt) {
				arr = tgt.type === "folder" ? tgt.children : (findParent(files, tgtId)?.children || files);
				tp = tgt.type === "folder" ? tgt : findParent(files, tgtId);
			}
		}

		if (nameExistsInArray(arr, src.name, src.id)) {
			src.name = uniqueNodeName(arr, src.name, src.id);
		}

		arr.push(src);
		if (tp) tp.isOpen = true;

		const newFullPath = getPath(srcId);
		const newPathParts = newFullPath.slice(0, -1).map(x => x.name);
		if (oldPathParts.join("/") !== newPathParts.join("/") || oldName !== src.name) {
			queueDiskDeletion(oldPathParts, oldName);
			const clearDiskContent = (node) => {
				delete node._diskContent;
				if (node.children) node.children.forEach(clearDiskContent);
			};
			clearDiskContent(src);
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

		let isCancelled = false;
		const commit = () => {
			if (isCancelled) return;
			inlineRenameId = null;
			const newName = input.value.trim();
			if (!newName || newName === n.name) { render(); return; }
			if (newName === "." || newName === ".." || /[\\/:*?"<>|]/.test(newName)) {
				showAlertModal("Invalid name", "Names cannot be '.' or '..' and cannot contain any of the following characters: \\ / : * ? \" < > |");
				render();
				return;
			}
			const p = findParent(files, id);
			const arr = p ? p.children : files;
			if (nameExistsInArray(arr, newName, id)) {
				showAlertModal("Duplicate name", `"${newName}" already exists here.`);
				render(); return;
			}
			const fullPath = getPath(id);
			const pathParts = fullPath.slice(0, -1).map(x => x.name);
			queueDiskDeletion(pathParts, n.name);
			n.name = newName;
			const clearDiskContent = (node) => {
				delete node._diskContent;
				if (node.children) node.children.forEach(clearDiskContent);
			};
			clearDiskContent(n);
			persistCurrent(); syncWorkspace(); render();
			if (selectedId === id && n.type === "file") {
				loadFile();
			}
		};

		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); input.blur(); }
			if (e.key === "Escape") { isCancelled = true; inlineRenameId = null; render(); }
		});
	}

	// ============================================================
	// EXPORT / IMPORT
	// ============================================================
	window.exportAll = async function () {
		await autoSaveCurrentFile();
		const zip = new JSZip();
		addToZip(zip, files);
		const blob = await zip.generateAsync({ type: "blob" });
		const exportName = (sidebarWsName?.textContent || "export").replace(/[/\\:*?"<>|]/g, "_").trim() || "export";
		downloadBlob(blob, `${exportName}.zip`);
	};
	window.exportFolder = async function (id) {
		await autoSaveCurrentFile();
		const n = findNode(files, id);
		if (!n || n.type !== "folder") return;
		const zip = new JSZip();
		addToZip(zip.folder(n.name), n.children);
		const blob = await zip.generateAsync({ type: "blob" });
		const folderName = (n.name || "folder").replace(/[/\\:*?"<>|]/g, "_").trim() || "folder";
		downloadBlob(blob, `${folderName}.zip`);
	};
	function addToZip(zipObj, nodes) {
		for (const n of nodes) {
			if (n.type === "file") {
				if (isImageFile(n.name) || n.isBinary) {
					zipObj.file(n.name, n.content, { binary: true });
				} else {
					zipObj.file(n.name, n.content || "");
				}
			} else {
				addToZip(zipObj.folder(n.name), n.children || []);
			}
		}
	}
	function downloadBlob(blob, name) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		a.style.display = "none";
		document.body.appendChild(a);
		a.click();
		setTimeout(() => {
			if (a.parentNode) a.parentNode.removeChild(a);
			URL.revokeObjectURL(url);
		}, 1000);
	}

	window.handleImport = async function (event) {
		const file = event.target.files[0];
		if (!file) return;

		try {
			const buffer = await file.arrayBuffer();
			const zip = await JSZip.loadAsync(buffer);
			const folders = { "": files };

			const fileEntries = [];
			zip.forEach((rel, entry) => {
				if (entry.dir) return;
				const normalized = rel.replace(/\\/g, "/");
				fileEntries.push({ path: normalized, entry });
			});

			// Synchronously build folder hierarchy to prevent race conditions (ZIP-01, ZIP-02, AUDIT-12)
			for (const { path } of fileEntries) {
				const parts = resolveSafeZipPath(path);
				const fname = parts.pop();
				if (!fname) continue;
				let arr = files, curPath = "";
				for (const dir of parts) {
					const fp = curPath ? `${curPath}/${dir}` : dir;
					if (!folders[fp]) {
						let existingFolder = arr.find(n => n.type === "folder" && n.name.toLowerCase() === dir.toLowerCase());
						if (!existingFolder) {
							existingFolder = { id: uid("folder"), name: dir, type: "folder", isOpen: true, children: [] };
							arr.push(existingFolder);
						}
						folders[fp] = existingFolder.children;
					}
					arr = folders[fp];
					curPath = fp;
				}
			}

			// Asynchronously read all file contents
			await Promise.all(fileEntries.map(async ({ path, entry }) => {
				const parts = resolveSafeZipPath(path);
				const fname = parts.pop();
				if (!fname) return;
				const isImg = isImageFile(fname);
				let content;
				if (isImg) {
					content = await entry.async("blob");
				} else {
					content = await entry.async("string");
				}
				const dirPath = parts.join("/");
				const arr = folders[dirPath] || files;
				const safeName = uniqueNodeName(arr, fname);
				arr.push({
					id: uid("file"),
					name: safeName,
					type: "file",
					content,
					isBinary: isImg,
					mimeType: isImg ? getImageMimeType(fname) : "text/plain"
				});
			}));

			persistCurrent();
			render();
			syncWorkspace();
			showAlertModal("Import complete", "Imported successfully.");
		} catch (err) {
			console.error("Failed to import ZIP:", err);
			showAlertModal("Import Failed", "The selected file is not a valid ZIP archive: " + (err.message || err));
		} finally {
			event.target.value = "";
		}
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
		if (!isWordWrap) updateLineNumbers();
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
		localStorage.setItem("keeplocal_global_theme", theme);
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
			input.blur();
			searchQuery = "";
			render();
		}
	};

	window.closeSearchBar = function () {
		const wrapper = document.getElementById("searchBarWrapper");
		const input = document.getElementById("searchInput");
		if (!wrapper) return;
		wrapper.classList.add("hidden");
		if (input) {
			input.value = "";
			input.blur();
			searchQuery = "";
			render();
		}
	};

	window.handleSearch = function () {
		searchQuery = document.getElementById("searchInput").value.toLowerCase();
		render();
	};

	const searchInputEl = document.getElementById("searchInput");
	if (searchInputEl) {
		searchInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				closeSearchBar();
			}
		});
	}

	// ============================================================
	// EDITOR TABS (VS Code Style)
	// ============================================================
	window.openTab = async function (id) {
		if (!id) return;
		if (selectedId === id) {
			if (!openTabs.includes(id)) {
				openTabs.push(id);
				renderTabs();
			}
			return;
		}
		if (isOpenTabInProgress) return;
		isOpenTabInProgress = true;
		try {
			if (selectedId) {
				await autoSaveCurrentFile();
			}
			if (!openTabs.includes(id)) {
				openTabs.push(id);
			}
			selectedId = id;
			document.querySelectorAll(".file-item.active").forEach(x => x.classList.remove("active"));
			const activeEl = fileTreeEl?.querySelector(`[data-id="${id}"]`);
			if (activeEl) activeEl.classList.add("active");
			persistCurrent();
			renderTabs();
			await loadFile();
			updateBreadcrumbs();
			if (window.innerWidth <= 768 && window.closeMobileSidebar) {
				window.closeMobileSidebar();
			}
		} finally {
			isOpenTabInProgress = false;
		}
	};

	window.closeTab = async function (id, event) {
		if (event) event.stopPropagation();
		if (selectedId === id) {
			await autoSaveCurrentFile();
		}

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
		await openTab(id);
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
					closeTab(id, e);
				}
			};

			tabsListEl.appendChild(tab);
		});

		if (window.lucide) window.lucide.createIcons();
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
		if (window.lucide) window.lucide.createIcons();
	}

	function renderTree(nodes, container, depth) {
		for (const node of nodes) {
			let show = true, hasChild = false, nameMatches = false;
			if (searchQuery) {
				if (node.type === "file") {
					show = node.name.toLowerCase().includes(searchQuery) || (typeof node.content === "string" && node.content.toLowerCase().includes(searchQuery));
				} else {
					nameMatches = node.name.toLowerCase().includes(searchQuery);
					hasChild = checkMatchingChild(node, searchQuery);
					show = nameMatches || hasChild;
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
			el.onclick = async (e) => {
				if (e.target.closest(".action-btn")) return;
				if (node.type === "folder") {
					node.isOpen = !node.isOpen;
					persistCurrent();
					// In-place DOM toggle without full tree re-render
					const iconWrap = el.querySelector(".icon");
					if (iconWrap && window.lucide) {
						iconWrap.innerHTML = `<i data-lucide="${node.isOpen ? 'folder-open' : 'folder'}" size="15"></i>`;
						window.lucide.createIcons();
					}
					const childSubTree = el.nextElementSibling;
					if (childSubTree && childSubTree.classList.contains("folder-children")) {
						childSubTree.style.display = node.isOpen ? "block" : "none";
					} else {
						render();
					}
				} else {
					await openTab(node.id);
				}
			};

			// Right-click
			el.oncontextmenu = (e) => {
				e.preventDefault();
				ctxNodeId = node.id;
				ctxExport.style.display = node.type === "folder" ? "flex" : "none";
				let top = e.clientY, left = e.clientX;
				if (top + 120 > window.innerHeight) top = Math.max(8, window.innerHeight - 120);
				if (left + 170 > window.innerWidth) left = Math.max(8, window.innerWidth - 170);
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
			bash: "terminal", sql: "database",
			png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", svg: "image",
			bmp: "image", ico: "image", avif: "image"
		};
		return m[ext] || "file";
	}

	function checkMatchingChild(folder, q) {
		if (!folder.children) return false;
		return folder.children.some(c =>
			c.type === "file"
				? c.name.toLowerCase().includes(q) || (typeof c.content === "string" && c.content.toLowerCase().includes(q))
				: (c.name.toLowerCase().includes(q) || checkMatchingChild(c, q))
		);
	}

	function updateBreadcrumbs() {
		breadcrumbEl.innerHTML = "";
		const path = getPath(selectedId);
		path.forEach(n => {
			const span = document.createElement("span");
			span.className = "breadcrumb-item";
			span.textContent = n.name;
			span.onclick = async () => {
				if (selectedId === n.id) return;
				if (n.type === "file") {
					await openTab(n.id);
				} else {
					n.isOpen = true;
					persistCurrent();
					render();
				}
			};
			breadcrumbEl.appendChild(span);
		});
	}

	// ============================================================
	// EDITOR.JS MARKDOWN BRIDGE (Delegated to KeepLocalMarkdown)
	// ============================================================
	function sanitizeUrl(url) {
		return KeepLocalMarkdown.sanitizeUrl(url);
	}

	function parseStandaloneImage(str) {
		return KeepLocalMarkdown.parseStandaloneImage(str);
	}

	function replaceMarkdownLinksAndImages(text, sanitizeUrlFn) {
		return KeepLocalMarkdown.replaceMarkdownLinksAndImages(text, sanitizeUrlFn);
	}

	async function compressDataUrl(dataUrl, maxWidth = 1200, maxHeight = 1200, quality = 0.78) {
		return KeepLocalMarkdown.compressDataUrl(dataUrl, maxWidth, maxHeight, quality);
	}

	async function compressImageFile(file, maxWidth = 1200, maxHeight = 1200, quality = 0.78) {
		return KeepLocalMarkdown.compressImageFile(file, maxWidth, maxHeight, quality);
	}

	function textToBlocks(text) {
		return KeepLocalMarkdown.textToBlocks(text);
	}

	window.textToBlocks = textToBlocks;

	function md2h(s) {
		return KeepLocalMarkdown.md2h(s);
	}

	function h2md(s) {
		return KeepLocalMarkdown.h2md(s);
	}

	function blocksToText(data) {
		return KeepLocalMarkdown.blocksToText(data);
	}

	window.blocksToText = blocksToText;

	// ============================================================
	// EDITOR.JS
	// ============================================================
	window.switchEditorMode = async function (mode) {
		const f = selectedId ? findNode(files, selectedId) : null;
		const hasFile = !!(f && f.type === "file");
		const isMarkdown = hasFile && isMarkdownFile(f?.name);
		if (!isMarkdown) return;
		if (editorMode === mode) return;
		await autoSaveCurrentFile();
		editorMode = mode;
		try { localStorage.setItem("keeplocal_editor_mode", mode); } catch (_) { }
		updateEditorModeUI();
		if (activeWsId) saveWsConfig(activeWsId);
		await loadFile();
	};

	async function initOrUpdateEditorJs(content) {
		const blocks = textToBlocks(content);
		if (editorInstance) {
			try {
				await editorInstance.isReady;
				await editorInstance.render({ blocks });
				return;
			} catch (e) {
				try { editorInstance.destroy(); } catch (_) { }
				editorInstance = null;
			}
		}
		await createEditorJsInstance(blocks);
	}

	async function createEditorJsInstance(blocks) {
		if (typeof EditorJS === "undefined") return;
		editorjsWrapper.innerHTML = "";
		const holder = document.createElement("div");
		holder.id = "editorjs-holder";
		editorjsWrapper.appendChild(holder);

		const tools = {};
		tools.paragraph = { config: { preserveBlank: true }, inlineToolbar: true };
		if (typeof Header !== "undefined") {
			tools.header = {
				class: Header,
				config: {
					placeholder: "Heading",
					levels: [1, 2, 3, 4, 5, 6],
					defaultLevel: 2
				},
				inlineToolbar: true
			};
		}
		const ListTool = typeof NestedList !== "undefined" ? NestedList : (typeof List !== "undefined" ? List : null);
		if (ListTool) tools.list = { class: ListTool, inlineToolbar: true };
		if (typeof Checklist !== "undefined") tools.checklist = { class: Checklist, inlineToolbar: true };
		if (typeof Quote !== "undefined") {
			class CustomQuoteTool extends Quote {
				render() {
					const container = super.render();
					const textEl = container.querySelector(`.${this.css.text}`);
					const captionEl = container.querySelector(`.${this.css.caption}`);

					const handleKeydown = (e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							document.execCommand("insertLineBreak");
							return;
						}
						if (e.key === "Backspace") {
							const targetEl = e.currentTarget;
							const sel = window.getSelection();
							if (!sel || !sel.rangeCount) return;
							const range = sel.getRangeAt(0);
							try {
								const preRange = document.createRange();
								preRange.setStart(targetEl, 0);
								preRange.setEnd(range.startContainer, range.startOffset);
								const preText = preRange.toString();
								if (preText.length > 0 || (range.startContainer !== targetEl && targetEl.firstChild && range.startContainer !== targetEl.firstChild)) {
									e.stopPropagation();
								}
							} catch (_) { }
						}
					};

					textEl?.addEventListener("keydown", handleKeydown, true);
					captionEl?.addEventListener("keydown", handleKeydown, true);
					return container;
				}
			}
			tools.quote = { class: CustomQuoteTool, inlineToolbar: true };
		}
		if (typeof Warning !== "undefined") {
			class CustomWarningTool extends Warning {
				static get toolbox() {
					return {
						icon: Warning.toolbox.icon,
						title: "Callout"
					};
				}
			}
			tools.warning = {
				class: CustomWarningTool,
				inlineToolbar: true,
				config: {
					titlePlaceholder: "Title",
					messagePlaceholder: "Message"
				}
			};
		}
		if (typeof Delimiter !== "undefined") {
			class CustomDelimiterTool extends Delimiter {
				static get toolbox() {
					return {
						icon: Delimiter.toolbox.icon,
						title: "Divider"
					};
				}
			}
			tools.delimiter = { class: CustomDelimiterTool };
		}
		if (typeof SimpleImage !== "undefined") {
			class CustomImageTool extends SimpleImage {
				static get toolbox() {
					return {
						icon: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
						title: "Image"
					};
				}
				constructor({ data, config, api, readOnly }) {
					super({ data, config, api, readOnly });
					this._originalUrl = data?.url || "";
					this._servingResolvedUrl = false;
				}
				get data() {
					if (this._servingResolvedUrl) {
						return {
							...this._data,
							url: resolveAttachmentUrl(this._originalUrl || this._data?.url || "")
						};
					}
					return {
						...this._data,
						url: this._originalUrl || this._data?.url || ""
					};
				}
				set data(val) {
					if (!val) return;
					if (typeof val.url !== "undefined") {
						if (!val.url.startsWith("blob:") || !this._originalUrl) {
							this._originalUrl = val.url;
						}
					}
					const targetUrl = this._originalUrl || val.url || "";
					const resolved = resolveAttachmentUrl(targetUrl);
					this._data = Object.assign({}, this._data, val, { url: targetUrl });
					if (this.nodes?.image) {
						if (resolved) {
							this.nodes.image.src = resolved;
						} else {
							this.nodes.image.removeAttribute("src");
						}
					}
					if (this.nodes?.caption && typeof val.caption !== "undefined") {
						this.nodes.caption.innerHTML = val.caption;
					}
				}
				_cleanWrapperInputs() {
					if (!this.nodes?.wrapper) return;
					const urlInput = this.nodes.wrapper.querySelector(".ce-image-url-input");
					if (urlInput) urlInput.remove();
					const errBox = this.nodes.wrapper.querySelector(".ce-image-error-box");
					if (errBox) errBox.remove();
				}
				async onDropHandler(file) {
					const relPath = await saveImageToAttachments(file);
					this._originalUrl = relPath;
					this._cleanWrapperInputs();
					return { url: relPath, caption: file.name || "image" };
				}
				async onPaste(e) {
					this._cleanWrapperInputs();
					switch (e.type) {
						case "tag": {
							const src = e.detail?.data?.src || "";
							if (src.startsWith("data:image/")) {
								const relPath = await saveImageToAttachments(src);
								this._originalUrl = relPath;
								this.data = { url: relPath };
							} else if (src) {
								this._originalUrl = src;
								this.data = { url: src };
							}
							break;
						}
						case "pattern": {
							const url = e.detail?.data || "";
							if (url) {
								this._originalUrl = url;
								this.data = { url };
							}
							break;
						}
						case "file": {
							const file = e.detail?.file;
							if (file) {
								const relPath = await saveImageToAttachments(file);
								this._originalUrl = relPath;
								this.data = { url: relPath, caption: file.name || "image" };
							}
							break;
						}
						default:
							super.onPaste(e);
					}
				}
				save(blockContent) {
					const captionEl = blockContent?.querySelector(`.${this.CSS.caption}`) || blockContent?.querySelector('[contenteditable]');
					let url = this._originalUrl || (this.data?.url ? this.data.url : "");
					if (url && url.startsWith("blob:") && typeof attachmentBlobUrlMap !== "undefined") {
						for (const [key, blobUrl] of attachmentBlobUrlMap.entries()) {
							if (blobUrl === url && key.startsWith("attachments/")) {
								url = key;
								break;
							}
						}
					}
					return {
						url,
						caption: captionEl ? captionEl.innerHTML : (this.data?.caption || ""),
						withBorder: !!this.data?.withBorder,
						withBackground: !!this.data?.withBackground,
						stretched: !!this.data?.stretched,
						tight: !!this.data?.tight
					};
				}
				_acceptTuneView() {
					this.tunes.forEach(tune => {
						if (this.nodes?.imageHolder) {
							const cls = this.CSS.imageHolder + "--" + tune.name.replace(/([A-Z])/g, t => `-${t[0].toLowerCase()}`);
							this.nodes.imageHolder.classList.toggle(cls, !!this.data[tune.name]);
						}
						if (tune.name === "stretched") {
							const block = (typeof this.api?.blocks?.getBlockByIndex === "function")
								? (this.api.blocks.getBlockByIndex(this.blockIndex) || this.api.blocks.getBlockByIndex(this.api.blocks.getCurrentBlockIndex()))
								: null;
							if (block && typeof block.stretched !== "undefined") {
								block.stretched = !!this.data.stretched;
							}
						}
					});
				}
				render() {
					const origUrl = this._originalUrl || this.data?.url || "";
					this._originalUrl = origUrl;
					const resolvedUrl = resolveAttachmentUrl(origUrl);

					this._servingResolvedUrl = true;
					const container = super.render();
					this._servingResolvedUrl = false;

					// Add error and timeout handling so image never spins forever
					const attachErrorHandler = () => {
						if (!this.nodes?.image) return;
						const imgEl = this.nodes.image;

						const showError = () => {
							const loader = container.querySelector(`.${this.CSS.loading}`);
							if (loader) loader.remove();
							container.classList.remove(this.CSS.loading);

							if (!container.querySelector(".ce-image-error-box")) {
								const errorBox = document.createElement("div");
								errorBox.className = "ce-image-error-box";
								errorBox.style.cssText = "display:flex; align-items:center; gap:8px; padding:10px 14px; background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:6px; color:var(--text-danger, #ef4444); font-size:12px; margin:8px 0;";
								const displayUrl = (this._originalUrl || "").length > 60 ? ((this._originalUrl || "").slice(0, 60) + "…") : (this._originalUrl || "image");
								errorBox.innerHTML = `
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="14" y2="16"/></svg>
									<span>Unable to load image: <code style="font-size:11px; word-break:break-all;">${escHtml(displayUrl)}</code></span>
								`;
								container.appendChild(errorBox);
							}
							if (this.nodes.caption && !container.contains(this.nodes.caption)) {
								container.appendChild(this.nodes.caption);
							}
						};

						imgEl.addEventListener("error", showError);
						imgEl.addEventListener("load", () => {
							container.querySelector(".ce-image-error-box")?.remove();
							container.querySelector(".ce-image-url-input")?.remove();
						});

						if (origUrl) {
							if (!resolvedUrl) {
								showError();
							} else {
								const timeoutId = setTimeout(() => {
									const loader = container.querySelector(`.${this.CSS.loading}`);
									if (loader) showError();
								}, 7000);
								imgEl.addEventListener("load", () => clearTimeout(timeoutId), { once: true });
							}
						}
					};

					attachErrorHandler();

					if (!origUrl) {
						const urlInput = document.createElement("input");
						urlInput.className = "cdx-input ce-image-url-input";
						urlInput.placeholder = "Paste image URL or image file and press Enter…";
						urlInput.style.cssText = "margin-bottom: 8px;";
						urlInput.addEventListener("keydown", async (e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								const val = urlInput.value.trim();
								if (val) {
									let finalUrl = val;
									if (val.startsWith("data:image/")) {
										finalUrl = await saveImageToAttachments(val);
									}
									this._originalUrl = finalUrl;
									urlInput.remove();
									this.data = { url: finalUrl, caption: this.data.caption || "" };
								}
							}
						});
						urlInput.addEventListener("paste", async (e) => {
							const items = e.clipboardData?.items;
							if (!items) return;
							for (let i = 0; i < items.length; i++) {
								if (items[i].type && items[i].type.startsWith("image/")) {
									const file = items[i].getAsFile();
									if (file) {
										e.preventDefault();
										e.stopPropagation();
										const relPath = await saveImageToAttachments(file);
										this._originalUrl = relPath;
										this._cleanWrapperInputs();
										this.data = { url: relPath, caption: file.name || "image" };
										return;
									}
								}
							}
						});
						container.prepend(urlInput);
					}
					return container;
				}
			}
			tools.image = { class: CustomImageTool, inlineToolbar: true };
		}
		if (typeof CodeTool !== "undefined") {
			class CustomCodeTool extends CodeTool {
				constructor({ data, config, api, readOnly }) {
					super({ data, config, api, readOnly });
					this._language = data && data.language ? data.language : "";
				}
				render() {
					const container = document.createElement("div");
					container.className = "ce-code-wrapper";
					const textarea = super.render();

					const langInput = document.createElement("input");
					langInput.className = "ce-code__lang-input";
					langInput.placeholder = "Language (e.g. js, python)";
					langInput.value = this._language || "";
					langInput.spellcheck = false;
					langInput.addEventListener("input", (e) => {
						this._language = e.target.value.trim();
					});

					container.appendChild(langInput);
					container.appendChild(textarea);
					return container;
				}
				save(blockContent) {
					const res = super.save(blockContent);
					const langInput = blockContent.querySelector(".ce-code__lang-input");
					if (langInput) {
						this._language = langInput.value.trim();
					}
					if (this._language) {
						res.language = this._language;
					}
					return res;
				}
			}
			tools.code = { class: CustomCodeTool };
		}
		if (typeof InlineCode !== "undefined") tools.inlineCode = { class: InlineCode };
		if (typeof Marker !== "undefined") tools.marker = { class: Marker };
		if (typeof Underline !== "undefined") tools.underline = { class: Underline };
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
				const editingId = editorLoadedFileId || selectedId;
				editorSaveTimer = setTimeout(async () => {
					if (!editingId || (selectedId !== editingId && editorLoadedFileId !== editingId)) return;
					const f = findNode(files, editingId);
					if (f?.type === "file" && editorInstance && editorMode === "block") {
						try {
							const d = await editorInstance.save();
							if (selectedId !== editingId && editorLoadedFileId !== editingId) return;
							f.content = blocksToText(d);
							if (editorTextarea) editorTextarea.value = f.content;
							persistCurrent();
							syncWorkspace(false);
						} catch (_) { }
					}
				}, 400);
			}
		});
		window.editorInstance = editorInstance;
		try {
			await editorInstance.isReady;
		} catch (e) {
			console.warn("[KeepLocal] editorInstance.isReady error:", e);
		}
	}

	async function loadFile() {
		let file = findNode(files, selectedId);
		if (!file || file.type !== "file") {
			file = null;
		}

		editorLoadedFileId = null;
		isInitEditor = true;

		const imgViewer = document.getElementById("imageViewerWrapper");

		if (file) {
			const isImg = isImageFile(file.name);
			const isMarkdown = !isImg && isMarkdownFile(file.name);

			if (isImg) {
				hideEditorLoading();
				if (modeSwitchGroup) modeSwitchGroup.classList.add("hidden");
				if (textControlsGroup) textControlsGroup.classList.add("hidden");
				if (modeBlockBtn) modeBlockBtn.disabled = true;
				if (modePlainBtn) modePlainBtn.disabled = true;
				if (editorEmptyState) editorEmptyState.classList.add("hidden");
				editorjsWrapper?.classList.add("hidden");
				plainWrapper?.classList.add("hidden");
				if (imgViewer) {
					imgViewer.classList.remove("hidden");
					loadImageInViewer(file);
				}
				editorLoadedFileId = file.id;
				if (editorStatusSpan) editorStatusSpan.textContent = "Image Viewer";
				if (cursorPosSpan) cursorPosSpan.textContent = file.name;
				isInitEditor = false;
				updateBreadcrumbs();
				return;
			}

			if (imgViewer) imgViewer.classList.add("hidden");
			if (textControlsGroup) textControlsGroup.classList.remove("hidden");

			const text = file.content || "";
			editorTextarea.value = text;
			editorTextarea.disabled = false;
			editorTextarea.placeholder = "Start typing...";

			const codeEl = document.getElementById("codeHighlightContent");
			if (codeEl) codeEl.innerHTML = ""; // prevent stale highlight flash

			if (modeSwitchGroup) {
				if (isMarkdown) {
					modeSwitchGroup.classList.remove("hidden");
				} else {
					modeSwitchGroup.classList.add("hidden");
				}
			}

			if (!isMarkdown) {
				// Code / non-markdown files must open in Raw mode to protect code structure
				if (modeBlockBtn) modeBlockBtn.disabled = true;
			} else {
				if (modeBlockBtn) modeBlockBtn.disabled = false;
			}
			if (modePlainBtn) modePlainBtn.disabled = false;

			if (editorEmptyState) editorEmptyState.classList.add("hidden");

			if (editorMode === "block" && isMarkdown) {
				editorjsWrapper.classList.remove("hidden");
				plainWrapper.classList.add("hidden");
				showEditorLoading("Loading note…");
				try {
					await initOrUpdateEditorJs(text);
				} catch (err) {
					console.warn("[KeepLocal] Error initializing block editor, falling back to Plain mode:", err);
					editorMode = "plain";
					updateEditorModeUI();
					plainWrapper.classList.remove("hidden");
					editorjsWrapper.classList.add("hidden");
				} finally {
					hideEditorLoading();
				}
			} else {
				hideEditorLoading();
				plainWrapper.classList.remove("hidden");
				editorjsWrapper.classList.add("hidden");
			}
			editorLoadedFileId = file.id;
			if (editorStatusSpan) editorStatusSpan.textContent = (editorMode === "block" && isMarkdown) ? "Block Mode" : "Raw Text";
		} else {
			hideEditorLoading();
			if (editorEmptyState) {
				editorEmptyState.classList.remove("hidden");
				if (window.lucide) window.lucide.createIcons();
			}
			editorjsWrapper?.classList.add("hidden");
			plainWrapper?.classList.add("hidden");
			imgViewer?.classList.add("hidden");
			if (modeSwitchGroup) modeSwitchGroup.classList.add("hidden");
			if (textControlsGroup) textControlsGroup.classList.add("hidden");
			if (modeBlockBtn) modeBlockBtn.disabled = true;
			if (modePlainBtn) modePlainBtn.disabled = true;
			editorTextarea.value = "";
			editorTextarea.disabled = true;
			editorLoadedFileId = null;
			if (editorStatusSpan) editorStatusSpan.textContent = "No file open";
			if (cursorPosSpan) cursorPosSpan.textContent = "—";
		}

		isInitEditor = false;
		updateLineNumbers();
		updateBreadcrumbs();
		if (editorMode === "plain") {
			updateCodeHighlighting();
		}
	}
	if (typeof window !== "undefined") {
		window.loadFile = loadFile;
		window.__getFiles = () => files;
		window.__setSelectedId = (id) => { selectedId = id; };
		window.__getSelectedId = () => selectedId;
		window.__setEditorMode = (m) => { editorMode = m; };
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
		if (editorMode !== "plain") return;
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

		// If document contains large base64 images, mask them for Prism display so regex never freezes
		if (val.length > 40 * 1024 && val.includes("data:image/")) {
			val = val.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{80,}/g, "data:image/...;base64,[image-data]");
		}

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

		// Don't run heavy Prism regex on massive documents (>250KB) to ensure silky-smooth typing
		if (val.length > 250 * 1024) return;

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
		const file = findNode(files, selectedId);
		if (!file || file.type !== "file") {
			lineNumbersEl.textContent = "";
			return;
		}
		const count = editorTextarea.value.split("\n").length;
		const nums = [];
		for (let i = 1; i <= count; i++) nums.push(i);
		lineNumbersEl.textContent = nums.join("\n");
	}
	function updateCursor() {
		const file = findNode(files, selectedId);
		if (!file || file.type !== "file") {
			if (cursorPosSpan) cursorPosSpan.textContent = "—";
			return;
		}
		const before = editorTextarea.value.substring(0, editorTextarea.selectionStart);
		const lines = before.split("\n");
		cursorPosSpan.textContent = `Ln ${lines.length}, Col ${lines[lines.length - 1].length + 1}`;
	}

	editorTextarea.addEventListener("input", async () => {
		const targetId = (findNode(files, selectedId)?.type === "file") ? selectedId : editorLoadedFileId;
		const f = findNode(files, targetId);
		if (f?.type === "file") {
			f.content = editorTextarea.value;
			persistCurrent();
			syncWorkspace(false);
		}
		updateLineNumbers();
		updateCodeHighlighting();
	});
	editorTextarea.addEventListener("keydown", (e) => {
		if (e.key === "Tab") {
			e.preventDefault();
			const val = editorTextarea.value;
			const start = editorTextarea.selectionStart;
			const end = editorTextarea.selectionEnd;

			if (e.shiftKey) {
				// Shift+Tab: Unindent (single or multi-line)
				const lineStart = val.lastIndexOf("\n", start - 1) + 1;
				let lineEnd = val.indexOf("\n", end);
				if (lineEnd === -1) lineEnd = val.length;

				const lines = val.substring(lineStart, lineEnd).split("\n");
				let firstLineRemoved = 0;
				let totalRemoved = 0;

				const unindented = lines.map((line, idx) => {
					let removeCount = 0;
					if (line.startsWith("    ")) {
						removeCount = 4;
					} else if (line.startsWith("\t")) {
						removeCount = 1;
					} else {
						const match = line.match(/^ {1,3}/);
						if (match) removeCount = match[0].length;
					}
					if (idx === 0) firstLineRemoved = removeCount;
					totalRemoved += removeCount;
					return line.slice(removeCount);
				});

				editorTextarea.value = val.substring(0, lineStart) + unindented.join("\n") + val.substring(lineEnd);
				editorTextarea.selectionStart = Math.max(lineStart, start - firstLineRemoved);
				editorTextarea.selectionEnd = Math.max(lineStart, end - totalRemoved);
				editorTextarea.dispatchEvent(new Event("input"));
			} else {
				// Tab: Indent
				if (start !== end && val.substring(start, end).includes("\n")) {
					// Multi-line selection: indent each line by prepending 4 spaces
					const lineStart = val.lastIndexOf("\n", start - 1) + 1;
					let lineEnd = val.indexOf("\n", end);
					if (lineEnd === -1) lineEnd = val.length;

					const lines = val.substring(lineStart, lineEnd).split("\n");
					const indented = lines.map(line => "    " + line);
					const addedTotal = 4 * lines.length;

					editorTextarea.value = val.substring(0, lineStart) + indented.join("\n") + val.substring(lineEnd);
					editorTextarea.selectionStart = start + 4;
					editorTextarea.selectionEnd = end + addedTotal;
					editorTextarea.dispatchEvent(new Event("input"));
				} else {
					// Single line / caret: insert 4 spaces
					editorTextarea.value = val.substring(0, start) + "    " + val.substring(end);
					editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 4;
					editorTextarea.dispatchEvent(new Event("input"));
				}
			}
		}
	});
	editorTextarea.addEventListener("keyup", updateCursor);
	editorTextarea.addEventListener("click", updateCursor);
	editorTextarea.addEventListener("focus", updateCursor);

	editorTextarea.addEventListener("paste", async (e) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		for (let i = 0; i < items.length; i++) {
			if (items[i].type && items[i].type.startsWith("image/")) {
				const file = items[i].getAsFile();
				if (file) {
					e.preventDefault();
					const relPath = await saveImageToAttachments(file);
					const mdLink = `![image](${relPath})\n`;
					const start = editorTextarea.selectionStart;
					const end = editorTextarea.selectionEnd;
					const val = editorTextarea.value;
					editorTextarea.value = val.substring(0, start) + mdLink + val.substring(end);
					editorTextarea.selectionStart = editorTextarea.selectionEnd = start + mdLink.length;
					editorTextarea.dispatchEvent(new Event("input"));
					return;
				}
			}
		}
	});

	// Ctrl/Cmd+Wheel → editor font size only
	document.querySelector(".main")?.addEventListener("wheel", (e) => {
		if (e.ctrlKey || e.metaKey) { e.preventDefault(); changeFontSize(e.deltaY < 0 ? 1 : -1); }
	}, { passive: false });

	// ============================================================
	// KEYBOARD SHORTCUTS
	// ============================================================
	document.addEventListener("keydown", async (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
			e.preventDefault();
			if (!activeWsId) return;
			if (workspaceHandle) {
				await autoSaveCurrentFile();
				persistCurrent();
				if (!fsPermissionGranted) {
					await requestReauthorization();
				} else {
					await syncWorkspace(true);
					const prev = wsStatusBadge.textContent;
					wsStatusBadge.textContent = "Saved ✓";
					setTimeout(() => {
						if (workspaceHandle && fsPermissionGranted) wsStatusBadge.textContent = workspaceHandle.name;
					}, 1500);
				}
			} else {
				saveWorkspace();
			}
		}
		// New note shortcut: Alt+N (or Option+N) / Ctrl+N / Cmd+N
		if ((e.altKey || e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "n" || e.code === "KeyN") && !e.shiftKey && activeWsId) {
			e.preventDefault();
			addFile();
		}

		// Close note shortcut: Alt+W (or Option+W)
		if (e.altKey && (e.key.toLowerCase() === "w" || e.code === "KeyW") && activeWsId) {
			e.preventDefault();
			const targetId = (selectedId && findNode(files, selectedId)?.type === "file")
				? selectedId
				: (openTabs.length > 0 ? openTabs[openTabs.length - 1] : null);
			if (targetId) {
				closeTab(targetId);
			}
		}
	});

	document.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
			e.preventDefault();
			toggleTheme();
		}
	});

	// Helper to check if element is an input, textarea, or contenteditable editor
	function isEditableTarget(el) {
		if (!el) return false;
		const tag = el.tagName;
		return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable || (el.closest && !!el.closest('[contenteditable="true"]'));
	}

	// Help shortcuts: '?' toggles help when not typing in editor, F1 or Alt+H toggles anytime
	document.addEventListener("keydown", (e) => {
		// F1 or Alt+H (or Option+H) toggles help from anywhere
		if (e.key === "F1" || (e.altKey && (e.key.toLowerCase() === "h" || e.code === "KeyH"))) {
			e.preventDefault();
			toggleHelpModal();
			return;
		}

		// Ctrl/Cmd + Shift + ? (or Ctrl/Cmd + ?) toggles help
		if ((e.ctrlKey || e.metaKey) && (e.key === "?" || (e.shiftKey && (e.key === "/" || e.code === "Slash")))) {
			e.preventDefault();
			toggleHelpModal();
			return;
		}

		// '?' shortcut toggles help when not typing in an editable field
		if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			if (helpModalOverlay?.classList.contains("active")) {
				e.preventDefault();
				hideHelpModal();
				return;
			}
			// Do not open if another prompt modal is open
			if (modalOverlay?.classList.contains("active")) return;

			if (!isEditableTarget(document.activeElement) && !isEditableTarget(e.target)) {
				e.preventDefault();
				toggleHelpModal();
			}
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
		const newWidth = Math.max(180, Math.min(600, startWidth + (e.clientX - startX)));
		document.documentElement.style.setProperty("--sidebar-width", newWidth + "px");
		sidebar.style.width = "";
	});
	document.addEventListener("mouseup", () => {
		if (!isResizing) return;
		isResizing = false;
		resizeHandle?.classList.remove("active"); sidebar?.classList.remove("resizing");
		document.body.style.cursor = "auto"; document.body.style.userSelect = "auto";
		if (activeWsId) saveWsConfig(activeWsId);
	});

	// ============================================================
	// MOBILE SIDEBAR (A11Y-01)
	// ============================================================
	window.toggleMobileSidebar = function (force) {
		const sb = document.querySelector(".sidebar");
		const backdrop = document.getElementById("sidebarBackdrop");
		if (!sb) return;
		const isOpen = sb.classList.contains("mobile-open");
		const shouldOpen = typeof force === "boolean" ? force : !isOpen;
		if (shouldOpen) {
			sb.classList.add("mobile-open");
			if (backdrop) {
				backdrop.classList.remove("hidden");
				requestAnimationFrame(() => backdrop.classList.add("active"));
			}
		} else {
			sb.classList.remove("mobile-open");
			if (backdrop) {
				backdrop.classList.remove("active");
				setTimeout(() => {
					if (!sb.classList.contains("mobile-open")) {
						backdrop.classList.add("hidden");
					}
				}, 250);
			}
		}
	};

	window.closeMobileSidebar = function () {
		window.toggleMobileSidebar(false);
	};

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			const sb = document.querySelector(".sidebar");
			if (sb?.classList.contains("mobile-open")) {
				window.closeMobileSidebar();
			}
		}
	});

	// ============================================================
	// FILE TREE DRAG DROP
	// ============================================================
	fileTreeEl.addEventListener("click", async (e) => {
		if (e.target === fileTreeEl) {
			if (openTabs.length === 0 && selectedId) {
				await autoSaveCurrentFile();
				selectedId = null;
				render();
				persistCurrent();
				await loadFile();
			}
		}
	});
	fileTreeEl.ondragover = (e) => e.preventDefault();
	fileTreeEl.ondrop = () => { if (draggedId) moveNode(draggedId, null); };

	// ============================================================
	// BEFOREUNLOAD FLUSH
	// ============================================================
	window.addEventListener("beforeunload", (e) => {
		if (editorSaveTimer !== null) {
			e.preventDefault();
			e.returnValue = "";
		}
		const targetId = (findNode(files, selectedId)?.type === "file") ? selectedId : editorLoadedFileId;
		if (targetId && editorTextarea) {
			const f = findNode(files, targetId);
			if (f?.type === "file" && !isImageFile(f.name) && !f.isBinary) {
				const isMarkdown = isMarkdownFile(f.name);
				if (editorMode === "plain" || !isMarkdown) {
					f.content = editorTextarea.value;
					persistCurrent();
				}
			}
		}
	});

	// ============================================================
	// INIT
	// ============================================================
	await KeepLocalDB.migrateFromLocalStorage();
	await loadWorkspaceMeta();

	// Apply last saved theme
	const globalTheme = localStorage.getItem("keeplocal_global_theme") || "dark";
	theme = globalTheme;
	document.body.setAttribute("data-theme", theme);

	// Parse initial route (supports #/workspaces, ?view=workspaces, ?safe=1, /workspaces, #/workspace/:id)
	function getInitialRoute() {
		const hash = (window.location.hash || "").replace(/^#\/?/, "").toLowerCase();
		const search = new URLSearchParams(window.location.search);
		const viewParam = (search.get("view") || "").toLowerCase();
		const isSafe = search.has("safe") || search.has("recovery");
		const path = window.location.pathname.toLowerCase();

		if (isSafe || viewParam === "workspaces" || hash === "workspaces" || path.endsWith("/workspaces")) {
			return { view: "workspaces" };
		}
		if (hash.startsWith("workspace/")) {
			const wsId = window.location.hash.replace(/^#\/?workspace\//i, "").trim();
			return { view: "editor", wsId };
		}
		return null;
	}

	const initialRoute = getInitialRoute();

	if (initialRoute?.view === "workspaces") {
		try { localStorage.removeItem("keeplocal_active_ws_id"); } catch (_) { }
		showWelcome();
	} else if (initialRoute?.view === "editor" && initialRoute.wsId) {
		const targetWs = workspaces.find(w => w.id === initialRoute.wsId);
		if (targetWs) {
			await openWorkspace(targetWs.id);
		} else {
			showWelcome();
		}
	} else {
		// Check for last active workspace or show welcome screen
		const lastActiveWsId = localStorage.getItem("keeplocal_active_ws_id");
		const targetWs = workspaces.find(w => w.id === lastActiveWsId);

		if (targetWs) {
			await openWorkspace(targetWs.id);
		} else {
			showWelcome();
		}
	}

	// Listen for route changes (e.g. Back/Forward browser navigation)
	window.addEventListener("hashchange", () => {
		const currentHash = (window.location.hash || "").replace(/^#\/?/, "").toLowerCase();
		if (currentHash === "workspaces" && activeWsId) {
			goHome();
		} else if (currentHash.startsWith("workspace/")) {
			const wsId = window.location.hash.replace(/^#\/?workspace\//i, "").trim();
			if (wsId && wsId !== activeWsId) {
				openWorkspace(wsId);
			}
		}
	});

	// First time visit: show product onboarding & help modal
	const hasSeenHelp = localStorage.getItem("keeplocal_help_seen");
	if (!hasSeenHelp) {
		localStorage.setItem("keeplocal_help_seen", "true");
		setTimeout(() => {
			openHelpModal();
		}, 200);
	}
});

// ============================================================
// SERVICE WORKER REGISTRATION (ARCH-01)
// ============================================================
if ("serviceWorker" in navigator && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("./sw.js").catch((err) => {
			console.warn("[KeepLocal] Service Worker registration failed:", err);
		});
	});
}

