import { z } from 'zod'

export const BUILT_IN_MODEL_TIERS = ['lite', 'speed', 'standard', 'performance', 'ultimate'] as const
export const SERVER_MODEL_TIERS = [...BUILT_IN_MODEL_TIERS, 'basic'] as const
export type DynamicBuiltInModelTier = `builtin_${string}`
export type BuiltInModelTier = typeof BUILT_IN_MODEL_TIERS[number] | DynamicBuiltInModelTier
export type CreditModelTier = BuiltInModelTier | 'basic' | 'custom'
const dynamicTierSchema = z.string().regex(/^builtin_[0-9a-f]{16}$/) as z.ZodType<DynamicBuiltInModelTier>
/** Parsing frozen identities does not grant admission to a configured model. */
export const builtInModelTierSchema = z.union([z.enum(BUILT_IN_MODEL_TIERS), dynamicTierSchema])
export const selectableModelTierSchema = z.union([builtInModelTierSchema, z.literal('custom')])
export const serverModelTierSchema = z.union([builtInModelTierSchema, z.literal('basic')])
export const creditModelTierSchema = z.union([serverModelTierSchema, z.literal('custom')])
export const isBuiltInModelTier = (value: unknown): value is BuiltInModelTier => builtInModelTierSchema.safeParse(value).success
export const isServerModelTier = (value: unknown): value is Exclude<CreditModelTier, 'custom'> => serverModelTierSchema.safeParse(value).success
