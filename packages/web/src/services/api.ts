import { useAuthStore } from '@/stores/auth'

const API_BASE = '/api'

interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
  pagination?: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = useAuthStore.getState().token

  const headers: HeadersInit = {
    ...options.headers,
  }

  // Only set Content-Type for requests with a body
  if (options.body) {
    ;(headers as Record<string, string>)['Content-Type'] = 'application/json'
  }

  if (token) {
    ;(headers as Record<string, string>)['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  })

  if (response.status === 401) {
    useAuthStore.getState().logout()
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }

  return response.json()
}

export const api = {
  get: <T>(endpoint: string) => request<T>(endpoint),

  post: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(data ?? {}),
    }),

  put: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    }),

  delete: <T>(endpoint: string) =>
    request<T>(endpoint, {
      method: 'DELETE',
    }),
}

// Auth API
export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ accessToken: string; user: unknown }>('/auth/login', { username, password }),

  me: () => api.get<unknown>('/auth/me'),

  logout: () => api.post('/auth/logout'),
}

// Helper to build query string, filtering out undefined/null values
function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return ''
  const filtered = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .reduce((acc, [k, v]) => ({ ...acc, [k]: String(v) }), {} as Record<string, string>)
  const query = new URLSearchParams(filtered).toString()
  return query ? `?${query}` : ''
}

// Customers API
export const customersApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string }) => {
    return api.get<unknown[]>(`/customers${buildQuery(params)}`)
  },
  get: (id: number) => api.get<unknown>(`/customers/${id}`),
  create: (data: unknown) => api.post<unknown>('/customers', data),
  update: (id: number, data: unknown) => api.put<unknown>(`/customers/${id}`, data),
  delete: (id: number) => api.delete(`/customers/${id}`),
  updateGroups: (id: number, groupIds: number[]) =>
    api.put<unknown>(`/customers/${id}/groups`, { groupIds }),
}

// Channel 類型
export type Channel = 'LINE' | 'FEISHU'

// Groups API
export interface Group {
  id: number
  lineGroupId: string
  channel: Channel
  displayName: string | null
  status: string
  knowledgeCategories: string[]
  autoReplyEnabled: boolean
  customerId: number | null
  customer: { id: number; name: string } | null
  _count: { messages: number; members: number; issues: number }
  updatedAt: string
}

export const groupsApi = {
  list: (params?: { page?: number; pageSize?: number; status?: string; customerId?: number; search?: string }) => {
    return api.get<Group[]>(`/groups${buildQuery(params)}`)
  },
  get: (id: number) => api.get<Group>(`/groups/${id}`),
  update: (id: number, data: {
    displayName?: string
    customerId?: number | null
    status?: string
    knowledgeCategories?: string[]
    autoReplyEnabled?: boolean
  }) => api.put<Group>(`/groups/${id}`, data),
  delete: (id: number) => api.delete(`/groups/${id}`),
  batchDelete: (ids: number[]) => api.post<{ deleted: number }>('/groups/batch-delete', { ids }),
  fetchName: (id: number) => api.post<Group>(`/groups/${id}/fetch-name`),
  batchUpdateCategories: (data: {
    groupIds: number[]
    knowledgeCategories?: string[]
    autoReplyEnabled?: boolean
    customerId?: number | null
  }) => api.post<{ updated: number }>('/groups/batch-update-categories', data),
  messages: (id: number, params?: { page?: number; pageSize?: number }) => {
    return api.get<unknown[]>(`/groups/${id}/messages${buildQuery(params)}`)
  },
  issues: (id: number, params?: { page?: number; pageSize?: number; status?: string }) => {
    return api.get<unknown[]>(`/groups/${id}/issues${buildQuery(params)}`)
  },
}

// Members API
export interface Member {
  id: number
  lineUserId: string
  channel: Channel
  displayName: string | null
  pictureUrl: string | null
  role: string
  notes: string | null
  groups: Array<{ group: { id: number; displayName: string | null; channel: Channel; customer?: { name: string } | null } }>
  _count: { messages: number }
  createdAt: string
  updatedAt: string
}

export const membersApi = {
  list: (params?: { page?: number; pageSize?: number; role?: string; search?: string }) => {
    return api.get<Member[]>(`/members${buildQuery(params)}`)
  },
  get: (id: number) => api.get<Member>(`/members/${id}`),
  update: (id: number, data: unknown) => api.put<Member>(`/members/${id}`, data),
  delete: (id: number) => api.delete(`/members/${id}`),
  batchDelete: (ids: number[]) => api.post<{ deleted: number }>('/members/batch-delete', { ids }),
  fetchProfile: (id: number) => api.post<Member>(`/members/${id}/fetch-profile`),
  batchFetchProfile: (ids: number[]) => api.post<{ total: number; success: number; failed: number }>('/members/batch-fetch-profile', { ids }),
  messages: (id: number, params?: { page?: number; pageSize?: number }) => {
    return api.get<unknown[]>(`/members/${id}/messages${buildQuery(params)}`)
  },
}

