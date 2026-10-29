# Changelog

所有值得用户知道的变更记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## 未发布 — 2026-10-28

新增 QQ 空间日记子插件（`qzone`，order 62）：

### 新增

- **`qzone` 子插件**：给机器人一个自己的 QQ 空间当日记本，每个会话每天最多一条，由它自己判断写不写；到点（默认 22:00 后）在它下一条被唤醒的消息里提醒一次（挂 `ev.hint`，不改静态系统提示）。新增三个模型工具 `post_qzone` / `skip_qzone` / `qzone_status`。
  - **「不写」绝不进空间**：`skip_qzone` 独立成一个工具，只记状态不发任何内容；`post_qzone` 对「不写」类正文另有硬性拦截 —— 合并工具 + 传空值的写法会让模型把不写的理由当正文发进公开空间。
  - **配图不污染表情库**：只接受本地文件路径，并拒绝 `qq-stickers/` 下的文件（包含判定走 `platform/paths.js` 的 `isInsidePath`）。
  - **额度落盘、跨重启保留**：状态存 `<dataDir>/qzone-state.json`（按会话记录当天条数与是否跳过），重启不会把额度重置回 0 —— 内存态会导致「早上发过、下午重启又能发第二条」。
  - **控制台显示实时额度**：`configSchema.info.text` 改成 getter，装配时把 dataDir/limit 记到模块级槽，每次读 schema 现算 `📔 今日已发 N/M`（今天所有会话的合计，跳过过会额外标注）。
- **适配器新增 `sendQzoneMsg()`**：包装协议端 `send_qzone_msg` 扩展（非 OneBot v11 标准）；失败返回 `{ok:false,msg}` 不抛错，不支持的实现自动降级。插件侧经 `bot.onebot.sendQzoneMsg` 调用，仍拿不到裸 send。
## 未发布 — 2026-10-23

群记忆正确性与控制台修复（不新增功能、不改对外配置键）：

### 修复

