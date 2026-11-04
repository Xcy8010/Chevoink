import type { AdminYunshuOperations, AdminYunshuOperationsQuery } from '../../shared/contracts/admin-yunshu-usage.js'

export function adminYunshuOperationsFixture(query: Partial<AdminYunshuOperationsQuery> = {}): AdminYunshuOperations {
  const period=query.period??'today', page=query.page??1
  return {
    source:'yunshu_admin_logs',scope:'configured_platform_tokens',period,window:{from:'2026-11-03T16:00:00Z',to:'2026-11-04T10:00:00Z'},observedAt:'2026-11-04T10:00:00Z',state:'partial',coverage:'partial',paginationComplete:true,message:'仅覆盖已配置的平台令牌。',lastAttemptAt:'2026-11-04T10:00:00Z',sources:{configured:2,verified:2,unresolved:0},
    records:{items:[{id:`fixture-call-${page}`,createdAt:'2026-11-04T09:00:00Z',modelName:`gateway-${period}-${page}`,group:'platform',kind:'consume',requestId:'fixture-request',requestTokens:100,responseTokens:null,durationMs:1250,streamOutcome:'unknown',quota:'1200'}],page,pageSize:20,total:41,totalPages:3,hasMore:page<3,totalObserved:41,kind:query.kind??'all'},
    health:{observation:'attention',consumeCount:38,errorCount:2,refundCount:1,streamSuccessCount:20,streamErrorCount:1,unknownOutcomeCount:17,durationSamples:35,p50Ms:1400,p95Ms:9200,lastSampleAt:'2026-11-04T09:00:00Z'},
    cost:{deductionQuota:'12345678901234567890',refundQuota:'12345678901234567900',netQuota:'-10',unknownDeductionCount:1,unknownRefundCount:0,display:{state:'ready',observedAt:'2026-11-04T10:00:00Z',message:'',quotaPerUnit:500000,type:'USD',rate:1,symbol:'$',deduction:'24691357802469.13578',refund:'24691357802469.1358',net:'-0.00002'}},
    balance:{scope:'management_account',state:'ready',observedAt:'2026-11-04T10:00:00Z',message:'',remainingQuota:'9007199254740993000',usedQuota:'1000000',displayRemaining:'18014398509481.986',displayUsed:'2'},
  }
}
