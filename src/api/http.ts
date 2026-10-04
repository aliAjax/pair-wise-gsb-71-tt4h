import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import {
  invalidateForRuleChange,
  readDb,
  resumeRecomputeJobs,
  schedulePendingRecompute,
  writeDb,
  type Database,
} from '@/mocks/db'
import {
  applyRules,
  computeMismatchRate,
  evidenceFor,
  latestSnapshot,
} from '@/utils/decisionChain'
import type {
  ApprovalBatch,
  Baseline,
  BatchReviewPayload,
  BatchReviewResult,
  ConflictDraft,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  Project,
  ReviewPayload,
  ReviewRecord,
  ReviewSubmitResult,
  RuleMutationResult,
  RuleSnapshot,
  RunFilters,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

export interface ApiErrorPayload {
  code: string
  message: string
  conflict?: ConflictDraft
  batchId?: string
  expectedRuleVersion?: number
  [key: string]: unknown
}

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Error',
  headers: {},
  config,
})

const fail = (status: number, payload: ApiErrorPayload): Promise<never> => {
  const error = new Error(payload.message) as Error & {
    response: { status: number; data: ApiErrorPayload }
  }
  error.response = { status, data: payload }
  return Promise.reject(error)
}

export const getApiError = (error: unknown): ApiErrorPayload => {
  const candidate = error as { response?: { data?: ApiErrorPayload }; message?: string }
  if (candidate.response?.data) return candidate.response.data
  return { code: 'unknown', message: candidate.message ?? '请求失败，请重试' }
}

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

const pushSnapshot = (db: Database, reason: string): RuleSnapshot => {
  const nextVersion = (latestSnapshot(db.ruleSnapshots)?.version ?? 0) + 1
  const snapshot: RuleSnapshot = {
    version: nextVersion,
    createdAt: new Date().toISOString(),
    reason,
    rules: db.rules.map((rule) => ({ ...rule })),
  }
  db.ruleSnapshots.unshift(snapshot)
  return snapshot
}

/** 规则变更后，只让判定结果实际发生变化的未审批运行立即失效重算 */
const affectedRunIds = (db: Database, previousRules: IgnoreRule[]): string[] =>
  db.runs
    .filter((run) => run.status === 'pending' || run.status === 'stale')
    .filter((run) => {
      const before = applyRules(run.regions, run, previousRules)
      const after = applyRules(run.regions, run, db.rules)
      return computeMismatchRate(before) !== computeMismatchRate(after)
    })
    .map((run) => run.id)

/** 规则变更统一落盘：先持久化新版本与失效状态，再启动重算 */
const persistRuleChange = (db: Database) => {
  writeDb(db)
  schedulePendingRecompute(db)
}

const partyFromReview = (review: ReviewRecord) => ({
  reviewer: review.reviewer,
  decision: review.decision,
  category: review.category,
  reason: review.reason,
  at: review.reviewedAt,
  ruleVersion: review.ruleVersion,
})

interface CommitInput {
  runId: string
  reviewer: string
  decision: 'approved' | 'rejected'
  category: ReviewPayload['category']
  reason: string
  ruleVersion: number | null
  batchId?: string
}

interface CommitOutcome {
  run: ScreenshotRun
  idempotent: boolean
  conflict: ConflictDraft | null
  baselineId?: string
  /** 无法提交时的结构化错误 */
  rejection?: ApiErrorPayload
}

