<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { buildChainView, getDashboard, getRuns } from '@/api/http'
import MetricPanel from '@/components/MetricPanel.vue'
import StatusTag from '@/components/StatusTag.vue'
import ChainStateTag from '@/components/ChainStateTag.vue'

const { data: dashboard, isLoading } = useQuery({
  queryKey: ['dashboard'],
  queryFn: getDashboard,
})

const { data: runs } = useQuery({
  queryKey: ['runs', 'dashboard'],
  queryFn: () => getRuns(),
})

const pendingRuns = computed(() =>
  (runs.value ?? [])
    .map((run) => ({ run, chain: buildChainView(run) }))
    .filter(({ run }) => run.status === 'pending'),
)
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <section class="page-intro">
      <div>
        <h2>今日视觉回归态势</h2>
        <p>统一按判定链口径统计：规则版本、差异区域与审批证据取自同一条可恢复链路。</p>
      </div>
      <router-link to="/runs">
        <a-button type="primary"><icon-upload /> 新建批量运行</a-button>
      </router-link>
    </section>

    <div class="metric-grid">
      <MetricPanel label="待审批运行" :value="dashboard?.pendingReview ?? 0" note="不含待核对" tone="orange" />
      <MetricPanel label="失效重算" :value="dashboard?.staleCount ?? 0" note="规则改动后待确认" tone="gold" />
      <MetricPanel label="高风险差异" :value="dashboard?.highRisk ?? 0" note="判定差异率 ≥ 5%" tone="red" />
      <MetricPanel label="有效基线 / 待核对" :value="`${dashboard?.activeBaselines ?? 0} / ${dashboard?.unverifiableCount ?? 0}`" note="基线证据已冻结" tone="blue" />
    </div>

    <div class="dashboard-grid">
      <a-card class="work-panel" :bordered="false">
        <template #title>发布阻断项</template>
        <template #extra><router-link to="/approvals">查看队列</router-link></template>
        <div class="blocker-list">
          <div
            v-for="{ run, chain } in pendingRuns.slice(0, 4)"
            :key="run.id"
            class="blocker-row"
          >
            <div class="severity-line" :class="{ high: chain.effectiveMismatchRate >= 5 }" />
            <div class="blocker-main">
              <strong>{{ run.page }}</strong>
              <span>{{ run.device }} · {{ run.build }}</span>
            </div>
            <b class="mismatch">{{ chain.effectiveMismatchRate.toFixed(2) }}%</b>
            <ChainStateTag :state="chain.state" :rule-version="chain.ruleVersion" />
            <router-link :to="`/runs/${run.id}`">定位差异</router-link>
          </div>
        </div>
      </a-card>

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
    </div>

    <a-card class="work-panel" :bordered="false">
      <template #title>最近同步的回归运行</template>
      <a-table :data="runs?.slice(0, 5)" :pagination="false" row-key="id" size="small">
        <template #columns>
          <a-table-column title="运行" data-index="name" />
          <a-table-column title="页面" data-index="page" />
          <a-table-column title="判定差异率">
            <template #cell="{ record }">{{ buildChainView(record).effectiveMismatchRate.toFixed(2) }}%</template>
          </a-table-column>
          <a-table-column title="规则版本">
            <template #cell="{ record }">rv{{ buildChainView(record).ruleVersion }}</template>
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
