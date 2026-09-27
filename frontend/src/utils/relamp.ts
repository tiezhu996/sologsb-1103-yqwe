import type { CueLevel } from '@/types/level'

/**
 * 彩排前临时换灯：把故障通道（源灯位）上已设好的通道电平转到备用通道（目标灯位）。
 * 规则：
 * - 同一条 Cue 只在源通道设过电平：整条电平（亮度 / 色温 / 对焦说明）转到备用通道，保持每 Cue 每通道仅一份；
 * - 同一条 Cue 两边都设过电平：只保留亮度大的那条（连同其色温与对焦说明）；
 * - 亮度相等时保留备用通道原有电平（备用灯具自身的设定优先，且结果不依赖遍历顺序）。
 */

/** 合并后保留的电平来自哪一侧 */
export type RelampWinner = 'source' | 'target'

/** 同一 Cue 两边都设过电平时的二选一明细 */
export interface RelampConflict {
  cueId: string
  /** 保留下来的亮度 */
  intensity: number
  /** 最终保留的电平来自哪一侧 */
  winner: RelampWinner
  /** 被舍弃一侧的亮度 */
  droppedIntensity: number
}

/** 换灯后单条 Cue 电平的处置方式 */
export interface RelampPlanItem {
  cueId: string
  /** 备用通道上最终生效的电平（仅在源或目标任一侧存在电平时有值） */
  winnerLevel: CueLevel | null
  /** 两边都设过电平时的二选一明细；仅源侧有时为 null */
  conflict: RelampConflict | null
}

/** 一次换灯的完整合并计划与汇总计数 */
export interface RelampPlan {
  items: RelampPlanItem[]
  /** 仅源通道设过、直接转到备用通道的条数 */
  movedCount: number
  /** 两边都设过、按亮度取大的条数 */
  conflictCount: number
  /** 取大时源通道亮度更高、由源通道顶替的条数 */
  sourceWinsCount: number
  /** 取大时备用通道亮度更高（含相等）、维持备用通道的条数 */
  targetWinsCount: number
}

/**
 * 依据源 / 目标通道各自的电平（建议已按 cueId 收敛为每 Cue 一条）计算合并计划。
 * 纯函数，不落库、不改写入参。
 */
export function buildRelampPlan(sourceLevels: readonly CueLevel[], targetLevels: readonly CueLevel[]): RelampPlan {
  const targetByCue = new Map<string, CueLevel>()
  targetLevels.forEach((level) => targetByCue.set(level.cueId, level))

  const items: RelampPlanItem[] = []
  let movedCount = 0
  let conflictCount = 0
  let sourceWinsCount = 0
  let targetWinsCount = 0

  const handledCueIds = new Set<string>()

  sourceLevels.forEach((sourceLevel) => {
    handledCueIds.add(sourceLevel.cueId)
    const targetLevel = targetByCue.get(sourceLevel.cueId)
    if (!targetLevel) {
      items.push({ cueId: sourceLevel.cueId, winnerLevel: sourceLevel, conflict: null })
      movedCount += 1
      return
    }

    // 两边都设过：只留亮度大的；相等时保留备用通道原有设定
    const sourceWins = sourceLevel.intensity > targetLevel.intensity
    const winnerLevel = sourceWins ? sourceLevel : targetLevel
    items.push({
      cueId: sourceLevel.cueId,
      winnerLevel,
      conflict: {
        cueId: sourceLevel.cueId,
        intensity: winnerLevel.intensity,
        winner: sourceWins ? 'source' : 'target',
        droppedIntensity: sourceWins ? targetLevel.intensity : sourceLevel.intensity
      }
    })
    conflictCount += 1
    if (sourceWins) sourceWinsCount += 1
    else targetWinsCount += 1
  })

  // 仅备用通道设过电平的 Cue：原样保留
  targetLevels.forEach((targetLevel) => {
    if (handledCueIds.has(targetLevel.cueId)) return
    items.push({ cueId: targetLevel.cueId, winnerLevel: targetLevel, conflict: null })
  })

  items.sort((a, b) => a.cueId.localeCompare(b.cueId))

  return { items, movedCount, conflictCount, sourceWinsCount, targetWinsCount }
}
