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
MODULE="$PROFILE_DIR/node_modules/dsh-super-kanban"
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
if [ -e "$MODULE" ] && [ ! -L "$MODULE" ]; then
  echo "ERROR: a package directory already exists; uninstall it from DSH before linking the source checkout." >&2
  exit 1
fi

if [ "$YES" -ne 1 ]; then
  printf "Install the plugin into this profile? [y/N] "
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 0 ;; esac
fi

python3 - "$PKG" "$BACKUP" "$PLUGIN_DIR" "$MODULE" <<'PY'
import json, os, stat, sys, tempfile
from pathlib import Path

pkg_path, backup_path, plugin_dir, module = map(Path, sys.argv[1:])
pkg_path = pkg_path.resolve(strict=True)
original = pkg_path.read_text(encoding="utf-8")
data = json.loads(original)

data.setdefault("dependencies", {})["dsh-super-kanban"] = f"link:{plugin_dir}"
profile = data.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if not isinstance(bundles, list):
    raise ValueError("profile bundles must be a list")
if "dsh-super-kanban" not in bundles:
    bundles.append("dsh-super-kanban")

with tempfile.TemporaryDirectory(dir=pkg_path.parent) as temp:
    staged_manifest = Path(temp) / "package.json"
    staged_manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    staged_manifest.chmod(stat.S_IMODE(pkg_path.stat().st_mode))
    module.parent.mkdir(exist_ok=True)
    previous_link = os.readlink(module) if module.is_symlink() else None
    if previous_link is None and module.exists():
        raise FileExistsError("a package directory already exists")
    with tempfile.TemporaryDirectory(dir=backup_path.parent) as profile_temp:
        staged_backup = Path(profile_temp) / "backup.json"
        staged_backup.write_text(original, encoding="utf-8")
        staged_backup.chmod(0o600)
        try:
            os.link(staged_backup, backup_path)
            print(f"  backup  : {backup_path} (first-install snapshot; not auto-restored)")
        except FileExistsError:
            pass

    with tempfile.TemporaryDirectory(dir=module.parent) as module_temp:
        staged_link = Path(module_temp) / "plugin"
        staged_link.symlink_to(plugin_dir, target_is_directory=True)
        os.replace(staged_link, module)
        try:
            os.replace(staged_manifest, pkg_path)
        except OSError:
            if previous_link is None:
                module.unlink()
            else:
                staged_link.symlink_to(previous_link, target_is_directory=True)
                os.replace(staged_link, module)
            raise

print("  profile : dependency + bundle selection written")
PY

echo
echo "Installed. In the DSH window press Cmd+R (reload) — the sidebar will show"
echo "\"任务看板\" after the page reloads. If the app does not pick it up, restart DSH."
echo "Data lives in $DSH_HOME/storages/super-kanban/."
