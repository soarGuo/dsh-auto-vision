/**
 * 纯函数与流处理:图片探测、识图 prompt 构造、时间戳格式化、流文本收集、
 * 以及"图片块 → 识别文本"的消息重写。
 * @module dsh-auto-vision/vision
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  ImageBlock,
  Message,
  StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** 稳定 cordis 插件名(cordis.patch.yml 的 insert id 与 index.ts 共用)。 */
export const PLUGIN_NAME = 'auto-vision'

/** 视觉识别调用的系统提示:只描述图片,不回答问题。 */
export const DESCRIBE_SYSTEM = '你是识图助手,只输出对图片客观、详实的描述;不要回答用户的问题,不要给出建议。'

/** 判断内容块列表里是否含有图片(递归工具结果)。 */
export function containsImage(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image'
    || (block.type === 'tool-result' && containsImage(block.content)))
}

/** 判断一条消息里是否含有图片(递归工具结果)。 */
export function hasImage(message: { readonly content: readonly ContentBlock[] }): boolean {
  return containsImage(message.content)
}

/** 递归收集全部图片块(深度优先,保持原顺序)。 */
export function collectImages(blocks: readonly ContentBlock[]): ImageBlock[] {
  const images: ImageBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') images.push(block)
    else if (block.type === 'tool-result') images.push(...collectImages(block.content))
  }
  return images
}

/** 拼接全部文本块(递归工具结果),用于识图 prompt 的上下文。 */
export function plainText(message: { readonly content: readonly ContentBlock[] }): string {
  const texts: string[] = []
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'text') texts.push(block.text)
      else if (block.type === 'tool-result') walk(block.content)
    }
  }
  walk(message.content)
  return texts.join('\n').trim()
}

/**
 * 递归移除所有图片块(顶层与工具结果内),并把描述文本追加到最外层
 * 消息内容末尾。工具结果内的其余块(如 read_image 的文本信封)保留。
 */
export function stripImages(blocks: readonly ContentBlock[], description: string): ContentBlock[] {
  const hasImages = containsImage(blocks)
  const stripped: ContentBlock[] = blocks.flatMap((block): ContentBlock[] => {
    switch (block.type) {
      case 'image':
        return []
      case 'tool-result':
        return containsImage(block.content)
          ? [{ ...block, content: stripImages(block.content, '') }]
          : [block]
      default:
        return [block]
    }
  })
  if (!hasImages) return [...stripped]
  return description.length === 0
    ? stripped
    : [...stripped, { type: 'text', text: description }]
}

/**
 * 构造识图 prompt:让视觉模型按「图1:」「图2:」…分节输出详实描述,
 * 供无法直接查看图片的模型引用。
 */
export function buildDescribePrompt(imageCount: number, userText: string): string {
  const original = userText.length > 0 ? userText : '(无文字说明)'
  return [
    '以下图片需要被识别为详细的文字描述,供一个无法直接查看图片的模型引用。请依次详细描述这些图片,使该模型仅凭文字就能引用图片内容。',
    '',
    `图片数量:${imageCount} 张。请用「图1:」「图2:」…逐张分节输出,每张包含:`,
    '- 图片类型(截图/照片/图表/手绘图等)',
    '- 画面与界面布局',
    '- 关键文字、数字、状态、报错信息(尽量逐字摘录)',
    '- 与用户问题相关的重点',
    '',
    '只输出描述本身,不要回答用户的问题,不要补充建议。',
    '',
    '原文或上下文:',
    original,
  ].join('\n')
}

