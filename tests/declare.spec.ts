import { describe, expect, it } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  declareImageInputs,
  IMAGE_DECLARATION_FIELDS,
  planImageDeclarations,
} from '../src/declare.ts'

describe('planImageDeclarations(llm-pi-ai)', () => {
  it('未声明 input 的模型补 [text, image]', () => {
    const patch = planImageDeclarations({
      providers: {
        gw: {
          models: [
            { id: 'm1', name: 'M1' },
            { id: 'm2', name: 'M2', input: ['text'] },
          ],
        },
      },
    }, 'llm-pi-ai')
    expect(patch).not.toBeNull()
    const providers = (patch as { providers: Record<string, unknown> }).providers
    const models = (providers['gw'] as { models: Record<string, unknown>[] }).models
    expect(models[0]).toEqual({ id: 'm1', name: 'M1', input: ['text', 'image'] })
    expect(models[1]).toEqual({ id: 'm2', name: 'M2', input: ['text', 'image'] })
  })

  it('已声明 image 的模型不动,整体无变化返回 null', () => {
    const section = {
      providers: {
        gw: {
          models: [
            { id: 'v', name: 'V', input: ['text', 'image'] },
            { id: 'm', name: 'M', input: ['text', 'image'] },
          ],
        },
      },
    }
    expect(planImageDeclarations(section, 'llm-pi-ai')).toBeNull()
  })

  it('无 providers 或无 models 返回 null', () => {
    expect(planImageDeclarations({}, 'llm-pi-ai')).toBeNull()
    expect(planImageDeclarations({ providers: {} }, 'llm-pi-ai')).toBeNull()
    expect(planImageDeclarations(undefined, 'llm-pi-ai')).toBeNull()
  })

  it('input 为空数组同样补声明', () => {
    const patch = planImageDeclarations({
      providers: { gw: { models: [{ id: 'm', input: [] }] } },
    }, 'llm-pi-ai')
    const models = ((patch as { providers: Record<string, unknown> }).providers['gw'] as { models: Record<string, unknown>[] }).models
    expect(models[0]).toEqual({ id: 'm', input: ['text', 'image'] })
  })
})

describe('planImageDeclarations(llm-deepseek)', () => {
  it('inputModalities 缺 image 时补 [text, image]', () => {
    const patch = planImageDeclarations({
      models: [
        { id: 'deepseek-v4-flash', name: 'Flash', inputModalities: ['text'] },
        { id: 'deepseek-v4-pro', name: 'Pro', inputModalities: ['text'] },
        { id: 'deepseek-v4-flash-vision-exp', name: 'Vision', inputModalities: ['text', 'image'] },
      ],
    }, 'llm-deepseek')
    expect(patch).not.toBeNull()
    const models = (patch as { models: Record<string, unknown>[] }).models
    expect(models[0]).toEqual({ id: 'deepseek-v4-flash', name: 'Flash', inputModalities: ['text', 'image'] })
    expect(models[1]).toEqual({ id: 'deepseek-v4-pro', name: 'Pro', inputModalities: ['text', 'image'] })
    // vision-exp 原样。
    expect(models[2]).toEqual({ id: 'deepseek-v4-flash-vision-exp', name: 'Vision', inputModalities: ['text', 'image'] })
  })

  it('全部已声明返回 null', () => {
    expect(planImageDeclarations({
      models: [{ id: 'v', inputModalities: ['text', 'image'] }],
    }, 'llm-deepseek')).toBeNull()
  })
})

describe('declareImageInputs', () => {
  it('只对有缺失的命名空间写回,幂等', async () => {
    const update = {
      'llm-pi-ai': [] as object[],
      'llm-deepseek': [] as object[],
    }
    const get = (ns: string): unknown => ns === 'llm-pi-ai'
      ? { providers: { gw: { models: [{ id: 'm' }] } } }
      : { models: [{ id: 'v', inputModalities: ['text', 'image'] }] }
    const settings = {
      get: (ns: never) => get(ns as unknown as string),
      update: async (ns: never, patch: object): Promise<void> => {
        update[ns as unknown as keyof typeof update].push(patch)
      },
    }
    await declareImageInputs(settings as never)

    expect(update['llm-pi-ai']).toHaveLength(1)
    expect(update['llm-deepseek']).toHaveLength(0)
    const patch = update['llm-pi-ai'][0] as {
      providers: { gw: { models: { id: string; input: string[] }[] } }
    }
    expect(patch.providers.gw.models[0]).toEqual({ id: 'm', input: ['text', 'image'] })

    // 幂等:第二次无缺失,不再写回。
    const secondGet = (ns: string): unknown => ns === 'llm-pi-ai'
      ? { providers: { gw: { models: [{ id: 'm', input: ['text', 'image'] }] } } }
      : { models: [{ id: 'v', inputModalities: ['text', 'image'] }] }
    const calls: object[] = []
    await declareImageInputs({
      get: (ns: never) => secondGet(ns as unknown as string),
      update: async (_ns: never, patch: object): Promise<void> => {
        calls.push(patch)
      },
    } as never)
    expect(calls).toHaveLength(0)
  })

  it('字段名常量与命名空间对齐', () => {
    expect(IMAGE_DECLARATION_FIELDS['llm-pi-ai']).toBe('input')
    expect(IMAGE_DECLARATION_FIELDS['llm-deepseek']).toBe('inputModalities')
    expect(settingsNamespace('llm-pi-ai')).toBeTruthy()
  })
})
