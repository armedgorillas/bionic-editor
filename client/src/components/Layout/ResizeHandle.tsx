import React, { useRef, useState, useEffect } from 'react';

interface ResizeHandleProps {
  orientation: 'vertical' | 'horizontal';
  currentSize: number;
  minSize: number;
  maxSize: number;
  /** Direction multiplier: +1 when dragging right/down grows pane, -1 when dragging left/up grows pane */
  direction: 1 | -1;
  onResize: (newSize: number) => void;
  onReset: () => void;
  onDraggingChange?: (dragging: boolean) => void;
  ariaLabel: string;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  orientation,
  currentSize,
  minSize,
  maxSize,
  direction,
  onResize,
  onReset,
  onDraggingChange,
  ariaLabel
}) => {
  const [active, setActive] = useState(false);
  const activeRef = useRef<boolean>(false);
  const startCoordRef = useRef<number>(0);
  const startSizeRef = useRef<number>(0);
  const onDraggingChangeRef = useRef(onDraggingChange);

  useEffect(() => {
    onDraggingChangeRef.current = onDraggingChange;
  }, [onDraggingChange]);

  // Clean up cursor & dragging flag if handle unmounts mid-drag
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        activeRef.current = false;
        document.body.style.cursor = '';
        onDraggingChangeRef.current?.(false);
      }
    };
  }, []);

  const isVertical = orientation === 'vertical';

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startCoordRef.current = isVertical ? e.clientX : e.clientY;
    startSizeRef.current = currentSize;
    activeRef.current = true;
    setActive(true);
    onDraggingChangeRef.current?.(true);
    document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    const coord = isVertical ? e.clientX : e.clientY;
    const delta = (coord - startCoordRef.current) * direction;
    onResize(startSizeRef.current + delta);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    activeRef.current = false;
    setActive(false);
    onDraggingChangeRef.current?.(false);
    document.body.style.cursor = '';
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (isVertical) {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onResize(currentSize + step * direction);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onResize(currentSize - step * direction);
      } else if (e.key === 'Home') {
        e.preventDefault();
        onReset();
      }
    } else {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onResize(currentSize - step * direction);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        onResize(currentSize + step * direction);
      } else if (e.key === 'Home') {
        e.preventDefault();
        onReset();
      }
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-valuemin={minSize}
      aria-valuemax={maxSize}
      aria-valuenow={Math.round(currentSize)}
      tabIndex={0}
      title="Drag to resize • Double-click to reset"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className={
        isVertical
          ? `relative z-20 w-1.5 -mx-[2.5px] flex-shrink-0 cursor-col-resize group focus:outline-none select-none`
          : `relative z-20 h-1.5 -my-[2.5px] flex-shrink-0 cursor-row-resize group focus:outline-none select-none`
      }
    >
      <div
        className={
          isVertical
            ? `mx-auto h-full w-[1px] transition-all ${
                active
                  ? 'w-[2px] bg-accent'
                  : 'bg-edge group-hover:w-[2px] group-hover:bg-accent/70 group-focus:w-[2px] group-focus:bg-accent'
              }`
            : `my-auto w-full h-[1px] transition-all ${
                active
                  ? 'h-[2px] bg-accent'
                  : 'bg-edge group-hover:h-[2px] group-hover:bg-accent/70 group-focus:h-[2px] group-focus:bg-accent'
              }`
        }
      />
    </div>
  );
};
