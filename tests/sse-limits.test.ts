import { describe, expect, it } from 'vitest';
import { readSSE } from '../shared/sse';

function stream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } });
}

async function collect(chunks: string[]) {
  const events: string[] = [];
  for await (const data of readSSE(stream(chunks))) events.push(data);
  return events;
}

describe('SSE event size boundaries', () => {
  it('rejects an oversized complete event in one network chunk before yielding it', async () => {
    const iterator = readSSE(stream([`data: ${'x'.repeat(2_000_001)}\n\n`]));
    await expect(iterator.next()).rejects.toThrow('流式事件超过大小限制');
  });

  it('counts all data lines and their joining newline before dispatch', async () => {
    const iterator = readSSE(stream([`data: ${'a'.repeat(1_000_000)}\ndata: ${'b'.repeat(1_000_000)}\n\n`]));
    await expect(iterator.next()).rejects.toThrow('流式事件超过大小限制');
  });

  it('rejects a growing event split between network reads before dispatch', async () => {
    const iterator = readSSE(stream([`data: ${'a'.repeat(1_500_000)}`, `${'b'.repeat(500_001)}\n\n`]));
    await expect(iterator.next()).rejects.toThrow('流式事件超过大小限制');
  });

  it('accepts multiple legal events whose shared network chunk exceeds the limit', async () => {
    const payloads = ['a'.repeat(1_200_000), 'b'.repeat(1_200_000)];
    const events = await collect([payloads.map(value => `data: ${value}\n\n`).join('')]);
    expect(events).toEqual(payloads);
  });

  it('accepts an event exactly at the size limit with CRLF split across chunks', async () => {
    const payload = 'x'.repeat(2_000_000);
    expect(await collect([`data: ${payload}\r`, '\n\r', '\n'])).toEqual([payload]);
  });

  it('does not reject a complete legal event followed by another partial event in the same chunk', async () => {
    const first = 'a'.repeat(1_200_000);
    const second = 'b'.repeat(1_200_000);
    expect(await collect([`data: ${first}\n\ndata: ${second.slice(0, 900_000)}`, `${second.slice(900_000)}\n\n`])).toEqual([first, second]);
  });
});
