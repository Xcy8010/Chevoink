import { governanceAvailableFor } from './governance-restrictions.js'
import { prisma } from './prisma.js'

export function yunshuResponseId(response: Response) {
  const url = URL.parse(response.url)
  if (response.redirected || url?.origin !== 'https://yunshu.chevolink.com' || !['/v1/chat/completions','/v1/responses'].includes(url.pathname)) return null
  const id = response.headers.get('X-Oneapi-Request-Id')
  return id && /^[0-9]{23}[0-9A-Za-z]{16}$/.test(id) ? id : null
}

export async function recordYunshuResponse(response: Response, userId: string, call: {kind:'usage'|'attempt'; id:string} | null) {
  const id = yunshuResponseId(response)
  if (!id || !call) return
  try {
    if (!await governanceAvailableFor(userId)) return
    await prisma.yunshuRequestLink.createMany({data:[{kind:call.kind,localId:call.id,requestId:id}],skipDuplicates:true})
  } catch {
    // Missing observational evidence must not tear down a paid response or replay a dispatch.
    console.warn('[yunshu] 供应商关联记录暂未保存')
  }
}
