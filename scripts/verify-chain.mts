/* eslint-disable no-console */
// 判定链端到端验证：mock localStorage/window 后直接驱动 mock adapter
import assert from 'node:assert'

const store = new Map<string, string>()
const g = globalThis as Record<string, unknown>
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
}
g.window = { setTimeout, clearTimeout }

const { api, getApiError } = await import('../src/api/http.ts')

const call = async <T = unknown>(method: string, url: string, data?: unknown): Promise<T> => {
  try {
    const res = await api.request({ method, url, baseURL: '/mock-api', data })
    return res.data as T
  } catch (error) {
    throw getApiError(error)
  }
}

let pass = 0
const ok = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name} failed ${JSON.stringify(extra ?? '')}`)
  pass++
  console.log(`  ✓ ${name}`)
}

// ---------- 初始数据 ----------
const runs0 = await call<any[]>('get', '/runs')
const r1048 = runs0.find((r) => r.id === 'run-1048')
ok('运行采集时锁定规则版本 v1', r1048.ruleVersion === 1, r1048.ruleVersion)
const r1042 = runs0.find((r) => r.id === 'run-1042')
ok('早于规则版本的旧运行进入待核对', r1042.status === 'needs-check' && r1042.ruleVersion === null, r1042.status)
const r1046 = runs0.find((r) => r.id === 'run-1046')
ok('已审批运行带冻结证据 v1', r1046.review.evidence.ruleVersion === 1)

// 列表判定链：run-1048 头像色差 24 > maxDelta20 不忽略；时间区域 delta9<=12 忽略；水印 delta4<=5 忽略
const judged1048Rate = r1048.mismatchRate
ok('判定差异率=未忽略像素归一', judged1048Rate > 0, judged1048Rate)

// ---------- 场景 A：规则色差改动 → 未审批运行失效重算，已审批不动 ----------
const rulesBefore = (await call<any[]>('get', '/rules'))
const avatarRule = rulesBefore.find((r) => r.id === 'rule-avatar')
const rateBefore = r1048.mismatchRate
const patched = await call<{ ruleVersion: number; invalidatedRunIds: string[] }>(
  'patch',
  `/rules/${avatarRule.id}`,
  { maxDelta: 30 },
)
ok('规则修改推进版本到 v2', patched.ruleVersion === 2, patched.ruleVersion)
ok('受影响运行被失效（run-1048 头像区域变为忽略）', patched.invalidatedRunIds.includes('run-1048'), patched.invalidatedRunIds)
ok('已审批运行不重算', !patched.invalidatedRunIds.includes('run-1046'))

const runsStale = await call<any[]>('get', '/runs')
const s1048 = runsStale.find((r) => r.id === 'run-1048')
ok('运行状态变为重算中(stale)', s1048.status === 'stale', s1048.status)

// 重算期间审批必须被拒绝
let staleReject: any = null
try {
  await call('patch', '/runs/run-1048/review', {
    category: 'design-change', decision: 'approved', reviewer: '甲', reason: '尝试在重算中审批无效', ruleVersion: 1,
  })
} catch (e) { staleReject = e }
ok('重算中审批被拒', staleReject?.code === 'run-stale', staleReject)

// 等待重算完成（任务 dueAt 设了最短 800ms）
await new Promise((r) => setTimeout(r, 4600))
const runsAfter = await call<any[]>('get', '/runs')
const a1048 = runsAfter.find((r) => r.id === 'run-1048')
ok('重算完成回到待审批', a1048.status === 'pending', a1048.status)
ok('重算后锁定新版本 v2、来源 recomputed', a1048.ruleVersion === 2 && a1048.ruleVersionSource === 'recomputed', [a1048.ruleVersion, a1048.ruleVersionSource])
ok('重算后差异率下降（头像区域被忽略）', a1048.mismatchRate < rateBefore, [rateBefore, a1048.mismatchRate])

// 已审批 run-1046 证据仍是 v1 旧数字
const a1046 = (await call<any[]>('get', '/runs')).find((r) => r.id === 'run-1046')
ok('已审批运行证据仍冻结 v1', a1046.review.evidence.ruleVersion === 1 && a1046.review.evidence.mismatchRate === r1046.review.evidence.mismatchRate)

// 旧审批依据 v1 提交 → rule-changed（页面落后）
let changedReject: any = null
try {
  await call('patch', '/runs/run-1048/review', {
    category: 'design-change', decision: 'approved', reviewer: '甲', reason: '页面仍按旧版本 v1 提交', ruleVersion: 1,
  })
} catch (e) { changedReject = e }
ok('落后版本提交被拒 rule-changed', changedReject?.code === 'rule-changed', changedReject)

// ---------- 场景 B：两人同时提交，先写入生效，后者留冲突草稿 ----------
const first = await call<{ run: any; conflict: any }>('patch', '/runs/run-1048/review', {
  category: 'design-change', decision: 'approved', reviewer: '甲', reason: '甲先写入：确认头像改版', ruleVersion: 2,
})
ok('第一人审批成功并生成基线', Boolean(first.run.review) && first.run.status === 'approved')
const baselines = await call<any[]>('get', '/baselines')
const baseline1 = baselines.find((b) => b.runId === 'run-1048')
ok('基线锁定 v2 证据', baseline1?.ruleVersion === 2 && baseline1.evidence.mismatchRate === a1048.mismatchRate)

let conflictErr: any = null
try {
  await call('patch', '/runs/run-1048/review', {
    category: 'render-error', decision: 'rejected', reviewer: '乙', reason: '乙落后页面的驳回取值', ruleVersion: 2,
  })
} catch (e) { conflictErr = e }
ok('第二人提交返回冲突', conflictErr?.code === 'review-conflict' && conflictErr.conflict?.loser.reviewer === '乙', conflictErr)
const afterConflict = (await call<any[]>('get', '/runs')).find((r) => r.id === 'run-1048')
ok('先生效结论保持为甲的批准', afterConflict.review.reviewer === '甲' && afterConflict.status === 'approved')
ok('双方取值保留为冲突草稿', afterConflict.conflicts?.length === 1 && afterConflict.conflicts[0].winner.reviewer === '甲' && afterConflict.conflicts[0].loser.decision === 'rejected')

// 甲重复提交同样结论 → 幂等，不多出基线
const dup = await call<{ idempotent: boolean; run: any }>('patch', '/runs/run-1048/review', {
  category: 'design-change', decision: 'approved', reviewer: '甲', reason: '甲先写入：确认头像改版', ruleVersion: 2,
})
ok('重复提交幂等', dup.idempotent === true)
const baselines2 = await call<any[]>('get', '/baselines')
ok('重复提交不多出基线', baselines2.filter((b) => b.runId === 'run-1048').length === 1)

// ---------- 场景 C：批次写入失败后恢复，只补未完成项 ----------
const pendingIds = (await call<any[]>('get', '/runs')).filter((r) => r.status === 'pending').map((r) => r.id)
ok('剩余待审批运行 >= 2', pendingIds.length >= 2, pendingIds)
const batchId = `batch-test-${Date.now()}`
let batchErr: any = null
try {
  await call('post', '/reviews/batch', {
    id: batchId, createdBy: '甲', reviewer: '批量审批人', decision: 'approved',
    category: 'design-change', reason: '批量批准：统一走判定链证据', runIds: pendingIds, simulateWriteFailure: true,
  })
} catch (e) { batchErr = e }
ok('批次写入失败返回 batch-write-failed', batchErr?.code === 'batch-write-failed' && batchErr.batchId === batchId, batchErr)

const interrupted = await call<any>('get', '/reviews/batch/latest')
ok('最近批次被保留为 interrupted', interrupted.id === batchId && interrupted.status === 'interrupted', interrupted.status)
const unfinished = interrupted.items.filter((i: any) => i.status === 'pending').map((i: any) => i.runId)
const doneBefore = interrupted.items.filter((i: any) => i.status === 'done').length
ok('存在未完成项', unfinished.length === pendingIds.length, [unfinished, pendingIds])
ok('失败项未落基线（0 完成）', doneBefore === 0, doneBefore)

// 恢复：只补未完成项
const resumed = await call<any>('post', '/reviews/batch', {
  id: batchId, createdBy: '甲', reviewer: '批量审批人', decision: 'approved',
  category: 'design-change', reason: '批量批准：统一走判定链证据', runIds: unfinished,
})
ok('恢复识别为 resumed', resumed.resumed === true)
ok('恢复后批次完成', resumed.batch.status === 'complete' && resumed.batch.items.every((i: any) => i.status === 'done'))

// 再次恢复同批次 → 全部幂等，不新增基线
const baselinesBeforeReplay = (await call<any[]>('get', '/baselines')).length
const replay = await call<any>('post', '/reviews/batch', {
  id: batchId, createdBy: '甲', reviewer: '批量审批人', decision: 'approved',
  category: 'design-change', reason: '批量批准：统一走判定链证据', runIds: unfinished,
})
ok('重复批次提交不产生重复完成项', replay.completed.every((c: any) => c.idempotent))
const baselinesAfterReplay = (await call<any[]>('get', '/baselines')).length
ok('重复批次不会多出基线', baselinesAfterReplay === baselinesBeforeReplay)

// ---------- 场景 D：旧运行回填 ----------
let needsErr: any = null
try {
  await call('patch', '/runs/run-1042/review', {
    category: 'environment-noise', decision: 'rejected', reviewer: '丙', reason: '未回填时禁止审批',
  })
} catch (e) { needsErr = e }
ok('待核对运行审批被拒', needsErr?.code === 'needs-check', needsErr)
const adopted = await call<any>('post', '/runs/run-1042/adopt-rules', { ruleVersion: 2 })
ok('人工回填后进入待审批、来源 checked', adopted.status === 'pending' && adopted.ruleVersion === 2 && adopted.ruleVersionSource === 'checked', [adopted.status, adopted.ruleVersion, adopted.ruleVersionSource])

// ---------- 场景 E：列表/详情/导出同源 ----------
const allRuns = await call<any[]>('get', '/runs')
const approvedRun = allRuns.find((r) => r.id === 'run-1046')
// 详情返回冻结数字，与基线证据一致
const detail = await call<any>('get', '/runs/run-1046')
ok('详情与列表为同一记录同一证据', detail.review.evidence.mismatchRate === approvedRun.review.evidence.mismatchRate)

// 规则继续改 v3，已批准运行/基线证据保持不变
await call('patch', '/rules/rule-time', { maxDelta: 3 })
await new Promise((r) => setTimeout(r, 4600))
const detail2 = await call<any>('get', '/runs/run-1046')
const baseline1046 = (await call<any[]>('get', '/baselines')).find((b) => b.runId === 'run-1046')
ok('规则 v3 后已审批运行证据仍为 v1', detail2.review.evidence.ruleVersion === 1)
ok('基线仍保留生成时 v1 证据', baseline1046.ruleVersion === 1 && baseline1046.evidence.mismatchRate === r1046.review.evidence.mismatchRate)

console.log(`\n全部 ${pass} 项判定链验证通过 ✅`)
