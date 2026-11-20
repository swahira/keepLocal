// Unit tests for KeepLocalMarkdown
const assert = require("assert");
const KeepLocalMarkdown = require("../js/markdown.js");

console.log("Running KeepLocalMarkdown unit tests...");

// 1. isMarkdownFile
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("notes.md"), true);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("guide.MARKDOWN"), true);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("script.js"), false);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile("image.png"), false);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile(""), false);
assert.strictEqual(KeepLocalMarkdown.isMarkdownFile(null), false);
console.log("✓ isMarkdownFile tests passed");

// 2. escHtml
assert.strictEqual(KeepLocalMarkdown.escHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
assert.strictEqual(KeepLocalMarkdown.escHtml('Hello & "World"'), "Hello &amp; &quot;World&quot;");
console.log("✓ escHtml tests passed");

// 3. sanitizeUrl
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("https://example.com"), "https://example.com");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("http://localhost:3000"), "http://localhost:3000");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("mailto:user@test.com"), "mailto:user@test.com");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("./relative/path.md"), "./relative/path.md");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("../parent/path.md"), "../parent/path.md");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("/root/path.md"), "/root/path.md");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("#anchor"), "#anchor");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("javascript:alert(1)"), "#");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("vbscript:test"), "#");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("data:text/html,<script>"), "#");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="), "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("attachments/image.webp"), "attachments/image.webp");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("blob:http://localhost:8000/123-456"), "blob:http://localhost:8000/123-456");
assert.strictEqual(KeepLocalMarkdown.sanitizeUrl("//evil.com/pic.png"), "#");
console.log("✓ sanitizeUrl tests passed");

// 4. parseStandaloneImage
const img1 = KeepLocalMarkdown.parseStandaloneImage("![My Image](https://example.com/pic.png)");
assert.deepStrictEqual(img1, { alt: "My Image", url: "https://example.com/pic.png" });

const img2 = KeepLocalMarkdown.parseStandaloneImage("Not an image");
assert.strictEqual(img2, null);

const img3 = KeepLocalMarkdown.parseStandaloneImage("![caption](data:image/jpeg;base64,12345)");
assert.deepStrictEqual(img3, { alt: "caption", url: "data:image/jpeg;base64,12345" });
console.log("✓ parseStandaloneImage tests passed");

// 5. replaceMarkdownLinksAndImages
const linkHtml = KeepLocalMarkdown.replaceMarkdownLinksAndImages("[Click here](https://example.com)", KeepLocalMarkdown.sanitizeUrl);
assert.strictEqual(linkHtml, '<a href="https://example.com" target="_blank" rel="noopener">Click here</a>');

const xssLink = KeepLocalMarkdown.replaceMarkdownLinksAndImages("[Evil](javascript:alert(1))", KeepLocalMarkdown.sanitizeUrl);
assert.strictEqual(xssLink, '<a href="#" rel="noopener" onclick="return false;">Evil</a>');

const inlineImg = KeepLocalMarkdown.replaceMarkdownLinksAndImages("![Alt text](https://example.com/img.png)", KeepLocalMarkdown.sanitizeUrl);
assert.ok(inlineImg.includes('<img src="https://example.com/img.png"'));
console.log("✓ replaceMarkdownLinksAndImages tests passed");

// 6. textToBlocks
// Headings
const h1Blocks = KeepLocalMarkdown.textToBlocks("# Heading 1");
assert.strictEqual(h1Blocks.length, 1);
assert.strictEqual(h1Blocks[0].type, "header");
assert.strictEqual(h1Blocks[0].data.level, 1);
assert.strictEqual(h1Blocks[0].data.text, "Heading 1");

const h3Blocks = KeepLocalMarkdown.textToBlocks("### Subheading");
assert.strictEqual(h3Blocks[0].data.level, 3);
assert.strictEqual(h3Blocks[0].data.text, "Subheading");

// Delimiter
const delimBlocks = KeepLocalMarkdown.textToBlocks("---");
assert.strictEqual(delimBlocks[0].type, "delimiter");

// Image
const imgBlocks = KeepLocalMarkdown.textToBlocks("![Test](https://example.com/img.png)");
assert.strictEqual(imgBlocks[0].type, "image");
assert.strictEqual(imgBlocks[0].data.url, "https://example.com/img.png");
assert.strictEqual(imgBlocks[0].data.caption, "Test");

// Alert
const alertBlocks = KeepLocalMarkdown.textToBlocks("> [!WARNING] Danger Ahead\n> Be careful!");
assert.strictEqual(alertBlocks[0].type, "warning");
assert.strictEqual(alertBlocks[0].data.alertType, "WARNING");
assert.ok(alertBlocks[0].data.title.includes("Danger Ahead"));
assert.ok(alertBlocks[0].data.message.includes("Be careful!"));

