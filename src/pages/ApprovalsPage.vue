<script setup lang="ts">
import axios from 'axios'
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import {
  batchReview,
  buildChainView,
  getConflictDrafts,
  getRecoverableBatch,
  getRuns,
  mergeRuns,
  resolveConflict,
  resumeBatch,
} from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import ChainStateTag from '@/components/ChainStateTag.vue'
import type { ApprovalBatch, ConflictDraft, ReviewCategory, ScreenshotRun } from '@/types'

const queryClient = useQueryClient()
const selectedKeys = ref<string[]>([])
const batchReason = ref('')
const batchDecision = ref<'approved' | 'rejected'>('approved')
const batchCategory = ref<ReviewCategory>('design-change')
const batchReviewer = ref('林默')
const failAfterIndex = ref<number | undefined>(undefined)
const showBatchPanel = ref(false)
const lastBatch = ref<ApprovalBatch | null>(null)

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', { status: 'pending' }],
  queryFn: () => getRuns({ status: 'pending' }),
})

const { data: allRuns } = useQuery({
  queryKey: ['runs', 'approvals-all'],
  queryFn: () => getRuns(),
})

const { data: conflicts } = useQuery({
  queryKey: ['conflicts', 'all'],
  queryFn: () => getConflictDrafts(),
  refetchInterval: 4000,
})

const { data: recoverable, refetch: refetchRecoverable } = useQuery({
  queryKey: ['recoverable-batch'],
  queryFn: getRecoverableBatch,
  refetchInterval: 4000,
})

const chainOf = (run: ScreenshotRun) => buildChainView(run)
const pendingRows = computed(() =>
  (runs.value ?? []).map((run) => ({ run, chain: chainOf(run) })),
)

const unverifiableRows = computed(() =>
  (allRuns.value ?? []).filter((run) => run.status === 'unverifiable'),
)

const staleCount = computed(
  () => pendingRows.value.filter(({ chain }) => chain.state === 'stale-recalculated').length,
)

const refreshAll = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['baselines'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['conflicts'] }),
    queryClient.invalidateQueries({ queryKey: ['recoverable-batch'] }),
  ])
}

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const batchMutation = useMutation({
  mutationFn: () => {
    const idempotencyKey = `batch-${[...selectedKeys.value].sort().join('_')}`
    return batchReview({
      idempotencyKey,
      failAfterIndex: failAfterIndex.value,
      items: selectedKeys.value.map((runId) => ({
        runId,
        decision: batchDecision.value,
        category: batchCategory.value,
        reviewer: batchReviewer.value,
        reason: batchReason.value || '批量审批：差异已核对，按统一结论处理。',
      })),
    })
  },
  onSuccess: async (response) => {
    lastBatch.value = response.batch
    const failed = response.batch.items.filter((item) => item.status === 'failed').length
    if (failed > 0) Message.warning(`批次完成 ${response.batch.items.length - failed} 项，${failed} 项冲突待人工处理`)
    else Message.success('审批批次全部提交完成，重复提交不会产生多余基线')
    selectedKeys.value = []
    showBatchPanel.value = false
    batchReason.value = ''
    failAfterIndex.value = undefined
    await refreshAll()
  },
  onError: async (error: Error) => {
    if (axios.isAxiosError(error) && error.response?.status === 500) {
      Message.error(`${error.message} —— 可从下方“最近审批批次”一键恢复`)
      await refetchRecoverable()
    } else {
      Message.error(error.message)
    }
    await refreshAll()
  },
})

