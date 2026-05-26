import 'dotenv/config';
import { spawn } from 'node:child_process';
import { loadConfig, type AppConfig } from './config.js';
import { log } from './log.js';
import { AgentMeetClient, AgentMeetError, registerAgent } from './agentmeet/client.js';
import { streamMessages } from './agentmeet/sse.js';
import { readChatText, type MessageRow } from './agentmeet/types.js';
import { buildTranscript, ClaudeCodeResponder } from './claude_code/responder.js';
import { isSelf } from './self-filter.js';

async function checkClaudeCli(bin: string): Promise<void> {
  await new Promise<void>((resolveOnce) => {
    const child = spawn(bin, ['--version'], { shell: false });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', (e: unknown) => {
      finish(() => {
        log.warn(
          {
            bin,
            errMessage: e instanceof Error ? e.message : String(e),
          },
          'claude CLI precheck failed — agent will run but mention handling will error until claude is installed',
        );
        resolveOnce();
      });
    });
    child.on('close', (code: number | null) => {
      finish(() => {
        if (code === 0) {
          log.info({ bin, version: out.trim() }, 'claude CLI detected');
        } else {
          log.warn(
            { bin, code, stderr: err.trim() },
            'claude CLI returned non-zero on --version',
          );
        }
        resolveOnce();
      });
    });
  });
}

interface AgentIdentity {
  readonly agentId: string;
  readonly handle: string;
  readonly token: string;
}

// History fetch window — how many recent messages we surface to Claude.
const HISTORY_WINDOW = 100;

async function ensureIdentity(cfg: AppConfig, client?: AgentMeetClient): Promise<AgentIdentity> {
  if (cfg.env.AGENTMEET_BEARER_TOKEN.length > 0) {
    log.info({ handle: cfg.env.AGENT_NICK }, 'using existing bearer token');
    // Best-effort resolve the real agentId so the self-filter can drop our own rows.
    // If /agents/me is unavailable we fall back to handle-based filtering.
    let agentId = '';
    if (client) {
      try {
        const me = await client.getMe();
        agentId = me.id;
        log.info({ agentId: me.id, handle: me.handle }, 'resolved self identity');
      } catch (err: unknown) {
        log.warn(
          {
            errName: err instanceof Error ? err.constructor.name : String(err),
            errMessage: err instanceof Error ? err.message : undefined,
            status: err instanceof AgentMeetError ? err.status : undefined,
          },
          'failed to resolve /agents/me — falling back to handle-only self filter',
        );
      }
    }
    return {
      agentId,
      handle: cfg.env.AGENT_NICK,
      token: cfg.env.AGENTMEET_BEARER_TOKEN,
    };
  }
  log.info({ handle: cfg.env.AGENT_NICK }, 'registering new agent via provisioning token');
  const reg = await registerAgent({
    apiBase: cfg.env.AGENTMEET_API_BASE,
    provisioningToken: cfg.env.AGENTMEET_PROVISIONING_TOKEN,
    handle: cfg.env.AGENT_NICK,
    name: cfg.env.AGENT_NAME,
  });
  log.info(
    { agentId: reg.id, handle: reg.handle },
    'registered — store apiToken in AGENTMEET_BEARER_TOKEN to skip this step next run',
  );
  return { agentId: reg.id, handle: reg.handle, token: reg.apiToken };
}

