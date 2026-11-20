/**
 * contracts.js — **冻结契约**。kernel 与所有 plugins 共用这一份定义。
 *
 * 纪律：
 *   · 任何人不得私自改本文件的字段名 / 阶段名 / 方法签名。要改 = 改架构，先问 Lead。
 *   · 所有子插件只能 `import { ... } from '../contracts.js'` 取常量；
 *     **禁止** import kernel 内部实现（kernel/*.js）—— 插件只认 `bot` 这个能力对象。
 *   · 事件对象是**普通可变对象**（不是 class），因为管线各阶段要就地改写（剥链接、加 hint）。
 *
 * 为什么这样设计：AstrBot 的 `AstrMessageEvent`（`core/platform/astr_message_event.py`）
 * 就是"可变事件 + stop 标记"的形态，被大规模验证过；比一堆不可变 record 更好写。
 */

/** 契约版本：插件 setup 时可用 bot.contractVersion 断言。 */
export const CONTRACT_VERSION = 1

/**
 * 入站管线阶段（**顺序即执行顺序**，不可跳阶段；同阶段内按注册顺序）。
 *
 *  - `pre-gate`     硬门禁。**fail-closed**：抛错 = 拦住这条消息。
 *  - `passive-tap`  旁路采集（留档 / 表情包入库）。**fire-and-forget**：抛错只记日志。
 *  - `intercept`    免模型拦截（命令 / 卡片链接 / 撤回 / 审批 / 戳一戳）。可 stop，也可放行。
 *  - `wake`         唤醒判定，决定 `ev.wake`。没 wake 就到此为止。
 *  - `before-turn`  拼 prompt 前最后一次改写机会（加 hint / 缩图 / 群上文 / 记忆指针）。
 */
export const STAGES = ['pre-gate', 'passive-tap', 'intercept', 'wake', 'before-turn']

/**
 * 出站装饰阶段（`deliver()` 内部固定四步，插件只能挂 `decorate`）。
 *
 *  `deliver()` 内部顺序（**内核硬编码，不可改**）：
 *    1. extractAt   —— 抽 `[AT:名字]` / `[AT:qq=号]`（必须在脱敏前！）
 *    2. sanitize    —— 六项脱敏 + toWellFormedText（唯一豁免：主人私聊）
 *    3. decorate    —— ← 插件挂这里（引用锚定夺 / 长文卡片 / 拆条）
 *    4. send+archive—— 发协议端 + 写 out 留档
 */
export const OUTBOUND_PHASE = 'decorate'

/**
 * 六项出口脱敏的**唯一实现位置**：kernel/format.js 的 `sanitizeSensitive(text, { exempt })`。
 * 插件不许自己写第二份。
 */
export const SENSITIVE_KINDS = ['qq', 'ip', 'port', 'rootCred', 'password', 'apiKey']

/**
 * 构造一个空的入站事件。**只有 kernel/onebot-adapter.js 调用它。**
 * @param {object} init 适配器解析出来的原始字段
 * @returns {BotMessageEvent}
 */
