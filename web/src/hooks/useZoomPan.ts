import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Zoom and pan for the lightbox.
 *
 * Zooming is anchored to the pointer rather than the centre of the frame: when
 * you scroll to inspect a corner, that corner should stay under the cursor.
 * Anchoring to the centre instead means the thing you were looking at slides
 * away and you have to chase it, which is what makes most home-grown viewers
 * unpleasant to actually use.
 */

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;

export interface UseZoomPanResult {
  state: ZoomState;
  isZoomed: boolean;
  reset: () => void;
  /** Attach to the element that should receive gestures. */
  handlers: {
    onWheel: (event: React.WheelEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onDoubleClick: (event: React.MouseEvent) => void;
  };
  /** True while a drag is in progress, for cursor styling. */
  panning: boolean;
}

export function useZoomPan(containerRef: React.RefObject<HTMLElement | null>): UseZoomPanResult {
  const [state, setState] = useState<ZoomState>({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  // Live values for the pointer handlers, which run outside React's render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const reset = useCallback(() => setState({ scale: 1, x: 0, y: 0 }), []);

  /**
   * Keeps the image from being dragged off screen.
   *
   * At scale 1 the offset is pinned to zero; beyond that the image may move by
   * however much of it overflows the frame, and no further.
   */
  const clamp = useCallback(
    (next: ZoomState): ZoomState => {
      const element = containerRef.current;
      if (!element || next.scale <= 1) return { scale: Math.max(1, next.scale), x: 0, y: 0 };

      const rect = element.getBoundingClientRect();
      const maxX = (rect.width * (next.scale - 1)) / 2;
      const maxY = (rect.height * (next.scale - 1)) / 2;

      return {
        scale: next.scale,
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
    },
    [containerRef],
  );

  /** Zooms toward a point given in client coordinates. */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const element = containerRef.current;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const current = stateRef.current;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      if (nextScale === current.scale) return;

      // Offset of the pointer from the frame centre.
      const pointerX = clientX - (rect.left + rect.width / 2);
      const pointerY = clientY - (rect.top + rect.height / 2);

      // Solve for the translation that leaves the point under the pointer
      // fixed as the scale changes.
      const ratio = nextScale / current.scale;
      setState(
        clamp({
          scale: nextScale,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        }),
      );
    },
    [containerRef, clamp],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      // Ctrl+wheel is the browser's pinch gesture on a trackpad; both mean zoom
      // here, and both must be prevented or the page zooms instead.
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAt(event.clientX, event.clientY, factor);
    },
    [zoomAt],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (stateRef.current.scale > 1) reset();
      else zoomAt(event.clientX, event.clientY, DOUBLE_TAP_SCALE);
    },
    [zoomAt, reset],
  );

  /**
   * Drag to pan, and two-finger pinch on touch.
   *
   * Pointer events cover mouse, pen and touch in one path; the pinch case just
   * tracks two active pointers and works from the distance between them.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      const element = containerRef.current;
      if (!element) return;

      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      // A single pointer only pans when there is something to pan.
      if (pointers.current.size === 1 && stateRef.current.scale <= 1) return;

      event.preventDefault();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      setPanning(true);

      const startState = { ...stateRef.current };
      const startX = event.clientX;
      const startY = event.clientY;

      const onMove = (move: PointerEvent) => {
        pointers.current.set(move.pointerId, { x: move.clientX, y: move.clientY });

        if (pointers.current.size >= 2) {
          const [a, b] = [...pointers.current.values()];
          if (!a || !b) return;
          const distance = Math.hypot(b.x - a.x, b.y - a.y);

          if (!pinchStart.current) {
            pinchStart.current = { distance, scale: stateRef.current.scale };
            return;
          }

          const ratio = distance / pinchStart.current.distance;
          const nextScale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, pinchStart.current.scale * ratio),
          );
          setState((prev) => clamp({ ...prev, scale: nextScale }));
          return;
        }

        setState(
          clamp({
            scale: startState.scale,
            x: startState.x + (move.clientX - startX),
            y: startState.y + (move.clientY - startY),
          }),
        );
      };

      const onUp = (up: PointerEvent) => {
        pointers.current.delete(up.pointerId);
        if (pointers.current.size < 2) pinchStart.current = null;
        if (pointers.current.size === 0) {
          setPanning(false);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [containerRef, clamp],
  );

  // Browsers treat wheel listeners added via React as passive, so
  // preventDefault there is ignored and the page zooms behind the lightbox.
  // A non-passive native listener is the only way to actually stop it.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const nativeWheel = (event: WheelEvent) => event.preventDefault();
    element.addEventListener('wheel', nativeWheel, { passive: false });
    return () => element.removeEventListener('wheel', nativeWheel);
  }, [containerRef]);

  return {
    state,
    isZoomed: state.scale > 1.01,
    reset,
    panning,
    handlers: { onWheel, onPointerDown, onDoubleClick },
  };
}