const alertRoundtrip = KeepLocalMarkdown.blocksToText({ blocks: alertBlocks });
assert.ok(alertRoundtrip.includes("> [!WARNING] Danger Ahead"));
assert.ok(alertRoundtrip.includes("> Be careful!"));

// Checklist (including uppercase [X])
const checkBlocks = KeepLocalMarkdown.textToBlocks("- [ ] Todo item\n- [x] Done item\n- [X] Upper done item");
assert.strictEqual(checkBlocks[0].type, "checklist");
assert.strictEqual(checkBlocks[0].data.items[0].checked, false);
assert.strictEqual(checkBlocks[0].data.items[0].text, "Todo item");
assert.strictEqual(checkBlocks[0].data.items[1].checked, true);
assert.strictEqual(checkBlocks[0].data.items[1].text, "Done item");
assert.strictEqual(checkBlocks[0].data.items[2].checked, true);
assert.strictEqual(checkBlocks[0].data.items[2].text, "Upper done item");

// Code block
const codeBlocks = KeepLocalMarkdown.textToBlocks("```javascript\nconst x = 42;\n```");
assert.strictEqual(codeBlocks[0].type, "code");
assert.strictEqual(codeBlocks[0].data.language, "javascript");
assert.strictEqual(codeBlocks[0].data.code, "const x = 42;");

// Inline code with asterisks and math isolation in md2h
const inlineCodeHtml = KeepLocalMarkdown.md2h("Check `const a = b * c;` for errors");
assert.ok(inlineCodeHtml.includes("<code>const a = b * c;</code>"));
assert.ok(!inlineCodeHtml.includes("<i>"));

const mathFormulaHtml = KeepLocalMarkdown.md2h("Formula: x * y * z = 100");
assert.ok(!mathFormulaHtml.includes("<i>"));

// Table with headings
const tableBlocks = KeepLocalMarkdown.textToBlocks("| Header 1 | Header 2 |\n| --- | --- |\n| Cell 1 | Cell 2 |");
assert.strictEqual(tableBlocks[0].type, "table");
assert.strictEqual(tableBlocks[0].data.withHeadings, true);
assert.deepStrictEqual(tableBlocks[0].data.content, [["Header 1", "Header 2"], ["Cell 1", "Cell 2"]]);

// Table without headings
const tableNoHeaderMd = KeepLocalMarkdown.blocksToText({
	blocks: [{ type: "table", data: { content: [["A", "B"], ["C", "D"]], withHeadings: false } }]
});
assert.ok(!tableNoHeaderMd.includes("| --- | --- |"));

// AUDIT-21: Escaped pipes and code spans in tables
const complexTableMd = "| Syntax | Code | Explanation |\n| --- | --- | --- |\n| a \\| b | `x | y` | Bitwise OR |\n| Line 1<br>Line 2 | `foo` | Multiline cell |";
const complexBlocks = KeepLocalMarkdown.textToBlocks(complexTableMd);
assert.strictEqual(complexBlocks[0].type, "table");
assert.strictEqual(complexBlocks[0].data.content.length, 3);
assert.strictEqual(complexBlocks[0].data.content[0].length, 3);
assert.strictEqual(complexBlocks[0].data.content[1].length, 3, "Escaped pipe and code pipe must not split into extra columns");
assert.strictEqual(complexBlocks[0].data.content[1][0], "a | b");
assert.strictEqual(complexBlocks[0].data.content[1][1], "<code>x | y</code>");
assert.strictEqual(complexBlocks[0].data.content[2][0], "Line 1<br>Line 2");

const complexRoundtrip = KeepLocalMarkdown.blocksToText({ blocks: complexBlocks });
assert.ok(complexRoundtrip.includes("a \\| b"), "Escaped pipe must be serialized as \\|");
assert.ok(complexRoundtrip.includes("`x | y`"), "Code span with pipe must not be broken");
assert.ok(complexRoundtrip.includes("Line 1<br>Line 2"), "<br> in cell must not create a literal newline");

// AUDIT-21: Jagged table rows padding
const jaggedBlocks = KeepLocalMarkdown.textToBlocks("| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n| Only One |");
assert.strictEqual(jaggedBlocks[0].data.content[1].length, 3, "Short row must be padded with empty strings to match maxCols");
assert.strictEqual(jaggedBlocks[0].data.content[1][1], "");
assert.strictEqual(jaggedBlocks[0].data.content[1][2], "");

