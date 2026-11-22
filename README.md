<p align="center"><img src="assets/icon.png" width="96" alt="T3 Pet icon"></p>

<h1 align="center">T3 Pet</h1>

<p align="center">A desktop pet for <a href="https://github.com/pingdotgg/t3code">T3 Code</a>. It sits on your screen, watches your threads on this computer <em>and every linked machine</em>, and tells you when something needs a decision or is done.</p>

> **Unofficial.** T3 Pet is a community project, not made by or affiliated with the T3 Code team.

## What it does

- **Live task view.** Running, waiting, failed and finished threads from this computer and from every
  environment you linked in T3 (for example your laptop and a desktop), grouped and labelled by machine.
- **Nudges, not noise.** A badge and a system notification when a thread needs your approval or answer,
  finishes with a question for you, fails, or completes. Nothing for what was already true at start-up.
- **One click to the thread.** Click a task in the bubble, the panel or a notification and T3 opens that
  exact thread (`t3code://threads/<environment>/<thread>`), on whichever machine it runs.
- **Settle, mark unread, snooze** from the panel (optional, see [Thread actions](#thread-actions)).
- **A pet with moods.** Calm idle when all is quiet, a focused pose while agents work, an asking pose
  when something needs you, a sad pose on failure, a hop when a task finishes. Drag it anywhere.
- **Hatch your own pet** from a description or a reference image with GPT image models
  (through Codex, or FAL / Venice as fallbacks). Pets use the standard **Codex pet** format, so every
  Codex pet works too.

## Install

Requirement: [T3 Code](https://github.com/pingdotgg/t3code) installed and opened at least once.

### Installer (recommended)

Download the latest file from [Releases](https://github.com/WinarG14/t3-pet/releases):

- **Windows:** `T3-Pet-Setup-<version>.exe`. Run it; it installs for your user only (no admin rights),
  adds Start Menu and desktop shortcuts, and starts T3 Pet. The builds are not code-signed yet, so Windows
  SmartScreen may say *Windows protected your PC*: choose **More info → Run anyway**. Uninstall it from
  Settings → Apps.
- **macOS:** `T3-Pet-<version>-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel). Open it and drag
  **T3 Pet** to Applications. The app is not notarized yet, so the first time **right-click → Open**.
  T3 Pet runs in the menu bar (no Dock icon).

### From source

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/WinarG14/t3-pet.git
cd t3-pet
npm install
npm start
```

Build the installers yourself with `npm run dist:win` (on Windows) or `npm run dist:mac` (on a Mac);
they land in `dist/`.

Works on **Windows** and **macOS**. On first start T3 Pet asks T3 for a read-only sign-in (no prompt;
see below) and greets you with **Dut**, the default pet.

- **Windows:** the first start adds a *T3 Pet* Start Menu shortcut; Windows needs it to show
  notifications under the app's name.
- **macOS:** T3 Pet lives in the menu bar (no Dock icon). Its sign-ins and API keys are kept
  encrypted with a Keychain item named *T3 Pet Safe Storage*. macOS may ask once for Keychain access,
  for example after Electron is reinstalled.
  - **No system notifications when you run from source.** macOS delivers notifications only from a
    code-signed app, and `npm start` runs Electron's development build, which is not signed. Nothing
    shows and nothing asks for permission. The pet's speech bubble and badge still show every update.
  - **Menu bar icon behind the notch.** On a MacBook with a camera notch and a full menu bar, macOS
    can hide the icon behind the notch. Right-click the pet for the same menu.

To start it with your computer: Settings → *Start when I sign in*. Lost the pet? Click the paw in the
panel's header, or Settings → *Bring pet back* (also in the tray / menu bar menu). On macOS, when you run from
source, this adds `~/Library/LaunchAgents/dev.t3pet.desktop.plist`, and macOS shows a one-time
"App Background Activity" notice for *Electron*. Turn the setting off to remove the file.

## How it reads T3

T3 Pet uses T3's own tool interface, the same `/mcp` tools T3's `t3 thread` CLI uses
(`t3_environment_links`, `t3_thread_list`, `t3_thread_read`, `t3_project_list`):

1. On first start it runs `t3 auth session issue --subject mcp-client --scope orchestration:read`
   through T3's bundled CLI (`~/.t3/bin/t3`). That creates a **read-only** sign-in called
   **T3 Pet (read-only)**, valid 30 days and renewed automatically. You can see and revoke it in
   T3 → Settings → Sharing & access.
2. Every few seconds it lists threads on this computer and, through T3's existing links, on every linked
   environment. It reads the newest message of a thread only when that thread changes.
3. It never reads subagent or delegated child threads (reading a child's result marks it delivered).
4. On this computer it also reads T3's local database (read-only) for one detail the tools don't expose:
   when you last opened a thread, so "finished, unread" is exact. On linked machines a finished thread
   counts as unread for 30 minutes, matching T3's own auto-read.

If the tool route is unavailable (T3 not running, CLI missing), the pet falls back to this computer's
database only and says so.

> The `--subject mcp-client` flag is what T3's MCP endpoint expects from tool clients today. It is
> not a documented contract, so a future T3 update may change it.

## Thread actions

*Settle*, *mark unread* and *snooze* change thread state, and T3 only lets a caller organize threads that
run at or below the caller's own access level. Most threads run at full access, so the pet needs a
**full-access** sign-in for these. Turn it on in Settings → *Thread actions*. T3 Pet then:

1. asks the owner CLI for a 5-minute setup session,
2. mints a one-time approval code for **T3 Pet (actions)** and signs in through T3's MCP OAuth flow,
3. revokes the setup session at once.

The sign-in lasts 30 days and appears in T3 → Settings → Sharing & access. A full-access token can also
start threads and run commands, so it never leaves the app's main process, is stored encrypted, and the
panel can only send the fixed actions listed above. *Turn off* revokes it.

## Pets

T3 Pet ships with **Dut**, a chubby white-and-brown tabby, as the default pet (`assets/pets/dut`).

A pet is a folder with `pet.json` and an 8×9 sprite sheet (`1536×1872`, cells of `192×208`), the
Codex pet format. T3 Pet reads `~/.codex/pets/` (or `$CODEX_HOME/pets/`) plus its bundled pets; a
Codex pet with the same id wins. Drop a pet folder there, or hatch one. Version 2 pets (8×11, `1536×2288`, two extra rows of look directions) work too; T3 Pet
uses their first 9 rows. With a version 2 `hatch-pet` skill, the FAL and Venice route still makes a
standard 8×9 pet: it skips the look-direction images.

### Hatch a pet

Panel → **Build**: name, look, optional reference image, style and engine. A pet is 10 images: a main
look and 9 poses (idle, walk right/left, wave, jump, failed, waiting, working, review).

| Engine | How | Needs |
| --- | --- | --- |
| **Codex** (default) | Runs the `hatch-pet` skill through `codex app-server` (the built-in image tool is only offered to app-server clients). Checks first that your plan includes image generation. | The Codex CLI signed in, the `hatch-pet` skill in `~/.codex/skills/` |
| **FAL** | `openai/gpt-image-2.6/sunburst/edit`, grounded on the main look for every pose | FAL API key (Settings) |
| **Venice** | `gpt-image-2-6-sunburst-edit` (multi-edit) and `gpt-image-2-6-sunburst` | Venice API key (Settings) |

With *Codex first, then FAL, then Venice*, a Codex failure (for example no image generation on your
plan) moves to FAL, and each image that fails on FAL is retried on Venice without redoing finished ones.
The FAL and Venice route reuses the `hatch-pet` skill's own scripts for set-up, frame extraction, atlas
assembly, validation and the contact sheet, so it needs Python 3 with Pillow (`pip install pillow`).
API keys are stored encrypted by the OS (Windows DPAPI, macOS Keychain). FAL and Venice charge per image.

## Settings worth knowing

| Setting | Default | |
| --- | --- | --- |
| Motion | Calm | *Calm* plays each mood slowly and then rests; *Lively* loops nonstop |
| Same size in every pose | On | Scales each animation row to the idle pose, so the pet doesn't grow while you drag it |
| Check this computer / linked machines | 3 s / 10 s | |
| Show threads active in the last | 72 h | |
| Data source | T3 tools | or *this computer's T3 database only* |

## Develop

```bash
npm run check          # state rules + database fallback, against synthetic data
npm run snapshot       # print what the pet sees now (uses a temporary read-only session, then revokes it)
npm run test:pipeline  # offline pet build: synthetic images through the real hatch-pet scripts
npm run icons          # rebuild the app and tray icons from assets/brand/logo-source.png (Python + Pillow)
```

```text
src/main.js            Electron main: windows, tray, polling, notifications, IPC, encrypted secrets
src/t3client.js        T3 MCP client: read-only session, actions sign-in, tool calls
src/tasks.js           task snapshot across machines and the state rules
src/watcher.js         local T3 database reader (fallback + "last opened" times) and notification diff
src/pets.js            finds Codex pets; the atlas contract
src/builder.js         pet builder: Codex (app-server) → FAL → Venice, hatch-pet scripts
src/codex-appserver.js minimal JSON-RPC client for `codex app-server`
src/platform.js        Windows / macOS differences
src/renderer/          pet window (pet.*), panel (panel.*), icons, mini sprite player
tools/                 checks, probes, icon generator
```

## Privacy

- Everything stays on your machines. T3 Pet talks only to your local T3 server (which relays to your
  linked environments) and, only when you hatch a pet with them, to FAL or Venice.
- It writes nothing to T3 except the thread actions you click, and the sign-ins described above.

## Credits

- Logo and the default pet Dut were made with GPT image models (logo: GPT Image 2.6 via Venice).

- [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools.
- The Codex pet format and the `hatch-pet` skill come from OpenAI Codex.
- Related projects that showed the way for desktop pets: [codex-pets-react](https://github.com/backnotprop/codex-pets-react),
  [contrueCT/codex-pet-desktop](https://github.com/contrueCT/codex-pet-desktop).

## License

[MIT](LICENSE)