const commitReview = (db: Database, input: CommitInput): CommitOutcome => {
  const run = db.runs.find((item) => item.id === input.runId)
  if (!run) {
    return {
      run: undefined as unknown as ScreenshotRun,
      idempotent: false,
      conflict: null,
      rejection: { code: 'run-not-found', message: '运行记录不存在' },
    }
  }

  if (run.status === 'approved' || run.status === 'rejected') {
    const existing = run.review!
    const sameConclusion =
      existing.reviewer === input.reviewer &&
      existing.decision === input.decision &&
      existing.category === input.category &&
      existing.reason === input.reason
    if (sameConclusion) {
      const baseline = db.baselines.find((item) => item.runId === run.id)
      return { run, idempotent: true, conflict: null, baselineId: baseline?.id }
    }
    // 两人同时提交同一运行：先生效结论保留，落后页面的取值存为冲突草稿
    const draft: ConflictDraft = {
      id: `conflict-${Date.now()}-${run.id}`,
      createdAt: new Date().toISOString(),
      winner: partyFromReview(existing),
      loser: {
        reviewer: input.reviewer,
        decision: input.decision,
        category: input.category,
        reason: input.reason,
        at: new Date().toISOString(),
        ruleVersion: input.ruleVersion,
      },
      resolved: false,
    }
    run.conflicts = [...(run.conflicts ?? []), draft]
    return {
      run,
      idempotent: false,
      conflict: draft,
      rejection: {
        code: 'review-conflict',
        message: `该运行已由 ${existing.reviewer} 先生效审批结论，你的取值已保留为冲突草稿`,
        conflict: draft,
      },
    }
  }

  if (run.status === 'stale') {
    return {
      run,
      idempotent: false,
      conflict: null,
      rejection: {
        code: 'run-stale',
        message: '规则作用域或色差已修改，该运行已失效并按最新规则重算，请等待重算完成',
        expectedRuleVersion: run.invalidatedByVersion,
      },
    }
  }
  if (run.status === 'needs-check' || run.ruleVersion === null || run.ruleVersion === undefined) {
    return {
      run,
      idempotent: false,
      conflict: null,
      rejection: {
        code: 'needs-check',
        message: '该旧运行缺少规则记录，无法判断当时有效规则，请先在详情页核对并回填',
      },
    }
  }
  if (run.status === 'merged') {
    return {
      run,
      idempotent: false,
      conflict: null,
      rejection: { code: 'run-merged', message: '该运行已被合并，请到合并后的运行提交审批' },
    }
  }
  if (input.ruleVersion !== null && input.ruleVersion !== undefined && input.ruleVersion !== run.ruleVersion) {
    return {
      run,
      idempotent: false,
      conflict: null,
      rejection: {
        code: 'rule-changed',
        message: `审批页依据的是规则 v${input.ruleVersion}，运行已按规则 v${run.ruleVersion} 重算，请刷新核对后再提交`,
        expectedRuleVersion: run.ruleVersion,
      },
    }
  }

  const version = run.ruleVersion
  const evidence = evidenceFor(run, version, db.ruleSnapshots, input.batchId)
  const reviewedAt = new Date().toISOString()
  const review: ReviewRecord = {
    category: input.category,
    decision: input.decision,
    reviewer: input.reviewer,
    reason: input.reason,
    reviewedAt,
    ruleVersion: version,
    evidence,
  }
  run.status = input.decision
  run.review = review

  let baselineId: string | undefined
  if (input.decision === 'approved') {
    // 重复提交不会多出基线：同一运行只允许生成一条基线
    const existingBaseline = db.baselines.find((item) => item.runId === run.id)
    if (existingBaseline) {
      existingBaseline.active = true
      baselineId = existingBaseline.id
    } else {
      db.baselines
        .filter(
          (item) =>
            item.projectId === run.projectId &&
            item.page === run.page &&
            item.device === run.device &&
            item.theme === run.theme &&
            item.active,
        )
        .forEach((item) => {
          item.active = false
        })
      const baseline: Baseline = {
        id: `base-${Date.now()}`,
        projectId: run.projectId,
        page: run.page,
        device: run.device,
        theme: run.theme,
        version: run.currentVersion,
        approvedBy: input.reviewer,
        reason: input.reason,
        approvedAt: reviewedAt,
        runId: run.id,
        active: true,
        ruleVersion: version,
        evidence: { ...evidence },
      }
      db.baselines.unshift(baseline)
      baselineId = baseline.id
    }
  }
  return { run, idempotent: false, conflict: null, baselineId }
}

