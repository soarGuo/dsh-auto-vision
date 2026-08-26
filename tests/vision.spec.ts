import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  buildDescribePrompt,
  collectImages,
  collectText,
  describeImages,
  formatStamp,
  hasImage,
  plainText,
  replaceRequestImages,
  stripImages,
} from '../src/vision.ts'

const REF = (attachmentId: string): ImageAttachmentRef => ({
  attachmentId,
  mediaType: 'image/png',
  width: 100,
  height: 100,
  bytes: 1024,
} as never)

function imageMessage(...attachmentIds: string[]): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: '这是什么?' },
      ...attachmentIds.map(attachmentId => ({ type: 'image' as const, attachment: REF(attachmentId) })),
    ],
    source: { kind: 'user' },
  })
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, 3) },
    { type: 'text-delta', index: 0, text: text.slice(3) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('hasImage', () => {
  it('纯文本消息不含图片', () => {
    const message = createUserMessage({
      content: [{ type: 'text', text: '你好' }],
      source: { kind: 'user' },
    })
    expect(hasImage(message)).toBe(false)
  })

  it('含图片块返回 true,并递归工具结果', () => {
    expect(hasImage(imageMessage('a'))).toBe(true)
    const nested = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call' as never,
        content: [{ type: 'image', attachment: REF('inner') }],
      }],
      source: { kind: 'tool', callId: 'call' as never },
    })
    expect(hasImage(nested)).toBe(true)
  })
})

describe('collectImages / plainText', () => {
  it('递归按顺序提取图片块并拼接文本', () => {
    const message = imageMessage('one', 'two')
    expect(collectImages(message.content).map(block => block.attachment.attachmentId)).toEqual(['one', 'two'])
    expect(plainText(message)).toBe('这是什么?')
  })

  it('工具结果内嵌图片也被收集,文本被递归拼接', () => {
    const message = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call' as never,
        content: [
          { type: 'text', text: '<path>a.png</path>' },
          { type: 'image', attachment: REF('nested') },
        ],
      }],
      source: { kind: 'tool', callId: 'call' as never },
    })
    expect(collectImages(message.content).map(block => block.attachment.attachmentId)).toEqual(['nested'])
    expect(plainText(message)).toContain('a.png')
  })
})

describe('stripImages', () => {
  it('移除顶层图片并追加描述文本', () => {
    const stripped = stripImages([
      { type: 'text', text: '问题' },
      { type: 'image', attachment: REF('a') },
    ], '描述')
    expect(stripped).toHaveLength(2)
    expect(stripped[0]).toEqual({ type: 'text', text: '问题' })
    expect(stripped[1]).toEqual({ type: 'text', text: '描述' })
  })

  it('递归移除工具结果内图片,保留文本信封并追加描述', () => {
    const stripped = stripImages([{
      type: 'tool-result',
      toolCallId: 'call' as never,
      content: [
        { type: 'text', text: '<path>a.png</path>' },
        { type: 'image', attachment: REF('inner') },
      ],
    }], '描述')
    expect(stripped).toHaveLength(2)
    const result = stripped[0]
    expect(result.type).toBe('tool-result')
    if (result.type !== 'tool-result') return
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({ type: 'text', text: '<path>a.png</path>' })
    expect(stripped[1]).toEqual({ type: 'text', text: '描述' })
  })

  it('无图内容原样返回', () => {
    const blocks = [{ type: 'text' as const, text: '你好' }]
    expect(stripImages(blocks, '描述')).toEqual(blocks)
  })
})

describe('buildDescribePrompt', () => {
  it('包含图片数量、分节要求与用户原文', () => {
    const prompt = buildDescribePrompt(2, '这个报错怎么修?')
    expect(prompt).toContain('2 张')
    expect(prompt).toContain('图1:')
    expect(prompt).toContain('图2:')
    expect(prompt).toContain('这个报错怎么修?')
  })

  it('空原文显示占位符', () => {
    expect(buildDescribePrompt(1, '')).toContain('(无文字说明)')
  })
})

describe('formatStamp', () => {
  it('生成非空本地时间戳', () => {
    const stamp = formatStamp(new Date(2026, 7, 24, 14, 32, 5))
    expect(stamp.length).toBeGreaterThan(0)
    expect(stamp).toContain('14:32')
  })
})

describe('collectText', () => {
  it('拼接 text-delta,块结束覆盖为完整文本', async () => {
    expect(await collectText((async function* () {
      yield* textChunks('这是识别结果')
    })())).toBe('这是识别结果')
  })

  it('finish error 抛出', async () => {
    await expect(collectText((async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } }
    })())).rejects.toThrow('识图调用失败:boom')
  })

  it('finish aborted 抛出', async () => {
    await expect(collectText((async function* () {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'gone', code: 'X' } } }
    })())).rejects.toThrow('识图调用被中止:gone')
  })
})

