/**
 * data-access 聚合桶：保持既有 import 路径（api/lib/data-access.js）不变，
 * 12 处下游零改动；实现在 api/lib/data/<domain>.ts。
 */
export * from './data/internal.js'
export * from './data/topic.js'
export * from './data/home.js'
export * from './data/novel.js'
export * from './data/chapter.js'
export * from './data/volume.js'
export * from './data/changeset.js'
export * from './data/comment.js'
export * from './data/post.js'
export * from './data/reading.js'
export * from './data/search.js'
export * from './data/user.js'
export * from './data/message.js'
export * from './data/cover.js'
export * from './data/feedback.js'
export * from './data/admin.js'
export * from './data/admin-analytics.js'
