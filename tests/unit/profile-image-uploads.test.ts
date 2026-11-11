import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { storeAvatarDataUrl } from '../../api/lib/avatar-storage.js'
import { storeProfileCoverDataUrl } from '../../api/lib/profile-cover-storage.js'
import { getProfileImageUploadError } from '../../src/lib/image-compress.js'

vi.mock('../../api/config/env.js', async original => {
  const actual = await original<typeof import('../../api/config/env.js')>()
  return { ...actual, env: { ...actual.env, appEnv: 'development' } }
})

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, chmod: vi.fn(actual.chmod) }
})

const maxBytes = 5 * 1024 * 1024
const uploaders = [
  { label: '头像', folder: 'avatars', store: storeAvatarDataUrl },
  { label: '封面', folder: 'profile-covers', store: storeProfileCoverDataUrl },
] as const

let directory: string

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chevoink-profile-image-')))
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  vi.mocked(chmod).mockClear()
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (path.dirname(directory) !== await realpath(os.tmpdir()) || !path.basename(directory).startsWith('chevoink-profile-image-')) {
    throw new Error('Unexpected profile upload fixture directory')
  }
  await rm(directory, { recursive: true, force: true })
})

it.each(uploaders)('accepts exactly 5 MB and publishes readable main and thumbnail files for $label', async ({ folder, store }) => {
  const png = await sharp({
    create: { width: 24, height: 8, channels: 3, background: '#204080' },
  }).png().toBuffer()
  const atLimit = Buffer.concat([png, Buffer.alloc(maxBytes - png.length)])
  const asDataUrl = (bytes: Buffer) => 'data:image/png;base64,' + bytes.toString('base64')
  const url = await store(asDataUrl(atLimit))
  const target = path.join(directory, '.local-storage', 'uploads', folder, path.basename(url))
  const thumbnail = target.replace(/\.webp$/, '.thumb.webp')

  expect(url).toMatch(new RegExp('^/api/uploads/' + folder + '/[a-f0-9-]+\\.webp$'))
  for (const file of [target, thumbnail]) {
    expect(await sharp(await readFile(file)).metadata()).toMatchObject({ format: 'webp', width: 24, height: 8 })
    expect(chmod).toHaveBeenCalledWith(file, 0o644)
  }
  expect(chmod).toHaveBeenCalledWith(path.dirname(target), expect.any(Number))
  await expect(store(asDataUrl(Buffer.concat([atLimit, Buffer.from([0])])))).rejects.toMatchObject({
    status: 400,
    code: 'VALIDATION_ERROR',
    message: expect.stringContaining('5MB'),
  })
})

it.each(uploaders)('enforces the same upload boundary at the file picker for $label', ({ label }) => {
  const file = (size: number, type: string) => new File([new ArrayBuffer(size)], 'image.png', { type })
  expect(getProfileImageUploadError(file(maxBytes, 'image/png'), label)).toBeNull()
  expect(getProfileImageUploadError(file(maxBytes + 1, 'image/png'), label)).toContain('5MB')
  expect(getProfileImageUploadError(file(1, 'image/gif'), label)).toContain('PNG、JPG 或 WebP')
})
