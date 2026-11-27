# AI Generated Content Filter for Steam (Millennium Addon)

Native Steam Client addon for [Millennium](https://github.com/SteamClientHomebrew/Millennium) (>= v3.4.0) that detects, labels, highlights, or hides Steam games disclosing AI-generated content across the Steam Store WebKit views.

## Features
- **3 Display Modes:** Show AI Label (`[AI: Art]`, `[AI: Audio]`, `[AI: Code]`), Highlight AI Content (red/blue outlines + capsule tinting), or Hide AI Content.
- **8-Category Disclosure Classifier:** Art, Audio/Music, Live Runtime Generation, Story/Narrative, Translation/Localization, Code/Dev Tools, Concept Art/Prototyping, and Marketing.
- **Native Steam Settings Panel:** Configure filter mode, category exemptions, cache purge, and scan statistics under **Settings -> Millennium -> Plugins**.
- **In-Page Steam Search Sidebar:** Injects the **Narrow by AI Usage** filter block directly into `#additional_search_options`.
- **Fast Batched Lookups:** Queries up to 100 AppIDs per request via `IStoreBrowseService/GetItems/v1/` with early-abort HTML streaming fallback.

## Prerequisites
- **[Millennium](https://github.com/SteamClientHomebrew/Millennium)** >= v3.4.0 (`.star` plugin bundles are not supported on `< v3.4.0`)
- **[Node.js](https://nodejs.org/) + npm** or **[Bun](https://bun.sh/) >= v1.0.0** (only required when building from source)

## Installation

> **Note:** Millennium's **Install a plugin** modal only accepts remote `steambrew.app` plugin IDs and has no local file picker. Install local or unsigned `.star` files by placing them directly in Millennium's plugins folder (`>= v3.4.0` loads top-level `*.star` files automatically without a signing key or Developer Mode flag).

### Option 1: Manual Local Install (`.star` file)
1. Open the Millennium plugins folder (`MILLENNIUM__PLUGINS_PATH`):
   - **Via Steam UI (any OS):** Open **Steam -> Settings -> Millennium -> Plugins** and click **Browse local files**.
   - **Windows (default):** `C:\Program Files (x86)\Steam\millennium\plugins\` (or `<SteamInstallPath>\millennium\plugins\`; do not use legacy `\plugins\` or `\ext\plugins\`).
   - **Linux:** `~/.local/share/millennium/plugins/` (or `$XDG_DATA_HOME/millennium/plugins/`).
   - **macOS:** `~/Library/Application Support/Millennium/plugins/`.
2. Copy `steam-ai-disclosure-filter.star` (from `dist/` or a release download) **directly** into that `plugins` folder. Do not extract it or place it inside a subfolder.
3. Reopen **Steam -> Settings -> Millennium -> Plugins** (or restart Steam).
4. Toggle **AI Generated Content Filter for Steam** on, click **Save Changes**, and click **Reload Now**.

### Option 2: Build & Auto-Install from Source (Windows / Linux)
1. Set `output_path = "auto"` in `millennium.toml`:

```toml
[compiler]
output_path = "auto"
```

2. Install dependencies and build directly into your active Millennium plugins directory:

```bash
npm install
npm run build
```

*(Use `npm run dev` or `bun run dev` for hot-reload during development. `output_path = "auto"` supports Windows and Linux only; on macOS, build with the default path and follow Option 1 to copy `./dist/steam-ai-disclosure-filter.star`.)*

3. Open **Steam -> Settings -> Millennium -> Plugins**, toggle **AI Generated Content Filter for Steam** on, click **Save Changes**, and click **Reload Now**.

## Building a Distributable `.star` Package
```bash
npm install
npm run build
```

With the default `millennium.toml` configuration, the compiled release bundle is written to `./dist/steam-ai-disclosure-filter.star` so builds succeed without a local Steam/Millennium installation.

## Updating & Uninstalling
- **Update:** Replace `steam-ai-disclosure-filter.star` in your Millennium `plugins` folder (or re-run `npm run build` with `output_path = "auto"`) and restart Steam.
- **Uninstall:** Choose **Uninstall** from the plugin menu in **Millennium -> Plugins**, or delete `steam-ai-disclosure-filter.star` from the `plugins` folder and restart Steam.

## Troubleshooting
- **"Install a plugin" rejects file paths / asks for an ID:** That button only downloads plugins listed on `steambrew.app`. Use **Browse local files** and copy `steam-ai-disclosure-filter.star` into the `plugins` folder manually (Option 1).
- **Plugin does not appear in Millennium -> Plugins:**
  - Confirm Millennium is **`>= v3.4.0`**.
  - Confirm the file is in `<SteamInstallPath>\millennium\plugins\` on Windows rather than `\plugins\` or `\ext\plugins\`.
  - Confirm `steam-ai-disclosure-filter.star` sits at the top level of the `plugins` folder, not nested inside a subfolder or extracted.
