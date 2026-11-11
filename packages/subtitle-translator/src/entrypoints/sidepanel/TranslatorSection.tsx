import { PLAMO_LICENSE_URL } from '@chrome-toolbox/extension-core';
import type { TranslatorStatus } from '../../line-translator.ts';
import {
  SUBTITLE_TRANSLATORS,
  TRANSLATOR_LABELS,
  type SubtitleTranslator,
} from '../../settings.ts';
import { Choices } from './DisplaySection.tsx';
import { PLAMO_ATTRIBUTION, PLAMO_LICENSE_NAME, PLAMO_SETUP, fallbackNotices } from './text.ts';

/**
 * Who translates the subtitles: Gemma (the default) or PLaMo 3 Translate 2B (Task 8). While PLaMo
 * is chosen, its attribution and license link (in English, as the license asks), where to install
 * it, and one line for each reason lines went to Gemma, the latest first (S44). `status` is the
 * translator of the shown tab's path; `plamoListed` whether the server lists PLaMo.
 */
export function TranslatorSection({
  chosen,
  status,
  plamoListed,
  failure,
  onChange,
}: {
  chosen: SubtitleTranslator | undefined;
  status: TranslatorStatus | undefined;
  plamoListed: boolean | undefined;
  failure: string | undefined;
  onChange: (translator: SubtitleTranslator) => void;
}) {
  const notices =
    chosen === 'plamo' ? fallbackNotices(status ?? { chosen: 'plamo' }, plamoListed) : [];
  return (
    <Choices
      legend="字幕の翻訳"
      name="translator"
      options={SUBTITLE_TRANSLATORS}
      labels={TRANSLATOR_LABELS}
      value={chosen}
      failure={failure}
      onChange={onChange}
    >
      {chosen === 'plamo' && (
        <div className="flex flex-col gap-1 text-xs text-slate-600">
          <p lang="en">{PLAMO_ATTRIBUTION}</p>
          <p>
            <a
              href={PLAMO_LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              lang="en"
              className="text-blue-700 underline"
            >
              {PLAMO_LICENSE_NAME}
            </a>
          </p>
          <p>{PLAMO_SETUP}</p>
          {notices.length > 0 && (
            <ul aria-label="Gemma で訳した行" className="flex flex-col gap-0.5 text-slate-900">
              {notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Choices>
  );
}
