/** Domain failures remain failures. Recovery must never relax ownership,
 * source revisions, author deletion, or quality gates. */
export function toolFailureRecovery(code: string): { label: string; guidance: string } | undefined {
  const entries: Record<string, { label: string; guidance: string }> = {
    MEMORY_SOURCE_REQUIRED: { label: '记忆来源需要重新核对', guidance: '先用 chapter_read 读取来源章节，使用返回的真实 chapterId 和 revision，再提交逐字原文。不得猜测版本、删除来源字段或改成无来源候选来绕过校验。' },
    MEMORY_EVIDENCE_MISMATCH: { label: '记忆引用与原文不符', guidance: '重新读取来源正文，只引用实际存在的连续原文；摘要、改写和省略号拼接不是原文。找不到依据就保留未完成并向作者说明，不要修改正文来迁就记忆。' },
    MEMORY_DELETED: { label: '作者已删除此记忆', guidance: '不要重试、改名重建或恢复被删除卡片。保留删除状态，其他已授权工作可以继续；确需此记忆时请作者决定。' },
    MEMORY_TARGET_MISSING: { label: '原记忆卡片已失效', guidance: '检索并核对当前记忆卡片，不得去掉 memoryId 后另建一张冒充修订；需要作者确认目标。' },
    CHAPTER_NOT_FOUND: { label: '章节目标不存在或不匹配', guidance: '先读取当前作品目录，使用返回的真实章节 ID；不得沿用其他作品或历史任务的 ID，也不要创建重复章节来绕过。' },
    VOLUME_NOT_FOUND: { label: '分卷目标不存在或不匹配', guidance: '先用 volume_list 核对当前作品的卷 ID 与卷序号；仅在原授权明确需要新卷时创建，不猜测卷编号。' },
    COMPILATION_STAGE_CONFLICT: { label: '章节编译阶段已变化', guidance: '先用 chapter_bridge_get 核对本任务编译和阶段，继续尚未完成的步骤；不得重建编译绕过已有校验。' },
    QUALITY_SOURCE_STALE: { label: '质量检查期间正文已变化', guidance: '保留当前正文，重新读取最新版后检查；旧报告不能提交，也不要覆盖作者刚修改的内容。' },
    CONTINUITY_INPUT_STALE: { label: '连续性检查期间正文已变化', guidance: '重新核对当前正文和编译版本后复核；不能使用旧版结论提交。' },
    STORY_CHARTER_REQUIRED: { label: '尚未建立创作宪章', guidance: '先核对并按原需求建立创作宪章，再执行依赖该宪章的规划步骤。不要反复提交相同参数。' },
  }
  return entries[code]
}
