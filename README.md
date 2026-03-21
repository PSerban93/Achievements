# 🎮 Achievements

A desktop application built with Electron that monitors running games and displays animated notifications for:

- ✅ Achievement unlocks
- ⏱️ Playtime tracking (Now Playing / You Played X minutes)
- 📈 Progress updates
- 🖼️ Game image overlays
- 📊 Real-time achievement dashboard
- Steam/Uplay/GOG/Epic schema support (auto-detected where possible)

**Platform:** Windows (uses Task Scheduler + Windows paths).

## ☕ Support

If you’d like to support the project further, you can buy me a coffee on Ko-fi:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/V7V81U42NF)

## ✨ Features

- **Achievement Tracking**
  - Detects running games using their process names
  - Sends notifications with custom HTML/CSS animation
  - Real-time progress monitoring and updates
  - Screenshots achievements when unlocked (optional)
- **Smart Dashboard**
  - Grid view of all configured games
  - Real-time progress tracking per game
  - Multiple sorting options:
    - Alphabetical (A-Z / Z-A)
    - Progress (Low-High / High-Low)
    - Last Updated (Recent-Old / Old-Recent)
  - Quick game search and filtering
  - Click-to-load configs
  - Play game launch button (requires executable and optional arguments)
  - Automatically refreshes when config or save files change
- **Notification System**
  - Multiple notification types:
    - Achievement unlocks
    - Progress updates
    - Playtime tracking (Now Playing / Session Ended)
  - Customizable sounds and visual presets
  - Adjustable position, duration, and scaling (presets support up to 200%)
  - Non-intrusive overlay system
  - Playtime header artwork cached locally for faster repeat notifications
  - Per-game progress mute (when a config is active)
- **Playtime Tracker**
  - Detects when configured games start and stop via process monitoring
  - Stores total Playtime per config inside `%APPDATA%/Achievements/playtime-totals.json`
  - Shows Playtime totals in the Achievements panel
  - Triggers dedicated notifications rendered by `playtime.html`
- **Customization**
  - Modern settings UI with tabs
  - Multiple visual themes/presets
  - Startup options (maximized/minimized)
  - UI scaling (75% to 200%)
  - Achievement duration slider (auto or custom)
  - Achievement sound volume (0% to 200%)
  - Show hidden descriptions (when available)
  - Close-to-tray option
  - Multi-language support for achievements

## 📁 Project Structure

