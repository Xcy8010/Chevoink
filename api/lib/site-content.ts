import { createHash } from 'node:crypto'
import type { Prisma, SiteContent, SiteContentVersion } from '@prisma/client'
import { publishedAnnouncementSchema, announcementStatus, contentDraftSchema, helpDocumentSchema, legalDocumentSchema, siteSettingsSchema, type ContentDraft, type ContentRow, type LegalConsent, type PublicLegal, type PublicSiteContent } from '../../shared/contracts/site-content.js'
import { DataAccessError, prisma } from './prisma.js'

type Transaction = Prisma.TransactionClient
type Document = SiteContent & { versions: SiteContentVersion[] }
// Publishing a policy and recording a registration serialize on the same transaction lock.
export async function lockSiteContent(tx: Transaction) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(804725)` }
const json = (value: ContentDraft['payload']) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
function version(row: SiteContentVersion) { return { id: row.id, contentVersion: row.contentVersion, payload: row.payload as ContentDraft['payload'], hash: row.hash, publishedAt: row.publishedAt.toISOString() } }
function present(row: Document, now = Date.now()): ContentRow {
  const draft = contentDraftSchema.parse({kind: row.kind, key: row.key, payload: row.draft})
  const published = row.versions.find(item => item.id === row.publishedVersionId)
  const announcement = published && row.kind === 'announcement' ? publishedAnnouncementSchema.parse(published.payload) : null
  const status = announcementStatus({published: Boolean(published), withdrawn: row.withdrawn || Boolean(row.deletedAt), startsAt: announcement?.startsAt, endsAt: announcement?.endsAt}, now)
  return { ...draft, id: row.id, revision: row.revision, deletedAt: row.deletedAt?.toISOString() ?? null, withdrawn: row.withdrawn, status: row.kind === 'announcement' ? status : row.withdrawn || row.deletedAt ? 'withdrawn' : published ? published.effectiveAt && published.effectiveAt.getTime() > now ? 'scheduled' : 'active' : 'draft', published: published ? version(published) : null, history: row.versions.map(version) }
}
export async function listSiteContent() { return (await prisma.siteContent.findMany({include: {versions: {orderBy: {contentVersion: 'desc'}}}, orderBy: [{kind:'asc'},{key:'asc'}]})).map(row => present(row)) }
export async function createSiteContent(input: ContentDraft, actorId: string, ip: string | null) {
  return prisma.$transaction(async tx => {
    await lockSiteContent(tx)
    if (await tx.siteContent.findUnique({where: {kind_key: {kind:input.kind, key:input.key}}})) throw new DataAccessError(409,'CONTENT_EXISTS','该内容已存在，请编辑或恢复原内容。')
    const row = await tx.siteContent.create({data: {kind: input.kind, key: input.key, draft: json(input.payload)}, include: {versions:true}})
    await tx.adminAuditLog.create({data:{adminId:actorId,action:'site_content.create',targetType:'site_content',targetId:row.id,ip,detail:{kind:input.kind,key:input.key,revision:row.revision}}})
    return present(row)
  })
}
export type ContentOperation = { expectedRevision: number; action: 'save'|'publish'|'withdraw'|'delete'|'restore'; draft?: ContentDraft; replace?: {id: string; expectedRevision: number} }
export async function mutateSiteContent(id: string, input: ContentOperation, actorId: string, ip: string | null) {
  return prisma.$transaction(async tx => {
    await lockSiteContent(tx)
    const row = await tx.siteContent.findUnique({where:{id},include:{versions:{orderBy:{contentVersion:'desc'}}}})
    if (!row) throw new DataAccessError(404,'CONTENT_NOT_FOUND','内容不存在。')
    if (row.revision !== input.expectedRevision) throw new DataAccessError(409,'CONTENT_REVISION_CONFLICT','内容已变更，请刷新后重试。')
    if (row.deletedAt && input.action !== 'restore') throw new DataAccessError(409,'CONTENT_DELETED','请先恢复已删除的内容。')
    const data: Prisma.SiteContentUpdateInput = {revision:{increment:1}}
    let publishedId: string | undefined
    if (input.action === 'save') {
      if (!input.draft || input.draft.kind !== row.kind || input.draft.key !== row.key) throw new DataAccessError(400,'VALIDATION_ERROR','内容类型与编号不能改变。')
      data.draft = json(input.draft.payload)
    } else if (input.action === 'publish') {
      const draft = contentDraftSchema.parse({kind:row.kind,key:row.key,payload:row.draft})
      const publishedAt = new Date()
      const publication = draft.kind === 'announcement' ? {...draft.payload,startsAt:draft.payload.startsAt ?? publishedAt.toISOString()} : draft.payload
      if (draft.kind === 'announcement' && !publishedAnnouncementSchema.safeParse(publication).success) throw new DataAccessError(400,'ANNOUNCEMENT_TIME_INVALID','结束时间必须晚于实际开始时间。')
      const snapshot = json(publication)
      const published = await tx.siteContentVersion.create({data:{contentId:id,contentVersion:(row.versions[0]?.contentVersion ?? 0)+1,publishedAt,payload:snapshot,hash:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),effectiveAt:draft.kind === 'terms' || draft.kind === 'privacy' ? new Date(draft.payload.effectiveAt) : null}})
      data.publishedVersionId = published.id
      data.withdrawn = false
      publishedId = published.id
      if (input.replace) {
        const previous = await tx.siteContent.findUnique({where:{id:input.replace.id}})
        if (row.kind !== 'announcement' || !previous || previous.kind !== 'announcement' || previous.id === row.id || previous.deletedAt || previous.revision !== input.replace.expectedRevision) throw new DataAccessError(409,'CONTENT_REVISION_CONFLICT','待替换公告已变更，请刷新。')
        await tx.siteContent.update({where:{id:previous.id},data:{withdrawn:true,revision:{increment:1}}})
        await tx.adminAuditLog.create({data:{adminId:actorId,action:'site_content.replaced',targetType:'site_content',targetId:previous.id,ip,detail:{replacementId:id,fromRevision:previous.revision,toRevision:previous.revision+1}}})
      }
    } else if (input.action === 'withdraw') data.withdrawn = true
    else if (input.action === 'delete') data.deletedAt = new Date()
    else data.deletedAt = null
    const updated = await tx.siteContent.update({where:{id},data,include:{versions:{orderBy:{contentVersion:'desc'}}}})
    await tx.adminAuditLog.create({data:{adminId:actorId,action:`site_content.${input.action}`,targetType:'site_content',targetId:id,ip,detail:{kind:row.kind,key:row.key,fromRevision:row.revision,toRevision:updated.revision,...(publishedId ? {versionId:publishedId} : {}),...(input.replace ? {replaces:input.replace.id} : {})}}})
    return present(updated)
  })
}
function currentLegal(rows: Document[], kind: 'terms'|'privacy', now: number): PublicLegal | null {
  const row = rows.find(item => item.kind === kind && !item.deletedAt && !item.withdrawn)
  const current = row?.versions.filter(item => item.effectiveAt && item.effectiveAt.getTime() <= now).sort((a,b) => b.effectiveAt!.getTime()-a.effectiveAt!.getTime() || b.contentVersion-a.contentVersion)[0]
  return current ? {id:current.id,hash:current.hash,contentVersion:current.contentVersion,payload:legalDocumentSchema.parse(current.payload)} : null
}
export async function readPublicSiteContent(tx: Transaction = prisma): Promise<PublicSiteContent> {
  const rows = await tx.siteContent.findMany({where:{deletedAt:null,withdrawn:false},include:{versions:true}})
  const now = Date.now()
  const result: PublicSiteContent = {serverNow:new Date(now).toISOString(),nextBoundaryAt:null,announcements:[],settings:null,help:{},legal:{terms:currentLegal(rows,'terms',now),privacy:currentLegal(rows,'privacy',now),registrationAvailable:false}}
  const boundaries: number[] = []
  for (const row of rows) {
    const published = row.versions.find(item => item.id === row.publishedVersionId)
    if (!published) continue
    if (row.kind === 'announcement') {
      const payload = publishedAnnouncementSchema.parse(published.payload)
      boundaries.push(Date.parse(payload.startsAt))
      if (payload.endsAt !== null) boundaries.push(Date.parse(payload.endsAt))
      if (announcementStatus({published:true,withdrawn:false,...payload}, now) === 'active') result.announcements.push({...payload,id:row.id,contentVersion:published.contentVersion,versionId:published.id})
    } else if (row.kind === 'settings') result.settings = siteSettingsSchema.parse(published.payload)
    else if (row.kind === 'help') result.help[row.key] = helpDocumentSchema.parse(published.payload)
    else boundaries.push(...row.versions.flatMap(item => item.effectiveAt ? [item.effectiveAt.getTime()] : []))
  }
  const next = boundaries.filter(value => value > now).sort((a,b)=>a-b)[0]
  result.nextBoundaryAt = next ? new Date(next).toISOString() : null
  result.legal.registrationAvailable = Boolean(result.legal.terms && result.legal.privacy)
  return result
}
export async function verifyRegistrationConsent(tx: Transaction, consent: LegalConsent | undefined) {
  await lockSiteContent(tx)
  const {legal,serverNow} = await readPublicSiteContent(tx)
  if (!legal.terms || !legal.privacy) throw new DataAccessError(503,'POLICY_UNAVAILABLE','正式服务条款与隐私政策尚未生效，暂时无法注册。')
  if (!consent || consent.termsVersionId !== legal.terms.id || consent.privacyVersionId !== legal.privacy.id) throw new DataAccessError(409,'POLICY_CONSENT_REQUIRED','请阅读并同意当前生效的服务条款与隐私政策。')
  return { acceptedAt:new Date(serverNow), versions:[ {kind:'terms',versionId:legal.terms.id,hash:legal.terms.hash}, {kind:'privacy',versionId:legal.privacy.id,hash:legal.privacy.hash} ] }
}