// HTTP API（纯 node:http，零第三方依赖）：
// 鉴权：/api/auth/* 登录换 token；其余接口需 Authorization: Bearer <token>；
// 写接口在服务层强制 RBAC 权限位 + tenantId 归属校验；所有写操作走交易 Saga，天然幂等/可续办。
import http from 'node:http'
import { URL } from 'node:url'
import { BizError, genId } from './util.js'
import { DEMO_USERS } from './seed.js'
import { PERMISSION_LABELS } from './mock-perms.js'

const PERMS = {
  reviewRisk: 'risk:review', ruleRisk: 'risk:rule',
  shipSend: 'ship:send', shipTrace: 'ship:trace', aftersaleReview: 'aftersale:review',
  purchaseApply: 'purchase:apply', purchaseApprove: 'purchase:approve', purchaseInbound: 'purchase:inbound',
  supplierBill: 'supplier:bill', supplierReview: 'supplier:review', supplierSettle: 'supplier:settle',
  budgetManage: 'budget:manage', budgetApprove: 'budget:approve',
  couponRedeem: 'coupon:redeem',
  reconRun: 'recon:run', reconReview: 'recon:review', reconCompensate: 'recon:compensate',
  activityManage: 'activity:manage'
}

export function createHttpServer(app) {
  const json = (res, status, data) => {
    const body = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(body)
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(app, req, res, json)
    } catch (err) {
      if (err instanceof BizError) {
        json(res, err.status, { ok: false, error: { code: err.code, message: err.message } })
      } else {
        console.error('[server error]', err)
        json(res, 500, { ok: false, error: { code: 'INTERNAL', message: err.message } })
      }
    }
  })
  return server
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
  })
}

function sessionOf(app, req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
  if (!m) throw new BizError('UNAUTHORIZED', '缺少 Authorization: Bearer <token>', 401)
  return app.auth.requireSession(m[1].trim())
}

// 员工/平台接口统一 RBAC 门禁
async function requireStaffPerm(app, session, perm) {
  await app.auth.requirePerm(session, perm, 'api', PERMISSION_LABELS[perm] || perm)
}

