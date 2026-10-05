import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import { selectableModelTierSchema } from '../../../../shared/contracts/model-tier.js'
import type { AgentStreamEvent, CreditModelTier, ModelReasoningEffort } from '../../../../shared/contracts/index.js'
import type { ModelAssignmentsPayload } from '../../../../shared/contracts/agent-model-assignments.js'
import { useAgentStore } from './agentStore'

type ModelChoice = { modelTier: CreditModelTier; customModelId?: string | null; reasoningEffort?: ModelReasoningEffort }
type ConfigurationEvent = Extract<AgentStreamEvent, { type: 'run.configuration' }>

export function resolveComposerModelEffort(preferred: ModelReasoningEffort | undefined, configuredModel: boolean,
  saved: ModelReasoningEffort | undefined, capability?: { reasoningEfforts: readonly ModelReasoningEffort[]; defaultReasoningEffort?: ModelReasoningEffort }): ModelReasoningEffort {
  if (preferred) return preferred
  if (!configuredModel && saved && capability?.reasoningEfforts.includes(saved)) return saved
  return capability?.defaultReasoningEffort ?? 'high'
}

export function useAgentModelPreference(novelId: string, sessionId: string | null) {
  const [fallbackTier, setFallbackTier] = useState<CreditModelTier>(() => {
    const saved = typeof window === 'undefined' ? null : window.localStorage.getItem('chevoink:agent-model-tier')
    const parsed = selectableModelTierSchema.safeParse(saved)
    return parsed.success ? parsed.data : 'speed'
  })
  const [fallbackCustomId, setFallbackCustomId] = useState<string | null>(() => typeof window === 'undefined' ? null : window.localStorage.getItem('chevoink:agent-custom-model-id'))
  const [reasoningSelections, setReasoningSelections] = useState<Record<string, ModelReasoningEffort>>(() => {
    try {
      const value = JSON.parse(typeof window === 'undefined' ? '{}' : window.localStorage.getItem('chevoink:agent-reasoning-efforts') ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  })
  const scope = `${novelId}:${sessionId ?? ''}`
  const [override, setOverride] = useState<{ scope: string; choice: ModelChoice } | null>(null)
  const manualEfforts = useRef<{ scope: string; values: Record<string, ModelReasoningEffort> } | null>(null)
  const seenConfiguration = useRef<{ runId: string; seq: number } | null>(null)
  const assignments = useQuery({
    queryKey: ['agent', 'model-assignments', `novel:${novelId}`],
    queryFn: () => requestJson<ModelAssignmentsPayload>(`/api/agent/model-assignments?novelId=${encodeURIComponent(novelId)}`),
    enabled: Boolean(novelId), retry: false,
  })
  const inherited = assignments.data?.effective.main?.selection
  const explicit = override?.scope === scope
  const choice: ModelChoice = explicit ? override.choice : inherited ?? { modelTier: fallbackTier, customModelId: fallbackCustomId }
  const modelKey = choice.modelTier === 'custom' ? `custom:${choice.customModelId ?? ''}` : `tier:${choice.modelTier}`
  const effectiveReasoningSelections = choice.reasoningEffort ? { ...reasoningSelections, [modelKey]: choice.reasoningEffort } : reasoningSelections

  useEffect(() => { window.localStorage.setItem('chevoink:agent-model-tier', fallbackTier) }, [fallbackTier])
  useEffect(() => {
    if (fallbackCustomId) window.localStorage.setItem('chevoink:agent-custom-model-id', fallbackCustomId)
    else window.localStorage.removeItem('chevoink:agent-custom-model-id')
  }, [fallbackCustomId])
  useEffect(() => { window.localStorage.setItem('chevoink:agent-reasoning-efforts', JSON.stringify(reasoningSelections)) }, [reasoningSelections])

  const selectModelTier = (tier: CreditModelTier) => {
    setFallbackTier(tier)
    setOverride(current => {
      const id = tier === 'custom' ? (current?.scope === scope ? current.choice.customModelId : choice.customModelId) ?? fallbackCustomId : null
      const effortKey = tier === 'custom' ? `custom:${id ?? ''}` : `tier:${tier}`
      const selectedEffort = manualEfforts.current?.scope === scope ? manualEfforts.current.values[effortKey] : undefined
      return { scope, choice: { modelTier: tier, customModelId: id, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) } }
    })
  }
  const selectCustomModel = (id: string | null) => {
    setFallbackCustomId(id)
    const selectedEffort = manualEfforts.current?.scope === scope ? manualEfforts.current.values[`custom:${id ?? ''}`] : undefined
    setOverride({ scope, choice: { modelTier: 'custom', customModelId: id, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) } })
  }
  const selectReasoningEffort = (key: string, effort: ModelReasoningEffort) => {
    setReasoningSelections(value => ({ ...value, [key]: effort }))
    manualEfforts.current = { scope, values: { ...(manualEfforts.current?.scope === scope ? manualEfforts.current.values : {}), [key]: effort } }
    if (key === modelKey) setOverride({ scope, choice: { ...choice, reasoningEffort: effort } })
  }
  const applyConfiguration = (event: ConfigurationEvent) => {
    const live = useAgentStore.getState()
    if (!sessionId || live.activeSessionId !== sessionId || live.runId !== event.runId || live.lastSeq !== event.seq) return false
    if (seenConfiguration.current?.runId === event.runId && seenConfiguration.current.seq >= event.seq) return false
    seenConfiguration.current = { runId: event.runId, seq: event.seq }
    // A server-confirmed task switch must not overwrite another work's or the global preference.
    if (event.modelSelectionExplicit) setOverride({ scope, choice: { modelTier: event.modelTier, customModelId: event.customModelId, reasoningEffort: event.reasoningEffort } })
    return true
  }
  return { modelTier: choice.modelTier, customModelId: choice.customModelId ?? null, reasoningSelections: effectiveReasoningSelections,
    preferredEffort: choice.reasoningEffort, explicit, inheritMain: Boolean(inherited) && !explicit,
    importAssignment: assignments.data?.effective.import_analysis?.selection,
    loading: Boolean(novelId) && assignments.isPending,
    selectModelTier, selectCustomModel, selectReasoningEffort, setFallbackTier, applyConfiguration }
}
