'use strict';
/**
 * op-queue.js — a serialized operation queue for the main process.
 *
 * server/mount/unmount must never overlap (concurrent rclone spawns orphan
 * processes and lose mount state), so those operations go through this queue.
 *
 * Reentrancy: calling serialize() from INSIDE a serialized operation would
 * deadlock (the inner link waits for the outer one, which waits for the
 * inner). Nested calls therefore run inline — the outer operation already
 * holds the queue, so the work is still serialized against the outside world.
 *
 * Nesting is detected with AsyncLocalStorage (the async context propagates
 * through awaits inside the operation), NOT with an in-flight counter: a
 * counter cannot tell a nested call apart from an INDEPENDENT operation
 * submitted while one is in flight, and would let the latter run inline —
 * overlapping two rclone spawns (audit finding Q-1).
 */
const { AsyncLocalStorage } = require('node:async_hooks');

function createOpQueue() {
  let chain = Promise.resolve();
  // store is truthy only while the current async context is inside a
  // serialized operation
  const inside = new AsyncLocalStorage();

  /**
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>} resolves/rejects with fn's outcome
   */
  function serialize(fn) {
    if (inside.getStore()) {
      // genuinely nested call: the queue is already held by the caller
      return Promise.resolve().then(fn, fn);
    }
    const next = chain.then(() => inside.run(true, fn), () => inside.run(true, fn));
    chain = next.catch(() => {});
    return next;
  }

  return { serialize };
}

module.exports = { createOpQueue };
