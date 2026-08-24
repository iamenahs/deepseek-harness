import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createUserMessage, CallId, type StreamChunk  } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

function reasoningToolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'deciding to echo' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'deciding to echo' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: CallId('call-1'), name: 'echo', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('call-1'), name: 'echo', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'echo', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-1'), name: 'echo', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('ACP automation output boundary', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('does not emit tool, terminal, plan, title, or reasoning presentation updates', async () => {
    harness = await makeBridgeHarness({ script: [toolCallResponse(), textResponse('done')] })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates).toHaveLength(1) })
    expect(harness.updates).toEqual([{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    }])
  })

  it('publishes tool calls when the deployment asks for progress', async () => {
    harness = await makeBridgeHarness({
      script: [toolCallResponse(), textResponse('done')],
      config: { progress: 'tools' },
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates).toHaveLength(3) })
    // The call, its result, then the text — in the order the turn produced
    // them, so a client can attach the result to the call it already showed.
    expect(harness.updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'echo',
        kind: 'other',
        status: 'in_progress',
        rawInput: {},
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'tool result' } }],
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
    ])
  })

  it('keeps reasoning and every other trace off the wire even with progress: tools', async () => {
    // The opt-in widens the filter by exactly two update kinds. This runs a
    // turn that produces reasoning *and* a tool call, and pins the whole
    // update list — so anything else the session logs (reasoning, todos,
    // titles, retry markers) leaking in would fail here rather than pass
    // unnoticed because the fixture happened not to produce it.
    harness = await makeBridgeHarness({
      script: [reasoningToolCallResponse(), textResponse('done')],
      config: { progress: 'tools' },
    })
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Return a deterministic result.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool result' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })

    await vi.waitFor(() => { expect(harness!.updates).toHaveLength(3) })
    expect(harness.updates.map(update => update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ])
    // The model reasoned; nothing about it reached the client, as a thought
    // chunk or as text inside the committed message.
    expect(JSON.stringify(harness.updates)).not.toContain('deciding to echo')
  })

  it('ignores events from agents the bridge does not own', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('foreign')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const { agent } = await harness.ctx.agents.create({
      sessionId: SessionId('foreign'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(harness.updates).toHaveLength(0)
  })

  it('delivers output from a bridge-owned session driven by another in-process producer', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('external')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'plugin', plugin: 'test' } }))
    await agent.whenIdle()

    expect(harness.updates).toEqual([{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'external' },
    }])
  })

  it('contains output conversion failure outside an ACP prompt', async () => {
    harness = await makeBridgeHarness({ script: [[
      { type: 'block-start', index: 0, blockType: 'image' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: {
            attachmentId: `sha256:${'a'.repeat(64)}` as never,
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]] })
    const warn = vi.spyOn(harness.ctx.logger, 'warn')
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'plugin', plugin: 'test' } }))
    await agent.whenIdle()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('output conversion failed')) })
    expect(harness.updates).toEqual([])
  })

  // `session/update` is a JSON-RPC notification, so a client-side handler
  // failure never reaches the bridge; this pins that the prompt still settles
  // normally with such a client. The bridge's own write-failure guard is
  // transport-level and documented untestable at `notify`.
  it('settles the prompt normally when the client rejects update notifications', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('answer')] })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    harness.onSessionUpdateError = () => {}
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
  })
})
