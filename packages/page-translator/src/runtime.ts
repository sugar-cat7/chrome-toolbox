import { browser } from 'wxt/browser';
import { Err, launch } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  createQueue,
  llmHandlers,
  llmProtocol,
  settingsStore,
  type ConnectionPort,
  type HostPermissions,
  type StorageArea,
} from '@chrome-toolbox/extension-core';

/** The extension APIs a side panel uses; tests pass a fake with this shape. */
export type PanelApi = {
  storage: { local: StorageArea };
  permissions: HostPermissions;
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

/** Side panel adapter: settings in extension storage, inference through the service worker. */
export function sidePanelPort(api: PanelApi = browser): ConnectionPort {
  return connectionPort({
    settings: settingsStore(api.storage.local),
    permissions: api.permissions,
    send: (message) => api.runtime.sendMessage(message),
  });
}

/** Registers the service worker's message router and returns its cleanup. */
export function startBackground(): () => void {
  // One inference at a time; a full queue answers queue_full instead of growing.
  const queue = createQueue({ concurrency: 1, maxPending: 16 });
  const route = llmProtocol.route(
    llmHandlers({ fetch: (input, init) => fetch(input, init), queue }),
  );
  function onMessage(
    message: unknown,
    _sender: unknown,
    sendResponse: (response: unknown) => void,
  ): true {
    launch(
      async () => {
        sendResponse(await route(message));
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }
  browser.runtime.onMessage.addListener(onMessage);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    queue.clear();
  };
}
