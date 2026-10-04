import type {
  ChainBasis,
  ChainState,
  ChainView,
  DifferenceRegion,
  RegionVerdict,
  RuleSnapshot,
  RunEvaluation,
  ScreenshotRun,
} from '@/types'

/**
 * 可恢复判定链的纯函数引擎：
 *   规则版本快照 → 差异区域判定 → 运行评估 → 审批/基线证据
 * 列表、详情、导出都只能经由 buildChainView 读取结果，避免多处各算各的。
 */

const matchPattern = (pattern: string | undefined, value: string | undefined): boolean => {
  if (!pattern || pattern === '*') return true
  const target = value ?? ''
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(target)
}

export interface RuleMatchContext {
  projectId: string
  path?: string
  page: string
  device: string
}

export type ArchivedRule = RuleSnapshot['rules'][number]

export const matchRule = (
  rule: ArchivedRule,
  region: DifferenceRegion,
  context: RuleMatchContext,
): boolean => {
  if (!rule.enabled) return false
  if (rule.projectId !== 'all' && rule.projectId !== context.projectId) return false
  if (!matchPattern(rule.pagePattern, context.path ?? context.page)) return false
  if (!matchPattern(rule.devicePattern, context.device)) return false
  // 优先按区域绑定的 ruleId 匹配（由调用方过滤），否则用选择器命中
  if (region.ruleId) return region.ruleId === rule.id
  if (region.selector && region.selector !== rule.selector) return false
  // 色差区域受 maxDelta 约束：实测色差超过阈值不折叠
  if (typeof region.colorDelta === 'number' && region.colorDelta > rule.maxDelta) return false
  return true
}

const findMatchedRule = (
  region: DifferenceRegion,
  snapshot: RuleSnapshot,
  context: RuleMatchContext,
): ArchivedRule | undefined => {
  const candidates = snapshot.rules.filter((rule) =>
    region.ruleId ? rule.id === region.ruleId : region.selector === rule.selector,
  )
  // 项目级规则优先于全局规则
  candidates.sort((a) => (a.projectId === 'all' ? 1 : -1))
  return candidates.find((rule) => matchRule(rule, region, context))
}

export interface EvaluateOptions {
  manualIgnoredRegionIds?: string[]
  state?: ChainState
  basis?: ChainBasis
  evaluatedAt?: string
  previousRate?: number
}

/** 在指定规则版本下评估一条运行，产出区域判定与有效差异率 */
export const evaluateRun = (
  run: ScreenshotRun,
  snapshot: RuleSnapshot,
  options: EvaluateOptions = {},
): RunEvaluation => {
  const context: RuleMatchContext = {
    projectId: run.projectId,
    path: run.path,
    page: run.page,
    device: run.device,
  }
  const manual = new Set(options.manualIgnoredRegionIds ?? [])
  const totalPixels = run.regions.reduce((sum, region) => sum + region.pixels, 0)

  const regionVerdicts: RegionVerdict[] = run.regions.map((region) => {
    if (manual.has(region.id)) {
      return {
        regionId: region.id,
        ignored: true,
        reason: 'manual',
        ruleVersion: snapshot.version,
      }
    }
    const matched = findMatchedRule(region, snapshot, context)
    if (matched) {
      return {
        regionId: region.id,
        ignored: true,
        reason: 'rule',
        ruleId: matched.id,
        ruleName: matched.name,
        ruleVersion: snapshot.version,
      }
    }
    return { regionId: region.id, ignored: false, reason: 'none', ruleVersion: snapshot.version }
  })

  const ignoredPixels = run.regions.reduce(
    (sum, region, index) => (regionVerdicts[index].ignored ? sum + region.pixels : sum),
    0,
  )
  const activePixels = Math.max(totalPixels - ignoredPixels, 0)
  // 原始差异率按差异像素占比标定，折叠忽略区域后按比例折算
  const effectiveMismatchRate =
    totalPixels === 0
      ? 0
      : Number((run.mismatchRate * (activePixels / totalPixels)).toFixed(2))

  return {
    ruleVersion: snapshot.version,
    state: options.state ?? 'current',
    basis: options.basis ?? 'live',
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
    effectiveMismatchRate,
    ignoredPixels,
    activePixels,
    regionCount: run.regions.length,
    ignoredRegionCount: regionVerdicts.filter((verdict) => verdict.ignored).length,
    regionVerdicts,
    deltaFromPrevious:
      typeof options.previousRate === 'number'
        ? Number((effectiveMismatchRate - options.previousRate).toFixed(2))
        : undefined,
  }
}

