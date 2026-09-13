import type { NovelImportStatus } from '../../../../shared/contracts/novel-import.js'

const STATUS: Record<NovelImportStatus, string> = {
  uploading: '等待上传文件', uploaded: '文件已上传，等待解析', parsing: '正在解析', needs_review: '需要核对预览', ready: '预览已就绪',
  awaiting_confirmation: '等待确认导入', succeeded: '导入已完成', failed: '处理未完成', cancelled: '任务已取消', expired: '任务已过期',
}

export function importStatusLabel(status: string): string {
  return Object.prototype.hasOwnProperty.call(STATUS, status) ? STATUS[status as NovelImportStatus] : '状态待核对，请查询任务'
}

const ERRORS: Record<string, string> = {
  IMPORT_ENCODING_AMBIGUOUS: '文本编码需要确认。请手动选择 UTF-8、UTF-16LE/BE 或 GB18030，再重试解析。',
  IMPORT_NO_BODY: '未识别到非空正文。请选择含原文正文的文件，不能只导入目录、封面或规划。',
  IMPORT_CHAPTER_TOO_LONG: '存在超过 10 万字符的章节。请在原文光标处拆分，全部章节符合上限后再导入。',
  IMPORT_CHAPTER_TOO_LARGE: '存在超过 10 万字符的章节。请在原文光标处拆分，全部章节符合上限后再导入。',
  IMPORT_INCOMPLETE_CONTENT: '仍有未处理的正文或来源问题。请查看预览警告，修正原文件后重新解析。',
  IMPORT_TARGET_CHANGED: '当前作品已变化。请重新检查覆盖条件并确认，旧批准不能继续使用。',
  IMPORT_PREVIEW_CHANGED: '服务端预览已更新。请查询任务状态并重新核对，不能提交旧预览。',
  IMPORT_APPROVAL_EXPIRED: '人工确认已过期。请重新检查覆盖条件，重新确认后再提交。',
  IMPORT_APPROVAL_REQUIRED: '尚未完成所需人工确认。请重新检查覆盖条件，按步骤确认。',
  IMPORT_WRITE_BUSY: '当前有写入或解析任务占用。请等待其完成后手动重试，不会自动暂停其他任务。',
  IMPORT_OVERWRITE_DISABLED: '已有章节的覆盖导入尚未开放（包括空白章节）。请使用没有章节的作品。',
  IMPORT_PUBLISHED_OVERWRITE_BLOCKED: '存在已发布内容或发布历史，当前不允许覆盖。请使用新的未发布作品。',
  IMPORT_RESTORE_DISABLED: '恢复功能尚未开放。请保留备份回执，不要依赖当前界面恢复作品。',
  IMPORT_RESTORE_CONFLICT: '导入后已有新编辑，恢复已阻止。请先导出当前稿件并核对差异。',
  IMPORT_RESTORE_UNAVAILABLE: '当前备份无法恢复。请保留任务编号并联系支持，不要重复覆盖。',
  IMPORT_DISABLED: '服务器尚未开放一键导入，请稍后再试。',
  IMPORT_UNSUPPORTED_FORMAT: '当前格式尚未开放。请查看服务器格式说明并选择可用格式。',
  IMPORT_CONVERT_FAILED: '文档转换失败。请检查文件是否损坏，或另存为当前支持的格式。',
  IMPORT_PASSWORD_REQUIRED: '文件受密码保护。请先解除密码，再重新上传。',
  IMPORT_ARCHIVE_UNSAFE: 'ZIP 未通过安全检查。请重新打包正常文件，移除嵌套压缩包及异常路径。',
  IMPORT_ARCHIVE_CORRUPT: 'ZIP 损坏或无法完整读取。请重新导出或打包后上传。',
  IMPORT_ARCHIVE_ROOT_AMBIGUOUS: 'ZIP 包含多个作品根目录。请只保留本次要导入的一部作品后重试。',
  IMPORT_ARCHIVE_STRUCTURE_AMBIGUOUS: 'ZIP 的卷章层级无法可靠识别。请整理单一作品的目录后重新上传。',
  IMPORT_ARCHIVE_MEMBER_FAILED: 'ZIP 中部分文件未能解析。请修复这些文件，不能把部分正文当作全书导入。',
  IMPORT_VISION_REQUIRED: '扫描页或图片正文需要 OCR/视觉识别，当前未开放。请转换为可核对的文本后导入。',
  IMPORT_PDF_COMPLETENESS_UNVERIFIED: 'PDF 正文完整性未能确认。请检查缺失页或改用文字格式，不能直接视为完整识别。',
  IMPORT_PDF_PAGE_FAILED: 'PDF 有页面解析失败。请检查问题页或转换为文字格式后重试。',
  IMPORT_PDF_TEXT_INVALID: 'PDF 文字层异常。请转换为可靠的文字文档后重试。',
  IMPORT_LIMIT_EXCEEDED: '文件、正文或卷章数量超过限制。请拆分文件，服务不会自动截断正文。',
  IMPORT_DAILY_JOB_LIMIT: '今日导入任务数量已达上限。请稍后再试，不要连续新建任务。',
  IMPORT_DAILY_UPLOAD_LIMIT: '今日导入上传量已达上限。请稍后再试。',
  IMPORT_MODEL_UNAVAILABLE: '当前选择的模型不可用。请回到输入框确认模型配置，不会自动换用其他付费模型。',
  IMPORT_SOURCE_UNAVAILABLE: '原文件已过期、清理或暂不可读取。请保留任务编号，必要时重新上传原文件。',
  IMPORT_SOURCE_INVALID: '来源文件未通过校验。请重新选择原文件或核对附件归属。',
  IMPORT_SOURCE_CHANGED: '原文件校验不一致，已停止处理。请重新上传可信的原文件。',
  IMPORT_ATTACHMENT_SCOPE: '附件与当前用户、作品或任务不匹配。请从本任务重新选择附件。',
  IMPORT_NOT_FOUND: '任务不存在或不属于当前作品。请返回对应作品核对任务编号。',
  IMPORT_EXPIRED: '任务已过期。请重新上传原文件并完成确认。',
  IMPORT_CANCELLED: '任务已取消。如需继续，请重新准备文件和确认。',
  IMPORT_PARSE_CANCELLED: '解析被中止或超时。请查询状态后手动重试，已导入状态以回执为准。',
  IMPORT_PARSE_FAILED: '文件解析未完成。请检查原文件、编码和格式说明后手动重试。',
  IMPORT_LEASE_LOST: '任务执行权已交接。请查询服务器状态，不要重复新建任务。',
  IMPORT_IDEMPOTENCY_CONFLICT: '检测到不一致的重复提交。请先查询任务回执，不要新建任务重复导入。',
  IMPORT_ALREADY_COMMITTED: '任务已经提交。请查询原回执，不要重复导入。',
  IMPORT_PREVIEW_UNAVAILABLE: '预览尚不可读取。请查询解析状态，完成后再核对。',
  IMPORT_STATE_INVALID: '当前任务状态不允许此操作。请查询最新状态后按提示继续。',
}

export function importErrorMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : '服务端未能完成此步骤。请先查询任务状态，再按格式说明重试；不要重复提交。必要时提供任务编号和错误码联系支持。'
}
