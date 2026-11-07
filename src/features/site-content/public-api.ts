import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import type { Announcement, PublicSiteContent } from '../../../shared/contracts/site-content'

export function usePublicSiteContent(enabled = true) {
  return useQuery({queryKey:['site-content','public'],queryFn:()=>requestJson<PublicSiteContent>('/api/site-content'),enabled,staleTime:0,refetchOnWindowFocus:true,refetchInterval:query=>{
    const data=query.state.data
    const remaining=data?.nextBoundaryAt ? Date.parse(data.nextBoundaryAt)-Date.parse(data.serverNow)-(Date.now()-query.state.dataUpdatedAt) : 60000
    return Math.max(250,Math.min(60000,remaining+100))
  }})
}
export function dismissalKey(id: string, version: number) { return `${id}:${version}` }
export function dismissalIsActive(value: number | undefined, policy: Announcement['dismissal'], now: number) { return value !== undefined && (policy.mode !== 'ttl' || now < value + policy.seconds * 1000) }

// Canonical legal publication remains readable for registration in every app channel.
export function useRegistrationPolicies(){
 return useQuery({queryKey:['auth','legal-policies'],queryFn:()=>requestJson<Pick<PublicSiteContent,'legal'>>('/api/auth/legal-policies'),staleTime:0,refetchOnWindowFocus:true,refetchInterval:60000})
}
