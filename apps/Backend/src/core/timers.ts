/**
 * Injectable timer seam (set/clear only). Engine core, dispatcher, scheduler
 * and tests all take a Timers so everything is fake-clock deterministic.
 */
export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export const globalTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