// Messages API
export const messagesApi = {
  list: (params?: {
    page?: number
    pageSize?: number
    groupId?: number
    memberId?: number
    search?: string
    startDate?: string
    endDate?: string
  }) => {
    return api.get<unknown[]>(`/messages${buildQuery(params)}`)
  },
  get: (id: number) => api.get<unknown>(`/messages/${id}`),
}

// Issues API
export const issuesApi = {
  list: (params?: {
    page?: number
    pageSize?: number
    status?: string
    customerId?: number
    groupId?: number
  }) => {
    return api.get<unknown[]>(`/issues${buildQuery(params)}`)
  },
  get: (id: number) => api.get<unknown>(`/issues/${id}`),
  update: (id: number, data: unknown) => api.put<unknown>(`/issues/${id}`, data),
  delete: (id: number) => api.delete(`/issues/${id}`),
  batchDelete: (ids: number[]) => api.post<{ deleted: number }>('/issues/batch-delete', { ids }),
  batchUpdateStatus: (ids: number[], status: string) =>
    api.post<{ updated: number }>('/issues/batch-update-status', { ids, status }),
  stats: () => api.get<unknown>('/issues/stats/summary'),
}

// Users API
export const usersApi = {
  list: (params?: { page?: number; pageSize?: number }) => {
    return api.get<unknown[]>(`/users${buildQuery(params)}`)
  },
  get: (id: number) => api.get<unknown>(`/users/${id}`),
  create: (data: unknown) => api.post<unknown>('/users', data),
  update: (id: number, data: unknown) => api.put<unknown>(`/users/${id}`, data),
  delete: (id: number) => api.delete(`/users/${id}`),
}

// Roles API
export const rolesApi = {
  list: () => api.get<unknown[]>('/roles'),
  get: (id: number) => api.get<unknown>(`/roles/${id}`),
  create: (data: unknown) => api.post<unknown>('/roles', data),
  update: (id: number, data: unknown) => api.put<unknown>(`/roles/${id}`, data),
  delete: (id: number) => api.delete(`/roles/${id}`),
  permissions: () => api.get<Record<string, string>>('/roles/permissions'),
}

// Settings API
export interface OAuthStatus {
  provider: string
  valid: boolean
  message: string
  refreshCommand?: string
}

export interface OAuthStatusResponse {
  currentProvider: string
  providers: OAuthStatus[]
}

export interface ChannelStatus {
  connected: boolean
  message: string
}

export const settingsApi = {
  get: () => api.get<Record<string, string>>('/settings'),
  update: (data: Record<string, string>) => api.put('/settings', data),
  getOAuthStatus: () => api.get<OAuthStatusResponse>('/settings/oauth/status'),
  checkOAuthProvider: (provider: string) => api.get<OAuthStatus>(`/settings/oauth/status/${provider}`),
  checkFeishuStatus: () => api.get<ChannelStatus>('/settings/channels/feishu/status'),
  checkLineStatus: () => api.get<ChannelStatus>('/settings/channels/line/status'),
}

// Analysis API
export const analysisApi = {
  run: (params?: { groupId?: number; since?: string }) =>
    api.post<unknown>('/analysis/run', params),
}

// Logs API
export const logsApi = {
  list: (params?: {
    page?: number
    pageSize?: number
    entityType?: string
    action?: string
    userId?: number
    startDate?: string
    endDate?: string
  }) => {
    return api.get<unknown[]>(`/logs${buildQuery(params)}`)
  },
}

// Knowledge API
export type KnowledgeSource = 'MANUAL' | 'FILE_IMPORT' | 'FEISHU_SYNC'

export interface KnowledgeEntry {
  id: number
  question: string
  answer: string
  category: string | null
  keywords: string[]
  source: KnowledgeSource
  sourceRef: string | null
  isActive: boolean
  isSyncedToAI: boolean
  usageCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: { id: number; displayName: string; username: string } | null
}

export interface KnowledgeStats {
  total: number
  active: number
  synced: number
  notSynced: number
  totalUsage: number
  embedding: {
    total: number
    embedded: number
    notEmbedded: number
    percentage: number
  }
  autoReply: {
    total: number
    matched: number
    notMatched: number
    today: number
    matchRate: number
  }
}

export interface AutoReplyLog {
  id: number
  messageId: number | null
  groupId: number
  memberId: number
  question: string
  answer: string | null
  knowledgeId: number | null
  matched: boolean
  confidence: number | null
  createdAt: string
}

export interface KnowledgeFile {
  name: string
  size: number
  createdAt: string
  modifiedAt: string
}

