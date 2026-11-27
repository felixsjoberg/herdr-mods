# Herdr Mods

Layouts and mods for [Herdr App](https://herdr.dev) built for running many parallel coding agents (**Claude Code**, **Antigravity**, **Codex**) with live GitHub PR visibility and clean repository grouping.

Pick the full **Vantage** layout, or drop individual mods into your own layout — ask your coding agent to add any folder below.

---

### [Vantage](vantage/) *(Layout)*

A dark, card-based workspace layout (**Aura Soft Dark** theme included) combining a glass pill top bar with labeled panel toggles, repo-grouped **Spaces**, and Claude Code-style GitHub **PR status badges** directly on every **Agent** row.

- **Glass pill top bar (`vantage-tabs`):** rounded top bar with icon + real task title tabs, `+`, and labeled `Files` / `Changes` (plus optional `Browser`) buttons.
- **Repo-grouped Spaces (`vantage-spaces`):** multiple spaces in the same repository collapse under one repo header with branch status, split-pane (`◫ N`) / multi-tab counts, rolled-up PR badges, and a `+` button to open a new tab inside that repo.
- **Agents with PR badges (`vantage-agents`):** real task titles (Claude Code session titles + Antigravity local conversation titles), green/purple PR count badges (green = open, purple = all merged, red dot = failing CI), and a clickable PR popover to jump straight to GitHub.
- **Theme included:** ships with `themes/aura-soft-dark.json` (light mode falls back to `paper`).

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/felixsjoberg/herdr-mods/tree/main/vantage
```

---

### [Agent PRs](agent-prs/) *(Mod)*

Standalone **Agents** sidebar mod that replaces generic repo prefixes with real task titles and adds Claude Code-style GitHub PR status badges (`open` in green, `merged` in purple, CI failure indicator) with a clickable PR list popover.

Works with Claude Code (`~/.claude/projects/*/*.jsonl`), Antigravity (`agy` via `presence/*.lock` + `conversation_summaries.db`), and any git feature branch via a single batched `gh api graphql` query.

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/felixsjoberg/herdr-mods/tree/main/agent-prs
```

---

### [Repo Spaces](repo-spaces/) *(Mod)*

Standalone **Spaces** sidebar mod that groups duplicate spaces sharing the same repository under a single collapsible repo header, showing task subtitles, split-pane indicators, rolled-up PR badges (when paired with `vantage-agents`), and a `+` button to add a tab inside that repo.

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/felixsjoberg/herdr-mods/tree/main/repo-spaces
```

---

## Install by hand

To install the full **Vantage** layout (including `themes/aura-soft-dark.json`, all three mods, and automatic detection for optional `browser` / `smart-scroll` mods):

```sh
git clone https://github.com/felixsjoberg/herdr-mods.git
cd herdr-mods
./install.sh
herdr-app do layout.switch '{"name":"vantage"}'
```

Each folder also contains a `RECIPE.md` describing what it shows, what external commands it runs, and how to build or adapt it from scratch.

## Requirements

- Herdr App (`0.1.18+`)
- `python3` and authenticated GitHub CLI (`gh auth status`) for live PR status badges.

## License

MIT, see [`LICENSE`](LICENSE).
