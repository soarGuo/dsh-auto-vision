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
  RequestMessage,
  StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** 稳定 cordis 插件名(cordis.patch.yml 的 insert id 与 index.ts 共用)。 */
export const PLUGIN_NAME = 'auto-vision'

/**
 * 本插件追加的"识图结果"上下文行。
 *
 * DSH 0.1.7 起 `MessageSourceMap` 不再有通用的 `plugin` 来源:每个生产者
 * 在自己的模块里声明自己的 `kind`(见官方 MessageSourceMap 注释)。这里
 * 按同一约定声明 `auto-vision`,并用 `form: 'notice'` 说明这是一次性事件
 * ——GUI 渲染为折叠行:summary 常显,正文展开可见。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'auto-vision': {
      kind: 'auto-vision'
      form: 'notice'
      /** 一行账号,折叠时显示。 */
      summary: string
    }
  }
}

/** 视觉识别调用的系统提示:只描述图片,不回答问题。 */
export const DESCRIBE_SYSTEM = '你是识图助手,只输出对图片客观、详实的描述;不要回答用户的问题,不要给出建议。'

/**
 * 判断内容块列表里是否含有图片。
 *
 * DSH 0.1.7 起工具结果是一等的 `tool` 角色消息(ToolResultMessage),不再
 * 内嵌 `tool-result` 块,所以图片只出现在当前消息自己的块里;请求级的
 * 覆盖由调用方逐条消息执行(见 replaceRequestImages)。
 */
export function containsImage(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image')
}

/** 判断一条消息里是否含有图片。 */
export function hasImage(message: { readonly content: readonly ContentBlock[] }): boolean {
  return containsImage(message.content)
}

/** 收集消息里的全部图片块(保持原顺序)。 */
export function collectImages(blocks: readonly ContentBlock[]): ImageBlock[] {
  return blocks.filter((block): block is ImageBlock => block.type === 'image')
}

/** 拼接全部文本块,用于识图 prompt 的上下文。 */
export function plainText(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** 移除全部图片块,并把描述文本追加到内容末尾(其余块原样保留)。 */
export function stripImages(blocks: readonly ContentBlock[], description: string): ContentBlock[] {
  const stripped = blocks.filter(block => block.type !== 'image')
  if (stripped.length === blocks.length) return [...blocks]
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
    // 识图指令直接并入用户文本,不占用 system 槽位:
    // 部分网关不接受 system 转 developer 的角色,这样最稳。
    DESCRIBE_SYSTEM,
    '',
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
 * 把一条消息里的全部图片块移除,不插入任何文本。
 * 用于请求前剥离:GUI 显示的消息保留图片,只有发给模型的请求被剥离;
 * 完整识别内容在紧随其后的描述消息里,请求里不留占位痕迹。
 *
 * 对 `tool` 角色消息同样适用:0.1.7 里工具结果的图片直接是这块消息自己的
 * image 块,所以逐条消息处理即可覆盖整份请求。
 * @returns 新消息对象(保留 id 与 source,仅 content 替换);无图时原样返回。
 */
export function replaceRequestImages(message: RequestMessage): RequestMessage {
  if (!containsImage(message.content)) return message
  return { ...message, content: stripImages(message.content, '') }
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
    // 内部识图请求:对视觉模型而言这就是一条普通用户消息。
    source: { kind: 'user' },
  })
  let description: string
  let failed = false
  try {
    description = await collectText(ctx.llm.stream({
      provider: vision.provider,
      model: vision.model,
      // 不传 system:识图指令已并入 prompt 文本,避免网关拒绝
      // system→developer 的角色转换。
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
      kind: 'auto-vision',
      form: 'notice',
      summary: failed ? '图片识别失败' : `识别了 ${images.length} 张图片`,
    },
  })
}