- **兼容 SnowLuma 等其它 OneBot v11 协议端**：引用回复允许**负 `message_id`**（SnowLuma 的 id 是有符号 int32 哈希、经常为负；原来 `<=0` 当「不挂引用」会让引用静默失效 —— 现在只有 `0` 才表示不挂），`parseWire` 的引用解析同步认负号；`get_group_msg_history` 同时发 `message_id: 0` 与 `message_seq: 0`（SnowLuma 认 `message_id`、NapCat 认 `message_seq`，两边都忽略未知键）；在线探针优先看 `get_status`（`online=false` 判掉线、`good=false` 判「接收链路停滞」——SnowLuma hook 卡住时发得出收不进，光靠 `get_stranger_info` 会误判在线），心跳里的 `status.good` 记进 `health().qqReceiveGood`；拿不到 `get_status`/字段时行为与原来一致（纯 NapCat 不受影响）。
- **写侧改用未截断原文**：积累器合并/备份不再拿读侧 24KB 截断文本当基准；超过 `maxBytes` 的尾部不再每轮丢失，旧版误写进正文的「…已截断」提示会在下次合并时清掉。
- **水位口径**：`digestedAt` 改为「本轮实际喂给模型的最新消息 ts」，不再用 `Date.now()`（模型调用期间新到的消息不再被误标已消化）。
- **采样可见**：每群超出 `accumulateMsgPerGroup` / `accumulateMaxChars` 的条数计入 `sampledOut`（日志 + 结果行），不再静默丢弃。
- **digest 解析 0 条不推水位**：模型把要点写成段落/表格时记 failed、下轮重试，不再当「无新增」跳过。
- **单轮群数上限可配 + 轮转**：新增 `accumulateMaxGroupsPerRound`（默认 12），配合游标轮转，大号段群不再永久饿死。
- **合并质量**：同 QQ 重复画像归一、`；**昵称(QQ)**` run-on 拍平、`这轮/本轮` 临时内容丢弃、每节按条数 + 字节预算裁剪（优先保「群里的人」），文件稳定在读取上限内。
- **`.revisions` 统一保留**：积累器与控制台 `-manual` 备份共用命名/`accumulateRetainRevisions`；死群多余版本每轮收掉。
- **控制台保存**：保存上限跟随 `maxBytes`；带 `ifMtime` 的乐观并发校验（防止旧编辑器覆盖新积累）；写盘 0600；`dir` 限制在数据目录内；唤醒词里的非群号数字键不再让「群记忆」页整页崩掉；保存后状态自动跟随。
- **生命周期**：定时器接入 `bot.onDispose()`（新增 bot 能力，向后兼容），插件重载不再叠出第二个 60s 定时器。
- **文档/注释**：配置参考补 `accumulateMaxGroupsPerRound`、采样/水位口径；开发指南补 `bot.onDispose`；修正「后台会话禁止调用任何工具」等过时注释。
- **撤回失败不再回显 NapCat 原始报错**：适配器把 `NTEvent / EventRet / decode failed` 原文只写日志、对外返回人话；`gate-wake` 的撤回失败回执也只发人话。修复 2026-10-23 15:37 把整段内部报错发进群的问题。
- **`/history` 上限 200 → 500**：`plugins/commands/index.js` 的 `HISTORY_MAX` 放宽（默认仍 50）；500 条约 23KB / 7.6K token，拉取仍在适配器 8s 超时内。
- **修复点赞通知制造空对话**：NapCat 的点赞通知（`profile_like`）没有 `user_id`/`group_id`，归一后 chatKey 变成 `private:undefined`，又被「私聊永远算被叫」放行 → 出现两个空模型回合、并建出 `private:undefined` 的 DSH 会话。现在：无身份 notice 直接丢弃（format）、notice 一律不进模型（gate-wake）、非法 chatKey 在 runTurn 第二道防线丢弃。
- **表情库改为自研存储，删除第三方 vendor**：不再随包携带 `vendor/dsh-sticker-shelf.mjs`（MIT，JackZo400/dsh-sticker-library，2026-10-12 引入）。按实际用到的能力重写为 `plugins/stickers/shelf.js`（索引读写/哈希去重/大小闸/挑图/清单/统计，约 280 行），并删掉用不上的打标（`tagPending`/看图回调/BLOCK 安全线）、删除黑名单、adult/lowq/renumber 等。`package.json.files` 去掉 `vendor`，`docs/开发指南.md` 目录表同步。
- **删除表情包「删除黑名单」（`blocked-hashes.txt`）**：本机不需要"删掉的表情别再收回来"这套账本 —— 删一张 = 删文件 + 删索引条目。`vendor/dsh-sticker-shelf.mjs` 里 `loadBlocked/addBlocked/isBlockedHash` 及其调用（harvest ×2、remove ×1）一并移除（记为该文件的「本地补丁 2」，升级覆盖后需重打）。
- **表情索引瘦身：只记标签**：去掉 `desc`（画面描述）/`use`（什么场合发）/`summary`/`fromNick`/`fromUid`/`seenCount`/`lastSeen`，每条只留 `id/hash/file/tags/tagged/blocked/tagVer/uses/lastUsed/ts`（index.json 97KB → 39KB）；关键词挑图只按标签匹配；`sticker_catalog` 清单变成「编号 · 标签」；控制台数量改为「只算磁盘上真实存在的图」，并单独提示「N 条索引指向已删文件」。
- **修复表情包总是发同一张**：`matchContextTag` 会用整段上下文（含内核注入的 `[群聊上文]` 脚手架）匹配标签 → 命中库里唯一带「群聊」标签的那张（`#107`「正在严肃对群友哈气」），提示词因此 58/64 次点名「群聊」、模型照抄 44 次。现在：① 匹配前剥掉脚手架行；② 元标签（群聊/表情包/二次元…）不参与点名；③ 同名标签取最长的（更具体）；④ 只读模式加进程内"最近发过"轮换，同一个词不会连发同一张；⑤ 提示句式轮换并允许模型自己换词。
- **表情包新增「收表情（会写索引）」开关，默认关**：关着时库只读（不采集/不打标/不清理/不记使用，`index.json` 一个字节都不写），机器人仍能挑现有图发；控制台「表情包」页顶部显示库数量/标签数，并说明当前是只读还是可写。默认关是为了防「运行中改索引被内存副本覆盖」（2026-10-20 标签丢失的根因）。
- **拆条支持 2~N 条**：`pacing.reply.style.splitMaxParts`（默认 3，控制台「主动接话 → 高级」），按自然句末拆、绝不拦腰砍句；只对模型经 `send_message` 写的正文生效，命令回执/答应声不拆；>120 字的长文仍走长文卡片。
- **表情包实际发出率**：`send_message` 新增 `sticker` 参数（发正文时顺手带一张，省一步工具调用）；提示词改成「顺手带一张 + 给出现成参数」；若本轮掷骰命中但还没发，`send_message` 的返回里会再轻推一次（最多 2 次）。
- **新增 `list_images` 工具 + 去掉每轮参考图提示**：`[参考图库:…]` 每轮拼进用户消息正文（约 100~350 token、看着烦）已删；改成按需工具 `list_images`，可列 `refs`（角色参考图）/`workspace`（QQ 工作区）/`uploads`（QQ 发来的文件）/`avatars`（头像缓存）/`all` 下的图片，返回绝对路径、文件名、字节数、尺寸（默认 30 张、最多 100）。`generate_image` 的 `image` 支持清单里的路径或文件名；名字找不到时报错并指引先调 `list_images`。白名单未放宽（仍只允许白名单目录内的真实图片）。
- **生图新增「额外请求字段（JSON）」**：`pluginConfig.imagegen.extraBody`（多行文本，默认空），控制台「生图」页可改。不同平台字段不同，由用户自己补：文生图并进 JSON 请求体、图生图逐项追加为 multipart 字段、`openai-chat` 协议并进 `/chat/completions` 顶层。典型用法：sensenova／商汤默认给图加水印，填 `{"watermark": false}` 关掉。留空 = 与旧版行为完全一致；非法 JSON 直接报错、不发请求。

