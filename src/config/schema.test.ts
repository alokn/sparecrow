/** Unit tests for config schema — execution_backend and container config fields. */
import { describe, it, expect } from 'vitest';
import { ScrowConfigSchema } from './schema.js';

describe('ScrowConfigSchema — execution_backend', () => {
  it('defaults execution_backend to "container" when omitted', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.provider.executionBackend).toBe('container');
  });

  it('includes executionBackend: "container" in transformed output when entire provider block is absent (full round-trip default expansion)', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.provider).toHaveProperty('executionBackend');
    expect(result.provider.executionBackend).toBe('container');
    expect(result.provider.name).toBe('claude-code');
    expect(result.provider.allowDangerouslySkipPermissions).toBe(false);
  });

  it('parses execution_backend: "container" correctly to executionBackend: "container"', () => {
    const result = ScrowConfigSchema.parse({
      provider: { execution_backend: 'container' },
    });
    expect(result.provider.executionBackend).toBe('container');
  });

  it('rejects execution_backend: "direct" with actionable error message', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { execution_backend: 'direct' },
      }),
    ).toThrow(
      "execution_backend 'direct' is no longer supported. Run 'sparecrow onboard' to reconfigure.",
    );
  });

  it('rejects invalid execution_backend value "docker"', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { execution_backend: 'docker' },
      }),
    ).toThrow();
  });

  it('rejects empty string for execution_backend', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { execution_backend: '' },
      }),
    ).toThrow();
  });

  it('rejects unsupported execution_backend value "kubernetes"', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { execution_backend: 'kubernetes' },
      }),
    ).toThrow();
  });
});

describe('ScrowConfigSchema — container config', () => {
  // 7.1: full container block with all fields parses correctly with snake_case-to-camelCase transform
  it('parses full container block with snake_case-to-camelCase transform', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        execution_backend: 'container',
        container: {
          runtime: 'docker',
          image: 'ubuntu:22.04',
          memory_limit_mb: 1024,
          cpu_limit: 2.0,
          network_mode: 'none',
          mount_claude_config: false,
        },
      },
    });

    expect(result.provider.container).toEqual({
      runtime: 'docker',
      image: 'ubuntu:22.04',
      memoryLimitMb: 1024,
      cpuLimit: 2.0,
      networkMode: 'none',
      mountClaudeConfig: false,
      mountClaudeConfigReadonly: true,
    });
  });

  // 7.2: missing container section produces undefined on ProviderConfig.container
  it('produces undefined for provider.container when container section is absent', () => {
    const result = ScrowConfigSchema.parse({
      provider: { execution_backend: 'container' },
    });

    expect(result.provider.container).toBeUndefined();
  });

  // 7.3: execution_backend: container without container section parses without error (AC4)
  it('parses execution_backend: container without container section without error', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { execution_backend: 'container' },
      }),
    ).not.toThrow();
  });

  // 7.4: partial container block fills defaults for all other fields
  it('fills defaults for unspecified container fields when partial block is provided', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        execution_backend: 'container',
        container: { memory_limit_mb: 1024 },
      },
    });

    expect(result.provider.container).toEqual({
      runtime: 'auto',
      image: 'node:lts-slim',
      memoryLimitMb: 1024,
      cpuLimit: 1.0,
      networkMode: 'bridge',
      mountClaudeConfig: true,
      mountClaudeConfigReadonly: true,
    });
  });

  // 7.5: memory_limit_mb below 64 is rejected; above 65536 is rejected
  it('rejects memory_limit_mb below 64', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { memory_limit_mb: 63 } },
      }),
    ).toThrow();
  });

  it('rejects memory_limit_mb above 65536', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { memory_limit_mb: 65537 } },
      }),
    ).toThrow();
  });

  // 7.5a: boundary values accepted
  it('accepts memory_limit_mb: 64 (exact minimum boundary)', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { memory_limit_mb: 64 } },
    });
    expect(result.provider.container!.memoryLimitMb).toBe(64);
  });

  it('accepts memory_limit_mb: 65536 (exact maximum boundary)', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { memory_limit_mb: 65536 } },
    });
    expect(result.provider.container!.memoryLimitMb).toBe(65536);
  });

  // 7.6: cpu_limit below 0.1 is rejected; above 128.0 is rejected
  it('rejects cpu_limit below 0.1', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { cpu_limit: 0.05 } },
      }),
    ).toThrow();
  });

  it('rejects cpu_limit above 128.0', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { cpu_limit: 128.1 } },
      }),
    ).toThrow();
  });

  // 7.6a: cpu_limit: 0.0 is rejected
  it('rejects cpu_limit: 0.0 (zero is below minimum 0.1)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { cpu_limit: 0.0 } },
      }),
    ).toThrow();
  });

  // 7.6b: boundary values accepted
  it('accepts cpu_limit: 0.1 (exact minimum boundary)', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { cpu_limit: 0.1 } },
    });
    expect(result.provider.container!.cpuLimit).toBeCloseTo(0.1);
  });

  it('accepts cpu_limit: 128.0 (exact maximum boundary)', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { cpu_limit: 128.0 } },
    });
    expect(result.provider.container!.cpuLimit).toBe(128.0);
  });

  // 7.7: network_mode: 'overlay' is rejected (invalid enum value)
  it('rejects network_mode: "overlay" (invalid enum value)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { network_mode: 'overlay' } },
      }),
    ).toThrow();
  });

  // 7.8: runtime: 'kubernetes' is rejected (invalid enum value)
  it('rejects runtime: "kubernetes" (invalid enum value)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { runtime: 'kubernetes' } },
      }),
    ).toThrow();
  });

  // 7.9: image: '' (empty string) is rejected
  it('rejects image: "" (empty string)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { image: '' } },
      }),
    ).toThrow();
  });

  // 7.9a: image: '   ' (whitespace-only) is rejected by trim().min(1)
  it('rejects image: "   " (whitespace-only string, trimmed to empty)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { image: '   ' } },
      }),
    ).toThrow();
  });

  // 7.10: default config (empty input {}) produces provider.container as undefined
  it('produces provider.container as undefined for default config (empty input {})', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.provider.container).toBeUndefined();
  });

  // 7.11: container: {} (empty container block) fills ALL defaults
  it('fills all defaults when container: {} (empty block) is provided', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: {} },
    });

    expect(result.provider.container).toEqual({
      runtime: 'auto',
      image: 'node:lts-slim',
      memoryLimitMb: 512,
      cpuLimit: 1.0,
      networkMode: 'bridge',
      mountClaudeConfig: true,
      mountClaudeConfigReadonly: true,
    });
  });

  // Extra fields (like legacy fallback) are silently stripped by Zod
  it('silently strips legacy fallback field from container block', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { fallback: 'none' } },
    });
    // fallback no longer exists in the output type
    expect(result.provider.container).not.toHaveProperty('fallback');
  });
});

