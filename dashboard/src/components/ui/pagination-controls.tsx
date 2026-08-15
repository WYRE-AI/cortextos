'use client';

import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

interface PaginationControlsProps {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** Plural noun for the range label, e.g. "messages". */
  label?: string;
}

export function PaginationControls({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
  label = 'items',
}: PaginationControlsProps) {
  // A single page needs no controls — showing them just adds chrome.
  if (pageCount <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-3 pt-3">
      <span className="text-xs text-muted-foreground tabular-nums">
        Showing {rangeStart}-{rangeEnd} of {total} {label}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={!canPrev}
          aria-label="Previous page"
        >
          <IconChevronLeft className="size-3.5" />
          Previous
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {page + 1} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={!canNext}
          aria-label="Next page"
        >
          Next
          <IconChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
