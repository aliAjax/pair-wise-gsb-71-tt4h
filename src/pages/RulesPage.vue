<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import {
  createRule,
  deleteRule,
  getApiError,
  getProjects,
  getRules,
  toggleRule,
  updateRule,
} from '@/api/http'
import { useDecisionChain } from '@/composables/useDecisionChain'
import type { IgnoreRule } from '@/types'

const queryClient = useQueryClient()
const modalVisible = ref(false)
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
const { currentRuleVersion } = useDecisionChain()

const refreshRules = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['rules'] }),
    queryClient.invalidateQueries({ queryKey: ['runs'] }),
    queryClient.invalidateQueries({ queryKey: ['rule-snapshots'] }),
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ])

const reportMutation = async (result: { ruleVersion: number; invalidatedRunIds: string[] }, action: string) => {
  await refreshRules()
  if (result.invalidatedRunIds.length) {
    Message.warning(
      `${action}已生成规则 v${result.ruleVersion}，${result.invalidatedRunIds.length} 条未审批运行立即失效并按新版本重算，已生成基线保留当时证据`,
    )
  } else {
    Message.success(`${action}已记录为规则 v${result.ruleVersion}（无未审批运行判定受影响）`)
  }
}

const createMutation = useMutation({
  mutationFn: createRule,
  onSuccess: (result) => {
    modalVisible.value = false
    Object.assign(form, {
      name: '',
      projectId: 'all',
      selector: '',
      pagePattern: '*',
      devicePattern: '*',
      maxDelta: 10,
      enabled: true,
    })
    return reportMutation(result, '新规则')
  },
  onError: (error: unknown) => Message.error(getApiError(error).message),
})

const toggleMutation = useMutation({
  mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toggleRule(id, enabled),
  onSuccess: (result) => reportMutation(result, '规则启用状态调整'),
  onError: (error: unknown) => Message.error(getApiError(error).message),
})

const deleteMutation = useMutation({
  mutationFn: deleteRule,
  onSuccess: (result) => reportMutation(result, '规则删除'),
  onError: (error: unknown) => Message.error(getApiError(error).message),
})

const editingRule = ref<IgnoreRule | null>(null)
const editForm = reactive({
  name: '',
  projectId: 'all',
  selector: '',
  pagePattern: '*',
  devicePattern: '*',
  maxDelta: 10,
})
const editVisible = ref(false)

const openEdit = (rule: IgnoreRule) => {
  editingRule.value = rule
  Object.assign(editForm, {
    name: rule.name,
    projectId: rule.projectId,
    selector: rule.selector,
    pagePattern: rule.pagePattern,
    devicePattern: rule.devicePattern,
    maxDelta: rule.maxDelta,
  })
  editVisible.value = true
}

const editMutation = useMutation({
  mutationFn: () => {
    const rule = editingRule.value!
    return updateRule(rule.id, { ...editForm })
  },
  onSuccess: async (result) => {
    editVisible.value = false
    editingRule.value = null
    await reportMutation(result, '规则作用域/色差修改')
  },
  onError: (error: unknown) => Message.error(getApiError(error).message),
})

const submitRule = () => {
  if (!form.name.trim() || !form.selector.trim()) {
    Message.warning('规则名称和选择器不能为空')
    return
  }
  createMutation.mutate({ ...form })
}

const confirmDelete = (rule: IgnoreRule) => {
  Modal.warning({
    title: '删除忽略规则',
    content: `删除“${rule.name}”会生成新规则版本，受影响的未审批运行将立即失效重算；已生成基线保留当时证据。`,
    hideCancel: false,
    onOk: () => deleteMutation.mutate(rule.id),
  })
}

const projectName = (id: string) =>
  id === 'all' ? '全部项目' : projects.value?.find((project) => project.id === id)?.name ?? id

const currentVersion = computed(() => currentRuleVersion.value)
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>差异忽略规则</h2>
      <p>作用域或色差一改动就会推进规则版本，未审批运行立即失效重算。</p>
    </div>
    <a-space>
      <a-tag color="arcoblue" size="large">当前生效版本 v{{ currentVersion }}</a-tag>
      <a-button type="primary" @click="modalVisible = true"><icon-plus /> 新建规则</a-button>
    </a-space>
  </section>

  <a-alert type="info" style="margin-bottom: 16px">
    审批依据锁定打开时的规则版本：规则后改不会改变旧运行审批结论与已生成基线的数字；未审批运行则立即失效并按新版本重算。
  </a-alert>

  <a-card class="table-panel" :bordered="false">
    <a-table :data="rules" :loading="isLoading" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="规则名称" :width="190">
          <template #cell="{ record }">
            <div class="primary-cell"><strong>{{ record.name }}</strong><span>{{ record.id }}</span></div>
          </template>
        </a-table-column>
        <a-table-column title="作用范围" :width="160">
          <template #cell="{ record }">{{ projectName(record.projectId) }}</template>
        </a-table-column>
        <a-table-column title="DOM 选择器" :width="240">
          <template #cell="{ record }"><code>{{ record.selector }}</code></template>
        </a-table-column>
        <a-table-column title="页面 / 设备" :width="180">
          <template #cell="{ record }">{{ record.pagePattern }} · {{ record.devicePattern }}</template>
        </a-table-column>
        <a-table-column title="最大色差" :width="110">
          <template #cell="{ record }">Δ {{ record.maxDelta }}</template>
        </a-table-column>
        <a-table-column title="启用" :width="100">
          <template #cell="{ record }">
            <a-switch
              :model-value="record.enabled"
              size="small"
              :loading="toggleMutation.isPending.value"
              @change="(value: string | number | boolean) => toggleMutation.mutate({ id: record.id, enabled: Boolean(value) })"
            />
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="140">
          <template #cell="{ record }">
            <a-button type="text" size="small" @click="openEdit(record)">编辑</a-button>
            <a-button type="text" status="danger" size="small" @click="confirmDelete(record)">删除</a-button>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:visible="modalVisible"
    title="新建忽略规则"
    :ok-loading="createMutation.isPending.value"
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
      <a-form-item label="创建后立即启用">
        <a-switch v-model="form.enabled" />
      </a-form-item>
    </a-form>
  </a-modal>

  <a-modal
    v-model:visible="editVisible"
    title="编辑规则作用域与色差"
    :ok-loading="editMutation.isPending.value"
    ok-text="保存并推进规则版本"
    @ok="editMutation.mutate()"
  >
    <a-alert type="warning" style="margin-bottom: 16px">
      保存后作用域或色差立即生效：未审批运行按新版本重算，已生成基线保留生成时证据。
    </a-alert>
    <a-form :model="editForm" layout="vertical">
      <a-form-item label="规则名称" required>
        <a-input v-model="editForm.name" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="作用项目" required>
            <a-select v-model="editForm.projectId">
              <a-option value="all">全部项目</a-option>
              <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="最大色差" required>
            <a-input-number v-model="editForm.maxDelta" :min="0" :max="255" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="DOM 选择器" required>
        <a-input v-model="editForm.selector" />
      </a-form-item>
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="页面匹配">
            <a-input v-model="editForm.pagePattern" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="设备匹配">
            <a-input v-model="editForm.devicePattern" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
    </a-form>
  </a-modal>
</template>
