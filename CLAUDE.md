# Bug Finder — project context

- `desktop/`: the Bug Detective Electron app (see `desktop/README.md`). Runs on Windows and on Linux/WSL 2.
- `supportdesk/`: the SupportDesk app and its QA suite; a separate git repository (ignored here). Stage branches `stage-1`…`stage-4` must keep a single commit each.
- Product requirements: `Bug Detective — Product Requirements v4.md`.
- Code, comments and commit messages are in English. Pedro often writes in Portuguese; reply in the language he uses.
- Before implementing a behavior change, propose the design and get approval first.

## Commit message at the end of every task

When you finish a task, end your final message with one suggested commit message: a single line, in a fenced block, following the Conventional Commits rules enforced by `@commitlint/config-conventional`:

```text
<type>(<optional scope>): <subject>
```

- `type`: one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- `scope` (optional, lowercase): the area touched, for example `desktop`, `qa`, `workspace`, `kanban`, `platform`, `ui`, `content`.
- `subject`: imperative, lowercase start, no trailing period; at most 72 characters for the whole line.
- One line only: no body, no bullets, no footer, and a single message even when the task touched several areas.
- Only suggest the message; do not run `git commit` unless Pedro asks.
