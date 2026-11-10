import { describe, it, expect } from 'vitest';
import { MessageRowSchema, readChatText } from '../src/agentmeet/types.js';

const base = {
  id: 'm1',
  seq: 1,
  hash: 'h1',
  kind: 'system',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('MessageRowSchema body', () => {
  it('accepts a row with no body key', () => {
    const parsed = MessageRowSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(readChatText(parsed.data.body)).toBeNull();
    }
  });

  it('accepts a null body', () => {
    expect(MessageRowSchema.safeParse({ ...base, body: null }).success).toBe(true);
  });

  it('keeps a chat body readable', () => {
    const parsed = MessageRowSchema.safeParse({ ...base, kind: 'chat', body: { text: 'hi' } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(readChatText(parsed.data.body)).toEqual({ text: 'hi' });
    }
  });
});