### 变更（控制台文案）

- **控制台里「NapCat」改名为「OneBot」**：页签「NapCat 连接」→「**OneBot 连接**」，按钮「测试 NapCat 连接」/「重新连接 NapCat」→「**测试 OneBot 连接**」/「**重新连接 OneBot**」，状态徽标「NapCat 在线/异常」→「OneBot 在线/异常」，诊断报告项与相关提示文案同步（协议端同时支持 NapCat 与 SnowLuma，界面不再只写其中一家）。**机器侧名字一律未改**：控制台动作 id 仍是 `napcat-check` / `napcat-reconnect`，配置键仍是 `napcat.*`，日志关键字仍是 `NapCat WS 已连接`（对外契约「只加不改」）。新增用例锁住新页签名与按钮名（`test/audit-console-groups.test.js`）。

### 变更（文档与文案口径：NapCat → OneBot 通用）

- **文档不再以 NapCat 为讲解对象，统一按 OneBot v11 通用表述**：`docs/` 8 份 + 仓库 `README.md` + `examples/windows/README.md`。
  `## 二、准备协议端（OneBot v11：NapCat 或 SnowLuma）` → `（OneBot v11）`；`### 2.1 NapCat` → **`### 2.1 安装并启动协议端（通用步骤）`**（启动协议端并登录 QQ → 开正向 WS（常见默认 3001）/ HTTP API（常见默认 3000）→ 记 token 填 `napcat.wsToken`/`httpToken` → curl 验证）；
  `## 三、安装并配置 NapCat（QQ 协议端）` → `## 三、安装并配置 OneBot 协议端`；对照表表头 `NapCat | SnowLuma` → `多数实现 | SnowLuma`；
  删除 NapCat 专属细节（NapCatQQ 安装器、WebUI `:6099`、`config\onebot11_<QQ号>.json`、`LD_PRELOAD`）；SnowLuma 小节保留并标注「本机在用的实现」；
  文档内 NapCat 命中 159 → 67（剩余全部是配置键 `napcat.*`、代码标识符与日志样例，必须与代码一致）。
- **界面与 CLI 文案同步泛化**：控制台 OneBot 连接页三步说明（不再写「NapCat 会自己拉起 QQ」）、`HTTP Token` 提示（「多数实现可留空；强制鉴权的实现（如 SnowLuma）必填」）、掉线/未连接提示里的 `:6099` 改为「端口见各实现文档（本机在用的 SnowLuma 默认 :5099）」、
  诊断项建议文案、`doctor --no-net` 帮助（「跳过 OneBot 协议端端口探测」）、自检项 `OneBot WS 端口`/`OneBot HTTP 端口`、新手向导提示（「测试 OneBot 连接」）；
  用户可见回执里「NapCat 没回数据 / 临时故障」→「协议端」；进模型的 `[群历史: … 来自 NapCat get_group_msg_history]` → `来自 OneBot get_group_msg_history`；`loginError` 的 `NapCat WS 断开` → `协议端 WS 断开`；`locale/*.json` 与 `package.json` 的 description 去掉 NapCat。
