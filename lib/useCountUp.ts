"use client";
import { useEffect, useState, useRef } from "react";

export function useCountUp(end: number, durationMs = 2000, startOnMount = true) {
  const [value, setValue] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!startOnMount || startedRef.current) return;
    startedRef.current = true;
    const startTime = performance.now();
    const startVal = 0;

    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - (1 - progress) * (1 - progress);
      setValue(Math.floor(startVal + (end - startVal) * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }, [end, durationMs, startOnMount]);

  return value;
}
