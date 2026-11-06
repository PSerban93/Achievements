# 🎮 Achievements

Achievement notifications, an in-game overlay and playtime tracking for Windows, across supported launchers, emulators and native ports.

<p align="center">
  <strong>Windows</strong> ·
  <a href="https://github.com/PSerban93/Achievements/releases/latest">Download the latest release</a> ·
  <a href="#install--quick-start">Quick start</a> ·
  <a href="#supported-platforms">Supported platforms</a>
</p>

<p align="center">
  <a href=".github/media/achievements-demo.webp">
    <img src=".github/media/achievements-demo.webp" width="1200" alt="Achievements application tour: onboarding, folder discovery and manual configuration, landscape and portrait Dashboard, collections, live unlocks, manual achievement locking and backup restoration, live theme editing, animated notification customisation and click indicators, expanded notification settings, 20 Achievements and SAN styles, a dedicated animated Platinum notification, achievement progress, playtime, capture preferences and an actual God of War III Remastered recording, interactive overlay actions, languages and controller navigation with animated PlayStation and Xbox layouts, controller overlay opening, scrolling and positioning, accounts, application backup and diagnostics. Captured with demonstration data and anonymised paths, on the application wallpaper.">
  </a>
</p>

<a id="contents"></a>

<p align="center">
  <a href="#highlights">Highlights</a> ·
  <a href="#install--quick-start">Install &amp; Quick Start</a> ·
  <a href="#supported-platforms">Supported Platforms</a> ·
  <a href="#usage--configuration">Usage &amp; Configuration</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#development">Development</a> ·
  <a href="#support--credits">Support &amp; Credits</a>
</p>

## Highlights

- **One game library:** Dashboard search, platform filters, progress and custom collections.
- **Achievement tracking:** live unlocks from compatible launchers, local saves, emulators and native ports.
- **Your notification style:** animated presets, Native Windows notifications and optional Xbox Game Bar delivery.
- **In-game overlay:** browse achievements and rarity with keyboard or controller navigation.
- **Playtime tracking:** start/stop notifications and saved totals for each config.
- **Screenshots & video clips:** capture unlocks on your selected monitor, with supported HDR handling.
- **Customization:** themes, Achievements/SAN presets, sounds, positions, scale and timing.
- **Backup & restore:** move configs, collections, preferences, artwork and progress to another profile or PC.

<a id="-features"></a>

<details>
<summary><strong>Full feature list and supported sources</strong></summary>

A desktop application built with Electron that monitors running games and displays achievement notifications for:

