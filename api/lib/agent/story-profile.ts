import type { Prisma, ProjectMemoryEntry, ProjectMemoryType } from '@prisma/client'
import { activeChapterScope } from '../data/internal.js'
import { DataAccessError } from '../prisma.js'

export const isStoryProfile = (type: ProjectMemoryType) => ['characterCard', 'itemCard', 'locationCard', 'sceneCard', 'storyArc'].includes(type)

export type ProfileWrite = {
  identityKey?: string
  aliases?: string[]
  section?: string
  knownBy?: string[] | null
  effectiveFromChapterId?: string
}

export type StoryRecallScope = { atChapterId?: string; atChapterOrder?: number; viewpointMemoryId?: string; publicOnly?: boolean }
type ProfileChange = { section: string; body: string | null; chapterId: string | null; restricted: boolean; knownBy: string[]; manual: boolean }
type ChapterOrder = Map<string, number>
const metadataPrefix = '\u001fprofile:'
const profileTitle = metadataPrefix + 'name'
const profileKey = metadataPrefix + 'key'
const profileAlias = metadataPrefix + 'alias:'

// An H2 is an addressable section. Preserve duplicate headings and ignore headings in fenced code.
export function splitProfileMarkdown(content: string) {
  const parts = new Map<string, string>()
  const counts = new Map<string, number>()
  let section = ''
  let lines: string[] = []
  let fence = ''
  const flush = () => {
    if (lines.length || section) parts.set(section, lines.join('\n').replace(/^\s*\n|\n\s*$/g, ''))
    lines = []
  }
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    const heading = !fence && /^ {0,3}##[\t ]+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      const name = heading[1]
      const ordinal = (counts.get(name) ?? 0) + 1
      counts.set(name, ordinal)
      section = ordinal === 1 ? name : `${name}\u001f${ordinal}`
    } else {
      if (marker) {
        if (!fence) fence = marker[1]
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = ''
      }
      lines.push(line)
    }
  }
  flush()
  return parts
}

/** Select from the chapter/POV projection, so a long introduction cannot crowd out the requested fact. */
export function selectProfileExcerpt(markdown: string, query: string, limit: number) {
  if (markdown.length <= limit) return markdown
  const parts = splitProfileMarkdown(markdown)
  const terms = new Set<string>()
  for (const word of query.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]/.test(word)) terms.add(word)
    else for (let i = 0; i + 1 < word.length; i++) terms.add(word.slice(i, i + 2))
  }
  const ranked = [...parts].map(([section, body]) => {
    const name = section.toLowerCase()
    const text = body.toLowerCase()
    let score = /当前|现状|持有人|所在地|近况/.test(name) ? 0.5 : 0
    let first = -1
    for (const term of terms) {
      if (name.includes(term)) score += 3
      const index = text.indexOf(term)
      if (index !== -1) { score++; if (first === -1 || first > index) first = index }
    }
    return { section, body, score, first }
  }).sort((a, b) => b.score - a.score)
  if (!ranked[0]?.score) return markdown.slice(0, limit)
  const lines = []
  let remaining = limit
  for (const hit of ranked) {
    if (remaining < 12 || !hit.score) break
    const heading = hit.section ? hit.section.split('\u001f', 1)[0] + '：' : ''
    const room = Math.max(1, remaining - heading.length)
    const start = hit.first >= room ? Math.max(0, hit.first - Math.floor(room / 4)) : 0
    const piece = (heading + (start ? '…' : '') + hit.body.slice(start)).slice(0, remaining)
    lines.push(piece)
    remaining -= piece.length + 1
  }
  return lines.join('\n') || markdown.slice(0, limit)
}

function chapterRank(id: string | null, chapters: ChapterOrder) { return id === null ? -1 : chapters.get(id) }

function visibleSections(changes: ProfileChange[], chapters: ChapterOrder, order = Infinity, viewpoint?: string, publicOnly = false) {
  // A retcon replaces the fact *and its audience* at that point in story time.
  // Select the latest revision before testing visibility to avoid returning a revoked variant.
  const atChapter = new Map<string | null, Map<string, ProfileChange>>()
  for (const change of changes) {
    const rank = chapterRank(change.chapterId, chapters)
    if (rank === undefined || rank > order) continue
    const slots = atChapter.get(change.chapterId) ?? new Map<string, ProfileChange>()
    slots.set(change.section, change)
    atChapter.set(change.chapterId, slots)
  }
  const sections = new Map<string, ProfileChange>()
  const ordered = [...atChapter.keys()].sort((a, b) => chapterRank(a, chapters)! - chapterRank(b, chapters)!)
  for (const chapter of ordered) {
    for (const change of atChapter.get(chapter)!.values()) {
      if (change.restricted && (viewpoint ? !change.knownBy.includes(viewpoint) : publicOnly)) continue
      sections.set(change.section, change)
    }
  }
  return sections
}

