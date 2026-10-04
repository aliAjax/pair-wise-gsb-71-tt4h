import type {
  Baseline,
  DifferenceRegion,
  IgnoreRule,
  Project,
  RuleSnapshot,
  ScreenshotRun,
} from '@/types'
import { backfillEvaluation, evaluateRun, snapshotAt } from '@/utils/chain'
const STORAGE_KEY = 'visual-regression-platform-v2'
const LEGACY_STORAGE_KEY = 'visual-regression-platform-v1'

export interface Database {
  schemaVersion: 2
  projects: Project[]
  runs: ScreenshotRun[]
  baselines: Baseline[]
  rules: IgnoreRule[]
  ruleSnapshots: RuleSnapshot[]
  reviewSessions: import('@/types').ReviewSession[]
  conflictDrafts: import('@/types').ConflictDraft[]
  approvalBatches: import('@/types').ApprovalBatch[]
}

const projects: Project[] = [
  { id: 'p-commerce', name: '零售交易工作台', code: 'RETAIL', owner: '沈宁', pageCount: 42 },
  { id: 'p-console', name: '云资源控制台', code: 'CLOUD', owner: '周航', pageCount: 67 },
  { id: 'p-growth', name: '增长运营平台', code: 'GROWTH', owner: '许薇', pageCount: 31 },
]

const makeRegions = (prefix: string, intensity: number): DifferenceRegion[] => [
  {
    id: `${prefix}-r1`,
    x: 11,
    y: 18,
    width: 28,
    height: 16,
    severity: 'high',
    pixels: Math.round(1840 * intensity),
    kind: 'layout',
    ignored: false,
    selector: '.checkout-summary',
  },
  {
    id: `${prefix}-r2`,
    x: 54,
    y: 34,
    width: 19,
    height: 11,
    severity: 'medium',
    pixels: Math.round(720 * intensity),
    kind: 'color',
    ignored: false,
    selector: '.price-amount',
    colorDelta: 16,
  },
  {
    id: `${prefix}-r3`,
    x: 72,
    y: 71,
    width: 18,
    height: 13,
    severity: 'low',
    pixels: Math.round(216 * intensity),
    kind: 'environment',
    ignored: true,
    ruleId: 'rule-time',
  },
  {
    id: `${prefix}-r4`,
    x: 34,
    y: 60,
    width: 12,
    height: 12,
    severity: 'low',
    pixels: Math.round(360 * intensity),
    kind: 'content',
    ignored: false,
    selector: '.user-avatar img',
    colorDelta: 10,
  },
]

// ---- 规则版本时间线（历史快照不可变，规则改动只会追加新版本） ----
const RULES_V1: RuleSnapshot['rules'] = [
  {
    id: 'rule-watermark',
    name: '测试环境水印',
    projectId: 'all',
    selector: '.environment-watermark',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 5,
    enabled: true,
  },
]

const RULES_V2: RuleSnapshot['rules'] = [
  ...RULES_V1,
  {
    id: 'rule-animation',
    name: '旧版骨架屏动画',
    projectId: 'p-console',
    selector: '.skeleton-shimmer',
    pagePattern: '*',
    devicePattern: 'iPhone*',
    maxDelta: 8,
    enabled: true,
  },
]

const RULES_V3: RuleSnapshot['rules'] = [
  ...RULES_V2.map((rule) => (rule.id === 'rule-animation' ? { ...rule, enabled: false } : rule)),
  {
    id: 'rule-time',
    name: '动态时间区域',
    projectId: 'all',
    selector: '[data-visual-ignore="relative-time"]',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 12,
    enabled: true,
  },
]

const RULES_V4: RuleSnapshot['rules'] = [
  ...RULES_V3,
  {
    id: 'rule-avatar',
    name: '用户头像随机图',
    projectId: 'p-commerce',
    selector: '.user-avatar img',
    pagePattern: '/checkout/*',
    devicePattern: '*',
    maxDelta: 14,
    enabled: true,
  },
]

const historicalSnapshots: RuleSnapshot[] = [
  {
    version: 1,
    historical: true,
    reason: '初始规则集：仅折叠测试环境水印',
    createdAt: '2026-08-01T09:00:00+08:00',
    rules: RULES_V1,
  },
  {
    version: 2,
    historical: true,
    reason: '新增控制台 iPhone 骨架屏动画忽略',
    createdAt: '2026-08-20T09:00:00+08:00',
    rules: RULES_V2,
  },
  {
    version: 3,
    historical: true,
    reason: '新增动态时间区域；骨架屏规则停用',
    createdAt: '2026-09-03T09:00:00+08:00',
    rules: RULES_V3,
  },
  {
    version: 4,
    historical: false,
    reason: '新增结算页用户头像随机图忽略',
    createdAt: '2026-09-10T09:00:00+08:00',
    rules: RULES_V4,
  },
]

