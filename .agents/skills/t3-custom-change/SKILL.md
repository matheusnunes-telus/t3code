---
name: t3-custom-change
description: How to build a feature or fix in Matheus's custom T3 Code fork and land it as a local commit on the `custom` branch. Use it for any code or UI change in this repo, even a small tweak, and whenever someone asks to add, change, fix or polish something in the app. Read it before the first edit. Use t3-custom-rebuild to install the result and t3-custom-sync for anything involving the fork or official repos.
---

# Make a change in T3 Code (Custom)

This repo is `pingdotgg/t3code` plus Matheus's own features, on the branch `custom`. Matheus uses the built app (`~/Applications/T3 Code (Custom).app`) as a daily driver, and this chat may be running inside it. `CUSTOM-CHANGELOG.md` lists what the fork adds.

`AGENTS.md` still applies. Where it and this skill differ, this skill wins, because it records what Matheus chose for the fork.

## Setup

Run this at the start of every shell command that uses repo tools, because shell state doesn't carry over:

```sh
source scripts/custom-env.sh
```

Run tools as `pnpm exec vp ...`. Calling `vp` directly can fail with "Vitest failed to find the current suite".

## Work in your own worktree

Matheus often has many chats changing this repo at once. So every change gets its own worktree, and the main checkout (`~/Desktop/matheus/repos/t3code`) stays clean on `custom`. Don't edit there: it's only for landing, rebuilding and syncing. If you find uncommitted files there, they belong to another chat, so leave them alone.

Pick a short name for the change, then:

```sh
cd ~/Desktop/matheus/repos/t3code
git worktree add ../t3code-wt-<name> -b <name> custom
cd ../t3code-wt-<name>
source scripts/custom-env.sh
pnpm install --frozen-lockfile
```

Don't symlink `node_modules`. If the chat already runs in a worktree T3 made (under `~/.t3/worktrees`), use that one. Its setup runs in the background, so wait while `.t3/setup-running` exists. Check that it's based on `custom`: this repo's `origin` is the official repo, so T3 can start a worktree from official `main`, which doesn't have the fork.

## Where chats start

New chats about the fork belong in the **T3 Custom** project, which points at this repo. Skills load on their own there, and its default provider is Personal Claude.

An older chat outside the repo can't load this skill with the Skill tool. Read it with `cat ~/Desktop/matheus/repos/t3code/.agents/skills/t3-custom-change/SKILL.md`. The same goes for t3-custom-rebuild and t3-custom-sync.

Screenshots pasted into the chat often show as "unavailable". They are on disk in `~/.t3/custom/userdata/attachments/`, so view the newest `.png` there before asking.

## Build it

- For UI work, read [references/design-language.md](references/design-language.md) first. It has the fork's layout choices and the rules lint won't catch.
- Copy the closest existing component instead of inventing a pattern.
- Every change Matheus suggests also becomes an option in Settings, in the same commit. Put it in the section where it belongs in the settings menu, as a `SettingsRow` with a description and a `settingsSearch` entry. Don't add a catch-all section.
- Start from the simplest version that works. List what you cut, so Matheus can ask for it later.
- For a proposal or a big UI change, show a mock before building it, and always show it as a screenshot (a saved `.png` path in your reply), not only a description. If the change touches UI and the real app can't show it (for example it needs live Google Cloud or Jira data), a mock screenshot is the minimum. See "Run a mock" below.
- If you're unsure about a choice that changes the result, ask. For "it was fine before" bugs, run `git log -S` on the relevant code first: the cause is often one recent fork commit, and its message says what it meant to do.
- Don't use `try`/`catch` inside `ChatView.tsx` handlers. It caused a render loop (React #301) in the installed app. Use `.then(ok, err)` or the `result._tag === "Failure"` pattern.

## Run a mock

A mock is a small standalone HTML page that looks like the new UI, so Matheus can judge it before or without the real build.

1. Write one `.html` file in your scratchpad. Copy the real colors, spacing and component look from [references/design-language.md](references/design-language.md) and from the closest existing component. Use fake data only, never real names, ticket text or project ids.
2. Show it with `html_preview`, then `html_render`. Don't start a server for it.
3. Save a screenshot as a `.png` and put its absolute path in your reply. Show the states that matter: default, hover, empty, disabled, and before/after when it helps.
4. Say what the mock leaves out, so nobody mistakes it for the built thing.

