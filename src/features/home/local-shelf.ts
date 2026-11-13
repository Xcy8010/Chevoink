/** 基于 localStorage 的本地书架（服务端书架能力未开放前的本地实现） */

export type LocalShelfEntry = {
  novelId: string
  title: string
  coverUrl: string | null
  addedAt: number
}

const STORAGE_KEY = 'chevoink-shelf'

/**
 * 书架变更订阅：任何写入（手动加/移除、云端水合注入、封面回填）都会通知订阅方，
 * 作品详情页据此重算「在架/收藏」按钮态，解决云同步落地后界面仍旧态的问题
 */
type ShelfChangeListener = () => void
const shelfChangeListeners = new Set<ShelfChangeListener>()

export function subscribeShelfChange(listener: ShelfChangeListener): () => void {
  shelfChangeListeners.add(listener)
  return () => {
    shelfChangeListeners.delete(listener)
  }
}

function notifyShelfChange() {
  shelfChangeListeners.forEach((listener) => listener())
}

// 其它标签页/WebView 写入 localStorage 时同步感知（storage 事件只在非写入方触发）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) notifyShelfChange()
  })
}

function readStore(): LocalShelfEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as LocalShelfEntry[]
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.novelId === 'string') : []
  } catch {
    return []
  }
}

function writeStore(entries: LocalShelfEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage 不可用时静默失败
  }
  notifyShelfChange()
}

export function getLocalShelf(): LocalShelfEntry[] {
  if (typeof window === 'undefined') return []
  return readStore().sort((left, right) => right.addedAt - left.addedAt)
}

export function isInShelf(novelId: string): boolean {
  if (typeof window === 'undefined') return false
  return readStore().some((entry) => entry.novelId === novelId)
}

export function addToShelf(entry: Omit<LocalShelfEntry, 'addedAt'>) {
  if (typeof window === 'undefined') return
  const entries = readStore().filter((item) => item.novelId !== entry.novelId)
  entries.unshift({ ...entry, addedAt: Date.now() })
  writeStore(entries)
}

export function removeFromShelf(novelId: string) {
  if (typeof window === 'undefined') return
  writeStore(readStore().filter((entry) => entry.novelId !== novelId))
}

/** 回填书架条目封面（收藏时还没封面、之后作品补了封面的场景） */
export function updateShelfCover(novelId: string, coverUrl: string) {
  updateShelfCovers(new Map([[novelId, coverUrl]]))
}

export function updateShelfCovers(covers: ReadonlyMap<string, string>) {
  if (typeof window === 'undefined' || covers.size === 0) return
  const entries = readStore()
  let changed = false
  for (const entry of entries) {
    const cover = covers.get(entry.novelId)
    if (cover === undefined || entry.coverUrl === cover) continue
    entry.coverUrl = cover
    changed = true
  }
  if (changed) writeStore(entries)
}

/** 切换书架状态，返回切换后是否在书架中 */
export function toggleShelf(entry: Omit<LocalShelfEntry, 'addedAt'>): boolean {
  if (isInShelf(entry.novelId)) {
    removeFromShelf(entry.novelId)
    return false
  }

  addToShelf(entry)
  return true
}

/** 水合注入：按指定 addedAt 直接写入一条书架记录（服务端数据回填本地缓存） */
export function upsertShelfRaw(entry: LocalShelfEntry) {
  if (typeof window === 'undefined') return
  const entries = readStore().filter((item) => item.novelId !== entry.novelId)
  entries.unshift(entry)
  writeStore(entries)
}
