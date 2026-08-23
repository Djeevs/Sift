/**
 * Build a double-clickable Sift.app.
 *
 *   npm run app:build                  # into ./build
 *   npm run app:build -- --out ~/Applications
 *
 * `.command` files exist to be opened *by* Terminal, so double-clicking one
 * always shows a terminal window. A `.app` does not: an application bundle is a
 * directory with an Info.plist and an executable, and the executable is allowed
 * to be a shell script. That is the whole trick.
 *
 * Built on this machine, so nothing is quarantined and Gatekeeper never
 * appears -- the "unidentified developer" warning comes from the quarantine
 * attribute macOS attaches to *downloads*. Signing only becomes necessary when
 * distributing the app to someone else.
 *
 * This wraps the checkout rather than embedding Node and node_modules. It
 * removes the terminal, which is the immediate problem; a self-contained
 * bundle that also removes the Node prerequisite is a larger, separate job.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';

loadEnvFile();
const args = parseArgs();

if (process.platform !== 'darwin') {
  console.log('Application bundles are a macOS thing. On Linux, run `npm run ui` or use a .desktop entry.');
  process.exit(1);
}

const outDir = resolve(
  typeof args.out === 'string' ? args.out.replace(/^~/, process.env.HOME ?? '~') : resolve(PROJECT_ROOT, 'build'),
);
const appPath = resolve(outDir, 'Sift.app');
const uiPort = Number(typeof args.port === 'string' ? args.port : process.env.SIFT_UI_PORT ?? 8790);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Sift</string>
  <key>CFBundleDisplayName</key><string>Sift</string>
  <key>CFBundleIdentifier</key><string>net.sift.app</string>
  <key>CFBundleVersion</key><string>${process.env.npm_package_version ?? '0.0.0'}</string>
  <key>CFBundleShortVersionString</key><string>${process.env.npm_package_version ?? '0.0.0'}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Sift</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;

/**
 * The bundle executable.
 *
 * Every failure has to explain itself in a dialog. There is no terminal to
 * print to any more, so a message written to stderr goes nowhere at all -- the
 * app would simply bounce once and vanish, which is indistinguishable from
 * being broken.
 */
const launcher = `#!/bin/bash
set -u
SIFT_DIR=${JSON.stringify(PROJECT_ROOT)}
SIFT_URL="http://127.0.0.1:${uiPort}"

say() { /usr/bin/osascript -e "display dialog \\"$1\\" buttons {\\"OK\\"} default button 1 with title \\"Sift\\"" >/dev/null 2>&1; }
ask() { /usr/bin/osascript -e "display dialog \\"$1\\" buttons {\\"Not now\\",\\"$2\\"} default button 2 with title \\"Sift\\"" 2>/dev/null | grep -q "$2"; }

cd "$SIFT_DIR" 2>/dev/null || { say "Sift's files have moved.\\n\\nThey were at:\\n$SIFT_DIR\\n\\nRebuild the app with: npm run app:build"; exit 1; }

# Already running: just bring the window up rather than starting a second one.
if /usr/bin/curl -fsS --max-time 2 "$SIFT_URL/api/status" >/dev/null 2>&1; then
  /usr/bin/open "$SIFT_URL"
  exit 0
fi

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
# nvm installs node outside the standard paths, and a GUI app inherits none of
# a shell's environment, so look where a terminal would have found it.
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$candidate/node" ] && export PATH="$candidate:$PATH" && break
  done
fi

if ! command -v node >/dev/null 2>&1; then
  if ask "Sift needs Node.js, which is not installed.\\n\\nIt is a free download and takes a couple of minutes. Open the download page?" "Open nodejs.org"; then
    /usr/bin/open "https://nodejs.org"
  fi
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  if ask "Sift needs Node.js 22 or newer.\\n\\nThis Mac has $(node -v). Open the download page?" "Open nodejs.org"; then
    /usr/bin/open "https://nodejs.org"
  fi
  exit 1
fi

if [ ! -x node_modules/.bin/tsx ]; then
  say "Setting Sift up for the first time.\\n\\nThis takes a minute or two. Sift will open when it is ready."
  if ! npm ci --registry=https://registry.npmjs.org/ >/tmp/sift-install.log 2>&1; then
    say "Setup did not finish.\\n\\nThe usual cause is no internet connection. Details are in:\\n/tmp/sift-install.log"
    exit 1
  fi
fi

# Killing the app must take the server with it. Backgrounding without this left
# the server orphaned, still holding the ports, so the next launch saw
# "already running" and reopened a page served by the old build.
npm run ui -- --no-open --app &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; exit 0; }
trap cleanup TERM INT HUP EXIT
for _ in $(seq 1 40); do
  /usr/bin/curl -fsS --max-time 1 "$SIFT_URL/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done

if ! /usr/bin/curl -fsS --max-time 2 "$SIFT_URL/api/status" >/dev/null 2>&1; then
  say "Sift started but is not responding on port ${uiPort}.\\n\\nSomething else may be using that port."
  kill "$SERVER_PID" 2>/dev/null
  exit 1
fi

/usr/bin/open "$SIFT_URL"
wait "$SERVER_PID"
`;

rmSync(appPath, { recursive: true, force: true });
mkdirSync(resolve(appPath, 'Contents', 'MacOS'), { recursive: true });
mkdirSync(resolve(appPath, 'Contents', 'Resources'), { recursive: true });
writeFileSync(resolve(appPath, 'Contents', 'Info.plist'), infoPlist);
writeFileSync(resolve(appPath, 'Contents', 'MacOS', 'Sift'), launcher);
chmodSync(resolve(appPath, 'Contents', 'MacOS', 'Sift'), 0o755);

const icon = resolve(PROJECT_ROOT, 'mac', 'Sift.icns');
if (existsSync(icon)) {
  cpSync(icon, resolve(appPath, 'Contents', 'Resources', 'Sift.icns'));
  writeFileSync(
    resolve(appPath, 'Contents', 'Info.plist'),
    infoPlist.replace('  <key>NSHighResolutionCapable</key>', '  <key>CFBundleIconFile</key><string>Sift</string>\n  <key>NSHighResolutionCapable</key>'),
  );
}

console.log(`Built ${appPath}`);
console.log('');
console.log('  Double-click it. No terminal window appears.');
console.log('  Built on this Mac, so it is not quarantined and Gatekeeper stays quiet.');
console.log('');
console.log(`  It runs the checkout at ${PROJECT_ROOT}, so keep that folder where it is.`);
console.log('  Drag it to Applications or the Dock if you like.');
if (!existsSync(icon)) console.log('\n  No mac/Sift.icns found, so it uses the generic app icon.');
