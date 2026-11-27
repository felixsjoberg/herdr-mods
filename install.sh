#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

mkdir -p "$HOME_DIR/layouts" "$HOME_DIR/mods" "$HOME_DIR/themes"

# Copy theme (Aura Soft Dark)
cp "$REPO_DIR/vantage/themes/aura-soft-dark.json" "$HOME_DIR/themes/aura-soft-dark.json"

# Copy layout preview and write layout JSON (auto-enabling browser & smart-scroll when installed)
cp "$REPO_DIR/vantage/layouts/vantage.svg" "$HOME_DIR/layouts/vantage.svg"
python3 - "$REPO_DIR/vantage/layouts/vantage.json" "$HOME_DIR/layouts/vantage.json" "$HOME_DIR/mods" <<'PY'
import json, os, sys

src, dst, mods_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src, "r", encoding="utf-8") as f:
    layout = json.load(f)

def find(node, node_id):
    if isinstance(node, dict):
        if node.get("id") == node_id:
            return node
        for c in node.get("children", []):
            res = find(c, node_id)
            if res is not None:
                return res
    return None

if os.path.isdir(os.path.join(mods_dir, "browser")):
    body = find(layout, "panel-body")
    if body and not any(c.get("id") == "browser" for c in body.get("children", [])):
        body["children"].append({"id": "browser", "type": "block", "content": {"mod": "browser"}})
    layout["link_handlers"] = ["browser"]

if os.path.isdir(os.path.join(mods_dir, "smart-scroll")):
    status_row = find(layout, "status-row")
    if status_row and not any(c.get("id") == "smart-scroll" for c in status_row.get("children", [])):
        status_row["children"].append({"id": "smart-scroll", "type": "block", "content": {"mod": "smart-scroll"}, "size": {"px": 0}})

with open(dst, "w", encoding="utf-8") as f:
    json.dump(layout, f, indent=2)
    f.write("\n")
PY

# Copy all Vantage mods
for mod in vantage-agents vantage-spaces vantage-tabs; do
  rm -rf "$HOME_DIR/mods/$mod"
  cp -R "$REPO_DIR/vantage/mods/$mod" "$HOME_DIR/mods/$mod"
done
chmod +x "$HOME_DIR/mods/vantage-agents/sync-agents-meta.py"

# Merge keys.json in-place (preserving dotfiles symlink)
if [ -f "$HOME_DIR/keys.json" ] && [ -d "$HOME_DIR/mods/browser" ]; then
  python3 - "$HOME_DIR/keys.json" "$REPO_DIR/vantage/keys.json" <<'PY'
import json, os, sys
dst_path = os.path.realpath(sys.argv[1])
src_path = sys.argv[2]
with open(dst_path, "r", encoding="utf-8") as f:
    dst = json.load(f)
with open(src_path, "r", encoding="utf-8") as f:
    src = json.load(f)
for section, bindings in src.items():
    if section not in dst:
        dst[section] = bindings
    else:
        for k, v in bindings.items():
            dst[section].setdefault(k, v)
with open(dst_path, "w", encoding="utf-8") as f:
    json.dump(dst, f, indent=2)
    f.write("\n")
PY
fi

# Run herdr-app check on all three mods
herdr_bin="$(command -v herdr-app || echo "$HOME/.local/bin/herdr-app")"
if [ -x "$herdr_bin" ]; then
  for mod in vantage-agents vantage-spaces vantage-tabs; do
    "$herdr_bin" check "$HOME_DIR/mods/$mod"
  done
fi

echo "Installed Vantage into $HOME_DIR"
