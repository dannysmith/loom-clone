#!/usr/bin/env bash
#
# install-prod.sh — Build a Release version of LoomClone and install to ~/Applications.
#
# Sets the production server URL in UserDefaults on first run. The API key
# persists in the Keychain across rebuilds — set it once via Settings.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
APP_NAME="LoomClone.app"
INSTALL_DIR="/Applications"
DEFAULTS_SUITE="is.danny.loomclone.settings"
SERVER_URL="https://v.danny.is"

echo "==> Building Release configuration..."
xcodebuild \
    -project "$PROJECT_DIR/LoomClone.xcodeproj" \
    -scheme LoomClone \
    -configuration Release \
    -destination 'platform=macOS' \
    build \
    -quiet

# Find the built app in DerivedData
BUILD_DIR=$(xcodebuild \
    -project "$PROJECT_DIR/LoomClone.xcodeproj" \
    -scheme LoomClone \
    -configuration Release \
    -destination 'platform=macOS' \
    -showBuildSettings 2>/dev/null \
    | grep -m1 "BUILT_PRODUCTS_DIR" \
    | awk '{print $3}')

if [[ ! -d "$BUILD_DIR/$APP_NAME" ]]; then
    echo "Error: Built app not found at $BUILD_DIR/$APP_NAME" >&2
    exit 1
fi

echo "==> Installing to $INSTALL_DIR/$APP_NAME..."
mkdir -p "$INSTALL_DIR"

# Remove old version if present (avoids code signing cache issues)
if [[ -d "$INSTALL_DIR/$APP_NAME" ]]; then
    rm -rf "$INSTALL_DIR/$APP_NAME"
fi

cp -R "$BUILD_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"

# Set server URL in release UserDefaults (preserves existing value if already set)
CURRENT_URL=$(defaults read "$DEFAULTS_SUITE" serverURL 2>/dev/null || echo "")
if [[ -z "$CURRENT_URL" ]]; then
    defaults write "$DEFAULTS_SUITE" serverURL -string "$SERVER_URL"
    echo "    Set server URL to $SERVER_URL"
else
    echo "    Server URL already configured: $CURRENT_URL"
fi

echo ""
echo "==> Installed $APP_NAME to $INSTALL_DIR/"
echo ""
echo "    Server URL: $(defaults read "$DEFAULTS_SUITE" serverURL 2>/dev/null || echo '(not set)')"
echo "    API key:    $(security find-generic-password -s 'is.danny.loomclone.apikey' -a 'default' >/dev/null 2>&1 && echo 'stored in Keychain' || echo 'NOT SET — open Settings in the app')"
echo ""
echo "    To launch: open $INSTALL_DIR/$APP_NAME"
