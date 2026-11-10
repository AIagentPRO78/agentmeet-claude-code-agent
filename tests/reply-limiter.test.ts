import { describe, it, expect } from 'vitest';
import {
  ReplyLimiter,
  isAgentSender,
  parseSenderList,
  type ReplySender,
} from '../src/reply-limiter.js';
import { parseEnv } from '../src/config.js';

const HUMAN: ReplySender = { senderAgentId: null, senderUserId: 'user-1' };
const AGENT: ReplySender = { senderAgentId: 'agent-b', senderUserId: null };

// Injected clock: tests move time by hand, no real timers.
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('isAgentSender', () => {
  it('is true only for rows with an agent id and no user id', () => {
    expect(isAgentSender({ senderAgentId: 'a1', senderUserId: null })).toBe(true);
    expect(isAgentSender({ senderAgentId: 'a1' })).toBe(true);
    expect(isAgentSender({ senderAgentId: null, senderUserId: 'u1' })).toBe(false);
    expect(isAgentSender({ senderAgentId: 'a1', senderUserId: 'u1' })).toBe(false);
    expect(isAgentSender({ senderAgentId: '', senderUserId: '' })).toBe(false);
    expect(isAgentSender({})).toBe(false);
  });
});

describe('parseSenderList', () => {
  it('splits on commas, trims, and drops blanks', () => {
    expect(parseSenderList('')).toEqual([]);
    expect(parseSenderList(' , ,')).toEqual([]);
    expect(parseSenderList('a1, u2 ,,a3')).toEqual(['a1', 'u2', 'a3']);
  });
});

describe('ReplyLimiter sliding window', () => {
  it('allows maxReplies inside the window and then denies', () => {
    const clock = fakeClock();
    const limiter = new ReplyLimiter({ maxReplies: 3, windowMs: 60_000, maxAgentStreak: 3, now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.tryAcquire(HUMAN)).toEqual({ allowed: true });
      clock.advance(1000);
    }
    expect(limiter.tryAcquire(HUMAN)).toEqual({ allowed: false, reason: 'rate_limited' });
  });

  it('slides: a slot frees up when the oldest reply leaves the window', () => {
    const clock = fakeClock();
    const limiter = new ReplyLimiter({ maxReplies: 2, windowMs: 1000, maxAgentStreak: 3, now: clock.now });
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true); // t=0
    clock.advance(900);
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true); // t=900
    clock.advance(99);
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(false); // t=999, both still inside
    clock.advance(1);
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true); // t=1000, reply from t=0 expired
    clock.advance(1);
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(false); // t=1001, 900 and 1000 inside
    clock.advance(899);
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true); // t=1900, reply from t=900 expired
  });

  it('does not count denied attempts against the window', () => {
    const clock = fakeClock();
    const limiter = new ReplyLimiter({ maxReplies: 1, windowMs: 1000, maxAgentStreak: 3, now: clock.now });
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      clock.advance(10);
      expect(limiter.tryAcquire(HUMAN).allowed).toBe(false);
    }
    clock.advance(500); // t=1000: only the first (allowed) reply ever counted
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true);
  });

  it('bounds a sustained flood to maxReplies per window', () => {
    const clock = fakeClock();
    const limiter = new ReplyLimiter({ maxReplies: 20, windowMs: 600_000, maxAgentStreak: 3, now: clock.now });
    let allowed = 0;
    // One mention per second for an hour.
    for (let i = 0; i < 3600; i += 1) {
      if (limiter.tryAcquire(HUMAN).allowed) allowed += 1;
      clock.advance(1000);
    }
    expect(allowed).toBe(120); // 6 windows x 20
  });
});

