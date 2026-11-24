<h1 align="center">Vantrex IDE</h1>

<p align="center">
  A fast, minimal code editor for web development, with a pure black interface and one orange signal.<br />
  Built on the open-source core of Visual Studio Code, with Vantrex account sign-in and settings sync.
</p>

<p align="center">
  <a href="https://github.com/nfworking/vtx-editor/actions/workflows/release.yml"><img alt="Release build" src="https://github.com/nfworking/vtx-editor/actions/workflows/release.yml/badge.svg" /></a>
  <a href="LICENSE.txt"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

> **Status: early preview.** The editor is usable day to day, but builds are unsigned and the feature set is still small. Expect rough edges and
> breaking changes between releases.

## What is it

Vantrex IDE is a desktop code editor for Windows, macOS and Linux. It keeps what makes VS Code good (the editor, the file explorer, search, Git,
the integrated terminal, language servers) and changes how it looks and what it ships with.

- **A calm, original interface.** Pure black canvas, floating glass panels with continuous rounded corners, pill controls and spring motion, the system
  font (SF on macOS) for the interface and JetBrains Mono for code. The same design language as the Vantrex platform.
- **A floating command bar.** One slim bar at the top of the window opens files by name, and `>` switches it to commands. The title bar,
  layout buttons and Restricted Mode prompts are gone.
- **A quiet side bar.** Explorer, Search and Source Control. Outline, Timeline, the secondary side bar and the other panels stay out of the way
  until you ask for them.
- **Vantrex account and settings sync.** Sign in with your Vantrex account (browser device login, no passwords in the editor). Settings,
  keybindings, snippets, extensions, UI state and **profiles** then follow you between machines.
- **Vantrex workspaces.** **Vantrex > Open Vantrex Workspace** (the application menu on macOS, File menu elsewhere) lists your GitHub-linked
  projects and branches, starts the branch's workspace on the platform and opens its files in the explorer. Edits save straight into the
  workspace, the terminal runs the allowed package manager tasks, the dev server's output has its own panel, a preview browser opens beside
  the editor, and **Commit Changes** sends your edits to GitHub as one commit (optionally on a new branch with a pull request).
- **Language support for the web.** TypeScript, JavaScript, HTML, CSS, JSON and Markdown work out of the box, including completion, hover,
  diagnostics and formatting.
