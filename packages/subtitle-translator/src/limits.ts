/**
 * Characters kept of what a page names; they go into prompts. A module without imports, so the
 * MAIN-world bridge can use it without pulling in extension-core.
 */
export const PAGE_LIMITS = { title: 200, author: 100, streamer: 128 } as const;