describe('ReplyLimiter agent streak', () => {
  it('stops after maxAgentStreak replies in a row to other agents', () => {
    const clock = fakeClock();
    const limiter = new ReplyLimiter({ maxReplies: 100, windowMs: 60_000, maxAgentStreak: 3, now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.tryAcquire(AGENT)).toEqual({ allowed: true });
    }
    expect(limiter.tryAcquire(AGENT)).toEqual({ allowed: false, reason: 'agent_streak' });
  });

  it('does not recover just because time passes', () => {
    const clock = fakeClock();
    const limiter = new ReplyLimiter({ maxReplies: 100, windowMs: 60_000, maxAgentStreak: 2, now: clock.now });
    limiter.tryAcquire(AGENT);
    limiter.tryAcquire(AGENT);
    clock.advance(24 * 3600 * 1000);
    expect(limiter.tryAcquire(AGENT)).toEqual({ allowed: false, reason: 'agent_streak' });
  });

  it('counts different agents towards the same streak', () => {
    const limiter = new ReplyLimiter({ maxReplies: 100, windowMs: 60_000, maxAgentStreak: 2, now: fakeClock().now });
    expect(limiter.tryAcquire({ senderAgentId: 'agent-b' }).allowed).toBe(true);
    expect(limiter.tryAcquire({ senderAgentId: 'agent-c' }).allowed).toBe(true);
    expect(limiter.tryAcquire({ senderAgentId: 'agent-d' }).allowed).toBe(false);
  });

  it('a human-sent mention resets the streak', () => {
    const limiter = new ReplyLimiter({ maxReplies: 100, windowMs: 60_000, maxAgentStreak: 2, now: fakeClock().now });
    limiter.tryAcquire(AGENT);
    limiter.tryAcquire(AGENT);
    expect(limiter.tryAcquire(AGENT).allowed).toBe(false);
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true);
    expect(limiter.tryAcquire(AGENT).allowed).toBe(true);
    expect(limiter.tryAcquire(AGENT).allowed).toBe(true);
    expect(limiter.tryAcquire(AGENT).allowed).toBe(false);
  });

  it('maxAgentStreak=0 never answers agents but still answers people', () => {
    const limiter = new ReplyLimiter({ maxReplies: 100, windowMs: 60_000, maxAgentStreak: 0, now: fakeClock().now });
    expect(limiter.tryAcquire(AGENT)).toEqual({ allowed: false, reason: 'agent_streak' });
    expect(limiter.tryAcquire(HUMAN)).toEqual({ allowed: true });
    expect(limiter.tryAcquire(AGENT)).toEqual({ allowed: false, reason: 'agent_streak' });
  });

  it('two agents that always mention each other stop on their own', () => {
    // Each agent has its own limiter, as two separately running kits would.
    const clock = fakeClock();
    const opts = { maxReplies: 1000, windowMs: 600_000, maxAgentStreak: 3, now: clock.now };
    const a = new ReplyLimiter(opts);
    const b = new ReplyLimiter(opts);
    const fromA: ReplySender = { senderAgentId: 'agent-a', senderUserId: null };
    const fromB: ReplySender = { senderAgentId: 'agent-b', senderUserId: null };

    // One person mentions both; from then on every reply mentions the other agent.
    let repliesA = a.tryAcquire(HUMAN).allowed ? 1 : 0;
    let repliesB = b.tryAcquire(HUMAN).allowed ? 1 : 0;
    let pendingForA = repliesB; // B's reply mentions A
    let pendingForB = repliesA;
    for (let round = 0; round < 1000 && (pendingForA > 0 || pendingForB > 0); round += 1) {
      clock.advance(3000);
      const aReplied = pendingForA > 0 && a.tryAcquire(fromB).allowed;
      const bReplied = pendingForB > 0 && b.tryAcquire(fromA).allowed;
      if (aReplied) repliesA += 1;
      if (bReplied) repliesB += 1;
      pendingForA = bReplied ? 1 : 0;
      pendingForB = aReplied ? 1 : 0;
    }
    // 1 reply to the person + 3 to the other agent, then silence.
    expect(repliesA).toBe(4);
    expect(repliesB).toBe(4);
  });
});

