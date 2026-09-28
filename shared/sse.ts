/** Streaming SSE decoder shared by the provider adapter and the browser client. */
export async function* readSSE(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let dataLength = 0;
  const maxEventLength = 2_000_000;
  const assertLength = (length: number, max = maxEventLength) => {
    if (length > max) throw new Error('流式事件超过大小限制');
  };
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
        assertLength(match.index, maxEventLength + 6); // Allow the "data: " prefix.
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          if (data.length) { signal?.throwIfAborted(); yield data.join('\n'); }
          data = [];
          dataLength = 0;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '');
          dataLength += value.length + (data.length ? 1 : 0);
          assertLength(dataLength);
          data.push(value);
        }
      }
      // Bound an unfinished line, including a possible split CRLF delimiter.
      // A large network chunk containing many valid events is allowed.
      assertLength(buffer.length - (buffer.endsWith('\r') ? 1 : 0), maxEventLength + 6);
      if (done) break;
    }
    // An event without a terminating blank line is incomplete and is not dispatched.
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
