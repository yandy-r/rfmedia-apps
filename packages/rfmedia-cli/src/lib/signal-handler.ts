/**
 * Centralized signal management for graceful interruption
 *
 * This module provides a singleton SignalManager that handles SIGINT/SIGTERM signals
 * and orchestrates cleanup callbacks with priority ordering. It uses AbortController
 * for process-wide cancellation signals.
 *
 * @module signal-handler
 */

export interface CleanupHandler {
  /** Priority (0 = highest, 100 = lowest) */
  priority: number;
  /** Unique name for this handler */
  name: string;
  /** Cleanup function (can be async) */
  cleanup: () => Promise<void> | void;
}

type HandledSignal = "SIGINT" | "SIGTERM";
type SignalListener = () => void | Promise<void>;
type BeforeExitListener = () => void;
type TerminationFallbackScheduler = (callback: () => void, delayMs: number) => () => void;
const SIGNAL_TERMINATION_GRACE_MS = 5_000;

/**
 * Minimal process boundary used to isolate signal lifecycle tests.
 *
 * @internal
 */
export interface SignalManagerRuntime {
  addSignalListener(signal: HandledSignal, listener: SignalListener): void;
  removeSignalListener(signal: HandledSignal, listener: SignalListener): void;
  addBeforeExitListener(listener: BeforeExitListener): void;
  removeBeforeExitListener(listener: BeforeExitListener): void;
  setExitCode(code: number): void;
  exit(code: number): never;
  error(...values: unknown[]): void;
}

