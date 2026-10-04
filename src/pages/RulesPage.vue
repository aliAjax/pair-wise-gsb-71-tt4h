<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import {
  createRule,
  deleteRule,
  getProjects,
  getRuleSnapshots,
  getRules,
  toggleRule,
  updateRule,
} from '@/api/http'
import type { IgnoreRule } from '@/types'

const queryClient = useQueryClient()
const modalVisible = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  projectId: 'all',
  selector: '',
  pagePattern: '*',
  devicePattern: '*',
  maxDelta: 10,
  enabled: true,
})

const { data: rules, isLoading } = useQuery({ queryKey: ['rules'], queryFn: getRules })
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: snapshots } = useQuery({ queryKey: ['rule-snapshots'], queryFn: getRuleSnapshots })

const refreshAll = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['rules'] }),
    queryClient.invalidateQueries({ queryKey: ['rule-snapshots'] }),
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['run'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ])
}

const createMutation = useMutation({
  mutationFn: createRule,
  onSuccess: async () => {
    Message.success('忽略规则已创建并生成新版本，未审批运行已失效重算')
    modalVisible.value = false
    resetForm()
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const updateMutation = useMutation({
  mutationFn: ({ id, patch }: { id: string; patch: Partial<IgnoreRule> }) => updateRule(id, patch),
  onSuccess: async () => {
    Message.success('规则已更新；未审批运行立即失效并按新版本重算，已审批基线保持当时证据')
    modalVisible.value = false
    editingId.value = null
    resetForm()
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const toggleMutation = useMutation({
  mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toggleRule(id, enabled),
  onSuccess: async () => {
    Message.info('启停已生成新规则版本，受影响的未审批运行已重算')
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const deleteMutation = useMutation({
  mutationFn: deleteRule,
  onSuccess: async () => {
    Message.success('规则已删除并生成新版本，相关未审批运行已重算')
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

function resetForm() {
  Object.assign(form, {
    name: '',
    projectId: 'all',
    selector: '',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 10,
    enabled: true,
  })
}

const openCreate = () => {
  editingId.value = null
  resetForm()
  modalVisible.value = true
}

const openEdit = (rule: IgnoreRule) => {
  editingId.value = rule.id
  Object.assign(form, {
    name: rule.name,
    projectId: rule.projectId,
    selector: rule.selector,
    pagePattern: rule.pagePattern,
    devicePattern: rule.devicePattern,
    maxDelta: rule.maxDelta,
    enabled: rule.enabled,
  })
  modalVisible.value = true
}

const submitRule = () => {
  if (!form.name.trim() || !form.selector.trim()) {
    Message.warning('规则名称和选择器不能为空')
    return
  }
  if (editingId.value) {
    updateMutation.mutate({ id: editingId.value, patch: { ...form } })
  } else {
    createMutation.mutate({ ...form })
  }
}

const confirmDelete = (rule: IgnoreRule) => {
  Modal.warning({
    title: '删除忽略规则',
    content: `删除“${rule.name}”会追加规则版本：未审批运行立即失效重算，已审批基线保留当时证据。`,
    hideCancel: false,
    onOk: () => deleteMutation.mutate(rule.id),
  })
}

const projectName = (id: string) =>
  id === 'all' ? '全部项目' : projects.value?.find((project) => project.id === id)?.name ?? id

const modalTitle = computed(() => (editingId.value ? '编辑忽略规则（产生新版本）' : '新建忽略规则'))
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>差异忽略规则</h2>
      <p>规则版本不可变：作用域、色差或启停一改动就追加新版本，未审批运行立即失效重算。</p>
    </div>
    <a-button type="primary" @click="openCreate"><icon-plus /> 新建规则</a-button>
  </section>

  <a-alert type="info" style="margin-bottom: 16px">
    规则不会自动批准截图；改动后仅未审批运行按新版本重算，已审批运行与基线保留当时证据。
  </a-alert>

  <a-card class="table-panel" :bordered="false">
    <a-table :data="rules" :loading="isLoading" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="规则名称" :width="190">
          <template #cell="{ record }">
            <div class="primary-cell"><strong>{{ record.name }}</strong><span>{{ record.id }}</span></div>
          </template>
        </a-table-column>
        <a-table-column title="作用范围" :width="140">
          <template #cell="{ record }">{{ projectName(record.projectId) }}</template>
        </a-table-column>
        <a-table-column title="DOM 选择器" :width="220">
          <template #cell="{ record }"><code>{{ record.selector }}</code></template>
        </a-table-column>
        <a-table-column title="页面 / 设备" :width="170">
          <template #cell="{ record }">{{ record.pagePattern }} · {{ record.devicePattern }}</template>
        </a-table-column>
        <a-table-column title="最大色差" :width="100">
          <template #cell="{ record }">Δ {{ record.maxDelta }}</template>
        </a-table-column>
        <a-table-column title="启用" :width="90">
          <template #cell="{ record }">
            <a-switch
              :model-value="record.enabled"
              size="small"
              @change="(value: string | number | boolean) => toggleMutation.mutate({ id: record.id, enabled: Boolean(value) })"
            />
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="130">
          <template #cell="{ record }">
            <a-space :size="4">
              <a-button type="text" size="small" @click="openEdit(record)">编辑</a-button>
              <a-button type="text" status="danger" size="small" @click="confirmDelete(record)">删除</a-button>
            </a-space>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-card class="table-panel" :bordered="false" style="margin-top: 16px">
    <template #title>规则版本时间线（不可变存档）</template>
    <a-timeline>
      <a-timeline-item
        v-for="snapshot in [...(snapshots ?? [])].reverse()"
        :key="snapshot.version"
        :dot-color="snapshot.historical ? 'gray' : 'green'"
        :label="snapshot.createdAt.slice(0, 16).replace('T', ' ')"
      >
        <strong>rv{{ snapshot.version }} {{ snapshot.historical ? '· 历史存档' : '' }}</strong>
        <p>{{ snapshot.reason }}</p>
        <small>启用 {{ snapshot.rules.length }} 条规则</small>
      </a-timeline-item>
    </a-timeline>
  </a-card>

  <a-modal
    v-model:visible="modalVisible"
    :title="modalTitle"
    :ok-loading="createMutation.isPending.value || updateMutation.isPending.value"
    @ok="submitRule"
  >
    <a-form :model="form" layout="vertical">
      <a-form-item label="规则名称" required>
        <a-input v-model="form.name" placeholder="例如：环境水印" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="作用项目" required>
            <a-select v-model="form.projectId">
              <a-option value="all">全部项目</a-option>
              <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="最大色差" required>
            <a-input-number v-model="form.maxDelta" :min="0" :max="255" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="DOM 选择器" required>
        <a-input v-model="form.selector" placeholder=".environment-watermark" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="页面匹配">
            <a-input v-model="form.pagePattern" placeholder="*" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="设备匹配">
            <a-input v-model="form.devicePattern" placeholder="*" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="保存后立即启用">
        <a-switch v-model="form.enabled" />
      </a-form-item>
      <a-alert v-if="editingId" type="warning">
        保存即追加规则版本，未审批运行立即失效重算；仅修改名称不产生新版本。
      </a-alert>
    </a-form>
  </a-modal>
</template>