const mockAdapter: AxiosAdapter = async (config) => {
  resumeRecomputeJobs()
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const dashboard: DashboardData = {
      pendingReview: db.runs.filter((run) => run.status === 'pending').length,
      approvedToday: db.runs.filter(
        (run) => run.review?.decision === 'approved' && run.review.reviewedAt.startsWith('2026-09-29'),
      ).length,
      highRisk: db.runs.filter((run) => run.mismatchRate >= 5 && run.status !== 'merged').length,
      activeBaselines: db.baselines.filter((baseline) => baseline.active).length,
      staleReview: db.runs.filter((run) => run.status === 'stale').length,
      needsCheck: db.runs.filter((run) => run.status === 'needs-check').length,
      ruleVersion: latestSnapshot(db.ruleSnapshots)?.version ?? 1,
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
    const run = db.runs.find((item) => item.id === runMatch[1])
    if (!run) return fail(404, { code: 'run-not-found', message: '运行记录不存在' })
    return respond(config, run)
  }

  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const submittedVersion =
      payload.ruleVersion === undefined
        ? latestSnapshot(db.ruleSnapshots)?.version ?? null
        : payload.ruleVersion
    const outcome = commitReview(db, {
      runId: reviewMatch[1],
      reviewer: payload.reviewer,
      decision: payload.decision,
      category: payload.category,
      reason: payload.reason,
      ruleVersion: submittedVersion,
    })
    if (outcome.rejection) {
      writeDb(db)
      return fail(outcome.rejection.code === 'run-not-found' ? 404 : 409, outcome.rejection)
    }
    writeDb(db)
    const result: ReviewSubmitResult = {
      run: outcome.run,
      idempotent: outcome.idempotent,
      conflict: outcome.conflict,
    }
    return respond(config, result)
  }

  const adoptMatch = path.match(/^\/runs\/([^/]+)\/adopt-rules$/)
  if (method === 'post' && adoptMatch) {
    const body = parseBody<{ ruleVersion?: number }>(config)
    const run = db.runs.find((item) => item.id === adoptMatch[1])
    if (!run) return fail(404, { code: 'run-not-found', message: '运行记录不存在' })
    if (run.status !== 'needs-check') {
      return fail(409, { code: 'not-needs-check', message: '只有待核对运行需要回填规则版本' })
    }
    const snapshot =
      db.ruleSnapshots.find((item) => item.version === body.ruleVersion) ??
      latestSnapshot(db.ruleSnapshots)!
    run.regions = applyRules(run.regions, run, snapshot.rules)
    run.mismatchRate = computeMismatchRate(run.regions)
    run.ruleVersion = snapshot.version
    run.ruleVersionSource = 'checked'
    run.status = 'pending'
    writeDb(db)
    return respond(config, run)
  }

  const conflictMatch = path.match(/^\/runs\/([^/]+)\/conflicts\/([^/]+)\/resolve$/)
  if (method === 'post' && conflictMatch) {
    const run = db.runs.find((item) => item.id === conflictMatch[1])
    const draft = run?.conflicts?.find((item) => item.id === conflictMatch[2])
    if (!run || !draft) return fail(404, { code: 'conflict-not-found', message: '冲突草稿不存在' })
    draft.resolved = true
    writeDb(db)
    return respond(config, run)
  }

  if (method === 'get' && path === '/reviews/batch/latest') {
    const latest = [...db.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    return respond<ApprovalBatch | null>(config, latest)
  }

  if (method === 'post' && path === '/reviews/batch') {
    const payload = parseBody<BatchReviewPayload>(config)
    const existing = db.batches.find((item) => item.id === payload.id)
    const resumed = Boolean(existing)
    const nowIso = new Date().toISOString()
    const batch: ApprovalBatch =
      existing ??
      ({
        id: payload.id,
        createdAt: nowIso,
        createdBy: payload.createdBy || payload.reviewer,
        // 批次打开时的全局规则版本（用于审计）；各运行证据按其锁定版本固化
        ruleVersion: latestSnapshot(db.ruleSnapshots)?.version ?? 1,
        status: 'running',
        items: payload.runIds.map((runId) => {
          const target = db.runs.find((candidate) => candidate.id === runId)
          const base = {
            runId,
            reviewer: payload.reviewer,
            decision: payload.decision,
            category: payload.category,
            reason: payload.reason,
            status: 'pending' as const,
          }
          if (!target) {
            return {
              ...base,
              ruleVersion: 0,
              status: 'failed' as const,
              errorCode: 'run-not-found',
              error: '运行记录不存在',
            }
          }
          if (target.ruleVersion === null || target.ruleVersion === undefined) {
            return {
              ...base,
              ruleVersion: 0,
              status: 'failed' as const,
              errorCode: 'needs-check',
              error: '该旧运行缺少规则记录，请先人工回填',
            }
          }
          // 建批瞬间锁定该运行依据的规则版本
          return { ...base, ruleVersion: target.ruleVersion }
        }),
        baselineIds: [],
      } satisfies ApprovalBatch)
    if (!existing) db.batches.unshift(batch)

    const pendingItems = batch.items.filter((item) => item.status === 'pending')
    const doneBeforeCall = new Set(
      batch.items.filter((item) => item.status === 'done').map((item) => item.runId),
    )
    const completed: BatchReviewResult['completed'] = batch.items
      .filter((item) => item.status === 'done')
      .map((item) => ({
        runId: item.runId,
        baselineId: item.baselineId,
        // 本次调用前就已完成的项属于重复提交，按幂等回报
        idempotent: item.idempotent || doneBeforeCall.has(item.runId),
      }))
    const failed: BatchReviewResult['failed'] = batch.items
      .filter((item) => item.status === 'failed')
      .map((item) => ({ runId: item.runId, code: item.errorCode ?? 'unknown', message: item.error ?? '' }))
    const skipped: BatchReviewResult['skipped'] = []

    for (const [index, item] of pendingItems.entries()) {
      // 提交前快照，写入失败时回滚未落盘的内存改动
      const rollbackState = JSON.parse(JSON.stringify({
        run: db.runs.find((candidate) => candidate.id === item.runId),
        baselines: db.baselines,
      })) as { run?: ScreenshotRun; baselines: Baseline[] }
      const outcome = commitReview(db, {
        runId: item.runId,
        reviewer: item.reviewer,
        decision: item.decision,
        category: item.category,
        reason: item.reason,
        ruleVersion: item.ruleVersion,
        batchId: batch.id,
      })
      const shouldSimulateFailure =
        payload.simulateWriteFailure && index === 0 && batch.items.length > 1
      if (outcome.rejection) {
        const recoverable = ['run-stale', 'needs-check', 'rule-changed'].includes(
          outcome.rejection.code,
        )
        if (recoverable) {
          // 可恢复：保留为未完成项，恢复批次时只补这些
          skipped.push({ runId: item.runId, reason: outcome.rejection.message })
        } else {
          item.status = 'failed'
          item.errorCode = outcome.rejection.code
          item.error = outcome.rejection.message
          failed.push({
            runId: item.runId,
            code: outcome.rejection.code,
            message: outcome.rejection.message,
          })
        }
        writeDb(db)
        continue
      }
      try {
        writeDb(db, shouldSimulateFailure)
      } catch {
        // 写入中途失败：回滚本次未落盘的审批与基线，保留批次和已完成项
        const runIndex = db.runs.findIndex((candidate) => candidate.id === item.runId)
        if (rollbackState.run && runIndex >= 0) db.runs[runIndex] = rollbackState.run
        db.baselines = rollbackState.baselines
        item.status = 'pending'
        batch.status = 'interrupted'
        batch.interruptedAt = new Date().toISOString()
        writeDb(db)
        return fail(503, {
          code: 'batch-write-failed',
          message: '审批批次写入中途失败，已保留最近完整批次，可一键恢复未完成项',
          batchId: batch.id,
        })
      }
      item.status = 'done'
      item.finishedAt = new Date().toISOString()
      item.baselineId = outcome.baselineId
      item.idempotent = outcome.idempotent
      if (outcome.baselineId && !batch.baselineIds.includes(outcome.baselineId)) {
        batch.baselineIds.push(outcome.baselineId)
      }
      completed.push({
        runId: item.runId,
        baselineId: outcome.baselineId,
        idempotent: outcome.idempotent,
      })
    }

    const stillPending = batch.items.filter((item) => item.status === 'pending')
    if (stillPending.length === 0) {
      batch.status = 'complete'
      batch.completedAt = batch.completedAt ?? new Date().toISOString()
    } else {
      batch.status = 'interrupted'
      batch.interruptedAt = batch.interruptedAt ?? new Date().toISOString()
    }
    writeDb(db)
    const result: BatchReviewResult = {
      batch,
      resumed,
      interrupted: batch.status === 'interrupted',
      completed,
      failed,
      skipped,
    }
    return respond(config, result, resumed ? 200 : 201)
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const selected = db.runs.filter((run) => ids.includes(run.id))
    if (selected.length < 2) throw new Error('至少选择两条运行记录进行合并')
    const [first, ...rest] = selected
    first.mergedRunIds = selected.map((run) => run.id)
    first.status = 'merged'
    first.mismatchRate =
      selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
    first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
    writeDb(db)
    return respond(config, first, 201)
  }

  if (method === 'post' && path === '/runs/import') {
    const payload = parseBody<ImportRunPayload>(config)
    if (
      !payload.projectId ||
      !payload.page.trim() ||
      !payload.device.trim() ||
      !payload.build.trim() ||
      payload.files.length === 0
    ) {
      throw new Error('项目、页面、设备、构建版本和截图文件不能为空')
    }
    const snapshot = latestSnapshot(db.ruleSnapshots)
    const imported = payload.files.map((file, index) => {
      const runId = `run-${Date.now()}-${index + 1}`
      const bare: ScreenshotRun = {
        id: runId,
        name: `${payload.page} ${payload.device}回归`,
        projectId: payload.projectId,
        page: payload.page.trim(),
        device: payload.device.trim(),
        theme: payload.theme,
        build: payload.build.trim(),
        status: 'pending',
        mismatchRate: 0,
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
            severity:
              Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2)) >= 5
                ? 'high'
                : 'medium',
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
            severity: 'low',
            pixels: Math.round(file.size / 18 || 180),
            kind: 'color',
            ignored: false,
          },
        ],
      }
      const evaluated = snapshot ? applyRules(bare.regions, bare, snapshot.rules) : bare.regions
      return {
        ...bare,
        regions: evaluated,
        mismatchRate: computeMismatchRate(evaluated),
        ruleVersion: snapshot?.version ?? null,
        ruleVersionSource: 'capture' as const,
      }
    })
    db.runs.unshift(...imported)
    writeDb(db)
    return respond(config, imported, 201)
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      db.baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, db.rules)
  }

  if (method === 'get' && path === '/rule-snapshots') {
    const snapshots = [...db.ruleSnapshots].sort((a, b) => b.version - a.version)
    return respond(config, snapshots)
  }

  if (method === 'post' && path === '/rules') {
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt'>>(config)
    const previousRules = db.rules.map((rule) => ({ ...rule }))
    const rule: IgnoreRule = {
      ...input,
      id: `rule-${Date.now()}`,
      createdAt: new Date().toISOString(),
    }
    db.rules.unshift(rule)
    const snapshot = pushSnapshot(db, `新建规则：${rule.name}`)
    const invalidatedRunIds = affectedRunIds(db, previousRules)
    if (invalidatedRunIds.length) {
      invalidateForRuleChange(db, `新建规则「${rule.name}」后重算`, invalidatedRunIds)
    }
    persistRuleChange(db)
    const result: RuleMutationResult = {
      rule,
      ruleVersion: snapshot.version,
      invalidatedRunIds,
    }
    return respond(config, result, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) return fail(404, { code: 'rule-not-found', message: '规则不存在' })
    const previousRules = db.rules.map((item) => ({ ...item }))
    Object.assign(rule, payload)
    const snapshot = pushSnapshot(db, `修改规则：${rule.name}`)
    const invalidatedRunIds = affectedRunIds(db, previousRules)
    if (invalidatedRunIds.length) {
      invalidateForRuleChange(db, `规则「${rule.name}」作用域或色差调整后重算`, invalidatedRunIds)
    }
    persistRuleChange(db)
    return respond<RuleMutationResult>(config, {
      rule,
      ruleVersion: snapshot.version,
      invalidatedRunIds,
    })
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) return fail(404, { code: 'rule-not-found', message: '规则不存在' })
    const previousRules = db.rules.map((item) => ({ ...item }))
    const [removed] = db.rules.splice(index, 1)
    const snapshot = pushSnapshot(db, `删除规则：${removed.name}`)
    const invalidatedRunIds = affectedRunIds(db, previousRules)
    if (invalidatedRunIds.length) {
      invalidateForRuleChange(db, `删除规则「${removed.name}」后重算`, invalidatedRunIds)
    }
    persistRuleChange(db)
    return respond<RuleMutationResult>(config, {
      rule: null,
      ruleVersion: snapshot.version,
      invalidatedRunIds,
    })
  }

  return fail(404, {
    code: 'mock-not-implemented',
    message: `Mock API 未实现：${method.toUpperCase()} ${path}`,
  })
}

