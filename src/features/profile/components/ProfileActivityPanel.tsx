import { BookmarkedPostsPanel, LikedPostsPanel, RepliesPanel } from './UserContentPanels'

const panels = {
  bookmarks: BookmarkedPostsPanel,
  liked: LikedPostsPanel,
  replies: RepliesPanel,
}

export default function ProfileActivityPanel({ panel, userId }: { panel: keyof typeof panels; userId: string }) {
  const Panel = panels[panel]
  return <Panel userId={userId} isSelf />
}
