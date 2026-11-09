#!/bin/sh
# Remove dsh-auto-workspace from a DSH profile.
set -eu

DSH_HOME=${DSH_HOME:-"$HOME/.dsh"}
PLUGIN_HOME=${DSH_AUTO_WORKSPACE_HOME:-"$DSH_HOME/plugins/dsh-auto-workspace"}

if [ -n "${DSH_PROFILE:-}" ]; then
  case "$DSH_PROFILE" in
    */*) PROFILE="$DSH_PROFILE" ;;
    *) PROFILE="$DSH_HOME/profiles/$DSH_PROFILE" ;;
  esac
elif [ -n "${DSH_PROFILE_DIR:-}" ]; then
  PROFILE="$DSH_PROFILE_DIR"
else
  PROFILE="$DSH_HOME/profiles/desktop"
fi

PATCH="$PROFILE/cordis.patch.yml"
DEST="$PROFILE/node_modules/dsh-auto-workspace"

rm -f "$DEST"

if [ -f "$PROFILE/package.json" ]; then
  node - "$PROFILE/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (pkg.dependencies !== undefined) {
  delete pkg.dependencies['dsh-auto-workspace'];
  if (Object.keys(pkg.dependencies).length === 0) delete pkg.dependencies;
}
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
fi

if [ -f "$PATCH" ]; then
  node - "$PATCH" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
text = text.replace(/\n?- insert:\n {4}- id: auto-workspace\n {6}name: dsh-auto-workspace\n?/g, '\n');
if (text.trim() === '') text = '[]\n';
fs.writeFileSync(file, text);
NODE
fi

# Remove the stable copy, but only when it is the directory this plugin owns.
case "$PLUGIN_HOME" in
  "$DSH_HOME"/plugins/dsh-auto-workspace) rm -rf "$PLUGIN_HOME" ;;
  *) echo "note: leaving $PLUGIN_HOME in place because it is outside $DSH_HOME/plugins" ;;
esac

echo "removed dsh-auto-workspace from $PROFILE"
echo "Quit and reopen DeepSeek Harness to unload it. Workspaces and sessions"
echo "created by the plugin are left untouched."
