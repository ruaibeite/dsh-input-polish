/**
 * @ruaibeite/dsh-input-polish — host half.
 *
 * Exposes one authenticated HTTP endpoint, `POST /dsh-input-polish/rewrite`,
 * that asks the model to rewrite the composer draft. The browser half reads the
 * draft from the composer, posts it here, and writes the answer back through
 * `inputActions.setDraft`.
 *
 * Context selection is the interesting part: a long session usually carries
 * several unrelated tasks, so "the last N messages" is often the *wrong* task.
 * The rewrite picks the messages that mention what the draft actually mentions
 * (paths, identifiers, quoted text, CJK bigrams) and always tells the model the
 * context is optional background — if it is about another task, ignore it.
 *
 * Why an HTTP route and not a typert remote: a third-party plugin cannot
 * contribute its own remote methods (typert artifacts are generated at build
 * time and the browser face ships a fixed deployment list), so a route on the
 * host's own web server is the supported way to talk to the host from a plugin
 * page. This mirrors how the market plugin wires its own API.
 *
 * @module @ruaibeite/dsh-input-polish
 */

/** Route served to the browser half. */
export const ROUTE = '/dsh-input-polish/rewrite'

/**
 * Services this plugin needs. `llm` is declared because it is read as a
 * property (`ctx.llm.stream`), which cordis' strict access traces; the rest
 * are read through `ctx.get(...)`, which needs no declaration and lets the
 * plugin load on profiles that omit them.
 */
export const inject = ['llm']

/** Defaults; every one can be overridden through the profile patch config. */
const DEFAULTS = {
  timeoutMs: 45_000,
  maxInputChars: 8_000,
  contextMessages: 6,
  contextScan: 60,
}

/** System prompt: rewrite only, never answer the request itself. */
const SYSTEM = [
  'You rewrite the user\'s composer draft for a coding agent chat.',
  'Your output replaces the draft verbatim, so return the rewritten text only:',
  'no preamble, no quotes, no markdown fence, no explanation, no "Here is".',
  '',
  'Rules:',
  '- Preserve the author\'s language: Chinese stays Chinese, English stays English.',
  '- Preserve intent, files, paths, identifiers, code, commands, numbers and URLs exactly.',
  '- Make the request unambiguous and complete: state the goal, the scope, the constraints, and what "done" looks like when the draft implies them.',
  '- Keep it compact. Do not invent requirements the author did not imply.',
  '- If the draft is already clear and well-formed, return it unchanged.',
  '- Never answer the draft\'s question; only rewrite it.',
  '- The conversation extract is OPTIONAL background. A long session mixes topics:',
  '  when the extract is about a different task than the draft, ignore it entirely',
  '  and rewrite the draft on its own terms. Never pull another task\'s goal,',
  '  file names or constraints into the draft.',
].join('\n')

/** Common English words that carry no topical signal. */
const EN_STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'these', 'those', 'from', 'into', 'when', 'then',
  'than', 'them', 'they', 'their', 'there', 'here', 'what', 'which', 'while', 'would', 'could',
  'should', 'about', 'after', 'before', 'also', 'just', 'like', 'make', 'made', 'need', 'needs',
  'please', 'some', 'such', 'want', 'will', 'your', 'have', 'been', 'were', 'does',
  'true', 'false', 'null', 'undefined', 'const', 'return', 'function', 'import', 'export',
])

/** Common Chinese bigrams that carry no topical signal. */
const ZH_STOP = new Set([
  '这个', '那个', '我们', '你们', '他们', '可以', '一下', '一个', '什么', '怎么', '然后', '就是',
  '还是', '但是', '因为', '所以', '如果', '现在', '已经', '没有', '不是', '需要', '帮我', '麻烦',
  '的话', '时候', '问题', '功能', '东西', '这里', '那里', '这样', '那样', '如何',
])

/**
 * Extract the topical anchors of a draft: backticked spans, quoted text, paths,
 * identifiers and CJK bigrams.
 *
 * @param text - the draft.
 * @returns unique lowercase anchors, most specific first.
 */
