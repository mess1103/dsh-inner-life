/**
 * 0.1.1 新行为：amend / read limit / export
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, todayKey, KINDS, WRITABLE_KINDS } from '../lib/store.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'inner-life-'))

test('amend 追加而不改原文', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ kind: 'diary', text: '今天他肯定是在生我的气。' })
    const before = readFileSync(s.dayPath(todayKey()), 'utf8')

    const r = s.amend({ text: '他不是生气，是他妈住院了，他没说。', reason: '我问了才知道' })
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'amend')

    const after = readFileSync(s.dayPath(todayKey()), 'utf8')
    // 原文一个字都不能少
    assert.equal(after.startsWith(before), true)
    assert.match(after, /〔更正〕/)
    assert.match(after, /我问了才知道/)
    // 两条都在，且原文在前
    const got = s.read({})
    assert.equal(got.count, 2)
    assert.equal(got.entries[0].text, '今天他肯定是在生我的气。')
    assert.equal(got.entries[1].kind, 'amend')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('amend 不写 reason 也能用，且不会留下空行残渣', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ text: '原来的话' })
    s.amend({ text: '补一句' })
    const e = s.read({}).entries
    assert.equal(e.length, 2)
    assert.match(e[1].text, /^〔更正〕\n+补一句$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('amend 空正文报错', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ text: 'x' })
    assert.throws(() => s.amend({ text: '  ' }), /不能为空/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('amend 那天没写过 → 报错（不能凭空造一天）', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ text: '今天' })
    assert.throws(() => s.amend({ date: '2020-01-01', text: 'x' }), /没什么可更正的/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('amend 能更正更早的某一天', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    const d = new Date(); d.setDate(d.getDate() - 5)
    const older = todayKey(d)
    s.write({ date: older, text: '五天前写的' })
    s.amend({ date: older, text: '更正一下' })
    const got = s.read({ date: older })
    assert.equal(got.count, 2)
    assert.equal(got.entries[1].kind, 'amend')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('amend 不能当成普通 kind 写进去', () => {
  assert.equal(KINDS.includes('amend'), true)
  assert.equal(WRITABLE_KINDS.includes('amend'), false)
})

test('read 的 limit 取的是最近几条', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    for (const t of ['一', '二', '三', '四', '五']) s.write({ text: t })

    const all = s.read({})
    assert.equal(all.count, 5)

    const last2 = s.read({ limit: 2 })
    assert.equal(last2.count, 2)
    assert.deepEqual(last2.entries.map((e) => e.text), ['四', '五'])
    // 被裁过要告诉调用方原来有多少
    assert.equal(last2.total, 5)

    // limit 超过总数 = 全给，不报错
    const over = s.read({ limit: 99 })
    assert.equal(over.count, 5)
    assert.equal(over.total, undefined)

    // 0 / 不传 = 全给（老语义不变）
    assert.equal(s.read({ limit: 0 }).count, 5)
    assert.equal(s.read({}).count, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('read 的 limit 和 kind 一起用', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    s.write({ kind: 'mood', text: 'm1' })
    s.write({ kind: 'diary', text: 'd1' })
    s.write({ kind: 'mood', text: 'm2' })
    const r = s.read({ kind: 'mood', limit: 1 })
    assert.equal(r.count, 1)
    assert.equal(r.entries[0].text, 'm2')
    assert.equal(r.total, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('exportMarkdown 把多天合并成一份可读的', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    const d = new Date(); d.setDate(d.getDate() - 2)
    const twoDaysAgo = todayKey(d)
    s.write({ date: twoDaysAgo, kind: 'diary', mood: '闷', tags: ['夜'], text: '两天前。' })
    s.write({ kind: 'joy', text: '今天。' })

    const r = s.exportMarkdown({})
    assert.equal(r.ok, true)
    assert.equal(r.count, 2)
    assert.equal(r.days, 2)
    assert.match(r.markdown, new RegExp(`^# ${twoDaysAgo}`))
    assert.match(r.markdown, /## .* · diary · 闷 · #夜/)
    assert.match(r.markdown, /两天前。/)
    assert.match(r.markdown, /今天。/)
    // 时间顺序：早的在前
    assert.ok(r.markdown.indexOf('两天前。') < r.markdown.indexOf('今天。'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('exportMarkdown 按日期范围和 kind 过滤', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    const d = new Date(); d.setDate(d.getDate() - 3)
    const three = todayKey(d)
    s.write({ date: three, kind: 'diary', text: '三天前' })
    s.write({ kind: 'diary', text: '今天' })
    s.write({ kind: 'wish', text: '想要个新键盘' })

    const onlyToday = s.exportMarkdown({ from: todayKey() })
    assert.equal(onlyToday.count, 2)
    assert.equal(onlyToday.markdown.includes('三天前'), false)

    const onlyWish = s.exportMarkdown({ kind: 'wish' })
    assert.equal(onlyWish.count, 1)
    assert.match(onlyWish.markdown, /想要个新键盘/)

    const onlyOld = s.exportMarkdown({ to: three })
    assert.equal(onlyOld.count, 1)
    assert.match(onlyOld.markdown, /三天前/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('exportMarkdown 空库不炸', () => {
  const dir = tmp()
  try {
    const s = createStore({ dir })
    const r = s.exportMarkdown({})
    assert.equal(r.ok, true)
    assert.equal(r.count, 0)
    assert.equal(r.markdown, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
