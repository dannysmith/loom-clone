import { useRef, useState } from 'react';

type Args = {
  x: number;
  y: number;
  onMove: (x: number, y: number) => void;
};

// Generic drag hook for an SVG element. Returns pointer handlers and an
// isDragging flag so the caller can style the cursor.
//
// Coordinate conversion is done via createSVGPoint + getScreenCTM().inverse()
// on the *outermost* SVG (via ownerSVGElement), so the slot's (x, y) — which
// live in the outer viewBox coordinate system — stay consistent regardless
// of how the SVG is scaled to fit its container.
export function useSvgDrag({ x, y, onMove }: Args) {
  const [isDragging, setIsDragging] = useState(false);
  // Pointer-to-slot offset captured at drag start, in viewBox coords.
  const offset = useRef({ dx: 0, dy: 0 });
  const dragging = useRef(false);

  const screenToSvg = (e: { clientX: number; clientY: number }, svg: SVGSVGElement) => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  };

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    const target = e.currentTarget;
    const svg = target.ownerSVGElement;
    if (!svg) return;
    const pt = screenToSvg(e, svg);
    if (!pt) return;
    offset.current = { dx: x - pt.x, dy: y - pt.y };
    dragging.current = true;
    setIsDragging(true);
    target.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<SVGElement>) => {
    if (!dragging.current) return;
    const target = e.currentTarget;
    const svg = target.ownerSVGElement;
    if (!svg) return;
    const pt = screenToSvg(e, svg);
    if (!pt) return;
    onMove(Math.round(pt.x + offset.current.dx), Math.round(pt.y + offset.current.dy));
  };

  const stopDragging = (e: React.PointerEvent<SVGElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore — pointer may not be captured if drag never started
    }
  };

  return {
    isDragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
    },
  };
}
