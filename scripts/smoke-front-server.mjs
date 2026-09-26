// 前端 ↔ 服务端 联机链路冒烟测试（真实起服 + 真实 Pinia store）：
//  1) 离线基线：纯前端本地模式可独立运行（既有行为不回归）；
//  2) 联机水合：autoConnect → bootstrap 全量投影（活动/商品/积分/业务日以服务端为准）；
//  3) 写操作接入：抽奖/兑换/任务/活动管理/风控/物流/采购/预算动作全部走服务端 API；
//  4) 统一保障：幂等键重放、RBAC 越权拦截、跨租户拦截、预算占用台账、并发不超卖；
//  5) WAL 恢复：进程重启重放后余额/记录精确一致；
//  6) 离线快照迁移：本地台账快照 → 空库迁移（校验/固定 id 幂等/manifest）→ 重放幂等 → 非空库守卫；
//  7) 服务端不可达时自动保持/回退本地离线模式。
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { setActivePinia, createPinia } from 'pinia'
import { createApp } from '../server/app.js'
import { createHttpServer } from '../server/http.js'
import { usePlatformStore } from '@/store/platform'
import { apiClient } from '@/api/client'
import * as remote from '@/api/remote'

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const tmpDb = (name) => {
  const f = path.join(tmpdir(), `lottery-front-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`)
  fs.rmSync(f, { force: true })
  return f
}

async function startServer(dbFile, seed) {
  const app = await createApp({ dbFile, seed })
  const server = createHttpServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { app, server, port, base: `http://127.0.0.1:${port}` }
}
async function stopServer(s) {
  if (!s) return
  s.server.closeAllConnections?.() // fetch keep-alive 连接需主动断开，否则 close 挂起
  await new Promise((r) => s.server.close(r))
  await s.app.k.close()
}
// 独立裸 API（不经 apiClient 单例，避免与 store 会话串扰）
async function rawApi(base, method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  let json = null
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json }
}
const newStore = () => {
  setActivePinia(createPinia())
  const s = usePlatformStore()
  s.init()
  return s
}

