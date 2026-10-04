<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { getDashboard, getRuns } from '@/api/http'
import MetricPanel from '@/components/MetricPanel.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useDecisionChain } from '@/composables/useDecisionChain'

const { data: dashboard, isLoading } = useQuery({
  queryKey: ['dashboard'],
  queryFn: getDashboard,
})

const { data: runs } = useQuery({
  queryKey: ['runs', 'dashboard'],
  queryFn: () => getRuns(),
  refetchInterval: (query) =>
    (query.state.data ?? []).some((run) => run.status === 'stale') ? 1500 : false,
})

const { judge } = useDecisionChain()
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <section class="page-intro">
      <div>
        <h2>今日视觉回归态势</h2>
        <p>差异率按各运行锁定的规则版本判定；当前全局规则版本 v{{ dashboard?.ruleVersion ?? 1 }}。</p>
      </div>
      <router-link to="/runs">
        <a-button type="primary"><icon-upload /> 新建批量运行</a-button>
      </router-link>
    </section>

    <div class="metric-grid">
      <MetricPanel label="待审批运行" :value="dashboard?.pendingReview ?? 0" note="按锁定规则版本判定" tone="orange" />
      <MetricPanel label="今日已批准" :value="dashboard?.approvedToday ?? 0" note="证据冻结可追溯" tone="green" />
      <MetricPanel label="规则变更重算中" :value="dashboard?.staleReview ?? 0" note="未审批运行已失效" tone="red" />
      <MetricPanel label="待核对旧运行" :value="dashboard?.needsCheck ?? 0" note="缺少规则记录" tone="blue" />
    </div>

    <div class="dashboard-grid">
      <a-card class="work-panel" :bordered="false">
        <template #title>近七日运行趋势</template>
        <template #extra><span class="muted">失败率受差异阈值控制</span></template>
        <div class="trend-chart">
          <div v-for="point in dashboard?.trend" :key="point.date" class="trend-column">
            <div class="trend-bars">
              <span class="trend-total" :style="{ height: `${point.total * 2.2}px` }" />
              <span class="trend-failed" :style="{ height: `${point.failed * 2.2}px` }" />
            </div>
            <b>{{ point.failed }}/{{ point.total }}</b>
            <small>{{ point.date }}</small>
          </div>
        </div>
        <div class="legend">
          <span><i class="total" />运行总量</span>
          <span><i class="failed" />差异失败</span>
        </div>
      </a-card>

      <a-card class="work-panel" :bordered="false">
        <template #title>发布阻断项</template>
        <template #extra><router-link to="/approvals">查看队列</router-link></template>
        <div class="blocker-list">
          <div v-for="run in runs?.filter((item) => item.status === 'pending' || item.status === 'stale' || item.status === 'needs-check').slice(0, 4)" :key="run.id" class="blocker-row">
            <div class="severity-line" :class="{ high: judge(run).mismatchRate >= 5 }" />
            <div class="blocker-main">
              <strong>{{ run.page }}</strong>
              <span>{{ run.device }} · {{ run.build }} · v{{ judge(run).ruleVersion ?? '?' }}</span>
            </div>
            <b class="mismatch">{{ judge(run).mismatchRate.toFixed(2) }}%</b>
            <StatusTag :status="run.status" />
            <router-link :to="`/runs/${run.id}`">定位差异</router-link>
          </div>
        </div>
      </a-card>
    </div>

    <a-card class="work-panel" :bordered="false">
      <template #title>最近同步的回归运行</template>
      <a-table :data="runs?.slice(0, 5)" :pagination="false" row-key="id" size="small">
        <template #columns>
          <a-table-column title="运行" data-index="name" />
          <a-table-column title="页面" data-index="page" />
          <a-table-column title="设备 / 主题" data-index="device" />
          <a-table-column title="构建" data-index="build" />
          <a-table-column title="判定差异率">
            <template #cell="{ record }">{{ judge(record).mismatchRate.toFixed(2) }}%</template>
          </a-table-column>
          <a-table-column title="状态">
            <template #cell="{ record }"><StatusTag :status="record.status" /></template>
          </a-table-column>
          <a-table-column title="操作">
            <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">打开评审</router-link></template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>
  </a-spin>
</template>