| File/Folder                             | Description                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `main.js`                               | Main Electron process: window handling, core logic   |
| `preload.js`                            | IPC bridge and renderer APIs                         |
| `utils/playtime-log-watcher.js`         | Tracks game start/stop and calculates total playtime |
| `index.html`                            | Main UI with dashboard and config management         |
| `overlay.html`                          | Achievement notification overlay                     |
| `playtime.html`                         | Playtime notification template                       |
| `progress.html`                         | Progress notification template                       |
| `tray-menu.html/js/css`                 | Tray menu UI and logic                               |
| `playtime-totals.json`                  | Runtime-generated totals (`%APPDATA%/Achievements/`) |
| `preferences.json`                      | Runtime settings (`%APPDATA%/Achievements/`)         |
| `utils/`                                | Helper modules and utilities:                        |
| `utils/auto-config-generator.js`        | Auto-generates game configs from save directories    |
| `utils/generate_achievements_schema.js` | Scrapes achievement data from Steam API/Web          |
| `utils/watched-folders.js`              | Watcher + auto-select + auto-config                  |
| `utils/steam-appcache*.js`              | Steam official appcache parsing + schema build       |
| `utils/exophase-scraper.js`             | Multi-language scraping from Exophase                |
| `utils/xenia-*`                         | Xenia parsing + schema generation                    |
| `utils/rpcs3-*`                         | RPCS3 parsing + schema generation                    |
| `utils/shadps4-*`                       | PS4 trophy parsing + schema generation               |
| `utils/paths.js`, etc.                  | Other utility modules                                |
| `presets/`                              | `Default Presets` and `Users Presets` themes         |
| `sounds/`                               | Notification sound assets                            |
| `style.css`                             | Global styling for all UI components                 |
| `assets/locales/`                       | UI translations                                      |

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
4. (Recommended) Install Playwright browsers for schema scraping:
   ```bash
   npm run dl-browsers
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

### Core

- [Electron](https://electronjs.org) - Cross-platform desktop application framework
- [ps-list](https://www.npmjs.com/package/ps-list) - Process monitoring
- [crc-32](https://www.npmjs.com/package/crc-32) - Checksum calculation

### Achievement Processing

- [Playwright](https://playwright.dev) - Browser automation for achievement scraping
- [axios](https://www.npmjs.com/package/axios) - HTTP client for Steam API
- [cheerio](https://www.npmjs.com/package/cheerio) - HTML parsing
- [jsdom](https://www.npmjs.com/package/jsdom) - DOM environment

### Features

- [screenshot-desktop](https://www.npmjs.com/package/screenshot-desktop) - Achievement screenshot capture (optional install)
- [ws](https://www.npmjs.com/package/ws) - WebSocket support
- [ini](https://www.npmjs.com/package/ini) - Config file parsing

### Background Services

- `chokidar` keeps config/save directories under watch to trigger UI refreshes
- `ps-list` (via `utils/pslist-wrapper.mjs`) provides process snapshots for auto-selection and playtime tracking
- Interval timers (~2s) keep dashboard cards and playtime state up to date

## 🎮 Setup & Configuration

### Quick Start (Tutorial)

1. Open **Settings** and set Preset, and Scale.
2. Add your **Watched Folders** (recommended) so the app can detect saves/emulators.
3. Start a game once so its save folder appears; the watcher will auto-create a config when possible.
4. Let the game identify and auto-select the config, or Select the config manually, set your Language to view achievements, progress, and playtime.
5. Optional: mute progress notifications for that config using the checkbox under the config dropdown.

### First-Run Onboarding (Auto-Config Gate)

- On first run (or after onboarding version changes), startup pauses and shows a folder selection modal before full auto-scan starts.
- The app searches for known achievement/save signals (for example `achievements.json`, `achievements.ini`, `stats.bin`, emulator trophy/gpd files) and lists candidate folders.
- **Start Auto-Config** keeps selected folders active and mutes unchecked discovered folders, then continues startup and background config generation.
- **Skip and mute all** continues startup immediately and mutes discovered/default auto-config roots.
- While onboarding is pending, folder watchers and boot auto-config scans are deferred by design to avoid unwanted automatic generation.
- Onboarding completion state is saved in `%APPDATA%/Achievements/preferences.json` (`autoConfigOnboardingCompleted`, `autoConfigOnboardingVersion`, `autoConfigOnboardingCompletedAt`).
- If the modal is not visible but startup is gated, use tray action **Resume Startup (Mute all)**.

### Basic Setup

#### Manual Configuration

1. Create a new config with:
   - **Name**: Your preferred identifier
   - **AppID**: Steam AppID or folder name for achievements
   - **Config Path**: Location of achievements.json and images / Leave empty to generate
   - **Save Path**: Where achievement progress is stored
   - **Executable** (optional): Direct path to game executable
   - **Arguments** (optional): Launch parameters
   - **Process Name** (optional): Specific .exe name to monitor
   - _Note_: Names are sanitized (illegal filename characters removed, condensed spacing) before saving; the sanitized name is used on disk and for playtime totals.

**Config JSON fields (reference):**

- `appid` (string) – game id
- `platform` (string) – steam/uplay/gog/gog-official/epic/xenia/rpcs3/shadps4/steam-official/ubisoft-official
- `config_path` (string) – folder containing `achievements.json` and `img/`
- `save_path` (string) – location of save/achievement progress
- `process_name` (string) – executable name for process tracking
- `executable` / `arguments` (optional) – used for Launch

_Note_: If `config_path` points to a custom location, schema regeneration/cleanup will not overwrite that folder.

#### Auto Configuration

1. Use **Watched Folders** (recommended) to scan your emulator/save directories.
2. The app will:
   - detect AppIDs and platform,
   - fetch game name + schema,
   - download achievement data and images when available,
   - generate configs automatically.
3. Default watched folders include:
   - %PUBLIC%\Documents\Steam\CODEX
   - %PUBLIC%\Documents\Steam\RUNE
   - %PUBLIC%\Documents\OnlineFix
   - %PUBLIC%\Documents\EMPRESS
   - %APPDATA%\Goldberg SteamEmu Saves
   - %APPDATA%\GSE Saves
   - %APPDATA%\EMPRESS
   - %LOCALAPPDATA%\anadius\LSX emu\achievement_watcher
   - %APPDATA%\Steam\CODEX
   - %APPDATA%\SmartSteamEmu
   - %LOCALAPPDATA%\SKIDROW

**Note**: Auto-configuration uses the Steam Web API when a key is provided in Settings. Without a key, it falls back to SteamDB/SteamHunters + Languages from Exophase.
Sources used when available: Steam Web API, SteamDB, SteamHunters, Exophase, GOG, Epic.

#### Xenia-Canary Support

1. Open Xenia and create a User Profile.
2. Use **Watched Folders** add the 'Xenia Location'\Content/xxxxxx/xxxx/xxxx/xxxxxx' folder which is created after the Account is created in Xenia.
3. Start and play the game.
4. The app will:
   - read the file Xenia created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

#### RPCS3 Support

1. Use **Watched Folders** add the 'RPCS3 Location\dev_hdd0\home\xxxxxxx\trophy' folder which is created after the RPCS3 is configured.
2. Start and play the game.
3. The app will:
   - read the file RPCS3 created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

#### ShadPS4 Support

1. Use **Watched Folders** add the 'C:\Users\YourName\AppData\Roaming\shadPS4\game_data' folder which is created after the ShadPS4 is configured.
2. Start and play the game.
3. The app will:
   - read the file ShadPS4 created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

#### Steam Official Support

1. Use **Watched Folders** add the 'C:\Program Files (x86)\Steam\appcache\stats' folder.
2. Start and play the game via Steam.
3. The app will:
   - read the file Steam created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

#### GOG Galaxy Support

1. Install and sign in to **GOG Galaxy**.
2. Use **Watched Folders** add the `%LOCALAPPDATA%\GOG.com\Galaxy\Applications` folder.
3. Start and play the game via GOG Galaxy at least once.
4. The app will:
   - resolve the local `clientId -> productId -> game title` mapping from `%ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db`,
   - watch `%LOCALAPPDATA%\GOG.com\Galaxy\Applications\<clientId>\Gameplay\<userId>\gameplay.db`,
   - generate a `gog-official` config automatically,
   - build `achievements.json` and `achievementpercentages.json` locally from `gameplay.db`,
   - monitor later changes in `gameplay.db` and display notifications when new achievements are unlocked.

**Important notes:**

- `gog-official` is auto-generated from local GOG Galaxy data. It is not meant to be created manually from the platform dropdown.
- The config is created only after `gameplay.db` exists and the achievement table is populated and stable, to avoid generating an empty schema.
- If a game only has `Storage\...` data and no `Gameplay\<userId>\gameplay.db` yet, the app will detect the install path but will wait before creating the config.
- After creation, the config `save_path` points to the concrete `Gameplay\<userId>` folder, while runtime progress is read from `gameplay.db`.

#### Ubisoft Connect Support

1. Install and sign in to **Ubisoft Connect**.
2. Use **Watched Folders** add the `%LOCALAPPDATA%\Ubisoft Game Launcher\spool` folder manually.
3. Start and play the game via Ubisoft Connect at least once so the local spool/cache files exist.
4. The app will:
   - detect `%LOCALAPPDATA%\Ubisoft Game Launcher\spool\<userId>\<productId>.spool`,
   - generate `achievements.json`, `achievementpercentages.json` and local images from `%ProgramData%\Ubisoft\Ubisoft Game Launcher\cache\achievements`,
   - generate a `ubisoft-official` config automatically,
   - use the local `uplay-steam` mapping when a Steam AppID is available for rarity,
   - monitor later `.spool` changes and display notifications when new achievements are unlocked.

**Important notes:**

- `ubisoft-official` is auto-generated from manually watched Ubisoft Connect spool roots. It is not meant to be created manually from the platform dropdown.
- The app does not assume the Ubisoft spool path automatically; the spool root must be added manually in **Settings → Folders**.
- The config is created only after both the `.spool` file and the local achievements archive are available, so the schema can be generated first.
- After creation, the config `save_path` points to the concrete `spool\<userId>` folder, while runtime progress is read from `<productId>.spool`.

#### EA Desktop Support

1. Install and sign in to **EA Desktop**.
2. Use **Watched Folders** add the `%LOCALAPPDATA%\Electronic Arts\EA Desktop\Logs` folder manually.
3. Start and play the game via EA Desktop at least once so `EADesktopVerbose.log` contains the local achievement query for that game.
4. The app will:
   - read `EADesktopVerbose.log`,
   - resolve the local `contentId -> achievementSet -> game title` mapping from the EA Desktop verbose log,
   - generate `achievements.json` and local images from the achievement set logged by EA Desktop,
   - generate an `ea-official` config automatically,
   - monitor later verbose log changes and display notifications when new achievements are unlocked.

**Important notes:**

- `ea-official` is auto-generated from manually watched EA Desktop log roots. It is not meant to be created manually from the platform dropdown.
- The app does not assume the EA Desktop logs path automatically; the logs root must be added manually in **Settings → Folders**.
- The config is created only after EA Desktop has logged a full achievement set for that game, so the schema can be generated first.
- After creation, the config `save_path` points to the EA Desktop `Logs` folder, while runtime progress is read from `EADesktopVerbose.log`.
- EA Desktop can rotate `EADesktopVerbose.log` into `EADesktopVerbose.bak`; the app reads both so achievement events are not lost across log rotation.

### Dashboard

- Press the "Show Dashboard" button to access the game grid
- Use search to filter games quickly
- Sort by name, progress, or last update time
- Click any game to load its config
- Use the play button for games with configured executables (dashboard closes and returns focus to the main UI)
- Automatic background polling selects the active game when its process starts
- `Esc` or the close button restores the dashboard overlay and re-enables input for the rest of the window

### Customization

- Choose notification preset and screen position
- Select notification sounds and language
- Adjust UI scale (75% to 200%)
- Adjust achievement duration (auto or custom)
- Adjust achievement sound volume (0% to 200%)
- Toggle Show Hidden Description for hidden achievements
- Enable Close to Tray (X button hides to tray)
- Configure overlay shortcut or disable the overlay entirely
- Configure Overlay Interaction Key (toggle click-through ↔ drag/scroll)
- Enable/disable features:
  - Achievement screenshots
  - Progress Notification
  - Playtime Notification
  - Startup behavior
- Per-game progress notifications can be muted when a config is active
- Toggle "Start with Windows" to create/remove a Task Scheduler entry using the current executable path
- All preferences persist to `%APPDATA%/Achievements/preferences.json` and are restored on startup

### Runtime Data Locations

- `%APPDATA%/Achievements/configs` – configs
- `%APPDATA%/Achievements/schema` – generated schemas + images
- `%APPDATA%/Achievements/images` – cached covers
- `%APPDATA%/Achievements/ach_cache` – cached achievements
- `%APPDATA%/Achievements/playtime-totals.json` – playtime totals

### Keyboard & Controller Navigation

- **Global**
  - Settings: `F1` / `Ctrl+O`; Controller: Xbox View, PlayStation Share.
  - Dashboard: `F2` / `Ctrl+D`; Controller: Xbox Button, PlayStation Touchpad or PS.
  - Show/Hide Options panel (Dashboard): Context Menu key or `Shift+F10`; Controller: Xbox Y, PlayStation ⃤⃤.
  - Show/Hide Options panel (Main): `F3`; Controller: Xbox X, PlayStation ☐.
  - Back/Close: `Esc` / `Backspace`; Controller: Xbox B, PlayStation ◯.
  - Play (launch): `P` / `Ctrl+Enter` / `Shift+Enter`; Controller: Xbox Menu, PlayStation Options.
  - Confirm/Activate: `Enter` / `Space`; Controller: Xbox A, PlayStation ✕.
  - Page scroll: `PageUp` / `PageDown`; Controller: Right Stick (RS).
  - Move focus: Arrow keys; Controller: D-pad or Left Stick (LS).
- **Overlay (while visible)**
  - Toggle visibility: configurable **Overlay Shortcut** from Settings (disabled by default until assigned).
  - Toggle interaction mode (click-through ↔ interactive): configurable **Interact Key** from Settings (default: `\`).
  - Page scroll: `PageUp` / `PageDown` with fallback `Ctrl+PageUp` / `Ctrl+PageDown`.
  - Snap 5 positions: `Ctrl+Alt+Shift+1..5` (Top-Left, Top-Right, Center, Bottom-Left, Bottom-Right).
  - Cycle snap presets: `Ctrl+Alt+Shift+M`.
  - Fine nudge (20px): `Ctrl+Alt+Shift+Arrow Keys`.
  - Overlay-specific shortcuts above are active only while the overlay is shown.
- **Dashboard**
  - Grid navigation: Arrow keys, `Home`, `End`, `PageUp`, `PageDown`; Controller: D-pad or LS.
  - Search: `Ctrl+F`; Controller: Xbox X, PlayStation ☐.
  - In search: `Enter` / A / ✕ opens first visible card; Down Arrow moves focus to first card; `Esc` / B / ◯ closes Dashboard.
  - Open game (select card): `Enter`; Controller: A / ✕.
  - Show/Hide Options panel (Dashboard): Context Menu key or `Shift+F10`; Controller: Xbox Y, PlayStation ⃤⃤.
  - Play from card: Click Play; `P` / `Ctrl+Enter` / `Shift+Enter`; Controller: Menu / Options (if executable).
  - Sort cycles: `Alt+1` (Name), `Alt+2` (Progress), `Alt+3` (Last Updated); Controller: L3 / RB / LB (Xbox), L3 / R1 / L1 (PlayStation).
- **Settings panel**
  - Open/Close: `F1` / `Ctrl+O`; Controller: View / Share.
  - Tabs mode: Up/Down move; `Enter` select; `Esc` close; Controller: D-pad or RS move; A / ✕ select; B / ◯ close.
  - Section mode: Up/Down focus; Left/Right adjust; `Enter` activate; `Esc` back to Tabs; Controller: D-pad or LS focus; A / ✕ activate; B / ◯ back.
  - Cycle tabs: Controller LB/RB (Xbox) or L1/R1 (PlayStation).
- **Main screen**
  - Toggle Options: `F3`; Controller: Xbox X, PlayStation ☐.
  - Create New Config: `Ctrl+N`.
  - Move: Up/Down; Controller: D-pad or LS.
  - Play: `P` / `Ctrl+Enter` / `Shift+Enter`; Controller: Menu / Options.
- **Drop-downs**
  - Open: `Enter`.
  - While open: Up/Down/Left/Right navigate; `Enter` confirm; `Esc` / `Backspace` cancel; Controller: D-pad navigate; A / ✕ confirm; B / ◯ cancel.
  - While closed: Left/Right cycles options; Controller: D-pad Left/Right.
- **Notes**
  - Right Stick scrolling uses smooth scrolling on the active scrollable area.
  - Back is contextual: Settings Section -> Tabs; Settings Tabs -> Close; Dashboard -> Close; Config modal -> Close; Main with a selected config -> Clear selection/back.

### Game Compatibility

- Works best with games in Borderless window mode
  [Note: Games using DirectX 9/10/11 require Borderless/Borderless Windowed mode to be enabled via in-game display settings in order for notifications to show above the game window]
- Limited support for Fullscreen mode
  [Note: If a game supports and runs using DirectX 12, notifications will usually show above the game window when Fullscreen is enabled]
- Automatically detects and imports existing achievements
- Supports multiple achievement languages if available in Config

## ⚠️ Known Limitations & Workarounds

- Match privilege level between app and game (`non-admin/non-admin` or `admin/admin`) for more reliable overlay and shortcut behavior.
- If overlay shortcut does not trigger in a specific game, switch to a 3-key combo and test `Ctrl+PageUp` / `Ctrl+PageDown` fallback.
- Overlay drag may fail in elevated/protected game contexts; use snap positions (`Ctrl+Alt+Shift+1..5`) or nudge (`Ctrl+Alt+Shift+Arrow Keys`) instead.
- In some engine/driver combinations, overlay z-order can vary (may appear behind windows); retoggle overlay and prefer Borderless Windowed mode.
- Flip/compositor behavior is controlled by Windows + GPU driver; app cannot force a single flip mode across all systems.
- Toggle **Disable Hardware Acceleration** (restart required) and keep the mode that is most stable for your setup. If the overlay hotkey works but nothing is visible, turn **Disable Hardware Acceleration** off (enable hardware acceleration) and restart the app.
- If overlay display/presentation issues appear, especially when **Special K** is also active, enable **Force globalShortcut for overlay**. This switches overlay shortcuts to Electron `globalShortcut`, disables hook-based drag, and can resolve compatibility/composition issues on affected systems.
- Notifications are queue-based; long preset durations can cause perceived delay. Reduce **Notification Duration** if needed.
- Presets with expensive effects (blur/backdrop + layered animation) can micro-stutter on some GPUs; use lighter presets if needed.
- Avoid running multiple overlay/injector tools at the same time when troubleshooting display/focus issues.

### Videos

- [First Run](https://youtu.be/c1jDfynHd-U) + [Controller Support](https://youtu.be/fsqoKiMGLkw)
- [Manual Config](https://youtu.be/abdVuDB80Ow)
- [Auto Config](https://youtu.be/nOoiU5lPopM)
- [Multi-Platform Support](https://youtu.be/KwRUo53VTho)

## 👤 Author

**JokerVerse**  
Copyright © 2025

---

Feel free to contribute, fork or suggest improvements!
