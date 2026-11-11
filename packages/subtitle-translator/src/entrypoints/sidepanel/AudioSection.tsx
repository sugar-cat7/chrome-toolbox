import { useEffect, useRef, useState } from 'react';
import { launch, type Result } from '@chrome-toolbox/contracts';
import type { Capability } from '../../panel.ts';
import type { TabState } from '../../protocol.ts';
import { SOURCE_LANGUAGE_CODES, SOURCE_LANGUAGES, type SubtitleSettings } from '../../settings.ts';
import { Choices } from './DisplaySection.tsx';
import {
  AUDIO_MISSING,
  AUDIO_READY,
  AUDIO_UNKNOWN,
  AUTO_LANGUAGE,
  SOURCE_CHOICES,
  START_GUIDE,
  STARTING,
  explain,
} from './text.ts';

/** What the server can do, once asked; failed when the service worker could not ask. */
export type CapabilityView =
  | { status: 'loading' }
  | { status: 'ready'; capability: Capability }
  | { status: 'failed' };

const SOURCES = [
  'auto',
  'captions',
  'audio',
] as const satisfies readonly SubtitleSettings['source'][];

/** Whether the server takes audio input for the speech model, and how to add it when it does not. */
function audioInput(capability: CapabilityView): string {
  if (capability.status === 'loading') return '音声入力: 確認しています…';
  if (capability.status === 'failed') return AUDIO_UNKNOWN;
  const { audio } = capability.capability;
  if (audio === undefined) return AUDIO_UNKNOWN;
  return audio ? AUDIO_READY : AUDIO_MISSING;
}

/**
 * Speech subtitles: the captured tab can be stopped here; they start only from the toolbar icon or
 * Alt+Shift+S, which Chrome lets capture a tab (S46), and while a start runs the panel says so until
 * the service worker tells it the start ended. Below, whether the server takes audio input.
 */
export function AudioSection({
  tab,
  capability,
  onStop,
}: {
  tab: TabState | undefined;
  capability: CapabilityView;
  onStop: () => Promise<Result<void>>;
}) {
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const capturing = tab?.source === 'audio';
  return (
    <section aria-label="音声" className="flex flex-col gap-1 px-4">
      <h2 className="font-medium">音声</h2>
      {capturing ? (
        <div className="flex items-center justify-between gap-2">
          <p>このタブの音声を字幕にしています</p>
          <button
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              setFailure('');
              launch(
                async () => {
                  const stopped = await onStop();
                  if (!mounted.current) return;
                  setStopping(false);
                  if (!stopped.ok) setFailure(explain(stopped.error.internalCode));
                },
                () => {
                  if (!mounted.current) return;
                  setStopping(false);
                  setFailure(explain('unexpected_failure'));
                },
              );
            }}
            className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
          >
            停止
          </button>
        </div>
      ) : (
        <p>{tab?.starting === true ? STARTING : START_GUIDE}</p>
      )}
      <p className="text-xs text-slate-600">{audioInput(capability)}</p>
      {failure !== '' && (
        <output aria-live="polite" className="text-xs text-red-700">
          {failure}
        </output>
      )}
    </section>
  );
}

/** Where the subtitles come from: chosen by the watch page, its caption track, or the audio. */
export function SourceSection({
  source,
  failure,
  onChange,
}: {
  source: SubtitleSettings['source'] | undefined;
  failure: string | undefined;
  onChange: (source: SubtitleSettings['source']) => void;
}) {
  return (
    <Choices
      legend="取得元"
      name="source"
      options={SOURCES}
      labels={SOURCE_CHOICES}
      value={source}
      failure={failure}
      onChange={onChange}
    />
  );
}

/** The spoken language of the audio: found from the speech, or one of the 12 fixed. */
export function LanguageSection({
  sourceLang,
  failure,
  onChange,
}: {
  sourceLang: SubtitleSettings['sourceLang'] | undefined;
  failure: string | undefined;
  onChange: (sourceLang: SubtitleSettings['sourceLang']) => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-4">
      <label className="flex flex-col gap-1">
        <span className="font-medium">話されている言語</span>
        <select
          value={sourceLang ?? 'auto'}
          disabled={sourceLang === undefined}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen === 'auto') onChange('auto');
            else {
              const code = SOURCE_LANGUAGE_CODES.find((known) => known === chosen);
              if (code !== undefined) onChange(code);
            }
          }}
          className="rounded border px-2 py-1"
        >
          <option value="auto">{AUTO_LANGUAGE}</option>
          {SOURCE_LANGUAGE_CODES.map((code) => (
            <option key={code} value={code}>
              {SOURCE_LANGUAGES[code]}
            </option>
          ))}
        </select>
      </label>
      {failure !== undefined && (
        <output aria-live="polite" className="text-xs text-red-700">
          {failure}
        </output>
      )}
    </div>
  );
}
