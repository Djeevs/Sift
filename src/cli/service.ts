/**
 * Run Sift as a background service, so it survives closing the terminal.
 *
 *   npm run service:install     # start at login, restart on crash
 *   npm run service:status
 *   npm run service:stop / :start / :restart
 *   npm run service:uninstall
 *
 * launchd rather than a wrapper application. What a reader wants is "it is just
 * running" -- starts at login, survives a crash, no terminal window to leave
 * open, stops when asked. launchd does all of that for a plist and a few
 * commands; an Electron or Tauri shell would add a second runtime and still
 * need something like this underneath.
 *
 * The plist goes in the user's own LaunchAgents directory, so nothing needs
 * administrator rights and nothing is installed system-wide.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import { buildPlist, labelFor, launchctl, plistPath } from '../service/launchd.js';

loadEnvFile();
const args = parseArgs();
const command = String(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'status');
const profile = typeof args.profile === 'string' ? args.profile : process.env.SIFT_PROFILE?.trim();
if (!profile) throw new Error('Missing --profile YOUR_NAME (or set SIFT_PROFILE).');

if (process.platform !== 'darwin') {
  console.log('Background service installation is macOS-only (launchd).');
  console.log('On Linux, run `npm run serve` under systemd or your init system of choice.');
  process.exit(1);
}

const label = labelFor(profile);
const path = plistPath(label);
const logDir = resolve(PROJECT_ROOT, 'data', 'logs');
// Resolved once and written into the service, so what is reported and what the
// service actually uses cannot disagree.
const uiPort = Number(typeof args['ui-port'] === 'string' ? args['ui-port'] : process.env.SIFT_UI_PORT ?? 8790);
if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535) {
  throw new Error('--ui-port must be a whole number from 1024 to 65535.');
}

switch (command) {
  case 'install': {
    const schedule = args['no-schedule'] !== true;
    // --dry prints what would be installed and touches nothing, matching the
    // convention `npm run push --dry` already sets for irreversible actions.
    if (args.dry === true) {
      console.log(`Would write ${path}\n`);
      console.log(buildPlist({ label, profile, node: process.execPath, logDir, schedule, uiPort }));
      console.log(schedule
        ? 'Scheduling is on: Sift would run the pipeline on the configured interval.'
        : 'Scheduling is off: Sift would serve feeds but never run on its own.');
      break;
    }
    mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    if (existsSync(path)) launchctl('bootout', `gui/${process.getuid?.() ?? 501}/${label}`);
    writeFileSync(path, buildPlist({ label, profile, node: process.execPath, logDir, schedule, uiPort }));
    const loaded = launchctl('bootstrap', `gui/${process.getuid?.() ?? 501}`, path);
    if (!loaded.ok) {
      console.log(`Wrote ${path}, but launchd would not load it:`);
      console.log(`  ${loaded.output}`);
      console.log('Run `npm run service:status` after resolving it.');
      process.exitCode = 1;
      break;
    }
    console.log(`Sift now runs in the background for "${profile}".`);
    console.log('  starts at login, restarts if it stops unexpectedly');
    console.log(`  scheduled runs: ${schedule ? 'on' : 'off (serves feeds only)'}`);
    console.log(`  control panel: http://127.0.0.1:${uiPort}`);
    console.log(`  logs:          ${logDir}`);
    console.log('');
    console.log('Stop it with:  npm run service:stop -- --profile ' + profile);
    break;
  }
  case 'uninstall': {
    launchctl('bootout', `gui/${process.getuid?.() ?? 501}/${label}`);
    if (existsSync(path)) rmSync(path);
    console.log(`Sift no longer runs in the background for "${profile}". Nothing else was removed.`);
    break;
  }
  case 'start':
  case 'stop': {
    if (!existsSync(path)) throw new Error(`No background service installed for "${profile}". Run npm run service:install first.`);
    const result = launchctl(command === 'start' ? 'kickstart' : 'kill', ...(command === 'start'
      ? [`gui/${process.getuid?.() ?? 501}/${label}`]
      : ['SIGTERM', `gui/${process.getuid?.() ?? 501}/${label}`]));
    console.log(result.ok ? `Sift ${command === 'start' ? 'started' : 'stopped'} for "${profile}".` : result.output);
    if (!result.ok) process.exitCode = 1;
    break;
  }
  case 'restart': {
    launchctl('kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${label}`);
    console.log(`Sift restarted for "${profile}".`);
    break;
  }
  case 'status': {
    if (!existsSync(path)) {
      console.log(`No background service installed for "${profile}".`);
      console.log(`Install with:  npm run service:install -- --profile ${profile}`);
      break;
    }
    const info = launchctl('print', `gui/${process.getuid?.() ?? 501}/${label}`);
    const pid = /\bpid = (\d+)/.exec(info.output)?.[1];
    console.log(`Service:  ${label}`);
    console.log(`Plist:    ${path}`);
    console.log(`State:    ${pid ? `running (pid ${pid})` : info.ok ? 'installed, not running' : 'installed, not loaded'}`);
    console.log(`Logs:     ${logDir}`);
    if (!pid && existsSync(resolve(logDir, `${label}.err.log`))) {
      const tail = readFileSync(resolve(logDir, `${label}.err.log`), 'utf8').trim().split('\n').slice(-5);
      if (tail.length > 0 && tail[0]) {
        console.log('\nLast error output:');
        for (const line of tail) console.log(`  ${line}`);
      }
    }
    break;
  }
  default:
    console.log('Usage: npm run service:<install|uninstall|start|stop|restart|status> -- --profile NAME');
    process.exitCode = 1;
}
