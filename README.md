# 🎮 Achievements

A desktop application built with Electron that monitors running games and displays achievement notifications for:

- ✅ Achievement unlocks
- ⏱️ Playtime tracking (Now Playing / You Played X minutes)
- 📈 Progress updates
- 🖼️ Game image overlays
- 📊 Real-time achievement dashboard
- Steam/Uplay/GOG/Epic emulators, Xbox PC, MarkerPatch, MadnessPatch and official launcher schema support (auto-detected where possible)

**Platform:** Windows (uses Task Scheduler + Windows paths).

## ☕ Support

If you’d like to support the project further, you can buy me a coffee on Ko-fi:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/V7V81U42NF)

## ✨ Features

- **Achievement Tracking**
  - Detects running games using their process names
  - Sends notifications with custom HTML/CSS animation
  - Real-time progress monitoring and updates
  - Supports progress stats from Online-Fix `Stats.ini` and Tenoke `user_stats.ini`
  - Screenshots achievements when unlocked (optional)
  - Records optional achievement clips with selectable 10–30 second duration, 30/60 FPS, and system audio
  - Optional GPU HDR-to-SDR conversion keeps recorded H.264/MP4 clips compatible with standard SDR players
- **Smart Dashboard**
  - Grid view of all configured games
  - Real-time progress tracking per game
  - Multiple sorting options:
    - Alphabetical (A-Z / Z-A)
    - Progress (Low-High / High-Low)
    - Last Updated (Recent-Old / Old-Recent)
  - Quick game search and filtering
  - Platform filtering and multi-select actions for ignore/delete
  - Click-to-load configs
  - Play game launch button (requires executable and optional arguments)
  - Automatically refreshes when config or save files change
- **Notification System**
  - Multiple notification types:
    - Achievement unlocks
    - Progress updates
    - Playtime tracking (Now Playing / Session Ended)
  - Animated presets and a native Windows notification preset
  - Customizable sounds and visual presets
  - Adjustable position, duration, and scaling (presets support up to 200%)
  - Non-intrusive overlay system
  - Optional click navigation to the matching achievement in the overlay or main application
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
  - Select which achievement schema languages are generated when the source supports localization
  - Optional controller support for the overlay (`Settings -> Advanced -> Rendering`)
  - Multi-language support for achievements

## 📁 Project Structure

