import { useEffect, useId, useRef, useState } from 'react';
import { launch, Ok, type AppError } from '@chrome-toolbox/contracts';
import { PLAMO_LICENSE_URL, PLAMO_TRANSLATE_MODEL } from '@chrome-toolbox/extension-core';
import { ConnectionPanel } from '@chrome-toolbox/ui';
import { readHosts, type OptionsPort } from '../../options.ts';
import { PAGE_SETTINGS_LIMITS, siteOf, type PageSettings } from '../../settings.ts';

type Translator = PageSettings['translator'];
const TRANSLATORS: readonly Readonly<{ value: Translator; label: string }>[] = [
  { value: 'gemma', label: 'Gemma' },
  { value: 'plamo', label: 'PLaMo 3 Translate 2B（任意。Built with PLaMo）' },
];

const messages: Partial<Record<AppError['internalCode'], string>> = {
  storage_failed: '設定を保存できませんでした。',
  response_invalid: '保存されている設定を読めませんでした。',
  input_invalid: '設定の形式が正しくありません。',
  unexpected_failure: '設定を変えられませんでした。',
};
const explain = (error: AppError): string =>
  messages[error.internalCode] ?? '設定を変えられませんでした。';
/** An always entry as the list shows it: the site's origin (`https://wiki.example`). */
const originOf = (pattern: string): string => pattern.replace(/\/\*$/u, '');

/**
 * The options page: the llama.cpp connection (the shared `ConnectionPanel`), who translates
 * pages, Gemma's model name, the sites never translated, the sites always translated and what to
 * do when paragraphs stay in the original. Settings read after the viewer touched a field leave
 * that field alone.
 */
