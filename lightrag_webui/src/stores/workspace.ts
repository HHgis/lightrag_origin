import { create } from 'zustand'
import { createSelectors, errorMessage } from '@/lib/utils'
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspaces,
  renameWorkspace,
  WorkspaceInfo
} from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { useBackendState } from '@/stores/state'

interface WorkspaceState {
  workspaces: WorkspaceInfo[]
  defaultWorkspace: string
  currentWorkspace: string
  isFetching: boolean
  lastFetchTime: number
  error: string | null

  fetchWorkspaces: () => Promise<void>
  selectWorkspace: (workspace: string) => void
  createWorkspace: (name: string) => Promise<void>
  renameWorkspace: (workspace: string, name: string) => Promise<void>
  deleteWorkspace: (workspace: string) => Promise<void>
  reset: () => void
}

const refreshBackendHealth = () => {
  useBackendState.getState().resetHealthCheckTimerDelayed(100)
}

const normalizeWorkspaceSelection = (
  workspaces: WorkspaceInfo[],
  requested: string,
  fallback: string
): string => {
  if (requested && workspaces.some((workspace) => workspace.name === requested)) {
    return requested
  }
  if (fallback && workspaces.some((workspace) => workspace.name === fallback)) {
    return fallback
  }
  return workspaces[0]?.name ?? ''
}

const useWorkspaceStoreBase = create<WorkspaceState>()((set) => ({
  workspaces: [],
  defaultWorkspace: '',
  currentWorkspace: useSettingsStore.getState().workspace,
  isFetching: false,
  lastFetchTime: 0,
  error: null,

  fetchWorkspaces: async () => {
    set({ isFetching: true, error: null })
    try {
      const response = await getWorkspaces()
      const selected = normalizeWorkspaceSelection(
        response.workspaces,
        useSettingsStore.getState().workspace,
        response.current_workspace || response.default_workspace
      )
      useSettingsStore.getState().setWorkspace(selected)
      set({
        workspaces: response.workspaces,
        defaultWorkspace: response.default_workspace,
        currentWorkspace: selected,
        isFetching: false,
        lastFetchTime: Date.now(),
        error: null
      })
    } catch (error) {
      set({ isFetching: false, error: errorMessage(error) })
      throw error
    }
  },

  selectWorkspace: (workspace: string) => {
    useSettingsStore.getState().setWorkspace(workspace)
    set({ currentWorkspace: workspace })
    refreshBackendHealth()
  },

  createWorkspace: async (name: string) => {
    set({ isFetching: true, error: null })
    try {
      const response = await createWorkspace(name)
      const selected = response.workspace?.name || response.current_workspace
      useSettingsStore.getState().setWorkspace(selected)
      set({
        workspaces: response.workspaces,
        defaultWorkspace: response.default_workspace,
        currentWorkspace: selected,
        isFetching: false,
        lastFetchTime: Date.now(),
        error: null
      })
      refreshBackendHealth()
    } catch (error) {
      set({ isFetching: false, error: errorMessage(error) })
      throw error
    }
  },

  renameWorkspace: async (workspace: string, name: string) => {
    set({ isFetching: true, error: null })
    try {
      const response = await renameWorkspace(workspace, name)
      const selected = response.workspace?.name || response.current_workspace
      useSettingsStore.getState().setWorkspace(selected)
      set({
        workspaces: response.workspaces,
        defaultWorkspace: response.default_workspace,
        currentWorkspace: selected,
        isFetching: false,
        lastFetchTime: Date.now(),
        error: null
      })
      refreshBackendHealth()
    } catch (error) {
      set({ isFetching: false, error: errorMessage(error) })
      throw error
    }
  },

  deleteWorkspace: async (workspace: string) => {
    set({ isFetching: true, error: null })
    try {
      const response = await deleteWorkspace(workspace)
      const selected = normalizeWorkspaceSelection(
        response.workspaces,
        response.current_workspace,
        response.default_workspace
      )
      useSettingsStore.getState().setWorkspace(selected)
      set({
        workspaces: response.workspaces,
        defaultWorkspace: response.default_workspace,
        currentWorkspace: selected,
        isFetching: false,
        lastFetchTime: Date.now(),
        error: null
      })
      refreshBackendHealth()
    } catch (error) {
      set({ isFetching: false, error: errorMessage(error) })
      throw error
    }
  },

  reset: () => {
    const workspace = useSettingsStore.getState().workspace
    set({
      workspaces: [],
      defaultWorkspace: '',
      currentWorkspace: workspace,
      isFetching: false,
      lastFetchTime: 0,
      error: null
    })
  }
}))

const useWorkspaceStore = createSelectors(useWorkspaceStoreBase)

export { useWorkspaceStore }