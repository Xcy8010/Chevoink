import { Router, type Request, type Response } from 'express'

import {
  FIXED_NOVEL_COVER_HEIGHT,
  FIXED_NOVEL_COVER_WIDTH,
  bulkReplacePreviewRequestSchema,
  createChapterSchema,
  createVolumeSchema,
  deleteVolumeSchema,
  mergeChaptersSchema,
  moveChapterSchema,
  moveVolumeSchema,
  createNovelSchema,
  publishNovelSchema,
  projectSearchRequestSchema,
  splitChapterSchema,
  updateChapterSchema,
  updateVolumeSchema,
  updateNovelSchema,
  uploadNovelCoverSchema,
} from '../../shared/contracts/index.js'
import { getPublicSessionUserId, getSessionUserId, requireSessionUserId } from '../lib/auth-session.js'
import {
  createChapterData,
  createUploadedCoverAssetData,
  createNovelData,
  createVolumeData,
  previewBulkReplaceData,
  deleteNovelData,
  deleteChapterData,
  deleteVolumeData,
  getChapterData,
  getNovelDetailData,
  getReaderPayloadData,
  getStudioPayloadData,
  getStructureReportData,
  listVolumesData,
  listNovelCardsByIdsData,
  listChangeSetsData,
  listNovelsData,
  publishNovelData,
  mergeChaptersData,
  moveChapterData,
  moveVolumeData,
  splitChapterData,
  setNovelFavoriteData,
  searchProjectData,
  updateChapterData,
  updateNovelData,
  updateVolumeData,
} from '../lib/data-access.js'
import { buildError, buildSuccess, createRequestId, parsePositiveInt } from '../lib/http.js'
import { buildNovelExportZip } from '../lib/export-service.js'
import { createStoredExport, getStoredExportByToken } from '../lib/export-store.js'
import { storeNovelCoverDataUrl } from '../lib/novel-cover-storage.js'
import { parseBody } from '../lib/parse-body.js'
import { sendRouteError } from '../lib/route-error.js'
import { requireAgent2Feature } from '../lib/agent2-feature-flags.js'
import { novelExportSchema as exportNovelSchema } from '../../shared/contracts/novel-export.js'

const router = Router()

