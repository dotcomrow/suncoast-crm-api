import assert from "node:assert/strict";
import test from "node:test";
import { runConsumerLoop } from "../src/consumer-loop.js";

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
