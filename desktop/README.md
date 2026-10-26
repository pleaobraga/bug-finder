# Bug Detective (desktop)

An offline-first desktop game where developers practice debugging. The player joins Lanternfish Labs, gets SupportDesk tickets on a Kanban board, fixes them in their own VS Code (attached to a Docker container), and goes through QA and a code review. Windows only for now.

- Electron 45 (Node.js 24.22 inside Electron) + React 19 + TypeScript 7 + Vite 8 via electron-vite 6
- Tailwind CSS 4 (`@tailwindcss/vite`, tokens in `src/renderer/src/styles.css` with `@theme`), Inter and JetBrains Mono bundled locally
- i18next (English and Brazilian Portuguese)
- electron-builder 26 (NSIS installer)
- Build tooling: Node.js 26.12.1 (`.nvmrc`), the same version as SupportDesk and the Docker images

## Layout

```
src/main/              Electron main process
  index.ts             window, security settings, content source selection
  ipc.ts               IPC handlers; every input validated with zod
  game.ts              game controller (Kanban rules + runtime), independent of Electron
  runtime.ts           GameRuntime interface and DockerRuntime
  fake-runtime.ts      in-memory runtime for the e2e tests (development builds only)
  services/            prerequisites, docker, workspace, content/, qa, vscode, state, backup, process
  platform/            OS-specific code: types.ts (interface), windows.ts
src/preload/           the typed window.bugDetective bridge
src/renderer/          React UI (Tailwind)
src/shared/            types, the Kanban state machine, QA message selection
docker/workspace/      the player's workspace image (+ the port forwarder)
docker/qa/             the QA image (Node 26 + Playwright Chromium + the SupportDesk QA CLI)
content/               company story and manager messages (story.en.json, story.pt.json)
tools/                 build-stage-packages.ts, prepare-resources.ts, sync-windows.sh, win.sh
test/unit|integration|e2e|manual
```

## Requirements

- Windows 10/11 with WSL 2 and Docker Desktop (WSL 2 backend)
- VS Code (the app installs the Dev Containers extension)
- For development: Node.js 26.12.1 on Windows; optionally Node.js 26.12.1 in WSL for unit tests
- `../supportdesk` next to this folder (the SupportDesk repository with the `stage-N` branches)

## Development on Windows

```powershell
npm ci
npm run electron:install   # downloads the Electron binary (Electron 45 does it lazily)
npm run dev                # prepares build/docker and build/stage-packages, then starts Electron
```

`npm run dev` and `npm run build` first run:

- `tools/prepare-resources.ts`: copies `docker/` and the QA CLI (`../supportdesk/qa` without `stages/`) into `build/docker/` and writes content-addressed image tags to `build/docker/images.json`;
- `tools/build-stage-packages.ts`: builds `build/stage-packages/` (one zip per stage + `manifest.json`), which the local content source verifies against.

## Development from WSL 2

The app is a Windows app, so Electron, the e2e tests and the installer run with Windows Node.js on a Windows copy of the code. `node_modules` is never shared between the two sides.

```sh
# Linux side: unit tests (and SupportDesk/QA work)
nvm use            # 26.12.1
npm ci
npm test

# Windows side: sync to C:\Users\<you>\bugdetective-dev, then run there with Windows Node
tools/sync-windows.sh
tools/win.sh npm ci
tools/win.sh npm run electron:install
tools/win.sh npm run dev
tools/win.sh npm run test:e2e
tools/win.sh npm run dist:win
```

`tools/win.sh` expects a Windows Node.js 26.12.1 in `%USERPROFILE%\bugdetective-dev\tools\node-v26.12.1-win-x64` (the official portable zip), or set `BUGDETECTIVE_WIN_NODE`. Run `tools/sync-windows.sh` after every change.

Docker is shared: `docker.exe` on Windows and the WSL integration talk to the same engine.

## Tests

| Command | Where | What |
| --- | --- | --- |
| `npm test` | WSL or Windows | Vitest unit tests: Kanban rules, state and migrations, QA result parsing and messages, checksums, content sources (local git repo and a mock GitHub server), backup manifests, Windows detection, the game controller |
| `npm run test:integration` | Windows + Docker Desktop | Real Docker: unlock stage 1, QA on the buggy stage (Gate 2 fails), infinite-loop timeout, `reference.patch` applied in the workspace container (both gates pass), next stage, export/delete/restore, interrupted QA. Uses the `bugdetective-test-*` resources only. Run `npm run build` first. |
| `npm run test:e2e` | Windows | Playwright for Electron with the fake runtime: first-run checklist, Docker banner, Kanban drag rules, ticket panel, language, restart |
| `npx playwright test --config playwright.manual.config.ts` | Windows + Docker Desktop + VS Code | The full game loop through the real UI (all four tickets, VS Code attach, restart during QA, export/restore). Opens VS Code windows. |