/** 格式化为本地时间戳,标注在识别文本前面以便新旧截图区分。 */
export function formatStamp(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 消费模型流并收集全部文本块。
 * @param stream - 一次识图调用的 chunk 流。
 * @returns 拼接后的文本(trim 后);流以 error/aborted 结束时抛出对应错误。
 */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  const texts = new Map<number, string>()
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
        break
      case 'block-end':
        // block-end 携带组装完成的整块文本,直接覆盖增量。
        if (chunk.block.type === 'text') texts.set(chunk.index, chunk.block.text)
        break
      case 'finish': {
        const reason = chunk.reason
        if (reason.kind === 'aborted') {
          throw new Error(`识图调用被中止:${reason.failure.message}`)
        }
        if (reason.kind === 'error') {
          throw new Error(`识图调用失败:${reason.failure.message}`)
        }
        break
      }
      default:
        break
    }
  }
  return [...texts.values()].join('').trim()
}

/**
 * 请求级占位文本:替换请求消息里的图片块,完整识别内容在紧随其后的
 * 描述消息里,这里只放短占位,不重复消耗 token。
 */
export function imagePlaceholderText(index: number, total: number): string {
  return total > 1
    ? `[截图 ${index}/${total} 已由 auto-vision 识别,内容见紧随其后的上下文条目]`
    : '[截图已由 auto-vision 识别,内容见紧随其后的上下文条目]'
}

/**
 * 把一条消息里的全部图片块(递归工具结果)替换为短占位文本。
 * 用于请求前剥离:GUI 显示的消息保留图片,只有发给模型的请求被替换。
 * @returns 新消息对象(保留 id 与 source,仅 content 替换)。
 */
export function replaceRequestImages(
  message: Message,
): Message {
  const total = collectImages(message.content).length
  let seen = 0
  const walk = (blocks: readonly ContentBlock[]): ContentBlock[] => blocks.flatMap((block): ContentBlock[] => {
    switch (block.type) {
      case 'image': {
        seen += 1
        return [{ type: 'text', text: imagePlaceholderText(seen, total) }]
      }
      case 'tool-result':
        return containsImage(block.content)
          ? [{ ...block, content: walk(block.content) }]
          : [block]
      default:
        return [block]
    }
  })
  return { ...message, content: walk(message.content) }
}

/**
 * 对一条携带图片的用户消息执行识图,返回独立的识别描述消息
 * (source 为插件 notice 形式,GUI 渲染为折叠的上下文行)。
 * 原消息不再改写:图片块保留在会话历史里供 GUI 显示,发给模型的
 * 请求由 `replaceRequestImages` 在 llm/stream 阶段剥离。
 * 识别失败降级为描述消息里的失败说明;用户取消则原样上抛。
 * @param ctx - 插件上下文(llm 服务来自此)。
 * @param vision - 识图路由(provider/model)。
 * @param message - 原用户消息(含图,含工具结果内嵌图)。
 * @param signal - 用户取消信号。
 * @returns 识别描述消息。
 */
export async function describeImages(
  ctx: Context,
  vision: { provider: string; model: string; reasoningEffort?: string },
  message: UserMessage,
  signal?: AbortSignal,
): Promise<UserMessage> {
  const images = collectImages(message.content)
  const visionMessage = createUserMessage({
    content: [
      { type: 'text', text: buildDescribePrompt(images.length, plainText(message)) },
      ...images.map(block => ({ type: 'image', attachment: block.attachment }) as const),
    ],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  })
  let description: string
  let failed = false
  try {
    description = await collectText(ctx.llm.stream({
      provider: vision.provider,
      model: vision.model,
      system: DESCRIBE_SYSTEM,
      messages: [visionMessage],
      ...vision.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(vision.reasoningEffort) },
      signal,
    }))
  } catch (error) {
    // 用户主动取消时直接上抛;识别失败降级为描述消息里的失败说明。
    if (signal?.aborted) throw error
    const detail = error instanceof Error ? error.message : String(error)
    description = `[识图失败:${detail}]`
    failed = true
  }
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[截图识别 ${formatStamp(new Date())}]\n${description}`,
    }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'notice',
      summary: failed ? '图片识别失败' : `识别了 ${images.length} 张图片`,
    },
  })
}
