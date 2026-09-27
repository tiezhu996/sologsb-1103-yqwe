<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import ChannelChip from '@/components/common/ChannelChip.vue'
import { useChannelConflict } from '@/hooks/useChannelConflict'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'
import {
  DMX_CHANNEL_MAX,
  DMX_CHANNEL_MIN,
  FIXTURE_POSITIONS,
  FIXTURE_TYPES,
  POSITION_COLORS,
  type Fixture,
  type FixtureDraft,
  type FixturePosition,
  type FixtureType
} from '@/types/fixture'
import { buildRelampPlan } from '@/utils/relamp'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const fixtureStore = useFixtureStore()
const levelStore = useLevelStore()
const cueStore = useCueStore()

const sessionId = computed(() => String(route.params.id ?? ''))
const session = computed(() => sessionStore.sessionById(sessionId.value))

const { messages, conflictChannels, conflictFixtureIds, loads, hasConflict, hasOverload } = useChannelConflict(sessionId)

const viewMode = ref<'group' | 'channel'>('group')
const collapsed = ref<FixturePosition[]>([])

const groups = computed(() => fixtureStore.groupedFixturesOfSession(sessionId.value))
const flatFixtures = computed(() => fixtureStore.sortedFixturesOfSession(sessionId.value))

const positionOptions = FIXTURE_POSITIONS.map((position) => ({ label: position, value: position }))
const typeOptions = FIXTURE_TYPES.map((type) => ({ label: type, value: type }))

const showModal = ref(false)
const editingId = ref<string | null>(null)

/** 弹窗表单单独持有可空值，提交时再收敛为 FixtureDraft，避免组件类型与模型类型互相污染 */
const form = reactive<{
  channel: number | null
  position: FixturePosition
  fixtureType: FixtureType
  gel: string
  patchNote: string
}>({
  channel: DMX_CHANNEL_MIN,
  position: '面光',
  fixtureType: '成像灯',
  gel: '',
  patchNote: ''
})

const modalTitle = computed(() => (editingId.value ? '编辑灯位通道' : '新建灯位通道'))

const duplicateChannel = computed(
  () => form.channel !== null && flatFixtures.value.some((fixture) => fixture.id !== editingId.value && fixture.channel === form.channel)
)

function isCollapsed(position: FixturePosition): boolean {
  return collapsed.value.includes(position)
}

function toggleGroup(position: FixturePosition): void {
  collapsed.value = isCollapsed(position)
    ? collapsed.value.filter((item) => item !== position)
    : [...collapsed.value, position]
}

function expandAll(): void {
  collapsed.value = []
}

function collapseAll(): void {
  collapsed.value = [...FIXTURE_POSITIONS]
}

function averageIntensityOf(fixtureId: string): number | null {
  return levelStore.averageIntensityOfFixture(fixtureId)
}

function openCreate(position?: FixturePosition): void {
  editingId.value = null
  const nextChannel = flatFixtures.value.reduce((max, fixture) => Math.max(max, fixture.channel), 0) + 1
  form.channel = Math.min(nextChannel, DMX_CHANNEL_MAX)
  form.position = position ?? '面光'
  form.fixtureType = '成像灯'
  form.gel = ''
  form.patchNote = ''
  showModal.value = true
}

function openEdit(fixture: Fixture): void {
  editingId.value = fixture.id
  form.channel = fixture.channel
  form.position = fixture.position
  form.fixtureType = fixture.fixtureType
  form.gel = fixture.gel
  form.patchNote = fixture.patchNote
  showModal.value = true
}

function handlePositionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string' && (FIXTURE_POSITIONS as readonly string[]).includes(value)) {
    form.position = value as FixturePosition
  }
}

function handleTypeChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string' && (FIXTURE_TYPES as readonly string[]).includes(value)) {
    form.fixtureType = value as FixtureType
  }
}