export function renderProfileAt(changes: ProfileChange[], chapters: ChapterOrder, order = Infinity, viewpoint?: string, layout?: string, publicOnly = false) {
  const sections = visibleSections(changes, chapters, order, viewpoint, publicOnly)
  const intro = sections.get('')?.body
  sections.delete('')
  const preferred = layout ? new Map([...splitProfileMarkdown(layout).keys()].map((name, index) => [name, index])) : new Map<string, number>()
  const blocks = [...sections.values()].filter(c => c.body !== null && !c.section.startsWith(metadataPrefix))
    .sort((a, b) => (preferred.get(a.section) ?? Infinity) - (preferred.get(b.section) ?? Infinity))
    .map(c => ('## ' + c.section.split('\u001f', 1)[0] + '\n\n' + c.body).trimEnd())
  return [intro, ...blocks].filter(Boolean).join('\n\n')
}

async function chapterOrders(db: Prisma.TransactionClient, novelId: string, ids: string[]) {
  const rows = ids.length ? await db.chapter.findMany({ where: { ...activeChapterScope(novelId), id: { in: [...new Set(ids)] } },
    select: { id: true, orderIndex: true } }) : []
  return new Map(rows.map(c => [c.id, c.orderIndex]))
}

/** Shape one update against the state *at that chapter*, then materialize the latest author view. */
export async function prepareProfileUpdate(db: Prisma.TransactionClient, novelId: string, existing: ProjectMemoryEntry | null, input: ProfileWrite & {
  content: string; title?: string; sourceChapterId?: string | null; systemDerived?: boolean; manual?: boolean; mergeSections?: boolean
}) {
  const at = input.effectiveFromChapterId ?? input.sourceChapterId ?? null
  const prior: ProfileChange[] = existing?.profileTracked
    ? await db.storyProfileChange.findMany({ where: { memoryId: existing.id }, orderBy: { id: 'asc' } }) : []
  const changes: ProfileChange[] = []
  if (existing && !existing.profileTracked) {
    const initial = splitProfileMarkdown(existing.content)
    initial.set(profileTitle, existing.title)
    if (existing.identityKey) initial.set(profileKey, existing.identityKey)
    for (const alias of existing.aliases) initial.set(profileAlias + alias, alias)
    for (const [section, body] of initial) {
      changes.push({ section, body, chapterId: existing.sourceChapterId, restricted: false, knownBy: [], manual: existing.reviewStatus === 'accepted' })
    }
  }
  const history = [...prior, ...changes]
  const chapters = await chapterOrders(db, novelId, [...history.flatMap(c => c.chapterId ? [c.chapterId] : []), ...(at ? [at] : [])])
  if (at && !chapters.has(at)) throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '设定生效章节已归档或不属于本作品。')
  const active = visibleSections(history, chapters, at ? chapters.get(at) : Infinity)
  const next = input.section ? new Map([[input.section.trim(), input.content.trim()]]) : splitProfileMarkdown(input.content)
  if ([...next.keys()].some(name => name.startsWith(metadataPrefix))) {
    throw new DataAccessError(400, 'MEMORY_INVALID_PATCH', '档案小节名含控制字符。')
  }
  const activeBody = [...active.keys()].filter(name => !name.startsWith(metadataPrefix))
  const merge = !!input.section || input.mergeSections && activeBody.some(name => name && active.get(name)?.body !== null)
  const names = new Set(merge ? next.keys() : [...next.keys(), ...activeBody])
  const addName = (field: string, value: string) => { names.add(field); next.set(field, value) }
  const formerName = existing && input.title && input.title !== existing.title
    ? [...history].reverse().find(c => c.section === profileTitle && c.body === existing.title) : undefined
  // Repeating the ID/name to address a later ordinary edit must not disclose it.
  // A reveal can explicitly publish the same name in the newly shared passage.
  const disclosedInText = (field: string, value: string) => {
    const previous = active.get(field)
    return input.content.includes(value) && (!previous || previous.restricted && (input.knownBy === null
      || input.knownBy?.some(reader => !previous.knownBy.includes(reader))))
  }
  if (input.title && (!existing || input.title !== existing.title || !history.some(c => c.section === profileTitle) || disclosedInText(profileTitle, input.title))) {
    addName(profileTitle, input.title)
    if (existing && existing.title !== input.title) addName(profileAlias + existing.title, existing.title)
  }
  if (input.identityKey && (!history.some(c => c.section === profileKey) || disclosedInText(profileKey, input.identityKey))) addName(profileKey, input.identityKey)
  for (const alias of input.aliases ?? []) if (alias.trim()) addName(profileAlias + alias.trim(), alias.trim())
  for (const section of names) {
    const previous = active.get(section)
    const former = formerName && section === profileAlias + formerName.body ? formerName : undefined
    const chapterId = former ? former.chapterId : at ?? previous?.chapterId ?? null
    const body = next.get(section) ?? null
    const restricted = former ? former.restricted : input.knownBy === undefined ? previous?.restricted ?? false : input.knownBy !== null
    const knownBy = former ? former.knownBy : input.knownBy === undefined ? previous?.knownBy ?? [] : [...new Set(input.knownBy ?? [])].sort()
    if (previous?.body === body && previous.restricted === restricted && knownBy.join() === previous.knownBy.join()
      && (section !== input.section || !input.manual || previous.manual)) continue
    if (input.systemDerived && previous?.manual && previous.chapterId === chapterId) continue
    const change = { section, body, chapterId, restricted, knownBy, manual: input.manual ?? false }
    changes.push(change)
    history.push(change)
  }
  return { changes, title: visibleSections(history, chapters).get(profileTitle)?.body,
    content: renderProfileAt(history, chapters, Infinity, undefined, merge ? existing?.content : input.content) }
}

