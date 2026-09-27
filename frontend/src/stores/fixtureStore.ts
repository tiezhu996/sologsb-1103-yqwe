import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Fixture, FixtureDraft, FixturePosition, PatchCheckResult } from '@/types/fixture'
import { DMX_CHANNEL_MAX, DMX_CHANNEL_MIN } from '@/types/fixture'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { buildPatchCheck, emptyPatchCheck, groupFixturesByPosition, sortFixturesByChannel } from '@/utils/patch'
import type { RelampPlan } from '@/utils/relamp'
import { useLevelStore } from '@/stores/levelStore'

/** Fixture 可更新字段 */
export type FixturePatch = Partial<Omit<Fixture, 'id' | 'sessionId' | 'createdAt'>>

/** 写入灯位通道的结果 */
export interface FixtureWriteResult {
  ok: boolean
  message: string
  fixture: Fixture | null
}

/** 换灯结果：携带电平合并计划，供页面汇总提示 */
export interface RelampResult {
  ok: boolean
  message: string
  /** 失败原因（页面在选不到本场备用通道时直接展示） */
  reason: string | null
  plan: RelampPlan | null
  source: Fixture | null
  target: Fixture | null
}

function validateChannel(channel: number): string | null {
  if (!Number.isInteger(channel)) return '通道号必须为整数'
  if (channel < DMX_CHANNEL_MIN || channel > DMX_CHANNEL_MAX) {
    return `通道号需在 ${DMX_CHANNEL_MIN}-${DMX_CHANNEL_MAX} 之间`
  }
  return null
}

/**
 * 灯位通道仓库：维护配接记录、按灯位分组结果与配接校验结果（冲突 / 过载）。
 */
