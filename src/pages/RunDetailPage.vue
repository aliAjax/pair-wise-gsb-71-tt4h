<script setup lang="ts">
import axios from 'axios'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import StatusTag from '@/components/StatusTag.vue'
import ChainStateTag from '@/components/ChainStateTag.vue'
import {
  buildChainView,
  getConflictDrafts,
  getRuleSnapshots,
  getRun,
  openReviewSession,
  recheckRun,
  resolveConflict,
  reviewRun,
  verifyRun,
} from '@/api/http'
import { useReviewStore } from '@/stores/review'
import type {
  ChainView,
  ConflictDraft,
  DifferenceRegion,
  ReviewCategory,
  RuleSnapshot,
} from '@/types'
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

const form = reactive<ReviewForm>({
  category: 'design-change',
  decision: 'approved',
  reviewer: '林默',
  reason: '',
})

const { data: run, isLoading } = useQuery({
  queryKey: computed(() => ['run', runId.value]),
  queryFn: () => getRun(runId.value),
})

const { data: snapshots } = useQuery({
  queryKey: ['rule-snapshots'],
  queryFn: getRuleSnapshots,
})

const { data: conflicts } = useQuery({
  queryKey: computed(() => ['conflicts', runId.value]),
  queryFn: () => getConflictDrafts(runId.value),
})

const chain = computed<ChainView | undefined>(() => (run.value ? buildChainView(run.value) : undefined))
const latestVersion = computed(() => snapshots.value?.[snapshots.value.length - 1]?.version)

const activeConflicts = computed(() =>
  (conflicts.value ?? []).filter((item) => item.runId === runId.value && !item.resolved),
)

// 打开审批页时锁定的会话与规则版本
const sessionId = ref<string | null>(null)
const basisRuleVersion = ref<number | null>(null)

const ensureSession = async () => {
  if (!run.value || run.value.review || run.value.status === 'unverifiable') return
  const session = await openReviewSession(run.value.id, form.reviewer)
  sessionId.value = session.id
  basisRuleVersion.value = session.basisRuleVersion
}

watch(
  run,
  (value) => {
    reviewStore.setDifferenceFilter('all')
    if (value && !value.review && value.status !== 'unverifiable') {
      ensureSession().catch((error) => Message.error(error instanceof Error ? error.message : '会话创建失败'))
    }
  },
  { immediate: true },
)

// 区域忽略状态：规则忽略 + 本页人工忽略
const manualIgnored = ref<Set<string>>(new Set())

watch(
  chain,
  (value) => {
    if (!value) return
    manualIgnored.value = new Set(
      value.evaluation.regionVerdicts
        .filter((verdict) => verdict.reason === 'manual')
        .map((verdict) => verdict.regionId),
    )
  },
  { immediate: true },
)

const verdictOf = (region: DifferenceRegion) =>
  chain.value?.evaluation.regionVerdicts.find((verdict) => verdict.regionId === region.id)

const regionIgnored = (region: DifferenceRegion): boolean => {
  const verdict = verdictOf(region)
  return Boolean(verdict?.ignored) || manualIgnored.value.has(region.id)
}

const visibleRegions = computed(() =>
  (run.value?.regions ?? []).filter(
    (region) =>
      reviewStore.differenceFilter === 'all' || region.severity === reviewStore.differenceFilter,
  ),
)

const suspiciousPixels = computed(() => {
  if (!run.value) return 0
  return run.value.regions.reduce((total, region, index) => {
    const verdict = chain.value?.evaluation.regionVerdicts[index]
    const ignored = Boolean(verdict?.ignored) || manualIgnored.value.has(region.id)
    return ignored ? total : total + region.pixels
  }, 0)
})