## Installer

```powershell
npm run dist:win     # dist\Bug-Detective-Setup-<version>.exe (not signed)
```

The installer is per-user (no admin rights), lets the player choose the folder, and adds Start menu and desktop shortcuts. The packaged app carries `resources/docker/` (Dockerfiles, the QA CLI, `images.json`); images are built on the player's machine the first time, with the player's consent.

## Configuration

| | |
| --- | --- |
| State | `%APPDATA%\Bug Detective\state.json` (versioned JSON, atomic writes, migrations in `services/state.ts`) |
| Stage packages | `%APPDATA%\Bug Detective\packages\stage-N.zip` and `stage-N\` (outside the Docker volume) |
| Content source | Development: the local SupportDesk checkout (`BUGDETECTIVE_SUPPORTDESK`, `BUGDETECTIVE_MANIFEST` override the paths). Installed app: GitHub, `bugDetective.contentRepository` / `contentRelease` in `package.json`. `%APPDATA%\Bug Detective\content-source.json` overrides both: `{ "kind": "local", "repoPath": "...", "manifestPath": "..." }` or `{ "kind": "github", "repository": "owner/name", "release": "latest" }` |
| Data folder | `BUGDETECTIVE_USER_DATA` replaces `%APPDATA%\Bug Detective` (tests, clean-profile checks) |
| Docker resources | Volumes `bugdetective-workspace` (the player's repository), `bugdetective-vscode-server`, `bugdetective-qa-cache` (dependency cache); container `bugdetective-workspace`; images `bugdetective-workspace:<hash>`, `bugdetective-qa:<hash>`; QA containers `bugdetective-qa-*`. All labeled `bugdetective.role`. |

## Publishing stages (GitHub)

Nothing is published automatically. To publish a content release:

1. Push the `stage-1` … `stage-4` branches to the public repository (for example `pleaobraga/supportdesk-qa`). Keep `qa/` off those branches.
2. `npm run build:stages -- --version 1.0.0` (or `node tools/build-stage-packages.ts --repo ../supportdesk --version 1.0.0`).
3. Create a GitHub Release (tag `v1.0.0`) and upload every file of `build/stage-packages/`: `manifest.json` and `stage-N-v1.0.0.zip`.
4. The app downloads `releases/latest/download/manifest.json`, then the package of the unlocked stage and `archive/refs/heads/stage-N.zip`. It checks the package's SHA-256 and the stage files' digest against the manifest before using anything. If a branch moves after the release, its digest no longer matches: publish a new release.

## How the workspace and VS Code fit together

- The workspace container runs `bugdetective-workspace:<hash>` (`node:26.12.1-bookworm`, the same base as SupportDesk's dev container, user `node`) with the `bugdetective-workspace` volume at `/workspaces/supportdesk`. Its ports are published on `127.0.0.1` only: the container's 15173 (a small forwarder to Vite on `localhost:5173`, which only listens on localhost) and 3001 (the API). Free host ports are chosen when 5173/3001 are taken.
- Unlocking a stage imports the stage files as a commit on the internal branch `bugdetective/stages` (tagged `stage-N`), then creates `player/ticket-N` from it. Uncommitted work from the previous ticket is stashed, never discarded; earlier `player/*` branches are never changed.
- **Open in VS Code** runs `Code.exe <commit>\resources\app\out\cli.js --new-window --folder-uri vscode-remote://attached-container+<hex of {"containerName":"/bugdetective-workspace"}>/workspaces/supportdesk` with `ELECTRON_RUN_AS_NODE=1`, which is exactly what `bin\code.cmd` does, without going through `cmd.exe`.
- QA runs in a new container per attempt, with `--network none`, the workspace volume mounted read-only, the stage package bind-mounted read-only, and dependencies from the cache volume. The container is always removed.

## Security

- `contextIsolation`, `sandbox` and no `nodeIntegration` in the renderer; the preload exposes one typed object; every IPC call is validated with zod and only accepted from the app's own page.
- A strict CSP (`default-src 'none'`, scripts, styles and fonts from `'self'` only); no remote content, navigation and new windows blocked, permission requests denied.
- External commands run with `spawn` and argument arrays only. The few shell scripts run inside containers are constants; data reaches them only as positional arguments.
- `shell.openExternal` only for the four help pages in `EXTERNAL_LINKS` and the workspace app on `http://127.0.0.1:<published port>/`.
