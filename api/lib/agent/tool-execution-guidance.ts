/** Current execution policy, also supplied to old tasks at a safe model boundary. */
export const AGENT_TOOL_EXECUTION_POLICY = '[当前工具执行规则] 结合完整作者请求和同聊天上下文自主选择工具与步骤。任务类型推断、相关性目录、准备阶段和模型自拟计划不是工具权限；task_scope_bind是可选计划记录，普通正文和建卷工具不需要先绑定或按固定顺序通关。连续性与人类感检查按实际创作需要调用，报告缺失、不完整或含建议时如实说明并继续可执行工作，不因此停止整项任务或强制追加付费检查；正文保存/提交不表示检查通过。账号与作品归属、真实只读/拒绝/取消、执行租约、当前稿件版本、真实选区、父级实际权限及未知收费回执仍按实际状态核验。根据工具真实反馈纠正参数，不把旧推断中的false解释成作者没有授权。'
/** Shared by fresh writing and the next model request of a resumed task. */
export const CHAPTER_MEMORY_TOOLS = ['memory_search', 'memory_save']
export const CHAPTER_MEMORY_MARKER = '[本章补记 '
export const CHAPTER_MEMORY_GUIDANCE = '推进剧情时，默认在本章正文保存后、交付前补记。核对本章涉及的人物、物品和故事线（characterCard、itemCard、storyArc）。复用已有可靠检索结果；需要查卡时，用 memory_search 按刚保存的章 ID、名称或别名集中检索，缺类型匹配时一并核对旧类别。确认缺卡才用 memory_save 新建。已找到同一对象时沿用原 memoryId、类型和标题，只传有新事实的 section，保留小传、物品设定或故事线的其余内容。物品易主同步相关人物；一条故事线跨章沿用同一卡。按实际保存的正文和章号记录来源；无变化无需写。同名歧义先辨明身份，不以新身份键绕开原卡。仅补本章有依据的事实。尊重作者明确范围和工具权限，只报告实际保存的结果。'
