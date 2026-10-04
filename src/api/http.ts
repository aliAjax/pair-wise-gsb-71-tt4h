import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb, type Database } from '@/mocks/db'
import { buildChainView, evaluateRun, latestSnapshot } from '@/utils/chain'
import type {
  ApprovalBatch,
  Baseline,
  ConflictDraft,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  Project,
  ReviewPayload,
  ReviewSession,
  RuleInput,
  RuleSnapshot,
  RunEvaluation,
  RunFilters,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'Created',
  headers: {},
  config,
})

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

class MockHttpError extends Error {
  response: { status: number; data: unknown }
  constructor(status: number, message: string, data: unknown = null) {
    super(message)
    this.name = 'MockHttpError'
    this.response = { status, data }
  }
}

const genId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// ---- 串行化所有读-改-写，保证“先写入者生效”的确定性 ----
let writeChain: Promise<unknown> = Promise.resolve()
const withLock = <T>(task: () => T): Promise<T> => {
  const run = writeChain.then(() => task())
  // 失败不应污染整条链
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------------- 判定链核心 ----------------

/** 规则作用域/色差等判定要素是否发生变化（纯改名不产生新版本） */
const isRuleSemanticChange = (before: IgnoreRule, patch: Partial<IgnoreRule>): boolean =>
  (['projectId', 'selector', 'pagePattern', 'devicePattern', 'maxDelta', 'enabled'] as const).some(
    (key) => key in patch && patch[key] !== before[key],
  )

/** 追加一版不可变规则快照 */
const appendSnapshot = (db: Database, reason: string): RuleSnapshot => {
  const current = latestSnapshot(db.ruleSnapshots)
  const snapshot: RuleSnapshot = {
    version: current.version + 1,
    historical: false,
    reason,
    createdAt: new Date().toISOString(),
    rules: db.rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        id: rule.id,
        name: rule.name,
        projectId: rule.projectId,
        selector: rule.selector,
        pagePattern: rule.pagePattern,
        devicePattern: rule.devicePattern,
        maxDelta: rule.maxDelta,
        enabled: rule.enabled,
      })),
  }
  db.ruleSnapshots.push(snapshot)
  return snapshot
}

/**
 * 作用域或色差一改动：未审批运行立即失效并按新版规则重算；
 * 已审批运行冻结不动，已生成基线保留当时证据。
 */
const invalidatePendingRuns = (db: Database, snapshot: RuleSnapshot, reason: string) => {
  for (const run of db.runs) {
    if (run.status !== 'pending' || !run.evaluation) continue
    if (run.evaluation.state === 'frozen') continue
    const previousRate = run.evaluation.effectiveMismatchRate
    run.evaluation = evaluateRun(run, snapshot, {
      state: 'stale-recalculated',
      basis: 'live',
      previousRate,
    })
    run.evaluation.evaluatedAt = new Date().toISOString()
    // 失效原因挂在评估上（供页面展示，不改变判定数值结构）
    ;(run.evaluation as RunEvaluation & { invalidatedReason?: string }).invalidatedReason = reason
  }
  // 打开中的会话立刻落后于新版本
  for (const session of db.reviewSessions) {
    if (!session.closed && session.basisRuleVersion < snapshot.version) {
      session.closed = true
    }
  }
}

interface CommitResult {
  outcome: 'committed' | 'idempotent'
  run: ScreenshotRun
  baseline?: Baseline
  conflict?: ConflictDraft
}

interface CommitContext {
  basisRuleVersion?: number
  reviewer: string
  manualIgnoredRegionIds?: string[]
}

/**
 * 单条审批提交（单审与批次共用同一入口，保证行为一致）：
 * 1. 运行已有结论 → 同人同结论幂等返回；结论不同则先写入者胜，落后者生成冲突草稿
 * 2. 打开时规则版本落后 → 409 + 规则已变更冲突草稿
 * 3. 批准创建基线，按 runId 幂等，重复提交不会多出基线
 */
