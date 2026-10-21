# T3 Code (Custom) changelog

This fork is the official [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus the changes below. The `custom` branch merges the official `main` from time to time. Everything listed here is what this version adds or changes compared to it.

Last synced with the official `main`: 2026-10-21.

## The app itself

- Packaged as **T3 Code (Custom)**, with its own bundle ID (`com.t3tools.t3code.custom`), Electron profile and data folder (`~/.t3/custom`). It never shares state with the official app, so both can be installed side by side.
- `scripts/rebuild-custom.sh` builds, signs and installs the app into `~/Applications`, keeps the last 3 builds as backups, and records the built commit. It runs pnpm 12 through npx, because corepack can't start it.

## Sidebar

- Projects drawn as bubbles, with collapse/expand all, pinned chats on top and settled chats dimmed.
- Sub-projects, either folder-nested or named. You can reorder them, create one from a project row, start a new chat from a sub-project header, and drag chats between sub-projects. Long chat lists are cut short, with a "Show all" button.
- Subagent chats are folded under their main chat, with an "N subagents" toggle.
- Settle and Un-settle in the chat hover actions and the right-click menu.
- Collapsed mode leaves a narrow icon rail (new chat, search, settings, pull requests, usage). Hovering it floats the full sidebar over the content. The rail starts below the top bar, and the floating sidebar covers the message minimap.

## Chat tabs

- VS Code-style tabs above the chat: preview and permanent tabs, project icons, Cmd+W / Cmd+T / Cmd+Shift+T.
- Drag tabs sideways to reorder them.
- Ctrl+Tab and Ctrl+Shift+Tab go through tabs by recent use. You can rebind them under "Chat Tabs" keybindings.
- A green dot on a tab means it has a finished reply you haven't seen yet.
- An unsent new chat gets a temporary italic "New chat" tab.
- A "+" button after the last tab opens a new tab.
- Archiving or deleting a chat closes its tab.
- When tabs overflow, a normal wheel or swipe scrolls them sideways. Scrolled tabs stop before the sidebar toggle.
- The tab strip sits a bit lower, leaving a strip above it to drag the window.

## Files tabs

- Under the new-chat composer, "or open the project files" turns the tab into a files tab. You browse the project in the right panel, and the picked file opens whole and editable in the main area, one file per tab.
- A files tab can use a worktree or a branch, like a chat. Its tab shows the project icon, a folder icon and the file type's icon.
- The Files panel can search inside files, with match case, whole word and regex options.
- Auto-save is an option (on by default). With it off, Cmd+S saves, an unsaved dot shows on the tab, and closing asks before throwing edits away.

## Messages

- Edit a user message in place. If the chat changed files since then, you're asked whether to keep or revert them.
- Re-send button on user messages.
- "Mark as unread" button under the latest reply, once the turn is done.
- The model shows next to an assistant message's time. Hovering the time shows the model and provider ("model not recorded" for imported chats).
- A queued message's reply now stays below the messages sent while it waited.

## Side chats and commands

- `/btw <question>` and a "Side chat" button fork the chat into a read-only copy in the right panel (plan mode, with approvals). "Open as chat" turns it into a normal chat.
- `/status` shows the provider version, login, model, effort, permissions, folder and session ID.

## Cost and prompt cache

- A stats popover in the chat header shows messages, tokens by type, an estimated cost, and whether the prompt cache is still warm.
- Claude chats show a prompt cache countdown in the context meter, and a warning when the cache is about to expire.
- A warning that switching models re-caches the chat, with roughly how many tokens that costs.

## Smaller changes

- The thread details panel starts closed.
