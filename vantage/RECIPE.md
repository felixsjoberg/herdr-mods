# Vantage

A card-based dark layout for Herdr App with the **Aura Soft Dark** theme, a rounded top bar with labeled panel buttons (`Files`, `Changes`, optional `Browser`), repo-grouped **Spaces**, and **Agents** with real task titles and Claude Code-style GitHub PR badges.

## What you see

- **Left sidebar (`284px`, resizable `44px–480px`)**: four rounded cards (`radius: 14`, `1px` border) with `12px` gaps:
  1. Brand header (`workspace-chrome`, `38px`).
  2. **Spaces** (`vantage-spaces`): repositories with 2+ spaces collapse under a single repo header (colored avatar, repo name, git branch/ahead-behind pill, space count, `+` new-tab button, fold chevron), with indented single-line child rows showing each space's task title, split/tab count (`◫ N` / `Nt`), and rolled-up PR badge. Single-space repos render as one compact card row.
  3. **Agents** (`vantage-agents`): Pinned / Priority or Grouped-by-space rows showing a colored space dot, agent icon, full-width task title (manual tab name → Claude Code / Antigravity title → live title → space fallback), split indicator, GitHub PR badge (green `#3fb950` when any PR is open, purple `#a371f7` when all are merged, red `#f85149` CI dot when failing), elapsed time (or pin button on hover), and live status mark.
  4. Footer (`workspace-chrome`, `72px`).
- **Right workspace**:
  - **Top bar** (`vantage-tabs`, `38px` rounded card): pill tabs on the left with program icon + real task title + status mark + close `×`; `+`, `Files`, `Changes` (and `Browser` if a `browser` block is present) on the right.
  - **Main terminal panes** (`pane` header, `radius: 14`, `#a277ff` focus border) beside the collapsible right side panel (`files`, `changes`, optional `browser`).
  - **Bottom status bar** (`workspace-status`, `32px` rounded card).

## How it behaves

- Clicking a PR badge on any agent row opens a popup listing all PRs for that agent sorted `OPEN` → `MERGED` → `CLOSED` with repo, number, title, state, and CI dot. Clicking any PR opens its URL in the default browser via `open`.
- Clicking `+` on a repo group header in **Spaces** selects the active/first space in that repo and runs `tab.new`, avoiding duplicate repo spaces.
- `vantage-agents` syncs titles and PR status off the UI thread on startup, every 45 seconds while focused, 2.5 seconds after any agent finishes a turn, and when clicking the refresh icon. Results are cached in `localStorage` and shared to `vantage-spaces` and `vantage-tabs` via `shared("vantage.agentsMeta")`.

## Built from

- Theme: `themes/aura-soft-dark.json`
- Layout: `layouts/vantage.json`, `layouts/vantage.svg`
- Mods:
  - `mods/vantage-agents/` (`main.js`, `mod.json`, `sync-agents-meta.py`, `icons/*.svg`)
  - `mods/vantage-spaces/` (`main.js`, `mod.json`)
  - `mods/vantage-tabs/` (`main.js`, `mod.json`)
- Shipped Herdr mods used: `workspace-chrome`, `pane`, `workspace-status`, `files`, `changes`, `menu`, `new-menu`.
- Optional integration: if you have the community `browser` mod installed, add `{ "id": "browser", "type": "block", "content": { "mod": "browser" } }` to `panel-body` and merge `keys.json` (`cmd-shift-b` → `vantage-tabs.browser`); `vantage-tabs` automatically shows the `Browser` button.
- External programs run:
  - `python3` (`mods/vantage-agents/sync-agents-meta.py`)
  - `hc` (`ls --json`, `get <addr> --json`, `read --lines 600 <addr>`, `machine ls --json`)
  - `lsof` (maps running Antigravity PIDs to `~/.gemini/antigravity-cli/presence/*.lock`)
  - Read-only SQLite access to `~/.gemini/antigravity-cli/conversation_summaries.db` and read-only scans of `~/.claude/projects/*/*.jsonl` and `~/.gemini/antigravity-cli/brain/*/transcript.jsonl`
  - Read-only `git` (`status --porcelain=v2 --branch`, `rev-parse`, `remote get-url`)
  - `gh` (`api graphql`, `pr list`)
  - `open` (only when clicking a PR in the PR popover)

## Done when

1. `herdr-app check` passes on `vantage-agents`, `vantage-spaces`, and `vantage-tabs`.
2. `herdr-app do layout.switch '{"name":"vantage"}'` switches with `"errors": []`.
3. `Agents` displays real titles and color-coded PR badges; clicking a badge opens the PR popover.
4. `Spaces` groups duplicate repo spaces under one header and shows task subtitles and split counts.
5. `vantage-tabs` renders rounded tab pills with real titles and labeled `Files` / `Changes` buttons.
