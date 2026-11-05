// ── SCROLL-UP PAGINATION + INCREMENTAL TAIL FOR A READ-ONLY THREAD ───────────────────────────
//
// A multi-day workshop thread grows without bound, so a shared chat is opened one PAGE at a time
// (newest first, older pages loaded as the reader scrolls up) and kept current by appending only
// the messages NEWER than the newest one already held — never by refetching the whole transcript.
//
// This module is the pure state machine; the React hook that drives it lives beside it. The fetch
// itself is INJECTED (`PageFetcher`), so the same logic serves the shared chat today (an IPC call to
// the AI service) and the own chat later (a local-SQLite call) without the state machine knowing
// which. Pure so the ordering/cursor/dedup rules can be asserted without a DOM or a backend.

import { useCallback, useRef, useState } from "react";

/** The least a message needs for this module: an id (dedup) and a createdAt (ordering + cursors). */
export interface PageableMessage {
  id: string;
  createdAt?: string;
}

/** One newest-first page, returned ASCENDING, with the cursor for the next OLDER page. */
export interface Page<M> {
  messages: M[];
  /** Pass as `before` to fetch the page above this one; null/undefined means the thread start. */
  nextBefore?: string | null;
}

/**
 * How this module reaches a backend. One function, two shapes by argument:
 *   · { limit, before? } — a newest-first page for scroll-up.
 *   · { since }          — the tail newer than `since`, for a live refresh.
 */
export type PageFetcher<M> = (
  args: { limit: number; before?: string } | { since: string }
) => Promise<Page<M>>;

/** The newest `createdAt` across a list, or undefined when none carry one — the `since` cursor. */
export function newestCreatedAt<M extends PageableMessage>(messages: M[]): string | undefined {
  let newest: string | undefined;
  for (const m of messages) {
    if (m.createdAt && (newest === undefined || m.createdAt > newest)) newest = m.createdAt;
  }
  return newest;
}

/**
 * Merge an incremental TAIL into the held list: append only ids not already present, preserving
 * order. Dedup by id matters because `since` is a strict `>` on a millisecond clock, but a retry or
 * an at-least-once delivery can still re-present a boundary row — appending it twice would show a
 * duplicate bubble. Returns the SAME array reference when nothing is new, so a caller can skip a
 * state update (and the re-render) on an empty poll.
 */
export function mergeTail<M extends PageableMessage>(held: M[], tail: M[]): M[] {
  if (tail.length === 0) return held;
  const seen = new Set(held.map((m) => m.id));
  const fresh = tail.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return held;
  return [...held, ...fresh];
}

/**
 * Prepend an OLDER page above the held list, dropping any ids already present (the `before` cursor
 * is exclusive, but a boundary row can still overlap under clock ties). Preserves ascending order.
 */
export function prependOlder<M extends PageableMessage>(held: M[], older: M[]): M[] {
  if (older.length === 0) return held;
  const seen = new Set(held.map((m) => m.id));
  const fresh = older.filter((m) => !seen.has(m.id));
  if (fresh.length === 0) return held;
  return [...fresh, ...held];
}

export interface ThreadPaginationState<M> {
  messages: M[];
  /** First page is loading (open) — distinct from `loadingOlder` so the UI can show each one right. */
  loading: boolean;
  /** An older page is loading (scroll-up) — drives a top spinner without blanking the transcript. */
  loadingOlder: boolean;
  /** Whether an older page exists to fetch. False once the thread start has been reached. */
  hasMore: boolean;
  /** When the last refresh completed — the pinned pane's "updated Xs ago" indicator. */
  refreshedAt: number | null;
}

export interface ThreadPagination<M> extends ThreadPaginationState<M> {
  /** Load the newest page from scratch (on open / on pin). Resets everything. */
  openNewest: () => Promise<void>;
  /** Load the next older page and prepend it. No-op while already loading or at the start. */
  loadOlder: () => Promise<void>;
  /** Append the tail newer than what is held. `silent` leaves `loading` untouched (background poll). */
  refreshTail: (silent: boolean) => Promise<void>;
  /** Drop all state (on unpin / close), so a later reopen starts clean. */
  reset: () => void;
}

/**
 * The React hook. `fetcher` must be stable (wrap in useCallback) — it is captured per call.
 *
 * ⚠ A GENERATION GUARD STOPS A STALE PAGE LANDING. `openNewest` is called on every pin/open, and a
 * project switch or a quick re-pin can fire a second one before the first await resolves. Each run
 * stamps `gen`; a resolved fetch whose stamp is no longer current is discarded, so the pane cannot
 * flash a previous thread's first page.
 */
export function useThreadPagination<M extends PageableMessage>(
  fetcher: PageFetcher<M>,
  pageSize: number
): ThreadPagination<M> {
  const [messages, setMessages] = useState<M[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const beforeRef = useRef<string | null>(null); // cursor for the next older page
  const messagesRef = useRef<M[]>([]); // latest messages for the tail/older merges without stale closure
  const genRef = useRef(0);
  const loadingOlderRef = useRef(false);

  const setBoth = useCallback((next: M[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const openNewest = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setBoth([]);
    beforeRef.current = null;
    const page = await fetcher({ limit: pageSize });
    if (gen !== genRef.current) return; // a newer open superseded this one
    setBoth(page.messages);
    beforeRef.current = page.nextBefore ?? null;
    setHasMore(Boolean(page.nextBefore));
    setLoading(false);
    setRefreshedAt(Date.now());
  }, [fetcher, pageSize, setBoth]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const before = beforeRef.current;
    if (!before) return; // at the start of the thread
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const gen = genRef.current;
    const page = await fetcher({ limit: pageSize, before });
    if (gen === genRef.current) {
      setBoth(prependOlder(messagesRef.current, page.messages));
      beforeRef.current = page.nextBefore ?? null;
      setHasMore(Boolean(page.nextBefore));
    }
    loadingOlderRef.current = false;
    setLoadingOlder(false);
  }, [fetcher, pageSize, setBoth]);

  const refreshTail = useCallback(
    async (silent: boolean) => {
      const since = newestCreatedAt(messagesRef.current);
      const gen = genRef.current;
      if (!silent) setLoading(true);
      // With nothing held yet, a tail has no anchor — fall back to the newest page.
      const page = since ? await fetcher({ since }) : await fetcher({ limit: pageSize });
      if (gen === genRef.current) {
        setBoth(since ? mergeTail(messagesRef.current, page.messages) : page.messages);
        if (!since) {
          beforeRef.current = page.nextBefore ?? null;
          setHasMore(Boolean(page.nextBefore));
        }
      }
      if (!silent) setLoading(false);
      setRefreshedAt(Date.now());
    },
    [fetcher, pageSize, setBoth]
  );

  const reset = useCallback(() => {
    genRef.current++;
    setBoth([]);
    beforeRef.current = null;
    setHasMore(false);
    setLoading(false);
    setLoadingOlder(false);
    setRefreshedAt(null);
  }, [setBoth]);

  return {
    messages,
    loading,
    loadingOlder,
    hasMore,
    refreshedAt,
    openNewest,
    loadOlder,
    refreshTail,
    reset,
  };
}
