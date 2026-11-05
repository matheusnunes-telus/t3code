# T3 Code (Custom) changelog

This fork is the official [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus the changes below. The `custom` branch merges the official `main` from time to time. Everything listed here is what this version adds or changes compared to it.

Last synced with the official `main`: 2026-11-03.

## The app itself

- Packaged as **T3 Code (Custom)**, with its own bundle ID (`com.t3tools.t3code.custom`), Electron profile and data folder (`~/.t3/custom`). It never shares state with the official app, so both can be installed side by side.
- `scripts/rebuild-custom.sh` builds, signs and installs the app into `~/Applications`, keeps the last 3 builds as backups, and records the built commit. It runs pnpm 12 through npx, because corepack can't start it.
- T3 Code (Custom) work now has its own **T3 Custom** project, so new chats about the fork start there instead of in No project.

## Sidebar

- Projects drawn as bubbles, with collapse/expand all, pinned chats on top and settled chats dimmed.
- Sub-projects, either folder-nested or named. You can reorder them, create one from a project row, start a new chat from a sub-project header, and drag chats between sub-projects. Long chat lists are cut short, with a "Show all" button.
- Subagent chats are folded under their main chat, with an "N subagents" toggle.
- Settle and Un-settle in the chat hover actions and the right-click menu.
- Move to project in a chat's right-click menu sends it to another project, for example from No project to T3 Custom. The chat keeps working in the folder it already uses, so its history still resumes. Turn it off in Settings, General.
- Agents can move a chat to another project too, with the `move_to_project` action of `t3_thread_organize`. Turn it off with "Agents can move threads" in Settings, General.
- Collapsed mode leaves a narrow icon rail (new chat, search, settings, pull requests, usage). Hovering it floats the full sidebar over the content. The rail starts below the top bar, and the floating sidebar covers the message minimap.
- The collapsed rail lists exactly what the tab strip shows, in the same order: chats, files tabs and unsent drafts, as project icons with the same status dot, and a small gap between project groups. Click one to open it. The rail no longer lists projects; those are in the sidebar when you hover.

## Chat tabs

- VS Code-style tabs above the chat: preview and permanent tabs, project icons, Cmd+W / Cmd+T / Cmd+Shift+T.
- Drag tabs sideways to reorder them.
- Ctrl+Tab and Ctrl+Shift+Tab go through tabs by recent use. You can rebind them under "Chat Tabs" keybindings.
- A green dot on a tab means it has a finished reply you haven't seen yet.
- An unsent new chat gets a temporary italic "New chat" tab.
- A "+" button after the last tab opens a new tab.
- Archiving or deleting a chat closes its tab.
- An open tab means an unsettled chat. Closing a tab settles the chat (Cmd+Shift+T reopens it and un-settles it). At the end of each day, open tabs are settled and cleared, like Arc. Pinned and running chats keep their tab.
- When tabs overflow, a normal wheel or swipe scrolls them sideways. Scrolled tabs stop before the sidebar toggle.
- The tab strip sits a bit lower, leaving a strip above it to drag the window.
- Tabs are grouped by project: chats without a project first, then the projects. A line under each group has the project's color. It thickens on hover, and dragging it slides the group sideways to reorder the groups. Tabs reorder only inside their group: the dragged tab follows the pointer and the others slide aside to show where it will land.

## Files tabs

- Under the new-chat composer, "or open the project files" turns the tab into a files tab. You browse the project in the right panel, and the picked file opens whole and editable in the main area, one file per tab.
- A files tab can use a worktree or a branch, like a chat. Its tab shows the project icon, a folder icon and the file type's icon.
- The Files panel can search inside files, with match case, whole word and regex options.
- Auto-save is an option (on by default). With it off, Cmd+S saves, an unsaved dot shows on the tab, and closing asks before throwing edits away.

## Google Cloud

- The expanded sidebar shows the Google Cloud login as a cloud icon next to Usage, like the collapsed sidebar. The account is in its tooltip, and a dot shows when something needs you. "Show login as a sidebar icon" brings the line of text back.
- Deploy banners above the composer only show for deploys you follow. Press "Follow in this chat" on a deploy in the Cloud panel. A setting ("Show deploys only when followed") turns this off to show every deploy of the project again.
- Finished deploys no longer pop up as toasts or desktop notifications. The deploy banners above the composer and the Cloud panel still show them.
- Deploy banners can be closed while the deploy is running. A closed deploy stays hidden when it finishes, unless it fails.

## Jira

- New tickets get a status when you create them from a chat, In Progress by default, or To Do.
- When a pull request merges, the Jira update card also suggests a status, Done unless the model picks another. You can change it from the status badge on the card, or untick it.
- "Suggest tickets for new chats" can be set per project, so a project with no Jira work can use Never.
- The "Likely ticket" card has a "Create new…" button, for when the suggested ticket isn't the right one.
- A linked chat now drafts a Jira update only when its pull request merges, not when it opens. "Draft Jira updates when a pull request opens" under Threads > Jira turns the old behavior back on.
- Settling a chat whose ticket is To Do or In Progress offers to move it to Done: the usual Jira update card (Status → Done) on that chat, plus a toast with "Open chat". Nothing is sent until you apply it. "Suggest Done when settling a chat" under Threads > Jira turns it off.
- The end-of-day tab clean-up now leaves open the tab of any chat whose Jira ticket is not Done. "Keep tabs of chats with open tickets" under Threads > Jira turns it off.

## Messages

- Steps the agent took before writing a message fold into one line ("Ran 3 commands"). Steps after its last message stay one per line while it works.
- Edit a user message in place. If the AI edited files in a later turn, you're asked whether to keep or revert them. Files only changed by background processes (dev servers, build output) don't trigger the question.
- Re-send button on user messages.
- "Mark as unread" button under the latest reply, once the turn is done.
- The model shows next to an assistant message's time. Hovering the time shows the model and provider ("model not recorded" for imported chats).
- A queued message's reply now stays below the messages sent while it waited.
- A "Settle" button sits next to the "Mark as unread" button under the latest reply.

## Side chats and commands

- Side chats now come from the official app (`/side`, also `/btw`). The fork keeps the `/status` command below.
- `/status` shows the provider version, login, model, effort, permissions, folder and session ID.

## Cost and prompt cache

- A stats popover in the chat header shows messages, tokens by type, an estimated cost, and whether the prompt cache is still warm.
- Claude chats show a prompt cache countdown in the context meter, and a warning when the cache is about to expire.
- A warning that switching models re-caches the chat, with roughly how many tokens that costs.

## Smaller changes

- The thread details panel starts closed.
- Chats without a project no longer show the "link a Jira ticket" suggestion, including older chats in `~/.t3/scratch`. "Suggest tickets in No project chats" under Threads > Jira turns it back on. Updates for a ticket you linked by hand still show there.
- New setting, "Sound only when a thread finishes" (Settings → General → Notifications). With it on, the alert sound plays only for a finished thread, not for input, approval, failure or pull request alerts. Off by default.
