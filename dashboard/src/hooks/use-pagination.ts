'use client';

import { useMemo, useState, useEffect } from 'react';

/**
 * Client-side pagination over an already-fetched array.
 *
 * These list endpoints already cap what they return (comms 200 messages,
 * activity 100 events), so the fix for "33 screens of scroll" is to stop
 * rendering the whole capped array at once — not to add offset/limit to three
 * different API contracts that each paginate differently today.
 */
export function usePagination<T>(items: T[], pageSize = 25) {
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));

  // Filters shrink the list under us; a stale page index would render blank.
  useEffect(() => {
    if (page > pageCount - 1) setPage(0);
  }, [page, pageCount]);

  const safePage = Math.min(page, pageCount - 1);

  const pageItems = useMemo(
    () => items.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [items, safePage, pageSize],
  );

  return {
    pageItems,
    page: safePage,
    pageCount,
    total: items.length,
    // 1-indexed, inclusive — for "Showing 26-50 of 200"
    rangeStart: items.length === 0 ? 0 : safePage * pageSize + 1,
    rangeEnd: Math.min((safePage + 1) * pageSize, items.length),
    canPrev: safePage > 0,
    canNext: safePage < pageCount - 1,
    prev: () => setPage((p) => Math.max(0, p - 1)),
    next: () => setPage((p) => Math.min(pageCount - 1, p + 1)),
  };
}
