import { MessageRowSchema, type MessageRow } from './types.js';

export interface SseStreamOptions {
  readonly apiBase: string;
  readonly bearerToken: string;
  readonly roomId: string;
  readonly afterSeq: number;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export interface SseEvent {
  readonly type: 'message' | 'reconnect' | 'retry' | 'unknown';
  readonly row?: MessageRow;
  readonly cursor?: number;
  readonly lastEventId?: string;
  readonly retryMs?: number;
}

interface ParsedFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export function parseFrames(buf: string): { frames: ParsedFrame[]; remainder: string } {
  const out: ParsedFrame[] = [];
  let remainder = buf;
  while (true) {
    const idx = remainder.indexOf('\n\n');
    if (idx === -1) break;
    const block = remainder.slice(0, idx);
    remainder = remainder.slice(idx + 2);
    let event = 'message';
    let id: string | undefined;
    let retry: number | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      // Per-line comment skip (SSE spec): a line starting with ':' is a comment.
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      } else if (line.startsWith('id:')) {
        id = line.slice(3).trim();
      } else if (line.startsWith('retry:')) {
        const n = Number(line.slice(6).trim());
        if (Number.isFinite(n) && n > 0) retry = n;
      }
    }
    if (dataLines.length === 0 && id === undefined && retry === undefined) continue;
    out.push({ event, data: dataLines.join('\n'), id, retry });
  }
  return { frames: out, remainder };
}

/**
 * Long-polls the AgentMeet SSE endpoint and yields parsed message events.
 * The server closes the stream every ~25s with a `reconnect` event carrying a cursor —
 * callers should re-invoke this generator with the new cursor and any seen lastEventId.
 */
export async function* streamMessages(opts: SseStreamOptions): AsyncGenerator<SseEvent> {
  const f = opts.fetchImpl ?? fetch;
  const url = new URL(`${opts.apiBase}/api/v1/rooms/${opts.roomId}/stream`);
  url.searchParams.set('after_seq', String(opts.afterSeq));

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearerToken}`,
    Accept: 'text/event-stream',
  };
  if (opts.lastEventId && opts.lastEventId.length > 0) {
    headers['Last-Event-ID'] = opts.lastEventId;
  }

  const res = await f(url, {
    method: 'GET',
    headers,
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connection failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  // Cap buffer growth at 1 MiB. If a malicious or misbehaving server sends a
  // response body that never contains a frame terminator (`\n\n`), we abort
  // rather than grow the string until the Node process OOMs.
  const MAX_BUFFER = 1_048_576;
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER) {
        throw new Error(`SSE buffer exceeded ${MAX_BUFFER} bytes without a frame terminator`);
      }
      const { frames, remainder } = parseFrames(buffer);
      buffer = remainder;
      for (const frame of frames) {
        // Surface a server-requested retry interval independently so callers can honour it.
        if (frame.retry !== undefined) {
          yield { type: 'retry', retryMs: frame.retry, lastEventId: frame.id };
        }
        if (frame.event === 'message') {
          if (frame.data.length === 0) continue;
          try {
            const json: unknown = JSON.parse(frame.data);
            const row = MessageRowSchema.parse(json);
            yield { type: 'message', row, lastEventId: frame.id };
          } catch {
            yield { type: 'unknown', lastEventId: frame.id };
          }
        } else if (frame.event === 'reconnect') {
          try {
            const json: unknown = JSON.parse(frame.data);
            const cursor =
              typeof json === 'object' && json !== null && 'cursor' in json
                ? Number((json as { cursor: unknown }).cursor)
                : undefined;
            yield { type: 'reconnect', cursor, lastEventId: frame.id };
          } catch {
            yield { type: 'reconnect', lastEventId: frame.id };
          }
        } else if (frame.data.length > 0) {
          yield { type: 'unknown', lastEventId: frame.id };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
