# Testing in the dev app

The `test-t3-app` skill covers driving the Browser panel and the free `Replay (dev)` provider. Use it, with the differences below.

## Start

```sh
source scripts/custom-env.sh
node scripts/dev-runner.ts dev --no-seed
```

Run it from your worktree, in the background, and save the PID. Read the real ports and `pairingUrl` from its log with `grep -a`. Each worktree gets its own state folder (`.t3`, gitignored) and its own ports, so servers from other chats don't clash with yours.

For desktop layout (title bar, traffic lights, sidebar), run this instead:

```sh
T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=9333 node scripts/dev-runner.ts dev:desktop --no-seed
```

Pick another port if another chat holds 9333. Then evaluate JS and take `Page.captureScreenshot` over CDP (the page URL starts with `t3code-dev://`). `screencapture -l` fails because there's no screen-recording permission. Native traffic lights don't appear in CDP shots. They sit at x=16, y=19, 12px each. If the dev window quits right after starting, `touch apps/desktop/dist-electron/main.cjs` relaunches it.

## Never use real data

Always pass `--no-seed` from a worktree. The real database is `~/.t3/custom/userdata/statev2.sqlite`. Never point a server at it or at a copy of it. On startup the server resumes any run marked as running, so a copied database once took over a live chat, and the replies went to the scratch database where Matheus couldn't see them.

Plain `vp run dev` seeds from real data, so don't use it, even though `AGENTS.md` and `test-t3-app` suggest it.

## Stop what you started

Stop every dev process you started once the change is checked, before you report back. This overrides the "keep the server available" advice in `test-t3-app`. Matheus doesn't want stale processes around, and a leftover `dev-electron.mjs` reopens a "T3 Code (Dev)" window on every rebuild.

- Kill by the PID you saved. Never use `pkill -f` with a pattern: this chat may run inside the app, and other chats run servers from other worktrees.
- Killing the dev runner leaves children behind. List them with `pgrep -fl "dev-runner|src/bin.ts|vite|dev-electron"`. Check each one's folder with `lsof -a -d cwd -p <pid>`, and kill only yours (`apps/server` or `apps/web` in your checkout).
- A leftover server makes the next run fail with "A T3 Code server is already running".

## Gotchas

- A project in the dev app that points at a real repo edits real files, because auto-save is on. Test edits in a scratchpad (Untitled-N), then check `git status`.
- The preview tools drop modifiers on clicks, so Alt/Cmd+click can't be tested with them. For those, use Playwright (`playwright-core` in `node_modules`, Chromium in `~/Library/Caches/ms-playwright`) with a persistent profile. Log in with a one-time token from `node apps/server/src/bin.ts auth pairing create --base-dir .t3 --json`.
- The file editor ignores instant clicks. Press the mouse, wait about 60 ms, then release.
- Chats from `thread start --provider devReplay --model showcase --title ...` need no paid model. Create projects with `node apps/server/src/bin.ts project add --base-dir .t3 <folder>` (use `git init`ed folders in the scratchpad).
- Double-clicking sidebar rows through the preview tools only replaces the italic preview tab. To get several permanent tabs, set `localStorage["t3code:chat-tabs:v1"]` to `{"state":{"tabs":[{"threadKey":"<envId>:<threadId>","preview":false}],"closedThreadKeys":[],"lastSweptDay":null,"groupOrder":[]},"version":1}` with `preview_evaluate`, then reload.
- `preview_act` drag takes selectors only. For HTML5 drag and drop, dispatch `dragstart`, `dragover`, `drop`, `dragend` from `preview_evaluate` with a shared `DataTransfer`, and `await` about 100 ms between them so React can update state.
- The dev server's data folder is inside a git repo, so it has no scratch ("no project") chats. Anything that depends on them can't be tried here; say so.
- Matheus's "No project" chats sit in `~/.t3/scratch`, not the server's scratch folder `~/.t3/custom/scratch`, so `isScratchProject` is false for them. Check the title too (`SCRATCH_PROJECT_TITLE`). To try this in the dev app, add a project from a folder named `No project`.
