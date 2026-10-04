import type {
  Baseline,
  DifferenceRegion,
  IgnoreRule,
  Project,
  RecomputeJob,
  RuleSnapshot,
  ScreenshotRun,
  ApprovalBatch,
} from '@/types'
import { applyRules, computeMismatchRate, latestSnapshot } from '@/utils/decisionChain'

const STORAGE_KEY = 'visual-regression-platform-v1'

export interface Database {
  schemaVersion: 2
  projects: Project[]
  runs: ScreenshotRun[]
  baselines: Baseline[]
  rules: IgnoreRule[]
  ruleSnapshots: RuleSnapshot[]
  recomputeJobs: RecomputeJob[]
  batches: ApprovalBatch[]
}

interface LegacyDatabaseV1 {
  projects?: Project[]
  runs?: ScreenshotRun[]
  baselines?: Baseline[]
  rules?: IgnoreRule[]
}

const projects: Project[] = [
  { id: 'p-commerce', name: '零售交易工作台', code: 'RETAIL', owner: '沈宁', pageCount: 42 },
  { id: 'p-console', name: '云资源控制台', code: 'CLOUD', owner: '周航', pageCount: 67 },
  { id: 'p-growth', name: '增长运营平台', code: 'GROWTH', owner: '许薇', pageCount: 31 },
]

interface RegionSeed {
  severity: DifferenceRegion['severity']
  pixels: number
  kind: DifferenceRegion['kind']
  selector?: string
  delta?: number
  manual?: boolean
}

const REGION_SEEDS: RegionSeed[] = [
  { severity: 'high', pixels: 1840, kind: 'layout' },
  { severity: 'medium', pixels: 720, kind: 'color', selector: '.user-avatar img', delta: 24 },
  { severity: 'low', pixels: 216, kind: 'environment', selector: '[data-visual-ignore="relative-time"]', delta: 9 },
  { severity: 'low', pixels: 96, kind: 'environment', selector: '.environment-watermark', delta: 4 },
]

const makeRegions = (prefix: string, intensity: number): DifferenceRegion[] =>
  REGION_SEEDS.map((seed, index) => ({
    id: `${prefix}-r${index + 1}`,
    x: [11, 54, 72, 32][index],
    y: [18, 34, 71, 80][index],
    width: [28, 19, 18, 22][index],
    height: [16, 11, 13, 8][index],
    severity: seed.severity,
    pixels: Math.round(seed.pixels * intensity),
    kind: seed.kind,
    selector: seed.selector,
    delta: seed.delta,
    ignored: false,
  }))

const rules: IgnoreRule[] = [
  {
    id: 'rule-time',
    name: '动态时间区域',
    projectId: 'all',
    selector: '[data-visual-ignore="relative-time"]',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 12,
    enabled: true,
    createdAt: '2026-09-02T09:00:00+08:00',
  },
  {
    id: 'rule-avatar',
    name: '用户头像随机图',
    projectId: 'p-commerce',
    selector: '.user-avatar img',
    pagePattern: '/checkout/*',
    devicePattern: '*',
    maxDelta: 20,
    enabled: true,
    createdAt: '2026-09-05T13:25:00+08:00',
  },
  {
    id: 'rule-watermark',
    name: '测试环境水印',
    projectId: 'all',
    selector: '.environment-watermark',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 5,
    enabled: true,
    createdAt: '2026-08-21T11:08:00+08:00',
  },
  {
    id: 'rule-animation',
    name: '旧版骨架屏动画',
    projectId: 'p-console',
    selector: '.skeleton-shimmer',
    pagePattern: '*',
    devicePattern: 'iPhone*',
    maxDelta: 8,
    enabled: false,
    createdAt: '2026-08-16T17:12:00+08:00',
  },
]

const V1_SNAPSHOT_AT = '2026-09-05T13:25:00+08:00'

const seedSnapshot = (): RuleSnapshot => ({
  version: 1,
  createdAt: V1_SNAPSHOT_AT,
  reason: '初始规则版本（动态时间、测试水印、头像随机图等规则生效）',
  rules: rules.map((rule) => ({ ...rule })),
})

