import type {
  DifferenceRegion,
  IgnoreRule,
  ReviewEvidence,
  RuleSnapshot,
  ScreenshotRun,
} from '@/types'

/** 简易 glob 匹配：仅支持 * 通配，其余按字面量比较 */
export const globMatch = (pattern: string, value: string): boolean => {
  const p = (pattern || '*').trim() || '*'
  if (p === '*') return true
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

export const ruleScopedToRun = (rule: IgnoreRule, run: ScreenshotRun): boolean =>
  (rule.projectId === 'all' || rule.projectId === run.projectId) &&
  globMatch(rule.pagePattern, run.path ?? run.page) &&
  globMatch(rule.devicePattern, run.device)

/**
 * 按指定规则版本快照重新判定每个差异区域。
 * 纯函数，不修改入参；判定结果只依赖 run 事实与该版本规则，
 * 因此规则后改不会影响已经固化的结论。
 */
export const applyRules = (
  regions: DifferenceRegion[],
  run: ScreenshotRun,
  rules: IgnoreRule[],
): DifferenceRegion[] =>
  regions.map((region) => {
    const matched = rules.find((rule) => {
      if (!rule.enabled || !ruleScopedToRun(rule, run)) return false
      // 环境噪声区域可被通用规则覆盖；其余区域必须选择器一致
      if (region.selector) return region.selector === rule.selector
      if (region.kind === 'environment') return true
      return false
    })
    const deltaCovered = matched && (region.delta ?? 0) <= matched.maxDelta
    if (matched && deltaCovered) {
      return { ...region, ignored: true, ruleId: matched.id, ignoredBy: 'rule' }
    }
    const wasManual = region.ignored && region.ignoredBy === 'manual'
    return {
      ...region,
      ignored: wasManual,
      ruleId: wasManual ? region.ruleId : undefined,
      ignoredBy: wasManual ? 'manual' : undefined,
    }
  })

/** 总像素面积按 900×620 截图归一，和初始样例口径保持一致 */
const CANVAS_PIXELS = 100_000

export const computeMismatchRate = (regions: DifferenceRegion[]): number => {
  const activePixels = regions
    .filter((region) => !region.ignored)
    .reduce((sum, region) => sum + region.pixels, 0)
  return Number((activePixels / CANVAS_PIXELS * 100).toFixed(2))
}

/** 快照按版本倒序存放，取某时刻有效版本即 created<=at 的最新一个 */
export const snapshotAt = (snapshots: RuleSnapshot[], at: string): RuleSnapshot | null => {
  const ordered = [...snapshots].sort((a, b) => a.version - b.version)
  let found: RuleSnapshot | null = null
  for (const snapshot of ordered) {
    if (snapshot.createdAt <= at) found = snapshot
    else break
  }
  return found
}

export const latestSnapshot = (snapshots: RuleSnapshot[]): RuleSnapshot | null =>
  snapshots.length ? [...snapshots].sort((a, b) => b.version - a.version)[0] : null

export const snapshotByVersion = (snapshots: RuleSnapshot[], version: number): RuleSnapshot | null =>
  snapshots.find((snapshot) => snapshot.version === version) ?? null

export interface RunJudgement {
  /** 判定所依据的规则版本；null 表示无法判断、进入待核对 */
  ruleVersion: number | null
  rulesAt: IgnoreRule[] | null
  regions: DifferenceRegion[]
  mismatchRate: number
  regionCount: number
  ignoredCount: number
  needsCheck: boolean
  /** 已审批运行：是否保留了当时证据 */
  frozen: boolean
}

const evaluate = (run: ScreenshotRun, rules: IgnoreRule[]): Omit<RunJudgement, 'ruleVersion' | 'rulesAt' | 'needsCheck' | 'frozen'> => {
  const regions = applyRules(run.regions, run, rules)
  return {
    regions,
    mismatchRate: computeMismatchRate(regions),
    regionCount: regions.length,
    ignoredCount: regions.filter((region) => region.ignored).length,
  }
}

/**
 * 统一判定链。列表、详情、导出都必须经过本函数：
 * - 已审批/驳回：回放审批证据（冻结差异率与区域口径）
 * - 待审批：按运行锁定的规则版本快照现算
 * - 重算中：按当前规则预判，同时暴露目标版本
 * - 缺少规则记录且无法回填：进入待核对
 */
export const judgeRun = (run: ScreenshotRun, snapshots: RuleSnapshot[]): RunJudgement => {
  if (run.status === 'approved' || run.status === 'rejected' || run.status === 'merged') {
    const evidence: ReviewEvidence | undefined = run.review?.evidence
    const version = evidence?.ruleVersion ?? run.ruleVersion ?? null
    const snapshot = version === null ? null : snapshotByVersion(snapshots, version)
    const rulesAt = snapshot?.rules ?? (run.ruleVersion === null ? null : [])
    const regions = snapshot ? applyRules(run.regions, run, snapshot.rules) : run.regions
    return {
      ruleVersion: version,
      rulesAt,
      regions,
      mismatchRate: evidence?.mismatchRate ?? run.mismatchRate,
      regionCount: evidence?.regionCount ?? run.regions.length,
      ignoredCount: evidence?.ignoredCount ?? run.regions.filter((region) => region.ignored).length,
      needsCheck: false,
      frozen: Boolean(evidence),
    }
  }

  if (run.ruleVersion === null || run.ruleVersion === undefined) {
    const capturedSnapshot = snapshotAt(snapshots, run.capturedAt)
    if (!capturedSnapshot) {
      return {
        ruleVersion: null,
        rulesAt: null,
        regions: run.regions,
        mismatchRate: run.mismatchRate,
        regionCount: run.regions.length,
        ignoredCount: run.regions.filter((region) => region.ignored).length,
        needsCheck: true,
        frozen: false,
      }
    }
    return {
      ruleVersion: capturedSnapshot.version,
      rulesAt: capturedSnapshot.rules,
      ...evaluate(run, capturedSnapshot.rules),
      needsCheck: false,
      frozen: false,
    }
  }

  const snapshot = snapshotByVersion(snapshots, run.ruleVersion)
  if (!snapshot) {
    return {
      ruleVersion: run.ruleVersion,
      rulesAt: null,
      regions: run.regions,
      mismatchRate: run.mismatchRate,
      regionCount: run.regions.length,
      ignoredCount: run.regions.filter((region) => region.ignored).length,
      needsCheck: true,
      frozen: false,
    }
  }
  return {
    ruleVersion: snapshot.version,
    rulesAt: snapshot.rules,
    ...evaluate(run, snapshot.rules),
    needsCheck: false,
    frozen: false,
  }
}

export const evidenceFor = (
  run: ScreenshotRun,
  ruleVersion: number,
  snapshots: RuleSnapshot[],
  batchId?: string,
): ReviewEvidence => {
  const snapshot = snapshotByVersion(snapshots, ruleVersion)
  const regions = snapshot ? applyRules(run.regions, run, snapshot.rules) : run.regions
  return {
    ruleVersion,
    mismatchRate: computeMismatchRate(regions),
    regionCount: regions.length,
    ignoredCount: regions.filter((region) => region.ignored).length,
    batchId,
    snapshotAt: new Date().toISOString(),
  }
}
