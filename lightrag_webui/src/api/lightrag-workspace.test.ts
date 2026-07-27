import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

const storageData = new Map<string, string>()
const storageMock = {
  getItem: (key: string) => storageData.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageData.set(key, value)
  },
  removeItem: (key: string) => {
    storageData.delete(key)
  },
  clear: () => {
    storageData.clear()
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: storageMock,
  configurable: true
})
Object.defineProperty(globalThis, 'sessionStorage', {
  value: storageMock,
  configurable: true
})

let storeApiKey: string | null = null
let storeWorkspace = ''
const axiosCalls: Array<{
  method: string
  url: string
  data?: unknown
  headers: Record<string, string>
}> = []

const workspaceResponse = {
  workspaces: [
    { name: 'default', storage_key: 'default', is_default: true },
    { name: 'demo', storage_key: 'demo', is_default: false }
  ],
  current_workspace: 'demo',
  default_workspace: 'default'
}

mock.module('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      apiKey: storeApiKey,
      workspace: storeWorkspace
    })
  }
}))

mock.module('@/stores/state', () => ({
  useAuthStore: {
    getState: () => ({
      isAuthenticated: false,
      isGuestMode: false,
      login: () => {},
      setTokenRenewal: () => {}
    })
  }
}))

mock.module('@/services/navigation', () => ({
  navigationService: { navigateToLogin: () => {} }
}))

mock.module('@/lib/utils', () => ({
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : `${error}`
}))

mock.module('@/lib/constants', () => ({
  backendBaseUrl: 'http://localhost:9621',
  popularLabelsDefaultLimit: 300,
  searchLabelsDefaultLimit: 50
}))

mock.module('axios', () => {
  let requestInterceptor = (config: any) => config

  const runRequest = (config: any) => {
    const intercepted = requestInterceptor({
      ...config,
      headers: { ...(config.headers ?? {}) }
    })
    axiosCalls.push({
      method: intercepted.method,
      url: intercepted.url,
      data: intercepted.data,
      headers: intercepted.headers
    })
    return Promise.resolve({ data: workspaceResponse, headers: {} })
  }

  const instance: any = (config: any) => runRequest(config)
  instance.get = (url: string, config: any = {}) =>
    runRequest({ ...config, method: 'get', url })
  instance.post = (url: string, data?: unknown, config: any = {}) =>
    runRequest({ ...config, method: 'post', url, data })
  instance.put = (url: string, data?: unknown, config: any = {}) =>
    runRequest({ ...config, method: 'put', url, data })
  instance.delete = (url: string, config: any = {}) =>
    runRequest({ ...config, method: 'delete', url })
  instance.interceptors = {
    request: {
      use: (handler: typeof requestInterceptor) => {
        requestInterceptor = handler
      }
    },
    response: { use: () => {} }
  }

  const axiosFn: any = () => Promise.resolve({ data: {}, headers: {} })
  axiosFn.create = () => instance
  axiosFn.get = () => Promise.resolve({ data: {}, headers: {} })
  axiosFn.post = () => Promise.resolve({ data: {}, headers: {} })
  axiosFn.interceptors = instance.interceptors
  return { default: axiosFn, __esModule: true }
})

let apiModule: typeof import('./lightrag')

beforeAll(async () => {
  apiModule = await import('./lightrag')
})

afterEach(() => {
  storageData.clear()
  axiosCalls.length = 0
  storeApiKey = null
  storeWorkspace = ''
})

describe('workspace API requests', () => {
  test('injects selected workspace into axios requests', async () => {
    storeApiKey = 'test-api-key'
    storeWorkspace = 'demo'

    await expect(apiModule.getWorkspaces()).resolves.toEqual(workspaceResponse)

    expect(axiosCalls).toHaveLength(1)
    expect(axiosCalls[0]).toMatchObject({ method: 'get', url: '/workspaces' })
    expect(axiosCalls[0].headers['X-API-Key']).toBe('test-api-key')
    expect(axiosCalls[0].headers['LIGHTRAG-WORKSPACE']).toBe('demo')
  })

  test('uses workspace CRUD endpoint paths and request bodies', async () => {
    storeWorkspace = 'demo'

    await apiModule.createWorkspace('new-space')
    await apiModule.renameWorkspace('demo space', 'renamed')
    await apiModule.deleteWorkspace('renamed')

    expect(axiosCalls.map((call) => [call.method, call.url, call.data])).toEqual([
      ['post', '/workspaces', { name: 'new-space' }],
      ['put', '/workspaces/demo%20space', { name: 'renamed' }],
      ['delete', '/workspaces/renamed', undefined]
    ])
    expect(
      axiosCalls.every(
        (call) => call.headers['LIGHTRAG-WORKSPACE'] === 'demo'
      )
    ).toBe(true)
  })

  test('injects selected workspace into streaming fetch requests', async () => {
    storeApiKey = 'stream-key'
    storeWorkspace = 'stream-workspace'
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = []

    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init })
      return Promise.resolve(
        new Response('{"response":"ok","answer":"ok"}\n', { status: 200 })
      )
    }) as unknown as typeof fetch

    await apiModule.queryTextStream(
      { query: 'hello', mode: 'mix' },
      () => {},
      () => {}
    )

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('http://localhost:9621/query/stream')
    const headers = fetchCalls[0].init?.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('stream-key')
    expect(headers['LIGHTRAG-WORKSPACE']).toBe('stream-workspace')
  })
})