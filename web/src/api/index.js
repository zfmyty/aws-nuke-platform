/** 领域接口封装：视图层不直接拼接 URL */
import { api, streamUrl } from './client.js'

export const authApi = {
  login: (payload) => api('/api/auth/login', { method: 'POST', body: payload }),
  me: () => api('/api/auth/me'),
  changePassword: (payload) => api('/api/auth/password', { method: 'POST', body: payload }),
}

export const dashboardApi = {
  get: () => api('/api/dashboard'),
}

export const accountsApi = {
  list: (query) => api('/api/accounts', { query }),
  scanOrganization: () => api('/api/accounts/organization'),
  importAccounts: (payload) => api('/api/accounts/organization/import', { method: 'POST', body: payload }),
  get: (id) => api(`/api/accounts/${id}`),
  create: (payload) => api('/api/accounts', { method: 'POST', body: payload }),
  update: (id, payload) => api(`/api/accounts/${id}`, { method: 'PATCH', body: payload }),
  remove: (id) => api(`/api/accounts/${id}`, { method: 'DELETE' }),
  config: (id) => api(`/api/accounts/${id}/config`),
  saveConfig: (id, yaml) => api(`/api/accounts/${id}/config`, { method: 'PUT', body: { yaml } }),
  regenerateConfig: (id) => api(`/api/accounts/${id}/config/regenerate`, { method: 'POST' }),
  verify: (id) => api(`/api/accounts/${id}/verify`, { method: 'POST' }),
  alias: (id) => api(`/api/accounts/${id}/alias`),
  createAlias: (id, alias) => api(`/api/accounts/${id}/alias`, { method: 'POST', body: { alias } }),
  run: (id, payload) => api(`/api/accounts/${id}/run`, { method: 'POST', body: payload }),
}

export const jobsApi = {
  list: (query) => api('/api/jobs', { query }),
  get: (id) => api(`/api/jobs/${id}`),
  log: (id) => api(`/api/jobs/${id}/log`),
  cancel: (id) => api(`/api/jobs/${id}/cancel`, { method: 'POST' }),
  confirmPrompt: (id, text) => api(`/api/jobs/${id}/prompt-confirm`, { method: 'POST', body: { text } }),
  remove: (id) => api(`/api/jobs/${id}`, { method: 'DELETE' }),
  batchDelete: (ids) => api('/api/jobs/batch-delete', { method: 'POST', body: { ids } }),
  stream: (id) => streamUrl(`/api/jobs/${id}/stream`),
}

export const usersApi = {
  list: () => api('/api/users'),
  create: (payload) => api('/api/users', { method: 'POST', body: payload }),
  update: (id, payload) => api(`/api/users/${id}`, { method: 'PATCH', body: payload }),
  remove: (id) => api(`/api/users/${id}`, { method: 'DELETE' }),
}

export const systemApi = {
  health: () => api('/api/health'),
  status: (refresh = false) => api('/api/system/status', { query: refresh ? { refresh: 1 } : undefined }),
  policy: () => api('/api/system/policy'),
  installCli: () => api('/api/system/install-cli', { method: 'POST' }),
  saveCredentials: (payload) => api('/api/system/credentials', { method: 'POST', body: payload }),
  verifyCredentials: () => api('/api/system/credentials/verify', { method: 'POST' }),
  clearCredentials: () => api('/api/system/credentials', { method: 'DELETE' }),
  settings: () => api('/api/system/settings'),
  updateSettings: (payload) => api('/api/system/settings', { method: 'PATCH', body: payload }),
  resourceTypes: () => api('/api/system/resource-types'),
  profiles: () => api('/api/system/profiles'),
  explainConfig: (accountId) => api('/api/system/explain-config', { method: 'POST', body: { accountId } }),
  audit: (limit = 100) => api('/api/system/audit', { query: { limit } }),
  checkNukeUpdate: (force = false) => api('/api/system/aws-nuke/update', { query: force ? { force: 1 } : undefined }),
  updateNuke: () => api('/api/system/aws-nuke/update', { method: 'POST' }),
  diagnoseNuke: () => api('/api/system/aws-nuke/diagnose'),
}
