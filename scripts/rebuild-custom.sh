#!/usr/bin/env bash
# Rebuild "T3 Code (Custom)" and install it into ~/Applications.
#
# The new app is built, signed and checked in a temp folder first. The installed
# app is only touched at the very end, and the old one is kept as a backup.
#
# Overrides (mostly for testing): INSTALL_DIR, BACKUP_ROOT.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT=$PWD

APP_NAME="T3 Code (Custom).app"
BUNDLE_ID="com.t3tools.t3code.custom"
SIGN_IDENTITY="T3 Code Custom Local Signing"
INSTALL_DIR=${INSTALL_DIR:-$HOME/Applications}
BACKUP_ROOT=${BACKUP_ROOT:-$HOME/.t3/custom-app-backups}
KEEP_BACKUPS=3

step() { printf '\n==> %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

# The repo needs Node 24, but the shell default is often older.
step "Node"
if [[ "$(node -v 2>/dev/null)" != v24.* ]]; then
  node24=$(ls -d "$HOME"/.nvm/versions/node/v24.* 2>/dev/null | sort -V | tail -1 || true)
  [[ -n "$node24" ]] || die "Node 24 not found. Install it with: nvm install 24"
  export PATH="$node24/bin:$PATH"
fi
node -v

# Rust is only needed for the native resource monitor.
step "Resource monitor"
if ! command -v cargo >/dev/null; then
  toolchain=$(ls -d "$HOME"/.rustup/toolchains/*/bin 2>/dev/null | head -1 || true)
  [[ -z "$toolchain" ]] || export PATH="$toolchain:$PATH"
fi
monitor_bin=native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor
# The cached binary is fine while nothing in native/resource-monitor changed after it was built.
# Reusing it also avoids needing a new Rust whenever a dependency raises its minimum version.
if [[ -f "$monitor_bin" && -z "$(find native/resource-monitor -path '*/target' -prune -o -type f -newer "$monitor_bin" -print -quit)" ]]; then
  export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true
  echo "Reusing the cached build (source unchanged)."
else
  command -v cargo >/dev/null || die "native/resource-monitor changed and cargo was not found. Install Rust: https://rustup.rs"
  echo "Source changed, building it with $(cargo --version)."
fi

step "Building the app"
pnpm run dist:desktop:dmg:arm64

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step "Unpacking and signing"
zip=$(ls -t release/T3-Code-*-arm64.zip | head -1)
echo "$zip"
ditto -x -k "$zip" "$work"
new_app="$work/$APP_NAME"
[[ -d "$new_app" ]] || die "$APP_NAME is not in $zip"
[[ "$(defaults read "$new_app/Contents/Info.plist" CFBundleIdentifier)" == "$BUNDLE_ID" ]] ||
  die "Unexpected bundle id in the new app. Not installing."
# The build output has no signature. This is the same local certificate the app was
# signed with before, so macOS keeps treating it as the same app.
# The first run asks for your login password. Choose "Always Allow" to skip it next time.
codesign --force --deep --sign "$SIGN_IDENTITY" "$new_app"
codesign --verify --deep --strict "$new_app"

step "Installing"
mkdir -p "$INSTALL_DIR"
backup=
if [[ -d "$INSTALL_DIR/$APP_NAME" ]]; then
  backup="$BACKUP_ROOT/$(date +%Y-%m-%d-%H%M%S)"
  mkdir -p "$backup"
  mv "$INSTALL_DIR/$APP_NAME" "$backup/"
fi
ditto "$new_app" "$INSTALL_DIR/$APP_NAME"
codesign --verify --deep --strict "$INSTALL_DIR/$APP_NAME"

# Keep the newest few backups, since each one is a full copy of the app.
if [[ -d "$BACKUP_ROOT" ]]; then
  ls -d "$BACKUP_ROOT"/*/ 2>/dev/null | sort -r | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
    rm -rf "$old"
  done
fi

# Lets `git log "$(cat ~/.t3/custom-app-built-commit)"..HEAD` list what the next rebuild adds.
git -C "$REPO_ROOT" rev-parse HEAD >"$HOME/.t3/custom-app-built-commit"

step "Done"
echo "Installed: $INSTALL_DIR/$APP_NAME"
echo "Quit and reopen the app to use the new version."
if [[ -n "$backup" ]]; then
  echo
  echo "To go back to the previous version:"
  echo "  rm -rf \"$INSTALL_DIR/$APP_NAME\" && mv \"$backup/$APP_NAME\" \"$INSTALL_DIR/\""
fi
