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
import { declareImageInputs } from './declare.ts'
import { describeImages, hasImage, PLUGIN_NAME, replaceRequestImages } from './vision.ts'

/** 稳定 cordis 插件名(与 cordis.patch.yml 的 insert id 一致)。 */
export const name = PLUGIN_NAME

/** agent 事件与 llm 服务;视觉模型的图片读取由适配器自理。 */
export const inject = ['agents', 'llm']

/** 插件配置命名空间(settings.yaml 的 auto-vision 段)。 */
export const AUTO_VISION_NAMESPACE = settingsNamespace('auto-vision')

/** 默认识图路由:官方 DeepSeek 的视觉实验模型。 */
export const DEFAULT_VISION_PROVIDER = 'deepseek-official'
export const DEFAULT_VISION_MODEL = 'deepseek-v4-flash-vision-exp'
/** 默认识图思考强度。 */
export const DEFAULT_VISION_REASONING_EFFORT = 'high'

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
  /**
   * 自动配置:启动时(及 settings/适配器变化时)自动给 settings 里已配置
   * 的模型补 `image` 输入声明,让 GUI 放行带图消息、免去手动配置。
   * 默认 true;设为 false 关闭(此时需按 README 手动声明)。
   */
  autoDeclareInput?: boolean
  /**
   * 识图调用使用的思考强度,默认 `high`。只作用于识图这一次调用,
   * 不影响用户会话模型的思考强度。
   */
  visionReasoningEffort?: string
}