const commitReview = (
  db: Database,
  run: ScreenshotRun,
  payload: ReviewPayload,
  context: CommitContext,
): CommitResult => {
  const now = new Date().toISOString()
  const snapshot = latestSnapshot(db.ruleSnapshots)

  if (run.review) {
    const sameConclusion =
      run.review.reviewer === payload.reviewer &&
      run.review.decision === payload.decision &&
      run.review.category === payload.category
    if (sameConclusion) {
      return { outcome: 'idempotent', run }
    }
    // 先写入的生效，落后的页面保留双方取值的冲突草稿
    const conflict: ConflictDraft = {
      id: genId('conflict'),
      runId: run.id,
      detectedAt: now,
      kind: 'already-reviewed',
      resolved: false,
      winner: {
        reviewer: run.review.reviewer,
        decision: run.review.decision,
        category: run.review.category,
        reason: run.review.reason,
        ruleVersion: run.review.ruleVersion,
        submittedAt: run.review.reviewedAt,
      },
      loser: {
        reviewer: payload.reviewer,
        decision: payload.decision,
        category: payload.category,
        reason: payload.reason,
        basisRuleVersion: context.basisRuleVersion ?? snapshot.version,
        submittedAt: now,
      },
    }
    db.conflictDrafts.unshift(conflict)
    return { outcome: 'idempotent', run, conflict }
  }

  const basis = context.basisRuleVersion ?? snapshot.version
  if (basis < snapshot.version) {
    const conflict: ConflictDraft = {
      id: genId('conflict'),
      runId: run.id,
      detectedAt: now,
      kind: 'rule-changed',
      resolved: false,
      winner: {
        reviewer: '系统（规则版本已推进）',
        decision: payload.decision,
        category: payload.category,
        reason: `规则已从 rv${basis} 更新到 rv${snapshot.version}，请按重算结果重新判定`,
        ruleVersion: snapshot.version,
        submittedAt: now,
      },
      loser: {
        reviewer: payload.reviewer,
        decision: payload.decision,
        category: payload.category,
        reason: payload.reason,
        basisRuleVersion: basis,
        submittedAt: now,
      },
    }
    db.conflictDrafts.unshift(conflict)
    return { outcome: 'idempotent', run, conflict }
  }

  const frozen = evaluateRun(run, snapshot, {
    state: 'frozen',
    basis: 'frozen',
    evaluatedAt: now,
    manualIgnoredRegionIds: context.manualIgnoredRegionIds,
  })

  run.status = payload.decision
  run.review = {
    category: payload.category,
    decision: payload.decision,
    reviewer: payload.reviewer,
    reason: payload.reason,
    reviewedAt: now,
    ruleVersion: snapshot.version,
    manualIgnoredRegionIds: context.manualIgnoredRegionIds,
  }
  run.evaluation = frozen

  let baseline: Baseline | undefined
  if (payload.decision === 'approved') {
    // 按 runId 幂等：同一运行重复提交不会多出基线
    baseline = db.baselines.find((item) => item.runId === run.id)
    if (!baseline) {
      for (const existing of db.baselines) {
        if (
          existing.projectId === run.projectId &&
          existing.page === run.page &&
          existing.device === run.device &&
          existing.theme === run.theme &&
          existing.active
        ) {
          existing.active = false
        }
      }
      baseline = {
        id: genId('base'),
        projectId: run.projectId,
        page: run.page,
        device: run.device,
        theme: run.theme,
        version: run.currentVersion,
        approvedBy: payload.reviewer,
        reason: payload.reason,
        approvedAt: now,
        runId: run.id,
        active: true,
        ruleVersion: snapshot.version,
        evidence: {
          rawMismatchRate: run.mismatchRate,
          effectiveMismatchRate: frozen.effectiveMismatchRate,
          regions: run.regions.map((region) => ({ ...region })),
          regionVerdicts: frozen.regionVerdicts.map((verdict) => ({ ...verdict })),
          frozenAt: now,
        },
      }
      db.baselines.unshift(baseline)
    }
  }

  return { outcome: 'committed', run, baseline }
}