const currentRules: IgnoreRule[] = [
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
    updatedAt: '2026-09-03T09:00:00+08:00',
  },
  {
    id: 'rule-avatar',
    name: '用户头像随机图',
    projectId: 'p-commerce',
    selector: '.user-avatar img',
    pagePattern: '/checkout/*',
    devicePattern: '*',
    maxDelta: 14,
    enabled: true,
    createdAt: '2026-09-05T13:25:00+08:00',
    updatedAt: '2026-09-10T09:00:00+08:00',
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
    updatedAt: '2026-08-01T09:00:00+08:00',
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
    updatedAt: '2026-09-03T09:00:00+08:00',
  },
]

const attachEvidence = (
  run: ScreenshotRun,
  snapshots: RuleSnapshot[],
): ScreenshotRun => {
  if (!run.review) return run
  const snapshot = snapshotAt(snapshots, run.review.reviewedAt)
  const evaluation = snapshot
    ? evaluateRun(run, snapshot, {
        state: 'frozen',
        basis: 'frozen',
        evaluatedAt: run.review.reviewedAt,
        manualIgnoredRegionIds: run.review.manualIgnoredRegionIds,
      })
    : {
        ruleVersion: 0,
        state: 'frozen' as const,
        basis: 'unverifiable' as const,
        evaluatedAt: run.review.reviewedAt,
        effectiveMismatchRate: run.mismatchRate,
        ignoredPixels: 0,
        activePixels: run.regions.reduce((sum, region) => sum + region.pixels, 0),
        regionCount: run.regions.length,
        ignoredRegionCount: 0,
        regionVerdicts: run.regions.map((region) => ({
          regionId: region.id,
          ignored: false,
          reason: 'none' as const,
          ruleVersion: 0,
        })),
      }
  return { ...run, evaluation }
}

