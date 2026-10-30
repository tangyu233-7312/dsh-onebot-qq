/**
 * sidecar-control — 侧车运维（id: 'sidecar-control', order: 5）
 *
 * 干什么：
 *   ① **自动拉起侧车**：插件加载时 ping 一次 `/health`，连不上就自己把它拉起来，
 *      之后每 5 分钟复查一次（挂了自动重启）。用户不需要去数据目录里找 start.bat 双击。
 *   ② **补配置**：侧车第一次跑时如果 `sidecar.config.json` 里 `pythonPath` 空着，
 *      这里会填上「DSH 宿主用的 node」旁边能找到的 python（找不到就不填，侧车照样能跑 B 站，
 *      只是抖音会失败）——免得用户手上还得改 JSON。
 *   ③ **`/sidecar` 命令**（仅主人）：`status` / `start` / `stop` / `restart` / `log`。
 *
 * ⚠️ **这是唯一一处故意破包内红线的代码**：`plugins/` 里禁 `child_process`，
 *    而"自动拉起一个外部进程"只能靠它。为什么明知故犯：
 *      · 侧车必须跑 ffmpeg / yt-dlp，插件进程内不许 spawn；
 *      · 子插件拿不到 ops provider（`bot` 上没有 `ops`），没法走"运维能力"那条正路；
 *      · 作者的控制台按钮表 `admin/schema.js` 的 `ACTIONS` 是硬编码的，插件注册不了按钮。
 *    所以：**本插件是站点自用插件，不要提交给作者**。想让它进包，需要作者给插件开一个
 *    "注册控制台动作 / 拿到 ops provider"的口子（README 里已写成建议）。
 *
 * 纪律：
 *   · 只在 `autoStart` 开时才自动拉起；失败只记日志，**绝不影响聊天**。
 *   · 拉起的进程 `detached + unref`：DSH 重启时侧车不会跟着反复重启/端口抢占。
 *   · 进程级去抖：30 秒内最多尝试一次；失败后 5 分钟再试。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { writeJsonFileSync } from '../../platform/atomic.js'

const BOOT_DEBOUNCE_MS = 30_000
const RECHECK_MS = 5 * 60_000

export default {
  id: 'sidecar-control',
  title: '侧车运维',
  order: 5,

  configSchema: {
    // ⚠️ 键名不能叫 enabled（2026-10-30 踩过）：
    //    DSH 内核把插件配置里的 enabled 当作「插件是否加载」的开关，而这个字段的本意是
    //    「要不要自动拉起侧车」。两者同名 → 用户关掉自启动，插件直接不加载，
    //    控制台的「运维」页跟着消失，连手动按钮和 /sidecar 命令都没了。
    //    改名 autoStart 后：插件常驻，自动运维默认关（PC 上原本就是这个意图）。
    autoStart: {
      type: 'bool', default: false, group: '运维',
      label: '自动拉起侧车',
      hint: '开：插件启动时 ping 一次侧车，连不上就自己把它拉起来（每 5 分钟复查，挂了自动重启）；'
        + '关（默认）：**插件不碰侧车** —— 不 ping、不定时检测、不自动重启，全部靠你自己'
        + '（控制台「运维」页的按钮，或 QQ 里发 /sidecar start）。',
    },
    sidecarUrl: {
      type: 'str', default: 'http://127.0.0.1:3972', group: '运维',
      label: '侧车地址',
      hint: '要跟 sidecar.config.json 的 port 一致。',
    },
    sidecarDir: {
      type: 'str', default: 'sidecar', group: '运维',
      label: '侧车目录',
      hint: '数据目录下的子目录名（默认 sidecar，里面应有 server.mjs）。',
    },
    prepareConfig: {
      type: 'bool', default: true, group: '运维',
      label: '首次自动补配置',
      hint: '开：发现 sidecar.config.json 的 pythonPath 为空时，自动探测本机 python 并填进去'
        + '（只填一次，之后你自己改了不会被覆盖）。找不到就不填。',
    },
    nodePath: {
      type: 'str', default: '', group: '运维',
      label: 'node 路径（留空 = 自动探测）',
      hint: '跑侧车用的 node。留空时依次找：DSH 自带 runtime → 宿主同级 → PATH。'
        + '插件跑在 Electron 宿主里，process.execPath 是 GUI 程序不能拿来跑脚本，所以必须解析出真正的 node。',
    },
    pythonPath: {
      type: 'str', default: '', group: '运维',
      label: 'python 路径（留空 = 自动探测）',
      hint: '侧车跑 yt-dlp 用。留空时按「DSH 自带 node 同级 → PATH → 常见安装位置」顺序找。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const urlOf = () => String(cfg().sidecarUrl || '').trim()
    /**
     * 侧车目录：⚠️ 内核的 `resolveRuntimePaths` 已经把**所有以 dir/file/path 结尾的键**
     * 按 dataDir 解析成绝对路径了（见 kernel/config-store.js）。所以这里**先判绝对路径**，
     * 否则会拼成 `<dataDir>\<绝对路径>` 这种重复路径 —— 那就是"找不到侧车"的真因。
     */
    const dirOf = () => {
      const raw = String(cfg().sidecarDir || 'sidecar').trim() || 'sidecar'
      if (path.isAbsolute(raw)) return raw
      return path.join(String(bot.core?.dataDir || '.'), raw)
    }
    const serverOf = () => path.join(dirOf(), 'server.mjs')
    const runFileOf = () => path.join(dirOf(), 'run.json')

    let lastTry = 0
    let timer = null
    let lastErr = ''   // 最近一次拉起失败的原始原因（回传给按钮，别只说「失败」）

    /**
     * 排障轨迹：把「为什么起不来」落到文件，不用靠猜、也不用翻宿主日志。
     * 位置：<数据目录>/sidecar/trace.log（跟侧车同一个目录，好找）。
     */
    function trace(...parts) {
      const line = new Date().toISOString() + ' ' + parts.join(' ') + '\n'
      // ① 系统临时目录：**绝对路径**，不依赖 dataDir/cwd —— 唯一保证能写的地方
      try { fs.appendFileSync(path.join(os.tmpdir(), 'qq-sidecar-control-trace.log'), line) } catch { /* */ }
      // ② 侧车目录（方便和 server.mjs 放一起看）；dataDir 解析错时这里会失败，但不影响①
      try { fs.appendFileSync(path.join(dirOf(), 'trace.log'), line) } catch { /* */ }
    }

    const logInfo = (m) => bot.log.info(`[侧车] ${m}`)
    const logWarn = (m) => bot.log.warn(`[侧车] ${m}`)

    async function health() {
      if (!urlOf()) return { up: false, why: '没配地址' }
      try {
        const r = await fetch(`${urlOf().replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2500) })
        if (!r.ok) return { up: false, why: `HTTP ${r.status}` }
        return { up: true, body: await r.json() }
      } catch (e) {
        return { up: false, why: e.name === 'TimeoutError' || e.name === 'AbortError' ? '超时' : e.message }
      }
    }

    /**
     * 首次补配置：pythonPath 空着就探测一个填进去。
     * 只在**用户没写过**（字段不存在或是空串）时填，绝不动用户已经设好的值。
     */
    function prepareSidecarConfig() {
      if (cfg().prepareConfig === false) return
      const file = path.join(dirOf(), 'sidecar.config.json')
      try {
        if (!fs.existsSync(file)) return
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
        if (String(raw.pythonPath || '').trim()) return          // 用户已经填了 → 不动
        if (String(cfg().pythonPath || '').trim()) {
          raw.pythonPath = String(cfg().pythonPath).trim()
          writeJsonFileSync(file, raw)
          logInfo(`已把 pythonPath 写进 sidecar.config.json`)
          return
        }
        const found = findPython()
        if (!found) {
          logInfo('没探测到 python：B 站照常能用，抖音链接会失败（可在配置里手动填 pythonPath）')
          return
        }
        raw.pythonPath = found
        writeJsonFileSync(file, raw)
        logInfo(`已自动探测并写入 pythonPath: ${found}`)
      } catch (e) {
        logWarn(`补配置失败（不影响运行）: ${e.message}`)
      }
    }

    /**
     * 找 node 可执行文件（**关键**）：插件跑在 Electron 宿主里，`process.execPath` 是
     * "DeepSeek Harness.exe"，用它 spawn 只会起个 GUI/静默退出，永远起不来侧车。
     * 优先级：配置 → 环境变量 → DSH 自带 runtime → 宿主同级/上级 → `where node` → PATH。
     */
    function findNode() {
      const cands = []
      if (String(cfg().nodePath || '').trim()) cands.push(String(cfg().nodePath).trim())
      if (process.env.DSH_NODE) cands.push(process.env.DSH_NODE)
      // DSH 自带的 runtime（实测位置：<app>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe）
      try {
        const appDir = path.resolve(path.dirname(process.execPath), 'resources', 'runtime')
        for (const d of fs.readdirSync(appDir)) {
          cands.push(path.join(appDir, d, 'dependencies', 'node', 'bin', 'node.exe'))
        }
      } catch { /* 没有就算了 */ }
      // 宿主同级/上级（dev 模式 / 便携版）
      const exeDir = path.dirname(process.execPath)
      cands.push(path.join(exeDir, 'node.exe'), path.join(exeDir, '..', 'node.exe'))
      // 只有 execPath 本身就是 node 时才用（判据：文件名）
      if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) cands.push(process.execPath)
      for (const c of cands) {
        try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c } catch { /* 忽略 */ }
      }
      // 最后交给 PATH 里的 node
      return 'node'
    }

    /** 找 python：配置 → DSH node 的同级/上级 → PATH → 常见安装位置 */
    function findPython() {
      const cands = []
      const nodeDir = path.dirname(process.execPath)
      for (const rel of ['python.exe', '../../../python/python.exe', '../../python/python.exe']) {
        cands.push(path.resolve(nodeDir, rel))
      }
      const envPy = process.env.PYTHON || process.env.PYTHON_PATH
      if (envPy) cands.push(envPy)
      for (const p of ['E:\\Python\\Envirment\\python.exe', 'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe']) cands.push(p)
      for (const c of cands) {
        try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c } catch { /* 忽略 */ }
      }
      return ''
    }

    /** 把侧车拉起来（幂等：已经在跑就直接返回） */
    async function startSidecar({ force = false } = {}) {
      const h = await health()
      if (h.up) return { ok: true, already: true }
      if (!force && Date.now() - lastTry < BOOT_DEBOUNCE_MS) return { ok: false, why: '刚试过，等一会儿' }
      lastTry = Date.now()

      const server = serverOf()
      if (!fs.existsSync(server)) {
        trace('server MISSING: ' + server)
        throw new Error(`找不到侧车：${server}（把 sidecar 目录放到数据目录下，或改「侧车目录」配置）`)
      }
      prepareSidecarConfig()

      const nodeBin = findNode()
      trace('start: execPath=' + process.execPath, 'node=' + nodeBin, 'server=' + server, 'cwd=' + dirOf())
      if (!/node/i.test(path.basename(nodeBin))) {
        // 走到这里说明没找到 node —— 直接用 execPath 会有"没返回"的玄学失败，这里先喊清楚
        logWarn(`没找到 node 可执行文件（当前 execPath=${process.execPath}），侧车无法拉起。请在「侧车运维」里填 nodePath`)
      }
      // ⚠️ Windows 上 `detached: true` **不保证**子进程活过父进程（Linux 才保证）。
      //    实测 DSH 一关侧车就跟着没了。所以 Windows 用 `cmd /c start /b` 起独立会话，
      //    父进程树断得干净 —— 这样 DSH 重启不会把侧车带走。
      let child
      if (process.platform === 'win32') {
        child = spawn('cmd.exe', ['/c', 'start', '/b', nodeBin, server], {
          cwd: dirOf(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env },
        })
        child.unref()
        trace('spawn via cmd/start ok（cmd 包装进程 pid=' + child.pid + '）')
      } else {
        child = spawn(nodeBin, [server], {
          cwd: dirOf(),
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        })
        child.unref()
        trace('spawn ok pid=' + child.pid)
      }
      child.on('error', (e) => { trace('spawn error: ' + (e && e.message)); lastErr = '起不来子进程: ' + (e && e.message) })
      // 记账：等 health 通了再用真实的监听 PID（cmd/start 返回的是包装进程，不能记它）
      const recordPid = (realPid) => {
        try {
          writeJsonFileSync(runFileOf(), { pid: realPid, startedAt: new Date().toISOString(), url: urlOf() })
        } catch { /* 记账失败不影响启动 */ }
      }
      logInfo(`已拉起侧车（node=${nodeBin}，${server}）`)

      // 最多等 8 秒确认它真的起来了
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const h2 = await health()
        if (h2.up) {
          const realPid = await findListeningPid()
          if (realPid) recordPid(realPid)
          logInfo(`侧车就绪：ffmpeg=${h2.body?.ffmpeg} ffprobe=${h2.body?.ffprobe} 队列=${JSON.stringify(h2.body?.queue || {})} pid=${realPid || child.pid}`)
          trace('health ok, realPid=' + (realPid || child.pid))
          return { ok: true, started: true, pid: realPid || child.pid, health: h2.body }
        }
      }
      logWarn('侧车进程起来了但 /health 一直不通（看 sidecar\\sidecar.log 或手跑一次 start.bat 看报错）')
      trace('health timeout after spawn')
      return { ok: false, why: '启动后 /health 不通' }
    }

    /** 拿"正在监听侧车端口"的真实 PID（cmd/start 返回的是包装进程，不能用它做记录） */
    async function findListeningPid() {
      const port = String(new URL(urlOf()).port || 80)
      return await new Promise((resolve) => {
        try {
          execFile('netstat', ['-ano'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(0)
            const line = String(stdout).split(/\r?\n/)
              .find((l) => l.includes(':' + port) && /LISTENING/i.test(l))
            const m = line && line.trim().split(/\s+/).pop()
            resolve(Number(m) || 0)
          })
        } catch { resolve(0) }
      })
    }

    /** 停掉**我们拉起的**那个（别人的/手动启动的，不去 kill） */
    async function stopSidecar() {
      let pid = 0
      try { pid = Number(JSON.parse(fs.readFileSync(runFileOf(), 'utf8')).pid) || 0 } catch { /* 没记录 */ }
      if (!pid) return { ok: false, why: '没有"由插件拉起"的运行记录；如果是手动启动的，请用 stop.bat 或关掉那个窗口' }
      try {
        process.kill(pid)
        fs.rmSync(runFileOf(), { force: true })
        logInfo(`已停止侧车 pid=${pid}`)
        return { ok: true, pid }
      } catch (e) {
        return { ok: false, why: `kill 失败: ${e.message}` }
      }
    }

    async function ensureUp({ force = false } = {}) {
      const h = await health()
      if (h.up) return true
      if (cfg().autoStart !== true) return false
      try {
        const r = await startSidecar({ force })
        if (r.ok !== true) lastErr = String(r.why || '启动后没能就绪')
        return r.ok === true
      } catch (e) {
        lastErr = String(e && e.message ? e.message : e)
        logWarn(`拉起失败: ${lastErr}`)
        return false
      }
    }

    // ── 自动运维（可整体关闭）────────────────────────────────
    // autoStart: false（默认）= 用户要"全手动"：不 ping、不建定时器、不自动重启。
    // 手动入口（控制台按钮 / /sidecar 命令 / bot.state.sidecar）全部照常工作。
    if (cfg().autoStart === true) {
      // 启动时自检一次（异步，别挡内核装配）
      if (urlOf()) {
        setTimeout(() => { ensureUp().catch(() => {}) }, 3000).unref?.()
      }
      // 每 5 分钟复查：挂了就重启
      timer = setInterval(() => { ensureUp().catch(() => {}) }, RECHECK_MS)
      timer.unref?.()
      trace('auto-on', '启动自检 + 每 ' + Math.round(RECHECK_MS / 60000) + ' 分钟复查已启用')
    } else {
      trace('auto-off', '自动运维未开启：不 ping、不定时检测，全部手动')
      logInfo('自动运维未开启（autoStart=false）：侧车完全由你手动控制')
    }

    // ── `/sidecar` 命令（仅主人）：这就是"控制台那个按钮"在 QQ 里的等价物 ──
    bot.registerCommand('sidecar', {
      permission: 'master',
      description: '侧车运维：/sidecar [status|start|stop|restart|log]',
      async handler(_ev, args) {
        const act = String(args?.[0] || 'status').toLowerCase()
        const reply = async (text) => bot.deliver(_ev.chatKey, text)
        if (act === 'start') {
          const r = await startSidecar({ force: true })
          await reply(r.ok ? `✅ 侧车已就绪${r.already ? '（本来就在跑）' : `（pid ${r.pid}）`}` : `⚠️ 起不来：${r.why}`)
          return
        }
        if (act === 'stop') {
          const r = await stopSidecar()
          await reply(r.ok ? `🛑 已停止（pid ${r.pid}）` : `⚠️ ${r.why}`)
          return
        }
        if (act === 'restart') {
          await stopSidecar()
          await new Promise((r) => setTimeout(r, 800))
          const r = await startSidecar({ force: true })
          await reply(r.ok ? `🔄 已重启（pid ${r.pid}）` : `⚠️ 起不来：${r.why}`)
          return
        }
        if (act === 'log') {
          const file = path.join(dirOf(), 'sidecar.log')
          let text = ''
          try { text = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-15).join('\n') } catch { /* 没有日志 */ }
          await reply(text ? `📄 最近日志：\n${text}` : '没有 sidecar.log（当前是控制台/隐藏窗口模式，日志在那边）')
          return
        }
        const h = await health()
        await reply(h.up
          ? `🟢 侧车在线\nffmpeg=${h.body?.ffmpeg} ffprobe=${h.body?.ffprobe}\n队列=${JSON.stringify(h.body?.queue || {})}\n目录=${dirOf()}`
          : `🔴 侧车离线（${h.why}）\n目录=${dirOf()}\n发 /sidecar start 让我拉起来`)
      },
    })

    // ── 把控制器挂到共享 state 上：控制台「链接解析」页那几个按钮就是调它 ──
    // 为什么挂 state：`kernel.state` 是内核暴露给 admin 端点的同一个对象
    // （`index.js:390` 的 kernel 字面量里有 `state`），插件唯一能写、面板能读的干净交集。
    // 没有它，按钮就只能是"未安装侧车控制插件"。
    try {
      const st = bot.state
      if (st && typeof st === 'object') {
        const guard = (name, fn) => async () => {
          // 进来就记：按钮确实调到了控制器，以及它看到的路径是什么
          trace('ctl.' + name + ' enter', 'dataDir=' + String(bot.core?.dataDir || ''),
            'sidecarDir=' + String(cfg().sidecarDir || ''), 'server=' + serverOf(),
            'url=' + urlOf(), 'execPath=' + process.execPath)
          try { return await fn() } catch (e) {
            const msg = String(e && e.message ? e.message : e)
            lastErr = name + ': ' + msg
            trace('ctl.' + name + ' threw: ' + msg)
            logWarn(`${name} 失败: ${msg}`)
            return { ok: false, why: lastErr }
          }
        }
        st.sidecar = {
          status: async () => {
            const h = await health()
            return {
              online: h.up,
              why: h.up ? '' : h.why,
              dir: dirOf(),
              ffmpeg: h.body?.ffmpeg ?? null,
              ffprobe: h.body?.ffprobe ?? null,
              ytdlp: h.body?.ytdlp ?? null,
              queue: h.body?.queue ?? null,
              version: h.body?.version ?? '',
            }
          },
          start: guard('start', async () => {
            const r = await startSidecar({ force: true })
            return {
              ok: r.ok, already: r.already === true, pid: r.pid ?? null,
              why: r.why || lastErr || '', health: r.health ?? null,
            }
          }),
          stop: guard('stop', async () => {
            const r = await stopSidecar()
            return { ok: r.ok, pid: r.pid ?? null, why: r.why || '' }
          }),
          restart: guard('restart', async () => {
            const s = await stopSidecar()
            await new Promise((r) => setTimeout(r, 800))
            const r = await startSidecar({ force: true })
            return { ok: r.ok, pid: r.pid ?? null, stopped: s.ok, why: r.why || lastErr || '' }
          }),
        }
        logInfo('已把侧车控制器挂到 state.sidecar（控制台「链接解析」页按钮可用）')
      }
    } catch (e) {
      logWarn(`挂控制器失败（按钮会显示未安装）: ${e.message}`)
    }

    // ── 卸载：只清定时器，不杀侧车（它可能正被别的进程用着） ──
    bot.onClose?.({ close() { if (timer) clearInterval(timer) } })
  },
}
