import { z } from 'zod'

/** 保证 function parameters 顶层 type 为 object。
 * 供应商（DeepSeek/OpenAI）要求函数参数顶层 type 必须是 object：顶层联合（oneOf/anyOf，
 * 如 novel_import 的 discriminatedUnion）转换后没有 type，会被供应商按 type null 拒绝，
 * 联合约束仍保留在 oneOf/anyOf 中，语义不变。 */
export function withObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.type === 'object' ? schema : { ...schema, type: 'object' }
}

/** zod schema → OpenAI function calling 参数定义（zod v4 原生转换 + 顶层 object 保证） */
export function toOpenAIParameters(parameters: z.ZodType): Record<string, unknown> {
  return withObjectType(z.toJSONSchema(parameters, { io: 'input' }) as Record<string, unknown>)
}
