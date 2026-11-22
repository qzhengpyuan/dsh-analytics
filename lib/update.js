/**
 * "Is a newer release out" for the panel.
 *
 * The repository is public, so the unauthenticated API is enough; it allows 60
 * calls an hour, so an answer is cached for ten minutes and concurrent asks share
 * one request. Every failure is reported as a string instead of thrown: an
 * unreachable GitHub must not read as "you are up to date".
 */
const RELEASES = 'https://api.github.com/repos/qzhengpyuan/dsh-analytics/releases/latest'
const CACHE_MS = 10 * 60 * 1000

export function createUpdateCheck({ fetchImpl = globalThis.fetch, now = () => Date.now(), endpoint = RELEASES } = {}) {
  let cached = null
  let inflight = null

  return async function check(current) {
    if (cached && now() - cached.at < CACHE_MS) return { ...cached.value, cached: true }
    if (!inflight) {
      inflight = (async () => {
        try {
          if (typeof fetchImpl !== 'function') throw new Error('这个运行环境没有 fetch')
          const response = await fetchImpl(endpoint, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-analytics' },
            signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(5000) : undefined,
          })
          if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
          const body = await response.json()
          const latest = String(body?.tag_name ?? '').replace(/^v/, '')
          if (!latest) throw new Error('发布信息里没有 tag_name')
          return {
            current,
            latest,
            newer: compare(latest, current) > 0,
            url: String(body?.html_url ?? ''),
            publishedAt: String(body?.published_at ?? ''),
            notes: String(body?.body ?? '').slice(0, 2000),
          }
        } catch (error) {
          return { current, latest: null, newer: false, error: String(error?.message ?? error) }
        } finally {
          inflight = null
        }
      })()
    }
    const value = await inflight
    // A failure is not cached: the next click should try again.
    if (!value.error) cached = { at: now(), value }
    return { ...value, cached: false }
  }
}

/** Numeric part-by-part compare of `a.b.c`, so 0.9.0 is newer than 0.56.0. */
export function compare(left, right) {
  const parse = (text) => String(text ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}
