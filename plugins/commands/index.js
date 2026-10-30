/**
 * commands.js — 基础命令（id: 'commands', order: 20）
 *
 * 命令全部**零 token**：插件侧动作（读内存 / 重置会话 / 中止回复 / 拉历史 / 查额度），不叫模型。
 *
 * 三条纪律：
 *   1. **所有回复一律走 `bot.deliver()`** —— 历史实现里 18 处裸发送绕过了脱敏/留档，
 *      这次用结构性约束根治：插件拿到的 bot 上根本没有裸 send。
 *   2. `/help` 清单从**已注册命令表**动态生成，不手写死字符串 —— 加命令只改一处注册。
 *   3. `/history` 不是纯回复：把群历史写进 `ev.historyBlock` 后**放行**（不 stop），交给模型回答。
 *
 * 契约关系：`bot.registerCommand` 只负责注册；宿主在 intercept 阶段按前缀查 `kernel.commands` 调 handler。
 * 会话查询/删映射/枚举全部"探测驱动的可选方法"，探测不到就降级（驱动实际都提供了）。
 * `/quota` 依赖可选的配额能力（`bot.core.usage.report()` 或 `bot.quotaReport()`），没有就明确降级。
 */

/** /history 不带参数时拉多少条（旧 HISTORY_DEFAULT） */
const HISTORY_DEFAULT = 50
/** /history 一次最多拉多少条（防刷屏/烧 token，旧 HISTORY_MAX；2026-10-24 由 200 放宽到 500） */
const HISTORY_MAX = 500

/** OneBot 历史消息 → 一行文本。只给 /history 用：容错 segment 数组 / CQ 字符串两种形态。 */
function historyLine(m) {
  const segs = m?.message
  if (Array.isArray(segs)) {
    return segs.map((s) => {
      if (s?.type === 'text') return s.data?.text ?? ''
      if (s?.type === 'image') return ' [图片]'
      if (s?.type === 'at') return s.data?.qq === 'all' ? '@全体成员' : `@${s.data?.qq ?? ''}`
      return ''
    }).join('').trim()
  }
  return String(typeof segs === 'string' ? segs : m?.raw_message ?? '')
    .replace(/\[CQ:at,qq=all\]/g, '@全体成员')
    .replace(/\[CQ:image[^\]]*\]/g, ' [图片]')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .trim()
}

