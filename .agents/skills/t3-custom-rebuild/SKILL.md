---
name: t3-custom-rebuild
description: How to rebuild and install the custom T3 Code desktop app (`T3 Code (Custom).app`) from the `custom` branch. Use it whenever Matheus says "rebuild", "lets rebuild", "build the app", "install it" or asks to get committed changes into the app, or asks what's waiting for a rebuild or how to roll back to the previous build.
---

# Rebuild T3 Code (Custom)

Only rebuild when Matheus asks. Committing doesn't mean rebuilding.

**Read the t3-custom-change skill first**, before any edit or rebuild, even when the rebuild is just one step of a small change. It covers how changes are made and landed on `custom`: your own worktree, typecheck, dev-app screenshots, commit style and the pre-commit hook. This skill assumes that's done and only installs what has landed. From a chat outside this repo, read it with `cat ~/Desktop/matheus/repos/t3code/.agents/skills/t3-custom-change/SKILL.md`.

## Before

Run these from the main checkout (`~/Desktop/matheus/repos/t3code`), not a worktree.

1. Run `git status -sb` and confirm you're on `custom` with a clean tree. The build uses the files on disk but records `HEAD` as the built commit, so uncommitted work would end up in the app without a record. If there are changes, stop and ask: they may belong to another chat.
2. List what this rebuild adds, calling out reverts: `git log --oneline "$(cat ~/.t3/custom-app-built-commit)"..custom`. If it's empty, say so and ask before building. Run `git worktree list` too, and mention any branches with work that hasn't landed (`git log --oneline custom..<branch>`), since it won't be in this build.
3. Typecheck, because a broken build once crashed the installed app: `source scripts/custom-env.sh && pnpm exec vp run typecheck`.
4. Check no dev server of yours is running. A leftover `dev-electron.mjs` reopens a dev window on every rebuild.

## Build

```sh
scripts/rebuild-custom.sh > /private/tmp/claude-501/rebuild.log 2>&1
```

Run it in the background, because it takes 10 minutes or more, and wait for it to finish. Always use this script rather than `pnpm dist` by hand. It already handles Node 24, pnpm, the cached Rust resource monitor, signing, the bundle id check, backups (it keeps 3), the install and `~/.t3/custom-app-built-commit`.

While it runs, the script holds `~/.t3/custom-rebuild.lock`, and other chats wait to land on `custom`. So the build is exactly the commit it started from, and that's the one it records. If it says another rebuild is running, wait for that one rather than starting a second.

The new app is built and signed in a temp folder, and the installed app is only touched at the end. So a failed build leaves the old app working. Read the log, fix the cause or report it, and don't retry blindly.

## After

- Tell Matheus to quit and reopen the app. Never restart or kill it yourself: this chat may be running inside it.
- Give the rollback command the script printed at the end of the log.
- Say which commits went in.
