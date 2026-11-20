/* ============================================================
   KEEPLOCAL — collab.js
   Peer-to-Peer Live Collaboration Engine (Trystero + Yjs)
   100% Serverless, Zero-Backend, End-to-End Encrypted
   ============================================================ */

(function (global) {
	"use strict";

	// Default peer color palette (vibrant, accessible)
	const PEER_COLORS = [
		"#10B981", // Emerald
		"#3B82F6", // Blue
		"#8B5CF6", // Purple
		"#F59E0B", // Amber
		"#EC4899", // Pink
		"#06B6D4", // Cyan
		"#F97316", // Orange
		"#14B8A6"  // Teal
	];

	/**
	 * Fast prefix/suffix diff algorithm to synchronize a string to a Y.Text instance.
	 * Dispatches minimal deletion and insertion operations in a single local transaction.
	 */
	function syncStringToYText(ytext, newStr) {
		if (!ytext) return;
		const oldStr = ytext.toString();
		if (oldStr === newStr) return;

		let start = 0;
		const oldLen = oldStr.length;
		const newLen = newStr.length;

		// Common prefix
		while (start < oldLen && start < newLen && oldStr[start] === newStr[start]) {
			start++;
		}

		// Common suffix
		let oldEnd = oldLen;
		let newEnd = newLen;
		while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
			oldEnd--;
			newEnd--;
		}

		const deleteCount = oldEnd - start;
		const insertText = newStr.slice(start, newEnd);

		ytext.doc.transact(() => {
			if (deleteCount > 0) {
				ytext.delete(start, deleteCount);
			}
			if (insertText.length > 0) {
				ytext.insert(start, insertText);
			}
		}, "local");
	}

	/**
	 * Adjusts a local cursor position according to incoming Yjs delta operations.
	 */
	function adjustCursorPosition(pos, delta) {
		if (!Array.isArray(delta)) return pos;
		let newPos = pos;
		let curr = 0;
		for (const op of delta) {
			if (op.retain) {
				curr += op.retain;
			} else if (op.insert) {
				const len = typeof op.insert === "string" ? op.insert.length : 1;
				if (curr <= pos) {
					newPos += len;
				}
				curr += len;
			} else if (op.delete) {
				if (curr < pos) {
					newPos -= Math.min(op.delete, pos - curr);
				}
			}
		}
		return Math.max(0, newPos);
	}

	/**
	 * Adapts Trystero's makeAction to provide a consistent send(data, targetPeerId)
	 * and on(callback) interface across both modern (object) and legacy (array) Trystero versions.
	 */
	function createActionBridge(room, actionName) {
		if (!room || typeof room.makeAction !== "function") {
			console.error(`[KeepLocalCollab] room.makeAction is not available for ${actionName}`);
			return { send: () => Promise.resolve(), on: () => () => {} };
		}

		const raw = room.makeAction(actionName);

		// Legacy array form: [send, on]
		if (Array.isArray(raw)) {
			const [rawSend, rawOn] = raw;
			return {
				send: (data, targetPeerId) => {
					if (targetPeerId) {
						rawSend(data, targetPeerId);
					} else {
						rawSend(data);
					}
					return Promise.resolve();
				},
				on: (callback) => {
					rawOn((data, peerId) => callback(data, peerId));
				}
			};
		}

		// Modern object form (Trystero 0.27+): { send, onMessage }
		if (raw && typeof raw === "object") {
			return {
				send: (data, targetPeerId) => {
					const opts = targetPeerId ? { target: targetPeerId } : undefined;
					return raw.send(data, opts).catch((err) => {
						console.warn(`[KeepLocalCollab] Action ${actionName} send error:`, err);
					});
				},
				on: (callback) => {
					if (typeof raw.onMessage === "function") {
						raw.onMessage((data, context) => {
							const peerId = typeof context === "string" ? context : (context?.peerId || "");
							callback(data, peerId);
						});
					}
				}
			};
		}

		return { send: () => Promise.resolve(), on: () => () => {} };
	}

	// ============================================================
	// TRYSTERO + YJS PROVIDER
	// ============================================================

	class KeepLocalTrysteroProvider {
		constructor(roomId, ydoc, options = {}) {
			this.roomId = roomId;
			this.ydoc = ydoc;
			this.strategy = options.strategy || "torrent";
			this.appId = options.appId || "keeplocal-p2p";
			this.password = options.password || undefined;
			this.userMeta = options.userMeta || { name: "Peer", color: PEER_COLORS[0] };

			this.peers = new Map(); // peerId -> { name, color, cursor, fileId, lastSeen }
			this.isDestroyed = false;

			// Callbacks
			this.onPeersChange = options.onPeersChange || null;
			this.onStatusChange = options.onStatusChange || null;
			this.onSyncComplete = options.onSyncComplete || null;

			this._initRoom();
		}

		_initRoom() {
			const collabLib = global.KeepLocalCollab;
			if (!collabLib) {
				console.error("[KeepLocalCollab] Collab bundle not loaded.");
				return;
			}

			const joinFn = (this.strategy === "nostr" && typeof collabLib.joinRoomNostr === "function")
				? collabLib.joinRoomNostr
				: collabLib.joinRoomTorrent;

			if (typeof joinFn !== "function") {
				console.error("[KeepLocalCollab] No valid joinRoom strategy found.");
				return;
			}

			const roomConfig = { appId: this.appId };
			if (this.password && this.password.trim().length > 0) {
				roomConfig.password = this.password.trim();
			}

			try {
				this.room = joinFn(roomConfig, this.roomId);
			} catch (err) {
				console.error("[KeepLocalCollab] Failed to join room:", err);
				if (this.onStatusChange) this.onStatusChange("error", err.message);
				return;
			}

			// Register actions via bridge (supporting Trystero 0.27+ and legacy)
			const syncAction = createActionBridge(this.room, "y-sync");
			const awarenessAction = createActionBridge(this.room, "y-awareness");

			this._sendSync = (data, targetPeerId) => syncAction.send(data, targetPeerId);
			this._sendAwareness = (data, targetPeerId) => awarenessAction.send(data, targetPeerId);

			// When peer joins:
			if (typeof this.room.onPeerJoin === "function") {
				this.room.onPeerJoin((context) => {
					const peerId = typeof context === "string" ? context : (context?.peerId || "");
					if (!peerId) return;
					console.log(`[KeepLocalCollab] Peer connected: ${peerId}`);
					// Step 1: Send local state vector to peer
					const sv = collabLib.Y.encodeStateVector(this.ydoc);
					this._sendSync({ type: "sync-step-1", sv: Array.from(sv) }, peerId);

					// Also announce self to new peer
					this.broadcastAwareness();

					if (this.onPeersChange) this.onPeersChange(this.getPeersList());
					if (this.onStatusChange) this.onStatusChange("connected", this.getPeerCount());
				});
			}

			// When peer leaves:
			if (typeof this.room.onPeerLeave === "function") {
				this.room.onPeerLeave((context) => {
					const peerId = typeof context === "string" ? context : (context?.peerId || "");
					if (!peerId) return;
					console.log(`[KeepLocalCollab] Peer disconnected: ${peerId}`);
					this.peers.delete(peerId);
					if (this.onPeersChange) this.onPeersChange(this.getPeersList());
					if (this.onStatusChange) this.onStatusChange("connected", this.getPeerCount());
				});
			}

			// Listen for room level status or errors
			if (typeof this.room.onError === "function") {
				this.room.onError((err) => {
					console.warn("[KeepLocalCollab] Room status/warning:", err?.message || err);
				});
			}

			// Handle incoming sync messages
			syncAction.on((msg, peerId) => {
				if (this.isDestroyed || !msg) return;

				if (msg.type === "sync-step-1") {
					// Peer sent their state vector; compute missing updates and send back step-2
					const peerSv = new Uint8Array(msg.sv);
					const missingUpdate = collabLib.Y.encodeStateAsUpdate(this.ydoc, peerSv);
					if (missingUpdate.length > 0) {
						this._sendSync({ type: "sync-step-2", update: Array.from(missingUpdate) }, peerId);
					}
					// Also reply with our state vector if peer hasn't seen it
					const mySv = collabLib.Y.encodeStateVector(this.ydoc);
					this._sendSync({ type: "sync-step-1-reply", sv: Array.from(mySv) }, peerId);
				} else if (msg.type === "sync-step-1-reply") {
					const peerSv = new Uint8Array(msg.sv);
					const missingUpdate = collabLib.Y.encodeStateAsUpdate(this.ydoc, peerSv);
					if (missingUpdate.length > 0) {
						this._sendSync({ type: "sync-step-2", update: Array.from(missingUpdate) }, peerId);
					}
				} else if (msg.type === "sync-step-2" || msg.type === "sync-update") {
					// Apply remote update to local Y.Doc
					if (msg.update && msg.update.length > 0) {
						collabLib.Y.applyUpdate(this.ydoc, new Uint8Array(msg.update), "remote");
					}
					if (this.onSyncComplete) this.onSyncComplete();
				}
			});

			// Handle incoming awareness
			awarenessAction.on((data, peerId) => {
				if (this.isDestroyed || !data) return;
				this.peers.set(peerId, {
					peerId,
					name: data.name || "Peer",
					color: data.color || PEER_COLORS[0],
					cursor: data.cursor || null,
					fileId: data.fileId || null,
					isHost: !!data.isHost,
					lastSeen: Date.now()
				});
				if (this.onPeersChange) this.onPeersChange(this.getPeersList());
			});

			// Broadcast local doc mutations to peers
			this._docUpdateHandler = (update, origin) => {
				if (origin !== "remote" && !this.isDestroyed) {
					this._sendSync({ type: "sync-update", update: Array.from(update) });
				}
			};
			this.ydoc.on("update", this._docUpdateHandler);

			// Initial status notification
			if (this.onStatusChange) this.onStatusChange("connecting", 0);
		}

		broadcastAwareness(extra = {}) {
			if (this.isDestroyed || !this._sendAwareness) return;
			const payload = {
				name: this.userMeta.name,
				color: this.userMeta.color,
				isHost: !!this.userMeta.isHost,
				...extra
			};
			this._sendAwareness(payload);
		}

		getPeerCount() {
			if (!this.room || typeof this.room.getPeers !== "function") return 0;
			try {
				const peers = this.room.getPeers();
				return peers ? Object.keys(peers).length : 0;
			} catch (_) {
				return 0;
			}
		}

		getPeersList() {
			return Array.from(this.peers.values());
		}

		destroy() {
			this.isDestroyed = true;
			if (this.ydoc && this._docUpdateHandler) {
				this.ydoc.off("update", this._docUpdateHandler);
			}
			if (this.room) {
				try {
					if (typeof this.room.leave === "function") {
						this.room.leave().catch(() => {});
					}
				} catch (_) { }
				this.room = null;
			}
			this.peers.clear();
			if (this.onStatusChange) this.onStatusChange("disconnected", 0);
			if (this.onPeersChange) this.onPeersChange([]);
		}
	}

	// ============================================================
	// COLLABORATION MANAGER (KeepLocal Integration)
	// ============================================================

	class KeepLocalCollabManager {
		constructor() {
			this.provider = null;
			this.ydoc = null;
			this.yText = null;
			this.activeRoomId = null;
			this.activeFileId = null;
			this.isHost = false;
			this.isApplyingRemote = false;
			this.activeStrategy = "torrent";

			// Local user profile
			this.userMeta = this._loadUserMeta();

			// Auto-save debounce timer
			this._saveDebounceTimer = null;
		}

		_loadUserMeta() {
			let saved = null;
			try {
				const raw = localStorage.getItem("keeplocal_collab_user");
				if (raw) saved = JSON.parse(raw);
			} catch (_) { }

			if (saved && saved.name && saved.color) {
				return saved;
			}

			const randomColor = PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)];
			const randomNum = Math.floor(1000 + Math.random() * 9000);
			const defaultMeta = {
				name: `Writer #${randomNum}`,
				color: randomColor
			};
			this.saveUserMeta(defaultMeta);
			return defaultMeta;
		}

		saveUserMeta(meta) {
			this.userMeta = { ...this.userMeta, ...meta };
			try {
				localStorage.setItem("keeplocal_collab_user", JSON.stringify(this.userMeta));
			} catch (_) { }
			if (this.provider) {
				this.provider.userMeta = this.userMeta;
				this.provider.broadcastAwareness();
			}
		}

		isActive() {
			return !!(this.provider && this.activeRoomId);
		}

		getActiveRoomId() {
			return this.activeRoomId;
		}

		/**
		 * Start hosting a live collaboration session for a note
		 */
		async startHostSession(roomId, password = "", strategy = "torrent") {
			const isLanIp = typeof window !== "undefined" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
			const isSecure = (typeof window !== "undefined" && window.isSecureContext) || (typeof crypto !== "undefined" && !!crypto?.subtle);
			if (!isSecure && isLanIp && typeof alert === "function") {
				const portStr = window.location.port ? `:${window.location.port}` : "";
				alert(`Insecure Context Warning:\n\nWebRTC cryptographic security requires a Secure Context (localhost or HTTPS).\n\nPlease open KeepLocal at http://localhost${portStr} on this computer, or access via HTTPS.`);
			}

			const api = global.KeepLocalAPI;
			if (api && typeof api.ensureActiveWorkspace === "function") {
				await api.ensureActiveWorkspace();
			}

			let file = api?.getActiveFile();
			if (!file || file.type !== "file") {
				if (typeof api?.addFileWithContent === "function") {
					file = await api.addFileWithContent("Shared_Notes.md", "");
					this.activeFileId = file?.id || null;
				} else {
					alert("Please open a note first before starting collaboration.");
					return false;
				}
			} else {
				this.activeFileId = file.id;
			}

			this.leaveSession();

			this.activeRoomId = roomId;
			this.isHost = true;
			this.activeStrategy = strategy;

			const collabLib = global.KeepLocalCollab;
			this.ydoc = new collabLib.Y.Doc();
			this.yText = this.ydoc.getText("content");

			// Initialize document with current note content
			const initialContent = file.content || "";
			if (initialContent.length > 0) {
				this.yText.insert(0, initialContent);
			}

			this._setupProvider(password, strategy);
			this._bindYTextObserver();
			this._updateUIState();
			this._updateUrlHash();

			console.log(`[KeepLocalCollab] Host session started on room: ${roomId}`);
			return true;
		}

		/**
		 * Join an existing live collaboration session
		 */
		async joinSession(roomId, password = "", strategy = "torrent") {
			if (!roomId || !roomId.trim()) return false;
			this.leaveSession();

			const cleanRoomId = roomId.trim();
			this.activeRoomId = cleanRoomId;
			this.isHost = false;
			this.activeStrategy = strategy;

			const api = global.KeepLocalAPI;
			if (api && typeof api.ensureActiveWorkspace === "function") {
				await api.ensureActiveWorkspace();
			}

			let targetFile = null;
			const expectedFileName = `Collab_${cleanRoomId}.md`;
			const allFiles = (typeof api?.getFiles === "function") ? api.getFiles() : [];
			const existingCollabFile = allFiles.find(f => f.type === "file" && f.name === expectedFileName);

			if (existingCollabFile) {
				if (typeof api?.openFileById === "function") {
					await api.openFileById(existingCollabFile.id);
				}
				targetFile = existingCollabFile;
			} else if (typeof api?.addFileWithContent === "function") {
				targetFile = await api.addFileWithContent(expectedFileName, "");
			} else {
				targetFile = api?.getActiveFile();
			}

			this.activeFileId = targetFile?.id || null;

			const collabLib = global.KeepLocalCollab;
			this.ydoc = new collabLib.Y.Doc();
			this.yText = this.ydoc.getText("content");

			this._setupProvider(password, strategy);
			this._bindYTextObserver();
			this._updateUIState();
			this._updateUrlHash();

			console.log(`[KeepLocalCollab] Joined session on room: ${cleanRoomId}`);
			return true;
		}

		_setupProvider(password, strategy) {
			this.provider = new KeepLocalTrysteroProvider(this.activeRoomId, this.ydoc, {
				strategy,
				password,
				userMeta: { ...this.userMeta, isHost: this.isHost },
				onPeersChange: (peers) => this._renderPeers(peers),
				onStatusChange: (status, detail) => this._renderStatus(status, detail),
				onSyncComplete: () => {
					console.log("[KeepLocalCollab] Initial sync completed.");
					this._applyRemoteUpdate(null);
				}
			});
		}

		_bindYTextObserver() {
			if (!this.yText) return;

			this.yText.observe((event, transaction) => {
				if (transaction.origin === "local" || this.isApplyingRemote) {
					return;
				}
				this._applyRemoteUpdate(event);
			});
		}

		/**
		 * Called by local editor (textarea input or Editor.js debounced save)
		 */
		handleLocalInput(newContent) {
			if (!this.isActive() || this.isApplyingRemote || !this.yText) return;
			syncStringToYText(this.yText, newContent);
		}

		/**
		 * Apply incoming remote CRDT update to the current KeepLocal editor view & file
		 */
		async _applyRemoteUpdate(event) {
			const api = global.KeepLocalAPI;
			if (!api) return;

			this.isApplyingRemote = true;
			try {
				const remoteContent = this.yText.toString();
				const targetFile = api.findNode(this.activeFileId) || api.getActiveFile();
				if (targetFile && targetFile.type === "file") {
					targetFile.content = remoteContent;
				}

				const editorMode = api.getEditorMode();
				const textarea = api.getEditorTextarea();
				const editorInstance = api.getEditorInstance();

				if (editorMode === "plain" && textarea) {
					// 1. Raw Textarea Mode: Preserve cursor position accurately
					const oldPos = textarea.selectionStart;
					const newPos = adjustCursorPosition(oldPos, event ? event.delta : []);

					textarea.value = remoteContent;
					textarea.setSelectionRange(newPos, newPos);

					if (typeof api.updateLineNumbers === "function") api.updateLineNumbers();
					if (typeof api.updateCodeHighlighting === "function") api.updateCodeHighlighting();
				} else if (editorMode === "block" && editorInstance) {
					// 2. Block Editor Mode: Re-render or patch blocks from canonical markdown
					if (global.KeepLocalMarkdown && typeof global.KeepLocalMarkdown.textToBlocks === "function") {
						const blocks = global.KeepLocalMarkdown.textToBlocks(remoteContent);
						try {
							await editorInstance.isReady;
							await editorInstance.render({ blocks });
						} catch (err) {
							console.warn("[KeepLocalCollab] EditorJS render error:", err);
						}
					}
				} else {
					if (typeof api.loadFile === "function") {
						await api.loadFile();
					}
				}

				// Debounced local persistence to IndexedDB & physical disk
				clearTimeout(this._saveDebounceTimer);
				this._saveDebounceTimer = setTimeout(() => {
					if (typeof api.persistCurrent === "function") api.persistCurrent();
					if (typeof api.syncWorkspace === "function") api.syncWorkspace(false);
				}, 500);
			} finally {
				this.isApplyingRemote = false;
			}
		}

		/**
		 * Leave current collaboration room
		 */
		leaveSession() {
			if (this.provider) {
				this.provider.destroy();
				this.provider = null;
			}
			this.ydoc = null;
			this.yText = null;
			this.activeRoomId = null;
			this.activeFileId = null;
			this.isHost = false;

			this._updateUIState();
			this._cleanUrlHash();
			console.log("[KeepLocalCollab] Session closed.");
		}

		// ============================================================
		// UI & PRESENCE INTEGRATION
		// ============================================================

		_updateUIState() {
			const badge = document.getElementById("collabActiveBadge");
			const statusBadge = document.getElementById("collabStatusBadge");
			const collabBtn = document.getElementById("collabBtn");

			if (this.isActive()) {
				if (badge) badge.classList.remove("hidden");
				if (statusBadge) {
					statusBadge.classList.remove("hidden");
					statusBadge.textContent = `P2P: 0 peers`;
				}
				if (collabBtn) collabBtn.classList.add("active");
			} else {
				if (badge) badge.classList.add("hidden");
				if (statusBadge) statusBadge.classList.add("hidden");
				if (collabBtn) collabBtn.classList.remove("active");
			}
		}

		_renderStatus(status, detail) {
			const statusBadge = document.getElementById("collabStatusBadge");
			const peerCountSpan = document.getElementById("collabPeerCount");

			if (!statusBadge || !this.isActive()) return;

			if (status === "connecting") {
				statusBadge.textContent = "Connecting P2P…";
				statusBadge.style.color = "var(--text-muted)";
			} else if (status === "connected") {
				const count = typeof detail === "number" ? detail : this.provider?.getPeerCount() || 0;
				statusBadge.textContent = `P2P: ${count} peer${count === 1 ? "" : "s"}`;
				statusBadge.style.color = count > 0 ? "var(--accent-color)" : "var(--text-muted)";
				if (peerCountSpan) {
					peerCountSpan.textContent = `${count + 1} online`;
				}
			} else if (status === "error") {
				statusBadge.textContent = "P2P Error";
				statusBadge.style.color = "var(--danger)";
			} else {
				statusBadge.textContent = "P2P Off";
			}
		}

		_renderPeers(peers) {
			const peersListEl = document.getElementById("collabPeersList");
			const peerAvatarsEl = document.getElementById("collabPeerAvatars");

			if (peersListEl) {
				peersListEl.innerHTML = "";
				// Add self
				const selfItem = document.createElement("div");
				selfItem.className = "collab-peer-item";
				selfItem.innerHTML = `
					<span class="collab-peer-dot" style="background:${this.userMeta.color}"></span>
					<span class="collab-peer-name">${this.userMeta.name} <b>(You)</b></span>
					${this.isHost ? '<span class="collab-peer-role">Host</span>' : ""}
				`;
				peersListEl.appendChild(selfItem);

				// Add peers
				peers.forEach((p) => {
					const item = document.createElement("div");
					item.className = "collab-peer-item";
					item.innerHTML = `
						<span class="collab-peer-dot" style="background:${p.color}"></span>
						<span class="collab-peer-name">${p.name || "Anonymous Peer"}</span>
						${p.isHost ? '<span class="collab-peer-role">Host</span>' : ""}
					`;
					peersListEl.appendChild(item);
				});
			}

			if (peerAvatarsEl) {
				peerAvatarsEl.innerHTML = "";
				// Render avatar circles in top bar
				peers.slice(0, 4).forEach((p) => {
					const dot = document.createElement("div");
					dot.className = "collab-avatar-bubble";
					dot.style.borderColor = p.color;
					dot.title = p.name;
					dot.textContent = (p.name || "P").charAt(0).toUpperCase();
					peerAvatarsEl.appendChild(dot);
				});
			}

			this._renderStatus("connected", peers.length);
		}

		_updateUrlHash() {
			if (!this.activeRoomId) return;
			const hash = `#/collab/${this.activeRoomId}`;
			if (window.location.hash !== hash) {
				window.history.replaceState(null, "", hash);
			}
		}

		_cleanUrlHash() {
			if (window.location.hash.startsWith("#/collab/")) {
				window.history.replaceState(null, "", window.location.pathname + window.location.search);
			}
		}

		/**
		 * Parse room information from URL on app launch
		 */
		checkUrlForSession() {
			const hash = window.location.hash;
			const search = window.location.search;

			let roomId = null;
			let password = "";

			if (hash.startsWith("#/collab/")) {
				const afterHash = hash.replace("#/collab/", "").trim();
				if (afterHash.includes("?")) {
					const [rId, q] = afterHash.split("?");
					roomId = decodeURIComponent(rId);
					const params = new URLSearchParams(q);
					if (params.get("key")) password = params.get("key");
				} else {
					roomId = decodeURIComponent(afterHash);
				}
			} else if (search.includes("collab=")) {
				const params = new URLSearchParams(search);
				roomId = params.get("collab");
				password = params.get("key") || "";
			}

			if (roomId) {
				// Prompt user to join the collaborative session
				setTimeout(() => {
					this.openModal({ initialRoomId: roomId, initialPassword: password });
				}, 400);
			}
		}

		// ============================================================
		// MODAL CONTROLS
		// ============================================================

		openModal(preset = {}) {
			const modal = document.getElementById("collabModalOverlay");
			if (!modal) return;

			const insecureBanner = document.getElementById("collabInsecureBanner");
			const localhostLink = document.getElementById("collabLocalhostLink");
			if (insecureBanner) {
				const isLanIp = typeof window !== "undefined" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";
				const isSecure = (typeof window !== "undefined" && window.isSecureContext) || (typeof crypto !== "undefined" && !!crypto?.subtle);
				if (!isSecure && isLanIp) {
					insecureBanner.classList.remove("hidden");
					if (localhostLink) {
						localhostLink.href = `http://localhost:${window.location.port || 8000}${window.location.pathname}${window.location.search}${window.location.hash}`;
					}
				} else {
					insecureBanner.classList.add("hidden");
				}
			}

			const hostTab = document.getElementById("collabTabHost");
			const joinTab = document.getElementById("collabTabJoin");
			const hostSection = document.getElementById("collabHostSection");
			const joinSection = document.getElementById("collabJoinSection");
			const activeSection = document.getElementById("collabActiveSection");

			const hostRoomInput = document.getElementById("collabHostRoomId");
			const joinRoomInput = document.getElementById("collabJoinRoomId");
			const joinPassInput = document.getElementById("collabJoinPassword");
			const nameInput = document.getElementById("collabUserNameInput");

			if (nameInput) nameInput.value = this.userMeta.name;

			if (this.isActive()) {
				// Show Active Session details
				if (hostTab) hostTab.classList.add("hidden");
				if (joinTab) joinTab.classList.add("hidden");
				if (hostSection) hostSection.classList.add("hidden");
				if (joinSection) joinSection.classList.add("hidden");
				if (activeSection) activeSection.classList.remove("hidden");

				const activeRoomSpan = document.getElementById("collabActiveRoomText");
				if (activeRoomSpan) activeRoomSpan.textContent = this.activeRoomId;
				this._renderPeers(this.provider ? this.provider.getPeersList() : []);
			} else {
				if (hostTab) hostTab.classList.remove("hidden");
				if (joinTab) joinTab.classList.remove("hidden");
				if (activeSection) activeSection.classList.add("hidden");

				if (preset.initialRoomId || preset.tab === "join") {
					// Switch to join tab
					if (hostTab) hostTab.classList.remove("active");
					if (joinTab) joinTab.classList.add("active");
					if (hostSection) hostSection.classList.add("hidden");
					if (joinSection) joinSection.classList.remove("hidden");
					if (joinRoomInput && preset.initialRoomId) joinRoomInput.value = preset.initialRoomId;
					if (joinPassInput && preset.initialPassword) joinPassInput.value = preset.initialPassword;
				} else {
					// Switch to host tab by default with generated room ID
					if (hostTab) hostTab.classList.add("active");
					if (joinTab) joinTab.classList.remove("active");
					if (hostSection) hostSection.classList.remove("hidden");
					if (joinSection) joinSection.classList.add("hidden");

					const randomSlug = "room-" + Math.random().toString(36).slice(2, 8);
					if (hostRoomInput) hostRoomInput.value = randomSlug;
				}
			}

			modal.classList.add("active");
			if (window.lucide) window.lucide.createIcons();
		}

		closeModal() {
			const modal = document.getElementById("collabModalOverlay");
			if (modal) modal.classList.remove("active");
		}
	}

	// ============================================================
	// GLOBAL UI ACTIONS (Window Handlers)
	// ============================================================

	global.switchCollabTab = function (tab) {
		const hostTab = document.getElementById("collabTabHost");
		const joinTab = document.getElementById("collabTabJoin");
		const hostSection = document.getElementById("collabHostSection");
		const joinSection = document.getElementById("collabJoinSection");

		if (tab === "host") {
			if (hostTab) hostTab.classList.add("active");
			if (joinTab) joinTab.classList.remove("active");
			if (hostSection) hostSection.classList.remove("hidden");
			if (joinSection) joinSection.classList.add("hidden");
		} else {
			if (hostTab) hostTab.classList.remove("active");
			if (joinTab) joinTab.classList.add("active");
			if (hostSection) hostSection.classList.add("hidden");
			if (joinSection) joinSection.classList.remove("hidden");
		}
	};

	global.generateNewRoomCode = function () {
		const hostRoomInput = document.getElementById("collabHostRoomId");
		if (hostRoomInput) {
			hostRoomInput.value = "room-" + Math.random().toString(36).slice(2, 8);
		}
	};

	global.startHostCollabFromModal = async function () {
		const nameInput = document.getElementById("collabUserNameInput");
		const roomInput = document.getElementById("collabHostRoomId");
		const passInput = document.getElementById("collabHostPassword");
		const stratInput = document.getElementById("collabHostStrategy");

		if (nameInput && nameInput.value.trim()) {
			global.KeepLocalCollabManager.saveUserMeta({ name: nameInput.value.trim() });
		}

		const roomId = roomInput?.value.trim() || ("room-" + Math.random().toString(36).slice(2, 8));
		const password = passInput?.value.trim() || "";
		const strategy = stratInput?.value || "torrent";

		const success = await global.KeepLocalCollabManager.startHostSession(roomId, password, strategy);
		if (success) {
			const link = `${window.location.origin}${window.location.pathname}#/collab/${encodeURIComponent(roomId)}${password ? "?key=" + encodeURIComponent(password) : ""}`;
			const linkInput = document.getElementById("collabShareLinkInput");
			if (linkInput) linkInput.value = link;

			// Switch view to active
			const hostTab = document.getElementById("collabTabHost");
			const joinTab = document.getElementById("collabTabJoin");
			const hostSection = document.getElementById("collabHostSection");
			const joinSection = document.getElementById("collabJoinSection");
			const activeSection = document.getElementById("collabActiveSection");
			if (hostTab) hostTab.classList.add("hidden");
			if (joinTab) joinTab.classList.add("hidden");
			if (hostSection) hostSection.classList.add("hidden");
			if (joinSection) joinSection.classList.add("hidden");
			if (activeSection) activeSection.classList.remove("hidden");

			const activeRoomSpan = document.getElementById("collabActiveRoomText");
			if (activeRoomSpan) activeRoomSpan.textContent = roomId;
			if (window.lucide) window.lucide.createIcons();
		}
	};

	global.joinCollabFromModal = async function () {
		const nameInput = document.getElementById("collabUserNameInput");
		const roomInput = document.getElementById("collabJoinRoomId");
		const passInput = document.getElementById("collabJoinPassword");
		const stratInput = document.getElementById("collabJoinStrategy");

		if (nameInput && nameInput.value.trim()) {
			global.KeepLocalCollabManager.saveUserMeta({ name: nameInput.value.trim() });
		}

		let raw = roomInput?.value.trim() || "";
		if (!raw) {
			alert("Please enter a Room ID or paste an invite link.");
			return;
		}

		let roomId = raw;
		let password = passInput?.value.trim() || "";

		// If user pasted a full URL
		if (raw.includes("#/collab/")) {
			const parts = raw.split("#/collab/");
			const afterHash = parts[1];
			if (afterHash.includes("?")) {
				const [rId, q] = afterHash.split("?");
				roomId = decodeURIComponent(rId);
				const params = new URLSearchParams(q);
				if (params.get("key")) password = params.get("key");
			} else {
				roomId = decodeURIComponent(afterHash);
			}
		}

		const strategy = stratInput?.value || "torrent";
		const success = await global.KeepLocalCollabManager.joinSession(roomId, password, strategy);
		if (success) {
			const link = `${window.location.origin}${window.location.pathname}#/collab/${encodeURIComponent(roomId)}${password ? "?key=" + encodeURIComponent(password) : ""}`;
			const linkInput = document.getElementById("collabShareLinkInput");
			if (linkInput) linkInput.value = link;

			// Close modal immediately so the user can see and edit the collaborative note
			global.KeepLocalCollabManager.closeModal();
		}
	};

	global.copyCollabInviteLink = function () {
		const linkInput = document.getElementById("collabShareLinkInput");
		const copyBtn = document.getElementById("collabCopyLinkBtn");
		if (!linkInput) return;

		const showSuccess = () => {
			if (copyBtn) {
				const originalHtml = copyBtn.innerHTML;
				copyBtn.innerHTML = '<i data-lucide="check" size="13"></i> <span>Copied!</span>';
				if (window.lucide) window.lucide.createIcons();
				setTimeout(() => {
					copyBtn.innerHTML = originalHtml;
					if (window.lucide) window.lucide.createIcons();
				}, 2000);
			}
		};

		linkInput.focus();
		linkInput.select();

		// Modern asynchronous Clipboard API (available in Secure Contexts: HTTPS / localhost)
		if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
			navigator.clipboard.writeText(linkInput.value).then(showSuccess).catch(() => {
				fallbackExecCommand();
			});
		} else {
			fallbackExecCommand();
		}

		function fallbackExecCommand() {
			try {
				const success = document.execCommand("copy");
				if (success) {
					showSuccess();
				} else {
					prompt("Copy link:", linkInput.value);
				}
			} catch (_) {
				prompt("Copy link:", linkInput.value);
			}
		}
	};

	global.leaveCollabFromModal = function () {
		global.KeepLocalCollabManager.leaveSession();
		global.KeepLocalCollabManager.closeModal();
	};

	// Attach to global scope
	global.KeepLocalCollab = global.KeepLocalCollab || {};
	global.KeepLocalCollab.Provider = KeepLocalTrysteroProvider;
	global.KeepLocalCollab.Manager = KeepLocalCollabManager;
	global.KeepLocalCollabManager = new KeepLocalCollabManager();

	// Initialize after DOM ready
	if (typeof document !== "undefined") {
		document.addEventListener("DOMContentLoaded", () => {
			global.KeepLocalCollabManager.checkUrlForSession();
		});
	}

})(typeof window !== "undefined" ? window : globalThis);