describe('ReplyLimiter sender allowlist', () => {
  it('empty allowlist lets anyone trigger a reply', () => {
    const limiter = new ReplyLimiter({ maxReplies: 10, windowMs: 1000, maxAgentStreak: 3, allowedSenders: [], now: fakeClock().now });
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true);
    expect(limiter.tryAcquire(AGENT).allowed).toBe(true);
  });

  it('only listed agent or user ids can trigger a reply', () => {
    const limiter = new ReplyLimiter({
      maxReplies: 10,
      windowMs: 1000,
      maxAgentStreak: 3,
      allowedSenders: ['user-1', 'agent-b'],
      now: fakeClock().now,
    });
    expect(limiter.tryAcquire({ senderUserId: 'user-1' })).toEqual({ allowed: true });
    expect(limiter.tryAcquire({ senderAgentId: 'agent-b' })).toEqual({ allowed: true });
    expect(limiter.tryAcquire({ senderUserId: 'user-2' })).toEqual({ allowed: false, reason: 'sender_not_allowed' });
    expect(limiter.tryAcquire({ senderAgentId: 'agent-x' })).toEqual({ allowed: false, reason: 'sender_not_allowed' });
    // No id at all, or only a prefix of an allowed id, is not a match.
    expect(limiter.tryAcquire({})).toEqual({ allowed: false, reason: 'sender_not_allowed' });
    expect(limiter.tryAcquire({ senderUserId: 'user-' })).toEqual({ allowed: false, reason: 'sender_not_allowed' });
  });

  it('a person who is not on the allowlist cannot reset the agent streak', () => {
    const limiter = new ReplyLimiter({
      maxReplies: 10,
      windowMs: 1000,
      maxAgentStreak: 1,
      allowedSenders: ['agent-b'],
      now: fakeClock().now,
    });
    expect(limiter.tryAcquire(AGENT).allowed).toBe(true);
    expect(limiter.tryAcquire({ senderUserId: 'user-2' }).allowed).toBe(false);
    expect(limiter.tryAcquire(AGENT)).toEqual({ allowed: false, reason: 'agent_streak' });
  });

  it('allowed senders are still rate limited', () => {
    const limiter = new ReplyLimiter({
      maxReplies: 1,
      windowMs: 1000,
      maxAgentStreak: 3,
      allowedSenders: ['user-1'],
      now: fakeClock().now,
    });
    expect(limiter.tryAcquire(HUMAN).allowed).toBe(true);
    expect(limiter.tryAcquire(HUMAN)).toEqual({ allowed: false, reason: 'rate_limited' });
  });
});

describe('reply limit environment variables', () => {
  const base = { AGENTMEET_BEARER_TOKEN: 'test-token' };

  it('has defaults when nothing is set', () => {
    const env = parseEnv(base);
    expect(env.REPLY_MAX_PER_WINDOW).toBe(20);
    expect(env.REPLY_WINDOW_SECONDS).toBe(600);
    expect(env.REPLY_MAX_AGENT_STREAK).toBe(3);
    expect(env.REPLY_ALLOWED_SENDERS).toEqual([]);
  });

  it('treats blank values as "use the default", not as 0', () => {
    const env = parseEnv({
      ...base,
      REPLY_MAX_PER_WINDOW: '',
      REPLY_WINDOW_SECONDS: '',
      REPLY_MAX_AGENT_STREAK: '',
      REPLY_ALLOWED_SENDERS: '',
    });
    expect(env.REPLY_MAX_PER_WINDOW).toBe(20);
    expect(env.REPLY_WINDOW_SECONDS).toBe(600);
    expect(env.REPLY_MAX_AGENT_STREAK).toBe(3);
    expect(env.REPLY_ALLOWED_SENDERS).toEqual([]);
  });

  it('reads overrides', () => {
    const env = parseEnv({
      ...base,
      REPLY_MAX_PER_WINDOW: '5',
      REPLY_WINDOW_SECONDS: '60',
      REPLY_MAX_AGENT_STREAK: '0',
      REPLY_ALLOWED_SENDERS: 'id-1, id-2',
    });
    expect(env.REPLY_MAX_PER_WINDOW).toBe(5);
    expect(env.REPLY_WINDOW_SECONDS).toBe(60);
    expect(env.REPLY_MAX_AGENT_STREAK).toBe(0);
    expect(env.REPLY_ALLOWED_SENDERS).toEqual(['id-1', 'id-2']);
  });

  it.each([
    ['REPLY_MAX_PER_WINDOW', '0'],
    ['REPLY_MAX_PER_WINDOW', '-1'],
    ['REPLY_MAX_PER_WINDOW', 'lots'],
    ['REPLY_MAX_PER_WINDOW', '2.5'],
    ['REPLY_WINDOW_SECONDS', '0'],
    ['REPLY_WINDOW_SECONDS', '86401'],
    ['REPLY_MAX_AGENT_STREAK', '-1'],
    ['REPLY_MAX_AGENT_STREAK', 'none'],
  ])('refuses to start with %s=%s', (name, value) => {
    expect(() => parseEnv({ ...base, [name]: value })).toThrow(name);
  });
});