export function anchorsOf(text) {
  const source = String(text ?? '')
  const anchors = new Set()
  const push = (value) => {
    const token = String(value ?? '').trim().toLowerCase()
    if (token.length >= 2 && token.length <= 80) anchors.add(token)
  }
  for (const match of source.matchAll(/`([^`\n]{1,80})`/g)) push(match[1])
  for (const match of source.matchAll(/"[^"\n]{2,80}"|“[^”\n]{1,80}”/g)) push(match[0].replace(/^["“]|["”]$/g, ''))
  for (const match of source.matchAll(/(?:[\w.@-]+\/)+[\w.@-]+/g)) push(match[0])
  for (const match of source.matchAll(/\b[A-Za-z_][A-Za-z0-9_$-]{3,}\b/g)) {
    const word = match[0]
    if (!EN_STOP.has(word.toLowerCase())) push(word)
  }
  for (const run of source.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (!ZH_STOP.has(bigram)) push(bigram)
    }
  }
  return [...anchors].slice(0, 60)
}

/**
 * How many anchors of the draft a text mentions.
 *
 * @param anchors - anchors from {@link anchorsOf}.
 * @param text - candidate text.
 * @returns the overlap count.
 */
export function scoreAgainst(anchors, text) {
  if (anchors.length === 0) return 0
  const haystack = String(text ?? '').toLowerCase()
  if (haystack === '') return 0
  let score = 0
  for (const anchor of anchors) if (haystack.includes(anchor)) score += 1
  return score
}

/**
 * Flatten one session message into prompt text.
 *
 * @param message - a frozen session message.
 * @returns text for the context block (possibly empty).
 */
export function flattenMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    const type = block?.type
    if (type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (type === 'tool-call') parts.push(`[called tool ${block.name ?? 'unknown'}]`)
    else if (type === 'tool-result') parts.push('[tool result]')
  }
  const text = parts.join('\n').trim()
  return text === '' ? '' : `${message?.role ?? 'user'}: ${text}`
}

/** Trim one context line so a single huge message cannot dominate the prompt. */
function clipLine(line, max) {
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

/**
 * Choose the messages most likely to belong to the draft's task.
 *
 * Scoring beats plain recency here: a session that interleaves tasks has its
 * *last* messages on the other task, while the draft's own vocabulary points at
 * the earlier ones. Recency is a tie-breaker, not the primary key, and the two
 * newest messages are always kept so an immediate follow-up ("再短一点") still
 * has its referent.
 *
 * @param messages - session messages, oldest first.
 * @param draft - the draft being rewritten.
 * @param options - how many messages to keep, how far back to scan.
 * @returns the selected messages, oldest first.
 */
export function selectContext(messages, draft, options = {}) {
  const limit = Math.max(1, options.limit ?? DEFAULTS.contextMessages)
  const scan = Math.max(limit, options.scan ?? DEFAULTS.contextScan)
  if (!Array.isArray(messages) || messages.length === 0) return []
  const window = messages.slice(-scan)
  const anchors = anchorsOf(draft)
  const scored = window.map((message, index) => ({
    message,
    index,
    score: scoreAgainst(anchors, flattenMessage(message)),
  }))
  const keep = new Map()
  // Always keep the newest pair: the draft may be a follow-up to them.
  for (const entry of scored.slice(-2)) keep.set(entry.index, entry)
  // Then by topical score, ties broken by recency.
  const ranked = [...scored].sort((a, b) => (b.score - a.score) || (b.index - a.index))
  for (const entry of ranked) {
    if (keep.size >= limit) break
    if (entry.score === 0 && keep.size >= 2) continue
    keep.set(entry.index, entry)
  }
  // Nothing matched: fall back to the plain tail.
  if (keep.size < limit) {
    for (const entry of scored.slice(-limit)) keep.set(entry.index, entry)
  }
  return [...keep.values()].sort((a, b) => a.index - b.index).map((entry) => entry.message)
}

/**
 * Latest conversation context for a draft, oldest first.
 *
 * @param ctx - host plugin context.
 * @param sessionId - the session the draft belongs to.
 * @param draft - the draft being rewritten (drives the topic match).
 * @param options - limit and scan window.
 * @returns flattened context text ('' when unavailable).
 */
export function sessionContext(ctx, sessionId, draft, options = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  try {
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    const messages = session?.deriveMessages?.()
    if (!Array.isArray(messages) || messages.length === 0) return ''
    const picked = selectContext(messages, draft, options)
    return picked
      .map((message) => flattenMessage(message))
      .filter((line) => line !== '')
      .map((line) => clipLine(line, 1_200))
      .join('\n\n')
      .slice(0, 12_000)
  } catch {
    return ''
  }
}

/**
 * The route this draft should use: the model the conversation already runs on,
 * falling back to the deployment default.
 *
 * @param ctx - host plugin context.
 * @param sessionId - the session the draft belongs to.
 * @returns `{ provider, model, reasoningEffort? }`, or undefined when unresolvable.
 */
export function resolveRoute(ctx, sessionId) {
  try {
    const session = ctx.get('sessions')?.get?.(sessionId)
    const config = session?.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return {
        provider: config.provider,
        model: config.model,
        ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
      }
    }
  } catch {
    /* fall through to the deployment default */
  }
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
    }
  } catch {
    /* no default available */
  }
  return undefined
}

/** Build the user turn: optional background + the draft to rewrite. */
export function buildUserText(text, context) {
  const parts = []
  if (context !== '') {
    parts.push([
      'Conversation extract (background only — it may belong to other tasks;',
      'use it only where it is clearly about the same task as the draft, otherwise ignore it):',
      context,
    ].join('\n'))
  }
  parts.push(`Draft to rewrite:\n${text}`)
  return parts.join('\n\n')
}

/** Lazy, tolerant access to the framework's stream assembler. */
let assemblerPromise
function loadAssembler() {
  if (assemblerPromise === undefined) {
    assemblerPromise = import('@deepseek-ai/dsh-llm').catch(() => null)
  }
  return assemblerPromise
}

/** Fallback text extraction for one stream chunk. */
export function chunkText(chunk) {
  if (typeof chunk?.text === 'string') return chunk.text
  if (typeof chunk?.delta?.text === 'string') return chunk.delta.text
  return ''
}

/**
 * Run one one-shot completion and return its text.
 *
 * @param ctx - host plugin context.
 * @param options - route, prompt text, session id and cancellation.
 * @returns the model's text.
 */
export async function complete(ctx, options) {
  const { provider, model, system, userText, signal, reasoningEffort, sessionId } = options
  const stream = ctx.llm.stream({
    provider,
    model,
    system,
    // No temperature and no token cap: reasoning routes reject both, and the
    // reasoning default comes from the profile's own model configuration.
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    // Some routes (opencode-go) refuse a request that cannot be attributed to a
    // session — they answer 400 MissingSessionID. The adapter forwards this id
    // as the provider's session header.
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId: String(sessionId) }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    signal,
  })

  const module = await loadAssembler()
  const Assembler = module?.BlockAssembler
  const assembler = typeof Assembler === 'function' ? new Assembler() : null
  let fallback = ''
  let failure

  for await (const chunk of stream) {
    if (assembler !== null) assembler.push(chunk)
    else fallback += chunkText(chunk)
    if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        const code = chunk.reason?.failure?.code ?? 'LLM_FAILED'
        const message = chunk.reason?.failure?.message ?? kind
        const details = chunk.reason?.failure?.details
        throw new Error(`${code}: ${message}${details === undefined ? '' : ` — ${JSON.stringify(details).slice(0, 600)}`}`)
      }
      failure = kind
      break
    }
  }

  if (assembler !== null) {
    const blocks = assembler.blocks()
    const textBlocks = blocks.filter((block) => block?.type === 'text')
    return textBlocks.map((block) => block.text ?? '').join('').trim()
  }
  if (failure !== undefined && failure !== 'stop') throw new Error(`model stopped with ${failure}`)
  return fallback.trim()
}

/** Strip a leading/trailing markdown fence or quote pair a model may add. */
export function unwrap(raw) {
  let text = String(raw ?? '').trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text)
  if (fence !== null) text = fence[1].trim()
  if (text.length > 1 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”')))) {
    text = text.slice(1, -1).trim()
  }
  return text
}

/** Read and parse a JSON request body with a hard size cap. */
async function readJson(request, limitBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

/**
 * Register the rewrite route.
 *
 * @param ctx - host plugin context.
 * @param config - profile config.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        let body
        try {
          body = await readJson(request, settings.maxInputChars * 8 + 16_384)
        } catch (error) {
          send(response, error?.status ?? 400, { ok: false, error: String(error?.message ?? error) })
          return
        }
        const text = typeof body.text === 'string' ? body.text : ''
        if (text.trim() === '') {
          send(response, 400, { ok: false, error: 'empty draft' })
          return
        }
        if (text.length > settings.maxInputChars) {
          send(response, 413, { ok: false, error: `draft is longer than ${settings.maxInputChars} characters` })
          return
        }

        const route = resolveRoute(ctx, body.sessionId)
        if (route === undefined) {
          send(response, 503, { ok: false, error: 'no model route is available for this profile' })
          return
        }
        const context = settings.contextMessages > 0
          ? sessionContext(ctx, body.sessionId, text, {
            limit: settings.contextMessages,
            scan: settings.contextScan,
          })
          : ''

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('timeout')), settings.timeoutMs)
        try {
          const raw = await complete(ctx, {
            ...route,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            system: SYSTEM,
            userText: buildUserText(text, context),
            signal: controller.signal,
          })
          const next = unwrap(raw)
          if (next === '') {
            send(response, 502, { ok: false, error: 'the model returned no text' })
            return
          }
          send(response, 200, { ok: true, text: next, route: { provider: route.provider, model: route.model } })
        } catch (error) {
          const aborted = controller.signal.aborted
          send(response, aborted ? 504 : 502, {
            ok: false,
            error: aborted ? 'the model call timed out' : String(error?.message ?? error),
            route,
          })
        } finally {
          clearTimeout(timer)
        }
      },
    }), 'input-polish: rewrite route')
  })
}
