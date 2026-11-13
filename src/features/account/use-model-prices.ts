import { useQuery, useQueryClient } from '@tanstack/react-query'
import { nextModelPriceRefreshAt, useModelPriceRefresh } from '@/app/live-configuration'
import { fetchCreditSummary, fetchCreditUsage } from './credits-api'

const creditSummaryKey = ['credits', 'summary'] as const
const creditUsageKey = ['credits', 'usage'] as const

export function useModelCreditSummary(refetchInterval: number | false = false) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: creditSummaryKey, queryFn: fetchCreditSummary, staleTime: 20_000, refetchInterval, refetchOnWindowFocus: true })
  useModelPriceRefresh(client, creditSummaryKey, nextModelPriceRefreshAt(query.data?.models ?? [], query.dataUpdatedAt, query.data?.modelPricesAsOf))
  return query
}

export function useCreditUsageWithModelPrices() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: creditUsageKey, queryFn: fetchCreditUsage, staleTime: 20_000, refetchOnWindowFocus: true })
  const account = query.data?.account
  useModelPriceRefresh(client, creditUsageKey, nextModelPriceRefreshAt(account?.models ?? [], query.dataUpdatedAt, account?.modelPricesAsOf))
  return query
}