type RunSeedInput = Omit<ScreenshotRun, 'ruleVersion' | 'ruleVersionSource' | 'regions' | 'mismatchRate' | 'status' | 'review'> & {
  status?: ScreenshotRun['status']
  regionIntensity: number
  review?: Omit<NonNullable<ScreenshotRun['review']>, 'ruleVersion' | 'evidence'>
}

/** 按规则 v1 评估并锁定运行的判定依据 */
const buildRun = (input: RunSeedInput, snapshot: RuleSnapshot): ScreenshotRun => {
  const { regionIntensity, review: reviewInput, status, ...rest } = input
  const bare: ScreenshotRun = {
    ...rest,
    regions: makeRegions(input.id.replace('run-', ''), regionIntensity),
    mismatchRate: 0,
    status: status ?? 'pending',
    ruleVersion: null,
  }
  const evaluated = applyRules(bare.regions, bare, snapshot.rules)

  if (reviewInput) {
    const evidence = {
      ruleVersion: snapshot.version,
      mismatchRate: computeMismatchRate(evaluated),
      regionCount: evaluated.length,
      ignoredCount: evaluated.filter((region) => region.ignored).length,
      snapshotAt: reviewInput.reviewedAt,
    }
    return {
      ...bare,
      status: reviewInput.decision,
      regions: evaluated,
      mismatchRate: evidence.mismatchRate,
      ruleVersion: snapshot.version,
      ruleVersionSource: 'capture',
      review: { ...reviewInput, ruleVersion: snapshot.version, evidence },
    }
  }

  if (status === 'needs-check') {
    const fallbackRate = computeMismatchRate(bare.regions)
    return {
      ...bare,
      regions: bare.regions.map((region) => ({ ...region, ignored: false })),
      mismatchRate: fallbackRate,
      ruleVersion: null,
      ruleVersionSource: undefined,
    }
  }

  return {
    ...bare,
    regions: evaluated,
    mismatchRate: computeMismatchRate(evaluated),
    ruleVersion: snapshot.version,
    ruleVersionSource: 'capture',
  }
}

const seedRuns = (snapshot: RuleSnapshot): ScreenshotRun[] => [
  buildRun(
    {
      id: 'run-1048',
      name: '结算页桌面端回归',
      projectId: 'p-commerce',
      page: '订单结算页',
      path: '/checkout/order',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/6.18.0',
      status: 'pending',
      capturedAt: '2026-09-29T08:42:00+08:00',
      baselineVersion: 'v6.17.4-baseline',
      currentVersion: 'v6.18.0-rc2',
      regionIntensity: 1,
    },
    snapshot,
  ),
  buildRun(
    {
      id: 'run-1047',
      name: '商品列表移动端回归',
      projectId: 'p-commerce',
      page: '商品列表页',
      device: 'iPhone 15',
      theme: 'light',
      build: 'release/6.18.0',
      status: 'pending',
      capturedAt: '2026-09-29T08:36:00+08:00',
      baselineVersion: 'v6.17.4-baseline',
      currentVersion: 'v6.18.0-rc2',
      regionIntensity: 0.7,
    },
    snapshot,
  ),
  buildRun(
    {
      id: 'run-1046',
      name: '账单明细暗色主题回归',
      projectId: 'p-console',
      page: '账单明细',
      device: 'Desktop 1920',
      theme: 'dark',
      build: 'feature/billing-v3',
      capturedAt: '2026-09-28T17:20:00+08:00',
      baselineVersion: 'v5.9.1-baseline',
      currentVersion: 'billing-v3.7',
      regionIntensity: 1.4,
      review: {
        category: 'design-change',
        decision: 'approved',
        reviewer: '林默',
        reason: '新计费周期列按需求上线，已核对设计稿和验收单。',
        reviewedAt: '2026-09-28T18:02:00+08:00',
      },
    },
    snapshot,
  ),
  buildRun(
    {
      id: 'run-1045',
      name: '活动配置页移动端回归',
      projectId: 'p-growth',
      page: '活动配置',
      device: 'Android Pixel 8',
      theme: 'light',
      build: 'feature/campaign-editor',
      capturedAt: '2026-09-28T15:11:00+08:00',
      baselineVersion: 'v2.4.0-baseline',
      currentVersion: 'campaign-v2',
      regionIntensity: 2.2,
      review: {
        category: 'render-error',
        decision: 'rejected',
        reviewer: '梁琪',
        reason: '主操作区被侧栏遮挡，属于阻断性渲染异常。',
        reviewedAt: '2026-09-28T15:44:00+08:00',
      },
    },
    snapshot,
  ),
  buildRun(
    {
      id: 'run-1044',
      name: '资源详情页桌面端回归',
      projectId: 'p-console',
      page: '资源详情',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/5.10.0',
      status: 'pending',
      capturedAt: '2026-09-28T13:30:00+08:00',
      baselineVersion: 'v5.9.1-baseline',
      currentVersion: 'v5.10.0-rc1',
      regionIntensity: 0.9,
    },
    snapshot,
  ),
  buildRun(
    {
      id: 'run-1043',
      name: '首页推荐位回归',
      projectId: 'p-growth',
      page: '运营首页',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/2.6.0',
      status: 'pending',
      capturedAt: '2026-09-27T19:15:00+08:00',
      baselineVersion: 'v2.5.3-baseline',
      currentVersion: 'v2.6.0-rc3',
      regionIntensity: 0.5,
    },
    snapshot,
  ),
  // 早于任何规则版本的旧运行：缺少规则记录且无法判断，进入待核对
  buildRun(
    {
      id: 'run-1042',
      name: '登录页遗留回归',
      projectId: 'p-console',
      page: '统一登录页',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/5.8.0',
      status: 'needs-check',
      capturedAt: '2026-08-04T10:05:00+08:00',
      baselineVersion: 'v5.8.0-baseline',
      currentVersion: 'v5.8.1-rc1',
      regionIntensity: 0.6,
    },
    snapshot,
  ),
]

