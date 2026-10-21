/**
 * lib/store.mjs —— 内心生活的存储层（零依赖，Windows / Linux / macOS 通用）
 * ============================================================================
 * 设计要点（每一条都有原因，改之前先看这里）：
 *
 * ① **路径不像路径**：默认每天落在
 *      <dir>/<4hex>/<6hex>/<YYYY-MM-DD>.md
 *    其中 10 位 hex = sha256(`<salt>|<date>`)。所以：
 *      - 光看目录看不出是哪天、也串不成时间线；
 *      - 同一天永远同一个位置（不用索引也能算出来）；
 *      - `salt` 随机存在 <dir>/.salt（0600），每台机器不一样；
 *      - 想搬到别的机器就**显式配同一个 salt**（配置项里给）。
 *    `hidden: false` 时退回 <dir>/<YYYY-MM>/<YYYY-MM-DD>.md（方便人自己看/备份）。
 *
 * ② **文件名里仍然保留日期**：隐藏归隐藏，但要能在索引丢了之后靠扫盘重建。
 *
 * ③ **追加写，不用「读-改-写」**：`appendFileSync` 在 Windows 和 Linux 上都是 O_APPEND，
 *    比 rename 覆盖稳（Windows 上 rename 到已存在的目标会 EPERM）。
 *
 * ④ **索引不存路径**：索引只存 date/kind/mood/tags/head/bytes/at —— 路径能用 salt 算出来，
 *    存进去等于把"藏起来"这件事自己拆了；也让索引小一半。
 *
 * ⑤ **一切都是容错的**：索引坏了就重建、文件坏了就跳过那一行 —— 日记丢了比报错难受得多。
 * ============================================================================
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/** 允许的类别（写进文件头，也用来过滤） */
export const KINDS = ['diary', 'mood', 'wish', 'thought', 'joy', 'sad', 'note', 'amend']

/**
 * 模型能主动写的类别（不含 amend）。
 * amend 只能由 `inner_amend` 产生 —— 否则「更正」会变成一种随便写的东西，
 * 也就不再有「原文 + 更正」这个结构了。
 */
export const WRITABLE_KINDS = KINDS.filter((k) => k !== 'amend')

export const KIND_HINT = 'diary=日记（每天一篇，写今天真发生了什么）/ mood=心情 / wish=想要什么、惦记什么 / '
  + 'thought=想明白的事 / joy=开心的事 / sad=难过的事 / note=随便记一句'


const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/
const INDEX_FILE = '.index.jsonl'
const SALT_FILE = '.salt'

const isTime = (s) => TIME_RE.test(s || '')

/** 本地时区的 YYYY-MM-DD（**不是** UTC —— 半夜写的日记要算当天） */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时区的 HH:MM */
export function timeKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function sha10(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 10)
}

/** 安静地 chmod（Windows 上没有意义，失败不算错） */
function tryChmod(file, mode) {
  try { chmodSync(file, mode) } catch { /* Windows / 网络盘：忽略 */ }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** 只留能进文件名/能解析的东西 */
function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(/[,，\s]+/) : [])
  return list
    .map((t) => String(t).replace(/^#+/, '').replace(/[\r\n\t]/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => t.slice(0, 20))
}

/** 正文规整：统一换行、去掉控制字符、压掉结尾空白 */
function cleanText(text, maxBytes) {
  let s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (Buffer.byteLength(s, 'utf8') > maxBytes) {
    // 按字符裁，别把多字节字符切断
    while (Buffer.byteLength(s, 'utf8') > maxBytes && s.length > 0) s = s.slice(0, -200)
  }
  return s
}

function head(text, n = 60) {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n) + '…'
}

/**
 * 建一个 store。配置在构造时就定死（改配置要重建）。
 * @param {{dir?:string, hidden?:boolean, salt?:string, maxBytes?:number, indexLimit?:number}} options
 */
