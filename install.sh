#!/bin/bash

# Register Omarchy Theme Sync and its native messaging host.
#
# Everything here is per-user and needs no root: the host manifest lives in each
# browser's profile config, and the extension is loaded unpacked through that
# browser's own flags file, which is how Omarchy already ships copy-url, yt-dlp
# and whatsapp-slim.

set -euo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
EXTENSION_DIR="${OMARCHY_THEME_EXTENSION_DIR:-$REPO_DIR/extension}"
HOST_BIN="${OMARCHY_THEME_HOST_BIN:-$REPO_DIR/bin/omarchy-browser-theme-host}"
HOST_NAME="com.omarchy.theme"

# The Arch chromium launcher resolves its flags file through the XDG config dir,
# not $HOME/.config, so a user who moves XDG_CONFIG_HOME would otherwise get the
# flag written somewhere the launcher never reads.
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

# The id is derived from the manifest's "key", so it is identical for the
# unpacked dev load and any future packed build. The native host refuses
# connections from any other origin, so this has to match exactly.
EXTENSION_ID="ppnnomfimbfcofidkfmghapellfbgklc"

# One "<profile root>|<flags file>|<launcher names>" entry per Chromium-family
# browser and channel. The root is the home of the native messaging manifest; the
# flags file is the one that browser's own launcher reads, and the name is per
# channel: chrome-flags.conf for stable Chrome, chrome-beta-flags.conf for Beta,
# brave-flags.conf for Brave, brave-origin-flags.conf for Brave Origin. Launcher
# names are alternatives, because packaging disagrees: brave-bin installs `brave`,
# Brave's own .deb installs `brave-browser`.
#
# A browser counts as present only when its profile root exists and one of its
# launchers is on PATH. The profile alone is not enough: Omarchy's own copy-url
# and yt-dlp installers mkdir -p every profile root in this list, so a machine
# with only Chromium would still look like it runs Chrome, Edge and three Braves.
BROWSERS=(
  "$CONFIG_HOME/chromium|chromium-flags.conf|chromium chromium-browser"
  "$CONFIG_HOME/google-chrome|chrome-flags.conf|google-chrome google-chrome-stable"
  "$CONFIG_HOME/google-chrome-beta|chrome-beta-flags.conf|google-chrome-beta"
  "$CONFIG_HOME/google-chrome-unstable|chrome-unstable-flags.conf|google-chrome-unstable"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser|brave-flags.conf|brave brave-browser"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser-Beta|brave-beta-flags.conf|brave-beta brave-browser-beta"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser-Nightly|brave-nightly-flags.conf|brave-nightly brave-browser-nightly"
  "$CONFIG_HOME/BraveSoftware/Brave-Origin|brave-origin-flags.conf|brave-origin"
  "$CONFIG_HOME/microsoft-edge|microsoft-edge-stable-flags.conf|microsoft-edge microsoft-edge-stable"
  "$CONFIG_HOME/microsoft-edge-beta|microsoft-edge-beta-flags.conf|microsoft-edge-beta"
  "$CONFIG_HOME/microsoft-edge-dev|microsoft-edge-dev-flags.conf|microsoft-edge-dev"
  "$CONFIG_HOME/vivaldi|vivaldi-flags.conf|vivaldi"
  "$CONFIG_HOME/vivaldi-snapshot|vivaldi-snapshot-flags.conf|vivaldi-snapshot"
  "$CONFIG_HOME/opera|opera-flags.conf|opera"
  "$CONFIG_HOME/helium|helium-flags.conf|helium"
)

uninstall=0
[[ ${1:-} == "--uninstall" ]] && uninstall=1

registered=0
configured=0

install_host() {
  local root=$1 manifest_dir="$1/NativeMessagingHosts"

  if (( uninstall )); then
    rm -f "$manifest_dir/$HOST_NAME.json"
    return
  fi

  mkdir -p "$manifest_dir"
  jq -n \
    --arg name "$HOST_NAME" \
    --arg path "$HOST_BIN" \
    --arg origin "chrome-extension://$EXTENSION_ID/" \
    '{name: $name,
      description: "Omarchy Theme Sync native host",
      path: $path,
      type: "stdio",
      allowed_origins: [$origin]}' >"$manifest_dir/$HOST_NAME.json"

  registered=$((registered + 1))
}

# --load-extension takes one comma-separated list and Chromium honours only the
# last occurrence of the flag, so this edits the existing list in place rather
# than appending a second flag line.
update_flags() {
  local flags_file=$1
  local line paths=() kept=() joined found=0

  [[ -f $flags_file ]] || {
    (( uninstall )) && return 0
    mkdir -p "$(dirname "$flags_file")"
    : >"$flags_file"
  }

  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == --load-extension=* ]]; then
      found=1
      IFS=',' read -ra paths <<<"${line#--load-extension=}"
      continue
    fi
    kept+=("$line")
  done <"$flags_file"

  local rebuilt=()
  local path
  for path in "${paths[@]}"; do
    [[ -n $path && $path != "$EXTENSION_DIR" ]] && rebuilt+=("$path")
  done
  (( uninstall )) || rebuilt+=("$EXTENSION_DIR")

  {
    # printf on an empty array still emits one blank line, which would accumulate
    # a leading newline in the flags file on every run.
    (( ${#kept[@]} )) && printf '%s\n' "${kept[@]}"
    if (( ${#rebuilt[@]} )); then
      joined=$(IFS=','; echo "${rebuilt[*]}")
      printf -- '--load-extension=%s\n' "$joined"
    fi
  } >"$flags_file.tmp"

  mv "$flags_file.tmp" "$flags_file"
  configured=$((configured + 1))

  if (( uninstall )); then
    echo "Removed $EXTENSION_DIR from $flags_file"
  elif (( found )); then
    echo "Updated --load-extension in $flags_file"
  else
    echo "Added --load-extension to $flags_file"
  fi
}

[[ -x $HOST_BIN ]] || { echo "install.sh: host binary not executable: $HOST_BIN" >&2; exit 1; }
[[ -f $EXTENSION_DIR/manifest.json ]] || { echo "install.sh: no manifest at $EXTENSION_DIR" >&2; exit 1; }

# A browser has to be installed and have been run at least once to be configured.
# Uninstall ignores the gate for the flags file and cleans any that exists, so a
# browser uninstalled after install still loses the path.
browser_present() {
  local root=$1 launcher
  [[ -d $root ]] || return 1
  for launcher in $2; do
    command -v "$launcher" >/dev/null 2>&1 && return 0
  done
  return 1
}

for entry in "${BROWSERS[@]}"; do
  root=${entry%%|*}
  rest=${entry#*|}
  flags_file="$CONFIG_HOME/${rest%%|*}"
  launchers=${rest##*|}

  if (( uninstall )); then
    if [[ -d $root ]]; then
      install_host "$root"
    fi
    if [[ -f $flags_file ]]; then
      update_flags "$flags_file"
    fi
    continue
  fi

  browser_present "$root" "$launchers" || continue
  install_host "$root"
  update_flags "$flags_file"
done

echo
if (( uninstall )); then
  echo "Removed $HOST_NAME from $configured flags file(s)."
  echo "Done. Restart your browser."
elif (( registered == 0 )); then
  echo "No Chromium-family browser profile found under $CONFIG_HOME." >&2
  echo "Open a browser once, then run this installer again." >&2
  exit 1
else
  echo "Registered $HOST_NAME for $registered browser profile(s)."
  echo "Done. Restart your browser, then check its extensions page for \"Omarchy Theme Sync\"."
  echo "Extension id: $EXTENSION_ID"
fi