api.defaults.adapter = mockAdapter

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const reviewRun = async (id: string, payload: ReviewPayload): Promise<ReviewSubmitResult> =>
  (await api.patch<ReviewSubmitResult>(`/runs/${id}/review`, payload)).data
export const adoptRules = async (id: string, ruleVersion?: number): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>(`/runs/${id}/adopt-rules`, { ruleVersion })).data
export const resolveConflict = async (runId: string, conflictId: string): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>(`/runs/${runId}/conflicts/${conflictId}/resolve`, {})).data
export const submitBatchReview = async (
  payload: BatchReviewPayload,
): Promise<BatchReviewResult> => (await api.post<BatchReviewResult>('/reviews/batch', payload)).data
export const getLatestBatch = async (): Promise<ApprovalBatch | null> =>
  (await api.get<ApprovalBatch | null>('/reviews/batch/latest')).data
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
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt'>,
): Promise<RuleMutationResult> => (await api.post<RuleMutationResult>('/rules', payload)).data
export const updateRule = async (
  id: string,
  payload: Partial<IgnoreRule>,
): Promise<RuleMutationResult> => (await api.patch<RuleMutationResult>(`/rules/${id}`, payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<RuleMutationResult> =>
  (await api.patch<RuleMutationResult>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<RuleMutationResult> =>
  (await api.delete<RuleMutationResult>(`/rules/${id}`)).data
