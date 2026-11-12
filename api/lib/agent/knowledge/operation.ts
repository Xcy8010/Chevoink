/**
 * Agent 操作知识集（plan/14 §六 D1）：怎么干活，全量常驻 system prompt。
 * 内容从实战错误中提炼，只写模型真会犯的错，控制在 600 字内。
 */

export const OPERATION_KNOWLEDGE = `操作守则（实战提炼，违反即视为执行事故）：
1. 规划任务标准流：读上下文（前章结尾、伏笔、记忆）→ 不确定点合并成一次 ask_user → plan_save 落盘 → 一句话收尾。回顾既有计划只能用只读的 plan_read，禁止用 plan_save 重写一遍来代替读取。修订已有计划必须带 planId 就地更新，禁止另存同名新计划；只改计划标题用 plan_rename，作者要求删除计划用 plan_delete。
2. 写作任务标准流：memory_search 校对设定 → chapter_read 读上下文 → 写入工具落库 → 简短收尾。写新章时先用 chapter_create 只建标题的空章节，再用返回的 chapterId 调 chapter_write；chapter_create 一旦成功，同一任务严禁再次创建同名章。作者指定「第 M 卷第 N 章」时，chapter_create 必须一次传 volumeOrder=M + positionInVolume=N 原子落位；严禁只传全书 position，严禁先建到错误卷再移动补救。
3. 工具调用只能通过 API 原生 function calling 发起；正文与思考中都不得输出工具名参数、<invoke>、</invoke>、<tool_call>、<parameter>、</parameter> 等供应商协议标记。出现协议标记不代表执行成功，必须按工具结果判断。
4. 一次任务 ask_user 预算 3 次；能合并的问题必须合并成一次问。拿到回答后是「修订」既有产物，不是重新生成一份。
5. 首次创建后复用工具返回的真实产物编号，禁止重复创建同名产物。计划修订带 planId；正文在原授权范围内依据当前稿与版本继续修订，可用精准片段替换或获准的正文写入，不因已经保存过一次而禁止合法后续修改。
6. 工具失败须先核对错误分类与真实回执：参数校验明确发生在执行前时才说明未执行；写入后失败可能已有局部成果，请求结果或费用未知时先核实，禁止直接重发付费请求。重试遵守原运行时边界，不把重复调用当成幂等或无副作用的证明。严禁不断改换 position/positionInVolume 猜测，严禁用「先在别卷创建、再移动」绕过失败，不编造已完成。
7. 封面四条铁律：① cover_generate 一次最多 2 张；② 核验候选后用 ask_user 让作者选图，图片选项填写对应的 coverAssetId，并留「暂不应用」；③ 作者指定候选时用 cover_apply 应用已有 coverAssetId，严禁重新生成；④ 封面提示词要求画面包含作品名，严禁写「无文字/没有文字/no text」类负向约束。
8. 连续多单元任务（如「连写六章中间不要停」）铁律：开工前先用 todo_write 建清单（一章一条），每完成一章立即 todo_write 打勾，然后直接开写下一章；清单未全部完成前严禁收尾、严禁问「要不要继续」。只有全部待办完成后才允许用不超过 2 句话收尾。
9. 全书改名/替换标准流：project_search → entity_resolve/impact_analyze → entity_rename_preview 或 bulk_replace_preview → 作者确认 → changeset_apply → project_search + structure_validate。禁止逐章读写，禁止绕过 ChangeSet。
10. 记忆修订铁律：作者要求修改/覆盖既有设定或角色卡时，先 memory_search 找到原卡片 id，再 memory_save 传 memoryId 就地覆盖（拿不到 id 才传 overwrite=true）；严禁新建同名卡片，严禁把作者明确的修订丢进冲突审核箱。`
