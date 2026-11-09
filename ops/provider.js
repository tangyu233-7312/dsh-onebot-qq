/**
 * ops/provider.js — **可选的运维能力**适配器（默认全 null；站点私有实现不进包）。
 *
 * 背景：控制台里「跑离线自检 / 清理临时文件 / 备份去重」这些动作
 * 天然依赖"某台机器上的脚本和 systemd/cron"，不能进通用插件包。这里只定义接口：
 *
 *   ops = { selfcheck, systemdProbe, cleanup, dedup, personaSwitch }
 *
 * 加载规则：
 *   · 默认读 `$DSH_HOME/dsh-onebot-qq/ops.local.mjs`（本机文件、gitignore、不进 npm 包）；
 *   · 环境变量 `DSH_QQ_OPS` 可覆盖路径（测试/多实例用）；
 *   · 文件不存在 → 返回**空实现**（所有方法 null），端点据此返回「本机未配置运维能力」；
 *   · 加载失败 / 方法调用抛错 → 记日志并降级为 null（**绝不把控制台整体拖垮**）。
 *
 * 文件形态（示例见 docs/运维接口.md）：默认导出对象，方法都是 async 函数，入参是端点 payload，
 * 返回值原样并入端点响应（建议带 `{ ok, message }`）。personaSwitch 例外：给了就用它切人设，
 * 否则用跨平台的 platform/persona-ref.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDataDir, resolveDshHome } from '../platform/paths.js'

/** 运维能力接口的固定方法名（缺哪个就留 null）。 */
export const OPS_METHODS = [
  'selfcheck',        // 离线自检：() => {ok, pass, fail, total, lines, message}
  'systemdProbe',     // 服务探针：() => {服务名: 'active'|'inactive'|...}（Windows 站点不实现）
  'cleanup',          // 清理临时文件：({confirm}) => {previewLines, message}
  'dedup',            // 备份代际去重：({confirm}) => {previewLines, message}
  // memoryAccumulate 2026-11-09 移除：群记忆下线，长期记忆由 long-memory 插件自己整理
  'personaSwitch',    // 本机自定义切人设：({name}) => {message}（不实现则走 platform/persona-ref）
]

/** 空实现：接口齐全、值全 null。 */
export function emptyOps() {
  const ops = { configured: false, file: '', error: '' }
  for (const name of OPS_METHODS) ops[name] = null
  return ops
}

/** 运维实现文件路径：`DSH_QQ_OPS` 优先，否则默认目录下的 ops.local.mjs（兼容旧名目录）。 */
export function resolveOpsFile({ env = process.env } = {}) {
  const configured = String(env.DSH_QQ_OPS || '').trim()
  if (configured) return path.resolve(configured)
  const home = resolveDshHome(env)
  const next = path.join(home, 'dsh-onebot-qq', 'ops.local.mjs')
  const legacy = path.join(home, 'dsh-qq-bot', 'ops.local.mjs')
  return (!fs.existsSync(next) && fs.existsSync(legacy)) ? legacy : next
}

/** 判断某个能力是否可用。 */
export function hasOps(ops, name) {
  return Boolean(ops && typeof ops[name] === 'function')
}

/**
 * 尝试加载本机 ops 实现；**永远返回一个完整的接口对象**（失败降级为 null 方法）。
 * @param {{log?:object, env?:NodeJS.ProcessEnv, dataDir?:string}} [opts]
 * @returns {Promise<object>} 见 OPS_METHODS；另有 `configured` / `file` / `error` 说明字段
 */
export async function loadOpsProvider({ log = console, env = process.env, dataDir = '' } = {}) {
  const ops = emptyOps()
  const file = resolveOpsFile({ env })
  ops.file = file

  const warn = (m) => { try { log?.warn?.(`[ops] ${m}`) } catch { /* ignore */ } }
  if (!fs.existsSync(file)) {
    ops.error = 'not-found'
    return ops
  }

  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (e) {
    ops.error = String(e?.message || e)
    warn(`加载 ${file} 失败：${ops.error}（运维能力按未配置处理）`)
    return ops
  }

  // 默认导出支持两种形态（都是站点私有文件的合理写法）：
  //   ① 普通对象 `export default { selfcheck(){...} }`
  //   ② 工厂函数 `export default function createOps({ log, env, dataDir }) { return {...} }`
  // 没有 default 时退回命名导出（`export async function selfcheck() {}`）。
  let raw = mod?.default !== undefined ? mod.default : mod
  if (typeof raw === 'function') {
    try {
      raw = await raw({ log, env, dataDir: dataDir || resolveDataDir('', env) })
    } catch (e) {
      ops.error = String(e?.message || e)
      warn(`ops 工厂函数执行失败：${ops.error}（运维能力按未配置处理）`)
      return ops
    }
  }
  if (!raw || typeof raw !== 'object') {
    ops.error = 'invalid-export'
    warn(`${file} 没有导出对象/工厂函数（运维能力按未配置处理）`)
    return ops
  }
  for (const name of OPS_METHODS) {
    const fn = raw?.[name]
    if (typeof fn !== 'function') continue
    ops[name] = async (...args) => {
      try {
        return await fn(...args)
      } catch (e) {
        warn(`${name} 调用失败：${e?.message || e}（本次按未配置处理）`)
        return null
      }
    }
  }
  ops.configured = OPS_METHODS.some((name) => typeof ops[name] === 'function')
  if (ops.configured) {
    try { log?.info?.(`[ops] 已加载本机运维能力：${OPS_METHODS.filter((n) => ops[n]).join(' / ')}`) } catch { /* ignore */ }
  } else {
    ops.error = 'empty'
    warn(`${file} 没有实现任何 ops 方法（可用：${OPS_METHODS.join(' / ')}）`)
  }
  return ops
}