/** 取某时刻生效的规则版本：createdAt <= at 中版本号最大者（historical 仅作展示标记，不参与时间判断） */
export const snapshotAt = (
  snapshots: RuleSnapshot[],
  at: string,
): RuleSnapshot | undefined => {
  const eligible = snapshots
    .filter((snapshot) => snapshot.createdAt <= at)
    .sort((a, b) => b.version - a.version)
  return eligible[0]
}

export const latestSnapshot = (snapshots: RuleSnapshot[]): RuleSnapshot =>
  snapshots.reduce((max, snapshot) => (snapshot.version > max.version ? snapshot : max), snapshots[0])

/**
 * 旧运行回填：按运行采集时刻找当时有效规则。
 * 找到 → backfilled；当时还没有任何规则存档 → unverifiable（待核对）。
 */
export const backfillEvaluation = (
  run: ScreenshotRun,
  snapshots: RuleSnapshot[],
): RunEvaluation => {
  const snapshot = snapshotAt(snapshots, run.capturedAt)
  if (!snapshot) {
    const totalPixels = run.regions.reduce((sum, region) => sum + region.pixels, 0)
    return {
      ruleVersion: 0,
      state: 'unverifiable',
      basis: 'unverifiable',
      evaluatedAt: new Date().toISOString(),
      effectiveMismatchRate: run.mismatchRate,
      ignoredPixels: 0,
      activePixels: totalPixels,
      regionCount: run.regions.length,
      ignoredRegionCount: 0,
      regionVerdicts: run.regions.map((region) => ({
        regionId: region.id,
        ignored: false,
        reason: 'none',
        ruleVersion: 0,
      })),
    }
  }
  return evaluateRun(run, snapshot, { state: 'backfilled', basis: 'backfilled' })
}

const basisLabels: Record<ChainBasis, string> = {
  live: '按打开时锁定规则版本判定',
  frozen: '按审批时规则版本冻结，保留当时证据',
  backfilled: '缺少规则记录，已按当时有效规则回填',
  unverifiable: '无法判断当时规则，待核对',
}

/**
 * 列表 / 详情 / 导出唯一的判定入口。
 * 已审批运行：冻结证据；未审批：按当前评估（可能已因规则改动而重算）。
 */
export const buildChainView = (
  run: ScreenshotRun,
  _snapshots: RuleSnapshot[] = [],
): ChainView => {
  const fallbackEvaluation: RunEvaluation = {
    ruleVersion: 0,
    state: 'unverifiable',
    basis: 'unverifiable',
    evaluatedAt: run.capturedAt,
    effectiveMismatchRate: run.mismatchRate,
    ignoredPixels: 0,
    activePixels: run.regions.reduce((sum, region) => sum + region.pixels, 0),
    regionCount: run.regions.length,
    ignoredRegionCount: 0,
    regionVerdicts: [],
  }
  const evaluation: RunEvaluation = run.evaluation ?? fallbackEvaluation

  const state = run.status === 'unverifiable' ? 'unverifiable' : evaluation.state
  const basis: ChainBasis = state === 'frozen' ? 'frozen' : evaluation.basis

  return {
    run,
    state,
    basis,
    ruleVersion: evaluation.ruleVersion,
    effectiveMismatchRate: evaluation.effectiveMismatchRate,
    rawMismatchRate: run.mismatchRate,
    evaluation,
    basisLabel: basisLabels[basis],
    stale: state === 'stale-recalculated',
    unverifiable: state === 'unverifiable',
    frozen: state === 'frozen',
  }
}
