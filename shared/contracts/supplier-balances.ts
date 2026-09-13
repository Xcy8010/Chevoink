export type SupplierBalance = {
  models: string[]
  provider: string
  status: 'ready' | 'unsupported' | 'unconfigured' | 'error'
  balances: Array<{ currency: string; total: string; granted: string; toppedUp: string }>
  checkedAt: string
  message: string
  consoleUrl: string | null
}
