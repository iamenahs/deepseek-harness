/** Standard ACP replay updates derived from one persisted session's complete stored log. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { assistantBlockToAcp } from './content.ts'
import { assistantContentUpdates, planUpdate, toolCallUpdate, toolResultUpdate } from './updates.ts'

/**
 * Convert one committed user message's blocks to ordered standard content
 * updates. Only genuine end-user prompts are replayed — a message from any
 * other logged source stays off the wire, matching what a live prompt admits.
 * @param ctx - bridge context carrying the attachment store used by content conversion.
 * @param event - committed user message event.
 * @returns ordered standard user-message updates, empty for a non-user source.
 */
async function userContentUpdates(ctx: Context, event: SessionEvent<'user/message'>): Promise<SessionUpdate[]> {
  if (event.data.source.kind !== 'user') return []
  const updates: SessionUpdate[] = []
  for (const block of event.data.content) {
    const content = await assistantBlockToAcp(ctx, block)
    if (content !== undefined) updates.push({ sessionUpdate: 'user_message_chunk', messageId: event.data.id, content })
  }
  return updates
}

/**
 * Convert one persisted session's complete stored log into the ordered
 * standard updates `session/load` replays before answering: user and agent
 * message chunks, thoughts, the generic tool-call lifecycle, and plan
 * snapshots. Context usage and session-title updates are omitted — usage
 * reflects live request pressure rather than history, and the loaded
 * session's title is already returned through `session/list` and `initialize`
 * calls made from the same title-carrying event log.
 * @param ctx - bridge context carrying the attachment store used by content conversion.
 * @param events - complete stored event log for the session being loaded, in ascending seq order.
 * @returns ordered standard updates, oldest first.
 */
export async function replayUpdates(ctx: Context, events: readonly SessionEvent[]): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        updates.push(...await userContentUpdates(ctx, event))
        break
      case 'assistant/message':
        updates.push(...await assistantContentUpdates(ctx, event))
        break
      case 'tool/call':
        updates.push(toolCallUpdate(event))
        break
      case 'tool/result':
        updates.push(await toolResultUpdate(ctx, event))
        break
      case 'todo/write':
        updates.push(planUpdate(event))
        break
      // Every other logged event type (turn/step markers, headers, approvals,
      // and any future merge-extensible addition) carries no standard ACP
      // replay projection and is silently skipped.
      default:
        break
    }
  }
  return updates
}
