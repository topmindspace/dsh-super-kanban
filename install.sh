#!/bin/bash
# Super Kanban — install into a DSH profile (default: the desktop profile).
#
#   ./install.sh            # interactive (shows target, asks confirmation)
#   ./install.sh -y         # non-interactive
#   DSH_HOME=/tmp/x ./install.sh -y        # install into an isolated DSH home
#
# The plugin stays in this repository and is linked into the profile, so future
# edits are picked up on the next profile recomposition (or app restart).
#
# super-kanban-profile-backup.json is written once, only on the first install:
# it is a pre-install snapshot for manual recovery. The uninstaller does NOT
# auto-restore it (a full-file restore would overwrite profile/plugin changes
# made after the install); it removes only this plugin's manifest entries.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
BACKUP="$PROFILE_DIR/super-kanban-profile-backup.json"
YES=0
[ "${1:-}" = "-y" ] || [ "${1:-}" = "--yes" ] && YES=1

echo "Super Kanban installer"
echo "  plugin : $PLUGIN_DIR"
echo "  profile: $PROFILE_DIR"
echo

if [ ! -f "$PLUGIN_DIR/package.json" ] || [ ! -f "$PLUGIN_DIR/client.js" ] || [ ! -f "$PLUGIN_DIR/index.mjs" ]; then
  echo "ERROR: plugin package incomplete at $PLUGIN_DIR" >&2
  exit 1
fi
if [ ! -f "$PKG" ]; then
  echo "ERROR: profile not found: $PKG (is DSH installed and has it been opened once?)" >&2
  exit 1
fi

if [ "$YES" -ne 1 ]; then
  printf "Install the plugin into this profile? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 0 ;; esac
fi

# 1. Link the package where the profile resolves bundle dependencies.
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-super-kanban"

# 2. Record the dependency + select the bundle in the profile manifest.
python3 - "$PKG" "$BACKUP" "$PLUGIN_DIR" <<'PY'
import json, os, sys, time

pkg_path, backup_path, plugin_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with open(pkg_path, encoding="utf-8") as fh:
    data = json.load(fh)

# First install only: keep a pre-install snapshot for manual recovery. It is not
# overwritten on re-install and never auto-restored by uninstall.sh.
if not os.path.exists(backup_path):
    with open(backup_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(f"  backup  : {backup_path} (first-install snapshot; not auto-restored)")

data.setdefault("dependencies", {})["dsh-super-kanban"] = f"link:{plugin_dir}"
profile = data.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if "dsh-super-kanban" not in bundles:
    bundles.append("dsh-super-kanban")

with open(pkg_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")

print("  profile : dependency + bundle selection written")
PY

echo
echo "Installed. In the DSH window press Cmd+R (reload) — the sidebar will show"
echo "\"任务看板\" after the page reloads. If the app does not pick it up, restart DSH."
echo "Data lives in $DSH_HOME/storages/super-kanban/."
