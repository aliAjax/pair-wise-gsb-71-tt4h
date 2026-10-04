<script setup lang="ts">
import { computed, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useQuery } from '@tanstack/vue-query'
import { buildChainView, getBaselines, getRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import ChainStateTag from '@/components/ChainStateTag.vue'
import type { ChainView } from '@/types'
const dateRange = ref('last-7-days')
const { data: runs } = useQuery({ queryKey: ['runs', 'reports'], queryFn: () => getRuns() })
const { data: baselines } = useQuery({ queryKey: ['baselines', 'reports'], queryFn: () => getBaselines() })

const rows = computed<Array<{ run: NonNullable<typeof runs.value>[number]; chain: ChainView }>>(() =>
  (runs.value ?? []).map((run) => ({ run, chain: buildChainView(run) })),
)

const summary = computed(() => ({
  total: rows.value.length,
  failed: rows.value.filter(({ chain }) => chain.effectiveMismatchRate > 0).length,
  approved: rows.value.filter(({ run }) => run.status === 'approved').length,
  baselines: baselines.value?.length ?? 0,
  stale: rows.value.filter(({ chain }) => chain.state === 'stale-recalculated').length,
  unverifiable: rows.value.filter(({ chain }) => chain.state === 'unverifiable').length,
}))

const stateText: Record<ChainView['state'], string> = {
  current: '当前规则',
  'stale-recalculated': '失效重算',
  frozen: '证据冻结',
  backfilled: '历史回填',
  unverifiable: '待核对',
}

const escapeCsv = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`

const exportCsv = () => {
  const header = [
    '运行ID',
    '页面',
    '设备',
    '主题',
    '构建',
    '状态',
    '规则版本',
    '判定链状态',
    '判定差异率',
    '原始差异率',
    '差异区域数',
    '规则忽略区域数',
    '审批人',
    '审批依据',
    '审批原因',
  ]
  const body = rows.value.map(({ run, chain }) => [
    run.id,
    run.page,
    run.device,
    run.theme,
    run.build,
    run.status,
    `rv${chain.ruleVersion}`,
    stateText[chain.state],
    chain.effectiveMismatchRate.toFixed(2),
    chain.rawMismatchRate.toFixed(2),
    chain.evaluation.regionCount,
    chain.evaluation.ignoredRegionCount,
    run.review?.reviewer ?? '',
    chain.basisLabel,
    run.review?.reason ?? '',
  ])
  const csv = `﻿${[header, ...body].map((row) => row.map(escapeCsv).join(',')).join('\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `visual-regression-report-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
  Message.success('结果 CSV 已按判定链结果导出')
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>结果汇总与导出</h2>
      <p>列表与导出共用同一条判定链：规则版本、判定状态、有效差异率三处口径一致。</p>
    </div>
    <a-space>
      <a-select v-model="dateRange" style="width: 150px">
        <a-option value="last-7-days">最近 7 天</a-option>
        <a-option value="last-30-days">最近 30 天</a-option>
        <a-option value="current-release">当前发布周期</a-option>
      </a-select>
      <a-button type="primary" @click="exportCsv"><icon-download /> 导出 CSV</a-button>
    </a-space>
  </section>

  <div class="metric-grid report-metrics">
    <div class="metric-panel tone-blue"><div class="metric-label">总运行</div><div class="metric-value">{{ summary.total }}</div><div class="metric-note">判定链口径</div></div>
    <div class="metric-panel tone-orange"><div class="metric-label">存在差异</div><div class="metric-value">{{ summary.failed }}</div><div class="metric-note">按判定差异率</div></div>
    <div class="metric-panel tone-green"><div class="metric-label">批准运行</div><div class="metric-value">{{ summary.approved }}</div><div class="metric-note">证据已冻结</div></div>
    <div class="metric-panel tone-red"><div class="metric-label">失效重算 / 待核对</div><div class="metric-value">{{ summary.stale }} / {{ summary.unverifiable }}</div><div class="metric-note">需跟进项</div></div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <template #title>发布质量明细</template>
    <template #extra><span class="muted">导出字段与本页一致，已含规则版本与判定状态</span></template>
    <a-table :data="rows.map(({ run }) => run)" :pagination="{ pageSize: 10 }" row-key="id">
      <template #columns>
        <a-table-column title="运行" data-index="name" :width="200" />
        <a-table-column title="判定链" :width="150">
          <template #cell="{ record }">
            <ChainStateTag :state="buildChainView(record).state" :rule-version="buildChainView(record).ruleVersion" />
          </template>
        </a-table-column>
        <a-table-column title="页面 / 设备" :width="200">
          <template #cell="{ record }">{{ record.page }} · {{ record.device }}</template>
        </a-table-column>
        <a-table-column title="判定差异率" :width="120">
          <template #cell="{ record }">
            <b :class="{ danger: buildChainView(record).effectiveMismatchRate >= 5 }">
              {{ buildChainView(record).effectiveMismatchRate.toFixed(2) }}%
            </b>
            <div class="sub-text">原始 {{ buildChainView(record).rawMismatchRate.toFixed(2) }}%</div>
          </template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="审批证据" :width="300">
          <template #cell="{ record }">
            <div v-if="record.review" class="evidence-cell">
              <strong>{{ record.review.reviewer }} · rv{{ record.review.ruleVersion }} · {{ record.review.reviewedAt.slice(0, 10) }}</strong>
              <span>{{ record.review.reason }}</span>
            </div>
            <span v-else class="muted">尚未审批（{{ buildChainView(record).basisLabel }}）</span>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>
</template>