export async function persistProfileChanges(db: Prisma.TransactionClient, memoryId: string, changes: ProfileChange[]) {
  if (changes.length) await db.storyProfileChange.createMany({ data: changes.map(change => ({ memoryId, ...change })) })
}

type RecallEntry = { id: string; content: string; title?: string; aliases?: string[]; identityKey?: string | null; memoryType: ProjectMemoryType; sourceChapterId?: string | null; profileTracked?: boolean }
export async function projectStoryMemoryAt<T extends RecallEntry>(db: Prisma.TransactionClient, novelId: string, entries: T[], scope: StoryRecallScope): Promise<T[]> {
  const scoped = !!(scope.atChapterId || scope.atChapterOrder !== undefined || scope.viewpointMemoryId || scope.publicOnly)
  if (!scoped && entries.every(e => e.profileTracked === false)) return entries
  const ids = entries.map(e => e.id)
  const metadata = entries.every(e => e.sourceChapterId !== undefined && e.profileTracked !== undefined) ? entries
    : await db.projectMemoryEntry.findMany({ where: { novelId, id: { in: ids } }, select: { id: true, sourceChapterId: true, profileTracked: true } })
  const meta = new Map(metadata.map(e => [e.id, e]))
  const profileIds = metadata.filter(e => e.profileTracked).map(e => e.id)
  const rows = profileIds.length ? await db.storyProfileChange.findMany({ where: { memoryId: { in: profileIds } }, orderBy: { id: 'asc' } }) : []
  const chapters = await chapterOrders(db, novelId, [
    ...(scope.atChapterId ? [scope.atChapterId] : []), ...metadata.flatMap(m => m.sourceChapterId ? [m.sourceChapterId] : []),
    ...rows.flatMap(r => r.chapterId ? [r.chapterId] : []),
  ])
  const order = scope.atChapterId ? chapters.get(scope.atChapterId) : scope.atChapterOrder ?? Infinity
  if (order === undefined) throw new DataAccessError(409, 'MEMORY_SOURCE_REQUIRED', '目标章节已归档或不属于本作品。')
  const byId = new Map<string, ProfileChange[]>()
  for (const row of rows) {
    const changes = byId.get(row.memoryId) ?? []
    changes.push(row)
    byId.set(row.memoryId, changes)
  }
  return entries.flatMap(entry => {
    const m = meta.get(entry.id)
    if (!m) return []
    if (m.profileTracked) {
      const history = byId.get(entry.id) ?? []
      const content = renderProfileAt(history, chapters, order, scope.viewpointMemoryId, entry.content, scope.publicOnly)
      if (!content) return []
      if (!scoped || !history.some(c => c.section === profileTitle)) return [{ ...entry, content }]
      const sections = visibleSections(history, chapters, order, scope.viewpointMemoryId, scope.publicOnly)
      const aliases = [...sections.values()].flatMap(c => c.section.startsWith(profileAlias) && c.body ? [c.body] : [])
      return [{ ...entry, content, title: sections.get(profileTitle)?.body ?? '未具名档案',
        aliases, identityKey: sections.get(profileKey)?.body ?? null }]
    }
    // Generated whole-book aggregates may contain facts copied from a later chapter.
    if (scoped && (entry.memoryType === 'storyBible' || entry.memoryType === 'volumeSummary')) return []
    if (m.sourceChapterId && (!chapters.has(m.sourceChapterId) || chapters.get(m.sourceChapterId)! > order)) return []
    return [entry]
  })
}