| File/Folder                             | Description                                          |
| --------------------------------------- | ---------------------------------------------------- |
| `main.js`                               | Main Electron process: window handling, core logic   |
| `preload.js`                            | IPC bridge and renderer APIs                         |
| `utils/playtime-log-watcher.js`         | Tracks game start/stop and calculates total playtime |
| `index.html`                            | Main UI with dashboard and config management         |
| `overlay.html`                          | Achievement notification overlay                     |
| `san-notification.html`                 | Animated achievement notification renderer           |
| `playtime.html`                         | Playtime notification template                       |
| `progress.html`                         | Progress notification template                       |
| `tray-menu.html/js/css`                 | Tray menu UI and logic                               |
| `playtime-totals.json`                  | Runtime-generated totals (`%APPDATA%/Achievements/`) |
| `preferences.json`                      | Runtime settings (`%APPDATA%/Achievements/`)         |
| `LICENSE`                               | Project license file                                 |
| `package.json`                          | Node.js dependencies and scripts                     |
| `README.md`                             | This documentation                                   |
| `style.css`                             | Global styling for all UI components                 |
| `assets/`                               | Static assets:                                       |
| `assets/steamdb.json`                   | Steam database cache                                 |
| `assets/uplay-steam.json`               | Uplay to Steam mapping                               |
| `assets/locales/`                       | UI translations                                      |
| `assets/san-runtime/`                   | Bundled runtime assets for animated notifications    |
| `assets/vendor/fontawesome/`            | Font Awesome icons                                   |
| `build/`                                | Build scripts and manifests                          |
| `fonts/`                                | Font files and licenses                              |
| `presets/`                              | `Default Presets` and `Users Presets` themes         |
| `sounds/`                               | Notification sound assets                            |
| `utils/`                                | Helper modules and utilities:                        |
| `utils/auto-config-generator.js`        | Auto-generates game configs from save directories    |
| `utils/generate_achievements_schema.js` | Generates multi-platform achievement schemas         |
| `utils/watched-folders.js`              | Watcher + auto-select + auto-config                  |
| `utils/steam-appcache*.js`              | Steam official appcache parsing + schema build       |
| `utils/exophase-scraper.js`             | Multi-language scraping from Exophase                |
| `utils/xenia-*`                         | Xenia parsing + schema generation                    |
| `utils/rpcs3-*`                         | RPCS3 parsing + schema generation                    |
| `utils/shadps4-*`                       | PS4 trophy parsing + schema generation               |
| `utils/achievement-data.js`             | Achievement data processing                          |
| `utils/achievement-rarity.js`           | Achievement rarity calculations                      |
| `utils/app-navigation.js`               | App launch argument and navigation routing            |
| `utils/atomic-json-store.js`             | Atomic JSON writes and backup recovery                |
| `utils/blacklist-identity.js`            | Global/platform blacklist identity handling           |
| `utils/config-deletion-guard.js`         | Prevents config recreation during deletion            |
| `utils/config-deletion-paths.js`         | Validates optional save/schema deletion targets       |
| `utils/config-name.js`                   | Safe config names and JSON path resolution            |
| `utils/config-platform-migrator.js`     | Config migration between platforms                   |
| `utils/content-version.js`              | Content versioning utilities                         |
| `utils/controller-input-manager.js`     | Controller input handling                            |
| `utils/ea-desktop-local.js`             | EA Desktop local integration                         |
| `utils/epic-api.js`                     | Epic Games API integration                           |
| `utils/epic-auth.js`                    | Epic authentication                                  |
| `utils/epic-identity.js`                | Epic artifact/AppID identity fallback                 |
| `utils/epic-local-installations.js`     | Epic local installations detection                   |
| `utils/epic-official.js`                | Epic official achievements                           |
| `utils/xbox-pc.js`                      | Xbox App PC discovery and direct Xbox Network sync   |
| `utils/fileCopy.js`                     | File copying utilities                               |
| `utils/game-cover.js`                   | Game cover image handling                            |
| `utils/gog-auth.js`                     | GOG authentication                                   |
| `utils/gog-galaxy-local.js`             | GOG Galaxy local integration                         |
| `utils/i18n-ui.js`                      | UI internationalization                              |
| `utils/local-game-name-cache.js`        | Local game name caching                              |
| `utils/logger.js`                       | Logging utilities                                    |
| `utils/lumaplay-event-watcher.js`       | Native LumaPlay registry change watcher              |
| `utils/lumaplay-registry.js`            | LumaPlay registry handling                           |
| `utils/markerpatch.js`                  | Dead Space 2 MarkerPatch detection and bitflag parser |
| `utils/madnesspatch.js`                 | Alice MadnessPatch detection, schema and profile bitflag parser |
| `utils/adaptive-path-watcher.js`        | Late-created local achievement path monitoring       |
| `utils/match-uplay-steam.js`            | Uplay to Steam matching                              |
| `utils/native-windows-notification-navigation.js` | Native toast activation routing          |
| `utils/overlay-controller-service.js`   | Overlay controller service                           |
| `utils/overlay-shortcut-manager.js`     | Overlay shortcut management                          |
| `utils/parseStatsBin.js`                | Stats binary parsing                                 |
| `utils/paths.js`                        | Path utilities                                       |
| `utils/playtime-store.js`               | Playtime data storage                                |
| `utils/process-event-watcher.js`        | Process event watching                               |
| `utils/process-config-match.js`          | Process-to-config matching                            |
| `utils/process-native-host.js`           | Isolated native process watcher host                  |
| `utils/process-name-utils.js`           | Process name utilities                               |
| `utils/process-poller.js`               | Process polling                                      |
| `utils/pslist-wrapper.mjs`              | PS list wrapper                                      |
| `utils/raw-hid-controller-hub.js`       | Raw HID controller hub                               |
| `utils/raw-hid-controller-worker.js`    | Raw HID controller worker                            |
| `utils/raw-hid-profiles.js`             | Raw HID profiles                                     |
| `utils/rpcs3-config-generator.js`       | RPCS3 config generation                              |
| `utils/rpcs3-trophy.js`                 | RPCS3 trophy handling                                |
| `utils/shadps4-config-generator.js`     | ShadPS4 config generation                            |
| `utils/shadps4-trophy.js`               | ShadPS4 trophy handling                              |
| `utils/startup-task.js`                 | Startup task management                              |
| `utils/steam-appcache-generator.js`     | Steam appcache generation                            |
| `utils/steam-appcache.js`               | Steam appcache handling                              |
| `utils/steam-local-users.js`            | Steam local users                                    |
| `utils/steam-schema-parse.js`            | Bundled Steam schema tool runtime and generation      |
| `utils/steamdb-launch-metadata.js`      | SteamDB launch metadata                              |
| `utils/ubisoft-connect-local.js`        | Ubisoft Connect local integration                    |
| `utils/windows-process-native-provider.js` | Native Windows process snapshot provider         |
| `utils/xenia-config-generator.js`       | Xenia config generation                              |
| `utils/xenia-gpd.js`                    | Xenia GPD handling                                   |

