#!/bin/bash
# Super Kanban — remove the plugin from a DSH profile (default: desktop).
#
#   ./uninstall.sh          # interactive
#   ./uninstall.sh -y       # non-interactive
#   DSH_HOME=/tmp/x ./uninstall.sh -y
#
# Restores the profile manifest from the pre-install backup when available and
# unlinks the package. The board data under $DSH_HOME/storages/super-kanban/ is
# kept; delete it yourself if you want a clean slate.
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PKG="$PROFILE_DIR/package.json"
BACKUP="$PROFILE_DIR/super-kanban-profile-backup.json"
YES=0
[ "${1:-}" = "-y" ] || [ "${1:-}" = "--yes" ] && YES=1

echo "Super Kanban uninstaller — profile: $PROFILE_DIR"
if [ "$YES" -ne 1 ]; then
  printf "Remove the plugin from this profile? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 0 ;; esac
fi

if [ -f "$BACKUP" ]; then
  cp "$BACKUP" "$PKG"
  rm -f "$BACKUP"
  echo "  profile : restored from backup"
else
  python3 - "$PKG" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
data.get("dependencies", {}).pop("dsh-super-kanban", None)
bundles = data.get("dsh", {}).get("profile", {}).get("bundles", [])
if "dsh-super-kanban" in bundles:
    bundles.remove("dsh-super-kanban")
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("  profile : dependency + bundle selection removed")
PY
fi

rm -f "$PROFILE_DIR/node_modules/dsh-super-kanban"
echo
echo "Removed. Reload the DSH window (Cmd+R) or restart the app."
echo "Board data (kept): $DSH_HOME/storages/super-kanban/"
