import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "schemastery";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/declare.ts
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
/** 模型输入能力声明在两个命名空间里的字段名不同。 */
const IMAGE_DECLARATION_FIELDS = {
	"llm-pi-ai": "input",
	"llm-deepseek": "inputModalities"
};
/** 需要扫描的命名空间列表(先 pi-ai 网关,后官方 DeepSeek)。 */
const IMAGE_DECLARATION_NAMESPACES = ["llm-pi-ai", "llm-deepseek"];
/** 判断一个模型是否已声明 image 输入。 */
function declaresImage(model, field) {
	const declared = model?.[field];
	return Array.isArray(declared) && declared.includes("image");
}
/**
* 计算"补 image 声明"所需写回的 patch,未变化时返回 null。
* @param section - 该命名空间的 resolved 段。
* @param ns - 命名空间(决定模型列表与字段名的位置)。
* @returns 需要写回 settings 的 patch;全部已声明时为 null。
*/
function planImageDeclarations(section, ns) {
	if (section === void 0 || typeof section !== "object") return null;
	const field = IMAGE_DECLARATION_FIELDS[ns];
	if (ns === "llm-deepseek") {
		const models = section["models"];
		if (!Array.isArray(models)) return null;
		let changed = false;
		const next = models.map((raw) => {
			const model = typeof raw === "object" && raw !== null ? raw : {};
			if (declaresImage(model, field)) return model;
			changed = true;
			return {
				...model,
				[field]: ["text", "image"]
			};
		});
		return changed ? { models: next } : null;
	}
	const providers = section["providers"];
	if (typeof providers !== "object" || providers === null) return null;
	let changed = false;
	const patchedProviders = {};
	for (const [key, rawProvider] of Object.entries(providers)) {
		const models = (typeof rawProvider === "object" && rawProvider !== null ? rawProvider : {})["models"];
		if (!Array.isArray(models)) continue;
		patchedProviders[key] = { models: models.map((raw) => {
			const model = typeof raw === "object" && raw !== null ? raw : {};
			if (declaresImage(model, field)) return model;
			changed = true;
			return {
				...model,
				[field]: ["text", "image"]
			};
		}) };
	}
	return changed ? { providers: patchedProviders } : null;
}
/**
* 扫描 settings 服务的两个模型命名空间,把缺失的 image 声明写回。
* 幂等;命名空间尚未注册(段为 undefined)时跳过。
* @param settings - settings 服务(get/update)。
* @param namespaces - 要扫描的命名空间,默认全部。
* @returns 完成全部写入后 resolve;单段写入失败会 reject。
*/
async function declareImageInputs(settings, namespaces = IMAGE_DECLARATION_NAMESPACES) {
	for (const ns of namespaces) {
		const patch = planImageDeclarations(settings.get(settingsNamespace(ns)), ns);
		if (patch !== null) await settings.update(settingsNamespace(ns), patch);
	}
}
//#endregion
//#region src/vision.ts
/** 稳定 cordis 插件名(cordis.patch.yml 的 insert id 与 index.ts 共用)。 */
const PLUGIN_NAME = "auto-vision";
/** 视觉识别调用的系统提示:只描述图片,不回答问题。 */
const DESCRIBE_SYSTEM = "你是识图助手,只输出对图片客观、详实的描述;不要回答用户的问题,不要给出建议。";
/** 判断内容块列表里是否含有图片(递归工具结果)。 */
function containsImage(blocks) {
	return blocks.some((block) => block.type === "image" || block.type === "tool-result" && containsImage(block.content));
}
/** 判断一条消息里是否含有图片(递归工具结果)。 */
function hasImage(message) {
	return containsImage(message.content);
}
/** 递归收集全部图片块(深度优先,保持原顺序)。 */
function collectImages(blocks) {
	const images = [];
	for (const block of blocks) if (block.type === "image") images.push(block);
	else if (block.type === "tool-result") images.push(...collectImages(block.content));
	return images;
}
/** 拼接全部文本块(递归工具结果),用于识图 prompt 的上下文。 */
function plainText(message) {
	const texts = [];
	const walk = (blocks) => {
		for (const block of blocks) if (block.type === "text") texts.push(block.text);
		else if (block.type === "tool-result") walk(block.content);
	};
	walk(message.content);
	return texts.join("\n").trim();
}
/**
* 构造识图 prompt:让视觉模型按「图1:」「图2:」…分节输出详实描述,
* 供无法直接查看图片的模型引用。
*/
function buildDescribePrompt(imageCount, userText) {
	const original = userText.length > 0 ? userText : "(无文字说明)";
	return [
		DESCRIBE_SYSTEM,
		"",
		"以下图片需要被识别为详细的文字描述,供一个无法直接查看图片的模型引用。请依次详细描述这些图片,使该模型仅凭文字就能引用图片内容。",
		"",
		`图片数量:${imageCount} 张。请用「图1:」「图2:」…逐张分节输出,每张包含:`,
		"- 图片类型(截图/照片/图表/手绘图等)",
		"- 画面与界面布局",
		"- 关键文字、数字、状态、报错信息(尽量逐字摘录)",
		"- 与用户问题相关的重点",
		"",
		"只输出描述本身,不要回答用户的问题,不要补充建议。",
		"",
		"原文或上下文:",
		original
	].join("\n");
}
/** 格式化为本地时间戳,标注在识别文本前面以便新旧截图区分。 */
function formatStamp(date) {
	return date.toLocaleString("zh-CN", { hour12: false });
}
/**
* 消费模型流并收集全部文本块。
* @param stream - 一次识图调用的 chunk 流。
* @returns 拼接后的文本(trim 后);流以 error/aborted 结束时抛出对应错误。
*/
async function collectText(stream) {
	const texts = /* @__PURE__ */ new Map();
	for await (const chunk of stream) switch (chunk.type) {
		case "text-delta":
			texts.set(chunk.index, (texts.get(chunk.index) ?? "") + chunk.text);
			break;
		case "block-end":
			if (chunk.block.type === "text") texts.set(chunk.index, chunk.block.text);
			break;
		case "finish": {
			const reason = chunk.reason;
			if (reason.kind === "aborted") throw new Error(`识图调用被中止:${reason.failure.message}`);
			if (reason.kind === "error") throw new Error(`识图调用失败:${reason.failure.message}`);
			break;
		}
	}
	return [...texts.values()].join("").trim();
}
/**
* 把一条消息里的全部图片块(递归工具结果)移除,不插入任何文本。
* 用于请求前剥离:GUI 显示的消息保留图片,只有发给模型的请求被剥离;
* 完整识别内容在紧随其后的描述消息里,请求里不留占位痕迹。
* @returns 新消息对象(保留 id 与 source,仅 content 替换)。
*/
function replaceRequestImages(message) {
	const walk = (blocks) => blocks.flatMap((block) => {
		switch (block.type) {
			case "image": return [];
			case "tool-result": return containsImage(block.content) ? [{
				...block,
				content: walk(block.content)
			}] : [block];
			default: return [block];
		}
	});
	return {
		...message,
		content: walk(message.content)
	};
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
async function describeImages(ctx, vision, message, signal) {
	const images = collectImages(message.content);
	const visionMessage = createUserMessage({
		content: [{
			type: "text",
			text: buildDescribePrompt(images.length, plainText(message))
		}, ...images.map((block) => ({
			type: "image",
			attachment: block.attachment
		}))],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME
		}
	});
	let description;
	let failed = false;
	try {
		description = await collectText(ctx.llm.stream({
			provider: vision.provider,
			model: vision.model,
			messages: [visionMessage],
			...vision.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(vision.reasoningEffort) },
			signal
		}));
	} catch (error) {
		if (signal?.aborted) throw error;
		description = `[识图失败:${error instanceof Error ? error.message : String(error)}]`;
		failed = true;
	}
	return createUserMessage({
		content: [{
			type: "text",
			text: `[截图识别 ${formatStamp(/* @__PURE__ */ new Date())}]\n${description}`
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "notice",
			summary: failed ? "图片识别失败" : `识别了 ${images.length} 张图片`
		}
	});
}
//#endregion
//#region src/index.ts
/** 稳定 cordis 插件名(与 cordis.patch.yml 的 insert id 一致)。 */
const name = PLUGIN_NAME;
/** agent 事件与 llm 服务;视觉模型的图片读取由适配器自理。 */
const inject = ["agents", "llm"];
/** 插件配置命名空间(settings.yaml 的 auto-vision 段)。 */
const AUTO_VISION_NAMESPACE = settingsNamespace("auto-vision");
/** 默认识图路由:官方 DeepSeek 的视觉实验模型。 */
const DEFAULT_VISION_PROVIDER = "deepseek-official";
const DEFAULT_VISION_MODEL = "deepseek-v4-flash-vision-exp";
/** 默认识图思考强度。 */
const DEFAULT_VISION_REASONING_EFFORT = "high";
/** 原生视觉模型默认白名单:这些模型带图时不干预。 */
const DEFAULT_NATIVE_VISION = [{
	provider: "deepseek-official",
	model: "deepseek-v4-flash-vision-exp"
}, {
	provider: "deepseek",
	model: "deepseek-v4-flash-vision-exp"
}];
/** Schemastery 校验(同时是 settings 段的 schema)。 */
const Config = z.object({
	visionProvider: z.string().default(DEFAULT_VISION_PROVIDER),
	visionModel: z.string().default(DEFAULT_VISION_MODEL),
	nativeVision: z.array(z.object({
		provider: z.string(),
		model: z.string()
	})).default(DEFAULT_NATIVE_VISION),
	autoDeclareInput: z.boolean().default(true),
	visionReasoningEffort: z.string().default(DEFAULT_VISION_REASONING_EFFORT)
});
/**
* 注册识图桥接:
* 1. `system-prompt/assemble` 快照每个 agent 本步的准确模型(GUI 的模型
*    选择由 installModelSelection 写进 assembly.variables);
* 2. `agent/pre-step` 对白名单外的模型把图片块替换为识别文本。
* @param ctx - 插件上下文;监听器随上下文一起销毁。
* @param config - 组合入口配置;settings.yaml 的 auto-vision 段会覆盖它。
*/
function apply(ctx, config) {
	let current = () => config;
	installSettingsSection(ctx, AUTO_VISION_NAMESPACE, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {}
	});
	/** 原生视觉白名单(每次判断时读取最新配置)。 */
	const nativeVision = () => (current() ?? {}).nativeVision ?? DEFAULT_NATIVE_VISION;
	/**
	* 解析识图路由:跟随当前会话模型的分组。
	* 若当前 provider 在白名单里列有原生视觉模型,就用**同分组**的视觉模型
	* 识图(同分组即同一组凭据,例如 sub2api 分组走 QX key);否则回退到
	* 配置的默认识图路由。
	*/
	const resolveVisionRoute = (provider) => {
		const reasoningEffort = (current() ?? {}).visionReasoningEffort ?? "high";
		if (provider !== void 0) {
			const match = nativeVision().find((entry) => entry.provider === provider);
			if (match !== void 0) return {
				provider: match.provider,
				model: match.model,
				reasoningEffort
			};
		}
		const cfg = current() ?? {};
		return {
			provider: cfg.visionProvider ?? "deepseek-official",
			model: cfg.visionModel ?? "deepseek-v4-flash-vision-exp",
			reasoningEffort
		};
	};
	/** 每个 agent 最近一次 assemble 的准确模型;assemble 先于 pre-step、同一步发生。 */
	const assembledModel = /* @__PURE__ */ new WeakMap();
	ctx.on("system-prompt/assemble", async (assembly, context, next) => {
		const transformed = await next();
		const agent = context.agent;
		const provider = transformed.variables["provider"];
		const model = transformed.variables["model"];
		if (agent !== void 0 && typeof provider === "string" && typeof model === "string") assembledModel.set(agent, {
			provider,
			model
		});
		return transformed;
	});
	/** 当前模型(assemble 快照优先,agent 创建选项兜底)。 */
	const currentModel = (agent) => {
		const snapshot = assembledModel.get(agent);
		return {
			provider: snapshot?.provider ?? agent.options.provider,
			model: snapshot?.model ?? agent.options.model
		};
	};
	/** 当前模型是否原生支持图片:assemble 快照优先,agent 创建选项兜底。 */
	const isNativeVision = (agent) => {
		const { provider, model } = currentModel(agent);
		if (provider === void 0 || model === void 0) return false;
		return nativeVision().some((entry) => entry.provider === provider && entry.model === model);
	};
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		if (!decision.messages.some((message) => hasImage(message))) return decision;
		if (isNativeVision(agent)) return decision;
		const route = resolveVisionRoute(currentModel(agent).provider);
		return {
			kind: "enter",
			messages: (await Promise.all(decision.messages.map(async (message) => {
				if (!hasImage(message)) return [message];
				return [message, await describeImages(ctx, route, message, signal)];
			}))).flat()
		};
	}, { prepend: true });
	ctx.on("llm/stream", async function* (options, next) {
		const provider = options.provider;
		const model = options.model;
		if (provider === void 0 || model === void 0) return yield* next();
		if (nativeVision().some((entry) => entry.provider === provider && entry.model === model)) return yield* next();
		if (!options.messages.some((message) => hasImage(message))) return yield* next();
		const stripped = {
			...options,
			messages: options.messages.map((message) => hasImage(message) ? replaceRequestImages(message) : message)
		};
		yield* ctx.llm.stream(stripped);
	});
	let syncTimer;
	const scheduleDeclarations = () => {
		if (syncTimer !== void 0) clearTimeout(syncTimer);
		syncTimer = setTimeout(() => {
			syncTimer = void 0;
			const settings = ctx.get("settings");
			if (settings === void 0) return;
			if ((current() ?? {}).autoDeclareInput === false) return;
			declareImageInputs(settings).catch((error) => {
				ctx.logger.warn(`auto-vision: failed to auto-declare image input: ${String(error)}`);
			});
		}, 1e3);
	};
	scheduleDeclarations();
	ctx.on("llm/adapters-updated", () => {
		scheduleDeclarations();
	});
	ctx.on("settings/updated", () => {
		scheduleDeclarations();
	});
	ctx.effect(() => () => {
		if (syncTimer !== void 0) clearTimeout(syncTimer);
	});
}
//#endregion
export { AUTO_VISION_NAMESPACE, Config, DEFAULT_NATIVE_VISION, DEFAULT_VISION_MODEL, DEFAULT_VISION_PROVIDER, DEFAULT_VISION_REASONING_EFFORT, apply, inject, name };
