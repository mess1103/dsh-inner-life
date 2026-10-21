/**
 * Windows / Linux 都能跑的冒烟测试：真加载 index.js，把 8 个工具全调一遍。
 * 单测只覆盖 store 那一层；这一层验证「插件本身能不能起来、工具能不能注册、
 * 真写盘能不能读回来」。不需要装进 DSH profile。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'inner-smoke-'))
const registered = new Map()

// 假 ctx：只要 tools.register 和 effect
const config = {
  dir,
  hidden: true,
  salt: '',
  maxBytes: 8000,
  indexLimit: 4000,
}
const ctx = {
  tools: {
    register(def) {
      registered.set(def.name, def)
      return () => {}
    },
  },
  effect(fn) { fn() },
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}

const mod = await import('../index.js')

console.log('平台            :', process.platform, process.version)
console.log('插件导出        :', Object.keys(mod).join(', '))
// cordis 里的插件名是 `inner-life`（跟 cordis.patch.yml 的 id 对上），不是包名
assert.equal(mod.name, 'inner-life')
assert.deepEqual(mod.inject, ['tools'])

// Config 是 schemastery；pick() 会剥掉 volatile 访问器
const picked = mod.Config ? mod.Config(config) : config
await mod.apply(ctx, picked)

const want = ['inner_write', 'inner_read', 'inner_recent', 'inner_find', 'inner_search', 'inner_stats', 'inner_amend', 'inner_export']
const got = [...registered.keys()].sort()
console.log('注册的工具      :', got.join(' '))
assert.deepEqual(got, [...want].sort(), '8 个工具都要在')

// 每个工具都得有 description / parameters / execute
for (const [name, def] of registered) {
  assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
  assert.ok(def.description && def.description.length > 10, `${name} description 太短`)
  assert.equal(typeof def.parameters, 'object', `${name} 缺 parameters`)
}

const call = async (name, args = {}) => {
  const def = registered.get(name)
  if (!def) throw new Error(`没有工具 ${name}`)
  return def.execute(args, {})
}

// 1) 写
const w1 = await call('inner_write', { kind: 'mood', text: '冒烟测试第一条', mood: '说不上来', tags: ['测试'] })
assert.equal(w1.ok, true)
assert.equal(w1.kind, 'mood')
console.log('write           : ok，日期', w1.date)

// 2) 再写一条不同 kind
await call('inner_write', { kind: 'thought', text: '冒烟测试第二条' })

// 3) 读 —— 同一天内是**正序**（早上→晚上，顺着读才像日记）
const r = await call('inner_read', {})
assert.equal(r.count, 2)
assert.equal(r.entries[0].kind, 'mood', '同一天内正序：先写的在前')
assert.equal(r.entries[1].kind, 'thought')

// 4) 带 limit —— 取的是**尾巴**（最近几条），不是开头
const r2 = await call('inner_read', { limit: 1 })
assert.equal(r2.count, 1)
assert.equal(r2.total, 2)
assert.equal(r2.entries[0].kind, 'thought', 'limit 取尾巴')

// 5) find 给路径，且路径真的存在
const f = await call('inner_find', {})
assert.equal(existsSync(f.path), true, 'find 给的路径必须真实存在')
console.log('find            : ok，路径存在')

// 6) recent
const rec = await call('inner_recent', { days: 7 })
assert.equal(rec.count, 2)

// 7) search
const s = await call('inner_search', { query: '冒烟测试第一条' })
assert.equal(s.count, 1)

// 8) stats
const st = await call('inner_stats', {})
assert.equal(st.entries, 2)
assert.equal(st.wroteToday, true)
console.log('stats           : ok，连续', st.streak, '天')

// 9) amend
const a = await call('inner_amend', { text: '补一句', reason: '刚才漏了' })
assert.equal(a.ok, true)
assert.equal(a.kind, 'amend')

// 10) amend 之后原文还在
const after = await call('inner_read', {})
assert.equal(after.count, 3)
assert.equal(after.entries.some((e) => e.kind === 'amend'), true)

// 11) export
const ex = await call('inner_export', {})
assert.equal(ex.ok, true)
assert.equal(ex.count, 3)
assert.ok(ex.markdown.includes('## '), '导出里要有块头')
console.log('export          : ok，', ex.count, '条 /', ex.days, '天')

// 12) 隐藏路径确实是散开的，文件名看不出来
const dayPath = f.path
const rel = dayPath.slice(dir.length + 1)
const segs = rel.split(/[\\/]/)
assert.equal(segs.length, 3, '应该是 <4位>/<6位>/<日期>.md')
assert.match(segs[0], /^[0-9a-f]{4}$/)
assert.match(segs[1], /^[0-9a-f]{6}$/)
console.log('隐藏路径        : ok，', segs[0] + '/' + segs[1] + '/…')
assert.equal(rel.includes('inner-smoke'), false)

// 13) 索引里不能有路径
const idxPath = join(dir, '.index.jsonl')
if (existsSync(idxPath)) {
  const { readFileSync } = await import('node:fs')
  const lines = readFileSync(idxPath, 'utf8').trim().split('\n').filter(Boolean)
  for (const l of lines) {
    const o = JSON.parse(l)
    assert.equal('path' in o, false, '索引不许存路径')
  }
  console.log('索引            : ok，', lines.length, '条，不含路径')
}

// 14) 空正文 → 工具层不抛，回 {ok:false, error}（抛出去会打断 agent 的一轮）
const bad = await call('inner_write', { text: '   ' })
assert.equal(bad.ok, false)
assert.match(bad.error, /空的|没写/)
console.log('空正文          : ok，回 ok:false 而不是抛异常')

// 15) 不存在的日子不能 amend
const bad2 = await call('inner_amend', { text: 'x', date: '2020-01-01' })
assert.equal(bad2.ok, false)
assert.match(bad2.error, /没写过/)

rmSync(dir, { recursive: true, force: true })
console.log('\n全部通过（' + process.platform + ' / node ' + process.version + '）')
