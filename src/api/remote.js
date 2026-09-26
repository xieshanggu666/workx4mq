// 前端 ↔ 服务端 联机层：
//  - connectServer：健康探测 → 会话恢复/登录 → bootstrap 全量水合（服务端 WAL 投影为唯一真实源）；
//  - 远程动作：与 store 本地动作同签名同返回契约，写操作一律走服务端 API
//    （租户权限/RBAC、幂等键、按键互斥并发、Saga 崩溃续办全部由服务端统一保障）；
//  - 离线快照：localStorage 持久化（断线续跑）+ 平台超管一键迁移上链（校验 → 固定 id 幂等重建 → manifest 留痕）。
import { apiClient, ApiError } from './client'
import { COUPONS } from '@/mock/data'
import { CLOUD_COUPONS, CUSTOMER } from '@/mock/tenant'

const LS_SNAP = 'lottery.offline.snapshot'

const kv = {
  get(k) { try { return globalThis.localStorage?.getItem(k) ?? null } catch { return null } },
  set(k, v) { try { globalThis.localStorage?.setItem(k, v) } catch { /* Node/隐私模式 */ } },
  del(k) { try { globalThis.localStorage?.removeItem(k) } catch { /* ignore */ } }
}

const deep = (x) => JSON.parse(JSON.stringify(x))
const descTs = (arr) => (arr || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))

// ===== 错误归一：权限/越权置 lastDenied；服务端掉线自动降级本地离线模式 =====
function handleError(store, e) {
  if (e instanceof ApiError && e.code === 'OFFLINE') {
    if (store.connMode === 'server') {
      store.connMode = 'local'
      store.offlineDirty = true
      store.showToast('📴 服务端连接中断，已切换本地离线模式；恢复联机后可迁移离线快照', 'warn')
    } else {
      store.showToast('服务端不可达，请稍后重试', 'warn')
    }
    return
  }
  const denied = e?.status === 403 || ['PERM_DENIED', 'CROSS_TENANT', 'FORBIDDEN', 'LOGIN_DENIED', 'TENANT_UNAVAILABLE'].includes(e?.code)
  if (denied) {
    store.lastDenied = { at: Date.now(), action: e.code, detail: e.message, perm: '', tenantId: store.activeTenantId }
  }
  store.showToast(e?.message || '操作失败，请重试', 'warn')
}

// ===== 水合：服务端投影 → store 本地态（getter/组件零改动） =====
export function hydrate(store, snap) {
  const s = snap.session || {}
  store.todayDate = snap.todayDate || store.todayDate
  store.tenants = snap.tenants || []
  store.members = snap.members || []
  store.customRoles = snap.customRoles || []
  store.activities = deep(snap.activities || [])
  store.goods = deep(snap.goods || [])
  // 任务完成/领取标记由 taskClaims 台账推导（日任务按业务日、一次性任务永久）
  const claims = (snap.taskClaims || []).filter((c) => c.userId === s.userId)
  store.tasks = (snap.tasks || []).map((t) => {
    const claimed = claims.some((c) => c.taskId === t.id && (t.type === 'once' || c.bizDate === snap.todayDate))
    return { ...t, done: claimed, claimed }
  })
  store.points = snap.pointsBalance ?? 0
  store.pointRecords = descTs(snap.pointRecords)
  store.records = descTs(snap.records)
  store.riskOrders = descTs(snap.riskOrders)
  store.riskRulesByTenant = snap.riskRulesByTenant || {}
  store.shipments = descTs(snap.shipments)
  store.afterSales = descTs(snap.afterSales)
  store.coupons = descTs(snap.coupons)
  store.couponLogs = descTs(snap.couponLogs)
  store.taskClaims = descTs(snap.taskClaims)
  store.purchaseOrders = descTs(snap.purchaseOrders)
  store.inboundBatches = descTs(snap.inboundBatches)
  store.acceptDiffs = descTs(snap.acceptDiffs)
  store.supplierBills = descTs(snap.supplierBills)
  store.budgets = descTs(snap.budgets)
  store.budgetLedger = descTs(snap.budgetLedger)
  store.reconBills = descTs(snap.reconBills)
  store.stockAdjustments = descTs(snap.stockAdjustments)
  store.auditLogs = descTs(snap.auditLogs)
  // 身份上下文镜像服务端会话
  store.identityKind = s.identityKind || 'customer'
  store.currentMemberId = s.memberId || ''
  if (s.tenantId) store.activeTenantId = s.tenantId
  const m = s.memberId ? store.members.find((x) => x.id === s.memberId) : null
  store.user = { id: s.userId, name: s.name, avatar: m?.avatar || store.user?.avatar || '🦊' }
  store.role = store.identityKind === 'customer' ? 'user' : 'operator'
}