- ✅ Achievement unlocks
- ⏱️ Playtime tracking (Now Playing / You Played X minutes)
- 📈 Progress updates
- 🖼️ Game image overlays
- 📊 Real-time achievement dashboard
- Steam/Uplay/GOG/Epic emulators, Xbox PC, RetroAchievements, XLiveLessNess, MarkerPatch, MadnessPatch, FINAL FANTASY VII `achievement.dat` and official launcher schema support (auto-detected where possible)
- PS4 Recomp trophy tracking for compatible Bloodborne, Uncharted: The Nathan Drake Collection, God of War III Remastered, MediEvil and CTR Nitro-Fueled ports ([setup and requirements](#ps4-recomp-support))

**Platform:** Windows (uses Task Scheduler + Windows paths).

- **Achievement Tracking**
  - Detects running games using their process names
  - Sends notifications with custom HTML/CSS animation
  - Real-time progress monitoring and updates
  - Supports progress stats from Online-Fix `Stats.ini` and Tenoke `user_stats.ini`
  - Screenshots achievements when unlocked (optional)
  - Choose the monitor for animated notifications, screenshots and recordings in **Settings → Notifications → Notification Toggles**. If disconnected, the first available monitor is used until the selected monitor reconnects.
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
  - Custom game collections shown as Dashboard cards, with Configs, Collections, or combined views; open a collection to view its games, add members with multi-select, and choose a color, icon, or custom image
  - Click-to-load configs
  - Play game launch button (requires executable and optional arguments)
  - Automatically refreshes when config or save files change
- **Notification System**
  - Multiple notification types:
    - Achievement unlocks
    - Progress updates
    - Playtime tracking (Now Playing / Session Ended)
  - Animated presets, a native Windows preset, and native Xbox Game Bar notifications through the optional Game Bar Widget [Achievements Overlay by JokerVerse]
  - Game Bar delivery supports achievement unlock, rarity/platinum metadata, click navigation, and textual progress (`current / maximum • percentage`)
  - The Game Bar companion is optional; when it is not installed or connected, the Electron application remains independent and uses the configured fallback
  - Optional Trophy Mode classifies unlocks as Gold below 20% rarity, Silver from 20% to below 50%, and Bronze from 50% upward; completing every achievement keeps the dedicated Platinum notification profile
  - RPCS3, ShadPS4, KytyPS5 and PS4 Recomp notifications keep their platform preset, sound, position and timing regardless of Trophy Mode, retaining native trophy grades alongside available rarity percentages. Platinum keeps its dedicated notification profile. Xenia and other platforms follow the Trophy Mode preference. Emulator notification tests use demonstration percentages.
  - Trophy Mode shows the tier color around achievement icons in notifications, the main achievement table, and the overlay; Bronze/Silver/Gold notifications use the Rare profile
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
  - Built-in GitHub release changelogs with cached offline fallback
  - Live application log viewer with source and severity filtering
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
- **Profile Backup & Restore**
  - Export the complete portable profile from **Settings -> Backup & Restore**
  - Stream backups through a TAR container compressed with Zstandard, without loading the full profile into memory
  - Restore configs, custom collections and their images, achievement cache, covers, images, presets, sounds, themes, playtime, preferences, account import metadata, and dashboard summary in one operation
  - Preview backup version and contents before replacing the current profile
  - Apply restore before watchers start, suppressing achievement notifications during migration
  - Rebase internal profile paths and refresh dashboard fingerprints when moving the profile to another Windows account or PC
  - Authentication token files are intentionally excluded; connected services can require sign-in again
  - Backup archives are not encrypted and may contain sensitive settings such as the Steam Web API key

</details>

<a id="-setup--configuration"></a>

<a id="getting-started"></a>

## Install & Quick Start

1. Download the Windows installer from [GitHub Releases](https://github.com/PSerban93/Achievements/releases/latest) and install Achievements.
2. Open the application, then follow the first-run steps below. Node.js and Git are only needed when [running from source](#development).

### Quick Start (Tutorial)

1. Open **Settings** and set Preset, and Scale.
2. Add your [**Watched Folders**](#auto-configuration) (recommended) so the app can detect saves/emulators.
3. Start a game once so its save folder appears; the watcher will auto-create a config when possible.
4. Let the game identify and auto-select the config, or Select the config manually, set your Language to view achievements, progress, and playtime.
5. Optional: mute progress notifications for that config using the checkbox under the config dropdown.

<a id="first-run-onboarding-auto-config-gate"></a>

<details>
<summary><strong>First-run folder selection and startup options</strong></summary>

- On first run (or after onboarding version changes), choose **Restore from Backup** or **Set Up as New Device** in the welcome dialog. Setting up a new device continues to folder selection before full auto-scan starts.
- In folder selection, **Back** returns to the welcome dialog.
- The app searches for known achievement/save signals (for example `achievements.json`, `achievements.ini`, `stats.bin`, emulator trophy/gpd files) and lists candidate folders.
- **Start Auto-Config** keeps selected folders active and mutes unchecked discovered folders, then continues startup and background config generation.
- **Skip and mute all** continues startup immediately and mutes discovered/default auto-config roots.
- While onboarding is pending, folder watchers and boot auto-config scans are deferred by design to avoid unwanted automatic generation.
- Onboarding completion state is saved in `%APPDATA%/Achievements/preferences.json` (`autoConfigOnboardingCompleted`, `autoConfigOnboardingVersion`, `autoConfigOnboardingCompletedAt`).
- If the modal is not visible but startup is gated, use tray action **Resume Startup (Mute all)**.

</details>

<a id="basic-setup"></a>

<details>
<summary><strong>Automatic configuration and default watched folders</strong></summary>

<a id="auto-configuration"></a>

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
   - %APPDATA%\R1 UplayEmu Saves
   - %APPDATA%\GSE Saves
   - %APPDATA%\NemirtingasEpicEmu
   - %APPDATA%\EMPRESS
   - %LOCALAPPDATA%\anadius\LSX emu\achievement_watcher
   - %APPDATA%\Steam\CODEX
   - %APPDATA%\SmartSteamEmu
   - %LOCALAPPDATA%\SKIDROW
   - %LOCALAPPDATA%\UniverseLAN

**Note**: With a Steam API key, auto-configuration tries `GetSchemaForGame` first, then `GetGameAchievements`. Without a key, it tries Schema Parse → public Steam achievement JSON → SteamCommunity → SteamDB. SteamCommunity supplies achievement IDs, texts, color/gray icons and available translations directly, without a browser. Exophase can provide additional translations when needed. Unavailable translations fall back to English.
Sources used when available: Steam Web API, Schema Parse, SteamCommunity, SteamDB, Exophase, GOG, Epic.
`Goldberg UplayEmu Saves` and `R1 UplayEmu Saves` are explicitly routed through the Uplay-to-Steam mapping while keeping the original Uplay AppID and Uplay schema storage.
`%LOCALAPPDATA%\UniverseLAN` is treated as a strict GOG root. Each immediate `<ProductID>` directory is mapped to a GOG config, and runtime progress is monitored from `<ProductID>\UniverseLANData\Achievements.ini`. Legacy game-local UniverseLAN installations continue to use `UniverseLAN.ini` discovery.

RUNE Ubisoft Connect saves are supported as an opt-in watched folder. Add `%USERPROFILE%\Documents\RUNE\Ubisoft Connect` (or its `achievements` subfolder) manually in **Settings -> Folders**. The app reads `<root>\achievements\<UserID>\<Uplay AppID>\achievements.cfg`, routes it through the existing Uplay schema/mapping flow, and ignores the sibling `savegames` tree. This path is intentionally not added to the default watched-folder list.

</details>

<a id="folder-rescan--blacklist"></a>

<details>
<summary><strong>Rescan folders and manage the blacklist</strong></summary>

- **Folders -> Rescan** opens a selection modal containing active watched folders. Use **Select All** or **Deselect All**, then scan only the selected roots.
- Ignored folders and ignored nested folders remain excluded even when their parent watched folder is selected.
- Rescan does not clear the folder ignore list or the AppID blacklist.
- Ignoring a configured game from the config/dashboard uses its AppID + platform identity, so another platform with the same AppID can remain active.
- **Settings -> Advanced -> Add Blacklisted AppIDs** adds one or more AppIDs globally, including incorrectly detected UserIDs. Separate values with commas, spaces or new lines.
- **Reset Blacklist** removes the saved global and platform-specific blacklist entries. It does not remove watched folders or rescan unrelated configs.
- Automatic emulator generation records confirmed missing IDs separately for Steam, Uplay, GOG and Epic. Generic discovery skips only the blacklisted provider and continues with the remaining providers; a known source skips its own blacklisted ID directly. An identified game without achievements stops the current discovery and is blacklisted only on its platform. A global blacklist requires negative results from all applicable providers, without technical failures, ambiguity or a previously identified game. Automatic lookup reasons are removed with their blacklist entries; older entries without reasons are never used as proof for a global blacklist.

</details>

<a id="videos"></a>

<details>
<summary><strong>Video tutorials</strong></summary>

- [First Run](https://youtu.be/c1jDfynHd-U) + [Controller Support](https://youtu.be/fsqoKiMGLkw)
- [Manual Config](https://youtu.be/abdVuDB80Ow)
- [Auto Config](https://youtu.be/nOoiU5lPopM)
- [Multi-Platform Support](https://youtu.be/KwRUo53VTho)
- [Multi-Platform Support V2 + Overlay Controller Support](https://youtu.be/vDQ_4cNeIe8)

</details>

<a id="platforms--integrations"></a>

<a id="platforms"></a>

## Supported Platforms

Choose your integration below. Each guide explains which folder or account to add, the required files and how unlocks are monitored.

Open a setup guide below for its complete instructions and requirements.

| Platform / integration     | What to add or connect                                                                                                                   | Instructions                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Steam emulators            | Local Steam emulator saves, such as Goldberg/GSE, CODEX/RUNE, Online-Fix or Tenoke; detects Steam AppIDs and tracks their saved unlocks. | [Setup](#steam-emulators) · [Folders](#auto-configuration) · [Progress](#steam-emulator-progress-files) |
| Uplay emulators            | Local Ubisoft achievement saves from Goldberg Uplay, R1 or RUNE; preserves the Uplay ID and matches it to the achievement schema.        | [Setup](#uplay-emulators) · [Folders](#auto-configuration)                                              |
| GOG emulators              | Local Galaxy emulator saves, such as Nemirtingas Galaxy or UniverseLAN; identifies the GOG product and tracks its achievement state.     | [Setup](#gog-emulators) · [Folders](#auto-configuration)                                                |
| Epic emulators             | Local Epic emulator saves, such as Nemirtingas Epic; identifies the Epic game ID and monitors its saved achievement state.               | [Setup](#epic-emulators) · [Folders](#auto-configuration)                                               |
| LumaPlay                   | Enable **Settings → Folders → Enable LumaPlay Watcher**; progress comes from the registry.                                               | [Setup](#lumaplay-support)                                                                              |
| XLiveLessNess              | Game folder containing `xlive.dll`, the game executable and its matching `.exe.cfg`.                                                     | [Setup](#xlivelessness-support)                                                                         |
| FINAL FANTASY VII          | Game folder with the required FFVII config files and `steam_appid.txt` set to `39140`.                                                   | [Setup](#final-fantasy-vii-achievementdat-support)                                                      |
| Dead Space 2 / MarkerPatch | Game folder containing `deadspace2.exe`, `MarkerPatch.ini` and `achievements`.                                                           | [Setup](#dead-space-2-markerpatch-support)                                                              |
| Alice / MadnessPatch       | Game folder or `Binaries\Win32` with MadnessPatch installed.                                                                             | [Setup](#alice-madness-returns-madnesspatch-support)                                                    |
| Steam launcher             | `C:\Program Files (x86)\Steam\appcache\stats`.                                                                                           | [Setup](#steam-launcher-support)                                                                        |
| Epic Games launcher        | Connect your Epic account in Settings, then use **Import Library**.                                                                      | [Setup](#epic-games-launcher-support)                                                                   |
| GOG Galaxy                 | `%LOCALAPPDATA%\GOG.com\Galaxy\Applications`.                                                                                            | [Setup](#gog-galaxy-launcher-support)                                                                   |
| Ubisoft Connect            | `%LOCALAPPDATA%\Ubisoft Game Launcher\spool`.                                                                                            | [Setup](#ubisoft-connect-launcher-support)                                                              |
| EA Desktop                 | `%LOCALAPPDATA%\Electronic Arts\EA Desktop\Logs`.                                                                                        | [Setup](#ea-desktop-launcher-support)                                                                   |
| PC Ports / LADXHD Updated  | Installed game folder with its executable and `Data` resources.                                                                          | [Setup](#pc-ports-ladxhd-updated)                                                                       |
| Xbox 360 Recomp            | Installed port folder, including the original game data required by that port.                                                           | [Setup](#xbox-360-recompilations-and-native-ports)                                                      |
| PS3 Recomp                 | Built port installation folder with its launcher/project configuration and original game data.                                           | [Setup](#ps3-recomp)                                                                                    |
| PS4 Recomp                 | Port installation folder, after selecting the original game and save locations in its launcher.                                          | [Setup](#ps4-recomp-support)                                                                            |
| Xenia-Canary               | The profile's achievement content folder under the Xenia installation.                                                                   | [Setup](#xenia-canary-support)                                                                          |
| RPCS3                      | `<RPCS3>\dev_hdd0\home\<user>\trophy`.                                                                                                   | [Setup](#rpcs3-support)                                                                                 |
| ShadPS4                    | ShadPS4 root folder, normally `%APPDATA%\shadPS4`.                                                                                       | [Setup](#shadps4-support)                                                                               |
| KytyPS5                    | Emulator folder containing `kyty_emulator.exe`; register game locations in the KytyPS5 launcher first.                                   | [Setup](#kytyps5-support)                                                                               |
| Xbox PC                    | Connect Xbox in **Settings → Advanced**, then use **Import Xbox PC**.                                                                    | [Setup](#xbox-pc-microsoft--xbox-network)                                                               |
| RetroAchievements          | Username and Web API key in **Settings → Advanced**, then **Connect → Import Library**.                                                  | [Setup](#retroachievements)                                                                             |

<details>
<summary>Browse by integration category</summary>

| Integration                         | Setup guides                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PC emulators and local integrations | [Steam emulator progress files](#steam-emulator-progress-files) · [LumaPlay](#lumaplay-support) · [XLiveLessNess](#xlivelessness-support) · [FINAL FANTASY VII](#final-fantasy-vii-achievementdat-support) · [MarkerPatch](#dead-space-2-markerpatch-support) · [MadnessPatch](#alice-madness-returns-madnesspatch-support) |
| Official PC launchers               | [Steam](#steam-launcher-support) · [Epic Games](#epic-games-launcher-support) · [GOG Galaxy](#gog-galaxy-launcher-support) · [Ubisoft Connect](#ubisoft-connect-launcher-support) · [EA Desktop](#ea-desktop-launcher-support)                                                                                              |
| Recompilations and native ports     | [PC Ports / LADXHD Updated](#pc-ports-ladxhd-updated) · [Xbox 360 Recomp](#xbox-360-recompilations-and-native-ports) · [PS3 Recomp](#ps3-recomp) · [PS4 Recomp](#ps4-recomp-support)                                                                                                                                        |
| Console emulators                   | [Xenia-Canary](#xenia-canary-support) · [RPCS3](#rpcs3-support) · [ShadPS4](#shadps4-support) · [KytyPS5](#kytyps5-support)                                                                                                                                                                                                 |
| Online accounts                     | [Xbox PC](#xbox-pc-microsoft--xbox-network) · [RetroAchievements](#retroachievements)                                                                                                                                                                                                                                       |

</details>

### PC Emulators & Local Integrations

<details>
<summary><strong>Steam emulators</strong></summary>

<a id="steam-emulators"></a>

Add the emulator's **achievement/save folder** in **Settings → Folders**. Supported layouts include Goldberg/GSE, CODEX/RUNE, Online-Fix and Tenoke. Common roots are listed in [Folders](#auto-configuration); game-local saves can be added directly.

Achievements detects the Steam AppID, downloads the matching schema and images, creates a config and monitors the local unlock file. Supported save formats include `achievements.json`, `achievements.ini`, `stats.bin` and Tenoke `user_stats.ini`, depending on the emulator. [Intermediate progress](#steam-emulator-progress-files) is available when the saved data supplies the required counters.

</details>

<details>
<summary><strong>Uplay emulators</strong></summary>

<a id="uplay-emulators"></a>

Add `%APPDATA%\Goldberg UplayEmu Saves`, `%APPDATA%\R1 UplayEmu Saves`, or your compatible game-local achievement folder in **Settings → Folders**. For RUNE Ubisoft Connect, add `%USERPROFILE%\Documents\RUNE\Ubisoft Connect` or its `achievements` subfolder.

The app identifies the **Uplay AppID**, generates the corresponding schema and monitors locally saved unlocks. Where needed, Uplay-to-Steam mapping supplies achievement metadata while the config retains its Uplay identity. RUNE's `achievements\<UserID>\<Uplay AppID>\achievements.cfg` is supported; its separate `savegames` folder is excluded.

</details>

<details>
<summary><strong>GOG emulators</strong></summary>

<a id="gog-emulators"></a>

Add `%APPDATA%\NemirtingasGalaxyEmu`, `%LOCALAPPDATA%\UniverseLAN`, or the compatible game-local emulator folder in **Settings → Folders**.

The app identifies the **GOG product ID**, generates the achievement schema and monitors local unlocks. UniverseLAN uses `<ProductID>\UniverseLANData\Achievements.ini`; game-local installations with `UniverseLAN.ini` are also detected. This does not require importing your GOG Galaxy library.

</details>

<details>
<summary><strong>Epic emulators</strong></summary>

<a id="epic-emulators"></a>

Add `%APPDATA%\NemirtingasEpicEmu` or the compatible game-local achievement/save folder in **Settings → Folders**.

The app identifies the **Epic game ID**, generates the matching schema and monitors the emulator's local achievement state. This local-save integration is separate from connecting an official Epic account and importing its library.

</details>

<details>
<summary><strong>Achievement progress and supported save files</strong></summary>

<a id="steam-emulator-progress-files"></a>

Progress notifications show an intermediate value such as **35 / 100** when the save contains a usable counter and the schema defines its target. They are separate from unlock notifications. Support depends on what each emulator writes; enabling progress notifications cannot create counters that the game does not save.

- Compatible JSON saves can provide `progress` / `max_progress` directly; supported binary stats are matched to the achievement schema.
- Online-Fix and Tenoke also expose counters through the stat files described below. Progress support is not restricted to Online-Fix.

- Online-Fix unlock state is read from `Achievements.ini`; `Stats.ini` supplies only mapped achievement progress and progress notifications.
- An empty Online-Fix `Stats.ini` is valid and remains monitored. It does not unlock achievements or clear the existing achievement cache; later stat values are applied when written.
- Tenoke reads unlock state and stats from `user_stats.ini`. Stats are mapped to schema progress rules through the achievement `operand1` value when available.
- Stats never mark an achievement unlocked by themselves; the emulator's achievement state remains the unlock source of truth.

</details>

<a id="lumaplay-support"></a>

<details>
<summary><strong>LumaPlay Support</strong></summary>

1. Enable **Settings -> Folders -> Enable LumaPlay Watcher**.
2. The app scans achievement entries under `HKCU\SOFTWARE\LumaPlay` and generates matching `uplay` configs with `emu=lumaplay` when possible.
3. While enabled, native registry change events trigger achievement refreshes and notifications without repeatedly polling the entire registry tree.

**Important notes:**

- The LumaPlay registry watcher is Windows-only and starts only while the option is enabled.
- Disabling this option stops LumaPlay registry monitoring, but does not disable watched-folder monitoring or normal process detection.

</details>

<a id="xlivelessness-support"></a>

<details>
<summary><strong>XLiveLessNess Support</strong></summary>

1. Install and configure XLiveLessNess for the supported Games for Windows - LIVE title, then start the game once if the emulator needs to create its profile data.
2. In **Settings -> Folders**, add the installed game directory. It can be the game root or a parent that contains the required files within the supported discovery depth.
3. Confirm that one executable directory contains `xlive.dll`, `<game>.exe` and the matching `<game>.exe.cfg`. Use **Folders -> Rescan** if the folder was added before these files were installed.
4. The app reads the title ID from `<game>.exe.cfg` and the executable's embedded `SPAFILE` resource to obtain localized achievement names/descriptions, Gamerscore values and images.
5. A local `xlivelessness` config and schema are generated. The detected executable and process names are saved for launch, process detection, auto-select and playtime.
6. Unlocks are read from each matching `<profile>\achievements.dat` below `XLiveLessNess\profile\title\<TITLEID>`.

Expected game-side layout:

```text
<Game folder>\
└─ <executable directory>\
   ├─ xlive.dll
   ├─ <game>.exe
   └─ <game>.exe.cfg
```

**Important notes:**

- Discovery and SPAFILE/schema processing run asynchronously. XLiveLessNess scan and generation stages are reported through the same generation progress rail used by the other supported local platforms.
- `achievements.dat` is not required when the config is first generated. If the profile/title path does not exist yet, the adaptive watcher attaches after XLiveLessNess creates it.
- The default global state root `%LOCALAPPDATA%\XLiveLessNess` and game-local `XLiveLessNess` roots are monitored adaptively, including when their profile/title directories do not exist yet.
- A custom XLiveLessNess storage root can also be added directly in **Settings -> Folders**. The app links it to existing XLiveLessNess configs without treating profile or title folders as generic AppIDs.
- When process command-line detection is available, `-xllnconfig=<path>` is resolved and its containing directory is added as another state root automatically.
- Multiple executables for the same title ID are kept in one config as process-name alternatives. Profiles keep independent baselines so changing profiles does not create false unlock notifications.
- Achievement schema languages follow the selection in **Settings -> Advanced -> Achievements Schema Languages** when the embedded SPAFILE contains those localizations.
- Builds that export DLC achievement metadata in `dlc/<TITLEID>/<pack>/Content/spa.bin` are supported. Use **Folders -> Rescan** after installing DLC to add its achievements and images to the existing game config.
- The app only reads the installed executable, XLiveLessNess title config, DLC metadata and `achievements.dat`; it does not modify the game or emulator data.

</details>

<a id="final-fantasy-vii-achievementdat-support"></a>

<details>
<summary><strong>FINAL FANTASY VII `achievement.dat` Support</strong></summary>

1. In the FINAL FANTASY VII game directory, add `steam_appid.txt` containing only `39140`.
2. In **Settings -> Folders**, add that game directory.
3. Detection activates only when `steam_appid.txt`, `ff7input.cfg`, `ff7sound.cfg` and `ff7video.cfg` are present together.
4. The app generates a separate Steam config and schema for AppID `39140`, then reads unlock bits from the adjacent `achievement.dat`.

**Important notes:**

- `steam_appid.txt` alone is ignored, so ordinary game folders and other platform flows are unaffected.
- `achievement.dat` is optional during config generation. An adaptive watcher waits for the game to create it.
- Existing unlocks are imported silently when the file already exists. If the file is first created after monitoring starts, newly set bits generate notifications and receive the local detection time in the cache.
- The file does not contain historical unlock timestamps; previously unlocked achievements without a cached timestamp therefore display no fabricated historical date.
- An existing Steam config for AppID `39140` is not modified or merged. This source receives its own config, identified internally by the `ff7-achievement-dat` provider.

</details>

<a id="dead-space-2-markerpatch-support"></a>

<details>
<summary><strong>Dead Space 2 MarkerPatch Support</strong></summary>

1. Install MarkerPatch in the Dead Space 2 game directory.
2. In **Settings -> Folders**, add the game directory containing `deadspace2.exe`, `MarkerPatch.ini` and the `achievements` folder.
3. The app creates a local `markerpatch` config and schema from the mod's text and image resources.
4. Achievement unlocks are monitored from `%LOCALAPPDATA%\EA Games\Dead Space 2\settings.txt` by reading `Controls.AcL.X` and `Controls.AcL.Y` as one 64-bit bitflag.

**Important notes:**

- The selected game directory is treated as a MarkerPatch root and is not scanned as a generic AppID container, including when it contains numeric subfolders.
- Only unlock state is supported. MarkerPatch progress values are not imported or displayed.
- The app reads the installed mod resources and the external settings file; it does not modify the game, the mod or its settings.
- If the settings directory or `settings.txt` does not exist yet, an adaptive watcher waits for it and attaches automatically without requiring an app restart.

</details>

<a id="alice-madness-returns-madnesspatch-support"></a>

<details>
<summary><strong>Alice: Madness Returns MadnessPatch Support</strong></summary>

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

</details>

### Official PC Launchers

<a id="steam-launcher-support"></a>

<details>
<summary><strong>Steam Launcher Support</strong></summary>

1. Use **Watched Folders** add the 'C:\Program Files (x86)\Steam\appcache\stats' folder.
2. Start and play the game via Steam.
3. The app will:
   - read the file Steam created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

</details>

<a id="epic-games-launcher-support"></a>

<details>
<summary><strong>Epic Games Launcher Support</strong></summary>

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

</details>

<a id="gog-galaxy-launcher-support"></a>

<details>
<summary><strong>GOG Galaxy Launcher Support</strong></summary>

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

</details>

<a id="ubisoft-connect-launcher-support"></a>

<details>
<summary><strong>Ubisoft Connect Launcher Support</strong></summary>

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

</details>

<a id="ea-desktop-launcher-support"></a>

<details>
<summary><strong>EA Desktop Launcher Support</strong></summary>

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

</details>

### Recompilations & Native Ports

<a id="pc-ports-ladxhd-updated"></a>

<details>
<summary><strong>PC Ports: LADXHD Updated</strong></summary>

1. Install **Link's Awakening DX HD Updated** using the game's own instructions.
2. In **Settings → Folders**, add the installed game folder containing `Link's Awakening DX HD.exe`, `Data/Languages` and `Data/Achievements`. The patcher or launcher folder alone is insufficient.
3. Use **Rescan** if generation does not start. A **PC Ports** config appears in the config selector and Dashboard, with the game's achievement list and icons.
4. Configure its notifications under **Main Achievements** in the Notifications tab.
5. Start the game and unlock an achievement. Achievements monitors the save location automatically; you do not need to add another folder.

**Important notes:**

- Normal Windows installations save progress in `%LOCALAPPDATA%/Zelda_LA/achievements`. Portable installations use the `achievements` file in the game folder. After switching portable mode, rescan the game folder.
- Progress is shared across the game's save slots. Previously unlocked achievements are imported without displaying old notifications.
- Rarity is filled when a matching Exophase page is available and can be updated with **Refresh Rarity**. These percentages describe the GBC/Retro player population, rather than players of the PC port. Missing rarity does not prevent unlock notifications.

</details>

<a id="xbox-360-recompilations-and-native-ports"></a>

<details>
<summary><strong>Xbox 360 Recompilations and Native Ports</strong></summary>

1. Install the recompilation or native port, including its required game data, using that project's instructions.
2. In **Settings → Folders**, add the installed game's folder. Use the examples below to choose the correct location.
3. Use **Rescan** if generation does not start. An **Xbox 360 Recomp** config appears in the config selector and Dashboard, with the available achievement list and icons.
4. Configure **Xbox 360 Recomp Notification** in the Notifications tab.
5. If **Game Profile** is shown below the configuration controls, select the same profile used by the game.
6. Start the game and unlock an achievement. Supported save locations are monitored automatically, including those outside the game folder. You do not need to add the entire Documents or AppData folder.

| Game / port                                   | Folder to add in Settings → Folders                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dante's Inferno                               | The installed game folder containing `dantes_inferno.exe`, `dantes_inferno_native.exe` or `dantesinferno.exe` and its game data.                                                                               |
| LEGO Dimensions                               | The installed game folder containing `legodimensions.exe` and its game data.                                                                                                                                   |
| Midnight Club: Los Angeles                    | The installed game folder containing `midnightclubla.exe`, `mcla.exe` or `larecomp.exe`. If the executable is under `out/build`, add the installation folder containing both that directory and the game data. |
| Spider-Man: Edge of Time                      | The installed game folder containing `SpiderManEOT.exe` and its game data.                                                                                                                                     |
| Blue Dragon (re:Blue)                         | The final installation containing `reblue.exe`, the installed game data and `profiles`. This may differ from the folder where you first extracted the installer.                                               |
| Gears of War 2 Hollow                         | The installed game folder containing the `GearGame/SaveData` directory.                                                                                                                                        |
| Unleashed Recompiled                          | The installed game folder containing `UnleashedRecomp.exe` and its game data.                                                                                                                                  |
| Castlevania: Symphony of the Night (Nocturne) | The installed game folder containing `nocturnerecomp.exe` and the game's XEX. The XEX identifies the US or Japanese version.                                                                                   |
| Silent Hill: Downpour                         | The installed game folder containing `downpour.exe` and its game data. Unlocks are monitored in the game's `user` folder.                                                                                      |
| Deadly Premonition                            | The installed game folder containing `deadlyprem.exe` / `deadlyprem_usa.exe` and its game data. The XEX selects the matching regional executable; unlocks are monitored in `userdata`.                         |
| Fable II (himdo)                              | The installed game folder containing `fable_2.exe` and its game data. Unlocks are monitored in `saves`.                                                                                                        |
| Naughty Bear (ReStuff)                        | The installed game folder containing `restuff.exe` and its game data. Its Documents save location is selected automatically.                                                                                   |
| Condemned 2: Bloodshot                        | The installed game folder containing `condemned2recomp.exe` and its game data. Unlocks are monitored in `UserData`.                                                                                            |
| Project Gotham Racing 4                       | The installed game folder containing `pgr4_recomp.exe` or `pgr4_recompiled.exe` and its game data. The Documents save location follows the executable's application name.                                      |
| Crackdown 2                                   | The installed game folder containing `crackdown2.exe` and its game data, built with achievement persistence support. Its Documents save location is selected automatically.                                    |
| Banjo-Kazooie: Nuts & Bolts (reNut)           | The installed game folder containing `renut.exe`. Complete the game's path setup wizard first; Achievements reads the game and save locations from `renut.cfg`.                                                |
| Lost Odyssey (freefrank)                      | The installed port folder containing `LostOdysseyRecomp.exe`. Imported game data is located through `game-path.txt` or `game/disc1`; unlocks are monitored in `profile/achievements.ini`.                      |

**Important notes:**

- Use a build that saves achievement unlocks. **Skate3Recomp v2.0.2** can import the achievement list, but its unlocks are not saved and cannot produce live notifications in Achievements.
- Other compatible ReXGlue builds and portable ports using `game-path.txt` with local profile storage can also be detected without a listed executable name. Add the installed port folder after configuring its original game data. Supported progress formats include ReXGlue TOML, `EOTACH1` TSV, compatible achievement JSON and earned-only INI.
- Supported games can generate a config before the first achievement is unlocked. If the config reports that its unlock source is pending, start the game and unlock an achievement, then rescan if necessary. Live notifications require a recognized save location.
- The first import generates the achievement schema and retrieves its metadata and achievement icons. After a successful import, changes to game settings, save paths, or player profiles do not rebuild the schema automatically. Use **Folders -> Rescan** for a later rebuild or to retry metadata and icons that failed during the initial import.
- If the unlock location is not yet confirmed, Achievements watches for compatible progress files in the game folder, Documents and any explicitly configured save location. Once a valid source is found, its path is saved and only its progress directory is monitored. Documents does not need to be added to Folders; adding it separately does not create another X360 Recomp config for the same installation.
- For the newly listed ReXGlue ports, the monitored file is `achievements/<TitleID>.toml` inside the game's save location. Its folder and file may appear only after an unlock; monitoring is prepared beforehand. A literal save-path override in a supported batch or PowerShell launcher is also recognized, except for Fable II, which forces its local `saves` folder, and reNut, which uses its path wizard.
- For reNut, an absent or invalid `renut.cfg` leaves the unlock source pending on a new import. Complete the game's path wizard, then use **Rescan** if needed. Existing confirmed monitoring paths are retained while the file is temporarily unavailable.
- Generated configs include the game/save path arguments recognized in a supported launcher. Manually edited launch arguments are preserved. After changing these arguments, use **Rescan** before starting the game so monitoring follows the same save location as **Play**.
- Changing the unlock location keeps progress from the previous location separate. Achievements already present in the new save are imported silently; subsequent unlocks produce notifications.
- Previously unlocked achievements are imported without displaying old notifications. Each available profile keeps its own progress.
- re:Blue's eight additional achievements are included automatically for supported builds.
- Keep the port's game data installed. A copied Xbox `default.xex` alone is insufficient to identify a recompilation. Renamed executables, custom builds and unsupported save locations may require additional configuration.

</details>

<a id="ps3-recomp"></a>

<details>
<summary><strong>PS3 Recomp</strong></summary>

Add the built port installation folder in **Settings → Folders**. Ports using the PS3Recomp trophy JSON format are supported when their launcher/project configuration locates the original game data. Trophy names and icons are extracted locally from `TROPHY.TRP`; RPCS3 is not required. Keep the original game data available for the first import. Use **Folders → Rescan** to rebuild a schema. Notification settings are under **PS3 Recomp Notification**.

</details>

<a id="ps4-recomp-support"></a>

<details>
<summary><strong>PS4 Recomp Support</strong></summary>

1. Install the port and the game data required by that port.
2. Select the original game folder in the port's launcher. If you use a custom save folder, configure it there too; Achievements follows the launcher's saved location.
3. Add the port's installation folder in **Settings → Folders**. Its launcher settings or runner must identify the original game and save locations; adding only the original game dump is insufficient. Compatible packaged PyInstaller launchers are also detected without separate Python source files or a Python installation.
4. Use **Folders → Rescan** if import does not start. Once the required trophy data is available, the config selector and Dashboard show the imported game under **PS4 Recomp**, with its trophy list and trophy icons.
5. Configure **PS4 Recomp Notification** in the Notifications tab: preset or SAN preset, sound, position, scale and duration. Native Bronze/Silver/Gold grades are preserved. Games with a native Platinum use the dedicated Platinum notification settings; trophy lists without Platinum use the generic completion notification at 100%.
6. Start the game through its port launcher and unlock a trophy. Achievements reads the port's saved unlocks or unlock log to update progress and show notifications. Keep logging enabled for ports that only record unlocks in logs.

**Important notes:**

- Trophy lists can be read from the port's `trophies.tsv` export or the original game's trophy files and `npbind.dat`, using the built-in public retail trophy key. Original trophy icons come from the game files. A local `trophy.key` beside the launcher is optional and overrides that key; decrypted trophy data is also supported. Use **Folders → Rescan** to update an existing import's icons.
- Uncharted: The Nathan Drake Collection and PROTOTYPE Biohazard Bundle create one config per game when their original trophy lists are available. Start them through their launchers; progress is kept separate for each game.
- Single-game ports with one trophy set use shared detection rules for compatible Python/shell runners and native launcher layouts. Supported progress sources include `trophies.log`, `last_run.log`, a log explicitly declared by the launcher, dated session logs, `user/trophies/<TITLE_ID>/unlocked.txt`, `<TITLE_ID>-user<ID>.bin` trophy flags, `trophies.dat` (16-byte trophy flags in the configured saves folder) and `user/trophy/<NPWR>/progress_user*.txt`, including files created after import. Keep users separate when several profiles exist. Other collections require separate support.
- For compatible PORTHEON packages, add the package folder containing `games` and `src`, or an individual port folder. Configure each game's original folder in its launcher first; Achievements follows the package's declared data locations, including locations outside the installation folder.
- JSON/INI launcher settings identify the game and save locations. If multiple games or users could match, monitoring pauses instead of combining their progress. No executable is required for import or unlock monitoring; Play requires a valid launcher path and process-based playtime requires a runtime name. A local `settings.json` in the port folder can specify `game_dir` and `user_dir` when launcher settings cannot be resolved automatically.

</details>

### Console Emulators

<a id="xenia-canary-support"></a>

<details>
<summary><strong>Xenia-Canary Support</strong></summary>

1. Open Xenia and create a User Profile.
2. Use **Watched Folders** add the 'Xenia Location'\Content/xxxxxx/xxxx/xxxx/xxxxxx' folder which is created after the Account is created in Xenia.
3. Start and play the game.
4. The app will:
   - read the file Xenia created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

</details>

<a id="rpcs3-support"></a>

<details>
<summary><strong>RPCS3 Support</strong></summary>

1. Use **Watched Folders** add the 'RPCS3 Location\dev_hdd0\home\xxxxxxx\trophy' folder which is created after the RPCS3 is configured.
2. Start and play the game.
3. The app will:
   - read the file RPCS3 created,
   - fetch game name, schema and images.
   - generate configs automatically.
   - when new achievement is unlocked display the notifications.

</details>

<a id="shadps4-support"></a>

<details>
<summary><strong>ShadPS4 Support</strong></summary>

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

</details>

<a id="kytyps5-support"></a>

<details>
<summary><strong>KytyPS5 Support</strong></summary>

1. Use the upstream KytyPS5 runtime that saves progress in `_Trophies`. The U59 fork and SharpEmu are not supported by this integration.
2. Register the directory containing the extracted game or its `.zar` archive in the KytyPS5 launcher.
3. In **Settings -> Folders**, add the emulator directory containing `kyty_emulator.exe`, then rescan.
4. A **KytyPS5** config appears in the config selector and Dashboard, with the game's trophy list and icons. Games in registered launcher locations can be discovered before the first unlock.
5. Configure **KytyPS5 Notification** in the Notifications tab.
6. Start the game through KytyPS5 and unlock a trophy. Achievements automatically monitors the emulator's `_Trophies` folder, even if the folder is created only at the first unlock.

**Important notes:**

- Add new game locations in the KytyPS5 launcher. Achievements follows those locations and detects new game folders and `.zar` archives. Use **Rescan** if a game does not appear.
- Extracted games and `.zar` archives are supported. Retail `.pkg` files are not supported directly.
- Each game has one config per emulator installation, including its additional trophy sets. Each KytyPS5 user keeps separate progress; the active user follows the game's settings in the emulator, or the emulator's global user setting.
- Previously unlocked trophies are imported without displaying old notifications. Notifications are generated for the active user's new unlocks.
- **Refresh Rarity** can add percentages when a matching Exophase PS5 page is available. Missing percentages do not prevent local trophy monitoring.
- A runtime title without a discovered active installation is logged as `kytyps5:discovery:runtime-title-unresolved`; old `_Trophies` / `_SaveData` folders can remain after a game is moved or removed. A recognized active installation with missing trophy packages remains a warning. Settings/read failures retain their scoped recovery retries; runtime-only titles wait for source events or **Rescan**, without periodic library scans. `metadata-resolved` is logged when an active source becomes available.

</details>

### Online Accounts

<a id="xbox-pc-microsoft--xbox-network"></a>

<details>
<summary><strong>Xbox PC (Microsoft / Xbox Network)</strong></summary>

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

</details>

<a id="retroachievements"></a>

<details>
<summary><strong>RetroAchievements</strong></summary>

1. Open **Settings -> Advanced** and enter the RetroAchievements username and
   Web API key from the RetroAchievements control panel.
2. Select **Connect**, then **Import Library** to create separate
   `retroachievements` configs and achievement schemas for the account history.
3. Select a RetroAchievements config in the dashboard to start its API poller.
   New unlocks received after the initial cached state generate notifications.

Notes:

- This integration uses only the read-only RetroAchievements Web API. It does
  not scan emulators, ROMs, processes or local game folders.
- The Web API key is stored with Electron safe storage and is not written as
  plaintext to preferences or config files.
- Polling runs only for the RetroAchievements config explicitly selected in the
  UI, and stops when another platform/config is selected or the account is
  disconnected.
- The initial import seeds existing unlocks silently, so historical unlocks do
  not produce a notification burst.

</details>

<a id="using-achievements"></a>

## Usage & Configuration

Open the group you need to configure the library, notifications or controls.

<details>
<summary><strong>Achievement Enabler</strong></summary>

Open **Settings → Achievement Enabler**, below **Help**, to run the [original Achievement Enabler scripts](https://github.com/Roschach96/Achievement-Enabler/releases) inside the application.

The resizable panel uses the active application theme and remembers its size. Closing the panel keeps the current session running; reopen it to continue, or use **Stop** to end it.

Report issues with Achievement Enabler on its [GitHub project page](https://github.com/Roschach96/Achievement-Enabler/issues), rather than in the Achievements repository.

1. Choose **Download** to install the official release under `%APPDATA%\Achievements\AchievementEnabler`. **Check for updates** retrieves new releases; updates keep the same active folder, additional adapter files and the confirmation that the adapters are prepared.
2. Select **Adapters**. For additional adapter files, check the forum post and extract the required adapter files **"ColdClient+R1+R2 Adapter files"**, **"Origin emu Adapter file"** into the downloaded folder. Use **Open folder** to open that location, then confirm that the adapters are prepared.

   **Before continuing with Steam or Ubisoft:** create `%SystemDrive%\steamcmd\_AchievementEnabler\dummy_account.txt`. Put the username of a throwaway Steam account on the first line and its password on the second line. EA, Epic, and GOG do not require this file.

3. Choose the game installation folder and press **Start**. Answer the original prompts with **Send answer**, or use **Send key** for a choice that does not require Enter. **Terminal details** shows the full interactive output.

**Important for RUNE releases:** complete these renames before applying Achievement Enabler. Rename the RUNE emulator file `steam_api64.dll` to `steam_api64.rune`, then restore the original Steam library by renaming `steam_api64.rne` to `steam_api64.dll`.

The scripts remain unmodified and control game detection, emulator setup and generated files. A working copy is placed in the chosen game folder; the downloaded distribution is kept separately. Their own caches, account settings and backup-folder prompts still apply. Achievements continues to discover and monitor the resulting supported achievement files through its existing folder/config logic.

The panel reports **Finished**, **Finished with warnings**, **Action required**, **Stopped**, **Failed**, or **Run interrupted**, using the script's diagnostics as well as its exit code. For example, replacing the known-bad GSE Tools executable or completing `dummy_account.txt` requires action and another run; it is not reported as a technical failure. An unrecognized nonzero exit is reported as interrupted. The confirmed self-delete after `SETUP COMPLETE` is recognized as normal completion. The original output remains available for review; it is not saved to application logs because prompts may contain account data.

When the main script exits, the UI ends that run without waiting for auxiliary config-patch processes, which can finish in the background. While a run is active, **Stop** ends its owned processes. Exiting Achievements also ends remaining background helpers. Changes already made to game files are retained. Use **Tab / Shift+Tab** to navigate the panel; **Escape** closes it unless the terminal has focus, where the key is sent to the script. Standard-mapped controllers use **A / Cross** to activate the focused control and **B / Circle** to close the panel.

</details>

<a id="dashboard"></a>

<details>
<summary><strong>Dashboard, search and game management</strong></summary>

- Press the "Show Dashboard" button to access the game grid
- Switch between **portrait and landscape cards**, and combine **Configs**, **Collections** and the additional sections from **Dashboard View**, or select **Show all**.
- Organize games into collections with their own name, color, icon or image. Right-click a game for its available actions.
- Use search to filter games quickly
- Filter by platform and sort by name, progress, last played, last added, or last update time. **Last added** cycles newest first → oldest first → Off and combines with the other sort criteria. Config creation dates are preserved across edits, schema regeneration and renaming; existing configs are initialized from their filesystem creation dates. The history is stored in `config-added-times.json` and included in profile backups. Existing filters, including Hide 0%, still apply.
- Click any game to load its config
- Use `Ctrl + Click` or the card context menu to select multiple games, then ignore, delete or clear the selection from the action bar
- Blacklisted games can be shown for inspection and restored from the dashboard when **Show blacklisted games** is enabled
- Use the play button for games with configured executables (dashboard closes and returns focus to the main UI)
- Enable **Settings → Customisation → Dashboard appearance → Enable 3D effects on Dashboard** for mouse-driven game and Collection card tilt in portrait and landscape layouts. It is off by default and respects reduced-motion preferences.
- When enabled, adjust vertical/horizontal tilt, zoom, lift, perspective, and follow/return durations below the toggle. Values are saved in preferences and restored at startup; **Reset 3D effects** restores the original values.
- **Settings → Customisation → Dashboard appearance** is a separate section between Rendering and Theme Customisation. Enable 3D effects appears immediately above Custom card layout, which is last. It also contains optional game previews, contextual backgrounds, controller hints and the on-screen keyboard. Progress-count and playtime details are always shown on game cards.
- Enable **Game preview** to open **Game Details** from a card's ⓘ button, **V**, **Space** on a focused game card, or the controller's **R3** (right-stick press), without changing the active config. **V / R3** also closes the preview. Use the expand icon for more space in the same panel. Play is the primary action; Achievements opens the existing table, and the Captures tab uses the existing media viewer. Applicable Steam, SteamDB, Epic Store, GOG Store, PlayStation Store, RPCS3 Wiki and EA App actions reuse the context menu's destinations and rules.
- For **PS3 Recomp**, the PlayStation Store action opens search results using the game's name, with config suffixes and copy numbers removed. It does not choose a product or change the config. Results depend on the current web catalog and may show newer editions or no matching game.
- Game Preview groups the title, platform and actions below the artwork, with a subdued gradient and responsive Progress / Playtime / Last played tiles. Compact and expanded views use the active application theme.
- Game Preview can be resized using the same corner grips as Settings. In the docked compact view, drag its left edge, bottom edge or bottom-left corner; the game list adjusts beside it. Floating/expanded views use the corner grips. Compact and expanded sizes are saved separately in preferences under `dashboardPreviewSize`, and restored after changing games, reopening Dashboard or restarting the app. Sizes are temporarily constrained to the available window space without overwriting the saved dimensions.
- Under **Game preview**, **Show Game Preview all the time** opens a compact preview automatically when a game is available, including after closing/reopening Dashboard and after restarting the app. It reuses the last previewed game when possible, then the selected config or an available card. Compact Preview stays visible while browsing. Clicking another game updates its data even when Open Game Preview on selection is off; a second activation opens the config only after its data has loaded. V / Space on a focused card and controller R3 move focus into Preview actions; Back / Escape returns to the library. Expanding still opens the full view. Disable the option to restore normal closing. **Update Game Preview on hover**, below **Open Game Preview on selection**, independently enables mouse-hover following for an already open Preview. Keyboard/controller focus navigation still follows games. Both new options default to off, depend on Game preview, and are saved in preferences.
- Game Details displays description, developer, publisher, genres and release date when available. Generation/import saves optional presentation metadata from Steam Store / Schema Parse, Epic, GOG and RetroAchievements responses. Missing metadata does not block generation; opening Details never starts an account sync or regenerates a schema. Successful Steam/Epic/GOG generation and regeneration also complete the optional game details independently of the achievement source. **Refresh game details** in the panel updates them without regenerating achievements; failed lookups keep existing information. Existing local Steam product info can also be read without rewriting configs. The authoritative record is `game-details.json` beside the schema. Early name lookups retain optional details in memory until the schema directory is known; they do not create a separate persistent metadata folder. Legacy `game-metadata` records, if present, can fill missing fields and are adopted into the schema-local file without overriding populated fields. Achievement state stays in its existing files. Presentation lookup and artwork diagnostics are written to `logs/game-details.log`; the existing `logs/covers.log` keeps hero download diagnostics.
- **About the game** can be collapsed or expanded with the mouse, keyboard or controller; its state is retained while the same preview receives background updates or changes size. Release dates omit the time and timezone. GOG localized descriptions/genre names are decoded, and untranslated `product_description` / `product_feature` placeholders are excluded.
- Opening Preview also completes missing details when artwork already exists. Checks for incomplete records share in-flight requests and pause for ten minutes after a successful check or two minutes after a failed/unsupported lookup; complete records are reused locally. **Refresh game details** explicitly checks the source again and bypasses this pause. Optional metadata does not change platform IDs, achievements, unlock state, configs or launch behavior.

<details>
<summary>Game Preview data sources and caching</summary>

| Platform                                     | Presentation source and identity                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Steam / Steam Official / Steam-based patches | Steam Store by Steam AppID, existing Schema Parse product info, then GOG GALAXY GamesDB's exact Steam release if fields remain missing.                                                                |
| Epic / Epic Official                         | The existing Epic identity resolver accepts supported namespace, product, catalog-item and artifact IDs, obtains the store mapping and launcher `appName`, then uses Epic product-content JSON and GamesDB's Epic release to complete missing fields. Config AppIDs remain unchanged. |
| GOG / GOG Official                           | GamesDB's GOG release by product ID, followed by GOG product/game APIs if needed. Localized fields such as `en-US` and `*` are supported.                                                              |
| Uplay / Ubisoft Official                     | GamesDB's Uplay release by Ubisoft game ID. An explicit Steam mapping can supplement remaining fields.                                                                                                 |
| EA / EA Official                             | GamesDB's Origin release when the config contains `ea_offer_id`. An EA achievement-set ID is not used as an Origin offer ID.                                                                           |
| Xbox PC                                      | GamesDB's Xbox release by Xbox TitleID.                                                                                                                                                                |
| Xenia / Xbox 360 Recomp                      | GamesDB's Xbox release after converting the hexadecimal Xbox 360 TitleID to its decimal representation.                                                                                                |
| shadPS4 / PS4 Recomp / KytyPS5               | GamesDB's PSN release using the known CUSA/PPSA title ID, including the `_00` release suffix. Supported PS4 Recomp collections use the collection's CUSA from `ps_content_id`; subgame AppIDs and trophy identities remain unchanged. |
| XLiveLessNess / Games for Windows LIVE        | GamesDB's Xbox release using the native GFWL TitleID first, followed by the shared title fallback with Xbox priority. A unique verified record from another platform can fill missing presentation fields. No game-specific ID conversion or config changes are applied. |
| RPCS3 / PS3 Recomp                           | A known PSN store release ID or explicit Steam mapping, then the shared title fallback with PSN priority. Local titles can identify a unique catalog record even when an NPWR/disc serial is unavailable as a store release. Conflicting same-name PS3 associations are left ambiguous. |
| RetroAchievements                            | Developer, publisher, genre, release date and artwork from the existing import response, when supplied. No account sync is started merely by opening Preview.                                          |
| PC Ports                                     | The shared title fallback, or an explicitly stored Steam mapping. An unknown original platform is not guessed from the port's AppID. |

For known Xbox 360 recomp ports, name lookup reuses the full title already declared in the local port catalog when native metadata abbreviates it (for example, Spider-Man: EoT). This lookup does not scan game folders or rename configs. Unknown ports retain the existing title-based behavior.

For every platform, an explicitly stored `steamAppId`, `steam_appid` or `steam_app_id` can supplement fields absent from the native record. If the existing ID-based routes leave presentation fields missing, a shared GamesDB title search prioritizes the config's store/platform (or a recognized original console name for RetroAchievements). If no candidate matches that platform, one unambiguous exact-title game on another platform can supply the missing fields. App-specific platform suffixes, copy-number suffixes and decorative symbols are removed from the search; edition names such as Remastered, Remake and Director's Cut are retained. Multiple equally eligible games remain ambiguous, including conflicting PS3 associations found under inconsistent GamesDB platform labels. An unrelated numeric ID is never reused as another store's ID.

The title fallback preserves populated fields and verifies the selected canonical game ID, title and platform association before saving. Its `gamesDbMatch` record in `game-details.json` stores the catalog game ID, query and selected platform for later reuse; the config's platform, AppID, achievements and launch settings do not change. Searches and detail requests share a bounded, profile-scoped cache; complete local records are reused, incomplete records can reuse their saved catalog association after restart, and manual refresh bypasses the request pause. Diagnostics use `game-details:name-search:selected`, `game-details:name-search:unavailable` and `game-details:name-search:failed` in `logs/game-details.log`. Missing or ambiguous records keep existing data. Release dates can describe the original game rather than a later platform edition.

Presentation metadata is stored in `<config_path>/game-details.json`. Existing local Steam product info can supplement older schemas. No new `%APPDATA%\Achievements\game-metadata` folder is generated: optional responses obtained before a schema directory is known stay in a bounded, profile-scoped memory buffer and are adopted into `game-details.json` when the directory becomes available. Old metadata-cache files remain read-only compatibility inputs; successful adoption writes missing fields beside the schema. Save failures are recorded in `logs/game-details.log` and do not interrupt achievement generation. Network presentation requests use JSON over HTTPS, without a browser or a Steam API key. The current remote presentation adapters request English; UI labels retain the selected application language.

Game artwork uses one shared provider service for **Cover / Portrait**, **Header / Landscape** and **Hero / Background**. Images remain under `%APPDATA%\Achievements\images\<platform>\<AppID>`: `<AppID>.*`, `header.*` and `game-cover-hero.*`. Automatic downloads still run at the existing generation/import, Dashboard, selected-config and Preview entry points. Valid existing/custom images are reused; failed requests keep the previous file.

**Redownload Images** is available from the Dashboard context menu, the existing buttons on the selected config's cover/header, and the background button in Game Preview (compact and expanded). The Preview background button also provides access to the cover and other image types. Select an image type or **All game images**, then **Automatic** or an eligible source. Preview actions target the previewed game without changing the selected config. Controls support mouse, keyboard and controller.

- **Automatic** tries eligible sources in order. A named source uses only that provider; mirrors or alternative image URLs within it may still be retried.
- **GamesDB** tries the platform's existing release identifiers, then the shared title/platform lookup if no suitable image is found or its download fails. Uplay / Ubisoft Official tries the existing mapped Steam AppID between the native Ubisoft ID and title lookup. Name lookup also supports configs without a GamesDB-compatible release ID, including PS3 trophy IDs. Existing `gamesDbMatch` associations are reused and revalidated. The config's platform is preferred; a unique exact-title game on another platform is allowed when the preferred association is absent. Ambiguous matches are not selected. These lookups stay within GamesDB and do not change the config's AppID or platform.
- Sources are filtered by platform, verified identifiers and image type: saved product artwork, Steam product assets/CDN/Store, local Steam Official library cache, SteamDB cover lookup, Epic Store/Catalog, GOG API/GamesDB, saved Xbox/RetroAchievements artwork, Xbox 360 Marketplace and SteamGridDB where supported.
- **All game images** reports each type independently. Unsupported or failed types keep their existing files; successful types are updated.
- Manual source choices are retained across restarts and protected against later automatic downloads/imports. Corrupt-image recovery uses the selected provider. The image folder's `sources.json` records selections and provider URLs while retaining existing Xbox fields; description/developer/genre metadata remains in `game-details.json` beside the schema.
- Downloads share bounds, validation and coordinated atomic publication. Automatic jobs reserve capacity for manual requests, duplicate automatic requests are shared, and older jobs cannot overwrite a newer explicit choice. Image updates refresh matching views without closing Preview or resetting its scroll/expanded state.
- SteamDB and SteamGridDB extraction uses the internal Electron browser. Direct image URLs and JSON use HTTP(S), with no additional browser download. Small backdrop images are rejected. WebP/GIF dimensions are recognized even when Windows `nativeImage` cannot decode the format; supported files retain animation when no resizing is required.

</details>

- Contextual backgrounds use sufficiently large landscape artwork (including existing `game-cover-hero` images), never an enlarged portrait thumbnail. The Dashboard background follows the game shown in Details. After selecting a config, the same option also displays that game's local hero behind the main achievement view. Switching configs updates it; Back, missing artwork or disabling the option restores the theme background. Opening Game Preview displays local content immediately and fetches missing artwork in the background, using product artwork before the existing SteamGridDB fallback. Hover never opens a closed Preview; following an open Preview requires **Update Game Preview on hover** and uses the same delayed artwork loading as navigation. Matching downloads are shared, failures have a two-minute retry pause, and late results cannot replace another game's preview. Artwork is saved under the game's platform/ID directory; custom images remain first. Downloads and the local reader share a 40 MiB bound. Preview downloads validate image dimensions and optimize oversized files before publishing them. If suitable artwork remains unavailable, the application keeps the theme's background.
- **Dashboard View** is a menu with independent selections for **Configs**, **Collections**, **Recently played**, **Almost completed** and **Recent unlocks**. **Show all** selects every view. Combine the views you want; section cards use the same size, layout, Play/Ignore/Preview controls, context menu and 3D effects as Configs, follow search/platform filters, and reflow beside Game Preview. View selections and collapsed sections are restored at startup. Platform filtering remains in its existing dropdown.
- **Settings → Customisation → Rendering → Games per Dashboard section** sets independent game limits for **Recently played**, **Recent unlocks** and **Almost completed**. Each defaults to **5** and accepts a positive whole number. Sections show up to that many eligible games after filtering. Limits apply when returning to Dashboard, persist across restarts and are preserved by **Reset card layout**.
- **Custom card layout** adjusts preferred portrait/landscape card widths, minimum/maximum cards per row, separate column/row spacing and title lines across Configs, sections and Collections. Maximum **0** means automatic. When a window or Game Preview leaves too little space, the minimum is reduced to keep cards readable without horizontal clipping. Changing a limit adjusts the opposite limit if needed. Existing spacing values initially apply to both axes. **Reset card layout** restores only these layout values; the enabled toggle and 3D/Preview options stay as selected. Settings are saved in preferences and restored at startup; filters and sorting retain their own saved state.
- **Captures** lists existing screenshots and recordings for unlocked achievements and opens them in the resizable viewer/player. It uses the configured capture folders and translated achievement filenames, including timestamp variants, without adding metadata files.
- Automatic background polling selects the active game when its process starts
- `Esc` or the close button restores the dashboard overlay and re-enables input for the rest of the window

</details>

<a id="manual-achievement-state"></a>

<details>
<summary><strong>Manual achievement changes and backups</strong></summary>

Select one or more achievement rows and right-click to open their available actions. The menu also supports keyboard and controller navigation.

These actions are also available by right-clicking an achievement in the overlay **while interaction mode is enabled**. Use Ctrl-click to select multiple achievements or Shift-click to select a range. Confirmation stays inside the overlay and does not activate its window. Leaving interaction mode, hiding the overlay or switching configs cancels an open confirmation. The same source restrictions and backup rules apply; close the game before locking or restoring its local achievements.

- **Mark as Manually Unlocked** adds a local manual unlock. **Clear Manual Unlock** removes that override.
- **Pin Achievement to Top** keeps selected locked achievements at the top of the main table and overlay; **Unpin Achievement** removes the pin. Ctrl-click or Shift-click to pin multiple achievements. Search and status filters still apply, and the selected sort is preserved within each group. Unlocking an achievement automatically removes its pin. Pins persist per config and platform in `achievement-pins.json` beside the game's `achievements.json`, even when several configs share that schema. Overlay actions require interaction mode.
- **Mark as Manually Locked** resets only the selected achievement records in a supported local unlock file and updates the app's cache. Close the game before confirming. The dialog lists the achievements and files involved, and a backup is saved before editing.
- **Restore Last Achievement Backup** is available when a backup matches the selected config, source and profile. Restoration replaces the affected achievement files and cache with their backed-up state, including changes made since that backup; review the confirmation before proceeding.

| Local source                         | Supported state formats                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Steam / Uplay / GOG / Epic emulators | Recognized achievement JSON and INI layouts, Tenoke `user_stats.ini`, RUNE Uplay `achievements.cfg`, and Steam `stats.bin` |
| RPCS3                                | Selected trophy records in `TROPUSR.DAT`                                                                                   |
| shadPS4                              | Trophy state in the selected user's XML, or the legacy `TROP*.XML` files                                                   |
| Xenia                                | Selected achievement flags and timestamps in GPD files                                                                     |
| KytyPS5                              | The selected user's trophy JSON and service label                                                                          |
| Xbox 360 Recomp                      | ReXGlue TOML, `EOTACH1` TSV, earned-only INI, achievement-state JSON, GPD and validated `ACH-DATA` records                 |

Availability depends on the actual state format. Unsupported or ambiguous sources are not edited. Official account unlocks and log-based ports are outside this feature.

Unselected achievement records, definitions, images, game saves and shared stat counters are preserved. Locking does not reset the game's own progress: the game may unlock an achievement again when an existing save already meets its condition. Manual locking and backup restoration do not produce unlock notifications, screenshots or recordings; a later real unlock follows the normal notification flow.

Backups are stored under `%APPDATA%/Achievements/achievement_backups`, separately for each config and source/profile identity. If an edit fails, the app attempts to roll it back. Recovery details and the backup location are recorded in the application logs; a file changed externally during the operation is preserved.

</details>

<a id="customization"></a>

<details>
<summary><strong>Notifications, captures and customization</strong></summary>

Right-click an unlocked achievement in the table to **Show Screenshot** or **Show Record** when a completed capture exists in the configured screenshot/record folders (or the default fallback folders). The same actions are available in the interactive overlay and open the viewer in the main application. The shared viewer is resizable, supports multiple saved captures, and includes video playback, seeking and volume controls. Files are matched using the schema's translated achievement names and valid timestamp suffixes; ambiguous names are excluded. Historical game folders with an equivalent typographic apostrophe or Unicode representation are also recognized when unambiguous and not owned by another config. No media sidecar files are created.

- In **Settings → Customisation**, choose an application theme or build your own with **Theme Customisation**. Use **Notification Customisation** to edit an existing Achievements/SAN preset, preview its animation and save a new variant.
- Choose notification preset and screen position
- For Steam, Uplay/Ubisoft, GOG, Epic, EA Official, Xenia and Xbox 360 Recomp configs, use **Find Platinum** beside **Refresh Rarity** to check the selected game's trophy list. New configs on these platforms are checked automatically after schema generation and rarity. A verified equivalent achievement keeps its original ID, title, description and icon, is labelled **Platinum** beside rarity in the table and overlay, and uses the Platinum notification when the game unlocks it. If there is no equivalent, matching PSN Platinum metadata and artwork provide the completion entry and banner at 100% of the game's real achievements. This additional entry does not change progress totals or percentages. Uncertain matches leave the config unchanged. Completion metadata is stored beside the schema in `platinum.json`; it does not change the game's unlock files. Xbox schemas keep their original IDs and gamerscore; the search does not import Bronze/Silver/Gold grades. Games without a matching PSN Platinum retain the generic completion notification. PlayStation emulators and recomps retain their native trophy handling; the new search is not used for those platforms, Xbox PC, RetroAchievements or other port/patch integrations.
- Find Platinum can accept tied regional PSN lists only when the local achievement matches are strong and every tied candidate has one Platinum with the same English title/description and matching icon. Different image URLs are compared using decoded pixels, so PNG encoding/metadata differences do not create false ambiguity. Regional rarity percentages are not identity evidence. Conflicting or unverifiable results remain ambiguous. This exception does not change the general Exophase schema/rarity selector.
- Downloaded completion Platinum titles/descriptions include all supported languages advertised by the selected Exophase page, independently of the config's current language. The actual language links are followed (including `kr` and `pt-BR`), and translated awards are matched by their stable Exophase award ID. Missing/failed translations keep existing saved values for the same award; English fallback pages are not stored as translations. Existing native achievement text, translations, IDs and icons remain unchanged when mapped as Platinum. Older completion records without the multilingual marker are enriched on their next lookup; **Find Platinum** explicitly refreshes already-upgraded records too. `exophase:platinum:languages`, `exophase:lang:failed` and `platinum:updated` in `rarity.log` report the available, loaded, failed and saved languages.
- After verifying the game and its achievement list, Platinum matching checks the title and normalized description first, then a unique title when the descriptions differ. Multiple unresolved candidates are left unchanged; a completion entry is added only when there is no corresponding title in the existing list.
- Choose **Native Windows** as the achievement preset to use Windows toast notifications instead of an animated preset
- Select notification sounds and language
- Select the achievement schema languages to generate from **Settings -> Advanced -> Achievements Schema Languages**
- Adjust UI scale (75% to 200%)
- Adjust achievement duration (auto or custom)
- Adjust achievement sound volume (0% to 200%)
- Toggle Show Hidden Description for hidden achievements
- Enable Close to Tray (X button hides to tray)
- The tray menu shows the five most recently played available games. Click a game to open its config, or use its separate **Play** button when a launch executable is configured.
- Configure overlay shortcut or disable the overlay entirely
- Configure Overlay Interaction Key (toggle click-through ↔ drag/scroll)
- Optionally open the matching achievement when an animated or Native Windows notification is clicked from **Settings → Notifications → Notification Click Action**
- Choose whether notification clicks open the non-focusable, click-through overlay or the main application; opening the main application moves focus away from the game
- Native Windows notifications retain separate navigation routes when stored in Action Center, so each available notification can open its own achievement
- Enable/disable controller support for the overlay from **Settings -> Advanced -> Rendering**
- Enable/disable features:
  - Achievement screenshots
  - Achievement records
    - Choose 30 FPS, 60 FPS or Unlocked
    - Choose a total clip duration from 10 to 30 seconds, divided equally before and after the unlock
  - Progress Notification
  - Playtime Notification
  - Startup behavior
- Per-game progress notifications can be muted when a config is active
- In **Settings → Notifications → Progress Notification**, choose the default progress style or an existing Achievements/SAN preset. Windows native and Game Bar notifications remain available through **Progress Notification Method**.
- Achievement progress percentages appear beside the bars in the main table, overlay and Default progress notifications for every platform that provides valid progress values. The original counters remain visible.
- Toggle "Start with Windows" to create/remove a Task Scheduler entry using the current executable path
- Disable the native process watcher to use executable-name fallback detection only; matching does not require command-line arguments when the config's process name is known
- All preferences persist to `%APPDATA%/Achievements/preferences.json` and are restored on startup

</details>

<a id="keyboard--controller-navigation"></a>

<details>
<summary><strong>Keyboard, controller and overlay navigation</strong></summary>

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
- **On-screen keyboard**
  - Enable **Settings → Customisation → Dashboard appearance → On-screen keyboard** (off by default). The option is saved and restored at startup.
  - On a writable text field, press `Enter` or controller A / ✕. `Ctrl+Shift+K` also opens it; for multiline fields, use that shortcut or the controller so normal Enter can insert new lines.
  - Built-in QWERTY keys include uppercase, numbers/symbols and accented Latin characters. Arrow keys / D-pad / LS navigate; Enter / A / ✕ select; Xbox X / PlayStation ☐ deletes; Y / △ inserts a space; LB/RB move the text cursor; Menu / Options confirms; Esc / B / ◯ cancels.
  - Editing stays in a draft until **OK**. Cancel keeps the original text; confirmation updates the original field using its existing input/change handlers. Passwords stay masked. Physical typing continues to work normally while the keyboard is closed.
  - A visible vertical cursor follows the text position when using the ← / → buttons or LB/RB, including long and multiline text. Left/Right navigation stays on the same keyboard row; Up/Down moves to the closest key in the adjacent row and preserves the preferred column.
- **Dashboard navigation**
  - Arrow keys / D-pad / Left Stick move through the visible grid, section headings, toolbar and Game Preview. Each grid uses its own columns; hidden Configs and collapsed sections are skipped.
  - `Home` / `End` select the first/last card in the current grid. `Tab` / `Shift+Tab` also reach card buttons, view selections, details controls and captures.
  - Game Preview: `V` or controller **R3** opens/closes the focused game's preview; `Space` also opens/closes it while a game card has focus. Requires **Game preview** in Dashboard appearance. The optional **Open Game Preview on selection** setting makes a card click, `Enter` or controller **A / ✕** open Preview first. Activating the game already shown in Preview opens its config; **Achievements** in Preview also opens the config directly. With Preview open, keyboard/controller navigation updates it without moving focus into Preview or changing the selected config. Mouse hover does so only when **Update Game Preview on hover** is enabled; this is independent of **Open Game Preview on selection**. Hover alone never opens a closed Preview. With Preview already open, following a game first shows local data, then downloads missing artwork after a short pause; moving away or closing Preview cancels pending requests that have not started. These shortcuts are local to Dashboard and do not activate while typing or using another menu/modal.
  - Confirm activates the focused card or control. The Play shortcut and context menu act on the focused visible card, including section cards.
  - `PageUp` / `PageDown` and Right Stick scroll Game Preview while focus is inside it. Back closes the current menu/player/details first; inside a collection, it returns to the collection gallery.
  - Keyboard/controller focus is retained while section content updates. Mouse hover resumes changing focus after actual pointer movement.
  - Opening, expanding, collapsing and closing Game Preview preserves the selected card's position in the library. Expanded Preview retains focus for keyboard/controller navigation, and `Home` / `End` stay within its controls.
  - Configs and section cards share the same focus outline. Only the current card instance is active; other appearances of that game do not inherit its navigation highlight. Explicit multi-selection remains separate.
  - **Settings → Shortcuts → Dashboard** lists preview and control navigation shortcuts. Optional Dashboard hints show movement, Open/Select, Preview, Play, Actions, Search, scrolling, controls and Back, using the same keycaps/controller button styles and switching between keyboard, Xbox and PlayStation labels.
- **Overlay (while visible)**
  - Toggle visibility: configurable **Overlay Shortcut** from Settings (disabled by default until assigned).
  - **Settings → Customisation → Rendering → Overlay opacity** adjusts the whole overlay, including text, from **10% to 100%** (default: **100%**). Drag for a live preview; releasing the slider saves the value for future sessions. Changing opacity does not show a hidden overlay, take focus, or change click-through/interaction mode.
  - **Overlay background transparency**, in the same Rendering section, changes only the panel backgrounds: **0%** keeps the theme appearance (default), **100%** removes the backgrounds. Text, icons, progress bars and interaction menus retain their own appearance. It previews live and persists independently of whole-window opacity; keep **Overlay opacity at 100%** for full-strength text.
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
  - With **Enable 3D effects** enabled in **Settings → Customisation → Dashboard appearance**, hold PlayStation **R2** / Xbox **RT** and move the **left stick** or **D-pad** to tilt the focused game or collection card. The stick controls the tilt proportionally; D-pad directions can be combined. Directional navigation pauses while tilting. Release the trigger to return the card to normal, then center the stick and release the D-pad to resume navigation. The effect uses your saved tilt, zoom and lift settings, works on section cards too, and is unavailable in menus, dialogs, expanded Preview or overlay control mode. It respects reduced-motion settings. **Settings → Shortcuts → Dashboard** and optional controller hints show the combination.
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
  - The Create New Config buttons in the main screen and Dashboard are hidden by default. Enable **Settings → Advanced → Tweaks → Show Create Manual Config** to display them.
  - Move: Up/Down; Controller: D-pad or LS.
  - Play: `P` / `Ctrl+Enter` / `Shift+Enter`; Controller: Menu / Options.
  - Enable **Settings → General → Startup → Minimize to tray on Play** to hide the application in the tray after the launch process starts. This also applies to Play from Dashboard and recent games in the tray; it is off by default.
- **Drop-downs**
  - Open: `Enter`.
  - While open: Up/Down/Left/Right navigate; `Enter` confirm; `Esc` / `Backspace` cancel; Controller: D-pad navigate; A / ✕ confirm; B / ◯ cancel.
  - While closed: Left/Right cycles options; Controller: D-pad Left/Right.
- **Notes**
  - Right Stick scrolling uses smooth scrolling on the active scrollable area.
  - Back is contextual: Settings Section -> Tabs; Settings Tabs -> Close; Dashboard -> Close; Config modal -> Close; Main with a selected config -> Clear selection/back.

</details>

<a id="manual-configuration"></a>

<details>
<summary><strong>Create a config manually</strong></summary>

1. Create a new config with:
   - **Name**: Your preferred identifier
   - **AppID**: Steam AppID or folder name for achievements
   - **Config Path**: Location of achievements.json and images / Leave empty to generate
   - **Save Path**: Where achievement progress is stored
   - **Executable** (optional): Direct path to game executable
   - **Arguments** (optional): Launch parameters
   - **Process Name** (optional): Specific .exe name to monitor
   - _Note_: Names are sanitized (illegal filename characters removed, condensed spacing) before saving; the sanitized name is used on disk and for playtime totals.

See [Config JSON fields](#config-json-fields) for the file format.

New automatically generated configs also try to locate the game's executable using available launch metadata, installed-launcher records and local installation folders. Existing launch settings are preserved. For configs without an executable, use the **search icon** inside the Executable field or **Find Executable** in the Dashboard right-click menu. Multiple candidates require a choice.

After successful **Regenerate Schema**, an empty **Process Name** is filled from available launch metadata, or a supported Steam launch-metadata lookup (Steam or an explicitly mapped Uplay Steam ID). The app then searches locally for a missing executable. Existing process names, executables and arguments are preserved. Only confident executable matches are saved; missing, ambiguous or incomplete search results do not fail schema regeneration. Shared launchers are not added as game processes.

**Settings → Folders → Find all games executables** searches existing configs with an empty Executable field. Progress appears in the process rail, with an **×** button to cancel this search. When it finishes or is cancelled, a results dialog shows the totals and names of configs with ambiguous matches or errors. Only confident matches are saved; ambiguous results remain unchanged. Search locations are temporary and are **not added to Watched Folders**. Recognised Achievement Enabler launchers (ColdClient, Epic exchange-code launchers and GOG server launchers) take priority over their original game executable while retaining the game's process for playtime. Search limits and inaccessible paths are recorded in the application logs; an incomplete search does not prevent subsequent games from being checked.

Executable availability checks still read the filesystem on each request. Identical failures for the same path are logged once per running session, rather than repeatedly while browsing Dashboard. A changed error or a new failure after recovery is logged again; `executable:available-again` records recovery. Saved executable paths are never cleared by these checks.

If known installation sources do not provide a confident match, a specific **Process Name** can also locate the executable in other accessible folders on fixed disks, including renamed folders and relocated directory structures. This fallback does not require a predefined game-library folder name. It prioritises folders matching the game title, compares matching folders at the same depth, and validates executable matches as they are discovered. A confirmed match in that targeted scope does not require indexing the rest of the PC. It runs only during executable searches, skips system data, junctions and excluded asset/backup folders, and observes time and directory limits. Multiple installations remain ambiguous.

Individual **Find Executable** searches have an initial five-second search budget before offering verified candidates or the game-folder picker. Disk or operating-system delays can extend that wait. Selecting a folder starts a fresh search confined to that folder. If a wider scan reaches a limit, verified candidates remain available for manual selection; incomplete scans never save an executable automatically. **Find all games executables** keeps its longer search budget and records incomplete results in the final report. Search diagnostics, including the search performed after **Regenerate Schema**, are written to `logs/executable-finder.log`.

Wider searches can continue through four chunks of 25,000 directories, up to 100,000 within the available time and memory limits. Retries continue from the pending directory/entry instead of restarting the scan. **Find all games executables** shares that pending inventory between configs, with a three-minute budget for the volume scan. A completed inventory refreshes changed directories and new subtrees instead of rebuilding everything. Retries and resumptions are recorded as `executable-finder:retry`; cancellation remains available in the process rail. The five-second budget for individual searches still applies.

During **Find all games executables**, configs share one in-memory snapshot of launcher sources, library folders and the completed executable inventory. Each candidate is still checked against the current file and its platform metadata. Covered folders are not walked again by the extended fallback; known locations outside the inventory's coverage retain that fallback. Negative and incomplete results receive one shared final revalidation, followed by a recheck of relevant configs, so executables added or moved during the job can be detected. Concurrent config edits are preserved. Unavailable volumes are skipped for that phase and probed again during final revalidation and future searches. The snapshot is discarded after the job; no background watcher or persistent index is added. Logs separate source discovery, index lookup, candidate validation, extended scanning and the final `executable-finder:batch-revalidation`.

Executable discovery excludes `plus` executables, `bin_plus`, crack folders and original-file backups. Within one installation, it prefers a unique `Win64-Shipping.exe` target and the normal executable over its `-l` variant. Official Epic configs use only their matching Epic launcher manifest and its declared executable; they do not fall back to copies from another platform.

When no Shipping target is available, a unique best match to the game title is preferred over named variants, editors and helper programs. A generic `launcher.exe` is omitted when another valid executable exists beside it. Local `steam_settings` identifies a Steam emulator even when GOG package metadata remains; otherwise UniverseLAN identifies GOG. These checks use the executable's directory and its parents within that installation, never neighbouring game folders.

</details>

<a id="reference"></a>

<details>
<summary><strong>Technical reference: data locations, config JSON and launch arguments</strong></summary>

### Runtime Data Locations

- `%APPDATA%/Achievements/configs` – configs
- `%APPDATA%/Achievements/configs/schema` – generated achievement schemas + local achievement images
- `%APPDATA%/Achievements/images` – cached covers
- `%USERPROFILE%/Pictures/Achievements Screenshots` – default achievement screenshot output
- `%USERPROFILE%/Videos/Achievements Records` – default achievement video output
- `%APPDATA%/Achievements/ach_cache` – cached achievements
- `%APPDATA%/Achievements/achievement_backups` – backups created before manual achievement locking or restoration
- `%APPDATA%/Achievements/ach_cache/github-releases.json` – cached GitHub release notes used by the Changelogs tab
- `%APPDATA%/Achievements/ach_cache_meta.json` – cache metadata used to avoid unnecessary cache rewrites
- `%APPDATA%/Achievements/logs` – application logs
- `%APPDATA%/Achievements/playtime-totals.json` – playtime totals
- `%APPDATA%/Achievements/preferences.json` – application settings, watched folders and blacklist state
- `%APPDATA%/Achievements/preferences.json.bak` – last valid preferences backup used for recovery after an interrupted/corrupt write
- `%APPDATA%/Achievements/xbox-pc-microsoft-auth.enc` – encrypted Microsoft/Xbox authentication state
- `%APPDATA%/Achievements/xbox-pc/titles` – per-title Xbox PC synchronization data
- `%APPDATA%/Achievements/retroachievements-auth.enc` – encrypted RetroAchievements Web API credentials
- `%APPDATA%/Achievements/retroachievements/titles` – per-game RetroAchievements synchronization data

### Config JSON Fields

**Config JSON fields (reference):**

- `appid` (string) – game id
- `platform` (string) – `steam`, `steam-official`, `uplay`, `ubisoft-official`, `ea-official`, `epic`, `epic-official`, `gog`, `gog-official`, `xbox-pc`, `retroachievements`, `x360recomp`, `ps3recomp`, `ps4recomp`, `pcports`, `xenia`, `rpcs3`, `shadps4`, `kytyps5`, `markerpatch`, `madnesspatch`, `xlivelessness`.
- `config_path` (string) – folder containing `achievements.json` and `img/`
- `save_path` (string) – location of save/achievement progress
- `process_name` (string) – executable name for process tracking
- `executable` / `arguments` (optional) – used for Launch

_Note_: If `config_path` points to a custom location, schema regeneration/cleanup will not overwrite that folder.

### Application Launch Arguments

An existing config can be opened directly by passing both its AppID and platform to the installed or unpacked executable:

```powershell
Achievements.exe --appid=239140/steam
Achievements.exe --appid=239140 --platform=steam
```

- Both formats are supported and are equivalent.
- If Achievements is already running, the existing instance is opened and navigates to the matching config.
- The AppID and platform must match one existing config exactly. These arguments do not generate a config or launch the game.
- Supported platform values: `steam`, `steam-official`, `uplay`, `ubisoft-official`, `ea-official`, `epic`, `epic-official`, `gog`, `gog-official`, `xbox-pc`, `retroachievements`, `x360recomp`, `ps3recomp`, `ps4recomp`, `pcports`, `xenia`, `rpcs3`, `shadps4`, `kytyps5`, `markerpatch`, `madnesspatch`, `xlivelessness`.

</details>

<a id="help--troubleshooting"></a>

<a id="help"></a>

## Troubleshooting

- **A game is missing:** check its [platform setup guide](#supported-platforms), then use **Folders → Rescan** when the required files are available.
- **Animated notifications are not visible:** try Borderless Windowed mode and check the compatibility notes below.
- **Need diagnostic information:** open **Settings → Logs**; review local paths and account identifiers before sharing logs.
- **Installer asks to close Achievements repeatedly:** exit through the tray menu, then retry. New installers include a correction for the all-users process-close fallback. See [installer behavior and isolated verification](docs/build/installer-close.md).

<a id="game-compatibility"></a>

<details>
<summary><strong>Game display modes and compatibility</strong></summary>

- Works best with games in Borderless window mode
  [Note: Games using DirectX 9/10/11 require Borderless/Borderless Windowed mode to be enabled via in-game display settings in order for notifications to show above the game window]
- Limited support for Fullscreen mode
  [Note: If a game supports and runs using DirectX 12, notifications will usually show above the game window when Fullscreen is enabled]
- Automatically detects and imports existing achievements
- Supports multiple achievement languages if available in Config

</details>

<a id="️-known-limitations--workarounds"></a>

<details>
<summary><strong>Notification, overlay and controller workarounds</strong></summary>

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

</details>

<a id="changelogs--live-logs"></a>

<details>
<summary><strong>View release notes and collect application logs</strong></summary>

- **Settings -> Changelogs** lists the project releases published on GitHub, including version, release type, publication date and release notes.
- Release data is cached for 30 minutes. **Refresh** requests current GitHub data, while the last valid cache remains available when GitHub or the network is unavailable.
- Release links open the corresponding GitHub release in the default browser. Remote release text is rendered as text and is not executed as HTML.
- **Settings -> Logs** lists known application log sources with friendly names and also discovers additional `.log` files already present in the logs directory.
- The selected file is followed in real time and remains synchronized across file replacement, truncation and normal logger rotation.
- Search and level filters (`DEBUG`, `INFO`, `WARN`, `ERROR`) affect only the displayed lines; they do not change or delete the underlying log file.
- **Pause** pauses UI updates without stopping application logging. **Clear View** clears only the current in-memory view. **Open Logs Folder** opens the original files in the system file manager.
- The initial view is limited to the latest 1,000 lines and the renderer retains at most 2,000 lines, preventing an open Logs tab from growing without bounds.
- Live file monitoring starts only while the Logs tab is active and is released when another tab is selected or Settings is closed.
- Logs can contain local paths or account identifiers. Review their contents before sharing them publicly.

</details>

## Development

For contributors and users running Achievements from source.

<details>
<summary><strong>Source installation, build instructions and project reference</strong></summary>

### 🛠️ Installation

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
   Schema scraping uses Electron's built-in browser in isolated hidden windows. No separate browser installation is required. The manual schema-generator `--headed` option opens these windows visibly for troubleshooting.

### 🚀 Running the App

```bash
npm start

```

### 🧱 Building a Windows Executable

Create an unpacked Windows build:

```bash
npm run pack
```

Create the Windows installer:

```bash
npm run dist

```

Build output is created in the `dist/` folder. The build scripts verify the native process watcher and SAN notification runtime. Both `npm run pack` and `npm run dist` install and validate full Playwright Chromium automatically before packaging. Chromium Headless Shell is not bundled.

### 📦 Dependencies

#### Core

- [Electron](https://electronjs.org) - Cross-platform desktop application framework
- [@vscode/windows-process-tree](https://www.npmjs.com/package/@vscode/windows-process-tree) - Native Windows process monitoring
- [Koffi](https://www.npmjs.com/package/koffi) - Native Windows API bindings used by local detection services
- [ps-list](https://www.npmjs.com/package/ps-list) - Limited process-monitoring fallback
- [crc-32](https://www.npmjs.com/package/crc-32) - Checksum calculation

#### Achievement Processing

- [Playwright](https://playwright.dev) - Browser automation for achievement scraping using isolated Electron windows; no separate Chromium download is required
- [axios](https://www.npmjs.com/package/axios) - HTTP client for platform APIs and metadata services
- [cheerio](https://www.npmjs.com/package/cheerio) - HTML parsing

<a id="features"></a>

#### Feature Dependencies

- [screenshot-desktop](https://www.npmjs.com/package/screenshot-desktop) - Optional achievement screenshot capture
- [node-pty](https://github.com/microsoft/node-pty) and [xterm.js](https://xtermjs.org/) - Interactive host for the optional Achievement Enabler integration
- [windows-capture](https://github.com/NiiightmareXD/windows-capture) - Windows Graphics Capture and hardware-accelerated H.264 encoding for optional achievement video clips and HDR screenshots. The bundled recorder uses a locally patched MIT-licensed 2.0.1 source snapshot to pass GPU tone-mapped surfaces directly to the encoder.
- [FFmpeg](https://ffmpeg.org/) - the optional NVIDIA/AMD Replay flow uses a minimal, locally compiled LGPL-2.1-or-later FFmpeg/ffprobe runtime to inspect and trim existing clips without re-encoding. Matching sources, licenses and build configuration accompany the binaries; see [replay media runtime](docs/build/replay-media.md).
- [@xboxreplay/xboxlive-auth](https://www.npmjs.com/package/@xboxreplay/xboxlive-auth) - Microsoft/Xbox Network authentication
- [ini](https://www.npmjs.com/package/ini) - Config file parsing

#### Notification customisation inspiration

The SAN-style template and theme workflow in Notification Customisation is independently implemented for Achievements, with credit to [Steam Achievement Notifier](https://github.com/SteamAchievementNotifier/SteamAchievementNotifier) for the design inspiration. Existing Achievements presets remain supported separately.

#### Background Services

- `chokidar` keeps config/save directories under watch to trigger UI refreshes
- `@vscode/windows-process-tree` runs in an isolated Electron utility process and provides process events plus command-line data when required
- `ps-list` (via `utils/pslist-wrapper.mjs`) reconciles native snapshots and remains active as the limited fallback
- `achievements-recorder.exe` runs only while achievement records are enabled, retains bounded rolling video/audio segments on disk, and captures the default Windows output mix through WASAPI loopback (microphone input is not captured; unavailable audio safely falls back to video-only)
- **Recording method:** the existing **Achievements Recorder** remains the default. **NVIDIA Instant Replay** and **AMD Instant Replay** are optional alternatives in the achievement recording controls. Selecting either alternative stops the Achievements capture pipeline; the GPU software owns the background replay buffer. Closing Achievements does not disable the GPU replay software.
- For GPU Replay, manually enable the GPU overlay, **Desktop Capture / Record Desktop** and **Instant Replay**. For full clips, a buffer longer than **seconds before + seconds after + 5 seconds** is recommended. A shorter buffer/history no longer prevents saving: Achievements saves the available continuous interval and may shorten Seconds After to preserve the action before the notification. Keep replay enabled long enough to contain the requested history. Choose the notification monitor in the GPU software as well: Achievements does not change its display settings. AMD monitor mismatches are rejected; unverified multi-monitor mappings require confirmation in Settings and must be confirmed again after a topology/selection change.
- GPU settings and save locations are read automatically for each job. NVIDIA App uses its discovered local replay API; a configured shortcut is used only when no API discovery file exists. AMD uses the current user's configured Save Instant Replay shortcut. No blind shortcut retry follows an uncertain API result. FPS, resolution, HDR and audio follow the GPU recorder settings; the native FPS/HDR conversion controls apply only to Achievements Recorder.
- **AMD settings and shortcut troubleshooting:** Achievements reads the replay save folder, shortcut, enabled flags, buffer duration, monitor, codec and FPS from `HKCU\Software\AMD\DVR`. Each absent value can fall back to `HKLM\SOFTWARE\AMD\DVR`, including when the entire user key is missing. Explicit user values such as `0`, `false`, `None`, empty strings and unsupported shortcuts are never replaced. Conflicts between registry views are checked per setting; machine differences do not matter for a setting explicitly supplied by the user. The AMD recording service must still be running. Selected sources appear in `logs/records.log` under `registrySources`; `hotkeySource` identifies the shortcut. If the shortcut remains unavailable, clear and reassign it in AMD Adrenalin, then click **Check replay settings**. Settings are reread on each check; no application restart is required to refresh them. Achievements does not invent settings or modify the registry. See [AMD diagnostics](docs/build/replay-media.md#amd-hotkey-diagnostics).
- **AMD shortcut compatibility:** the original `Ctrl+Shift,S` notation remains supported, together with forms such as `Ctrl+Shift+S`, `Control + Shift, VK_S`, `Alt+PageDown` and `Ctrl+Numpad0`. Named navigation/editing keys, F1–F24, numpad keys, explicit OEM key names and single configured keys are recognized; case and surrounding spaces are normalized. Existing Ctrl/Shift/Alt mappings remain identical. This reads the configured shortcut, including its modifiers: it does not guess a default for a missing value or change Adrenalin's own shortcut rules. See [supported representations](docs/build/replay-media.md#amd-hotkey-compatibility).
- **Replay readiness warnings:** with GPU recording enabled, Achievements performs one read-only check when NVIDIA/AMD Replay becomes active (including startup), on **Check replay settings**, and during normal save attempts. Warnings identify confirmed inactive options such as Instant Replay, Desktop Capture / Record Desktop, the AMD recording feature/service or AMD hotkeys; unavailable NVIDIA In-Game Overlay and unverified settings have separate messages. These are in-app warnings and do not focus/show the application or enable GPU features. Identical warnings are suppressed for 60 seconds; a successful check resets suppression. No periodic polling is added. The AMD shortcut message explicitly means that **Achievements cannot interpret the value read**, not that Adrenalin rejects the combination.
- An expired NVIDIA API session (HTTP 404 during a status read) is renewed once, with concurrent checks sharing the renewal. Only the status read is repeated; a capture command is never resent automatically. `external-replay:stage` entries `api-session-renewing`, `api-session-renewed` and `api-session-renewal-failed` in `records.log` explain recovery. Failures include the operation, HTTP status or NVIDIA error code/retryability when available. NVIDIA MCP access and In-Game Overlay readiness are separate requirements; see the [NVIDIA API notes](docs/build/replay-media.md#nvidia-api-connection-and-recovery).
- **Uncertain NVIDIA save:** after a transport timeout/disconnection or `overlay_timeout`, Achievements continues watching for one valid new replay file using the original command timestamp. It never resends the save. `save-outcome-uncertain` and `save-file-recovered` stages explain this path in `records.log`; a recovered result includes `saveOutcomeUncertain:true` and retains the GPU original. Explicit rejections, failed connections before sending, cancellation and ambiguous/missing files do not publish a recovered clip.
- **Available replay duration:** a request for 20s before + 20s after saves the complete 40s when available. If only 8s before + 20s after or 20s before + 8s after exists, it saves approximately 28s. With a 30s buffer and no earlier retained source covering the missing history, it normally schedules the save after about 7s to protect the requested 20s before (3s safety margin). Actual file duration determines the final cut. `external-replay:partial` in `records.log` reports requested/selected Before and After, final duration, reasons and whether the notification is included. Timing remains subject to GPU/API latency and keyframes; overwritten frames cannot be recovered. See [partial replay behavior and tests](docs/build/replay-media.md#partial-replay-intervals).
- The external interval is anchored when the animated notification reports visible content, the Windows toast reports `show`, or Game Bar acknowledges the notification. OS/Game Bar capture visibility still depends on the GPU software. Screenshots can remain disabled. New replay files are observed only in the configured GPU media directory, excluding AMD `replay_cache`; these locations are never added to Watched Folders. Ambiguous files produce a logged failure instead of selecting an arbitrary clip; insufficient history uses the available partial interval.
- Nearby notifications can share one GPU save within the earliest interval's history deadline. Saving normally waits until one second after the latest requested end, but can happen earlier to protect the action before the notification. Each achievement still gets its own trimmed record. Notifications received after a save command enter the next batch. **Saving/detection and media processing have separate queues:** GPU commands and file associations remain serial, while one FFmpeg processing worker can run alongside the next save/detection. Sources are selected and protected before processing is queued, and graceful exit waits for both queues. Slow provider responses/detection can still delay later saves; no parallel capture commands are issued.
- If the first notification appears before automatic config selection finishes, external replay retains its original visibility timestamp and recording preferences for up to 20 seconds. Activation releases only requests matching that config and platform, independently of native recorder startup. Elapsed time counts toward the requested post-notification interval; it does not restart at selection. Backend/monitor changes, disabling recording and application exit discard waiting requests. `external-replay:pending-queued`, `pending-flush` and `pending-discarded` in `records.log` explain that waiting phase.
- Bundled **FFmpeg / ffprobe** extract the requested interval without video/audio re-encoding and preserve all audio tracks. Stream-copy cut accuracy depends on keyframes and timestamps; no automatic re-encoding is performed. The output is validated before publication in the normal Records folder, so **Show Record** continues to use the existing name/translation matching. Associated sources stay available for at least **145 seconds** to support following notifications. Automatic deletion requires a successful unchanged source, no pending dependencies, and its exact path confirmed by the capture command's machine-readable response. AMD shortcuts and NVIDIA responses without that path leave the GPU original in place; `source-retained: ownership-unconfirmed` explains this normal outcome. Finished unconfirmed entries retire from active history without deleting the original. Failed/ambiguous sources are retained. Compatible successive segments can be joined if they cover the complete requested interval, have safe compressed-video boundaries and pass per-track audio checks. Minor audio overlaps/gaps up to **25ms per discontinuity** still save the clip, with `external-replay:audio-warning` in `records.log`; larger audio discontinuities remain rejected before publication, with sources preserved. Some drivers leave an actual gap after saving replay; missing frames cannot be recovered. Available continuous material is saved as a partial clip, without frozen padding or a join across the gap. Once active sources reach 32 files or 16 GiB per running controller, further save commands stop without deleting needed sources; an already-created file is kept even if it pushes the total above the size threshold. No metadata sidecars are created beside clips. Interrupted jobs and retained-source diagnostics are recorded under `%APPDATA%/Achievements/replay-jobs` and are not replayed automatically; diagnostics use `logs/records.log`. Recovery entries explicitly identify historical failed/interrupted jobs, published journals and retained sources. They are not new failures in the current session; recovery neither sends replay commands nor deletes source clips or journals. Repeated recovery calls suppress unchanged entries during the same session.
- Graceful exit drains all accepted external replay jobs before source cleanup. The shutdown timeout includes remaining Seconds After and processing work, capped at 30 minutes; it exits as soon as jobs finish. The native-only timeout remains unchanged. `shutdown-draining` in `records.log` reports the budget and accepted jobs. Force-stopping at the deadline preserves incomplete sources.
- Run `npm run prepare:replay-media` before development tests of GPU Replay. Windows build preparation runs it automatically and reuses a verified runtime. This produces minimal Windows x64 `ffmpeg.exe` and `ffprobe.exe` from pinned, hash-checked FFmpeg sources using an isolated temporary compiler. No system FFmpeg or PATH installation is required in production. `npm run verify:replay-media` checks binaries and matching source; pack hooks check the packaged copy. Runtime details and licensing are described in [docs/build/replay-media.md](docs/build/replay-media.md).
- Recording frame rate supports **30 FPS**, **60 FPS**, and **Unlocked**. Unlocked captures without an application FPS limit, adapts to monitor refresh changes between segments, and may increase resource usage and file sizes, subject to Windows and hardware capacity.
- Native snapshots run at ~1s; fallback detection runs at ~2s and hybrid reconciliation at ~12s
- Disabling the native process watcher in **Settings -> Advanced** keeps executable-name detection active through the limited `ps-list` fallback; command-line arguments are not available in that mode
- A config selected automatically from a running executable is cleared when its last matching process closes; configs selected manually or by save-folder watchers remain selected
- The Settings log viewer uses a filesystem watcher with a lightweight polling fallback only while the **Logs** tab is active; both are released when the tab or Settings is closed
- GitHub release notes are fetched on demand from the public repository API and cached atomically for offline reuse

### 📁 Project Structure

<details>
<summary>View the complete file and folder reference</summary>

Packaged notification originals are stored once in `resources/sounds` and `resources/presets`, outside `app.asar`. On startup, the existing copy/update process populates `%APPDATA%/Achievements/sounds` and `presets`; notifications and user customisations use those AppData copies. Preset updates retain the existing version check and backup process.

| File/Folder                                       | Description                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `main.js`                                         | Main Electron process: window handling, core logic               |
| `preload.js`                                      | IPC bridge and renderer APIs                                     |
| `utils/playtime-log-watcher.js`                   | Tracks game start/stop and calculates total playtime             |
| `index.html`                                      | Main UI with dashboard and config management                     |
| `overlay.html`                                    | Achievement notification overlay                                 |
| `san-notification.html`                           | Animated achievement notification renderer                       |
| `playtime.html`                                   | Playtime notification template                                   |
| `progress.html`                                   | Progress notification template                                   |
| `tray-menu.html/js/css`                           | Tray menu UI and logic                                           |
| `playtime-totals.json`                            | Runtime-generated totals (`%APPDATA%/Achievements/`)             |
| `preferences.json`                                | Runtime settings (`%APPDATA%/Achievements/`)                     |
| `LICENSE`                                         | Project license file                                             |
| `package.json`                                    | Node.js dependencies and scripts                                 |
| `README.md`                                       | This documentation                                               |
| `style.css`                                       | Global styling for all UI components                             |
| `assets/`                                         | Static assets:                                                   |
| `assets/steamdb.json`                             | Steam database cache                                             |
| `assets/uplay-steam.json`                         | Uplay to Steam mapping                                           |
| `assets/locales/`                                 | UI translations                                                  |
| `assets/san-runtime/`                             | Bundled runtime assets for animated notifications                |
| `assets/vendor/fontawesome/`                      | Font Awesome icons                                               |
| `build/`                                          | Packaging hooks, manifests and required build verification       |
| `fonts/`                                          | Font files and licenses                                          |
| `presets/`                                        | `Default Presets` and `Users Presets` themes                     |
| `sounds/`                                         | Notification sound assets                                        |
| `utils/`                                          | Helper modules and utilities:                                    |
| `utils/auto-config-generator.js`                  | Auto-generates game configs from save directories                |
| `utils/generate_achievements_schema.js`           | Generates multi-platform achievement schemas                     |
| `utils/watched-folders.js`                        | Watcher + auto-select + auto-config                              |
| `utils/steam-appcache*.js`                        | Steam official appcache parsing + schema build                   |
| `utils/exophase-scraper.js`                       | Multi-language scraping from Exophase                            |
| `utils/xenia-*`                                   | Xenia parsing + schema generation                                |
| `utils/rpcs3-*`                                   | RPCS3 parsing + schema generation                                |
| `utils/shadps4-*`                                 | PS4 trophy parsing + schema generation                           |
| `utils/achievement-data.js`                       | Achievement data processing                                      |
| `utils/achievement-rarity.js`                     | Achievement rarity calculations                                  |
| `utils/trophy-mode.js`                            | Trophy Mode tier resolution for achievement notifications        |
| `utils/app-navigation.js`                         | App launch argument and navigation routing                       |
| `utils/atomic-json-store.js`                      | Atomic JSON writes and backup recovery                           |
| `utils/blacklist-identity.js`                     | Global/platform blacklist identity handling                      |
| `utils/config-deletion-guard.js`                  | Prevents config recreation during deletion                       |
| `utils/config-deletion-paths.js`                  | Validates optional save/schema deletion targets                  |
| `utils/config-name.js`                            | Safe config names and JSON path resolution                       |
| `utils/config-platform-migrator.js`               | Config migration between platforms                               |
| `utils/content-version.js`                        | Content versioning utilities                                     |
| `utils/game-collections.js`                       | Atomic custom collection storage and game membership handling    |
| `utils/game-collection-images.js`                 | Validation and local storage for custom collection images        |
| `utils/controller-input-manager.js`               | Controller input handling                                        |
| `utils/ea-desktop-local.js`                       | EA Desktop local integration                                     |
| `utils/epic-api.js`                               | Epic Games API integration                                       |
| `utils/epic-auth.js`                              | Epic authentication                                              |
| `utils/epic-identity.js`                          | Epic artifact/AppID identity fallback                            |
| `utils/epic-local-installations.js`               | Epic local installations detection                               |
| `utils/epic-official.js`                          | Epic official achievements                                       |
| `utils/xbox-pc.js`                                | Xbox App PC discovery and direct Xbox Network sync               |
| `utils/fileCopy.js`                               | File copying utilities                                           |
| `utils/game-cover.js`                             | Game cover image handling                                        |
| `utils/gog-auth.js`                               | GOG authentication                                               |
| `utils/gog-galaxy-local.js`                       | GOG Galaxy local integration                                     |
| `utils/i18n-ui.js`                                | UI internationalization                                          |
| `utils/local-game-name-cache.js`                  | Local game name caching                                          |
| `utils/logger.js`                                 | Logging utilities                                                |
| `utils/log-viewer-service.js`                     | Bounded live log tailing, rotation handling and subscriptions    |
| `utils/github-changelog-service.js`               | GitHub release retrieval with atomic cache and offline fallback  |
| `utils/lumaplay-event-watcher.js`                 | Native LumaPlay registry change watcher                          |
| `utils/lumaplay-registry.js`                      | LumaPlay registry handling                                       |
| `utils/markerpatch.js`                            | Dead Space 2 MarkerPatch detection and bitflag parser            |
| `utils/madnesspatch.js`                           | Alice MadnessPatch detection, schema and profile bitflag parser  |
| `utils/ff7-achievement-dat.js`                    | FINAL FANTASY VII legacy achievement.dat detection and parser    |
| `utils/xlivelessness.js`                          | XLiveLessNess discovery, config generation and DAT state parser  |
| `utils/xlivelessness-spa.js`                      | XLiveLessNess PE SPAFILE/XDBF metadata and image parser          |
| `utils/xlivelessness-worker.js`                   | Async XLiveLessNess executable discovery worker                  |
| `utils/retroachievements.js`                      | RetroAchievements Web API authentication, import and polling     |
| `utils/adaptive-path-watcher.js`                  | Late-created local achievement path monitoring                   |
| `utils/match-uplay-steam.js`                      | Uplay to Steam matching                                          |
| `utils/native-windows-notification-navigation.js` | Native toast activation routing                                  |
| `utils/overlay-controller-service.js`             | Overlay controller service                                       |
| `utils/overlay-shortcut-manager.js`               | Overlay shortcut management                                      |
| `utils/parseStatsBin.js`                          | Stats binary parsing                                             |
| `utils/paths.js`                                  | Path utilities                                                   |
| `utils/playtime-store.js`                         | Playtime data storage                                            |
| `utils/profile-backup.js`                         | Validated streaming profile backup, staging and restore          |
| `utils/profile-backup-worker.js`                  | Off-main-thread TAR + Zstandard backup creation and verification |
| `utils/playwright-runtime.js`                     | Hidden Electron browser runtime                                  |
| `utils/process-event-watcher.js`                  | Process event watching                                           |
| `utils/process-config-match.js`                   | Process-to-config matching                                       |
| `utils/process-native-host.js`                    | Isolated native process watcher host                             |
| `utils/process-name-utils.js`                     | Process name utilities                                           |
| `utils/process-poller.js`                         | Process polling                                                  |
| `utils/pslist-wrapper.mjs`                        | PS list wrapper                                                  |
| `utils/raw-hid-controller-hub.js`                 | Raw HID controller hub                                           |
| `utils/raw-hid-controller-worker.js`              | Raw HID controller worker                                        |
| `utils/raw-hid-profiles.js`                       | Raw HID profiles                                                 |
| `utils/rpcs3-config-generator.js`                 | RPCS3 config generation                                          |
| `utils/rpcs3-trophy.js`                           | RPCS3 trophy handling                                            |
| `utils/shadps4-config-generator.js`               | ShadPS4 config generation                                        |
| `utils/shadps4-trophy.js`                         | ShadPS4 trophy handling                                          |
| `utils/kytyps5-rarity.js`                         | Exophase PS5 trophy rarity matching and refresh                  |
| `utils/startup-task.js`                           | Startup task management                                          |
| `utils/steam-appcache-generator.js`               | Steam appcache generation                                        |
| `utils/steam-appcache.js`                         | Steam appcache handling                                          |
| `utils/steam-local-users.js`                      | Steam local users                                                |
| `utils/steam-schema-parse.js`                     | Bundled Steam schema tool runtime and generation                 |
| `utils/steamdb-launch-metadata.js`                | SteamDB launch metadata                                          |
| `utils/ubisoft-connect-local.js`                  | Ubisoft Connect local integration                                |
| `utils/windows-process-native-provider.js`        | Native Windows process snapshot provider                         |
| `utils/xenia-config-generator.js`                 | Xenia config generation                                          |
| `utils/xenia-gpd.js`                              | Xenia GPD handling                                               |

</details>

</details>

<a id="support"></a>

## Support & Credits

### ☕ Support

If you’d like to support the project further, you can buy me a coffee on Ko-fi:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/V7V81U42NF)

<a id="author"></a>

### 👤 Author

**JokerVerse**  
Copyright © 2025

---

Feel free to contribute, fork or suggest improvements!

Licensed under the [MIT License](LICENSE).
