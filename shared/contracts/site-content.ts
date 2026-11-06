import { z } from 'zod'

const text = z.string().trim().max(20000)
export const safeSiteLinkSchema = z.string().max(2000).refine(value => {
  if (/^\/(?!\/)[a-zA-Z0-9/?#=&%._~-]*$/.test(value)) return true
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
}, '仅支持站内路径或 HTTPS 链接')
// Navigation routes are the normal public/user AppShell entries in app/route-config.
export const publicNavigationPaths = ['/', '/discover', '/rankings', '/search', '/studio', '/community', '/messages', '/me', '/me/follows', '/me/likes', '/settings', '/account', '/account/profile', '/account/usage', '/account/posts', '/account/billing', '/account/plan', '/account/docs', '/login', '/register', '/create', '/legal', '/version'] as const
export const siteNavigationLinkSchema = safeSiteLinkSchema.refine(value => {
  if (/^https:/i.test(value)) return true
  try {
    const url = new URL(value, 'https://navigation.invalid')
    const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'
    if (Array.from(pathname).some(character => character === '\\' || character.charCodeAt(0) < 32)) return false
    return publicNavigationPaths.some(route => route === pathname.toLowerCase()) || /^\/(?:studio\/novel\/[^/]+|novel\/[^/]+(?:\/read\/[^/]+)?|community\/topic\/[^/]+|author\/[^/]+(?:\/follows)?|post\/[^/]+)$/i.test(pathname)
  } catch { return false }
}, '请选择有效的站内页面或安全 HTTPS 链接')
export const safeSiteAssetLinkSchema = safeSiteLinkSchema
export const siteSettingsSchema = z.object({
  name: z.string().trim().min(1).max(80), logoUrl: safeSiteAssetLinkSchema.nullable(),
  footer: text, about: text, contact: z.object({ label: z.string().trim().max(120), url: safeSiteLinkSchema.nullable(), details: text }),
  docsLabel: z.string().trim().min(1).max(80),
  navigation: z.array(z.object({ label: z.string().trim().min(1).max(80), url: siteNavigationLinkSchema })).max(12),
})
export const helpKeys = ['what-is','quick-start','writing-agent','multi-window','novel-structure','approval','skills','tasks','memory','cover','reader','community','discover','credits','invite','plan','custom-models','settings','privacy','faq','changelog'] as const
export const helpDocumentSchema = z.object({
  title: z.string().trim().min(1).max(160), summary: text,
  sections: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]+$/).max(80), heading: z.string().trim().min(1).max(160), paragraphs: z.array(text).max(40).optional(), bullets: z.array(text).max(40).optional() })).min(1).max(40),
}).refine(value => new Set(value.sections.map(section => section.id)).size === value.sections.length, '章节编号不能重复')
const announcementFields = {
  title: z.string().trim().min(1).max(160), body: text.min(1),
  scope: z.enum(['home','studio','both']), startsAt: z.iso.datetime().nullable(), endsAt: z.iso.datetime().nullable(),
  dismissal: z.discriminatedUnion('mode', [z.object({ mode: z.literal('session') }),z.object({ mode: z.literal('ttl'), seconds: z.number().int().min(60).max(31536000) }),z.object({ mode: z.literal('version') })]),
}
// Draft null start means server publication time; null end means no expiry.
export const announcementSchema = z.object(announcementFields).refine(value => value.startsAt === null || value.endsAt === null || Date.parse(value.endsAt) > Date.parse(value.startsAt), '结束时间必须晚于开始时间')
export const publishedAnnouncementSchema = z.object({...announcementFields, startsAt:z.iso.datetime()}).refine(value => value.endsAt === null || Date.parse(value.endsAt) > Date.parse(value.startsAt), '结束时间必须晚于实际发布时间')
export type PublishedAnnouncement = z.infer<typeof publishedAnnouncementSchema>
export const legalDocumentSchema = z.object({ title: z.string().trim().min(1).max(160), body: text.min(1), effectiveAt: z.iso.datetime() })
export const contentDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('announcement'), key: z.string().regex(/^[a-z0-9-]+$/).max(80), payload: announcementSchema }),
  z.object({ kind: z.literal('settings'), key: z.literal('main'), payload: siteSettingsSchema }),
  z.object({ kind: z.literal('help'), key: z.enum(helpKeys), payload: helpDocumentSchema }).refine(value => value.payload.sections.length === helpSectionIds[value.key].length && value.payload.sections.every(section => helpSectionIds[value.key].includes(section.id)), '请保留现有文档章节编号'),
  z.object({ kind: z.literal('terms'), key: z.literal('terms'), payload: legalDocumentSchema }),
  z.object({ kind: z.literal('privacy'), key: z.literal('privacy'), payload: legalDocumentSchema }),
])
export type ContentDraft = z.infer<typeof contentDraftSchema>
export type Announcement = z.infer<typeof announcementSchema>
export type SiteSettings = z.infer<typeof siteSettingsSchema>
export type HelpDocument = z.infer<typeof helpDocumentSchema>
export type LegalDocument = z.infer<typeof legalDocumentSchema>
export const legalConsentSchema = z.object({ termsVersionId: z.string().min(1).max(64), privacyVersionId: z.string().min(1).max(64) })
export type LegalConsent = z.infer<typeof legalConsentSchema>
export type ContentVersion = { id: string; contentVersion: number; hash: string; payload: ContentDraft['payload']; publishedAt: string }
export type ContentRow = ContentDraft & { id: string; revision: number; deletedAt: string | null; withdrawn: boolean; status: 'draft'|'scheduled'|'active'|'ended'|'withdrawn'; published: ContentVersion | null; history: ContentVersion[] }
export type PublicLegal = { id: string; hash: string; contentVersion: number; payload: LegalDocument }
export type PublicSiteContent = {
  serverNow: string; nextBoundaryAt: string | null;
  announcements: Array<PublishedAnnouncement & { id: string; contentVersion: number }>;
  settings: SiteSettings | null; help: Record<string, HelpDocument>;
  legal: { terms: PublicLegal | null; privacy: PublicLegal | null; registrationAvailable: boolean };
}
export function announcementStatus(input: { published: boolean; withdrawn: boolean; startsAt?: string | null; endsAt?: string | null }, now: number): ContentRow['status'] {
  if (input.withdrawn) return 'withdrawn'
  if (!input.published) return 'draft'
  if (now < Date.parse(input.startsAt!)) return 'scheduled'
  if (input.endsAt != null && now >= Date.parse(input.endsAt)) return 'ended'
  return 'active'
}
export const helpSectionIds: Record<string, readonly string[]> = {"what-is":["positioning","philosophy","workspaces"],"quick-start":["register","first-novel","first-chapter"],"writing-agent":["conversation","tools","resume"],"multi-window":["why","how","review"],"novel-structure":["hierarchy","chapter-states","visibility"],"approval":["why-approval","changeset","auto"],"skills":["what-is-skill","create","lifecycle","manage"],"tasks":["task-list","branch","delete"],"memory":["what","maintain"],"cover":["generate","apply"],"reader":["immersive","notes","tts"],"community":["posts","interact"],"discover":["discover","rankings","search"],"credits":["what","reset","records","billing"],"invite":["how","reward"],"plan":["beta","future"],"custom-models":["what","config","security"],"settings":["appearance","preferences"],"privacy":["dimensions","content-visibility","data"],"faq":["credits-out","agent-stop","security","delete","model-choose","publish-review"],"changelog":["v3","v2","v1"]}
export const policyProtectedHelpSections: Record<string, readonly string[]> = { 'quick-start':['register'], credits:['what','reset'], invite:['reward'], plan:['beta','future'], faq:['credits-out'] }
