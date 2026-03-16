/** CLI entrypoint: process setup, Node.js version guard, then delegates to cli/index.ts. */

const MIN_NODE_MAJOR = 22;

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < MIN_NODE_MAJOR) {
  process.stderr.write(
    `sparecrow requires Node.js >= ${MIN_NODE_MAJOR}. You are running Node.js ${process.versions.node}. Upgrade at https://nodejs.org/\n`,
  );
  process.exit(1);
}

/** Write a crash report and display guidance to the user. */
async function handleCrash(err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Unexpected error: ${message}\n`);
  if (err instanceof Error && err.stack && process.env['DEBUG']) {
    process.stderr.write(err.stack + '\n');
  }
  try {
    const { writeCrashReport } = await import('./utils/crash-reporter.js');
    const { getPaths } = await import('./platform/index.js');
    const paths = getPaths();
    const reportPath = await writeCrashReport(err, paths.data, paths.logs, paths.config);
    if (reportPath) {
      process.stderr.write(
        `Crash report saved: ${reportPath}\nTo report: sparecrow report-crash ${reportPath}\n`,
      );
    }
  } catch {
    // Crash reporting itself must never prevent exit
  }
}

process.on('uncaughtException', (err) => {
  void handleCrash(err).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  void handleCrash(reason).finally(() => process.exit(1));
});

// Dynamic import so Node version check runs first (before any ESM parsing)
// Check if this process was spawned as the internal daemon runner
if (process.argv.includes('--daemon-runner')) {
  const { runDaemon } = await import('./daemon/runner.js');
  await runDaemon();
} else {
  const { run } = await import('./cli/index.js');
  await run();
}
