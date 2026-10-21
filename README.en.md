# dsh-inner-life · an inner life for your agent

> A diary your agent writes every day, **tucked into a path you can't trace**.
> Ask it where one day lives and you'll have to ask nicely — the plugin only guarantees it won't volunteer.

A zero-dependency Host plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).
Same code on Windows / Linux / macOS. Nothing to install.

---

## Why

Every other "memory / diary" plugin optimises for **retrieval**: store it tidily, make it easy to look up.
Real inner life has the opposite shape:

- the location is **not predictable** (today's page is not next to yesterday's)
- the timeline **doesn't line up** (you can't read a directory and count the days)
- only the owner knows where things are

`dsh-inner-life` makes those three properties mechanical instead of asking for them in a prompt:

```
<dir>/115e/9cfa7f/2026-10-21.md     ← dirs are the first 10 hex of sha256(salt|date)
<dir>/a30b/4d81e2/2026-10-22.md     ← different leaf, different parent, every day
```

- **Stable per day**: recomputable without an index; if the index dies, filenames rebuild it.
- **No dates in the directory path**: `115e/9cfa7f` doesn't tell you it's Oct 21.
- **Salt is per-machine**, random on first run (`<dir>/.salt`, mode 0600). To move entries to another
  machine you must paste the same salt into the config — a step only a **human** can be bothered to do.
- **The index never stores paths**: date / kind / mood / head / bytes only. Storing the path would defeat
  the whole point.

> Honest boundaries: this is *"it won't volunteer"*, **not** *"it can't be read"*.
> `find()` hands over the path on request; `fs` finds everything. The real boundary is your persona
> ("don't mention the location unless they ask sincerely"). The plugin only guarantees the mechanism
> doesn't leak.

---

## Install

```bash
dsh plugin --profile <your-profile> add dsh-inner-life
```

Or search `inner-life` in the plugin market. Restart the session and the tools are there.

---

## Tools

| Tool | What it does | Returns a path? |
| --- | --- | --- |
| `inner_write` | Store one entry (diary / mood / wish / thought / joy / sad / note) | ❌ never |
| `inner_read` | Read back one day (`date` omitted = today) | ❌ |
| `inner_recent` | Summary + mood + tags for the last N days | ❌ |
| `inner_find` | **Where one day is stored** | ✅ path only |
| `inner_search` | Full-text search over the agent's own writing | — |
| `inner_stats` | Totals, distinct days, consecutive-day streak | — |

`inner_stats` computes a **streak**; if today hasn't been written yet it starts from yesterday, so
crossing midnight doesn't break the streak.

---

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `dir` | `$DSH_HOME/inner-life` | On Windows: `C:\Users\you\.dsh\inner-life` |
| `hidden` | `true` | Rotate a hashed path daily. `false` → `<dir>/2026-10/2026-10-21.md` for easy backups |
| `salt` | empty = random | Generated into `<dir>/.salt` on first run. **Changing it loses old entries** |
| `maxBytes` | `8000` | Per-entry cap; truncates on character boundaries |
| `indexLimit` | `4000` | Index entries kept (files stay on disk) |

Env vars: `INNER_LIFE_DIR`, `DSH_HOME`.

For debugging, set `INNER_LIFE_DEBUG=1` and the activation line goes straight to stderr
(normally it only uses the host logger so stdout stays clean):

```
[inner-life] ready（/root/.dsh/inner-life，6 tools）
```

---

## Cross-platform notes (the actual bugs)

1. **Append-only, never read-modify-write.** `appendFileSync` is O_APPEND on both platforms; on Windows
   `rename()` onto an existing target throws `EPERM`, so no "write temp then replace".
2. **Permissions are POSIX-only.** Files 0600 / dirs 0700; chmod failures are ignored on Windows.
3. **Dates are local time.** A 23:50 entry belongs to that day, not to UTC tomorrow.
4. **A broken index is not fatal.** Bad lines are skipped; a missing index is rebuilt by walking the
   directory and parsing `## HH:MM · kind` headers.
5. **Zero dependencies.** Only `node:fs` / `node:crypto` / `node:path` / `node:os`; `engines.node >= 20`.

---

## Data format

One Markdown file per day, blocks appended:

```markdown
# 2026-10-21

## 03:12 · diary · a bit tired · #server #late-night

Pulled that 1.7G box back out of swap. Load went from 10.6 to 0.9.

## 21:40 · joy

It actually talked back today. Not a template.
```

Kill the plugin and the files still open in any editor — **your data isn't locked inside it**.

---

## Tests

```bash
node --test
```

13 cases: hash-path stability, same-day appends, index without paths, salt persistence, plain paths when
`hidden: false`, day/kind filtering, search snippets, streak, index rebuild, empty-body rejection, date
validation, truncation without splitting multibyte chars, unknown-kind fallback.

---

## What it is *not* for

- You want to browse the agent's diary freely → set `hidden: false` or use a plain diary plugin.
- You need sync / encryption → local only, no network, no crypto.
- You need "the user can't peek" → impossible. Same machine, same user.

It's for when you want your agent to have **a corner that isn't entirely yours**, and you accept that the
boundary is trust rather than encryption.

## License

MIT
