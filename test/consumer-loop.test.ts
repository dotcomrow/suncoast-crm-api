import assert from "node:assert/strict";
import test from "node:test";
import type { Consumer } from "kafkajs";
import { runConsumerLoop, runKafkaJsConsumerUntilExit } from "../src/consumer-loop.js";

test("KafkaJS session waits for an actual consumer exit event", async () => {
  const listeners = new Map<string, Set<() => void>>();
  const events = {
    CRASH: "consumer.crash",
    STOP: "consumer.stop",
    DISCONNECT: "consumer.disconnect"
  } as const;
  const consumer = {
    events,
    on: (eventName: string, listener: () => void) => {
      const eventListeners = listeners.get(eventName) ?? new Set<() => void>();
      eventListeners.add(listener);
      listeners.set(eventName, eventListeners);
      return () => { eventListeners.delete(listener); };
    },
    run: async () => undefined
  } as unknown as Consumer;

  let settled = false;
  const session = runKafkaJsConsumerUntilExit(consumer, {}).then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  for (const listener of listeners.get(events.CRASH) ?? []) listener();
  await session;
  assert.equal(settled, true);
});

test("consumer loop reconnects when a running consumer stops unexpectedly", async () => {
  let stopped = false;
  let connects = 0;
  let runs = 0;
  let disconnects = 0;
  const failures: unknown[] = [];

  await runConsumerLoop({
    connect: async () => { connects += 1; },
    subscribe: async () => undefined,
    run: async () => {
      runs += 1;
      if (runs === 2) stopped = true;
    },
    disconnect: async () => { disconnects += 1; },
    shouldStop: () => stopped,
    markUnavailable: () => undefined,
    onFailure: (error) => failures.push(error),
    wait: async () => undefined,
    stoppedMessage: "consumer stopped"
  });

  assert.equal(connects, 2);
  assert.equal(runs, 2);
  assert.equal(disconnects, 2);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /consumer stopped/);
});

test("consumer loop reconnects after a connection failure", async () => {
  let stopped = false;
  let connects = 0;
  let runs = 0;
  const failures: unknown[] = [];

  await runConsumerLoop({
    connect: async () => {
      connects += 1;
      if (connects === 1) throw new Error("broker unavailable");
    },
    subscribe: async () => undefined,
    run: async () => { runs += 1; stopped = true; },
    disconnect: async () => undefined,
    shouldStop: () => stopped,
    markUnavailable: () => undefined,
    onFailure: (error) => failures.push(error),
    wait: async () => undefined,
    stoppedMessage: "consumer stopped"
  });

  assert.equal(connects, 2);
  assert.equal(runs, 1);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /broker unavailable/);
});
