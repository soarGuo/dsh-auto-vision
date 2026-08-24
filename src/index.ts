/**
 * dsh-auto-vision:当会话当前模型不在"原生视觉白名单"里、用户消息又携带
 * 图片时,用配置的视觉模型识别图片,并把识别文本写回会话历史(替换图片块)。
 *
 * 纯插件实现,不修改 DSH 源码:
 * - GUI 侧:把需要桥接的模型在 settings.yaml 里声明 `input: [text, image]`,
 *   让 apiproxy 的图片准入检查放行(它只相信模型声明);
 * - 插件侧:监听 `system-prompt/assemble`(pre-step 前、同一步发生),从
 *   assembly.variables 快照 GUI 此刻选择的准确模型;pre-step 时白名单外的
 *   模型一律替换图片为识别文本。替换后的消息由 agent loop 原样写入会话
 *   历史,所以识别结果天然持久化,后续每轮对话都能引用同一条图片记忆;
 *   每次发新截图都会追加一条新的识别结果(带时间戳),模型以最新一条为主。
 *
 * 与模型相关、与会话无关:白名单内(如 vision-exp)的模型带图时不干预,
 * 图片原样交给模型。
 * @module dsh-auto-vision
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
// 事件类型:'system-prompt/assemble' waterfall 与 PromptAssembly。
import type {} from '@deepseek-ai/dsh-system-prompt'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import { describeImages, hasImage, PLUGIN_NAME } from './vision.ts'

/** 稳定 cordis 插件名(与 cordis.patch.yml 的 insert id 一致)。 */
export const name = PLUGIN_NAME

/** agent 事件与 llm 服务;视觉模型的图片读取由适配器自理。 */
export const inject = ['agents', 'llm']

/** 插件配置命名空间(settings.yaml 的 auto-vision 段)。 */
export const AUTO_VISION_NAMESPACE = settingsNamespace('auto-vision')

/** 默认识图路由:官方 DeepSeek 的视觉实验模型。 */
export const DEFAULT_VISION_PROVIDER = 'deepseek-official'
export const DEFAULT_VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** 一条"原生视觉"模型标识。 */
export interface NativeVisionModel {
  provider: string
  model: string
}

/** 原生视觉模型默认白名单:这些模型带图时不干预。 */
export const DEFAULT_NATIVE_VISION: NativeVisionModel[] = [
  { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
  { provider: 'deepseek', model: 'deepseek-v4-flash-vision-exp' },
]

/** 插件配置;所有字段都可省。 */
export interface Config {
  /** 识图路由的 provider。 */
  visionProvider?: string
  /** 识图路由的模型。 */
  visionModel?: string
  /**
   * 原生支持图片输入的模型白名单:白名单内的模型带图时不干预,
   * 白名单外的模型带图时替换为识别文本。默认两个 vision-exp。
   */
  nativeVision?: NativeVisionModel[]
}

/** Schemastery 校验(同时是 settings 段的 schema)。 */
export const Config: z<Config> = z.object({
  visionProvider: z.string().default(DEFAULT_VISION_PROVIDER),
  visionModel: z.string().default(DEFAULT_VISION_MODEL),
  nativeVision: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).default(DEFAULT_NATIVE_VISION),
})

/**
 * 注册识图桥接:
 * 1. `system-prompt/assemble` 快照每个 agent 本步的准确模型(GUI 的模型
 *    选择由 installModelSelection 写进 assembly.variables);
 * 2. `agent/pre-step` 对白名单外的模型把图片块替换为识别文本。
 * @param ctx - 插件上下文;监听器随上下文一起销毁。
 * @param config - 组合入口配置;settings.yaml 的 auto-vision 段会覆盖它。
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, AUTO_VISION_NAMESPACE, Config, config, {
    setSource: source => {
      current = source
    },
    onChange: () => {
      // 识图路由与白名单按次读取 current(),无需额外刷新。
    },
  })

  /** 每次识图调用时读取最新配置,settings.yaml 修改即时生效。 */
  const vision = (): { provider: string; model: string } => {
    const cfg = current() ?? {}
    return {
      provider: cfg.visionProvider ?? DEFAULT_VISION_PROVIDER,
      model: cfg.visionModel ?? DEFAULT_VISION_MODEL,
    }
  }

  /** 原生视觉白名单(每次判断时读取最新配置)。 */
  const nativeVision = (): NativeVisionModel[] => (current() ?? {}).nativeVision ?? DEFAULT_NATIVE_VISION

  /** 每个 agent 最近一次 assemble 的准确模型;assemble 先于 pre-step、同一步发生。 */
  const assembledModel = new WeakMap<Agent, { provider: string; model: string }>()

  // system-prompt 组装时,installModelSelection 把 GUI 选择的 provider/model
  // 写进 assembly.variables;`await next()` 之后读到的结果一定包含它。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const transformed = await next()
    const agent = context.agent
    const provider = transformed.variables['provider']
    const model = transformed.variables['model']
    if (agent !== undefined && typeof provider === 'string' && typeof model === 'string') {
      assembledModel.set(agent, { provider, model })
    }
    return transformed
  })

  /** 当前模型是否原生支持图片:assemble 快照优先,agent 创建选项兜底。 */
  const isNativeVision = (agent: Agent): boolean => {
    const snapshot = assembledModel.get(agent)
    const provider = snapshot?.provider ?? agent.options.provider
    const model = snapshot?.model ?? agent.options.model
    if (provider === undefined || model === undefined) return false
    return nativeVision().some(entry => entry.provider === provider && entry.model === model)
  }

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (!decision.messages.some(message => hasImage(message))) return decision
    // 原生视觉模型(如 vision-exp)不干预,图片原样交给模型。
    if (isNativeVision(agent)) return decision
    // 带图消息拆成两条:原消息(图片移除、文字原样)+ 独立识别描述消息。
    const expanded = await Promise.all(decision.messages.map(async message => {
      if (!hasImage(message)) return [message]
      const { rewritten, description } = await describeImages(ctx, vision(), message, signal)
      return description === null ? [rewritten] : [rewritten, description]
    }))
    return { kind: 'enter', messages: expanded.flat() }
  }, { prepend: true })
}
