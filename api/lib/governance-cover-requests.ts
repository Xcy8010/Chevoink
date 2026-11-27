const active = new Map<string, Set<AbortController>>()

export async function withCoverRequest<T>(userId:string, prior:AbortSignal|undefined, work:(signal:AbortSignal)=>Promise<T>) {
  const controller=new AbortController()
  const requests=active.get(userId)??new Set<AbortController>()
  requests.add(controller)
  active.set(userId,requests)
  try { return await work(prior ? AbortSignal.any([prior,controller.signal]) : controller.signal) }
  finally { requests.delete(controller); if (!requests.size) active.delete(userId) }
}
export function stopAccountCoverRequests(userId:string) {
  for(const request of active.get(userId)??[]) request.abort()
}
