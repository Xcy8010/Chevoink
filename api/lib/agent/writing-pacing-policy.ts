/** Existing confirmation-first boundary, shared without changing historical
 * pacing classification. Callers choose their own trusted author-text source. */
export function requiresWritingConfirmation(prompt: string): boolean {
  return /(?:先|等).{0,24}(?:确认|同意|批准).{0,16}(?:再|后).{0,12}(?:写|正文)|(?:不要|不得|不能|别).{0,12}(?:直接|擅自|未经.{0,6}(?:同意|确认)).{0,8}(?:写|正文)|(?:先|只).{0,8}(?:大纲|规划|计划|方案)/u.test(prompt)
}