async function route(app, req, res, json) {
  const u = new URL(req.url, 'http://localhost')
  const p = u.pathname
  const method = req.method
  const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {}

  // —— 健康检查 / 目录 ——
  if (method === 'GET' && p === '/health') return json(res, 200, { ok: true, service: 'lottery-server', ts: Date.now() })
  if (method === 'GET' && p === '/api/catalog/users') return json(res, 200, { users: DEMO_USERS })

  // —— 鉴权 ——
  if (method === 'POST' && p === '/api/auth/customer-login') {
    const user = DEMO_USERS.find((x) => x.id === body.userId) || DEMO_USERS[0]
    const { token, session } = await app.auth.loginCustomer(user.id, user.name, {
      tenantId: body.tenantId || 't-star', ip: req.socket.remoteAddress
    })
    return json(res, 200, { token, session: publicSession(session) })
  }
  if (method === 'POST' && p === '/api/auth/member-login') {
    const { token, session } = await app.auth.loginMember(body.memberId, { ip: req.socket.remoteAddress })
    return json(res, 200, { token, session: publicSession(session) })
  }
  if (method === 'POST' && p === '/api/auth/switch-tenant') {
    const session = sessionOf(app, req)
    await app.auth.switchTenant(session, body.tenantId)
    return json(res, 200, { session: publicSession(session) })
  }
  if (method === 'POST' && p === '/api/auth/logout') {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    if (m) app.auth.logout(m[1].trim())
    return json(res, 200, { ok: true })
  }

  const session = sessionOf(app, req)
  const tid = () => session.tenantId

  // —— 查询类 ——
  if (method === 'GET' && p === '/api/me') return json(res, 200, { session: publicSession(session) })
  // 前端联机水合：一次性返回当前身份/租户作用域内的全部业务投影（WAL 重放后的服务端真实状态）
  if (method === 'GET' && p === '/api/bootstrap') {
    return json(res, 200, bootstrap(app, session))
  }
  if (method === 'GET' && p === '/api/dashboard') {
    return json(res, 200, dashboard(app, tid()))
  }
  if (method === 'GET' && p === '/api/activities') {
    const list = app.k.state.activities.filter((a) => a.tenantId === tid())
    return json(res, 200, { activities: list })
  }
  if (method === 'GET' && p === '/api/goods') {
    const list = app.k.state.goods.filter((g) => (g.tenantId || 't-star') === tid())
    return json(res, 200, { goods: list })
  }
  if (method === 'GET' && p === '/api/points') {
    return json(res, 200, {
      balance: app.points.balanceOf(session.userId),
      flows: app.points.flowsOf(session.userId).filter((f) => (f.tenantId || 't-star') === tid()).slice(0, 200)
    })
  }
  if (method === 'GET' && p === '/api/records') {
    const mine = body.mine !== false && session.identityKind === 'customer'
    const list = app.k.state.records
      .filter((r) => (r.tenantId || 't-star') === tid())
      .filter((r) => !mine || r.userId === session.userId)
      .sort((a, b) => b.ts - a.ts).slice(0, 200)
    return json(res, 200, { records: list })
  }
  if (method === 'GET' && p === '/api/coupons/my') {
    return json(res, 200, {
      coupons: app.k.state.coupons
        .filter((c) => (c.tenantId || 't-star') === tid() && c.userId === session.userId)
        .sort((a, b) => b.ts - a.ts)
    })
  }
  if (method === 'GET' && p === '/api/shipments') {
    const mine = session.identityKind === 'customer'
    const list = app.k.state.shipments
      .filter((o) => (o.tenantId || 't-star') === tid())
      .filter((o) => !mine || o.userId === session.userId)
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, { shipments: list })
  }
  if (method === 'GET' && p === '/api/aftersales') {
    const mine = session.identityKind === 'customer'
    const list = app.k.state.afterSales
      .filter((a) => (a.tenantId || 't-star') === tid())
      .filter((a) => !mine || a.userId === session.userId)
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, { afterSales: list })
  }
  if (method === 'GET' && p === '/api/purchases') {
    const list = app.k.state.purchaseOrders
      .filter((o) => (o.tenantId || 't-star') === tid())
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, {
      purchases: list,
      batches: app.k.state.inboundBatches.filter((b) => (b.tenantId || 't-star') === tid()),
      acceptDiffs: app.k.state.acceptDiffs.filter((b) => (b.tenantId || 't-star') === tid())
    })
  }
  if (method === 'GET' && p === '/api/supplier/bills') {
    return json(res, 200, {
      bills: app.k.state.supplierBills
        .filter((b) => (b.tenantId || 't-star') === tid())
        .sort((a, b) => b.ts - a.ts)
    })
  }
  if (method === 'GET' && p === '/api/supplier/recon') {
    return json(res, 200, { recon: app.supplier.computeRecon(tid()) })
  }
  if (method === 'GET' && p === '/api/budgets') {
    const list = app.budget.list(tid()).map((b) => ({ ...b, summary: app.budget.summary(b.id) }))
    return json(res, 200, { budgets: list })
  }
  if (method === 'GET' && p === '/api/budgets/ledger') {
    return json(res, 200, { ledger: app.budget.ledger(tid()) })
  }
  if (method === 'GET' && p === '/api/budgets/dashboard') {
    return json(res, 200, { dashboard: app.budget.dashboard(tid()) })
  }
  if (method === 'GET' && p === '/api/risk/orders') {
    const list = app.k.state.riskOrders
      .filter((o) => (o.tenantId || 't-star') === tid())
      .filter((o) => session.identityKind === 'customer' ? o.userId === session.userId : true)
      .sort((a, b) => b.ts - a.ts)
    return json(res, 200, { orders: list })
  }
  if (method === 'GET' && p === '/api/risk/rules') {
    return json(res, 200, { rules: app.risk.rulesOf(tid()) })
  }
  if (method === 'GET' && p.startsWith('/api/audit')) {
    await requireStaffPerm(app, session, 'audit:view')
    const q = {
      tenantId: u.searchParams.get('tenantId') || tid(),
      module: u.searchParams.get('module') || '',
      result: u.searchParams.get('result') || '',
      traceId: u.searchParams.get('traceId') || '',
      keyword: u.searchParams.get('keyword') || ''
    }
    if (u.searchParams.get('traceId')) {
      return json(res, 200, { timeline: app.audit.timeline(q.traceId) })
    }
    return json(res, 200, { logs: app.audit.query(q).slice(0, 200) })
  }
  if (method === 'GET' && p === '/api/recon/dates') {
    const dates = new Set()
    app.k.state.records.forEach((r) => { if ((r.tenantId || 't-star') === tid()) dates.add(r.date) })
    app.k.state.taskClaims.forEach((c) => { if ((c.tenantId || 't-star') === tid()) dates.add(c.bizDate) })
    dates.add(app.k.todayDate())
    return json(res, 200, { dates: [...dates].sort().reverse() })
  }
  if (method === 'GET' && p === '/api/recon/bill') {
    const date = u.searchParams.get('date') || app.k.todayDate()
    return json(res, 200, { bill: app.recon.billOf(date, tid()) })
  }

  // —— 写：交易链路（客户）——
  if (method === 'POST' && p === '/api/draw') {
    const r = await app.trade.draw(body.activityId, session, { idempotencyKey: body.idempotencyKey })
    return json(res, 200, { ok: true, ...stripTrade(r.trade), idempotent: !!r.idempotent })
  }
  if (method === 'POST' && p === '/api/redeem') {
    const r = await app.trade.redeem(body.goodsId, session, { idempotencyKey: body.idempotencyKey })
    return json(res, 200, { ok: true, ...stripTrade(r.trade), idempotent: !!r.idempotent })
  }
  if (method === 'POST' && p === '/api/risk/appeal') {
    const row = await app.risk.appeal(body.orderId, body.reason, session)
    return json(res, 200, { ok: true, order: row })
  }
  if (method === 'POST' && p === '/api/shipments/address') {
    const row = await app.ship.submitAddress(body.shipmentId, body, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/shipments/receive') {
    const row = await app.ship.receive(body.shipmentId, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/shipments/trace') {
    // 客户与有权限员工均可同步本人/本租户订单
    const o = app.ship.requireShipment(body.shipmentId)
    if (session.identityKind === 'customer') {
      if (o.userId !== session.userId || (o.tenantId || 't-star') !== tid()) throw new BizError('FORBIDDEN', '只能查询自己的物流', 403)
    } else {
      await requireStaffPerm(app, session, PERMS.shipTrace)
      await app.auth.requireSameTenant(session, o.tenantId, 'ship')
    }
    const row = await app.ship.syncTrace(body.shipmentId, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/aftersales/apply') {
    const row = await app.ship.applyAfterSale(body.shipmentId, body.type, body.reason, session)
    return json(res, 200, { ok: true, afterSale: row })
  }

  // —— 写：运营 ——
  if (method === 'POST' && p === '/api/risk/review') {
    await requireStaffPerm(app, session, PERMS.reviewRisk)
    const o = app.k.state.riskOrders.find((x) => x.id === body.orderId)
    if (!o) throw new BizError('ORDER_NOT_FOUND', '审核单不存在', 404)
    await app.auth.requireSameTenant(session, o.tenantId, 'risk')
    const row = await app.risk.review(body.orderId, body.action, body.note, session)
    return json(res, 200, { ok: true, order: row })
  }
  if (method === 'POST' && p === '/api/risk/rules') {
    await requireStaffPerm(app, session, PERMS.ruleRisk)
    const rules = await app.risk.updateRules(tid(), body, session)
    return json(res, 200, { ok: true, rules })
  }
  if (method === 'POST' && p === '/api/shipments/send') {
    await requireStaffPerm(app, session, PERMS.shipSend)
    const o = app.ship.requireShipment(body.shipmentId)
    await app.auth.requireSameTenant(session, o.tenantId, 'ship')
    const row = await app.ship.ship(body.shipmentId, body, session)
    return json(res, 200, { ok: true, shipment: row })
  }
  if (method === 'POST' && p === '/api/aftersales/review') {
    await requireStaffPerm(app, session, PERMS.aftersaleReview)
    const as = app.k.state.afterSales.find((x) => x.id === body.afterSaleId)
    if (!as) throw new BizError('AS_NOT_FOUND', '售后单不存在', 404)
    await app.auth.requireSameTenant(session, as.tenantId, 'aftersale')
    const row = await app.ship.reviewAfterSale(body.afterSaleId, !!body.approve, body.note || '', session)
    return json(res, 200, { ok: true, afterSale: row })
  }
  if (method === 'POST' && p === '/api/purchases/create') {
    await requireStaffPerm(app, session, PERMS.purchaseApply)
    const row = await app.purchase.createOrder(body, session)
    return json(res, 200, { ok: true, purchase: row })
  }
  if (method === 'POST' && p === '/api/purchases/review') {
    await requireStaffPerm(app, session, PERMS.purchaseApprove)
    const po = app.k.state.purchaseOrders.find((x) => x.id === body.purchaseId)
    if (!po) throw new BizError('PO_NOT_FOUND', '采购单不存在', 404)
    await app.auth.requireSameTenant(session, po.tenantId, 'purchase')
    const row = await app.purchase.reviewOrder(body.purchaseId, !!body.approve, body.note || '', session)
    return json(res, 200, { ok: true, purchase: row })
  }
  if (method === 'POST' && p === '/api/purchases/cancel') {
    await requireStaffPerm(app, session, PERMS.purchaseApply)
    const po = app.k.state.purchaseOrders.find((x) => x.id === body.purchaseId)
    if (!po) throw new BizError('PO_NOT_FOUND', '采购单不存在', 404)
    await app.auth.requireSameTenant(session, po.tenantId, 'purchase')
    const row = await app.purchase.cancelOrder(body.purchaseId, session)
    return json(res, 200, { ok: true, purchase: row })
  }
  if (method === 'POST' && p === '/api/purchases/inbound') {
    await requireStaffPerm(app, session, PERMS.purchaseInbound)
    const po = app.k.state.purchaseOrders.find((x) => x.id === body.purchaseId)
    if (!po) throw new BizError('PO_NOT_FOUND', '采购单不存在', 404)
    await app.auth.requireSameTenant(session, po.tenantId, 'purchase')
    const r = await app.purchase.inbound(body.purchaseId, body, session)
    return json(res, 200, { ok: true, ...r })
  }
  if (method === 'POST' && p === '/api/supplier/bills/create') {
    await requireStaffPerm(app, session, PERMS.supplierBill)
    const po = app.k.state.purchaseOrders.find((x) => x.id === body.purchaseId)
    if (!po) throw new BizError('PO_NOT_FOUND', '采购单不存在', 404)
    await app.auth.requireSameTenant(session, po.tenantId, 'supplier')
    const bill = await app.supplier.createBill(body.purchaseId, body, session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/supplier/bills/submit') {
    await requireStaffPerm(app, session, PERMS.supplierBill)
    const cur = app.supplier.requireBill(body.billId)
    if (!cur) throw new BizError('BILL_NOT_FOUND', '供应商账单不存在', 404)
    await app.auth.requireSameTenant(session, cur.tenantId, 'supplier')
    const bill = await app.supplier.submitBill(body.billId, body, session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/supplier/bills/review') {
    await requireStaffPerm(app, session, PERMS.supplierReview)
    const cur = app.supplier.requireBill(body.billId)
    if (!cur) throw new BizError('BILL_NOT_FOUND', '供应商账单不存在', 404)
    await app.auth.requireSameTenant(session, cur.tenantId, 'supplier')
    const bill = await app.supplier.reviewBill(body.billId, !!body.approve, body.note || '', session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/supplier/bills/settle') {
    await requireStaffPerm(app, session, PERMS.supplierSettle)
    const cur = app.supplier.requireBill(body.billId)
    if (!cur) throw new BizError('BILL_NOT_FOUND', '供应商账单不存在', 404)
    await app.auth.requireSameTenant(session, cur.tenantId, 'supplier')
    const bill = await app.supplier.settleBill(body.billId, body.note || '', session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/coupons/redeem') {
    await requireStaffPerm(app, session, PERMS.couponRedeem)
    const r = await app.coupons.redeem(body.code, session, body)
    return json(res, 200, { ok: true, ...r })
  }
  if (method === 'POST' && p === '/api/recon/run') {
    await requireStaffPerm(app, session, PERMS.reconRun)
    const bill = await app.recon.run(body.date || app.k.todayDate(), tid(), session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/recon/diffs') {
    await requireStaffPerm(app, session, PERMS.reconRun)
    const diffs = app.recon.compute(body.date || app.k.todayDate(), tid())
    return json(res, 200, { ok: true, diffs })
  }
  if (method === 'POST' && p === '/api/recon/review') {
    await requireStaffPerm(app, session, PERMS.reconReview)
    const bill = await app.recon.review(body.date, tid(), body.note || '', session)
    return json(res, 200, { ok: true, bill })
  }
  if (method === 'POST' && p === '/api/recon/compensate') {
    await requireStaffPerm(app, session, PERMS.reconCompensate)
    const r = await app.recon.compensate(body.date, tid(), body.note || '', session)
    return json(res, 200, { ok: true, ...r, bill: undefined })
  }
  if (method === 'POST' && p === '/api/activities') {
    await requireStaffPerm(app, session, PERMS.activityManage)
    const row = await createActivity(app, body, session)
    return json(res, 200, { ok: true, activity: row })
  }
  if (method === 'POST' && p === '/api/activities/status') {
    await requireStaffPerm(app, session, PERMS.activityManage)
    const a = app.k.state.activities.find((x) => x.id === body.activityId)
    if (!a) throw new BizError('ACT_NOT_FOUND', '活动不存在', 404)
    await app.auth.requireSameTenant(session, a.tenantId, 'activity')
    const map = { running: 'paused', paused: 'running', ended: 'running' }
    const next = { ...a, status: map[a.status] || 'running' }
    await app.k.commit([{ type: 'upsert', table: 'activities', row: next }])
    await app.audit.log('activity-toggle', a.id,
      `活动【${a.name}】状态变更为${next.status === 'running' ? '运行中' : next.status === 'paused' ? '已暂停' : '已结束'}`,
      { tenantId: a.tenantId, ctx: session, module: 'activity' })
    return json(res, 200, { ok: true, activity: next })
  }
  if (method === 'POST' && p === '/api/activities/reset-stock') {
    await requireStaffPerm(app, session, PERMS.activityManage)
    const a = app.k.state.activities.find((x) => x.id === body.activityId)
    if (!a) throw new BizError('ACT_NOT_FOUND', '活动不存在', 404)
    await app.auth.requireSameTenant(session, a.tenantId, 'activity')
    // 重置时不动审核中预占的库存：remain 恢复为 总库存 - 冻结预占（与前端本地口径一致）
    const next = { ...a, prizes: a.prizes.map((p) => ({ ...p, remain: p.stock - (p.frozen || 0) })) }
    await app.k.commit([{ type: 'upsert', table: 'activities', row: next }])
    await app.audit.log('activity-stock-reset', a.id, `活动【${a.name}】奖品库存重置（风控预占保留）`,
      { tenantId: a.tenantId, ctx: session, module: 'activity' })
    return json(res, 200, { ok: true, activity: next })
  }
  if (method === 'POST' && p === '/api/activities/delete') {
    await requireStaffPerm(app, session, PERMS.activityManage)
    const a = app.k.state.activities.find((x) => x.id === body.activityId)
    if (!a) throw new BizError('ACT_NOT_FOUND', '活动不存在', 404)
    await app.auth.requireSameTenant(session, a.tenantId, 'activity')
    await app.k.commit([{ type: 'remove', table: 'activities', id: a.id }])
    await app.audit.log('activity-delete', a.id, `删除活动【${a.name}】（配置删除，历史业务记录保留）`,
      { tenantId: a.tenantId, ctx: session, module: 'activity' })
    return json(res, 200, { ok: true, removed: a.id })
  }
  // 手动任务（每日签到/观看/分享/一次性任务）领取：抽奖任务由交易链路自动结算，禁止手动领取。
  // 幂等：日任务按 任务×业务日×用户 判重；一次性任务按 任务×用户 判重（taskClaims 台账）。
  if (method === 'POST' && p === '/api/tasks/complete') {
    const t = app.k.state.tasks.find((x) => x.id === body.taskId)
    if (!t) throw new BizError('TASK_NOT_FOUND', '任务不存在', 404)
    if (t.metric === 'draw') throw new BizError('TASK_AUTO', '抽奖任务按真实参与记录自动结算，达标后自动发奖', 400)
    const tenantId = tid()
    const date = app.k.todayDate()
    const dup = app.k.state.taskClaims.some((c) => c.taskId === t.id && c.userId === session.userId &&
      (c.tenantId || 't-star') === tenantId && (t.type === 'once' || c.bizDate === date))
    if (dup) throw new BizError('TASK_CLAIMED', '该任务已领取，请勿重复操作', 409)
    const claimId = genId('tc')
    // 营销预算实时占用：任务积分奖励（租户积分预算，超额/冻结整笔阻断，effectId 幂等）
    await app.budget.occupy('settle',
      { unit: 'points', amount: t.reward, scopeType: 'tenant', scopeId: tenantId },
      { category: 'points', kind: 'task-reward', refType: 'task-claim', refId: claimId, bizNo: t.label,
        summary: `任务奖励：${t.label} +${t.reward} 积分`, tenantId, userId: session.userId },
      { name: session.name, userId: session.userId, tenantId })
    const { flow } = await app.points.post({
      userId: session.userId, delta: t.reward, note: `完成任务：${t.label}`,
      kind: 'reward', tenantId, bizDate: date, refId: claimId, refType: 'task-manual'
    })
    const claim = {
      id: claimId, taskId: t.id, taskLabel: t.label, reward: t.reward,
      userId: session.userId, tenantId, bizDate: date, grantDate: date,
      time: app.k.nowTime(), ts: app.k.nowTs(), source: 'manual', flowId: flow.id
    }
    await app.k.commit([{ type: 'insert', table: 'taskClaims', row: claim }])
    await app.audit.log('task-claim', claimId, `用户【${session.name}】完成任务【${t.label}】，发放 ${t.reward} 积分`,
      { tenantId, ctx: session, module: 'points' })
    return json(res, 200, { ok: true, claim })
  }

  // —— 离线快照迁移（仅平台超管）：前端离线模式产生的本地台账快照，校验后重建为服务端事件 ——
  if (method === 'GET' && p === '/api/migrations') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可查看迁移批次', 403)
    return json(res, 200, { migrations: app.k.state.migrations })
  }
  if (method === 'POST' && p === '/api/migration/run') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台超管可执行离线快照迁移', 403)
    const snap = body.snapshot || body
    if (!snap || typeof snap !== 'object') throw new BizError('BAD_FORM', '缺少快照内容', 400)
    // 守卫：迁移只允许导入「无业务数据的库」（防止与既有台账双计余额/库存）；
    // 同批次 manifest 已存在时放行（中断重跑/重复提交幂等零增量）。
    const batchId = `mig-${snap.source || 'legacy'}-${snap.migratedAt || 'all'}`
    const dup = app.k.state.migrations.find((m) => m.id === batchId)
    const hasBusiness = app.k.state.records.length > 0 || app.k.state.pointFlows.length > 0 || app.k.state.coupons.length > 0
    if (hasBusiness && !dup) {
      throw new BizError('MIGRATION_NOT_EMPTY',
        '目标服务端已存在业务数据：离线快照迁移仅允许导入空库（--no-seed 启动）或同批次幂等重放', 409)
    }
    const r = await app.migration.run(snap, { ctx: session })
    return json(res, 200, { ok: true, ...r })
  }

  // —— 写：营销预算与成本控制 ——
  if (method === 'POST' && p === '/api/budgets/create') {
    await requireStaffPerm(app, session, PERMS.budgetManage)
    const row = await app.budget.create(body, session)
    return json(res, 200, { ok: true, budget: row })
  }
  if (method === 'POST' && p === '/api/budgets/review') {
    await requireStaffPerm(app, session, PERMS.budgetApprove)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.review(body.budgetId, !!body.approve, body.note || '', session)
    return json(res, 200, { ok: true, budget: row })
  }
  if (method === 'POST' && p === '/api/budgets/cancel') {
    await requireStaffPerm(app, session, PERMS.budgetManage)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.cancel(body.budgetId, session)
    return json(res, 200, { ok: true, budget: row })
  }
  if (method === 'POST' && p === '/api/budgets/freeze') {
    await requireStaffPerm(app, session, PERMS.budgetApprove)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.setFrozen(body.budgetId, true, body.note || '', session)
    return json(res, 200, { ok: true, budget: row })
  }
  if (method === 'POST' && p === '/api/budgets/activate') {
    await requireStaffPerm(app, session, PERMS.budgetApprove)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.setFrozen(body.budgetId, false, body.note || '', session)
    return json(res, 200, { ok: true, budget: row })
  }
  if (method === 'POST' && p === '/api/budgets/close') {
    await requireStaffPerm(app, session, PERMS.budgetApprove)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.close(body.budgetId, body.note || '', session)
    return json(res, 200, { ok: true, budget: row })
  }
  if (method === 'POST' && p === '/api/budgets/adjust') {
    await requireStaffPerm(app, session, PERMS.budgetManage)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.requestAdjust(body.budgetId, Number(body.delta) || 0, body.reason || '', session)
    return json(res, 200, { ok: true, adjustment: row })
  }
  if (method === 'POST' && p === '/api/budgets/adjust-review') {
    await requireStaffPerm(app, session, PERMS.budgetApprove)
    const cur = app.budget.requireBudget(body.budgetId)
    await app.auth.requireSameTenant(session, cur.tenantId, 'budget')
    const row = await app.budget.reviewAdjust(body.budgetId, body.adjustId, !!body.approve, body.note || '', session)
    return json(res, 200, { ok: true, budget: row })
  }

  // —— 运维：故障注入/续办/跨日（仅平台超管或本地演示令牌）——
  if (method === 'POST' && p === '/api/admin/fault') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可注入故障', 403)
    app.k.injectFault(body.name)
    return json(res, 200, { ok: true, injected: body.name })
  }
  if (method === 'POST' && p === '/api/admin/resume') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可执行续办', 403)
    const trades = await app.trade.resumeAll(session)
    const orders = await app.risk.resumeProcessing()
    return json(res, 200, { ok: true, resumedTrades: trades, resumedOrders: orders })
  }
  if (method === 'POST' && p === '/api/admin/day') {
    if (session.identityKind !== 'platform') throw new BizError('FORBIDDEN', '仅平台方可切换业务日', 403)
    if (body.day) app.k.setBusinessDay(body.day)
    else app.k.advanceDay(body.n || 1)
    const r = await app.trade.rollover(session)
    return json(res, 200, { ok: true, today: app.k.todayDate(), ...r })
  }

  json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${method} ${p} 不存在` } })
}

function publicSession(s) {
  return {
    identityKind: s.identityKind, memberId: s.memberId, userId: s.userId,
    name: s.name, tenantId: s.tenantId
  }
}

// 前端联机水合快照：按会话身份与当前数据上下文租户做作用域裁剪。
//  - 消费者：可见全部活跃租户（"逛店"），业务记录/物流/卡券/积分流水仅本人；
//  - 员工：锁定归属租户，可见本租户全部业务投影与成员目录；
//  - 平台超管：跨租户巡检，可见全部。
// 业务日一律以服务端业务时钟为准（跨日审核/虚拟业务日场景前端不得自行推日）。
function bootstrap(app, session) {
  const tid = session.tenantId || 't-star'
  const isCustomer = session.identityKind === 'customer'
  const isPlatform = session.identityKind === 'platform'
  const st = app.k.state
  const visibleTenants = st.tenants.filter((t) =>
    (isCustomer || isPlatform) ? t.status === 'active' : t.id === tid)
  const tids = new Set(visibleTenants.map((t) => t.id))
  const inVisible = (x) => tids.has(x.tenantId || 't-star')
  const inT = (x) => (x.tenantId || 't-star') === tid
  const mine = (x) => x.userId === session.userId
  // 业务投影：消费者看本人（跨可见租户），员工/平台看当前上下文租户
  const scoped = (arr) => arr.filter((x) => (isCustomer ? inVisible(x) && mine(x) : inT(x)))
  const canAudit = isPlatform || app.auth.can(session, 'audit:view')
  const flows = isCustomer
    ? st.pointFlows.filter((f) => inVisible(f) && mine(f))
    : st.pointFlows.filter(inT)
  return {
    session: publicSession(session),
    todayDate: app.k.todayDate(),
    tenants: visibleTenants,
    members: st.members.filter((m) => !m.tenantId || tids.has(m.tenantId)),
    customRoles: st.customRoles.filter((r) => tids.has(r.tenantId)),
    activities: st.activities.filter((a) => tids.has(a.tenantId)),
    goods: st.goods.filter(inVisible),
    tasks: st.tasks,
    pointsBalance: st.balances[session.userId] || 0,
    pointRecords: flows.slice(-500),
    records: scoped(st.records).slice(-500),
    riskOrders: scoped(st.riskOrders),
    riskRulesByTenant: Object.fromEntries(
      [...tids].map((t) => [t, st.riskRules[t] || null]).filter(([, v]) => v)),
    shipments: scoped(st.shipments),
    afterSales: scoped(st.afterSales),
    coupons: scoped(st.coupons),
    couponLogs: isCustomer ? st.couponLogs.filter((l) => inVisible(l) && mine(l)) : st.couponLogs.filter(inT),
    taskClaims: scoped(st.taskClaims),
    purchaseOrders: isCustomer ? [] : st.purchaseOrders.filter(inT),
    inboundBatches: isCustomer ? [] : st.inboundBatches.filter(inT),
    acceptDiffs: isCustomer ? [] : st.acceptDiffs.filter(inT),
    supplierBills: isCustomer ? [] : st.supplierBills.filter(inT),
    budgets: isCustomer ? [] : st.budgets.filter(inT),
    budgetLedger: isCustomer ? [] : st.budgetLedger.filter(inT),
    reconBills: isCustomer ? [] : st.reconBills.filter(inT),
    stockAdjustments: isCustomer ? [] : st.stockAdjustments.filter(inT),
    auditLogs: canAudit ? st.auditLogs.filter(inVisible).slice(-500) : []
  }
}

function stripTrade(r) {
  if (!r) return {}
  const { processing, stages, ...rest } = r
  return { trade: rest }
}

async function createActivity(app, body, session) {
  const id = 'act-' + Date.now().toString(36)
  const prizes = (body.prizes || []).map((p, i) => ({
    id: `p${i}-${id}`,
    name: p.name,
    rarity: p.rarity || 'common',
    stock: p.stock || 10, remain: p.stock || 10, frozen: 0,
    weight: p.weight || 10,
    physical: p.physical !== undefined ? !!p.physical : !p.name.includes('积分'),
    emoji: p.emoji || '🎁',
    couponId: p.couponId || ''
  }))
  if (!prizes.some((p) => p.rarity === 'none')) {
    prizes.push({ id: `p-none-${id}`, name: '谢谢参与', rarity: 'none', stock: 99999, remain: 99999, frozen: 0, weight: 100, emoji: '🤝', physical: false })
  }
  const act = {
    id, tenantId: session.tenantId, name: body.name, type: body.type || 'wheel',
    status: 'running', cost: body.cost || 0, costType: body.costType || 'free',
    dailyLimit: body.dailyLimit || 3, totalLimit: body.totalLimit || 50,
    icon: '🎪', desc: body.desc || '新活动', prizes
  }
  await app.k.commit([{ type: 'upsert', table: 'activities', row: act }])
  await app.audit.log('activity-create', act.id, `新建活动【${act.name}】（${prizes.length} 个奖品）`, { tenantId: act.tenantId, ctx: session })
  return act
}

function dashboard(app, tid) {
  const inT = (x) => (x.tenantId || 't-star') === tid
  const records = app.k.state.records.filter(inT)
  const draws = records.filter((r) => r.type === 'draw' && r.status !== 'revoked')
  return {
    tenantId: tid,
    totalDraws: draws.length,
    participants: new Set(draws.map((r) => r.userId)).size,
    goodsSold: records.filter((r) => r.type === 'redeem' && r.status !== 'revoked').length,
    pendingRisk: app.k.state.riskOrders.filter((o) => inT(o) && ['pending', 'appealed'].includes(o.status)).length,
    frozenPoints: app.k.state.riskOrders.filter((o) => inT(o) && ['pending', 'appealed'].includes(o.status)).reduce((s, o) => s + (o.frozenPoints || 0), 0),
    stock: [...app.k.state.activities.filter((a) => a.tenantId === tid).flatMap((a) => a.prizes.map((p) => ({ key: `prize:${a.id}:${p.id}`, name: `${a.name}/${p.name}`, remain: p.remain, frozen: p.frozen || 0 }))),
      ...app.k.state.goods.filter((g) => inT(g)).map((g) => ({ key: `goods:${g.id}`, name: g.name, remain: g.remain, frozen: g.frozen || 0 }))],
    couponIssued: app.k.state.coupons.filter(inT).length,
    couponAvailable: app.k.state.coupons.filter((c) => inT(c) && c.status === 'available').length,
    couponRedeemed: app.k.state.coupons.filter((c) => inT(c) && c.status === 'redeemed').length,
    shipments: {
      pendingAddress: app.k.state.shipments.filter((o) => inT(o) && o.status === 'pending_address').length,
      toShip: app.k.state.shipments.filter((o) => inT(o) && o.status === 'to_ship').length,
      shipped: app.k.state.shipments.filter((o) => inT(o) && o.status === 'shipped').length,
      received: app.k.state.shipments.filter((o) => inT(o) && o.status === 'received').length,
      returned: app.k.state.shipments.filter((o) => inT(o) && o.status === 'returned').length
    },
    afterSalePending: app.k.state.afterSales.filter((a) => inT(a) && a.status === 'pending').length,
    afterSaleWaiting: app.k.state.afterSales.filter((a) => inT(a) && a.status === 'waiting_stock').length,
    purchasePending: app.k.state.purchaseOrders.filter((o) => inT(o) && o.status === 'pending').length,
    purchaseToInbound: app.k.state.purchaseOrders.filter((o) => inT(o) && ['approved', 'receiving'].includes(o.status)).length,
    purchaseReceived: app.k.state.purchaseOrders.filter((o) => inT(o) && o.status === 'received').length,
    purchaseDiffClosed: app.k.state.purchaseOrders.filter((o) => inT(o) && o.status === 'diff_closed').length,
    purchaseInboundQty: app.k.state.inboundBatches.filter((b) => inT(b)).reduce((n, b) => n + (b.qty || 0), 0),
    acceptDiffCount: app.k.state.acceptDiffs.filter((d) => inT(d)).length,
    supplierBills: app.k.state.supplierBills.filter((b) => inT(b)).length,
    supplierReviewing: app.k.state.supplierBills.filter((b) => inT(b) && b.status === 'reviewing').length,
    supplierApproved: app.k.state.supplierBills.filter((b) => inT(b) && b.status === 'approved').length,
    supplierSettled: app.k.state.supplierBills.filter((b) => inT(b) && b.status === 'settled').length,
    supplierPaid: app.k.state.supplierBills.filter((b) => inT(b) && b.status === 'settled').reduce((n, b) => n + (b.payableAmount || 0), 0),
    reconBills: app.k.state.reconBills.filter((b) => inT(b)).length,
    reconOpen: app.k.state.reconBills.filter((b) => inT(b) && ['pending', 'reviewed'].includes(b.status)).length,
    budget: app.budget.dashboard(tid)
  }
}
