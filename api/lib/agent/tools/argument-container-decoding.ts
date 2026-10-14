import { z } from 'zod'

type Schema = boolean | Record<string, unknown>
const types = ['object', 'array', 'string', 'number', 'boolean', 'null'] as const
const plans = new WeakMap<z.ZodType, Schema | null>()
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const schema = (value: unknown): Schema => typeof value === 'boolean' || object(value) ? value : true
const shape = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const combine = (kind: 'allOf' | 'anyOf', nodes: Schema[]): Schema => nodes.length === 1 ? nodes[0] : { [kind]: nodes }

/** A transport compatibility decoder, not syntax repair or business coercion.
 * Unconstrained/text alternatives cannot authorize decoding. Unsupported plans
 * leave the existing validator in charge. Canonical accepted inputs are kept. */
export function decodeToolArgumentContainers(parameters: z.ZodType, input: unknown): unknown {
  // This proves accepted-input identity, including preprocessors, defaults and
  // legitimate string unions; do not apply parse output or invoke effects.
  if (parameters.safeParse(input).success) return input
  if (!plans.has(parameters)) {
    try { plans.set(parameters, z.toJSONSchema(parameters, { io: 'input', unrepresentable: 'any' }) as Schema) }
    catch { plans.set(parameters, null) }
  }
  const root = plans.get(parameters)
  if (!root) return input

  const resolve = (node: Schema): Schema => {
    if (!object(node) || typeof node.$ref !== 'string') return node
    if (node.$ref !== '#' && !node.$ref.startsWith('#/')) return true
    let found: unknown = root
    for (const part of (node.$ref === '#' ? [] : node.$ref.slice(2).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~')))) {
      if (!object(found) || !own(found, part)) return true
      found = found[part]
    }
    const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'))
    return Object.keys(siblings).length ? combine('allOf', [schema(found), siblings]) : schema(found)
  }
  const allowed = (raw: Schema, depth: number): Set<string> => {
    if (depth > 32) return new Set(types)
    const node = resolve(raw)
    if (node === false) return new Set()
    if (node === true) return new Set(types)
    let result = new Set<string>(types)
    if (typeof node.type === 'string' || Array.isArray(node.type)) {
      result = new Set((Array.isArray(node.type) ? node.type : [node.type]).map(type => type === 'integer' ? 'number' : String(type)))
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) if (Array.isArray(node[key])) {
      const branches = node[key].map(item => allowed(schema(item), depth + 1))
      const bound = key === 'allOf' ? branches.reduce((a, b) => new Set([...a].filter(type => b.has(type))), new Set<string>(types))
        : new Set(branches.flatMap(branch => [...branch]))
      result = new Set([...result].filter(type => bound.has(type)))
    }
    return result
  }
  const possible = (raw: Schema, value: unknown): boolean => {
    const node = resolve(raw)
    if (!allowed(node, 0).has(shape(value))) return false
    if (!object(node)) return node !== false
    if (own(node, 'const') && node.const !== value) return false
    if (Array.isArray(node.enum) && !node.enum.includes(value)) return false
    if (object(value) && object(node.properties)) for (const [key, field] of Object.entries(node.properties)) {
      const constraint = resolve(schema(field))
      if (!own(value, key) || !object(constraint)) continue
      // Select a branch only using a real literal discriminator, never by
      // guessing missing fields or whether a nested JSON string looks useful.
      if (own(constraint, 'const') && value[key] !== constraint.const) return false
      if (Array.isArray(constraint.enum) && !constraint.enum.includes(value[key])) return false
    }
    return true
  }
  const child = (raw: Schema, value: unknown, key: string | number, depth: number): Schema => {
    if (depth > 32) return true
    const node = resolve(raw)
    if (!object(node)) return node
    const bounds: Schema[] = []
    for (const group of ['oneOf', 'anyOf', 'allOf'] as const) if (Array.isArray(node[group])) {
      const branches = node[group].map(schema).filter(branch => group === 'allOf' || possible(branch, value))
      bounds.push(branches.length ? combine(group === 'allOf' ? 'allOf' : 'anyOf', branches.map(branch => child(branch, value, key, depth + 1))) : true)
    }
    if (Array.isArray(value)) {
      if (Array.isArray(node.prefixItems) && Number(key) < node.prefixItems.length) bounds.push(schema(node.prefixItems[Number(key)]))
      else if (node.items !== undefined) bounds.push(schema(node.items))
    } else if (object(value)) {
      if (object(node.properties) && own(node.properties, key)) bounds.push(schema(node.properties[key]))
      else if (object(node.patternProperties)) {
        let matched = false
        for (const [pattern, field] of Object.entries(node.patternProperties)) {
          try { if (new RegExp(pattern).test(String(key))) { bounds.push(schema(field)); matched = true } }
          catch { return true }
        }
        if (!matched && node.additionalProperties !== undefined) bounds.push(schema(node.additionalProperties))
      } else if (node.additionalProperties !== undefined) bounds.push(schema(node.additionalProperties))
    }
    return bounds.length ? combine('allOf', bounds) : true
  }
  const visit = (raw: unknown, node: Schema, depth: number): unknown => {
    if (depth > 32) return raw
    if (typeof resolve(node) === 'boolean') return raw
    let value = raw
    if (typeof value === 'string') {
      const accepted = allowed(node, 0)
      if (!accepted.size || [...accepted].some(type => !['object', 'array', 'null'].includes(type))) return raw
      const text = value.trim()
      if (!text.startsWith('{') && !text.startsWith('[')) return raw
      try {
        const decoded: unknown = JSON.parse(text)
        if ((!object(decoded) && !Array.isArray(decoded)) || !accepted.has(shape(decoded))) return raw
        value = decoded
      } catch { return raw }
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, child(node, value, index, 0), depth + 1))
    if (!object(value)) return value
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, child(node, value, key, 0), depth + 1)]))
  }
  return visit(input, root, 0)
}
