# Bug Detective — Product Requirements v4

Oct 25, 2026 · @Pedro Henrique Leão Braga

## 1. Vision and changes from v3

Bug Detective is an offline-first simulation of working as a software developer: players join a fictional consulting company, receive realistic tickets, debug a running app in their own VS Code and browser, and go through QA and a simulated code review. The audience is people who already program and need practice debugging and maintaining real projects. No AI judges or explains player solutions.

**Current milestone:** Stage C on **Windows**: the Electron desktop app around the finished SupportDesk stages and QA suite. macOS and Linux come after the Windows version works end to end. The app also runs in development mode directly inside WSL 2 (Linux), through the same platform module; Linux packaging is still part of Stage D.

**What changed from v3**

| Area | v3 | v4 |
| --- | --- | --- |
| Delivery | A → B → C | A → B → C (Windows) → **playtest** → D (macOS, Linux) |
| Onboarding bugs | 3 (search case, priority, assignment) | 4: useEffect stale data, false assignment success, priority payload field, blank screen on null assignee |
| Search | Frontend or backend (unclear) | Backend, case-insensitive, no bug attached |
| SupportDesk scope | List + details, priority and assignee | Adds Previous/Next navigation, editable status, unassign, `employees.active` |
| Language | Not defined | App in English; game texts (tickets, QA, hints, review) bilingual PT/EN |
| Editor | No Dev Containers | VS Code **inside the container** via Dev Containers |
| Workspace | Not defined | Code lives in a Docker named volume; manual "Export progress" backup |
| Gate 1 | "Project's own tests" | Curated stage tests only |
| Hidden tests | "Outside the workspace" | Per-stage package on GitHub Releases |
| Stuck players | No hints | Ask the senior dev on the card → prewritten hints → final solution |
| Done tickets | Can switch back and edit | Read-only in the app |
| Stage download | Shallow clone/fetch | Snapshot import as a commit |
| Platforms | Windows | Windows first; macOS and Linux later |

## 2. Delivery sequence

Stages A and B are done. The playtest now runs on the Windows desktop app, and other platforms wait for its result.

1. **Stage A — SupportDesk (done).** The standalone app, verified hands-on: list, search, details, Previous/Next, priority, status and assignee editing, tests passing.
2. **Stage B — Assignments (done).** Four deterministic bug stages with ticket texts, hidden validation, reference fixes and the QA CLI. Each buggy stage passes Gate 1 and fails Gate 2; each reference fix passes both.
3. **Stage C — Desktop experience on Windows (current).** Electron dashboard, company context, manager messages, Kanban, senior-dev hints, Git and Docker orchestration, VS Code launch, prerequisites checklist and a Windows installer. Runs on Windows with Docker Desktop and WSL2. OS-specific code stays isolated so other platforms can be added without rewrites.
4. **Playtest.** Run the Windows desktop app with 3–5 real developers.
   - Go/no-go: after finishing the four tickets, ask each tester "Would you play a next project with new bugs?". Proceed to Stage D and new content if at least 3 of 5 say yes.
5. **Stage D — macOS and Linux.** Port and package the desktop app for macOS (including notarization) and Linux (Docker Engine).

## 3. SupportDesk specification

SupportDesk is a two-screen customer support app in English, with no authentication. The story: the player joins a small team building an early-stage platform for a client, and the manager hands out low-hanging bug fixes as onboarding.

**Ticket List**

- Table: ID, title, status, priority, assignee; ordered by ID.
- Search by title, performed by the backend, case-insensitive, partial match.
- Clicking a row opens its details; the search term travels in the URL (e.g. `/tickets/4?search=login`).

**Ticket Details**

- Shows title, description, status, priority, assignee.
- Editable: priority, status, assignee (including "Unassigned"). Changes persist.
- Previous / Next buttons move between tickets **within the current search results**, by ID; disabled at the first and last result. The component stays mounted, so the URL changes without a full remount.
- Assignee dropdown lists active employees only.

**Data model**

| Table | Fields |
| --- | --- |
| `tickets` | `id`, `title`, `description`, `status` (Open / In Progress / Closed), `priority` (Low / Medium / High), `assigneeId` (nullable), `createdAt`, `updatedAt` |
| `employees` | `id`, `name`, `email`, `active` (boolean) |

Seed: about 15 tickets and 5 employees, including at least one inactive employee and several unassigned tickets. All seed text in English.

