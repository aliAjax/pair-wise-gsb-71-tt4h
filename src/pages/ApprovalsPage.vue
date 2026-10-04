<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import {
  getApiError,
  getLatestBatch,
  getRuns,
  mergeRuns,
  submitBatchReview,
} from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useDecisionChain, versionLabel } from '@/composables/useDecisionChain'
import type {
  ApprovalBatch,
  BatchReviewResult,
  ReviewCategory,
  ScreenshotRun,
} from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])
const batchModalVisible = ref(false)
const interruptedBatch = ref<ApprovalBatch | null>(null)
/** 批次幂等键：写入失败后用同一 id 恢复，只补未完成项 */
const activeBatchId = ref('')

const batchForm = reactive({
  reviewer: '林默',
  decision: 'approved' as 'approved' | 'rejected',
  category: 'design-change' as ReviewCategory,
  reason: '',
  simulateWriteFailure: false,
})

const { judge, currentRuleVersion } = useDecisionChain()

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', 'approvals-all'],
  queryFn: () => getRuns(),
  refetchInterval: (query) =>
    (query.state.data ?? []).some((run) => run.status === 'stale') ? 1500 : false,
})

const { data: latestBatch } = useQuery({
  queryKey: ['approval-batch-latest'],
  queryFn: getLatestBatch,
  initialData: null,
})

const pendingRuns = computed(() => (runs.value ?? []).filter((run) => run.status === 'pending'))
const staleRuns = computed(() => (runs.value ?? []).filter((run) => run.status === 'stale'))
const needsCheckRuns = computed(() => (runs.value ?? []).filter((run) => run.status === 'needs-check'))

const pendingSet = computed(() => new Set(pendingRuns.value.map((run) => run.id)))
const selectableKeys = computed(() =>
  selectedKeys.value.filter((id) => pendingSet.value.has(id)),
)

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: (error: unknown) => Message.error(getApiError(error).message),
})

const batchMutation = useMutation({
  mutationFn: (payload: { runIds: string[]; resumeId?: string }) => {
    const id = payload.resumeId ?? activeBatchId.value
    return submitBatchReview({
      id,
      createdBy: batchForm.reviewer,
      reviewer: batchForm.reviewer,
      decision: batchForm.decision,
      category: batchForm.category,
      reason: batchForm.reason,
      runIds: payload.runIds,
      simulateWriteFailure: batchForm.simulateWriteFailure && !payload.resumeId,
    })
  },
  onSuccess: async (result: BatchReviewResult) => {
    if (result.interrupted) {
      interruptedBatch.value = result.batch
      Message.warning('批次在写入中途中断，已保留已完成项，可一键恢复未完成项')
    } else {
      const approved = result.completed.filter((item) => item.baselineId).length
      const idempotent = result.completed.filter((item) => item.idempotent).length
      Message.success(
        `批次${result.resumed ? '恢复' : ''}完成：${result.completed.length} 项已处理` +
          (approved ? `，${approved} 条基线` : '') +
          (idempotent ? `，${idempotent} 项为重复提交（未多出基线）` : ''),
      )
      interruptedBatch.value = null
      activeBatchId.value = ''
      batchModalVisible.value = false
      selectedKeys.value = []
      batchForm.simulateWriteFailure = false
    }
    await invalidateAll()
  },
  onError: async (error: unknown) => {
    const payload = getApiError(error)
    if (payload.code === 'batch-write-failed' && payload.batchId) {
      activeBatchId.value = payload.batchId
      Message.error(payload.message)
      await invalidateAll()
      const refreshed = await getLatestBatch()
      interruptedBatch.value = refreshed?.id === payload.batchId ? refreshed : interruptedBatch.value
    } else {
      Message.error(payload.message)
    }
  },
})

