/** Human prose is action authority only when it contains a bounded imperative. */
export function configurationCommandText(prompt: string): string | null {
  if (/[`"'“”‘’「」『』]/u.test(prompt)
    || /(?:不要|别|禁止|不能|未要求|例如|比如|假如|假设|如果|分析|讨论|比较|解释|翻译|语法|引用|文档|示例|是否|能否|don't|do not|never|example|hypothetical|\bif\b|analyse|analyze|discuss|compare|explain|translate|quoted?|document)/iu.test(prompt)) return null
  const clauses = prompt.replace(/^(全局|所有作品|所有小说|全部作品)[，,]\s*/u, '$1')
    .split(/([。！？!?\n；;，,])/u)
  const imperative = /^(?:(?:请|麻烦|现在|接下来|以后|后续|全局|所有作品|所有小说|全部作品|please|global|all novels|now)[，,\s]*)*(?:切换(?:到|为)?|换成|改用|使用|改为|用|将.+?(?:切换|设为|改为)|(?:模型|思考强度|写作模式|创作模式|主\s*Agent|子\s*Agent|派生任务|正文写作|写作|连续性(?:检查)?|质量(?:检查)?|创作评审|局部修订|研究综合|风格学习|关系网|发布建议|任务命名|大纲(?:生成)?|章节辅助|封面提示词|导入识别|图片理解).{0,12}(?:用|切换(?:到|为)?|改为|设为)|(?:main|chapter_writing|subagent|spawned_task|continuity|quality|creative_critique|creative_revision|research_synthesis|style_learning|memory_graph|publish_advice|session_title|cover_prompt|import_analysis|vision)\s+(?:use|set|change)\b|(?:switch|use|set|change)\b)/iu
  const commands: string[] = []
  let lastCommandIndex = -2
  // A comma-separated effort modifier belongs only to the immediately preceding
  // command. A new task/model directive never inherits another command's tuple.
  const effortModifier = /^(?:思考强度|推理强度|reasoning(?:\s+effort)?)(?:\s*(?:设为|改为|用|为|to|=))?\s*(?:none|minimal|low|medium|high|xhigh|max|关闭|最低|低|中|中等|高|极高|最高)$/iu
  for (let index = 0; index < clauses.length; index += 2) {
    let clause = clauses[index].trim()
    if (!clause) continue
    const compound = clause.split(/\s*(?:以及|并且|同时|还有|和|并|\band\b)\s*/iu)
    if (compound.length > 1) {
      if (compound.every(part => imperative.test(part))) {
        commands.push(...compound)
        lastCommandIndex = index
        continue
      }
      // Only a single effort modifier has an unambiguous shared model target.
      // Multiple task/model directives require punctuation or clarification.
      if (compound.length !== 2 || !imperative.test(compound[0]) || !effortModifier.test(compound[1])) continue
      clause = `${compound[0]} ${compound[1]}`
    }
    if (commands.length && lastCommandIndex === index - 2 && /^[，,]$/u.test(clauses[index - 1] ?? '') && effortModifier.test(clause)) {
      commands[commands.length - 1] += ` ${clause}`
      lastCommandIndex = index
    } else if (imperative.test(clause)) {
      commands.push(clause)
      lastCommandIndex = index
    }
  }
  return commands.length ? commands.join('；') : null
}

export function isConfigurationCommand(prompt: string): boolean { return configurationCommandText(prompt) !== null }

function windowReferencePattern(target: { id: string; title: string }) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [target.id, target.title].filter(Boolean).map(escape).join('|')
  const quotedName = `["“「]?\\s*(?:${names})\\s*["”」]?`
  return `(?:窗口\\s*${quotedName}|${quotedName}\\s*窗口)`
}
export function stripWindowConfigurationReferences(prompt: string, target: { id: string; title: string }) {
  return prompt.replace(new RegExp(windowReferencePattern(target), 'gu'), '窗口')
}

/** Resolve a named window before applying the ordinary human-command grammar. */
export function windowConfigurationDirectives(prompt: string, target: { id: string; title: string }, currentSessionId: string,
  ownedWindows: ReadonlyArray<{ id: string; title: string }> = [target]) {
  const named = new RegExp(`^(?:(?:请|麻烦)\\s*)?(?:将|把)?${windowReferencePattern(target)}(?:内|中|的)?\\s*`, 'u')
  const prose = ownedWindows.reduce((text, window) => stripWindowConfigurationReferences(text, window), prompt)
  if (/[`"'“”‘’「」『』]/u.test(prose)) return []
  if (/(?:例如|比如|假如|假设|如果|分析|讨论|比较|解释|翻译|语法|引用|文档|示例|是否|能否|example|hypothetical|\bif\b|analyse|analyze|discuss|compare|explain|translate|quoted?|document)/iu.test(prose)) return []
  const current = /^(?:(?:请|麻烦)\s*)?(?:将|把)?(?:当前|本|这个)窗口(?:内|中|的)?\s*/u
  let previousTarget = false
  const fragments = prompt.split(/([。！？!?\n；;，,])/u)
  return fragments.reduce<Array<{ command: string; revoked: boolean }>>((result, clause, index) => {
    if (index % 2) return result
    let command = clause.trim().replace(/^(?:(?:请|麻烦)\s*)+/u, '')
    const negative = /^(?:不要(?:再)?|别|禁止)\s*/u.exec(command)?.[0]
    if (negative) command = command.slice(negative.length)
    const mentionsTarget = named.test(command)
    const mentionsCurrent = current.test(command)
    if (!mentionsTarget && !mentionsCurrent && !previousTarget && /^[，,]$/u.test(fragments[index - 1] ?? '')
      && /^(?:思考强度|推理强度|reasoning|effort)/iu.test(command)) return result
    if (mentionsTarget) command = command.replace(named, '')
    else if (mentionsCurrent && target.id === currentSessionId) command = command.replace(current, '')
    else if (previousTarget && /^[，,]$/u.test(fragments[index - 1] ?? '') && /^(?:思考强度|推理强度|reasoning|effort)/iu.test(command) && !negative) {
      const last = result.at(-1)
      if (last) {
        const combined = configurationDirectives(`${last.command}，${command}`)
        if (combined.length === 1) last.command = combined[0].command
      }
      return result
    } else if (target.id !== currentSessionId || /窗口|会话/u.test(command)) {
      previousTarget = false
      return result
    }
    const directives = configurationDirectives(`${negative ?? ''}${command.replace(/改成/gu, '改为')}`)
    result.push(...directives)
    previousTarget = directives.length > 0
    return result
  }, [])
}

/** Negative authentic controls supersede old authority without authorizing a write. */
export function configurationDirectives(prompt: string): Array<{ command: string; revoked: boolean }> {
  const positive = configurationCommandText(prompt)
  if (positive) return positive.split('；').map(command => ({ command, revoked: false }))
  if (!/(?:不要|别|禁止|don't|do not|never)/iu.test(prompt)) return []
  const stripped = prompt.replace(/(?:不要(?:再)?|别|禁止|don't|do not|never)\s*/giu, '')
  const negative = configurationCommandText(stripped)
  return negative ? negative.split('；').map(command => ({ command, revoked: true })) : []
}
