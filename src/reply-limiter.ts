import type { MessageRow } from './agentmeet/types.js';

/**
 * Decides whether a mention may be answered. Consulted before the model call,
 * so every "allowed" answer is one (billable) call and at most one room post.
 *
 * Three independent checks, all in memory:
 *  - sender allowlist (optional): only listed sender ids can trigger a reply
 *  - agent streak: how many replies in a row were triggered by other agents;
 *    reset when a human-sent mention arrives. Stops two agents that keep
 *    mentioning each other from ping-ponging forever.
 *  - sliding window: at most `maxReplies` replies per `windowMs`, whoever asks
 *
 * A denied mention must be dropped silently by the caller — posting an
 * explanation into the room could itself feed a reply loop.
 */

export type ReplySender = Pick<MessageRow, 'senderAgentId' | 'senderUserId'>;

export type ReplyDenyReason = 'sender_not_allowed' | 'agent_streak' | 'rate_limited';

export type ReplyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: ReplyDenyReason };

export interface ReplyLimiterOptions {
  /** Maximum replies inside one sliding window. */
  readonly maxReplies: number;
  /** Sliding window length in milliseconds. */
  readonly windowMs: number;
  /** Maximum replies in a row triggered by other agents. 0 = never reply to agents. */
  readonly maxAgentStreak: number;
  /** Sender ids (agent or user) allowed to trigger replies. Empty = anyone. */
  readonly allowedSenders?: readonly string[];
  /** Clock, injectable for tests. Defaults to Date.now. */
  readonly now?: () => number;
}

/** Split a comma-separated id list from the environment; blanks are ignored. */
export function parseSenderList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * AgentMeet sets senderAgentId on rows posted with an agent token and
 * senderUserId on rows posted by a signed-in person. A row counts as
 * agent-sent only when it has an agent id and no user id.
 */
export function isAgentSender(sender: ReplySender): boolean {
  const agentId = sender.senderAgentId ?? '';
  const userId = sender.senderUserId ?? '';
  return agentId.length > 0 && userId.length === 0;
}

export class ReplyLimiter {
  private readonly maxReplies: number;
  private readonly windowMs: number;
  private readonly maxAgentStreak: number;
  private readonly allowedSenders: ReadonlySet<string>;
  private readonly now: () => number;
  // Timestamps of allowed replies inside the current window, oldest first.
  private replyTimes: number[] = [];
  private agentStreak = 0;

  constructor(opts: ReplyLimiterOptions) {
    this.maxReplies = opts.maxReplies;
    this.windowMs = opts.windowMs;
    this.maxAgentStreak = opts.maxAgentStreak;
    this.allowedSenders = new Set(opts.allowedSenders ?? []);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Ask for permission to answer a mention from `sender`. An "allowed" answer
   * is counted immediately, so call this exactly once per reply attempt.
   */
  public tryAcquire(sender: ReplySender): ReplyDecision {
    if (this.allowedSenders.size > 0 && !this.isAllowedSender(sender)) {
      return { allowed: false, reason: 'sender_not_allowed' };
    }

    const fromAgent = isAgentSender(sender);
    // A person is talking to us again: the agent-to-agent run is over.
    if (!fromAgent) this.agentStreak = 0;
    if (fromAgent && this.agentStreak >= this.maxAgentStreak) {
      return { allowed: false, reason: 'agent_streak' };
    }

    const now = this.now();
    const cutoff = now - this.windowMs;
    this.replyTimes = this.replyTimes.filter((t) => t > cutoff);
    if (this.replyTimes.length >= this.maxReplies) {
      return { allowed: false, reason: 'rate_limited' };
    }

    this.replyTimes.push(now);
    if (fromAgent) this.agentStreak += 1;
    return { allowed: true };
  }

  private isAllowedSender(sender: ReplySender): boolean {
    const agentId = sender.senderAgentId ?? '';
    const userId = sender.senderUserId ?? '';
    return (
      (agentId.length > 0 && this.allowedSenders.has(agentId)) ||
      (userId.length > 0 && this.allowedSenders.has(userId))
    );
  }
}
