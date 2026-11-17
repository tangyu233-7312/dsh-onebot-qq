# dsh-onebot-qq

运行在 DSH 中的 QQ 机器人，通过 OneBot v11 协议连接 QQ，支持聊天、人设、生图、长期记忆、视频理解和语音唱歌。支持 Linux / Windows；日常配置集中在 DSH 设置里的「QQ 控制台」。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-7c3aed)

这是 [YUsaltyfish/dsh-onebot-qq](https://github.com/YUsaltyfish/dsh-onebot-qq) 的定制 fork。**定制版在 `custom` 分支，安装时请显式指定 `#custom`。** 功能说明以本分支代码为准，不把历史上与上游的差异当作永久不变的清单。

先配置基础聊天，再按需开启生图、视频、语音等能力。**功能开关、插件是否加载、外部服务是否就绪是三件不同的事**；不是所有模块装上就能直接用。

| 要做什么 | 看哪里 |
|---|---|
| 第一次安装 / 升级 / 卸载 | [安装与卸载](docs/安装与卸载.md) · [Windows 安装](docs/Windows安装.md) |
| 查功能、配置或排错 | [文档总览](docs/README.md) · [使用说明书](docs/使用说明书.md) · [配置参考](docs/配置参考.md) |
| 配语音、唱歌、PC 算力或视频侧车 | [语音唱歌与解析侧车](docs/定制-语音唱歌与侧车.md) |
| 改代码 / 接手维护 | [开发指南](docs/开发指南.md) · [维护与交接](docs/维护与交接.md) |

## 安装与快速开始

| 组件 | 要求 |
|---|---|
| Node.js | `>= 22` |
| DSH | `>= 0.2.1-rc.2 < 0.3.0`，并配置可用的聊天模型 |
| QQ 协议端 | 兼容 OneBot v11，提供正向 WebSocket 与 HTTP API；可使用 [NapCat](https://github.com/NapNeko/NapCatQQ)，其他实现按接口兼容性配置 |
| QQ 账号 | 在协议端登录，用于机器人收发消息 |

~~~sh
# 安装本 fork 的定制版
dsh plugin --profile web add github:tangyu233-7312/dsh-onebot-qq#custom

# 也可以安装本地 npm pack 产物，或链接开发目录（二选一）
# dsh plugin --profile web add /abs/path/dsh-onebot-qq-0.1.1.tgz
# dsh plugin --profile web add link:/abs/path/dsh-onebot-qq
~~~

`web` 是示例 profile；请使用实际运行机器人的 profile。配置数据目录、启动 DSH 的完整步骤见 [安装与卸载](docs/安装与卸载.md)。

1. 在协议端登录 QQ，开启 WebSocket 和 HTTP API，记录地址及 token。常见地址是 `ws://127.0.0.1:3001`、`http://127.0.0.1:3000`，以协议端配置为准。
2. 打开 DSH 设置 →「QQ 控制台」，按新手向导填写主人 QQ 和连接信息。
3. 保存并测试连接；确认机器人在线后，在 QQ 中 @ 它或私聊测试回复。

首次缺少主人 QQ 时会进入待配置模式，控制台仍可用。协议端与 DSH 不在同一台机器或容器时，需要填写 DSH 实际能访问的地址。

如果需要限制 QQ 会话能访问的全局工具，可另装上游的 `dsh-onebot-qq-opsgate`，详见 [安装与卸载](docs/安装与卸载.md)。

## 按需开启的能力

下表是代码默认值，不代表已有实例的当前设置。插件加载由「子插件」页管理，各功能还有自己的开关、权限和额度。

| 能力 | 默认或启用条件 | 需要准备什么 |
|---|---|---|
| **语音 / 唱歌** | `ttsEnabled`、`singEnabled` 分别默认关闭；语音插件本身正常加载 | 可接外部 PC 算力网关，或在机器人所在机器准备 TTS、RVC、音色和转码环境 |
| **曲库收集** | `autoLibrary` 默认开启，与语音、唱歌开关独立 | 可写的曲库目录；不需要自动收音频时关闭此项 |
| **看视频 / B 站链接与 BV 号** | 视频理解功能默认开启；定时自己找视频看默认关闭 | 解析侧车、ffmpeg/ffprobe、按需安装 yt-dlp，以及能处理图片的模型；当前链接平台以 B 站为主，抖音支持已下线 |
| **链接媒体搬运** | `link-parser.enabled` 默认关闭 | 同一套解析侧车，将下载的媒体发送到 QQ |
| **侧车自动启动** | `sidecar-control.autoStart` 默认关闭 | 配好侧车目录后，可用控制台或主人命令 `/sidecar start` 手动启动，也可开启自动拉起 |
| **生图 / 图生图** | 配置好至少一个生图来源才可用 | 本机或远端 ComfyUI，或兼容的生图 API；可配置备用来源 |
| **长期记忆 / 语气守卫** | 按各自开关和作用域工作；长期记忆默认只记私聊 | 各自的模型接口配置；接口调用可能产生费用 |

**NAS 可以只运行机器人，把语音、唱歌和 silk 转码交给 PC。** 网关、Worker、音色模型和相关 Python 依赖放在计算端；PC QQ 机器人无需启动。远端失败时插件会尝试本机回落，本机缺少依赖时仍会失败。网关程序不包含在本仓库中。

当前本机语音链路使用 MiMo TTS 后接 RVC，不能把“脚本支持 edge-tts”理解为“只装 edge-tts 就能运行当前语音功能”。详细依赖与接口见 [语音唱歌与解析侧车](docs/定制-语音唱歌与侧车.md)。

## 子插件一览

插件由 `plugins/<id>/index.js` 自动发现。**控制台按功能归组，插件与页签不是一一对应**；具体开关、默认值和加载错误以控制台及代码为准。

| 模块 | 子插件 | 能力 |
|---|---|---|
| 唤醒与权限 | `gate-wake`、`commands`、`private-friend-gate` | @、引用、唤醒词、基础命令、好友准入 |
| 发言节奏 | `anti-repeat`、`tone-guard` | 重复消息冷却、按语境处理辱骂与垃圾消息 |
| 人设与表达 | `persona-voice`、`persona-version` | 固定句池、回复拆条、人设读取与版本管理 |
| 媒体与图片 | `file-transfer`、`imagegen`、`stickers` | 收取媒体、发送图片、生图/改图、头像和表情库 |
| 视频理解 | `video-read`、`video-link-read`、`video-wander` | 看视频附件、B 站链接/BV 号、按需或定时观看 |
| 侧车与解析 | `sidecar-control`、`link-parser` | 侧车状态与启动管理、下载链接媒体 |
| 语音与唱歌 | `voice` | 语音输出、曲库管理、RVC 翻唱、本机或 PC 网关计算 |
| 记忆与自我记录 | `long-memory`、`self-view` | 长期记忆整理/衰减/召回、群摘要与跨会话流水账 |
| 群与空间 | `group-welcome`、`qzone` | 入群欢迎、QQ 空间日记及发布记录 |

主动接话、合批和静默时段由内核与配置协同处理。内置「蓝色大肥鱼」示例人设和 [人设模板](examples/personas/_模板.md)，可在控制台管理；更换人设及旧会话生效问题见 [使用说明书](docs/使用说明书.md) 和 [维护与交接](docs/维护与交接.md)。

`watch_now` 将画面交给当前会话里的模型理解；`watch_video` 走后台观看流程。跨会话流水账记录机器人做过的事，并可保留它自己的视频感想；这与存储聊天要点的长期记忆是不同模块，详见 [一个脑子](docs/一个脑子.md)。

## 仓库、发布包与外部程序

| 位置 | 内容 | 交付方式 |
|---|---|---|
| `kernel/`、`admin/`、`platform/`、`plugins/` | DSH 插件内核、控制台与子插件 | 随插件包发布，在 DSH 进程内运行 |
| `docs/`、`examples/` | 通用文档、配置与人设示例 | 随插件包发布 |
| `sidecar/` | 视频下载、抽帧和解析 HTTP 服务 | Git 仓库中提供，当前 npm 包不含；另行部署，见 [侧车说明](sidecar/README.md) |
| `tools/singing-pack/` | RVC 推理与安装脚本 | Git 仓库中提供，当前 npm 包不含；不附带音色模型或曲库 |
| PC 算力网关 / Worker | 接收语音和唱歌任务的计算服务 | 外部程序，仓库只提供插件侧接入 |

解析侧车默认监听 `127.0.0.1:3972`，需要 Node.js 22+、ffmpeg/ffprobe，下载 B 站视频时还需要 yt-dlp。它返回本地媒体路径，通常与机器人部署在同一文件系统；跨机器部署不能只改一个 IP，还需解决文件可达性。

## 开发与发布检查

~~~sh
npm run verify
node scripts/check-no-secrets.mjs --tracked
node scripts/check-doc-links.mjs
~~~

`verify` 包含测试、语法、发布文件脱敏和打包检查。`--tracked` 补查所有 Git 跟踪文件；新增文件先精确暂存，待推送的历史提交另行审查。检查范围和多处安装核验流程见 [维护与交接](docs/维护与交接.md)。

实例配置、真实 QQ/群号、密钥、聊天数据、音色模型和本地部署备份不应提交。文档使用占位值，运行数据保留在实例数据目录。

## License

[MIT](LICENSE)
