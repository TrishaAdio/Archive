import { DURABLE_WRITE } from "../db.js";

function createCounterService(counters) {
  async function reserveBlock(name, count) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error("Counter block size must be a positive integer");
    }

    const updated = await counters.findOneAndUpdate(
      { _id: name },
      { $inc: { allocated: count } },
      { upsert: true, returnDocument: "after", writeConcern: DURABLE_WRITE },
    );

    const end = updated?.allocated;
    if (!Number.isInteger(end)) {
      throw new Error(`Counter ${name} returned a non-integer allocation`);
    }

    return { start: end - count + 1, end };
  }

  async function peek(name) {
    const doc = await counters.findOne({ _id: name });
    return doc?.allocated ?? 0;
  }

  return { reserveBlock, peek };
}

export { createCounterService };
