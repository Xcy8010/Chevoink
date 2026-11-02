import { jsonrepair } from 'jsonrepair'

/** Execution repair may change JSON syntax, never supply a missing value or
 * close a partial business payload. Compare all non-comma tokens after repair. */
function parseCompleteToolArgs(raw: string): unknown {
  const firstObject = raw.indexOf('{'), firstArray = raw.indexOf('[')
  const first = firstObject < 0 ? firstArray : firstArray < 0 ? firstObject : Math.min(firstObject, firstArray)
  if (first < 0) throw new Error('工具参数结构不完整')
  const last = raw.lastIndexOf(raw[first] === '{' ? '}' : ']')
  if (last < first) throw new Error('工具参数结构不完整')
  // Ignore prose/fence wrappers, not strings inside the actual argument object.
  const suffix = raw.slice(last + 1)
  if (/[{}[\]"':,]/.test(suffix)) throw new Error('工具参数尾部存在未完成业务字段')
  const input = raw.slice(first, last + 1)
  let normalized = ''
  for (let index = 0; index < input.length; index++) {
    const quote = input[index]
    if (quote !== '"' && quote !== "'") { normalized += quote; continue }
    let value = '', closed = false
    for (index++; index < input.length; index++) {
      const char = input[index]
      if (char === quote) { closed = true; break }
      if (char !== '\\') { value += char; continue }
      const escaped = input[++index]
      if (quote === "'" && escaped === "'") { value += "'"; continue }
      const length = escaped === 'u' ? 5 : 1
      if (!escaped || !'"\\/bfnrtu'.includes(escaped)
        || escaped === 'u' && !/^[a-f0-9]{4}$/i.test(input.slice(index + 1, index + 5))) throw new Error('参数无法解析为 JSON')
      value += JSON.parse('"\\' + input.slice(index, index + length) + '"') as string
      index += length - 1
    }
    if (!closed) throw new Error('工具参数结构不完整')
    normalized += JSON.stringify(value)
  }
  const tokens = (source: string): string[] => {
    const result: string[] = [], stack: string[] = []
    const pattern = /\s+|"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]:,]|\S/g
    let closed = false, previous = ''
    for (const match of source.matchAll(pattern)) {
      const token = match[0]
      if (!token.trim()) continue
      if (closed) throw new Error('参数包含多个或不完整的 JSON 对象')
      if (token === '{' || token === '[') stack.push(token === '{' ? '}' : ']')
      else if (token === '}' || token === ']') {
        if (stack.pop() !== token) throw new Error('工具参数结构不完整')
        closed = stack.length === 0
      } else if (!stack.length) throw new Error('工具参数结构不完整')
      if (token === ',') {
        if (['{', '[', ':', ','].includes(previous)) throw new Error('工具参数存在缺失字段或数组项')
        previous = token
        continue
      }
      previous = token
      if (token.startsWith('"')) result.push(JSON.stringify(['string', JSON.parse(token)]))
      else if (/^(?:[{}[\]:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) result.push(token)
      else throw new Error('参数无法解析为 JSON')
    }
    if (!closed || stack.length) throw new Error('工具参数结构不完整')
    return result
  }
  const before = tokens(normalized)
  const repaired = jsonrepair(normalized)
  if (JSON.stringify(before) !== JSON.stringify(tokens(repaired))) throw new Error('参数修复不能补造或改写业务内容')
  return JSON.parse(repaired)
}

/** 容错 JSON 解析：模型生成长正文参数时最常见的三类毛病可自动修复，
 * 避免一整章内容因一个未转义换行符就全部作废重写：
 * 1. 字符串内部出现未转义的控制字符（真换行/制表符）
 * 2. 参数被 ```json 围栏或前后多余文本包裹
 * 3. 输出被 length 截断导致字符串/花括号未闭合 */
export function parseToolArgsTolerant(raw: string, allowTruncation = true): unknown {
  // Normal calls stay linear and byte-for-byte intact. Repair full syntax before any legacy truncation fallback.
  try { return JSON.parse(raw) } catch { /* syntax repair below */ }
  if (!allowTruncation) return parseCompleteToolArgs(raw)
  if (/[}\]]\s*$/.test(raw)) {
    try { return JSON.parse(jsonrepair(raw)) } catch { /* legacy compatibility below */ }
  }
  const attempts: string[] = [raw]

  // 剥离 Markdown 围栏与前后多余文本：取第一个 { 到最后一个 } 之间
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first > 0 || (first >= 0 && last >= 0 && last < raw.length - 1)) {
    attempts.push(raw.slice(first, last + 1))
  }

  // 转义字符串内部的裸控制字符（逐字符扫描，只在引号内替换，不破坏结构性空白）
  const escapeControlChars = (input: string): string => {
    let out = ''
    let inString = false
    for (let i = 0; i < input.length; i++) {
      const char = input[i]
      if (inString) {
        if (char === '\\' && i + 1 < input.length) {
          out += char + input[i + 1]
          i += 1
          continue
        }
        if (char === '"') {
          inString = false
          out += char
          continue
        }
        if (char === '\n') {
          out += '\\n'
          continue
        }
        if (char === '\r') {
          out += '\\r'
          continue
        }
        if (char === '\t') {
          out += '\\t'
          continue
        }
        out += char
        continue
      }
      if (char === '"') {
        inString = true
      }
      out += char
    }
    return out
  }

  for (const candidate of [...attempts]) {
    attempts.push(escapeControlChars(candidate))
  }

  // 截断修复：扫描未闭合的字符串与括号栈，补齐后再试
  const repairTruncated = (input: string): string => {
    let inString = false
    const stack: string[] = []
    for (let i = 0; i < input.length; i++) {
      const char = input[i]
      if (inString) {
        if (char === '\\') {
          i += 1
        } else if (char === '"') {
          inString = false
        }
        continue
      }
      if (char === '"') {
        inString = true
      } else if (char === '{' || char === '[') {
        stack.push(char === '{' ? '}' : ']')
      } else if (char === '}' || char === ']') {
        stack.pop()
      }
    }
    let repaired = input
    if (inString) {
      repaired += '"'
    }
    while (stack.length > 0) {
      repaired += stack.pop()
    }
    return repaired
  }

  // 深度截断修复：朴素补括号救不了截断留下的悬垂逗号/冒号/悬垂键/尾部孤反斜杠
  // （如 {...,"mode": 或 {"a":"x\ 截断），这些残尾会让补完后的 JSON 依旧非法
  const repairTruncatedDeep = (input: string): string => {
    let inString = false
    let stringStart = -1
    let prevSignificant = ''
    // 对象上下文里「已闭合但还没等到冒号/值」的键起点：EOF 时仍是悬垂键则连键一起切掉
    let pendingKeyStart: number | null = null
    const stack: string[] = []
    for (let i = 0; i < input.length; i += 1) {
      const char = input[i]
      if (inString) {
        if (char === '\\') {
          i += 1
        } else if (char === '"') {
          inString = false
          prevSignificant = '"'
        }
        continue
      }
      if (char === '"') {
        inString = true
        stringStart = i
        pendingKeyStart = stack[stack.length - 1] === '}' && (prevSignificant === '{' || prevSignificant === ',') ? i : null
      } else if (char === '{' || char === '[') {
        stack.push(char === '{' ? '}' : ']')
        prevSignificant = char
        pendingKeyStart = null
      } else if (char === '}' || char === ']') {
        stack.pop()
        prevSignificant = char
        pendingKeyStart = null
      } else if (char === ':') {
        prevSignificant = char
        // 冒号坐实了前面的字符串是键：保留 pending，等值出现再清
      } else if (char === ',') {
        prevSignificant = char
        pendingKeyStart = null
      } else if (char.trim()) {
        prevSignificant = char
        pendingKeyStart = null
      }
    }
    let body = input
    const trailingBackslashes = body.match(/\\+$/)?.[0].length ?? 0
    if (inString) {
      // 尾部孤反斜杠会把补上的闭引号转义掉，先切掉
      if (trailingBackslashes % 2 === 1) body = body.slice(0, -1)
      const isKey = prevSignificant === '{' || prevSignificant === ','
      if (isKey) {
        body = body.slice(0, stringStart)
      } else {
        body += '"'
      }
    } else if (trailingBackslashes % 2 === 1) {
      body = body.slice(0, -1)
    }
    body = body.replace(/[\s,:]+$/, '')
    if (!inString && pendingKeyStart != null) {
      body = body.slice(0, pendingKeyStart).replace(/[\s,]+$/, '')
    }
    const closers: string[] = []
    let inStr = false
    for (let i = 0; i < body.length; i += 1) {
      const char = body[i]
      if (inStr) {
        if (char === '\\') i += 1
        else if (char === '"') inStr = false
        continue
      }
      if (char === '"') inStr = true
      else if (char === '{' || char === '[') closers.push(char === '{' ? '}' : ']')
      else if (char === '}' || char === ']') closers.pop()
    }
    let repaired = body
    while (closers.length > 0) repaired += closers.pop()
    return repaired
  }

  // 单引号字符串修复：模型常见用单引号包字符串（JSON 不认单引号），逐字符把不在双引号内的
  // 单引号当成字符串定界符换成双引号；双引号内内容原样保留，避免误伤；“撇号”位于双引号内会被
  // 正常跳过。这条只是候选之一，parse 失败时继续尝试其它候选，不会破坏原 JSON。
  const repairSingleQuoteStrings = (input: string): string => {
    let out = ''
    let inDouble = false
    let inSingle = false
    let i = 0
    while (i < input.length) {
      const char = input[i]
      if (inDouble) {
        out += char
        if (char === '\\') {
          out += input[i + 1] ?? ''
          i += 2
          continue
        }
        if (char === '"') inDouble = false
        i += 1
        continue
      }
      if (inSingle) {
        if (char === '\\') {
          out += '\\\\'
          i += 1
          continue
        }
        if (char === "'") {
          out += '"'
          inSingle = false
          i += 1
          continue
        }
        if (char === '"') {
          out += '\\"'
          i += 1
          continue
        }
        if (char === '\n') {
          out += '\\n'
          i += 1
          continue
        }
        if (char === '\r') {
          out += '\\r'
          i += 1
          continue
        }
        if (char === '\t') {
          out += '\\t'
          i += 1
          continue
        }
        out += char
        i += 1
        continue
      }
      if (char === '"') {
        inDouble = true
        out += char
        i += 1
        continue
      }
      if (char === "'") {
        inSingle = true
        out += '"'
        i += 1
        continue
      }
      out += char
      i += 1
    }
    return out
  }

  for (const candidate of [...attempts]) {
    attempts.push(repairTruncated(candidate))
  }

  for (const candidate of [...attempts]) {
    attempts.push(repairSingleQuoteStrings(candidate))
  }

  // 复合损伤（字符串内裸换行 + 截断未闭括号同时存在）在长参数场景很常见，
  // 上面的单项修复候选都只治一种，这里补两个顺序组合候选兜底
  for (const candidate of [...attempts]) {
    attempts.push(repairTruncated(escapeControlChars(candidate)))
    attempts.push(escapeControlChars(repairTruncated(candidate)))
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 继续下一个候选
    }
  }

  // 二遍兜底：一遍候选全失败才进深度修复（正常路径零开销），
  // 专救截断残尾（悬垂逗号/冒号/悬垂键/孤反斜杠）这类朴素补括号救不了的损伤
  for (const candidate of [...attempts]) {
    attempts.push(repairTruncatedDeep(candidate))
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 继续下一个候选
    }
  }

  throw new Error('参数无法解析为 JSON')
}
