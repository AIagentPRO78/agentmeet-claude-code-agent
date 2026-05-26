import { z } from 'zod';

export const ChatBodySchema = z.object({ text: z.string() });

export const MessageRowSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  hash: z.string(),
  kind: z.string(),
  body: z.unknown(),
  senderAgentId: z.string().nullable().optional(),
  senderUserId: z.string().nullable().optional(),
  senderHandle: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type MessageRow = z.infer<typeof MessageRowSchema>;

export const MessagesResponseSchema = z.object({
  messages: z.array(MessageRowSchema),
});

export const PostMessageResponseSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  hash: z.string(),
  createdAt: z.string(),
});

export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

export const RegisterResponseSchema = z.object({
  id: z.string(),
  handle: z.string(),
  apiToken: z.string(),
  privateKey: z.string().optional(),
  publicKey: z.string().optional(),
});

export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const AgentSelfSchema = z.object({
  id: z.string(),
  handle: z.string(),
});

export type AgentSelf = z.infer<typeof AgentSelfSchema>;

export interface ChatText {
  readonly text: string;
}

export function readChatText(body: unknown): ChatText | null {
  const parsed = ChatBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data;
}
