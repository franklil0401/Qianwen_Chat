/** Streaming SSE decoder shared by the provider adapter and the browser client. */
export async function* readSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      while (true) {
        signal?.throwIfAborted();
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        // A CR may be the first half of a CRLF split between two reads.
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          if (data.length) { signal?.throwIfAborted(); yield data.join('\n'); }
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (buffer.length > 2_000_000 || data.reduce((size, line) => size + line.length, 0) > 2_000_000) {
        throw new Error('流式事件超过大小限制');
      }
      if (done) break;
    }
    // An event without a terminating blank line is incomplete and is not dispatched.
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
