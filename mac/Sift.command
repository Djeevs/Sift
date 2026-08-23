#!/bin/zsh
# Double-clickable launcher for Sift Home.
#
# Everything a non-technical reader sees before the browser opens happens here,
# so every failure has to explain itself and then wait: a Terminal window that
# flashes an error and closes is indistinguishable from nothing happening.

set -u

SIFT_APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SIFT_APP_DIR" || exit 1

bold() { printf '\033[1m%s\033[0m\n' "$1"; }

fail() {
  echo
  bold "Sift could not start."
  echo
  printf '%s\n' "$1"
  echo
  echo "This window stays open so you can read the message."
  echo "Press Return to close it."
  read -r _
  exit 1
}

# --- Node ---------------------------------------------------------------
# By far the most common first-run failure, and the error Node's absence
# produces on its own ("command not found: npm") tells the reader nothing.
if ! command -v node >/dev/null 2>&1; then
  fail "Sift needs Node.js, which is not installed on this Mac.

  1. Go to  https://nodejs.org
  2. Download the version marked LTS and open the installer.
  3. Accept the defaults.
  4. Double-click Sift.command again.

  The download is free and takes a couple of minutes."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Sift needs Node.js 22 or newer. This Mac has version $(node -v).

  Install the current LTS release from  https://nodejs.org
  and then double-click Sift.command again."
fi

# --- Dependencies -------------------------------------------------------
if [ ! -x node_modules/.bin/tsx ]; then
  bold "Setting up Sift for the first time…"
  echo "This downloads the pieces Sift needs and takes a minute or two."
  echo
  if ! npm ci --registry=https://registry.npmjs.org/; then
    fail "The setup step did not finish.

  The usual cause is no internet connection, or a network that blocks
  downloads. Check your connection and try again.

  If it keeps failing, the messages above this line say why."
  fi
  echo
fi

bold "Opening Sift Home in your browser…"
echo "Leave this window open while you use Sift. Closing it stops Sift."
echo
npm run ui

# `npm run ui` only returns once the server stops, normally via Control-C.
status=$?
if [ $status -ne 0 ] && [ $status -ne 130 ]; then
  fail "Sift stopped unexpectedly. The messages above this line say why."
fi