describe('ScrowConfigSchema — container claude_binary_path', () => {
  // 10.5 3.1: claude_binary_path is optional and absent by default
  it('produces claudeBinaryPath as undefined when claude_binary_path is absent from container block', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: {} },
    });
    expect(result.provider.container!.claudeBinaryPath).toBeUndefined();
  });

  // 10.5 3.2: claude_binary_path is parsed and transformed correctly
  it('parses claude_binary_path and transforms to claudeBinaryPath', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        container: { claude_binary_path: '/usr/local/bin/claude' },
      },
    });
    expect(result.provider.container!.claudeBinaryPath).toBe('/usr/local/bin/claude');
  });

  // 10.5 3.3: empty string is rejected (min(1))
  it('rejects claude_binary_path: "" (empty string)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { claude_binary_path: '' } },
      }),
    ).toThrow();
  });

  // 10.5: whitespace-only string is rejected (trim().min(1))
  it('rejects claude_binary_path: "   " (whitespace-only string)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { claude_binary_path: '   ' } },
      }),
    ).toThrow();
  });

  // 10.5: claude_binary_path included in full round-trip
  it('includes claudeBinaryPath in full container config round-trip', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        execution_backend: 'container',
        container: {
          runtime: 'docker',
          image: 'node:lts-slim',
          memory_limit_mb: 512,
          cpu_limit: 1.0,
          network_mode: 'bridge',
          mount_claude_config: true,
          claude_binary_path: '/opt/claude/cli.js',
        },
      },
    });
    expect(result.provider.container).toEqual({
      runtime: 'docker',
      image: 'node:lts-slim',
      memoryLimitMb: 512,
      cpuLimit: 1.0,
      networkMode: 'bridge',
      mountClaudeConfig: true,
      mountClaudeConfigReadonly: true,
      claudeBinaryPath: '/opt/claude/cli.js',
    });
  });
});

