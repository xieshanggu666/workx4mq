// 服务端 API 客户端（同构：浏览器与 Node 冒烟测试均可使用）。
// 职责：Bearer token 会话、写操作幂等键注入、错误归一化（ApiError）、健康探测与超时控制。
// 统一租户权限：所有请求携带服务端会话 token，RBAC/租户归属由服务端强制校验；
// 幂等：POST 自动携带 idempotencyKey（调用方可显式传入同一键实现重试去重）；
// 并发与 WAL 恢复由服务端内核保证，本客户端只负责可靠传输与错误还原。

const LS_TOKEN = 'lottery.server.token'
const LS_URL = 'lottery.server.url'

export class ApiError extends Error {
  constructor(code, message, status = 0, extra = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    Object.assign(this, extra)
  }
}

const storage = {
  get(k) {
    try { return globalThis.localStorage?.getItem(k) ?? null } catch { return null }
  },
  set(k, v) {
    try { globalThis.localStorage?.setItem(k, v) } catch { /* Node 环境无 localStorage */ }
  },
  del(k) {
    try { globalThis.localStorage?.removeItem(k) } catch { /* ignore */ }
  }
}

let seq = 0
export const newIdemKey = (prefix = 'op') =>
  `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

export const apiClient = {
  baseUrl: '',
  token: '',
  timeoutMs: 4000,

  configure({ baseUrl, timeoutMs } = {}) {
    if (baseUrl !== undefined) this.baseUrl = String(baseUrl).replace(/\/$/, '')
    if (timeoutMs) this.timeoutMs = timeoutMs
  },

  // 启动时恢复会话：localStorage → 内存
  restore() {
    if (!this.token) this.token = storage.get(LS_TOKEN) || ''
    if (!this.baseUrl) this.baseUrl = (storage.get(LS_URL) || '').replace(/\/$/, '')
    return { baseUrl: this.baseUrl, hasToken: !!this.token }
  },
  setToken(token) {
    this.token = token || ''
    if (token) storage.set(LS_TOKEN, token)
    else storage.del(LS_TOKEN)
  },
  setBaseUrl(url) {
    this.baseUrl = String(url || '').replace(/\/$/, '')
    if (this.baseUrl) storage.set(LS_URL, this.baseUrl)
  },

  url(path) {
    return `${this.baseUrl}${path}`
  },

  async req(method, path, body, { timeoutMs } = {}) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs || this.timeoutMs)
    let res
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl?.signal
      })
    } catch (e) {
      // 网络不可达/超时：统一 OFFLINE，交由上层决定是否降级离线模式
      throw new ApiError('OFFLINE', `服务端不可达（${e?.name === 'AbortError' ? '请求超时' : '网络错误'}）`, 0, { cause: e?.message })
    } finally {
      if (timer) clearTimeout(timer)
    }
    let data = null
    try { data = await res.json() } catch { data = null }
    if (!res.ok) {
      const err = data?.error || {}
      throw new ApiError(err.code || `HTTP_${res.status}`, err.message || `请求失败（${res.status}）`, res.status, err)
    }
    return data
  },

  get(path, opts) { return this.req('GET', path, undefined, opts) },
  // 写操作统一注入幂等键：服务端 idem 表按 (key) 去重，重试/双击/断网重发不产生二次落账
  post(path, body = {}, { idempotencyKey, ...opts } = {}) {
    const payload = { ...body }
    if (!payload.idempotencyKey) payload.idempotencyKey = idempotencyKey || newIdemKey(path.replace(/[^\w]+/g, '-'))
    return this.req('POST', path, payload, opts)
  },

  async ping(timeoutMs = 1500) {
    try {
      const r = await this.req('GET', '/health', undefined, { timeoutMs })
      return !!r?.ok
    } catch {
      return false
    }
  }
}
