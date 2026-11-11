# ui

Shared React components. They receive their data through adapters passed as props, so they work in an extension side panel, in the `web` app and in jsdom tests without knowing where the data comes from.

## Status

| Component         | Used by                     | Purpose                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConnectionPanel` | All three extensions        | The side panel's llama.cpp connection form: the "llama.cpp の接続先" URL field (filled with the stored URL unless the viewer typed first), the "接続を確認" button and a status line (`<output data-status>`) with the model names or a Japanese error message. Adapter: `ConnectionAdapter` (`load`, `check`). |
| `NotesPanel`      | `web` (template sample app) | Notes list with loading, empty, error, add, delete and export states. Adapter: `NotesAdapter`.                                                                                                                                                                                                                  |

The extensions build the `ConnectionAdapter` with `connectionPort` from [`extension-core`](../extension-core/README.md). Components return to a usable state on every adapter failure; they never throw.

## Use

```tsx
import { ConnectionPanel } from '@chrome-toolbox/ui';

<ConnectionPanel title="コメントアシスタント" adapter={sidePanelPort()} />;
```

The extensions' Tailwind CSS scans this package's sources (`@source '../../../../ui/src'` in each side panel's `style.css`), so the components need no stylesheet of their own.

## Development and tests

From the repository root:

```console
pnpm --filter @chrome-toolbox/ui test
pnpm --filter @chrome-toolbox/ui check
pnpm --filter @chrome-toolbox/ui build
```

`test` runs Vitest with Testing Library in jsdom (`src/*.test.tsx`): every connection result and error message, a URL typed before the stored one loads, a stored-settings failure, and the notes states. `build` packs `src/index.tsx` with type declarations (`vp pack`).
