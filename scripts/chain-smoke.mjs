// 判定链端到端冒烟测试：实时打包 mock API（axios 外置），在内存 localStorage 中驱动整条链路。
// 运行：node scripts/chain-smoke.mjs
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import axios from 'axios'

// 临时产物放在 node_modules/.cache 下，external 的 axios 才能沿 node_modules 向上解析
const dir = await mkdtemp(join(process.cwd(), 'node_modules/.cache/chain-smoke-'))
const outfile = join(dir, 'http.mjs')
await build({
  entryPoints: ['src/api/http.ts'],
  bundle: true,
  format: 'esm',
  alias: { '@': process.cwd() + '/src' },
  outfile,
  external: ['axios'],
  logLevel: 'silent',
})

const store = new Map()
globalThis.window = { setTimeout }
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
}

const { api } = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
const assert = (cond, msg) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

const call = async (method, url, body, params) =>
  api.request({ method, url, data: body, params, adapter: api.defaults.adapter })
const findRun = (runs, id) => runs.find((r) => r.id === id)
const reviewBody = (reviewer, decision, reason) => ({ category: 'design-change', decision, reviewer, reason })

try {
  console.log('\n[1] 种子数据与规则判定')
  let runs = (await call('get', '/runs')).data
  const r1048 = findRun(runs, 'run-1048')
  assert(r1048.evaluation.ruleVersion === 4, `run-1048 按 rv4 判定（实际 rv${r1048.evaluation.ruleVersion}）`)
  assert(r1048.evaluation.state === 'current', 'run-1048 状态为 current')
  const ignored = r1048.evaluation.regionVerdicts.filter((v) => v.ignored).map((v) => v.regionId)
  assert(ignored.includes('1048-r3'), '动态时间区域被规则折叠')
  assert(ignored.includes('1048-r4'), '头像随机图（Δ10 ≤ 14，/checkout/*）被规则折叠')
  assert(r1048.evaluation.effectiveMismatchRate < r1048.mismatchRate, '判定差异率小于原始差异率')

  const r0810 = findRun(runs, 'run-0810')
  assert(r0810.evaluation.state === 'backfilled', 'run-0810 按当时规则回填')
  assert(r0810.evaluation.ruleVersion === 1, `回填版本为 rv1（实际 rv${r0810.evaluation.ruleVersion}）`)
  const r0720 = findRun(runs, 'run-0720')
  assert(r0720.status === 'unverifiable' && r0720.evaluation.state === 'unverifiable', 'run-0720 早于规则存档 → 待核对')

  console.log('\n[2] 规则色差改动 → 未审批运行失效重算，已审批冻结')
  const before = findRun((await call('get', '/runs')).data, 'run-1048').evaluation.effectiveMismatchRate
  await call('patch', '/rules/rule-avatar', { maxDelta: 8 })
  runs = (await call('get', '/runs')).data
  let r = findRun(runs, 'run-1048')
  assert(r.evaluation.state === 'stale-recalculated', '规则改动后 run-1048 立即失效重算')
  assert(r.evaluation.effectiveMismatchRate > before, `色差收紧后判定差异率回升（${before} → ${r.evaluation.effectiveMismatchRate}）`)
  const r1046 = findRun(runs, 'run-1046')
  assert(r1046.evaluation.state === 'frozen', '已审批 run-1046 证据冻结，不随规则重算')
  assert(r1046.review.ruleVersion === 4, '已审批运行保留审批时 rv4')
  const snapshots = (await call('get', '/rule-snapshots')).data
  assert(snapshots.length === 5 && snapshots.at(-1).version === 5, `追加 rv5（共 ${snapshots.length} 版）`)
  assert(snapshots.at(-1).rules.find((x) => x.id === 'rule-avatar').maxDelta === 8, 'rv5 记录新色差 8')

  console.log('\n[3] 打开锁定版本 + 两人同时提交（先写者胜，冲突草稿存双方取值）')
  const sessA = (await call('post', '/runs/run-1047/review-session', { reviewer: '沈宁' })).data
  const sessB = (await call('post', '/runs/run-1047/review-session', { reviewer: '周航' })).data
  assert(sessA.basisRuleVersion === 5 && sessB.basisRuleVersion === 5, '两人打开时均锁定 rv5')
  await call('patch', '/runs/run-1047/review', { ...reviewBody('沈宁', 'approved', 'A 先写：批准为新基线，原因足够长。'), sessionId: sessA.id })
  let conflict409 = null
  try {
    await call('patch', '/runs/run-1047/review', { ...reviewBody('周航', 'rejected', 'B 后写：认为应该驳回该运行结果。'), sessionId: sessB.id })
  } catch (e) {
    conflict409 = e
  }
  assert(conflict409?.response?.status === 409, '后提交者收到 409')
  r = findRun((await call('get', '/runs')).data, 'run-1047')
  assert(r.review.reviewer === '沈宁' && r.status === 'approved', '先写入者（沈宁/批准）生效')
  const conflicts = (await call('get', '/conflicts', null, { runId: 'run-1047' })).data
  assert(conflicts.length === 1, '生成 1 条冲突草稿')
  assert(conflicts[0].winner.reviewer === '沈宁' && conflicts[0].loser.reviewer === '周航', '草稿保留双方取值')
  assert(conflicts[0].winner.decision === 'approved' && conflicts[0].loser.decision === 'rejected', '草稿保留双方结论（批准 vs 驳回）')

  console.log('\n[4] 规则在落后页面提交期间推进 → rule-changed 冲突')
  const run1044 = 'run-1044'
  const sessOld = (await call('post', `/runs/${run1044}/review-session`, { reviewer: '梁琪' })).data
  await call('patch', '/rules/rule-time', { maxDelta: 3 })
  let staleErr = null
  try {
    await call('patch', `/runs/${run1044}/review`, { ...reviewBody('梁琪', 'approved', '基于旧 rv5 页面提交的批准结论。'), sessionId: sessOld.id })
  } catch (e) {
    staleErr = e
  }
  assert(staleErr?.response?.status === 409, '基于旧版本的提交被拒（409）')
  const staleConflicts = (await call('get', '/conflicts')).data
  assert(staleConflicts.some((c) => c.kind === 'rule-changed'), '生成 rule-changed 冲突草稿')
  r = findRun((await call('get', '/runs')).data, run1044)
  assert(!r.review && r.evaluation.state === 'stale-recalculated', 'run-1044 未被旧结论审批，保持失效重算')
  await call('post', `/runs/${run1044}/recheck`)
  const sessNew = (await call('post', `/runs/${run1044}/review-session`, { reviewer: '梁琪' })).data
  assert(sessNew.basisRuleVersion === 6, '重开会话锁定 rv6')

  console.log('\n[5] 批量审批：逐项落盘、故障注入、恢复只补未完成项、基线幂等')
  const baselineBefore = (await call('get', '/baselines')).data.length
  const pendingTargets = ['run-1048', 'run-1043', run1044].map((runId) => ({
    runId,
    decision: 'approved',
    category: 'design-change',
    reviewer: '批量机器人',
    reason: '批量审批：差异已核对，按统一结论处理。',
  }))
  let batchErr = null
  try {
    await call('post', '/runs/batch-review', { idempotencyKey: 'demo-batch-1', items: pendingTargets, failAfterIndex: 1 })
  } catch (e) {
    batchErr = e
  }
  assert(batchErr?.response?.status === 500, '批次在第 2 项注入写入失败（500）')
  const partial = (await call('get', '/approvals/recoverable')).data
  assert(partial?.status === 'partial' && partial.items[0].status === 'committed', '最近批次可恢复，第 1 项已提交')
  assert(partial.items.slice(1).every((i) => i.status === 'pending'), '其余项仍为未完成')
  assert((await call('get', '/baselines')).data.length === baselineBefore + 1, '中断时只新增 1 条基线')
  const resumed = (await call('post', `/approvals/batches/${partial.id}/resume`, {})).data
  assert(resumed.status === 'completed' && resumed.items.every((i) => i.status === 'committed'), '恢复后批次全部完成')
  const afterRuns = (await call('get', '/runs')).data
  assert(['run-1048', 'run-1043', run1044].every((id) => findRun(afterRuns, id).status === 'approved'), '三个运行均已批准')
  const afterBaselines = (await call('get', '/baselines')).data
  assert(afterBaselines.length === baselineBefore + 3, `恢复只补 2 条基线（共新增 3 条，实际 ${afterBaselines.length - baselineBefore}）`)
  const dup = (await call('post', '/runs/batch-review', { idempotencyKey: 'demo-batch-1', items: pendingTargets })).data
  assert(dup.id === resumed.id, '相同幂等键返回同一批次')
  const baselineCountFor = ['run-1048', 'run-1043', run1044].map((id) => afterBaselines.filter((b) => b.runId === id).length)
  assert(baselineCountFor.every((n) => n === 1), `每个运行恰好 1 条基线（${baselineCountFor.join(',')}）`)

  console.log('\n[6] 基线证据冻结 & 待核对人工确认')
  const b1048 = afterBaselines.find((b) => b.runId === 'run-1048')
  assert(b1048.ruleVersion === 6, `基线记录 rv6（实际 rv${b1048.ruleVersion}）`)
  assert(typeof b1048.evidence.effectiveMismatchRate === 'number' && b1048.evidence.regions.length > 0, '基线保留当时区域与差异率证据')
  await call('patch', '/rules/rule-watermark', { enabled: false })
  const r1048After = findRun((await call('get', '/runs')).data, 'run-1048')
  assert(r1048After.evaluation.state === 'frozen' && r1048After.review.ruleVersion === 6, '再改规则后已审批运行仍冻结 rv6')
  assert((await call('get', '/baselines')).data.find((b) => b.runId === 'run-1048').ruleVersion === 6, '基线规则版本不变')
  await call('post', '/runs/run-0720/verify')
  const r0720After = findRun((await call('get', '/runs')).data, 'run-0720')
  assert(r0720After.status === 'pending' && r0720After.evaluation.state === 'current', '待核对经人工确认后回到待审批')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exit(1)
