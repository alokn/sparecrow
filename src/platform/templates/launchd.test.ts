/** Unit tests for generateLaunchdPlist — verifies generated plist format and required keys. */
import { describe, it, expect } from 'vitest';
import { generateLaunchdPlist } from './launchd.js';
import type { ServiceTemplateOpts } from '../../types/index.js';

const baseOpts: ServiceTemplateOpts = {
  nodePath: '/usr/local/bin/node',
  entrypoint: '/usr/local/lib/node_modules/sparecrow/dist/index.js',
  configPath: '/Users/user/Library/Application Support/sparecrow/config.yaml',
  dataPath: '/Users/user/Library/Application Support/sparecrow',
  daemonRunnerFlag: '--daemon-runner',
};

describe('generateLaunchdPlist()', () => {
  it('generates valid XML plist opening tags', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('</plist>');
  });

  it('contains the correct Label key', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.sparecrow.daemon</string>');
  });

  it('contains ProgramArguments with nodePath, entrypoint, and daemonRunnerFlag', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain(`<string>${baseOpts.nodePath}</string>`);
    expect(plist).toContain(`<string>${baseOpts.entrypoint}</string>`);
    expect(plist).toContain(`<string>${baseOpts.daemonRunnerFlag}</string>`);
  });

  it('contains RunAtLoad set to true', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
  });

  it('contains KeepAlive set to true', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>KeepAlive</key>');
    // true appears at least twice (RunAtLoad and KeepAlive)
    const trueCount = (plist.match(/<true\/>/g) ?? []).length;
    expect(trueCount).toBeGreaterThanOrEqual(2);
  });

  it('contains EnvironmentVariables with SPARECROW_CONFIG_PATH', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>SPARECROW_CONFIG_PATH</key>');
    expect(plist).toContain(`<string>${baseOpts.configPath}</string>`);
  });

  it('contains EnvironmentVariables with SPARECROW_DATA_PATH', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>SPARECROW_DATA_PATH</key>');
    expect(plist).toContain(`<string>${baseOpts.dataPath}</string>`);
  });

  it('contains StandardOutPath pointing to logs/daemon.log', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain(`${baseOpts.dataPath}/logs/daemon.log`);
  });

  it('contains StandardErrorPath pointing to logs/daemon-error.log', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain(`${baseOpts.dataPath}/logs/daemon-error.log`);
  });

  it('accepts custom daemonRunnerFlag value', () => {
    const opts: ServiceTemplateOpts = { ...baseOpts, daemonRunnerFlag: '--custom-flag' };
    const plist = generateLaunchdPlist(opts);
    expect(plist).toContain('<string>--custom-flag</string>');
    expect(plist).not.toContain('<string>--daemon-runner</string>');
  });

  it('contains ExitTimeOut set to 15 seconds for launchd force-kill (AC7)', () => {
    const plist = generateLaunchdPlist(baseOpts);
    expect(plist).toContain('<key>ExitTimeOut</key>');
    expect(plist).toContain('<integer>15</integer>');
  });

  it('escapes XML special characters in paths', () => {
    const opts: ServiceTemplateOpts = {
      ...baseOpts,
      nodePath: '/usr/local/bin/node&v22',
      configPath: '/Users/user/Library/Application Support/sparecrow/config<1>.yaml',
      dataPath: '/Users/user/data>dir',
    };
    const plist = generateLaunchdPlist(opts);
    // Raw unescaped characters must not appear inside string elements
    expect(plist).not.toContain('<string>/usr/local/bin/node&v22</string>');
    expect(plist).not.toContain(
      '<string>/Users/user/Library/Application Support/sparecrow/config<1>.yaml</string>',
    );
    // Escaped forms must be present
    expect(plist).toContain('node&amp;v22');
    expect(plist).toContain('config&lt;1&gt;.yaml');
    expect(plist).toContain('data&gt;dir');
  });
});