If the real app can show the change (dev app, see [references/dev-testing.md](references/dev-testing.md)), screenshots of the real app beat a mock.

## Check it

1. `pnpm exec vp run typecheck`. A broken build can crash the installed app.
2. `pnpm exec vp test run <files>` for the tests near your change.
3. For a UI change, try it in the dev app, including hover, empty and disabled states, and take screenshots. See [references/dev-testing.md](references/dev-testing.md). It also covers two dangers: never run a dev server on real data, and stop what you started.

A UI change is not checked until you have looked at screenshots of it in the dev app. Typecheck and unit tests don't count. Do this before you commit, show the screenshots in your reply (the saved `.png` paths from `preview_snapshot`), and say what you could not reach in the dev app. If you skip it, say so, and don't land the change.

## Commit it

Commit on your worktree's branch. Make one commit per requested change, so each one is easy to track and revert. Never rebuild or push as part of a change. Those only happen when Matheus asks.

- The subject is a plain sentence saying what changed for the user, like "Add a Mark as unread button under the latest reply". The fork doesn't use `feat(web):` prefixes. Add a short body when the why isn't obvious.
- If users will notice the change, add a line to `CUSTOM-CHANGELOG.md` in the same commit, under the matching section.
- Commits are SSH-signed. If a commit hangs, the key isn't loaded in ssh-agent. Tell Matheus rather than turning signing off.

The pre-commit hook runs format, lint and knip. As of 2026-11-03 the fork has 15 unused exports (mostly Jira and Google Cloud) and about 21 lint errors from stricter upstream rules. Knip checks the whole repo, so **any code commit fails the hook** until those are cleaned up.

When the hook fails, read the failure. If it's in code you wrote, fix it. If every failure was already there, commit with `--no-verify` and say so in your reply. To compare, run `pnpm exec vp run knip:check` and check that your change adds nothing to the list. Once that list is empty, delete this paragraph and the one above.

## Land it on `custom`

Once the change is checked and you think the solution is good enough, land it without asking, unless Matheus asked to keep it on the branch. Only do it when the main checkout (`~/Desktop/matheus/repos/t3code`) has no uncommitted changes (`git -C ~/Desktop/matheus/repos/t3code status --short` is empty). If it's dirty, leave the work on its branch and tell Matheus. Landing is local and easy to undo. From your worktree:

```sh
git rebase custom
pnpm exec vp run typecheck
cat ~/.t3/custom-rebuild.lock 2>/dev/null
git -C ~/Desktop/matheus/repos/t3code merge --ff-only <name>
```

- `git rebase custom` puts your commits on top of what other chats landed. If it conflicts, keep both sides: the other work is finished work from another chat. In `CUSTOM-CHANGELOG.md` that just means keeping both lines. If another chat changed the same behavior in a way you can't combine, ask.
- A fast-forward can't conflict. If it refuses, another chat landed first, so run the steps again. Never use a merge commit or force anything to get around that.
- If the lock file exists and its PID is alive (`kill -0 <pid>`), a rebuild is running and reads the files in the main checkout. Don't land until it ends. If it isn't alive, the lock is stale and you can land.

## Clean up

After landing, stop any dev server you started, then delete the worktree and branch:

```sh
cd ~/Desktop/matheus/repos/t3code
git worktree remove ../t3code-wt-<name>
git branch -d <name>
```

Don't add `--force`, and don't use `-D`. Both commands refuse when something would be lost, like uncommitted files or commits that didn't land, so look at what's there first. If Matheus asks for more in this chat, make a new worktree.

Leave worktrees T3 made in place, since their chat depends on them. Tell Matheus the work has landed.

## Report back

End your reply with:

- What changed, plus screenshots for UI changes.
- What you tested and what you didn't.
- Everything on `custom` waiting for the next rebuild, as short hash and subject, including what other chats landed. Call out reverts, since a change and its revert cancel out. If you kept work on a branch, say so, since it won't be in the next rebuild.

```sh
git log --oneline "$(cat ~/.t3/custom-app-built-commit)"..custom
```