const buildSeedRuns = (snapshots: RuleSnapshot[]): ScreenshotRun[] => {
  const latest = snapshots[snapshots.length - 1]

  const pending = (run: ScreenshotRun): ScreenshotRun => ({
    ...run,
    evaluation: evaluateRun(run, latest, { state: 'current', basis: 'live' }),
  })

  const runs: ScreenshotRun[] = [
    pending({
      id: 'run-1048',
      name: '结算页桌面端回归',
      projectId: 'p-commerce',
      path: '/checkout/order',
      page: '订单结算页',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/6.18.0',
      status: 'pending',
      mismatchRate: 3.82,
      capturedAt: '2026-09-29T08:42:00+08:00',
      baselineVersion: 'v6.17.4-baseline',
      currentVersion: 'v6.18.0-rc2',
      regions: makeRegions('1048', 1),
    }),
    pending({
      id: 'run-1047',
      name: '商品列表移动端回归',
      projectId: 'p-commerce',
      path: '/products/list',
      page: '商品列表页',
      device: 'iPhone 15',
      theme: 'light',
      build: 'release/6.18.0',
      status: 'pending',
      mismatchRate: 1.36,
      capturedAt: '2026-09-29T08:36:00+08:00',
      baselineVersion: 'v6.17.4-baseline',
      currentVersion: 'v6.18.0-rc2',
      regions: makeRegions('1047', 0.7),
    }),
    attachEvidence(
      {
        id: 'run-1046',
        name: '账单明细暗色主题回归',
        projectId: 'p-console',
        path: '/billing/details',
        page: '账单明细',
        device: 'Desktop 1920',
        theme: 'dark',
        build: 'feature/billing-v3',
        status: 'approved',
        mismatchRate: 5.14,
        capturedAt: '2026-09-28T17:20:00+08:00',
        baselineVersion: 'v5.9.1-baseline',
        currentVersion: 'billing-v3.7',
        regions: makeRegions('1046', 1.4),
        review: {
          category: 'design-change',
          decision: 'approved',
          reviewer: '林默',
          reason: '新计费周期列按需求上线，已核对设计稿和验收单。',
          reviewedAt: '2026-09-28T18:02:00+08:00',
          ruleVersion: 4,
        },
      },
      snapshots,
    ),
    attachEvidence(
      {
        id: 'run-1045',
        name: '活动配置页移动端回归',
        projectId: 'p-growth',
        path: '/campaign/edit',
        page: '活动配置',
        device: 'Android Pixel 8',
        theme: 'light',
        build: 'feature/campaign-editor',
        status: 'rejected',
        mismatchRate: 10.73,
        capturedAt: '2026-09-28T15:11:00+08:00',
        baselineVersion: 'v2.4.0-baseline',
        currentVersion: 'campaign-v2',
        regions: makeRegions('1045', 2.2),
        review: {
          category: 'render-error',
          decision: 'rejected',
          reviewer: '梁琪',
          reason: '主操作区被侧栏遮挡，属于阻断性渲染异常。',
          reviewedAt: '2026-09-28T15:44:00+08:00',
          ruleVersion: 4,
        },
      },
      snapshots,
    ),
    pending({
      id: 'run-1044',
      name: '资源详情页桌面端回归',
      projectId: 'p-console',
      path: '/resources/detail',
      page: '资源详情',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/5.10.0',
      status: 'pending',
      mismatchRate: 2.08,
      capturedAt: '2026-09-28T13:30:00+08:00',
      baselineVersion: 'v5.9.1-baseline',
      currentVersion: 'v5.10.0-rc1',
      regions: makeRegions('1044', 0.9),
    }),
    pending({
      id: 'run-1043',
      name: '首页推荐位回归',
      projectId: 'p-growth',
      path: '/home/recommend',
      page: '运营首页',
      device: 'Desktop 1440',
      theme: 'light',
      build: 'release/2.6.0',
      status: 'pending',
      mismatchRate: 0.94,
      capturedAt: '2026-09-27T19:15:00+08:00',
      baselineVersion: 'v2.5.3-baseline',
      currentVersion: 'v2.6.0-rc3',
      regions: makeRegions('1043', 0.5),
    }),
  ]

  // 旧运行：缺少规则记录，按采集时有效规则回填
  const oldBackfill: ScreenshotRun = {
    id: 'run-0810',
    name: '运营首页早期回归（历史数据）',
    projectId: 'p-growth',
    path: '/home/banner',
    page: '运营首页',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'release/2.1.0',
    status: 'pending',
    mismatchRate: 1.72,
    capturedAt: '2026-08-10T10:05:00+08:00',
    baselineVersion: 'v2.0.0-baseline',
    currentVersion: 'v2.1.0-rc1',
    regions: [
      {
        id: '0810-r1',
        x: 20,
        y: 30,
        width: 30,
        height: 14,
        severity: 'medium',
        pixels: 980,
        kind: 'layout',
        ignored: false,
        selector: '.banner-card',
      },
      {
        id: '0810-r2',
        x: 6,
        y: 8,
        width: 22,
        height: 8,
        severity: 'low',
        pixels: 260,
        kind: 'environment',
        ignored: false,
        ruleId: 'rule-watermark',
      },
    ],
  }
  oldBackfill.evaluation = backfillEvaluation(oldBackfill, snapshots)

  // 更早期运行：早于任何规则存档，无法判断，进入待核对
  const unverifiable: ScreenshotRun = {
    id: 'run-0720',
    name: '遗留平台迁移运行（规则记录缺失）',
    projectId: 'p-commerce',
    path: '/legacy/portal',
    page: '旧版门户页',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'release/1.6.0',
    status: 'unverifiable',
    mismatchRate: 4.55,
    capturedAt: '2026-07-20T14:00:00+08:00',
    baselineVersion: 'v1.5.0-baseline',
    currentVersion: 'v1.6.0-rc2',
    regions: [
      {
        id: '0720-r1',
        x: 12,
        y: 22,
        width: 34,
        height: 18,
        severity: 'high',
        pixels: 2120,
        kind: 'layout',
        ignored: false,
      },
    ],
  }
  unverifiable.evaluation = backfillEvaluation(unverifiable, snapshots)

  return [...runs, oldBackfill, unverifiable]
}

