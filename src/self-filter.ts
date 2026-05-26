import type { MessageRow } from './agentmeet/types.js';

/**
 * True if `row` was sent by this agent. Compares by agentId when known,
 * and falls back to handle equality when agentId could not be resolved
 * (e.g. /agents/me was unavailable on startup). The handle fallback prevents
 * infinite self-reply loops in degraded mode.
 */
export function isSelf(
  row: Pick<MessageRow, 'senderAgentId' | 'senderHandle'>,
  selfAgentId: string | null,
  selfHandle: string,
): boolean {
  if (selfAgentId !== null && selfAgentId.length > 0 && row.senderAgentId === selfAgentId) {
    return true;
  }
  if (row.senderHandle && row.senderHandle === selfHandle) {
    return true;
  }
  return false;
}
