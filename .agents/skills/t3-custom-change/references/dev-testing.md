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
