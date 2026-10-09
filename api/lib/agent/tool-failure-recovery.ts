/** Retry identity follows the failed operation and target, not a reformulated
 * manuscript or a different writer tool. Actual saved progress resets it. */
export function toolRecoveryKey(action: string, code: string, args: unknown, fallbackChapterId?: string | null): string {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const manuscript = ['chapter_write', 'chapter_edit_range', 'chapter_append'].includes(action)
  const target = ['chapterId', 'compilationId', 'memoryId', 'volumeId', 'taskId']
    .map(key => value[key]).find(item => typeof item === 'string' && item.trim())
    ?? (manuscript ? fallbackChapterId : null) ?? null
  return JSON.stringify([manuscript ? 'chapter-manuscript' : action, code, typeof target === 'string' ? target.trim() : target])
}

/** Domain failures remain failures. Recovery must never relax ownership,
 * source revisions, author deletion, or quality gates. */
export function toolFailureRecovery(code: string): { label: string; guidance: string } | undefined {
  const entries: Record<string, { label: string; guidance: string }> = {
    INVALID_ARGUMENTS: { label: '工具参数需要纠正', guidance: '本次输入未执行。按具体字段含义纠正参数；同一调用中的章节编号、全书位置和卷内位置必须一致，不能只修改说明文字或重复发送同一冲突输入。原授权、已保存结果和预算保留。' },
    TASK_WAIT_TARGET_NOT_FOUND: { label: '等待窗口不存在或不属于当前作者', guidance: '本次未获得该窗口交付。任务身份和章节编译编号不是派生窗口编号；仅使用本任务实际派生工具返回的窗口编号。没有派生窗口就直接执行当前原任务，不能等待虚构窗口或把失败当作完成。' },
    TASK_WAIT_TARGET_INVALID: { label: '等待窗口身份无效', guidance: '不能等待当前窗口自身或把任务身份当作窗口身份。仅等待本任务实际派生且获授权的窗口；没有窗口时继续当前原任务的必要步骤。' },
    COMPILATION_NOT_FOUND: { label: '未找到本任务章节编译', guidance: '章节编号不是编译编号。使用本任务真实编译编号；本任务尚未准备时按冻结目标准备，再构建场景并保存正文。不要恢复历史旧章、猜编号或重复创建已存在编译。' },
    COMPILATION_IDENTITY_MISMATCH: { label: '章节编译身份不匹配', guidance: '本次操作未执行。显式编号不会被自动替换；核对本任务已保存的真实编译状态，使用返回的编译编号继续该目标的缺失步骤，不能借旧章或其他任务完成当前任务。' },
    COMPILATION_NOT_WRITTEN: { label: '本任务章节正文尚未保存', guidance: '准备和场景计划不等于正文。保留当前编译与场景，按冻结目标创建或复用已绑定章节，然后写入非空正文，再完成当前版本的必要检查和终态提交。' },
    REVIEW_MERGED_REVISION_REQUIRED: { label: '修订依据需要核对', guidance: '本次修改被拒绝，未写入。按具体拒绝原因核对当前报告绑定和留置意见；quality findingId 必须使用报告返回的真实编号，不能用序号代替。普通正文编辑可在原授权范围内分步调用 chapter_edit_range 或 chapter_write，批量合并只是建议；不要只换工具或重复读取相同正文来重试同一拒绝，也不能把保存修订当作新版检查通过。' },
    REVIEW_DECISION_REQUIRED: { label: '检查意见需要明确处理', guidance: '检查完成与意见处置是两个状态。按提交结果给出的当前引用逐项处理；不能安全修改的意见直接在 chapter_bridge_commit 的 retainedFindings 中填写 source、reportId、真实 findingId 和具体保留理由。chapter_bridge_get 可读取待处理引用；quality findingId 不能用序号代替。正文不变且检查仍匹配时无需再次检查；只有实际改稿才复核最终版本。保留理由不表示修复或检查通过。' },
    REVIEW_REPAIR_RECHECK_REQUIRED: { label: '需要复核当前版本', guidance: '已保存正文保留，旧报告不能认证新版。普通编辑可在原授权范围内继续，提交前在既有检查次数内复核最终正文；检查次数用尽时如实说明当前版本尚未完成检查，不要重置次数、重绑旧报告或反复调用已耗尽的检查。' },
    CHAPTER_ANCHOR_CONFLICT: { label: '正文片段需要重新定位', guidance: '查看错误给出的失败片段序号。仅对本次原目标调用 chapter_read，逐字使用当前版本中的唯一连续原文；段落换行可确定定位，其他文字必须一致。纠正失败片段后可继续提交，不能重复相同坏参数；必要时在原正文写入授权和当前版本内提交完整修订。不要猜测其他章节 ID、替换到其他章节或照旧报告强行写入。' },
    TODO_CHANGE_REASON_REQUIRED: { label: '待办需要保留原项目身份', guidance: '读取当前清单，更新时保留原 id。确有新增的原授权工作请给出 changeReason，不重建整张清单或扩大章节范围。' },
    CONTINUITY_CHECK_REQUIRED: { label: '当前版本尚未完成连续性检查', guidance: '先完成当前正文的 continuity_validate，保留现有编译和检查次数，不能把缺报告视为通过。' },
    CONTINUITY_EVIDENCE_UNLOCATED: { label: '检查引用需要核对', guidance: '报告引用未在对应当前正文中定位，不能照旧引文改稿，也不能判定通过。保留正文和报告，核对本任务当前原文；原写作授权内可继续纠正确有原文依据的问题，再在原检查预算内复核最终版。不得反复提交同一检查或重置次数。' },
    CONTINUITY_REPORT_INCOMPLETE: { label: '连续性报告未完成', guidance: '报告未完整返回，不能判定通过。保留正文、报告、已用次数和费用；先核对真实结果，原授权内其他工作可继续。不得重放未知付费请求或重置预算。' },
    QUALITY_CHECK_REQUIRED: { label: '当前版本尚未完成人类感检查', guidance: '先完成当前正文的 quality_analyze，不能省略检查、引用旧版报告或宣称修订本身就是检查通过。' },
    AUTHOR_CHAPTER_SCOPE: { label: '章节目标或位置与原请求不符', guidance: '本次操作未执行，目标或位置不符不表示任务已结束。先核对原始请求和当前作品目录，仅在现有授权范围内纠正目标或位置；全书位置与卷内位置不得混用，不要猜卷坐标、另建重复章或扩大范围。重试、换工具、改参数、子任务或续跑都不能扩大授权；需要处理其他章节时，请作者在输入框重新发送一条写明目标章节的明确指令，系统将按新任务受理。任务已暂停、结束或授权不匹配时不得继续。' },
    SCOPE_NEEDS_INPUT: { label: '原任务缺少可证明的章节目标', guidance: '原请求的目标章节无法证明，本次未写入任何章节。用 ask_user 如实说明并请作者明确要处理的章节；在作者给出明确指令前不要按当前界面位置、历史记录或猜测的章节自行写入。作者在输入框新发写明章节的指令后，系统按新任务受理。' },
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