export async function refreshStore(store) {
  const snap = await apiClient.get('/api/bootstrap')
  hydrate(store, snap)
}

// 防抖刷新：业务日轮询/页面可见时调用，避免频繁全量拉取
let refreshTimer = null
export function scheduleRefresh(store) {
  if (refreshTimer) return
  refreshTimer = setTimeout(async () => {
    refreshTimer = null
    try { await refreshStore(store) } catch (e) { handleError(store, e) }
  }, 300)
}

// ===== 联机接入 =====
export async function connectServer(store, { baseUrl, silent } = {}) {
  if (baseUrl !== undefined) apiClient.setBaseUrl(baseUrl)
  apiClient.restore()
  const ok = await apiClient.ping()
  if (!ok) {
    if (store.connMode !== 'local') store.connMode = 'local'
    if (!silent) store.showToast('📴 未检测到服务端，当前为本地离线模式（操作将计入离线快照，可后续迁移上链）', 'info')
    return false
  }
  // 会话恢复：优先复用已持久化 token；失效则按当前消费者身份重新登录
  let authed = false
  if (apiClient.token) {
    try { await apiClient.get('/api/me'); authed = true } catch { apiClient.setToken('') }
  }
  if (!authed) {
    const r = await apiClient.post('/api/auth/customer-login', {
      userId: store.user?.id || CUSTOMER.id,
      tenantId: store.activeTenantId || CUSTOMER.homeTenantId
    })
    apiClient.setToken(r.token)
  }
  await refreshStore(store)
  store.connMode = 'server'
  store.connInfo = { at: Date.now() }
  if (!silent) store.showToast('🌐 已接入服务端：租户权限 / 幂等 / 并发 / WAL 恢复由服务端统一保障', 'success')
  return true
}

// 写动作统一模板：成功 → 全量水合（服务端投影为准）；失败 → 错误归一（不抛出，组件无需 try/catch）
async function call(store, fn, { toast } = {}) {
  try {
    const r = await fn()
    await refreshStore(store)
    if (toast) store.showToast(toast, 'success')
    return r
  } catch (e) {
    handleError(store, e)
    return null
  }
}

// ===== 交易（客户）=====
export async function draw(store, activityId) {
  const r = await call(store, () => apiClient.post('/api/draw', { activityId }))
  if (!r) return null
  const rec = r.trade
  if (rec?.status === 'frozen') {
    store.showToast('🛡️ 该次抽奖已转入风控审核，奖品与积分已冻结', 'warn')
  } else if (rec) {
    store.showToast(`获得：${rec.prizeName}`, 'success')
  }
  return rec || null
}

export async function redeem(store, goodsId) {
  const r = await call(store, () => apiClient.post('/api/redeem', { goodsId }))
  if (!r) return null
  const rec = r.trade
  if (rec?.status === 'frozen') store.showToast('🛡️ 该笔兑换已转入风控审核', 'warn')
  else if (rec) store.showToast(`兑换成功：${rec.goodsName}`, 'success')
  return rec || null
}

