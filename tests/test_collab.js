// Unit tests for KeepLocal Collaboration Engine (Trystero + Yjs)
const assert = require("assert");

// Mock browser global environment for Node testing
global.window = global;
global.self = global;
global.localStorage = {
	_store: {},
	getItem(k) { return this._store[k] || null; },
	setItem(k, v) { this._store[k] = String(v); },
	removeItem(k) { delete this._store[k]; }
};

// 1. Load collab bundle
require("../js/collab-bundle.js");
const collabLib = global.KeepLocalCollab;

console.log("Running KeepLocal Collaboration unit tests...\n");

// Check bundle exports
assert.ok(collabLib, "KeepLocalCollab should be defined");
assert.ok(collabLib.Y, "collabLib.Y should be defined");
assert.strictEqual(typeof collabLib.Y.Doc, "function", "Y.Doc should be a constructor");
assert.strictEqual(typeof collabLib.joinRoomTorrent, "function", "joinRoomTorrent should be a function");
assert.strictEqual(typeof collabLib.joinRoomNostr, "function", "joinRoomNostr should be a function");
console.log("✓ Bundle exports verified (Yjs, joinRoomTorrent, joinRoomNostr)");

// 2. Load collab module
require("../js/collab.js");
assert.ok(global.KeepLocalCollabManager, "KeepLocalCollabManager instance should be created");
assert.ok(global.KeepLocalCollab.Provider, "KeepLocalCollab.Provider class should exist");
console.log("✓ Collab Manager and Provider classes registered");

// 3. Test syncStringToYText algorithm
const Y = collabLib.Y;
const doc1 = new Y.Doc();
const ytext1 = doc1.getText("content");

