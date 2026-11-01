'use strict';
/**
 * op-queue.test.js — the serialized operation queue.
 *
 * The queue exists so concurrent tray clicks / IPC calls cannot spawn two
 * rclone processes. The subtle failure mode it must NOT have: a nested
 * serialize() call from inside a serialized operation would wait for the
 * outer operation, which waits for the inner one — a deadlock that hangs the
 * mount forever. Nested calls must run inline instead.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { createOpQueue } = require('../../app/op-queue.js');

test('serialize runs operations one at a time, in order', async () => {
  const { serialize } = createOpQueue();
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const op = (id, ms) => serialize(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    order.push(id);
    inFlight--;
    return id;
  });
  const results = await Promise.all([op('a', 30), op('b', 5), op('c', 10)]);
  assert.equal(maxInFlight, 1, 'operations must never overlap');
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(results, ['a', 'b', 'c']);
});

test('a failing operation does not poison the queue', async () => {
  const { serialize } = createOpQueue();
  await assert.rejects(serialize(async () => { throw new Error('boom'); }), /boom/);
  const ok = await serialize(async () => 'after-failure');
  assert.equal(ok, 'after-failure');
});

test('nested serialize runs inline (no deadlock)', async () => {
  const { serialize } = createOpQueue();
  // outer operation calls the queue again from inside: the naive chaining
  // implementation deadlocks here forever
  const out = await serialize(async () => {
    const inner = await serialize(async () => 'inner');
    return 'outer+' + inner;
  });
  assert.equal(out, 'outer+inner');
});

test('nested serialize still excludes OUTSIDE operations', async () => {
  const { serialize } = createOpQueue();
  let inFlight = 0;
  let maxInFlight = 0;
  const op = () => serialize(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
  });
  // outer op nests an inner op; meanwhile another op is queued from outside
  const outer = serialize(async () => {
    await serialize(op);
    await new Promise((r) => setTimeout(r, 10));
  });
  const outside = op();
  await Promise.all([outer, outside]);
  assert.equal(maxInFlight, 1, 'the nested call must not break mutual exclusion');
});