const processRuntime: SignalManagerRuntime = {
  addSignalListener: (signal, listener) => {
    process.on(signal, listener);
  },
  removeSignalListener: (signal, listener) => {
    process.off(signal, listener);
  },
  addBeforeExitListener: (listener) => {
    process.on("beforeExit", listener);
  },
  removeBeforeExitListener: (listener) => {
    process.off("beforeExit", listener);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  exit: (code) => process.exit(code),
  error: (...values) => {
    console.error(...values);
  },
};

const scheduleProcessTerminationFallback: TerminationFallbackScheduler = (callback, delayMs) => {
  const timeout = setTimeout(callback, delayMs);
  timeout.unref();
  return () => clearTimeout(timeout);
};

function signalExitCode(signal: HandledSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Singleton class for managing process-wide signal handling and cleanup
 */
export class SignalManager {
  private static instance: SignalManager | null = null;
  private abortController: AbortController;
  private cleanupHandlers: Map<string, CleanupHandler> = new Map();
  private isCleaningUp = false;
  private signalHandlersRegistered = false;
  private readonly signalListeners = new Map<HandledSignal, SignalListener>();
  private signalExitCode: number | undefined;
  private beforeExitListener: BeforeExitListener | undefined;
  private cancelTerminationFallback: (() => void) | undefined;

  private constructor(
    private readonly runtime: SignalManagerRuntime = processRuntime,
    private readonly scheduleTerminationFallback: TerminationFallbackScheduler = scheduleProcessTerminationFallback,
  ) {
    this.abortController = new AbortController();
  }

  /**
   * Get the singleton instance of SignalManager
   */
  static getInstance(): SignalManager {
    if (!SignalManager.instance) {
      SignalManager.instance = new SignalManager();
      SignalManager.instance.registerSignalHandlers();
    }
    return SignalManager.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (SignalManager.instance) {
      SignalManager.instance.dispose();
      SignalManager.instance = null;
    }
  }

  /**
   * Create an isolated manager with an injected process boundary.
   *
   * @internal Test seam; production callers should use getInstance().
   */
  static createForTesting(
    runtime: SignalManagerRuntime,
    scheduleTerminationFallback?: TerminationFallbackScheduler,
  ): SignalManager {
    const manager = new SignalManager(runtime, scheduleTerminationFallback);
    manager.registerSignalHandlers();
    return manager;
  }

  /**
   * Get the global AbortSignal for this process
   */
  getSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Check if the abort signal has been triggered
   */
  isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /**
   * Register a cleanup handler with priority
   * Lower priority numbers run first (0 = highest priority)
   */
  registerCleanup(handler: CleanupHandler): void {
    if (this.isAborted()) {
      throw new Error("Cannot register cleanup handler after abort");
    }
    this.cleanupHandlers.set(handler.name, handler);
  }

  /**
   * Unregister a cleanup handler by name
   */
  unregisterCleanup(name: string): void {
    this.cleanupHandlers.delete(name);
  }

  /**
   * Register signal handlers for SIGINT and SIGTERM
   */
  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) {
      return;
    }

    const signalHandler = async (signal: HandledSignal): Promise<void> => {
      if (this.isCleaningUp) {
        // Second signal - force exit
        this.clearTerminationFallback();
        this.runtime.error("\n\nForced exit (received second signal)");
        this.runtime.exit(1);
      }

      this.runtime.error(`\n\nReceived ${signal} - cleaning up...`);
      try {
        await this.handleSignal(signal);
      } catch (err) {
        this.clearTerminationFallback();
        this.runtime.error("Error during cleanup:", err);
        this.runtime.exit(1);
      }
    };

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listener = (): Promise<void> => signalHandler(signal);
      this.signalListeners.set(signal, listener);
      this.runtime.addSignalListener(signal, listener);
    }

    this.signalHandlersRegistered = true;
  }

  /**
   * Handle signal by aborting and running cleanup handlers
   */
  private async handleSignal(signal: HandledSignal): Promise<void> {
    if (this.isCleaningUp) {
      return;
    }

    this.isCleaningUp = true;
    this.preserveSignalExitCode(signalExitCode(signal));

    // Abort all operations
    this.abortController.abort();

    // Sort handlers by priority (lowest number = highest priority)
    const sortedHandlers = Array.from(this.cleanupHandlers.values()).sort(
      (a, b) => a.priority - b.priority,
    );

    // Run cleanup handlers in priority order
    for (const handler of sortedHandlers) {
      try {
        await Promise.resolve(handler.cleanup());
      } catch (err) {
        this.runtime.error(`Error in cleanup handler '${handler.name}':`, err);
      }
    }
  }

  /**
   * Keep the first signal's conventional exit code authoritative after command
   * handlers finish unwinding without terminating before cleanup completes.
   */
  private preserveSignalExitCode(exitCode: number): void {
    this.signalExitCode = exitCode;
    this.runtime.setExitCode(exitCode);
    if (this.cancelTerminationFallback === undefined) {
      this.cancelTerminationFallback = this.scheduleTerminationFallback(() => {
        this.cancelTerminationFallback = undefined;
        this.runtime.error("\n\nForced exit (graceful shutdown timed out)");
        this.runtime.exit(exitCode);
      }, SIGNAL_TERMINATION_GRACE_MS);
    }
    if (this.beforeExitListener !== undefined) return;

    const listener = (): void => {
      try {
        this.clearTerminationFallback();
        if (this.signalExitCode !== undefined) {
          this.runtime.setExitCode(this.signalExitCode);
        }
      } finally {
        this.runtime.removeBeforeExitListener(listener);
        if (this.beforeExitListener === listener) {
          this.beforeExitListener = undefined;
        }
      }
    };
    this.beforeExitListener = listener;
    this.runtime.addBeforeExitListener(listener);
  }

  private clearTerminationFallback(): void {
    this.cancelTerminationFallback?.();
    this.cancelTerminationFallback = undefined;
  }

  /**
   * Remove registered listeners and release retained cleanup handlers.
   */
  private dispose(): void {
    for (const [signal, listener] of this.signalListeners) {
      this.runtime.removeSignalListener(signal, listener);
    }
    this.signalListeners.clear();
    if (this.beforeExitListener !== undefined) {
      this.runtime.removeBeforeExitListener(this.beforeExitListener);
      this.beforeExitListener = undefined;
    }
    this.clearTerminationFallback();
    this.signalExitCode = undefined;
    this.signalHandlersRegistered = false;
    this.cleanupHandlers.clear();
    this.isCleaningUp = false;
  }
}

/**
 * Get the global AbortSignal for the current process
 */
export function getGlobalSignal(): AbortSignal {
  return SignalManager.getInstance().getSignal();
}

/**
 * Register a cleanup handler with the global SignalManager
 */
export function registerGlobalCleanup(handler: CleanupHandler): void {
  SignalManager.getInstance().registerCleanup(handler);
}

/**
 * Unregister a cleanup handler from the global SignalManager
 */
export function unregisterGlobalCleanup(name: string): void {
  SignalManager.getInstance().unregisterCleanup(name);
}

/**
 * Check if the global signal has been aborted
 */
export function isAborted(): boolean {
  return SignalManager.getInstance().isAborted();
}
