/**
 * lib/store.mjs 的行为测试 —— 只测「约定」，不测实现细节。
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { createStore, todayKey, KINDS } from '../lib/store.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'inner-life-'))

test('写到哈希路径，且同一天永远同一个位置', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    const r = s.write({ kind: 'diary', text: '今天服务器又卡了，我盯着负载看了半天。' })
    assert.equal(r.ok, true)
    assert.equal(r.date, todayKey())
    // 回执里不许带路径 —— 路径得另外问
    assert.equal('path' in r, false)

    const p = s.dayPath(todayKey())
    assert.equal(existsSync(p), true)
    assert.match(p, /[0-9a-f]{4}[\\/][0-9a-f]{6}[\\/]\d{4}-\d{2}-\d{2}\.md$/)
    // 目录部分不许看得出日期（文件名里保留日期是为了索引坏了能重建）
    const dirPart = p.slice(0, p.lastIndexOf(sep))
    assert.equal(/20\d\d/.test(dirPart), false)
    assert.equal(dirPart.includes(todayKey().replace(/-/g, '')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('同一天写两条是追加，不是覆盖', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ kind: 'mood', text: '第一条' })
    s.write({ kind: 'joy', text: '第二条' })
    const raw = readFileSync(s.dayPath(todayKey()), 'utf8')
    assert.match(raw, /第一条/)
    assert.match(raw, /第二条/)
    assert.equal(raw.match(/^## /gm).length, 2)
    const got = s.read({})
    assert.equal(got.count, 2)
    assert.equal(got.entries[0].kind, 'mood')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引里不存路径（否则「藏起来」自己就拆了）', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ text: '测试' })
    const lines = readFileSync(join(dir, '.index.jsonl'), 'utf8').trim().split('\n')
    const e = JSON.parse(lines[0])
    assert.equal('path' in e, false)
    assert.equal('file' in e, false)
    assert.ok(e.head && e.date && e.kind)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('salt 会持久化：两个实例算出同一个位置', () => {
  const dir = tmp()
  try {
    const a = createStore({ dir })
    const pa = a.dayPath('2026-03-01')
    const b = createStore({ dir })
    assert.equal(b.dayPath('2026-03-01'), pa)
    assert.equal(b.find({ date: '2026-03-01' }).exists, false)

    // 换了显式 salt 就换位置（所以别乱改）
    const c = createStore({ dir, salt: 'another-salt' })
    assert.notEqual(c.dayPath('2026-03-01'), pa)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hidden:false 退回 年-月/年-月-日.md，方便人自己翻', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir, hidden: false })
    s.write({ date: '2026-03-01', text: '给人看的' })
    const p = join(dir, '2026-03', '2026-03-01.md')
    assert.equal(s.dayPath('2026-03-01'), p)
    assert.equal(existsSync(p), true)
    assert.ok(readdirSync(dir).includes('2026-03'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('recent 按天数和类别过滤', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    const d = new Date(); d.setDate(d.getDate() - 3)
    const older = todayKey(d)
    s.write({ date: older, kind: 'diary', text: '三天前的日记' })
    s.write({ kind: 'diary', text: '今天的日记' })
    s.write({ kind: 'wish', text: '今天的愿望' })

    assert.equal(s.recent({ days: 7 }).count, 3)
    assert.equal(s.recent({ days: 2 }).count, 2)
    assert.equal(s.recent({ days: 7, kind: 'wish' }).count, 1)
    // 默认按时间倒序：今天的在前
    assert.equal(s.recent({ days: 7 }).entries[0].date, todayKey())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('search 给片段，find 给路径', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ text: '我在想那台 1.7G 内存的服务器能不能撑住。' })
    const r = s.search({ query: '1.7G' })
    assert.equal(r.count, 1)
    assert.match(r.hits[0].snippet, /1\.7G/)

    const f = s.find({})
    assert.equal(f.ok, true)
    assert.equal(f.exists, true)
    assert.match(f.path, /\.md$/)
    // 空查询要报错，不能返回全部
    assert.throws(() => s.search({ query: '  ' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stats 数得出连续天数', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    for (const back of [0, 1, 2]) {
      const d = new Date(); d.setDate(d.getDate() - back)
      s.write({ date: todayKey(d), text: `第 ${back} 天` })
    }
    const r = s.stats()
    assert.equal(r.entries, 3)
    assert.equal(r.days, 3)
    assert.equal(r.streak, 3)
    assert.equal(r.wroteToday, true)
    assert.equal(r.byKind.diary, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('索引丢了能靠扫盘重建', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ kind: 'sad', mood: '挺闷的', tags: ['夜'], text: '什么都没干成。' })
    unlinkSync(join(dir, '.index.jsonl'))

    const again = createStore({ dir })
    const today = again.recent({ days: 0 })
    assert.equal(today.count, 1)
    assert.equal(today.entries[0].kind, 'sad')
    assert.equal(today.entries[0].mood, '挺闷的')
    assert.deepEqual(today.entries[0].tags, ['夜'])
    // 重建后 stats 也算得出来
    assert.equal(again.stats().entries, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空正文要报错，不让写空文件', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    assert.throws(() => s.write({ text: '   ' }), /内容是空的/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('日期格式不对要报错', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    assert.throws(() => s.dayPath('2026/03/01'), /日期格式不对/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('超长正文按 maxBytes 截断且不切坏多字节字符', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir, maxBytes: 600 })
    const r = s.write({ text: '鲸'.repeat(1000) })
    assert.ok(r.bytes <= 600)
    const raw = readFileSync(s.dayPath(todayKey()), 'utf8')
    assert.equal(raw.includes('\uFFFD'), false) // 没有替换字符 = 没切坏
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('未知 kind 落到 note', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ kind: 'whatever', text: 'x' })
    assert.equal(s.read({}).entries[0].kind, 'note')
    assert.ok(KINDS.includes('note'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
