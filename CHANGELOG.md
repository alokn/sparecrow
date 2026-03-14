# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.1] - 2026-03-14

First public beta release.

### Added

- **Capacity Intelligence** — waste potential calculation, idle hours scheduling, weekly reserve percentage for optimising Claude Code subscription usage
- **Container Execution** — Docker/Podman isolated task dispatch with credential mounting and security boundaries
- **Active Templates** — fix-bugs, improve-code, write-tests, and security-audit with structured action requests
- **Action Request Protocol** — post-execution git operations (branch, push, PR) running on host outside the container
- **Security Hardening** — environment variable stripping, audit log file permissions, YAML alias limits, git ref validation
- **Comprehensive CLI** — 15+ commands including `status`, `queue`, `results`, `doctor`, `refresh`, `why`, and more
- **Background Daemon** — polling loop with configurable intervals, PID file management, and health checks
- **Audit Logging** — daily-rotated JSONL audit logs with 30-day default retention

## [0.x.x] — Internal Development

Internal alpha versions (`0.1.0` through `0.9.0`). Not publicly announced.

[1.0.0-beta.1]: https://github.com/alokn/sparecrow/releases/tag/v1.0.0-beta.1
[0.x.x]: https://github.com/alokn/sparecrow/compare
[Known issues]: https://github.com/alokn/sparecrow/issues
