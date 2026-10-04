<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useQuery } from '@tanstack/vue-query'
import { getBaselines, getRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useDecisionChain, versionLabel } from '@/composables/useDecisionChain'

const dateRange = ref('last-7-days')
const { data: runs } = useQuery({ queryKey: ['runs', 'reports'], queryFn: () => getRuns() })
const { data: baselines } = useQuery({ queryKey: ['baselines', 'reports'], queryFn: () => getBaselines() })
const { judge, currentRuleVersion } = useDecisionChain()

const summary = computed(() => ({
  total: runs.value?.length ?? 0,
  failed: runs.value?.filter((run) => judge(run).mismatchRate > 0).length ?? 0,
  approved: runs.value?.filter((run) => run.status === 'approved').length ?? 0,
  stale: runs.value?.filter((run) => run.status === 'stale').length ?? 0,
  needsCheck: runs.value?.filter((run) => run.status === 'needs-check').length ?? 0,
  baselines: baselines.value?.length ?? 0,
}))

const escapeCsv = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`

const exportCsv = () => {
  const rows = [
    [
      '运行ID',
      '页面',
      '设备',
      '主题',
      '构建',
      '状态',
      '规则版本',
      '依据来源',
      '差异率',
      '差异区域总数',
      '忽略区域数',
      '待判定区域',
      '证据冻结',
      '审批人',
      '审批原因',
      '审批批次',
    ],
    ...(runs.value ?? []).map((run) => {
      const result = judge(run)
      const review = run.review
      return [
        run.id,
        run.page,
        run.device,
        run.theme,
        run.build,
        run.status,
        result.ruleVersion === null ? 'unknown' : `v${result.ruleVersion}`,
        result.ruleVersion === null
          ? 'needs-check'
          : run.ruleVersionSource ?? (review ? 'frozen-evidence' : 'capture'),
        result.mismatchRate.toFixed(2),
        result.regionCount,
        result.ignoredCount,
        result.regionCount - result.ignoredCount,
        result.frozen ? 'yes' : 'no',
        review?.reviewer ?? '',
        review?.reason ?? '',
        review?.evidence.batchId ?? '',
      ]
    }),
  ]
  const csv = `﻿${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `visual-regression-report-rv${currentRuleVersion.value}-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
  Message.success('结果 CSV 已按统一判定链导出（含规则版本与冻结证据列）')
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>结果汇总与导出</h2>
      <p>导出数字与列表、详情共用同一条判定链；已批准运行导出冻结证据，不受规则后改影响。</p>
    </div>
    <a-space>
      <a-tag color="arcoblue">当前规则 v{{ currentRuleVersion }}</a-tag>
      <a-select v-model="dateRange" style="width: 150px">
        <a-option value="last-7-days">最近 7 天</a-option>
        <a-option value="last-30-days">最近 30 天</a-option>
        <a-option value="current-release">当前发布周期</a-option>
      </a-select>
      <a-button type="primary" @click="exportCsv"><icon-download /> 导出 CSV</a-button>
    </a-space>
  </section>

  <div class="metric-grid report-metrics">
    <div class="metric-panel tone-blue"><div class="metric-label">总运行</div><div class="metric-value">{{ summary.total }}</div><div class="metric-note">当前筛选范围</div></div>
    <div class="metric-panel tone-orange"><div class="metric-label">存在差异（判定链）</div><div class="metric-value">{{ summary.failed }}</div><div class="metric-note">按各运行锁定规则版本判定</div></div>
    <div class="metric-panel tone-green"><div class="metric-label">批准运行</div><div class="metric-value">{{ summary.approved }}</div><div class="metric-note">含冻结证据</div></div>
    <div class="metric-panel tone-red"><div class="metric-label">重算/待核对</div><div class="metric-value">{{ summary.stale }}/{{ summary.needsCheck }}</div><div class="metric-note">规则变更与旧运行</div></div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <template #title>发布质量明细</template>
    <template #extra><span class="muted">差异率、区域数均来自判定链</span></template>
    <a-table :data="runs" :pagination="{ pageSize: 10 }" row-key="id">
      <template #columns>
        <a-table-column title="运行" data-index="name" :width="200" />
        <a-table-column title="页面 / 设备" :width="190">
          <template #cell="{ record }">{{ record.page }} · {{ record.device }}</template>
        </a-table-column>
        <a-table-column title="规则依据" :width="170">
          <template #cell="{ record }">
            <code>{{ versionLabel(judge(record).ruleVersion, record.ruleVersionSource) }}</code>
          </template>
        </a-table-column>
        <a-table-column title="差异率" :width="100">
          <template #cell="{ record }">{{ judge(record).mismatchRate.toFixed(2) }}%</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="审批证据" :width="300">
          <template #cell="{ record }">
            <div v-if="record.review" class="evidence-cell">
              <strong>
                {{ record.review.reviewer }} · {{ record.review.reviewedAt.slice(0, 10) }} ·
                冻结 v{{ record.review.evidence.ruleVersion }} / {{ record.review.evidence.mismatchRate.toFixed(2) }}%
              </strong>
              <span>{{ record.review.reason }}</span>
            </div>
            <span v-else class="muted">尚未审批</span>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
