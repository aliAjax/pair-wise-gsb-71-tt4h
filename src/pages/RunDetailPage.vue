<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import {
  adoptRules,
  getApiError,
  getRun,
  resolveConflict,
  reviewRun,
} from '@/api/http'
import { useDecisionChain, versionLabel } from '@/composables/useDecisionChain'
import { useReviewStore } from '@/stores/review'
import type { DifferenceRegion, ReviewCategory } from '@/types'

interface ReviewForm {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const reviewStore = useReviewStore()
const runId = computed(() => String(route.params.id))
const localRegions = ref<DifferenceRegion[]>([])
/** 打开审批页时记下的规则版本（并发提交的乐观版本） */
const pinnedRuleVersion = ref<number | null>(null)

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

const { data: run, isLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
  refetchInterval: (query) => (query.state.data?.status === 'stale' ? 1500 : false),
})

const { judge, currentRuleVersion } = useDecisionChain()
const judgement = computed(() => (run.value ? judge(run.value) : null))

watch(
  run,
  (value) => {
    if (value) {
      // 本地手动忽略仅为视图态；正式判定始终走规则版本快照
      localRegions.value = (judge(value).regions ?? value.regions).map((region) => ({ ...region }))
      if (pinnedRuleVersion.value === null) {
        pinnedRuleVersion.value = value.ruleVersion ?? currentRuleVersion.value
      }
    }
    reviewStore.setDifferenceFilter('all')
  },
  { immediate: true },
)

const visibleRegions = computed(() =>
  localRegions.value.filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const suspiciousPixels = computed(() =>
  localRegions.value
    .filter((region) => !region.ignored)
    .reduce((total, region) => total + region.pixels, 0),
)

const unresolvedConflicts = computed(() => (run.value?.conflicts ?? []).filter((item) => !item.resolved))

const invalidateAll = async () => {
  await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['rule-snapshots'] })
  await queryClient.invalidateQueries({ queryKey: ['approval-batch-latest'] })
}

const reviewMutation = useMutation({
  mutationFn: () =>
    reviewRun(runId.value, { ...form, ruleVersion: pinnedRuleVersion.value }),
  onSuccess: async (result) => {
    if (result.idempotent) {
      Message.info('该结论已提交过，本次为重复提交，不会重复生成基线')
      await invalidateAll()
      return
    }
    Message.success(form.decision === 'approved' ? '审批通过，新基线已按规则版本留痕' : '已驳回归并保留原基线')
    await invalidateAll()
    await router.push('/approvals')
  },
  onError: async (error: unknown) => {
    const payload = getApiError(error)
    if (payload.code === 'rule-changed') {
      Message.warning(payload.message)
    } else if (payload.code === 'review-conflict') {
      Message.warning(payload.message)
    } else if (payload.code === 'run-stale') {
      Message.info(payload.message)
    } else {
      Message.error(payload.message)
    }
    await invalidateAll()
  },
})

const adoptMutation = useMutation({
  mutationFn: (ruleVersion?: number) => adoptRules(runId.value, ruleVersion),
  onSuccess: async (updated) => {
    pinnedRuleVersion.value = updated.ruleVersion ?? currentRuleVersion.value
    Message.success('已按所选规则版本回填，运行进入待审批')
    await invalidateAll()
  },
  onError: (error: unknown) => Message.error(getApiError(error).message),
})

const resolveMutation = useMutation({
  mutationFn: (conflictId: string) => resolveConflict(runId.value, conflictId),
  onSuccess: async () => {
    Message.success('冲突草稿已标记为已核对，先生效的审批结论保持不变')
    await invalidateAll()
  },
})

const toggleIgnored = (target: DifferenceRegion) => {
  const region = localRegions.value.find((item) => item.id === target.id)
  if (region) {
    region.ignored = !region.ignored
    region.ignoredBy = region.ignored ? 'manual' : undefined
  }
}

const handleDifferenceFilter = (value: string | number | boolean) => {
  const allowed = ['all', 'high', 'medium', 'low']
  if (allowed.includes(String(value))) {
    reviewStore.setDifferenceFilter(String(value) as 'all' | 'high' | 'medium' | 'low')
  }
}

const submitReview = () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (run.value?.status === 'stale') {
    Message.warning('运行正在按新规则重算，请等待重算完成后再提交')
    return
  }
  if (run.value?.status === 'needs-check') {
    Message.warning('旧运行缺少规则记录，请先在下方核对并回填规则版本')
    return
  }
  reviewMutation.mutate()
}

