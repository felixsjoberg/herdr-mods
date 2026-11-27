// Vantage Spaces: repo-grouped Spaces sidebar.
// Spaces sharing a repository/name collapse cleanly under ONE repo header (showing avatar,
// repo name, once-only git branch/ahead-behind pill, count, and a "+" new-tab button),
// with each space listed underneath by its real task title, split/tab indicator, and PR badge.
// Repos with only 1 space render as a compact single card row without a redundant header.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  machines,
  panes,
  agents,
  run,
  openOverlay,
  exec,
  hc,
  theme,
  shared,
  setShared,
  watchFolder,
  window,
  layout,
  home,
  props,
  checking,
} from "herdr";

const PR_OPEN_COLOR = "#3fb950";
const PR_MERGED_COLOR = "#a371f7";
const CI_FAIL_COLOR = "#f85149";

function newSpaceArgs(m) {
  return m ? { machine: m } : { machine: "", folder: home() };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 100;

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const FALLBACK = 60000;
const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function isGenericTitle(text) {
  if (!text) return true;
  const low = text.toLowerCase();
  if (low === "agy" || low === "claude" || low === "claude code" || low === "codex" || low === "zsh" || low === "bash") return true;
  if (/^[~/]|^[A-Za-z]:\\/.test(text) || text.includes("@")) return true;
  return false;
}

function rollupSpacePrs(spaceAgents, metaAgents) {
  const seen = new Map();
  for (const a of spaceAgents) {
    const prs = metaAgents[a.address]?.prs ?? [];
    for (const p of prs) {
      const key = `${p.repo}#${p.number}`;
      if (!seen.has(key)) seen.set(key, p);
    }
  }
  if (seen.size === 0) return null;
  let open = 0;
  let merged = 0;
  let ciFailed = false;
  for (const p of seen.values()) {
    if (p.state === "OPEN") {
      open++;
      if (p.ci === "FAILURE" || p.ci === "ERROR") ciFailed = true;
    } else if (p.state === "MERGED") {
      merged++;
    }
  }
  if (open === 0 && merged === 0) return null;
  return {
    total: seen.size,
    open,
    merged,
    ciFailed,
    color: open > 0 ? PR_OPEN_COLOR : PR_MERGED_COLOR,
    iconPath: open > 0 ? "mods/vantage-spaces/icons/pr-open.svg" : "mods/vantage-spaces/icons/pr-merged.svg",
  };
}

function spaceSubtitle(w, spaceAgents, metaAgents) {
  const namedTab = (w.tabs ?? []).find((tb) => tb.named && tb.name && !/^\d+$/.test(tb.name));
  if (namedTab) return namedTab.name;
  for (const a of spaceAgents) {
    const mt = metaAgents[a.address]?.title;
    if (mt && !isGenericTitle(mt)) return mt;
    const live = clean(a.title);
    if (!isGenericTitle(live)) return live;
  }
  return null;
}

export default class VantageSpaces extends View {
  init(_props, cx) {
    this.git = {};
    this.checked = {};
    this.unsure = new Set();
    this.pending = new Set();
    this.busy = {};
    this.ready = {};
    this.at = {};
    this.watching = new Set();
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.hovered = null;
    this.hoveredGroup = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedRepos = new Set(JSON.parse(localStorage.getItem("vantage.foldedRepos") ?? "[]"));

    if (checking()) return;

    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(
        Object.values(this.git)
          .filter(Boolean)
          .map((g) => JSON.parse(g.repo))
          .filter(([on]) => !on)
          .map(([, repo]) => repo),
      );
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], {
        cwd,
        on,
      });
      if (r.code !== 0) {
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = {
        name,
        branch: null,
        ahead: 0,
        behind: 0,
        repo: JSON.stringify([on, repo]),
        linked: repo !== `${top.stdout.trim()}/.git`,
      };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) {
            this.refreshGit(
              Object.keys(this.git).filter((k) => this.git[k]?.repo === mine),
              cx,
            );
          }
        }
      } catch {
        this.watching.delete(repo);
      }
    });
  }

  menu(w) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  gitPill(g, name, t) {
    if (!g || props()?.branch_pill === false) return null;
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === (name ?? "").toLowerCase();
    const whereBranch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    if (!whereBranch && !(g.ahead > 0) && !(g.behind > 0)) return null;
    return h_flex()
      .flex_none()
      .h(15)
      .px(5)
      .gap(3)
      .items_center()
      .rounded_full()
      .text_size(9.5)
      .bg(t.ansi3)
      .text_color(t.background)
      .when(Boolean(whereBranch), (el) => el.child(div().max_w(72).truncate().child(whereBranch)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().child(`↑${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().child(`↓${g.behind}`)));
  }

  groupByRepo(items) {
    const groups = [];
    const byKey = new Map();
    for (const item of items) {
      const repoKey = `${item.w.machine ?? "local"}::${item.w.name || item.g?.name || item.w.id}`;
      let group = byKey.get(repoKey);
      if (!group) {
        group = {
          key: repoKey,
          name: item.w.name || item.g?.name || "Workspace",
          lead: item,
          items: [],
        };
        byKey.set(repoKey, group);
        groups.push(group);
      }
      group.items.push(item);
    }
    return groups;
  }

  prPill(prSummary) {
    if (!prSummary) return null;
    return h_flex()
      .flex_none()
      .gap(2)
      .items_center()
      .text_size(10.5)
      .text_color(prSummary.color)
      .child(svg(prSummary.iconPath).size(11).flex_none().text_color(prSummary.color))
      .child(String(prSummary.total))
      .when(prSummary.ciFailed, (el) => el.child(div().size(5).rounded(3).flex_none().bg(CI_FAIL_COLOR)));
  }

  singleRow(item, t, ps, ags, metaAgents) {
    const { w, g } = item;
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : MARK[color] ?? t[color];

    const tabIds = new Set((w.tabs ?? []).map((tb) => tb.id));
    const paneCount = ps.filter((p) => tabIds.has(p.tab)).length;
    const tabCount = (w.tabs ?? []).length;
    const hasSplits = paneCount > tabCount;
    const spaceAgents = ags.filter((a) => a.space === w.id);
    let subtitle = spaceSubtitle(w, spaceAgents, metaAgents);
    if (subtitle && subtitle.toLowerCase() === (w.name ?? "").toLowerCase()) subtitle = null;

    const pill = this.gitPill(g, w.name, t);
    const prSummary = rollupSpacePrs(spaceAgents, metaAgents);
    const hasSecondLine = Boolean(subtitle || pill);
    const isHovered = this.hovered === w.id;

    return v_flex()
      .id(`space-${w.id}`)
      .px(8)
      .h(hasSecondLine ? 46 : 32)
      .flex_none()
      .my(1.5)
      .justify_center()
      .rounded(8)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((over, cx) => {
        if (over) this.hovered = w.id;
        else if (this.hovered === w.id) this.hovered = null;
        cx.notify();
      })
      .on_click(() => run("space.select", { id: w.id }))
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .child(
            h_flex()
              .size(18)
              .flex_none()
              .rounded(5)
              .bg(fill)
              .items_center()
              .justify_center()
              .text_size(10.5)
              .font_bold()
              .text_color("#ffffff")
              .child([...w.name][0]?.toUpperCase() ?? "?"),
          )
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(w.name))
          .when(hasSplits && !isHovered, (el) =>
            el.child(
              h_flex()
                .flex_none()
                .gap(2)
                .items_center()
                .text_size(10)
                .text_color(t.dim)
                .child(svg("mods/vantage-spaces/icons/split.svg").size(10).flex_none().text_color(t.dim))
                .child(String(paneCount)),
            ),
          )
          .when(!hasSplits && tabCount > 1 && !isHovered, (el) =>
            el.child(div().flex_none().text_size(10).text_color(t.dim).child(`${tabCount}t`)),
          )
          .when(Boolean(prSummary) && !isHovered, (el) => el.child(this.prPill(prSummary)))
          .when(isHovered, (el) =>
            el.child(
              div()
                .id(`space-newtab-${w.id}`)
                .size(18)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(4)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((s) => s.bg(t.raised).text_color(t.foreground))
                .tooltip(`New tab in ${w.name}`)
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  run("space.select", { id: w.id });
                  run("tab.new", {});
                })
                .child(svg("mods/workspace-chrome/plus.svg").size(11)),
            ),
          ),
      )
      .when(hasSecondLine, (el) =>
        el.child(
          h_flex()
            .min_w(0)
            .mt(2)
            .gap(6)
            .items_center()
            .pl(25)
            .when(Boolean(subtitle), (el) =>
              el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(subtitle)),
            )
            .when(Boolean(pill), (el) => el.child(pill)),
        ),
      );
  }

  repoGroup(group, t, ps, ags, metaAgents) {
    const lead = group.lead;
    const colors = shared("space.colors") ?? {};
    const color = colors[lead.w.id] ?? "ansi4";
    const fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
    const folded = this.foldedRepos.has(group.key);
    const activeInGroup = group.items.find((it) => it.w.active) ?? lead;
    const pill = this.gitPill(activeInGroup.g ?? lead.g, group.name, t);

    // Rolled-up PR summary when folded
    const allGroupAgents = ags.filter((a) => group.items.some((it) => it.w.id === a.space));
    const groupPrSummary = folded ? rollupSpacePrs(allGroupAgents, metaAgents) : null;

    const head = h_flex()
      .id(`repo-group-${group.key}`)
      .px(8)
      .h(28)
      .mt(3)
      .flex_none()
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_hover((over, cx) => {
        if (over) this.hoveredGroup = group.key;
        else if (this.hoveredGroup === group.key) this.hoveredGroup = null;
        cx.notify();
      })
      .on_click((_e, cx) => {
        folded ? this.foldedRepos.delete(group.key) : this.foldedRepos.add(group.key);
        localStorage.setItem("vantage.foldedRepos", JSON.stringify([...this.foldedRepos]));
        cx.notify();
      })
      .child(
        h_flex()
          .size(17)
          .flex_none()
          .rounded(5)
          .bg(fill)
          .items_center()
          .justify_center()
          .text_size(10)
          .font_bold()
          .text_color("#ffffff")
          .child([...group.name][0]?.toUpperCase() ?? "?"),
      )
      .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(group.name))
      .when(Boolean(pill), (el) => el.child(pill))
      .child(div().flex_1())
      .when(Boolean(groupPrSummary), (el) => el.child(this.prPill(groupPrSummary)))
      .when(!folded, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(group.items.length))))
      .child(
        div()
          .id(`repo-newtab-${group.key}`)
          .size(18)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          .tooltip(`New tab in ${group.name}`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            run("space.select", { id: activeInGroup.w.id });
            run("tab.new", {});
          })
          .child(svg("mods/workspace-chrome/plus.svg").size(11)),
      )
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim));

    if (folded) return [head];

    const children = group.items.map((item, idx) => {
      const { w, g } = item;
      const on = w.active;
      const tabIds = new Set((w.tabs ?? []).map((tb) => tb.id));
      const paneCount = ps.filter((p) => tabIds.has(p.tab)).length;
      const tabCount = (w.tabs ?? []).length;
      const hasSplits = paneCount > tabCount;
      const spaceAgents = ags.filter((a) => a.space === w.id);
      const subtitle =
        spaceSubtitle(w, spaceAgents, metaAgents) ||
        (g?.branch && g.branch !== "main" && g.branch !== "master" ? g.branch : null) ||
        (w.folder && base(w.folder) !== group.name ? base(w.folder) : `Session ${idx + 1}`);
      const prSummary = rollupSpacePrs(spaceAgents, metaAgents);

      return h_flex()
        .id(`space-${w.id}`)
        .ml(16)
        .pl(10)
        .pr(7)
        .h(27)
        .flex_none()
        .gap(6)
        .items_center()
        .rounded_r(7)
        .border_l(1.5)
        .border_color(on ? t.accent : t.border)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .tooltip(`${group.name} · ${subtitle}`)
        .on_click(() => run("space.select", { id: w.id }))
        .on_mouse_down("right", () => this.menu(w))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12)
            .text_color(on ? t.foreground : t.muted)
            .child(subtitle),
        )
        .when(hasSplits, (el) =>
          el.child(
            h_flex()
              .flex_none()
              .gap(2)
              .items_center()
              .text_size(10)
              .text_color(t.dim)
              .tooltip(`${paneCount} split panes`)
              .child(svg("mods/vantage-spaces/icons/split.svg").size(10).flex_none().text_color(t.dim))
              .child(String(paneCount)),
          ),
        )
        .when(!hasSplits && tabCount > 1, (el) =>
          el.child(div().flex_none().text_size(10).text_color(t.dim).child(`${tabCount}t`)),
        )
        .when(Boolean(prSummary), (el) => el.child(this.prPill(prSummary)));
    });

    return [head, ...children];
  }

  compact({ w }, t) {
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : MARK[color] ?? t[color];
    const big = (find(layout(), "sidebar")?.size?.px ?? 0) >= 70;
    return h_flex()
      .id(`space-${w.id}`)
      .size(big ? 40 : 28)
      .flex_none()
      .my(2)
      .items_center()
      .justify_center()
      .rounded(big ? 9 : 6)
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .size(big ? 28 : 18)
          .flex_none()
          .rounded(big ? 7 : 5)
          .bg(fill)
          .items_center()
          .justify_center()
          .text_size(big ? 14 : 10.5)
          .font_bold()
          .text_color("#ffffff")
          .child([...w.name][0]?.toUpperCase() ?? "?"),
      );
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ps = panes();
    const ags = agents();
    const metaAgents = shared("vantage.agentsMeta")?.agents ?? {};

    const ids = new Set(sp.map((p) => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);

    const items = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    let contentRows;
    if (collapsed) {
      contentRows = items.map((it) => this.compact(it, t));
    } else {
      const repoGroups = this.groupByRepo(items);
      contentRows = repoGroups.flatMap((group) =>
        group.items.length === 1
          ? [this.singleRow(group.lead, t, ps, ags, metaAgents)]
          : this.repoGroup(group, t, ps, ags, metaAgents),
      );
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .rounded(13)
      .overflow_hidden()
      .bg(t.chrome)
      .text_size(12.5)
      .when(collapsed, (el) => el.pt(10))
      .child(
        h_flex()
          .h(32)
          .when(collapsed, (el) => el.justify_center())
          .when(!collapsed, (el) => el.pl(14).pr(8).justify_between())
          .items_center()
          .text_size(11.5)
          .text_color(t.dim)
          .when(!collapsed, (el) => el.child("Spaces"))
          .child(
            div()
              .id("space-new")
              .size(24)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("New space")
              .on_click(() => run("space.new", newSpaceArgs(null)))
              .child(svg("mods/workspace-chrome/plus.svg").size(13)),
          ),
      )
      .child(
        v_flex()
          .id("spaces-list")
          .flex_1()
          .min_h(0)
          .px(collapsed ? 0 : 6)
          .when(collapsed, (el) => el.items_center())
          .pb(10)
          .overflow_y_scrollbar()
          .mode("always")
          .children(contentRows),
      );
  }
}