// ---------------- Mock adapter ----------------

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 160))
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, readDb().projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const db = readDb()
    const pending = db.runs.filter(
      (run) => run.status === 'pending' && run.evaluation?.state !== 'frozen',
    )
    const today = new Date().toISOString().slice(0, 10)
    const dashboard: DashboardData = {
      pendingReview: pending.filter((run) => run.evaluation?.state !== 'unverifiable').length,
      approvedToday: db.runs.filter(
        (run) => run.review?.decision === 'approved' && run.review.reviewedAt.slice(0, 10) === today,
      ).length,
      highRisk: db.runs.filter(
        (run) =>
          (run.status === 'pending' || run.status === 'unverifiable') &&
          (run.evaluation?.effectiveMismatchRate ?? run.mismatchRate) >= 5,
      ).length,
      activeBaselines: db.baselines.filter((baseline) => baseline.active).length,
      staleCount: db.runs.filter((run) => run.evaluation?.state === 'stale-recalculated').length,
      unverifiableCount: db.runs.filter((run) => run.status === 'unverifiable').length,
      trend: [
        { date: '09-23', total: 36, failed: 7 },
        { date: '09-24', total: 42, failed: 4 },
        { date: '09-25', total: 39, failed: 9 },
        { date: '09-26', total: 47, failed: 6 },
        { date: '09-27', total: 44, failed: 5 },
        { date: '09-28', total: 52, failed: 11 },
        { date: '09-29', total: 29, failed: 8 },
      ],
    }
    return respond(config, dashboard)
  }

  if (method === 'get' && path === '/runs') {
    const db = readDb()
    const filters = (config.params ?? {}) as RunFilters
    const keyword = filters.keyword?.trim().toLowerCase()
    const data = db.runs.filter((run) => {
      return (
        (!filters.projectId || run.projectId === filters.projectId) &&
        (!filters.page || run.page === filters.page) &&
        (!filters.device || run.device === filters.device) &&
        (!filters.theme || run.theme === filters.theme) &&
        (!filters.build || run.build === filters.build) &&
        (!filters.status || run.status === filters.status) &&
        (!keyword ||
          run.name.toLowerCase().includes(keyword) ||
          run.page.toLowerCase().includes(keyword) ||
          run.id.toLowerCase().includes(keyword))
      )
    })
    return respond(config, data)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  if (method === 'get' && runMatch) {
    const run = readDb().runs.find((item) => item.id === runMatch[1])
    if (!run) throw new MockHttpError(404, '运行记录不存在')
    return respond(config, run)
  }

  // 打开审批页：创建会话，记下当时规则版本
  const sessionMatch = path.match(/^\/runs\/([^/]+)\/review-session$/)
  if (method === 'post' && sessionMatch) {
    return withLock(() => {
      const db = readDb()
      const run = db.runs.find((item) => item.id === sessionMatch[1])
      if (!run) throw new MockHttpError(404, '运行记录不存在')
      const body = parseBody<{ reviewer?: string }>(config)
      const snapshot = latestSnapshot(db.ruleSnapshots)
      // 同一运行同一审批人复用未关闭会话；规则推进后旧会话关闭、另开新会话
      const existing = db.reviewSessions.find(
        (session) =>
          session.runId === run.id &&
          session.reviewer === (body.reviewer ?? '') &&
          !session.closed &&
          session.basisRuleVersion === snapshot.version,
      )
      if (existing) return respond(config, existing)
      const session: ReviewSession = {
        id: genId('session'),
        runId: run.id,
        reviewer: body.reviewer ?? '匿名审批人',
        basisRuleVersion: snapshot.version,
        openedAt: new Date().toISOString(),
        closed: false,
      }
      db.reviewSessions.unshift(session)
      writeDb(db)
      return respond(config, session, 201)
    })
  }

  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    return withLock(() => {
      const db = readDb()
      const run = db.runs.find((item) => item.id === reviewMatch[1])
      if (!run) throw new MockHttpError(404, '运行记录不存在')

      let basis: number | undefined
      if (payload.sessionId) {
        const session = db.reviewSessions.find((item) => item.id === payload.sessionId)
        if (session) basis = session.basisRuleVersion
      }

      const result = commitReview(db, run, payload, {
        basisRuleVersion: basis,
        reviewer: payload.reviewer,
        manualIgnoredRegionIds: payload.manualIgnoredRegionIds,
      })

      if (result.conflict) {
        writeDb(db)
        throw new MockHttpError(
          409,
          result.conflict.kind === 'rule-changed'
            ? `规则版本已更新（rv${result.conflict.loser.basisRuleVersion} → rv${result.conflict.winner.ruleVersion}），结论基于旧版本，请按重算结果重新判定`
            : `该运行已由 ${result.conflict.winner.reviewer} 先行提交结论，后提交内容已存为冲突草稿`,
          { conflict: result.conflict, run: result.run },
        )
      }

      if (payload.sessionId) {
        const session = db.reviewSessions.find((item) => item.id === payload.sessionId)
        if (session) session.closed = true
      }
      writeDb(db)
      return respond(config, result.run)
    })
  }

  // 规则改动后人工确认“按重算结果继续”：stale → current
  const recheckMatch = path.match(/^\/runs\/([^/]+)\/recheck$/)
  if (method === 'post' && recheckMatch) {
    return withLock(() => {
      const db = readDb()
      const run = db.runs.find((item) => item.id === recheckMatch[1])
      if (!run) throw new MockHttpError(404, '运行记录不存在')
      if (run.evaluation?.state === 'stale-recalculated') {
        run.evaluation.state = 'current'
        writeDb(db)
      }
      return respond(config, run)
    })
  }

  // 待核对运行经人工确认后进入正常待审批
  const verifyMatch = path.match(/^\/runs\/([^/]+)\/verify$/)
  if (method === 'post' && verifyMatch) {
    return withLock(() => {
      const db = readDb()
      const run = db.runs.find((item) => item.id === verifyMatch[1])
      if (!run) throw new MockHttpError(404, '运行记录不存在')
      const snapshot = latestSnapshot(db.ruleSnapshots)
      run.status = 'pending'
      run.evaluation = evaluateRun(run, snapshot, { state: 'current', basis: 'live' })
      writeDb(db)
      return respond(config, run)
    })
  }

  // 可恢复批量审批
  if (method === 'post' && path === '/runs/batch-review') {
    const payload = parseBody<{
      idempotencyKey?: string
      items: Array<{
        runId: string
        decision: 'approved' | 'rejected'
        category: import('@/types').ReviewCategory
        reviewer: string
        reason: string
      }>
      failAfterIndex?: number
    }>(config)

    return withLock(() => {
      const db = readDb()

      if (payload.idempotencyKey) {
        const existing = db.approvalBatches.find(
          (batch) => batch.idempotencyKey === payload.idempotencyKey,
        )
        if (existing) return respond(config, existing)
      }

      const now = new Date().toISOString()
      const snapshot = latestSnapshot(db.ruleSnapshots)
      const batch: ApprovalBatch = {
        id: genId('batch'),
        idempotencyKey: payload.idempotencyKey ?? genId('idem'),
        createdAt: now,
        updatedAt: now,
        status: 'processing',
        items: payload.items.map((item) => ({
          runId: item.runId,
          status: 'pending',
          reviewer: item.reviewer,
          decision: item.decision,
          category: item.category,
          reason: item.reason,
          basisRuleVersion: snapshot.version,
        })),
      }
      db.approvalBatches.unshift(batch)

      const conflicts: ConflictDraft[] = []
      let interrupted = false

      payload.items.forEach((item, index) => {
        if (interrupted) return
        const target = batch.items[index]

        // 故障注入：在指定项之前模拟写入中断（本项及之后均未完成）
        if (payload.failAfterIndex != null && index === payload.failAfterIndex) {
          interrupted = true
          return
        }

        const run = db.runs.find((candidate) => candidate.id === item.runId)
        if (!run) {
          target.status = 'failed'
          target.error = '运行记录不存在'
          return
        }

        const result = commitReview(
          db,
          run,
          {
            category: item.category,
            decision: item.decision,
            reviewer: item.reviewer,
            reason: item.reason,
          },
          {
            basisRuleVersion: target.basisRuleVersion,
            reviewer: item.reviewer,
          },
        )

        if (result.conflict) {
          conflicts.push(result.conflict)
          target.status = 'failed'
          target.error =
            result.conflict.kind === 'rule-changed'
              ? '规则版本已变更，需按重算结果重审'
              : `与 ${result.conflict.winner.reviewer} 的先提交结论冲突`
          return
        }

        target.status = 'committed'
        target.committedAt = new Date().toISOString()
        target.baselineId = result.baseline?.id
        // 逐项落盘：任意后续项失败都能从最近完整批次恢复
        batch.updatedAt = new Date().toISOString()
        writeDb(db)
      })

      const pendingCount = batch.items.filter((item) => item.status === 'pending').length
      const failedCount = batch.items.filter((item) => item.status === 'failed').length
      batch.status = pendingCount > 0 ? 'partial' : failedCount > 0 ? 'partial' : 'completed'
      writeDb(db)

      if (interrupted) {
        throw new MockHttpError(500, `批次在第 ${payload.failAfterIndex! + 1} 项写入中断，可从最近审批批次恢复`, {
          batch,
        })
      }
      return respond(config, { batch, conflicts }, batch.status === 'completed' ? 201 : 200)
    })
  }

  const batchResumeMatch = path.match(/^\/approvals\/batches\/([^/]+)\/resume$/)
  if (method === 'post' && batchResumeMatch) {
    const body = parseBody<{ failAfterIndex?: number }>(config)
    return withLock(() => {
      const db = readDb()
      const batch = db.approvalBatches.find((item) => item.id === batchResumeMatch[1])
      if (!batch) throw new MockHttpError(404, '审批批次不存在')

      // 只补未完成项；committed / failed 不动，保证不产生重复基线
      const pendingIndexes = batch.items
        .map((item, index) => (item.status === 'pending' ? index : -1))
        .filter((index) => index >= 0)

      let interrupted = false
      pendingIndexes.forEach((originalIndex, resumeOrdinal) => {
        if (interrupted) return
        const target = batch.items[originalIndex]
        if (body.failAfterIndex != null && resumeOrdinal === body.failAfterIndex) {
          interrupted = true
          return
        }
        const run = db.runs.find((candidate) => candidate.id === target.runId)
        if (!run) {
          target.status = 'failed'
          target.error = '运行记录不存在'
          return
        }
        const result = commitReview(
          db,
          run,
          {
            category: target.category,
            decision: target.decision,
            reviewer: target.reviewer,
            reason: target.reason,
          },
          { basisRuleVersion: target.basisRuleVersion, reviewer: target.reviewer },
        )
        if (result.conflict) {
          target.status = 'failed'
          target.error = '审批冲突，需人工处理'
          return
        }
        target.status = 'committed'
        target.committedAt = new Date().toISOString()
        target.baselineId = result.baseline?.id
        batch.updatedAt = new Date().toISOString()
        writeDb(db)
      })

      const pendingCount = batch.items.filter((item) => item.status === 'pending').length
      const failedCount = batch.items.filter((item) => item.status === 'failed').length
      batch.status = pendingCount > 0 ? 'partial' : failedCount > 0 ? 'partial' : 'completed'
      writeDb(db)

      if (interrupted) {
        throw new MockHttpError(500, '恢复过程中再次写入中断，批次仍可继续恢复', { batch })
      }
      return respond(config, batch)
    })
  }

  if (method === 'get' && path === '/approvals/recoverable') {
    const db = readDb()
    const partial = db.approvalBatches.find((batch) => batch.status === 'partial')
    return respond(config, partial ?? null)
  }

  if (method === 'get' && path === '/conflicts') {
    const runId = config.params?.runId as string | undefined
    const db = readDb()
    return respond(
      config,
      db.conflictDrafts.filter((conflict) => !runId || conflict.runId === runId),
    )
  }

  const conflictResolveMatch = path.match(/^\/conflicts\/([^/]+)$/)
  if (method === 'patch' && conflictResolveMatch) {
    return withLock(() => {
      const db = readDb()
      const conflict = db.conflictDrafts.find((item) => item.id === conflictResolveMatch[1])
      if (!conflict) throw new MockHttpError(404, '冲突草稿不存在')
      conflict.resolved = true
      writeDb(db)
      return respond(config, conflict)
    })
  }

  if (method === 'post' && path === '/runs/merge') {
    return withLock(() => {
      const ids = parseBody<string[]>(config)
      const db = readDb()
      const selected = db.runs.filter((run) => ids.includes(run.id))
      if (selected.length < 2) throw new MockHttpError(400, '至少选择两条运行记录进行合并')
      const [first, ...rest] = selected
      first.mergedRunIds = selected.map((run) => run.id)
      first.status = 'merged'
      first.mismatchRate =
        selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
      first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
      const snapshot = latestSnapshot(db.ruleSnapshots)
      first.evaluation = evaluateRun(first, snapshot, {
        state: 'stale-recalculated',
        basis: 'live',
      })
      writeDb(db)
      return respond(config, first, 201)
    })
  }

  if (method === 'post' && path === '/runs/import') {
    return withLock(() => {
      const payload = parseBody<ImportRunPayload>(config)
      const db = readDb()
      if (
        !payload.projectId ||
        !payload.page.trim() ||
        !payload.device.trim() ||
        !payload.build.trim() ||
        payload.files.length === 0
      ) {
        throw new MockHttpError(400, '项目、页面、设备、构建版本和截图文件不能为空')
      }
      const snapshot = latestSnapshot(db.ruleSnapshots)
      const imported = payload.files.map((file, index) => {
        const runId = `run-${Date.now()}-${index + 1}`
        const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
        const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
        const run: ScreenshotRun = {
          id: runId,
          name: `${payload.page} ${payload.device}回归`,
          projectId: payload.projectId,
          page: payload.page.trim(),
          device: payload.device.trim(),
          theme: payload.theme,
          build: payload.build.trim(),
          status: 'pending',
          mismatchRate,
          capturedAt: new Date().toISOString(),
          baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
          currentVersion: payload.currentVersion.trim() || payload.build.trim(),
          baselineImage: payload.baselineImage,
          currentImage: file.dataUrl,
          regions: [
            {
              id: `${runId}-r1`,
              x: 12 + index * 3,
              y: 22 + index * 2,
              width: 24,
              height: 14,
              severity,
              pixels: Math.round(file.size / 8 || 620),
              kind: 'layout',
              ignored: false,
            },
            {
              id: `${runId}-r2`,
              x: 58,
              y: 52,
              width: 16,
              height: 10,
              severity: severity === 'high' ? 'medium' : 'low',
              pixels: Math.round(file.size / 18 || 180),
              kind: 'color',
              ignored: false,
            },
          ],
        }
        run.evaluation = evaluateRun(run, snapshot, { state: 'current', basis: 'live' })
        return run
      })
      db.runs.unshift(...imported)
      writeDb(db)
      return respond(config, imported, 201)
    })
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      readDb().baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, readDb().rules)
  }

  if (method === 'get' && path === '/rule-snapshots') {
    return respond<RuleSnapshot[]>(config, readDb().ruleSnapshots)
  }

  if (method === 'post' && path === '/rules') {
    return withLock(() => {
      const db = readDb()
      const input = parseBody<RuleInput>(config)
      const now = new Date().toISOString()
      const rule: IgnoreRule = {
        ...input,
        id: genId('rule'),
        createdAt: now,
        updatedAt: now,
      }
      db.rules.unshift(rule)
      const snapshot = appendSnapshot(db, `新增规则「${rule.name}」`)
      invalidatePendingRuns(db, snapshot, `新增规则「${rule.name}」`)
      writeDb(db)
      return respond(config, rule, 201)
    })
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    return withLock(() => {
      const db = readDb()
      const payload = parseBody<Partial<IgnoreRule>>(config)
      const rule = db.rules.find((item) => item.id === ruleMatch[1])
      if (!rule) throw new MockHttpError(404, '规则不存在')

      const semanticChanged = isRuleSemanticChange(rule, payload)
      Object.assign(rule, payload, { updatedAt: new Date().toISOString() })

      let newSnapshot: RuleSnapshot | undefined
      if (semanticChanged) {
        const reason = `规则「${rule.name}」作用域或色差调整`
        newSnapshot = appendSnapshot(db, reason)
        invalidatePendingRuns(db, newSnapshot, reason)
      }
      writeDb(db)
      return respond(config, { rule, newSnapshot })
    })
  }

  if (method === 'delete' && ruleMatch) {
    return withLock(() => {
      const db = readDb()
      const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
      if (index < 0) throw new MockHttpError(404, '规则不存在')
      const [removed] = db.rules.splice(index, 1)
      const snapshot = appendSnapshot(db, `删除规则「${removed.name}」`)
      invalidatePendingRuns(db, snapshot, `删除规则「${removed.name}」`)
      writeDb(db)
      return respond(config, { success: true })
    })
  }

  throw new MockHttpError(404, `Mock API 未实现：${method.toUpperCase()} ${path}`)
}

