import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { launch, publicFailure, type PublicError, type Result } from '@chrome-toolbox/contracts';
import { createEngine } from './engine';
import { nativeRelay, type RelayStatus, type Settings, type SettingsUpdate } from './native';
import './styles.css';

if (import.meta.env.MODE === 'e2e') await import('@wdio/tauri-plugin');

const engine = createEngine();

const SOURCE_SUGGESTIONS = [
  'https://www.youtube.com/watch?v=',
  'https://youtu.be/',
  'https://www.twitch.tv/',
];

function overlayUrl(settings: Settings | undefined): string {
  if (!settings) return '';
  return `http://127.0.0.1:${settings.overlayPort}/overlay/${settings.overlayToken}`;
}

function Control() {
  const [status, setStatus] = useState<RelayStatus>();
  const [settings, setSettings] = useState<Settings>();
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('準備中…');
  const [error, setError] = useState<PublicError>();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<SettingsUpdate>({
    mode: 'external',
    baseUrl: 'http://127.0.0.1:8080',
    filterStrength: 'normal',
    translate: true,
    sourceLanguage: 'auto',
    targetLanguage: 'ja',
    display: 'both',
    maxItems: 20,
    overlayPort: 8787,
  });
  const attached = useRef(false);

  const fail = useCallback((err: PublicError) => {
    setError(err);
    setBusy(false);
  }, []);

  const refresh = useCallback(async (): Promise<Result<RelayStatus, PublicError>> => {
    const [s, set] = await Promise.all([nativeRelay.status(), nativeRelay.settings()]);
    if (s.ok) setStatus(s.value);
    else setError(s.error);
    if (set.ok) {
      setSettings(set.value);
      setForm({
        mode: set.value.mode,
        baseUrl: set.value.baseUrl,
        filterStrength: set.value.filterStrength,
        translate: set.value.translate,
        sourceLanguage: set.value.sourceLanguage,
        targetLanguage: set.value.targetLanguage,
        display: set.value.display,
        maxItems: set.value.maxItems,
        overlayPort: set.value.overlayPort,
      });
    }
    return s.ok ? { ok: true, value: s.value } : { ok: false, error: s.error };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    launch(
      async () => {
        if (!attached.current) {
          attached.current = true;
          const result = await engine.attach();
          if (!result.ok) {
            if (active) fail(result.error);
            return;
          }
        }
        if (active) {
          const refreshed = await refresh();
          if (!refreshed.ok) fail(refreshed.error);
        }
      },
      (err) => {
        if (active) fail(publicFailure(err));
      },
    );
    launch(
      async () => {
        const off = await listen('relay-status-changed', () => {
          launch(
            async () => {
              const s = await nativeRelay.status();
              if (s.ok) setStatus(s.value);
            },
            () => undefined,
          );
        });
        if (active) unlisten = off;
        else off();
      },
      () => undefined,
    );
    return () => {
      active = false;
      unlisten?.();
    };
  }, [fail, refresh]);

  const run = (action: () => Promise<Result<unknown, PublicError>>) =>
    launch(
      async () => {
        setBusy(true);
        setError(undefined);
        const result = await action();
        if (!result.ok) {
          fail(result.error);
          return;
        }
        const refreshed = await refresh();
        setBusy(false);
        if (!refreshed.ok) fail(refreshed.error);
      },
      (err) => fail(publicFailure(err)),
    );

  const refreshStatus = () =>
    launch(
      async () => {
        setBusy(true);
        setError(undefined);
        const result = await refresh();
        setBusy(false);
        if (!result.ok) {
          fail(result.error);
          return;
        }
        setMessage(`取得: ${result.value.source} / 推論: ${result.value.inference}`);
      },
      (err) => fail(publicFailure(err)),
    );

  const counters = status?.counters;
  return (
    <main>
      <h1>OBS コメント中継</h1>

      <section>
        <h2>ソース</h2>
        <input
          type="text"
          list="source-suggestions"
          placeholder="YouTube / Twitch のライブ URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <datalist id="source-suggestions">
          {SOURCE_SUGGESTIONS.map((s) => (
            <option key={s} value={s} aria-label={s} />
          ))}
        </datalist>{' '}
        <button
          disabled={busy || !url.trim()}
          onClick={() => run(() => nativeRelay.start(url.trim()))}
        >
          接続
        </button>{' '}
        <button disabled={busy} onClick={() => run(() => nativeRelay.stop())}>
          切断
        </button>{' '}
        <button disabled={busy} onClick={refreshStatus}>
          状態を取得
        </button>
        <p>
          取得: {status?.source ?? '—'} / 推論: {status?.inference ?? '—'}
        </p>
        {counters && (
          <p>
            受付 {counters.accepted} / 公開 {counters.published} / フィルタ {counters.filtered} /
            破棄 {counters.dropped} / 失敗 {counters.failed}
          </p>
        )}
      </section>

      <section>
        <h2>OBS オーバーレイ</h2>
        {overlayUrl(settings) ? (
          <p>
            <code>{overlayUrl(settings)}</code>{' '}
            <button
              onClick={() => {
                launch(
                  async () => {
                    await navigator.clipboard?.writeText(overlayUrl(settings));
                    setMessage('URL をコピーしました');
                  },
                  () => undefined,
                );
              }}
            >
              コピー
            </button>
          </p>
        ) : (
          <p>設定を読み込めませんでした。</p>
        )}
        <p>OBS のブラウザソースにこの URL を追加してください（幅 400 / 高さ 200 推奨）。</p>
      </section>

      <section>
        <h2>設定</h2>
        <div className="grid">
          <label>
            モード{' '}
            <select
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value as 'managed' | 'external' })}
            >
              <option value="external">外部 llama-server</option>
              <option value="managed">内蔵（準備中）</option>
            </select>
          </label>
          <label>
            llama-server URL{' '}
            <input
              type="text"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </label>
          <label>
            フィルタ強度{' '}
            <select
              value={form.filterStrength}
              onChange={(e) =>
                setForm({
                  ...form,
                  filterStrength: e.target.value as 'mild' | 'normal' | 'strict',
                })
              }
            >
              <option value="mild">弱</option>
              <option value="normal">標準</option>
              <option value="strict">強</option>
            </select>
          </label>
          <label>
            翻訳{' '}
            <input
              type="checkbox"
              checked={form.translate}
              onChange={(e) => setForm({ ...form, translate: e.target.checked })}
            />
          </label>
          <label>
            元言語{' '}
            <input
              type="text"
              value={form.sourceLanguage}
              onChange={(e) => setForm({ ...form, sourceLanguage: e.target.value })}
            />
          </label>
          <label>
            表示{' '}
            <select
              value={form.display}
              onChange={(e) =>
                setForm({
                  ...form,
                  display: e.target.value as 'translated' | 'original' | 'both',
                })
              }
            >
              <option value="both">原文+翻訳</option>
              <option value="translated">翻訳のみ</option>
              <option value="original">原文のみ</option>
            </select>
          </label>
          <label>
            最大件数{' '}
            <input
              type="number"
              min={1}
              max={100}
              value={form.maxItems}
              onChange={(e) => setForm({ ...form, maxItems: Number(e.target.value) })}
            />
          </label>
          <label>
            オーバーレイポート{' '}
            <input
              type="number"
              min={1}
              max={65535}
              value={form.overlayPort}
              onChange={(e) => setForm({ ...form, overlayPort: Number(e.target.value) })}
            />
          </label>
        </div>{' '}
        <button disabled={busy} onClick={() => run(() => nativeRelay.save(form))}>
          設定を保存
        </button>{' '}
        <button disabled={busy} onClick={() => run(() => nativeRelay.check())}>
          接続を確認
        </button>
      </section>

      <output>{message}</output>
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          <p>{error.remediation}</p>
          <small>診断 ID: {error.diagnosticId}</small>
          {error.code === 'relay_settings_corrupt' && (
            <p>
              <button disabled={busy} onClick={() => run(() => nativeRelay.restore())}>
                壊れた設定を保存して初期設定に戻す
              </button>
            </p>
          )}
        </div>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) document.body.textContent = 'The application could not initialize.';
else
  createRoot(root).render(
    <StrictMode>
      <Control />
    </StrictMode>,
  );
