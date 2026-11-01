import type { ComponentProps } from 'react'
import TextInput from '@/components/ui/TextInput'
import { cn } from '@/lib/utils'

/** Admin fields already have their own visible label. */
export default function AdminTextInput(props: ComponentProps<typeof TextInput>) {
  return <TextInput {...props} className={cn('h-11 rounded-md', props.className)} wrapperAs="span" />
}
