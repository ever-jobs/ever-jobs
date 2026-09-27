import { NdjsonWriter } from '../ndjson-writer';

/**
 * Spec 1721 — line-at-a-time NDJSON writer: back-pressure, ordering, and a
 * consumer that goes away must never park the producer.
 */
describe('NdjsonWriter (Spec 1721)', () => {
  it('writes 1 000 lines in order under a tiny high-water mark (back-pressure honoured)', async () => {
    const writer = new NdjsonWriter({ highWaterMark: 64 });
    const received: Buffer[] = [];
    let drained = 0;
    writer.stream.on('drain', () => drained++);

    // Slow consumer: read only after the producer has started blocking.
    const consume = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      for await (const chunk of writer.stream) received.push(Buffer.from(chunk as Buffer));
    })();

    for (let i = 0; i < 1_000; i++) {
      expect(await writer.write({ type: 'n', i })).toBe(true);
    }
    writer.end();
    await consume;

    const lines = Buffer.concat(received).toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(1_000);
    expect(lines.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual(
      Array.from({ length: 1_000 }, (_, i) => i),
    );
    expect(drained).toBeGreaterThan(0);
  });

  it('writeJob wraps the job JSON verbatim', async () => {
    const writer = new NdjsonWriter();
    const job = { id: 'a', nested: { x: [1, 2] }, date: new Date('2026-01-02T03:04:05.000Z') };
    await writer.writeJob(job);
    writer.end();
    const chunks: Buffer[] = [];
    for await (const chunk of writer.stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString('utf8')).toBe(
      `{"type":"job","data":${JSON.stringify(job)}}\n`,
    );
  });

  it('after abort every write resolves false and nothing throws', async () => {
    const writer = new NdjsonWriter();
    writer.abort();
    expect(writer.isClosed).toBe(true);
    expect(await writer.write({ type: 'x' })).toBe(false);
    expect(await writer.writeJob({})).toBe(false);
    expect(() => writer.writeNow({ type: 'x' })).not.toThrow();
    expect(() => writer.end()).not.toThrow();
  });

  it('a producer blocked on drain is released when the consumer goes away', async () => {
    const writer = new NdjsonWriter({ highWaterMark: 16 });
    // Nobody reads: the first write that crosses the high-water mark blocks.
    let pending: Promise<boolean> | undefined;
    for (let i = 0; i < 10 && !pending; i++) {
      const p = writer.write({ padding: 'x'.repeat(32), i });
      const settled = await Promise.race([p.then(() => true), new Promise((r) => setImmediate(() => r(false)))]);
      if (!settled) pending = p;
    }
    expect(pending).toBeDefined();
    writer.abort();
    await expect(pending).resolves.toBe(false);
  });

  it('writeNow after end is a no-op', async () => {
    const writer = new NdjsonWriter();
    await writer.write({ type: 'end' });
    writer.end();
    writer.writeNow({ type: 'progress' });
    const chunks: Buffer[] = [];
    for await (const chunk of writer.stream) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"type":"end"}\n');
  });
});
