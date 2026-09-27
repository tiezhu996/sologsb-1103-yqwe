import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CueLevel } from '@/types/level'
import { INTENSITY_MAX, INTENSITY_MIN } from '@/types/level'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { buildRelampPlan, type RelampPlan } from '@/utils/relamp'

/** 通道电平补丁 */
export interface CueLevelPatch {
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

function clampIntensity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(INTENSITY_MAX, Math.max(INTENSITY_MIN, Math.round(value)))
}

/**
 * CueLevel 通道电平仓库：按 (cueId, fixtureId) 唯一，跨页共享电平设定。
 */
export const useLevelStore = defineStore('level', () => {
  const levels = ref<CueLevel[]>([])
  const hydrated = ref(false)

  const levelsByCue = computed<Record<string, CueLevel[]>>(() => {
    const grouped: Record<string, CueLevel[]> = {}
    levels.value.forEach((level) => {
      if (!grouped[level.cueId]) grouped[level.cueId] = []
      grouped[level.cueId].push(level)
    })
    return grouped
  })

  function levelsOfCue(cueId: string): CueLevel[] {
    return levelsByCue.value[cueId] ?? []
  }

  function levelOf(cueId: string, fixtureId: string): CueLevel | null {
    return levels.value.find((level) => level.cueId === cueId && level.fixtureId === fixtureId) ?? null
  }

  /** 通道平均亮度，用于灯位配置台展示通道芯片的亮度 */
  function averageIntensityOfFixture(fixtureId: string): number | null {
    const matched = levels.value.filter((level) => level.fixtureId === fixtureId)
    if (matched.length === 0) return null
    const total = matched.reduce((sum, level) => sum + level.intensity, 0)
    return Math.round(total / matched.length)
  }

  function countOfCue(cueId: string): number {
    return levelsOfCue(cueId).length
  }

  async function hydrate(): Promise<void> {
    levels.value = await db.levels.toArray()
    hydrated.value = true
  }

  async function upsertLevel(cueId: string, fixtureId: string, patch: CueLevelPatch): Promise<CueLevel> {
    const existing = levelOf(cueId, fixtureId)
    const now = Date.now()
    if (existing) {
      const next: CueLevel = {
        ...existing,
        intensity: patch.intensity === undefined ? existing.intensity : clampIntensity(patch.intensity),
        colorTempK: patch.colorTempK === undefined ? existing.colorTempK : Math.round(patch.colorTempK),
        focusNote: patch.focusNote === undefined ? existing.focusNote : patch.focusNote,
        updatedAt: now
      }
      await db.levels.put(next)
      levels.value = levels.value.map((level) => (level.id === next.id ? next : level))
      return next
    }
    const created: CueLevel = {
      id: createId('lvl'),
      cueId,
      fixtureId,
      intensity: clampIntensity(patch.intensity ?? 0),
      colorTempK: Math.round(patch.colorTempK ?? 3200),
      focusNote: patch.focusNote ?? '',
      updatedAt: now
    }
    await db.levels.put(created)
    levels.value = [...levels.value, created]
    return created
  }

  async function removeLevel(cueId: string, fixtureId: string): Promise<void> {
    const target = levelOf(cueId, fixtureId)
    if (!target) return
    await db.levels.delete(target.id)
    levels.value = levels.value.filter((level) => level.id !== target.id)
  }

  async function removeByCue(cueId: string): Promise<void> {
    const ids = levelsOfCue(cueId).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => level.cueId !== cueId)
  }

  async function removeByFixture(fixtureId: string): Promise<void> {
    const ids = levels.value.filter((level) => level.fixtureId === fixtureId).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => level.fixtureId !== fixtureId)
  }

  /**
   * 换灯：把源灯位的全部电平合并到备用灯位（同一 Cue 两边都设过时只留亮度大的），
   * 随后删除源灯位剩余电平。levels 表在单事务内改写，避免半完成状态。
   */
  async function relocateLevelsForFixture(sourceFixtureId: string, targetFixtureId: string): Promise<RelampPlan> {
    const sourceLevels = levels.value.filter((level) => level.fixtureId === sourceFixtureId)
    const targetLevels = levels.value.filter((level) => level.fixtureId === targetFixtureId)
    const plan = buildRelampPlan(sourceLevels, targetLevels)
    const now = Date.now()

    const toPut: CueLevel[] = []
    const toDelete: string[] = []
    plan.items.forEach((item) => {
      if (item.conflict) {
        // 两边都设过：留一条（沿用其原记录主键），删另一条
        if (item.conflict.winner === 'source') {
          toPut.push({ ...(item.winnerLevel as CueLevel), fixtureId: targetFixtureId, updatedAt: now })
          const targetLevel = targetLevels.find((level) => level.cueId === item.cueId)
          if (targetLevel) toDelete.push(targetLevel.id)
        } else {
          const sourceLevel = sourceLevels.find((level) => level.cueId === item.cueId)
          if (sourceLevel) toDelete.push(sourceLevel.id)
        }
      } else if (item.winnerLevel?.fixtureId === sourceFixtureId) {
        // 仅源通道设过：整条转到备用通道
        toPut.push({ ...item.winnerLevel, fixtureId: targetFixtureId, updatedAt: now })
      }
    })
    // 理论上源通道的电平均已在计划中处置，这里兜底删除其余残留
    sourceLevels.forEach((level) => {
      if (!toPut.some((item) => item.id === level.id) && !toDelete.includes(level.id)) {
        toDelete.push(level.id)
      }
    })

    await db.transaction('rw', db.levels, async () => {
      // 先删后写，避免同 (cueId, fixtureId) 在事务内短暂出现两条
      if (toDelete.length > 0) await db.levels.bulkDelete(toDelete)
      if (toPut.length > 0) await db.levels.bulkPut(toPut)
    })
    levels.value = await db.levels.toArray()
    return plan
  }

  async function removeByCues(cueIds: readonly string[]): Promise<void> {
    const removing = new Set(cueIds)
    const ids = levels.value.filter((level) => removing.has(level.cueId)).map((level) => level.id)
    if (ids.length === 0) return
    await db.levels.bulkDelete(ids)
    levels.value = levels.value.filter((level) => !removing.has(level.cueId))
  }

  return {
    levels,
    hydrated,
    levelsByCue,
    levelsOfCue,
    levelOf,
    averageIntensityOfFixture,
    countOfCue,
    hydrate,
    upsertLevel,
    removeLevel,
    removeByCue,
    removeByFixture,
    relocateLevelsForFixture,
    removeByCues
  }
})
