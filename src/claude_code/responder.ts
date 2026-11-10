import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readChatText, type MessageRow } from '../agentmeet/types.js';

export interface TranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly author: string;
}

export interface BuildPromptInput {
  readonly history: readonly MessageRow[];
  readonly selfAgentId: string | null;
  readonly windowSize?: number;
}

const DEFAULT_WINDOW = 20;

/**
 * Convert a slice of AgentMeet message rows into transcript turns.
 * The agent's own past messages become `assistant`, everyone else's become `user`.
 * Non-chat kinds and rows with no text are dropped.
 */
export function buildTranscript(input: BuildPromptInput): TranscriptTurn[] {
  const window = input.windowSize ?? DEFAULT_WINDOW;
  const slice = input.history.slice(-window);
  const turns: TranscriptTurn[] = [];
  for (const row of slice) {
    if (row.kind !== 'chat') continue;
    const chat = readChatText(row.body);
    if (!chat) continue;
    const isSelf = input.selfAgentId !== null && row.senderAgentId === input.selfAgentId;
    const author = isSelf
      ? 'me'
      : (row.senderAgentId ?? row.senderUserId ?? 'unknown').slice(0, 8);
    turns.push({
      role: isSelf ? 'assistant' : 'user',
      content: isSelf ? chat.text : `${author}: ${chat.text}`,
      author,
    });
  }
  return turns;
}

/**
 * Collapse consecutive same-role turns. We join same-role runs with newlines so
 * the rendered prompt reads as a continuous transcript.
 */
export function collapseTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      out[out.length - 1] = {
        role: last.role,
        author: last.author,
        content: `${last.content}\n${turn.content}`,
      };
    } else {
      out.push({ ...turn });
    }
  }
  // Drop leading assistant turns so the transcript starts with a user line.
  while (out.length > 0 && out[0]?.role !== 'user') out.shift();
  return out;
}

export interface FormatReplyInput {
  readonly raw: string;
  readonly maxLength?: number;
}

const DEFAULT_MAX_REPLY = 4000;

export function formatReply(input: FormatReplyInput): string {
  const max = input.maxLength ?? DEFAULT_MAX_REPLY;
  const trimmed = input.raw.trim();
  if (trimmed.length === 0) return '(no reply)';
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Render the collapsed transcript as a single prompt string. Each turn becomes
 * one line `<author>: <content>` (self lines are tagged `me:`). The claude CLI
 * receives this entire blob on stdin and decides what to reply.
 */
export function renderPrompt(turns: readonly TranscriptTurn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      lines.push(`me: ${turn.content}`);
    } else {
      // turn.content for non-self turns already contains the "author: text"
      // prefix (see buildTranscript).
      lines.push(turn.content);
    }
  }
  return lines.join('\n');
}

export class ClaudeCodeTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClaudeCodeTimeoutError';
  }
}

export class ClaudeCodeExitError extends Error {
  public readonly code: number | null;
  public readonly stderr: string;
  public constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = 'ClaudeCodeExitError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface ClaudeCodeResponderOptions {
  readonly persona: string;
  readonly model?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly claudeBin?: string;
  readonly timeoutMs?: number;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

const DEFAULT_TIMEOUT_MS = 120_000;
// No tool is pre-approved by default. The prompt is built from room messages,
// which any participant can write, so every tool granted here is reachable by
// prompt injection.
const DEFAULT_ALLOWED_TOOLS: readonly string[] = [];

// Built-in tools that run commands, read or change files, or reach the network.
// Any of these the operator has not allowed is denied outright, so a room
// message cannot use it even where the CLI would not ask for permission.
export const GUARDED_TOOLS: readonly string[] = [
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

/** Guarded tools to deny, given the operator's allowlist. `*` opts out. */
export function deniedTools(allowed: readonly string[]): string[] {
  if (allowed.includes('*')) return [];
  return GUARDED_TOOLS.filter(
    (tool) => !allowed.some((a) => a === tool || a.startsWith(`${tool}(`)),
  );
}

/**
 * Environment for the `claude` child process: everything except this agent's
 * own AgentMeet credentials, which the CLI never needs.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('AGENTMEET_')) out[key] = value;
  }
  return out;
}

/**
 * ClaudeCodeResponder wraps the local `claude` CLI as a subprocess. It does NOT
 * call the Anthropic HTTP API. Auth, model selection, MCP servers, Skills, and
 * tool inheritance all come from the user's installed CLI configuration.
 */
export class ClaudeCodeResponder {
  private readonly persona: string;
  private readonly model: string | undefined;
  private readonly maxTurns: number;
  private readonly allowedTools: readonly string[];
  private readonly claudeBin: string;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnFn;

  public constructor(opts: ClaudeCodeResponderOptions, spawnFn?: SpawnFn) {
    this.persona = opts.persona;
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? 1;
    this.allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.claudeBin = opts.claudeBin ?? process.env.CLAUDE_BIN ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnFn =
      spawnFn ??
      ((cmd, args) =>
        spawn(cmd, [...args], {
          shell: false,
          env: childEnv(process.env),
        }) as ChildProcessWithoutNullStreams);
  }

  public buildArgs(): string[] {
    const args: string[] = [
      '-p',
      '--append-system-prompt',
      this.persona,
      '--max-turns',
      String(this.maxTurns),
      '--output-format',
      'text',
    ];
    if (this.model !== undefined && this.model.length > 0) {
      args.push('--model', this.model);
    }
    if (this.allowedTools.length > 0) {
      args.push('--allowed-tools', this.allowedTools.join(','));
    }
    const denied = deniedTools(this.allowedTools);
    if (denied.length > 0) {
      args.push('--disallowed-tools', denied.join(','));
    }
    return args;
  }

  public async respond(turns: readonly TranscriptTurn[]): Promise<string> {
    const collapsed = collapseTurns(turns);
    if (collapsed.length === 0) {
      return '(no context to respond to)';
    }
    const prompt = renderPrompt(collapsed);
    const args = this.buildArgs();
    const stdout = await this.runChild(prompt, args);
    return formatReply({ raw: stdout });
  }

  private runChild(prompt: string, args: readonly string[]): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const child = this.spawnFn(this.claudeBin, args);
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore — process may already be gone
        }
        rejectPromise(
          new ClaudeCodeTimeoutError(
            `claude CLI timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });

      child.on('error', (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        rejectPromise(new Error(`failed to spawn claude CLI: ${message}`));
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          rejectPromise(
            new ClaudeCodeExitError(
              `claude CLI exited with code ${code ?? 'null'}: ${stderrBuf.trim()}`,
              code,
              stderrBuf,
            ),
          );
          return;
        }
        resolvePromise(stdoutBuf);
      });

      // Write prompt to stdin and close — avoids argv length limits and
      // shell-quoting injection from prompt content.
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (err: unknown) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        rejectPromise(
          new Error(`failed to write prompt to claude stdin: ${message}`),
        );
      }
    });
  }
}
