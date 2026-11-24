import { useState, useEffect, useCallback } from 'react';

export interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  terminalHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 256,
  rightWidth: 384,
  terminalHeight: 256,
  leftCollapsed: false,
  rightCollapsed: false
};

export const MIN_LEFT_WIDTH = 180;
export const MAX_LEFT_WIDTH = 480;
export const MIN_RIGHT_WIDTH = 280;
export const MAX_RIGHT_WIDTH = 760;
export const MIN_CENTER_WIDTH = 320;
export const MIN_TERMINAL_HEIGHT = 120;
export const NARROW_VIEWPORT_BREAKPOINT = 820;

const STORAGE_KEY = 'bionic_layout_state';

/**
 * Pure helper so narrow viewports never clip the center editor or overflow sidebars.
 */
export function clampLayoutWidths(viewportWidth: number, state: LayoutState): LayoutState {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return state;
  }

  let leftCollapsed = state.leftCollapsed;
  const rightCollapsed = state.rightCollapsed;

  // On narrow screens (< 820px), auto-collapse left sidebar if both panels are open
  if (viewportWidth < NARROW_VIEWPORT_BREAKPOINT && !leftCollapsed && !rightCollapsed) {
    leftCollapsed = true;
  }

  let leftWidth = Math.max(MIN_LEFT_WIDTH, Math.min(MAX_LEFT_WIDTH, state.leftWidth));
  let rightWidth = Math.max(
    MIN_RIGHT_WIDTH,
    Math.min(MAX_RIGHT_WIDTH, Math.floor(viewportWidth * 0.6), state.rightWidth)
  );

  const effectiveLeft = leftCollapsed ? 0 : leftWidth;
  const effectiveRight = rightCollapsed ? 0 : rightWidth;
  const availableForSides = Math.max(0, viewportWidth - MIN_CENTER_WIDTH);

  if (effectiveLeft + effectiveRight > availableForSides) {
    if (!leftCollapsed && !rightCollapsed) {
      // Shrink right first down to min, then left down to min
      const excess = effectiveLeft + effectiveRight - availableForSides;
      const rightRoom = Math.max(0, rightWidth - MIN_RIGHT_WIDTH);
      const shrinkRight = Math.min(excess, rightRoom);
      rightWidth -= shrinkRight;

      const remaining = excess - shrinkRight;
      if (remaining > 0) {
        leftWidth = Math.max(MIN_LEFT_WIDTH, leftWidth - remaining);
      }
    } else if (!rightCollapsed) {
      rightWidth = Math.max(MIN_RIGHT_WIDTH, Math.min(rightWidth, availableForSides));
    } else if (!leftCollapsed) {
      leftWidth = Math.max(MIN_LEFT_WIDTH, Math.min(leftWidth, availableForSides));
    }
  }

  return {
    ...state,
    leftWidth: Math.round(leftWidth),
    rightWidth: Math.round(rightWidth),
    leftCollapsed,
    rightCollapsed
  };
}

function loadLayoutState(): LayoutState {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clampLayoutWidths(window.innerWidth, DEFAULT_LAYOUT);
    const parsed = JSON.parse(raw);
    return clampLayoutWidths(window.innerWidth, {
      leftWidth: typeof parsed.leftWidth === 'number' ? parsed.leftWidth : DEFAULT_LAYOUT.leftWidth,
      rightWidth: typeof parsed.rightWidth === 'number' ? parsed.rightWidth : DEFAULT_LAYOUT.rightWidth,
      terminalHeight: typeof parsed.terminalHeight === 'number' ? parsed.terminalHeight : DEFAULT_LAYOUT.terminalHeight,
      leftCollapsed: Boolean(parsed.leftCollapsed),
      rightCollapsed: Boolean(parsed.rightCollapsed)
    });
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function useResizableLayout() {
  const [layout, setLayout] = useState<LayoutState>(loadLayoutState);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const persist = useCallback((next: LayoutState) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setLayout((prev) => clampLayoutWidths(window.innerWidth, prev));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setLeftWidth = useCallback(
    (width: number) => {
      setLayout((prev) => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
        const clamped = clampLayoutWidths(vw, { ...prev, leftWidth: width, leftCollapsed: false });
        persist(clamped);
        return clamped;
      });
    },
    [persist]
  );

  const setRightWidth = useCallback(
    (width: number) => {
      setLayout((prev) => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
        const clamped = clampLayoutWidths(vw, { ...prev, rightWidth: width, rightCollapsed: false });
        persist(clamped);
        return clamped;
      });
    },
    [persist]
  );

  const setTerminalHeight = useCallback(
    (height: number) => {
      setLayout((prev) => {
        const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
        const maxH = Math.floor(vh * 0.6);
        const next = {
          ...prev,
          terminalHeight: Math.round(Math.max(MIN_TERMINAL_HEIGHT, Math.min(maxH, height)))
        };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const resetLeftWidth = useCallback(() => setLeftWidth(DEFAULT_LAYOUT.leftWidth), [setLeftWidth]);
  const resetRightWidth = useCallback(() => setRightWidth(DEFAULT_LAYOUT.rightWidth), [setRightWidth]);
  const resetTerminalHeight = useCallback(
    () => setTerminalHeight(DEFAULT_LAYOUT.terminalHeight),
    [setTerminalHeight]
  );

  const toggleLeftCollapsed = useCallback(() => {
    setLayout((prev) => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
      const nextLeftCollapsed = !prev.leftCollapsed;
      // On narrow screens, opening left sidebar collapses right sidebar so center stays readable
      const nextRightCollapsed =
        !nextLeftCollapsed && vw < NARROW_VIEWPORT_BREAKPOINT ? true : prev.rightCollapsed;
      const next = clampLayoutWidths(vw, {
        ...prev,
        leftCollapsed: nextLeftCollapsed,
        rightCollapsed: nextRightCollapsed
      });
      persist(next);
      return next;
    });
  }, [persist]);

  const toggleRightCollapsed = useCallback(() => {
    setLayout((prev) => {
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
      const nextRightCollapsed = !prev.rightCollapsed;
      const nextLeftCollapsed =
        !nextRightCollapsed && vw < NARROW_VIEWPORT_BREAKPOINT ? true : prev.leftCollapsed;
      const next = clampLayoutWidths(vw, {
        ...prev,
        leftCollapsed: nextLeftCollapsed,
        rightCollapsed: nextRightCollapsed
      });
      persist(next);
      return next;
    });
  }, [persist]);

  return {
    layout,
    isDragging,
    setIsDragging,
    setLeftWidth,
    setRightWidth,
    setTerminalHeight,
    resetLeftWidth,
    resetRightWidth,
    resetTerminalHeight,
    toggleLeftCollapsed,
    toggleRightCollapsed
  };
}
