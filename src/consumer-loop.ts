export interface ConsumerLoopOptions {
  connect: () => Promise<void>;
  subscribe: () => Promise<void>;
  run: () => Promise<void>;
  disconnect: () => Promise<void>;
  shouldStop: () => boolean;
  markUnavailable: () => void;
  onFailure: (error: unknown) => void;
  wait?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  stoppedMessage: string;
}

const defaultWait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function runConsumerLoop(options: ConsumerLoopOptions): Promise<void> {
  const wait = options.wait ?? defaultWait;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  while (!options.shouldStop()) {
    let failure: unknown;
    options.markUnavailable();
    try {
      await options.connect();
      await options.subscribe();
      await options.run();
      if (!options.shouldStop()) failure = new Error(options.stoppedMessage);
    } catch (error) {
      failure = error;
    }
    options.markUnavailable();
    await options.disconnect().catch(() => undefined);
    if (options.shouldStop()) break;
    options.onFailure(failure);
    await wait(retryDelayMs);
  }
}