export async function completeTask(store, taskId) {
  const t = (store.tasks || []).find((x) => x.id === taskId)
  if (t?.metric === 'draw') {
    store.showToast('抽奖任务按真实参与记录自动结算，达标后自动发奖', 'info')
    return
  }
  const r = await call(store, () => apiClient.post('/api/tasks/complete', { taskId }))
  if (r) store.showToast(`获得 ${r.claim?.reward ?? t?.reward ?? 0} 积分`, 'success')
}

// ===== 风控 =====
export async function appealRisk(store, orderId, reason) {
  if (!reason || !String(reason).trim()) { store.showToast('请填写申诉理由', 'warn'); return false }
  const r = await call(store, () => apiClient.post('/api/risk/appeal', { orderId, reason: String(reason).trim() }))
  if (r) store.showToast('申诉已提交，等待运营审核', 'success')
  return !!r
}

export async function reviewRisk(store, orderId, action, note = '') {
  const r = await call(store, () => apiClient.post('/api/risk/review', { orderId, action, note }))
  if (r) store.showToast(action === 'release' ? '已放行：权益补发完成' : '已撤销：积分/库存/次数已返还', 'success')
  return !!r
}

export async function updateRiskRules(store, rules) {
  const r = await call(store, () => apiClient.post('/api/risk/rules', rules))
  if (r) store.showToast('风控规则已更新（服务端即时生效）', 'success')
  return !!r
}

// ===== 物流与售后 =====
export async function submitShipAddress(store, shipmentId, form) {
  const r = await call(store, () => apiClient.post('/api/shipments/address', { shipmentId, ...form }))
  if (r) store.showToast('收货信息已保存', 'success')
  return !!r
}

export async function shipShipment(store, shipmentId, form) {
  const r = await call(store, () => apiClient.post('/api/shipments/send', { shipmentId, ...form }))
  if (r) store.showToast('已发货，物流轨迹已生成', 'success')
  return !!r
}

export async function syncShipmentTrace(store, shipmentId) {
  return !!(await call(store, () => apiClient.post('/api/shipments/trace', { shipmentId })))
}

export async function receiveShipment(store, shipmentId) {
  const r = await call(store, () => apiClient.post('/api/shipments/receive', { shipmentId }))
  if (r) store.showToast('已确认收货，订单闭环', 'success')
  return !!r
}

export async function applyAfterSale(store, shipmentId, type, reason) {
  const r = await call(store, () => apiClient.post('/api/aftersales/apply', { shipmentId, type, reason }))
  if (r) store.showToast('售后申请已提交，等待运营审核', 'success')
  return r?.afterSale || null
}

export async function reviewAfterSale(store, afterSaleId, approve, note = '') {
  const r = await call(store, () => apiClient.post('/api/aftersales/review', { afterSaleId, approve, note }))
  if (r) store.showToast(approve ? '售后已审核通过并回写' : '售后已驳回（不动账）', 'success')
  return !!r
}

// ===== 采购入库 =====
export async function createPurchaseOrder(store, form) {
  const r = await call(store, () => apiClient.post('/api/purchases/create', form))
  if (r) store.showToast('采购单已提交，待财务审批', 'success')
  return r?.purchase || null
}

export async function reviewPurchaseOrder(store, purchaseId, approve, note = '') {
  const r = await call(store, () => apiClient.post('/api/purchases/review', { purchaseId, approve, note }))
  if (r) store.showToast(approve ? '采购单已审批通过' : '采购单已驳回', 'success')
  return !!r
}

export async function cancelPurchaseOrder(store, purchaseId) {
  const r = await call(store, () => apiClient.post('/api/purchases/cancel', { purchaseId }))
  if (r) store.showToast('采购单已撤销', 'info')
  return !!r
}

export async function inboundPurchase(store, purchaseId, form) {
  const r = await call(store, () => apiClient.post('/api/purchases/inbound', { purchaseId, ...form }))
  if (r) store.showToast('本批验收已入库', 'success')
  return r
}

// ===== 供应商结算 =====
export async function createSupplierBill(store, purchaseId, form = {}) {
  const r = await call(store, () => apiClient.post('/api/supplier/bills/create', { purchaseId, ...form }))
  if (r) store.showToast(form.submit ? '供应商账单已提交财务复核' : '供应商账单草稿已保存', 'success')
  return r?.bill || null
}