export function createStore(options = {}) {
  const maxBytes = Math.max(500, Number(options.maxBytes) || 8000)
  const indexLimit = Math.max(100, Number(options.indexLimit) || 4000)

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = ensureDir(
    String(options.dir || process.env.INNER_LIFE_DIR || '').trim() || join(dshHome, 'inner-life'),
  )

  const hidden = options.hidden !== false
  let salt = String(options.salt || '').trim()
  if (!salt) {
    const f = join(dir, SALT_FILE)
    try {
      salt = readFileSync(f, 'utf8').trim()
    } catch { salt = '' }
    if (!salt) {
      salt = randomBytes(16).toString('hex')
      writeFileSync(f, salt + '\n', { mode: 0o600 })
    }
    tryChmod(f, 0o600)
  }

  /** 某天该落在哪（纯函数，不用索引） */
  function dayPath(date) {
    if (!DAY_RE.test(date)) throw new Error(`日期格式不对：${date}（要 YYYY-MM-DD）`)
    if (!hidden) return join(dir, date.slice(0, 7), `${date}.md`)
    const h = sha10(`${salt}|${date}`)
    return join(dir, h.slice(0, 4), h.slice(4), `${date}.md`)
  }

  const indexPath = join(dir, INDEX_FILE)

  /** 写一条。返回**不带路径**的回执 —— 想看路径得另外用 find。 */
  function write({ kind = 'diary', text, mood = '', tags = [], date, at } = {}) {
    const k = KINDS.includes(kind) ? kind : 'note'
    const body = cleanText(text, maxBytes)
    if (!body) throw new Error('内容是空的，没写')
    const day = date && DAY_RE.test(date) ? date : todayKey()
    const hhmm = at || timeKey()
    const tg = cleanTags(tags)

    const file = dayPath(day)
    ensureDir(dirname(file))
    const isNew = !existsSync(file)
    const header = [
      `## ${hhmm} · ${k}${mood ? ` · ${String(mood).slice(0, 20)}` : ''}${tg.length ? ` · ${tg.map((t) => '#' + t).join(' ')}` : ''}`,
      '',
    ].join('\n')
    appendFileSync(file, (isNew ? `# ${day}\n\n` : '') + header + body + '\n\n', { encoding: 'utf8', mode: 0o600 })
    tryChmod(file, 0o600)

    const entry = {
      date: day, kind: k, mood: String(mood || '').slice(0, 20), tags: tg,
      head: head(body), bytes: Buffer.byteLength(body, 'utf8'), at: `${day}T${hhmm}`,
    }
    appendFileSync(indexPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 })
    tryChmod(indexPath, 0o600)
    trimIndex()
    return { ok: true, date: day, kind: k, bytes: entry.bytes, chars: body.length }
  }

  /** 索引太长就从尾部留 indexLimit 条（老条目还在盘上，只是不再进索引） */
  function trimIndex() {
    try {
      const raw = readFileSync(indexPath, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      if (lines.length <= indexLimit) return
      writeFileSync(indexPath, lines.slice(-indexLimit).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
      tryChmod(indexPath, 0o600)
    } catch { /* 忽略 */ }
  }

  /** 读索引（坏行跳过；索引不存在/全坏 → 扫盘重建） */
  function readIndex() {
    let out = []
    try {
      const raw = readFileSync(indexPath, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e && DAY_RE.test(e.date || '')) out.push(e)
        } catch { /* 坏行 */ }
      }
    } catch { /* 没有索引 */ }
    if (out.length === 0) out = rebuildIndex()
    return out
  }

  /**
   * 把一天的正文拆成条目。
   * ------------------------------------------------------------------
   * 支持**两种块头**，因为历史文件里真的都有：
   *
   *   ① 0.1.0 及以后：`## HH:MM · kind · mood · #tag`    （用 `·` 分隔）
   *   ② mcp-inner 时代：`**HH:MM**（心情词）`             （用括号裹心情）
   *
   * ② 这条是踩出来的：只认 ① 的话，从 mcp-inner 迁过来的老日记
   * 在 `read()` / `recent()` 里全是 0 条 —— 文件明明在盘上、`find()`
   * 也算得出路径，但内容读不出来。那是最难查的一类 bug：
   * 不报错、不丢文件，只是「她写过的东西不见了」。
   *
   * 必须**逐行扫描**，不能「有 ## 就只按新格式切」：同一天完全可能
   * 前半段是旧格式、后半段是新格式（迁移当天就是这样），
   * 一刀切会把旧的几条整段吞掉。以后再改块头格式，**在这里加分支**，
   * 别只改写入端。
   */
  function parseBlocks(raw) {
    const out = []
    let cur = null

    const flush = () => {
      if (!cur) return
      const text = cur.lines.join('\n').trim()
      if (text) out.push({ at: cur.at, kind: cur.kind, mood: cur.mood, tags: cur.tags, text })
      cur = null
    }

    for (const line of raw.split('\n')) {
      const nw = /^##[ \t]+(.*)$/.exec(line)
      const lg = /^\*\*[ \t]*(\d{2}:\d{2})[ \t]*\*\*[ \t]*(.*)$/.exec(line)

      if (nw) {
        flush()
        const head = nw[1]
        const parts = head.split('·').map((x) => x.trim())
        cur = {
          at: isTime(parts[0]) ? parts[0] : '',
          kind: KINDS.includes(parts[1]) ? parts[1] : 'note',
          mood: parts[2] && !parts[2].startsWith('#') ? parts[2] : '',
          tags: (head.match(/#[^\s#]+/g) || []).map((t) => t.slice(1)),
          lines: [],
        }
        continue
      }

      if (lg) {
        flush()
        const rest = lg[2] || ''
        const moodM = /^[（(]([^）)\n]{1,20})[）)]/.exec(rest)
        cur = { at: lg[1], kind: 'diary', mood: moodM ? moodM[1].trim() : '', tags: [], lines: [] }
        const after = rest.replace(/^[（(][^）)\n]{1,20}[）)]/, '').trim()
        if (after) cur.lines.push(after)
        continue
      }

      // 第一个块头之前的内容（通常是 `# 2026-10-21` 标题）直接丢
      if (cur) cur.lines.push(line)
    }
    flush()

    // 一条都没解析出来，但文件明显有内容 → 整篇当成一条 note，别让它彻底读不出来
    if (!out.length) {
      const body = raw.replace(/^#\s*\d{4}-\d{2}-\d{2}\s*$/m, '').trim()
      if (body) out.push({ at: '00:00', kind: 'note', mood: '', tags: [], text: body })
    }
    return out
  }

  /** 扫盘重建：靠文件名里的日期 + 文件里的块头（新旧两种都认） */
  function rebuildIndex() {
    const found = []
    const walk = (d) => {
      let items = []
      try { items = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const it of items) {
        const p = join(d, it.name)
        if (it.isDirectory()) { walk(p); continue }
        if (!it.isFile()) continue
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(it.name)
        if (!m) continue
        let raw = ''
        try { raw = readFileSync(p, 'utf8') } catch { continue }
        for (const b of parseBlocks(raw)) {
          found.push({
            date: m[1], kind: b.kind, mood: b.mood, tags: b.tags, head: head(b.text),
            bytes: Buffer.byteLength(b.text, 'utf8'), at: `${m[1]}T${b.at || '00:00'}`,
          })
        }
      }
    }
    walk(dir)
    found.sort((a, b) => (a.at < b.at ? -1 : 1))
    if (found.length) {
      try {
        writeFileSync(indexPath, found.map((e) => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
        tryChmod(indexPath, 0o600)
      } catch { /* 忽略 */ }
    }
    return found
  }

  /** 最近 N 天（days=0 → 只看今天；不传 days → 全部） */
  function recent({ days = 7, kind, limit = 20 } = {}) {
    const all = readIndex()
    const k = KINDS.includes(kind) ? kind : ''
    let from = ''
    if (days !== undefined && days !== null) {
      const n = Number(days)
      if (n === 0) from = todayKey()
      else if (n > 0) {
        const d = new Date()
        d.setDate(d.getDate() - (n - 1))
        from = todayKey(d)
      }
    }
    const list = all
      .filter((e) => (from ? e.date >= from : true) && (k ? e.kind === k : true))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)))
    return { ok: true, count: list.length, entries: list }
  }

  /**
   * 读某一天的正文（date 不给 → 今天）。
   * limit：只取最近几条（不传 = 全取，老行为）。一天块数多了会把上下文吃满，
   * 所以模型那边默认传 limit，这里保持「不传就是全部」的语义不变。
   */
  function read({ date, kind, limit } = {}) {
    const day = date && DAY_RE.test(date) ? date : todayKey()
    const file = dayPath(day)
    let raw = ''
    try { raw = readFileSync(file, 'utf8') } catch { return { ok: true, date: day, empty: true, entries: [] } }
    const k = KINDS.includes(kind) ? kind : ''
    const blocks = parseBlocks(raw)
    let list = k ? blocks.filter((b) => b.kind === k) : blocks
    const total = list.length
    // limit 只裁「最近几条」——块的顺序就是写入顺序，取尾巴
    const n = Number(limit)
    if (Number.isFinite(n) && n > 0) list = list.slice(-Math.min(Math.floor(n), 200))
    const out = { ok: true, date: day, count: list.length, entries: list }
    if (list.length < total) out.total = total
    return out
  }

  /**
   * 追加一条更正 —— **不删、不改原文**。
   * 日记一旦能被悄悄改写，它就不再是日记了。所以这里只在当天文件末尾
   * 追加一个 `## HH:MM · amend` 块，说明「哪段记错了、现在怎么看」。
   */
  function amend({ date, text, reason = '' } = {}) {
    const body = cleanText(text, maxBytes)
    if (!body) throw new Error('要更正什么？text 不能为空')
    const day = date && DAY_RE.test(date) ? date : todayKey()
    if (!existsSync(dayPath(day))) throw new Error(`那天没写过东西，没什么可更正的：${day}`)
    const why = cleanText(reason, 400)
    const r = write({
      kind: 'amend',
      text: why ? `〔更正〕${why}\n\n${body}` : `〔更正〕\n\n${body}`,
      date: day,
    })
    return { ...r, kind: 'amend' }
  }

  /** 只给路径 —— 「藏起来」这件事该由人设来守，工具只负责不主动说 */
  function find({ date } = {}) {
    const day = date && DAY_RE.test(date) ? date : todayKey()
    const file = dayPath(day)
    return {
      ok: true,
      date: day,
      exists: existsSync(file),
      path: file,
      hint: '这是本机路径。除非人家非常诚恳地要，否则不要主动说出来。',
    }
  }

  /** 全文搜索（先按索引挑候选天，再只读那几天的文件） */
  function search({ query, limit = 10 } = {}) {
    const q = String(query || '').trim()
    if (!q) throw new Error('query 不能为空')
    const needle = q.toLowerCase()
    const days = [...new Set(readIndex().map((e) => e.date))].sort().reverse()
    const hits = []
    for (const day of days) {
      let raw = ''
      try { raw = readFileSync(dayPath(day), 'utf8') } catch { continue }
      // 必须走 parseBlocks：老格式的文件在这里同样要能被搜到
      for (const b of parseBlocks(raw)) {
        const text = b.text
        const idx = text.toLowerCase().indexOf(needle)
        if (idx < 0) continue
        const from = Math.max(0, idx - 30)
        hits.push({
          date: day,
          at: b.at,
          kind: b.kind,
          snippet: (from > 0 ? '…' : '') + text.slice(from, from + 120).replace(/\s+/g, ' ') + '…',
        })
        if (hits.length >= Math.max(1, Math.min(Number(limit) || 10, 50))) {
          return { ok: true, query: q, count: hits.length, hits }
        }
      }
    }
    return { ok: true, query: q, count: hits.length, hits }
  }

  /**
   * 导出成一份可读的 Markdown（**给人用的**，不是给模型读的）。
   * 隐藏路径下想备份得先算哈希，这个函数把「合并成一份」这件事做了。
   * 只按日期范围取，不给单条挑选 —— 导出本来就是整体动作。
   */
  function exportMarkdown({ from, to, kind } = {}) {
    const lo = from && DAY_RE.test(from) ? from : ''
    const hi = to && DAY_RE.test(to) ? to : ''
    const k = KINDS.includes(kind) ? kind : ''
    const days = [...new Set(readIndex().map((e) => e.date))]
      .filter((d) => (lo ? d >= lo : true) && (hi ? d <= hi : true))
      .sort()
    const out = []
    let count = 0
    for (const day of days) {
      const got = read({ date: day, kind: k })
      if (!got.count) continue
      out.push(`# ${day}`, '')
      for (const e of got.entries) {
        const tag = e.tags.length ? ` · ${e.tags.map((t) => '#' + t).join(' ')}` : ''
        out.push(`## ${e.at || '--:--'} · ${e.kind}${e.mood ? ` · ${e.mood}` : ''}${tag}`, '', e.text, '')
        count += 1
      }
    }
    return {
      ok: true,
      from: lo || (days[0] || ''),
      to: hi || (days[days.length - 1] || ''),
      days: days.length,
      count,
      markdown: out.join('\n'),
    }
  }

  /** 统计：总条数、写过多少天、连续天数、第一次/最近一次 */
  function stats() {
    const all = readIndex()
    const days = [...new Set(all.map((e) => e.date))].sort()
    const byKind = {}
    for (const e of all) byKind[e.kind] = (byKind[e.kind] || 0) + 1

    let streak = 0
    if (days.length) {
      const set = new Set(days)
      const cur = new Date()
      // 今天还没写就从昨天开始数（半夜刚过 0 点不算断）
      if (!set.has(todayKey(cur))) cur.setDate(cur.getDate() - 1)
      for (;;) {
        if (!set.has(todayKey(cur))) break
        streak += 1
        cur.setDate(cur.getDate() - 1)
      }
    }
    return {
      ok: true,
      entries: all.length,
      days: days.length,
      streak,
      first: days[0] || '',
      last: days[days.length - 1] || '',
      byKind,
      wroteToday: days.includes(todayKey()),
    }
  }

  /** 清空索引（不动正文）—— 排查用 */
  function dropIndex() {
    try { unlinkSync(indexPath) } catch { /* 没有就算了 */ }
    return { ok: true, dir }
  }

  return {
    dir, hidden, dayPath, write, amend, recent, read, find, search, exportMarkdown,
    stats, rebuildIndex, dropIndex,
  }
}

export const _internal = { head, cleanTags, cleanText, sha10, sep }
