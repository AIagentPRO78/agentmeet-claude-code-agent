import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import {
  buildTranscript,
  collapseTurns,
  formatReply,
  renderPrompt,
  ClaudeCodeResponder,
  ClaudeCodeTimeoutError,
  ClaudeCodeExitError,
  type TranscriptTurn,
} from '../src/claude_code/responder.js';
import type { MessageRow } from '../src/agentmeet/types.js';

function row(seq: number, sender: string | null, text: string, kind = 'chat'): MessageRow {
  return {
    id: `m_${seq}`,
    seq,
    hash: 'h',
    kind,
    body: { text },
    senderAgentId: sender,
    senderUserId: null,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough & { writes: string[] };
  kill: (signal?: string) => boolean;
  spawnArgs: readonly string[];
  spawnCmd: string;
  killed: boolean;
}

function makeFakeChild(cmd: string, args: readonly string[]): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  const stdin = new PassThrough() as PassThrough & { writes: string[] };
  stdin.writes = [];
  const origWrite = stdin.write.bind(stdin);
  stdin.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    stdin.writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    // call through so 'end' eventually flushes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origWrite as any)(chunk, ...rest);
  };
  ee.stdin = stdin;
  ee.spawnCmd = cmd;
  ee.spawnArgs = args;
  ee.killed = false;
  ee.kill = (_signal?: string): boolean => {
    ee.killed = true;
    return true;
  };
  return ee;
}

// Cast to the node typing without dragging the full child_process surface in.
function asChild(fc: FakeChild): ChildProcessWithoutNullStreams {
  return fc as unknown as ChildProcessWithoutNullStreams;
}

describe('buildTranscript', () => {
  it('routes self messages to assistant and others to user', () => {
    const history = [
      row(1, 'agent_alice', 'hello there'),
      row(2, 'agent_me', 'hi back'),
      row(3, 'agent_alice', '@claude_code what do you think?'),
    ];
    const turns = buildTranscript({ history, selfAgentId: 'agent_me' });
    expect(turns).toHaveLength(3);
    expect(turns[0]?.role).toBe('user');
    expect(turns[1]?.role).toBe('assistant');
    expect(turns[1]?.content).toBe('hi back');
    expect(turns[2]?.role).toBe('user');
    expect(turns[2]?.content).toContain('@claude_code what do you think?');
  });

  it('drops non-chat kinds', () => {
    const history = [
      row(1, 'agent_alice', 'first'),
      row(2, 'agent_alice', 'task body', 'task'),
      row(3, 'agent_bob', 'second'),
    ];
    const turns = buildTranscript({ history, selfAgentId: null });
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.content)).not.toContain('task body');
  });

  it('respects windowSize', () => {
    const history = Array.from({ length: 50 }, (_, i) =>
      row(i + 1, 'agent_other', `msg-${i}`),
    );
    const turns = buildTranscript({ history, selfAgentId: null, windowSize: 5 });
    expect(turns).toHaveLength(5);
    expect(turns[0]?.content).toContain('msg-45');
  });

  it('drops malformed bodies', () => {
    const malformed: MessageRow = {
      id: 'm_x',
      seq: 9,
      hash: 'h',
      kind: 'chat',
      body: { not_text: 'oops' },
      senderAgentId: 'agent_alice',
      senderUserId: null,
      createdAt: new Date().toISOString(),
    };
    const turns = buildTranscript({ history: [malformed], selfAgentId: null });
    expect(turns).toHaveLength(0);
  });
});

describe('collapseTurns', () => {
  it('merges consecutive same-role turns', () => {
    const turns: TranscriptTurn[] = [
      { role: 'user', author: 'a', content: 'one' },
      { role: 'user', author: 'a', content: 'two' },
      { role: 'assistant', author: 'me', content: 'hi' },
    ];
    const out = collapseTurns(turns);
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toBe('one\ntwo');
  });

  it('drops leading assistant turns', () => {
    const turns: TranscriptTurn[] = [
      { role: 'assistant', author: 'me', content: 'hi' },
      { role: 'user', author: 'a', content: 'hey' },
    ];
    const out = collapseTurns(turns);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });
});

describe('formatReply', () => {
  it('returns trimmed text', () => {
    expect(formatReply({ raw: '  hello  ' })).toBe('hello');
  });

  it('truncates over the cap', () => {
    const raw = 'x'.repeat(5000);
    const out = formatReply({ raw, maxLength: 10 });
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back when empty', () => {
    expect(formatReply({ raw: '   ' })).toBe('(no reply)');
  });
});

describe('renderPrompt', () => {
  it('renders self turns with me: prefix and others verbatim', () => {
    const turns: TranscriptTurn[] = [
      { role: 'user', author: 'agent_al', content: 'agent_al: hi' },
      { role: 'assistant', author: 'me', content: 'how can I help?' },
      { role: 'user', author: 'agent_al', content: 'agent_al: do a thing' },
    ];
    const prompt = renderPrompt(turns);
    expect(prompt).toBe('agent_al: hi\nme: how can I help?\nagent_al: do a thing');
  });
});

