/**
 * Guided Cloudflare setup: one command instead of three manual steps of
 * copying ids between terminal output and two different files.
 *
 *   npm run cloud:setup                       # the owner profile
 *   npm run cloud:setup -- --profile alice     # a named reader
 *
 * Re-running is safe: any step already done (a namespace, a database, a
 * deployed worker) is detected and skipped rather than recreated.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { PROJECT_ROOT, resolveHome } from '../config/index.js';
import { profileDirectory, validateProfileId } from '../onboarding/index.js';
import { readEnv, updateEnv } from '../util/dotenv.js';
import { loadEnvFile, parseArgs } from './_bootstrap.js';
import {
  wranglerAvailable,
  whoami,
  login,
  ensureWranglerToml,
  wranglerTomlStatus,
  createKvNamespace,
  createD1Database,
  applyD1Schema,
  regenerateTypes,
  pushAccessTokenSecret,
  deployWorker,
} from '../cloudflare/wrangler.js';

loadEnvFile();
const args = parseArgs();
const profileArg = typeof args.profile === 'string' ? args.profile.trim().toLowerCase() : null;

const readerSlug = profileArg ? validateProfileId(profileArg) : 'home';
const envPath = profileArg ? resolve(profileDirectory(profileArg, resolveHome()), '.env') : resolve(PROJECT_ROOT, '.env');

let step = 0;
const total = 7;
function announce(label: string): void {
  step += 1;
  console.log(`\nStep ${step} of ${total}: ${label}`);
}

async function run(): Promise<void> {
  console.log(`Setting up Cloudflare for ${profileArg ? `reader "${profileArg}"` : 'this profile'}.`);
  console.log('This talks to your Cloudflare account and creates real (free-tier) cloud resources.\n');

  if (!existsSync(envPath)) {
    throw new Error(
      `No profile found at ${envPath}. Finish onboarding first: ` +
      (profileArg ? `npm run onboard -- --profile ${profileArg} --from <dossier.json>` : 'npm run onboard'),
    );
  }
  const env = readEnv(envPath);
  if (!env.SIFT_ACCESS_TOKEN) {
    throw new Error(`${envPath} has no SIFT_ACCESS_TOKEN yet. Finish onboarding before setting up Cloudflare.`);
  }

  announce('Checking wrangler is installed');
  if (!(await wranglerAvailable())) {
    throw new Error('wrangler is not available. Run "npm ci" inside the worker/ folder first.');
  }
  console.log('  ok');

  announce('Checking your Cloudflare login');
  let account = await whoami();
  if (!account) {
    console.log('  Not logged in yet. Opening the Cloudflare login in your browser --');
    console.log('  approve it there, then come back to this terminal.');
    await login();
    account = await whoami();
    if (!account) throw new Error('Still not logged in after running wrangler login. Try again.');
  }
  console.log(`  logged in as ${account}`);

  announce('Preparing worker/wrangler.toml');
  let status = ensureWranglerToml(readerSlug);
  console.log(`  worker name: ${status.name}`);

  announce('Creating the KV namespace that stores your feeds');
  if (status.kvNamespaceId) {
    console.log(`  already configured (${status.kvNamespaceId}), skipping`);
  } else {
    const id = await createKvNamespace('SIFT_FEEDS');
    console.log(`  created ${id}`);
    status = wranglerTomlStatus();
  }

  announce('Creating the database that records article opens');
  if (status.d1DatabaseId) {
    console.log(`  already configured (${status.d1DatabaseId}), skipping`);
  } else {
    const name = status.d1DatabaseName ?? `sift-${readerSlug}-events`;
    const id = await createD1Database(name);
    console.log(`  created ${id}`);
    console.log('  applying the database schema...');
    await applyD1Schema(name);
    console.log('  done');
    status = wranglerTomlStatus();
  }
  await regenerateTypes();

  announce('Sending your feed-access token to Cloudflare');
  await pushAccessTokenSecret(env.SIFT_ACCESS_TOKEN);
  console.log('  done (the token itself was never shown or typed)');

  announce('Deploying');
  const url = await deployWorker();
  console.log(`  live at ${url}`);

  updateEnv(envPath, { SIFT_PUBLIC_URL: url, SIFT_KV_NAMESPACE_ID: status.kvNamespaceId ?? wranglerTomlStatus().kvNamespaceId ?? '' });

  const profileFlag = profileArg ? `--profile ${profileArg} ` : '';
  console.log('\nDone. Your feeds will work even while this Mac is asleep, once you push them:');
  console.log(`  npm run push -- ${profileFlag}--dry`);
  console.log(`  npm run push${profileArg ? ` -- ${profileFlag.trim()}` : ''}`);
}

run().catch((err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  const detail = err as { stdout?: string; stderr?: string };
  if (detail.stderr) console.error(detail.stderr.trim());
  console.error('\nRunning the command again will pick up where it left off.');
  process.exitCode = 1;
});
