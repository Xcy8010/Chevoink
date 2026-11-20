import type { Request } from 'express'

const clients = new Set(['应用', 'Edge', 'Firefox', 'Chrome', 'Safari'])
const commercialName = /^(?:(?:Google )?Pixel|Nexus|(?:Samsung )?Galaxy|Redmi|POCO|Xiaomi|Mi|Honor|Huawei|OnePlus|OPPO|realme|vivo|iQOO|moto(?:rola)?|Xperia|Nothing Phone|Zenfone|ROG Phone|Surface|iPhone|iPad|MacBook)\s+(.+)$/i
const modelWord = /^(?:[a-z]{0,4}\d+[a-z\d+.-]{0,8}|pro\+?|plus|xl|max|mini|air|edge|ultra|fold|flip|note|mate|find|reno|magic|lite|pad|tab|tablet|book|neo|gt|fe|s|z|g|a|m|t|x)$/i
const productCode = /^(?:SM-[A-Z][0-9]{3,4}[A-Z0-9]{0,3}|[A-Z]{1,4}[-_]?[0-9]{2,6}[A-Z0-9]{0,4}|[0-9]{4,7}[A-Z]{1,5}[A-Z0-9]{1,5}|[A-Z]{2,5}-[A-Z]{1,4}[0-9]{2,4})$/

function validModel(value: string) {
  // Model hints are client-reported display metadata. Accept product-shaped labels;
  // never persist an arbitrary header, architecture, build fingerprint or serial number.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{1,39}$/.test(value)) return ''
  if (/\b(?:CPU|ARM(?:64)?|AArch64|AMD64|WIN64|WOW64|IA64|MIPS64|x64|x86(?:_64)?|SDK|emulator|generic|serial|IMEI|UUID|device|phone of)\b/i.test(value)
    || /^(?:user|sn|imei|uuid|cpu|armv?)[-_\d]|[0-9]{10}|[a-f0-9]{12}/i.test(value)) return ''
  const family = commercialName.exec(value)?.[1]
  return (family && family.split(' ').every(word => modelWord.test(word) || productCode.test(word))) || productCode.test(value) ? value : ''
}

function deviceProfile(req: Request | undefined) {
  const agent = (req?.headers['user-agent'] ?? '').slice(0, 512)
  const os = /Android/i.test(agent) ? 'Android' : /iPad/i.test(agent) ? 'iPad' : /iPhone/i.test(agent) ? 'iPhone' : /Windows/i.test(agent) ? 'Windows' : /Macintosh/i.test(agent) ? 'Mac' : /Linux/i.test(agent) ? 'Linux' : ''
  const client = /; wv\)/i.test(agent) ? '应用' : /Edg/i.test(agent) ? 'Edge' : /Firefox|FxiOS/i.test(agent) ? 'Firefox' : /Chrome|CriOS/i.test(agent) ? 'Chrome' : /Safari/i.test(agent) ? 'Safari' : ''
  const hint = req?.headers['sec-ch-ua-model']
  let model = typeof hint === 'string' && os ? validModel(/^"([^"]{1,40})"$/.exec(hint)?.[1] ?? '') : ''
  if (!model && os === 'Android') {
    const comment = /\([^()]*?\bAndroid\b([^()]*)\)/i.exec(agent)?.[1]
    for (const field of (comment ?? '').split(';').slice(1)) {
      model = validModel(field.split(/\s+Build\//i, 1)[0].trim())
      if (model) break
    }
  }
  return { os, client, model }
}

export function deviceName(req: Request | undefined) {
  const { os, client, model } = deviceProfile(req)
  return [os, model, client].filter(Boolean).join(' · ') || '未知设备'
}

export function enrichDeviceName(req: Request, stored: string) {
  if (!stored || stored.startsWith('旧版登录')) return
  if (!req.headers['sec-ch-ua-model'] && !stored.startsWith('Android') && stored !== '未知设备') return
  const [previousOs, previousClient, detail] = stored.split(' · ')
  if (detail || (previousClient && !clients.has(previousClient))) return
  const { os, client, model } = deviceProfile(req)
  if (!model || (stored !== '未知设备' && os !== previousOs)) return
  return [os, model, previousClient || client].filter(Boolean).join(' · ')
}
