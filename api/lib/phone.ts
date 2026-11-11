import { DataAccessError } from './prisma.js'

export function normalizePhoneNumber(input: string): string {
  const normalized = input.replace(/[\s-]/g, '').trim()

  if (!normalized) {
    throw new DataAccessError(400, 'VALIDATION_ERROR', '请输入手机号。')
  }

  if (/^\+?[1-9]\d{7,14}$/.test(normalized)) {
    return normalized.startsWith('+') ? normalized : `+${normalized}`
  }

  if (/^0086\d{11}$/.test(normalized)) {
    return `+86${normalized.slice(4)}`
  }

  if (/^86\d{11}$/.test(normalized)) {
    return `+${normalized}`
  }

  if (/^1\d{10}$/.test(normalized)) {
    return `+86${normalized}`
  }

  throw new DataAccessError(400, 'VALIDATION_ERROR', '手机号格式不正确。')
}

export function normalizeAccountPhoneNumber(input: string): string {
  const digits = input.replace(/[\s-]/g, '')
  return /^1\d{10}$/.test(digits) ? `+86${digits}` : normalizePhoneNumber(digits)
}

export function maskPhoneNumber(phone: string): string {
  const normalized = phone.replace(/^\+86/, '')

  if (normalized.length < 7) {
    return phone
  }

  return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
}
