import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import type { AgentStreamEvent, CreditModelTier, ModelReasoningEffort } from '../../../../shared/contracts/index.js'
import type { ModelAssignmentsPayload } from '../../../../shared/contracts/agent-model-assignments.js'
import { useAgentStore } from './agentStore'
import { useAgentWindowConfiguration } from './useAgentWindowConfiguration'

type ModelChoice = { modelTier: CreditModelTier; customModelId?: string | null; reasoningEffort?: ModelReasoningEffort }
type ConfigurationEvent = Extract<AgentStreamEvent, { type: 'run.configuration' }>

export function resolveComposerModelEffort(preferred: ModelReasoningEffort | undefined, configuredModel: boolean,
  saved: ModelReasoningEffort | undefined, capability?: { reasoningEfforts: readonly ModelReasoningEffort[]; defaultReasoningEffort?: ModelReasoningEffort }): ModelReasoningEffort {
  if (preferred) return preferred
  if (!configuredModel && saved && capability?.reasoningEfforts.includes(saved)) return saved
  return capability?.defaultReasoningEffort ?? 'high'
}

export function useAgentModelPreference(novelId: string, sessionId: string | null, draftScope = '') {
  const [fallbackTier, setFallbackTier] = useState<CreditModelTier>('speed')
  const windowConfiguration = useAgentWindowConfiguration(novelId, sessionId, draftScope)
  const scope = `${novelId}:${sessionId ?? `draft:${draftScope}`}`
  const [efforts, setEfforts] = useState<Record<string, Record<string, ModelReasoningEffort>>>({})
  const seenConfiguration = useRef<{ runId: string; seq: number } | null>(null)
  const assignments = useQuery({
    queryKey: ['agent', 'model-assignments', `novel:${novelId}`],
    queryFn: () => requestJson<ModelAssignmentsPayload>(`/api/agent/model-assignments?novelId=${encodeURIComponent(novelId)}`),
    enabled: Boolean(novelId), retry: false,
  })
  const inherited = assignments.data?.effective.main?.selection
  const explicit = Boolean(windowConfiguration.configuration.model)
  const choice: ModelChoice = windowConfiguration.configuration.model ?? inherited ?? { modelTier: fallbackTier }
  const choiceRef = useRef({ scope, choice })
  choiceRef.current = { scope, choice }
  const modelKey = choice.modelTier === 'custom' ? `custom:${choice.customModelId ?? ''}` : `tier:${choice.modelTier}`
  const effectiveReasoningSelections = choice.reasoningEffort ? { ...efforts[scope], [modelKey]: choice.reasoningEffort } : efforts[scope] ?? {}
  const saveChoice = (model: ModelChoice) => {
    if (model.modelTier === 'basic') return
    choiceRef.current = { scope, choice: model }
    void windowConfiguration.update({ model: { ...model, modelTier: model.modelTier, customModelId: model.customModelId ?? undefined } }).catch(() => {})
  }

  const selectModelTier = (tier: CreditModelTier) => {
    const id = tier === 'custom' ? choiceRef.current.choice.customModelId ?? null : null
    const selectedEffort = efforts[scope]?.[tier === 'custom' ? `custom:${id ?? ''}` : `tier:${tier}`]
    saveChoice({ modelTier: tier, customModelId: id, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) })
  }
  const selectCustomModel = (id: string | null) => {
    const selectedEffort = efforts[scope]?.[`custom:${id ?? ''}`]
    saveChoice({ modelTier: 'custom', customModelId: id, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) })
  }
  const selectReasoningEffort = (key: string, effort: ModelReasoningEffort) => {
    setEfforts(value => ({ ...value, [scope]: { ...value[scope], [key]: effort } }))
    const selected = choiceRef.current.choice
    const selectedKey = selected.modelTier === 'custom' ? `custom:${selected.customModelId ?? ''}` : `tier:${selected.modelTier}`
    if (key === selectedKey) saveChoice({ ...selected, reasoningEffort: effort })
  }
  const applyConfiguration = (event: ConfigurationEvent) => {
    const live = useAgentStore.getState()
    if (!sessionId || live.activeSessionId !== sessionId || live.runId !== event.runId || live.lastSeq !== event.seq) return false
    if (seenConfiguration.current?.runId === event.runId && seenConfiguration.current.seq >= event.seq) return false
    seenConfiguration.current = { runId: event.runId, seq: event.seq }
    // A run snapshot is immutable history; refresh the separately owned window preference.
    void windowConfiguration.refresh()
    return true
  }
  return { modelTier: choice.modelTier, customModelId: choice.customModelId ?? null, reasoningSelections: effectiveReasoningSelections,
    preferredEffort: choice.reasoningEffort, explicit, inheritMain: Boolean(inherited) && !explicit,
    importAssignment: assignments.data?.effective.import_analysis?.selection,
    loading: Boolean(novelId) && assignments.isPending || windowConfiguration.loading,
    windowConfiguration,
    selectModelTier, selectCustomModel, selectReasoningEffort, setFallbackTier, applyConfiguration }
}
