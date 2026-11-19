export const graphKinds = { character: 'characterCard', item: 'itemCard', location: 'locationCard', scene: 'sceneCard' } as const
export type ProfileKind = typeof graphKinds[keyof typeof graphKinds]
type Subject = { id?: string; memoryType: ProfileKind; title: string; aliases: string[] }
type Entity = { entityType: string; canonicalName: string; aliases: { alias: string }[] }

/** A shared name alone cannot identify which of two characters appeared. */
export function findProfileMentions(text: string, cards: Subject[], entities: Entity[]) {
  const subjects = cards.map(card => ({ ...card }))
  for (const entity of entities) {
    const kind = graphKinds[entity.entityType as keyof typeof graphKinds]
    if (!kind) continue
    const matches = subjects.filter(s => s.memoryType === kind && (s.title === entity.canonicalName || s.aliases.includes(entity.canonicalName)))
    const names = entity.aliases.map(a => a.alias)
    if (matches.length === 1) matches[0].aliases = [...new Set([...matches[0].aliases, ...names])]
    // A graph alias may reveal an identity that is only established later in the novel.
    else if (!matches.length && text.includes(entity.canonicalName)) subjects.push({ memoryType: kind, title: entity.canonicalName, aliases: [] })
  }
  const owners = new Map<string, Set<Subject>>()
  for (const subject of subjects) for (const name of [subject.title, ...subject.aliases]) {
    if (!name.trim()) continue
    const candidates = owners.get(name) ?? new Set<Subject>()
    candidates.add(subject)
    owners.set(name, candidates)
  }
  const mentions = new Map<Subject, { start: number; end: number }>()
  const word = /[\p{Script=Latin}\d_]/u
  for (const [name, candidates] of owners) {
    if (candidates.size !== 1) continue
    const [subject] = candidates
    for (let start = text.indexOf(name); start !== -1; start = text.indexOf(name, start + name.length)) {
      const end = start + name.length
      if (word.test(name[0]) && word.test(text[start - 1] ?? '') || word.test(name.at(-1)!) && word.test(text[end] ?? '')) continue
      const old = mentions.get(subject)
      if (!old || start < old.start || start === old.start && end > old.end) mentions.set(subject, { start, end })
      break
    }
  }
  return [...mentions].map(([subject, span]) => ({ ...subject, span }))
}