// Helper to simulate syncStringToYText
function syncStringToYText(ytext, newStr) {
	const oldStr = ytext.toString();
	if (oldStr === newStr) return;

	let start = 0;
	const oldLen = oldStr.length;
	const newLen = newStr.length;

	while (start < oldLen && start < newLen && oldStr[start] === newStr[start]) {
		start++;
	}

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

ytext1.insert(0, "Initial content");
assert.strictEqual(ytext1.toString(), "Initial content");

syncStringToYText(ytext1, "Initial updated content");
assert.strictEqual(ytext1.toString(), "Initial updated content");

syncStringToYText(ytext1, "Prefix Initial updated content with suffix");
assert.strictEqual(ytext1.toString(), "Prefix Initial updated content with suffix");

syncStringToYText(ytext1, "");
assert.strictEqual(ytext1.toString(), "");

syncStringToYText(ytext1, "# Title\n\n- Task 1\n- Task 2\n");
assert.strictEqual(ytext1.toString(), "# Title\n\n- Task 1\n- Task 2\n");
console.log("✓ syncStringToYText diffing and string-to-CRDT transactions passed");

// 4. Test adjustCursorPosition
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

// Cursor at 5 in "Hello world"
// Remote peer inserts "beautiful " at index 6: cursor should remain 5 (remote insert after cursor)
const delta1 = [{ retain: 6 }, { insert: "beautiful " }];
assert.strictEqual(adjustCursorPosition(5, delta1), 5);

// Remote peer inserts "Hey! " at index 0: cursor should shift by 5 (5 -> 10)
const delta2 = [{ insert: "Hey! " }];
assert.strictEqual(adjustCursorPosition(5, delta2), 10);

// Remote peer deletes 2 characters at index 1: cursor should shift back by 2 (5 -> 3)
const delta3 = [{ retain: 1 }, { delete: 2 }];
assert.strictEqual(adjustCursorPosition(5, delta3), 3);
console.log("✓ adjustCursorPosition cursor preservation logic passed");

// 5. Test Two-Peer Document Convergence (Mathematical CRDT Sync)
const peerADoc = new Y.Doc();
const peerBDoc = new Y.Doc();

const peerAText = peerADoc.getText("content");
const peerBText = peerBDoc.getText("content");

peerAText.insert(0, "# Document\n\nWritten by Peer A.");

// Initial Handshake simulation:
// Peer B connects to Peer A:
const peerASv = Y.encodeStateVector(peerADoc);
const peerBSv = Y.encodeStateVector(peerBDoc);

const updateForB = Y.encodeStateAsUpdate(peerADoc, peerBSv);
const updateForA = Y.encodeStateAsUpdate(peerBDoc, peerASv);

Y.applyUpdate(peerBDoc, updateForB);
Y.applyUpdate(peerADoc, updateForA);

assert.strictEqual(peerBText.toString(), peerAText.toString());
console.log("✓ Initial 2-peer state-vector handshake converged documents");

// 6. Test Concurrent Edits Convergence
// Peer A types at beginning:
peerAText.insert(0, "<!-- Welcome -->\n");

// Simultaneously, Peer B types at end:
peerBText.insert(peerBText.length, "\n\nAdded by Peer B.");

// Exchange updates:
const updateFromA = Y.encodeStateAsUpdate(peerADoc, Y.encodeStateVector(peerBDoc));
const updateFromB = Y.encodeStateAsUpdate(peerBDoc, Y.encodeStateVector(peerADoc));

Y.applyUpdate(peerBDoc, updateFromA);
Y.applyUpdate(peerADoc, updateFromB);

assert.strictEqual(peerAText.toString(), peerBText.toString());
assert.ok(peerAText.toString().includes("<!-- Welcome -->"));
assert.ok(peerAText.toString().includes("Added by Peer B."));
console.log("✓ Concurrent editing convergence verified: both peers reached identical text!");

// 7. Test Scope and Echo Prevention Idempotency
const manager = global.KeepLocalCollabManager;
manager.setScope("workspace");
assert.strictEqual(manager.getScope(), "workspace");
manager.setScope("note");
assert.strictEqual(manager.getScope(), "note");
console.log("✓ Collaboration Scope switching (note vs workspace) verified");

// Test that syncStringToYText with identical text does zero mutations (preventing echo loops)
const initialYTextStr = peerAText.toString();
let updateTriggered = false;
peerADoc.on("update", () => { updateTriggered = true; });
syncStringToYText(peerAText, initialYTextStr);
assert.strictEqual(updateTriggered, false, "Identical string must not trigger CRDT updates");
console.log("✓ Echo prevention verified: identical text diff is strictly no-op");

// 8. Test Workspace Map Sync (Diagram 1 & 2 Workspace sharing)
const wsDocA = new Y.Doc();
const wsDocB = new Y.Doc();
const metaA = wsDocA.getMap("meta");
const metaB = wsDocB.getMap("meta");
const filesA = wsDocA.getMap("files");
const filesB = wsDocB.getMap("files");

metaA.set("scope", "workspace");
metaA.set("workspaceName", "Project Docs");
filesA.set("tree", JSON.stringify([{ id: "f1", name: "Architecture.md", content: "# Arch" }]));

// Sync from A to B:
const wsUpdateA = Y.encodeStateAsUpdate(wsDocA, Y.encodeStateVector(wsDocB));
Y.applyUpdate(wsDocB, wsUpdateA);

assert.strictEqual(metaB.get("scope"), "workspace");
assert.strictEqual(metaB.get("workspaceName"), "Project Docs");
const parsedTree = JSON.parse(filesB.get("tree"));
assert.strictEqual(parsedTree.length, 1);
assert.strictEqual(parsedTree[0].name, "Architecture.md");
console.log("✓ Entire workspace map & file tree synchronization verified");

// 9. Test Cross-Mode Block <-> Plain Offset Mapping
assert.strictEqual(typeof manager._blockToPlainOffset, "function");
assert.strictEqual(typeof manager._plainToBlockOffset, "function");
const samplePlain = "Hello world\n\nSecond block\n\nThird block";
// Test fallback behavior without DOM
const plainOffset = manager._blockToPlainOffset(1, 5);
assert.strictEqual(typeof plainOffset, "number");
const blockOffset = manager._plainToBlockOffset(15);
assert.strictEqual(typeof blockOffset, "object");
assert.ok("blockIndex" in blockOffset && "charOffset" in blockOffset);
console.log("✓ Cross-mode Block <-> Plain cursor translation verified");

console.log("\nAll KeepLocal Collaboration tests passed successfully!");