export async function submitSupplierBill(store, billId, form = {}) {
  const r = await call(store, () => apiClient.post('/api/supplier/bills/submit', { billId, ...form }))
  if (r) store.showToast('账单已提交财务复核', 'success')
  return r?.bill || null
}

export async function reviewSupplierBill(store, billId, approve, note = '') {
  const r = await call(store, () => apiClient.post('/api/supplier/bills/review', { billId, approve, note }))
  if (r) store.showToast(approve ? '账单复核通过' : '账单已驳回，待运营修订', 'success')
  return !!r
}

export async function settleSupplierBill(store, billId, note = '') {
  const r = await call(store, () => apiClient.post('/api/supplier/bills/settle', { billId, note }))
  if (r) store.showToast('结算付款完成，已回写库存对账快照', 'success')
  return r?.bill || null
}

// ===== 营销预算 =====
export async function createBudget(store, form) {
  const r = await call(store, () => apiClient.post('/api/budgets/create', form))
  if (r) store.showToast('预算已编制提交，待财务审批', 'success')
  return r?.budget || null
}

export async function reviewBudget(store, budgetId, approve, note = '') {
  const r = await call(store, () => apiClient.post('/api/budgets/review', { budgetId, approve, note }))
  if (r) store.showToast(approve ? '预算已审批生效' : '预算已驳回', 'success')
  return !!r
}

export async function cancelBudget(store, budgetId) {
  const r = await call(store, () => apiClient.post('/api/budgets/cancel', { budgetId }))
  if (r) store.showToast('预算申请已撤销', 'info')
  return !!r
}

export async function setBudgetFrozen(store, budgetId, frozen, note = '') {
  const r = await call(store, () => apiClient.post(frozen ? '/api/budgets/freeze' : '/api/budgets/activate', { budgetId, note }))
  if (r) store.showToast(frozen ? '预算已冻结（暂停新增占用）' : '预算已解冻恢复', 'success')
  return !!r
}

export async function closeBudget(store, budgetId, note = '') {
  const r = await call(store, () => apiClient.post('/api/budgets/close', { budgetId, note }))
  if (r) store.showToast('预算已关闭（终态，台账保留）', 'success')
  return !!r
}

export async function requestBudgetAdjust(store, budgetId, delta, reason) {
  const r = await call(store, () => apiClient.post('/api/budgets/adjust', { budgetId, delta, reason }))
  if (r) store.showToast('预算调整已提交，待财务审批', 'success')
  return r?.adjustment || null
}

export async function reviewBudgetAdjust(store, budgetId, adjustId, approve, note = '') {
  const r = await call(store, () => apiClient.post('/api/budgets/adjust-review', { budgetId, adjustId, approve, note }))
  if (r) store.showToast(approve ? '调整已生效' : '调整已驳回', 'success')
  return !!r
}

// ===== 卡券 =====
export async function redeemCoupon(store, code, form = {}) {
  const r = await call(store, () => apiClient.post('/api/coupons/redeem', { code, ...form }))
  if (r) store.showToast('卡券核销成功', 'success')
  return r
}

// ===== 对账 =====
export async function runRecon(store, date, silent = false, tenantId) {
  const r = await call(store, () => apiClient.post('/api/recon/run', { date }))
  if (r && !silent) {
    const open = r.bill?.diffs?.openCount ?? 0
    store.showToast(open === 0 ? `🧮 ${date} 对账完成：账实相符` : `🧮 ${date} 对账完成：${open} 项差异待复核`, open === 0 ? 'success' : 'warn')
  }
  return r?.bill || null
}

export async function reviewRecon(store, date, note = '', tenantId) {
  const r = await call(store, () => apiClient.post('/api/recon/review', { date, note }))
  if (r) store.showToast('差异单已复核', 'success')
  return !!r
}

