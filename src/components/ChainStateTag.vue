<script setup lang="ts">
import { computed } from 'vue'
import type { ChainState } from '@/types'

const props = defineProps<{ state: ChainState; ruleVersion?: number }>()

const meta: Record<ChainState, { color: string; label: string }> = {
  current: { color: 'green', label: '当前规则' },
  'stale-recalculated': { color: 'gold', label: '已失效重算' },
  frozen: { color: 'arcoblue', label: '证据已冻结' },
  backfilled: { color: 'cyan', label: '历史回填' },
  unverifiable: { color: 'purple', label: '待核对' },
}

const value = computed(() => meta[props.state])
</script>

<template>
  <a-tooltip :content="state === 'frozen'
    ? '审批后证据按该规则版本冻结，规则再改不影响本次结论'
    : state === 'stale-recalculated'
      ? '规则改动后本运行已按新版本重算，确认后才能继续审批'
      : state === 'backfilled'
        ? '旧运行缺少规则记录，已按采集时有效规则回填'
        : state === 'unverifiable'
          ? '无法判断当时适用的规则版本，需人工核对'
          : '与最新规则版本一致'">
    <a-tag :color="value.color" size="small" bordered>
      {{ value.label }}<template v-if="ruleVersion"> · rv{{ ruleVersion }}</template>
    </a-tag>
  </a-tooltip>
</template>
