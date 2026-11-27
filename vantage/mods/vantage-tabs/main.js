// Vantage Tabs: rounded glass-card top bar with icon + real task title tab pills on the left
// and labeled panel toggles (+ | Files | Changes | Browser) on the right.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import {
  spaces,
  panes,
  run,
  openOverlay,
  theme,
  window,
  shared,
  layout,
  settings,
  nextCommand,
  checking,
} from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function toggleBrowser() {
  const root = layout();
  const panel = find(root, "panel");
  const body = find(root, "panel-body");
  if (!find(root, "browser")) return;
  if (panel && !panel.hidden && body?.active === "browser") run("layout.hide", { id: "panel" });
  else {
    run("layout.select", { stack: "panel-body", child: "browser" });
    run("layout.show", { id: "panel" });
  }
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function isGenericTitle(text, prog) {
  if (!text) return true;
  const low = text.toLowerCase();
  if (low === "agy" || low === "claude" || low === "claude code" || low === "codex" || low === "zsh" || low === "bash") return true;
  if (prog?.name && low === prog.name.toLowerCase()) return true;
  if (prog?.key && low === prog.key.toLowerCase()) return true;
  if (/^[~/]|^[A-Za-z]:\\/.test(text) || text.includes("@")) return true;
  return false;
}

function resolveTabLabel(tab, lead, metaAgents) {
  const prog = lead?.program?.name;
  if (tab.named && tab.name && !/^\d+$/.test(tab.name)) return tab.name;
  const metaTitle = lead?.terminal ? metaAgents[lead.terminal]?.title : null;
  if (metaTitle && !isGenericTitle(metaTitle, lead?.program)) return metaTitle;
  const live = clean(lead?.title);
  if (!isGenericTitle(live, lead?.program)) return live;
  return prog ?? (tab.named ? tab.name : "Terminal");
}

export default class VantageTabs extends View {
  init(_props, cx) {
    if (!checking()) {
      cx.spawn(async (cx) => {
        for (;;) {
          if ((await nextCommand()) === "browser") toggleBrowser();
          cx.notify();
        }
      });
    }
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try {
      this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    } catch {
      this.panels = {};
    }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
  }

  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe;
    const now = Date.now();
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else {
            run("layout.hide", { id: "panel" });
          }
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex((tab) => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }

    const ps = panes();
    const metaAgents = shared("vantage.agentsMeta")?.agents ?? {};
    const stop = (_e, cx) => cx.stop_propagation();

    const iconButton = (id, label, action) =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(8)
        .cursor_pointer()
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(label);

    const item = (c, i) => {
      const lead = ps.find((p) => p.tab === c.id && p.program?.agent) ?? ps.find((p) => p.tab === c.id);
      const program = lead?.program;
      const name = resolveTabLabel(c, lead, metaAgents);
      return h_flex()
        .id(`tab-${c.id}`)
        .h(26)
        .px(9)
        .gap(7)
        .rounded(8)
        .items_center()
        .flex_none()
        .text_size(12.5)
        .cursor_pointer()
        .when(i <= active, (el) =>
          el.on_size_change((_size, cx) => {
            this.scroll.scroll_to_item(active);
            cx.notify();
          }),
        )
        .border(1)
        .border_color(c.active ? t.border : t.chrome)
        .bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = i;
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i) {
            run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
          } else {
            run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } });
        })
        .when(Boolean(program?.icon), (el) =>
          el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)),
        )
        .child(div().max_w(210).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", (el) =>
          el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)),
        )
        .when(c.status === "blocked" || c.status === "done", (el) => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, (el) =>
          el.child(
            div()
              .id(`close-${c.id}`)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: c.id });
              })
              .child(svg("mods/pane/close.svg").size(12)),
          ),
        );
    };

    const root = layout();
    const sidebar = find(root, "sidebar");
    const w = window();
    const lightsPadding =
      w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
        ? Math.max(8, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
        : 8;

    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const hasBrowser = Boolean(find(root, "browser"));
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), ...(hasBrowser ? ["browser"] : [])];
    this.syncPanel(space, panel, body, enabled);

    const panelButton = (id, label, iconPath) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(26)
        .px(9)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .text_size(12)
        .bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else {
            run("layout.select", { stack: "panel-body", child: id });
            run("layout.show", { id: "panel" });
          }
        })
        .child(svg(iconPath).size(14).flex_none())
        .child(label);
    };

    return h_flex()
      .size_full()
      .min_w(0)
      .rounded(13)
      .overflow_hidden()
      .pr(8)
      .pl(lightsPadding)
      .gap(4)
      .items_center()
      .bg(t.chrome)
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel((e) => this.wheel(e))
      .child(
        h_flex()
          .id("tab-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(4)
          .overflow_x_scrollbar()
          .track_scroll(this.scroll)
          .on_size_change((_size, cx) => {
            if (active >= 0) {
              this.scroll.scroll_to_item(active);
              cx.notify();
            }
          })
          .children(shown.map(item)),
      )
      .child(iconButton("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), (el) => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), (el) => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(hasBrowser, (el) => el.child(panelButton("browser", "Browser", "mods/browser/globe.svg")))
      .when(w?.buttons, (el) =>
        el
          .child(iconButton("minimize", "−", () => run("window.minimize")))
          .child(iconButton("maximize", "□", () => run("window.maximize")))
          .child(iconButton("close-window", svg("mods/pane/close.svg").size(13), () => run("window.close"))),
      );
  }
}