const seed = (): Database => {
  const snapshotV1 = seedSnapshot()
  const runs = seedRuns(snapshotV1)
  const reviewedAt = (runId: string) =>
    runs.find((run) => run.id === runId)?.review?.reviewedAt ?? new Date(0).toISOString()
  const evidenceOf = (runId: string) => {
    const run = runs.find((item) => item.id === runId)
    return (
      run?.review?.evidence ?? {
        ruleVersion: 1,
        mismatchRate: 0,
        regionCount: 0,
        ignoredCount: 0,
        snapshotAt: '2026-09-01T00:00:00+08:00',
      }
    )
  }

  const baselines: Baseline[] = [
    {
      id: 'base-commerce-checkout',
      projectId: 'p-commerce',
      page: '订单结算页',
      device: 'Desktop 1440',
      theme: 'light',
      version: 'v6.17.4-baseline',
      approvedBy: '林默',
      reason: '合入优惠券区域改版，设计稿版本 DS-318。',
      approvedAt: '2026-09-19T11:30:00+08:00',
      runId: 'run-998',
      active: true,
      ruleVersion: 1,
      evidence: {
        ruleVersion: 1,
        mismatchRate: 0.62,
        regionCount: 4,
        ignoredCount: 2,
        snapshotAt: '2026-09-19T11:30:00+08:00',
      },
    },
    {
      id: 'base-console-billing',
      projectId: 'p-console',
      page: '账单明细',
      device: 'Desktop 1920',
      theme: 'dark',
      version: 'v5.9.1-baseline',
      approvedBy: '周航',
      reason: '升级账单表格主题变量，无业务布局变化。',
      approvedAt: '2026-09-12T14:05:00+08:00',
      runId: 'run-961',
      active: true,
      ruleVersion: 1,
      evidence: {
        ruleVersion: 1,
        mismatchRate: 0.48,
        regionCount: 4,
        ignoredCount: 1,
        snapshotAt: '2026-09-12T14:05:00+08:00',
      },
    },
    {
      id: 'base-growth-campaign',
      projectId: 'p-growth',
      page: '活动配置',
      device: 'Android Pixel 8',
      theme: 'light',
      version: 'v2.4.0-baseline',
      approvedBy: '许薇',
      reason: '第一版移动端活动配置工作台基线。',
      approvedAt: '2026-08-28T10:10:00+08:00',
      runId: 'run-902',
      active: false,
      ruleVersion: 1,
      evidence: {
        ruleVersion: 1,
        mismatchRate: 0.3,
        regionCount: 3,
        ignoredCount: 0,
        snapshotAt: '2026-08-28T10:10:00+08:00',
      },
    },
    {
      id: 'base-commerce-list',
      projectId: 'p-commerce',
      page: '商品列表页',
      device: 'iPhone 15',
      theme: 'light',
      version: 'v6.17.4-baseline',
      approvedBy: '沈宁',
      reason: '商品卡信息密度调整完成，已通过交互验收。',
      approvedAt: '2026-09-20T16:40:00+08:00',
      runId: 'run-1002',
      active: true,
      ruleVersion: 1,
      evidence: {
        ruleVersion: 1,
        mismatchRate: 0.55,
        regionCount: 4,
        ignoredCount: 2,
        snapshotAt: '2026-09-20T16:40:00+08:00',
      },
    },
    // 已批准运行生成的基线保留生成时证据
    {
      id: 'base-console-billing-v3',
      projectId: 'p-console',
      page: '账单明细',
      device: 'Desktop 1920',
      theme: 'dark',
      version: 'billing-v3.7',
      approvedBy: '林默',
      reason: '新计费周期列按需求上线，已核对设计稿和验收单。',
      approvedAt: reviewedAt('run-1046'),
      runId: 'run-1046',
      active: true,
      ruleVersion: 1,
      evidence: evidenceOf('run-1046'),
    },
  ]

  // 同一页面旧基线在新基线批准时已停用
  baselines.find((item) => item.id === 'base-console-billing')!.active = false

  return {
    schemaVersion: 2,
    projects,
    runs,
    baselines,
    rules,
    ruleSnapshots: [snapshotV1],
    recomputeJobs: [],
    batches: [],
  }
}

