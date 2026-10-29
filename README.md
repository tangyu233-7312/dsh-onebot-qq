# dsh-onebot-qq

DSH插件式的QQ机器人，经 OneBot v11 协议收发消息 —— 协议端可换：任意 OneBot v11 实现都行
（本仓库线上在用的是 **[NapCat](https://github.com/NapNeko/NapCatQQ)**，另有 [SnowLuma](https://github.com/SnowLuma/SnowLuma)、[OneBot](https://onebot.napneko.icu/) 等实现）。
微内核 + 可插拔子插件，**Linux / Windows通用**，装完在控制台填几项就能用。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-7c3aed)

> [!NOTE]
> **这是 [YUsaltyfish/dsh-onebot-qq](https://github.com/YUsaltyfish/dsh-onebot-qq) 的定制 fork。**
> 上游代码 + 本仓库自己的定制，默认分支 `custom`。

> [!WARNING]
> **本仓库比上游多了两块「需要外部依赖」的功能，装之前先看这两条：**
>
> | 功能 | 在哪 | 默认 | 要你自己准备 |
> |---|---|---|---|
> | **语音 / 曲库 / 唱歌** | `plugins/voice` | **全关** | Python 3.10、ffmpeg、edge-tts；唱歌还要 RVC 能力包 + **自己训练的 .pth 音色** + 建议 N 卡 |
> | **解析侧车**（看视频 / 链接解析的下载抽帧后端） | `sidecar/` | **不自动启动** | Node 18+、ffmpeg、yt-dlp |
>
> **两块都默认关着**，不装、不配、不开，就当它不存在。
> 详细步骤、依赖清单、已知限制 → **[docs/定制-语音唱歌与侧车.md](docs/定制-语音唱歌与侧车.md)**
> 侧车单独一篇 → [sidecar/README.md](sidecar/README.md)
>
> 其它定制（上游代码之上）：**QQ 空间日记 / 空间工作区**、**只发 BV 号也能看视频**、
> **自己找视频看**、**私聊主动接话**、**静默时段** —— 这些不需要额外装东西。

> **先读**：[`docs/README.md`](docs/README.md)（功能手册总览：按「我要做什么」找文档 + 全部功能索引）。
> 日常用：[`docs/使用说明书.md`](docs/使用说明书.md)（安装 → 连接 → 各功能怎么用 → 人设怎么写）。
> 想自己装：本文「安装」；只想让 DSH 帮你装：把 [`docs/安装与卸载.md`](docs/安装与卸载.md)（Windows 用 [`docs/Windows安装.md`](docs/Windows安装.md)）整份甩给它。

## 特性

| 能力 | 说明 |
|---|---|
| **DSH 原生插件** | `dsh.bundle.patch` 随包声明、一行挂载；纯 in-process，无独立进程 / systemd |
| **高可塑性** | 想要什么功能自己向DSH许愿 |
| **微内核 + 可插拔子插件** | 目录自动发现、一个坏了不影响其他；现有一览见下方[子插件一览](#子插件一览) |
| **唯一出站口** | 文本只走 `deliver()`、媒体只走 `sendMedia()`；自动抽 `[AT:]` → 六项脱敏 → 插件装饰 → 发送 + 留档 |
| **QQ 控制台** | 每个子插件一页 + 若干核心页（群聊 / 连接 / 消息设置 / 主动接话 / 其他）；配置热改（原子写 + 备份 + 回滚），全部带悬停解释 |
| **开箱人设** | 内置「蓝色大肥鱼」+ `_模板.md`，首次启动自动投递；唤醒词与人设词合并生效，控制台可增删 |
| **QQ 侧能力** | 收发图片、生图/图生图（`openai-images` / `openai-chat`）、群头像、表情包自动收集、入群欢迎、群记忆注入、可选链接解析 |
| **跨平台** | 路径 / 临时目录 / CQ 文件引用 / 原子写 / 人设软链降级全在 `platform/` 收口 |
| **高扩展性** | 同“可塑性” |

## 子插件一览

`plugins/<id>/index.js`，按契约暴露 `id / title / order / configSchema / setup`；**目录自动发现**，坏一个不影响其他。
控制台里每个子插件对应一页（`order` 决定排序）。

| order | id | 做什么 | 默认 |
|---:|---|---|---|
| 10 | `gate-wake` | **门禁与唤醒**：判断这条消息要不要叫醒它（@ / 叫名字 / 引用 / 接续窗口） | 开 |
| 15 | `anti-repeat` | 连续重复发言冷却 | 开 |
| 20 | `commands` | 斜杠命令（`/help` 等） | 开 |
| 20 | `private-friend-gate` | 私聊只回好友 | 开 |
| 30 | `file-transfer` | 把服务器本地图片发到 QQ（只发图，不发文件） | 开 |
| 40 | `persona-voice` | 人设固定句池、长回复拆条 | 开 |
| 44 | `video-read` | 群里直接发的视频 → 抽帧给模型看 | 开 |
| 45 | `video-link-read` | B站/抖音链接、**裸 BV 号** → 抽帧给模型看 | 开 |
| 47 | `video-wander` | **自己找视频看**：隔几小时自己挑一个 B 站视频看，写完感想私聊发给主人 | 开（自动看=关） |
| 50 | `voice` | **语音 / 曲库 / 唱歌**（本仓库定制）：TTS 念话；点歌 → 分离人声 → RVC 换音色 → 混回伴奏。**要 Python + RVC + 自备音色模型** | **关** |
| 55 | `group-welcome` | 新成员入群发欢迎图文 | 开 |
| 60 | `imagegen` | 生图 / 图生图 / 群头像 | 开 |
| 62 | `qzone` | **QQ 空间日记**：每天一条说说，写不写它自己判断；定时回顾见「空间工作区」 | 开 |
| 70 | `link-parser` | 把链接里的媒体直接搬进群（**需要自备解析侧车**） | **关** |
| 80 | `stickers` | 从表情库挑图发送 + 自动收集 | 开 |
| 90 | `group-memory` | 长期群记忆：这个群怎么叫醒它、该怎么回话、群友特点 | 开 |

> **默认关的只有两个，都因为「要额外装东西」**：
> - `voice`（本仓库定制）：要 Python + ffmpeg +（唱歌）RVC + 自备音色模型。依赖没配好就开着，每次调用都报错
> - `link-parser`：要自备解析侧车（本仓库 `sidecar/` 就是现成的）
>
> 别的子插件装上就能用。装法见 [docs/定制-语音唱歌与侧车.md](docs/定制-语音唱歌与侧车.md)。

> 「默认」指**装好后不碰配置时**的样子。每个子插件都能在控制台单独开关；
> 需要外部服务的（`link-parser` / 看视频两个）没装服务时会自己降级，不影响聊天。

## 前置要求

| 组件 | 要求 |
|---|---|
| Node.js | `>= 22` |
| DSH | `>= 0.2.1-rc.2 < 0.3.0`（`engines.dsh` 声明） |
| 协议端（任选其一） | 任意 **OneBot v11** 实现。实测能用的三种：<br>· **NapCat**（最常用，有 Docker 镜像 \`mlikiowa/napcat-docker\` 和 Windows 版；WebUI 默认 6099 扫码登录，token 在 WebUI 里设）<br>· **SnowLuma** v2.x（token 必填、不自己启动 QQ）<br>· **OneBot** 实现（token 可空）<br>都需开启**正向 WebSocket**（常见默认 3001）与 **HTTP API**（常见默认 3000），见 [安装与卸载 §二](docs/安装与卸载.md#二准备协议端onebot-v11) |
| QQ 号 | 协议端登录用（建议小号）；机器人靠它收发消息 |

## 安装

### ① 装插件（三选一）

```bash
# GitHub（推荐）—— 装的是本 fork 的定制版
dsh plugin --profile web add github:tangyu233-7312/dsh-onebot-qq#custom

# 想追上游原版（没有本仓库的定制）：
# dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq

# 本地 tgz（npm pack 产物）
dsh plugin --profile web add /abs/path/dsh-onebot-qq-0.1.1.tgz

# 本地目录（改代码立刻生效）
dsh plugin --profile web add link:/abs/path/dsh-onebot-qq
```

> `#custom` 是本 fork 的默认分支，写全更保险（万一将来默认分支变了，这行命令还是对的）。

也可以在 DSH 桌面端的「设置 → 插件」里填 GitHub 仓库地址安装。

> 装完还要「建数据目录 → 启动 → 控制台新手向导连协议端」才算跑通：完整步骤、升级、卸载、回滚见 [`docs/安装与卸载.md`](docs/安装与卸载.md)；Windows 见 [`docs/Windows安装.md`](docs/Windows安装.md)。

> **可选**：想让 QQ 线连**全局工具**（`ops_*` / agent-team / MCP 资源）也挡住，再装配套的独立插件 `dsh-onebot-qq-opsgate`：
> `dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq-opsgate`（必须装在 `dsh-onebot-qq` 之后）。
> 注意：本 fork **没有** fork 这个配套插件，它仍在原作者名下。
> 不装也能正常用，只是 QQ 会话的工具面更大，token消耗略微增加，可能导致群聊天时调用不该用的工具而产生风险。详见 [`docs/安装与卸载.md`](docs/安装与卸载.md)。

> **可选但本仓库已自带**：「看视频 / 看视频链接 / 自己找视频看 / 链接解析」需要本地解析侧车。
> 本仓库的 `sidecar/` 就是**现成实现**（零依赖 Node 脚本），只是**默认不启动**。
> 不跑侧车也完全不影响聊天，那几个功能会自己降级 —— 详见下节 [解析侧车](#解析侧车仓库自带不自动启动)。

## 快速开始（4 步）

1. 协议端登录 QQ，开启 WebSocket（默认 `ws://127.0.0.1:3001`）与 HTTP（默认 `http://127.0.0.1:3000`），记下 token
   （NapCat 在 WebUI 的「网络配置」里设；SnowLuma 必填；多数实现可空）。
2. DSH 设置 →「QQ 控制台」→「OneBot 连接」页（任意 OneBot v11 协议端都填这里）填地址/token → 点「测试 OneBot 连接」。
3. 「群聊」页顶部填**主人 QQ**（必填）→ 保存后自动连接。
4. 在 QQ 里 @ 机器人（或私聊）→ 有回复即可用。

> 首次启动缺 `adminQq` 会进入「待配置模式」：控制台和工具可用、不连协议端，填完自动连接。

## 控制台与人设

- **控制台**集成在 DSH 内置设置页：每个子插件一页，外加群聊 / 连接 / 消息设置 / 主动接话 / 其他几个核心页，改完即生效。
- **人设**可以直接让 AI 照随包的 `personas/_模板.md` 写一份；优秀程度看用心程度，推荐让模型多用示范对话。

## 解析侧车（仓库自带，不自动启动）

「链接解析 / 看视频 / 看视频链接 / 自己找视频看」这四个功能的**下载与抽帧后端**。

> **本仓库自带一套可用实现**（\`sidecar/\`，零依赖 Node 脚本）。
> 但它**不会自己启动** —— 要你用 \`sidecar/start.bat\` 手动起、或装成开机自启、或用 systemd。
> 不跑侧车也完全不影响聊天，那几个功能会自己降级。

### 「侧车」是什么

主插件只负责**在 QQ 里收发消息、拼提示词、调模型**。而「下载 B 站/抖音视频、用 ffmpeg 抽帧转码」这类活儿
需要额外装 Python/ffmpeg、可能还要登录 cookie，体积大、坑多，不适合塞进插件包，而且包内红线禁止 \`child_process\` ——
所以把它拆成**一个独立的小 HTTP 服务**跑在同一台机器上，插件通过 HTTP 调它干活。
这种「主程序旁边挂一个专职小服务」的做法叫 **sidecar（侧车）**：像摩托车的跨斗，自己不跑，但能载货。

### 哪些功能依赖它

| 功能 | 子插件 | 默认 | 调用的接口 | 没有侧车时 |
|---|---|---|---|---|
| **链接解析**（B站/抖音链接 → 直接把视频、图集发到群里） | \`link-parser\` | **关** | \`POST /parse\` | 链接按普通消息交给模型（模型只看到链接文字） |
| **看视频**（群里发的视频 → 抽几帧给模型看） | \`video-read\` | **开** | \`POST /read\` | 群里如实回一句「看视频的服务没起来」 |
| **看视频链接**（B 站/抖音链接、裸 BV 号 → 抽帧给模型看） | \`video-link-read\` | **开** | \`POST /read\` | 同上 |
| **自己找视频看**（隔几小时自己挑一个 B 站视频看，写感想发主人私聊） | \`video-wander\` | **开**（自动看=关） | \`POST /read\` | 拿不到帧就跳过这次，只记日志不打扰 |

> ⚠️ 后三个**插件默认是开的**：没跑侧车时，群里一出现视频/视频链接，机器人就会说「看视频的服务没起来，这视频我看不了」。
> 不想看到这句 → 控制台「文件与图片」页把开关关掉；想用 → 按下面把侧车跑起来。

### 跑起来（本仓库自带的这套）

**装什么：**

| 项 | 必需？ | 说明 |
|---|---|---|
| Node.js 18+ | ✅ | 侧车是零依赖 \`.mjs\`，只用内置模块 |
| **ffmpeg + ffprobe** | ✅ | 抽帧 / DASH 合流。\`sidecar.config.json\` 可指定路径，留空自动找 |
| **yt-dlp** | 链接解析要 | B站/抖音下载。可给可执行文件路径，或配 \`pythonPath\` 用 \`python -m yt_dlp\` |
| 磁盘 | — | 下载的视频按 TTL 自动清（默认帧 10 分钟、总量 2 GB 上限） |

**启动：**

\`\`\`bat
:: Windows
cd sidecar
start.bat                    :: 前台跑，关窗口就停
install-autostart.ps1        :: 或装成开机自启（计划任务）
\`\`\`

\`\`\`bash
# Linux / NAS
cd sidecar && node server.mjs
# 或写个 systemd 单元：ExecStart=/usr/bin/node /path/to/sidecar/server.mjs
\`\`\`

**自检：**

\`\`\`bash
curl http://127.0.0.1:3972/health
# 期望 {"ok":true,"ffmpeg":true,"ffprobe":true,"ytdlp":true,...}
\`\`\`

### 三个接口

| 接口 | 谁用 | 做什么 |
|---|---|---|
| \`GET /health\` | 控制台 / 自检 | 报 ffmpeg / yt-dlp 是否就位 |
| \`POST /read\` | \`video-read\` / \`video-link-read\` / \`video-wander\` | 下载（或本地路径）→ ffprobe 探时长 → ffmpeg 抽 N 帧 → 返回帧路径 |
| \`POST /parse\` | \`link-parser\` | 下载媒体 → 返回本地路径（由插件搬进群） |

请求 / 响应格式见 [\`sidecar/README.md\`](sidecar/README.md)。

> 想自己用 Python / Go 重写一个也行 —— 插件只认上面三个接口和约定的 \`code\` 字段：
> \`too_long\`（太长）/ \`too_big\`（太大）/ \`busy\`（正忙）/ \`nomatch\`（链接打不开）/ \`download_failed\`（下载失败）。

### 安全边界（改之前先读）

侧车是**群友能间接触发**的（发视频、贴链接），所以自带实现做了这些：

- **只绑 \`127.0.0.1\`**，不对外网开
- **域名白名单** \`allowedHosts\`：B站 / 抖音 / QQ 的 CDN 在列，其它一律拒
- **私网地址拒绝**：不许它去访问内网（防 SSRF）
- **本地路径白名单**：只读临时目录与 \`.dsh/dsh-onebot-qq\` 下的文件
- **失败一律 200 + \`ok:false\`**：让插件能干净降级，不是抛 500 让调用方猜
- **用完就删**：源视频几百 MB，按 TTL 与总量上限清

### 控制台在哪配

| 位置 | 要做什么 |
|---|---|
| 控制台 →「链接解析」页 | 打开「链接解析」；「侧车地址」填 \`http://127.0.0.1:3972\`（默认值） |
| 控制台 →「文件与图片」页 | 「让模型看视频内容」/「点开 B 站 / 抖音链接看视频」两个开关 + 各自的「侧车地址」 |
| 控制台 →「自己找视频看」页 | 侧车地址 + 抽几帧 + 最长时长等（自动看要单独开） |
| 配置键（手改 \`config.json\`） | \`pluginConfig.link-parser.parserUrl\`、\`pluginConfig.video-read.sidecarUrl\`、\`pluginConfig.video-link-read.sidecarUrl\`、\`pluginConfig.video-wander.sidecarUrl\` |

- 地址**留空 = 不解析/不看**（等于关掉该功能）；
- 侧车换端口/换机器也能用（跨机器就把 \`127.0.0.1\` 换成那台机器的内网 IP，**别暴露到公网**）；
- 插件侧还有一道 \`maxBytes\` 上限（\`link-parser\` 默认 100MB）。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | **功能手册总览（先看这个）**：按任务找文档 + 全部功能索引 |
| [`docs/使用说明书.md`](docs/使用说明书.md) | 功能怎么用：控制台、生图、表情、群记忆、人设与句池 |
| [`docs/安装与卸载.md`](docs/安装与卸载.md) | 安装 / 首次配置 / 升级 / 卸载 / 回滚 |
| [`docs/开发指南.md`](docs/开发指南.md) | 架构与子插件 SDK（贡献者 / 二次开发必读） |
| [`docs/定制-语音唱歌与侧车.md`](docs/定制-语音唱歌与侧车.md) | **本仓库定制**：语音/曲库/唱歌 + 解析侧车的安装、依赖、已知限制 |

其余文档（Windows、配置参考、排错、运维接口）统一从 [功能手册总览](docs/README.md) 进。

## 仓库里还有一块「不是插件」的东西

| 目录 | 是什么 | 默认 |
|---|---|---|
| \`sidecar/\` | **解析侧车**（见上一节） | 不启动 |
| \`tools/singing-pack/\` | **RVC 能力包**：唱歌用的推理脚本 + 安装脚本。**不含音色模型**（自己训练，已被 .gitignore 排除） | — |

两块都要额外装东西（ffmpeg / yt-dlp / Python / CUDA），所以默认都不跑。
装法、依赖清单、已知限制 → [docs/定制-语音唱歌与侧车.md](docs/定制-语音唱歌与侧车.md)。

## 隐私

- 包内**不含**任何真实 QQ 号、群号、token、API Key 或服务器路径；示例都是占位值。
- 运行数据（配置、人设、表情库、群记忆、日志）都在你自己的数据目录，不进仓库、不进 npm 包。

## License

[MIT](LICENSE)

---

> ⚠️ 请注意：本项目的主要贡献来自于蓝色大肥鱼——本人由于能力限制，仅通过不断“压力”大肥鱼来进行代码编写和部分细节调整。因此也诚邀同好者共同测试和维护。

> [!WARNING]
> 本插件和文档由 AI 生成，内容仅供参考，请仔细甄别。
