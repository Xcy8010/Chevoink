// A conservative lexical proof, not a Prisma validator or engine invocation.
// Keep declaration boundaries, literal bytes and tokens within each declaration.
// Only proven independent model constraints may change order inside a block.
const identifier = /^[A-Za-z_][A-Za-z0-9_-]*$/
const kinds = new Set(['model', 'enum', 'type', 'view', 'datasource', 'generator'])

function modelRows(rows) {
  if (!rows.some(row => row[0] === '@@' && ['unique', 'index'].includes(row[1]))) return rows
  const fields = new Set(), constraints = new Set(), names = new Set(), maps = new Set(), anchors = new Set()
  let attributesStarted = false
  for (const row of rows) {
    if (row[0] === '@@') { attributesStarted = true; continue }
    if (attributesStarted || fields.has(row[0])) throw new Error('ambiguous_model_fields')
    fields.add(row[0])
  }
  const sortable = row => row[0] === '@@' && ['unique', 'index'].includes(row[1])
  for (const row of rows.filter(row => row[0] === '@@')) {
    if (!sortable(row)) {
      // Existing opaque declarations stay in place; never sort across them.
      if (!['id', 'map', 'schema', 'ignore'].includes(row[1]) || anchors.has(row[1])) throw new Error('unsupported_model_attribute')
      anchors.add(row[1]); continue
    }
    // Deliberately bounded: a nonempty list of distinct local bare field names,
    // followed only by string name (unique only) / map arguments. No expression,
    // field options, dotted paths, unknown arguments or duplicate identities.
    const values = row.filter(value => value !== '\n'), referenced = []
    let i = 3
    if (values[2] !== '(' || values[i++] !== '[') throw new Error('unsupported_model_constraint')
    while (true) {
      const field = values[i++]
      if (!identifier.test(field) || !fields.has(field) || referenced.includes(field)) throw new Error('ambiguous_constraint_field')
      referenced.push(field)
      if (values[i] !== ',') break
      i++
    }
    if (values[i++] !== ']') throw new Error('unsupported_constraint_fields')
    const args = new Set()
    while (values[i] === ',') {
      i++
      const name = values[i++], literal = values[i + 1]
      if (!['name', 'map'].includes(name) || name === 'name' && row[1] !== 'unique' || args.has(name)
        || values[i++] !== ':' || !literal?.startsWith('"')) throw new Error('unsupported_constraint_argument')
      i++
      const value = JSON.parse(literal), identities = name === 'name' ? names : maps
      if (!value || identities.has(value)) throw new Error('ambiguous_constraint_identity')
      args.add(name); identities.add(value)
    }
    if (values[i++] !== ')' || i !== values.length) throw new Error('non_standalone_constraint')
    const key = JSON.stringify([row[1], referenced])
    if (constraints.has(key)) throw new Error('duplicate_model_constraint')
    constraints.add(key)
  }
  const result = []
  for (let i = 0; i < rows.length;) {
    if (!sortable(rows[i])) { result.push(rows[i++]); continue }
    const start = i
    while (i < rows.length && sortable(rows[i])) i++
    result.push(...rows.slice(start, i).sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b)
      return left < right ? -1 : left > right ? 1 : 0
    }))
  }
  return result
}

function declarations(text) {
  if (text.length > 2 * 1024 * 1024) throw new Error('schema_limit')
  const tokens = [], token = /"(?:[^"\\\u0000-\u001f]|\\[^\r\n])*"|Unsupported\(|[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*|-?\d+(?:\.\d+)?|\[\]|@@|[{}[\]()@=?:,.!]|\n/y
  let offset = 0
  while (offset < text.length) {
    if (text[offset] === ' ' || text[offset] === '\t') { offset++; continue }
    if (text.startsWith('//', offset)) { const end = text.indexOf('\n', offset); offset = end < 0 ? text.length : end; continue }
    if (text.startsWith('/*', offset)) {
      const end = text.indexOf('*/', offset + 2)
      if (end < 0) throw new Error('unterminated_comment')
      const before = text.slice(text.lastIndexOf('\n', offset) + 1, offset)
      const after = text.slice(end + 2, text.indexOf('\n', end + 2) < 0 ? text.length : text.indexOf('\n', end + 2))
      if (before.trim() && after.trim()) throw new Error('inline_comment_position_unverified')
      if (text.slice(offset, end).includes('\n')) tokens.push('\n')
      offset = end + 2; continue
    }
    token.lastIndex = offset
    const match = token.exec(text)
    if (!match) throw new Error('unsupported_token')
    if (match[0].startsWith('"')) JSON.parse(match[0])
    tokens.push(match[0]); offset = token.lastIndex
  }
  const blocks = new Map(), configuration = [], definitions = [], dataNames = new Set()
  let position = 0
  while (position < tokens.length) {
    if (tokens[position] === '\n') { position++; continue }
    const kind = tokens[position++], name = tokens[position++]
    if (!kinds.has(kind) || !identifier.test(name) || tokens[position++] !== '{') throw new Error('unsupported_block')
    const key = `${kind} ${name}`
    if (blocks.has(key)) throw new Error('duplicate_block')
    const config = ['generator', 'datasource'].includes(kind)
    if (!config && dataNames.has(name)) throw new Error('ambiguous_data_name')
    if (!config) dataNames.add(name)
    if (!['\n', '}'].includes(tokens[position])) throw new Error('inline_declaration_unverified')
    const rows = [], stack = []
    let row = [], closed = false
    const flush = () => {
      if (!row.length) return
      if (row[0] !== '@@' && !identifier.test(row[0])) throw new Error('unsupported_declaration')
      if (['generator', 'datasource'].includes(kind) && (row[1] !== '=' || row.length < 3)) throw new Error('unsupported_config')
      rows.push(row); row = []
    }
    while (position < tokens.length) {
      const value = tokens[position++]
      if (value === '\n' && !stack.length) { flush(); continue }
      if (value === '}') { if (stack.length || row.length) throw new Error('inline_or_unbalanced_closing_block'); closed = true; break }
      if (value === '{') throw new Error('nested_block_unverified')
      if (value === 'Unsupported(') stack.push('(')
      if (['(', '['].includes(value)) stack.push(value)
      if ([')', ']'].includes(value) && stack.pop() !== (value === ')' ? '(' : '[')) throw new Error('unbalanced_expression')
      row.push(value)
    }
    if (!closed) throw new Error('unclosed_block')
    const canonicalRows = kind === 'model' ? modelRows(rows) : rows
    blocks.set(key, canonicalRows)
    const group = config ? configuration : definitions
    group.push([key, canonicalRows])
  }
  if (!blocks.size) throw new Error('no_declarations')
  return { configuration, definitions: definitions.sort(([left], [right]) => left.localeCompare(right)), blocks: blocks.size }
}

export function comparePrismaSchemas(source, generated) {
  const normalize = text => text.replace(/\r\n?/g, '\n')
  source = normalize(source); generated = normalize(generated)
  if (source === generated) return { status: 'equivalent', basis: 'exact_text' }
  try {
    const left = declarations(source), right = declarations(generated)
    if (JSON.stringify(left) === JSON.stringify(right)) return { status: 'equivalent', basis: 'declaration_tokens', blocks: left.blocks }
    return { status: 'unverified', reason: 'declarations_not_identical' }
  } catch { return { status: 'unverified', reason: 'unsupported_or_ambiguous_schema' } }
}
