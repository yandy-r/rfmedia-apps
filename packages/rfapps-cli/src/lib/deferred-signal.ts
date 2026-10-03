export type DeferredSignal = "SIGINT" | "SIGTERM";

let deferredSignal: DeferredSignal | undefined;

/** Record the first termination signal for the root CLI boundary to re-raise. */
export function deferSignal(signal: DeferredSignal): void {
  deferredSignal ??= signal;
}

/** Consume the deferred signal exactly once. */
export function takeDeferredSignal(): DeferredSignal | undefined {
  const signal = deferredSignal;
  deferredSignal = undefined;
  return signal;
}