export async function compensateRecon(store, date, note = '', tenantId) {
  const r = await call(store, () => apiClient.post('/api/recon/compensate', { date, note }))
  if (r) store.showToast('补偿完成：仅追加补偿流水/调整凭证，原始记录保留', 'success')
  return r
}

// ===== 活动管理 =====
export async function createActivity(store, payload) {
  const r = await call(store, () => apiClient.post('/api/activities', payload))
  if (r) store.showToast(`活动【${r.activity?.name}】创建成功`, 'success')
  return r?.activity || null
}

export async function toggleActivityStatus(store, activityId) {
  return !!(await call(store, () => apiClient.post('/api/activities/status', { activityId })))
}

export async function resetActivityStock(store, activityId) {
  const r = await call(store, () => apiClient.post('/api/activities/reset-stock', { activityId }))
  if (r) store.showToast('奖品库存已恢复（风控预占保留）', 'success')
  return !!r
}

export async function deleteActivity(store, activityId) {
  const r = await call(store, () => apiClient.post('/api/activities/delete', { activityId }))
  if (r) store.showToast('活动已删除（历史业务记录保留）', 'info')
  return !!r
}

// ===== 身份与租户 =====
export async function loginAsMember(store, memberId, opts = {}) {
  const r = await call(store, async () => {
    const res = await apiClient.post('/api/auth/member-login', { memberId })
    apiClient.setToken(res.token)
    return res
  })
  if (!r) return false
  if (!opts.silent) store.showToast(`已登录：${store.user.name}（${store.roleLabelOf(store.currentMember?.roleKey)}）`, 'success')
  return true
}

export async function loginAsCustomer(store, opts = {}) {
  const r = await call(store, async () => {
    const res = await apiClient.post('/api/auth/customer-login', {
      userId: CUSTOMER.id, tenantId: store.activeTenantId || CUSTOMER.homeTenantId
    })
    apiClient.setToken(res.token)
    return res
  })
  if (!r) return false
  if (!opts.silent) store.showToast('已切回消费者身份', 'success')
  return true
}

export async function switchTenant(store, tenantId) {
  const r = await call(store, () => apiClient.post('/api/auth/switch-tenant', { tenantId }))
  return !!r
}

// ===== 离线快照：导出（迁移口径）/ 本地持久化（断线续跑）/ 迁移上链 =====
export function exportOfflineSnapshot(store) {
  return {
    source: 'web-offline-snapshot',
    migratedAt: store.todayDate,
    tenants: deep(store.tenants),
    members: deep(store.members),
    customRoles: deep(store.customRoles),
    tasks: deep((store.tasks || []).map(({ done, claimed, ...t }) => t)),
    riskRulesByTenant: deep(store.riskRulesByTenant),
    couponTplsList: [...COUPONS, ...CLOUD_COUPONS].map((c) => ({ ...c })),
    activities: deep(store.activities),
    goods: deep(store.goods),
    pointRecords: deep([...(store.pointRecords || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0))),
    records: deep(store.records),
    riskOrders: deep(store.riskOrders),
    taskClaims: deep(store.taskClaims),
    coupons: deep(store.coupons),
    couponLogs: deep(store.couponLogs),
    shipments: deep(store.shipments),
    afterSales: deep(store.afterSales),
    reconBills: deep(store.reconBills),
    stockAdjustments: deep(store.stockAdjustments),
    purchaseOrders: deep(store.purchaseOrders || []),
    inboundBatches: deep(store.inboundBatches || []),
    acceptDiffs: deep(store.acceptDiffs || []),
    supplierBills: deep(store.supplierBills || []),
    budgets: deep(store.budgets || []),
    budgetLedger: deep(store.budgetLedger || []),
    auditLogs: deep(store.auditLogs),
    legacyPoints: store.points
  }
}

// 本地持久化（原始本地态，含任务完成标记；仅离线模式由 $subscribe 触发）
export function captureLocalState(store) {
  return {
    ...exportOfflineSnapshot(store),
    savedAt: Date.now(),
    savedTodayDate: store.todayDate,
    activeTenantId: store.activeTenantId,
    tasksRaw: deep(store.tasks)
  }
}

