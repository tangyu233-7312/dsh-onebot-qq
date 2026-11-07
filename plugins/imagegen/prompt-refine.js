/**
 * prompt-refine.js — 生图提示词**优化器**（imagegen 插件的一部分，单独成文件便于测试）。
 *
 * 为什么需要（2026-11-06 实测反馈"生图效果差"）：
 *   用户说的是一句人话（「画只胖鱼在吃拉面」），模型以前把这句**原样**塞给生图模型。
 *   生图模型看不懂语气、梗、会话上下文，只认"画面要素"：主体 / 外观 / 动作 / 场景 / 光线 / 构图 / 画风。
 *   所以这里先用一轮**纯文本**的模型调用把需求翻译成"能画出来的描述"，再交给生图模型。
 *
 * 纪律（和生图主流程对齐，别在这里加"聪明"逻辑）：
 *   ① **绝不重试、绝不第二次调用**：失败就原样用原文 —— 宁可画得糙，也不让一次生图花两笔钱。
 *   ② **不抛错到底**：任何异常（没服务 / 超时 / 空回复）都退回原文并记一行日志，生图照常进行。
 *   ③ 输出**必须清洗**：模型爱加「好的，这是优化后的提示词：」、引号、Markdown、多行解释，
 *      直接塞给生图模型会把这些废话画进去（实测会画出一行字）。
 *   ④ 提示词**永远从控制台读**（imagegen.promptOptimizeText）；代码里那份只当默认值，
 *      用户改了控制台就以控制台为准（"提示词全部进控制台"是本站长期设计决定）。
 */

/** 控制台没填优化提示词时的默认值（也是"恢复默认"的落点）。 */
export const DEFAULT_OPTIMIZE_PROMPT = [
  '你是生图提示词工程师。把下面这条「用户需求」改写成一段能直接交给生图模型的提示词。',
  '',
  '要求：',
  '1. 输出**只有一段提示词本体**：中文为主、可夹英文画风词；不要标题、不要解释、不要引号、不要 Markdown、不要换行分点。',
  '2. 写清能画出来的画面要素：主体（数量/外观/关键特征）→ 动作或神情 → 场景与道具 → 光线与色调 → 构图与视角 → 画风/质感。',
  '3. 具体优先：把"可爱 / 好看 / 精致"这类空话换成看得见的细节（比例、材质、颜色、光影）。',
  '4. 保留用户的原意与所有明确要求（指定了角色、颜色、文字、比例就照做），不要删、不要自行换主题。',
  '5. 不要写否定式堆砌（"不要崩坏、不要糊"）——这类词对生图模型无效，改用正向描述画质与结构。',
  '6. 长度 60~200 字；信息量够就别凑字，宁短勿水。',
  '',
  '用户需求：',
].join('\n')

