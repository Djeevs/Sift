import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { PROJECT_ROOT } from '../config/index.js';
import { onboardingDossierSchema } from '../onboarding/index.js';

const required = [
  'LICENSE',
  '.github/workflows/ci.yml',
  '.env.example',
  'npm-shrinkwrap.json',
  'config/taste-profile.yaml',
  'profiles/example/taste-profile.yaml',
  'onboarding/chatgpt-profile-prompt.md',
  'worker/wrangler.example.toml',
  'mac/Sift.command',
];

const textExtensions = new Set(['.ts', '.md', '.yaml', '.yml', '.json', '.toml', '.sql']);
const excludedDirectories = new Set(['node_modules', 'dist', 'data', '.backups', '.git', '.wrangler']);

function textFiles(directory: string, root = directory): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (excludedDirectories.has(entry)) continue;
    const path = resolve(directory, entry);
    const rel = relative(root, path);
    if (rel === '.env' || rel.startsWith(`profiles/`) && !rel.startsWith('profiles/example/')) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...textFiles(path, root));
    else if (textExtensions.has(extname(path)) || entry === '.env.example' || entry === '.gitignore' || entry === 'LICENSE') files.push(path);
  }
  return files;
}

const failures: string[] = [];
for (const path of required) {
  if (!existsSync(resolve(PROJECT_ROOT, path))) failures.push(`missing required distributable file: ${path}`);
}

const gitignorePath = resolve(PROJECT_ROOT, '.gitignore');
if (existsSync(gitignorePath)) {
  const gitignore = readFileSync(gitignorePath, 'utf8');
  for (const pattern of ['data/', '.env', 'profiles/*', 'public/', 'worker/.dev.vars']) {
    if (!gitignore.includes(pattern)) failures.push(`.gitignore is missing ${pattern}`);
  }
}

const shrinkwrap = readFileSync(resolve(PROJECT_ROOT, 'npm-shrinkwrap.json'), 'utf8');
for (const match of shrinkwrap.matchAll(/"resolved"\s*:\s*"([^"]+)"/g)) {
  const resolvedUrl = match[1];
  if (resolvedUrl && !resolvedUrl.startsWith('https://registry.npmjs.org/')) {
    failures.push(`npm-shrinkwrap.json contains a non-public package URL: ${resolvedUrl}`);
  }
}

const readme = readFileSync(resolve(PROJECT_ROOT, 'README.md'), 'utf8');
if (!readme.includes('npm ci --registry=https://registry.npmjs.org/')) {
  failures.push('README install instructions do not override private npm registry environments');
}
const onboardingPrompt = readFileSync(resolve(PROJECT_ROOT, 'onboarding/chatgpt-profile-prompt.md'), 'utf8');

/**
 * The prompt and the schema must agree on the dossier version.
 *
 * Asserted against the schema rather than a hardcoded number, because the
 * hardcoded version is what broke this check: the contract moved 3 -> 5 and
 * dropped `source_candidates`, and share-check kept failing on strings that
 * were correct two contracts ago. A stale pre-publication gate is worse than
 * none -- it fails for a reason nobody reads, so a real failure hides in the
 * noise. This version cannot go stale.
 */
const promptVersion = Number(/"version":\s*(\d+)/.exec(onboardingPrompt)?.[1] ?? NaN);
const versionField = (onboardingDossierSchema as unknown as {
  shape: Record<string, { safeParse: (value: unknown) => { success: boolean } } | undefined>;
}).shape.version;
if (!versionField) {
  failures.push('onboardingDossierSchema no longer has a "version" field');
} else if (!Number.isFinite(promptVersion)) {
  failures.push('ChatGPT onboarding prompt does not declare a dossier "version"');
} else if (!versionField.safeParse(promptVersion).success) {
  failures.push(
    `ChatGPT onboarding prompt declares dossier version ${promptVersion}, which onboardingDossierSchema rejects`,
  );
}

// Contract fields and the output discipline, not prose. Wording gets edited;
// these are what a downstream model actually depends on.
for (const requiredText of [
  'reading_goal',
  'attention_selection_model',
  'contextual_interests',
  'exactly one valid JSON object',
]) {
  if (!onboardingPrompt.includes(requiredText)) failures.push(`ChatGPT onboarding prompt is missing: ${requiredText}`);
}

const secretPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\bgh[opsu]_[A-Za-z0-9]{30,}\b/ },
];
for (const path of textFiles(PROJECT_ROOT)) {
  const content = readFileSync(path, 'utf8');
  for (const secret of secretPatterns) {
    if (secret.pattern.test(content)) failures.push(`${secret.name} found in ${relative(PROJECT_ROOT, path)}`);
  }
}

if (failures.length > 0) {
  console.error('Sift share check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Sift share check passed: neutral profile, portable public-registry lockfile, private-path ignores, license, CI, and basic secret scan are present.');
}
