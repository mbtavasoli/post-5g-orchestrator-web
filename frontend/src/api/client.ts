import type {
  ActionRequest,
  DeploymentMetadata,
  DeploymentState,
  JobLogs,
  JobRecord,
  R2LabDevices,
  R2LabReservation,
  R2LabSessionStatus,
  RuntimeOverview,
  SlicesAuthStatus,
  ApiErrorBody,
  ApiErrorResponse,
  BootstrapData,
  CreateDeploymentRequest,
  DeploymentResponse,
  HealthResponse,
  JsonSchema,
  OptionsResponse,
  ProviderCatalogsResponse,
  ReconcileResponse,
  ReconcileStage,
} from './types'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody | null

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (!value || typeof value !== 'object' || !('error' in value)) {
    return false
  }

  const error = value.error
  return Boolean(
    error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string',
  )
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const body = isApiErrorResponse(payload) ? payload.error : null
    throw new ApiError(response.status, body, `Request failed with status ${response.status}.`)
  }

  return payload as T
}

export async function loadBootstrapData(signal?: AbortSignal): Promise<BootstrapData> {
  const [health, options, metamodelSchema, deploymentModelSchema, providerCatalogs] = await Promise.all([
    request<HealthResponse>('/api/health', { signal }),
    request<OptionsResponse>('/api/options', { signal }),
    request<JsonSchema>('/api/schema/metamodel', { signal }),
    request<JsonSchema>('/api/schema/deployment-model', { signal }),
    request<ProviderCatalogsResponse>('/api/provider-catalogs', { signal }),
  ])

  return { health, options, metamodelSchema, deploymentModelSchema, providerCatalogs }
}

export function createDeployment(
  body: CreateDeploymentRequest,
  signal?: AbortSignal,
): Promise<DeploymentResponse> {
  return request<DeploymentResponse>('/api/deployments', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  })
}

export function replaceDeployment(
  deploymentId: string,
  body: CreateDeploymentRequest,
  signal?: AbortSignal,
): Promise<DeploymentResponse> {
  return request<DeploymentResponse>(`/api/deployments/${encodeURIComponent(deploymentId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    signal,
  })
}

export function reconcileDeployment(
  deploymentId: string,
  until: ReconcileStage,
  signal?: AbortSignal,
): Promise<ReconcileResponse> {
  const query = new URLSearchParams({ until })
  return request<ReconcileResponse>(
    `/api/deployments/${encodeURIComponent(deploymentId)}/reconcile?${query}`,
    { method: 'POST', signal },
  )
}


const deploymentPath = (deploymentId: string) => `/api/deployments/${encodeURIComponent(deploymentId)}`

export function listDeployments(signal?: AbortSignal): Promise<DeploymentMetadata[]> {
  return request<DeploymentMetadata[]>('/api/deployments', { signal })
}

export function getDeployment(deploymentId: string, signal?: AbortSignal): Promise<DeploymentResponse> {
  return request<DeploymentResponse>(deploymentPath(deploymentId), { signal })
}

export function getRuntime(deploymentId: string, signal?: AbortSignal): Promise<RuntimeOverview> {
  return request<RuntimeOverview>(`${deploymentPath(deploymentId)}/runtime`, { signal })
}

export function getDeploymentState(deploymentId: string, signal?: AbortSignal): Promise<DeploymentState> {
  return request<DeploymentState>(`${deploymentPath(deploymentId)}/state`, { signal })
}

export function startAction(deploymentId: string, body: ActionRequest): Promise<JobRecord> {
  return request<JobRecord>(`${deploymentPath(deploymentId)}/actions`, { method: 'POST', body: JSON.stringify(body) })
}

export function getJobLogs(deploymentId: string, jobId: string, signal?: AbortSignal): Promise<JobLogs> {
  return request<JobLogs>(`${deploymentPath(deploymentId)}/jobs/${encodeURIComponent(jobId)}/logs`, { signal })
}

export function getSlicesAuth(refresh = false, signal?: AbortSignal): Promise<SlicesAuthStatus> {
  return request<SlicesAuthStatus>(`/api/providers/slices/auth${refresh ? '?refresh=true' : ''}`, { signal })
}

export function startSlicesLogin(): Promise<SlicesAuthStatus> {
  return request<SlicesAuthStatus>('/api/providers/slices/auth/login', { method: 'POST' })
}

export function getR2LabSession(signal?: AbortSignal): Promise<R2LabSessionStatus> {
  return request<R2LabSessionStatus>('/api/providers/r2lab/session', { signal })
}

export function signInR2Lab(body: { email: string; password: string; slice: string }): Promise<R2LabSessionStatus> {
  return request<R2LabSessionStatus>('/api/providers/r2lab/session', { method: 'POST', body: JSON.stringify(body) })
}

export function signOutR2Lab(): Promise<R2LabSessionStatus> {
  return request<R2LabSessionStatus>('/api/providers/r2lab/session', { method: 'DELETE' })
}

export function getR2LabReservation(signal?: AbortSignal): Promise<R2LabReservation> {
  return request<R2LabReservation>('/api/providers/r2lab/reservation', { signal })
}

export function releaseR2LabLease(leaseId: number): Promise<R2LabReservation> {
  return request<R2LabReservation>(`/api/providers/r2lab/leases/${leaseId}`, { method: 'DELETE' })
}

export function getR2LabDevices(names: string[], signal?: AbortSignal): Promise<R2LabDevices> {
  const query = new URLSearchParams()
  for (const name of names) query.append('names', name)
  return request<R2LabDevices>(`/api/providers/r2lab/devices?${query}`, { signal })
}