describe('ClaudeCodeResponder.respond (mocked spawn)', () => {
  function makeResponder(spawnImpl: (cmd: string, args: readonly string[]) => FakeChild) {
    const child: { current: FakeChild | null } = { current: null };
    const responder = new ClaudeCodeResponder(
      {
        persona: 'PERSONA',
        model: 'claude-sonnet-4-5',
        maxTurns: 1,
        allowedTools: ['Bash', 'Read'],
        claudeBin: '/fake/claude',
        timeoutMs: 1_000,
      },
      (cmd, args) => {
        const fc = spawnImpl(cmd, args);
        child.current = fc;
        return asChild(fc);
      },
    );
    return { responder, child };
  }

  const turns: TranscriptTurn[] = [
    { role: 'user', author: 'agent_al', content: 'agent_al: hello' },
  ];

  it('constructs a prompt from collapsed turns and feeds it to stdin', async () => {
    const { responder, child } = makeResponder((cmd, args) => {
      const fc = makeFakeChild(cmd, args);
      // simulate async completion
      setImmediate(() => {
        fc.stdout.write('hi back\n');
        fc.emit('close', 0);
      });
      return fc;
    });
    const out = await responder.respond(turns);
    expect(out).toBe('hi back');
    expect(child.current).not.toBeNull();
    expect(child.current?.stdin.writes.join('')).toBe('agent_al: hello');
  });

  it('calls claude with -p, --output-format text, --max-turns, and stdin prompt', async () => {
    const { responder, child } = makeResponder((cmd, args) => {
      const fc = makeFakeChild(cmd, args);
      setImmediate(() => {
        fc.stdout.write('ok');
        fc.emit('close', 0);
      });
      return fc;
    });
    await responder.respond(turns);
    const args = child.current?.spawnArgs ?? [];
    expect(child.current?.spawnCmd).toBe('/fake/claude');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    expect(args).toContain('--max-turns');
    expect(args).toContain('1');
    // prompt never appears in argv
    expect(args.find((a) => a.includes('agent_al: hello'))).toBeUndefined();
  });

  it('passes persona via --append-system-prompt', async () => {
    const { responder, child } = makeResponder((cmd, args) => {
      const fc = makeFakeChild(cmd, args);
      setImmediate(() => {
        fc.stdout.write('ok');
        fc.emit('close', 0);
      });
      return fc;
    });
    await responder.respond(turns);
    const args = child.current?.spawnArgs ?? [];
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('PERSONA');
  });

  it('applies allowed-tools restriction', async () => {
    const { responder, child } = makeResponder((cmd, args) => {
      const fc = makeFakeChild(cmd, args);
      setImmediate(() => {
        fc.stdout.write('ok');
        fc.emit('close', 0);
      });
      return fc;
    });
    await responder.respond(turns);
    const args = child.current?.spawnArgs ?? [];
    const idx = args.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Bash,Read');
  });

  it('defaults to the read-only tool allowlist when allowedTools is unset', () => {
    const responder = new ClaudeCodeResponder({
      persona: 'PERSONA',
      claudeBin: '/fake/claude',
    });
    const args = responder.buildArgs();
    const idx = args.indexOf('--allowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Bash,Read,Grep,Glob,WebFetch');
  });

  it('omits --model when model is not set', () => {
    const responder = new ClaudeCodeResponder({
      persona: 'PERSONA',
      claudeBin: '/fake/claude',
    });
    const args = responder.buildArgs();
    expect(args).not.toContain('--model');
  });

  it('times out and kills the child', async () => {
    vi.useFakeTimers();
    try {
      const { responder, child } = makeResponder((cmd, args) => {
        // never emit close
        return makeFakeChild(cmd, args);
      });
      const p = responder.respond(turns);
      // attach a rejection handler before advancing timers to avoid unhandled
      const assertion = expect(p).rejects.toBeInstanceOf(ClaudeCodeTimeoutError);
      await vi.advanceTimersByTimeAsync(1_100);
      await assertion;
      expect(child.current?.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates non-zero exit with stderr', async () => {
    const { responder } = makeResponder((cmd, args) => {
      const fc = makeFakeChild(cmd, args);
      setImmediate(() => {
        fc.stderr.write('auth required\n');
        fc.emit('close', 2);
      });
      return fc;
    });
    let caught: unknown = null;
    try {
      await responder.respond(turns);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClaudeCodeExitError);
    if (caught instanceof ClaudeCodeExitError) {
      expect(caught.code).toBe(2);
      expect(caught.stderr).toContain('auth required');
    }
  });
});
