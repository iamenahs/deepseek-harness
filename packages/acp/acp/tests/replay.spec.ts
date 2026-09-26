import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { replayUpdates } from '../src/replay.ts'

describe('session/load replay projection', () => {
  it('replays user, agent, tool, and plan history in log order, skipping usage and title', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const events: SessionEvent[] = [
      {
        type: 'user/message',
        surfaceOp: 'append',
        seq: SessionSeq(0),
        time: 0,
        data: {
          id: MessageId('user-1'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'first prompt' }],
        },
      },
      // A system-injected checkpoint carries the same role but a different
      // source kind; only a genuine end-user prompt replays as user_message_chunk.
      {
        type: 'user/message',
        surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) },
        seq: SessionSeq(1),
        time: 0,
        data: {
          id: MessageId('checkpoint-1'),
          role: 'user',
          source: { kind: 'compaction-summary' } as unknown as SessionEvent<'user/message'>['data']['source'],
          content: [{ type: 'text', text: 'summary, not a prompt' }],
        },
      },
      {
        type: 'tool/call',
        seq: SessionSeq(2),
        time: 0,
        data: { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'todo_write', arguments: '{}' },
      },
      {
        type: 'todo/write',
        seq: SessionSeq(3),
        time: 0,
        data: { todos: [{ content: 'write tests', status: 'in_progress' }] },
      },
      {
        type: 'tool/result',
        surfaceOp: 'append',
        seq: SessionSeq(4),
        time: 0,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: MessageId('tool-1'),
            role: 'tool',
            toolCallId: ToolCallId('call-1'),
            source: { kind: 'tool', callId: ToolCallId('call-1') },
            content: [{ type: 'text', text: 'updated the list' }],
          },
        },
      },
      {
        type: 'assistant/message',
        surfaceOp: 'append',
        seq: SessionSeq(5),
        time: 0,
        data: {
          stream: [],
          turn: 1,
          step: 1,
          message: {
            id: MessageId('assistant-1'),
            role: 'assistant',
            source: { kind: 'model', provider: 'mock', model: 'mock' },
            content: [{ type: 'text', text: 'done' }],
          },
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      },
      // A durable title snapshot never replays as a session/update.
      {
        type: 'session/title',
        seq: SessionSeq(6),
        time: 0,
        data: { title: 'first prompt', messageSeqs: [SessionSeq(0)], source: { kind: 'fallback' } },
      },
      // An ordinary lifecycle marker with no standard projection is skipped.
      { type: 'turn/start', seq: SessionSeq(7), time: 0, data: { turn: 2 } },
    ]

    const updates = await replayUpdates(ctx, events)

    expect(updates.map(update => update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'tool_call',
      'plan',
      'tool_call_update',
      'agent_message_chunk',
    ])
    expect(updates[0]).toEqual({
      sessionUpdate: 'user_message_chunk',
      messageId: 'user-1',
      content: { type: 'text', text: 'first prompt' },
    })
    expect(updates[4]).toEqual({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'assistant-1',
      content: { type: 'text', text: 'done' },
    })
    // No usage_update or session_info_update was produced for history.
    expect(updates.every(update => update.sessionUpdate !== 'usage_update' && update.sessionUpdate !== 'session_info_update')).toBe(true)
  })
})
