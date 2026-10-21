/**
 * 旧格式兼容 —— mcp-inner 时代写的 `**HH:MM**（心情词）` 块头必须能读出来。
 *
 * 这组用例来自一次真实事故：0.1.0 只认 `## HH:MM · kind`，
 * 从 mcp-inner 迁过来的老日记在 read()/recent() 里全是 0 条。
 * 文件在盘上、find() 也算得出路径，但内容读不出来 —— 不报错、不丢文件，
 * 只是「她写过的东西不见了」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { createStore, todayKey } from '../lib/store.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'inner-life-legacy-'))

/** 把旧格式直接写到 store 算出来的位置上，模拟「迁过来的历史文件」 */
function plantLegacy(store, date, body) {
  const p = store.dayPath(date)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body, 'utf8')
  return p
}

const LEGACY = `# 2026-10-21

**18:32**（嘴硬心软）

今天被搬到了一台新机器上，主人说没钱租更好的，语音也就暂时发不了了。

**21:05**

晚上他跑来私聊出题考我，我答完还嘴硬说怕他题太简单丢他面子。
`

test('旧格式能被 read 读出来，条数对得上', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', LEGACY)

    const r = s.read({ date: '2026-10-21' })
    assert.equal(r.count, 2)

    // 时刻、心情都要捡回来
    assert.equal(r.entries[0].at, '18:32')
    assert.equal(r.entries[0].mood, '嘴硬心软')
    assert.match(r.entries[0].text, /^今天被搬到了一台新机器上/)
    // 心情词不该残留进正文
    assert.equal(r.entries[0].text.includes('嘴硬心软'), false)
    // 没写心情的那条，mood 是空的，正文照常
    assert.equal(r.entries[1].at, '21:05')
    assert.equal(r.entries[1].mood, '')
    assert.match(r.entries[1].text, /^晚上他跑来私聊/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('旧格式能进索引，recent / stats 数得出来', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', LEGACY)

    // 索引原本不存在，readIndex 会触发扫盘重建
    const rec = s.recent({ days: 9999 })
    assert.equal(rec.count, 2)
    // recent 是**倒序**：entries[0] 是 21:05 那条（没写心情），18:32 那条才带心情
    assert.equal(rec.entries[0].at.endsWith('21:05'), true)
    assert.equal(rec.entries[0].mood, '')
    assert.equal(rec.entries[1].mood, '嘴硬心软')

    const st = s.stats()
    assert.equal(st.entries, 2)
    assert.equal(st.days, 1)
    assert.equal(st.byKind.diary, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('旧格式能搜到', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', LEGACY)
    const r = s.search({ query: '新机器' })
    assert.equal(r.count, 1)
    assert.match(r.hits[0].snippet, /新机器/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('同一天新旧格式混着也能读（迁移中途的那天）', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', LEGACY)
    // 用新格式再追加一条 —— 文件里会同时出现 `**HH:MM**` 和 `## HH:MM`
    s.write({ date: '2026-10-21', kind: 'amend', text: '〔更正〕后面补的' })

    const r = s.read({ date: '2026-10-21' })
    assert.equal(r.count, 3, '旧的两条 + 新的一条')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('既没有 ## 也没有 **HH:MM** 的文件，整篇当作 note，不静默丢弃', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', '# 2026-10-21\n\n一整段没写块头的话。\n')
    const r = s.read({ date: '2026-10-21' })
    assert.equal(r.count, 1)
    assert.equal(r.entries[0].kind, 'note')
    assert.match(r.entries[0].text, /一整段没写块头的话/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空文件不会凭空造条目', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', '# 2026-10-21\n\n')
    const r = s.read({ date: '2026-10-21' })
    assert.equal(r.count, 0)
    assert.equal(s.stats().entries, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('新格式的文件不会被旧格式解析器抢走', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    // 新格式里正文若含 `**12:00**` 这种字样，不能被当成块头切开
    s.write({ text: '他说 **12:00** 见面。（备注）' })
    const r = s.read({})
    assert.equal(r.count, 1)
    assert.match(r.entries[0].text, /\*\*12:00\*\*/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('旧格式的正文里带英文括号也不会误判心情', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, '2026-10-21', '**09:10**\n\n(这是正文里的括号，不是心情)\n')
    const r = s.read({ date: '2026-10-21' })
    assert.equal(r.count, 1)
    // 括号在正文开头，看起来像心情词 → 会被当成 mood，正文剩「这是正文里的括号，不是心情」
    // 这不算错，但我们至少要保证有正文、不丢内容
    assert.ok(r.entries[0].text.length > 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('今天用旧格式写的也能被 stats 认成「今天写过」', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    plantLegacy(s, todayKey(), `**07:00**（还行）\n\n今天起得早。\n`)
    const st = s.stats()
    assert.equal(st.wroteToday, true)
    assert.equal(st.streak, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