**API**

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/api/tickets?search=` | Case-insensitive title search; ordered by ID |
| GET | `/api/tickets/:id` | 404 for unknown IDs |
| PATCH | `/api/tickets/:id` | Any of `priority`, `status`, `assigneeId` (`null` unassigns); updates `updatedAt`; 400 on invalid enum; 422 when assigning an inactive employee |
| GET | `/api/employees` | Includes `active` |

**Stack:** React, TypeScript, Vite; Node.js 26, Express; SQLite; Vitest for project tests; Playwright and API requests for hidden validation. Every interactive element the hidden tests use carries a stable `data-testid`.

## 4. Onboarding bugs

Four tickets, one revealed per phase, covering three skills: async and state, tracing data flow, and reading errors and debugging. Each stage contains the reference fixes of earlier tickets plus the next bug. Ticket texts describe symptoms and expected behavior, never the faulty file or the fix.

| # | Ticket | Skill | Symptom the player sees | Cause in the code | Required fix (what Gate 2 checks) |
| --- | --- | --- | --- | --- | --- |
| 1 | Details show the wrong ticket | Async and state | Clicking Next changes the URL to `/tickets/4`, but title and description still show ticket 3 | The details `useEffect` fetches with `[]` instead of `[id]` | Content always matches the ID in the URL after Previous/Next |
| 2 | Assignment says "success" when it fails | Async and state | Assigning an employee who left the company shows a success message; after reload the old assignee is back | Inactive employees appear in the dropdown; the PATCH returns 422, but the UI does not await or check the response | Both: the UI shows an error and keeps the previous assignee, **and** inactive employees are removed from the dropdown |
| 3 | Priority does not save | Tracing data flow | The UI shows the new priority; after reload it is back to the old value | The frontend sends `{ priorityLevel }`, the backend expects `{ priority }`, silently ignores the field and returns 200 | The new priority persists after reload |
| 4 | Blank screen on some tickets | Reading errors and debugging | Opening certain tickets shows an empty page; the error appears only in the browser console | The API is correct; the React component reads `assignee.name` without handling `null` | Unassigned tickets open and show "Unassigned"; assigned ones are unaffected |

Notes:

- Ticket 2's text must describe both symptoms (false success and the departed employee in the list), since Gate 2 requires both fixes.
- Ticket 2's failure is real and reproducible by the player, not simulated in tests.
- Ticket 4 is meant to be the hardest: there is no server stack trace, so the player needs DevTools or a breakpoint.
- The seed contains unassigned tickets from Stage A onward; ticket 4 is a regression introduced by a later change.

## 5. Assignment packaging

Each ticket ships as two pieces: the app code as a stage branch in the public repository, and everything else as a per-stage package attached to a GitHub Release.

| Piece | Where it lives | Contents |
| --- | --- | --- |
| Stage code | Branch `stage-N` of the public repo | Complete app with earlier reference fixes, the next bug, the curated project tests, README |
| Stage package | GitHub Release asset for stage N | Curated Gate 1 test files, hidden Gate 2 suite, reference fix, review explanation, ticket text (PT/EN), senior-dev hints and final solution (PT/EN) |

- New stages need no app update: the Electron app (or the B.5 CLI) downloads the stage and its package together.
- Each reference fix adds a regression test that becomes part of the next stage's curated suite.
- **Test contract:** the SupportDesk README has a "Team conventions" section: do not remove `data-testid` attributes, do not change API routes or response shapes, do not alter the seed. Hidden tests rely on these, never on visible text (the game is bilingual).
- Hidden tests are not truly secret from a determined local user; acceptable for an offline learning MVP, not for competitive rankings.

## 6. Game workflow

The player moves a card only from To Do to In Progress and from In Progress to In QA; every other move is made by the system.

&#91;embedded content: Kanban flow · 5 columns, 2 QA gates\]

A failed gate or a timeout always returns the card to In Progress with a QA comment; the player cannot cancel QA.

**Kanban rules**

- One active ticket at a time; **Get Next Assignment** unlocks the next one after Done.
- Moving to In QA triggers validation for that ticket only.
- **Gate 1:** runs only the curated tests from the stage package (player-edited or deleted tests do not count).
- **Gate 2:** runs only if Gate 1 passes; runs the ticket's hidden validation.
- Failures return the card with a predefined QA message naming the gate, failing test names and errors.
- **Timeout:** if QA exceeds its limit (e.g. 3 minutes), it is stopped and counts as a failed attempt, with a comment suggesting a hang or infinite loop and listing unfinished tests.
- Passing both gates moves the card to Code Review, which shows the prewritten reference and explanation. Accepting the review moves it to Done.
- Every transition is an append-only record (ticket, from, to, timestamp) shown with QA comments and attempt history.

**QA environment:** QA copies the player's current workspace into a separate container with a fresh database from the seed and its own ports, so it never touches the player's running server or data.

**Senior-dev hints:** from a card in progress, the player sends a message to the senior developer, who replies with prewritten hints (PT/EN), one at a time. Only after all hints are used can the final solution be revealed. Even then, the player must apply it and pass QA. History records how many hints were used and whether the solution was revealed.

**Starting a ticket** (To Do → In Progress, which happens only once per ticket) resets the workspace to the clean stage: uncommitted changes, untracked files and extra commits on `player/ticket-N` are discarded, and the database is reseeded. Coming back from QA never resets anything, so the player continues where they stopped. Starting a ticket needs Docker running.

**Done tickets** are read-only in the app: the player can view the review, QA comments and history, but the app never switches back to an old ticket's branch.

No scores, rankings, visible timers or AI assessment in the MVP.

## 7. Runtime and environment

The app runs in Docker, and the player edits it in VS Code attached to the container through Dev Containers, so no Node install is needed on the host.

| Decision | Choice | Consequence |
| --- | --- | --- |
| Runtime | Docker Desktop with the WSL2 backend | Players install Docker; RAM use must be benchmarked |
| Editor | VS Code inside the container via Dev Containers | IntelliSense, terminal, Node and debugger all run in the container; the app installs the extension with `code --install-extension` |
| Workspace | Code in a Docker named volume | Native Linux speed and file watching; a Docker reset or `prune --volumes` erases the work |
| Backup | Manual "Export progress" button | Player must remember to export; format still open |
| Dependencies | Installed on demand | The app runs offline; if `node_modules`, Playwright or an image is missing (first run or a stage with new deps), it asks for internet and installs what is needed |
| QA | Separate container per run | Fresh seeded database and its own ports |
| Platforms | Windows first; macOS and Linux in Stage D | One packaging and test target for now; OS-specific code is isolated behind a platform module |

**First run:** a guided checklist verifies Docker Desktop, WSL2 (Windows), VS Code and the Dev Containers extension. Each missing item gets a link and instructions; the extension is installed automatically. The game unlocks only when every item is green.

**Players are free to use** DevTools, Postman, terminals and any tool; none is mandatory. An 8 GB RAM target is a hypothesis to benchmark, not a guaranteed minimum.

## 8. Git and stage distribution

Each unlocked stage is downloaded as a snapshot and imported as a new commit in the player's single local repository; no shallow clone or fetch logic is needed.

- **GitHub is a download source only:** no player login, tokens or push permission. Internet is needed to download a newly unlocked stage and its Release package; everything after that works offline.
- **Download only the unlocked stage:** the app downloads the `stage-N` branch archive plus its Release package, imports the code as a commit and creates branch `player/ticket-N` from it. Future stages are never fetched ahead of time.
- **One working directory**, inside the Docker volume. The next ticket starts from the curated stage, not from the player's implementation; the player's earlier branches are kept locally and never pushed.
- **Player Git is free:** the player may commit and create branches in VS Code. QA evaluates the current state of the workspace files, not a specific branch. If HEAD is not on the ticket's branch, the app warns the player.
- **No switching back:** since Done tickets are read-only, the app never checks out an older ticket's branch.
- **One game per workspace:** the Docker volume outlives the saved game, so the repository records which game it belongs to. When a different game (or **Settings → New game**) unlocks a stage, the previous game's `player/*` branches are renamed to `archive/<time>/…` and its uncommitted work is stashed, so a new game never inherits old code.
- **Anti-cheat limitation:** the public repository and Release assets can be discovered by a motivated player; this is accepted for the MVP.
- Failed or partial downloads must be retried safely without touching existing player branches.

## 9. Scope, open items and next actions

**Out of scope for the first release**

- AI reviews, AI scoring, style judging or AI-generated tickets and hints (prewritten senior-dev hints are in scope).
- GitHub player login, pushing player work, remote sync, multiplayer, leaderboards, scores, visible timers.
- Multiple simultaneous tickets, difficulty selection, promotions or character systems.
- Embedded code editor, custom WSL2 distribution, multiple running projects.
- Reopening Done tickets or resubmitting them to QA.
- Complex SupportDesk features (authentication, notifications, comments, administration).

**Open items (Stage C, not blocking)**

- [x] Where game state is stored: one versioned `state.json` in the app data folder, written atomically, with schema migrations on load
- [x] "Export progress" format: a `.bdsave` zip (manifest with checksums, game state, `git bundle` of the workspace, stage packages); restore validates everything, warns before overwriting, then recreates the volume
- [ ] Windows code signing and auto-update (macOS notarization moves to Stage D)
- [ ] Docker Desktop license terms if companies adopt the game for training
- [x] QA timeout value: 3 minutes by default, configurable in Settings (30 s to 30 min); a timeout counts as a failed attempt

**Next actions**

1. SupportDesk, its four stages and the QA suite are done and verified.
2. Move the whole project to Node.js 26 (SupportDesk on all branches, QA and the desktop app) and re-run the verification matrix.
3. Build the Stage C desktop app on Windows with WSL2, reusing the SupportDesk QA CLI as the QA engine.
4. Write the senior-dev hints, final solutions, review texts and manager messages for the four tickets.
5. Verify the full loop on Windows: first-run checklist, stage download, Kanban, QA pass and fail, hints, code review, export and restore.
6. Run the playtest with 3–5 developers.
7. If the playtest passes: Stage D for macOS and Linux.