const adoptCurrentRules = () => adoptMutation.mutate(currentRuleVersion.value)
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="run && judgement">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <StatusTag :status="run.status" />
            <a-tag :color="judgement.needsCheck ? 'gold' : 'arcoblue'">
              判定依据 {{ versionLabel(judgement.ruleVersion, run.ruleVersionSource) }}
            </a-tag>
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            type="primary"
            :disabled="run.status !== 'pending'"
            :loading="reviewMutation.isPending.value"
            @click="submitReview"
          >
            <icon-check /> 提交审批
          </a-button>
        </a-space>
      </section>

      <a-alert
        v-if="run.status === 'stale'"
        type="warning"
        style="margin-bottom: 12px"
        banner
      >
        规则的作用域或色差已修改，本运行已失效并按规则
        <b>v{{ run.invalidatedByVersion }}</b>
        重算中；未审批前不会生成任何基线。
      </a-alert>

      <a-alert
        v-if="run.status === 'needs-check'"
        type="error"
        style="margin-bottom: 12px"
        banner
      >
        <template #title>该旧运行缺少规则记录，无法判断当时有效规则，已进入待核对</template>
        运行采集于 {{ run.capturedAt.slice(0, 16).replace('T', ' ') }}，早于现存最早的规则版本。
        确认无误后可按当前规则 v{{ currentRuleVersion }} 人工回填。
        <template #action>
          <a-button
            size="small"
            type="primary"
            :loading="adoptMutation.isPending.value"
            @click="adoptCurrentRules"
          >
            按规则 v{{ currentRuleVersion }} 回填并判定
          </a-button>
        </template>
      </a-alert>

      <a-alert
        v-for="conflict in unresolvedConflicts"
        :key="conflict.id"
        type="warning"
        style="margin-bottom: 12px"
      >
        <template #title>并发审批冲突：{{ conflict.winner.reviewer }} 的结论已先生效，你的取值保留为冲突草稿</template>
        <div class="conflict-grid">
          <div class="conflict-party winner">
            <strong>先生效（{{ conflict.winner.reviewer }} · v{{ conflict.winner.ruleVersion ?? '?' }}）</strong>
            <span>{{ conflict.winner.decision === 'approved' ? '批准' : '驳回' }} · {{ conflict.winner.category }}</span>
            <p>{{ conflict.winner.reason }}</p>
          </div>
          <div class="conflict-party loser">
            <strong>落后草稿（{{ conflict.loser.reviewer }} · v{{ conflict.loser.ruleVersion ?? '?' }}）</strong>
            <span>{{ conflict.loser.decision === 'approved' ? '批准' : '驳回' }} · {{ conflict.loser.category }}</span>
            <p>{{ conflict.loser.reason }}</p>
          </div>
        </div>
        <template #action>
          <a-button size="small" :loading="resolveMutation.isPending.value" @click="resolveMutation.mutate(conflict.id)">
            已核对，标记处理
          </a-button>
        </template>
      </a-alert>

      <div class="run-facts">
        <div><span>差异率（{{ judgement.frozen ? '冻结证据' : `规则 v${judgement.ruleVersion ?? '?'}` }}）</span>
          <strong :class="{ danger: judgement.mismatchRate >= 5 }">{{ judgement.mismatchRate.toFixed(2) }}%</strong>
        </div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div>
          <span>差异区域（忽略 {{ judgement.ignoredCount }}/{{ judgement.regionCount }}）</span>
          <strong>{{ judgement.regionCount - judgement.ignoredCount }} 处待判定</strong>
        </div>
        <div><span>构建链路</span><strong>{{ run.baselineVersion }} → {{ run.currentVersion }}</strong></div>
      </div>

      <div class="review-workspace">
        <div class="comparison-area">
          <div class="compare-toolbar">
            <a-space>
              <span class="toolbar-label">差异筛选</span>
              <a-radio-group
                type="button"
                :model-value="reviewStore.differenceFilter"
                size="small"
                @change="handleDifferenceFilter"
              >
                <a-radio value="all">全部</a-radio>
                <a-radio value="high">高</a-radio>
                <a-radio value="medium">中</a-radio>
                <a-radio value="low">低</a-radio>
              </a-radio-group>
            </a-space>
            <a-space>
              <a-button-group size="small">
                <a-button @click="reviewStore.setZoom(reviewStore.zoom - 10)"><icon-zoom-out /></a-button>
                <a-button>{{ reviewStore.zoom }}%</a-button>
                <a-button @click="reviewStore.setZoom(reviewStore.zoom + 10)"><icon-zoom-in /></a-button>
              </a-button-group>
              <a-button size="small" @click="reviewStore.setZoom(100)"><icon-refresh /> 复位</a-button>
            </a-space>
          </div>
          <div class="canvas-grid">
            <DiffCanvas :run="run" side="baseline" :zoom="reviewStore.zoom" :regions="visibleRegions" />
            <DiffCanvas :run="run" side="current" :zoom="reviewStore.zoom" :regions="visibleRegions" />
          </div>
        </div>

        <aside class="review-panel">
          <div class="panel-title">
            <div>
              <h3>差异区域</h3>
              <span>按规则 v{{ judgement.ruleVersion ?? '待核对' }} 判定，已展示 {{ visibleRegions.length }} 处</span>
            </div>
            <a-tag color="red">{{ localRegions.filter((item) => !item.ignored).length }} 待判定</a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{ ignored: region.ignored }"
              @click="toggleIgnored(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>
                  区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px
                  <template v-if="region.ruleId"> · 命中 {{ region.ruleId }}</template>
                </small>
              </span>
              <span class="ignore-action">{{ region.ignored ? '恢复' : '忽略' }}</span>
            </button>
          </div>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>
                本页打开时锁定规则 v{{ pinnedRuleVersion ?? '?' }}
                <template v-if="run.ruleVersionSource === 'backfilled'">（旧运行已回填）</template>
              </span>
            </div>
          </div>
          <a-form :model="form" layout="vertical" @submit-success="submitReview">
            <a-form-item field="category" label="变化类型" :rules="[{ required: true, message: '请选择变化类型' }]">
              <a-select v-model="form.category">
                <a-option value="design-change">设计变更</a-option>
                <a-option value="render-error">渲染异常</a-option>
                <a-option value="environment-noise">环境噪声</a-option>
              </a-select>
            </a-form-item>
            <a-form-item field="decision" label="审批结论" :rules="[{ required: true, message: '请选择审批结论' }]">
              <a-radio-group v-model="form.decision" type="button">
                <a-radio value="approved">批准为新基线</a-radio>
                <a-radio value="rejected">驳回归</a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item field="reviewer" label="批准人" :rules="[{ required: true, message: '请填写批准人' }]">
              <a-input v-model="form.reviewer" />
            </a-form-item>
            <a-form-item
              field="reason"
              label="审批原因"
              :rules="[
                { required: true, message: '请填写审批原因' },
                { minLength: 8, message: '审批原因至少 8 个字符' },
              ]"
            >
              <a-textarea
                v-model="form.reason"
                :auto-size="{ minRows: 4, maxRows: 7 }"
                placeholder="说明业务需求、设计稿或异常依据"
              />
            </a-form-item>
            <a-alert v-if="form.decision === 'approved'" type="warning" style="margin-bottom: 16px">
              批准将按锁定的规则 v{{ pinnedRuleVersion }} 固化差异率与区域证据；规则后改不影响该基线，重复提交不会多出基线。
            </a-alert>
            <a-button
              html-type="submit"
              type="primary"
              long
              :loading="reviewMutation.isPending.value"
              :disabled="run.status !== 'pending'"
            >
              确认{{ form.decision === 'approved' ? `批准并按 v${pinnedRuleVersion ?? '?'} 创建基线` : '驳回' }}
            </a-button>
          </a-form>

          <div v-if="run.review" class="review-record">
            <h4>已生效审批（证据冻结）</h4>
            <dl>
              <dt>结论</dt><dd>{{ run.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ run.review.category }}</dd>
              <dt>人员</dt><dd>{{ run.review.reviewer }}</dd>
              <dt>规则</dt><dd>v{{ run.review.evidence.ruleVersion }}</dd>
              <dt>冻结差异率</dt><dd>{{ run.review.evidence.mismatchRate.toFixed(2) }}%</dd>
              <dt>区域口径</dt><dd>忽略 {{ run.review.evidence.ignoredCount }}/{{ run.review.evidence.regionCount }}</dd>
              <dt>时间</dt><dd>{{ run.review.reviewedAt.slice(0, 16).replace('T', ' ') }}</dd>
            </dl>
            <p>{{ run.review.reason }}</p>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
