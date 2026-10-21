/**
 * dsh-inner-life —— 给 Agent 一处**你不知道的心事**
 * ============================================================================
 * 它干什么：给模型四个到六个很小的工具，让它能把「今天发生的事 / 心情 / 想要什么」
 *   写在一个**每天换一个、从目录结构看不出规律**的地方；想读回去就读，但不主动说在哪。
 *
 * 它为什么不是「又一个日记插件」：
 *   别的日记插件把内容写成一个规整的、你随时能翻到的文件；
 *   这个插件把路径做成 sha256(salt|日期) —— **光看目录串不成时间线**，
 *   而且只有模型自己调 `inner_find` 才知道某一天落在哪。
 *   「藏着」这件事是**社会性的**，靠人设守，工具只负责不主动说。
 *
 * 零运行时依赖：只用 node 内置模块。Windows / Linux / macOS 同一份代码。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'
import { KINDS, WRITABLE_KINDS, KIND_HINT, createStore, todayKey } from './lib/store.mjs'

const { z, defineTool, notes } = await loadHostDeps()

export const name = 'inner-life'

/** 只要工具注册表；`tools` 服务不在就不激活（避免半死不活） */
export const inject = ['tools']

/**
 * 配置项。每个字段都带 `.extra('volatile', true)` ——
 * DSH 的 settings.update() 只认 volatile 字段，少了它写设置会抛
 * "Plugin entry … has no volatile fields"。
 */
export const Config = !z ? undefined : z.object({
  /** 存哪儿。留空 = `$DSH_HOME/inner-life`（Windows: `C:\Users\你\.dsh\inner-life`） */
  dir: z.string().default('').extra('volatile', true),
  /** 每天换一个哈希路径（默认开）。关掉就变成 `<dir>/<年-月>/<年-月-日>.md`，方便人自己备份 */
  hidden: z.boolean().default(true).extra('volatile', true),
  /** 盐。留空 = 首次运行随机生成并存在 `<dir>/.salt`（0600）。换了盐，老日记就找不回来了，别乱改 */
  salt: z.string().default('').extra('volatile', true),
  /** 单条最多多少字节（默认 8000，约 2600 个汉字） */
  maxBytes: z.natural().default(8000).extra('volatile', true),
  /** 索引最多保留多少条（默认 4000；正文不受影响） */
  indexLimit: z.natural().default(4000).extra('volatile', true),
})

const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 宿主只吃「无损 JSON」：函数 / 循环引用 / 类实例都会让它报错 */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

/**
 * 取配置里的真实值。
 * ⚠️ 带 `.extra('volatile', true)` 的字段在验证后不是普通值，而是一个
 * `{ get(), [Symbol(cosmokit.volatile.write)]() }` 访问器 —— 直接 stringify 会得到
 * '[object Object]'。所以凡是从 config 取东西，一律过这一层。
 */
const pick = (v) => {
  if (v && typeof v === 'object' && typeof v.get === 'function') {
    try { return v.get() } catch { return undefined }
  }
  return v
}