describe('describeImages', () => {
  const ctx = () => ({
    llm: {
      stream: vi.fn(async function* () {
        yield* textChunks('图1:这是一张截图')
      }),
    },
  }) as unknown as Context

  it('返回独立 notice 描述消息(原消息由调用方保留)', async () => {
    const message = imageMessage('a', 'b')
    const description = await describeImages(ctx(), { provider: 'p', model: 'm' }, message)
    const text = description.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('[截图识别 ')
    expect(text).toContain('图1:这是一张截图')
    expect(description.source).toEqual({
      kind: 'plugin',
      plugin: 'auto-vision',
      form: 'notice',
      summary: '识别了 2 张图片',
    })
  })

  it('识图请求带上了全部图片块,指令并入 prompt 而非 system 槽位', async () => {
    const fake = ctx()
    await describeImages(fake, { provider: 'p', model: 'm' }, imageMessage('a', 'b'))
    const options = (fake.llm.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(options.provider).toBe('p')
    expect(options.model).toBe('m')
    // 不占用 system 槽位(部分网关拒绝 developer 角色)。
    expect(options.system).toBeUndefined()
    const promptText = options.messages[0].content
      .filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('')
    expect(promptText).toContain('识图助手')
    expect(options.messages[0].content.filter((block: { type: string }) => block.type === 'image')).toHaveLength(2)
  })

  it('工具结果内嵌图片也被识图', async () => {
    const toolMessage = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call' as never,
        content: [
          { type: 'text', text: '<path>shot.png</path>' },
          { type: 'image', attachment: REF('nested') },
        ],
      }],
      source: { kind: 'tool', callId: 'call' as never },
    })
    const description = await describeImages(ctx(), { provider: 'p', model: 'm' }, toolMessage)
    const text = description.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('图1:这是一张截图')
    expect(description.source).toEqual({
      kind: 'plugin',
      plugin: 'auto-vision',
      form: 'notice',
      summary: '识别了 1 张图片',
    })
  })

  it('识别失败降级:失败说明进描述消息', async () => {
    const failing = {
      llm: {
        stream: vi.fn(async function* () {
          throw new Error('gateway 500')
        }),
      },
    } as unknown as Context
    const description = await describeImages(failing, { provider: 'p', model: 'm' }, imageMessage('a'))
    const text = description.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('[识图失败:gateway 500]')
    expect(description.source).toEqual({
      kind: 'plugin',
      plugin: 'auto-vision',
      form: 'notice',
      summary: '图片识别失败',
    })
  })

  it('用户取消时原样上抛', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelled = {
      llm: {
        stream: vi.fn(async function* () {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'X' } } }
        }),
      },
    } as unknown as Context
    await expect(describeImages(
      cancelled,
      { provider: 'p', model: 'm' },
      imageMessage('a'),
      controller.signal,
    )).rejects.toThrow('识图调用被中止:cancelled')
  })
})

describe('replaceRequestImages', () => {
  it('移除图片块且不插入任何文本,保留 id 与 source', () => {
    const message = imageMessage('a', 'b')
    const replaced = replaceRequestImages(message)
    expect(replaced.id).toBe(message.id)
    expect(replaced.source).toEqual({ kind: 'user' })
    expect(hasImage(replaced)).toBe(false)
    // 只剩原文,没有占位文本。
    expect(replaced.content).toEqual([{ type: 'text', text: '这是什么?' }])
  })

  it('纯图消息剥离后内容为空', () => {
    const pureImage = createUserMessage({
      content: [{ type: 'image', attachment: REF('only') }],
      source: { kind: 'user' },
    })
    const replaced = replaceRequestImages(pureImage)
    expect(replaced.content).toEqual([])
  })

  it('工具结果内嵌图片同样移除', () => {
    const toolMessage = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call' as never,
        content: [
          { type: 'text', text: '<path>shot.png</path>' },
          { type: 'image', attachment: REF('nested') },
        ],
      }],
      source: { kind: 'tool', callId: 'call' as never },
    })
    const replaced = replaceRequestImages(toolMessage)
    expect(hasImage(replaced)).toBe(false)
    const result = replaced.content[0]
    expect(result.type).toBe('tool-result')
    if (result.type !== 'tool-result') return
    expect(result.content.some(block => block.type === 'text' && block.text.includes('shot.png'))).toBe(true)
    expect(result.content.some(block => block.type === 'image')).toBe(false)
  })
})
