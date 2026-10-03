import { describe, expect, it, vi } from "vitest";

import { SignalManager, type SignalManagerRuntime } from "./signal-handler.js";

type HandledSignal = "SIGINT" | "SIGTERM";
type SignalListener = () => void | Promise<void>;

function createRuntime() {
  const beforeExitListeners = new Set<() => void>();
  const listeners = new Map<HandledSignal, SignalListener>();
  let terminationFallback: (() => void) | undefined;
  let terminationFallbackDelay: number | undefined;
  const cancelTerminationFallback = vi.fn(() => {
    terminationFallback = undefined;
  });
  const exit = vi.fn<(code: number) => never>((code) => {
    throw new Error(`exit:${String(code)}`);
  });
  const error = vi.fn<(...values: unknown[]) => void>();
  const setExitCode = vi.fn<(code: number) => void>();
  const runtime: SignalManagerRuntime = {
    addSignalListener: (signal, listener) => {
      listeners.set(signal, listener);
    },
    removeSignalListener: (signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    addBeforeExitListener: (listener) => {
      beforeExitListeners.add(listener);
    },
    removeBeforeExitListener: (listener) => {
      beforeExitListeners.delete(listener);
    },
    setExitCode,
    exit,
    error,
  };
  const scheduleTerminationFallback = (callback: () => void, delayMs: number): (() => void) => {
    terminationFallback = callback;
    terminationFallbackDelay = delayMs;
    return cancelTerminationFallback;
  };

  const send = async (signal: HandledSignal): Promise<void> => {
    const listener = listeners.get(signal);
    if (listener === undefined) throw new Error(`Missing ${signal} listener`);
    await listener();
  };

  const emitBeforeExit = (): void => {
    for (const listener of [...beforeExitListeners]) listener();
  };

  const fireTerminationFallback = (): void => {
    if (terminationFallback === undefined) throw new Error("Missing termination fallback");
    terminationFallback();
  };

  return {
    beforeExitListeners,
    cancelTerminationFallback,
    emitBeforeExit,
    error,
    exit,
    fireTerminationFallback,
    listeners,
    runtime,
    scheduleTerminationFallback,
    send,
    setExitCode,
    terminationFallbackDelay: () => terminationFallbackDelay,
  };
}

describe("SignalManager", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "aborts on %s, awaits cleanup in priority order, and leaves exit to the command",
    async (signal, exitCode) => {
      const { error, exit, runtime, scheduleTerminationFallback, send, setExitCode } =
        createRuntime();
      const manager = SignalManager.createForTesting(runtime, scheduleTerminationFallback);
      const events: string[] = [];
      let releaseCleanup: (() => void) | undefined;
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      manager.registerCleanup({
        name: "later",
        priority: 20,
        cleanup: () => {
          events.push("later");
        },
      });
      manager.registerCleanup({
        name: "first",
        priority: 10,
        cleanup: async () => {
          events.push("first:start");
          await cleanupGate;
          events.push("first:end");
        },
      });

      const handling = send(signal);
      await vi.waitFor(() => {
        expect(events).toEqual(["first:start"]);
      });

      expect(manager.getSignal().aborted).toBe(true);
      expect(setExitCode).toHaveBeenCalledWith(exitCode);
      expect(exit).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(`\n\nReceived ${signal} - cleaning up...`);

      releaseCleanup?.();
      await handling;

      expect(events).toEqual(["first:start", "first:end", "later"]);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it("forces exit one on a second signal while first-signal cleanup is pending", async () => {
    const { cancelTerminationFallback, exit, runtime, scheduleTerminationFallback, send } =
      createRuntime();
    const manager = SignalManager.createForTesting(runtime, scheduleTerminationFallback);
    let releaseCleanup: (() => void) | undefined;
    manager.registerCleanup({
      name: "pending",
      priority: 0,
      cleanup: () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    });

    const firstSignal = send("SIGINT");
    await vi.waitFor(() => {
      expect(manager.getSignal().aborted).toBe(true);
    });

    await expect(send("SIGTERM")).rejects.toThrow("exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(cancelTerminationFallback).toHaveBeenCalledOnce();

    releaseCleanup?.();
    await firstSignal;
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "forces the conventional %s exit code when a command does not unwind during the grace period",
    async (signal, exitCode) => {
      const {
        error,
        exit,
        fireTerminationFallback,
        runtime,
        scheduleTerminationFallback,
        send,
        terminationFallbackDelay,
      } = createRuntime();
      SignalManager.createForTesting(runtime, scheduleTerminationFallback);

      await send(signal);

      expect(terminationFallbackDelay()).toBe(5_000);
      expect(() => fireTerminationFallback()).toThrow(`exit:${String(exitCode)}`);
      expect(error).toHaveBeenLastCalledWith("\n\nForced exit (graceful shutdown timed out)");
      expect(exit).toHaveBeenCalledWith(exitCode);
    },
  );

  it("continues ordered cleanup after a handler fails", async () => {
    const { error, exit, runtime, scheduleTerminationFallback, send } = createRuntime();
    const manager = SignalManager.createForTesting(runtime, scheduleTerminationFallback);
    const events: string[] = [];
    const cleanupError = new Error("cleanup failed");
    manager.registerCleanup({
      name: "broken",
      priority: 1,
      cleanup: () => {
        events.push("broken");
        throw cleanupError;
      },
    });
    manager.registerCleanup({
      name: "healthy",
      priority: 2,
      cleanup: () => {
        events.push("healthy");
      },
    });

    await send("SIGINT");

    expect(events).toEqual(["broken", "healthy"]);
    expect(error).toHaveBeenCalledWith("Error in cleanup handler 'broken':", cleanupError);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "reasserts the %s exit code once after a command overwrites it while unwinding",
    async (signal, exitCode) => {
      const {
        beforeExitListeners,
        cancelTerminationFallback,
        emitBeforeExit,
        runtime,
        scheduleTerminationFallback,
        send,
        setExitCode,
      } = createRuntime();
      SignalManager.createForTesting(runtime, scheduleTerminationFallback);

      await send(signal);
      runtime.setExitCode(1);
      expect(setExitCode).toHaveBeenLastCalledWith(1);

      emitBeforeExit();

      expect(setExitCode).toHaveBeenLastCalledWith(exitCode);
      expect(cancelTerminationFallback).toHaveBeenCalledOnce();
      expect(beforeExitListeners).toHaveLength(0);
    },
  );
});
