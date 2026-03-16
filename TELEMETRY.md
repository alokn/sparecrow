# Telemetry

sparecrow includes optional, opt-in anonymous usage telemetry to help the maintainer understand adoption and prioritise bug fixes.

## Opt-in only

Telemetry is **disabled by default**. It is never enabled without your explicit consent:

- During `sparecrow onboard`, you are asked: *"Help improve sparecrow by sharing anonymous usage data?"* — the default answer is **no**.
- You can enable or disable telemetry at any time:
  ```bash
  sparecrow config set telemetry.enabled true   # enable
  sparecrow config set telemetry.enabled false  # disable
  ```

## What is collected

When telemetry is enabled, the following data is sent — nothing more:

| Field | Description | Example |
|-------|-------------|---------|
| `timestamp` | ISO 8601 event timestamp | `2026-03-16T10:00:00.000Z` |
| `installationId` | Random UUID generated once per install (not tied to any user identity) | `a1b2c3d4-...` |
| `eventType` | One of: `command_run`, `error`, `daemon_start`, `daemon_stop` | `command_run` |
| `commandName` | CLI command name only (no arguments or flags) | `status` |
| `errorCode` | ScrowError code only (no message or stack trace) | `CONFIG_INVALID` |
| `osPlatform` | Operating system | `linux`, `darwin`, `win32` |
| `osArch` | CPU architecture | `x64`, `arm64` |
| `nodeMajorVersion` | Node.js major version number | `22` |
| `sparecrowVersion` | sparecrow package version | `1.0.0` |

## What is never collected

- Task prompts or custom prompt text
- Repository paths or file paths
- OAuth tokens or credentials
- Environment variables
- IP addresses (not logged server-side)
- Any personally identifiable information (PII)
- Command arguments or flags
- Error messages or stack traces

## How it works

1. Events are buffered in memory during CLI command execution or daemon polling cycles.
2. Buffered events are batched and sent via HTTPS POST to the telemetry endpoint.
3. If the endpoint is unreachable, events are **silently dropped** — no retry, no local queue.
4. Telemetry **never blocks or delays** CLI commands or daemon operations.

## Transparency

You can see exactly what data is being shared:

```bash
sparecrow config get telemetry
```

This displays:
- Whether telemetry is enabled
- Your installation ID
- The endpoint URL
- The last 10 events sent (from a local ring buffer)

## Installation ID

A random UUID is generated once and stored in the state directory (`telemetry-id` file). It is:
- Not tied to any user identity, account, or machine fingerprint
- Not deleted when telemetry is disabled (re-enabling does not create a new identity)
- Used only to deduplicate events and estimate unique install counts

## Endpoint

Events are sent to: `https://telemetry.sparecrow.dev/v1/events`

The endpoint URL is configurable via:
```bash
sparecrow config set telemetry.endpoint https://your-endpoint.example.com/events
```

## Payload schema

```json
{
  "events": [
    {
      "timestamp": "2026-03-16T10:00:00.000Z",
      "installationId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      "eventType": "command_run",
      "commandName": "status",
      "errorCode": null,
      "osPlatform": "linux",
      "osArch": "x64",
      "nodeMajorVersion": 22,
      "sparecrowVersion": "1.0.0"
    }
  ]
}
```
