import { useState } from 'react'
import { requestJson } from '@/app/api-client'
import { action, control, errorText } from './common'
export type Challenge = { captchaId: string; answer: string }
export function Captcha({ onChange }: { onChange: (v: Challenge | undefined) => void }) {
  const [image, setImage] = useState<{ captchaId: string; imageBase64: string } | null>(null),
    [error, setError] = useState(''),
    [answer, setAnswer] = useState('')
  async function refresh() {
    setError('')
    setAnswer('')
    onChange(undefined)
    try {
      setImage(
        await requestJson<{ captchaId: string; imageBase64: string }>('/api/governance/captcha', {
          credentials: 'omit',
        }),
      )
    } catch (e) {
      setImage(null)
      setError(errorText(e))
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {image && <img alt="图形验证码" width={140} height={52} src={image.imageBase64} />}
        <button type="button" className={action} onClick={refresh}>
          {image ? '更换验证码' : '获取图形验证码'}
        </button>
      </div>
      {image && (
        <label>
          图形验证码
          <input
            className={control}
            value={answer}
            maxLength={12}
            onChange={(e) => {
              setAnswer(e.target.value)
              onChange({ captchaId: image.captchaId, answer: e.target.value })
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