/** Schemastery 校验(同时是 settings 段的 schema)。 */
export const Config: z<Config> = z.object({
  visionProvider: z.string().default(DEFAULT_VISION_PROVIDER),
  visionModel: z.string().default(DEFAULT_VISION_MODEL),
  nativeVision: z.array(z.object({
    provider: z.string(),
    model: z.string(),
  })).default(DEFAULT_NATIVE_VISION),
  autoDeclareInput: z.boolean().default(true),
  visionReasoningEffort: z.string().default(DEFAULT_VISION_REASONING_EFFORT),
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

  /** 原生视觉白名单(每次判断时读取最新配置)。 */
  const nativeVision = (): NativeVisionModel[] => (current() ?? {}).nativeVision ?? DEFAULT_NATIVE_VISION

  /** 白名单里的模型名集合(用于跨分组按名匹配)。 */
  const nativeModelNames = (): Set<string> => new Set(nativeVision().map(entry => entry.model))

  /**
   * 一个 (provider, model) 是否命中白名单:
   * 先精确匹配 provider+model,再按模型名匹配(任意分组)。
   * 这样用户给分组起任何名字、改名、重建,只要组里存在白名单模型名的
   * 视觉模型,就自动视为原生视觉/识图候选。
   */
  const matchesNativeVision = (provider: string | undefined, model: string | undefined): boolean => {
    if (provider === undefined || model === undefined) return false
    const native = nativeVision()
    if (native.some(entry => entry.provider === provider && entry.model === model)) return true
    return native.some(entry => entry.model === model)
  }

  /** 模型列表缓存:按 provider,适配器变化时清空。 */
  const modelCatalogCache = new Map<string, readonly { id: string }[]>()

  /**
   * 列出某 provider 的模型 id(缓存)。失败或不可用时返回空。
   */
  const listProviderModelIds = async (provider: string): Promise<string[]> => {
    const cached = modelCatalogCache.get(provider)
    if (cached !== undefined) return cached.map(entry => entry.id)
    try {
      const models = await ctx.llm.listModels(provider)
      const ids = models.map(entry => entry.id)
      modelCatalogCache.set(provider, ids.map(id => ({ id })))
      return ids
    } catch {
      return []
    }
  }

  /**
   * 解析识图路由:跟随当前会话模型的分组。
   * 1. 白名单精确命中当前 provider → 用它;
   * 2. 当前 provider 的模型列表里有白名单模型名的模型 → 用本分组的它
   *    (分组名任意、改名/重建都自动跟随,凭据随分组);
   * 3. 否则回退配置的默认识图路由。
   */
  const resolveVisionRoute = async (provider: string | undefined): Promise<{ provider: string; model: string; reasoningEffort: string }> => {
    const reasoningEffort = (current() ?? {}).visionReasoningEffort ?? DEFAULT_VISION_REASONING_EFFORT
    if (provider !== undefined) {
      const native = nativeVision()
      // 1. 精确:同 provider 的白名单条目。
      const exact = native.find(entry => entry.provider === provider)
      if (exact !== undefined) return { provider: exact.provider, model: exact.model, reasoningEffort }
      // 2. 按模型名:本分组里有白名单模型名的模型。
      const names = nativeModelNames()
      const ids = await listProviderModelIds(provider)
      const byName = ids.find(id => names.has(id))
      if (byName !== undefined) return { provider, model: byName, reasoningEffort }
    }
    const cfg = current() ?? {}
    return {
      provider: cfg.visionProvider ?? DEFAULT_VISION_PROVIDER,
      model: cfg.visionModel ?? DEFAULT_VISION_MODEL,
      reasoningEffort,
    }
  }

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

  /** 当前模型(assemble 快照优先,agent 创建选项兜底)。 */
  const currentModel = (agent: Agent): { provider?: string; model?: string } => {
    const snapshot = assembledModel.get(agent)
    return {
      provider: snapshot?.provider ?? agent.options.provider,
      model: snapshot?.model ?? agent.options.model,
    }
  }

  /** 当前模型是否原生支持图片:assemble 快照优先,agent 创建选项兜底。 */
  const isNativeVision = (agent: Agent): boolean => {
    const { provider, model } = currentModel(agent)
    return matchesNativeVision(provider, model)
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
    // 识图路由跟随当前分组:用当前 provider 分组里的视觉模型识图。
    const route = await resolveVisionRoute(currentModel(agent).provider)
    // 原消息保持原样(图片块保留,GUI 显示缩略图);
    // 只在其后追加独立的识别描述消息。发给模型的请求会在
    // llm/stream 阶段把图片替换为短占位(见下)。
    const expanded = await Promise.all(decision.messages.map(async message => {
      if (!hasImage(message)) return [message]
      const description = await describeImages(ctx, route, message, signal)
      return [message, description]
    }))
    return { kind: 'enter', messages: expanded.flat() }
  }, { prepend: true })

  // ---- 请求前剥离:显示保留图片,发给模型的请求换成短占位 ----
  // llm/stream 的 options 是冻结的(文档要求只读),所以这里构造替换版
  // options 重新进入 stream;替换后的消息不再含图,第二次进入时直接 next()。
  ctx.on('llm/stream', async function* (options, next) {
    const provider = options.provider
    const model = options.model
    if (provider === undefined || model === undefined) return yield* next()
    // 原生视觉模型(白名单,含跨分组按名匹配)正常发图,不干预。
    if (matchesNativeVision(provider, model)) {
      return yield* next()
    }
    if (!options.messages.some(message => hasImage(message))) return yield* next()
    const stripped = {
      ...options,
      messages: options.messages.map(message => (
        hasImage(message) ? replaceRequestImages(message) : message
      )),
    }
    yield* ctx.llm.stream(stripped)
  })

  // ---- 自动配置:给已配置模型补 image 输入声明 ----
  // 触发时机:插件加载后(延迟,等 llm 插件的 settings 段注册完成)、
  // 适配器变化、以及任何 settings 更新(用户在模型页新增模型后也能补齐)。
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleDeclarations = (): void => {
    if (syncTimer !== undefined) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      const settings = ctx.get('settings')
      if (settings === undefined) return
      const cfg = current() ?? {}
      if (cfg.autoDeclareInput === false) return
      void declareImageInputs(settings).catch((error: unknown) => {
        ctx.logger.warn(`auto-vision: failed to auto-declare image input: ${String(error)}`)
      })
    }, 1000)
  }
  scheduleDeclarations()
  ctx.on('llm/adapters-updated', () => {
    // 适配器变化后模型目录可能已变,清空缓存并重新补声明。
    modelCatalogCache.clear()
    scheduleDeclarations()
  })
  ctx.on('settings/updated', () => {
    modelCatalogCache.clear()
    scheduleDeclarations()
  })

  // 清理残留定时器。
  ctx.effect(() => () => {
    if (syncTimer !== undefined) clearTimeout(syncTimer)
  })
}
