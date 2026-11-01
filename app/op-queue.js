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
 */
function createOpQueue() {
  let chain = Promise.resolve();
  let running = 0;

  const invoke = async (fn) => {
    running++;
    try {
      return await fn();
    } finally {
      running--;
    }
  };

  /**
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>} resolves/rejects with fn's outcome
   */
  function serialize(fn) {
    if (running > 0) {
      // nested call: the queue is already held by the caller
      return Promise.resolve().then(fn, fn);
    }
    const next = chain.then(() => invoke(fn), () => invoke(fn));
    chain = next.catch(() => {});
    return next;
  }

  return { serialize };
}

module.exports = { createOpQueue };
