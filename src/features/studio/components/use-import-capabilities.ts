import { useQuery } from '@tanstack/react-query'
import { novelImportApi } from '../import-api'

/** Fail closed. No intent, upload or mutation is issued on workspace rendering. */
export function useImportCapabilities(novelId: string, userId?: string | null) {
  const query = useQuery({
    queryKey: ['novel-import-capabilities', userId ?? null, novelId],
    queryFn: () => novelImportApi.capabilities(novelId),
    enabled: !!novelId && !!userId,
    retry: false,
    staleTime: 0,
  })
  // React Query retains old data after a failed refetch. It is not current authorization.
  return { ...query, data: query.isError ? undefined : query.data }
}
