document.addEventListener("DOMContentLoaded", () => {
    // --- State ---
    let files = [];
    let selectedId = null;
    let theme = "light";
    let fontSize = 15;
    let searchQuery = "";
    let draggedId = null;

    const editor = document.getElementById("editor");
    const lineNumbers = document.getElementById("lineNumbers");
    const fileTreeContainer = document.getElementById("fileTree");
    const breadcrumbContainer = document.getElementById("breadcrumb");
    const cursorPosSpan = document.getElementById("cursorPos");

    // --- Persistence ---
    function loadData() {
        const savedFiles = localStorage.getItem("localKeep_files");
        const savedConfig = localStorage.getItem("localKeep_config");

        if (savedFiles) {
            files = JSON.parse(savedFiles);
        } else {
            // Default initial state: Root-level file
            files = [
                { id: "welcome", name: "Welcome.txt", type: "file", content: "Welcome to localKeep!\n\nThis is a simple, private notes app that stores everything in your browser's local storage.\n\nFeatures:\n- File & Folder management\n- Auto-save\n- Dark mode\n- Search\n- Breadcrumbs\n- Line numbers" }
            ];
        }


        if (savedConfig) {
            const config = JSON.parse(savedConfig);
            theme = config.theme || "light";
            fontSize = config.fontSize || 15;
            selectedId = config.selectedId || null;
            
            // Validate selectedId exists
            if (selectedId && !findNode(files, selectedId)) {
                selectedId = null;
            }
        }

        applyConfig();
    }

    function saveData() {
        localStorage.setItem("localKeep_files", JSON.stringify(files));
        localStorage.setItem("localKeep_config", JSON.stringify({ theme, fontSize, selectedId }));
    }

    function applyConfig() {
        document.body.setAttribute("data-theme", theme);
        const themeIcon = document.querySelector("#themeToggle i") || document.querySelector("#themeToggle svg");
        if (themeIcon) {
            if (themeIcon.tagName.toLowerCase() === "i") {
                themeIcon.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
            } else {
                // If it's already an SVG, we need to replace it or re-render
                const newIcon = document.createElement("i");
                newIcon.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
                themeIcon.replaceWith(newIcon);
            }
            if (window.lucide) lucide.createIcons();
        }
        editor.style.fontSize = fontSize + "px";
        const ln = document.querySelector(".line-numbers");
        if (ln) ln.style.fontSize = (fontSize - 2) + "px";
    }

    // --- Helper Functions ---
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

    function getPath(id, nodes = files, path = []) {
        for (let node of nodes) {
            if (node.id === id) return [...path, node];
            if (node.children) {
                let found = getPath(id, node.children, [...path, node]);
                if (found) return found;
            }
        }
        return null;
    }

    function findFirstFile(nodes) {
        for (let node of nodes) {
            if (node.type === "file") return node;
            if (node.children) {
                let found = findFirstFile(node.children);
                if (found) return found;
            }
        }
        return null;
    }

    // --- Modal Logic ---
    const modalOverlay = document.getElementById("modalOverlay");
    const modalTitle = document.getElementById("modalTitle");
    const modalInput = document.getElementById("modalInput");
    const modalMessage = document.getElementById("modalMessage");
    const modalInputHint = document.getElementById("modalInputHint");
    const modalConfirmButtons = document.getElementById("modalConfirmButtons");
    const modalConfirmBtn = document.getElementById("modalConfirmBtn");
    const modalCancelBtn = document.getElementById("modalCancelBtn");
    
    let modalCallback = null;

    function showInputModal(title, defaultValue, callback) {
        modalTitle.textContent = title;
        modalInput.value = defaultValue;
        modalInput.classList.remove("hidden");
        modalMessage.classList.add("hidden");
        modalInputHint.classList.remove("hidden");
        modalConfirmButtons.classList.add("hidden");
        
        modalOverlay.classList.add("active");
        modalInput.focus();
        modalInput.select();
        modalCallback = callback;
    }

    function showConfirmModal(title, message, callback) {
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        
        modalInput.classList.add("hidden");
        modalMessage.classList.remove("hidden");
        modalInputHint.classList.add("hidden");
        modalConfirmButtons.classList.remove("hidden");
        
        modalConfirmBtn.textContent = "Confirm";
        if (title.toLowerCase().includes("delete")) {
            modalConfirmBtn.textContent = "Delete";
        }

        modalOverlay.classList.add("active");
        modalCallback = callback;
    }

    function hideModal() {
        modalOverlay.classList.remove("active");
        modalInput.blur();
        modalCallback = null;
    }

    modalInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            if (modalCallback) modalCallback(modalInput.value);
            hideModal();
        } else if (e.key === "Escape") {
            hideModal();
        }
    });

    modalConfirmBtn.onclick = () => {
        if (modalCallback) modalCallback(true);
        hideModal();
    };

    modalCancelBtn.onclick = () => {
        hideModal();
    };

    modalOverlay.addEventListener("click", (e) => {
        if (e.target === modalOverlay) hideModal();
    });


    // --- Operations ---
    function getTarget() {
        if (!selectedId) return { array: files, node: null };
        
        const node = findNode(files, selectedId);
        if (!node) return { array: files, node: null };

        if (node.type === "folder") {
            return { array: node.children, node: node };
        } else {
            const parent = findParent(files, selectedId);
            return { array: parent ? parent.children : files, node: parent };
        }
    }

    window.addFile = function () {
        const target = getTarget();

        showInputModal("New File name:", "note.txt", (name) => {
            if (!name) return;
            const newFile = {
                id: "f_" + Date.now(),
                name: name,
                type: "file",
                content: ""
            };
            target.array.push(newFile);
            if (target.node) target.node.isOpen = true;
            selectedId = newFile.id;
            saveData();
            render();
            loadFile();
        });
    };

    window.addFolder = function () {
        const target = getTarget();

        showInputModal("New Folder name:", "New Folder", (name) => {
            if (!name) return;
            const newFolder = {
                id: "d_" + Date.now(),
                name: name,
                type: "folder",
                isOpen: true,
                children: []
            };
            target.array.push(newFolder);
            if (target.node) target.node.isOpen = true;
            selectedId = newFolder.id;
            saveData();
            render();
        });
    };

    window.renameNode = function (id) {
        const node = findNode(files, id);
        if (!node) return;

        showInputModal("Rename to:", node.name, (newName) => {
            if (newName && newName !== node.name) {
                node.name = newName;
                saveData();
                render();
                updateBreadcrumbs();
            }
        });
    };


    window.deleteNode = function (id) {
        const node = findNode(files, id);
        if (!node) return;
        
        showConfirmModal("Delete Item", `Are you sure you want to delete "${node.name}"? This action cannot be undone.`, (confirmed) => {
            if (!confirmed) return;

            const parent = findParent(files, id);
            if (parent) {
                parent.children = parent.children.filter(n => n.id !== id);
            } else {
                files = files.filter(n => n.id !== id);
            }

            if (selectedId === id) {
                selectedId = null;
                loadFile();
            }
            saveData();
            render();
        });
    };


    window.moveNode = function (sourceId, targetId) {
        if (sourceId === targetId) return;
        
        const sourceNode = findNode(files, sourceId);
        if (!sourceNode) return;

        // Safety check: Cannot move folder into itself or its descendants
        if (sourceNode.type === "folder") {
            const isDescendant = (nodes, id) => {
                const node = findNode(nodes, id);
                return !!getPath(targetId, [sourceNode]);
            };
            if (sourceId === targetId || isDescendant(sourceNode.children, targetId)) {
                return;
            }
        }

        // Remove from old parent
        const oldParent = findParent(files, sourceId);
        if (oldParent) {
            oldParent.children = oldParent.children.filter(n => n.id !== sourceId);
        } else {
            files = files.filter(n => n.id !== sourceId);
        }

        // Add to new target
        if (!targetId) {
            // Move to root
            files.push(sourceNode);
        } else {
            const targetNode = findNode(files, targetId);
            const targetArray = targetNode.type === "folder" ? targetNode.children : (findParent(files, targetId)?.children || files);
            const targetParent = targetNode.type === "folder" ? targetNode : findParent(files, targetId);
            
            targetArray.push(sourceNode);
            if (targetParent) targetParent.isOpen = true;
        }

        saveData();
        render();
    };

    // --- Export / Import Logic ---
    window.exportAll = async function () {
        const zip = new JSZip();
        addToZip(zip, files);
        const content = await zip.generateAsync({ type: "blob" });
        downloadBlob(content, "localKeep_all_notes.zip");
    };

    window.exportFolder = async function (id) {
        const node = findNode(files, id);
        if (!node || node.type !== "folder") return;
        const zip = new JSZip();
        const folder = zip.folder(node.name);
        addToZip(folder, node.children);
        const content = await zip.generateAsync({ type: "blob" });
        downloadBlob(content, `localKeep_${node.name}.zip`);
    };

    function addToZip(zipObj, nodes) {
        nodes.forEach(node => {
            if (node.type === "file") {
                zipObj.file(node.name, node.content || "");
            } else {
                const folder = zipObj.folder(node.name);
                addToZip(folder, node.children || []);
            }
        });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    window.handleImport = function (event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            const zip = await JSZip.loadAsync(e.target.result);
            const importedNodes = [];
            
            const folders = { "": importedNodes };
            const promises = [];
            zip.forEach((relativePath, file) => {
                if (!file.dir) {
                    promises.push((async () => {
                        const content = await file.async("string");
                        const parts = relativePath.split("/");
                        const fileName = parts.pop();
                        
                        let currentArray = importedNodes;
                        let currentPath = "";
                        
                        parts.forEach(dirName => {
                            const fullPath = currentPath ? `${currentPath}/${dirName}` : dirName;
                            if (!folders[fullPath]) {
                                const newFolder = {
                                    id: "d_" + Date.now() + Math.random(),
                                    name: dirName,
                                    type: "folder",
                                    isOpen: true,
                                    children: []
                                };
                                currentArray.push(newFolder);
                                folders[fullPath] = newFolder.children;
                            }
                            currentArray = folders[fullPath];
                            currentPath = fullPath;
                        });

                        currentArray.push({
                            id: "f_" + Date.now() + Math.random(),
                            name: fileName,
                            type: "file",
                            content: content
                        });
                    })());
                }
            });

            await Promise.all(promises);
            files = [...files, ...importedNodes];
            saveData();
            render();
            event.target.value = "";
        };
        reader.readAsArrayBuffer(file);
    };

    // --- Context Menu Logic ---
    const contextMenu = document.getElementById("contextMenu");
    const ctxExport = document.getElementById("ctxExport");
    let contextNodeId = null;

    window.addEventListener("click", () => {
        contextMenu.classList.add("hidden");
    });

    ctxExport.onclick = () => {
        if (contextNodeId) exportFolder(contextNodeId);
        contextMenu.classList.add("hidden");
    };



    window.toggleTheme = function () {
        theme = theme === "light" ? "dark" : "light";
        applyConfig();
        saveData();
    };

    window.changeFontSize = function (delta) {
        fontSize = Math.max(10, Math.min(30, fontSize + delta));
        applyConfig();
        saveData();
    };

    window.handleSearch = function () {
        searchQuery = document.getElementById("searchInput").value.toLowerCase();
        render();
    };

    // --- Rendering ---
    function renderTree(nodes, container, depth = 0) {
        nodes.forEach(node => {
            // When searching, we only show files that match OR folders that have matching children
            let shouldShow = true;
            let hasMatchingChild = false;

            if (searchQuery) {
                if (node.type === "file") {
                    shouldShow = node.name.toLowerCase().includes(searchQuery);
                } else {
                    // Check if any child matches (recursively)
                    hasMatchingChild = checkHasMatchingChild(node, searchQuery);
                    shouldShow = hasMatchingChild;
                }
            }

            if (!shouldShow) return;

            const item = document.createElement("div");
            item.className = "file-item";
            item.draggable = true;
            if (node.id === selectedId) item.classList.add("active");
            item.style.paddingLeft = (16 + depth * 16) + "px";

            // Drag Events
            item.ondragstart = (e) => {
                draggedId = node.id;
                item.classList.add("dragging");
                e.dataTransfer.setData("text/plain", node.id);
            };

            item.ondragend = () => {
                item.classList.remove("dragging");
                draggedId = null;
            };

            item.ondragover = (e) => {
                e.preventDefault();
                if (draggedId !== node.id) {
                    item.classList.add("drag-over");
                }
            };

            item.ondragleave = () => {
                item.classList.remove("drag-over");
            };

            item.ondrop = (e) => {
                e.preventDefault();
                e.stopPropagation();
                item.classList.remove("drag-over");
                if (draggedId) {
                    moveNode(draggedId, node.id);
                }
            };

            const icon = document.createElement("span");
            icon.className = "icon";
            let iconName = node.type === "folder" ? (node.isOpen || (searchQuery && hasMatchingChild) ? "folder-open" : "folder") : "file-text";
            icon.innerHTML = `<i data-lucide="${iconName}" size="16"></i>`;
            item.appendChild(icon);

            const nameSpan = document.createElement("span");
            nameSpan.textContent = node.name;
            item.appendChild(nameSpan);

            const actions = document.createElement("div");
            actions.className = "actions";
            actions.innerHTML = `
                <span class="action-btn" title="Rename" onclick="event.stopPropagation(); renameNode('${node.id}')"><i data-lucide="edit-3" size="14"></i></span>
                <span class="action-btn" title="Delete" onclick="event.stopPropagation(); deleteNode('${node.id}')"><i data-lucide="trash-2" size="14"></i></span>
            `;
            item.appendChild(actions);

            item.onclick = () => {
                selectedId = node.id;
                if (node.type === "folder") {
                    node.isOpen = !node.isOpen;
                } else {
                    loadFile();
                }
                saveData();
                render();
            };

            item.oncontextmenu = (e) => {
                if (node.type === "folder") {
                    e.preventDefault();
                    contextNodeId = node.id;
                    contextMenu.style.top = e.pageY + "px";
                    contextMenu.style.left = e.pageX + "px";
                    contextMenu.classList.remove("hidden");
                }
            };

            container.appendChild(item);

            if (node.children && (node.isOpen || (searchQuery && hasMatchingChild))) {
                renderTree(node.children, container, depth + 1);
            }
        });
    }

    function checkHasMatchingChild(folder, query) {
        if (!folder.children) return false;
        return folder.children.some(child => {
            if (child.type === "file") {
                return child.name.toLowerCase().includes(query);
            } else {
                return checkHasMatchingChild(child, query);
            }
        });
    }


    function updateBreadcrumbs() {
        const path = getPath(selectedId);
        breadcrumbContainer.innerHTML = "";
        if (path) {
            path.forEach((node, index) => {
                const span = document.createElement("span");
                span.className = "breadcrumb-item";
                span.textContent = node.name;
                span.onclick = () => {
                    selectedId = node.id;
                    if (node.type === "file") loadFile();
                    render();
                    saveData();
                };
                breadcrumbContainer.appendChild(span);
            });
        }
    }

    function loadFile() {
        let file = findNode(files, selectedId);
        
        // If nothing is selected or it's a folder, try to find the first available file
        if (!file || file.type !== "file") {
            const fallbackFile = findFirstFile(files);
            if (fallbackFile) {
                selectedId = fallbackFile.id;
                file = fallbackFile;
            }
        }

        if (file && file.type === "file") {
            editor.value = file.content || "";
            editor.disabled = false;
            editor.placeholder = "Start typing...";
        } else {
            // ONLY create Untitled.txt if there are NO files in the entire system
            const hasAnyFile = !!findFirstFile(files);
            
            if (!hasAnyFile) {
                const newFile = {
                    id: "f_" + Date.now(),
                    name: "Untitled.txt",
                    type: "file",
                    content: ""
                };
                files.push(newFile);
                selectedId = newFile.id;
                saveData();
                render();
                
                editor.value = "";
                editor.disabled = false;
                editor.placeholder = "Start typing...";
            } else {
                // If there ARE files but none are currently selected/found (should be rare now)
                editor.value = "";
                editor.disabled = true;
                editor.placeholder = "Select a file to edit";
            }
        }
        updateLines();
        updateBreadcrumbs();
    }




    function updateLines() {
        const lines = editor.value.split("\n");
        const count = lines.length;
        lineNumbers.innerHTML = "";
        for (let i = 1; i <= count; i++) {
            const div = document.createElement("div");
            div.textContent = i;
            lineNumbers.appendChild(div);
        }
    }

    function updateCursorPos() {
        const textBeforeCursor = editor.value.substring(0, editor.selectionStart);
        const lines = textBeforeCursor.split("\n");
        const currentLine = lines.length;
        const currentCol = lines[lines.length - 1].length + 1;
        cursorPosSpan.textContent = `Ln ${currentLine}, Col ${currentCol}`;
    }

    function render() {
        fileTreeContainer.innerHTML = "";
        renderTree(files, fileTreeContainer);
        updateBreadcrumbs();
        if (window.lucide) lucide.createIcons();
    }


    // --- Events ---
    editor.addEventListener("input", () => {
        const file = findNode(files, selectedId);
        if (file && file.type === "file") {
            file.content = editor.value;
            saveData();
        }
        updateLines();
    });

    editor.addEventListener("keyup", updateCursorPos);
    editor.addEventListener("click", updateCursorPos);
    editor.addEventListener("focus", updateCursorPos);

    // Sync scroll between textarea and line numbers
    editor.addEventListener("scroll", () => {
        lineNumbers.scrollTop = editor.scrollTop;
    });

    // --- Init ---
    loadData();
    render();
    loadFile();

    // Click on file tree container (empty space) to deselect
    fileTreeContainer.addEventListener("click", (e) => {
        if (e.target === fileTreeContainer) {
            selectedId = null;
            render();
            saveData();
            loadFile();
        }
    });

    // Drop on empty space to move to root
    fileTreeContainer.ondragover = (e) => e.preventDefault();
    fileTreeContainer.ondrop = (e) => {
        if (draggedId) {
            moveNode(draggedId, null);
        }
    };
});