const buildSeedBaselines = (
  runs: ScreenshotRun[],
  snapshots: RuleSnapshot[],
): Baseline[] => {
  const evidenceFor = (runId: string, rate: number): Baseline['evidence'] => {
    const run = runs.find((item) => item.id === runId)
    if (run?.evaluation) {
      return {
        rawMismatchRate: run.mismatchRate,
        effectiveMismatchRate: run.evaluation.effectiveMismatchRate,
        regions: run.regions.map((region) => ({ ...region })),
        regionVerdicts: run.evaluation.regionVerdicts.map((verdict) => ({ ...verdict })),
        frozenAt: run.review?.reviewedAt ?? new Date().toISOString(),
      }
    }
    return {
      rawMismatchRate: rate,
      effectiveMismatchRate: rate,
      regions: [],
      regionVerdicts: [],
      frozenAt: new Date().toISOString(),
    }
  }

  return [
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
      ruleVersion: snapshotAt(snapshots, '2026-09-19T11:30:00+08:00')?.version ?? 0,
      evidence: evidenceFor('run-998', 2.31),
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
      ruleVersion: snapshotAt(snapshots, '2026-09-12T14:05:00+08:00')?.version ?? 0,
      evidence: evidenceFor('run-961', 1.18),
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
      ruleVersion: snapshotAt(snapshots, '2026-08-28T10:10:00+08:00')?.version ?? 0,
      evidence: evidenceFor('run-902', 0.64),
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
      ruleVersion: snapshotAt(snapshots, '2026-09-20T16:40:00+08:00')?.version ?? 0,
      evidence: evidenceFor('run-1002', 1.02),
    },
  ]
}

export const seed = (): Database => {
  const ruleSnapshots = historicalSnapshots.map((snapshot) => ({
    ...snapshot,
    rules: snapshot.rules.map((rule) => ({ ...rule })),
  }))
  const runs = buildSeedRuns(ruleSnapshots)
  const baselines = buildSeedBaselines(runs, ruleSnapshots)
  return {
    schemaVersion: 2,
    projects,
    runs,
    baselines,
    rules: currentRules.map((rule) => ({ ...rule })),
    ruleSnapshots,
    reviewSessions: [],
    conflictDrafts: [],
    approvalBatches: [],
  }
}

/** v1 → v2：补建规则快照链，并为旧运行回填判定或标记待核对 */
const migrateLegacy = (legacy: {
  projects?: Project[]
  runs?: ScreenshotRun[]
  baselines?: Baseline[]
  rules?: IgnoreRule[]
}): Database => {
  const snapshots = historicalSnapshots.map((snapshot) => ({
    ...snapshot,
    rules: snapshot.rules.map((rule) => ({ ...rule })),
  }))

  const migratedRules = (legacy.rules ?? currentRules).map((rule) => ({
    ...rule,
    updatedAt: rule.updatedAt ?? rule.createdAt,
  }))

  const migratedRuns = (legacy.runs ?? []).map((run) => {
    // 旧区域结构补齐字段
    run.regions = run.regions.map((region) => ({ ...region }))
    if (run.review) {
      const review = { ...run.review }
      const withReview: ScreenshotRun = { ...run, review }
      const snapshot = snapshotAt(snapshots, review.reviewedAt)
      if (snapshot) {
        review.ruleVersion = snapshot.version
        withReview.evaluation = evaluateRun(withReview, snapshot, {
          state: 'frozen',
          basis: 'frozen',
          evaluatedAt: review.reviewedAt,
        })
      } else {
        review.ruleVersion = 0
        review.evidenceIncomplete = true
        withReview.evaluation = backfillEvaluation(withReview, snapshots)
      }
      return withReview
    }
    const evaluation = backfillEvaluation(run, snapshots)
    const next: ScreenshotRun = { ...run, evaluation }
    if (evaluation.state === 'unverifiable') next.status = 'unverifiable'
    return next
  })

  const migratedBaselines = (legacy.baselines ?? []).map((baseline) => {
    const snapshot = snapshotAt(snapshots, baseline.approvedAt)
    return {
      ...baseline,
      ruleVersion: snapshot?.version ?? 0,
      evidence: {
        rawMismatchRate: 0,
        effectiveMismatchRate: 0,
        regions: [],
        regionVerdicts: [],
        frozenAt: baseline.approvedAt,
      },
    }
  })

  return {
    schemaVersion: 2,
    projects: legacy.projects ?? projects,
    runs: migratedRuns,
    baselines: migratedBaselines,
    rules: migratedRules,
    ruleSnapshots: snapshots,
    reviewSessions: [],
    conflictDrafts: [],
    approvalBatches: [],
  }
}

export const readDb = (): Database => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Database
      if (parsed.schemaVersion === 2) return parsed
    } catch {
      // 落到重建逻辑
    }
  }

  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacyRaw) {
    try {
      const db = migrateLegacy(JSON.parse(legacyRaw))
      writeDb(db)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
      return db
    } catch {
      // 旧数据损坏时回落到种子数据
    }
  }

  const initial = seed()
  writeDb(initial)
  return initial
}

export const writeDb = (db: Database): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
}