async function handleNovelDetailRequest(req: Request, res: Response, novelId: string): Promise<void> {
  const requestId = createRequestId()

  try {
    const payload = await getNovelDetailData(novelId, getPublicSessionUserId(req))
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  const page = parsePositiveInt(req.query.page, 1)
  const pageSize = parsePositiveInt(req.query.pageSize, 12)
  const authorId = typeof req.query.authorId === 'string' && req.query.authorId.trim() ? req.query.authorId.trim() : undefined
  const publishedOnly = req.query.status === 'published'
  const tag = typeof req.query.tag === 'string' && req.query.tag.trim() ? req.query.tag.trim() : undefined

  try {
    const payload = await listNovelsData(page, pageSize, { authorId, publishedOnly, tag })
    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(createNovelSchema, req.body, '请完整填写作品标题和简介。')

    const novel = await createNovelData(userId, {
      title: body.title.trim(),
      displayTitle: body.displayTitle,
      summary: body.summary.trim(),
      categoryId: body.categoryId,
      tags: body.tags,
      visibility: body.visibility,
      status: body.status,
    })

    res.status(201).json(buildSuccess(requestId, { novel }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/detail', async (req: Request, res: Response): Promise<void> => {
  await handleNovelDetailRequest(req, res, req.params.novelId)
})

// 批量轻量卡片（首页继续阅读，方案 20 §2.5）：必须先于 /:novelId 注册，避免被动态段吞掉
router.get('/cards', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  const idsParam = typeof req.query.ids === 'string' ? req.query.ids : ''
  const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean)

  try {
    const items = await listNovelCardsByIdsData(ids, getSessionUserId(req))
    res.status(200).json(buildSuccess(requestId, { items }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 一键导出产物匿名下载：APP 壳外跳系统浏览器后无会话 Cookie，只验 token（randomUUID + TTL 15 分钟）；
// 必须先于 /:novelId 注册，避免被动态段吞掉
router.get('/exports/:exportId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const stored = getStoredExportByToken(req.params.exportId)

    if (!stored) {
      res.status(404).json(buildError(requestId, 'EXPORT_NOT_FOUND', '导出文件不存在或已过期，请重新导出。'))
      return
    }

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(stored.fileName)}`)
    res.status(200).send(stored.buffer)
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId', async (req: Request, res: Response): Promise<void> => {
  await handleNovelDetailRequest(req, res, req.params.novelId)
})

router.patch('/:novelId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    // 原零校验透传：schema 仅做错型拦截与字段白名单 strip，空值校验仍在 data 层
    const body = parseBody(updateNovelSchema, req.body, '作品信息格式不正确。')
    const novel = await updateNovelData(userId, req.params.novelId, body)

    if (!novel) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { novel }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/:novelId/cover', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(uploadNovelCoverSchema, req.body, '请提供作品封面图片。')

    const imageUrl = await storeNovelCoverDataUrl(body.coverDataUrl.trim())
    const asset = await createUploadedCoverAssetData({
      userId,
      novelId: req.params.novelId,
      imageUrl,
      width: FIXED_NOVEL_COVER_WIDTH,
      height: FIXED_NOVEL_COVER_HEIGHT,
    })
    const novel = await updateNovelData(userId, req.params.novelId, { coverAssetId: asset.id })

    if (!novel) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { novel, asset }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

async function handleNovelFavorite(req: Request, res: Response, favorited: boolean): Promise<void> {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await setNovelFavoriteData(userId, req.params.novelId, favorited)

    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
}

router.post('/:novelId/favorite', (req, res) => handleNovelFavorite(req, res, true))
router.delete('/:novelId/favorite', (req, res) => handleNovelFavorite(req, res, false))

router.post('/:novelId/publish', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(publishNovelSchema, req.body, '发布参数不正确。')
    const visibility = body.visibility ?? 'public'

    const payload = await publishNovelData(userId, req.params.novelId, body.chapterIds, visibility)

    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 一键导出：服务端组装 zip（规划/目录/章节/作品信息以及发布建议），二进制流直接下发
router.post('/:novelId/export', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(exportNovelSchema, req.body, '导出选项格式不正确。')
    const result = await buildNovelExportZip(userId, req.params.novelId, body)

    // 发布建议因额度用尽未生成时用响应头告知前端（二进制流无法携带 JSON 说明），前端据此弹兑底提示
    if (result.adviceCreditsExhausted) {
      res.setHeader('X-Advice-Credits-Exhausted', '1')
    }

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`)
    res.status(200).send(result.buffer)
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

// 一键导出（APP 壳专用）：服务端打包并暂存，返回一次性下载链接；
// 壳内 WebView 会吞掉 blob/同源下载，前端拿链接外跳系统浏览器完成保存
router.post('/:novelId/export-link', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(exportNovelSchema, req.body, '导出选项格式不正确。')
    const result = await buildNovelExportZip(userId, req.params.novelId, body)
    const exportId = createStoredExport(userId, result.buffer, result.fileName)

    res.status(200).json(
      buildSuccess(requestId, {
        exportId,
        downloadUrl: `/api/novels/exports/${exportId}`,
        fileName: result.fileName,
        adviceCreditsExhausted: result.adviceCreditsExhausted ?? false,
      }),
    )
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/:novelId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const deleted = await deleteNovelData(userId, req.params.novelId)

    if (!deleted) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { deleted: true as const, novelId: req.params.novelId }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/studio', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const payload = await getStudioPayloadData(userId, req.params.novelId)
    if (!payload) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/reader/:chapterId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const payload = await getReaderPayloadData(req.params.novelId, req.params.chapterId, getPublicSessionUserId(req))
    if (!payload) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节内容。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, payload))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/volumes', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const items = await listVolumesData(requireSessionUserId(req), req.params.novelId)
    res.status(200).json(buildSuccess(requestId, { items }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/search', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('changeSet', userId)
    const body = parseBody(projectSearchRequestSchema, req.body, '检索参数不正确。')
    const result = await searchProjectData(userId, req.params.novelId, body)
    res.status(200).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/changesets', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('changeSet', userId)
    const items = await listChangeSetsData(userId, req.params.novelId)
    res.status(200).json(buildSuccess(requestId, { items }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/changesets/preview', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('changeSet', userId)
    const body = parseBody(bulkReplacePreviewRequestSchema, req.body, '变更预览参数不正确。')
    const changeSet = await previewBulkReplaceData(userId, req.params.novelId, body)
    res.status(201).json(buildSuccess(requestId, { changeSet }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/volumes', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const body = parseBody(createVolumeSchema, req.body, '请填写卷标题。')
    const volume = await createVolumeData(userId, req.params.novelId, body)
    res.status(201).json(buildSuccess(requestId, { volume }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/:novelId/volumes/:volumeId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const body = parseBody(updateVolumeSchema, req.body, '卷信息格式不正确。')
    const volume = await updateVolumeData(userId, req.params.novelId, req.params.volumeId, body)
    if (!volume) {
      res.status(404).json(buildError(requestId, 'VOLUME_NOT_FOUND', '未找到卷。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { volume }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/volumes/:volumeId/move', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const body = parseBody(moveVolumeSchema, req.body, '卷移动参数不正确。')
    const volume = await moveVolumeData(userId, req.params.novelId, req.params.volumeId, body)
    if (!volume) {
      res.status(404).json(buildError(requestId, 'VOLUME_NOT_FOUND', '未找到卷。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { volume }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/:novelId/volumes/:volumeId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const input = req.body && Object.keys(req.body).length ? parseBody(deleteVolumeSchema, req.body, '卷删除参数不正确。') : undefined
    const deleted = await deleteVolumeData(userId, req.params.novelId, req.params.volumeId, undefined, input)
    if (!deleted) {
      res.status(404).json(buildError(requestId, 'VOLUME_NOT_FOUND', '未找到卷。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { deleted: true as const }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/structure', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const report = await getStructureReportData(requireSessionUserId(req), req.params.novelId)
    res.status(200).json(buildSuccess(requestId, { report }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/chapters/:chapterId/move', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const body = parseBody(moveChapterSchema, req.body, '章节移动参数不正确。')
    const chapter = await moveChapterData(userId, req.params.novelId, req.params.chapterId, body)
    if (!chapter) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { chapter }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/chapters/:chapterId/split', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const body = parseBody(splitChapterSchema, req.body, '章节拆分参数不正确。')
    const result = await splitChapterData(userId, req.params.novelId, req.params.chapterId, body)
    if (!result) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节。'))
      return
    }
    res.status(201).json(buildSuccess(requestId, result))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/chapters/:chapterId/merge', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()
  try {
    const userId = requireSessionUserId(req)
    requireAgent2Feature('volume', userId)
    const body = parseBody(mergeChaptersSchema, req.body, '章节合并参数不正确。')
    const chapter = await mergeChaptersData(userId, req.params.novelId, req.params.chapterId, body)
    if (!chapter) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到待合并章节。'))
      return
    }
    res.status(200).json(buildSuccess(requestId, { chapter }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.post('/:novelId/chapters', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const body = parseBody(createChapterSchema, req.body, '请完整填写章节信息。')

    const chapter = await createChapterData(
      userId,
      req.params.novelId,
      {
        title: body.title.trim(),
        summary: body.summary,
        content: body.content,
        status: body.status,
        visibility: body.visibility,
        volumeId: body.volumeId,
        orderInVolume: body.orderInVolume,
      },
      body.visibility ?? 'public',
    )

    if (!chapter) {
      res.status(404).json(buildError(requestId, 'NOVEL_NOT_FOUND', '未找到作品。'))
      return
    }

    res.status(201).json(buildSuccess(requestId, { chapter }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.get('/:novelId/chapters/:chapterId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const chapter = await getChapterData(userId, req.params.novelId, req.params.chapterId)

    if (!chapter) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { chapter }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.patch('/:novelId/chapters/:chapterId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    // 原零校验透传：schema 仅做错型拦截与字段白名单 strip，空值校验仍在 data 层
    const body = parseBody(updateChapterSchema, req.body, '章节信息格式不正确。')
    const chapter = await updateChapterData(userId, req.params.novelId, req.params.chapterId, body)

    if (!chapter) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { chapter }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

router.delete('/:novelId/chapters/:chapterId', async (req: Request, res: Response): Promise<void> => {
  const requestId = createRequestId()

  try {
    const userId = requireSessionUserId(req)
    const rawExpectedRevision = req.query.expectedRevision
    let expectedRevision: number | undefined
    if (rawExpectedRevision !== undefined) {
      const normalized = Array.isArray(rawExpectedRevision) ? rawExpectedRevision[0] : rawExpectedRevision
      const parsedRevision = typeof normalized === 'string' ? Number(normalized) : Number.NaN
      if (
        typeof normalized !== 'string' ||
        !/^[1-9]\d*$/.test(normalized) ||
        !Number.isSafeInteger(parsedRevision)
      ) {
        res.status(400).json(buildError(requestId, 'VALIDATION_ERROR', '章节版本格式不正确。'))
        return
      }
      expectedRevision = parsedRevision
    }
    const deleted = await deleteChapterData(
      userId,
      req.params.novelId,
      req.params.chapterId,
      expectedRevision,
    )

    if (!deleted) {
      res.status(404).json(buildError(requestId, 'CHAPTER_NOT_FOUND', '未找到章节。'))
      return
    }

    res.status(200).json(buildSuccess(requestId, { deleted: true }))
  } catch (error) {
    sendRouteError(res, requestId, error)
  }
})

export default router
