/** Unit tests for generateSystemdUnit and quoteForSystemd — verifies unit file format and quoting edge cases. */
import { describe, it, expect } from 'vitest';
import { generateSystemdUnit, quoteForSystemd } from './systemd.js';
import type { ServiceTemplateOpts } from '../../types/index.js';

const baseOpts: ServiceTemplateOpts = {
  nodePath: '/usr/bin/node',
  entrypoint: '/usr/local/lib/node_modules/sparecrow/dist/index.js',
  configPath: '/home/user/.config/sparecrow/config.yaml',
  dataPath: '/home/user/.local/state/sparecrow',
  daemonRunnerFlag: '--daemon-runner',
};

describe('generateSystemdUnit()', () => {
  it('contains [Unit] section with Description and After=network.target', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=sparecrow daemon');
    expect(unit).toContain('After=network.target');
  });

  it('contains [Service] section with required fields', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('Environment=NODE_ENV=production');
  });

  it('embeds nodePath, entrypoint, and daemonRunnerFlag in ExecStart with systemd quoting', () => {
    const unit = generateSystemdUnit(baseOpts);
    // All values are double-quoted for systemd (Story 18.1 AC6)
    expect(unit).toContain(
      `ExecStart="${baseOpts.nodePath}" "${baseOpts.entrypoint}" "${baseOpts.daemonRunnerFlag}"`,
    );
  });

  it('quotes paths with spaces correctly in ExecStart', () => {
    const opts: ServiceTemplateOpts = {
      ...baseOpts,
      nodePath: '/home/user name/nvm/versions/node/v22.0.0/bin/node',
      entrypoint: '/home/user name/.local/bin/sparecrow',
    };
    const unit = generateSystemdUnit(opts);
    const execStartLine = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    expect(execStartLine).toBeDefined();
    // Spaces in paths must be within quoted tokens
    expect(execStartLine).toContain('"/home/user name/nvm/versions/node/v22.0.0/bin/node"');
    expect(execStartLine).toContain('"/home/user name/.local/bin/sparecrow"');
  });

  it('embeds daemonRunnerFlag in ExecStart line', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain('--daemon-runner');
    const execStartLine = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    expect(execStartLine).toBeDefined();
    expect(execStartLine).toContain('--daemon-runner');
  });

  it('embeds SPARECROW_CONFIG_PATH environment directive with quoting', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain(`Environment=SPARECROW_CONFIG_PATH="${baseOpts.configPath}"`);
  });

  it('embeds SPARECROW_DATA_PATH environment directive with quoting', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain(`Environment=SPARECROW_DATA_PATH="${baseOpts.dataPath}"`);
  });

  it('contains [Install] section with WantedBy=default.target', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('generates valid INI-style format with section headers in brackets', () => {
    const unit = generateSystemdUnit(baseOpts);
    const lines = unit.split('\n');
    const sectionHeaders = lines.filter((line) => line.startsWith('[') && line.endsWith(']'));
    expect(sectionHeaders).toContain('[Unit]');
    expect(sectionHeaders).toContain('[Service]');
    expect(sectionHeaders).toContain('[Install]');
  });

  it('accepts custom daemonRunnerFlag value', () => {
    const opts: ServiceTemplateOpts = { ...baseOpts, daemonRunnerFlag: '--custom-flag' };
    const unit = generateSystemdUnit(opts);
    expect(unit).toContain('--custom-flag');
    expect(unit).not.toContain('--daemon-runner');
  });

  it('contains KillMode=control-group for cgroup-based process cleanup (AC6)', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain('KillMode=control-group');
  });

  it('contains TimeoutStopSec=15 for SIGKILL escalation after 15s (AC6)', () => {
    const unit = generateSystemdUnit(baseOpts);
    expect(unit).toContain('TimeoutStopSec=15');
  });

  it('doubles percent signs in paths to prevent systemd specifier expansion (Story 18.1)', () => {
    const opts: ServiceTemplateOpts = {
      ...baseOpts,
      configPath: '/home/user-path/.config/%X/config.yaml',
      dataPath: '/tmp/%h/sparecrow',
    };
    const unit = generateSystemdUnit(opts);
    // Each % in input must be doubled to %% in the output
    expect(unit).toContain(
      'Environment=SPARECROW_CONFIG_PATH="/home/user-path/.config/%%X/config.yaml"',
    );
    expect(unit).toContain('Environment=SPARECROW_DATA_PATH="/tmp/%%h/sparecrow"');
    // The doubled sequences must appear in the output — no single isolated % before a non-% char
    const configLine = unit
      .split('\n')
      .find((l) => l.startsWith('Environment=SPARECROW_CONFIG_PATH'));
    expect(configLine).toBeDefined();
    // After removing all %% sequences, no % should remain
    const withoutDoubled = configLine!.replace(/%%/g, '');
    expect(withoutDoubled).not.toContain('%');
  });

  it('quotes all interpolated values including paths with spaces (Story 18.1 AC6)', () => {
    const opts: ServiceTemplateOpts = {
      nodePath: '/home/user name/bin/node',
      entrypoint: '/home/user name/lib/sparecrow/dist/index.js',
      configPath: '/home/user name/.config/sparecrow/config.yaml',
      dataPath: '/home/user name/.local/state/sparecrow',
      daemonRunnerFlag: '--daemon-runner',
    };
    const unit = generateSystemdUnit(opts);
    // No unquoted value containing a space should appear
    const lines = unit.split('\n');
    for (const line of lines) {
      if (line.startsWith('ExecStart=') || line.startsWith('Environment=SPARECROW_')) {
        // All values with spaces must be quoted
        const parts = line.split('=').slice(1).join('=');
        // Each space-containing segment must be within quotes
        const unquotedSpaces = parts.replace(/"[^"]*"/g, '').includes(' name');
        expect(unquotedSpaces, `Unquoted space found in: ${line}`).toBe(false);
      }
    }
  });
});

// Direct unit tests for quoteForSystemd() edge cases (Story 18.1 — Finding 8)
describe('quoteForSystemd()', () => {
  it('wraps a plain value in double-quotes', () => {
    expect(quoteForSystemd('/usr/bin/node')).toBe('"/usr/bin/node"');
  });

  it('wraps a value with spaces in double-quotes', () => {
    expect(quoteForSystemd('/home/user name/bin/node')).toBe('"/home/user name/bin/node"');
  });

  it('escapes backslashes', () => {
    expect(quoteForSystemd('C:\\Program Files\\node')).toBe('"C:\\\\Program Files\\\\node"');
  });

  it('escapes double-quote characters', () => {
    expect(quoteForSystemd('value"with"quotes')).toBe('"value\\"with\\"quotes"');
  });

  it('doubles percent signs to prevent systemd specifier expansion', () => {
    expect(quoteForSystemd('/home/%u/bin')).toBe('"/home/%%u/bin"');
    expect(quoteForSystemd('%h/.config')).toBe('"%%h/.config"');
    expect(quoteForSystemd('100%')).toBe('"100%%"');
  });

  it('handles a value with all special characters combined', () => {
    // backslash, double-quote, and percent all in one value
    expect(quoteForSystemd('C:\\foo"%bar')).toBe('"C:\\\\foo\\"%%bar"');
  });

  it('handles empty string', () => {
    expect(quoteForSystemd('')).toBe('""');
  });
});
