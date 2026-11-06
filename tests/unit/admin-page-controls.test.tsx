// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminRowActions } from '../../src/features/admin/pages/AdminPageControls'
afterEach(cleanup)
it('exposes row actions immediately in an accessible group and preserves their handlers',()=>{
 const edit=vi.fn(),remove=vi.fn()
 render(<AdminRowActions label="示例行操作"><button onClick={edit}>编辑</button><button onClick={remove}>删除</button></AdminRowActions>)
 const group=screen.getByRole('group',{name:'示例行操作'})
 expect(within(group).getAllByRole('button')).toHaveLength(2)
 expect(group.querySelector('details')).toBeNull()
 fireEvent.click(within(group).getByRole('button',{name:'编辑'}));expect(edit).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled()
})
