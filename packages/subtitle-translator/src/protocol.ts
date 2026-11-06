import { llmProtocolSpec } from '@chrome-toolbox/extension-core';

/** Who a message is for: every receiver drops what is not for it before validating. */
export type Target = 'background' | 'offscreen' | 'panel' | 'content';
const TARGETS: readonly string[] = [
  'background',
  'offscreen',
  'panel',
  'content',
] satisfies Target[];

/** The messages the service worker answers; each task adds its own. */
export const subtitleProtocolSpec = { ...llmProtocolSpec };

/** The message with its target added; anything that is not an object carries only the target. */
export function addressed(target: Target, message: unknown): { target: Target } {
  return typeof message === 'object' && message !== null ? { ...message, target } : { target };
}

/** Whether `message` names `target`; reads nothing else, so it runs before validation. */
export function isFor(target: Target, message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'target' in message &&
    message.target === target &&
    TARGETS.includes(target)
  );
}