export function App({ port }: { port: OptionsPort }) {
  /** The page settings as last read or saved; the always list shows from them. */
  const [page, setPage] = useState<PageSettings | undefined>();
  const [modelLoaded, setModelLoaded] = useState(false);
  const [translator, setTranslator] = useState<Translator>('gemma');
  const [model, setModel] = useState('');
  const [never, setNever] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  /** Fields the viewer has touched: settings read afterwards must not replace them. */
  const edited = useRef({ translator: false, model: false, never: false });
  const modelId = useId();
  const neverId = useId();
  const neverHintId = useId();
  const alwaysId = useId();
  const helpId = useId();

  useEffect(() => {
    mounted.current = true;
    launch(
      async () => {
        const loaded = await port.pageSettings.load();
        if (!mounted.current) return;
        if (!loaded.ok) {
          setMessage(explain(loaded.error));
          return;
        }
        setPage(loaded.value);
        if (!edited.current.translator) setTranslator(loaded.value.translator);
        if (!edited.current.never) setNever(loaded.value.never.join('\n'));
      },
      (error) => {
        if (mounted.current) setMessage(explain(error));
      },
    );
    launch(
      async () => {
        const loaded = await port.settings.load();
        if (!mounted.current) return;
        if (!loaded.ok) {
          setMessage(explain(loaded.error));
          return;
        }
        setModelLoaded(true);
        if (!edited.current.model) setModel(loaded.value.models.translate);
      },
      (error) => {
        if (mounted.current) setMessage(explain(error));
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [port]);

  function save(): void {
    // The never list goes only when the viewer edited it: the popup may have changed the stored
    // one since it was read, and `save` keeps what is stored otherwise.
    const hosts = edited.current.never ? readHosts(never) : Ok(undefined);
    if (!hosts.ok) {
      setMessage(`ホスト名の形式が正しくありません: ${hosts.error.line}`);
      return;
    }
    if (hosts.value !== undefined && hosts.value.length > PAGE_SETTINGS_LIMITS.never) {
      setMessage(`翻訳しないサイトは ${PAGE_SETTINGS_LIMITS.never} 件までです`);
      return;
    }
    const name = model.trim();
    if (name === '') {
      setMessage('Gemma のモデル名を入れてください');
      return;
    }
    setBusy(true);
    setMessage('');
    launch(
      async () => {
        const saved = await port.save({
          translator,
          model: name,
          ...(hosts.value === undefined ? {} : { never: hosts.value }),
        });
        if (!mounted.current) return;
        setBusy(false);
        if (!saved.ok) {
          setMessage(explain(saved.error));
          return;
        }
        // The field shows the list as stored now; it goes with the next save once edited again.
        edited.current.never = false;
        setPage(saved.value.page);
        setNever(saved.value.page.never.join('\n'));
        setModel(saved.value.settings.models.translate);
        setMessage('設定を保存しました');
      },
      (error) => {
        if (!mounted.current) return;
        setBusy(false);
        setMessage(explain(error));
      },
    );
  }

  /** Takes the always site of `pattern` off; the list is read again afterwards. */
  function remove(pattern: string): void {
    const site = siteOf(pattern);
    setBusy(true);
    setMessage('');
    launch(
      async () => {
        // An entry that is no site's pattern (storage edited by hand) still leaves the list.
        const removed = await port.setAlways(
          site.ok ? site.value : { host: pattern, pattern },
          false,
          page?.never ?? [],
        );
        const loaded = await port.pageSettings.load();
        if (!mounted.current) return;
        setBusy(false);
        if (loaded.ok) setPage(loaded.value);
        if (!removed.ok) setMessage(explain(removed.error));
        else if (!loaded.ok) setMessage(explain(loaded.error));
      },
      (error) => {
        if (!mounted.current) return;
        setBusy(false);
        setMessage(explain(error));
      },
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 pb-8 text-sm text-slate-900">
      <ConnectionPanel title="ページ翻訳" adapter={port.connection} />
      <form
        className="flex flex-col gap-4 px-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="font-medium">翻訳モデル</legend>
          {TRANSLATORS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="translator"
                value={value}
                checked={translator === value}
                onChange={() => {
                  edited.current.translator = true;
                  setTranslator(value);
                }}
                className="accent-slate-900"
              />
              {label}
            </label>
          ))}
          {translator === 'plamo' && (
            <p className="text-xs">
              <span lang="en">Built with PLaMo</span>
              {' · '}
              <a
                href={PLAMO_LICENSE_URL}
                target="_blank"
                rel="noreferrer"
                lang="en"
                className="underline"
              >
                PLaMo Community License
              </a>
            </p>
          )}
          <p className="text-xs text-slate-600">
            PLaMo は llama.cpp のサーバーに別に入れます（docs/llama-server.md）。モデル名は{' '}
            {PLAMO_TRANSLATE_MODEL} です
          </p>
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor={modelId} className="font-medium">
            Gemma のモデル名
          </label>
          <input
            id={modelId}
            name="model"
            value={model}
            onChange={(event) => {
              edited.current.model = true;
              setModel(event.target.value);
            }}
            className="rounded border px-2 py-1"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={neverId} className="font-medium">
            翻訳しないサイト
          </label>
          <textarea
            id={neverId}
            name="never"
            rows={5}
            value={never}
            aria-describedby={neverHintId}
            onChange={(event) => {
              edited.current.never = true;
              setNever(event.target.value);
            }}
            className="rounded border px-2 py-1 font-mono"
          />
          <p id={neverHintId} className="text-xs text-slate-600">
            1 行に 1 つのホスト名（例:
            bank.example）。そのサブドメインも翻訳しません。選択範囲の翻訳は使えます。
          </p>
        </div>
        <button
          type="submit"
          disabled={busy || page === undefined || !modelLoaded}
          className="self-start rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
        >
          保存
        </button>
        <output aria-live="polite" className="text-xs text-slate-600">
          {message}
        </output>
      </form>
      <section aria-labelledby={alwaysId} className="flex flex-col gap-2 px-4">
        <h2 id={alwaysId} className="font-medium">
          常に翻訳するサイト
        </h2>
        <p className="text-xs text-slate-600">
          ポップアップの「このサイトは常に翻訳」で足します。足したサイトは「翻訳しないサイト」から外れます。
        </p>
        {page !== undefined && page.always.length === 0 && (
          <p className="text-slate-500">まだありません</p>
        )}
        {page !== undefined && page.always.length > 0 && (
          <ul aria-labelledby={alwaysId} className="flex flex-col gap-1">
            {page.always.map((pattern) => (
              <li key={pattern} className="flex items-center justify-between gap-2">
                <span className="font-mono">{originOf(pattern)}</span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`${originOf(pattern)} を外す`}
                  onClick={() => remove(pattern)}
                  className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
                >
                  外す
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={helpId} className="flex flex-col gap-1 px-4">
        <h2 id={helpId} className="font-medium">
          困ったとき
        </h2>
        <ul className="list-disc pl-5 text-slate-700">
          <li>
            段落がすべて原文のまま残るときは、llama.cpp を <code>--parallel 2</code>{' '}
            以上で起動してください。ページ翻訳は、字幕が使う枠 0 を使いません。
          </li>
          <li>
            ポップアップに「llama.cpp
            に接続できません」と出るときは、上の「接続を確認」で接続先を確かめてください。
          </li>
        </ul>
      </section>
    </main>
  );
}