/** 北京时间 HH:MM（进程时区是 UTC，手工 +8；群历史渲染统一用这个） */
function beijingHHMM(sec) {
  if (!sec) return ''
  const d = new Date(Number(sec) * 1000 + 8 * 3600 * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/**
 * 命令后面的参数文本（例：/history 25 看看 → "25 看看"）。
 * 内核可能把整条命令留在 ev.text，也可能剥掉命令只给 args —— 两种都认，
 * 别让"命令后面的正题"被吃掉（线上实测踩过）。
 */
function tailText(ev, args, cmd) {
  const text = String(ev.text || '')
  const at = text.toLowerCase().indexOf(cmd)
  const tail = at >= 0 ? text.slice(at + cmd.length).trim() : ''
  const argText = Array.isArray(args) ? args.join(' ').trim() : String(args ?? '').trim()
  return tail || argText || (at < 0 ? text.trim() : '')
}

export default {
  id: 'commands',
  title: '基础命令',
  order: 20,
  configSchema: {
    enabled: { type: 'bool', default: true, group: '群聊', label: '基础命令', hint: '开：支持 /help、/status 这类斜杠命令（/help 谁都能用，改配置类命令仅主人）；关：全部不响应。' },
  },

  setup(bot) {
    /** 本插件注册表：/help 的动态来源（宿主还没暴露命令表，见文件头契约缺口） */
    const registry = new Map()

    /** 命令回执统一出口：deliver 之后这条消息到此为止（除 /history 外都不进模型） */
    async function reply(ev, text, name) {
      // noForward：命令回执不套合并转发卡片 —— /help 列出十几条命令轻松过 400 字，
      // 一转卡片用户还得点开才看得全（2026-10-30）。
      await bot.deliver(ev.chatKey, text, { noForward: true }) // ⚠️ 唯一出站口；引用/拆条/脱敏由内核出站链路定夺
      ev.stopped = true
      ev.stopReason = `commands:${name}`
    }

    /** 仅主人命令的统一前置；返回 true = 已拒绝并回执 */
    async function denyUnlessMaster(ev, name) {
      if (ev.sender?.isMaster === true) return false
      await reply(ev, '🙅 这个命令只有主人能用', name)
      return true
    }

    function define(name, { permission, description, run }) {
      registry.set(name, { permission, description })
      bot.registerCommand(name, {
        permission,
        description,
        async handler(ev, args) {
          try {
            await run(ev, args)
          } catch (e) {
            bot.log.warn(`命令 /${name} 失败: ${e.message}`)
            await reply(ev, `⚠️ 命令执行失败: ${e.message}`, name)
          }
        },
      })
    }

    /** 会话查询（只查不建）：契约没登记，按驱动的可选形态探测；探测不到 = 显示未创建 */
    function sessionOf(chatKey) {
      const d = bot.dsh || {}
      const v = d.sessionOf?.(chatKey) ?? d.getSession?.(chatKey)
        ?? (typeof d.sessions?.get === 'function' ? d.sessions.get(chatKey) : '')
      return v || ''
    }

    /** 删本线映射（重置用）：优先内核明确方法，其次驱动里那张 Map（旧实现就是 sessions.delete） */
    function forgetLine(chatKey) {
      const d = bot.dsh || {}
      if (typeof d.forget === 'function') return d.forget(chatKey)
      if (typeof d.resetSession === 'function') return d.resetSession(chatKey)
      if (typeof d.sessions?.delete === 'function') {
        d.sessions.delete(chatKey)
        d.saveSessions?.()
      }
    }

    /** 重置时顺手清掉与本线绑定的内存态（新会话要重新拿首轮格式说明、群上文重新给基线、群记忆重新给首次指针） */
    function clearLineState(chatKey) {
      const st = bot.state?.get?.(chatKey)
      if (!st) return
      st.followUpUntil = 0
      st.followUpCache = null
      st.lastContextId = null
      if (st._scratch) delete st._scratch['group-memory:seen']
    }

    /** 所有 QQ 线的 chatKey：契约没给"枚举全部线"的入口，按驱动可选形态探测 */
    function lineKeys() {
      const d = bot.dsh || {}
      const keys = []
      if (typeof d.sessions?.keys === 'function') keys.push(...d.sessions.keys())
      else if (typeof d.listChatKeys === 'function') keys.push(...d.listChatKeys())
      return [...new Set(keys.map(String))].filter((k) => /^(group|private):/.test(k))
    }

    /**
     * 额度查询：**可选能力降级**。通用包里没有配额数据源；站点若通过 ops/适配层注入
     * `bot.core.usage.report()` 或 `bot.quotaReport()`，就转交它渲染，否则明确告诉用户未配置。
     * （错误详情只进日志，回执保持中性。）
     */
    async function quotaReport() {
      const providers = [
        () => bot.core?.usage?.report?.(),
        () => bot.quotaReport?.(),
      ]
      for (const run of providers) {
        try {
          const out = await run()
          if (typeof out === 'string' && out.trim()) return out
        } catch (e) {
          bot.log.warn(`额度查询失败: ${e.message}`)
          return '⚠️ 配额查询不可用（过会儿再试，或看内核日志）'
        }
      }
      return '⚠️ 未配置配额能力（本实例没有接入额度数据源），/quota 暂不可用'
    }

    // ── /help（任意人） ──────────────────────────────────────────
    define('help', {
      permission: 'any',
      description: '本帮助',
      async run(ev) {
        const lines = ['📖 可用命令:']
        const source = bot.commands instanceof Map && bot.commands.size ? bot.commands : registry
        for (const [name, def] of source) {
          lines.push(`/${name} - ${def.description}${def.permission === 'master' ? '（仅主人）' : ''}`)
        }
        lines.push('', '直接发消息即可对话；群聊需 @本机 或命中唤醒词。')
        await reply(ev, lines.join('\n'), 'help')
      },
    })

    // ── /status（主人） ─────────────────────────────────────────
    define('status', {
      permission: 'master',
      description: '查看会话状态',
      async run(ev) {
        if (await denyUnlessMaster(ev, 'status')) return
        const sid = sessionOf(ev.chatKey)
        await reply(ev, [
          '📊 状态',
          `聊天: ${ev.chatKey}`,
          `类型: ${ev.isGroup ? `群聊 ${ev.groupId}` : '私聊'}`,
          `DSH 会话: ${sid || '(未创建)'}`,
        ].join('\n'), 'status')
      },
    })

    // ── /reset（主人）：**先归档旧会话、再删映射** ────────────────
    define('reset', {
      permission: 'master',
      description: '清空本聊天上下文（重新开始）',
      async run(ev) {
        if (await denyUnlessMaster(ev, 'reset')) return
        // 旧实现只删映射不归档 → 旧会话变"游离"永远留在侧栏（线上报过的问题）。
        // 现在与「控制台 → 重置本群对话」一致；归档失败只 warn 并降级（照样重置这一轮）。
        const oldSid = sessionOf(ev.chatKey)
        let archived = false
        if (oldSid && typeof bot.dsh?.archive === 'function') {
          try {
            await bot.dsh.archive(oldSid)
            archived = true
          } catch (e) {
            bot.log.warn(`归档旧会话失败 (${oldSid}): ${e.message}`)
          }
        }
        forgetLine(ev.chatKey)
        clearLineState(ev.chatKey)
        bot.log.info(`命令重置单条会话: ${ev.chatKey}（旧会话 ${oldSid || '无'}，已归档=${archived}）`)
        await reply(ev, oldSid
          ? `✅ 已清空上下文, 下次消息将开启全新会话${archived ? '（旧会话已归档）' : '（⚠️ 旧会话归档失败，仍留在侧栏）'}`
          : '✅ 已清空上下文, 下次消息将开启全新会话', 'reset')
      },
    })

    // ── /resetall（主人）：破坏性操作，必须显式 confirm ───────────
    define('resetall', {
      permission: 'master',
      description: '清空**所有** QQ 线（群+私聊）的对话；要带 confirm',
      async run(ev, args) {
        if (await denyUnlessMaster(ev, 'resetall')) return
        // 打字成本很低、误触代价很大：不带 confirm 只回提示，不动任何会话
        if (!/confirm|yes|确认|确定|是/i.test(tailText(ev, args, 'resetall'))) {
          await reply(ev, [
            '⚠️ 这会清空**所有** QQ 线的对话（群 + 私聊），旧会话在 GUI 里归档、可恢复。',
            '确定就发: /resetall confirm',
          ].join('\n'), 'resetall')
          return
        }
        const keys = lineKeys()
        const sids = [...new Set(keys.map((k) => sessionOf(k)).filter(Boolean))]
        let archived = 0
        if (typeof bot.dsh?.archive === 'function') {
          for (const sid of sids) {
            try {
              await bot.dsh.archive(sid)
              archived += 1
            } catch (e) {
              bot.log.warn(`归档旧会话失败 (${sid}): ${e.message}`)
            }
          }
        }
        for (const key of keys) {
          forgetLine(key)
          clearLineState(key)
        }
        // ⚠️ 旧实现还会扫"清过映射但会话仍留在侧栏"的游离 QQ 线会话（按 cwd 匹配）。
        //    新契约没给 listSessions / archive 的整表接口 → 这里扫不到；📌 已报 Lead 补接口。
        bot.log.info(`一键清空 QQ 线: ${keys.length} 条映射 / 归档 ${archived} 个会话`)
        await reply(ev, [
          `✅ 已清空 ${keys.length} 条 QQ 线（群 + 私聊）`,
          `旧会话已归档 ${archived} 个；下次消息开启全新对话`,
        ].join('\n'), 'resetall')
      },
    })

    // ── /cancel（主人）：中止本线正在进行的回复 ──────────────────
    define('cancel', {
      permission: 'master',
      description: '中止当前正在进行的回复',
      async run(ev) {
        if (await denyUnlessMaster(ev, 'cancel')) return
        const sid = sessionOf(ev.chatKey)
        if (!sid) {
          await reply(ev, '当前没有进行中的回复', 'cancel')
          return
        }
        const ok = await bot.dsh.cancel?.(sid)
        await reply(ev, ok ? '⏹️ 已中止当前回复' : '⚠️ 中止失败 (可能已结束)', 'cancel')
      },
    })

    // ── /quota（主人）：零 token，由可选配额能力渲染人话 ──────────
    define('quota', {
      permission: 'master',
      description: '查模型线路额度（5小时/每周/每月；仅主人）',
      async run(ev) {
        if (await denyUnlessMaster(ev, 'quota')) return
        await reply(ev, await quotaReport(), 'quota')
      },
    })

    // ── /history（主人）：**不是纯回复** —— 群历史进 ev.historyBlock，放行给模型 ──
    define('history', {
      permission: 'master',
      description: '拉本群最近 N 条记录进模型回答（仅主人；默认 50，上限 500）',
      async run(ev, args) {
        if (await denyUnlessMaster(ev, 'history')) return
        if (!ev.isGroup) {
          await reply(ev, '这个命令要在群里发（拉的就是那个群最近的记录）', 'history')
          return
        }
        const tail = tailText(ev, args, 'history')
        const asked = Number((tail.match(/\d+/) || [])[0]) || HISTORY_DEFAULT
        const n = Math.max(1, Math.min(asked, HISTORY_MAX))
        // 命令后面还写了东西（"/history 25 看看"）→ 那是主人的正题，必须带上，别吃掉
        // （线上实测踩到：只读到命令、正文丢了）
        const extra = tail.replace(/^\d+\s*/, '').trim()
        const list = await bot.onebot.groupHistory(ev.groupId, n + 2)
        if (!Array.isArray(list) || !list.length) {
          await reply(ev, '⚠️ 取群记录失败（协议端没回数据），过会儿再试', 'history')
          return
        }
        const rendered = []
        for (const m of list) {
          if (String(m?.message_id ?? m?.messageId) === String(ev.messageId)) continue
          const body = historyLine(m)
          if (!body) continue
          const who = m?.sender?.card || m?.sender?.nickname || String(m?.user_id ?? '')
          rendered.push(`${beijingHHMM(m?.time)} ${who}: ${body}`)
        }
        const block = rendered.slice(-n).join('\n')
        if (!block) {
          await reply(ev, '这一段里没有能读的文字消息', 'history')
          return
        }
        ev.historyBlock = `[群历史: 最近 ${n} 条(旧→新; 来自 OneBot get_group_msg_history)]\n${block}`
        ev.text = extra // 正题交回正文，命令本身别再进 prompt
        ev.hint.push(extra
          ? `[主人命令] 拉本群最近 ${n} 条聊天记录（记录在下面）。主人的要求：「${extra}」——**先照他这句回答**，记录只是素材。`
          : `[主人命令] 拉本群最近 ${n} 条聊天记录（记录在下面）。用当前人设的口吻回一条（2~4 行）：现在群里在聊什么、有没有人在问本机什么、有没有需要主人回应的；**别逐条复述**，只挑重点。`)
        // ⚠️ 命令跑在 intercept 阶段（早于 wake），不补 wake 的话群里没 @ 的 /history 会被当闲聊丢掉；
        //    这里的语义就是"立刻交给模型"，所以补一个显式唤醒标记（私聊按 private）。
        ev.wake ||= { kind: ev.isGroup ? 'at' : 'private' }
        bot.log.info(`/history ${n}: 取到 ${rendered.length} 条, 交给模型回答${extra ? `（带正题「${extra.slice(0, 30)}」）` : ''} (${ev.chatKey})`)
        ev.stopped = false // 放行：不 stop、不 deliver，让模型给出"对应的回答"
        return { pass: true }
      },
    })
  },
}