describe('ScrowConfigSchema — env_strip_patterns', () => {
  // 8.1: parses env_strip_patterns correctly and transforms to envStripPatterns
  it('parses env_strip_patterns and transforms to envStripPatterns', () => {
    const result = ScrowConfigSchema.parse({
      provider: { env_strip_patterns: ['CUSTOM_*', 'MY_SECRET'] },
    });
    expect(result.provider.envStripPatterns).toEqual(['CUSTOM_*', 'MY_SECRET']);
  });

  // 8.2: omitting env_strip_patterns produces envStripPatterns === undefined
  it('produces provider.envStripPatterns as undefined when env_strip_patterns is absent', () => {
    const result = ScrowConfigSchema.parse({
      provider: { name: 'claude-code' },
    });
    expect(result.provider.envStripPatterns).toBeUndefined();
  });

  // 8.3: when entire provider block is omitted, envStripPatterns is undefined
  it('produces provider.envStripPatterns as undefined when entire provider block is omitted (default expansion)', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.provider.envStripPatterns).toBeUndefined();
  });

  // 8.4: env_strip_patterns: [] is valid (empty array)
  it('accepts env_strip_patterns: [] (empty array, no additional patterns)', () => {
    const result = ScrowConfigSchema.parse({
      provider: { env_strip_patterns: [] },
    });
    expect(result.provider.envStripPatterns).toEqual([]);
  });

  // 8.5: env_strip_patterns: [''] is rejected (empty string in array)
  it('rejects env_strip_patterns: [""] (empty string in array, z.string().min(1))', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { env_strip_patterns: [''] },
      }),
    ).toThrow();
  });

  // 8.6: env_strip_patterns with null as an array element is rejected by Zod
  it('rejects env_strip_patterns with null as an array element', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { env_strip_patterns: [null] },
      }),
    ).toThrow();
  });

  // 8.7: env_strip_patterns set to a non-array value is rejected by Zod
  it('rejects env_strip_patterns set to a non-array value (e.g. a string)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { env_strip_patterns: 'CUSTOM_*' },
      }),
    ).toThrow();
  });
});

describe('ScrowConfigSchema — container mount_claude_binary', () => {
  // 10.7 4.6a: mount_claude_binary is optional and absent by default
  it('produces mountClaudeBinary as undefined when mount_claude_binary is absent from container block', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: {} },
    });
    expect(result.provider.container!.mountClaudeBinary).toBeUndefined();
  });

  // 10.7 4.6b: mount_claude_binary: true is parsed correctly
  it('parses mount_claude_binary: true and transforms to mountClaudeBinary: true', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        container: { mount_claude_binary: true },
      },
    });
    expect(result.provider.container!.mountClaudeBinary).toBe(true);
  });

  // 10.7 4.6c: mount_claude_binary: false is parsed correctly
  it('parses mount_claude_binary: false and transforms to mountClaudeBinary: false', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        container: { mount_claude_binary: false },
      },
    });
    expect(result.provider.container!.mountClaudeBinary).toBe(false);
  });

  // 10.7 4.6d: non-boolean value is rejected
  it('rejects mount_claude_binary: "yes" (non-boolean)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { mount_claude_binary: 'yes' } },
      }),
    ).toThrow();
  });

  // 10.7 4.6e: numeric value is rejected
  it('rejects mount_claude_binary: 1 (numeric, not boolean)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { mount_claude_binary: 1 } },
      }),
    ).toThrow();
  });

  // 10.7 4.6f: includes mountClaudeBinary in full round-trip
  it('includes mountClaudeBinary in full container config round-trip', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        execution_backend: 'container',
        container: {
          runtime: 'docker',
          image: 'ghcr.io/13rac1/openclaw-claude-code:latest',
          memory_limit_mb: 1024,
          cpu_limit: 2.0,
          network_mode: 'bridge',
          mount_claude_config: true,
          mount_claude_binary: false,
        },
      },
    });
    expect(result.provider.container).toEqual({
      runtime: 'docker',
      image: 'ghcr.io/13rac1/openclaw-claude-code:latest',
      memoryLimitMb: 1024,
      cpuLimit: 2.0,
      networkMode: 'bridge',
      mountClaudeConfig: true,
      mountClaudeConfigReadonly: true,
      mountClaudeBinary: false,
    });
  });

  // 10.7: mount_claude_binary absent does not include mountClaudeBinary key in output
  it('does not include mountClaudeBinary key when mount_claude_binary is not provided', () => {
    const result = ScrowConfigSchema.parse({
      provider: {
        container: { image: 'node:lts-slim' },
      },
    });
    expect('mountClaudeBinary' in result.provider.container!).toBe(false);
  });
});

