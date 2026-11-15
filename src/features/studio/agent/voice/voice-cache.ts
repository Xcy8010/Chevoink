import { VOICE_CACHE_NAME, VOICE_MANIFEST } from './voice-manifest'

export const voiceAssetUrl = (name: string) => new URL(VOICE_MANIFEST.baseUrl + name, globalThis.location.origin).href
export const voicePackFingerprint = VOICE_MANIFEST.files.map(file => file.sha256).join(':')

/** Check the installation marker and response metadata without starting the inference worker. */
export async function hasCachedVoicePack(): Promise<boolean> {
  if (!globalThis.caches || !await caches.has(VOICE_CACHE_NAME)) return false
  const cache = await caches.open(VOICE_CACHE_NAME)
  const marker = await cache.match(voiceAssetUrl('.verified'))
  if (!marker || await marker.text() !== voicePackFingerprint) return false
  for (const file of VOICE_MANIFEST.files) {
    const response = await cache.match(voiceAssetUrl(file.name))
    if (!response || response.headers.get('Content-Length') !== String(file.bytes) || response.headers.get('X-Voice-Sha256') !== file.sha256) return false
  }
  return true
}
