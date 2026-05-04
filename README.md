# localKeep

**A premium, private, and local-first notes editor for the modern web.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Storage: LocalStorage](https://img.shields.io/badge/Storage-LocalStorage-blue.svg)](#)
[![Privacy: 100%](https://img.shields.io/badge/Privacy-100%25-green.svg)](#)

localKeep is a minimalist yet powerful notes application designed for those who value privacy and speed. It lives entirely in your browser, storing your data locally without any cloud synchronization or tracking.

## Features

- **Premium UI/UX**: VS Code-inspired design with a focus on productivity and aesthetics.
- **File Management**: Create, rename, delete, and organize notes into nested folders.
- **Drag & Drop**: Intuitively reorganize your file tree with smooth drag-and-drop interactions.
- **Custom Themes**: Seamlessly switch between a vibrant Light mode and a sleek Dark mode.
- **Search**: Instantly find notes by name with recursive filtering across all folders.
- **Export & Import**: Backup your entire workspace or specific folders as ZIP files.
- **Keyboard Optimized**: Modal dialogs with Enter/Esc shortcuts for a streamlined workflow.
- **Auto-Save**: Never lose a thought; every keystroke is persisted to localStorage in real-time.
- **Technical Polish**: Line numbering, cursor position tracking, and breadcrumb navigation.
- **Adjustable Font Size**: Increase or decrease editor font size to suit your preference.

## Privacy First

localKeep is built on the principle of absolute privacy:

- **No Account Required**: Start writing instantly.
- **No Cloud**: Your notes never leave your machine.
- **No Tracking**: No analytics, no cookies, just your notes.

## Installation

Since localKeep is a pure client-side application, you can run it anywhere:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/swahira/localKeep.git
   ```
2. **Open `index.html`**:
   Simply open the `index.html` file in any modern web browser.

Alternatively, you can host it on **GitHub Pages**, **Vercel**, or any static hosting provider.

## Usage

| Action | How |
|---|---|
| New file | Click **File** button or select a folder first to create inside it |
| New folder | Click **Folder** button |
| Rename | Click the edit icon on any file/folder in the tree |
| Delete | Click the trash icon on any file/folder |
| Move | Drag and drop items onto folders or empty space (root) |
| Export all | Click **Export** in the sidebar |
| Export folder | Right-click a folder and select **Export as ZIP** |
| Import | Click **Import** and select a previously exported ZIP file |
| Toggle theme | Click the moon/sun icon in the top bar |
| Adjust font size | Click **+** or **-** in the top bar |

## Built With

- **HTML5 Semantic Structure**
- **Vanilla CSS3** (Custom properties, Flexbox, Grid)
- **Vanilla JavaScript** (ES6+)
- **[Lucide Icons](https://lucide.dev/)** for consistent iconography
- **[JSZip](https://stuk.github.io/jszip/)** for client-side ZIP generation

## Known Limitations

- Search only matches file and folder names, not note content.
- Duplicate file/folder names are allowed within the same directory.
- The Tab key does not insert a tab character in the editor.
- Imported files are merged silently without a preview or summary.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT License. See `LICENSE` for more information.

Built with care for privacy and productivity.