- **代码注释统一为「协议端」**：`kernel/`、`plugins/`、`admin/`、`client.js`、`bin/` 等 20 个文件约 60 行注释（NapCat 的行为特性 → 协议端通用描述）；差异事实保留但改成实现无关写法（如「Anchor 参数名各实现不同：多数实现认 `message_seq`，SnowLuma 认 `message_id`」）。
- **保持不动的契约**（与 2026-10-27 变更 9 一致）：配置键 `napcat.*`、动作 id `napcat-check`/`napcat-reconnect`、模块与文件 `kernel/napcat-adapter.js`、`NapCatAdapter`、`toNapCatFileRef`/`fromNapCatFileRef`、`test/fake-napcat.mjs`、日志前缀 `[onebot-qq:napcat]` 与验收日志字符串（如 `NapCat WS 已连接`）—— 全部保留，避免打坏既有配置与运维 grep。

### 修复（链接解析：视频拆条）

- **视频类链接在 SnowLuma 等严格协议端下发不出**：协议端要求「video 必须是消息里唯一的 segment」（`message element "video" must be the only segment in a message`；同一条里放两个视频同样被拒：`video may appear only once`）。`link-parser` 原来把「说明文字 + `[CQ:video]`」拼成一条 —— NapCat 时代兄弟元素被 QQ 静默吞掉、看起来正常，换成 SnowLuma 后整条发送失败（ERROR 日志，媒体一条都发不出）。
  现在有视频时改为：**每个视频各自一条、图片并一条、说明文字最后单独一条**；纯图片仍是「说明 + 图片同条」（图片没有该限制）。媒体全部失败时按原逻辑走「本条按普通消息处理」降级，并且**不单独发说明**（避免只留一句标题）。新增 4 条用例（单视频拆条 / 多视频逐条 / 纯图片不拆 / 全失败降级），全量 271/271。

### 变更（配置键与标识符改名：napcat → onebot）⚠️ 破坏性

- **配置键 `napcat.*` → `onebot.*`**：`wsUrl` / `wsToken` / `httpUrl` / `httpToken` / `mediaSendTimeoutMs` / `mediaSendRetries` 全部迁到 `onebot` 段。
  **旧键继续能读**：`loadConfig()` 会做一次归一（`applyOneBotLegacyKey`）—— 新键优先、旧键只补缺字段，所以老 `config.json` 一个字不改也能直接跑；控制台保存后写成新键。
- **动作 id**：`napcat-check` → `onebot-check`，`napcat-reconnect` → `onebot-reconnect`（旧 id 不再注册）。
- **模块与函数改名**：`kernel/napcat-adapter.js` → **`kernel/onebot-adapter.js`**，类 `NapCatAdapter` → `OneBotAdapter`，
  `toNapCatFileRef` / `fromNapCatFileRef` → `toOneBotFileRef` / `fromOneBotFileRef`，内部 `checkNapcat` → `checkOneBot`；
  测试用假协议端 `test/fake-napcat.mjs` → `test/fake-onebot.mjs`。
- **日志前缀与验收串**：`[onebot-qq:napcat]` → `[onebot-qq:onebot]`，`NapCat WS 已连接` → `OneBot WS 已连接` 等。
  ⚠️ **外部脚本要跟着改**：自建的监控/巡检脚本（取 `onebot.httpToken`，旧键兜底）与同步脚本（校验新文件名）需同步；
  自建的监控/巡检若 grep 过 `NapCat WS 已连接`，改成 `OneBot WS 已连接`。
- 文档、示例配置、`locale`、诊断项、CLI 输出同步为 `onebot.*`。仓库内旧实现名仅剩两处：兼容旧键的字面量（`applyOneBotLegacyKey` 内）与一条防回归守卫测试。
- 测试 269/269（新增「旧键兼容」2 条：只写旧键能读、两键并存时新键优先）。

### 文档


