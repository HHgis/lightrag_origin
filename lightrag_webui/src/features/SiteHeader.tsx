import { useEffect, useState, type ReactNode } from 'react'
import Button from '@/components/ui/Button'
import { SiteInfo, webuiPrefix } from '@/lib/constants'
import AppSettings from '@/components/AppSettings'
import { TabsList, TabsTrigger } from '@/components/ui/Tabs'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/state'
import { useWorkspaceStore } from '@/stores/workspace'
import { useGraphStore } from '@/stores/graph'
import { cn, errorMessage } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { navigationService } from '@/services/navigation'
import { CheckIcon, Loader2Icon, PencilIcon, PlusIcon, Trash2Icon, ZapIcon, LogOutIcon } from 'lucide-react'
import GithubIcon from '@/components/icons/GithubIcon'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/Select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/AlertDialog'
import Input from '@/components/ui/Input'
import { toast } from 'sonner'

interface NavigationTabProps {
  value: string
  currentTab: string
  children: ReactNode
}

function NavigationTab({ value, currentTab, children }: NavigationTabProps) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'cursor-pointer px-2 py-1 transition-all',
        currentTab === value ? '!bg-emerald-400 !text-zinc-50' : 'hover:bg-background/60'
      )}
    >
      {children}
    </TabsTrigger>
  )
}

function TabsNavigation() {
  const currentTab = useSettingsStore.use.currentTab()
  const { t } = useTranslation()

  return (
    <div className="flex h-8 self-center">
      <TabsList className="h-full gap-2">
        <NavigationTab value="documents" currentTab={currentTab}>
          {t('header.documents')}
        </NavigationTab>
        <NavigationTab value="knowledge-graph" currentTab={currentTab}>
          {t('header.knowledgeGraph')}
        </NavigationTab>
        <NavigationTab value="retrieval" currentTab={currentTab}>
          {t('header.retrieval')}
        </NavigationTab>
        <NavigationTab value="api" currentTab={currentTab}>
          {t('header.api')}
        </NavigationTab>
      </TabsList>
    </div>
  )
}

