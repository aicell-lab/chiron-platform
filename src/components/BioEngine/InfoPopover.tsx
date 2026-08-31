import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Placement of the panel for one opening. `top` and `bottom` are exclusive:
 *  whichever side of the trigger has the room wins, and the panel is anchored
 *  to that edge so it grows away from the trigger and never off screen. */
interface PopoverPosition {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

const PANEL_WIDTH = 288;
/** Distance from the viewport edge the panel keeps. */
const VIEWPORT_MARGIN = 8;
/** Distance between the trigger and the panel. */
const TRIGGER_GAP = 6;
/** Below this the space under the trigger is not worth using, so the panel
 *  flips above instead of rendering a two-line scroll box. */
const MIN_USABLE_HEIGHT = 140;

/** Small anchored info popover: click an (i) icon to reveal a short tip near
 *  the trigger. Rendered through a portal into document.body so `position:
 *  fixed` coordinates resolve against the real viewport, not an ancestor
 *  with a `backdrop-filter`/`filter`/`transform` that would otherwise create
 *  its own containing block. */
const InfoPopover: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({ top: 0, left: 0, maxHeight: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Where the panel goes for the trigger's current position on screen.
  //
  // Long content used to run off the bottom of the window with no way to reach
  // it: the panel had no height bound, and a scroll gesture over it moved the
  // page behind instead. So bound the height to the space that is actually
  // there, flip the panel above the trigger when there is more room there, and
  // let it scroll inside itself.
  const measure = useCallback((): PopoverPosition => {
    const rect = triggerRef.current!.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN)
    );
    const below = window.innerHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN;
    const above = rect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
    if (below < MIN_USABLE_HEIGHT && above > below) {
      return {
        bottom: window.innerHeight - rect.top + TRIGGER_GAP,
        left,
        maxHeight: Math.max(above, MIN_USABLE_HEIGHT),
      };
    }
    return {
      top: rect.bottom + TRIGGER_GAP,
      left,
      maxHeight: Math.max(below, MIN_USABLE_HEIGHT),
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // The trigger moves whenever anything it sits in scrolls or the window is
    // resized, and a panel left at the old coordinates would float free of it.
    // Capture phase, because the scrolling element is usually a dialog body
    // rather than the window.
    const reposition = () => {
      if (triggerRef.current) setPosition(measure());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, measure]);

  const togglePopover = () => {
    if (!open && triggerRef.current) setPosition(measure());
    setOpen(!open);
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={togglePopover}
        aria-label={label}
        className="text-gray-400 hover:text-blue-600 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      {open && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
          <div
            style={{
              position: 'fixed',
              top: position.top,
              bottom: position.bottom,
              left: position.left,
              zIndex: 999,
              width: `${PANEL_WIDTH}px`,
              maxHeight: position.maxHeight,
              overflowY: 'auto',
              // Keep a scroll gesture that runs out of panel from carrying on
              // into the page behind, which is what made the overflowing text
              // unreachable.
              overscrollBehavior: 'contain',
            }}
            className="bg-white rounded-lg shadow-lg border border-gray-200 p-3 text-xs text-gray-700"
          >
            {children}
          </div>
        </>,
        document.body
      )}
    </>
  );
};

export default InfoPopover;
