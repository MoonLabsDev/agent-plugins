/**
 * The ONLY module that speaks HTTP. Everything else takes plain data, which is
 * what lets the parser, the payload and the spool be tested without a
 * server and reused by a future plugin/codex/ml-track.
 */
export class ApiError extends Error {
  constructor(status, body, url, message, retryAfterSeconds = null) {
    super(message ?? `${status} from ${url}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    // The server's `Retry-After` on a 429, in seconds, or null. The one
    // response header anything downstream needs: the flusher waits this long
    // instead of guessing at the tracker's rate window.
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Comfortably below `lib/flush.mjs`'s `LOCK_STALE_MS` (5 minutes): a flusher
 * hung on a black-holed socket (a stopped container, a VPN blip) must give up
 * well before a second flusher would presume the lock's holder dead and take
 * it over — otherwise both race on the same session's unsynchronised read ->
 * mutate -> rewrite of the ledger, exactly the lost-update the lock exists to
 * prevent. An ordinary flush sends a handful of requests and finishes in well
 * under a second even over a slow network (see flush.mjs's own comment on
 * LOCK_STALE_MS), so a full minute is generous headroom without cutting off a
 * merely slow — but real — request.
 */
const DEFAULT_TIMEOUT_MS = 60_000

export function createClient({ baseUrl, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = `${baseUrl.replace(/\/+$/, '')}/api/v1`

  async function send(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    const url = `${root}${path}`
    // The `body` key is added rather than set to undefined: passing
    // `body: undefined` on a GET is harmless at runtime but is statically the
    // forbidden GET-with-body shape, and a linter that flags it is right to.
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined) init.body = JSON.stringify(body)
    const res = await fetch(url, init)
    const text = await res.text()
    let parsed
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = text
    }
    if (!res.ok) {
      // `headers` is absent on the hand-rolled fetch fakes some tests pass in.
      const retryAfter = Number(res.headers?.get?.('retry-after'))
      throw new ApiError(
        res.status, parsed, url, undefined,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      )
    }
    return parsed
  }

  // The server contract for list endpoints is `{ data: [...] }`. A response that
  // doesn't match it means the server contract changed or something is broken —
  // fail loudly here instead of letting callers silently treat `undefined` as
  // "no results" (which would show the user "no projects" instead of an error).
  async function sendList(path) {
    const url = `${root}${path}`
    const parsed = await send(path)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('data' in parsed)) {
      throw new ApiError(
        200,
        parsed,
        url,
        `malformed response from ${url}: expected an object with a "data" array, but the response had no "data" key`,
      )
    }
    if (!Array.isArray(parsed.data)) {
      throw new ApiError(
        200,
        parsed,
        url,
        `malformed response from ${url}: expected "data" to be an array, but got ${typeof parsed.data}`,
      )
    }
    return parsed.data
  }

  return {
    getMe: () => send('/me'),
    listClients: () => sendList('/clients'),
    // Only active projects: time cannot be booked against an archived project,
    // so offering one in the picker would just produce a call that fails later.
    listProjects: () => sendList('/projects?status=active'),
    createRecord: (body, idempotencyKey) =>
      send('/time-records', { method: 'POST', body, idempotencyKey }),
    // Exposed for introspection/testing only — no call site depends on this.
    timeoutMs,
  }
}