/**
 * v1 存档迁移：
 * - 用最早规则时间构造 v1 快照，旧运行按当时有效规则回填
 * - 回填不到有效版本的运行进入待核对
 * - 已审批运行保留当时证据（冻结口径）
 */
const migrateV1 = (legacy: LegacyDatabaseV1): Database => {
  const snapshotV1 = seedSnapshot()
  const migratedRuns = (legacy.runs ?? []).map((run) => {
    const reviewed = Boolean(run.review)
    const evaluated = applyRules(run.regions, run, snapshotV1.rules)
    if (reviewed) {
      const reviewedAt = run.review?.reviewedAt ?? run.capturedAt
      return {
        ...run,
        ruleVersion: snapshotV1.version,
        ruleVersionSource: 'backfilled' as const,
        regions: evaluated,
        review: {
          ...run.review!,
          ruleVersion: snapshotV1.version,
          evidence: {
            ruleVersion: snapshotV1.version,
            mismatchRate: run.mismatchRate,
            regionCount: run.regions.length,
            ignoredCount: run.regions.filter((region) => region.ignored).length,
            snapshotAt: reviewedAt,
          },
        },
      }
    }
    if (run.capturedAt < snapshotV1.createdAt) {
      return { ...run, status: 'needs-check' as const, ruleVersion: null }
    }
    return {
      ...run,
      ruleVersion: snapshotV1.version,
      ruleVersionSource: 'backfilled' as const,
      regions: evaluated,
      mismatchRate: computeMismatchRate(evaluated),
    }
  })

  const migratedBaselines = (legacy.baselines ?? []).map((baseline) => ({
    ...baseline,
    ruleVersion: 1,
    evidence: {
      ruleVersion: 1,
      mismatchRate: 0,
      regionCount: 0,
      ignoredCount: 0,
      snapshotAt: baseline.approvedAt,
    },
  }))

  return {
    schemaVersion: 2,
    projects: legacy.projects?.length ? legacy.projects : projects,
    runs: migratedRuns,
    baselines: migratedBaselines,
    rules: legacy.rules?.length ? legacy.rules : rules,
    ruleSnapshots: [snapshotV1],
    recomputeJobs: [],
    batches: [],
  }
}

let memoryDb: Database | null = null
const scheduledJobs = new Map<string, ReturnType<typeof setTimeout>>()

export const readDb = (): Database => {
  if (memoryDb) return memoryDb
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = seed()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial))
    memoryDb = initial
    return initial
  }
  try {
    const parsed = JSON.parse(raw) as Database | LegacyDatabaseV1
    const db =
      (parsed as Database).schemaVersion === 2
        ? (parsed as Database)
        : migrateV1(parsed as LegacyDatabaseV1)
    memoryDb = db
    return db
  } catch {
    const initial = seed()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial))
    memoryDb = initial
    return initial
  }
}

