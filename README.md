
# 🎮 Achievements

A desktop application built with Electron that monitors running games and displays beautiful animated notifications for:

- ✅ Achievement unlocks
- ⏱️ Playtime tracking (Now Playing / You Played X minutes)
- 📈 Progress updates
- 🖼️ Game image overlays

## ✨ Features

- Detects running games using their process names
- Sends notifications with custom HTML/CSS animation
- Supports multiple notification types:
  - Achievement
  - Progress
  - Playtime
- Customizable sounds and visual presets
- Notification position and scaling options
- No focus stealing – overlay remains non-intrusive
- Electron-based frontend, built for Windows

## 📁 Project Structure

| File/Folder                 | Description |
|----------------------------|-------------|
| `main.js`                  | Main Electron process: window handling, core logic |
| `playtime-log-watcher.js` | Tracks game start/stop and calculates total playtime |
| `overlay.html`, `playtime.html`, `progress.html` | Animated HTML notification templates |
| `gameImage.html`           | Displays a static game image window |
| `utils/`                   | Helper modules for paths, process listing, etc. |
| `presets/`, `sounds/`      | Custom themes and sound assets |
| `style.css`                | Global styling for notification templates |

## 🛠️ Installation

1. Install [Node.js](https://nodejs.org) and [Git](https://git-scm.com).
2. Clone this repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/achievements.git
   cd achievements
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## 🚀 Running the App

```bash
npm start
```

## 🧱 Building a Windows Executable

```bash
npm run dist
```

Creates a standalone `.exe` installer in the `dist/` folder.

## 📦 Dependencies

- [Electron](https://electronjs.org)
- [ps-list](https://www.npmjs.com/package/ps-list)
- [crc-32](https://www.npmjs.com/package/crc-32)
- [axios](https://www.npmjs.com/package/axios)
- [cheerio](https://www.npmjs.com/package/cheerio)
- [jsdom](https://www.npmjs.com/package/jsdom)

## 👤 Author

**JokerVerse**  
Copyright © 2025

---

Feel free to contribute, fork or suggest improvements!