export function createEvent(init) {
  return {
    // ── 身份（不可变，插件只读） ───────────────────────────────
    chatKey: init.chatKey,              // 'group:<群号>' | 'private:<QQ>'
    isGroup: !!init.isGroup,
    groupId: init.groupId ?? null,
    messageId: init.messageId ?? null,
    sender: init.sender,                // { qq:number, name:string, card:string|null, isMaster:boolean }
    time: init.time ?? Date.now(),

    // ── 内容（归一化后的只读快照） ─────────────────────────────
    text: init.text ?? '',              // 已剥掉 @本机器人 与 CQ 码的纯正文
    rawSegments: init.rawSegments ?? [],// OneBot 原始段数组（只读，别改）
    mentionedSelf: !!init.mentionedSelf,
    replyToId: init.replyToId ?? null,  // 被引用消息 id
    images: init.images ?? [],          // [{ url, isSticker, summary, emojiId, subType }]
    files: init.files ?? [],            // [{ name, url, size }]
    cards: init.cards ?? [],            // 卡片里挖出的真链接 ['https://...']

    // ── 管线可变字段（各阶段往里写） ───────────────────────────
    wake: null,                         // { kind:'at'|'quote'|'keyword'|'followup'|'proactive'|'private', keyword?:string, reason?:string }
    hint: [],                           // 追加到 prompt 的短标记数组（字符串，按顺序拼）
    imageParts: [],                     // 送模型的多模态块 [{ mediaType, data, name }]
    imagePaths: [],                     // 落盘路径（给模型做图生图的参考）
    historyBlock: '',                   // 群聊上文块（含 \n[群聊上文]\n 前缀）
    rawText: init.text ?? '',           // 未剥链接的正文（插件可自取）
    stopped: false,                     // 置 true = 这条消息到此为止，不进模型
    stopReason: '',                     // 调试用：谁拦的
    _scratch: Object.create(null),      // 插件间传值用（不同插件别抢同名 key，前缀自己的 id）

    // ── 本轮上下文（wake 阶段之后才有值） ──────────────────────
    turnCtx: null,                      // TurnContext
  }
}

/**
 * 本轮 Turn 上下文。**替代历史实现里 4 个隐式共享 Map**：
 *   spontTurn / lastSendAt / turnAnchor / pendingTriggers → 全部收进这里 + ChatState。
 *
 * 生命周期：wake 通过 → 内核创建 → 贯穿 prompt 组装 / 工具执行 / 出站 → turn/end 时销毁。
 * 工具内怎么拿到它：内核把它挂在 `AsyncLocalStorage`，工具调用时自动可取（见 kernel/state-pipeline.js）。
 */
export function createTurnContext(ev) {
  // 插件可在更早的阶段（before-turn 等）把自己的标记放进 `ev._scratch.turnExtras`，
  // 等 TurnContext 建出来时并进去 —— 这样插件不用为了"本轮内的状态"去改内核的字段表。
  const extras = ev?._scratch?.turnExtras
  return {
    ...(extras && typeof extras === 'object' ? extras : {}),
    turnId: `${ev.chatKey}#${Date.now().toString(36)}`,
    chatKey: ev.chatKey,
    triggerMsgId: ev.messageId,
    wakeKind: ev.wake?.kind ?? 'private',
    arrivedDuringTurn: 0,     // 本轮开始后同群又来了几条（>0 才自动挂引用）
    stickersSent: 0,          // 本轮已发几张表情包（上限 1）
    imagegenUsed: 0,          // 本轮已生图几次
    startedAt: Date.now(),
    promptText: '',           // before-turn 结束后由内核填最终文本
    sessionId: null,          // 走完 dsh-driver 后回填
  }
}

/**
 * 出站消息包（`deliver` 的载荷）。插件在 `decorate` 阶段拿到的就是它，可改字段。
 * @typedef {object} OutboundMessage
 * @property {string} target        'group:123' | 'private:456'
 * @property {string} text          正文（已脱敏；插件不要回写敏感内容）
 * @property {number[]} ats         要 @ 的 QQ 号
 * @property {number|null} replyTo  引用哪条（null=不引用；decorate 阶段可改）
 * @property {'plain'|'reply'|'at'|'forward'} mode  最终发送形态
 * @property {boolean} [noForward]   true = 不许套长文卡片（主动接话轮用）
 * @property {object|null} turnCtx  本轮上下文（主动接话轮 = wakeKind 'proactive'）
 * @property {boolean} fromTool      true = 模型经 send_message 发的正文（拆条等加工只对它做）
 */