// AUDIT-21: splitTableRow and formatTableCellForMd direct unit tests
assert.deepStrictEqual(KeepLocalMarkdown.splitTableRow("| a \\| b | `c | d` | e |"), ["a \\| b", "`c | d`", "e"]);
assert.strictEqual(KeepLocalMarkdown.formatTableCellForMd("a | b"), "a \\| b");
assert.strictEqual(KeepLocalMarkdown.formatTableCellForMd("`x | y`"), "`x | y`");
assert.strictEqual(KeepLocalMarkdown.formatTableCellForMd("line 1<br>line 2"), "line 1<br>line 2");

console.log("✓ textToBlocks tests passed");

// 7. blocksToText roundtrip
const roundtripMd = KeepLocalMarkdown.blocksToText({
	blocks: [
		{ type: "header", data: { level: 2, text: "Section 2" } },
		{ type: "paragraph", data: { text: "It&#39;s a test with <b>bold</b> and <i>italic</i>" } },
		{ type: "delimiter", data: {} },
		{ type: "checklist", data: { items: [{ text: "Buy milk", checked: false }, { text: "Walk dog", checked: true }] } },
		{ type: "code", data: { language: "py", code: "print('hello')" } }
	]
});

assert.ok(roundtripMd.includes("## Section 2"));
assert.ok(roundtripMd.includes("It's a test with **bold** and *italic*"));
assert.ok(!roundtripMd.includes("&#39;"));
assert.ok(roundtripMd.includes("---"));
assert.ok(roundtripMd.includes("- [ ] Buy milk"));
assert.ok(roundtripMd.includes("- [x] Walk dog"));
assert.ok(roundtripMd.includes("```py\nprint('hello')\n```"));
console.log("✓ blocksToText roundtrip tests passed");

// 8. resolveSafeZipPath (Zip Slip & path sanitization)
const safe1 = KeepLocalMarkdown.resolveSafeZipPath("docs/sub/notes.md");
assert.deepStrictEqual(safe1, ["docs", "sub", "notes.md"]);

// Zip Slip root escape attempt
const safe2 = KeepLocalMarkdown.resolveSafeZipPath("../../etc/passwd");
assert.deepStrictEqual(safe2, ["etc", "passwd"]);

// Relative resolution with backtracks
const safe3 = KeepLocalMarkdown.resolveSafeZipPath("project/temp/../final/report.txt");
assert.deepStrictEqual(safe3, ["project", "final", "report.txt"]);

// OS-illegal characters replacement
const safe4 = KeepLocalMarkdown.resolveSafeZipPath("bad:folder*/file?name<test>|pipe.md");
assert.deepStrictEqual(safe4, ["bad_folder_", "file_name_test__pipe.md"]);

// Windows-style backslashes
const safe5 = KeepLocalMarkdown.resolveSafeZipPath("windows\\sub\\file.txt");
assert.deepStrictEqual(safe5, ["windows", "sub", "file.txt"]);

// Empty, dot, and pure traversal
assert.deepStrictEqual(KeepLocalMarkdown.resolveSafeZipPath(""), []);
assert.deepStrictEqual(KeepLocalMarkdown.resolveSafeZipPath(null), []);
assert.deepStrictEqual(KeepLocalMarkdown.resolveSafeZipPath("../../../"), []);
assert.deepStrictEqual(KeepLocalMarkdown.resolveSafeZipPath("././."), []);
// 9. Markdown formatting & tight image roundtrip idempotency
const tightImages = "![img1](attachments/img1.webp)\n![img2](attachments/img2.webp)";
let tightCur = tightImages;
for (let r = 0; r < 5; r++) {
	tightCur = KeepLocalMarkdown.blocksToText({ blocks: KeepLocalMarkdown.textToBlocks(tightCur) });
}
assert.strictEqual(tightCur, tightImages, "Tight images should not insert extra blank lines across roundtrips");

const spacedImages = "![img1](attachments/img1.webp)\n\n![img2](attachments/img2.webp)";
let spacedCur = spacedImages;
for (let r = 0; r < 5; r++) {
	spacedCur = KeepLocalMarkdown.blocksToText({ blocks: KeepLocalMarkdown.textToBlocks(spacedCur) });
}
assert.strictEqual(spacedCur, spacedImages, "Spaced images should maintain single empty line across roundtrips");

const textBlocks = "# Heading\n\nParagraph 1\n\nParagraph 2";
let textCur = textBlocks;
for (let r = 0; r < 5; r++) {
	textCur = KeepLocalMarkdown.blocksToText({ blocks: KeepLocalMarkdown.textToBlocks(textCur) });
}
assert.strictEqual(textCur, textBlocks, "Text paragraphs should not multiply blank lines across roundtrips");

