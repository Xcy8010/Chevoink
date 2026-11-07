import { brandMeta } from '@/lib/theme/tokens'
import { desktopNavItems } from '@/types/app'
import type { SiteSettings } from '../../../shared/contracts/site-content'

/** The existing public defaults, also shown when preparing the first settings draft. */
export const defaultSiteSettings = {
  name: brandMeta.productName,
  logoUrl: '/favicon.png',
  about: '',
  footer: '',
  docsLabel: '帮助文档',
  contact: { label: '联系客服', url: 'https://work.weixin.qq.com/kfid/kfc79a6e1508b365a61', details: '' },
  navigation: desktopNavItems.map(item => ({ label: item.label, url: item.href })),
} satisfies SiteSettings

export function effectiveSiteSettings(settings: SiteSettings | null | undefined): SiteSettings {
  return settings ?? defaultSiteSettings
}
