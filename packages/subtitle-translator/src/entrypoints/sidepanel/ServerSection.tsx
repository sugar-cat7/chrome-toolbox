import { useEffect, useRef, useState } from 'react';
import { launch } from '@chrome-toolbox/contracts';
import type { Settings } from '@chrome-toolbox/extension-core';
import { ConnectionPanel } from '@chrome-toolbox/ui';
import type { PanelPort } from '../../panel.ts';
import { explain } from './text.ts';

/**
 * The llama.cpp connection (the shared `ConnectionPanel`) and the model names sent to a router:
 * Gemma for translation (`models.translate`) and the speech model (`models.asr`). A saved name
 * read late never replaces one the viewer has typed; saving writes only these two names over the
 * settings read again.
 */
export function ServerSection({ port }: { port: PanelPort }) {
  const [settings, setSettings] = useState<Settings | undefined>();
  const [translate, setTranslate] = useState('');
  const [asr, setAsr] = useState('');
  const [saved, setSaved] = useState('');
  const mounted = useRef(true);
  /** Fields the viewer has typed in: the saved names, read afterwards, must not replace them. */
  const edited = useRef({ translate: false, asr: false });

  useEffect(() => {
    mounted.current = true;
    launch(
      async () => {
        const loaded = await port.settings.load();
        if (!mounted.current) return;
        if (!loaded.ok) {
          setSaved(explain(loaded.error.internalCode));
          return;
        }
        setSettings(loaded.value);
        if (!edited.current.translate) setTranslate(loaded.value.models.translate);
        if (!edited.current.asr) setAsr(loaded.value.models.asr);
      },
      () => {
        if (mounted.current) setSaved(explain('unexpected_failure'));
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [port]);

  return (
    <div className="flex flex-col gap-1">
      <ConnectionPanel title="llama.cpp の接続" adapter={port.connection} />
      <form
        className="flex flex-col gap-2 px-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (settings === undefined) return;
          launch(
            async () => {
              // Read again first: the connection check may have saved a new URL meanwhile.
              const current = await port.settings.load();
              const base = current.ok ? current.value : settings;
              const written = await port.settings.save({
                ...base,
                models: { ...base.models, translate: translate.trim(), asr: asr.trim() },
              });
              if (!mounted.current) return;
              if (written.ok) setSettings(written.value);
              setSaved(written.ok ? 'モデル名を保存しました' : explain(written.error.internalCode));
            },
            () => {
              if (mounted.current) setSaved(explain('unexpected_failure'));
            },
          );
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="font-medium">翻訳モデル（Gemma）</span>
          <input
            name="translate"
            required
            value={translate}
            onChange={(event) => {
              edited.current.translate = true;
              setTranslate(event.target.value);
            }}
            className="rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-medium">音声認識モデル</span>
          <input
            name="asr"
            required
            value={asr}
            onChange={(event) => {
              edited.current.asr = true;
              setAsr(event.target.value);
            }}
            className="rounded border px-2 py-1"
          />
        </label>
        <button
          type="submit"
          disabled={settings === undefined}
          className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          モデル名を保存
        </button>
        <output aria-live="polite" className="text-xs text-slate-600">
          {saved}
        </output>
      </form>
    </div>
  );
}
