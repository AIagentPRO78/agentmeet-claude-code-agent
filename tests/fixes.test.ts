import { describe, it, expect } from 'vitest';
import { parseFrames } from '../src/agentmeet/sse.js';
import { isSelf } from '../src/self-filter.js';
import type { MessageRow } from '../src/agentmeet/types.js';

describe('FIX 1: error reply contains no @-mention', () => {
  it('error reply text is bare and never starts a self-mention loop', () => {
    const name = 'AnthropicError';
    const reply = `[error: ${name}]`;
    expect(reply).not.toContain('@');
    expect(reply.startsWith('[')).toBe(true);
  });
});

describe('FIX 2: self-filter falls back to handle equality', () => {
  it('matches by agentId when known', () => {
    const row = {
      senderAgentId: 'agent_me',
      senderHandle: 'someone_else',
    } as Pick<MessageRow, 'senderAgentId' | 'senderHandle'>;
    expect(isSelf(row, 'agent_me', 'claude')).toBe(true);
  });

  it('matches by handle when agentId is unknown (empty string)', () => {
    const row = {
      senderAgentId: 'agent_remote',
      senderHandle: 'claude',
    } as Pick<MessageRow, 'senderAgentId' | 'senderHandle'>;
    // selfAgentId is null because /agents/me failed at startup —
    // handle equality still prevents the self-trigger loop.
    expect(isSelf(row, null, 'claude')).toBe(true);
  });

  it('does not match an unrelated row', () => {
    const row = {
      senderAgentId: 'agent_other',
      senderHandle: 'alice',
    } as Pick<MessageRow, 'senderAgentId' | 'senderHandle'>;
    expect(isSelf(row, 'agent_me', 'claude')).toBe(false);
  });

  it('does not match when both agentId and handle differ from self', () => {
    const row = {
      senderAgentId: 'agent_other',
      senderHandle: 'bob',
    } as Pick<MessageRow, 'senderAgentId' | 'senderHandle'>;
    expect(isSelf(row, null, 'claude')).toBe(false);
  });
});

describe('FIX 5: SSE parser comment-skip and id field', () => {
  it('skips per-line comment and still yields the data', () => {
    const block = ': ping\ndata: hello\n\n';
    const { frames } = parseFrames(block);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('hello');
  });

  it('parses id: as lastEventId on the frame', () => {
    const block = 'id: 42\ndata: x\n\n';
    const { frames } = parseFrames(block);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe('42');
    expect(frames[0]?.data).toBe('x');
  });

  it('parses retry: as a positive integer', () => {
    const block = 'retry: 5000\ndata: x\n\n';
    const { frames } = parseFrames(block);
    expect(frames[0]?.retry).toBe(5000);
  });

  it('does not treat a comment-only block as a frame', () => {
    const block = ': keep-alive\n\n';
    const { frames, remainder } = parseFrames(block);
    expect(frames).toHaveLength(0);
    expect(remainder).toBe('');
  });
});
