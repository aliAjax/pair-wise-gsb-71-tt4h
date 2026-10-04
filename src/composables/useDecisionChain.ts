import { computed, type Ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { getRuleSnapshots } from '@/api/http'
import { judgeRun, type RunJudgement } from '@/utils/decisionChain'
import type { RuleSnapshot, ScreenshotRun } from '@/types'

/**
 * 判定链唯一入口：所有页面通过同一批规则快照判定运行，
 * 保证列表、详情、导出数字一致。
 */
export const useDecisionChain = () => {
  const { data: snapshots } = useQuery({
    queryKey: ['rule-snapshots'],
    queryFn: getRuleSnapshots,
    staleTime: 5_000,
  })

  const snapshotList = computed<RuleSnapshot[]>(() => snapshots.value ?? [])
  const currentRuleVersion = computed(() => snapshotList.value[0]?.version ?? 1)

  const judge = (run: ScreenshotRun): RunJudgement => judgeRun(run, snapshotList.value)

  const judgeRef = (run: Ref<ScreenshotRun | undefined>) =>
    computed<RunJudgement | null>(() => (run.value ? judge(run.value) : null))

  return { snapshots: snapshotList, currentRuleVersion, judge, judgeRef }
}

export const versionLabel = (version: number | null | undefined, source?: string): string => {
  if (version === null || version === undefined) return '待核对'
  const suffix =
    source === 'recomputed'
      ? '（规则变更后重算）'
      : source === 'backfilled'
        ? '（按当时规则回填）'
        : source === 'checked'
          ? '（人工核对回填）'
          : '（采集时锁定）'
  return `v${version}${suffix}`
}