const invalidateAll = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['approval-batch-latest'] }),
    queryClient.invalidateQueries({ queryKey: ['baselines'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ])

const openBatchModal = () => {
  if (selectableKeys.value.length === 0) {
    Message.warning('请先选择待审批运行（重算中、待核对、已审批运行不能进入批次）')
    return
  }
  if (selectableKeys.value.length !== selectedKeys.value.length) {
    Message.info(`已自动过滤非待审批项，仅对 ${selectableKeys.value.length} 条待审批运行建批`)
    selectedKeys.value = [...selectableKeys.value]
  }
  activeBatchId.value = `batch-${Date.now()}`
  batchModalVisible.value = true
}

const submitBatch = () => {
  if (!batchForm.reason.trim()) {
    Message.warning('请填写统一审批原因')
    return
  }
  if (batchForm.reason.trim().length < 8) {
    Message.warning('审批原因至少 8 个字符')
    return
  }
  batchMutation.mutate({ runIds: [...selectableKeys.value] })
}

const resumeBatch = (batch: ApprovalBatch) => {
  const unfinished = batch.items.filter((item) => item.status === 'pending').map((item) => item.runId)
  if (unfinished.length === 0) {
    Message.info('该批次没有未完成项')
    return
  }
  activeBatchId.value = batch.id
  Message.info(`从批次 ${batch.id} 恢复，仅补 ${unfinished.length} 个未完成项`)
  batchMutation.mutate({ runIds: unfinished, resumeId: batch.id })
}

const unignoredCount = (run: ScreenshotRun) => judge(run).regionCount - judge(run).ignoredCount

const recoverableLatest = computed(() => {
  const batch = latestBatch.value
  if (!batch || batch.status !== 'interrupted') return null
  const pending = batch.items.filter((item) => item.status === 'pending')
  return pending.length ? batch : null
})
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>审批页打开时锁定当前规则版本 v{{ currentRuleVersion }}；先写入的结论生效，冲突取值保留草稿。</p>
    </div>
    <a-space>
      <a-button :disabled="selectableKeys.length < 2" @click="mergeMutation.mutate(selectableKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
      <a-button type="primary" :disabled="selectableKeys.length === 0" @click="openBatchModal">
        <icon-check-circle /> 批量审批 {{ selectableKeys.length }} 条
      </a-button>
    </a-space>
  </section>

  <a-alert
    v-if="recoverableLatest"
    type="warning"
    style="margin-bottom: 16px"
    banner
  >
    <template #title>
      存在中断的审批批次 {{ recoverableLatest.id }}：已完成
      {{ recoverableLatest.items.filter((item) => item.status === 'done').length }} 项，
      {{ recoverableLatest.items.filter((item) => item.status === 'pending').length }} 项待恢复
    </template>
    <template #action>
      <a-button size="small" type="primary" :loading="batchMutation.isPending.value" @click="resumeBatch(recoverableLatest)">
        从最近完整批次恢复
      </a-button>
    </template>
  </a-alert>

  <div v-if="staleRuns.length || needsCheckRuns.length" class="queue-notices">
    <a-alert v-if="staleRuns.length" type="warning">
      {{ staleRuns.length }} 条运行因规则作用域/色差改动已失效，正在重算，重算完成前禁止审批。
    </a-alert>
    <a-alert v-if="needsCheckRuns.length" type="error">
      {{ needsCheckRuns.length }} 条旧运行缺少规则记录，已进入待核对，请到详情页人工回填。
    </a-alert>
  </div>

  <div class="queue-summary">
    <div><span>当前待审批</span><strong>{{ pendingRuns.length }}</strong></div>
    <div>
      <span>高风险运行</span>
      <strong class="danger">
        {{ pendingRuns.filter((run) => judge(run).mismatchRate >= 5).length }}
      </strong>
    </div>
    <div><span>规则变更重算中</span><strong>{{ staleRuns.length }}</strong></div>
    <div><span>待核对旧运行</span><strong>{{ needsCheckRuns.length }}</strong></div>
  </div>

  <a-card v-if="interruptedBatch" class="table-panel recovery-panel" :bordered="false">
    <template #title>
      中断批次恢复 {{ interruptedBatch.id }}（依据规则 v{{ interruptedBatch.ruleVersion }}）
    </template>
    <template #extra>
      <a-button size="small" type="primary" :loading="batchMutation.isPending.value" @click="resumeBatch(interruptedBatch)">
        只补 {{ interruptedBatch.items.filter((item) => item.status === 'pending').length }} 个未完成项
      </a-button>
    </template>
    <a-space direction="vertical" fill>
      <div
        v-for="item in interruptedBatch.items"
        :key="item.runId"
        class="batch-item"
        :class="item.status"
      >
        <a-tag :color="item.status === 'done' ? 'green' : item.status === 'failed' ? 'red' : 'orange'">
          {{ item.status === 'done' ? '已完成' : item.status === 'failed' ? '无法完成' : '未完成' }}
        </a-tag>
        <router-link :to="`/runs/${item.runId}`">{{ item.runId }}</router-link>
        <span class="muted">{{ item.error ?? '同一判定链结果，恢复不会重复生成基线' }}</span>
      </div>
    </a-space>
  </a-card>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="runs"
      :loading="isLoading"
      :pagination="false"
      row-key="id"
      :row-selection="{
        type: 'checkbox',
        showCheckedAll: true,
      }"
    >
      <template #columns>
        <a-table-column title="优先队列" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.id }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险（判定链）" :width="150">
          <template #cell="{ record }">
            <a-tag :color="judge(record).mismatchRate >= 5 ? 'red' : judge(record).mismatchRate >= 2 ? 'orange' : 'gray'">
              {{ judge(record).mismatchRate.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="规则依据" :width="190">
          <template #cell="{ record }">
            <a-tag :color="record.status === 'stale' ? 'purple' : 'arcoblue'">
              {{ versionLabel(judge(record).ruleVersion, record.ruleVersionSource) }}
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="140">
          <template #cell="{ record }">
            {{ unignoredCount(record) }} 处待判定 / 共 {{ judge(record).regionCount }}
          </template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="110" fixed="right">
          <template #cell="{ record }">
            <router-link v-if="record.status === 'pending'" :to="`/runs/${record.id}`">开始评审</router-link>
            <span v-else-if="record.status === 'stale'" class="muted">等待重算…</span>
            <router-link v-else :to="`/runs/${record.id}`">查看详情</router-link>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:visible="batchModalVisible"
    title="批量审批（同一判定链）"
    :ok-loading="batchMutation.isPending.value"
    ok-text="锁定版本并提交批次"
    width="560px"
    @ok="submitBatch"
  >
    <a-alert type="info" style="margin-bottom: 16px">
      批次打开时锁定规则版本 <b>v{{ currentRuleVersion }}</b>，运行 {{ selectableKeys.length }} 条；
      规则在此期间改动会使相关运行失效重算并从批次跳过，已生成基线保留当时证据。
    </a-alert>
    <a-form :model="batchForm" layout="vertical">
      <a-form-item label="审批人" required>
        <a-input v-model="batchForm.reviewer" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="结论" required>
            <a-radio-group v-model="batchForm.decision" type="button">
              <a-radio value="approved">批准为新基线</a-radio>
              <a-radio value="rejected">驳回归</a-radio>
            </a-radio-group>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="变化类型" required>
            <a-select v-model="batchForm.category">
              <a-option value="design-change">设计变更</a-option>
              <a-option value="render-error">渲染异常</a-option>
              <a-option value="environment-noise">环境噪声</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="统一审批原因（至少 8 个字符）" required>
        <a-textarea v-model="batchForm.reason" :auto-size="{ minRows: 3, maxRows: 6 }" />
      </a-form-item>
      <a-form-item label="演练写入失败（用于验证批次恢复，不会重复生成基线）">
        <a-switch v-model="batchForm.simulateWriteFailure" />
      </a-form-item>
    </a-form>
  </a-modal>
</template>
