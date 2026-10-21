/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/schemastery`（拿不到就降级）
 * ============================================================================
 * 🔴 为什么不能裸 import：
 *    `@deepseek-ai/schemastery` 在多数插件里是 **optional peer**，桌面版 profile 用
 *    `autoInstallPeers: false` ⇒ 永远不装 ⇒ 裸 import 会让**整条插件不激活**，
 *    只在日志里留一句 `1 entry did not activate … failed to import`。
 *    为了一个「设置页」把整个插件搞挂，不值。
 *
 * ⭐ 策略：① 先按几处常见位置找宿主那份（跟宿主同一份，行为最一致）
 *          ② 再裸 import 一次
 *          ③ 都不行 → 返回 null，**插件照常跑**，只是没有 Config（设置页降级，走默认值/环境变量）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai/*` 的地方（按可能性排序，不写死某一台机器） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  // Linux / macOS 的全局安装
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有时这些包被别的插件 hoist 到了 profile 根上
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // 宿主自己的树：从正在跑的那个 CLI 脚本（process.argv[1]）往上找
  // —— 便携版 / 绿色版 / 自定义安装位置都能命中，不依赖 APPDATA
  try {
    let p = process.argv[1] ? dirname(process.argv[1]) : ''
    for (let i = 0; i < 6 && p && p !== dirname(p); i += 1) {
      push(join(p, 'node_modules', '@deepseek-ai'))
      push(join(p, '@deepseek-ai'))
      p = dirname(p)
    }
  } catch { /* 没有就算了 */ }

  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function resolveOne(name) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try { return await import(url) } catch { /* 试下一个 */ }
  }
  try { return await import(name) } catch { return null }
}

/**
 * 取回宿主半端要的东西。
 * @returns {Promise<{z:any, defineTool:Function, notes:string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const zMod = await resolveOne('schemastery')
  const z = zMod?.default ?? zMod ?? null
  if (!z) notes.push('schemastery 拿不到 —— 没有 Config，走默认值/环境变量（插件本体照常跑）')

  const dtMod = await resolveOne('dsh-tools')
  const hostDefine = dtMod?.defineTool
  // 宿主的 defineTool 会做 spec→JSON Schema 与参数校验；拿不到就用等价实现：
  // 我们的 parameters 本来就是标准 JSON Schema，这里只补一条 object 必须写 additionalProperties 的校验。
  const defineTool = typeof hostDefine === 'function'
    ? hostDefine
    : (options) => {
      const check = (schema, where) => {
        if (!schema || typeof schema !== 'object') return
        if (schema.type === 'object' && schema.additionalProperties === undefined) {
          throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
        }
        for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
      }
      check(options.parameters, 'parameters')
      check(options.output?.schema, 'output.schema')
      return options
    }
  if (typeof hostDefine !== 'function') notes.push('dsh-tools 拿不到 —— defineTool 用本地等价实现')

  return { z, defineTool, notes }
}