export const useFixtureStore = defineStore('fixture', () => {
  const fixtures = ref<Fixture[]>([])
  /** 各场次的配接校验结果，跨页共享 */
  const patchChecks = ref<Record<string, PatchCheckResult>>({})
  const hydrated = ref(false)

  const fixturesBySession = computed<Record<string, Fixture[]>>(() => {
    const grouped: Record<string, Fixture[]> = {}
    fixtures.value.forEach((fixture) => {
      if (!grouped[fixture.sessionId]) grouped[fixture.sessionId] = []
      grouped[fixture.sessionId].push(fixture)
    })
    return grouped
  })

  function fixturesOfSession(sessionId: string): Fixture[] {
    return fixturesBySession.value[sessionId] ?? []
  }

  function sortedFixturesOfSession(sessionId: string): Fixture[] {
    return sortFixturesByChannel(fixturesOfSession(sessionId))
  }

  function groupedFixturesOfSession(sessionId: string): Array<{ position: FixturePosition; fixtures: Fixture[] }> {
    return groupFixturesByPosition(fixturesOfSession(sessionId))
  }

  function fixtureById(id: string): Fixture | null {
    return fixtures.value.find((fixture) => fixture.id === id) ?? null
  }

  function usedChannels(sessionId: string): number[] {
    return sortedFixturesOfSession(sessionId).map((fixture) => fixture.channel)
  }

  /** 读取配接校验结果；尚未校准时即时计算并缓存 */
  function patchCheckOf(sessionId: string): PatchCheckResult {
    const cached = patchChecks.value[sessionId]
    if (cached) return cached
    const result = fixturesOfSession(sessionId).length === 0 ? emptyPatchCheck() : buildPatchCheck(fixturesOfSession(sessionId))
    patchChecks.value = { ...patchChecks.value, [sessionId]: result }
    return result
  }

  /** 用外部 hooks 计算的结果覆盖缓存 */
  function applyPatchCheck(sessionId: string, result: PatchCheckResult): void {
    patchChecks.value = { ...patchChecks.value, [sessionId]: result }
  }

  async function hydrate(): Promise<void> {
    fixtures.value = await db.fixtures.toArray()
    hydrated.value = true
  }

  async function addFixture(draft: FixtureDraft): Promise<FixtureWriteResult> {
    const channelError = validateChannel(draft.channel)
    if (channelError) return { ok: false, message: channelError, fixture: null }
    const now = Date.now()
    const created: Fixture = {
      id: createId('fix'),
      sessionId: draft.sessionId,
      channel: draft.channel,
      position: draft.position,
      fixtureType: draft.fixtureType,
      gel: draft.gel,
      patchNote: draft.patchNote,
      createdAt: now,
      updatedAt: now
    }
    await db.fixtures.put(created)
    fixtures.value = [...fixtures.value, created]
    applyPatchCheck(draft.sessionId, buildPatchCheck(fixturesOfSession(draft.sessionId)))
    return {
      ok: true,
      message: `已配接 CH${created.channel}`,
      fixture: created
    }
  }

  async function updateFixture(id: string, patch: FixturePatch): Promise<FixtureWriteResult> {
    const target = fixtureById(id)
    if (!target) return { ok: false, message: '灯位通道不存在', fixture: null }
    if (patch.channel !== undefined) {
      const channelError = validateChannel(patch.channel)
      if (channelError) return { ok: false, message: channelError, fixture: null }
    }
    const next: Fixture = { ...target, ...patch, updatedAt: Date.now() }
    await db.fixtures.put(next)
    fixtures.value = fixtures.value.map((fixture) => (fixture.id === id ? next : fixture))
    applyPatchCheck(target.sessionId, buildPatchCheck(fixturesOfSession(target.sessionId)))
    return { ok: true, message: `已更新 CH${next.channel}`, fixture: next }
  }

  async function removeFixture(id: string): Promise<void> {
    const target = fixtureById(id)
    if (!target) return
    const levelStore = useLevelStore()
    await db.fixtures.delete(id)
    fixtures.value = fixtures.value.filter((fixture) => fixture.id !== id)
    await levelStore.removeByFixture(id)
    applyPatchCheck(target.sessionId, buildPatchCheck(fixturesOfSession(target.sessionId)))
  }

  /**
   * 彩排前换灯：把故障通道（sourceFixtureId）已设好的电平转到本场已配接的备用通道
   * （targetFixtureId）上接着用，两边都设过电平的只留亮度大的，随后原通道退出本场。
   * 已生成的排演表是生成时刻快照，不在此动作的影响范围内。
   */
  async function relampFixture(sourceFixtureId: string, targetFixtureId: string): Promise<RelampResult> {
    const source = fixtureById(sourceFixtureId)
    if (!source) {
      return { ok: false, message: '原通道不存在或已退出本场', reason: '原通道不存在或已退出本场', plan: null, source: null, target: null }
    }
    const target = fixtureById(targetFixtureId)
    if (!target) {
      return {
        ok: false,
        message: '备用通道在本场没有配过灯，换灯不生效',
        reason: '该备用通道在本场没有配过灯：请先在本场完成配接，或改选已配接的通道作为备用通道。',
        plan: null,
        source,
        target: null
      }
    }
    if (target.sessionId !== source.sessionId) {
      return {
        ok: false,
        message: '备用通道不在本场，换灯不生效',
        reason: '该通道没有配在本场，不能作为本场的备用通道。',
        plan: null,
        source,
        target
      }
    }
    if (target.id === source.id) {
      return {
        ok: false,
        message: '备用通道不能与原通道相同',
        reason: '备用通道不能与原通道相同，请选择其他通道。',
        plan: null,
        source,
        target
      }
    }

    const levelStore = useLevelStore()
    const finalPlan = await db.transaction('rw', [db.fixtures, db.levels], async () => {
      const plan = await levelStore.relocateLevelsForFixture(source.id, target.id)
      await db.fixtures.delete(source.id)
      return plan
    })
    fixtures.value = fixtures.value.filter((fixture) => fixture.id !== source.id)
    applyPatchCheck(source.sessionId, buildPatchCheck(fixturesOfSession(source.sessionId)))

    const summary =
      finalPlan.conflictCount > 0
        ? `CH${source.channel} 已退出本场，${finalPlan.movedCount} 条电平转到 CH${target.channel}，${finalPlan.conflictCount} 条两边都设过、已保留亮度大的`
        : `CH${source.channel} 已退出本场，${finalPlan.movedCount} 条电平转到 CH${target.channel}`
    return { ok: true, message: summary, reason: null, plan: finalPlan, source, target }
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const targets = fixturesOfSession(sessionId)
    if (targets.length === 0) return
    await db.fixtures.bulkDelete(targets.map((fixture) => fixture.id))
    fixtures.value = fixtures.value.filter((fixture) => fixture.sessionId !== sessionId)
    patchChecks.value = { ...patchChecks.value, [sessionId]: emptyPatchCheck() }
  }

  return {
    fixtures,
    patchChecks,
    hydrated,
    fixturesBySession,
    fixturesOfSession,
    sortedFixturesOfSession,
    groupedFixturesOfSession,
    fixtureById,
    usedChannels,
    patchCheckOf,
    applyPatchCheck,
    hydrate,
    addFixture,
    updateFixture,
    removeFixture,
    relampFixture,
    removeBySession
  }
})
