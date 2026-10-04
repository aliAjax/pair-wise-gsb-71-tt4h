/* eslint-disable no-console */
// v1 存档迁移验证：预置旧结构（无 ruleVersion/快照），读取即按当时有效规则回填
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

// 预置 v1 旧库：无 schemaVersion、无 ruleVersion
const legacy = {
  projects: [],
  runs: [
    // 采集晚于最早规则(2026-09-05)：应回填 v1
    {
      id: 'run-old-1', name: '旧运行-可回填', projectId: 'p-console', page: '资源详情',
      device: 'Desktop 1440', theme: 'light', build: 'b1', status: 'pending', mismatchRate: 9.9,
      capturedAt: '2026-09-10T09:00:00+08:00', baselineVersion: 'a', currentVersion: 'b',
      regions: [{
        id: 'o1-r1', x: 1, y: 1, width: 5, height: 5, severity: 'low', pixels: 10,
        kind: 'environment', selector: '[data-visual-ignore="relative-time"]', delta: 9, ignored: false,
      }],
    },
    // 采集早于最早规则：应进入待核对
    {
      id: 'run-old-2', name: '旧运行-待核对', projectId: 'p-console', page: '资源详情',
      device: 'Desktop 1440', theme: 'light', build: 'b2', status: 'pending', mismatchRate: 1.2,
      capturedAt: '2026-07-01T09:00:00+08:00', baselineVersion: 'a', currentVersion: 'b',
      regions: [],
    },
    // 已审批旧运行：保留当时证据、冻结口径
    {
      id: 'run-old-3', name: '旧运行-已审批', projectId: 'p-console', page: '资源详情',
      device: 'Desktop 1440', theme: 'light', build: 'b3', status: 'approved', mismatchRate: 3.33,
      capturedAt: '2026-09-12T09:00:00+08:00', baselineVersion: 'a', currentVersion: 'b',
      regions: [],
      review: {
        category: 'design-change', decision: 'approved', reviewer: '旧审批人',
        reason: '旧库迁移的已审批记录原因', reviewedAt: '2026-09-12T10:00:00+08:00',
      },
    },
  ],
  baselines: [{
    id: 'b-old', projectId: 'p-console', page: '资源详情', device: 'Desktop 1440',
    theme: 'light', version: 'v-old', approvedBy: '旧审批人', reason: '旧基线',
    approvedAt: '2026-09-12T10:00:00+08:00', runId: 'run-old-3', active: true,
  }],
  rules: [],
}
store.set('visual-regression-platform-v1', JSON.stringify(legacy))

const { readDb } = await import('../src/mocks/db.ts')
const db = readDb()

let pass = 0
const ok = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name} ${JSON.stringify(extra ?? '')}`)
  pass++
  console.log(`  ✓ ${name}`)
}

ok('迁移后 schemaVersion=2', db.schemaVersion === 2)
ok('生成了 v1 规则快照', db.ruleSnapshots[0]?.version === 1 && db.rules.length >= 4)

const r1 = db.runs.find((r) => r.id === 'run-old-1')!
ok('晚于规则的旧运行回填 v1', r1.ruleVersion === 1 && r1.ruleVersionSource === 'backfilled', [r1.ruleVersion, r1.ruleVersionSource])
ok('回填时按当时规则重算忽略（时间区域命中）', r1.regions[0].ignored === true && r1.regions[0].ruleId === 'rule-time')
ok('回填差异率按判定链重算（环境区域被忽略后为0）', r1.mismatchRate === 0, r1.mismatchRate)

const r2 = db.runs.find((r) => r.id === 'run-old-2')!
ok('早于任何规则的旧运行进入待核对', r2.status === 'needs-check' && r2.ruleVersion === null, r2.status)

const r3 = db.runs.find((r) => r.id === 'run-old-3')!
ok('已审批旧运行回填来源', r3.ruleVersionSource === 'backfilled' && r3.review?.ruleVersion === 1)
ok('已审批旧运行保留当时差异率证据（不重算为0）', r3.review.evidence.mismatchRate === 3.33, r3.review.evidence)
ok('已审批运行状态保持 approved', r3.status === 'approved')

const bOld = db.baselines.find((b) => b.id === 'b-old')!
ok('旧基线补齐规则版本与证据结构', bOld.ruleVersion === 1 && typeof bOld.evidence.mismatchRate === 'number')

console.log(`\n迁移验证 ${pass} 项全部通过 ✅`)
