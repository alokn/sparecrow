/** CLI entrypoint: process setup, Node.js version guard, then delegates to cli/index.ts. */

const MIN_NODE_MAJOR = 22;

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < MIN_NODE_MAJOR) {
  process.stderr.write(
    `sparecrow requires Node.js >= ${MIN_NODE_MAJOR}. You are running Node.js ${process.versions.node}. Upgrade at https://nodejs.org/\n`,
  );
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`Uncaught exception: ${err.message}\n`);
  if (err.stack && process.env['DEBUG']) process.stderr.write(err.stack + '\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`Unhandled rejection: ${message}\n`);
  process.exit(1);
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
