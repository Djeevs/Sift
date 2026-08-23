import { describe, expect, it } from 'vitest';
import { LAUNCHD_SUPPORTED, buildPlist, labelFor, plistPath, serviceState } from '../src/service/launchd.js';

const plist = (over: Partial<Parameters<typeof buildPlist>[0]> = {}) => buildPlist({
  label: 'net.sift.reader.alice',
  profile: 'alice',
  node: '/usr/local/bin/node',
  logDir: '/tmp/logs',
  schedule: true,
  uiPort: 8790,
  ...over,
});

describe('background service', () => {
  it('produces a plist that starts at login and recovers from a crash', () => {
    const xml = plist();
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('net.sift.reader.alice');
    expect(xml).toContain('--profile');
  });

  /**
   * A launchd service inherits none of the shell environment it was installed
   * from. The first version left SIFT_UI_PORT out, so the service quietly used
   * a different port than the install message had just promised.
   */
  it('writes the control-panel port into the service', () => {
    expect(plist({ uiPort: 8794 })).toContain('<string>8794</string>');
    expect(plist({ uiPort: 8794 })).toContain('<key>SIFT_UI_PORT</key>');
  });

  it('only schedules runs when asked', () => {
    expect(plist({ schedule: false })).toContain('--no-schedule');
    expect(plist({ schedule: true })).not.toContain('--no-schedule');
  });

  // A profile id reaches the filesystem and an XML document; neither may break.
  it('keeps the label safe for a filename', () => {
    expect(labelFor('a/../b')).toBe('net.sift.reader.a----b');
    expect(plistPath(labelFor('alice'))).toMatch(/LaunchAgents\/net\.sift\.reader\.alice\.plist$/);
  });

  it('escapes values that would otherwise corrupt the plist', () => {
    expect(plist({ profile: 'a&b' })).toContain('a&amp;b');
    expect(plist({ profile: 'a&b' })).not.toMatch(/<string>a&b<\/string>/);
  });

  it('reports a profile with nothing installed, without throwing', () => {
    const state = serviceState('definitely-not-installed-profile');
    expect(state.installed).toBe(false);
    expect(state.running).toBe(false);
    expect(state.supported).toBe(LAUNCHD_SUPPORTED);
  });
});