/** 失败注入：批次指定 simulateWriteFailure 时，先持久化再抛错，模拟写入中途失败 */
export const writeDb = (db: Database, forceFail = false): void => {
  const payload = JSON.stringify(db)
  localStorage.setItem(STORAGE_KEY, payload)
  memoryDb = db
  if (forceFail) {
    throw new Error('本地存储写入失败（模拟）：审批批次已保留，可从最近完整批次恢复')
  }
}

/**
 * 规则变更后让未审批运行立即失效，并安排重算。
 * 已审批/驳回及其基线保留证据，不进入重算。
 */
export const invalidateForRuleChange = (
  db: Database,
  reason: string,
  targetRunIds?: string[],
): { runIds: string[]; version: number } => {
  const current = latestSnapshot(db.ruleSnapshots)!
  const nowIso = new Date().toISOString()
  const dueAt = new Date(Date.now() + 4000).toISOString()
  const runIds = (targetRunIds ??
    db.runs
      .filter((run) => run.status === 'pending' || run.status === 'stale')
      .map((run) => run.id)).filter((id) => {
        const run = db.runs.find((item) => item.id === id)
        return run && (run.status === 'pending' || run.status === 'stale')
      })

  for (const run of db.runs) {
    if (!runIds.includes(run.id)) continue
    run.status = 'stale'
    run.invalidatedAt = nowIso
    run.invalidatedByVersion = current.version
  }

  const job: RecomputeJob = {
    id: `job-${Date.now()}`,
    runIds,
    ruleVersion: current.version,
    reason,
    createdAt: nowIso,
    dueAt,
  }
  db.recomputeJobs.push(job)
  for (const run of db.runs) {
    if (runIds.includes(run.id)) run.recomputeJobId = job.id
  }
  // 注意：只登记任务，必须等 writeDb 落盘后再 scheduleRecompute，
  // 否则定时器可能先于持久化触发，读到旧内存态而跳过重算。
  return { runIds, version: current.version }
}

/** 规则变更落盘后调用：安排重算任务 */
export const schedulePendingRecompute = (db: Database): void => {
  for (const job of db.recomputeJobs) scheduleRecompute(job.id, job.dueAt)
}

const applyRecompute = (jobId: string) => {
  const db = readDb()
  const job = db.recomputeJobs.find((item) => item.id === jobId)
  if (!job) return
  for (const run of db.runs) {
    if (!job.runIds.includes(run.id)) continue
    if (run.status !== 'stale' || run.invalidatedByVersion !== job.ruleVersion) continue
    const snapshot = db.ruleSnapshots.find((item) => item.version === job.ruleVersion)
    if (!snapshot) continue
    const evaluated = applyRules(run.regions, run, snapshot.rules)
    run.regions = evaluated
    run.mismatchRate = computeMismatchRate(evaluated)
    run.ruleVersion = snapshot.version
    run.ruleVersionSource = 'recomputed'
    run.status = 'pending'
    run.invalidatedAt = undefined
    run.invalidatedByVersion = undefined
    run.recomputeJobId = undefined
  }
  db.recomputeJobs = db.recomputeJobs.filter((item) => item.id !== jobId)
  try {
    writeDb(db)
  } catch {
    // 重算落盘失败时保留任务，下次读取仍可恢复
  }
  scheduledJobs.delete(jobId)
}

const scheduleRecompute = (jobId: string, dueAt: string) => {
  const existing = scheduledJobs.get(jobId)
  if (existing) return
  const delay = Math.max(800, new Date(dueAt).getTime() - Date.now())
  const timer = setTimeout(() => applyRecompute(jobId), delay)
  scheduledJobs.set(jobId, timer)
}

/** 页面加载时把已到期的重算任务排上队（跨刷新恢复） */
export const resumeRecomputeJobs = (): void => {
  const db = readDb()
  for (const job of db.recomputeJobs) {
    if (scheduledJobs.has(job.id)) continue
    const delay = Math.max(400, new Date(job.dueAt).getTime() - Date.now())
    const timer = setTimeout(() => applyRecompute(job.id), delay)
    scheduledJobs.set(job.id, timer)
  }
}
