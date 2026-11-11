import { Err, failure, Ok, capture, type Result } from '@chrome-toolbox/contracts';
import { hostPattern, type ConnectionStatus } from './llm.ts';
import { llmProtocol } from './messages.ts';
import type { SettingsStore } from './settings.ts';

/** The subset of chrome.permissions used to reach a LAN llama.cpp host. */
export type HostPermissions = {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
};
export type ConnectionPort = {
  load(this: void): Promise<Result<string>>;
  check(this: void, baseUrl: string): Promise<Result<ConnectionStatus>>;
};

// Extension pages call check from a click: Chrome only shows the host permission
// prompt during that user activation, so the permission request happens first.
export function connectionPort({
  settings,
  permissions,
  send,
}: {
  settings: SettingsStore;
  permissions: HostPermissions;
  send: (message: unknown) => Promise<unknown>;
}): ConnectionPort {
  return {
    load: async (): Promise<Result<string>> => {
      const stored = await settings.load();
      return stored.ok ? Ok(stored.value.llamaBaseUrl) : stored;
    },
    check: async (baseUrl: string): Promise<Result<ConnectionStatus>> => {
      const pattern = hostPattern(baseUrl);
      if (!pattern.ok) return pattern;
      const origins = [pattern.value];
      const granted = await capture(
        async () => (await permissions.contains({ origins })) || permissions.request({ origins }),
        'host_permission_denied',
      );
      if (!granted.ok) return granted;
      if (!granted.value) return Err(failure('host_permission_denied'));
      const current = await settings.load();
      if (!current.ok) return current;
      const saved = await settings.save({ ...current.value, llamaBaseUrl: baseUrl });
      if (!saved.ok) return saved;
      return llmProtocol.send(send, 'llm/status', { baseUrl: saved.value.llamaBaseUrl });
    },
  };
}
