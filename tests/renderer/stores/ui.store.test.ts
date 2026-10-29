import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

describe('useUIStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useUIStore.setState({
      searchKeyword: '',
      filterCategory: null,
      filterStatus: null,
      showUnreadOnly: false,
      undoQueue: [],
      multiSelectMode: false,
      selectedIds: [],
      workspaceMode: 'workbench',
      workItemScope: 'current',
    })
  })

  it('should have correct initial state', () => {
    const state = useUIStore.getState()

    expect(state.searchKeyword).toBe('')
    expect(state.filterCategory).toBeNull()
    expect(state.filterStatus).toBeNull()
    expect(state.showUnreadOnly).toBe(false)
    expect(state.multiSelectMode).toBe(false)
    expect(state.selectedIds).toEqual([])
  })

  describe('project workspace navigation', () => {
    it('enters a project without toggling back when selected repeatedly', () => {
      const state = useUIStore.getState()
      state.setSearchKeyword('hidden')
      state.setFilterCategory('cat-1')
      state.toggleMultiSelect()
      state.toggleSelectId('todo-1')

      state.enterProject('project-a')
      expect(useUIStore.getState().workspaceMode).toBe('project')
      expect(useUIStore.getState().filterProject).toBe('project-a')
      expect(useUIStore.getState().workItemScope).toBe('current')
      expect(useUIStore.getState().searchKeyword).toBe('')
      expect(useUIStore.getState().filterCategory).toBeNull()
      expect(useUIStore.getState().selectedIds).toEqual([])
      expect(useUIStore.getState().multiSelectMode).toBe(false)

      state.enterProject('project-a')
      expect(useUIStore.getState().workspaceMode).toBe('project')
      expect(useUIStore.getState().filterProject).toBe('project-a')
    })

    it('switches to workbench and all-items history explicitly', () => {
      const state = useUIStore.getState()
      state.enterProject('project-a')
      state.setWorkItemScope('ended')
      expect(useUIStore.getState().workItemScope).toBe('ended')

      state.enterWorkbench()
      expect(useUIStore.getState().workspaceMode).toBe('workbench')
      expect(useUIStore.getState().filterProject).toBeNull()
      expect(useUIStore.getState().workItemScope).toBe('current')

      state.enterAllItems()
      expect(useUIStore.getState().workspaceMode).toBe('all')
      expect(useUIStore.getState().workItemScope).toBe('all')
      expect(useUIStore.getState().filterProject).toBeNull()
    })
  })

  describe('setSearchKeyword()', () => {
    it('should update search keyword', () => {
      useUIStore.getState().setSearchKeyword('test')
      expect(useUIStore.getState().searchKeyword).toBe('test')
    })
  })

  describe('setFilterCategory()', () => {
    it('should set category filter', () => {
      useUIStore.getState().setFilterCategory('cat-1')
      expect(useUIStore.getState().filterCategory).toBe('cat-1')
    })

    it('should clear category filter with null', () => {
      useUIStore.getState().setFilterCategory('cat-1')
      useUIStore.getState().setFilterCategory(null)
      expect(useUIStore.getState().filterCategory).toBeNull()
    })
  })

  describe('toggleMultiSelect()', () => {
    it('should toggle multi-select mode from false to true', () => {
      useUIStore.getState().toggleMultiSelect()
      expect(useUIStore.getState().multiSelectMode).toBe(true)
    })

    it('should clear selectedIds when toggling', () => {
      useUIStore.getState().toggleMultiSelect()
      useUIStore.getState().toggleSelectId('id-1')
      useUIStore.getState().toggleMultiSelect()

      expect(useUIStore.getState().multiSelectMode).toBe(false)
      expect(useUIStore.getState().selectedIds).toEqual([])
    })
  })

  describe('toggleSelectId()', () => {
    it('should add id to selection', () => {
      useUIStore.getState().toggleSelectId('id-1')
      expect(useUIStore.getState().selectedIds).toContain('id-1')
    })

    it('should remove id from selection on second toggle', () => {
      useUIStore.getState().toggleSelectId('id-1')
      useUIStore.getState().toggleSelectId('id-1')
      expect(useUIStore.getState().selectedIds).not.toContain('id-1')
    })
  })

  describe('clearSelection()', () => {
    it('should clear selectedIds and exit multi-select mode', () => {
      useUIStore.getState().toggleMultiSelect()
      useUIStore.getState().toggleSelectId('id-1')
      useUIStore.getState().clearSelection()

      expect(useUIStore.getState().selectedIds).toEqual([])
      expect(useUIStore.getState().multiSelectMode).toBe(false)
    })
  })
})