- **No AI features and no telemetry.** The AI assistant, its extensions and its menus are removed or switched off, telemetry is off.
- **Automatic updates.** The editor checks the [Releases](https://github.com/nfworking/vtx-editor/releases) page hourly, downloads the archive for
  your platform, verifies its SHA-256 against `SHA256SUMS.txt`, and installs it the next time you restart (macOS, Windows and Linux). If the
  folder it runs from is read-only it offers the download instead. Set `update.mode` to `none` to turn this off.

## Download

Get the latest build from the [**Releases**](https://github.com/nfworking/vtx-editor/releases) page.

| Platform | File | Notes |
| --- | --- | --- |
| Windows (x64) | `Vantrex-<version>-win32-x64-setup.exe` | A per-user installer (no administrator needed). Windows SmartScreen may warn about an unknown publisher: choose **More info**, then **Run anyway**. A `.zip` is also published. |
| macOS (Apple silicon) | `Vantrex-<version>-darwin-arm64.dmg` | Open the disk image and drag Vantrex to Applications. See the note below. A `.zip` is also published. |
| macOS (Intel) | `Vantrex-<version>-darwin-x64.dmg` | As above. |
| Linux (x64) | `Vantrex-<version>-linux-x64.tar.gz` | Extract and run `./vantrex`. |

The editor updates itself from these releases using the `.zip` and `.tar.gz` archives, so keep them in the release.

Each release includes `SHA256SUMS.txt`. Verify a download with `shasum -a 256 <file>` (macOS, Linux) or `Get-FileHash <file>` (Windows).

**macOS and unsigned builds.** The apps are not yet signed with an Apple Developer ID or notarised. If macOS says the app is damaged or from an
unidentified developer, remove the download quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/Vantrex.app
```

## Getting started

1. Open a folder with **File > Open Folder**, or press `Ctrl+P` / `Cmd+P` to jump to a file.
2. Click **Sign in** at the bottom left of the window (or run **Vantrex: Sign In** from the command bar). Your browser opens the Vantrex
   dashboard, where you approve a short code.
3. Open the account menu (your email, bottom left) and choose **Turn On Settings Sync**. Pick what to sync; your settings and profiles are then
   kept in step across every machine you sign in on.

Settings sync talks to `https://api.vantrex.cloud`. Both addresses are configurable:

| Setting | Default | Purpose |
| --- | --- | --- |
| `vantrex.account.authUrl` | `https://app.vantrex.cloud` | The dashboard where you sign in |
| `vantrex.account.apiUrl` | `https://api.vantrex.cloud` | The API used for account details |

The settings sync endpoint itself is `configurationSync.store` in [`product.json`](product.json).

## Build from source

You need [Node.js](https://nodejs.org) (the version in [`.nvmrc`](.nvmrc)), [pnpm](https://pnpm.io) (the version in the `packageManager` field of
`package.json`, available through `corepack enable`), Git and Python 3, plus the native build tools for your platform:

- **Windows:** Visual Studio 2022 Build Tools with the *Desktop development with C++* workload.
- **macOS:** Xcode command line tools (`xcode-select --install`).
- **Linux:** `build-essential pkg-config libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`.

```bash
pnpm install --frozen-lockfile
pnpm run compile-client      # build the editor
./scripts/code.sh            # run it (scripts\code.bat on Windows)
```

To produce a distributable build for the platform you are on (native modules are compiled for it, so you cannot build one platform's package on
another):

```bash
pnpm run gulp vscode-<platform>-<arch>-min     # e.g. vscode-darwin-arm64-min, vscode-win32-x64-min, vscode-linux-x64-min
```

The result is written next to the repository as `VSCode-<platform>-<arch>`. The [release workflow](.github/workflows/release.yml) does exactly
this on GitHub's hosted runners for every platform.

### Releases

Push a version tag to build every platform and publish a release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Or run **Actions > Release > Run workflow** to build all platforms and download the archives from the run page.

## What is different from VS Code

Vantrex changes are kept small and in their own places, so tracking upstream stays practical:

| Area | Where |
| --- | --- |
| Colour theme (Vantrex Dark) | [`extensions/theme-vantrex`](extensions/theme-vantrex) |
| Fonts, shapes and type treatment | [`src/vs/workbench/browser/media/vantrex.css`](src/vs/workbench/browser/media/vantrex.css) |
| Floating command bar, quiet defaults, side bar trim | [`src/vs/workbench/contrib/vantrex`](src/vs/workbench/contrib/vantrex) |
| Account sign-in, account menu, sync authentication | [`extensions/vantrex-account`](extensions/vantrex-account) |
| Workspaces: files, terminal, preview, commit | [`extensions/vantrex-workspaces`](extensions/vantrex-workspaces) |
| Product name, icons and the sync endpoint | [`product.json`](product.json), [`resources/`](resources) |
| Simplified Welcome page | `src/vs/workbench/contrib/welcomeGettingStarted` |

The AI assistant extension and its packaging steps were removed. Some inert upstream code for it remains in the source tree and is switched off by
default (`chat.disableAIFeatures`).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. For security problems, see [SECURITY.md](SECURITY.md) and
please do not open a public issue.

## License and credits

Vantrex IDE is released under the [MIT License](LICENSE.txt). It is a derivative of
[Code - OSS](https://github.com/microsoft/vscode), the open-source project behind Visual Studio Code, Copyright (c) Microsoft Corporation,
also MIT licensed. Third-party components keep their own licenses: see [ThirdPartyNotices.txt](ThirdPartyNotices.txt).

Vantrex IDE is not affiliated with, endorsed by or sponsored by Microsoft. "Visual Studio Code" and "VS Code" are trademarks of Microsoft
Corporation. JetBrains Mono is distributed under the SIL Open Font License.
