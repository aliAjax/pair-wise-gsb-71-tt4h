export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus =
  | 'pending'
  | 'stale'
  | 'needs-check'
  | 'approved'
  | 'rejected'
  | 'merged'
export type Severity = 'high' | 'medium' | 'low'
/** 判定依据来源：运行采集时锁定 / 旧运行回填 / 规则变更后重算 / 人工核对回填 */
export type RuleVersionSource = 'capture' | 'backfilled' | 'recomputed' | 'checked'
export type RegionIgnoredBy = 'rule' | 'manual'

export interface Project {
  id: string
  name: string
  code: string
  owner: string
  pageCount: number
}

export interface DifferenceRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  /** 实测色差，用于和规则 maxDelta 比较 */
  delta?: number
  /** 区域所属 DOM 选择器，用于命中忽略规则 */
  selector?: string
  ignored: boolean
  ruleId?: string
  ignoredBy?: RegionIgnoredBy
}

/** 审批冻结的判定证据，规则后改也不再变化 */
export interface ReviewEvidence {
  ruleVersion: number
  mismatchRate: number
  regionCount: number
  ignoredCount: number
  batchId?: string
  /** 证据固化时间 */
  snapshotAt: string
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 提交时锁定的规则版本 */
  ruleVersion: number
  evidence: ReviewEvidence
}

export interface ConflictParty {
  reviewer: string
  decision: 'approved' | 'rejected'
  category: ReviewCategory
  reason: string
  at: string
  ruleVersion: number | null
}

/** 两人同时提交同一运行时，先生效结论与落后页面取值的冲突草稿 */
export interface ConflictDraft {
  id: string
  createdAt: string
  winner: ConflictParty
  loser: ConflictParty
  resolved: boolean
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  /** 页面路径，用于 pagePattern 匹配（如 /checkout/order） */
  path?: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
  /** 判定依据锁定的规则版本；null 表示缺少规则记录、无法判断 */
  ruleVersion?: number | null
  ruleVersionSource?: RuleVersionSource
  /** 规则变更导致失效的时间 */
  invalidatedAt?: string
  /** 正在等待重算到的规则版本 */
  invalidatedByVersion?: number
  recomputeJobId?: string
  /** 并发提交保留下来的双方取值草稿 */
  conflicts?: ConflictDraft[]
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  active: boolean
  /** 基线生成时锁定的规则版本与证据，后续规则修改不影响 */
  ruleVersion: number
  evidence: ReviewEvidence
}

export interface IgnoreRule {
  id: string
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  createdAt: string
}

/** 规则快照：每次规则变更生成一个不可变版本 */
export interface RuleSnapshot {
  version: number
  createdAt: string
  reason: string
  rules: IgnoreRule[]
}

/** 规则变更后未审批运行的重算任务 */
export interface RecomputeJob {
  id: string
  runIds: string[]
  ruleVersion: number
  reason: string
  createdAt: string
  dueAt: string
}

export interface ApprovalBatchItem {
  runId: string
  /** 建批时该运行锁定的规则版本（未受规则变更影响的运行保持旧版本） */
  ruleVersion: number
  reviewer: string
  decision: 'approved' | 'rejected'
  category: ReviewCategory
  reason: string
  status: 'pending' | 'done' | 'failed'
  errorCode?: string
  error?: string
  finishedAt?: string
  baselineId?: string
  idempotent?: boolean
}

export interface ApprovalBatch {
  id: string
  createdAt: string
  createdBy: string
  /** 批次打开时锁定的规则版本 */
  ruleVersion: number
  status: 'running' | 'interrupted' | 'complete'
  items: ApprovalBatchItem[]
  interruptedAt?: string
  completedAt?: string
  baselineIds: string[]
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  staleReview: number
  needsCheck: number
  ruleVersion: number
  trend: Array<{ date: string; total: number; failed: number }>
}

export interface RunFilters {
  projectId?: string
  page?: string
  device?: string
  theme?: string
  build?: string
  status?: string
  keyword?: string
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  /** 审批页打开时记下的规则版本 */
  ruleVersion?: number | null
}

export interface ReviewSubmitResult {
  run: ScreenshotRun
  idempotent: boolean
  conflict: ConflictDraft | null
}

export interface BatchReviewPayload {
  /** 客户端生成的批次幂等键 */
  id: string
  createdBy: string
  reviewer: string
  decision: 'approved' | 'rejected'
  category: ReviewCategory
  reason: string
  runIds: string[]
  /** 演示用：在首批写入后模拟一次写入失败 */
  simulateWriteFailure?: boolean
}

export interface BatchReviewResult {
  batch: ApprovalBatch
  resumed: boolean
  interrupted: boolean
  completed: Array<{ runId: string; baselineId?: string; idempotent?: boolean }>
  failed: Array<{ runId: string; code: string; message: string }>
  skipped: Array<{ runId: string; reason: string }>
}

export interface RuleMutationResult {
  rule: IgnoreRule | null
  ruleVersion: number
  invalidatedRunIds: string[]
}

export interface ImportRunPayload {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  baselineVersion: string
  currentVersion: string
  files: Array<{ name: string; size: number; dataUrl: string }>
  baselineImage?: string
}