async function submitForm(): Promise<void> {
  if (form.channel === null) {
    message.error('请填写 DMX 通道号')
    return
  }
  const payload: FixtureDraft = {
    sessionId: sessionId.value,
    channel: form.channel,
    position: form.position,
    fixtureType: form.fixtureType,
    gel: form.gel.trim(),
    patchNote: form.patchNote.trim()
  }
  const result = editingId.value
    ? await fixtureStore.updateFixture(editingId.value, payload)
    : await fixtureStore.addFixture(payload)
  if (!result.ok) {
    message.error(result.message)
    return
  }
  message.success(result.message)
  showModal.value = false
}

function confirmRemove(fixture: Fixture): void {
  const levelCount = levelStore.levels.filter((level) => level.fixtureId === fixture.id).length
  dialog.warning({
    title: '删除灯位通道',
    content: `将删除 CH${fixture.channel}（${fixture.position} · ${fixture.fixtureType}）${
      levelCount > 0 ? `，并清理 ${levelCount} 条通道电平记录` : ''
    }。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await fixtureStore.removeFixture(fixture.id)
      message.success('灯位通道已删除')
    }
  })
}

/* ---------------- 彩排前换灯：故障通道 → 本场备用通道 ---------------- */

/** 手输通道号生成的临时标签前缀，与灯位主键（fix_ 开头）区分 */
const SWAP_TAG_PREFIX = 'ch:'

const showSwapModal = ref(false)
const swappingFixture = ref<Fixture | null>(null)
/** NSelect 选中值：灯位 id，或手输通道号生成的 `ch:12` 临时标签 */
const swapTargetValue = ref<string | null>(null)
const swapSubmitting = ref(false)

const swapOptions = computed(() =>
  flatFixtures.value
    .filter((fixture) => fixture.id !== swappingFixture.value?.id)
    .map((fixture) => ({
      label: `CH${fixture.channel} · ${fixture.position} · ${fixture.fixtureType}${fixture.patchNote ? ` · ${fixture.patchNote}` : ''}`,
      value: fixture.id
    }))
)

/** 手输通道号：过滤后归一为 `ch:<整数>` 标签 */
function createSwapTag(rawValue: string): string {
  const digits = rawValue.replace(/[^\d]/g, '')
  return `${SWAP_TAG_PREFIX}${digits}`
}

interface SwapTargetState {
  fixture: Fixture | null
  /** 不生效原因；为 null 表示选中了本场已配接的备用通道 */
  reason: string | null
}

/** 解析当前选中的备用通道：已配接灯位直接命中；手输通道号要求本场恰好配过 */
const swapTargetState = computed<SwapTargetState>(() => {
  const value = swapTargetValue.value
  const source = swappingFixture.value
  if (!source) return { fixture: null, reason: null }
  if (!value) return { fixture: null, reason: null }

  if (!value.startsWith(SWAP_TAG_PREFIX)) {
    const fixture = flatFixtures.value.find((item) => item.id === value) ?? null
    if (fixture && fixture.id === source.id) return { fixture: null, reason: '备用通道不能与原通道相同。' }
    return { fixture, reason: fixture ? null : '该备用通道在本场没有配过灯，换灯不生效。' }
  }

  const digits = value.slice(SWAP_TAG_PREFIX.length)
  if (!digits) return { fixture: null, reason: null }
  const channel = Number(digits)
  if (!Number.isInteger(channel) || channel < DMX_CHANNEL_MIN || channel > DMX_CHANNEL_MAX) {
    return { fixture: null, reason: `DMX 通道号需在 ${DMX_CHANNEL_MIN}-${DMX_CHANNEL_MAX} 之间。` }
  }
  const matched = flatFixtures.value.filter((item) => item.channel === channel && item.id !== source.id)
  if (matched.length === 0) {
    return { fixture: null, reason: `备用通道 CH${channel} 本场没配过灯，换灯不生效；请先配接或改选列表中的通道。` }
  }
  if (matched.length > 1) {
    return { fixture: null, reason: `CH${channel} 在本场有多个配接，请从下拉列表中明确选择一条备用通道。` }
  }
  return { fixture: matched[0], reason: null }
})

const swapPlan = computed(() => {
  const source = swappingFixture.value
  const target = swapTargetState.value.fixture
  if (!source || !target) return null
  return buildRelampPlan(
    levelStore.levels.filter((level) => level.fixtureId === source.id),
    levelStore.levels.filter((level) => level.fixtureId === target.id)
  )
})

/** 两边都设过电平的 Cue 明细，用于确认前列出二选一结果 */
const swapConflictItems = computed(() => {
  const plan = swapPlan.value
  if (!plan) return []
  return plan.items
    .filter((item) => item.conflict !== null)
    .map((item) => {
      const conflict = item.conflict as NonNullable<typeof item.conflict>
      return {
        cueId: item.cueId,
        cueNo: cueStore.cueById(item.cueId)?.cueNo ?? '已删除的 Cue',
        intensity: conflict.intensity,
        droppedIntensity: conflict.droppedIntensity,
        winner: conflict.winner
      }
    })
})

function swapTargetLabel(): string {
  const target = swapTargetState.value.fixture
  return target ? `CH${target.channel}（${target.position} · ${target.fixtureType}）` : ''
}

function openSwap(fixture: Fixture): void {
  swappingFixture.value = fixture
  swapTargetValue.value = null
  swapSubmitting.value = false
  showSwapModal.value = true
}

async function submitSwap(): Promise<void> {
  const source = swappingFixture.value
  const target = swapTargetState.value.fixture
  if (!source || !target || swapSubmitting.value) return
  swapSubmitting.value = true
  try {
    const result = await fixtureStore.relampFixture(source.id, target.id)
    if (!result.ok) {
      message.error(result.reason ?? result.message)
      return
    }
    message.success(result.message)
    showSwapModal.value = false
  } finally {
    swapSubmitting.value = false
  }
}

function goCues(): void {
  void router.push(`/sessions/${sessionId.value}/cues`)
}

function goSessions(): void {
  void router.push('/sessions')
}

function channelLoadText(position: FixturePosition): string {
  const load = loads.value.find((item) => item.position === position)
  if (!load) return '0/0'
  return `${load.count}/${load.limit}`
}

function isPositionOverloaded(position: FixturePosition): boolean {
  return loads.value.find((item) => item.position === position)?.overloaded ?? false
}

function handleChipClick(fixture: Fixture): void {
  openEdit(fixture)
}

function positionColor(position: FixturePosition): string {
  return POSITION_COLORS[position]
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">灯位通道配置台</h1>
        <p class="page__subtitle">
          {{ session ? `${session.order}. ${session.title}` : '场次不存在或已删除' }} ·
          按通道号排布、按灯位分组折叠，重复通道号会被高亮。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goSessions">返回场次</NButton>
        <NButton @click="goCues">Cue 时间轴</NButton>
        <NButton type="primary" :disabled="!session" @click="openCreate()">新建灯位通道</NButton>
      </div>
    </header>

    <NAlert v-if="!session" type="warning" :bordered="false">
      该场次不存在，可能已被删除。请返回场次编排重新选择。
    </NAlert>

    <template v-else>
      <div class="toolbar">
        <span class="toolbar__label">视图</span>
        <NButton size="small" :type="viewMode === 'group' ? 'primary' : 'default'" @click="viewMode = 'group'">
          按灯位分组
        </NButton>
        <NButton size="small" :type="viewMode === 'channel' ? 'primary' : 'default'" @click="viewMode = 'channel'">
          按通道号序列
        </NButton>
        <span class="toolbar__divider" />
        <NButton size="small" quaternary @click="expandAll">全部展开</NButton>
        <NButton size="small" quaternary @click="collapseAll">全部折叠</NButton>
        <span class="toolbar__spacer" />
        <NTag size="small" :bordered="false" :type="hasConflict ? 'error' : 'success'">
          {{ hasConflict ? `${conflictChannels.length} 个通道号重复` : '通道号唯一' }}
        </NTag>
        <NTag size="small" :bordered="false" :type="hasOverload ? 'warning' : 'success'">
          {{ hasOverload ? '存在灯位过载' : '灯位负载正常' }}
        </NTag>
      </div>

      <NAlert v-for="(text, index) in messages" :key="index" type="error" :bordered="false" class="alert-line">
        {{ text }}
      </NAlert>

      <section class="panel">
        <h2 class="panel__title">灯位负载<span class="panel__title-tag">单灯位上限 6 个通道</span></h2>
        <div class="load-grid">
          <div v-for="load in loads" :key="load.position" class="load-item" :class="{ 'load-item--over': load.overloaded }">
            <span class="load-item__dot" :style="{ background: positionColor(load.position) }" />
            <span class="load-item__name">{{ load.position }}</span>
            <span class="load-item__count mono">{{ load.count }}/{{ load.limit }}</span>
          </div>
        </div>
      </section>

      <BlankHint
        v-if="flatFixtures.length === 0"
        title="还没有灯位通道"
        description="灯位通道记录 DMX 通道号、灯位方位、灯具类型与色纸编号，是 Cue 电平设定的对象。"
        tip="提示：同一场次内通道号必须唯一，重复项会被标红。"
        action-text="新建第一个通道"
        @action="openCreate()"
      />

      <template v-else-if="viewMode === 'group'">
        <section v-for="group in groups" :key="group.position" class="panel group">
          <button type="button" class="group__head" @click="toggleGroup(group.position)">
            <span class="group__caret" :class="{ 'group__caret--closed': isCollapsed(group.position) }">▾</span>
            <span class="group__dot" :style="{ background: positionColor(group.position) }" />
            <span class="group__name">{{ group.position }}</span>
            <span class="group__count mono">{{ group.fixtures.length }} 个通道</span>
            <span class="group__load mono" :class="{ 'group__load--over': isPositionOverloaded(group.position) }">
              负载 {{ channelLoadText(group.position) }}
            </span>
            <span class="toolbar__spacer" />
            <NButton size="tiny" quaternary @click.stop="openCreate(group.position)">+ 新增</NButton>
          </button>

          <div v-if="!isCollapsed(group.position)" class="group__body">
            <p v-if="group.fixtures.length === 0" class="empty-line">该灯位暂无通道</p>
            <div
              v-for="fixture in group.fixtures"
              :key="fixture.id"
              class="fixture-row"
              :class="{ 'fixture-row--conflict': conflictFixtureIds.includes(fixture.id) }"
            >
              <ChannelChip
                :channel="fixture.channel"
                :position="fixture.position"
                :intensity="averageIntensityOf(fixture.id)"
                :gel="fixture.gel"
                :fixture-type="fixture.fixtureType"
                :duplicate="conflictChannels.includes(fixture.channel)"
                clickable
                @click="handleChipClick(fixture)"
              />
              <span class="fixture-row__type">{{ fixture.fixtureType }}</span>
              <span class="fixture-row__note">{{ fixture.patchNote || '无配接备注' }}</span>
              <span class="toolbar__spacer" />
              <NButton size="tiny" quaternary @click="openEdit(fixture)">编辑</NButton>
              <NButton size="tiny" quaternary type="warning" @click="openSwap(fixture)">换灯</NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(fixture)">删除</NButton>
            </div>
          </div>
        </section>
      </template>

      <section v-else class="panel">
        <h2 class="panel__title">通道号序列<span class="panel__title-tag">共 {{ flatFixtures.length }} 个通道</span></h2>
        <div class="channel-table">
          <div class="channel-table__head">
            <span>通道</span>
            <span>灯位</span>
            <span>灯具</span>
            <span>色纸</span>
            <span>配接备注</span>
            <span>操作</span>
          </div>
          <div
            v-for="fixture in flatFixtures"
            :key="fixture.id"
            class="channel-table__row"
            :class="{ 'channel-table__row--conflict': conflictFixtureIds.includes(fixture.id) }"
          >
            <ChannelChip
              :channel="fixture.channel"
              :position="fixture.position"
              :intensity="averageIntensityOf(fixture.id)"
              :gel="fixture.gel"
              :duplicate="conflictChannels.includes(fixture.channel)"
              size="small"
            />
            <span>{{ fixture.position }}</span>
            <span>{{ fixture.fixtureType }}</span>
            <span class="mono">{{ fixture.gel || '—' }}</span>
            <span class="channel-table__note">{{ fixture.patchNote || '—' }}</span>
            <span class="channel-table__actions">
              <NButton size="tiny" quaternary @click="openEdit(fixture)">编辑</NButton>
              <NButton size="tiny" quaternary type="warning" @click="openSwap(fixture)">换灯</NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(fixture)">删除</NButton>
            </span>
          </div>
        </div>
      </section>
    </template>

    <NModal v-model:show="showModal" preset="card" :title="modalTitle" class="form-modal" :mask-closable="false">
      <NForm label-placement="left" label-width="92">
        <NFormItem label="DMX 通道">
          <div class="channel-picker">
            <NInputNumber
              v-model:value="form.channel"
              :min="DMX_CHANNEL_MIN"
              :max="DMX_CHANNEL_MAX"
              :show-button="false"
              style="width: 140px"
            />
            <span class="channel-picker__hint mono">{{ DMX_CHANNEL_MIN }}-{{ DMX_CHANNEL_MAX }}</span>
          </div>
        </NFormItem>
        <NFormItem v-if="duplicateChannel" label=" ">
          <span class="channel-picker__warn">该通道号在本场次已存在，保存后会形成重复通道并高亮提示。</span>
        </NFormItem>
        <NFormItem label="灯位方位">
          <NSelect :value="form.position" :options="positionOptions" @update:value="handlePositionChange" />
        </NFormItem>
        <NFormItem label="灯具类型">
          <NSelect :value="form.fixtureType" :options="typeOptions" @update:value="handleTypeChange" />
        </NFormItem>
        <NFormItem label="色纸编号">
          <NInput v-model:value="form.gel" placeholder="例如 R02 / L201" />
        </NFormItem>
        <NFormItem label="配接备注">
          <NInput v-model:value="form.patchNote" type="textarea" :rows="3" placeholder="灯号、吊杆位置、调光回路等" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="showModal = false">取消</NButton>
          <NButton type="primary" @click="submitForm">保存</NButton>
        </div>
      </template>
    </NModal>

    <NModal
      v-model:show="showSwapModal"
      preset="card"
      title="彩排前换灯：通道电平转备用通道"
      class="form-modal swap-modal"
      :mask-closable="false"
    >
      <template v-if="swappingFixture">
        <div class="swap-source">
          <span class="swap-source__label">故障通道</span>
          <ChannelChip
            :channel="swappingFixture.channel"
            :position="swappingFixture.position"
            :intensity="averageIntensityOf(swappingFixture.id)"
            :gel="swappingFixture.gel"
            :fixture-type="swappingFixture.fixtureType"
          />
          <span class="swap-source__text">
            {{ swappingFixture.position }} · {{ swappingFixture.fixtureType }}，换灯后退出本场
          </span>
        </div>

        <NForm label-placement="left" label-width="92">
          <NFormItem label="备用通道">
            <NSelect
              v-model:value="swapTargetValue"
              :options="swapOptions"
              filterable
              tag
              clearable
              placeholder="选择本场已配接的通道，或直接输入通道号"
              :create-tag="createSwapTag"
            />
          </NFormItem>
        </NForm>

        <NAlert v-if="swapTargetState.reason" type="warning" :bordered="false" class="alert-line">
          {{ swapTargetState.reason }}
        </NAlert>

        <div v-if="swapPlan && swapTargetState.fixture" class="swap-plan">
          <p class="swap-plan__line">
            原通道 {{ swapPlan.movedCount }} 条电平转到备用通道{{ swapTargetLabel() }}继续使用；
            <template v-if="swapPlan.conflictCount > 0">
              {{ swapPlan.conflictCount }} 条 Cue 两边都设过电平，只留亮度大的那条
              （备用通道更亮保留 {{ swapPlan.targetWinsCount }} 条，原通道更亮顶替 {{ swapPlan.sourceWinsCount }} 条）。
            </template>
            <template v-else>备用通道与原通道没有同 Cue 重复的电平。</template>
          </p>
          <ul v-if="swapConflictItems.length > 0" class="swap-plan__conflicts">
            <li v-for="item in swapConflictItems" :key="item.cueId">
              <span class="mono">{{ item.cueNo }}</span>
              <span :class="item.winner === 'source' ? 'swap-plan__win-source' : 'swap-plan__win-target'">
                保留 {{ item.winner === 'source' ? `原通道 ${item.intensity}%` : `备用通道 ${item.intensity}%` }}
              </span>
              <span class="swap-plan__drop mono">舍弃 {{ item.droppedIntensity }}%</span>
            </li>
          </ul>
          <p class="swap-plan__note">同一 Cue 在同一通道上只保留一份电平（含亮度、色温与对焦说明）。</p>
        </div>

        <NAlert type="info" :bordered="false" class="alert-line" :show-icon="true">
          已生成的排演表照旧留着生成当天的通道号与亮度，不受本次换灯影响。
        </NAlert>
      </template>

      <template #footer>
        <div class="modal-footer">
          <NButton @click="showSwapModal = false">取消</NButton>
          <NButton
            type="primary"
            :loading="swapSubmitting"
            :disabled="!swapTargetState.fixture"
            @click="submitSwap"
          >
            确认换灯
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.toolbar__label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.toolbar__divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.12);
}

.alert-line {
  margin: 0;
}

.load-grid {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.load-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;
}

.load-item--over {
  border-color: rgba(232, 168, 84, 0.7);
  background: rgba(232, 168, 84, 0.12);
  color: #ffd79a;
}

.load-item__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.load-item__count {
  color: rgba(255, 255, 255, 0.6);
}

.group {
  padding: 0;
  overflow: hidden;
}

.group__head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px 18px;
  background: transparent;
  border: none;
  color: inherit;
  font-size: 14px;
  cursor: pointer;
  text-align: left;
}

.group__head:hover {
  background: rgba(255, 255, 255, 0.03);
}

.group__caret {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  transition: transform 0.18s ease;
}

.group__caret--closed {
  transform: rotate(-90deg);
}

.group__dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.group__name {
  font-weight: 600;
}

.group__count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.group__load {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.group__load--over {
  color: #ffd79a;
}

.group__body {
  padding: 4px 18px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.fixture-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 10px;
  transition: background 0.16s ease;
}

.fixture-row:hover {
  background: rgba(255, 255, 255, 0.035);
}

.fixture-row--conflict {
  background: rgba(232, 84, 84, 0.07);
}

.fixture-row__type {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.62);
  min-width: 56px;
}

.fixture-row__note {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-table__head,
.channel-table__row {
  display: grid;
  grid-template-columns: 190px 80px 90px 90px 1fr 196px;
  align-items: center;
  gap: 10px;
  padding: 9px 6px;
  font-size: 13px;
}

.channel-table__head {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.channel-table__row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.channel-table__row--conflict {
  background: rgba(232, 84, 84, 0.07);
}

.channel-table__note {
  color: rgba(255, 255, 255, 0.5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-table__actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}

.channel-picker {
  display: flex;
  align-items: center;
  gap: 12px;
}

.channel-picker__hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.38);
}

.channel-picker__warn {
  font-size: 12px;
  color: #ff9a9a;
  line-height: 1.6;
}

.form-modal {
  width: 520px;
  max-width: 92vw;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.swap-modal {
  width: 560px;
  max-width: 92vw;
}

.swap-source {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  margin-bottom: 14px;
  border-radius: 10px;
  background: rgba(232, 84, 84, 0.07);
  border: 1px solid rgba(232, 84, 84, 0.25);
  font-size: 13px;
}

.swap-source__label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
}

.swap-source__text {
  color: rgba(255, 255, 255, 0.62);
}

.swap-plan {
  margin: 4px 0 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.swap-plan__line {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.78);
}

.swap-plan__conflicts {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.swap-plan__win-source {
  margin: 0 8px;
  color: #ffd79a;
}

.swap-plan__win-target {
  margin: 0 8px;
  color: #9fd0ff;
}

.swap-plan__drop {
  color: rgba(255, 255, 255, 0.4);
}

.swap-plan__note {
  margin: 8px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}
</style>