export interface FileUploadResult {
  filename: string
  originalName: string
  contentLength: number
  entriesFound: number
  preview: string
  entries: Array<{ question: string; answer: string; category?: string }>
}

export interface FileContent {
  filename: string
  content: string
  entriesFound: number
  entries: Array<{ question: string; answer: string; category?: string }>
}

export const knowledgeApi = {
  list: (params?: {
    page?: number
    pageSize?: number
    category?: string
    isActive?: string
    isSyncedToAI?: string
    search?: string
  }) => {
    return api.get<KnowledgeEntry[]>(`/knowledge${buildQuery(params)}`)
  },
  get: (id: number) => api.get<KnowledgeEntry>(`/knowledge/${id}`),
  create: (data: { question: string; answer: string; category?: string; keywords?: string[] }) =>
    api.post<KnowledgeEntry>('/knowledge', data),
  update: (id: number, data: { question?: string; answer?: string; category?: string | null; keywords?: string[]; isActive?: boolean }) =>
    api.put<KnowledgeEntry>(`/knowledge/${id}`, data),
  delete: (id: number) => api.delete(`/knowledge/${id}`),
  batchDelete: (ids: number[]) => api.post<{ deleted: number }>('/knowledge/batch-delete', { ids }),
  categories: () => api.get<{ name: string; count: number }[]>('/knowledge/categories'),
  stats: () => api.get<KnowledgeStats>('/knowledge/stats'),
  import: (entries: { question: string; answer: string; category?: string; keywords?: string[] }[]) =>
    api.post<{ created: number; updated: number; errors: string[] }>('/knowledge/import', { entries }),
  sync: (ids?: number[]) =>
    api.post<{ synced: number; failed: number }>('/knowledge/sync', { ids }),
  autoReplyLogs: (params?: { page?: number; pageSize?: number; matched?: string }) => {
    return api.get<AutoReplyLog[]>(`/knowledge/auto-reply-logs${buildQuery(params)}`)
  },

  // 文件相關 API
  getSupportedTypes: () => api.get<{ extensions: string[]; mimeTypes: string[] }>('/knowledge/files/supported-types'),

  uploadFile: async (file: File): Promise<{ success: boolean; data?: FileUploadResult; error?: { code: string; message: string } }> => {
    const token = useAuthStore.getState().token
    const formData = new FormData()
    formData.append('file', file)

    const response = await fetch(`${API_BASE}/knowledge/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    })

    return response.json()
  },

  listFiles: () => api.get<KnowledgeFile[]>('/knowledge/files'),

  getFileContent: (filename: string) => api.get<FileContent>(`/knowledge/files/${encodeURIComponent(filename)}`),

  deleteFile: (filename: string) => api.delete(`/knowledge/files/${encodeURIComponent(filename)}`),

  clearAllFiles: () => api.delete<{ deleted: number; errors: string[] }>('/knowledge/files'),

  importFromFile: (filename: string, category?: string) =>
    api.post<{ created: number; updated: number; errors: string[]; total: number }>(
      `/knowledge/files/${encodeURIComponent(filename)}/import`,
      { category }
    ),

  batchImportFromFiles: (filenames?: string[], category?: string) =>
    api.post<{
      created: number
      updated: number
      total: number
      filesProcessed: number
      errors: string[]
    }>('/knowledge/files/batch-import', { filenames, category }),

  // 飛書知識庫同步
  syncFromFeishu: () =>
    api.post<{ created: number; updated: number; errors: string[] }>('/knowledge/sync-feishu'),
}

// Tunnel API
export type TunnelMode = 'quick' | 'fixed'

export interface TunnelStatus {
  isRunning: boolean
  url: string | null
  webhookUrl: string | null
  startedAt: string | null
  error: string | null
  mode: TunnelMode
  hasToken: boolean
  customDomain: string
  customWebhookUrls: { line: string; feishu: string } | null
  lastQuickUrl: string | null
}

export interface TunnelHealth {
  isValid: boolean
  latency?: number
  error?: string
}

export const tunnelApi = {
  status: () => api.get<TunnelStatus>('/tunnel/status'),
  start: () => api.post<{ success: boolean; url?: string; webhookUrl?: string; error?: string; mode?: TunnelMode }>('/tunnel/start'),
  stop: () => api.post<{ success: boolean }>('/tunnel/stop'),
  restart: () => api.post<{ success: boolean; url?: string; webhookUrl?: string; error?: string }>('/tunnel/restart'),
  health: () => api.get<TunnelHealth>('/tunnel/health'),
  updateCustomDomain: (domain: string) =>
    api.put<{ customDomain: string; customWebhookUrls: { line: string; feishu: string } | null }>('/tunnel/custom-domain', { domain }),
  updateMode: (mode: TunnelMode, token?: string) =>
    api.put<{ mode: TunnelMode }>('/tunnel/mode', { mode, token }),
}
