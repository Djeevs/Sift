import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/config/index.js';
import { ACTIONS } from '../src/ui/jobs.js';

const scripts = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;

/**
 * Sift is meant to be equally usable by someone who lives in a terminal and
 * someone who has never opened one. That only holds if neither surface can do
 * something the other cannot.
 *
 * The web UI achieves it by shelling out to the same npm scripts rather than
 * reimplementing them, so the two cannot diverge in behaviour. These tests
 * guard the places where they could still drift apart.
 */
describe('terminal and web UI stay in step', () => {
  it('every web UI action runs a real npm script', () => {
    for (const [action, definition] of Object.entries(ACTIONS)) {
      expect(scripts[definition.script], `UI action "${action}" runs missing script "${definition.script}"`).toBeTruthy();
    }
  });

  /**
   * Source adoption shipped as a web-only feature and had to be backfilled: a
   * terminal user was left hand-writing YAML for something the product did for
   * everyone else. Each capability below must be reachable from a command.
   */
  it('every reader-facing capability has a command', () => {
    for (const script of [
      'onboard',          // create a reader
      'db:setup',         // set up storage
      'pipeline',         // find articles (SIFT_DRY_RUN=1 for the free test)
      'sources:suggest',  // ask Sift which sources suit this reader
      'sources:discover', // check each one really publishes a feed
      'sources:adopt',    // follow suggested sources
      'calibrate',        // rate what you read
      'reader:delete',    // remove a reader
      'doctor',           // check the setup
      'serve',            // publish locally
      'export',           // publish statically
      'cloud:setup',      // guided Cloudflare setup, so feeds work while the Mac sleeps
      'push',             // publish to Cloudflare
    ]) {
      expect(scripts[script], `missing npm script: ${script}`).toBeTruthy();
    }
  });

  /**
   * The commands survived; the web routes did not. A refactor of the job page
   * replaced a slice of app.ts spanning from the job route to the calibration
   * route, and the source-adoption routes sat between them — so they were
   * deleted silently, and every test still passed because the CLI half kept
   * working. Parity is only real if both halves are checked.
   */
  it('serves a web route for every capability that has one', () => {
    const app = readFileSync(resolve(PROJECT_ROOT, 'src/ui/app.ts'), 'utf8');
    for (const route of [
      "'/onboarding'",              // create a reader
      "'/profile/:id'",             // the dashboard
      "'/profile/:id/action'",      // storage, test run, real run, discovery
      "'/profile/:id/sources'",     // review and follow suggested sources
      "'/profile/:id/calibration'", // rate what you read
      "'/profile/:id/delete'",      // remove a reader
      "'/api/status'",              // machine-readable state
    ]) {
      expect(app, `no route for ${route}`).toContain(route);
    }
  });

  it('labels come from one place, so a button and its job cannot disagree', () => {
    const app = readFileSync(resolve(PROJECT_ROOT, 'src/ui/app.ts'), 'utf8');
    for (const action of Object.keys(ACTIONS)) {
      // Every action button renders ACTIONS[...].label rather than a literal.
      expect(app, `action "${action}" should render its label from ACTIONS`).toContain(`ACTIONS.${action}.label`);
    }
    // The wording that caused the original mismatch must not reappear.
    expect(app).not.toContain('Run free dry test');
    expect(app).not.toContain('Update recommendations');
  });
});
