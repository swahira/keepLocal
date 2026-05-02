document.addEventListener("DOMContentLoaded", () => {

    let files = [
        {
            id: "root",
            name: "workspace",
            type: "folder",
            isOpen: true,
            children: [
                { id: "1", name: "note1.txt", type: "file", content: "" },
                {
                    id: "2",
                    name: "notes",
                    type: "folder",
                    isOpen: true,
                    children: [
                        { id: "3", name: "my note", type: "file", content: "hello" }
                    ]
                }
            ]
        }
    ];

    let selectedId = "3";

    const editor = document.getElementById("editor");
    const lineNumbers = document.getElementById("lineNumbers");

    /* ---------------- FIND NODE ---------------- */

    function findNode(nodes, id) {
        for (let node of nodes) {
            if (node.id === id) return node;
            if (node.children) {
                let found = findNode(node.children, id);
                if (found) return found;
            }
        }
        return null;
    }

    /* ---------------- FIND PARENT ---------------- */

    function findParent(nodes, id, parent = null) {
        for (let node of nodes) {
            if (node.id === id) return parent;
            if (node.children) {
                let found = findParent(node.children, id, node);
                if (found) return found;
            }
        }
        return null;
    }

    /* ---------------- RENDER TREE (FIXED) ---------------- */

    function renderTree(nodes, container, depth = 0) {
        nodes.forEach(node => {

            const row = document.createElement("div");
            row.className = "file";
            row.style.paddingLeft = (10 + depth * 14) + "px";

            if (node.id === selectedId) row.classList.add("active");

            let prefix = node.type === "folder"
                ? (node.isOpen ? "▼ " : "▶ ")
                : "📄 ";

            row.textContent = prefix + node.name;

            row.onclick = () => {
                if (node.type === "folder") {
                    node.isOpen = !node.isOpen;
                } else {
                    selectedId = node.id;
                    loadFile();
                }
                render();
            };

            container.appendChild(row);

            if (node.children && node.isOpen) {
                renderTree(node.children, container, depth + 1);
            }
        });
    }

    /* ---------------- LOAD FILE ---------------- */

    function loadFile() {
        const file = findNode(files, selectedId);
        if (file && file.type === "file") {
            editor.value = file.content || "";
            updateLines();
        }
    }

    /* ---------------- ADD FILE ---------------- */

    window.addFile = function () {
        const parent = findNode(files, selectedId);

        let target = (parent && parent.type === "folder")
            ? parent
            : findParent(files, selectedId) || files[0];

        const newFile = {
            id: Date.now().toString(),
            name: "new.txt",
            type: "file",
            content: ""
        };

        target.children = target.children || [];
        target.children.push(newFile);

        selectedId = newFile.id;
        render();
        loadFile();
    };

    /* ---------------- ADD FOLDER ---------------- */

    window.addFolder = function () {
        const parent = findNode(files, selectedId);

        let target = (parent && parent.type === "folder")
            ? parent
            : findParent(files, selectedId) || files[0];

        const newFolder = {
            id: Date.now().toString(),
            name: "New Folder",
            type: "folder",
            isOpen: true,
            children: []
        };

        target.children = target.children || [];
        target.children.push(newFolder);

        selectedId = newFolder.id;
        render();
    };

    /* ---------------- EDITOR ---------------- */

    editor.addEventListener("input", () => {
        const file = findNode(files, selectedId);
        if (file && file.type === "file") {
            file.content = editor.value;
        }
        updateLines();
    });

    function updateLines() {
        const count = editor.value.split("\n").length;
        lineNumbers.innerHTML = "";

        for (let i = 1; i <= count; i++) {
            const div = document.createElement("div");
            div.textContent = i;
            lineNumbers.appendChild(div);
        }
    }

    /* ---------------- RENDER ---------------- */

    function render() {
        const container = document.getElementById("fileTree");
        container.innerHTML = "";   // IMPORTANT FIX
        renderTree(files, container);
    }

    render();
    loadFile();
    updateLines();

});