#!/bin/zsh
set -e

SIFT_APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SIFT_APP_DIR"

if [[ ! -x node_modules/.bin/tsx ]]; then
  echo "Installing Sift's local dependencies…"
  npm ci --registry=https://registry.npmjs.org/
fi

echo "Opening Sift Home…"
exec npm run ui
