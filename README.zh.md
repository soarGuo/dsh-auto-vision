# dsh-auto-vision

[English](./README.md) | 中文

DSH 插件:当前会话模型**不在"原生视觉白名单"里**时,自动用视觉模型识别消息里的图片,并把识别描述以**折叠的上下文条目**写入会话历史——**你的原始消息保持原样**。每个会话都生效;与模型相关,与会话无关。**纯插件 + 配置实现,不修改 DSH 源码。**

## 工作原理

1. **GUI 放行**(自动配置):插件默认(`autoDeclareInput: true`)在启动时与 settings/适配器变化时,自动给 settings 里已配置的模型补 `input: [text, image]` 声明——图片准入检查只相信模型声明,声明含 image 即放行,带图消息得以进入 inbox。原生视觉模型同样补声明(它们也需要声明才能收到图)。
2. **准确模型快照**(插件):监听 `system-prompt/assemble`(pre-step 前、同一步发生),从 `assembly.variables` 读取 GUI 此刻选择的准确 provider/model(由 DSH 的 model-selection 机制写入)。
3. **拆分注入**(插件):`agent/pre-step` 时,白名单外的模型 → 原消息仅移除图片块(文字一字不动),识别描述作为**独立的 notice 上下文消息**追加其后(GUI 渲染为折叠行:摘要 + 展开看全文)。两条消息都由 agent loop 原样写入会话历史,**识别结果天然持久化**,后续多轮都能引用同一条图片记忆。
4. **白名单内不干预**:`nativeVision` 里的模型(默认两个 vision-exp)带图时图片原样交给模型。

## 行为

- 触发条件(两个同时满足):
  1. 进入 step 的消息含有图片块(顶层或工具结果内);
  2. 当前模型不在 `nativeVision` 白名单内。
- **递归处理工具结果**:`read_image` 等工具结果里内嵌的图片同样会被识图替换(声明 `input: [text, image]` 会解锁 `read_image` 的执行门槛,这一层替换保证模型主动读的图也不会直达网关)。
- **每次发图都会识别,每次识别结果都会追加**(不覆盖)。新截图的结果带时间戳追加在历史最后,模型以最新一条为主;旧结果仍在上下文中可引用。
- 识别失败(网络/网关错误)不阻塞消息:失败说明进描述条目,你的文字照常送达模型;用户取消则原样中止。

## 安装

构建产物 `lib/` 已提交进仓库,**无需构建步骤**,装来即用:

```sh
# GitHub 安装
dsh plugin --profile web add github:soarGuo/dsh-auto-vision

# 或 tarball 安装(在仓库目录里先 pnpm pack)
dsh plugin --profile web add ./dsh-auto-vision-0.1.0.tgz
```

安装后重启 DSH。

## 配置

**模型声明零手动配置。** 默认(`autoDeclareInput: true`)插件会自动扫描 `llm-pi-ai` / `llm-deepseek` 段,给所有已配置模型补 `image` 输入声明(幂等,已声明的不动),这是 GUI 准入放行所需的那一步。安装者无需手动改任何东西。

插件自身配置(均可省略,以下为默认值):

```yaml
auto-vision:
  visionProvider: deepseek-official            # 默认识图路由
  visionModel: deepseek-v4-flash-vision-exp    # 默认视觉模型
  nativeVision:                                # 原生视觉白名单:带图时不干预
    [
      { provider: deepseek-official, model: deepseek-v4-flash-vision-exp },
      { provider: deepseek, model: deepseek-v4-flash-vision-exp }
    ]
  autoDeclareInput: true                       # 自动补 image 声明;false 则手动管理
```

settings.yaml 修改即时生效(热重载)。识图路由也可指向任一网关的视觉模型:

```yaml
auto-vision:
  visionProvider: deepseek
  visionModel: deepseek-v4-flash-vision-exp
```

### 手动声明(仅当 autoDeclareInput: false)

以某 OpenAI 兼容网关路由为例:

```yaml
llm-pi-ai:
  providers:
    {
      my-gateway:
        {
          displayName: My Gateway,
          models:
            [
              { id: my-pro, name: My-Pro, input: [ text, image ] },
              { id: my-vision, name: My-Vision, input: [ text, image ] }
            ],
          baseURL: https://example.com/v1,
          apiKeyEnv: MY_API_KEY
        }
    }
```

## 注意事项

- 声明 `input: [text, image]` 后,GUI 会把被桥接模型显示为"支持图片";实际图片由插件桥接,不会发给网关。
- **插件停用后不要向被桥接模型发图**:图片会直达网关并被拒绝。先恢复插件或切到原生视觉模型。
- 官方路由(`deepseek-official`)的模型如需桥接,同样在 `llm-deepseek.models` 里声明 `input: [text, image]`。

## 卸载

```sh
dsh plugin --profile web remove dsh-auto-vision
```

重启 DSH。

## 开发

```powershell
pnpm install
pnpm test        # vitest 单元测试
pnpm typecheck   # 类型检查
pnpm build       # 重建 lib/(发布前记得提交构建产物)
```
