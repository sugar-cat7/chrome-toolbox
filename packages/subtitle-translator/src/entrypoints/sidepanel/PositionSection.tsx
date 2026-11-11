import { useState } from 'react';
import { POSITION_LIMITS } from '../../settings.ts';

/** What the slider says of the offset: the usual place, or how far up or down. */
function offsetText(offset: number): string {
  if (offset === 0) return '標準の位置';
  return offset < 0 ? `上へ ${-offset}%` : `下へ ${offset}%`;
}

/**
 * The vertical offset of the subtitle lines over the player, in percent of the player's height
 * (the detailed settings' 字幕の表示位置). The slider only moves a draft; the choice is saved
 * when the gesture ends — the pointer released, a key let go or the field left — not on every
 * tick of a drag. The draft is kept with the saved value it was made against: a value saved
 * elsewhere (another tab, this panel's own save) shows at once instead.
 */
export function PositionSection({
  position,
  failure,
  onChange,
}: {
  position: number | undefined;
  failure: string | undefined;
  onChange: (position: number) => void;
}) {
  const [draft, setDraft] = useState<{ of: number | undefined; value: number | undefined }>({
    of: position,
    value: position,
  });
  const shown = draft.of === position ? draft.value : position;
  const commit = () => {
    if (shown !== undefined && shown !== position) onChange(shown);
  };
  return (
    <div className="flex flex-col gap-1 px-4">
      <label htmlFor="subtitle-position" className="font-medium">
        字幕の表示位置
      </label>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-xs text-slate-500">
          上
        </span>
        <input
          id="subtitle-position"
          type="range"
          min={POSITION_LIMITS.min}
          max={POSITION_LIMITS.max}
          step={1}
          value={shown ?? 0}
          disabled={position === undefined}
          onChange={(event) => setDraft({ of: position, value: Number(event.target.value) })}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="w-full"
        />
        <span aria-hidden="true" className="text-xs text-slate-500">
          下
        </span>
      </div>
      <p className="text-xs text-slate-600">
        プレイヤーの高さに対する割合（%）で上下に動かせます（
        {shown === undefined ? '読み込んでいます…' : offsetText(shown)}）
      </p>
      {failure !== undefined && (
        <output aria-live="polite" className="text-xs text-red-700">
          {failure}
        </output>
      )}
    </div>
  );
}
