/**
 * 自动配置:给 settings 里已配置的模型自动补 `image` 输入声明。
 *
 * GUI 的图片准入检查发生在插件之前,它只相信模型的输入能力声明。
 * 本模块扫描 `llm-pi-ai` / `llm-deepseek` 段的模型列表,为尚未声明
 * `image` 输入的模型自动补上声明,于是:
 * - GUI 放行带图消息(进入本插件的桥接流程);
 * - 原生视觉模型(白名单内)也补声明 —— 它们同样需要声明才能发图,
 *   否则 GUI 连 vision 模型都会拦。
 *
 * 纯 settings 写入,不改 DSH 源码。幂等:已声明的不动,可随时通过
 * `autoDeclareInput: false` 关闭。
 * @module dsh-auto-vision/declare
 */

import type { SettingsForms } from '@deepseek-ai/dsh-settings'

/** 模型输入能力声明在两个命名空间里的字段名不同。 */
export const IMAGE_DECLARATION_FIELDS = {
  'llm-pi-ai': 'input',
  'llm-deepseek': 'inputModalities',
} as const

export type ImageDeclarationNamespace = keyof typeof IMAGE_DECLARATION_FIELDS

/** 需要扫描的命名空间列表(先 pi-ai 网关,后官方 DeepSeek)。 */
export const IMAGE_DECLARATION_NAMESPACES: readonly ImageDeclarationNamespace[] = ['llm-pi-ai', 'llm-deepseek']

type ModelRecord = Record<string, unknown>
type Section = Record<string, unknown>

/** 判断一个模型是否已声明 image 输入。 */
function declaresImage(model: ModelRecord | undefined, field: string): boolean {
  const declared = model?.[field]
  return Array.isArray(declared) && declared.includes('image')
}

/**
 * 计算"补 image 声明"所需写回的 patch,未变化时返回 null。
 * @param section - 该命名空间的 resolved 段。
 * @param ns - 命名空间(决定模型列表与字段名的位置)。
 * @returns 需要写回 settings 的 patch;全部已声明时为 null。
 */
export function planImageDeclarations(
  section: Section | undefined,
  ns: ImageDeclarationNamespace,
): Record<string, unknown> | null {
  if (section === undefined || typeof section !== 'object') return null
  const field = IMAGE_DECLARATION_FIELDS[ns]

  if (ns === 'llm-deepseek') {
    const models = section['models']
    if (!Array.isArray(models)) return null
    let changed = false
    const next = models.map(raw => {
      const model = typeof raw === 'object' && raw !== null ? raw as ModelRecord : {}
      if (declaresImage(model, field)) return model
      changed = true
      return { ...model, [field]: ['text', 'image'] }
    })
    return changed ? { models: next } : null
  }

  // llm-pi-ai:providers.<key>.models[]
  const providers = section['providers']
  if (typeof providers !== 'object' || providers === null) return null
  let changed = false
  const patchedProviders: Record<string, unknown> = {}
  for (const [key, rawProvider] of Object.entries(providers as Record<string, unknown>)) {
    const provider = typeof rawProvider === 'object' && rawProvider !== null ? rawProvider as ModelRecord : {}
    const models = provider['models']
    if (!Array.isArray(models)) continue
    const next = models.map(raw => {
      const model = typeof raw === 'object' && raw !== null ? raw as ModelRecord : {}
      if (declaresImage(model, field)) return model
      changed = true
      return { ...model, [field]: ['text', 'image'] }
    })
    patchedProviders[key] = { models: next }
  }
  return changed ? { providers: patchedProviders } : null
}

/**
 * 扫描 settings 服务的两个模型命名空间,把缺失的 image 声明写回。
 * 幂等;命名空间尚未注册(段为 undefined)时跳过。
 *
 * 0.1.7 的 settings 服务按 Loader entry 描述配置(SettingsForms):先用
 * `describe()` 读各段实时值,再用 `update()` 合并写回。模型列表字段在官方
 * llm-deepseek 与 llm-pi-ai 里都位于 volatile 节点之下,因此这两次写入都会
 * 就地生效,不会重挂对应的适配器。
 * @param settings - settings 服务(describe/update)。
 * @param namespaces - 要扫描的命名空间,默认全部。
 * @returns 完成全部写入后 resolve;单段写入失败会 reject。
 */
export async function declareImageInputs(
  settings: SettingsForms,
  namespaces: readonly ImageDeclarationNamespace[] = IMAGE_DECLARATION_NAMESPACES,
): Promise<void> {
  const descriptors = settings.describe()
  for (const ns of namespaces) {
    const descriptor = descriptors.find(row => row.ns === ns)
    if (descriptor === undefined) continue
    const patch = planImageDeclarations(descriptor.value as Section | undefined, ns)
    if (patch !== null) await settings.update(ns, patch)
  }
}