const doubleBlank = "# Heading\n\n\nParagraph 1";
let doubleCur = doubleBlank;
for (let r = 0; r < 5; r++) {
	doubleCur = KeepLocalMarkdown.blocksToText({ blocks: KeepLocalMarkdown.textToBlocks(doubleCur) });
}
assert.strictEqual(doubleCur, doubleBlank, "Intentional double blank lines should be preserved across roundtrips");

// Test Editor.js simulation: Editor.js paragraph tool discards `tight` on save
const userCase = "Text 1\n\n\nText 2";
let userCur = userCase;
for (let r = 0; r < 5; r++) {
	const rawBlocks = KeepLocalMarkdown.textToBlocks(userCur);
	const editorSavedBlocks = rawBlocks.map(b => {
		if (b.type === "paragraph") {
			return { type: "paragraph", data: { text: b.data?.text || "" } };
		}
		return b;
	});
	userCur = KeepLocalMarkdown.blocksToText({ blocks: editorSavedBlocks });
}
assert.strictEqual(userCur, userCase, "Two blank lines between texts should not double across Editor.js roundtrips");

// Test multiple blank lines with Editor.js stripped tight metadata
const tripleBlank = "Text 1\n\n\n\nText 2";
let tripleCur = tripleBlank;
for (let r = 0; r < 5; r++) {
	const rawBlocks = KeepLocalMarkdown.textToBlocks(tripleCur);
	const editorSavedBlocks = rawBlocks.map(b => {
		if (b.type === "paragraph") {
			return { type: "paragraph", data: { text: b.data?.text || "" } };
		}
		return b;
	});
	tripleCur = KeepLocalMarkdown.blocksToText({ blocks: editorSavedBlocks });
}
assert.strictEqual(tripleCur, tripleBlank, "Three blank lines between texts should not double across Editor.js roundtrips");

// Test Editor.js empty paragraph saved with <br>
const brBlocks = [
	{ type: "paragraph", data: { text: "Text 1" } },
	{ type: "paragraph", data: { text: "<br>" } },
	{ type: "paragraph", data: { text: "Text 2" } }
];
assert.strictEqual(KeepLocalMarkdown.blocksToText({ blocks: brBlocks }), "Text 1\n\n\nText 2");
console.log("✓ tight image and roundtrip idempotency tests passed");

// 9. isImageFile tests
assert.strictEqual(KeepLocalMarkdown.isImageFile("photo.webp"), true);
assert.strictEqual(KeepLocalMarkdown.isImageFile("image.PNG"), true);
assert.strictEqual(KeepLocalMarkdown.isImageFile("vector.svg"), true);
assert.strictEqual(KeepLocalMarkdown.isImageFile("notes.md"), false);
assert.strictEqual(KeepLocalMarkdown.isImageFile(""), false);
assert.strictEqual(KeepLocalMarkdown.isImageFile(null), false);
console.log("✓ isImageFile tests passed");

// 10. cloneFileNode tests
const mockBlob = new Blob(["sample image binary data"], { type: "image/webp" });
const originalTree = {
	id: "folder_1",
	name: "attachments",
	type: "folder",
	children: [
		{
			id: "file_img_1",
			name: "image_1.webp",
			type: "file",
			isBinary: true,
			content: mockBlob
		}
	]
};

const clonedTree = KeepLocalMarkdown.cloneFileNode(originalTree);
assert.notStrictEqual(clonedTree, originalTree, "Root folder must be a new object reference");
assert.notStrictEqual(clonedTree.children, originalTree.children, "Children array must be a new reference");
assert.strictEqual(clonedTree.children[0].content instanceof Blob, true, "Cloned file content must remain an instance of Blob");
assert.strictEqual(clonedTree.children[0].content, mockBlob, "Blob reference must be preserved without serialization corruption");
// Mutating clone children shouldn't affect original
clonedTree.children.push({ id: "file_2", name: "new.md", type: "file" });
assert.strictEqual(originalTree.children.length, 1, "Original tree children must not be mutated");
console.log("✓ cloneFileNode tests passed");

// 11. mergeFileTrees tests
const imgBlobA = new Blob(["blob_a_data"], { type: "image/webp" });
const imgBlobB = new Blob(["blob_b_data"], { type: "image/webp" });