/** 去掉模型爱加的客套/Markdown 包装（"好的，这是…：" / 代码围栏 / 粗体 / 引号）。 */
function stripWrapping(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  // 代码块围栏（三个反引号包一整段）
  const fence = '```'
  const fenceEdge = new RegExp(fence, 'g')
  s = s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && x.replace(fenceEdge, '').trim() !== '').join('\n')
  s = s.replace(/^`+[a-zA-Z]*\s*/, '').replace(/\s*`+\s*$/, '')
  // 先去 Markdown 星号/标题记号，再合并成一行（顺序很重要：先合并就认不出"好的，这是…："这类引导句）
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  const plain = []
  for (const one of lines) {
    if (!plain.length && plain.length !== lines.length - 1 && lines.length > 1
      && one.length <= 40 && /^(好的|当然|以下是|这是|优化后|提示词)[^\n]{0,38}[:：]$/.test(one)) continue
    plain.push(one)
  }
  s = (plain.length ? plain : lines).join(' ')
  s = s.replace(/\*\*/g, '').replace(/^#+\s*/, '')
  s = s.replace(/^[\s"'“”‘’「」『』【】]+/, '').replace(/[\s"'“”‘’「」『』【】]+$/, '')
  return s.replace(/\s+/g, ' ').trim()
}

/** 默认上限：生图提示词再长也没用，超了生图模型会截断或乱猜。 */
export const MAX_PROMPT_CHARS = 600

/**
 * 清洗优化结果。返回 '' 表示"这次优化不可用"（调用方退回原文）。
 * @param {string} raw
 * @param {{maxChars?:number}} [opts]
 */
export function cleanRefinedPrompt(raw, opts = {}) {
  const maxChars = Math.max(20, Number(opts.maxChars) || MAX_PROMPT_CHARS)
  let s = stripWrapping(raw)
  if (!s) return ''
  // 模型有时回「提示词：xxx」，再剥一层
  s = s.replace(/^(最终的?|优化后的?)?提示词\s*[:：]\s*/, '')
  if (s.length > maxChars) s = s.slice(0, maxChars).replace(/[，,、；;\s]+$/, '')
  // 有效信息太少（"无" / "无法优化" / 一个词）→ 视为失败，别拿它覆盖原意
  if (s.length < 6) return ''
  if (/^(无法|不能|抱歉|对不起|I cannot|Sorry)/i.test(s) && s.length < 40) return ''
  return s
}

/**
 * 拼最终发给大模型的 user 文本：优化提示词（控制台可改）+ 用户原话（+ 会话语境的短提示）。
 * @param {{system?:string, demand:string, context?:string}} p
 */
export function buildRefineInput({ system, demand, context }) {
  const head = String(system || '').trim() || DEFAULT_OPTIMIZE_PROMPT
  const ctx = String(context || '').trim()
  return [
    head,
    String(demand || '').trim(),
    ...(ctx ? ['', `补充语境（帮你判断这是什么角色/梗，别把它的措辞照抄进提示词）：${ctx}`] : []),
  ].join('\n')
}

/**
 * 调一次优化。**永不 throw**。
 * @param {object} p
 * @param {object} p.llm        bot.llm（内核一次性文本补全能力）；没有就返回原文
 * @param {string} p.prompt     用户/模型给的原始需求
 * @param {string} [p.system]   控制台里可改的优化提示词
 * @param {string} [p.context]  会话语境（最近几句）
 * @param {number} [p.timeoutMs]
 * @param {number} [p.maxTokens]
 * @param {object} [p.log]
 * @returns {Promise<{ok:boolean, used:boolean, original:string, prompt:string, reason:string,
 *   raw?:string, route?:string, ms?:number}>}
 */
export async function refinePrompt({ llm, prompt, system, context, timeoutMs = 30000, maxTokens = 400, log = null } = {}) {
  const original = String(prompt ?? '').trim()
  const skipped = (reason) => ({ ok: false, used: false, original, prompt: original, reason })
  if (!original) return skipped('需求为空')
  if (!llm || typeof llm.complete !== 'function' || (typeof llm.available === 'function' && !llm.available())) {
    return skipped('宿主没有可用的模型（llm 服务），已按原文生图')
  }
  const t0 = Date.now()
  let res
  try {
    res = await llm.complete({
      prompt: buildRefineInput({ system, demand: original, context }),
      maxTokens,
      timeoutMs,
    })
  } catch (e) {
    return skipped(`优化调用异常：${e?.message || e}`)
  }
  if (!res?.ok) return skipped(res?.reason || '优化没有返回结果')
  const cleaned = cleanRefinedPrompt(res.text)
  if (!cleaned) {
    log?.warn?.(`[生图] 提示词优化结果不可用（${String(res.text || '').slice(0, 60)}），按原文生图`)
    return {
      ok: false, used: false, original, prompt: original, reason: '优化结果为空或不可用',
      raw: res.text, route: res.provider ? `${res.provider}/${res.model}` : '', ms: Date.now() - t0,
    }
  }
  return {
    ok: true, used: true, original, prompt: cleaned, reason: '',
    raw: res.text,
    route: res.provider ? `${res.provider}/${res.model}` : '',
    ms: Date.now() - t0,
  }
}
