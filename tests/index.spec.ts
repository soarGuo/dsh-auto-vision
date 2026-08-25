import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import * as autoVision from '../src/index.ts'

const SIGNAL = new AbortController().signal

const REF: ImageAttachmentRef = {
  attachmentId: 'img-1',
  mediaType: 'image/png',
  width: 100,
  height: 100,
  bytes: 1024,
} as never

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function imageProposal(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [
      { type: 'text', text: '这个报错怎么修?' },
      { type: 'image', attachment: REF },
    ],
    source: { kind: 'user' },
  })
}

function textProposal(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: '普通问题' }],
    source: { kind: 'user' },
  })
}

interface Fixture {
  ctx: Context
  agent: Agent
  llm: {
    resolveModelInfo: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
  }
  fire: (proposal: ReturnType<typeof createUserMessage>) => Promise<PreStepDecision>
  assemble: (provider: string, model: string) => Promise<PromptAssembly>
}

async function mount(options: { agentModel?: string; pluginConfig?: Record<string, unknown> } = {}): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const llm = {
    resolveModelInfo: vi.fn(async (_provider: string, model: string) => ({
      provider: 'deepseek',
      id: model,
      name: model,
      inputModalities: ['text'],
    })),
    stream: vi.fn(async function* () {
      yield* textChunks('图1:这是一张错误截图')
    }),
  }
  ctx.provide('llm', llm as never)
  await ctx.plugin(autoVision, options.pluginConfig ?? {})

  const session = Session.create(SessionId('test-session'))
  const agent: Agent = {
    id: SessionId('agent-1'),
    options: { provider: 'deepseek', model: options.agentModel ?? 'deepseek-v4-pro' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('unused') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const fire = async (proposal: ReturnType<typeof createUserMessage>) => agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposal], turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: [proposal] }),
  )
  const assemble = (provider: string, model: string): Promise<PromptAssembly> => {
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: { provider, model },
    }
    return ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent } as never,
      () => Promise.resolve(assembly),
    )
  }
  return { ctx, agent, llm, fire, assemble }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('auto-vision agent/pre-step(白名单机制)', () => {
  it('assemble 快照为白名单外模型(pro):原消息保留图片 + 独立识别描述', async () => {
    const { llm, fire, assemble } = await mount()
    await assemble('deepseek', 'deepseek-v4-pro')
    const decision = await fire(imageProposal())
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    // 两条:原消息(图片保留,供 GUI 显示)+ 识别描述消息。
    expect(decision.messages).toHaveLength(2)
    const original = decision.messages[0]
    expect(original.content.some(block => block.type === 'image')).toBe(true)
    expect(original.content[0]).toEqual({ type: 'text', text: '这个报错怎么修?' })
    expect(original.source).toEqual({ kind: 'user' })
    const description = decision.messages[1]
    const text = description.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain('[截图识别 ')
    expect(text).toContain('图1:这是一张错误截图')
    expect(description.source).toEqual({
      kind: 'plugin',
      plugin: 'auto-vision',
      form: 'notice',
      summary: '识别了 1 张图片',
    })
    expect(llm.stream).toHaveBeenCalledTimes(1)
  })

  it('assemble 快照为白名单内模型(vision-exp):不干预', async () => {
    const { llm, fire, assemble } = await mount()
    await assemble('deepseek', 'deepseek-v4-flash-vision-exp')
    const decision = await fire(imageProposal())
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages[0].content.some(block => block.type === 'image')).toBe(true)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('无 assemble 快照:回退 agent 创建选项判断', async () => {
    const { llm, fire } = await mount({ agentModel: 'deepseek-v4-flash-vision-exp' })
    const decision = await fire(imageProposal())
    if (decision.kind !== 'enter') throw new Error('expected enter')
    // agent.options 是 vision-exp(白名单内),不干预。
    expect(decision.messages[0].content.some(block => block.type === 'image')).toBe(true)
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('自定义白名单生效:白名单外替换,白名单内不干预', async () => {
    const { llm, fire, assemble } = await mount({
      pluginConfig: {
        nativeVision: [{ provider: 'deepseek', model: 'my-vision-model' }],
      },
    })
    // 官方 flash 不在自定义白名单 → 替换。
    await assemble('deepseek', 'deepseek-v4-flash')
    const first = await fire(imageProposal())
    if (first.kind !== 'enter') throw new Error('expected enter')
    expect(first.messages).toHaveLength(2)
    expect(first.messages[0].content.some(block => block.type === 'image')).toBe(true)
    expect(llm.stream).toHaveBeenCalledTimes(1)

    // 自定义模型在白名单 → 不干预。
    await assemble('deepseek', 'my-vision-model')
    const second = await fire(imageProposal())
    if (second.kind !== 'enter') throw new Error('expected enter')
    expect(second.messages[0].content.some(block => block.type === 'image')).toBe(true)
    expect(llm.stream).toHaveBeenCalledTimes(1)
  })

  it('消息无图:不调用识图', async () => {
    const { llm, fire, assemble } = await mount()
    await assemble('deepseek', 'deepseek-v4-pro')
    const decision = await fire(textProposal())
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('识图路由跟随当前分组:sub2api 分组用其视觉模型,官方分组用官方视觉模型', async () => {
    const { llm, fire, assemble } = await mount()
    // 当前分组 sub2api(deepseek)→ 用同分组的 vision-exp 识图。
    await assemble('deepseek', 'deepseek-v4-pro')
    await fire(imageProposal())
    const first = llm.stream.mock.calls[0][0]
    expect(first.provider).toBe('deepseek')
    expect(first.model).toBe('deepseek-v4-flash-vision-exp')
    expect(first.reasoningEffort).toBe('high')

    // 切到官方分组 → 用官方的 vision-exp 识图。
    await assemble('deepseek-official', 'deepseek-v4-pro')
    await fire(imageProposal())
    const second = llm.stream.mock.calls[1][0]
    expect(second.provider).toBe('deepseek-official')
    expect(second.model).toBe('deepseek-v4-flash-vision-exp')
    expect(second.reasoningEffort).toBe('high')
  })

  it('分组无白名单项时回退默认识图路由', async () => {
    const { llm, fire, assemble } = await mount()
    await assemble('some-other-provider', 'some-model')
    await fire(imageProposal())
    const options = llm.stream.mock.calls[0][0]
    expect(options.provider).toBe('deepseek-official')
    expect(options.model).toBe('deepseek-v4-flash-vision-exp')
    // 识别用的消息源是插件,避免与用户消息混淆。
    expect(options.messages[0].source).toEqual({ kind: 'plugin', plugin: 'auto-vision' })
  })
})

describe('auto-vision llm/stream(请求前剥离图片)', () => {
  const MARKER = { type: 'text-delta', index: 0, text: '__MARKER__' } as const

  async function streamThrough(ctx: Context, options: GenerateOptions): Promise<unknown[]> {
    const chunks: unknown[] = []
    const result = ctx.waterfall(
      'llm/stream',
      options,
      () => (async function* () { yield MARKER })(),
    ) as AsyncIterable<unknown>
    for await (const chunk of result) chunks.push(chunk)
    return chunks
  }

  it('白名单外模型 + 带图消息:剥离图片并短路重发', async () => {
    const fixture = await mount()
    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      messages: [imageProposal()],
    }
    const chunks = await streamThrough(fixture.ctx, options)
    // 不走 default(MARKER 未出现),走 fake stream 的文本。
    expect(chunks.some(c => JSON.stringify(c) === JSON.stringify(MARKER))).toBe(false)
    expect(chunks.some(c => (c as { type: string }).type === 'block-start')).toBe(true)
    // fake llm.stream 收到剥离后的 options。
    const streamed = fixture.llm.stream.mock.calls.at(-1)?.[0]
    expect(streamed.provider).toBe('deepseek')
    expect(streamed.messages[0].content.some((b: { type: string }) => b.type === 'image')).toBe(false)
    const texts = streamed.messages[0].content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text)
    expect(texts.join('')).toContain('已由 auto-vision 识别')
  })

  it('白名单模型 + 带图:不干预,走默认流', async () => {
    const fixture = await mount()
    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-v4-flash-vision-exp',
      messages: [imageProposal()],
    }
    const chunks = await streamThrough(fixture.ctx, options)
    expect(chunks).toHaveLength(1)
    expect(JSON.stringify(chunks[0])).toBe(JSON.stringify(MARKER))
  })

  it('无图消息:不干预,走默认流', async () => {
    const fixture = await mount()
    const options: GenerateOptions = {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      messages: [textProposal()],
    }
    const chunks = await streamThrough(fixture.ctx, options)
    expect(chunks).toHaveLength(1)
    expect(JSON.stringify(chunks[0])).toBe(JSON.stringify(MARKER))
  })
})
