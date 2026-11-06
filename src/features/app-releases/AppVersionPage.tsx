import { useQuery } from '@tanstack/react-query'
import { requestJson } from '@/app/api-client'
import type { AppReleaseBootstrap } from '../../../shared/contracts/app-release'
export default function AppVersionPage(){
 const query=useQuery({queryKey:['app-release','bootstrap'],queryFn:()=>requestJson<AppReleaseBootstrap>('/api/app-releases/bootstrap'),staleTime:0,refetchOnWindowFocus:true})
 const release=query.data?.release
 return <article className="mx-auto max-w-3xl space-y-5 py-8"><h1 className="text-2xl font-semibold">应用版本</h1>{query.isLoading?<p>加载中…</p>:query.isError?<p role="alert">版本信息暂时无法读取。<button onClick={()=>void query.refetch()}>重试</button></p>:release?<><p>{release.label} · {query.data!.channel==='test'?'测试版':'稳定版'}</p>{(['features','fixes','changes'] as const).map(kind=>release.notes[kind].length?<section key={kind}><h2 className="font-medium">{{features:'新增功能',fixes:'修复',changes:'改进'}[kind]}</h2><ul className="mt-2 list-inside list-disc space-y-2">{release.notes[kind].map((note,index)=><li key={index}>{note}</li>)}</ul></section>:null)}</>:<p>当前使用现有应用版本，尚未配置版本通道。</p>}</article>
}