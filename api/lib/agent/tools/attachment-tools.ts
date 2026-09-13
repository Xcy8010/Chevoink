import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import {
  getUploadsRootDirectory,
  MANAGED_AGENT_ATTACHMENT_PREFIX,
  readAuthorizedAgentAttachment,
  resolveManagedAttachmentPath,
} from '../../agent-attachment-storage.js'
import { extractFileText } from '../../file-extract.js'
import { getPublicHttpBytes } from '../../public-http.js'
import { prisma } from '../../prisma.js'
import { describeImageWithVision } from '../../vision-service.js'
import { defineTool } from './types.js'

/**
 * 附件理解工具（视觉旁路 + 文件提取）：
 * 纯文本主模型由 view_image 把图片发给视觉旁路换回描述；具备视觉能力的主模型可直接接收本轮附件，
 * read_file 用 pdf-parse/mammoth 提取上传文件文本。两者均为只读、三模式放行。
 */

const READ_PERMISSION = { plan: 'allow', build: 'allow', review: 'allow' } as const

/** 封面候选图前缀（novel-cover-storage 内部常量，此处镜像用于 view_image 白名单） */
const NOVEL_COVER_PREFIX = '/api/uploads/novel-covers/'

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const MAX_REMOTE_IMAGE_BYTES = 8 * 1024 * 1024
/** 外网下载时限：生图 CDN 跨境较慢（实测 2MB+ 需 ~20s），放宽到 60s */
const REMOTE_FETCH_TIMEOUT_MS = 60000
/** 魔数嗅探：Content-Type/扩展名都不可靠时的兜底格式判定 */
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))) {
    return 'image/png'
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** 下载外网图片：禁跳转、限时限体积、仅放行 png/jpeg/webp */
async function downloadRemoteImage(
  url: string,
  signal: AbortSignal,
): Promise<{ buffer: Buffer; mime: string } | null> {
  signal.throwIfAborted()
  try {
    const { bytes } = await getPublicHttpBytes(url, {
      signal, timeoutMs: REMOTE_FETCH_TIMEOUT_MS, maxBytes: MAX_REMOTE_IMAGE_BYTES,
    })
    // Neither a URL extension nor a remote Content-Type proves these are image bytes.
    const mime = sniffImageMime(bytes)
    return mime ? { buffer: bytes, mime } : null
  } catch {
    signal.throwIfAborted()
    return null
  }
}

/** URL → 磁盘绝对路径：仅放行本站附件与封面候选两个托管前缀（防 SSRF/越权读盘） */
function resolveReadableImagePath(url: string): string | null {
  if (url.startsWith(MANAGED_AGENT_ATTACHMENT_PREFIX)) {
    return resolveManagedAttachmentPath(url)
  }

  if (url.startsWith(NOVEL_COVER_PREFIX)) {
    const basename = path.basename(url)
    if (!basename || basename !== url.slice(NOVEL_COVER_PREFIX.length)) {
      return null
    }
    return path.join(getUploadsRootDirectory(), 'novel-covers', basename)
  }

  return null
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

export const viewImageTool = defineTool({
  name: 'view_image',
  title: '查看图片',
  description:
    '查看并理解一张图片（纯文本主模型收到的作者参考图、cover_generate 返回的封面候选图、novel_get_context 返回的正式封面地址，含历史外网封面链接）。本工具通过安全视觉旁路返回文字描述；若系统已说明本轮附件像素直接可见，不要为同一附件重复调用。cover_generate 后仍须查看候选以校验画面，作者询问当前封面效果时用正式封面地址查看。url 接受本站附件/封面地址、封面候选 coverAssetId 或 https 公网地址。',
  parameters: z.object({
    url: z
      .string()
      .describe('图片地址（作者附件 url、cover_generate 候选图 url 或 coverAssetId、正式封面 url 或 https 外网图片 url）'),
    focus: z
      .string()
      .max(500)
      .optional()
      .describe('查看重点（如：校验封面主体/文字是否乱码/构图是否符合提示词）；缺省为通用详细描述'),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    ctx.signal.throwIfAborted()
    let buffer: Buffer | null = null
    let mime: string | undefined
    // display 用真实图片地址：入参可能是 coverAssetId（UUID），直接展示会 404 破图
    let displayUrl = args.url

    if (args.url.startsWith('http://') || args.url.startsWith('https://')) {
      // 外网图片（历史 AI 生图直存的远程封面等）：安全校验后下载
      const remote = await downloadRemoteImage(args.url, ctx.signal)
      if (!remote) {
        return {
          output:
            'view_image 失败：该外网图片不可达、过大或不是 png/jpg/webp（仅允许 https 公网域名，禁止内网/IP 地址）。可基于文字信息继续任务，并向作者如实说明。',
        }
      }
      buffer = remote.buffer
      mime = remote.mime
    } else {
      let diskPath = resolveReadableImagePath(args.url)

      if (!diskPath) {
        // 容错：历史压缩可能只剩 coverAssetId，按归属反查候选图 url（防越权：仅限本人资源）
        const asset = await prisma.coverAsset.findFirst({
          where: { id: args.url, ownerUserId: ctx.userId },
          select: { imageUrl: true },
        })

        if (asset) {
          diskPath = resolveReadableImagePath(asset.imageUrl)
          displayUrl = asset.imageUrl
        }
      }

      if (!diskPath) {
        return {
          output: `view_image 被拒绝：${args.url} 不是可读图片地址（仅允许本会话附件、封面候选、封面候选 coverAssetId 或 https 外网图片）。请使用附件元数据、cover_generate 或 novel_get_context 返回的 url 或 coverAssetId。`,
        }
      }

      if (displayUrl.startsWith(MANAGED_AGENT_ATTACHMENT_PREFIX)) {
        buffer = await readAuthorizedAgentAttachment(displayUrl, ctx.userId)
      } else {
        try {
          buffer = await readFile(diskPath)
        } catch {
          return { output: 'view_image 失败：图片文件不存在或已失效，请作者重新发送附件。' }
        }
      }

      mime = EXT_TO_MIME[(path.extname(diskPath).slice(1) || '').toLowerCase()]

      if (!mime) {
        return { output: 'view_image 失败：该地址不是支持的图片格式（png/jpg/webp）。' }
      }
    }

    ctx.signal.throwIfAborted()
    try {
      const description = await describeImageWithVision(
        { buffer, mime },
        args.focus?.trim() ||
          '请详细描述这张图片的内容：主体、场景、文字（如有，逐字列出）、构图与风格，供网文写作与封面校验参考。',
        { userId: ctx.userId, runId: ctx.runId, signal: ctx.signal },
      )

      return {
        output: `图片观察结果：${description}`,
        summary: '查看 1 张图片',
        display: {
          kind: 'viewedImage',
          images: [{ id: path.basename(displayUrl), url: displayUrl }],
          description,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        output: `view_image 失败：${message}。可基于文字信息继续任务，并向作者如实说明本次未能查看图片。`,
      }
    }
  },
})

export const readFileTool = defineTool({
  name: 'read_file',
  title: '读取文件',
  description:
    '读取作者随消息上传的文件内容（pdf/docx/txt/md）。禁止凭文件名猜测。ZIP/DOC 及完整作品导入请使用 novel_import prepare，经用户核对与确认，不通过本工具解压或转换。返回提取的纯文本（单次最多 20000 字符，超出时用 offset 参数续读）。',
  parameters: z.object({
    url: z.string().describe('文件地址（作者附件元数据中的 url）'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('字符偏移：上次返回提示截断时，传该偏移续读后续内容'),
  }),
  permission: READ_PERMISSION,
  readOnly: true,
  async execute(ctx, args) {
    const diskPath = resolveManagedAttachmentPath(args.url)

    if (!diskPath) {
      return {
        output: `read_file 被拒绝：${args.url} 不是本会话上传的附件地址。请使用作者附件元数据中的 url。`,
      }
    }

    const buffer = await readAuthorizedAgentAttachment(args.url, ctx.userId)

    if (['.zip', '.doc'].includes(path.extname(diskPath).toLowerCase())) {
      return { outcome: 'failed', summary: '需使用作品导入', output: 'ZIP/DOC 仅作为导入原件保存，请使用 novel_import prepare，或打开作品导入面板核验。此工具未解压、未转换、未导入；DOC 转换器未开放时请另存为 DOCX。' }
    }

    try {
      const result = await extractFileText(buffer, path.basename(diskPath), args.offset ?? 0)

      if (result.totalChars === 0) {
        return {
          output:
            'read_file：未提取到任何文本。若为扫描版 PDF（图片扫描件），没有文字层，可如实告知作者。',
          summary: '读取文件（无文本）',
        }
      }

      const offset = args.offset ?? 0
      const tailNote = result.truncated
        ? `（已截断：本次返回第 ${offset}-${offset + result.text.length} 字符，全文共 ${result.totalChars} 字符；需要后续内容请再次调用 read_file 并传 offset=${offset + result.text.length}）`
        : `（全文共 ${result.totalChars} 字符，已完整返回）`

      return {
        output: `文件内容提取结果${tailNote}：\n"""\n${result.text}\n"""`,
        summary: `读取文件 · ${result.text.length} 字`,
        display: { kind: 'markdown', markdown: clip(result.text, 2000) },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { output: `read_file 失败：${message}` }
    }
  },
})
