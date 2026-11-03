---
name: t3-custom-sync
description: How to keep the three copies of the custom T3 Code fork in step - the local `custom` branch, Matheus's fork (`fork/main`) and the official repo (`origin/main`). Use it whenever Matheus asks to pull or merge the latest from the main or official repo, update from upstream, push to the fork, or "sync", or when a PR was merged into the fork from elsewhere.
---

# Sync local, fork and official

| Name          | Where                       | Role                                                     |
| ------------- | --------------------------- | -------------------------------------------------------- |
| `custom`      | local branch                | where all work lands                                     |
| `fork/main`   | `matheusnunes-telus/t3code` | backup and PR target. Holds the same commits as `custom` |
| `origin/main` | `pingdotgg/t3code`          | the official repo. Read only                             |

Never push to `origin`, and never force push. Do what was asked: "pull from main" means steps 1-4, "push" means steps 1 and 5, and "sync" means all of them. Rebuilding is separate (see t3-custom-rebuild) and only happens when asked.

## 1. Check where things stand

```sh
source scripts/custom-env.sh
git status -sb
git fetch origin main && git fetch fork main
git log --oneline custom..fork/main
git rev-list --count custom..origin/main
```

The tree must be clean. If it isn't, stop and ask, since the changes may belong to another chat.

If `fork/main` has commits that `custom` lacks (a PR merged from another session), bring them in first with `git merge --ff-only fork/main`. If that fails, the two have diverged, so use a normal merge.

## 2. Merge the official repo

A big merge takes hours, and other chats keep landing work meanwhile. So do it in its own worktree, and the main checkout stays usable:

```sh
cd ~/Desktop/matheus/repos/t3code
git worktree add ../t3code-wt-sync -b sync-official custom
cd ../t3code-wt-sync
source scripts/custom-env.sh
git merge origin/main --no-commit
```

If it goes badly, `git merge --abort` gets you back. Nothing reaches `custom` until you land it in step 5.

Resolving conflicts is the real work here:

- **Keep both sides when you can.** Put the fork's feature inside upstream's rewrite rather than picking one file. `CUSTOM-CHANGELOG.md` lists every fork feature, so check that none got lost.
- **When upstream deletes something the fork uses**, keep it and move any deleted helpers into a fork-only file (as with `apps/web/src/components/LegacySidebar.logic.ts`). Matheus runs the legacy sidebar, and the Jira grouping, sub-projects, Settle and the icon rail live in it.
- **When upstream ships its own version of a fork feature**, compare them. Take upstream's if it does the job better, and tell Matheus you did. That's how upstream's `/side` replaced the fork's side chat. It's Matheus's call if the fork's behavior was a deliberate choice, so ask.
- **When a rule differs**, prefer upstream's unless the fork's was chosen on purpose, and check the tests.
- **Moved or renamed files** often hide fork changes. Search for the fork's code in the new location.
- **Run `pnpm install` once conflicts are resolved**, since the merge usually changes dependencies. It also reinstalls the git hooks.

Commit as "Merge the official main into custom", with a body listing the decisions above. Use `--no-verify` for this commit only: a merge stages everything, so the hook fails on all the old fork lint errors. Say that you did.

## 3. Test it

This is the one time repo-wide checks are fine, and the `AGENTS.md` rule against them doesn't apply, because a merge can break anything.

```sh
pnpm exec vp run typecheck
pnpm exec vp test run
```

Run the tests in the background, and per package if the full run is too slow. Web has `unit` and `browser` projects.

A failure counts against the merge only if it's new. To tell, run the same test file on plain `origin/main` in a temporary worktree, with its own `pnpm install --frozen-lockfile --ignore-scripts`, and remove the worktree afterwards.

Known failures as of 2026-11-03, none caused by a merge:

- Server: about 10 that depend on this Mac (temp paths, npm global, VS Code Insiders, local plugins), and a `DeviceHubProxy.stream` timeout.
- Browser: the GuestPage scroll test, and 5 `ReopenClosedViewShortcut` tests, because the fork maps Cmd+Shift+T to reopening a chat tab.

Upstream tests that assume upstream's look can fail where the fork differs on purpose. Adapt those to the fork's behavior, and say which ones.

Then open the dev app (see `dev-testing.md` in the t3-custom-change skill) and check the fork's main features: legacy sidebar and rail, chat tabs, Jira panel, Cloud panel, step rail and folds, and the slash menu. Show screenshots, and stop the dev server when you're done.

Say plainly what you didn't check. "All tests pass" must mean you saw them pass.

## 4. Update the changelog

In `CUSTOM-CHANGELOG.md`, update "Last synced with the official `main`", and fix any line the merge made wrong. Commit that as its own commit.

## 5. Land and push

Land it the same way as any change (see "Land it on `custom`" in t3-custom-change), with one difference: use `git merge custom` rather than `git rebase custom`, because a rebase would flatten the merge. Typecheck again if other chats landed work. Then fast-forward `custom`, and delete the worktree and branch.

Then push from the main checkout:

```sh
git -C ~/Desktop/matheus/repos/t3code push fork custom:main
```

If it's rejected, `fork/main` moved. Go back to step 1. Don't force.

## Report back

Say how many upstream commits came in and how many files conflicted. Then list the decisions Matheus should know about, what fails and why, what wasn't checked, and whether the app still needs a rebuild.
