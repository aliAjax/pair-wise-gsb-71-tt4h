export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'merged'
  | 'recalculating'
  | 'unverifiable'
export type Severity = 'high' | 'medium' | 'low'

/**
 * 判定链状态：
 * - current：打开时锁定的规则版本仍是最新，结论可直接提交
 * - stale-recalculated：打开后规则发生改动，未审批结论已失效，运行按新规则重算
 * - frozen：已审批/已驳回，差异证据按审批时规则版本冻结，基线保留当时证据
 * - backfilled：旧运行缺少规则记录，已按当时有效规则回填
 * - unverifiable：无法判断当时适用哪一版规则，进入待核对
 */
export type ChainState =
  | 'current'
  | 'stale-recalculated'
  | 'frozen'
  | 'backfilled'
  | 'unverifiable'

export type ChainBasis = 'live' | 'frozen' | 'backfilled' | 'unverifiable'

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
  ignored: boolean
  ruleId?: string
  /** 区域命中的 DOM 选择器，规则匹配优先用 ruleId，再回退 selector */
  selector?: string
  /** 区域实测色差 ΔE，与规则 maxDelta 比较决定是否折叠 */
  colorDelta?: number
}

/** 单个差异区域在某一规则版本下的判定结果 */
export interface RegionVerdict {
  regionId: string
  ignored: boolean
  reason: 'rule' | 'manual' | 'none'
  ruleId?: string
  ruleName?: string
  ruleVersion: number
}

/** 一条运行在某一规则版本下的完整评估结果 */
export interface RunEvaluation {
  ruleVersion: number
  state: ChainState
  basis: ChainBasis
  evaluatedAt: string
  /** 判定生效的差异率（已折叠规则忽略区域） */
  effectiveMismatchRate: number
  ignoredPixels: number
  activePixels: number
  regionCount: number
  ignoredRegionCount: number
  regionVerdicts: RegionVerdict[]
  /** 本版评估相较上一版，差异率变化（百分点，正为升高） */
  deltaFromPrevious?: number
  /** 失效重算原因（规则改动说明） */
  invalidatedReason?: string
}

export interface ChainView {
  run: ScreenshotRun
  state: ChainState
  basis: ChainBasis
  ruleVersion: number
  effectiveMismatchRate: number
  rawMismatchRate: number
  evaluation: RunEvaluation
  /** 判定依据说明（列表、详情、导出共用文案） */
  basisLabel: string
  stale: boolean
  unverifiable: boolean
  frozen: boolean
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 审批生效的规则版本，即证据快照版本 */
  ruleVersion: number
  /** 提交时附带的人工忽略区域（与规则忽略分开留痕） */
  manualIgnoredRegionIds?: string[]
  /** 旧运行回填时无法确认版本则为 true */
  evidenceIncomplete?: boolean
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  /** 页面对应的路由路径，用于规则 pagePattern 匹配 */
  path?: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  /** 采集时原始差异率，仅作历史留存；对外一律以判定链 effectiveMismatchRate 为准 */
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  baselineImage?: string
  currentImage?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
  /** 判定链评估结果（随规则版本失效重算而更新；已审批运行冻结不再更新） */
  evaluation?: RunEvaluation
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
  /** 基线生成时锁定的规则版本与证据快照 */
  ruleVersion: number
  evidence: BaselineEvidence
}

/** 基线保留的当时证据：区域、差异率、规则版本均不可变 */
export interface BaselineEvidence {
  rawMismatchRate: number
  effectiveMismatchRate: number
  regions: DifferenceRegion[]
  regionVerdicts: RegionVerdict[]
  frozenAt: string
}

/** 规则在某一版本下的不可变快照 */
export interface RuleSnapshot {
  version: number
  /** rv1 之前已生效的历史版本，用于旧运行回填 */
  historical: boolean
  reason: string
  createdAt: string
  /** 该版本下启用的规则集合（按 id 存档内容） */
  rules: Array<{
    id: string
    name: string
    projectId: string
    selector: string
    pagePattern: string
    devicePattern: string
    maxDelta: number
    enabled: boolean
  }>
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
  updatedAt: string
}

/** 审批页打开时创建的会话，记录打开时刻的规则版本 */
export interface ReviewSession {
  id: string
  runId: string
  reviewer: string
  /** 打开审批页时锁定的规则版本 */
  basisRuleVersion: number
  openedAt: string
  /** 会话已提交结论则关闭 */
  closed: boolean
}

/** 乐观锁冲突：先写入者的取值（winner）与落后页面的取值（loser）并存 */
export interface ConflictDraft {
  id: string
  runId: string
  detectedAt: string
  winner: {
    reviewer: string
    decision: 'approved' | 'rejected'
    category: ReviewCategory
    reason: string
    ruleVersion: number
    submittedAt: string
  }
  loser: {
    reviewer: string
    decision: 'approved' | 'rejected'
    category: ReviewCategory
    reason: string
    basisRuleVersion: number
    submittedAt: string
  }
  /** 冲突原因：规则已改动 / 运行已被他人先审批 */
  kind: 'rule-changed' | 'already-reviewed'
  resolved: boolean
}

export type ApprovalItemStatus = 'pending' | 'committed' | 'failed'

export interface ApprovalBatchItem {
  runId: string
  status: ApprovalItemStatus
  reviewer: string
  decision: 'approved' | 'rejected'
  category: ReviewCategory
  reason: string
  basisRuleVersion: number
  committedAt?: string
  baselineId?: string
  error?: string
}

/** 审批批次：可恢复的最小提交单元集合 */
export interface ApprovalBatch {
  id: string
  idempotencyKey: string
  createdAt: string
  updatedAt: string
  status: 'processing' | 'partial' | 'completed'
  items: ApprovalBatchItem[]
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  staleCount: number
  unverifiableCount: number
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
  /** 审批会话 id（打开审批页时获取），携带打开时锁定的规则版本 */
  sessionId?: string
  manualIgnoredRegionIds?: string[]
}

export interface BatchReviewItem {
  runId: string
  decision: 'approved' | 'rejected'
  category: ReviewCategory
  reviewer: string
  reason: string
}

export interface BatchReviewPayload {
  idempotencyKey?: string
  items: BatchReviewItem[]
  /** 故障注入：处理到第几项时模拟一次写入失败（演示恢复） */
  failAfterIndex?: number
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

export interface RuleInput {
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
}