api.defaults.adapter = mockAdapter

// ---------------- API 导出 ----------------

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const openReviewSession = async (runId: string, reviewer: string): Promise<ReviewSession> =>
  (await api.post<ReviewSession>(`/runs/${runId}/review-session`, { reviewer })).data
export const reviewRun = async (id: string, payload: ReviewPayload): Promise<ScreenshotRun> =>
  (await api.patch<ScreenshotRun>(`/runs/${id}/review`, payload)).data
export const recheckRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>(`/runs/${id}/recheck`)).data
export const verifyRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>(`/runs/${id}/verify`)).data
export interface BatchReviewResponse {
  batch: ApprovalBatch
  conflicts: ConflictDraft[]
}
export const batchReview = async (payload: {
  idempotencyKey?: string
  items: import('@/types').BatchReviewItem[]
  failAfterIndex?: number
}): Promise<BatchReviewResponse> => (await api.post<BatchReviewResponse>('/runs/batch-review', payload)).data
export const resumeBatch = async (
  id: string,
  failAfterIndex?: number,
): Promise<ApprovalBatch> =>
  (await api.post<ApprovalBatch>(`/approvals/batches/${id}/resume`, { failAfterIndex })).data
export const getRecoverableBatch = async (): Promise<ApprovalBatch | null> =>
  (await api.get<ApprovalBatch | null>('/approvals/recoverable')).data
export const getConflictDrafts = async (runId?: string): Promise<ConflictDraft[]> =>
  (await api.get<ConflictDraft[]>('/conflicts', { params: { runId } })).data
export const resolveConflict = async (id: string): Promise<ConflictDraft> =>
  (await api.patch<ConflictDraft>(`/conflicts/${id}`, {})).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const getRuleSnapshots = async (): Promise<RuleSnapshot[]> =>
  (await api.get<RuleSnapshot[]>('/rule-snapshots')).data
export const createRule = async (payload: RuleInput): Promise<IgnoreRule> =>
  (await api.post<IgnoreRule>('/rules', payload)).data
export const updateRule = async (
  id: string,
  payload: Partial<IgnoreRule>,
): Promise<{ rule: IgnoreRule; newSnapshot?: RuleSnapshot }> =>
  (await api.patch<{ rule: IgnoreRule; newSnapshot?: RuleSnapshot }>(`/rules/${id}`, payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await updateRule(id, { enabled })).rule
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data

export { buildChainView }