- **SnowLuma 升为一等公民**：`docs/安装与卸载.md` 的「准备协议端」拆成 **NapCat / SnowLuma 两小节**（含 Linux 无头部署、ptrace 注入前提、token 必填、关掉自带 `#sl`、`get_file` 能力差异）；`docs/排错.md` 新增「接了 SnowLuma 之后」整节（注入失败 / `good=false` 收不进 / 二维码过期 / `#sl` 抢话等 9 条）；`docs/配置参考.md` 写明 `napcat.*` 键名沿用、SnowLuma 两个 token 必填；`docs/开发指南.md` 新增「协议端差异」对照表（负 `message_id` / 群历史锚点 / `get_status` 健康字段 / `get_file` 覆盖面）；`README.md`、`docs/README.md` 与 `Windows安装.md`、`使用说明书.md`、`运维接口.md` 的措辞改为「协议端」，并说明控制台页签/配置键名沿用 NapCat 是历史原因。

### 测试

- 新增 `test/audit-group-memory-fixes.test.js`（6 条）与 4 条控制台用例；全量 `node --test` 209/209。

## 0.1.1 — 2026-10-21

新增 4 个可选子插件（来自社区 PR #1），并修掉 review 发现的问题。

### 新增

- `anti-repeat`：同一个人同一句话刷屏冷却（超过次数甩一句 + 整线冷却，零 token）。
- `private-friend-gate`：私聊只回好友（好友列表缓存；拉取失败时 fail-open，不误伤）。
- `video-read` / `video-link-read`：群视频 / B 站·抖音链接抽帧给模型看（需要本地解析侧车；没装或没起时自动降级）。
- 控制台对应开关（「唤醒」页防刷屏、「文件与图片」页看视频、「其他」页私聊门禁）。

### 修复（review）

- 移除 `video-read` 的排障 trace（不再写临时日志），并给被引消息加负缓存。
- `video-link-read` 移除 `blockParserAfterRead`：`link-parser` 在 intercept 阶段已经处理，before-turn 拦不住，原选项语义相反。
- `video-link-read` 补上缺失的 `onlyWhenAddressed` 配置。
- `bot.napcat` 契约补充 `friendList / msgById / getFile`；README / 说明书 / 架构文档同步为 13 个子插件。

## 0.1.0 — 2026-10-20

首个公开发布版本：把内部迭代收敛成一个**可安装、开箱即用**的 DSH 插件。

### 新增

- **DSH 原生插件包**：`dsh.bundle.patch` 随包声明，一行挂载；in-process 运行，无需独立进程 / systemd。
- **微内核 + 9 个子插件**：`gate-wake` / `commands` / `file-transfer` / `persona-voice` / `group-welcome` / `imagegen` / `link-parser` / `stickers` / `group-memory`，目录自动发现、按 order 排序、坏一个不拖垮整体。
- **五阶段入站管线**：`pre-gate` → `passive-tap` → `intercept` → `wake` → `before-turn`。
- **唯一出站口**：文本走 `deliver()`、媒体走 `sendMedia()`；自动抽 `[AT:]`、六项脱敏、插件装饰、发送 + 留档。
- **QQ 控制台**：16 个页签，配置热改（原子写 + 备份 + 失败回滚）；**子插件 ↔ 页面 1:1**（生图凭据归 `imagegen`、人设句池归「句池」、门禁与唤醒归「唤醒」），低频配置统一在「其他」页。
- **开箱人设**：内置「蓝色大肥鱼」人设 + `_模板.md`，首次启动自动投递；唤醒词与人设词合并生效。
- **QQ 侧能力**：收/发图片、生图与图生图（`openai-images` / `openai-chat` 两种协议）、群头像、表情包自动收集与发表情、入群欢迎、链接解析（可选侧车）、群记忆注入。
- **跨平台**：Linux / Windows / macOS；Windows 路径、临时目录、CQ 文件引用、原子写、软链不可用时的人设 copy 降级都在 `platform/` 收口。
- **CLI**：`node bin/dsh-onebot-qq.mjs init | doctor | import-legacy | persona`。
- **测试与守卫**：`node --test`（含假 NapCat 端到端）、打包清单守卫、私有信息扫描。

### 说明

- 数据目录默认 `$DSH_HOME/dsh-onebot-qq`；从旧名 `dsh-qq-bot` 升级时**自动沿用旧目录**，无需迁移。
- 配置里不携带任何真实 QQ 号 / 群号 / 密钥 / 服务器路径；所有示例均为占位值。
