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

Run `git status -sb` before you edit. Other chats work in this repo too, so uncommitted files you didn't touch belong to someone else. Leave them alone, and stage your own files by path instead of `git add -A`.

If you're in a worktree, commit on its branch. When Matheus wants it on `custom`, merge from the main checkout with `git merge --no-ff <branch>` ("Merge branch '<branch>' into custom"). A new worktree needs its own `pnpm install --frozen-lockfile --ignore-scripts`. Don't symlink `node_modules`.

## Build it

- For UI work, read [references/design-language.md](references/design-language.md) first. It has the fork's layout choices and the rules lint won't catch.
- Copy the closest existing component instead of inventing a pattern.
- Start from the simplest version that works. List what you cut, so Matheus can ask for it later.
- For a proposal or a big UI change, show a mock before building it.
- If you're unsure about a choice that changes the result, ask.
- Don't use `try`/`catch` inside `ChatView.tsx` handlers. It caused a render loop (React #301) in the installed app. Use `.then(ok, err)` or the `result._tag === "Failure"` pattern.

## Check it

1. `pnpm exec vp run typecheck`. A broken build can crash the installed app.
2. `pnpm exec vp test run <files>` for the tests near your change.
3. For a UI change, try it in the dev app, including hover, empty and disabled states, and take screenshots. See [references/dev-testing.md](references/dev-testing.md). It also covers two dangers: never run a dev server on real data, and stop what you started.

## Commit it

Make one commit per requested change, so each one is easy to track and revert. Never rebuild or push as part of a change. Those only happen when Matheus asks.

- The subject is a plain sentence saying what changed for the user, like "Add a Mark as unread button under the latest reply". The fork doesn't use `feat(web):` prefixes. Add a short body when the why isn't obvious.
- If users will notice the change, add a line to `CUSTOM-CHANGELOG.md` in the same commit, under the matching section.
- Commits are SSH-signed. If a commit hangs, the key isn't loaded in ssh-agent. Tell Matheus rather than turning signing off.

The pre-commit hook runs format, lint and knip. As of 2026-11-03 the fork has 15 unused exports (mostly Jira and Google Cloud) and about 21 lint errors from stricter upstream rules. Knip checks the whole repo, so **any code commit fails the hook** until those are cleaned up.

When the hook fails, read the failure. If it's in code you wrote, fix it. If every failure was already there, commit with `--no-verify` and say so in your reply. To compare, run `pnpm exec vp run knip:check` and check that your change adds nothing to the list. Once that list is empty, delete this paragraph and the one above.

## Report back

End your reply with:

- What changed, plus screenshots for UI changes.
- What you tested and what you didn't.
- Everything waiting for the next rebuild, as short hash and subject. Call out reverts, since a change and its revert cancel out:

```sh
git log --oneline "$(cat ~/.t3/custom-app-built-commit)"..HEAD
```
