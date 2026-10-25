"use client";

import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { Surface, useSurfaceProgress } from "ukibori";

/** Native button recipe; can receive props/ref from a headless asChild slot. */
export const PressSurface = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & {
  selected?: boolean;
  reducedMotion?: boolean | "auto";
}>(function PressSurface({ selected = false, reducedMotion = "auto", disabled,
  onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture,
  onKeyDown, onKeyUp, onBlur, onClick, ...props }, ref) {
  const [pressed, setPressed] = useState(false);
  const pointer = useRef<number | null>(null);
  const key = useRef<string | null>(null);
  const cancelledClick = useRef(false);
  const reset = useCallback(() => { pointer.current = null; key.current = null; setPressed(false); }, []);
  useEffect(() => { window.addEventListener("blur", reset); return () => window.removeEventListener("blur", reset); }, [reset]);
  useEffect(() => { if (disabled) reset(); }, [disabled]);
  const p = useSurfaceProgress(disabled ? 0 : pressed ? 1 : selected ? 0.375 : 0, { reducedMotion });
  return <Surface {...props} as="button" ref={ref} type={props.type ?? "button"} disabled={disabled}
    elevation={8 - 6 * p} thickness={3 - 2 * p} bevelWidth={4}
    data-progress={p}
    onPointerDown={event => {
      onPointerDown?.(event);
      if (event.defaultPrevented || disabled || !event.isPrimary || event.button !== 0) return;
      cancelledClick.current = false;
      pointer.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setPressed(true);
    }}
    onPointerUp={event => {
      onPointerUp?.(event);
      if (pointer.current !== event.pointerId) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      cancelledClick.current = event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom;
      reset();
    }}
    onPointerCancel={event => { onPointerCancel?.(event); if (pointer.current === event.pointerId) reset(); }}
    onLostPointerCapture={event => { onLostPointerCapture?.(event); if (pointer.current === event.pointerId) reset(); }}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (event.defaultPrevented || disabled || (event.key !== " " && event.key !== "Enter")) return;
      cancelledClick.current = false;
      key.current = event.key; setPressed(true);
    }}
    onKeyUp={event => { onKeyUp?.(event); if (key.current === event.key) reset(); }}
    onBlur={event => { onBlur?.(event); reset(); }}
    onClick={event => {
      if (cancelledClick.current) { cancelledClick.current = false; event.preventDefault(); return; }
      onClick?.(event);
    }} />;
});
