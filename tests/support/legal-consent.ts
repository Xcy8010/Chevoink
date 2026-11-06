import { createHash } from 'node:crypto'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from './database-preflight.js'
let verified: Promise<boolean> | undefined
/** Synthetic, isolated integration fixtures only. Never production policy or consent backfill. */
export async function integrationLegalConsent() {
  verified ??= verifyTestDatabase(true)
  await verified
  await prisma.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(804725)`
    for(const kind of ['terms','privacy'] as const){
      const id=`integration-legal-${kind}`
      const versionId=`integration-legal-${kind}-v1`
      const payload={title:`Integration fixture ${kind}`,body:'Synthetic test fixture. Not an official policy.',effectiveAt:'2020-01-01T00:00:00.000Z'}
      await tx.siteContent.upsert({where:{kind_key:{kind,key:kind}},create:{id,kind,key:kind,draft:payload},update:{}})
      const content=await tx.siteContent.findUniqueOrThrow({where:{kind_key:{kind,key:kind}}})
      await tx.siteContentVersion.upsert({where:{id:versionId},create:{id:versionId,contentId:content.id,contentVersion:1,payload,hash:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),effectiveAt:new Date(payload.effectiveAt)},update:{}})
      await tx.siteContent.update({where:{id:content.id},data:{publishedVersionId:versionId,withdrawn:false,deletedAt:null}})
    }
  })
  return {legalConsent:{termsVersionId:'integration-legal-terms-v1',privacyVersionId:'integration-legal-privacy-v1'}}
}