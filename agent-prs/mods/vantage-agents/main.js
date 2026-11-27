// Vantage Agents: clean Agents sidebar card with real task titles (Claude Code & Antigravity),
// split-pane indicators, and Claude Code-style GitHub PR status badges (green=open, purple=merged)
// with a clickable PR detail popover.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  terminals,
  panes,
  focused,
  spaces,
  run,
  exec,
  theme,
  shared,
  setShared,
  setAgentOrder,
  openOverlay,
  closeOverlay,
  props,
  window,
  layout,
  appHome,
  checking,
} from "herdr";

const PR_OPEN_COLOR = "#3fb950";
const PR_DRAFT_COLOR = "#8b949e";
const PR_MERGED_COLOR = "#a371f7";
const PR_CLOSED_COLOR = "#f85149";
const CI_FAIL_COLOR = "#f85149";
const CI_PENDING_COLOR = "#d29922";

const MARK = {
  ansi6: "#22a99a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi2: "#3fae6a",
  ansi1: "#d9649a",
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 100;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 284) : window()?.platform === "macos" ? 78 : 44,
  });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function isGenericTitle(text, prog) {
  if (!text) return true;
  const low = text.toLowerCase();
  if (low === "agy" || low === "claude" || low === "claude code" || low === "codex" || low === "zsh" || low === "bash") return true;
  if (prog?.name && low === prog.name.toLowerCase()) return true;
  if (prog?.key && low === prog.key.toLowerCase()) return true;
  if (/^[~/]|^[A-Za-z]:\\/.test(text) || text.includes("@")) return true;
  return false;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

export function summarizePrs(prs) {
  if (!Array.isArray(prs) || prs.length === 0) return null;
  let open = 0;
  let draft = 0;
  let merged = 0;
  let closed = 0;
  let ciFailed = false;
  let ciPending = false;
  for (const p of prs) {
    if (p.state === "OPEN") {
      open++;
      if (p.isDraft) draft++;
      if (p.ci === "FAILURE" || p.ci === "ERROR") ciFailed = true;
      else if (p.ci === "PENDING" || p.ci === "EXPECTED") ciPending = true;
    } else if (p.state === "MERGED") {
      merged++;
    } else {
      closed++;
    }
  }
  const kind = open > 0 ? "open" : merged > 0 ? "merged" : "closed";
  const color =
    kind === "open"
      ? draft === open
        ? PR_DRAFT_COLOR
        : PR_OPEN_COLOR
      : kind === "merged"
        ? PR_MERGED_COLOR
        : PR_CLOSED_COLOR;
  const iconPath =
    kind === "open"
      ? "mods/vantage-agents/icons/pr-open.svg"
      : kind === "merged"
        ? "mods/vantage-agents/icons/pr-merged.svg"
        : "mods/vantage-agents/icons/pr-closed.svg";
  const parts = [];
  if (open > 0) parts.push(`${open} open`);
  if (merged > 0) parts.push(`${merged} merged`);
  if (closed > 0) parts.push(`${closed} closed`);
  if (ciFailed) parts.push("CI failing");
  else if (ciPending) parts.push("CI running");
  return {
    total: prs.length,
    open,
    merged,
    closed,
    kind,
    color,
    iconPath,
    ciFailed,
    ciPending,
    tooltip: `${parts.join(" · ")} — click to view PRs`,
  };
}

export default class VantageAgents extends View {
  init(_props, cx) {
    if (props()?.sortMenu || props()?.prMenu) return;
    this.folded = new Set();
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    this.meta = JSON.parse(localStorage.getItem("vantage.agentsMeta") ?? '{"agents":{},"updatedAt":0}');
    this.syncing = false;
    this.prevWorking = new Set();

    if (checking()) return;

    if (this.meta?.agents && Object.keys(this.meta.agents).length) {
      setShared("vantage.agentsMeta", this.meta);
    }
    this.refreshMeta(cx);
    cx.timer.every(30000, (cx) => cx.notify());
    cx.timer.every(45000, (cx) => {
      if (window()?.active) this.refreshMeta(cx);
    });
  }

  refreshMeta(cx) {
    if (this.syncing || checking()) return;
    this.syncing = true;
    cx.notify();
    const script = `${appHome()}/mods/vantage-agents/sync-agents-meta.py`;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("python3", [script], { timeout: 25000 });
        if (res.code === 0 && res.stdout?.trim()) {
          const parsed = JSON.parse(res.stdout);
          if (parsed && typeof parsed.agents === "object") {
            this.meta = parsed;
            localStorage.setItem("vantage.agentsMeta", JSON.stringify(parsed));
            setShared("vantage.agentsMeta", parsed);
          }
        }
      } catch {
        // Keep last cached PR metadata on transient failure
      } finally {
        this.syncing = false;
        cx.notify();
      }
    });
  }

  track(list, now, cx) {
    let dirty = false;
    let finishedTurn = false;
    const nowWorking = new Set();
    for (const a of list) {
      if (a.status === "working") nowWorking.add(a.address);
      if (this.prevWorking.has(a.address) && a.status !== "working") finishedTurn = true;
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    this.prevWorking = nowWorking;
    if (finishedTurn && !checking()) {
      cx.timer.after(2500, (cx) => this.refreshMeta(cx));
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) {
      if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    }
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    if (!same || cur.status !== "idle") {
      this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
    }
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(
        SORTS.map((s) =>
          h_flex()
            .id(`sort-${s.id}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(t.foreground)
            .hover((el) => el.bg(t.hover))
            .on_click(() => {
              setShared("agents.sort", s.id);
              closeOverlay(props().overlay);
            })
            .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(s.label))
            .when(s.id === on, (el) =>
              el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)),
            ),
        ),
      );
  }

  prMenu(t) {
    const info = props().prMenu ?? {};
    const prs = Array.isArray(info.prs) ? info.prs : [];
    const summary = summarizePrs(prs);
    return v_flex()
      .size_full()
      .p(8)
      .gap(6)
      .bg(t.popover)
      .text_size(12.5)
      .child(
        h_flex()
          .px(6)
          .py(4)
          .gap(8)
          .items_center()
          .justify_between()
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().font_semibold().truncate().text_color(t.foreground).child(info.title || "Pull Requests"))
              .when(Boolean(summary), (el) =>
                el.child(
                  div()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(`${summary.total} PR${summary.total === 1 ? "" : "s"} · ${summary.open} open · ${summary.merged} merged`),
                ),
              ),
          ),
      )
      .child(
        v_flex()
          .id("pr-popup-list")
          .flex_1()
          .min_h(0)
          .gap(2)
          .overflow_y_scrollbar()
          .mode("always")
          .children(
            prs.map((pr, idx) => {
              const color =
                pr.state === "OPEN"
                  ? pr.isDraft
                    ? PR_DRAFT_COLOR
                    : PR_OPEN_COLOR
                  : pr.state === "MERGED"
                    ? PR_MERGED_COLOR
                    : PR_CLOSED_COLOR;
              const iconPath =
                pr.state === "OPEN"
                  ? "mods/vantage-agents/icons/pr-open.svg"
                  : pr.state === "MERGED"
                    ? "mods/vantage-agents/icons/pr-merged.svg"
                    : "mods/vantage-agents/icons/pr-closed.svg";
              const ciColor =
                pr.ci === "FAILURE" || pr.ci === "ERROR"
                  ? CI_FAIL_COLOR
                  : pr.ci === "PENDING" || pr.ci === "EXPECTED"
                    ? CI_PENDING_COLOR
                    : pr.ci === "SUCCESS"
                      ? PR_OPEN_COLOR
                      : null;
              const stateLabel =
                pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed";
              return h_flex()
                .id(`pr-item-${idx}-${pr.number}`)
                .px(8)
                .py(6)
                .gap(8)
                .rounded(7)
                .items_center()
                .cursor_pointer()
                .hover((el) => el.bg(t.hover))
                .on_click(() => {
                  if (pr.url) exec("open", [pr.url]);
                  closeOverlay(props().overlay);
                })
                .child(svg(iconPath).size(14).flex_none().text_color(color))
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(1)
                    .child(div().truncate().text_color(t.foreground).child(pr.title || `PR #${pr.number}`))
                    .child(
                      h_flex()
                        .gap(6)
                        .items_center()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(div().truncate().child(`${pr.shortRepo} #${pr.number}`))
                        .child(div().flex_none().text_color(color).child(stateLabel))
                        .when(Boolean(ciColor) && pr.state === "OPEN", (el) =>
                          el.child(div().size(6).rounded(3).flex_none().bg(ciColor)),
                        ),
                    ),
                );
            }),
          ),
      );
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(
        s.lines.map((l) =>
          div()
            .self_start()
            .mt(-4)
            .w(9)
            .h(17)
            .mr(4)
            .flex_none()
            .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
            .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6)),
        ),
      )
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(
        div()
          .flex_1()
          .truncate()
          .text_color(on ? t.foreground : t.muted)
          .child(k.name || k.template || k.program?.name || k.address),
      )
      .child(this.status(t, { status: st }, compact));
  }

  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") {
      return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    }
    if (a.status === "blocked" && compact) {
      return div()
        .size(14)
        .flex_none()
        .rounded(4)
        .bg(t.blocked + "26")
        .text_size(10.5)
        .font_bold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    }
    if (a.status === "blocked") {
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg(t.blocked + "26")
        .text_size(10.5)
        .font_semibold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .child("Needs you");
    }
    if (a.status === "idle") {
      return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    }
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  prBadge(t, a, displayTitle, prs) {
    const summary = summarizePrs(prs);
    if (!summary) return null;
    return h_flex()
      .id(`pr-badge-${a.address}`)
      .flex_none()
      .h(20)
      .px(5)
      .gap(3)
      .rounded(5)
      .items_center()
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(summary.tooltip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const height = Math.min(360, Math.max(120, 64 + prs.length * 44));
        openOverlay({
          mod: "vantage-agents",
          kind: "popup",
          width: 370,
          height,
          props: { prMenu: { address: a.address, title: displayTitle, prs } },
        });
      })
      .child(svg(summary.iconPath).size(12).flex_none().text_color(summary.color))
      .child(div().text_size(11).font_medium().text_color(summary.color).child(String(summary.total)))
      .when(summary.ciFailed, (el) => el.child(div().size(5).rounded(3).flex_none().bg(CI_FAIL_COLOR)));
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.prMenu) return this.prMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now, cx);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(
      list.map((a) => [
        a.address,
        Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0)),
      ]),
    );
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const ps = panes();
    const paneCountsByTab = new Map();
    for (const p of ps) {
      if (!p.tab) continue;
      paneCountsByTab.set(p.tab, (paneCountsByTab.get(p.tab) ?? 0) + 1);
    }
    const allTabs = new Map(spaces().flatMap((s) => (s.tabs ?? []).map((tb) => [tb.id, tb])));
    const spaceColors = shared("space.colors") ?? {};
    const metaAgents = this.meta?.agents ?? {};

    const resolveTitle = (a) => {
      const tb = allTabs.get(a.tab);
      if (tb?.named && tb.name && !/^\d+$/.test(tb.name)) return tb.name;
      const metaTitle = metaAgents[a.address]?.title;
      if (metaTitle && !isGenericTitle(metaTitle, a.program)) return metaTitle;
      const live = clean(a.title);
      if (!isGenericTitle(live, a.program)) return live;
      return a.space_name || a.program?.name || a.address;
    };

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : t[top] ?? t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 15, t.foreground);
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      const prs = metaAgents[a.address]?.prs ?? [];
      const displayTitle = resolveTitle(a);
      const splitCount = paneCountsByTab.get(a.tab) ?? 1;

      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .w(34)
          .px(4)
          .rounded(6)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }

      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const spaceColorKey = spaceColors[a.space] ?? "ansi6";
      const spaceDotFill = spaceColorKey.startsWith("#") ? spaceColorKey : MARK[spaceColorKey] ?? t[spaceColorKey] ?? t.dim;
      const showSpaceDot = byPriority || isPinned;

      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));

      const prEl = this.prBadge(t, a, displayTitle, prs);
      const rowTooltip = `${a.space_name || ""}${displayTitle && displayTitle !== a.space_name ? ` · ${displayTitle}` : ""}${splitCount > 1 ? ` · ${splitCount} split panes` : ""}`;

      return h_flex()
        .id(`ag-${a.address}`)
        .px(7)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(6)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(rowTooltip)
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(showSpaceDot, (el) => el.child(div().size(5).rounded(3).flex_none().bg(spaceDotFill)))
        .when(Boolean(pic), (el) =>
          el.child(
            div()
              .id(`agent-fold-${a.address}`)
              .when(subs.length > 0, (el) =>
                el.on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
                  cx.notify();
                }),
              )
              .child(pic),
          ),
        )
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_color(idle ? t.muted : t.foreground)
            .child(displayTitle),
        )
        .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(splitCount > 1 && this.hovered !== a.address, (el) =>
          el.child(
            h_flex()
              .flex_none()
              .gap(2)
              .items_center()
              .text_size(10)
              .text_color(t.dim)
              .child(svg("mods/vantage-agents/icons/split.svg").size(10).flex_none().text_color(t.dim))
              .child(String(splitCount)),
          ),
        )
        .when(Boolean(prEl), (el) => el.child(prEl))
        .when(subs.length > 0, (el) => el.child(fold(a, subs)))
        .when(this.hovered === a.address, (el) => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), (el) =>
          el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(duration(now - when))),
        )
        .child(this.status(t, a, byPriority && !isPinned));
    };

    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else {
        groups.push({
          id,
          label: byPriority ? SECTION[r] : a.space_name || "",
          status: byPriority ? SECTION_STATUS[r] : null,
          members: [a],
        });
      }
    }

    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(28)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().min_w(0).truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) =>
          el
            .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
            .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)),
        );
    };

    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .rounded(13)
      .overflow_hidden()
      .bg(t.chrome)
      .text_size(12.5)
      .when(collapsed, (el) => el.pt(10))
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(14)
            .h(38)
            .pt(10)
            .pb(4)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(
                  div()
                    .id("ag-refresh-prs")
                    .p(3)
                    .rounded(5)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("Refresh PR status & titles")
                    .on_click((_e, cx) => this.refreshMeta(cx))
                    .child(
                      this.syncing
                        ? svg("mods/vantage-agents/icons/refresh.svg").size(13).flex_none().text_color(t.accent).spin(900)
                        : svg("mods/vantage-agents/icons/refresh.svg").size(13).flex_none(),
                    ),
                )
                .child(
                  div()
                    .id("ag-sort")
                    .p(3)
                    .rounded(5)
                    .text_color(t.dim)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() =>
                      openOverlay({ mod: "vantage-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }),
                    )
                    .tooltip(`Sort agents: ${sort.label}`)
                    .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(13).flex_none()),
                ),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(
          div()
            .px(12)
            .text_size(12)
            .text_color(t.dim)
            .child("No agent status yet. Agents show up here when they report their status."),
        ),
      )
      .child(
        v_flex()
          .id("ag-list")
          .flex_1()
          .min_h(0)
          .px(collapsed ? 0 : 6)
          .when(collapsed, (el) => el.items_center())
          .overflow_y_scrollbar()
          .mode("always")
          .children(rows),
      )
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size((find(layout(), "sidebar")?.size?.px ?? 0) >= 70 ? 20 : 13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
