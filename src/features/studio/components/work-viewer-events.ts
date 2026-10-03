export const WORK_OPEN_DOCUMENT = 'chevoink:work-open-document'

export function openWorkDocument(scope: string | undefined) {
  if (scope) window.dispatchEvent(new CustomEvent(WORK_OPEN_DOCUMENT, { detail: { scope } }))
}
