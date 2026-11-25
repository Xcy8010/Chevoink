import { createHmac, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { normalizePhoneNumber } from './phone.js'
import { decryptSecret, encryptSecret } from './secret-box.js'

const keyId = 'v1'

/** Keep the original owner across release of a number. Verified phone login and
 * paid or earned balances are independent of this free-benefit claim. */
export async function claimCreditPhone(tx: Prisma.TransactionClient, userId: string, phone: string) {
  let key = await tx.creditPhoneKey.findUnique({ where: { id: keyId } })
  if (!key) {
    await tx.creditPhoneKey.createMany({
      data: [{ id: keyId, ciphertext: encryptSecret(randomBytes(32).toString('base64url')) }],
      skipDuplicates: true,
    })
    key = await tx.creditPhoneKey.findUniqueOrThrow({ where: { id: keyId } })
  }
  const phoneDigest = createHmac('sha256', Buffer.from(decryptSecret(key.ciphertext), 'base64url'))
    .update(normalizePhoneNumber(phone))
    .digest('hex')
  await tx.creditPhoneIdentity.createMany({
    data: [{ phoneDigest, ownerUserId: userId }],
    skipDuplicates: true,
  })
  const { ownerUserId } = await tx.creditPhoneIdentity.findUniqueOrThrow({ where: { phoneDigest } })
  return ownerUserId === userId
}