const resumeMutation = useMutation({
  mutationFn: (batch: ApprovalBatch) => resumeBatch(batch.id),
  onSuccess: async (batch) => {
    lastBatch.value = batch
    Message.success(batch.status === 'completed' ? '批次已恢复并全部完成' : '已补提未完成项，仍有失败项需人工处理')
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const resolveConflictMutation = useMutation({
  mutationFn: (conflict: ConflictDraft) => resolveConflict(conflict.id),
  onSuccess: async () => {
    Message.success('冲突草稿已标记处理')
    await queryClient.invalidateQueries({ queryKey: ['conflicts'] })
  },
})

const pendingItemsIn = (batch: ApprovalBatch) => batch.items.filter((item) => item.status === 'pending').length
const failedItemsIn = (batch: ApprovalBatch) => batch.items.filter((item) => item.status === 'failed').length

const submitBatch = () => {
  if (selectedKeys.value.length === 0) {
    Message.warning('请先选择运行')
    return
  }
  batchMutation.mutate()
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>打开即锁定规则版本；两人同批结论先写者生效，落后页面保留双方取值的冲突草稿。</p>
    </div>
    <a-space>
      <a-button :disabled="selectedKeys.length < 2" @click="mergeMutation.mutate(selectedKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
      <a-button type="primary" :disabled="selectedKeys.length === 0" @click="showBatchPanel = true">
        <icon-check-circle /> 批量审批 {{ selectedKeys.length }} 条
      </a-button>
    </a-space>
  </section>

  <!-- 写入失败后的恢复入口：只补未完成项 -->
  <a-alert
    v-if="recoverable"
    type="error"
    style="margin-bottom: 14px"
  >
    <template #title>
      最近审批批次「{{ recoverable.id }}」存在 {{ pendingItemsIn(recoverable) }} 项未完成
      <template v-if="failedItemsIn(recoverable)">、{{ failedItemsIn(recoverable) }} 项冲突失败</template>
      ，已提交项与基线不会重复生成。
    </template>
    <template #action>
      <a-button size="small" type="primary" :loading="resumeMutation.isPending.value" @click="resumeMutation.mutate(recoverable)">
        只补未完成项
      </a-button>
    </template>
  </a-alert>

  <div class="queue-summary">
    <div><span>当前待审批</span><strong>{{ pendingRows.length }}</strong></div>
    <div>
      <span>规则改动失效</span>
      <strong :class="{ danger: staleCount > 0 }">{{ staleCount }}</strong>
    </div>
    <div><span>待核对</span><strong class="danger">{{ unverifiableRows.length }}</strong></div>
    <div>
      <span>未处理冲突草稿</span>
      <strong class="danger">{{ conflicts?.filter((item) => !item.resolved).length ?? 0 }}</strong>
    </div>
  </div>

  <a-card v-if="showBatchPanel" class="table-panel" :bordered="false" style="margin-bottom: 16px">
    <template #title>批量审批（{{ selectedKeys.length }} 条）</template>
    <a-grid :cols="{ xs: 1, sm: 2, md: 4 }" :col-gap="12" :row-gap="12">
      <a-grid-item>
        <a-input v-model="batchReviewer" placeholder="审批人" />
      </a-grid-item>
      <a-grid-item>
        <a-radio-group v-model="batchDecision" type="button">
          <a-radio value="approved">全部批准</a-radio>
          <a-radio value="rejected">全部驳回</a-radio>
        </a-radio-group>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="batchCategory">
          <a-option value="design-change">设计变更</a-option>
          <a-option value="render-error">渲染异常</a-option>
          <a-option value="environment-noise">环境噪声</a-option>
        </a-select>
      </a-grid-item>
      <a-grid-item>
        <a-select v-model="failAfterIndex" allow-clear placeholder="故障注入：第几项中断">
          <a-option
            v-for="(_, index) in selectedKeys.length"
            :key="index"
            :value="index - 1"
          >第 {{ index }} 项后模拟写入失败</a-option>
        </a-select>
      </a-grid-item>
    </a-grid>
    <a-textarea
      v-model="batchReason"
      :auto-size="{ minRows: 2, maxRows: 4 }"
      placeholder="批量审批原因（留空使用默认说明）"
      style="margin: 12px 0"
    />
    <a-space>
      <a-button type="primary" :loading="batchMutation.isPending.value" @click="submitBatch">提交批次</a-button>
      <a-button @click="showBatchPanel = false">取消</a-button>
      <span class="muted">提交逐项落盘，中断后可恢复；批准项的基线按运行幂等去重。</span>
    </a-space>
  </a-card>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="pendingRows.map(({ run }) => run)"
      :loading="isLoading"
      :pagination="false"
      row-key="id"
      :row-selection="{ type: 'checkbox', showCheckedAll: true }"
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
        <a-table-column title="判定链" :width="150">
          <template #cell="{ record }">
            <ChainStateTag
              :state="chainOf(record).state"
              :rule-version="chainOf(record).ruleVersion"
            />
          </template>
        </a-table-column>
        <a-table-column title="判定差异率" :width="140">
          <template #cell="{ record }">
            <a-tag :color="chainOf(record).effectiveMismatchRate >= 5 ? 'red' : chainOf(record).effectiveMismatchRate >= 2 ? 'orange' : 'gray'">
              {{ chainOf(record).effectiveMismatchRate.toFixed(2) }}%
            </a-tag>
            <div class="sub-text">原始 {{ chainOf(record).rawMismatchRate.toFixed(2) }}%</div>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="160">
          <template #cell="{ record }">
            {{ chainOf(record).evaluation.regionCount - chainOf(record).evaluation.ignoredRegionCount }} 处待判定
            <div class="sub-text">规则折叠 {{ chainOf(record).evaluation.ignoredRegionCount }} 处</div>
          </template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="提交时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">开始评审</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-card
    v-if="unverifiableRows.length"
    class="table-panel"
    :bordered="false"
    style="margin-top: 16px"
  >
    <template #title>待核对（无法判断当时规则）</template>
    <a-table :data="unverifiableRows" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="运行" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.id }} · 采集于 {{ record.capturedAt.slice(0, 10) }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="差异率" data-index="mismatchRate" :width="120" />
        <a-table-column title="状态" :width="120">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="120">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">进入核对</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-card
    v-if="conflicts?.filter((item) => !item.resolved).length"
    class="table-panel"
    :bordered="false"
    style="margin-top: 16px"
  >
    <template #title>并发冲突草稿（落后页面保留双方取值）</template>
    <div v-for="conflict in conflicts.filter((item) => !item.resolved)" :key="conflict.id" class="conflict-row">
      <div class="conflict-grid">
        <div class="conflict-side winner">
          <strong>先生效：{{ conflict.winner.reviewer }} · rv{{ conflict.winner.ruleVersion }}</strong>
          <span>{{ conflict.winner.decision === 'approved' ? '批准' : '驳回' }} · {{ conflict.winner.category }}</span>
          <p>{{ conflict.winner.reason }}</p>
        </div>
        <div class="conflict-side loser">
          <strong>落后：{{ conflict.loser.reviewer }} · 依据 rv{{ conflict.loser.basisRuleVersion }}</strong>
          <span>{{ conflict.loser.decision === 'approved' ? '批准' : '驳回' }} · {{ conflict.loser.category }}</span>
          <p>{{ conflict.loser.reason }}</p>
        </div>
      </div>
      <div class="conflict-foot">
        <router-link :to="`/runs/${conflict.runId}`">打开运行核对</router-link>
        <a-button size="mini" type="text" @click="resolveConflictMutation.mutate(conflict)">标记已处理</a-button>
      </div>
    </div>
  </a-card>

  <a-card v-if="lastBatch" class="table-panel" :bordered="false" style="margin-top: 16px">
    <template #title>最近审批批次结果 · {{ lastBatch.id }}</template>
    <a-table :data="lastBatch.items" :pagination="false" row-key="runId" size="small">
      <template #columns>
        <a-table-column title="运行" data-index="runId" :width="180" />
        <a-table-column title="结论" :width="100">
          <template #cell="{ record }">{{ record.decision === 'approved' ? '批准' : '驳回' }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="120">
          <template #cell="{ record }">
            <a-tag :color="record.status === 'committed' ? 'green' : record.status === 'failed' ? 'red' : 'orange'">
              {{ record.status === 'committed' ? '已提交' : record.status === 'failed' ? '失败' : '未完成' }}
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="说明">
          <template #cell="{ record }">{{ record.error ?? (record.baselineId ? `基线 ${record.baselineId}` : '已留痕') }}</template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
