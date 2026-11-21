export type AccountObservationInput = {
  action: 'password_login' | 'device_revoke' | 'ordinary_activity'
  repeatedFailures: boolean
  countryChanged: boolean
  deviceEvidence?: 'existing_session' | 'recent_session' | 'unknown'
}

export function evaluateAccountObservation({
  action, repeatedFailures, countryChanged, deviceEvidence = 'unknown',
}: AccountObservationInput): 'allow' | 'notice' | 'would_verify' {
  if (action === 'ordinary_activity') return 'allow'
  if (repeatedFailures && countryChanged && deviceEvidence !== 'existing_session') return 'would_verify'
  if (repeatedFailures || (action === 'device_revoke' && deviceEvidence === 'recent_session' && countryChanged)) return 'notice'
  return 'allow'
}
