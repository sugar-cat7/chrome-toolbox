import { useEffect, useRef, useState } from 'react';
import { launch, type AppError, type Result } from '@chrome-toolbox/contracts';

export type ConnectionAdapter = {
  load(this: void): Promise<Result<string>>;
  check(this: void, baseUrl: string): Promise<Result<{ models: readonly string[] }>>;
};
type State =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'connected'; models: readonly string[] }
  | { status: 'failed'; message: string };

const messages: Partial<Record<AppError['internalCode'], string>> = {
  input_invalid: 'URL の形式が正しくありません（例: http://127.0.0.1:18083）。',
  host_permission_denied: 'この接続先へのアクセスが許可されませんでした。',
  network_failed: 'llama.cpp に接続できません。サーバーの起動と URL を確認してください。',
  response_invalid: 'llama.cpp から想定外の応答がありました。',
  storage_failed: '設定を保存できませんでした。',
  ipc_failed: '拡張機能の内部通信に失敗しました。パネルを開き直してください。',
};
const explain = (error: AppError): string =>
  messages[error.internalCode] ?? '接続確認に失敗しました。';
const label = (state: State): string => {
  switch (state.status) {
    case 'idle':
      return '未確認';
    case 'checking':
      return '確認中…';
    case 'connected':
      return `接続済み（モデル: ${state.models.join(', ') || 'なし'}）`;
    case 'failed':
      return state.message;
  }
};

/** llama.cpp endpoint setting shared by every extension's side panel. */
export function ConnectionPanel({ title, adapter }: { title: string; adapter: ConnectionAdapter }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const mounted = useRef(true);
  /** The viewer has typed in the field: the stored URL, read afterwards, must not replace it. */
  const edited = useRef(false);
  useEffect(() => {
    mounted.current = true;
    launch(
      async () => {
        const stored = await adapter.load();
        if (!mounted.current) return;
        if (!stored.ok) setState({ status: 'failed', message: explain(stored.error) });
        else if (!edited.current) setBaseUrl(stored.value);
      },
      (error) => {
        if (mounted.current) setState({ status: 'failed', message: explain(error) });
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [adapter]);

  return (
    <section aria-label={title} className="flex flex-col gap-3 p-4 text-sm">
      <h1 className="text-base font-semibold">{title}</h1>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setState({ status: 'checking' });
          launch(
            async () => {
              const result = await adapter.check(baseUrl);
              if (!mounted.current) return;
              setState(
                result.ok
                  ? { status: 'connected', models: result.value.models }
                  : { status: 'failed', message: explain(result.error) },
              );
            },
            (error) => {
              if (mounted.current) setState({ status: 'failed', message: explain(error) });
            },
          );
        }}
      >
        <label htmlFor="llama-base-url" className="font-medium">
          llama.cpp の接続先
        </label>
        <input
          id="llama-base-url"
          name="baseUrl"
          type="url"
          required
          value={baseUrl}
          onChange={(event) => {
            edited.current = true;
            setBaseUrl(event.target.value);
          }}
          placeholder="http://127.0.0.1:18083"
          className="rounded border px-2 py-1"
        />
        <button
          type="submit"
          disabled={state.status === 'checking'}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          接続を確認
        </button>
      </form>
      <output aria-live="polite" data-status={state.status} className="block">
        {label(state)}
      </output>
    </section>
  );
}