describe('ScrowConfigSchema — container mount_claude_config_readonly', () => {
  // 22.1 AC4: defaults to true when not specified
  it('defaults mount_claude_config_readonly to true', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: {} },
    });
    expect(result.provider.container!.mountClaudeConfigReadonly).toBe(true);
  });

  // 22.1 AC4: explicit false is accepted
  it('parses mount_claude_config_readonly: false', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { mount_claude_config_readonly: false } },
    });
    expect(result.provider.container!.mountClaudeConfigReadonly).toBe(false);
  });

  // 22.1: explicit true is accepted
  it('parses mount_claude_config_readonly: true', () => {
    const result = ScrowConfigSchema.parse({
      provider: { container: { mount_claude_config_readonly: true } },
    });
    expect(result.provider.container!.mountClaudeConfigReadonly).toBe(true);
  });

  // 22.1: non-boolean value rejected
  it('rejects mount_claude_config_readonly: "yes" (non-boolean)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        provider: { container: { mount_claude_config_readonly: 'yes' } },
      }),
    ).toThrow();
  });
});

describe('ScrowConfigSchema — wsl_mount_prefix', () => {
  // 22.4 AC2: defaults to /mnt/ when not specified
  it('defaults wsl_mount_prefix to /mnt/', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.wslMountPrefix).toBe('/mnt/');
  });

  // 22.4 AC2: custom prefix is accepted
  it('parses wsl_mount_prefix: /media/ correctly', () => {
    const result = ScrowConfigSchema.parse({ wsl_mount_prefix: '/media/' });
    expect(result.wslMountPrefix).toBe('/media/');
  });

  // 22.4: prefix must end with /
  it('rejects wsl_mount_prefix without trailing slash', () => {
    expect(() => ScrowConfigSchema.parse({ wsl_mount_prefix: '/mnt' })).toThrow();
  });

  // 22.4: empty string is rejected
  it('rejects wsl_mount_prefix: "" (empty string)', () => {
    expect(() => ScrowConfigSchema.parse({ wsl_mount_prefix: '' })).toThrow();
  });

  // 22.4: whitespace-only is rejected (trim + min(1))
  it('rejects wsl_mount_prefix: "   " (whitespace-only)', () => {
    expect(() => ScrowConfigSchema.parse({ wsl_mount_prefix: '   ' })).toThrow();
  });

  // 22.4: single slash is rejected — would classify every absolute path as a WSL Windows path
  it('rejects wsl_mount_prefix: "/" (single slash — would bypass all permission checks)', () => {
    expect(() => ScrowConfigSchema.parse({ wsl_mount_prefix: '/' })).toThrow();
  });
});

describe('ScrowConfigSchema — capacity intelligence trigger fields', () => {
  // Task 5.2: empty input returns new trigger field defaults
  it('returns trigger.maxWastePercentage: 50 and trigger.weeklyReservePercentage: 30 for empty input (AC5)', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.trigger.maxWastePercentage).toBe(50);
    expect(result.trigger.weeklyReservePercentage).toBe(30);
  });

  // Task 5.3: custom max_waste_percentage is preserved
  it('returns trigger.maxWastePercentage: 70 when max_waste_percentage: 70 is set', () => {
    const result = ScrowConfigSchema.parse({ trigger: { max_waste_percentage: 70 } });
    expect(result.trigger.maxWastePercentage).toBe(70);
  });

  // Task 5.4: max_waste_percentage above 100 is rejected
  it('throws when max_waste_percentage: 101 is set (above range)', () => {
    expect(() => ScrowConfigSchema.parse({ trigger: { max_waste_percentage: 101 } })).toThrow();
  });

  // Task 5.5: weekly_reserve_percentage below 0 is rejected
  it('throws when weekly_reserve_percentage: -1 is set (below range)', () => {
    expect(() => ScrowConfigSchema.parse({ trigger: { weekly_reserve_percentage: -1 } })).toThrow();
  });
});

