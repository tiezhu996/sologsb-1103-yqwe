import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { CueLevel } from '@/types/level'
import { INTENSITY_MAX, INTENSITY_MIN } from '@/types/level'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'

/** 通道电平补丁 */
export interface CueLevelPatch {
  intensity?: number
  colorTempK?: number
  focusNote?: string
}

/** 换灯时电平转移的统计结果 */
export interface LevelTransferResult {
  /** 直接转移到备用通道的条数 */
  moved: number
  /** 与备用通道已有电平合并的条数（保留亮度大者） */
  merged: number
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
   * 换灯：把源通道的全部电平转移到备用通道。
   * 同一条 Cue 两边都设过电平时只保留亮度大的一条（色温、对焦说明跟随被保留的记录），
   * 保证同一 Cue 在同一通道上不留两份电平。
   */
  async function transferLevels(fromFixtureId: string, toFixtureId: string): Promise<LevelTransferResult> {
    const sources = levels.value.filter((level) => level.fixtureId === fromFixtureId)
    const result: LevelTransferResult = { moved: 0, merged: 0 }
    if (sources.length === 0) return result

    const now = Date.now()
    const puts: CueLevel[] = []
    const deletes: string[] = []

    sources.forEach((source) => {
      const target = levelOf(source.cueId, toFixtureId)
      if (!target) {
        puts.push({ ...source, fixtureId: toFixtureId, updatedAt: now })
        result.moved += 1
        return
      }
      result.merged += 1
      if (source.intensity > target.intensity) {
        // 源通道这条更亮：其设定顶到备用通道上，备用通道原记录让位
        puts.push({ ...source, fixtureId: toFixtureId, updatedAt: now })
        deletes.push(target.id)
      } else {
        // 备用通道已有记录不弱于源：保留备用通道的，丢弃源记录
        deletes.push(source.id)
      }
    })

    await db.transaction('rw', db.levels, async () => {
      if (deletes.length > 0) await db.levels.bulkDelete(deletes)
      if (puts.length > 0) await db.levels.bulkPut(puts)
    })

    const removed = new Set(deletes)
    const replaced = new Set(puts.map((level) => level.id))
    levels.value = [...levels.value.filter((level) => !removed.has(level.id) && !replaced.has(level.id)), ...puts]
    return result
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
    removeByCues,
    transferLevels
  }
})
