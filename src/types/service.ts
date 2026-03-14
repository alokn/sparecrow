/** Type definitions for service installation and uninstallation. */

/** Options for service installation — force bypasses overwrite confirmation. */
export interface ServiceInstallOptions {
  force?: boolean;
  /** The daemon runner flag (e.g. '--daemon-runner'). Passed from the CLI layer to avoid DAG violation. Defaults to '--daemon-runner' when omitted. */
  daemonRunnerFlag?: string;
}

/** Result returned from a successful service installation. */
export interface ServiceInstallResult {
  platform: 'linux' | 'darwin';
  serviceFilePath: string;
  method: 'systemd' | 'launchd';
  overwritten: boolean;
  /** Always false — install registers for auto-start on next boot; it does not launch the daemon immediately. */
  started: boolean;
}

/** Result returned from a successful service uninstallation. */
export interface ServiceUninstallResult {
  platform: 'linux' | 'darwin';
  serviceFilePath: string;
  /** Set by the CLI layer after calling stopDaemon() before uninstallService(). */
  stopped: boolean;
  removed: boolean;
}

/** Options passed to service file template generators. */
export interface ServiceTemplateOpts {
  nodePath: string;
  entrypoint: string;
  configPath: string;
  dataPath: string;
  /** The daemon runner flag value (e.g. '--daemon-runner'). Passed from CLI layer to avoid DAG violation. */
  daemonRunnerFlag: string;
}