describe('ScrowConfigSchema — idle_hours', () => {
  // 15.3 Task 2.1: idle_hours defaults to empty array when omitted
  it('defaults idle_hours to empty array when omitted', () => {
    const result = ScrowConfigSchema.parse({});
    expect(result.trigger.idleHours).toEqual([]);
  });

  // 15.3 Task 2.1: simple idle_hours entry parses correctly
  it('parses simple idle_hours entry with start and end', () => {
    const result = ScrowConfigSchema.parse({
      trigger: {
        idle_hours: [{ start: '00:00', end: '06:00' }],
      },
    });
    expect(result.trigger.idleHours).toEqual([{ start: '00:00', end: '06:00' }]);
  });

  // 15.3 Task 2.1: idle_hours with days field parses correctly
  it('parses idle_hours entry with days field', () => {
    const result = ScrowConfigSchema.parse({
      trigger: {
        idle_hours: [{ start: '00:00', end: '23:59', days: ['saturday', 'sunday'] }],
      },
    });
    expect(result.trigger.idleHours).toEqual([
      { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] },
    ]);
  });

  // 15.3 Task 2.1: multiple idle_hours entries
  it('parses multiple idle_hours entries', () => {
    const result = ScrowConfigSchema.parse({
      trigger: {
        idle_hours: [
          { start: '00:00', end: '06:00' },
          { start: '22:00', end: '06:00' },
          { start: '00:00', end: '23:59', days: ['saturday', 'sunday'] },
        ],
      },
    });
    expect(result.trigger.idleHours).toHaveLength(3);
  });

  // 15.3 AC6: invalid HH:MM format — start
  it('rejects invalid start time format "25:00"', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '25:00', end: '06:00' }] },
      }),
    ).toThrow();
  });

  // 15.3 AC6: invalid HH:MM format — end
  it('rejects invalid end time format "12:60"', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '00:00', end: '12:60' }] },
      }),
    ).toThrow();
  });

  // 15.3 AC6: invalid HH:MM format — missing leading zero
  it('rejects time without leading zero "9:00"', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '9:00', end: '17:00' }] },
      }),
    ).toThrow();
  });

  // 15.3 AC6: invalid day name
  it('rejects invalid day name', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '00:00', end: '06:00', days: ['notaday'] }] },
      }),
    ).toThrow();
  });

  // 15.3 AC6: empty days array rejected (min(1))
  it('rejects empty days array (min 1)', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '00:00', end: '06:00', days: [] }] },
      }),
    ).toThrow();
  });

  // 15.3: non-array idle_hours is rejected
  it('rejects non-array idle_hours value', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: 'not-an-array' },
      }),
    ).toThrow();
  });

  // 15.3: missing start field is rejected
  it('rejects idle_hours entry missing start', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ end: '06:00' }] },
      }),
    ).toThrow();
  });

  // 15.3: missing end field is rejected
  it('rejects idle_hours entry missing end', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '00:00' }] },
      }),
    ).toThrow();
  });

  // 15.3: all valid day names accepted
  it('accepts all valid day names', () => {
    const result = ScrowConfigSchema.parse({
      trigger: {
        idle_hours: [
          {
            start: '00:00',
            end: '06:00',
            days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
          },
        ],
      },
    });
    expect(result.trigger.idleHours[0]!.days).toHaveLength(7);
  });

  // 15.3: duplicate day names rejected
  it('rejects duplicate day names in days array', () => {
    expect(() =>
      ScrowConfigSchema.parse({
        trigger: { idle_hours: [{ start: '00:00', end: '06:00', days: ['monday', 'monday'] }] },
      }),
    ).toThrow();
  });

  // 15.3: overnight range (start > end) is valid in schema (no schema-level prohibition)
  it('accepts overnight range where start > end (e.g. 22:00-06:00)', () => {
    const result = ScrowConfigSchema.parse({
      trigger: { idle_hours: [{ start: '22:00', end: '06:00' }] },
    });
    expect(result.trigger.idleHours[0]).toEqual({ start: '22:00', end: '06:00' });
  });

  // 15.3: whitespace trimming in time values
  it('trims whitespace in time values', () => {
    const result = ScrowConfigSchema.parse({
      trigger: { idle_hours: [{ start: ' 00:00 ', end: ' 06:00 ' }] },
    });
    expect(result.trigger.idleHours[0]).toEqual({ start: '00:00', end: '06:00' });
  });

  // 15.3: days field absent produces no days key in output
  it('omits days key when not specified', () => {
    const result = ScrowConfigSchema.parse({
      trigger: { idle_hours: [{ start: '00:00', end: '06:00' }] },
    });
    expect('days' in result.trigger.idleHours[0]!).toBe(false);
  });

  // 15.4: idle_hours coexists with capacity intelligence trigger fields
  it('coexists with capacity intelligence trigger fields', () => {
    const result = ScrowConfigSchema.parse({
      trigger: {
        max_waste_percentage: 60,
        weekly_reserve_percentage: 20,
        idle_hours: [{ start: '00:00', end: '06:00' }],
      },
    });
    expect(result.trigger.maxWastePercentage).toBe(60);
    expect(result.trigger.weeklyReservePercentage).toBe(20);
    expect(result.trigger.idleHours).toEqual([{ start: '00:00', end: '06:00' }]);
  });
});
