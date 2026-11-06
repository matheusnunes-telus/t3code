# Common pitfalls

Mistakes that cost Matheus a round trip, from a sweep of the chats between 2026-10-19 and 2026-11-05. One entry per mistake: what he saw, why it happened, the rule.

**Add a line here when Matheus corrects you, or when a tool fails twice for the same reason.** Keep each entry to 2-3 lines with a date. If a rule fits an existing entry, update that entry. Tell Matheus in one line what you added.

## Before you report "done"

- **Feature hidden in his real chats** (2026-10-19, Edit button). It only showed in git repos. His chats mostly run in `~/.t3/scratch`, which is not a git repo ("No project"). *Rule:* say which kinds of chat the feature works in, and check a No project chat. The dev server has none, so see the last bullet in `dev-testing.md`.
- **Same bug, another chat type** (2026-11-04, Jira card in No project chats). *Rule:* any feature that attaches something to a chat (Jira, PR, cloud) must be off for No project chats unless Matheus says otherwise.
- **Installed build crashed** (2026-10-19, React #301). The cause was `try`/`catch` in `ChatView.tsx` (see `SKILL.md`). Only dev mode had been checked. *Rule:* if you touch `ChatView.tsx`, say the installed build was not tried.
- **"Was that in the last rebuild?"** (2026-11-03 and 2026-11-04, twice). *Rule:* always end with the un-rebuilt list from `SKILL.md`, and say when a fix still needs a rebuild to show.

## Defaults Matheus wants (ask about these before building)

- **Opt-in, not automatic** (2026-10-30). About half his chats need no Jira ticket. Anything that spends tokens or notifies him starts only when he clicks.
- **Generic, not his setup** (2026-10-30). No project ids, repos or workflow names in code. Other people should be able to use it.
- **Every change is a setting** (2026-11-04), in the right section of the menu. Already in `SKILL.md`; it's here because it was missed once.
- **Deploy and cloud notifications** are noisy on shared projects like Pegasus (2026-11-03). Default to following only what he picked.

## UI

- **Overlaps, overflow, edges** (2026-10-20, 2026-10-21). He found a header touching the macOS buttons, a button covering another, tabs covering the sidebar icon. *Rule:* for each UI change, look at screenshots of collapsed, hover, overflowing (many tabs) and narrow states. Check the top-left corner (traffic lights x=16, y=19).
- **Two screen sizes.** He moves between a laptop and a 2160x1080 ultrawide. Check sizes that are not the one you tested.
- **Two sidebars** (2026-11-06). He uses `LegacySidebar.tsx` (`legacySidebarEnabled` in Labs); the dev app starts on `Sidebar.tsx`. *Rule:* add sidebar UI to both, and turn the legacy one on before you check it.
- **Screenshots he sends may show as "unavailable".** They are in `~/.t3/custom/userdata/attachments/`. Look there first.

## Parallel chats

- **Two chats on one feature** (2026-11-04, both reworking tab reordering). *Rule:* before you start, run `git worktree list` and `git branch -a`, and read the names. If another branch looks like the same area, tell Matheus before building.
- **Provider switch mid-chat** crashed a turn (2026-10-23). Don't switch providers yourself. Jira work runs on the company provider, the build work on Personal Claude.

## Preview tools

- `preview_snapshot` timed out 10 times, always after 15 s (2026-10-19 to 2026-10-27). *Rule:* after one timeout, don't retry the same call. Use `preview_evaluate`, or CDP screenshots (see `dev-testing.md`).
- `preview_evaluate`: wrap code in `(async () => { ... })()`, because top-level `await` is a SyntaxError (twice). Never navigate inside the script, because that destroys the page context. If an element lookup can return nothing, check it before `.click()`.

## Round trips

- **Batch reads.** 90% of turns in the sweep made a single tool call, and 1,972 Bash calls were small `sed -n`/`head` reads. When you know where something is, read it whole in one call, or send independent calls in the same turn.
- **When you don't know where something is, find it once and write it down.** Add the location to the right skill reference, or to the "where things live" memory.