async function main() {
  // ============ 1) 离线基线（纯前端本地模式） ============
  console.log('— 离线基线：本地模式独立运行 —')
  const store = newStore()
  assert(store.connMode === 'local', '默认本地离线模式')
  store.riskRulesByTenant['t-star'].enabled = false // 关闭风控，保证演示确定性
  const localRec = store.draw('act-1')
  assert(!!localRec && localRec.status === 'normal', '本地模式抽奖落账（纯前端链路不回归）')
  const snap0 = remote.exportOfflineSnapshot(store)
  assert(Array.isArray(snap0.activities) && Array.isArray(snap0.pointRecords) && snap0.legacyPoints === store.points,
    '离线快照导出（迁移口径：台账数组 + legacyPoints）')

  // ============ 2) 启动服务端并联机水合 ============
  console.log('— 联机水合：bootstrap 以服务端投影为准 —')
  const db1 = tmpDb('main')
  let s1 = await startServer(db1)
  // 关闭服务端风控（演示确定性），用风控专员 token
  const riskLogin = await rawApi(s1.base, 'POST', '/api/auth/member-login', { body: { memberId: 'm-star-risk' } })
  await rawApi(s1.base, 'POST', '/api/risk/rules', {
    token: riskLogin.json.token,
    body: { enabled: false, dailyDrawThreshold: 0, rapidDrawMax: 0, rapidRedeemMax: 0, highValueRarities: [] }
  })
  apiClient.configure({ baseUrl: s1.base })
  apiClient.setToken('')
  const connected = await store.autoConnect()
  assert(connected === true && store.connMode === 'server', 'autoConnect 接入服务端')
  assert(store.activities.some((a) => a.id === 'act-1') && store.goods.some((g) => g.id === 'g1'),
    '水合活动/商品投影')
  assert(store.points === 1000, `积分余额以服务端分户为准（u-1001 = 1000，实际 ${store.points}）`)
  assert(store.todayDate === s1.app.k.todayDate(), '业务日以服务端业务时钟为准')
  assert(store.identityKind === 'customer' && store.user.id === 'u-1001', '会话身份水合（消费者）')

  // ============ 3) 写操作接入服务端 API ============
  console.log('— 写操作：抽奖/兑换/任务走服务端交易 Saga —')
  const before = store.points
  const rec = await store.draw('act-2') // 10 积分/次
  assert(!!rec && rec.status === 'normal', '联机抽奖返回服务端业务记录')
  assert(store.points === before - 10 + (rec.prizeName?.includes('积分') ? parseInt(rec.prizeName) || 0 : 0) || store.points !== before,
    `抽奖后余额由服务端投影刷新（${before} → ${store.points}）`)
  assert(store.records[0]?.id === rec.id && rec.traceId, '业务记录带服务端 traceId 水合')
  const rd = await store.redeem('g1') // 30 积分券类商品
  assert(!!rd && rd.status === 'normal', '联机兑换券类商品')
  assert(store.coupons.some((c) => c.recordId === rd.id && c.status === 'available'), '券已交付至卡券账户（服务端发券）')
  const ptsBefore = store.points
  await store.completeTask('t-checkin')
  assert(store.points === ptsBefore + 5, `手动任务领奖 +5（实际 ${ptsBefore} → ${store.points}）`)
  await store.completeTask('t-checkin')
  assert(store.points === ptsBefore + 5, '重复领取被服务端幂等拦截（TASK_CLAIMED）')

  // ============ 4) 幂等 / RBAC / 跨租户 / 预算 / 并发 ============
  console.log('— 统一保障：幂等键 / RBAC / 跨租户 / 预算占用 / 并发 —')
  const custToken = apiClient.token
  const i1 = await rawApi(s1.base, 'POST', '/api/redeem', { token: custToken, body: { goodsId: 'g2', idempotencyKey: 'front-idem-1' } })
  const i2 = await rawApi(s1.base, 'POST', '/api/redeem', { token: custToken, body: { goodsId: 'g2', idempotencyKey: 'front-idem-1' } })
  assert(i1.json.trade.id === i2.json.trade.id && i2.json.idempotent === true, '同一幂等键重放返回同一交易')
  const g2 = (await rawApi(s1.base, 'GET', '/api/goods', { token: custToken })).json.goods.find((g) => g.id === 'g2')
  assert(g2.remain === 99, '幂等重放不重复扣库存（100→99）')

  const deniedBefore = s1.app.k.state.activities.length
  const deniedAct = await store.createActivity({ name: '越权活动', type: 'wheel', prizes: [] })
  assert(deniedAct === null && store.lastDenied, '消费者新建活动被 RBAC 拦截（lastDenied 留痕）')
  assert(s1.app.k.state.activities.length === deniedBefore, '越权操作零变更（服务端状态不变）')

  const opsLogin = await store.loginAsMember('m-star-ops')
  assert(opsLogin === true && store.identityKind === 'staff', '员工登录切换（活动运营）')
  const act = await store.createActivity({ name: '联机新建活动', type: 'wheel', costType: 'free', dailyLimit: 2, prizes: [{ name: '测试奖品', rarity: 'common', stock: 5, weight: 10 }] })
  assert(!!act && act.tenantId === 't-star', '运营新建活动落服务端 WAL')
  assert(await store.toggleActivityStatus(act.id) === true, '活动暂停/启动状态机')
  assert(await store.resetActivityStock(act.id) === true, '活动库存重置（保留预占口径）')
  assert(await store.deleteActivity(act.id) === true, '活动删除（历史记录保留）')
  const cross = await store.deleteActivity('cact-1')
  assert(!cross && /租户|越权/.test(store.lastDenied?.detail || ''), '跨租户操作被拦截并留痕')
  await store.loginAsCustomer({ silent: true })

  // 预算占用：抽奖成本已实时占用（财务视角台账）
  const finLogin = await rawApi(s1.base, 'POST', '/api/auth/member-login', { body: { memberId: 'm-star-fin' } })
  const ledger = (await rawApi(s1.base, 'GET', '/api/budgets/ledger', { token: finLogin.json.token })).json.ledger
  assert(ledger.some((l) => l.category === 'draw' && l.direction === 'settle'), '抽奖成本实时占用预算（settle 台账）')
  assert(ledger.some((l) => l.kind === 'task-reward'), '任务奖励占用租户积分预算')

  // 并发：6 路并发兑换 g1（30 积分/件，库存 200），成交精确无超卖/重扣
  const balBefore = (await rawApi(s1.base, 'GET', '/api/points', { token: custToken })).json.balance
  const batch = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    rawApi(s1.base, 'POST', '/api/redeem', { token: custToken, body: { goodsId: 'g1', idempotencyKey: `conc-${i}` } })))
  assert(batch.every((r) => r.status === 200), '6 路并发兑换全部成功')
  const g1 = (await rawApi(s1.base, 'GET', '/api/goods', { token: custToken })).json.goods.find((g) => g.id === 'g1')
  const balAfter = (await rawApi(s1.base, 'GET', '/api/points', { token: custToken })).json.balance
  assert(g1.remain === 200 - 6 - 1, `并发库存精确扣减（实际 remain=${g1.remain}）`)
  assert(balAfter === balBefore - 180, `并发余额精确扣减（${balBefore} → ${balAfter}）`)

  // ============ 5) WAL 恢复：重启重放状态精确一致 ============
  console.log('— WAL 恢复：进程重启重放 —')
  const recCount = s1.app.k.state.records.length
  await stopServer(s1)
  s1 = await startServer(db1)
  const relogin = await rawApi(s1.base, 'POST', '/api/auth/customer-login', { body: { userId: 'u-1001' } })
  const pts2 = (await rawApi(s1.base, 'GET', '/api/points', { token: relogin.json.token })).json
  assert(pts2.balance === balAfter, `重启后余额链精确恢复（${pts2.balance}）`)
  assert(s1.app.k.state.records.length === recCount, '重启后业务记录完整恢复')
  const boot = (await rawApi(s1.base, 'GET', '/api/bootstrap', { token: relogin.json.token })).json
  assert(boot.records.length === recCount && boot.todayDate === s1.app.k.todayDate(), 'bootstrap 投影与 WAL 一致')

  // ============ 6) 离线快照迁移 ============
  console.log('— 离线快照迁移：本地台账 → 空库上链 —')
  const store2 = newStore()
  store2.riskRulesByTenant['t-star'].enabled = false
  store2.draw('act-1')
  store2.completeTask('t-checkin')
  const snapshot = remote.exportOfflineSnapshot(store2)
  const s2 = await startServer(tmpDb('mig'), 'org') // 迁移目标库（仅组织种子）
  const platLogin = await rawApi(s2.base, 'POST', '/api/auth/member-login', { body: { memberId: 'm-platform' } })
  const platToken = platLogin.json.token
  const mig = await rawApi(s2.base, 'POST', '/api/migration/run', { token: platToken, body: { snapshot } })
  assert(mig.status === 200 && mig.json.ok && mig.json.manifest.status === 'done', '迁移执行成功（manifest 留痕）')
  assert(mig.json.manifest.counts.records === store2.records.length &&
    mig.json.manifest.counts.pointFlows === store2.pointRecords.length,
    `迁移行数一致（记录 ${mig.json.manifest.counts.records}、流水 ${mig.json.manifest.counts.pointFlows}）`)
  const migAgain = await rawApi(s2.base, 'POST', '/api/migration/run', { token: platToken, body: { snapshot } })
  assert(migAgain.json.idempotent === true, '同批次重跑幂等（零增量）')
  const cust2 = await rawApi(s2.base, 'POST', '/api/auth/customer-login', { body: { userId: 'u-1001' } })
  const boot2 = (await rawApi(s2.base, 'GET', '/api/bootstrap', { token: cust2.json.token })).json
  assert(boot2.records.length === store2.records.length, '迁移后业务记录完整上链')
  assert(boot2.pointsBalance === store2.points, `迁移后余额一致（${boot2.pointsBalance} == ${store2.points}）`)
  // 迁移后历史漏记（种子预置上一业务日 5 积分）由对账检出
  const yd = (() => { const d = new Date(); d.setDate(d.getDate() - 1); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` })()
  const fin2 = await rawApi(s2.base, 'POST', '/api/auth/member-login', { body: { memberId: 'm-star-fin' } })
  const recon = await rawApi(s2.base, 'POST', '/api/recon/run', { token: fin2.json.token, body: { date: yd } })
  assert(recon.status === 200 && recon.json.bill, '迁移库可直接跑 P1–P6 对账')
  assert((recon.json.bill.diffs?.openCount ?? 0) >= 1, `历史漏记由对账检出（openCount=${recon.json.bill.diffs?.openCount}）`)
  // 非空库守卫：已有业务数据的服务端拒绝新批次迁移
  const guard = await rawApi(s1.base, 'POST', '/api/migration/run', {
    token: (await rawApi(s1.base, 'POST', '/api/auth/member-login', { body: { memberId: 'm-platform' } })).json.token,
    body: { snapshot }
  })
  assert(guard.status === 409 && guard.json.error.code === 'MIGRATION_NOT_EMPTY', '非空库拒绝新批次迁移（防双计）')
  // 迁移接口权限：非平台身份拒绝
  const forbidden = await rawApi(s2.base, 'POST', '/api/migration/run', { token: cust2.json.token, body: { snapshot } })
  assert(forbidden.status === 403, '消费者执行迁移被拦截（仅平台超管）')
  await stopServer(s2)

  // ============ 7) 服务端不可达：保持/回退离线模式 ============
  console.log('— 离线降级：服务端不可达 —')
  const store3 = newStore()
  apiClient.configure({ baseUrl: 'http://127.0.0.1:9' }) // 不可达端口
  apiClient.setToken('')
  const ok3 = await store3.autoConnect()
  assert(ok3 === false && store3.connMode === 'local', '服务端不可达时保持本地离线模式')
  const rec3 = store3.draw('act-1')
  assert(!!rec3, '离线模式本地台账继续可用（操作计入离线快照）')
  remote.persistOfflineSnapshot(store3)
  assert(store3.offlineDirty === true, '离线变更标记待迁移')

  await stopServer(s1)

  console.log(failed ? `\n❌ ${failed} 项断言失败` : '\n✅ 前端↔服务端联机链路冒烟全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