function mentionsMe(text: string, nick: string): boolean {
  const re = new RegExp(`@${escapeRegExp(nick)}\\b`, 'i');
  return re.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class TurnRunner {
  private busy = false;
  // Tracks the highest seq we've observed so handleMention can request the
  // most-recent N messages instead of the oldest N (afterSeq=0 returns oldest).
  private headSeq = 0;
  constructor(
    private readonly client: AgentMeetClient,
    private readonly responder: ClaudeCodeResponder,
    private readonly roomId: string,
    private readonly selfAgentId: string | null,
    private readonly nick: string,
  ) {}

  public setHead(seq: number): void {
    if (seq > this.headSeq) this.headSeq = seq;
  }

  public async handleMention(triggeringRow: MessageRow): Promise<void> {
    if (this.busy) {
      log.debug({ seq: triggeringRow.seq }, 'single-flight: dropping mention while busy');
      return;
    }
    this.busy = true;
    try {
      // We want the RECENT N messages, not the oldest N. AgentMeet's GET
      // /messages takes after_seq, so we anchor to (head - N) so the next
      // page returns the tail of the room. clamp to 0 to be safe.
      const head = Math.max(this.headSeq, triggeringRow.seq);
      const afterSeq = Math.max(0, head - HISTORY_WINDOW);
      const history = await this.client.getMessages(this.roomId, afterSeq, HISTORY_WINDOW);
      const turns = buildTranscript({
        history,
        selfAgentId: this.selfAgentId,
        windowSize: 20,
      });
      log.info({ turns: turns.length, trigger: triggeringRow.seq }, 'calling claude');
      let reply: string;
      try {
        reply = await this.responder.respond(turns);
      } catch (err: unknown) {
        const name = err instanceof Error ? err.constructor.name : 'Error';
        log.error(
          {
            errName: name,
            errMessage: err instanceof Error ? err.message : undefined,
            status: err instanceof AgentMeetError ? err.status : undefined,
          },
          'claude call failed',
        );
        // Plain text, no @-prefix — prevents an infinite self-trigger loop where
        // the agent's own error reply mentions itself and re-triggers handleMention.
        reply = `[error: ${name}]`;
        await this.safePost(reply);
        return;
      }
      await this.safePost(reply);
    } finally {
      this.busy = false;
    }
  }

  private async safePost(text: string): Promise<void> {
    try {
      const result = await this.client.postChat(this.roomId, text);
      log.info({ seq: result.seq, id: result.id }, 'posted reply');
      this.setHead(result.seq);
    } catch (err: unknown) {
      const name = err instanceof Error ? err.constructor.name : 'Error';
      const status = err instanceof AgentMeetError ? err.status : undefined;
      log.error(
        {
          errName: name,
          errMessage: err instanceof Error ? err.message : undefined,
          status,
        },
        'post failed',
      );
    }
  }
}

async function runLoop(
  client: AgentMeetClient,
  runner: TurnRunner,
  roomId: string,
  nick: string,
  selfAgentId: string | null,
): Promise<void> {
  let cursor = 0;
  let lastEventId: string | undefined;
  let reconnectDelayMs = 2000;
  // Seed cursor from current head so we don't reply to history on startup.
  // We fetch the LAST 1 message via cursor=0+limit=1 then advance — the existing
  // API returns oldest-first, so for an empty/quiet room this still works to
  // anchor the cursor at 0; a separate poll inside runLoop catches up the tail.
  try {
    const seed = await client.getMessages(roomId, 0, HISTORY_WINDOW);
    if (seed.length > 0) {
      const last = seed[seed.length - 1];
      if (last) {
        cursor = last.seq;
        runner.setHead(last.seq);
      }
    }
  } catch (err: unknown) {
    log.warn(
      {
        errName: err instanceof Error ? err.constructor.name : String(err),
        errMessage: err instanceof Error ? err.message : undefined,
      },
      'failed to seed cursor — starting from 0',
    );
  }
  log.info({ cursor }, 'listening for mentions');

  while (true) {
    try {
      for await (const evt of streamMessages({
        apiBase: client.baseUrl,
        bearerToken: client.token,
        roomId,
        afterSeq: cursor,
        lastEventId,
      })) {
        if (evt.lastEventId) lastEventId = evt.lastEventId;
        if (evt.type === 'retry' && typeof evt.retryMs === 'number') {
          reconnectDelayMs = evt.retryMs;
          continue;
        }
        if (evt.type === 'message' && evt.row) {
          cursor = evt.row.seq;
          runner.setHead(evt.row.seq);
          if (evt.row.kind !== 'chat') continue;
          if (isSelf(evt.row, selfAgentId, nick)) continue;
          const chat = readChatText(evt.row.body);
          if (!chat) continue;
          if (!mentionsMe(chat.text, nick)) continue;
          log.info({ seq: evt.row.seq, from: evt.row.senderAgentId }, 'mention detected');
          // Fire-and-forget so the SSE loop keeps draining.
          void runner.handleMention(evt.row);
        } else if (evt.type === 'reconnect' && typeof evt.cursor === 'number') {
          cursor = evt.cursor;
        }
      }
    } catch (err: unknown) {
      log.warn(
        {
          errName: err instanceof Error ? err.constructor.name : String(err),
          errMessage: err instanceof Error ? err.message : undefined,
          delayMs: reconnectDelayMs,
        },
        'SSE stream errored — backing off',
      );
      await new Promise((r) => setTimeout(r, reconnectDelayMs));
    }
  }
}

async function main(): Promise<void> {
  const cfg = await loadConfig(process.env);
  log.level = cfg.env.LOG_LEVEL;
  log.info({ apiBase: cfg.env.AGENTMEET_API_BASE, nick: cfg.env.AGENT_NICK }, 'starting');

  // Bootstrap a client with whatever bearer we have so ensureIdentity can
  // resolve /agents/me when a pre-supplied AGENTMEET_BEARER_TOKEN is used.
  const bootstrapToken = cfg.env.AGENTMEET_BEARER_TOKEN;
  const bootstrapClient = bootstrapToken.length > 0
    ? new AgentMeetClient({ apiBase: cfg.env.AGENTMEET_API_BASE, bearerToken: bootstrapToken })
    : undefined;

  const identity = await ensureIdentity(cfg, bootstrapClient);
  const client = new AgentMeetClient({
    apiBase: cfg.env.AGENTMEET_API_BASE,
    bearerToken: identity.token,
  });

  if (cfg.env.AGENTMEET_ROOM_ID.length === 0) {
    log.warn('AGENTMEET_ROOM_ID is empty — agent is registered but idle. Set the env var to join a room.');
    return;
  }

  await client.joinRoom(cfg.env.AGENTMEET_ROOM_ID);
  log.info({ roomId: cfg.env.AGENTMEET_ROOM_ID }, 'joined room');

  await checkClaudeCli(cfg.env.CLAUDE_BIN);

  const allowedTools = cfg.env.CLAUDE_ALLOWED_TOOLS
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const responder = new ClaudeCodeResponder({
    persona: cfg.persona,
    model: cfg.env.CLAUDE_MODEL.length > 0 ? cfg.env.CLAUDE_MODEL : undefined,
    maxTurns: cfg.env.CLAUDE_MAX_TURNS,
    allowedTools,
    claudeBin: cfg.env.CLAUDE_BIN,
    timeoutMs: cfg.env.CLAUDE_TIMEOUT_MS,
  });

  const runner = new TurnRunner(
    client,
    responder,
    cfg.env.AGENTMEET_ROOM_ID,
    identity.agentId.length > 0 ? identity.agentId : null,
    cfg.env.AGENT_NICK,
  );

  await runLoop(
    client,
    runner,
    cfg.env.AGENTMEET_ROOM_ID,
    cfg.env.AGENT_NICK,
    identity.agentId.length > 0 ? identity.agentId : null,
  );
}

main().catch((err: unknown) => {
  log.fatal(
    {
      errName: err instanceof Error ? err.constructor.name : String(err),
      errMessage: err instanceof Error ? err.message : undefined,
    },
    'fatal error',
  );
  process.exit(1);
});
