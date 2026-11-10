window.__ModuleLoader__.load({
	id: 'dsh-onebot-qq',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement
		const CHANNEL = '/qq-console'

		// ── 样式（内联，省一个 CSS 资源） ─────────────────────────────────
		const S = {
			card: { border: '1px solid var(--dsh-border, #e4e7ec)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
			title: { fontWeight: 600, marginBottom: 6 },
			row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', flexWrap: 'wrap' },
			label: { flex: '1 1 auto' },
			btn: { padding: '3px 10px', borderRadius: 6, border: '1px solid #d0d5dd', background: 'transparent', cursor: 'pointer', fontSize: 13 },
			input: { width: 110, padding: '3px 8px', borderRadius: 6, border: '1px solid #d0d5dd', background: 'transparent', fontSize: 13 },
			chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, background: 'rgba(127,127,127,.12)', fontSize: 12, margin: '2px 4px 2px 0' },
			badge: (ok) => ({ display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 12, marginRight: 6, background: ok ? '#dcfce7' : '#fee2e2', color: ok ? '#166534' : '#991b1b' }),
			msg: { fontSize: 13, minHeight: 18, opacity: .85, whiteSpace: 'pre-wrap' },   // 多行消息（自检失败清单）原样换行
			group: { fontSize: 12, opacity: .65, marginTop: 8, marginBottom: 2 },
			// 群卡片专用：卡片标题行 / 卡片操作行（恒定右对齐）/ 字段名固定列（两行对齐）/ 禁用态按钮
			cardHd: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
			cardCtl: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 6 },
			flabel: { flex: '0 0 152px', fontSize: 12, opacity: .8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
			btnOff: { opacity: .45, cursor: 'not-allowed' },
			// 标签页（页内切换，不占设置左侧导航）
			tabs: { display: 'flex', gap: 6, marginBottom: 10, borderBottom: '1px solid rgba(127,127,127,.25)', paddingBottom: 6, flexWrap: 'wrap' },
			tab: { padding: '4px 14px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: 13, opacity: .7 },
			tabOn: { padding: '4px 14px', borderRadius: 8, border: '1px solid #d0d5dd', background: 'rgba(127,127,127,.14)', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: 1 },
			pgroup: { fontSize: 12, opacity: .65, marginTop: 10, marginBottom: 2, borderTop: '1px solid rgba(127,127,127,.18)', paddingTop: 8 },
		}

		// ═══════════ 页内标签页（2026-10-18 起：一项功能一页）═══════════
		// 固定页：总览 / 运维 / 群聊 / 子插件 / 记忆（long-memory 插件）；
		// 功能页：后端 CONTROLS 的每个 group 自动成一页（顺序 = 后端首次出现的顺序）——
		//   现在 = OneBot 连接 / 消息设置 / 主动接话 / 回话 / 生图 / 表情包 / 链接解析。
		//   ⇒ 以后加一组开关：group 写新名字就自动多一页，前端不用改。
		// PERSONA_GROUPS（默认空）：如有分组要跟着「人设」显示在总览页，由 schema.personaGroups 指定。
		// 数据（schema / status / msg / busy / confirmBox）由**外壳统一持有**再往下传：
		// ① 避免每个标签页各拉一遍 status（status 里要 spawnSync 查四个服务，拉 6 次很浪费）；
		// ② 操作反馈（消息行）和二次确认弹窗做成**跨标签页共用**，切页不丢。
		// 标签页组件只负责"渲染自己那一块"，不自己取数。

		/**
		 * 群唤醒词编辑（老款「填空 + 添加按钮」交互，不用多行文本框）。
		 * 可删的是 config 词表（控制台写这里）；人设 `.wake.txt` 自带的词只读展示（改人设文件）。
		 */
		function WakeWordsEditor(props) {
			const { call, run, busy, status } = props
			const { useState } = react
			const [word, setWord] = useState('')
			const [note, setNote] = useState('')
			const wake = (status && status.wake) || {}
			const cfgWords = Array.isArray(wake.cfgGlobal) ? wake.cfgGlobal.map(String) : []
			const personaWords = Array.isArray(wake.persona) ? wake.persona.map(String) : []
			const personaOnly = personaWords.filter((w) => !cfgWords.includes(w))
			const add = () => {
				const w = word.trim()
				if (!w || busy) return
				if (/[\r\n]/.test(w)) { setNote('唤醒词不能包含换行'); return }
				if (cfgWords.includes(w)) { setNote(`「${w}」已经在词表里了`); return }
				setNote('')
				Promise.resolve(run(`加唤醒词 ${w}`, () => call('group', { kind: 'keywords', op: 'add', group_id: '*', value: w })))
					.then(() => setWord(''))
					.catch(() => { /* run 自己会把错误写进消息行 */ })
			}
			const srcText = (personaOnly.length && cfgWords.length) ? '来源：人设 + config 合并'
				: personaOnly.length ? `来源：人设 ${String(wake.wakeFile || '').split(/[\\/]/).pop()}` : '来源：config'
			return h('div', { key: 'wakeWords', style: { marginLeft: 10, marginBottom: 6 } }, [
				h('div', { style: S.row, key: 'row' }, [
					h('span', { key: 'l', style: S.flabel, title: '所有群通用：群里说到这些词就唤醒（不用 @ 机器人）；config 词 / 人设词的 × 都能删' }, '免@唤醒词（全局）'),
					h('span', { key: 'src', style: S.badge(cfgWords.length > 0 || personaOnly.length > 0) }, srcText),
					...cfgWords.map((w) => h('span', { style: S.chip, key: 'c' + w, title: 'config 里的词（点 × 删除）' }, [
						w,
						h('span', {
							key: 'x', style: { cursor: 'pointer' },
							onClick: () => !busy && run(`删词 ${w}`, () => call('group', { kind: 'keywords', op: 'remove', group_id: '*', value: w })),
						}, '×'),
					])),
					...personaOnly.map((w) => h('span', {
						key: 'p' + w, style: S.chip,
						title: '来自人设文件（点 × 删除会改 personas/<当前人设>.wake.txt）',
					}, [
						w,
						h('span', {
							key: 'x', style: { cursor: 'pointer' },
							onClick: () => !busy && run(`删人设唤醒词 ${w}`, () => call('group', { kind: 'keywords', op: 'remove', group_id: '*', value: w, source: 'persona' })),
						}, '×'),
					])),
					h('input', {
						key: 'in', style: S.input, placeholder: '输入唤醒词', value: word, disabled: busy,
						onChange: (e) => { setWord(e.target.value); if (note) setNote('') },
						onKeyDown: (e) => { if (e.key === 'Enter') add() },
					}),
					h('button', { key: 'add', style: S.btn, disabled: busy || !word.trim(), onClick: add, title: '添加一个免@唤醒词（所有群共用）' }, '添加'),
				]),
				h('div', { key: 'hint', style: S.msg }, personaOnly.length
					? `人设文件自带的词也在生效；点它上面的 × 会改人设文件（personas/<当前人设>.wake.txt），加词写到 config。当前人设：${wake.wakeFile ? String(wake.wakeFile).split(/[\\/]/).pop() : '（无）'}`
					: (cfgWords.length ? '加/删立即生效；切到自带 wake.txt 的人设会自动合并。' : '还没有免@唤醒词：群里只能 @ 或引用叫醒它。')),
				note ? h('div', { key: 'note', style: S.msg }, note) : null,
			])
		}

		/** 开关行（支持 bool / enum / str / group / int / float / text；info = 整行说明块） */
		function ctrlRow(c, api) {
			const { busy, run, call, setMsg } = api
			// 提示里的 ** 是文档粗体标记，tooltip 会原样露出星号 → 渲染前统一去掉
			const plainHint = String(c.hint || '').replace(/\*\*/g, '')
			// 纯说明块（新手引导的分步骤图文）：不渲染输入框、不参与读写
			if (c.type === 'info') {
				return h('div', {
					key: c.key,
					style: Object.assign({}, S.msg, {
						marginLeft: 10, marginBottom: 6, whiteSpace: 'pre-wrap', lineHeight: 1.55,
					}),
					title: plainHint,
				}, String(c.text || ''))
			}
			// 群唤醒词：老款「填空 + 添加」交互（存储仍是 config 的文本行格式；不用多行文本框）
			if (c.key === 'gate-wake.keywords') return h(WakeWordsEditor, { key: c.key, ...api })
			// 悬停解释（2026-10-11）：整行 title + 行尾 ⓘ
			const renderInput = () => {
				if (c.type === 'bool') {
					return h('input', {
						key: 'v', type: 'checkbox', checked: !!c.value, disabled: busy,
						onChange: (e) => run(`${c.label} = ${e.target.checked}`, () => call('set', { key: c.key, value: e.target.checked })),
					})
				}
				if (c.type === 'enum') {
					const opts = Array.isArray(c.options) ? c.options : []
					return h('select', {
						key: 'v', style: Object.assign({}, S.input, { width: 150 }), value: c.value ?? '', disabled: busy,
						onChange: (e) => run(`${c.label} = ${e.target.value}`, () => call('set', { key: c.key, value: e.target.value })),
					}, opts.map((o) => {
						const val = o && o.value !== undefined ? o.value : o
						const lbl = o && o.label !== undefined ? o.label : val
						return h('option', { key: String(val), value: String(val) }, String(lbl))
					}))
				}
				// 带输入建议的 str（如生图模型名）：input list → <datalist>；保存逻辑与普通 str 一致
				if (c.type === 'str' && Array.isArray(c.suggestions) && c.suggestions.length) {
					const initStr = String(c.value ?? '')
					const listId = 'qqdl-' + String(c.key).replace(/[^A-Za-z0-9_-]/g, '-')
					return h('span', { key: 'nw', style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, [
						h('input', {
							key: 'v', type: 'text', list: listId,
							style: Object.assign({}, S.input, { width: 200 }), defaultValue: initStr, disabled: busy,
							onBlur: (e) => {
								const raw = String(e.target.value ?? '').trim()
								if (raw === initStr.trim()) return
								run(`${c.label} = ${raw || '(空)'}`, () => call('set', { key: c.key, value: raw }))
							},
						}),
						h('datalist', { key: 'dl', id: listId },
							c.suggestions.map((v) => h('option', { key: String(v), value: String(v) }))),
					])
				}
				if (c.type === 'str' || c.type === 'group') {
					const initStr = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')
					const isSecret = c.secret === true
					return h('input', {
						key: 'v', type: isSecret ? 'password' : 'text', style: Object.assign({}, S.input, { width: 200 }),
						defaultValue: isSecret ? '' : initStr, placeholder: isSecret ? '（已配置则留空 = 不修改）' : '', disabled: busy,
						autoComplete: 'new-password',
						onBlur: (e) => {
							const raw = String(e.target.value ?? '').trim()
							if (isSecret && raw === '') return // 秘密字段留空 = 不改
							if (!isSecret && raw === initStr.trim()) return
							const nextVal = c.type === 'group' ? raw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : raw
							run(isSecret ? `${c.label} 已更新` : `${c.label} = ${raw || '(空)'}`, () => call('set', { key: c.key, value: nextVal }))
						},
					})
				}
				// 多行文本（2026-10-19 入群欢迎文案）：onBlur 保存，字符串原样回传；
				// key 带 c.value → 保存后 schema 回读归一化后的真值，控件重挂显示真值（同数字输入）。
				if (c.type === 'text') {
					const initText = String(c.value ?? '')
					// 提示词类字段：插件通过 helper 现算了一份「内置默认原文」（c.helperDefault），这里给一键恢复。
					// 为什么需要：默认文案升级后，改过的人是「旧副本」、没改过的人「自动跟上」，光看框分不出来 —— 给个明确的回默认。
					const helperDefault = typeof c.helperDefault === 'string' ? c.helperDefault : ''
					const canReset = Boolean(helperDefault) && initText !== helperDefault
					return h('span', { key: 'tw', style: { display: 'block', width: '100%' } }, [
						h('textarea', {
							key: `v:${c.value}`,
							style: Object.assign({}, S.input, {
								width: '100%', minHeight: 84, fontFamily: 'inherit', color: 'inherit', lineHeight: 1.5,
								resize: 'vertical', boxSizing: 'border-box',
							}),
							defaultValue: initText, rows: 4, disabled: busy, spellCheck: false,
							onBlur: (e) => {
								const raw = String(e.target.value ?? '')
								if (raw === initText) return
								run(`${c.label} 已保存`, () => call('set', { key: c.key, value: raw }))
							},
						}),
						canReset ? h('button', {
							key: 'reset', style: Object.assign({}, S.btn, { marginTop: 4, fontSize: 12 }), disabled: busy,
							title: '把这段提示词恢复成插件内置的默认原文（保存后立即生效）',
							onClick: () => run('恢复默认提示词', () => call('set', { key: c.key, value: helperDefault })),
						}, '↺ 恢复默认提示词') : null,
					])
				}
				return h('span', { key: 'nw', style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, [
					h('input', {
						// key 带 c.value：保存成功后 schema 回读新值 → 输入框重挂载，显示的是**归一化后的真值**
						key: `v:${c.value}`, type: 'number', style: S.input, defaultValue: c.value, min: c.min, max: c.max, step: c.step, disabled: busy,
						onBlur: (e) => {
							const raw = String(e.target.value ?? '').trim()
							const v = Number(raw)
							// 前端先拦一道：超出范围 / 非数字 → 直接还原成当前值并说明，不往后端发
							const tooSmall = c.min != null && v < c.min
							const tooBig = c.max != null && v > c.max
							if (raw === '' || !Number.isFinite(v) || tooSmall || tooBig) {
								const range = `${c.min != null ? c.min : '-∞'}~${c.max != null ? c.max : '+∞'}`
								setMsg(`${c.label}：${raw || '(空)'} 不在允许范围 ${range}${c.unit || ''} 内，已还原为 ${c.value}${c.unit || ''}`)
								e.target.value = c.value
								return
							}
							if (v !== c.value) run(`${c.label} = ${v}${c.unit || ''}`, () => call('set', { key: c.key, value: v }))
						},
					}),
					c.unit ? h('span', { key: 'u', style: S.msg }, c.unit) : null,
				])
			}
			return h('div', { style: S.row, key: c.key, title: plainHint }, [
				h('span', { style: S.label, key: 'l' }, [
					c.label,
					c.hint ? h('span', { key: 'i', style: { marginLeft: 6, opacity: .5, cursor: 'help' }, title: plainHint }, 'ⓘ') : null,
				]),
				renderInput(),
			])
		}

		/** 某一组开关（后端 group 相同的一行行开关；群聊 / 回话 / 生图… 各功能页共用） */
		/**
		 * 通用折叠块（2026-11-09）：一个标题按钮 + 点开才渲染的内容。
		 * 用它把「同一类东西」收进一页（入群欢迎 / 看自己 / 记忆高级参数…），页面短、但没丢任何入口。
		 * children 是**函数**：没展开就不执行，避免每次进页都拉接口（图片池那种）。
		 */
		function Fold(props) {
			const { title, api = {}, defaultOpen = false, children, hint = '' } = props
			const { useState } = react
			const [open, setOpen] = useState(!!defaultOpen)
			return h('div', { style: { marginTop: 8 } }, [
				h('div', { style: S.row, key: 'hd' }, [
					h('button', {
						key: 'b', style: Object.assign({}, S.btn, open ? { fontWeight: 600 } : {}), disabled: !!api.busy,
						title: hint || '点开 / 收起',
						onClick: () => setOpen(!open),
					}, (open ? '▾ ' : '▸ ') + title + (open ? '（收起）' : '（展开）')),
				]),
				open ? h('div', { key: 'body' }, typeof children === 'function' ? children() : children) : null,
			])
		}

		function SwitchGroup(props) {
			// sectionExtras：{ 小节名: (api) => 表格/块 }。同一个折叠块里，控件之后**接着**画这段自定义内容
			// （入群欢迎的文案/图片池/测试就是这样接进去的 —— 之前另起一个 Fold，结果页面出现两个同名块）。
			const { schema, group, onlySection = '', skipSections = [], sectionExtras = null, ...api } = props
			const skipSec = new Set([].concat(skipSections || []))
			const list = (schema.controls || []).filter((c) => c.group === group
				&& (!onlySection || c.section === onlySection)
				&& !(c.section && skipSec.has(c.section)))
			if (!list.length) return h('div', { style: S.msg }, `（${group}组暂时没有开关）`)
			// 具名折叠块（c.section）：同一页里再分小节，默认收起 —— 如生图页的「备用接口 1/2」
			const { useState } = react
			const [openSec, setOpenSec] = useState({})
			// 是否把某个 section 单独列到普通项之后（保持后端声明顺序）
			const secOrder = []
			const showSection = (name) => {
				const open = !!openSec[name]
				return h('div', { key: 'sec:' + name }, [
					h('div', { style: S.row, key: 'hd' }, [
						h('button', {
							key: 'b', style: S.btn, disabled: api.busy,
							title: `共 ${list.filter((c) => c.section === name).length} 项 —— 默认收起，点开调整`,
							onClick: () => setOpenSec({ ...openSec, [name]: !open }),
						}, (open ? '▾ ' : '▸ ') + name + (open ? '（收起）' : '（展开）')),
					]),
					open ? h('div', { key: 'body' }, [
						...list.filter((c) => c.section === name).map((c) => ctrlRow(c, api)),
						// 追加内容**必须**走组件（h(WelcomeBody, ...)），不能直接调函数：直接调等于把它当成普通函数执行，
						// 里面的 useState/useEffect 会落到父组件（SwitchGroup）的 hook 顺序里 —— 展开时 hook 数量突变，
						// 整块控制台白屏（2026-11-10 踩过，点「入群欢迎」立刻白）。
						sectionExtras && typeof sectionExtras[name] === 'function' ? sectionExtras[name]() : null,
					]) : null,
				])
			}
			return h('div', null, [
				onlySection ? null : h('div', { style: S.group, key: 'gt' }, group),
				// 无 section 的项照常平铺；section 项收进折叠块（顺序按后端声明）
				list.filter((c) => !c.section).map((c) => ctrlRow(c, api)),
				...list.filter((c) => c.section).map((c) => {
					if (secOrder.includes(c.section)) return null
					secOrder.push(c.section)
					return showSection(c.section)
				}).filter(Boolean),
			])
		}

		// 各功能页顶部的「跨页指路」：只有会让人找不到开关的地方才写一行，别堆说明。
		const GROUP_NOTES = {
			'主动接话': '这里是「没人叫也偶尔接一句」的频率和回话风格；每个群还要在「群聊」页勾「允许主动接话」——两处都开才生效。\n'
				+ '顶部三个档位按钮只是一键填好下面的数字，之后还能随便细调；进阶项收在下面的「高级」按钮里。\n'
				+ '最下面「最近状态」能看到本小时用了几次、上一次模型接没接 —— 调参就看那一行。',
			'其他': '这里是低频 / 高级配置，按来源分组：权限（主人 QQ）、门禁（屏蔽群 / 群内黑名单 / 白名单 / 全局允许用户）、\n'
				+ '文件（入站落盘目录）、发图（可发图片目录白名单）、头像（缓存目录与时长）。\n'
				+ '平时不用动；每一项都有详细悬停解释。门禁类在「群聊」页每张群卡片上也有同样的开关，改哪边都一样。',
		}

		/** 单个功能分组页（消息设置 / 回话 / 生图 / 表情包 / 链接解析…） */
		function GroupTab(props) {
			// skipSections：父组件的 extraHead 已经画过的小节（如运维页的「OneBot 连接」），通用渲染要跳过它。
			const { group, extraHead = null, skipSections = [], ...api } = props
			const skip = new Set([].concat(skipSections || []))
			// 这一组自己的动作按钮（如「空间日记」的立刻回顾 / 重置额度）：长在本页底部，不去「运维」页挤。
			// 2026-11-09 合并后，旧分组名（群聊/入群欢迎/空间日记/看自己）的动作都挂在母页名下：
			// 所以按「后端 actions 里的 group」再到归并表里换算，找属于本页的。
			const MERGED = { 入群欢迎: '群聊', 看自己: '空间日记（看自己）' }
			const acts = (props.schema.actions || []).filter((a) => a.onGroup && (a.group === group || MERGED[a.group] === group))
			// 「要填几个字段再跑」的动作（如生图的 🧪 试优化）：按 action.prompt 描述自动渲染弹窗，不用为此抄一遍 UI
			const { useState } = react
			const [promptBox, setPromptBox] = useState(null)
			const [pv, setPv] = useState({ busy: false, result: null, error: '', values: {} })
			// 打开弹窗：字段初值 → ① valueFrom（取 schema 里某个控件的当前值）② 显式 value ③ 空
			const openPrompt = (a) => {
				const fields = (a.prompt && a.prompt.fields) || []
				const values = {}
				for (const f of fields) {
					const ctrl = f.valueFrom ? (props.schema.controls || []).find((c) => c.key === f.valueFrom) : null
					values[f.name] = String(ctrl && ctrl.value != null ? ctrl.value : (f.value ?? ''))
				}
				setPv({ busy: false, result: null, error: '', values })
				setPromptBox(a)
			}
			const submitPrompt = async (a) => {
				const fields = (a.prompt && a.prompt.fields) || []
				const payload = { id: a.id }
				for (const f of fields) payload[f.name] = String(pv.values[f.name] ?? '')
				const missing = fields.filter((f) => f.required && !String(payload[f.name] || '').trim())
				if (missing.length) { setPv((s) => Object.assign({}, s, { error: `「${missing[0].label}」不能空` })); return }
				setPv((s) => Object.assign({}, s, { busy: true, error: '', result: null }))
				try {
					const r = await api.call('action', payload)
					if (!r || typeof r !== 'object') throw new Error('后端没有返回结果')
					if (r.ok === false) throw new Error(r.error || '没成功')
					setPv((s) => Object.assign({}, s, { result: r }))
				} catch (e) {
					setPv((s) => Object.assign({}, s, { error: e.message }))
				} finally {
					setPv((s) => Object.assign({}, s, { busy: false }))
				}
			}
			const dialog = promptBox ? h('div', {
				key: 'pb', style: {
					position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
					display: 'flex', alignItems: 'center', justifyContent: 'center',
				},
				onClick: () => { if (!pv.busy) setPromptBox(null) },
			}, [
				h('div', {
					key: 'box', style: {
						background: '#fff', color: '#111', borderRadius: 12, padding: '16px 18px',
						maxWidth: 760, width: '100%', maxHeight: '88vh', overflow: 'auto',
						boxShadow: '0 12px 40px rgba(0,0,0,.35)', border: '1px solid #d0d5dd', boxSizing: 'border-box',
					},
					onClick: (e) => e.stopPropagation(),
				}, [
					h('div', { key: 't', style: { fontWeight: 700, marginBottom: 4, fontSize: 15 } }, (promptBox.prompt && promptBox.prompt.title) || promptBox.label),
					h('div', { key: 'h', style: { fontSize: 12, opacity: .7, marginBottom: 10, lineHeight: 1.5 } },
						'只跑一次很短的模型调用：不画图、不占生图冷却、不花钱出图。改完再点一次就能对比效果。'),
					...((promptBox.prompt && promptBox.prompt.fields) || []).map((f) => h('div', { key: 'f-' + f.name, style: { marginBottom: 10 } }, [
						h('div', { key: 'l', style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, f.label || f.name),
						h('textarea', {
							key: 'v', rows: f.rows || 4, spellCheck: false, disabled: pv.busy,
							value: String(pv.values[f.name] ?? ''),
							onChange: (e) => { const v = e.target.value; setPv((s) => Object.assign({}, s, { values: Object.assign({}, s.values, { [f.name]: v }) })) },
							style: Object.assign({}, S.area, { minHeight: f.rows ? f.rows * 22 : 88, width: '100%', fontSize: 12.5, lineHeight: 1.6, padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd', boxSizing: 'border-box', resize: 'vertical' }),
						}),
						f.hint ? h('div', { key: 'hint', style: { fontSize: 12, opacity: .65, marginTop: 3, lineHeight: 1.5 } }, f.hint) : null,
					])),
					pv.result ? h('div', { key: 'res', style: { marginTop: 4, marginBottom: 8 } }, [
						h('div', { key: 'l', style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } },
							'优化后的提示词' + (pv.result.route ? `（${pv.result.route}${pv.result.ms ? '，' + pv.result.ms + 'ms' : ''}）` : '')),
						h('div', { key: 'o', style: { fontSize: 12, opacity: .65, marginBottom: 4, lineHeight: 1.5, wordBreak: 'break-all' } }, '原话：' + String(pv.result.original || '')),
						h('textarea', {
							key: 'pv', readOnly: true, value: String(pv.result.prompt || ''), spellCheck: false, style: { width: '100%', minHeight: 110, fontSize: 12.5, lineHeight: 1.6, padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd', boxSizing: 'border-box' },
						}),
						h('div', { key: 'n', style: { fontSize: 12, opacity: .65, marginTop: 4, lineHeight: 1.5 } },
							'这就是聊天里生图时会真正发给生图模型的提示词（同一份规则）。'),
					]) : null,
					pv.error ? h('div', { key: 'err', style: { color: '#b3261e', fontSize: 13, marginBottom: 8, whiteSpace: 'pre-wrap' } }, pv.error) : null,
					h('div', { key: 'b', style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' } }, [
						h('button', { key: 'c', style: S.btn, disabled: pv.busy, onClick: () => setPromptBox(null) }, '关闭'),
						h('button', {
							key: 'ok', style: Object.assign({}, S.btn, { fontWeight: 600 }), disabled: pv.busy,
							onClick: () => submitPrompt(promptBox),
						}, pv.busy ? '优化中…' : ((promptBox.prompt && promptBox.prompt.okLabel) || '跑一次')),
					]),
				]),
			]) : null
			return h('div', null, [
				GROUP_NOTES[group] ? h('div', { key: 'note', style: S.msg }, GROUP_NOTES[group]) : null,
				extraHead,
				// 「群聊」页：群卡片（自定义交互）放在控件前面；「空间日记（看自己）」页：看自己那块放最后
				group === '群聊' ? h(GroupCardsBody, { key: 'cards', ...api, group }) : null,
				h(SwitchGroup, Object.assign({}, api, {
					key: 'sw', group, skipSections,
					...(group === '群聊'
						? { sectionExtras: { 入群欢迎: () => h(WelcomeBody, Object.assign({}, api, { key: 'wl' })) } }
						: {}),
				})),
				acts.length ? h('div', { key: 'acts' }, [
					h('div', { style: S.group, key: 'gt' }, '操作'),
					...acts.map((a) => h('div', { style: S.row, key: a.id }, [
						h('button', {
							style: S.btn, disabled: api.busy, title: a.hint || '',
							onClick: () => {
								const { run, call, setBusy, setMsg, setConfirmBox } = api
								if (a.confirm) {
									setBusy(true); setMsg('')
									const params = Object.assign({ id: a.id }, a.params || {})
									call('action', params).then((p) => {
										if (p && p.ok === false) throw new Error(p.error || p.message || '操作失败')
										setConfirmBox({
											title: (a.confirm && a.confirm.title) || `⚠️ 确认执行「${a.label}」？`,
											lines: (p.previewLines && p.previewLines.length) ? p.previewLines : [p.message || '（预演没有输出）'],
											okLabel: (a.confirm && a.confirm.okLabel) || '确认执行',
											onOk: () => run(a.label, () => call('action', Object.assign({}, params, { confirm: true }))),
										})
									}).catch((e) => setMsg(`${a.label} ✗ ${e.message}`)).finally(() => setBusy(false))
									return
								}
								// 要填字段的动作（如「🧪 试优化一条提示词」）：先开弹窗填，不直接跑
								// 要填字段的动作只在它自己的配置页（GroupTab 的弹窗）里跑；这两页遇到就提示一句，不静默无反应
								if (a.prompt) { setMsg('「' + a.label + '」要点开它自己的配置页，在那一页底部操作'); return }
								run(a.label, () => call('action', { id: a.id }))
							},
						}, a.label),
					])),
				]) : null,
				// 入群欢迎（2026-11-09 并进群聊页）：文案/图片池/测试接在「入群欢迎」小节下面（见上面 sectionExtras），
				// 不再另起一个折叠块 —— 否则页面上会出现两个「入群欢迎」。
				// 看自己（并进空间日记页）：两个只读工具（browse_groups / self_log）没有控件，只有说明，
				// 所以这里写清楚「它是干什么的、怎么让它用」，而不是摆一个空折叠块。
				// 看自己（并进空间日记页）：只有 4 个配置项，父页的 SwitchGroup 已经把它当「看自己」小节渲染了，
				// 这里不再重复一块，只补一句「这两个工具是干什么的」，免得用户以为这页只有开关。
				group === '空间日记（看自己）' ? h('div', { key: 'sv', style: Object.assign({}, S.msg, { marginTop: 6 }) },
					'※「看自己」那两个工具是只读的：翻群摘要（browse_groups）看最近几小时群里聊什么、流水账（self_log）看它今天做过什么；'
					+ '它们不读原文、不发消息，上面三个数字就是它们的上限。') : null,
				dialog,
			])
		}

		// 新手向导里可一键处理的两项（其余项只显示 hint；人设安装时已自动投递）
		const WIZARD_ACTIONS = {
			onebot: { id: 'onebot-check', label: '测试连接' },
			imagegen: { id: 'imagegen-check', label: '检查生图' },
		}

		// ═══════════ 标签页①：运维（健康 / 新手向导 / 人设 / 动作按钮）═══════════
		// 2026-10-18：原「运维」页并入总览（主人要求）—— 动作按钮与可选模块排在总览最下面。
		function TabOverview(props) {
			const { schema, status, busy, run, call, setBusy, setMsg, setConfirmBox, setReportBox } = props
			const health = status.health || {}
			const svc = status.services || {}
			const persona = status.persona || { personas: [] }
			const lp = status.linesPool || {}
			const lpN = (x) => (typeof x === 'number' ? x : '?')
			const meta = status.meta || null
			const onboarding = Array.isArray(status.onboarding) ? status.onboarding : []
			const fmtCheck = (ts) => { try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '' } }
			return h('div', null, [
				// ═══ 待配置模式提示条（首次安装还没填主人 QQ / 协议端时最醒目）═══
				(meta && meta.configReady === false)
					? h('div', {
						key: 'needcfg',
						style: { padding: '8px 10px', borderRadius: 8, background: '#fef3c7', color: '#92400e', fontSize: 13, marginBottom: 8, lineHeight: 1.5 },
					}, '⚠️ 还没完成必填配置（主人 QQ / OneBot 协议端），按下面清单填完即可')
					: null,

				// ═══ QQ 掉线提醒：OneBot WS 还连着，但 QQ 服务端往返探测失败（get_stranger_info）═══
				(health.onebotLinked && health.qqLoggedIn === false)
					? h('div', {
						key: 'qqoffline',
						style: { padding: '8px 10px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13, marginBottom: 8, lineHeight: 1.5 },
					}, '🔴 QQ 账号已掉线（OneBot 连接还在）：机器人现在收发不到消息。请打开协议端自带 WebUI 重新登录（端口见各实现文档，本机在用的 SnowLuma 默认 :5099）；'
						+ (health.qqLoginError ? `原因：${health.qqLoginError}` : '登录后本页约 5 秒自动恢复。') + ' 也可点「检查 QQ 登录」立即重试。')
					: null,

				h('div', { style: S.row, key: 'hc' }, [
					h('span', { style: S.badge(health.dshLinked), key: 'd' }, `DSH ${health.dshLinked ? '已连' : '断开'}`),
					h('span', { style: S.badge(health.onebotLinked && !health.onebotStale), key: 'n' }, `OneBot ${health.onebotLinked && !health.onebotStale ? '在线' : '异常'}`),
					h('span', {
						style: S.badge(health.qqLoggedIn === true), key: 'q',
						title: health.qqLoginError || '',
					}, health.onebotLinked
						? (health.qqLoggedIn === true ? 'QQ 已登录' : (health.qqLoggedIn === false ? 'QQ 未登录' : 'QQ 检查中'))
						: 'QQ 未知'),
					h('button', {
						key: 'ql', style: S.btn, disabled: busy,
						title: '主动调用 get_stranger_info 验证 QQ 是否真的在线（协议端缓存的登录信息可能过期）',
						onClick: () => run('检查 QQ 登录', () => call('action', { id: 'onebot-check' })),
					}, '检查 QQ 登录'),
					health.qqLoginCheckedAt
						? h('span', { key: 'qt', style: { opacity: .6, fontSize: 12 } }, `最近检查 ${fmtCheck(health.qqLoginCheckedAt)}`)
						: null,
					h('span', { key: 'l' }, `QQ 线 ${status.lines ? status.lines.mapped : '?'} 条`),
					h('span', { key: 's' }, Object.keys(svc).map((k) => `${k}:${svc[k] === 'active' ? '✓' : '✗'}`).join('  ')),
				]),

				// ═══ 新手向导：逐项 ✅/❌ + 一句怎么做 + 可操作项的小按钮 ═══
				onboarding.length ? h('div', { key: 'wizard' }, [
					h('div', { style: S.group, key: 't' }, '新手向导（按顺序做完下面几项就能用）'),
					...onboarding.map((it) => h('div', { style: S.row, key: it.id }, [
						h('span', { style: S.badge(!!it.ok), key: 'b' }, it.ok ? '✅' : '❌'),
						h('span', { style: Object.assign({}, S.label, { fontWeight: it.ok ? 400 : 600 }), key: 'l' },
							`${it.label || it.id}${it.required === false ? '（可选）' : ''}`),
						h('span', { style: Object.assign({}, S.msg, { flex: '0 0 auto', opacity: .7 }), key: 'h' }, it.hint || ''),
						(WIZARD_ACTIONS[it.id] && !it.ok)
							? h('button', {
								key: 'a', style: S.btn, disabled: busy, title: it.hint || '',
								onClick: () => run(WIZARD_ACTIONS[it.id].label, () => call('action', { id: WIZARD_ACTIONS[it.id].id })),
							}, WIZARD_ACTIONS[it.id].label)
							: null,
					])),
				]) : null,

				// ═══ 版本 / 数据目录 / 配置文件（小字，排查时一眼看到）═══
				meta ? h('div', {
					key: 'meta',
					style: { fontSize: 12, opacity: .55, marginTop: 4, marginBottom: 8, wordBreak: 'break-all' },
				}, `v${meta.version || '?'} · 数据目录 ${meta.dataDir || '?'} · 配置 ${meta.configPath || '?'}`) : null,

				// ═══ 人设（2026-10-06 主人要"控制台快捷切换"）：点一下就切，下一条消息生效 ═══
				h('div', { key: 'persona' }, [
					h('div', { style: S.group, key: 'pt' }, '人设（QQ 线用哪套；人设 + 句池一起换，不用重置）'),
					h('div', { style: S.row, key: 'pr' }, [
						h('span', { key: 'l', style: S.flabel, title: '当前生效 = qq-lines/AGENTS.local.md 指向的那份（软链或复制投递）' }, '当前人设'),
						h('span', { style: S.badge(!!persona.current), key: 'cur' }, persona.current || '（没挂）'),
						...(persona.personas || []).map((p) => h('span', {
							key: 'p' + p.name,
							style: p.name === persona.current ? Object.assign({}, S.chip, { fontWeight: 700, outline: '1px solid currentColor' }) : S.chip,
							title: `${(p.bytes / 1024).toFixed(1)} KB`
								+ (p.hasLines ? ' ｜ 自带句池 .lines.txt' : (p.hasPoke ? ' ｜ 老格式句池 .poke.txt' : ' ｜ 无句池（继承底池）')),
							onClick: () => { if (!busy && p.name !== persona.current) run(`切人设 → ${p.name}`, () => call('persona', { op: 'switch', name: p.name })) },
						}, p.name)),
					]),
					h('div', { style: S.msg, key: 'ph' },
						`句池生效：poke ${lpN((lp.effective || {}).poke)} ｜ 答应 ${lpN((lp.effective || {}).callAck)} ｜ 图 ${lpN((lp.effective || {}).imageAck)}+${lpN((lp.effective || {}).imageBusy)}+${lpN((lp.effective || {}).imageFail)}`
						+ `（人设池 ${Object.values(lp.persona || {}).reduce((a, b) => a + b, 0)} 句 → 缺的节继承底池）｜ 切完**下一条消息生效**，不用重置、不丢上下文`),
				]),

				// ═══ 跟随「人设」显示的分组（当前为空；句池/唤醒 已各自成页）═══
				...((schema.personaGroups || []).map((g) => (
					(schema.controls || []).some((c) => c.group === g)
						? h(SwitchGroup, Object.assign({}, props, { key: 'pg' + g, group: g }))
						: null
				))),
			])
		}

		// ═══════════ 标签页②：运维（动作按钮 + 子插件开关；2026-10-20 从「总览」拆出）═══════════
		// 「运维」页的动作按钮块（父页要排除某个小节时传 props.section）
		function OpsTab(props) {
			const { schema, busy, run, call, setBusy, setMsg, setConfirmBox, setReportBox, section = '' } = props
			return h('div', null, [
				// ═══ 运维动作：危险动作走二级确认 ═══
				h('div', { key: 'act' }, [
					h('div', { style: S.group, key: 'gt' }, '运维 / 危险操作'),
					(schema.actions || []).filter((a) => !a.onGroup).map((a) => h('div', { style: S.row, key: a.id }, [
						h('button', {
							style: S.btn, disabled: busy, title: a.hint || '',
							onClick: () => {
								// 一键诊断：结果不是普通 message，而是整份报告（弹窗展示 + 复制/落盘路径）
								if (a.id === 'diagnose') {
									setBusy(true); setMsg('')
									call('action', { id: 'diagnose' }).then((res) => {
										if (res && res.ok === false) throw new Error(res.error || '诊断失败')
										setReportBox(res || {})
										setMsg(res && res.reportPath
											? `诊断完成，报告已保存到：${res.reportPath}`
											: '诊断完成（报告落盘失败，可复制弹窗内容）')
									}).catch((e) => setMsg(`诊断 ✗ ${e.message}`))
										.finally(() => setBusy(false))
									return
								}
								// 需确认的动作（注册表里带 confirm，2026-10-09 泛化）：
								// ① 先跑一次**预演**（后端不删任何东西）→ ② 弹窗给你看影响面 → ③ 点确认才带 confirm:true 真执行。
								// 「清空对话 / 清理临时文件 / 备份去重」都走这条同一段逻辑。
								if (a.confirm) {
									setBusy(true); setMsg('')
									call('action', { id: a.id }).then((p) => {
										if (p && p.ok === false) throw new Error(p.error || p.message || '操作失败')
										setConfirmBox({
											title: (a.confirm && a.confirm.title) || `⚠️ 确认执行「${a.label}」？`,
											lines: (p.previewLines && p.previewLines.length) ? p.previewLines : [p.message || '（预演没有输出）'],
											okLabel: (a.confirm && a.confirm.okLabel) || '确认执行',
											onOk: () => run(a.label, () => call('action', { id: a.id, confirm: true })),
										})
									}).catch((e) => setMsg(`${a.label} ✗ ${e.message}`))
										.finally(() => setBusy(false))
									return
								}
								// 要填字段的动作只在它自己的配置页（GroupTab 的弹窗）里跑；这两页遇到就提示一句，不静默无反应
								if (a.prompt) { setMsg('「' + a.label + '」要点开它自己的配置页，在那一页底部操作'); return }
								run(a.label, () => call('action', { id: a.id }))
							},
						}, a.label),
					])),
					// 2026-11-09：这里的「子插件开关」删掉了 —— 和「子插件」页重复，两处同源，留一处就够。
					// 连接状态 + 测试按钮由父页（GroupTab 的 extraHead）渲染；连接配置在「OneBot 连接」小节里。
				]),
			])
		}

		// ═══════════ 标签页②：OneBot 连接（状态 + 连接测试 + 连接配置；登录/扫码交给协议端自带 WebUI）═══════════
		// 状态与总览**同一来源**（ConsoleShell 的 status，5 秒轮询）。
		function OneBotStatus(props) {
			const { call, refresh, status, busy, section = '', sectionTitle = '' } = props
			const { useState } = react
			const [note, setNote] = useState('')
			const [busyLocal, setBusyLocal] = useState(false)
			const health = (status && status.health) || {}
			const nap = (status && status.onebot) || {}
			const linked = Boolean(health.onebotLinked)
			const selfId = nap.selfId || health.selfId || ''
			const nick = health.selfNickname || ''
			const qqLoggedIn = nap.qqLoggedIn ?? health.qqLoggedIn ?? null
			const online = linked && qqLoggedIn === true
			const loginUnknown = linked && qqLoggedIn == null
			const loginErr = nap.qqLoginError || health.qqLoginError || ''

			const test = async () => {
				setBusyLocal(true); setNote('')
				try {
					const r = await call('action', { id: 'onebot-check' })
					setNote((r && (r.message || r.error)) || '测试完成')
					await refresh()
				} catch (e) {
					setNote('测试失败：' + e.message)
				} finally { setBusyLocal(false) }
			}

			// 只渲染「运维动作按钮 + 连接状态 + 提示 + 测试按钮」：连接配置的控件由父页的「OneBot 连接」小节渲染。
			// 有 section 时先画小节标题（父页的通用渲染会跳过同名小节，避免重复）。
			return h('div', null, [
				h(OpsTab, Object.assign({}, props, { key: 'ops' })),
				section ? h('div', { style: S.group, key: 'sec' }, sectionTitle || section) : null,
				h('div', { style: S.row, key: 'hd' }, [
					h('span', { style: S.badge(linked), key: 'br' }, `内核 ${linked ? '已连接' : '断开'}`),
					h('span', { style: S.badge(online), key: 'qq', title: loginErr || '' }, !linked
						? 'QQ 未知（OneBot 未连接）'
						: online
							? `QQ 已登录${selfId ? `：${nick || selfId}${nick ? `（${selfId}）` : ''}` : ''}`
							: (loginUnknown ? 'QQ 检查中' : 'QQ 未登录/已掉线')),
					h('button', { key: 't', style: S.btn, disabled: busy || busyLocal, onClick: test, title: '测试内核到 OneBot 协议端的连接，并主动 get_login_info 检查 QQ 是否在线' }, '🔌 测试连接 / 检查登录'),
				]),
				h('div', { key: 'hint', style: S.msg }, !linked
					? 'OneBot 连接未建立：先检查协议端是否启动、地址/token 是否正确。'
					: online
						? 'QQ 已登录，机器人可以收发消息。状态与总览页同一来源，约 5 秒自动刷新。'
						: loginUnknown
							? '正在检查 QQ 登录状态…（每 30 秒自动检查一次，也可点上面按钮立即检查）'
							: `QQ 未登录/已掉线${loginErr ? `：${loginErr}` : ''}。请用协议端自带的 WebUI 扫码 / 密码登录（端口见各实现文档，本机在用的 SnowLuma 默认 http://127.0.0.1:5099）；登录后本页与总览会自动更新。`),
				note ? h('div', { key: 'note', style: S.msg }, note) : null,
			])
		}

		// ═══════════ 「群聊」页的群卡片块（屏蔽 / 白名单 / 黑名单 / 主动接话 / 入群欢迎）═══════════
		// 2026-11-09 从原 TabGroups 里拆出来：它现在是「群聊」页 GroupTab 里的一个块，
		// 而不是一整页——页面容器、页签、说明都由父页管。
		function GroupCardsBody(props) {
			const { status, busy, run, call } = props
			const { useState } = react
			const [gid, setGid] = useState('')
			const [qqIn, setQqIn] = useState({})   // 每群的“加白名单”输入框
			const [blIn, setBlIn] = useState({})   // 每群的“加黑名单”输入框（2026-10-07）
			const g = status.groups || {}
			// 欢迎群 = *（所有未被屏蔽群）时，逐群勾选没有意义 → 禁用并指路去「入群欢迎」页
			const welcomeAll = (((status.welcome || {}).groups) || []).includes('*')

			// 群清单：后端 status.groupList 为准；老后端没这字段时用旧字段拼一个
			const gl = (status.groupList && status.groupList.length) ? status.groupList : (() => {
				const ig = (g.ignore || []).map(String)
				const lineIds = ((status.lines && status.lines.group) || []).map((k) => String(k).replace(/^group:/, ''))
				const ids = [...new Set([...ig, ...Object.keys(g.allowlist || {}), ...Object.keys(g.blocklist || {}), ...Object.keys(g.keywords || {}), ...lineIds])].filter((x) => x !== '*')
				return ids.map((id) => ({
					id, ignored: ig.includes(id), runtimeIgnored: false, welcome: false,
					allowlist: ((g.allowlist || {})[id] || []).map(String),
					blocklist: ((g.blocklist || {})[id] || []).map(String),
					keywords: (g.keywords || {})[id] || [],
					hasLine: lineIds.includes(id),
				}))
			})()

			return h('div', null, [
				// ═══ 群聊管理：每群一张卡片（屏蔽 / 白名单 / 黑名单 / 允许主动接话）═══
				h('div', { key: 'gmanage' }, [
					h('div', { style: S.group, key: 'gt' }, '群聊管理（屏蔽 / 白名单 / 黑名单 / 主动接话每群独立；免@唤醒词全局生效）'),
					h('div', { style: S.row, key: 'add' }, [
						h('input', { style: S.input, placeholder: '群号', value: gid, onChange: (e) => setGid(e.target.value) }),
						h('button', { style: S.btn, disabled: busy, onClick: () => gid && run(`纳入管理 ${gid}`, () => call('group', { kind: 'allowlist', op: 'ensure', group_id: gid })), title: '把这个群纳入管理：加进白名单后「群聊」页会出现它的卡片，方便逐群设置' }, '纳入管理'),
						h('button', { style: S.btn, disabled: busy, onClick: () => gid && run(`屏蔽 ${gid}`, () => call('group', { kind: 'ignore', op: 'add', group_id: gid })), title: '整群屏蔽：@ 和唤醒词都不理（在卡片里取消屏蔽即可恢复）' }, '直接屏蔽'),
					]),
					h('div', { style: S.msg, key: 'hint' }, '说明：屏蔽 = 该群 @ 和关键词都不理；白名单留空 = 群里谁叫都理，填了人 = 只有名单里的人叫得动；**黑名单 = 这些人发的消息机器人不回、也不进留档（优先于白名单）**；免@唤醒词是**全局**的，所有群共用一份（在「人设与语气 → 唤醒」里改）。'),
					gl.length === 0
						? h('div', { style: S.msg, key: 'none' }, '（还没有纳入管理的群）')
						: gl.map((grp) => h('div', {
							key: `g${grp.id}`,
							style: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, padding: '8px 10px', marginBottom: 8, opacity: grp.ignored ? .6 : 1 },
						}, [
							// 标题行：只有群名 + 状态徽章（按钮不再放这行，位置就不会随群名长短漂移）
							h('div', { style: S.cardHd, key: 'hd' }, [
								h('span', { key: 'id', style: { fontWeight: 600 } }, grp.name ? `群 ${grp.name}（${grp.id}）` : `群 ${grp.id}`),
								h('span', { key: 'ln', style: S.badge(!!grp.hasLine) }, grp.hasLine ? '已接入' : '无会话'),
								grp.ignored ? h('span', { key: 'ig', style: S.badge(false) }, '已屏蔽') : null,
								grp.runtimeIgnored ? h('span', { key: 'rt', style: S.badge(false), title: '运行时屏蔽（只在内核内存里，不写配置）' }, '运行时屏蔽') : null,
							]),
							// 操作行：恒定一行、右对齐；勾选框与文字包在同一个 <label> 里 —— 换行也拆不开，点文字也能勾
							h('div', { style: S.cardCtl, key: 'ctl' }, [
								h('button', {
									key: 'rst', style: grp.hasLine ? S.btn : Object.assign({}, S.btn, S.btnOff), disabled: busy || !grp.hasLine,
									title: grp.hasLine ? '重置本群对话：清掉该群的会话映射并把旧会话归档（下一条消息开新会话）' : '该群当前没有会话记录（暂不可用）',
									onClick: () => run(`重置本群 ${grp.id}`, () => call('action', { id: 'reset-session', chat: 'group:' + grp.id })),
								}, '🧹 重置本群对话'),
								h('label', {
									key: 'tg', style: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', cursor: busy ? 'default' : 'pointer' },
								}, [
									h('input', {
										key: 'c', type: 'checkbox', checked: !!grp.ignored, disabled: busy, style: { margin: 0 },
										onChange: () => run(`${grp.ignored ? '放行' : '屏蔽'} ${grp.id}`, () => call('group', { kind: 'ignore', op: grp.ignored ? 'remove' : 'add', group_id: grp.id })),
									}),
									h('span', { key: 't' }, '屏蔽本群'),
								]),
								h('label', {
									key: 'sp', style: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', cursor: busy ? 'default' : 'pointer' },
									title: '开了以后：群里没人叫它，它也可能偶尔接一句（频率 / 冷场 / 风格在「主动接话」页调）',
								}, [
									h('input', {
										key: 'c', type: 'checkbox', checked: !!grp.spont, disabled: busy, style: { margin: 0 },
										onChange: () => run(`${grp.spont ? '关掉' : '打开'} ${grp.id} 的主动接话`, () => call('group', { kind: 'spont', op: grp.spont ? 'remove' : 'add', group_id: grp.id })),
									}),
									h('span', { key: 't' }, '允许主动接话'),
								]),
								// 入群欢迎（2026-10-19）：群范围在这里勾；文案/图片/测试在「入群欢迎」页
								h('label', {
									key: 'wc', style: { display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', cursor: busy ? 'default' : 'pointer' },
									title: '开了以后：这个群有人入群时自动发欢迎（文案 / 图片 / 测试在「入群欢迎」页）',
								}, [
									h('input', {
										key: 'c', type: 'checkbox', checked: welcomeAll ? true : !!grp.welcome, disabled: busy || welcomeAll, style: { margin: 0 },
										title: welcomeAll ? '当前欢迎群 = *（所有未被屏蔽群）：要逐群开关，先去「入群欢迎」页把群列表里的 * 去掉' : '',
										onChange: () => run(`${grp.welcome ? '关掉' : '打开'} ${grp.id} 的入群欢迎`, () => call('group', { kind: 'welcome', op: grp.welcome ? 'remove' : 'add', group_id: grp.id })),
									}),
									h('span', { key: 't' }, '允许入群欢迎'),
								]),
							]),
							h('div', { style: S.row, key: 'al' }, [
								h('span', { key: 'l', style: S.flabel, title: '留空＝群里谁叫都理；填了人＝只有名单里的人叫得动' }, grp.allowlist.length ? '白名单（只有他们能叫）' : '白名单（空＝谁都能叫）'),
								...grp.allowlist.map((qq) => h('span', { style: S.chip, key: 'qq' + qq }, [
									qq,
									h('span', { key: 'x', style: { cursor: 'pointer' }, onClick: () => !busy && run(`移出白名单 ${qq}`, () => call('group', { kind: 'allowlist', op: 'remove', group_id: grp.id, value: qq })) }, '×'),
								])),
								h('input', { style: S.input, placeholder: 'QQ 号', value: qqIn[grp.id] || '', onChange: (e) => setQqIn(Object.assign({}, qqIn, { [grp.id]: e.target.value })) }),
								h('button', { style: S.btn, disabled: busy, onClick: () => qqIn[grp.id] && run(`加白名单 ${qqIn[grp.id]}`, () => call('group', { kind: 'allowlist', op: 'add', group_id: grp.id, value: qqIn[grp.id] })), title: '加白名单：只有名单里的人叫它才理（留空 = 谁叫都理）' }, '加'),
							]),
							// 黑名单（2026-10-07 主人定）：这些人发的消息**不回、不入站**，且优先于白名单
							h('div', { style: S.row, key: 'bl' }, [
								h('span', { key: 'l', style: S.flabel, title: '这些人发的消息机器人不回、也不进留档（优先于白名单）' }, (grp.blocklist || []).length ? `黑名单（${(grp.blocklist || []).length} 人：不回不入站）` : '黑名单（空＝没人被屏蔽）'),
								...((grp.blocklist || []).map((qq) => h('span', { style: S.chip, key: 'bqq' + qq }, [
									qq,
									h('span', { key: 'x', style: { cursor: 'pointer' }, onClick: () => !busy && run(`移出黑名单 ${qq}`, () => call('group', { kind: 'blocklist', op: 'remove', group_id: grp.id, value: qq })) }, '×'),
								]))),
								h('input', { style: S.input, placeholder: 'QQ 号', value: blIn[grp.id] || '', onChange: (e) => setBlIn(Object.assign({}, blIn, { [grp.id]: e.target.value })) }),
								h('button', { style: S.btn, disabled: busy, onClick: () => blIn[grp.id] && run(`加黑名单 ${blIn[grp.id]}`, () => call('group', { kind: 'blocklist', op: 'add', group_id: grp.id, value: blIn[grp.id] })), title: '加黑名单：名单里的人发消息不回、也不进留档（优先于白名单）' }, '加'),
							]),
						])),
				]),
			])
		}

		// ═══════════ 标签页：入群欢迎（图片池 / 测试 / 状态；每群开关在「群聊」页）═══════════
		// 开关文案来自 schema 的 group==='入群欢迎'（后端 CONTROLS 里加就自动多出这一页）；
		// 图片池 + 测试走 RPC 端点 action 的 welcome-images / welcome-test 两个动作。
		// 字段全用可选链兜底：后端还没上线时这页照样能渲染，只是读不到数据。
		function WelcomeBody(props) {
			const { schema, status, busy, run, call, setBusy, setMsg, setConfirmBox } = props
			const { useState, useEffect, useCallback, useRef } = react
			const w = (status && status.welcome) || {}
			const [pool, setPool] = useState(null)     // {ok,dir,exists,count,images:[{name,size,mtime}]}
			const [note, setNote] = useState('')       // 读图片池失败时的提示
			const [gid, setGid] = useState('')         // 测试目标群
			const [busyPool, setBusyPool] = useState(false)
			const alive = useRef(true)

			const loadPool = useCallback(async () => {
				setBusyPool(true); setNote('')
				try {
					const r = await call('action', { id: 'welcome-images' })
					if (r && r.ok === false) throw new Error(r.error || r.message || '读取失败')
					if (alive.current) setPool(r || {})
				} catch (e) {
					if (alive.current) setNote(`读取图片池失败：${e.message}`)
				} finally { if (alive.current) setBusyPool(false) }
			}, [call])

			useEffect(() => {
				alive.current = true
				loadPool()
				return () => { alive.current = false }
			}, [loadPool])

			// 测试：先预演拿 previewLines → 二次确认 → 带 confirm:true 真发（跟运维危险动作同一套）
			const doTest = () => {
				if (!gid) return
				setBusy(true); setMsg('')
				call('action', { id: 'welcome-test', group_id: gid }).then((p) => {
					if (p && p.ok === false) throw new Error(p.error || p.message || '预演失败')
					setConfirmBox({
						title: '⚠️ 确认发送测试欢迎？',
						lines: (p && p.previewLines && p.previewLines.length)
							? p.previewLines
							: [ (p && p.message) || '（预演没有输出）' ],
						okLabel: '确认发送',
						onOk: () => run('测试入群欢迎', () => call('action', { id: 'welcome-test', group_id: gid, confirm: true })),
					})
				}).catch((e) => setMsg(`测试入群欢迎 ✗ ${e.message}`))
					.finally(() => setBusy(false))
			}

			const gl = Array.isArray(status && status.groupList) ? status.groupList : []
			const wGroups = Array.isArray(w.groups) ? w.groups.map(String) : []
			const nameOf = (id) => {
				const hit = gl.find((g) => String(g.id) === id)
				return hit && hit.name ? hit.name : id
			}
			const dirText = (pool && pool.dir) || w.imageDir || '（未知目录）'
			const fmtSize = (n) => (typeof n === 'number' && Number.isFinite(n))
				? (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB')
				: '?'
			const images = Array.isArray(pool && pool.images) ? pool.images : []
			const exists = pool ? (pool.exists !== false) : true
			const modeText = w.mode === 'model' ? '模型生成' : (w.mode === 'fixed' ? '固定文案' : (w.mode || '?'))

			return h('div', null, [
				h('div', { style: S.msg, key: 'note' },
					'有人入群时自动发一条欢迎（看图池里随机挑一张图一起发）。'
					+ '哪个群生效在「群聊」页每张群卡片勾「允许入群欢迎」；整群屏蔽沿用「屏蔽本群」。'),
				h(SwitchGroup, Object.assign({}, props, { key: 'sw', group: '入群欢迎' })),

				// ═══ 状态行（只读）：总开关 / 模式 / 开了几个群 / 后端提示 ═══
				h('div', { style: S.row, key: 'st' }, [
					h('span', { key: 'e', style: S.badge(!!w.enabled) }, `总开关 ${w.enabled ? '开' : '关'}`),
					h('span', { key: 'm' }, `模式：${modeText}`),
					h('span', { key: 'c' }, `已开启的群：${wGroups.length} 个`),
					w.error ? h('span', { key: 'err', style: { color: '#b3261e', fontSize: 12 } }, `后端提示：${w.error}`) : null,
				]),
				wGroups.length
					? h('div', { style: S.row, key: 'wg' }, [
						h('span', { key: 'l', style: S.label }, '已开启入群欢迎的群'),
						...wGroups.map((id) => h('span', { key: 'g' + id, style: S.chip, title: id }, nameOf(id))),
					])
					: null,

				// ═══ 图片池（后端扫 imageDir；不进 schema，只能按需拉）═══
				h('div', { key: 'pool' }, [
					h('div', { style: S.group, key: 't' }, '图片池（欢迎时随机挑一张）'),
					h('div', { style: S.row, key: 'hd' }, [
						h('span', { key: 'n', style: S.label }, pool ? `共 ${pool.count ?? images.length} 张` : (busyPool ? '读取中…' : '（还没读到）')),
						h('span', { key: 'd', style: { fontSize: 12, opacity: .6, wordBreak: 'break-all' } }, `目录 ${dirText}`),
						h('button', { key: 'rf', style: S.btn, disabled: busy || busyPool, onClick: loadPool, title: '重新扫描图片池目录（新放进来的图要刷新才显示）' }, '刷新'),
					]),
					note ? h('div', { key: 'ne', style: S.msg }, note) : null,
					!exists
						? h('div', { key: 'none', style: S.msg }, `目录不存在，把图片放进 ${dirText} 后点「刷新」。`)
						: images.length === 0
							? h('div', { key: 'empty', style: S.msg }, pool ? '目录里还没有图片（放进去后点「刷新」）。' : '')
							: h('div', { key: 'list', style: { marginTop: 4, maxHeight: 220, overflow: 'auto' } }, images.map((img) => h('div', {
								key: 'i' + img.name,
								style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '2px 0' },
								title: img.mtime ? new Date(img.mtime).toLocaleString('zh-CN') : '',
							}, [
								h('span', { key: 'n', style: { flex: '1 1 auto', wordBreak: 'break-all' } }, img.name),
								h('span', { key: 's', style: { opacity: .6, whiteSpace: 'nowrap' } }, fmtSize(img.size)),
							]))),
				]),

				// ═══ 测试（预演 → 二次确认 → 真发）═══
				h('div', { key: 'test' }, [
					h('div', { style: S.group, key: 't' }, '测试（先预演，确认后才真发到群）'),
					h('div', { style: S.row, key: 'ctl' }, [
						h('select', {
							key: 'g', style: Object.assign({}, S.input, { width: 240 }), value: gid,
							disabled: busy || !gl.length, onChange: (e) => setGid(e.target.value),
						}, [
							h('option', { key: 'ph', value: '' }, gl.length ? '选择测试群…' : '（没有可选的群）'),
							...gl.map((g) => h('option', { key: String(g.id), value: String(g.id) }, `${g.name || '未命名'} (${g.id})`)),
						]),
						h('button', { key: 'go', style: S.btn, disabled: busy || !gid, onClick: doTest, title: '在选中的群里发一条测试欢迎（走真实发送链路）' }, '发送测试欢迎'),
					]),
					h('div', { style: S.msg, key: 'hint' }, '预演只把要发的内容算给你看，不会真的发；点确认才发。⚠️ 这个群没勾「允许入群欢迎」时预演会提示（模拟通知会被忽略）。'),
				]),
			])
		}

		// ═══════════ 标签页③：主动接话（没人叫时偶尔接一句 + 回话风格；进阶项折叠）═══════════
		// 给一般用户看的：三档按钮 + 几个概率 + 一行"最近接没接"的状态；语境权重等进阶项收在「高级」按钮里。
		const REPLY_PRESETS = [
			{ id: 'quiet', label: '安静', hint: '每小时最多主动接话 1 次；只在特别值得接的时候开口' },
			{ id: 'semi', label: '适中（推荐）', hint: '每小时最多 3 次；看群里聊得合适才接' },
			{ id: 'active', label: '活泼', hint: '每小时最多 6 次；更容易在普通聊天里接话' },
		]
		function ReplyModeTab(props) {
			const { schema, status, busy, run, call, setBusy, setMsg, setConfirmBox } = props
			const { useState } = react
			const [showAdv, setShowAdv] = useState(false)
			// 「连续对话」这类具名折叠块：每个 section 一个开合状态，默认收起
			const [openSec, setOpenSec] = useState({})
			const all = ((schema && schema.controls) || []).filter((c) => c.group === '主动接话')
			// 三类：普通项 / 具名折叠块（如「连续对话」）/ 高级项
			const sections = []
			const controls = []
			const advanced = []
			for (const c of all) {
				if (c.section) {
					let s = sections.find((x) => x.name === c.section)
					if (!s) { s = { name: c.section, rows: [] }; sections.push(s) }
					s.rows.push(c)
				} else if (c.advanced) advanced.push(c)
				else controls.push(c)
			}
			const reply = (status && status.reply) || null
			const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) } catch { return '?' } }
			const groups = (reply && Array.isArray(reply.groups)) ? reply.groups : []
			return h('div', null, [
				h('div', { style: S.msg, key: 'note' },
					'没人叫它的时候，它也会偶尔自己接一句。先选个档位，下面还能细调；'
					+ '每个群还要在「群聊」页勾「允许主动接话」。'),
				h('div', { style: S.group, key: 'pt' }, '快速档位'),
				h('div', { style: S.row, key: 'presets' }, REPLY_PRESETS.map((m) => h('button', {
					key: m.id, style: S.btn, disabled: busy, title: m.hint,
					onClick: () => run(`主动接话 → ${m.label}`, () => call('action', { id: 'reply-preset', preset: m.id })),
				}, m.label))),
				h('div', { style: S.msg, key: 'ph' },
					reply && reply.enabled
						? `当前：每小时最多 ${reply.hourlyMax} 次 · 实际间隔 ≥ ${Math.round((reply.minGapMs || 0) / 60000)} 分钟 · 语境门槛 ${Math.round((reply.threshold || 0) * 100)} 分`
						: '当前：主动接话关着（上面「允许主动接话」打开即可）'),
				...controls.map((c) => ctrlRow(c, props)),
				// ═══ 具名折叠块（如「连续对话」）：和「高级」一样的按钮，但独立成栏、默认收起 ═══
				...sections.map((sec) => {
					const open = !!openSec[sec.name]
					return h('div', { key: 'sec:' + sec.name }, [
						h('div', { style: S.row, key: 'hd' }, [
							h('button', {
								key: 'b', style: S.btn, disabled: busy,
								title: `共 ${sec.rows.length} 项 —— 默认收起，点开调整`,
								onClick: () => setOpenSec({ ...openSec, [sec.name]: !open }),
							}, (open ? '▾ ' : '▸ ') + sec.name + (open ? '（收起）' : '（展开）')),
						]),
						open ? h('div', { key: 'body' }, sec.rows.map((c) => ctrlRow(c, props))) : null,
					])
				}),
				// ═══ 进阶项：默认收起，点一下展开、再点收起 ═══
				h('div', { style: S.row, key: 'adv' }, [
					h('button', {
						key: 'b', style: S.btn, disabled: busy,
						title: '语境权重、机会窗口、拆条间隔等进阶项 —— 一般不用动',
						onClick: () => setShowAdv(!showAdv),
					}, showAdv ? '▾ 高级（收起）' : '▸ 高级（展开）'),
				]),
				showAdv ? h('div', { key: 'advbox' }, advanced.map((c) => ctrlRow(c, props))) : null,
				// ═══ 本页自己的动作按钮（如「重置私聊接话额度」）：与 GroupTab 底部同款，带二次确认 ═══
				...((schema.actions || []).filter((a) => a.onGroup && a.group === '主动接话')).map((a) =>
					h('div', { style: S.row, key: 'act:' + a.id }, [
						h('button', {
							style: S.btn, disabled: busy, title: a.hint || '',
							onClick: () => {
								if (a.confirm) {
									setBusy(true); setMsg('')
									call('action', { id: a.id }).then((p) => {
										if (p && p.ok === false) throw new Error(p.error || p.message || '操作失败')
										setConfirmBox({
											title: (a.confirm && a.confirm.title) || ('⚠️ 确认执行「' + a.label + '」？'),
											lines: (p.previewLines && p.previewLines.length) ? p.previewLines : [p.message || '（预演没有输出）'],
											okLabel: (a.confirm && a.confirm.okLabel) || '确认执行',
											onOk: () => run(a.label, () => call('action', { id: a.id, confirm: true })),
										})
									}).catch((err) => setMsg(a.label + ' ✗ ' + err.message)).finally(() => setBusy(false))
									return
								}
								// 要填字段的动作只在它自己的配置页（GroupTab 的弹窗）里跑；这两页遇到就提示一句，不静默无反应
								if (a.prompt) { setMsg('「' + a.label + '」要点开它自己的配置页，在那一页底部操作'); return }
								run(a.label, () => call('action', { id: a.id }))
							},
						}, a.label),
					])),
				reply ? h('div', { key: 'st' }, [
					h('div', { style: S.group, key: 'stg' }, '最近状态（调参数时看这里）'),
					groups.length
						? groups.map((g) => h('div', { style: S.row, key: 'sg' + g.groupId }, [
							h('span', { style: S.label, key: 'l' }, `群 ${g.groupId}`),
							h('span', { key: 'v', style: S.msg },
								`本小时 ${g.used}/${g.max} 次`
								+ (g.lastAt
									? ` ｜ 上次 ${fmtTime(g.lastAt)} ${g.lastSent === true ? '已接话' : (g.lastSent === false ? '模型判断没接' : '')}`
									: ' ｜ 还没触发过')),
						]))
						: h('div', { style: S.msg, key: 'empty' }, '还没有允许主动接话的群 —— 去「群聊」页勾一下。'),
					(reply.recent && reply.recent.length)
						? h('div', { style: S.msg, key: 'recent' }, '最近：' + reply.recent
							.map((r) => `${fmtTime(r.at)} 群${r.groupId} ${r.sent ? '已接' : '没接'}${r.reason === 'silence' ? '（冷场找话）' : ''}`)
							.join('；'))
						: null,
				]) : null,
			])
		}

		// ═══════════ 标签页④：子插件（8 个模块化业务子插件管理）═══════════
		function TabPlugins(props) {
			const { schema, busy, run, call } = props
			const list = schema.subPlugins || schema.modules || []
			return h('div', { key: 'subp' }, [
				h('div', { style: S.group, key: 'gt' }, '🧩 架构子插件（按洋葱管线 order 排序，可独立启停与热控）'),
				list.length === 0
					? h('div', { style: S.msg, key: 'empty' }, '（未读取到子插件清单）')
					: list.map((p) => h('div', {
						key: p.id,
						style: { border: '1px solid rgba(127,127,127,.22)', borderRadius: 8, padding: '8px 10px', marginBottom: 8 },
					}, [
						h('div', { style: S.row, key: 'hd' }, [
							h('span', { key: 'ord', style: S.chip }, `order ${p.order || 100}`),
							h('span', { key: 'nm', style: Object.assign({}, S.label, { fontWeight: 600 }) }, `${p.title || p.label} (${p.id})`),
							h('span', { key: 'st', style: S.badge(!!p.on) }, p.on ? '运行中' : '已停用'),
							p.alwaysOn
								? h('span', { key: 'ao', style: { fontSize: 12, opacity: .65 } }, '基础常驻')
								: h('input', {
									key: 'tg', type: 'checkbox', checked: !!p.on, disabled: busy, title: p.desc || p.hint || '',
									onChange: (e) => run(
										`子插件 ${p.id} → ${e.target.checked ? '启用' : '停用'}`,
										() => p.key ? call('set', { key: p.key, value: e.target.checked }) : call('module', { id: p.id, on: e.target.checked }),
									),
								}),
						]),
						p.desc || p.hint ? h('div', { key: 'dc', style: { fontSize: 12, opacity: .75, marginTop: 3 } }, p.desc || p.hint) : null,
					])),
			])
		}

		// 页内标签页：总览 / 子插件 + 后端归并后的每个分组一页（顺序按 schema.groupOrder，「其他」固定排最后）。
		// 合并页里的额外内容（只在这里拼，不动 GroupTab 主体）：
		//   · 运维（OneBot 连接在这个页的「OneBot 连接」小节）→ extraHead = OpsTab（危险动作按钮）
		//   · 群聊（入群欢迎并进来了）→ GroupCardsBody（群卡片）+ WelcomeBody（入群欢迎）
		//   · 空间日记（看自己）→ SwitchGroup 只渲染「看自己」那一个小节
		//   · 主动接话 / 记忆 → 各自的专用组件（有自定义交互）
		function tabDefs(schema) {
			// 后端已经把分组归并过（admin/schema.js 的 GROUP_MERGE），并给了页签顺序 groupOrder。
			// 固定页：总览（状态/向导）、子插件（清单与开关）；其余都是「合并后的分组页」。
			const groups = []
			const FIXED_LABELS = ['总览', '子插件']
			const personaGroups = new Set((schema && schema.personaGroups) || [])
			for (const c of (schema && schema.controls) || []) {
				if (!c.group || personaGroups.has(c.group) || FIXED_LABELS.includes(c.group) || groups.includes(c.group)) continue
				groups.push(c.group)
			}
			const order = Array.isArray(schema && schema.groupOrder) ? schema.groupOrder : []
			groups.sort((a, b) => {
				const ia = order.indexOf(a)
				const ib = order.indexOf(b)
				if (ia >= 0 || ib >= 0) return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib)
				return 0
			})
			// 「其他」永远排最后（杂项汇总页，不该夹在功能页中间）
			if (groups.includes('其他')) {
				groups.splice(groups.indexOf('其他'), 1)
				groups.push('其他')
			}
			return [
				{ id: 'overview', label: '总览' },
				...groups.map((g) => ({ id: 'group:' + g, label: g, group: g })),
				{ id: 'plugins', label: '子插件' },
			]
		}

		// ═══════════ 外壳：页内标签页（设置导航只占一格）+ 共享状态 ═══════════
		function ConsoleShell(props) {
			const { ctx } = props
			const { useState, useEffect, useCallback } = react
			const [schema, setSchema] = useState(null)
			const [status, setStatus] = useState(null)
			const [msg, setMsg] = useState('')
			const [busy, setBusy] = useState(false)
			const [confirmBox, setConfirmBox] = useState(null)   // 危险操作二次确认弹窗（跨标签页共用）
			const [reportBox, setReportBox] = useState(null)     // 一键诊断结果弹窗（报告 + 复制按钮）
			const [tab, setTab] = useState('overview')

			// DSH 的 connection.rpc 返回的是 RPC 信封 {ok:true,value} / {ok:false,error}，
			// 这里统一拆到「内核自己的返回值」；下面所有面板逻辑都按内核的 {ok,...} 形状写。
			// ⚠️ payload 必须兜成 {}：JSON.stringify 会**丢掉值为 undefined 的键**，
			//    而 DSH 原生 RPC 通道的信封 schema 要求 payload 键存在（缺了就回
			//    `invalid client-request message`，面板显示"读取失败"）。
			//    旧版走直挂路由时后端用 `payload || {}` 兜过，所以这个坑以前没露出来。
			const call = useCallback(async (endpoint, payload) => {
				const r = await ctx.connection.rpc.call(CHANNEL, endpoint, payload ?? {})
				if (r && r.ok === false) {
					const err = r.error
					throw new Error(typeof err === 'string' ? err : (err && (err.message || err.code)) || 'RPC 调用失败')
				}
				return r ? r.value : undefined
			}, [ctx])

			const refresh = useCallback(async () => {
				try {
					const [s, st] = await Promise.all([call('schema'), call('status')])
					if (s && s.ok === false) throw new Error(s.error)
					setSchema(s)
					setStatus(st)
				} catch (e) { setMsg(`读取失败：${e.message}`) }
			}, [call])

			// 首屏拉一次（schema + status），之后每 5 秒两份都刷新：
			// · status：连接 / 人设 / 群卡片 / 主动接话状态等实时数据；
			// · schema：控件当前值 + 子插件开关（别处改了配置，这边也不会一直显示旧值）。
			// 轮询失败静默重试：别每 5 秒往消息行刷一条错误。
			useEffect(() => {
				refresh()
				let inflight = false
				const t = setInterval(async () => {
					if (inflight) return
					inflight = true
					try {
						const [s, st] = await Promise.all([call('schema'), call('status')])
						if (s && s.ok !== false) setSchema(s)
						if (st && st.ok !== false) setStatus(st)
					} catch { /* 下一轮再试 */ } finally { inflight = false }
				}, 5000)
				return () => clearInterval(t)
			}, [refresh, call])

			// 复制到剪贴板：优先 clipboard API；失败降级选中弹窗里的报告 textarea（用户可 Ctrl+C）
			const copyToClipboard = (text, label) => {
				const value = String(text || '')
				const fallbackSelect = () => {
					try {
						const ta = document.querySelector('textarea[data-qq-report="1"]')
						if (ta) {
							ta.focus(); ta.select()
							if (typeof document.execCommand === 'function' && document.execCommand('copy')) {
								setMsg(`${label}已复制 ✓`)
								return
							}
						}
					} catch { /* 选不中也只是降级失败 */ }
					setMsg('复制失败：请手动选中弹窗里的报告正文复制（Ctrl/⌘+C）')
				}
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
						navigator.clipboard.writeText(value)
							.then(() => setMsg(`${label}已复制 ✓`))
							.catch(fallbackSelect)
						return
					}
				} catch { /* 走降级 */ }
				fallbackSelect()
			}

			const run = async (label, fn) => {
				setBusy(true); setMsg('')
				try {
					const r = await fn()
					if (r && r.ok === false) throw new Error(r.error)
					// 内核返回的 message 优先显示（例如危险操作的二次确认提示 / 自检的失败清单）
					// 2026-10-11：**保留多行**（自检失败会把失败用例逐行列出来），消息行已开 pre-wrap
					const detail = r && typeof r.message === 'string' && r.message.trim()
						? String(r.message).trim()
						: `${label} ✓`
					setMsg(detail)
					await refresh()
				} catch (e) { setMsg(`${label} ✗ ${e.message}`) } finally { setBusy(false) }
			}

			const TABS = tabDefs(schema)
			const curTab = TABS.find((t) => t.id === tab) || TABS[0]
			const api = { ctx, call, refresh, run, busy, setBusy, schema, status, msg, setMsg, setConfirmBox, setReportBox }

			const body = (!schema || !status)
				? h('div', { style: S.msg, key: 'loading' }, msg || '读取中…')
				: curTab.id === 'overview' ? h(TabOverview, { key: 'o', ...api })
					: curTab.id === 'plugins' ? h(TabPlugins, { key: 'pl', ...api })
						// 合并后需要「动作按钮 + 自定义交互」的页走专用组件；其余全是通用折叠渲染
						: curTab.group === '运维' ? h(GroupTab, Object.assign({}, api, { key: 'op', group: '运维', skipSections: ['OneBot 连接'], extraHead: h(OneBotStatus, Object.assign({}, api, { key: 'oh', section: 'OneBot 连接', sectionTitle: '运维动作' })) }))
						: curTab.group === '群聊' ? h(GroupTab, Object.assign({}, api, { key: 'g', group: '群聊' }))
							: curTab.group === '主动接话' ? h(ReplyModeTab, Object.assign({}, api, { key: 'rm' }))
								: curTab.group === '记忆' ? h(LongMemoryTab, { key: 'lm', ...api })
									: curTab.group ? h(GroupTab, Object.assign({}, api, { key: 'gt', group: curTab.group }))
										: h(TabOverview, { key: 'o2', ...api })

			return h('div', { style: S.card }, [
				h('div', { style: S.tabs, key: 'tabs' }, TABS.map((t) => h('button', {
					key: t.id, style: tab === t.id ? S.tabOn : S.tab, onClick: () => setTab(t.id),
				}, t.label))),
				body,

				h('div', { style: S.msg, key: 'msg' }, msg || (busy ? '处理中…' : '')),

				// ═══ 诊断报告弹窗（一键诊断：摘要 + 报告路径 + 正文 + 复制）═══
				reportBox ? h('div', {
					key: 'report',
					style: {
						position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
						display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12,
					},
					onClick: () => { if (!busy) setReportBox(null) },
				}, [
					h('div', {
						key: 'box',
						style: {
							background: '#fff', color: '#111', borderRadius: 12, padding: '16px 18px',
							maxWidth: 760, width: '100%', boxShadow: '0 12px 40px rgba(0,0,0,.35)', border: '1px solid #d0d5dd',
						},
						onClick: (e) => e.stopPropagation(),
					}, [
						h('div', { key: 't', style: { fontWeight: 700, marginBottom: 8, fontSize: 15 } }, '🩺 诊断完成'),
						h('div', { key: 's', style: { fontSize: 13, marginBottom: 6, lineHeight: 1.5 } },
							(reportBox.summary && reportBox.summary.text) || '检查完成'),
						h('div', { key: 'p', style: { fontSize: 12, marginBottom: 8, lineHeight: 1.6, wordBreak: 'break-all' } }, [
							h('span', { key: 'l', style: { opacity: .7 } }, '报告位置：'),
							h('span', {
								key: 'v',
								style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', userSelect: 'all' },
							}, reportBox.reportPath || '（报告落盘失败，可复制下面正文）'),
						]),
						h('textarea', {
							key: 'ta',
							readOnly: true,
							'data-qq-report': '1',
							value: String(reportBox.report || ''),
							spellCheck: false,
							style: {
								width: '100%', height: 240, maxHeight: 240, overflow: 'auto',
								fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.5,
								padding: '8px 10px', borderRadius: 8, border: '1px solid #d0d5dd',
								background: 'transparent', color: 'inherit', boxSizing: 'border-box', resize: 'vertical',
							},
						}),
						h('div', { key: 'hint', style: Object.assign({}, S.msg, { marginTop: 6, lineHeight: 1.5 }) },
							'已脱敏（不含 token/API Key/完整 QQ 号）；可以把报告路径贴给 DSH 本体，让它按报告修复（说『按这份报告修复 dsh-onebot-qq』即可）。'),
						h('div', { key: 'b', style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, flexWrap: 'wrap' } }, [
							h('button', {
								key: 'copy', style: S.btn, disabled: busy,
								onClick: () => copyToClipboard(reportBox.report, '报告正文'),
							}, '复制报告'),
							h('button', {
								key: 'fix', style: S.btn, disabled: busy,
								onClick: () => copyToClipboard(reportBox.fixPrompt, '修复提示词'),
							}, '复制给 DSH 的修复提示词'),
							h('button', { key: 'close', style: S.btn, disabled: busy, onClick: () => setReportBox(null) }, '关闭'),
						]),
					]),
				]) : null,

				// ═══ 二次确认弹窗（危险操作；跨标签页共用）═══
				confirmBox ? h('div', {
					key: 'confirm', style: {
						position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999,
						display: 'flex', alignItems: 'center', justifyContent: 'center',
					},
					onClick: () => { if (!busy) setConfirmBox(null) },
				}, [
					h('div', {
						key: 'box', style: {
							background: '#fff', color: '#111', borderRadius: 12, padding: '16px 18px',
							maxWidth: 460, boxShadow: '0 12px 40px rgba(0,0,0,.35)', border: '1px solid #d0d5dd',
						},
						onClick: (e) => e.stopPropagation(),
					}, [
						h('div', { key: 't', style: { fontWeight: 700, marginBottom: 8, fontSize: 15 } }, confirmBox.title),
						...confirmBox.lines.map((l, i) => h('div', { key: 'l' + i, style: { fontSize: 13, opacity: .85, marginBottom: 4 } }, l)),
						h('div', { key: 'b', style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } }, [
							h('button', { key: 'c', style: S.btn, disabled: busy, onClick: () => setConfirmBox(null) }, '取消'),
							h('button', {
								key: 'ok', disabled: busy,
								style: Object.assign({}, S.btn, { background: '#b3261e', color: '#fff', border: '1px solid #b3261e', fontWeight: 600 }),
								onClick: () => { const f = confirmBox.onOk; setConfirmBox(null); f() },
							}, confirmBox.okLabel || '确认'),
						]),
					]),
				]) : null,
			])
		}

		// ═══════════ 标签页：长期记忆（long-memory）═══════════
		/**
		 * long-memory 控制台页（「记忆」标签页）。
		 *
		 * 三类数据分开取，别混：
		 *   · 配置（存储范围 / 整理模型 / 参数）→ schema 里的控件，用 ctrlRow 直接渲染并热写 config.json；
		 *   · 状态（条数/水位/接口是否通）→ RPC `mem` 的 `status`；
		 *   · 记忆库（列表/搜索/详情/删除/导出/导入）→ RPC `mem` 的 `list|get|forget|restore|purge|export|import`。
		 *
		 * 为什么单独一个组件：旧页是「每群一篇 md」的形态，新库是「一条条带分数的记忆」，
		 * 渲染逻辑完全不同；硬塞进旧组件只会让两边都变难读。旧页在新插件跑通后整体移除。
		 */
		function LongMemoryTab(props) {
		  const { ctx, schema, msg } = props
		  const { useState, useEffect, useCallback } = react
		  const call = useCallback((payload) => ctx.connection.rpc.call(CHANNEL, 'mem', payload ?? {}), [ctx])

		  const [data, setData] = useState(null)   // status
		  const [list, setList] = useState(null)   // {items, total, filtered}
		  const [q, setQ] = useState('')
		  const [scopeFilter, setScopeFilter] = useState('')
		  const [detail, setDetail] = useState(null)
		  const [local, setLocal] = useState('')    // 本页自己的消息（装卸数据/操作的反馈）
		  const [busy2, setBusy2] = useState(false)
		  const [showForgotten, setShowForgotten] = useState(false)
		  const [importText, setImportText] = useState('')
		  const [exportText, setExportText] = useState('')
		  const [previewScope, setPreviewScope] = useState('')
		  const [previewOut, setPreviewOut] = useState(null)
		  const [cfgOpen, setCfgOpen] = useState(false)

		  const say = (t) => setLocal(String(t || ''))

		  const loadStatus = useCallback(async () => {
		    try {
		      const r = await call({ op: 'status' })
		      if (r && r.ok === false) throw new Error(r.error)
		      setData(r)
		    } catch (e) { say(`读取状态失败：${e.message}`) }
		  }, [call])

		  const loadList = useCallback(async (kw = q, scope = scopeFilter, forgotten = showForgotten) => {
		    try {
		      const r = await call({ op: 'list', q: kw, scope, forgotten, limit: 200 })
		      if (r && r.ok === false) throw new Error(r.error)
		      setList(r)
		    } catch (e) { say(`读取记忆库失败：${e.message}`) }
		  }, [call, q, scopeFilter, showForgotten])

		  useEffect(() => { loadStatus(); loadList() }, []) // 只在挂载时拉一次

		  const act = async (label, payload, after) => {
		    setBusy2(true); say('')
		    try {
		      const r = await call(payload)
		      if (r && r.ok === false) throw new Error(r.error)
		      say(`${label} ✓${r && r.message ? ` ${r.message}` : ''}`)
		      if (after) await after(r)
		    } catch (e) { say(`${label} ✗ ${e.message}`) } finally { setBusy2(false) }
		  }

		  const kb = (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB')
		  const when = (ts) => {
		    if (!ts) return '—'
		    const d = Math.floor((Date.now() - ts) / 86400000)
		    return d <= 0 ? '今天' : d === 1 ? '昨天' : d + ' 天前'
		  }

		  // ── 顶部状态卡 ──────────────────────────────────────────────────────
		  const st = data || {}
		  const llm = st.llm || {}
		  const org = st.organize || {}
		  // 状态灯里的三项（2026-11-10）：只显示「插件真正读到的」；filled 缺失时按 configured 兜底。
		  const filled = llm.filled || {}
		  const yc = (ok) => (ok ? '✅' : '❌')
		  // when() 在本组件上方已经定义（“今天是第几天”），这里只补一个完整时间格式化
		  const fmtTime = (ts) => { try { return new Date(ts).toLocaleString() } catch { return String(ts) } }
		  const top = h('div', { style: S.card, key: 'top' }, [
		    h('div', { style: S.title, key: 't' }, '长期记忆 · 存盘的，不靠压缩'),
		    h('div', { style: S.row, key: 'r1' }, [
		      // 0 条不再标红：那是「还没开始记」，不是错误
		      h('span', { key: 'a', style: S.badge(true) }, `${st.entries ?? '—'} 条记忆`),
		      h('span', { key: 'b', style: S.badge(true) }, `已遗忘 ${st.forgotten ?? 0}`),
		      h('span', { key: 'c', style: S.badge(Boolean(llm.configured)) },
		        llm.configured ? `整理接口已配置（${llm.model || '未填模型'}）` : '整理接口未配置'),
		      h('span', { key: 'c2', style: { fontSize: 12, opacity: .8, marginLeft: 2 } },
		        `地址 ${yc(filled.baseUrl)} 模型 ${yc(filled.model)} Key ${yc(filled.apiKey)}`),
		      h('span', { key: 'd', style: S.badge(st.autoOrganize) }, st.autoOrganize ? '自动整理开' : '自动整理关'),
		      h('span', { key: 'e', style: S.badge(st.injectEnabled) }, st.injectEnabled ? '每轮注入开' : '每轮注入关'),
		      st.running ? h('span', { key: 'f', style: S.badge(true) }, '正在整理…') : null,
		    ]),
		    h('div', { style: Object.assign({}, S.msg, { whiteSpace: 'pre-wrap' }), key: 'r2' },
		      `范围：${st.scopeSummary || '—'}｜最早 ${when(st.oldest)}，最新 ${when(st.newest)}\n`
		      + `上次整理：${org.at ? fmtTime(org.at) : '还没跑过'}` + (org.error ? `｜原因：${org.error}` : '') + '\n'
		      + `目录：${st.dir || ''}`
		      + (llm.configured ? '' : `\n整理模型没配好的话：展开下面的「整理模型」填地址/模型/Key，再点「🔌 测试整理接口」`)),
		    h('div', { style: S.row, key: 'r3' }, [
		      h('button', { key: 'o', style: S.btn, disabled: busy2, onClick: () => act('整理一轮', { op: 'organize', force: true }, async () => { await loadStatus(); await loadList() }) }, '⚙ 立刻整理一轮'),
		      h('button', { key: 't', style: S.btn, disabled: busy2, onClick: () => act('测试接口', { op: 'testLlm' }) }, '🔌 测试整理接口'),
		      h('button', { key: 'rf', style: S.btn, disabled: busy2, onClick: async () => { await loadStatus(); await loadList() } }, '刷新'),
		      h('button', { key: 'cfg', style: S.btn, onClick: () => setCfgOpen(!cfgOpen) }, (cfgOpen ? '▾ 收起配置' : '▸ 存储范围与整理模型')),
		    ]),
		    local ? h('div', { style: S.msg, key: 'm' }, local) : (msg ? h('div', { style: S.msg, key: 'm2' }, msg) : null),
		  ])

		  // ── 配置区（直接复用外层的 ctrlRow，保存走统一的 set 接口）──
		  const cfgApi = {
		    busy: busy2,
		    setMsg: say,
		    async run(label, fn) {
		      setBusy2(true); say('')
		      try { await fn(); say(`${label} ✓`); await loadStatus() } catch (e) { say(`${label} ✗ ${e.message}`) } finally { setBusy2(false) }
		    },
		    call: (op, payload) => {
		      if (op !== 'set' || !payload) return Promise.reject(new Error(`不支持的操作：${op}`))
		      return ctx.connection.rpc.call(CHANNEL, 'set', { key: payload.key, value: payload.value })
		        .then((r) => { if (r && r.ok === false) throw new Error(r.error); return r })
		    },
		  }
		  // 「记忆」页不再分两页：所有控件都在这一页，按小节折成折叠块（存储范围 / 整理模型 / 高级参数）。
		  // 后端已经把 `记忆（高级）` 并进「记忆」（section 仍是各自的名字），这里只决定块的顺序与默认开合。
		  const cfgBlock = (() => {
		    if (!cfgOpen || !schema) return null
		    const ctrls = (schema.controls || []).filter((c) => c.plugin === 'long-memory')
		    const sections = []
		    for (const c of ctrls) if (!sections.includes(c.section || '')) sections.push(c.section || '')
		    // 常用两块默认展开；「高级参数」里的所有小节默认收起（参数多，别一进来就刷屏）
		    const OPEN_BY_DEFAULT = { 存储范围: true, 整理模型: true }
		    return h('div', { key: 'cfg' }, sections.map((sec) => h(Fold, {
		      key: 's' + sec, api: cfgApi, title: sec || '设置', defaultOpen: !!OPEN_BY_DEFAULT[sec],
		      children: () => ctrls.filter((c) => (c.section || '') === sec).map((c) => ctrlRow(c, cfgApi)),
		    })))
		  })()

		  // ── 记忆库 ──────────────────────────────────────────────────────────
		  const items = (list && list.items) || []
		  const scopes = (st.scopes || []).map((s) => s.scope)
		  const lib = h('div', { style: S.card, key: 'lib' }, [
		    h('div', { style: S.title, key: 't' }, `记忆库${list ? `（${list.total} 条${list.filtered ? `，筛出 ${items.length}` : ''}）` : ''}`),
		    h('div', { style: S.row, key: 'q' }, [
		      h('input', {
		        key: 'i', style: Object.assign({}, S.input, { width: 220 }), placeholder: '搜索正文/标签', defaultValue: q,
		        onKeyDown: (e) => { if (e.key === 'Enter') { setQ(e.target.value); loadList(e.target.value) } },
		      }),
		      h('select', {
		        key: 's', style: Object.assign({}, S.input, { width: 150 }), value: scopeFilter,
		        onChange: (e) => { setScopeFilter(e.target.value); loadList(q, e.target.value) },
		      }, [h('option', { key: '', value: '' }, '全部会话'), ...scopes.map((s) => h('option', { key: s, value: s }, s))]),
		      h('label', { key: 'f', style: { fontSize: 12, opacity: .8 } }, [
		        h('input', {
		          key: 'c', type: 'checkbox', checked: showForgotten, style: { marginRight: 4 },
		          onChange: (e) => { setShowForgotten(e.target.checked); loadList(q, scopeFilter, e.target.checked) },
		        }),
		        '看已遗忘的',
		      ]),
		      h('button', { key: 'b', style: S.btn, disabled: busy2, onClick: () => loadList() }, '搜索'),
		      h('button', { key: 'e', style: S.btn, disabled: busy2, onClick: () => act('导出', { op: 'export', format: 'md' }, (r) => setExportText(r.text || '')) }, '导出 md'),
		      h('button', { key: 'ej', style: S.btn, disabled: busy2, onClick: () => act('导出 JSON', { op: 'export', format: 'json' }, (r) => setExportText(r.text || '')) }, '导出 JSON'),
		      h('button', {
		        key: 'imp', style: S.btn, disabled: busy2,
		        onClick: () => {
		          const txt = window.prompt('粘贴要导入的记忆 JSON（导出的 JSON 格式，数组）')
		          if (txt) act('导入', { op: 'import', text: txt }, loadList)
		        },
		      }, '导入 JSON'),
		    ]),
		    exportText ? h('textarea', {
		      key: 'exp', readOnly: true, value: exportText, spellCheck: false,
		      style: { width: '100%', minHeight: 120, fontSize: 12, marginTop: 6, padding: '6px 8px', borderRadius: 8, border: '1px solid #d0d5dd', boxSizing: 'border-box' },
		    }) : null,
		    h('div', { style: { maxHeight: 420, overflow: 'auto', marginTop: 6 }, key: 'l' },
		      items.length ? items.map((m) => h('div', {
		        key: m.id, style: {
		          padding: '5px 0', borderBottom: '1px solid rgba(127,127,127,.14)', fontSize: 13,
		          opacity: m.forgottenAt ? .5 : 1,
		        },
		      }, [
		        h('div', { key: 'a', style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } }, [
		          h('span', { key: 'w', style: { fontSize: 11, opacity: .7, minWidth: 48 } }, when(m.createdAt)),
		          h('span', { key: 's', style: { fontSize: 11, opacity: .7 } }, String(m.scope || '')),
		          h('span', { key: 'i', style: S.chip }, `重要 ${Number(m.importance || 0).toFixed(2)}`),
		          m.effective != null ? h('span', { key: 'e', style: S.chip }, `清晰度 ${Number(m.effective).toFixed(2)}`) : null,
		          Number(m.forgottenAt) > 0 ? h('span', { key: 'f', style: S.badge(false) }, '已遗忘') : null,
		          ...(Array.isArray(m.tags) ? m.tags.slice(0, 4).map((t, i) => h('span', { key: 't' + i, style: S.chip }, t)) : []),
		        ]),
		        h('div', { key: 'b', style: { marginTop: 2 } }, String(m.text || '')),
		        h('div', { key: 'c', style: S.row }, [
		          h('button', { key: 'd', style: S.btn, disabled: busy2, onClick: () => act('查看', { op: 'get', id: m.id }, (r) => setDetail(r.item || r)) }, '为什么会被想起来'),
		          Number(m.forgottenAt) > 0
		            ? h('button', { key: 'r', style: S.btn, disabled: busy2, onClick: () => act('恢复', { op: 'restore', id: m.id }, loadList) }, '恢复')
		            : h('button', { key: 'f', style: S.btn, disabled: busy2, onClick: () => act('忘掉', { op: 'forget', id: m.id }, loadList) }, '忘掉'),
		          h('button', {
		            key: 'b2', style: S.btn, disabled: busy2,
		            onClick: () => {
		              const v = window.prompt('新的重要性（0~1）', String(m.importance ?? 0.6))
		              if (v != null) act('改重要性', { op: 'boost', id: m.id, importance: Number(v) }, loadList)
		            },
		          }, '改重要性'),
		          h('button', {
		            key: 'p', style: Object.assign({}, S.btn, { color: '#b3261e' }), disabled: busy2,
		            onClick: () => {
		              const ok = window.confirm('彻底删除这一条？会先整库备份到 .revisions/，然后从库和导出里都去掉。')
		              if (ok) act('彻底删除', { op: 'purge', id: m.id }, loadList)
		            },
		          }, '彻底删除'),
		          h('span', { key: 'id', style: { fontSize: 11, opacity: .5 } }, m.id),
		        ]),
		      ])) : h('div', { style: S.msg }, list ? '还没有记忆。先在上面配好「整理模型」，或者对面说一句「记住…」。' : '读取中…')),
		  ])

		  // ── 分项详情 ────────────────────────────────────────────────────────
		  const detailBox = detail ? h('div', { style: S.card, key: 'detail' }, [
		    h('div', { style: S.title, key: 't' }, '这条为什么会被想起来'),
		    h('div', { style: Object.assign({}, S.msg, { whiteSpace: 'pre-wrap' }), key: 'b' },
		      `${detail.memory && detail.memory.text}\n\n`
		      + `相关 ${detail.score ? detail.score.relevance : '—'}｜新鲜 ${detail.score ? detail.score.fresh : '—'}｜重要 ${detail.score ? detail.score.importance : '—'}\n`
		      + `综合分 ${detail.score ? detail.score.score : '—'}（相关×0.65 + 新鲜×0.20 + 重要×0.15）\n`
		      + `来源 ${detail.memory && detail.memory.scope}｜来源消息 ${(detail.memory && detail.memory.sourceMsgIds || []).join(',') || '—'}`),
		    detail.why && detail.why.length ? h('div', { style: S.msg, key: 'w' }, '命中原因：' + detail.why.join(' / ')) : null,
		    h('button', { key: 'x', style: S.btn, onClick: () => setDetail(null) }, '关闭'),
		  ]) : null

		  // ── 预览 ────────────────────────────────────────────────────────────
		  const previewBox = h('div', { style: S.card, key: 'pv' }, [
		    h('div', { style: S.title, key: 't' }, '预览：拿最近聊天试抽一次（不写库、不推水位）'),
		    h('div', { style: S.row, key: 'r' }, [
		      h('input', {
		        key: 'i', style: Object.assign({}, S.input, { width: 220 }), placeholder: 'scope，如 private:123456',
		        defaultValue: previewScope, onChange: (e) => setPreviewScope(e.target.value),
		      }),
		      h('button', {
		        key: 'b', style: S.btn, disabled: busy2,
		        onClick: () => act('预览', { op: 'preview', scope: previewScope }, (r) => setPreviewOut(r)),
		      }, '抽一次看看'),
		    ]),
		    previewOut ? h('div', { style: Object.assign({}, S.msg, { whiteSpace: 'pre-wrap' }), key: 'o' },
		      previewOut.ok
		        ? `会记 ${previewOut.wouldAdd || 0} 条：\n` + (previewOut.items || []).map((x) => `- [${Number(x.importance || 0).toFixed(2)}] ${x.text}`).join('\n')
		        : `失败：${previewOut.code || ''} ${previewOut.reason || ''}`) : null,
		  ])

		  return h('div', {}, [top, cfgOpen ? cfgBlock : null, detailBox, lib, previewBox])
		}


		function apply(ctx) {
			ctx.slots.inject('settings.section', () => {
				const dispose = ctx.slots.register(
					{ name: 'settings.section', id: 'dsh-onebot-qq', order: 98, label: () => 'QQ 控制台' },
					() => h(ConsoleShell, { ctx }),
				)
				return typeof dispose === 'function' ? dispose : () => {}
			})
		}

		const inject = ['slots', 'connection']
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
