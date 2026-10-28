import type { Options } from '@wdio/types';
import type { TauriCapabilities } from '@wdio/tauri-service';
const binary = process.env.STARTER_NATIVE_BINARY ?? '';

export const config: Options.Testrunner & { capabilities: TauriCapabilities[] } = {
  runner: 'local',
  onPrepare() {
    if (!binary)
      throw new Error('Run test:native to build and supply the actual native app binary');
  },
  specs: ['./test/**/*.e2e.ts'],
  maxInstances: 1,
  framework: 'mocha',
  mochaOpts: { timeout: 30_000, forbidOnly: true },
  reporters: [
    'spec',
    [
      'json',
      {
        outputDir: process.env.STARTER_NATIVE_REPORT_DIR ?? '../../artifacts/native-results',
        outputFileFormat: (options) => `results-${options.cid}.json`,
      },
    ],
  ],
  connectionRetryCount: 0,
  connectionRetryTimeout: 30_000,
  services: [
    [
      '@wdio/tauri-service',
      {
        driverProvider: 'embedded',
        embeddedPort: Number(process.env.STARTER_DRIVER_PORT),
        appBinaryPath: binary,
      },
    ],
  ],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
};
