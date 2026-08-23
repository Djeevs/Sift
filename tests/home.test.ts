import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT, resolveHome } from '../src/config/index.js';
import { profileDirectory } from '../src/onboarding/index.js';

const original = process.env.SIFT_HOME;
afterEach(() => {
  if (original === undefined) delete process.env.SIFT_HOME;
  else process.env.SIFT_HOME = original;
});

/**
 * PROJECT_ROOT holds what Sift reads — config defaults, prompts, the schema.
 * SIFT_HOME holds what it writes — databases, readers, tokens, logs. They are
 * the same directory in a checkout, which is why separating them changed
 * nothing for anyone working in one, and they must be separable for a packaged
 * application: an .app bundle is read-only and is replaced wholesale on update,
 * which would otherwise delete every reader and feed token.
 */
describe('state location', () => {
  it('keeps state beside the code by default', () => {
    delete process.env.SIFT_HOME;
    expect(resolveHome()).toBe(PROJECT_ROOT);
    expect(profileDirectory('alice')).toBe(resolve(PROJECT_ROOT, 'profiles', 'alice'));
  });

  it('moves readers to SIFT_HOME when set, leaving assets behind', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'sift-home-'));
    process.env.SIFT_HOME = home;
    expect(resolveHome()).toBe(home);
    expect(profileDirectory('alice')).toBe(resolve(home, 'profiles', 'alice'));
    // Assets are not relocated: they ship with the code and are read-only.
    expect(PROJECT_ROOT).not.toBe(home);
  });

  it('resolves a relative SIFT_HOME to an absolute path', () => {
    process.env.SIFT_HOME = './somewhere';
    expect(resolve(resolveHome())).toBe(resolveHome());
  });

  it('ignores an empty SIFT_HOME rather than writing to /', () => {
    process.env.SIFT_HOME = '   ';
    expect(resolveHome()).toBe(PROJECT_ROOT);
  });

  it('still refuses a profile id that would escape the directory', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'sift-home-'));
    process.env.SIFT_HOME = home;
    expect(() => profileDirectory('../escape')).toThrow();
  });

  it('does not require SIFT_HOME to exist before it is used', () => {
    const home = resolve(mkdtempSync(resolve(tmpdir(), 'sift-home-')), 'not-created-yet');
    process.env.SIFT_HOME = home;
    expect(existsSync(home)).toBe(false);
    // Callers create it; resolving must not fail or silently fall back.
    expect(profileDirectory('alice')).toBe(resolve(home, 'profiles', 'alice'));
  });
});
