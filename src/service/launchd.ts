/**
 * launchd integration: the same background-service logic behind both the
 * `npm run service:*` commands and the dashboard's background toggle.
 *
 *   npm run service:install     # start at login, restart on crash
 *   npm run service:status
 *   npm run service:stop / :start / :restart
 *   npm run service:uninstall
 *
 * launchd rather than a wrapper application. The thing a reader actually wants
 * is "it is just running" -- starts at login, survives a crash, no terminal
 * window to leave open, and stops when asked. launchd does all of that for a
 * plist and a few commands. An Electron or Tauri shell would add a second
 * runtime and an installer to maintain, and would still need something like
 * this underneath to keep the server alive.
 *
 * The plist is written into the user's own LaunchAgents directory, so nothing
 * here needs administrator rights and nothing is installed system-wide.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';

const LABEL_PREFIX = 'net.sift.reader';

function labelFor(profile: string): string {
  return `${LABEL_PREFIX}.${profile.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function plistPath(label: string): string {
  return resolve(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `launchctl` exits non-zero for ordinary conditions, so failures are data. */
function launchctl(...args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync('launchctl', args, { encoding: 'utf8' }).trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message || 'failed' };
  }
}

function buildPlist(options: { label: string; profile: string; node: string; logDir: string; schedule: boolean; uiPort: number }): string {
  // Runs the built entry point through the same npm script a person would use,
  // so the service and the terminal cannot diverge in what they actually start.
  const entries: Array<[string, string]> = [
    ['Label', options.label],
    ['WorkingDirectory', PROJECT_ROOT],
    ['StandardOutPath', resolve(options.logDir, `${options.label}.out.log`)],
    ['StandardErrorPath', resolve(options.logDir, `${options.label}.err.log`)],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([key, value]) => `  <key>${key}</key>\n  <string>${xmlEscape(value)}</string>`).join('\n')}
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(options.node)}</string>
    <string>${xmlEscape(resolve(PROJECT_ROOT, 'node_modules/.bin/tsx'))}</string>
    <string>${xmlEscape(resolve(PROJECT_ROOT, 'src/cli/serve-and-schedule.ts'))}</string>
    <string>--profile</string>
    <string>${xmlEscape(options.profile)}</string>${options.schedule ? '' : `
    <string>--no-schedule</string>`}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SIFT_PROFILE</key>
    <string>${xmlEscape(options.profile)}</string>
    <!-- Written explicitly: a launchd service inherits none of the shell
         environment it was installed from, so without this the service would
         quietly use a different port than the install message promised. -->
    <key>SIFT_UI_PORT</key>
    <string>${options.uiPort}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}


export const LAUNCHD_SUPPORTED = process.platform === 'darwin';

export interface ServiceState {
  supported: boolean;
  installed: boolean;
  running: boolean;
  pid: number | null;
  label: string;
  plistPath: string;
}

/** What launchd currently thinks, for a reader. Never throws. */
export function serviceState(profile: string): ServiceState {
  const label = labelFor(profile);
  const path = plistPath(label);
  const base: ServiceState = { supported: LAUNCHD_SUPPORTED, installed: false, running: false, pid: null, label, plistPath: path };
  if (!LAUNCHD_SUPPORTED || !existsSync(path)) return base;
  const info = launchctl('print', `gui/${process.getuid?.() ?? 501}/${label}`);
  const pid = /\bpid = (\d+)/.exec(info.output)?.[1];
  return { ...base, installed: true, running: Boolean(pid), pid: pid ? Number(pid) : null };
}

export { labelFor, plistPath, buildPlist, launchctl };
