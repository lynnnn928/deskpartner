import { create } from 'zustand'
import type {
  Project,
  CreateProjectInput,
  UpdateProjectInput
} from '../types/project'
import { invoke, on } from '../lib/ipc-client'

interface ProjectState {
  projects: Project[]
  loading: boolean

  fetchProjects: () => Promise<void>
  createProject: (input: CreateProjectInput) => Promise<Project>
  updateProject: (input: UpdateProjectInput) => Promise<Project>
  deleteProject: (id: string) => Promise<void>

  /** 按 id 取项目，找不到返回 null */
  getProject: (id: string | null) => Project | null
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  projects: [],
  loading: false,

  fetchProjects: async () => {
    set({ loading: true })
    try {
      const projects = await invoke('project:list')
      set({ projects, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  createProject: async (input) => {
    const project = await invoke('project:create', input)
    set((s) => ({ projects: [...s.projects, project] }))
    return project
  },

  updateProject: async (input) => {
    const updated = await invoke('project:update', input)
    set((s) => ({
      projects: s.projects.map((p) => (p.id === updated.id ? updated : p))
    }))
    return updated
  },

  deleteProject: async (id) => {
    await invoke('project:delete', { id })
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
  },

  getProject: (id) => (id ? get().projects.find((p) => p.id === id) ?? null : null)
}))

// 监听数据变更
if (typeof window !== 'undefined' && window.api) {
  on('event:dataChanged', (data) => {
    if (data.type === 'project') {
      useProjectStore.getState().fetchProjects()
    }
  })
}