function WorkspaceManager() {
  const { t } = useTranslation()
  const workspaces = useWorkspaceStore.use.workspaces()
  const currentWorkspace = useWorkspaceStore.use.currentWorkspace()
  const defaultWorkspace = useWorkspaceStore.use.defaultWorkspace()
  const isFetching = useWorkspaceStore.use.isFetching()
  const fetchWorkspaces = useWorkspaceStore.use.fetchWorkspaces()
  const selectWorkspace = useWorkspaceStore.use.selectWorkspace()
  const createWorkspace = useWorkspaceStore.use.createWorkspace()
  const renameWorkspace = useWorkspaceStore.use.renameWorkspace()
  const deleteWorkspace = useWorkspaceStore.use.deleteWorkspace()

  const [createOpen, setCreateOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')

  const resetWorkspaceScopedUi = () => {
    useGraphStore.getState().reset()
    useSettingsStore.getState().triggerSearchLabelDropdownRefresh()
  }

  useEffect(() => {
    fetchWorkspaces().catch((error) => {
      toast.error(errorMessage(error))
    })
  }, [fetchWorkspaces])

  const submitWorkspaceMutation = async (
    mutation: () => Promise<void>,
    onSuccess: () => void
  ) => {
    const name = workspaceName.trim()
    if (!name) {
      toast.error(t('workspace.nameRequired', 'Workspace name is required'))
      return
    }

    try {
      await mutation()
      resetWorkspaceScopedUi()
      onSuccess()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const handleSelectWorkspace = (workspace: string) => {
    if (!workspace || workspace === currentWorkspace) {
      return
    }
    selectWorkspace(workspace)
    resetWorkspaceScopedUi()
  }

  const handleOpenCreate = () => {
    setWorkspaceName('')
    setCreateOpen(true)
  }

  const handleOpenRename = () => {
    setWorkspaceName(currentWorkspace)
    setRenameOpen(true)
  }

  const handleCreate = () =>
    submitWorkspaceMutation(
      () => createWorkspace(workspaceName.trim()),
      () => setCreateOpen(false)
    )

  const handleRename = () =>
    submitWorkspaceMutation(
      () => renameWorkspace(currentWorkspace, workspaceName.trim()),
      () => setRenameOpen(false)
    )

  const handleDelete = async () => {
    try {
      await deleteWorkspace(currentWorkspace)
      resetWorkspaceScopedUi()
      setDeleteOpen(false)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const isDefaultWorkspace = currentWorkspace === defaultWorkspace
  const hasWorkspace = Boolean(currentWorkspace)

  return (
    <div className="border-border bg-muted/30 flex h-8 items-center gap-1 rounded-md border px-1.5">
      <span className="text-muted-foreground px-1 text-xs font-medium">
        {t('workspace.select', 'Workspace')}
      </span>
      <Select
        value={currentWorkspace || undefined}
        onValueChange={handleSelectWorkspace}
        disabled={isFetching || workspaces.length === 0}
      >
        <SelectTrigger className="h-8 w-[150px]">
          <SelectValue placeholder={t('workspace.select', 'Workspace')} />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.name} value={workspace.name}>
              <span className="flex items-center gap-2">
                {workspace.name}
                {workspace.is_default && (
                  <span className="text-muted-foreground text-xs">
                    {t('workspace.defaultBadge', 'default')}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="icon"
        side="bottom"
        tooltip={t('workspace.create', 'Create workspace')}
        disabled={isFetching}
        onClick={handleOpenCreate}
      >
        {isFetching ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        side="bottom"
        tooltip={t('workspace.rename', 'Rename workspace')}
        disabled={isFetching || !hasWorkspace || isDefaultWorkspace}
        onClick={handleOpenRename}
      >
        <PencilIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        side="bottom"
        tooltip={t('workspace.delete', 'Delete workspace')}
        disabled={isFetching || !hasWorkspace || isDefaultWorkspace}
        onClick={() => setDeleteOpen(true)}
      >
        <Trash2Icon className="size-4" />
      </Button>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workspace.createTitle', 'Create workspace')}</DialogTitle>
            <DialogDescription>
              {t('workspace.createDescription', 'Create an isolated workspace for documents, graph, and query state.')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder={t('workspace.namePlaceholder', 'workspace-name')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleCreate()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={() => void handleCreate()} disabled={isFetching}>
              <CheckIcon className="size-4" />
              {t('common.create', 'Create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('workspace.renameTitle', 'Rename workspace')}</DialogTitle>
            <DialogDescription>
              {t('workspace.renameDescription', 'Only the display name changes. Existing storage data is not moved.')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            placeholder={t('workspace.namePlaceholder', 'workspace-name')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void handleRename()
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button onClick={() => void handleRename()} disabled={isFetching || isDefaultWorkspace}>
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('workspace.deleteTitle', 'Delete workspace')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('workspace.deleteDescription', 'This permanently removes the selected workspace data. This action cannot be undone.', { workspace: currentWorkspace })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault()
                void handleDelete()
              }}
            >
              {t('common.delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function SiteHeader() {
  const { t } = useTranslation()
  const { isGuestMode, coreVersion, apiVersion, username, webuiTitle, webuiDescription } = useAuthStore()

  const versionDisplay = (coreVersion && apiVersion)
    ? `${coreVersion}/${apiVersion}`
    : null;

  // Check if frontend needs rebuild (apiVersion ends with warning symbol)
  const hasWarning = apiVersion?.endsWith('⚠️');
  const versionTooltip = hasWarning
    ? t('header.frontendNeedsRebuild')
    : versionDisplay ? `v${versionDisplay}` : '';

  const handleLogout = () => {
    navigationService.navigateToLogin();
  }

  return (
    <header className="border-border/40 bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50 flex h-10 w-full items-center gap-3 border-b px-4 backdrop-blur">
      <div className="flex min-w-[200px] shrink-0 items-center">
        <a href={webuiPrefix} className="flex items-center gap-2">
          <ZapIcon className="size-4 text-emerald-400" aria-hidden="true" />
          <span className="font-bold md:inline-block">{SiteInfo.name}</span>
        </a>
        {webuiTitle && (
          <div className="flex items-center">
            <span className="mx-1 text-xs text-gray-500 dark:text-gray-400">|</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="font-medium text-sm cursor-default">
                    {webuiTitle}
                  </span>
                </TooltipTrigger>
                {webuiDescription && (
                  <TooltipContent side="bottom">
                    {webuiDescription}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>

      <div className="flex h-10 min-w-0 flex-1 items-center justify-center">
        <TabsNavigation />
        <div className="ml-2 self-center">
          <WorkspaceManager />
        </div>
        {isGuestMode && (
          <div className="ml-2 self-center px-2 py-1 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 rounded-md">
            {t('login.guestMode', 'Guest Mode')}
          </div>
        )}
      </div>

      <nav className="flex shrink-0 items-center justify-end">
        <div className="flex items-center gap-2">
          {versionDisplay && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-gray-500 dark:text-gray-400 mr-1 cursor-default">
                    v{versionDisplay}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {versionTooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button variant="ghost" size="icon" side="bottom" tooltip={t('header.projectRepository')}>
            <a href={SiteInfo.github} target="_blank" rel="noopener noreferrer">
              <GithubIcon className="size-4" />
            </a>
          </Button>
          <AppSettings />
          {!isGuestMode && (
            <Button
              variant="ghost"
              size="icon"
              side="bottom"
              tooltip={`${t('header.logout')} (${username})`}
              onClick={handleLogout}
            >
              <LogOutIcon className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </nav>
    </header>
  )
}
