import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { launch, publicFailure, type PublicError } from '@chrome-toolbox/contracts';
import { nativeRelay } from './native';
import './styles.css';

if (import.meta.env.MODE === 'e2e') await import('@wdio/tauri-plugin');
function Control() {
  const [message, setMessage] = useState('停止中。接続確認は手動で実行します。');
  const [error, setError] = useState<PublicError>();
  const [busy, setBusy] = useState(false);
  const failure = (error: PublicError) => {
    setError(error);
    setBusy(false);
  };
  const run = (action: 'status' | 'check' | 'restore') =>
    launch(
      async () => {
        setBusy(true);
        setError(undefined);
        if (action === 'status') {
          const result = await nativeRelay.status();
          if (!result.ok) return failure(result.error);
          setMessage('取得: ' + result.value.source + ' / 推論: ' + result.value.inference);
          setError(result.value.error);
        } else if (action === 'check') {
          const result = await nativeRelay.check();
          if (!result.ok) return failure(result.error);
          setMessage(
            'health: ' + result.value.health.status + ' / models: ' + result.value.models.status,
          );
        } else {
          const result = await nativeRelay.restore();
          if (!result.ok) return failure(result.error);
          setMessage('初期設定を復元しました。元の設定ファイルは保存されています。');
        }
        setBusy(false);
      },
      (error) => failure(publicFailure(error)),
    );
  return (
    <main>
      <h1>OBS コメント中継</h1>
      <p>フェーズ4: Rust IPC と接続の確認</p>
      <button disabled={busy} onClick={() => run('status')}>
        状態を取得
      </button>
      <button disabled={busy} onClick={() => run('check')}>
        接続を確認
      </button>
      <output>{message}</output>
      {error && (
        <div role="alert">
          <p>{error.message}</p>
          <p>{error.remediation}</p>
          <small>診断 ID: {error.diagnosticId}</small>
          {error.code === 'relay_settings_corrupt' && (
            <p>
              <button disabled={busy} onClick={() => run('restore')}>
                壊れた設定を保存して初期設定に戻す
              </button>
            </p>
          )}
        </div>
      )}
      <p>取得用 reader と engine、管理モードの起動は後続フェーズです。</p>
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