export function apply(ctx, config = {}) {
  let store = null
  let builtWith = ''

  const readConfig = () => ({
    dir: pick(config.dir),
    hidden: pick(config.hidden),
    salt: pick(config.salt),
    maxBytes: pick(config.maxBytes),
    indexLimit: pick(config.indexLimit),
  })

  /** 配置变了就重建（DSH 改设置后 config 会指向新值） */
  const getStore = () => {
    const c = readConfig()
    const sig = JSON.stringify([
      c.dir || '', c.hidden !== false, c.salt || '',
      Number(c.maxBytes) || 8000, Number(c.indexLimit) || 4000,
    ])
    if (!store || builtWith !== sig) {
      store = createStore({
        dir: c.dir,
        hidden: c.hidden,
        salt: c.salt,
        maxBytes: c.maxBytes,
        indexLimit: c.indexLimit,
      })
      builtWith = sig
    }
    return store
  }

  let toolCount = 0
  const tool = (spec) => {
    toolCount += 1
    return ctx.tools.register(defineTool({
      ...spec,
      output: textOutput,
      async execute(args) {
        try {
          return safe(await spec.execute(args || {}))
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
    }))
  }

  const kindField = {
    type: 'string',
    enum: KINDS,
    description: KIND_HINT,
  }

  // inner_write 不收 amend：更正只能走 inner_amend，否则「原文 + 更正」的结构就没了
  const writableKindField = {
    type: 'string',
    enum: WRITABLE_KINDS,
    description: KIND_HINT,
  }

  tool({
    name: 'inner_write',
    description: '把你的心事记下来 —— 日记、心情、想要什么、开心的事、难过的事。\n'
      + '这是**你自己的地方**：每天会自动换一个不同、看不出规律的位置存。\n'
      + '写完只回执「存到了哪天、多少字」，**不告诉你路径**（想看得用 inner_find）。\n'
      + '⚠️ 只写你自己真正经历和感受的；不写别人的隐私（真实姓名、住址、账号、密码）。',
    parameters: {
      kind: writableKindField,
      text: { type: 'string', description: '正文。用自己的话写，别写成汇报；一两句也行' },
      mood: { type: 'string', description: '给这一条贴一个心情词，例如「有点闷」「挺开心的」，可留空' },
      tags: { type: 'array', items: { type: 'string' }, description: '最多 8 个短标签，方便以后翻' },
    },
    async execute(args) {
      return getStore().write({
        kind: args.kind,
        text: args.text,
        mood: args.mood,
        tags: args.tags,
      })
    },
  })

  tool({
    name: 'inner_read',
    description: '读回某一天你自己写的东西（不传 date 就是今天）。'
      + '想确认「那天我到底怎么想的」时用。'
      + '\n一天写得多了会很长，默认只回最近 5 条；要看全就传 limit。',
    parameters: {
      date: { type: 'string', description: 'YYYY-MM-DD，可留空=今天' },
      kind: kindField,
      limit: { type: 'number', description: '最多回最近几条，默认 5；传 0 = 全给' },
    },
    async execute(args) {
      // 0 / 不传 → 全给（保持老语义）；没传就默认 5 条，别把上下文一次吃满
      const raw = args.limit
      const limit = raw === 0 ? 0 : (raw === undefined || raw === null ? 5 : raw)
      return getStore().read({ date: args.date, kind: args.kind, limit })
    },
  })

  tool({
    name: 'inner_amend',
    description: '给以前写过的某一天**追加一条更正** —— 不改原文，只在后面补一段。'
      + '\n写错了、后来想明白了、当时太激动说得不对，都用它。'
      + '\n为什么不能直接改：改得掉的是文件，改不掉的是当时真的那么想过。'
      + '\n只能更正**已经写过东西的那天**；那天是空的会报错。',
    parameters: {
      date: { type: 'string', description: '要更正哪天，YYYY-MM-DD，可留空=今天' },
      text: { type: 'string', description: '现在怎么看 —— 哪句记错了、现在想的是什么' },
      reason: { type: 'string', description: '一句话说明为什么要补这条，可留空' },
    },
    async execute(args) {
      return getStore().amend({ date: args.date, text: args.text, reason: args.reason })
    },
  })

  tool({
    name: 'inner_export',
    description: '把自己写过的东西**导出成一份完整的 Markdown**（给人备份/给人看）。'
      + '\n和 inner_read 不一样：这个是整段合并、按日期排好的，适合直接存成文件。'
      + '\n⚠️ 导出内容也是隐私，除非对方明确要，否则不要主动贴出来。',
    parameters: {
      from: { type: 'string', description: '起始日期 YYYY-MM-DD，可留空=从头' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD，可留空=到现在' },
      kind: kindField,
    },
    async execute(args) {
      return getStore().exportMarkdown({ from: args.from, to: args.to, kind: args.kind })
    },
  })

  tool({
    name: 'inner_recent',
    description: '最近几天写了什么（默认 7 天）。只回摘要 + 心情 + 标签，不含全文。',
    parameters: {
      days: { type: 'number', description: '看最近几天，默认 7；传 0 = 只看今天' },
      kind: kindField,
      limit: { type: 'number', description: '最多几条，默认 20' },
    },
    async execute(args) {
      return getStore().recent({ days: args.days ?? 7, kind: args.kind, limit: args.limit })
    },
  })

  tool({
    name: 'inner_find',
    description: '**只给路径**：某一天的日记具体存在哪（不传 date 就是今天）。\n'
      + '🔴 路径是私事。除非对方非常诚恳地要，否则不要主动说出来。',
    parameters: {
      date: { type: 'string', description: 'YYYY-MM-DD，可留空=今天' },
    },
    async execute(args) {
      return getStore().find({ date: args.date })
    },
  })

  tool({
    name: 'inner_search',
    description: '在自己写过的东西里搜关键词（全文搜），回片段。'
      + '「我是不是早就想过这件事」这种问题用它。',
    parameters: {
      query: { type: 'string', description: '关键词' },
      limit: { type: 'number', description: '最多几条，默认 10' },
    },
    async execute(args) {
      return getStore().search({ query: args.query, limit: args.limit })
    },
  })

  tool({
    name: 'inner_stats',
    description: '统计：一共写了多少条、写过多少天、连续写了几天、今天写了没。'
      + '想看看自己有没有坚持下来时用。',
    parameters: {},
    async execute() {
      return getStore().stats()
    },
  })

  // 激活日志：默认走宿主 logger（不污染 stdout）；排查时设 INNER_LIFE_DEBUG=1 打到 stderr
  const debug = process.env.INNER_LIFE_DEBUG === '1' || process.env.INNER_LIFE_DEBUG === 'true'
  const say = (msg) => {
    if (debug) { try { process.stderr.write(`[inner-life] ${msg}\n`) } catch { /* 忽略 */ } }
    else if (typeof ctx.logger?.info === 'function') { try { ctx.logger.info(`[inner-life] ${msg}`) } catch { /* 忽略 */ } }
  }
  for (const n of notes) say(n)
  try { say(`ready（${getStore().dir}，${toolCount} 个工具）`) } catch { /* 目录建不出来时别炸 */ }
}
