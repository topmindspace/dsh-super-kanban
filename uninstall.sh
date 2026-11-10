#!/bin/bash
# Super Kanban — remove the plugin from a DSH profile (default: desktop).
#
#   ./uninstall.sh          # interactive
#   ./uninstall.sh -y       # non-interactive
#   DSH_HOME=/tmp/x ./uninstall.sh -y
#
# Removal is a targeted edit: only the `dsh-super-kanban` dependency and bundle
# entry are removed from the profile manifest — every other dependency, bundle
# and profile setting is preserved — and the package link is deleted.
#
# super-kanban-profile-backup.json (written by install.sh on the FIRST install
# only) is a pre-install snapshot. It is intentionally NOT restored: a full-file
# restore would silently drop any plugin/config changes made to the profile after
# the install. The file is kept for manual recovery.
#
# The board data under $DSH_HOME/storages/super-kanban/ is kept; delete it
# yourself if you want a clean slate.
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
BACKUP="$PROFILE_DIR/super-kanban-profile-backup.json"
MODULE="$PROFILE_DIR/node_modules/dsh-super-kanban"
YES=0
[ "${1:-}" = "-y" ] || [ "${1:-}" = "--yes" ] && YES=1

echo "Super Kanban uninstaller — profile: $PROFILE_DIR"
if [ -e "$MODULE" ] && [ ! -L "$MODULE" ]; then
  echo "ERROR: this is a package directory; uninstall it from the DSH plugin page." >&2
  exit 1
fi
if [ "$YES" -ne 1 ]; then
  printf "Remove the plugin from this profile? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 0 ;; esac
fi

if [ -f "$PKG" ]; then
  python3 - "$PKG" <<'PY'
import json, sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)

# Targeted removal: keep every other dependency / bundle / profile setting, so
# plugins installed after Super Kanban are never lost.
deps = data.get("dependencies")
if isinstance(deps, dict):
    deps.pop("dsh-super-kanban", None)
dsh = data.get("dsh")
profile = dsh.get("profile") if isinstance(dsh, dict) else None
bundles = profile.get("bundles") if isinstance(profile, dict) else None
if isinstance(bundles, list) and "dsh-super-kanban" in bundles:
    bundles.remove("dsh-super-kanban")

with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("  profile : dependency + bundle selection removed")
PY
else
  echo "  profile : manifest not found, skipping profile edit"
fi

# The bundle is linked into the profile's node_modules; drop only that entry
# (never the whole node_modules tree).
rm -f -- "$MODULE"

if [ -f "$BACKUP" ]; then
  echo "  backup  : kept at $BACKUP (pre-install snapshot, NOT auto-restored)"
fi
echo
echo "Removed. Reload the DSH window (Cmd+R) or restart the app."
echo "Board data (kept): $DSH_HOME/storages/super-kanban/"
