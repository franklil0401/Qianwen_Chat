import { describe, expect, it } from 'vitest';
import { readSSE } from '../shared/sse';

function bytesStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } });
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const events: string[] = [];
  for await (const data of readSSE(stream)) events.push(data);
  return events;
}

describe('SSE framing across network chunks', () => {
  it('preserves Chinese UTF-8 characters even when every byte arrives separately', async () => {
    const bytes = new TextEncoder().encode('data: {"delta":"你好，千问"}\n\ndata: [DONE]\n\n');
    const events = await collect(bytesStream([...bytes].map(byte => new Uint8Array([byte]))));
    expect(events).toEqual(['{"delta":"你好，千问"}', '[DONE]']);
  });
  it('handles split CRLF, comments, multiple data lines, and independent events', async () => {
    const chunks = [': ping\r', '\ndata: first\r', '\ndata: second\r', '\n\r', '\ndata: third\n\n'];
    expect(await collect(bytesStream(chunks.map(text => new TextEncoder().encode(text))))).toEqual(['first\nsecond', 'third']);
  });
  it('does not dispatch a truncated event', async () => {
    expect(await collect(bytesStream([new TextEncoder().encode('data: complete\n\ndata: incomplete\n')]))).toEqual(['complete']);
  });
  it('cancels a stalled reader when interrupted', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const iterator = readSSE(stream, controller.signal);
    const next = iterator.next();
    controller.abort();
    await expect(next).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it('does not dispatch buffered events after cancellation between yields', async () => {
    const controller = new AbortController();
    const stream = bytesStream([new TextEncoder().encode('data: first\n\ndata: stale\n\n')]);
    const iterator = readSSE(stream, controller.signal);
    expect((await iterator.next()).value).toBe('first');
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
});
