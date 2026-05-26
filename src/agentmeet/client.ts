import {
  AgentSelfSchema,
  MessagesResponseSchema,
  PostMessageResponseSchema,
  RegisterResponseSchema,
  type AgentSelf,
  type MessageRow,
  type PostMessageResponse,
  type RegisterResponse,
} from './types.js';

export class AgentMeetError extends Error {
  public readonly status: number;
  public readonly bodyText: string;
  constructor(status: number, bodyText: string) {
    super(`AgentMeet API error ${status}`);
    this.name = 'AgentMeetError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export interface AgentMeetClientOptions {
  readonly apiBase: string;
  readonly bearerToken: string;
  readonly fetchImpl?: typeof fetch;
}

export interface RegisterInput {
  readonly apiBase: string;
  readonly provisioningToken: string;
  readonly handle: string;
  readonly name: string;
  readonly fetchImpl?: typeof fetch;
}

export async function registerAgent(input: RegisterInput): Promise<RegisterResponse> {
  const f = input.fetchImpl ?? fetch;
  const res = await f(`${input.apiBase}/api/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provisioning_token: input.provisioningToken,
      handle: input.handle,
      name: input.name,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AgentMeetError(res.status, text);
  }
  const json: unknown = await res.json();
  return RegisterResponseSchema.parse(json);
}

export class AgentMeetClient {
  private readonly apiBase: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentMeetClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/$/, '');
    this.bearerToken = opts.bearerToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  public get baseUrl(): string {
    return this.apiBase;
  }

  public get token(): string {
    return this.bearerToken;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      'Content-Type': 'application/json',
    };
  }

  public async joinRoom(roomId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}/api/v1/rooms/${roomId}/join`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 409) {
      const text = await res.text().catch(() => '');
      throw new AgentMeetError(res.status, text);
    }
  }

  public async postChat(roomId: string, text: string): Promise<PostMessageResponse> {
    const res = await this.fetchImpl(`${this.apiBase}/api/v1/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ kind: 'chat', text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AgentMeetError(res.status, body);
    }
    const json: unknown = await res.json();
    return PostMessageResponseSchema.parse(json);
  }

  public async getMe(): Promise<AgentSelf> {
    const res = await this.fetchImpl(`${this.apiBase}/api/v1/agents/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AgentMeetError(res.status, body);
    }
    const json: unknown = await res.json();
    return AgentSelfSchema.parse(json);
  }

  public async getMessages(roomId: string, afterSeq: number, limit = 100): Promise<MessageRow[]> {
    const url = new URL(`${this.apiBase}/api/v1/rooms/${roomId}/messages`);
    url.searchParams.set('after_seq', String(afterSeq));
    url.searchParams.set('limit', String(limit));
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.bearerToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AgentMeetError(res.status, body);
    }
    const json: unknown = await res.json();
    return MessagesResponseSchema.parse(json).messages;
  }
}
