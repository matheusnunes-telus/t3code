# Design language

Follow this for any UI change. It combines upstream's rules (`AGENTS.md` "Taste", `docs/internals/web-ui.md`, lint) with what Matheus chose in this fork. Read the closest existing component before building, and copy its pattern rather than inventing one.

## Upstream rules (lint enforces most)

- **Primitives:** controls come from `apps/web/src/components/ui` (Button, Badge, Menu, Popover, Dialog, Select, Input, Textarea, Tooltip, Toggle, Switch…). Pick a `variant`/`size`; never restyle one with `className`, only add layout classes (width, flex, margin). No raw styled `<button>`/`<input>`/`<select>` posing as a primitive; raw elements are fine for rows, tabs, handles.
  - Button sizes: `micro`, `compact` (panel actions), `default`, `lg`, `icon`. Variants: `default`, `outline`, `ghost`, `ghost-muted`, `destructive`, `destructive-outline`, `ghost-destructive`, `glass`.
  - Badge variants: `secondary`, `info`, `success`, `warning`, `error`, `destructive`, `outline`, `label`.
- **Colors:** theme tokens only (`foreground`, `muted-foreground`, `accent`, `border`, `info`, `success`, `warning`, `destructive`, `sidebar-*`, `message`, `surface-raised`…). No raw palette (`bg-emerald-500`) and no arbitrary values (`shadow-[...]`); add a token in `index.css` if one is missing.
- **Tooltips:** `Tooltip`/`TooltipTrigger`/`TooltipPopup`, never the native `title`.
- **Copy:** no em dashes. Sentence case, short, plain. An action's label, tooltip, menu text and `aria-label` must name the same action on the same object.
- **Focus/selection rings:** `ring-inset` (or negative offset); never paint outside the element.
- **React:** no `useMemo`/`useCallback` (React Compiler). No `try`/`catch` in ChatView handlers (use `result._tag === "Failure"`). Derive in render, act in handlers; a new `useEffect` needs `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`. No `Date.now()` in render (pass `now` down). `observeResize`, not `ResizeObserver`.
- **Composition:** new notices above the composer use the `ComposerBanner` slots / `ComposerBannerStackItem` (`id`, `variant`, `icon`, `title`, `description`, `actions`, `group`). Make repeated looks a variant or slot, not copied classes.
- **Motion:** no continuously repainting animation. A spinner only while work is really running; `motion-safe:` for pulses.

## Visual scale

- Text: `text-sm` titles and body, `text-xs` meta and rows, `text-2xs font-medium tracking-wide uppercase text-muted-foreground` section labels, `text-3xs` tiny tags.
- Icons: lucide. `size-3` in chips, tabs and tiny buttons; `size-3.5` in menus, rows and inline status; `size-4` in banners, toasts and dialogs.
- Chips (header, like Jira/PR): `h-6 rounded-md border border-border bg-background px-1.5 text-xs`, `hover:bg-accent`, `data-popup-open:bg-accent`. An "add" chip is the same with `border-dashed text-muted-foreground` and a `+`.
- Status dots: `size-1.5 rounded-full`. Pulsing `bg-info` = running, success color = unread finished reply.
- Muted helper lines under fields or sections, never extra headings. Relative ages read "synced 5 d ago", "read 3 h ago".

## Layout preferences (Matheus)

- **Chat tabs (top bar, VS Code style):** one tab per chat with the project favicon. A single click opens an italic preview tab; double-click or sending keeps it. Unsent drafts with text get an italic tab, for this session only. "+" New tab after the last tab. Drag to reorder, Ctrl+Tab by recent use, Cmd+Shift+T reopens a closed tab, plain wheel scrolls overflowing tabs. Controls must not slide under the sidebar toggle. Tabs close when a chat is archived or deleted.
- **Left sidebar:** collapses to an icon rail and expands on hover (peek) above everything, including the message minimap. Projects contain sub-projects (draggable chats, "+" to create, "Show all" for long lists), and subagent chats fold under their main chat. Jira grouping is Project | Ticket. Row actions (archive, settle) appear only on the hovered row. The open/closed state persists.
- **Right panel:** tabbed surfaces opened from "+" or the empty state "Open a surface". Each surface has an icon and a one-letter shortcut (B, T, F, D, P, L, M, S, J). An unavailable surface stays in the list, grayed out, with a short hint ("Turn on Jira in Settings."), rather than hidden. Width is kept as a share of the window so it fits both the ultrawide and the MacBook. Detail views (PR, Jira ticket, side chat) open here, not in the chat.
- **Chat body vs composer:** the timeline shows only what happened. Anything pending or not yet sent (context handoff, prompt cache expiry, model-switch cost, Jira suggestions) is a banner above the composer. After it happens it may appear in the chat.
- **Settings:** a row per setting (`SettingsRow` with description and reset), grouped in the existing sections. Pull request options live in "Diffs & pull requests", Jira in "Threads". Add a `settingsSearch` entry pointing at the right page.

## Interaction patterns

- **Pickers:** a Popover with an autofocused search `Input`, a scrollable list of rows (`text-xs`, key in mono, muted type at the end), and a footer action row for "create new…".
- **Forms:** a Dialog with DialogHeader (title plus one-line description), DialogPanel (labelled fields, muted label above each), DialogFooter (`outline` Cancel, then a primary action that says what happens: "Create and link").
- **Choices on a value:** a Menu on the badge itself (the status badge with a chevron); a spinner in the badge while it applies.
- **Panel cards:** a header row (key, status badge, level tag, actions at the right), then a `text-sm font-medium` title, a path or breadcrumb, a `dl` grid (`grid-cols-[5.5rem_1fr] text-xs`, muted labels), uppercase section labels, and a row of `compact` Buttons at the end (primary first, then `outline`, then `ghost` external links).
- **AI help:** the model pre-fills, the user decides. Drafts fill only empty fields, a loader says "Drafting from this chat…", and nothing reaches an outside system (Jira, GitHub) until the user clicks. Show what a failure means and keep the form usable.
- **Less clutter (approved 2026-11-02):** one-line rows; links and meta as hover icons and tooltips; problems first; sync/read times in a refresh icon's tooltip instead of footers; status as a dot on the project icon (same on rail, tabs, sidebar); skeletons instead of "Loading…" text.
- **Persistence:** per-viewer UI preferences (widths, open/closed, tab order) go in localStorage. Session-only conveniences (draft tabs) live in memory.
