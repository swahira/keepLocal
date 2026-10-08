/* ============================================================
   KEEPLOCAL — db.js
   Modular IndexedDB Storage Engine (v2)
   Provides asynchronous, non-blocking storage with Gigabyte capacity.
   ============================================================ */

(function (global) {
	"use strict";

	const DB_NAME = "keeplocal_db";
	const DB_VERSION = 2;

	const STORES = {
		HANDLES: "handles",       // FileSystemDirectoryHandle references (v1 legacy)
		WORKSPACES: "workspaces", // Workspace metadata list
		FILES: "files",           // File tree nodes per workspace id
		CONFIG: "config",         // Workspace settings, tabs, view state
		DELETIONS: "deletions"    // Pending disk deletions for folder sync
	};

	let dbInstance = null;
	let dbOpenPromise = null;

	/**
	 * Open or reuse IndexedDB connection with schema migration
	 */
	function openDB() {
		if (dbInstance) return Promise.resolve(dbInstance);
		if (dbOpenPromise) return dbOpenPromise;

		dbOpenPromise = new Promise((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				return reject(new Error("IndexedDB is not supported in this browser environment"));
			}

			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onupgradeneeded = (event) => {
				const db = event.target.result;

				// Store 1: Handles (v1 compatibility)
				if (!db.objectStoreNames.contains(STORES.HANDLES)) {
					db.createObjectStore(STORES.HANDLES);
				}

				// Store 2: Workspaces metadata
				if (!db.objectStoreNames.contains(STORES.WORKSPACES)) {
					db.createObjectStore(STORES.WORKSPACES);
				}

				// Store 3: Workspace files tree
				if (!db.objectStoreNames.contains(STORES.FILES)) {
					db.createObjectStore(STORES.FILES);
				}

				// Store 4: Workspace config
				if (!db.objectStoreNames.contains(STORES.CONFIG)) {
					db.createObjectStore(STORES.CONFIG);
				}

				// Store 5: Pending deletions
				if (!db.objectStoreNames.contains(STORES.DELETIONS)) {
					db.createObjectStore(STORES.DELETIONS);
				}
			};

			request.onsuccess = (event) => {
				dbInstance = event.target.result;
				dbInstance.onversionchange = () => {
					dbInstance.close();
					dbInstance = null;
					dbOpenPromise = null;
				};
				resolve(dbInstance);
			};

			request.onerror = (event) => {
				dbOpenPromise = null;
				reject(event.target.error || new Error("Failed to open IndexedDB"));
			};
		});

		return dbOpenPromise;
	}

	/**
	 * Generic IDB transaction helper
	 */
	async function withStore(storeName, mode, callback) {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, mode);
			const store = tx.objectStore(storeName);

			let result;
			try {
				result = callback(store);
			} catch (err) {
				return reject(err);
			}

			let requestResult;
			let isResolved = false;

			if (result && typeof result.onsuccess !== "undefined") {
				result.onsuccess = (e) => {
					requestResult = e.target.result;
					if (mode === "readonly") {
						isResolved = true;
						resolve(requestResult);
					}
				};
				result.onerror = (e) => {
					if (!isResolved) reject(e.target.error);
				};
			}

			tx.oncomplete = () => {
				if (!isResolved) {
					isResolved = true;
					resolve(typeof requestResult !== "undefined" ? requestResult : result);
				}
			};
			tx.onerror = (e) => {
				if (!isResolved) reject(e.target.error);
			};
			tx.onabort = (e) => {
				if (!isResolved) reject(e.target.error || new Error("Transaction aborted"));
			};
		});
	}

	// ============================================================
	// CRUD OPERATIONS
	// ============================================================

	/**
	 * Get value by key from a store
	 */
	async function get(storeName, key) {
		return withStore(storeName, "readonly", (store) => store.get(key));
	}

	/**
	 * Put value by key in a store
	 */
	async function set(storeName, key, val) {
		return withStore(storeName, "readwrite", (store) => store.put(val, key));
	}

	/**
	 * Delete value by key from a store
	 */
	async function del(storeName, key) {
		return withStore(storeName, "readwrite", (store) => store.delete(key));
	}

	// ============================================================
	// WORKSPACES
	// ============================================================

	async function getWorkspaces() {
		try {
			const res = await get(STORES.WORKSPACES, "list");
			return Array.isArray(res) ? res : [];
		} catch (err) {
			console.warn("[KeepLocalDB] getWorkspaces error:", err);
			return [];
		}
	}

	async function saveWorkspaces(workspaces) {
		try {
			await set(STORES.WORKSPACES, "list", workspaces || []);
		} catch (err) {
			console.error("[KeepLocalDB] saveWorkspaces error:", err);
			throw err;
		}
	}

	// ============================================================
	// FILES
	// ============================================================

	async function getFiles(wsId) {
		if (!wsId) return [];
		try {
			const res = await get(STORES.FILES, wsId);
			return Array.isArray(res) ? res : [];
		} catch (err) {
			console.warn(`[KeepLocalDB] getFiles(${wsId}) error:`, err);
			return [];
		}
	}

	async function saveFiles(wsId, files) {
		if (!wsId) return;
		try {
			await set(STORES.FILES, wsId, files || []);
		} catch (err) {
			console.error(`[KeepLocalDB] saveFiles(${wsId}) error:`, err);
			throw err;
		}
	}

	// ============================================================
	// CONFIG & STATE
	// ============================================================

	async function getConfig(wsId) {
		if (!wsId) return null;
		try {
			return (await get(STORES.CONFIG, wsId)) || null;
		} catch (err) {
			console.warn(`[KeepLocalDB] getConfig(${wsId}) error:`, err);
			return null;
		}
	}

	async function saveConfig(wsId, config) {
		if (!wsId) return;
		try {
			await set(STORES.CONFIG, wsId, config || {});
		} catch (err) {
			console.error(`[KeepLocalDB] saveConfig(${wsId}) error:`, err);
		}
	}

	async function getDeletions(wsId) {
		if (!wsId) return [];
		try {
			const res = await get(STORES.DELETIONS, wsId);
			return Array.isArray(res) ? res : [];
		} catch (_) {
			return [];
		}
	}

	async function saveDeletions(wsId, deletions) {
		if (!wsId) return;
		try {
			await set(STORES.DELETIONS, wsId, deletions || []);
		} catch (_) { }
	}

	// ============================================================
	// HANDLES (FileSystem Access API)
	// ============================================================

	async function getHandle(wsId) {
		if (!wsId) return null;
		try {
			return (await get(STORES.HANDLES, `handle_${wsId}`)) || null;
		} catch (_) {
			return null;
		}
	}

	async function saveHandle(wsId, handle) {
		if (!wsId) return;
		try {
			await set(STORES.HANDLES, `handle_${wsId}`, handle);
		} catch (err) {
			console.warn(`[KeepLocalDB] saveHandle(${wsId}) error:`, err);
		}
	}

	async function deleteWorkspaceData(wsId) {
		if (!wsId) return;
		try {
			await Promise.all([
				del(STORES.FILES, wsId),
				del(STORES.CONFIG, wsId),
				del(STORES.DELETIONS, wsId),
				del(STORES.HANDLES, `handle_${wsId}`)
			]);
		} catch (err) {
			console.warn(`[KeepLocalDB] deleteWorkspaceData(${wsId}) error:`, err);
		}
	}

	// ============================================================
	// STORAGE ESTIMATION (GB Capacity)
	// ============================================================

	async function getStorageEstimate() {
		if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
			try {
				const est = await navigator.storage.estimate();
				const usage = est.usage || 0;
				const quota = est.quota || (1024 * 1024 * 1024 * 2); // Default fallback: 2GB
				const percentage = Math.min(100, Math.round((usage / quota) * 100));
				return { usage, quota, percentage, isSupported: true };
			} catch (_) { }
		}
		return { usage: 0, quota: 1024 * 1024 * 1024, percentage: 0, isSupported: false };
	}

	// ============================================================
	// TRANSPARENT MIGRATION FROM LOCALSTORAGE
	// ============================================================

	async function migrateFromLocalStorage() {
		if (typeof localStorage === "undefined") return { migrated: false };

		const MIGRATION_FLAG = "keeplocal_migrated_to_idb_v2";
		if (localStorage.getItem(MIGRATION_FLAG) === "true") {
			return { migrated: false, alreadyDone: true };
		}

		console.log("[KeepLocalDB] Starting transparent migration from localStorage to IndexedDB...");
		let migratedWorkspacesCount = 0;

		try {
			// 1. Migrate workspaces metadata
			const rawWs = localStorage.getItem("keeplocal_workspaces");
			let wsList = [];
			if (rawWs) {
				try {
					wsList = JSON.parse(rawWs);
					if (Array.isArray(wsList) && wsList.length > 0) {
						await saveWorkspaces(wsList);
					}
				} catch (e) {
					console.warn("[KeepLocalDB] Error parsing legacy workspaces during migration:", e);
				}
			}

			// 1b. Support migration from pre-workspace version (keeplocal_files)
			const oldSingleFiles = localStorage.getItem("keeplocal_files");
			const oldSingleCfg = localStorage.getItem("keeplocal_config");
			if (oldSingleFiles && wsList.length === 0) {
				try {
					const migFiles = JSON.parse(oldSingleFiles);
					const migCfg = oldSingleCfg ? JSON.parse(oldSingleCfg) : {};
					const wsId = "ws_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
					const defaultWs = {
						id: wsId,
						name: "My Notes",
						createdAt: Date.now(),
						lastOpenedAt: Date.now(),
						folderName: null,
						fileCount: Array.isArray(migFiles) ? migFiles.length : 0
					};
					wsList = [defaultWs];
					await saveWorkspaces(wsList);
					await saveFiles(wsId, migFiles);
					if (migCfg) await saveConfig(wsId, migCfg);
					try {
						localStorage.removeItem("keeplocal_files");
						localStorage.removeItem("keeplocal_config");
					} catch (_) { }
					migratedWorkspacesCount++;
				} catch (e) {
					console.warn("[KeepLocalDB] Error migrating legacy single-workspace data:", e);
				}
			}

			// 2. Migrate each workspace's files, config, deletions
			for (const ws of wsList) {
				if (!ws || !ws.id) continue;
				const wsId = ws.id;

				// Files
				const rawFiles = localStorage.getItem(`keeplocal_files_${wsId}`);
				if (rawFiles) {
					try {
						const files = JSON.parse(rawFiles);
						if (Array.isArray(files)) {
							await saveFiles(wsId, files);
							migratedWorkspacesCount++;
							// Clear large file payloads from localStorage to free up space
							localStorage.removeItem(`keeplocal_files_${wsId}`);
						}
					} catch (e) {
						console.warn(`[KeepLocalDB] Error migrating files for workspace ${wsId}:`, e);
					}
				}

				// Config
				const rawCfg = localStorage.getItem(`keeplocal_cfg_${wsId}`);
				if (rawCfg) {
					try {
						const cfg = JSON.parse(rawCfg);
						if (cfg && typeof cfg === "object") {
							await saveConfig(wsId, cfg);
						}
					} catch (_) { }
				}

				// Deletions
				const rawDel = localStorage.getItem(`keeplocal_deletions_${wsId}`);
				if (rawDel) {
					try {
						const delList = JSON.parse(rawDel);
						if (Array.isArray(delList)) {
							await saveDeletions(wsId, delList);
						}
					} catch (_) { }
				}
			}

			// Mark migration complete
			localStorage.setItem(MIGRATION_FLAG, "true");
			console.log(`[KeepLocalDB] Migration completed successfully. ${migratedWorkspacesCount} workspace file trees transferred to IndexedDB.`);
			return { migrated: true, count: migratedWorkspacesCount };
		} catch (err) {
			console.error("[KeepLocalDB] Migration failed:", err);
			return { migrated: false, error: err };
		}
	}

	// Export to global scope
	const KeepLocalDB = {
		openDB,
		get,
		set,
		del,
		getWorkspaces,
		saveWorkspaces,
		getFiles,
		saveFiles,
		getConfig,
		saveConfig,
		getDeletions,
		saveDeletions,
		getHandle,
		saveHandle,
		deleteWorkspaceData,
		getStorageEstimate,
		migrateFromLocalStorage,
		STORES
	};

	global.KeepLocalDB = KeepLocalDB;
	if (typeof module !== "undefined" && module.exports) {
		module.exports = KeepLocalDB;
	}

})(typeof window !== "undefined" ? window : globalThis);