const baseFolderNodes = [
	{
		id: "f_attachments",
		name: "attachments",
		type: "folder",
		children: [
			{
				id: "f_img_1",
				name: "diagram.webp",
				type: "file",
				isBinary: true,
				mimeType: "image/webp",
				content: imgBlobA
			}
		]
	},
	{
		id: "f_doc_1",
		name: "untitled.md",
		type: "file",
		content: "# Original Disk Content"
	}
];

const localWorkspaceNodes = [
	{
		id: "f_attachments_local",
		name: "attachments",
		type: "folder",
		children: [
			{
				id: "f_img_1_local",
				name: "diagram.webp",
				type: "file",
				isBinary: true,
				mimeType: "image/webp",
				content: imgBlobB
			}
		]
	},
	{
		id: "f_doc_1_local",
		name: "untitled.md",
		type: "file",
		content: "# Modified Local Content"
	},
	{
		id: "f_doc_2_local",
		name: "untitled-1.md",
		type: "file",
		content: "# New Local Note"
	}
];

const mergedTree = KeepLocalMarkdown.mergeFileTrees(baseFolderNodes, localWorkspaceNodes);

// A. Attachment folder checks
const mergedAttachments = mergedTree.find(n => n.name === "attachments");
assert.ok(mergedAttachments, "Merged tree must contain attachments folder");
assert.strictEqual(mergedAttachments.children.length, 1, "Duplicate attachment images must NOT be generated with (local) copies");
assert.strictEqual(mergedAttachments.children[0].content instanceof Blob, true, "Attachment content must remain an instance of Blob, never {}");
assert.strictEqual(mergedAttachments.children[0].name, "diagram.webp");

// B. Text file conflict checks
const docOriginal = mergedTree.find(n => n.name === "untitled.md");
assert.ok(docOriginal, "Base file must be preserved in merged tree");
assert.strictEqual(docOriginal.content, "# Original Disk Content");

const docLocalCopy = mergedTree.find(n => n.name === "untitled (local).md");
assert.ok(docLocalCopy, "Conflicting local text file must be preserved as (local)");
assert.strictEqual(docLocalCopy.content, "# Modified Local Content");

// C. New non-conflicting local note checks
const docNew = mergedTree.find(n => n.name === "untitled-1.md");
assert.ok(docNew, "New unique local note must be merged into tree");
assert.strictEqual(docNew.content, "# New Local Note");

// D. Repair corrupted attachment test
const corruptedBase = [
	{
		id: "f_att",
		name: "attachments",
		type: "folder",
		children: [
			{
				id: "f_corrupted",
				name: "corrupted.webp",
				type: "file",
				isBinary: true,
				content: {} // simulated corrupted content
			}
		]
	}
];

const healthyLocal = [
	{
		id: "f_att_l",
		name: "attachments",
		type: "folder",
		children: [
			{
				id: "f_healthy",
				name: "corrupted.webp",
				type: "file",
				isBinary: true,
				content: imgBlobA
			}
		]
	}
];

const repairedTree = KeepLocalMarkdown.mergeFileTrees(corruptedBase, healthyLocal);
const repairedAtt = repairedTree.find(n => n.name === "attachments");
assert.strictEqual(repairedAtt.children[0].content instanceof Blob, true, "Corrupted attachment object should be healed by healthy local blob");
console.log("✓ mergeFileTrees binary preservation, deduplication and healing tests passed");

// 12. computeBlobHash and areBlobsEqual tests (Deduplication)
(async () => {
	const blob1 = new Blob(["identical image bytes 12345"], { type: "image/webp" });
	const blob2 = new Blob(["identical image bytes 12345"], { type: "image/webp" });
	const blob3 = new Blob(["different image bytes 99999"], { type: "image/webp" });

	const hash1 = await KeepLocalMarkdown.computeBlobHash(blob1);
	const hash2 = await KeepLocalMarkdown.computeBlobHash(blob2);
	const hash3 = await KeepLocalMarkdown.computeBlobHash(blob3);

	assert.ok(hash1 && hash1.length === 64, "SHA-256 hash must be 64-char hex string");
	assert.strictEqual(hash1, hash2, "Identical content must yield identical hash");
	assert.notStrictEqual(hash1, hash3, "Different content must yield different hash");

	const isEqual1 = await KeepLocalMarkdown.areBlobsEqual(blob1, blob2);
	assert.strictEqual(isEqual1, true, "Identical blobs must evaluate to equal");

	const isEqual2 = await KeepLocalMarkdown.areBlobsEqual(blob1, blob3);
	assert.strictEqual(isEqual2, false, "Different blobs must evaluate to not equal");
	console.log("✓ computeBlobHash & areBlobsEqual attachment deduplication tests passed");

	console.log("All KeepLocalMarkdown unit tests passed successfully!");
})();
