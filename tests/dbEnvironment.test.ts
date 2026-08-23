import { describe, it, expect, afterEach } from 'vitest';
import { resolveDbPath, defaultDbPath, resolveEnvironment } from '../src/config/index.js';

/**
 * Two populated database files -- data/sift.db and data/dev.db -- once diverged
 * for a whole session, with the pipeline writing one while the admin server read
 * the other. The UI showed a stale funnel and nothing said so. These lock the
 * resolution rules that stop it recurring.
 */
const saved = { env: process.env.SIFT_ENV, node: process.env.NODE_ENV, path: process.env.SIFT_DB_PATH };

afterEach(() => {
  for (const [k, v] of Object.entries({ SIFT_ENV: saved.env, NODE_ENV: saved.node, SIFT_DB_PATH: saved.path })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('database resolution', () => {
  it('gives each environment its own file', () => {
    const dev = defaultDbPath('development');
    const prod = defaultDbPath('production');
    expect(dev).not.toBe(prod);
    expect(prod).toMatch(/sift\.db$/);
    expect(dev).toMatch(/sift-dev\.db$/);
  });

  it('keeps tests off disk entirely', () => {
    expect(defaultDbPath('test')).toBe(':memory:');
  });

  it('reads the environment from SIFT_ENV, then NODE_ENV', () => {
    delete process.env.NODE_ENV;
    process.env.SIFT_ENV = 'production';
    expect(resolveEnvironment()).toBe('production');

    delete process.env.SIFT_ENV;
    process.env.NODE_ENV = 'test';
    expect(resolveEnvironment()).toBe('test');

    delete process.env.NODE_ENV;
    expect(resolveEnvironment()).toBe('development');
  });

  it('lets an explicit SIFT_DB_PATH win, for replay and migration tools', () => {
    process.env.SIFT_DB_PATH = './data/some-copy.db';
    expect(resolveDbPath()).toMatch(/data\/some-copy\.db$/);
  });

  it('resolves a relative SIFT_DB_PATH against the project root, not the cwd', () => {
    process.env.SIFT_DB_PATH = './data/x.db';
    expect(resolveDbPath().startsWith('/')).toBe(true);
  });

  it('passes :memory: through untouched', () => {
    process.env.SIFT_DB_PATH = ':memory:';
    expect(resolveDbPath()).toBe(':memory:');
  });

  it('falls back to the environment default when no path is set', () => {
    delete process.env.SIFT_DB_PATH;
    delete process.env.SIFT_ENV;
    process.env.NODE_ENV = 'production';
    expect(resolveDbPath()).toBe(defaultDbPath('production'));
  });
});
