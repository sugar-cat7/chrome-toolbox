import type { ReactNode } from 'react';
import { DISPLAY_MODES, type DisplayMode } from '../../settings.ts';
import { DISPLAY_CHOICES, DISPLAY_HINT } from './text.ts';

/**
 * A group of radio buttons that saves each choice at once; disabled until the saved value is
 * known. `failure` says why the last choice was not saved.
 */
export function Choices<T extends string>({
  legend,
  name,
  options,
  labels,
  value,
  failure,
  onChange,
  children,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  labels: Readonly<Record<T, string>>;
  value: T | undefined;
  failure: string | undefined;
  onChange: (value: T) => void;
  children?: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-1 px-4" disabled={value === undefined}>
      <legend className="font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-1">
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            {labels[option]}
          </label>
        ))}
      </div>
      {children}
      {failure !== undefined && (
        <output aria-live="polite" className="text-xs text-red-700">
          {failure}
        </output>
      )}
    </fieldset>
  );
}

/** The display mode, which every tab follows at once (`subs/display`). */
export function DisplaySection({
  mode,
  failure,
  onChange,
}: {
  mode: DisplayMode | undefined;
  failure: string | undefined;
  onChange: (mode: DisplayMode) => void;
}) {
  return (
    <Choices
      legend="表示"
      name="display"
      options={DISPLAY_MODES}
      labels={DISPLAY_CHOICES}
      value={mode}
      failure={failure}
      onChange={onChange}
    >
      <p className="text-xs text-slate-600">{DISPLAY_HINT}</p>
    </Choices>
  );
}