export function persistOfflineSnapshot(store) {
  kv.set(LS_SNAP, JSON.stringify(captureLocalState(store)))
  store.offlineDirty = true
}

export function hasPersistedSnapshot() {
  return !!kv.get(LS_SNAP)
}

export function clearPersistedSnapshot() {
  kv.del(LS_SNAP)
}

// 离线续跑：把持久化快照恢复到 store（在 init 之后、connectServer 之前调用）
export function restorePersistedSnapshot(store) {
  const raw = kv.get(LS_SNAP)
  if (!raw) return false
  let snap = null
  try { snap = JSON.parse(raw) } catch { return false }
  if (!snap || !Array.isArray(snap.activities)) return false
  store.tenants = snap.tenants || store.tenants
  store.members = snap.members || store.members
  store.customRoles = snap.customRoles || store.customRoles
  store.tasks = snap.tasksRaw || snap.tasks || store.tasks
  store.riskRulesByTenant = snap.riskRulesByTenant || store.riskRulesByTenant
  store.activities = snap.activities || store.activities
  store.goods = snap.goods || store.goods
  store.pointRecords = snap.pointRecords || []
  store.records = snap.records || []
  store.riskOrders = snap.riskOrders || []
  store.taskClaims = snap.taskClaims || []
  store.coupons = snap.coupons || []
  store.couponLogs = snap.couponLogs || []
  store.shipments = snap.shipments || []
  store.afterSales = snap.afterSales || []
  store.reconBills = snap.reconBills || []
  store.stockAdjustments = snap.stockAdjustments || []
  store.purchaseOrders = snap.purchaseOrders || []
  store.inboundBatches = snap.inboundBatches || []
  store.acceptDiffs = snap.acceptDiffs || []
  store.supplierBills = snap.supplierBills || []
  store.budgets = snap.budgets || []
  store.budgetLedger = snap.budgetLedger || []
  store.auditLogs = snap.auditLogs || []
  store.points = snap.legacyPoints ?? store.points
  store.offlineDirty = true
  return true
}

// 迁移上链：平台超管把离线快照导入服务端事件库（校验 → 固定 id 幂等 → manifest 留痕）。
// 快照来源优先取 localStorage 持久化副本（联机水合后 store 已是服务端投影，离线数据以持久化快照为准）。
export async function migrateOfflineSnapshot(store) {
  if (store.connMode !== 'server') {
    store.showToast('当前为离线模式：请先恢复服务端连接再迁移', 'warn')
    return null
  }
  if (store.identityKind !== 'platform') {
    store.showToast('离线快照迁移需平台超管身份：请先在「组织权限」登录平台超管', 'warn')
    return null
  }
  let snapshot = null
  const raw = kv.get(LS_SNAP)
  if (raw) { try { snapshot = JSON.parse(raw) } catch { snapshot = null } }
  if (!snapshot || !Array.isArray(snapshot.activities)) snapshot = exportOfflineSnapshot(store)
  try {
    const r = await apiClient.post('/api/migration/run', { snapshot })
    await refreshStore(store)
    store.offlineDirty = false
    clearPersistedSnapshot()
    const c = r.manifest?.counts || {}
    store.showToast(r.idempotent
      ? '该离线快照已迁移过（批次幂等，零增量）'
      : `✅ 离线快照迁移完成：流水 ${c.pointFlows || 0} 行、记录 ${c.records || 0} 笔、卡券 ${c.coupons || 0} 张、预算台账 ${c.budgetLedger || 0} 行`, 'success')
    return r
  } catch (e) {
    if (e?.code === 'MIGRATION_INVALID') {
      store.showToast(`快照校验未通过，已整批拒绝：${e.message}`, 'warn')
    } else if (e?.code === 'MIGRATION_NOT_EMPTY') {
      store.showToast('目标服务端已有业务数据：请改用 --no-seed 启动的空库执行首次迁移', 'warn')
    } else {
      handleError(store, e)
    }
    return null
  }
}