const reviewMutation = useMutation({
  mutationFn: () => {
    if (!run.value) throw new Error('运行不存在')
    return reviewRun(run.value.id, {
      ...form,
      sessionId: sessionId.value ?? undefined,
      manualIgnoredRegionIds: [...manualIgnored.value],
    })
  },
  onSuccess: async (updated) => {
    Message.success(updated.review?.decision === 'approved' ? '审批通过，新基线已按当时证据留痕' : '已驳回并保留原基线')
    sessionId.value = null
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['baselines'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    await queryClient.invalidateQueries({ queryKey: ['conflicts'] })
    await router.push('/approvals')
  },
  onError: (error: Error) => {
    if (axios.isAxiosError(error) && error.response?.status === 409) {
      Message.warning(error.message)
      queryClient.invalidateQueries({ queryKey: ['conflicts'] })
    } else {
      Message.error(error.message)
    }
  },
})

const recheckMutation = useMutation({
  mutationFn: () => recheckRun(runId.value),
  onSuccess: async () => {
    Message.success('已确认按最新规则重算结果，可重新提交审批')
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await ensureSession()
  },
  onError: (error: Error) => Message.error(error.message),
})

const verifyMutation = useMutation({
  mutationFn: () => verifyRun(runId.value),
  onSuccess: async () => {
    Message.success('核对完成，运行已回到待审批队列')
    await queryClient.invalidateQueries({ queryKey: ['run', runId.value] })
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    await ensureSession()
  },
  onError: (error: Error) => Message.error(error.message),
})

const resolveConflictMutation = useMutation({
  mutationFn: (conflict: ConflictDraft) => resolveConflict(conflict.id),
  onSuccess: async () => {
    Message.success('冲突草稿已标记处理，请按最新结论刷新判定')
    await queryClient.invalidateQueries({ queryKey: ['conflicts'] })
  },
})

const toggleIgnored = (target: DifferenceRegion) => {
  const verdict = verdictOf(target)
  if (verdict?.reason === 'rule') {
    Message.info('该区域由忽略规则折叠，请到规则页调整作用域或色差')
    return
  }
  const next = new Set(manualIgnored.value)
  if (next.has(target.id)) next.delete(target.id)
  else next.add(target.id)
  manualIgnored.value = next
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
  reviewMutation.mutate()
}

const snapshotLabel = (snapshot: RuleSnapshot | undefined) =>
  snapshot ? `rv${snapshot.version} · ${snapshot.reason}` : '未知版本'

const basisSnapshot = computed(() =>
  basisRuleVersion.value
    ? snapshots.value?.find((snapshot) => snapshot.version === basisRuleVersion.value)
    : undefined,
)
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="run && chain">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ run.name }}</h2>
            <StatusTag :status="run.status" />
            <ChainStateTag :state="chain.state" :rule-version="chain.ruleVersion" />
          </a-space>
          <p>{{ run.page }} · {{ run.device }} · {{ run.theme === 'light' ? '浅色主题' : '深色主题' }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/runs')"><icon-left /> 返回列表</a-button>
          <a-button
            v-if="!run.review && run.status !== 'unverifiable'"
            type="primary"
            :loading="reviewMutation.isPending.value"
            @click="submitReview"
          >
            <icon-check /> 提交审批
          </a-button>
        </a-space>
      </section>

      <!-- 判定链横幅 -->
      <a-alert
        v-if="chain.state === 'stale-recalculated'"
        type="warning"
        style="margin-bottom: 14px"
      >
        <template #title>
          打开后忽略规则已改动：结论已按 rv{{ chain.ruleVersion }} 重算（有效差异率
          {{ chain.effectiveMismatchRate.toFixed(2) }}%），旧版本提交不会生效
        </template>
        <template #action>
          <a-button size="small" type="primary" :loading="recheckMutation.isPending.value" @click="recheckMutation.mutate()">
            确认重算结果并继续
          </a-button>
        </template>
      </a-alert>
      <a-alert
        v-else-if="chain.state === 'unverifiable'"
        type="error"
        style="margin-bottom: 14px"
      >
        <template #title>
          该运行早于任何规则存档，无法判断采集时适用的忽略规则，已进入待核对
        </template>
        <template #action>
          <a-button size="small" type="primary" :loading="verifyMutation.isPending.value" @click="verifyMutation.mutate()">
            人工核对无误，转回待审批
          </a-button>
        </template>
      </a-alert>
      <a-alert v-else-if="chain.state === 'backfilled'" type="info" style="margin-bottom: 14px">
        旧运行缺少规则记录，已按采集时有效规则 rv{{ chain.ruleVersion }} 回填判定，可核对后正常审批。
      </a-alert>
      <a-alert v-else-if="chain.state === 'frozen'" type="info" style="margin-bottom: 14px">
        审批证据按 rv{{ chain.ruleVersion }} 冻结，基线保留当时的区域与差异率；之后规则改动不影响本结论。
      </a-alert>

      <!-- 冲突草稿：双方取值并存 -->
      <a-card
        v-for="conflict in activeConflicts"
        :key="conflict.id"
        class="conflict-card"
        :bordered="false"
      >
        <div class="conflict-head">
          <a-tag color="red">提交冲突 · {{ conflict.kind === 'rule-changed' ? '规则版本已变更' : '他人已先提交' }}</a-tag>
          <a-button size="mini" type="text" @click="resolveConflictMutation.mutate(conflict)">标记已处理</a-button>
        </div>
        <div class="conflict-grid">
          <div class="conflict-side winner">
            <strong>先生效取值（{{ conflict.winner.reviewer }}）</strong>
            <span>{{ conflict.winner.decision === 'approved' ? '批准' : '驳回' }} · {{ conflict.winner.category }} · rv{{ conflict.winner.ruleVersion }}</span>
            <p>{{ conflict.winner.reason }}</p>
          </div>
          <div class="conflict-side loser">
            <strong>本页落后取值（{{ conflict.loser.reviewer }}）</strong>
            <span>{{ conflict.loser.decision === 'approved' ? '批准' : '驳回' }} · {{ conflict.loser.category }} · 依据 rv{{ conflict.loser.basisRuleVersion }}</span>
            <p>{{ conflict.loser.reason }}</p>
          </div>
        </div>
      </a-card>

      <div class="run-facts">
        <div>
          <span>判定差异率</span>
          <strong :class="{ danger: chain.effectiveMismatchRate >= 5 }">{{ chain.effectiveMismatchRate.toFixed(2) }}%</strong>
          <small>原始 {{ chain.rawMismatchRate.toFixed(2) }}%</small>
        </div>
        <div><span>待判定像素</span><strong>{{ suspiciousPixels.toLocaleString() }}</strong></div>
        <div>
          <span>规则版本</span>
          <strong>rv{{ chain.ruleVersion }}</strong>
          <small v-if="latestVersion && latestVersion !== chain.ruleVersion && chain.state !== 'frozen'">
            最新 rv{{ latestVersion }}
          </small>
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
              <span>按 rv{{ chain.ruleVersion }} 判定 {{ visibleRegions.length }} 处</span>
            </div>
            <a-tag color="red">
              {{ run.regions.filter((region) => !regionIgnored(region)).length }} 待判定
            </a-tag>
          </div>
          <div class="region-list">
            <button
              v-for="region in visibleRegions"
              :key="region.id"
              class="region-item"
              :class="{ ignored: regionIgnored(region) }"
              @click="toggleIgnored(region)"
            >
              <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
              <span class="region-copy">
                <strong>{{ region.kind === 'layout' ? '布局位移' : region.kind === 'color' ? '色彩变化' : region.kind === 'content' ? '内容变更' : '环境噪声' }}</strong>
                <small>区域 {{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px</small>
                <small v-if="verdictOf(region)?.reason === 'rule'" class="rule-hint">
                  规则折叠：{{ verdictOf(region)?.ruleName }}（rv{{ verdictOf(region)?.ruleVersion }}）
                </small>
                <small v-else-if="manualIgnored.has(region.id)" class="rule-hint">本页人工忽略，随审批留痕</small>
                <small v-if="typeof region.colorDelta === 'number'" class="rule-hint">实测色差 Δ{{ region.colorDelta }}</small>
              </span>
              <span class="ignore-action">
                {{ verdictOf(region)?.reason === 'rule' ? '规则忽略' : manualIgnored.has(region.id) ? '恢复' : '忽略' }}
              </span>
            </button>
          </div>

          <a-divider />

          <div class="panel-title">
            <div>
              <h3>评审结论</h3>
              <span>
                打开时锁定：{{ basisSnapshot ? snapshotLabel(basisSnapshot) : '尚未建立会话' }}
              </span>
            </div>
          </div>
          <a-form v-if="!run.review && run.status !== 'unverifiable'" :model="form" layout="vertical" @submit-success="submitReview">
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
              <a-input v-model="form.reviewer" @change="ensureSession" />
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
              批准只新增基线版本，证据按 rv{{ chain.ruleVersion }} 冻结，原基线仍可追溯。
            </a-alert>
            <a-button html-type="submit" type="primary" long :loading="reviewMutation.isPending.value">
              确认{{ form.decision === 'approved' ? '批准并创建基线' : '驳回' }}
            </a-button>
          </a-form>

          <div v-if="run.review" class="review-record">
            <h4>冻结的审批证据</h4>
            <dl>
              <dt>结论</dt><dd>{{ run.review.decision === 'approved' ? '已批准' : '已驳回' }}</dd>
              <dt>类型</dt><dd>{{ run.review.category }}</dd>
              <dt>人员</dt><dd>{{ run.review.reviewer }}</dd>
              <dt>规则版本</dt><dd>rv{{ run.review.ruleVersion }}</dd>
              <dt>时间</dt><dd>{{ run.review.reviewedAt.slice(0, 16).replace('T', ' ') }}</dd>
              <dt v-if="run.review.evidenceIncomplete">证据</dt><dd v-if="run.review.evidenceIncomplete">规则记录缺失，证据不完整</dd>
            </dl>
            <p>{{ run.review.reason }}</p>
            <small class="muted">{{ chain.basisLabel }}</small>
          </div>
        </aside>
      </div>
    </template>
  </a-spin>
</template>