/**
 * **子插件标准契约**（每个 `src/plugins/<id>.js` 默认导出这个对象）。
 *
 * ```js
 * export default {
 *   id: 'stickers',
 *   title: '表情包',
 *   order: 60,                       // 同阶段内排序，小在前；缺省 100
 *   configSchema: {                  // 控制台据此渲染表单 + 生成默认值
 *     enabled: { type: 'bool', default: true, group: '能力', label: '表情包' },
 *   },
 *   setup(bot) { ... },              // 注册钩子/工具；**不要返回任何东西**
 * }
 * ```
 *
 * `bot` 能力对象（内核注入，插件只用这些，**别去摸别的**）：
 *
 * | 成员 | 说明 |
 * |---|---|
 * | `bot.id` | 本插件 id |
 * | `bot.cfg` | 本插件的已校验配置（已套 schema 默认值；控制台热改会原地同步） |
 * | `bot.log` | `{ info, warn, error, debug }` |
 * | `bot.contractVersion` | 契约版本 |
 * | `bot.on(stage, fn, opts?)` | 挂入站阶段；`fn(ev)`；`opts.order` 覆盖插件 order |
 * | `bot.onOutbound(fn)` | 挂出站 decorate；`fn(out)`；可改 `out.mode / out.replyTo / out.text` |
 * | `bot.registerCommand(name, def)` | `{ permission:'any'\|'master', description, handler(ev, args) }` |
 * | `bot.registerTool(name, toolDef)` | `toolDef` = `{ description, parameters, execute(args) }`（返回普通值即可） |
 * | `bot.deliver(target, text, opts?)` | **唯一出站口**；`opts={ replyTo, ats, turnCtx }` |
 * | `bot.sendMedia(target, cqBody, caption)` | 发图/媒体（内部走 deliver 的脱敏 + 留档） |
 * | `bot.state` | ChatState 访问器：`{ get(chatKey), turns }` |
 * | `bot.pacing` | 回复节奏（内核级）：`{ config, stats(), submit, noteInbound, interestFor(ev) }` —— 主动接话由内核调度，插件只读状态/配置 |
 * | `bot.conversation` | 接话窗口：门禁使用 open/capture，重置使用 clear(chatKey)；只有实际模型回复续期 |
 * | `bot.currentTurn()` | 取本轮 TurnContext：工具执行时按 **DSH 会话 id** 认线（认不出再按参数 target），**绝不跨线兜底**；拿不到返回 null，请自己报错让模型重试 |
 * | `bot.onebot` | 只读适配器（`groupHistory / memberInfo / recall / fetchAvatar / friendList / msgById / getFile`）；**没有 raw send** |
 * | `bot.core` | 只读核心配置快照：`{ adminQq, dataDir, configPath, toolPrefix, outbound, archive, pacing, credentials, dsh, onebot, compat, keywordTable, tmp }` |
 * | `bot.credentials` | 实例配置的凭据段（如 `credentials.gptImage`）；也能从 `bot.core.credentials` 取 |
 * | `bot.dsh` | 会话驱动：`{ ensureSession(chatKey), rename(sessionId,title), cancel(sessionId) }` |
 */

/** 配置 schema 字段类型 → 控制台控件（与控制台前端已有的控件类型对齐）。 */
export const CONFIG_TYPES = {
  bool: 'bool',      // 开关
  int: 'int',        // 整数（可带 unit/scale/min/max/step）
  float: 'float',    // 小数（可带 unit/scale）
  str: 'str',        // 文本
  enum: 'enum',      // 下拉（options: [{value,label}]）
  group: 'group',    // 字符串数组（如可自发接话的群号列表）
}

/** 给插件写 configSchema 用的小工具：补默认值。内核会在 setup 前套用它。 */
export function withDefaults(schema, raw = {}) {
  const cfg = {}
  for (const [key, def] of Object.entries(schema ?? {})) {
    const v = raw?.[key]
    cfg[key] = v === undefined ? def?.default : v
  }
  return cfg
}

/** 判断某 chatKey 是不是主人私聊（脱敏唯一豁免点）。内核才知道 adminQq，插件用这个辅助判断。 */
export function isMasterPrivate(chatKey, adminQq) {
  return String(chatKey) === `private:${Number(adminQq)}`
}