## 🛠️ Installation

1. Install [Node.js](https://nodejs.org) and [Git](https://git-scm.com).
2. Clone this repository:
   ```bash
   git clone https://github.com/PSerban93/achievements.git
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

### Application Launch Arguments

An existing config can be opened directly by passing both its AppID and platform to the installed or unpacked executable:

```powershell
Achievements.exe --appid=239140/steam
Achievements.exe --appid=239140 --platform=steam
```

- Both formats are supported and are equivalent.
- If Achievements is already running, the existing instance is opened and navigates to the matching config.
- The AppID and platform must match one existing config exactly. These arguments do not generate a config or launch the game.
- Supported platform values: `steam`, `steam-official`, `uplay`, `ubisoft-official`, `ea-official`, `epic`, `epic-official`, `gog`, `gog-official`, `xbox-pc`, `xenia`, `rpcs3`, `shadps4`, `markerpatch`, `madnesspatch`.

## 🧱 Building a Windows Executable

Create an unpacked Windows build:

```bash
npm run pack
```

Create the Windows installer:

```bash
npm run dist

```

Build output is created in the `dist/` folder. The build scripts verify the native process watcher and SAN notification runtime; `npm run dist` also installs the required Playwright Chromium runtimes before packaging.

## 📦 Dependencies

### Core

- [Electron](https://electronjs.org) - Cross-platform desktop application framework
- [@vscode/windows-process-tree](https://www.npmjs.com/package/@vscode/windows-process-tree) - Native Windows process monitoring
- [Koffi](https://www.npmjs.com/package/koffi) - Native Windows API bindings used by local detection services
- [ps-list](https://www.npmjs.com/package/ps-list) - Limited process-monitoring fallback
- [crc-32](https://www.npmjs.com/package/crc-32) - Checksum calculation

### Achievement Processing

- [Playwright](https://playwright.dev) - Browser automation for achievement scraping
- [axios](https://www.npmjs.com/package/axios) - HTTP client for platform APIs and metadata services
- [cheerio](https://www.npmjs.com/package/cheerio) - HTML parsing
- [jsdom](https://www.npmjs.com/package/jsdom) - DOM environment

### Features

- [screenshot-desktop](https://www.npmjs.com/package/screenshot-desktop) - Optional achievement screenshot capture
- [windows-capture](https://github.com/NiiightmareXD/windows-capture) - Windows Graphics Capture and hardware-accelerated H.264 encoding for optional achievement video clips and HDR screenshots. The bundled recorder uses a locally patched MIT-licensed 2.0.1 source snapshot to pass GPU tone-mapped surfaces directly to the encoder.
- [@xboxreplay/xboxlive-auth](https://www.npmjs.com/package/@xboxreplay/xboxlive-auth) - Microsoft/Xbox Network authentication
- [ws](https://www.npmjs.com/package/ws) - WebSocket support
- [ini](https://www.npmjs.com/package/ini) - Config file parsing

### Background Services

- `chokidar` keeps config/save directories under watch to trigger UI refreshes
- `@vscode/windows-process-tree` runs in an isolated Electron utility process and provides process events plus command-line data when required
- `ps-list` (via `utils/pslist-wrapper.mjs`) reconciles native snapshots and remains active as the limited fallback
- `achievements-recorder.exe` runs only while achievement records are enabled, retains bounded rolling video/audio segments on disk, and captures the default Windows output mix through WASAPI loopback (microphone input is not captured; unavailable audio safely falls back to video-only)
- Native snapshots run at ~1s; fallback detection runs at ~2s and hybrid reconciliation at ~12s
- Disabling the native process watcher in **Settings -> Advanced** keeps executable-name detection active through the limited `ps-list` fallback; command-line arguments are not available in that mode

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
- `platform` (string) – steam/uplay/gog/gog-official/epic/epic-official/xbox-pc/xenia/rpcs3/shadps4/markerpatch/madnesspatch/steam-official/ubisoft-official/ea-official
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
   - %APPDATA%\Goldberg UplayEmu Saves
   - %APPDATA%\GSE Saves
   - %APPDATA%\EMPRESS
   - %LOCALAPPDATA%\anadius\LSX emu\achievement_watcher
   - %APPDATA%\Steam\CODEX
   - %APPDATA%\SmartSteamEmu
   - %LOCALAPPDATA%\SKIDROW

**Note**: Auto-configuration uses the Steam Web API when a key is provided in Settings. Without a key, it falls back to SteamDB/SteamHunters + Languages from Exophase.
Sources used when available: Steam Web API, SteamDB, SteamHunters, Exophase, GOG, Epic.

#### Folder Rescan & Blacklist

- **Folders -> Rescan** opens a selection modal containing active watched folders. Use **Select All** or **Deselect All**, then scan only the selected roots.
- Ignored folders and ignored nested folders remain excluded even when their parent watched folder is selected.
- Rescan does not clear the folder ignore list or the AppID blacklist.
- Ignoring a configured game from the config/dashboard uses its AppID + platform identity, so another platform with the same AppID can remain active.
- **Settings -> Advanced -> Add Blacklisted AppIDs** adds one or more AppIDs globally, including incorrectly detected UserIDs. Separate values with commas, spaces or new lines.
- **Reset Blacklist** removes the saved global and platform-specific blacklist entries. It does not remove watched folders or rescan unrelated configs.

#### Steam Emulator Progress Files

- Online-Fix unlock state is read from `Achievements.ini`; `Stats.ini` supplies only mapped achievement progress and progress notifications.
- An empty Online-Fix `Stats.ini` is valid and remains monitored. It does not unlock achievements or clear the existing achievement cache; later stat values are applied when written.
- Tenoke reads unlock state and stats from `user_stats.ini`. Stats are mapped to schema progress rules through the achievement `operand1` value when available.
- Stats never mark an achievement unlocked by themselves; the emulator's achievement state remains the unlock source of truth.

#### LumaPlay Support

1. Enable **Settings -> Folders -> Enable LumaPlay Watcher**.
2. The app scans achievement entries under `HKCU\SOFTWARE\LumaPlay` and generates matching `uplay` configs with `emu=lumaplay` when possible.
3. While enabled, native registry change events trigger achievement refreshes and notifications without repeatedly polling the entire registry tree.

**Important notes:**

- The LumaPlay registry watcher is Windows-only and starts only while the option is enabled.
- Disabling this option stops LumaPlay registry monitoring, but does not disable watched-folder monitoring or normal process detection.

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

1. Use **Watched Folders** and add the ShadPS4 root folder: `%APPDATA%\shadPS4`.
2. Start and play the game so ShadPS4 creates the trophy schema and user progress files.
3. The app will:
   - read the schema from `%APPDATA%\shadPS4\trophy\<NPWR>\Xml`,
   - copy trophy icons from `%APPDATA%\shadPS4\trophy\<NPWR>\Icons`,
   - read unlock progress from `%APPDATA%\shadPS4\home\<userId>\trophy\<NPWR>.xml`,
   - map NPWR trophy IDs to CUSA game IDs when local ShadPS4 logs or legacy data provide the mapping,
   - generate configs automatically,
   - keep separate achievement cache files per ShadPS4 user,
   - detect user switches by monitoring all local user progress XML files for the selected game,
   - display notifications when new achievements are unlocked.

**Important notes:**

- Modern ShadPS4 storage is based on `%APPDATA%\shadPS4\trophy\<NPWR>` for schema/icons and `%APPDATA%\shadPS4\home\<userId>\trophy\<NPWR>.xml` for progress.
- Legacy ShadPS4 storage under `%APPDATA%\shadPS4\game_data\<CUSA>\TrophyFiles\trophy00` is still supported, but the modern trophy/progress layout is preferred when both exist.
- If multiple ShadPS4 users exist, caches are scoped per user so switching users does not overwrite another user's achievement state.

#### Dead Space 2 MarkerPatch Support

1. Install MarkerPatch in the Dead Space 2 game directory.
2. In **Settings -> Folders**, add the game directory containing `deadspace2.exe`, `MarkerPatch.ini` and the `achievements` folder.
3. The app creates a local `markerpatch` config and schema from the mod's text and image resources.
4. Achievement unlocks are monitored from `%LOCALAPPDATA%\EA Games\Dead Space 2\settings.txt` by reading `Controls.AcL.X` and `Controls.AcL.Y` as one 64-bit bitflag.

**Important notes:**

- The selected game directory is treated as a MarkerPatch root and is not scanned as a generic AppID container, including when it contains numeric subfolders.
- Only unlock state is supported. MarkerPatch progress values are not imported or displayed.
- The app reads the installed mod resources and the external settings file; it does not modify the game, the mod or its settings.
- If the settings directory or `settings.txt` does not exist yet, an adaptive watcher waits for it and attaches automatically without requiring an app restart.

#### Alice: Madness Returns MadnessPatch Support

1. Install MadnessPatch in the game's `Binaries\Win32` directory.
2. In **Settings -> Folders**, add either that `Win32` directory or the game directory containing it.
3. The app creates a local `madnesspatch` config and schema from the mod's `Achievements\txt` and `Achievements\img` resources.
4. Unlocks are monitored from the active profile files under `Documents\My Games\Alice Madness Returns\AliceGame\CheckPoint\<profile>\Achievements.txt`.

**Important notes:**

- The Documents base is resolved through the Windows/Electron known folder, so a relocated Documents folder is supported without hardcoding `C:\Users\...`.
- The app does not create the `CheckPoint` tree or `Achievements.txt`. If they do not exist yet, monitoring attaches automatically after MadnessPatch creates them.
- Each profile keeps an independent in-memory baseline. A newly discovered profile is seeded silently, while later bitflag changes generate notifications.
- Only the persisted unlock bitflag is imported. Runtime-only progress shown by the mod is not read from `Achievements.txt`.
- `AchievementSupport` must remain enabled in `MadnessPatch.ini` for the mod to create and update the state file.
- The selected game directory is treated as a MadnessPatch root and is not scanned as a generic AppID container.

#### Steam Launcher Support

1. Use **Watched Folders** add the 'C:\Program Files (x86)\Steam\appcache\stats' folder.
2. Start and play the game via Steam.
3. The app will:
   - read the file Steam created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

#### Epic Games Launcher Support

1. Connect an Epic account in **Settings** and use **Import Library** to pull owned games.
2. The app imports owned titles with achievements as `epic-official` configs automatically.
3. Local detection uses Epic manifest files to resolve install location, executable path and process name when the game is installed.
4. Polling runs only for the detected running Epic game, or for an Epic Official config explicitly selected by the user.
5. The dashboard reads the local achievement cache; it does not run a full Epic sync just to render the grid.

**Important notes:**

- `epic-official` configs are auto-generated and are not meant to be created manually from the platform dropdown.
- The import flow relies on Epic login and local encrypted token storage.
- Store images are resolved through Epic product metadata first, then fall back to SteamGridDB only when Epic metadata cannot provide a usable image.
- For Epic emulator folders that use an artifact/AppID instead of a namespace, schema generation can resolve the related catalog item and namespace before continuing through the normal Epic schema flow.

#### GOG Galaxy Launcher Support

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

#### Ubisoft Connect Launcher Support

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

#### EA Desktop Launcher Support

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
- The app does not assume the EA Desktop logs path automatically; the logs root must be added manually in **Settings -> Folders**.
- The config is created only after EA Desktop has logged a full achievement set for that game, so the schema can be generated first.
- After creation, the config `save_path` points to the EA Desktop `Logs` folder, while runtime progress is read from `EADesktopVerbose.log`.
- EA Desktop can rotate `EADesktopVerbose.log` into `EADesktopVerbose.bak`; the app reads both so achievement events are not lost across log rotation.

### Xbox PC (Microsoft / Xbox Network)

1. Open **Settings -> Advanced** and select **Connect Xbox** under **Xbox PC (Microsoft / Xbox Network)**.
2. Sign in through Microsoft OAuth with the account used by the Windows Xbox
   app.
3. Use **Import Xbox PC** to:
   - read achievement-enabled Windows/PC titles from the Xbox profile,
   - scan local `XboxGames` and packaged GDK installations,
   - generate `xbox-pc` configs and achievement schemas,
   - correlate local executable/AUMID information when available.
4. Achievement state is refreshed directly from Xbox Network for the selected
   Xbox PC config, with a request throttle and local cache fallback.

Notes:

- Xbox console-only history is excluded. A title is imported only when Xbox
  reports a Windows/PC device or its Title ID matches a locally installed game.
- Games delegated to EA App, Ubisoft Connect, or another launcher may not
  provide Xbox achievements on PC.
- The app stores the Microsoft refresh token and Xbox XSTS session encrypted;
  it never asks for or stores the Microsoft account password or an Entra client
  secret.
- The experimental authentication route uses the public desktop OAuth identity
  published by the [OpenXbox Xbox-WebAPI project](https://github.com/OpenXbox/xbox-webapi-python).
- This client identity is not owned by the Achievements project. Microsoft can
  restrict or revoke its use, and direct Xbox Network endpoints can still reject
  requests.
- `xbox-pc` configs are auto-generated and are not meant to be created manually.

### Dashboard

- Press the "Show Dashboard" button to access the game grid
- Use search to filter games quickly
- Filter by platform and sort by name, progress, or last update time
- Click any game to load its config
- Use `Ctrl + Click` or the card context menu to select multiple games, then ignore, delete or clear the selection from the action bar
- Blacklisted games can be shown for inspection and restored from the dashboard when **Show blacklisted games** is enabled
- Use the play button for games with configured executables (dashboard closes and returns focus to the main UI)
- Automatic background polling selects the active game when its process starts
- `Esc` or the close button restores the dashboard overlay and re-enables input for the rest of the window

### Customization

- Choose notification preset and screen position
- Choose **Native Windows** as the achievement preset to use Windows toast notifications instead of an animated preset
- Select notification sounds and language
- Select the achievement schema languages to generate from **Settings -> Advanced -> Achievements Schema Languages**
- Adjust UI scale (75% to 200%)
- Adjust achievement duration (auto or custom)
- Adjust achievement sound volume (0% to 200%)
- Toggle Show Hidden Description for hidden achievements
- Enable Close to Tray (X button hides to tray)
- Configure overlay shortcut or disable the overlay entirely
- Configure Overlay Interaction Key (toggle click-through ↔ drag/scroll)
- Optionally open the matching achievement when an animated or Native Windows notification is clicked from **Settings -> Advanced -> Notification Click Action**
- Choose whether notification clicks open the non-focusable, click-through overlay or the main application; opening the main application moves focus away from the game
- Native Windows notifications retain separate navigation routes when stored in Action Center, so each available notification can open its own achievement
- Enable/disable controller support for the overlay from **Settings -> Advanced -> Rendering**
- Enable/disable features:
  - Achievement screenshots
  - Achievement records
    - Choose 30 or 60 FPS
    - Choose a total clip duration from 10 to 30 seconds, divided equally before and after the unlock
  - Progress Notification
  - Playtime Notification
  - Startup behavior
- Per-game progress notifications can be muted when a config is active
- Toggle "Start with Windows" to create/remove a Task Scheduler entry using the current executable path
- Disable the native process watcher to use executable-name fallback detection only; matching does not require command-line arguments when the config's process name is known
- All preferences persist to `%APPDATA%/Achievements/preferences.json` and are restored on startup

### Runtime Data Locations

- `%APPDATA%/Achievements/configs` – configs
- `%APPDATA%/Achievements/configs/schema` – generated achievement schemas + local achievement images
- `%APPDATA%/Achievements/images` – cached covers
- `%USERPROFILE%/Pictures/Achievements Screenshots` – default achievement screenshot output
- `%USERPROFILE%/Videos/Achievements Records` – default achievement video output
- `%APPDATA%/Achievements/ach_cache` – cached achievements
- `%APPDATA%/Achievements/ach_cache_meta.json` – cache metadata used to avoid unnecessary cache rewrites
- `%APPDATA%/Achievements/logs` – application logs
- `%APPDATA%/Achievements/playtime-totals.json` – playtime totals
- `%APPDATA%/Achievements/preferences.json` – application settings, watched folders and blacklist state
- `%APPDATA%/Achievements/preferences.json.bak` – last valid preferences backup used for recovery after an interrupted/corrupt write
- `%APPDATA%/Achievements/xbox-pc-microsoft-auth.enc` – encrypted Microsoft/Xbox authentication state
- `%APPDATA%/Achievements/xbox-pc/titles` – per-title Xbox PC synchronization data

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
  - Enable controller support from **Settings -> Advanced -> Rendering** to control the overlay independently from the main window navigation.
  - Toggle visibility: Controller: Xbox View + Menu, PlayStation Share + Options.
  - Enter overlay control mode: Hold Xbox LB + RB, PlayStation L1 + R1.
  - Move overlay in control mode: Controller: Left Stick (LS).
  - Page scroll in control mode: Controller: Right Stick (RS).
  - Fine nudge in control mode: Controller: D-pad.
  - Cycle snap presets in control mode: Controller: Xbox Y, PlayStation △.
  - Overlay control mode ends when the shoulder buttons are released, the controller disconnects, or the overlay is no longer available.
  - Native PlayStation controller support uses Microsoft GameInput when available. If GameInput is missing, the app warns when the setting is enabled and falls back to XInput-compatible controllers only.
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
- Native Windows notification click activation can be limited when Achievements runs as administrator. If redirect does not work, run Achievements without elevation when the game permits it.
- If overlay shortcut does not trigger in a specific game, switch to a 3-key combo and test `Ctrl+PageUp` / `Ctrl+PageDown` fallback.
- Overlay drag may fail in elevated/protected game contexts; use snap positions (`Ctrl+Alt+Shift+1..5`) or nudge (`Ctrl+Alt+Shift+Arrow Keys`) instead.
- Native PlayStation controller support for the overlay depends on Microsoft GameInput. Without it, only Xbox/XInput-compatible controllers are available for the overlay controller feature.
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
- [Multi-Platform Support V2 + Overlay Controller Support](https://youtu.be/vDQ_4cNeIe8)

## 👤 Author

**JokerVerse**  
Copyright © 2025

---

Feel free to contribute, fork or suggest improvements!
