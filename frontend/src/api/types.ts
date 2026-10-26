export type JsonObject = Record<string, unknown>

export interface HealthResponse {
  status: 'ok'
  versions: Record<string, string>
}

export interface NetworkOptions {
  implementations: string[];
  default_implementation: string;
  component_types: string[];
  supported_components: Record<string, string[]>;
  default_components: Record<string, ModelComponentDefault>;
}

export interface ModelComponentDefault {
  type: string;
  model?: string | null;
  implementation?: string | null;
}

export interface ProvisionerInstanceOption {
  type: string;
  supported_categories: string[];
}

export interface ProvisionerOptions {
  types: string[];
  supported_categories: Record<string, string[]>;
  default_instances: Record<string, ProvisionerInstanceOption>;
}

export interface RUOptions {
  types: string[];
  models: Record<string, string[]>;
  capabilities: Record<string, Record<string, JsonObject>>;
  default_components: Record<string, ModelComponentDefault>;
}

export interface OptionsResponse {
  versions: Record<string, string>
  core: NetworkOptions
  ran: NetworkOptions
  ric: NetworkOptions
  ue: {
    types: string[];
    implementations: string[];
    default_implementation: string;
    default_components: Record<string, ModelComponentDefault>;
  };
  ru: RUOptions;
  provisioners: ProvisionerOptions;
  node_roles: string[];
  [key: string]: unknown;
}

export interface JsonSchema extends JsonObject {
  title?: string
  $defs?: Record<string, JsonObject>
  properties?: Record<string, JsonObject>
}

export interface SophiaNodeCatalogEntry {
  id: string;
  available: boolean;
  r2lab_radio_capable: boolean;
  ssh_hostname?: string;
  ssh?: {
    hostname: string;
    jumphost?: { hostname: string; port: number | null; user: string | null; user_from?: "slices_username" };
  };
}

export interface R2LabRUCatalogEntry {
  id: string;
  label: string;
  type: string;
  model: string;
}

export interface R2LabUECatalogEntry {
  id: string;
  label: string;
  model: string;
  imsi: string;
  attached_to?: string;
}

export interface BIParamsDefaults {
  extra_path: string | null;
  infra: string;
  image: string;
  flavor: string;
  project: string;
  experiment: string;
  create_experiment: boolean;
  experiment_duration: string;
  node_duration: string;
  allow_created: boolean;
}

export interface ProviderCatalogsResponse {
  version: number;
  updated: string;
  sources: Record<string, string>;
  slices: {
    sophianodes: SophiaNodeCatalogEntry[];
    bi: { provisioner_type: string };
  };
  r2lab: {
    required_sophianodes: string[];
    radio_units: R2LabRUCatalogEntry[];
    user_equipment: R2LabUECatalogEntry[];
  };
  provisioner_models: {
    bi: {
      type: string;
      params_defaults: BIParamsDefaults;
      params_schema: JsonSchema;
      provisioner_schema: JsonSchema;
    };
    r2lab: {
      type: string;
      params_schema: JsonSchema;
      provisioner_schema: JsonSchema;
    };
  };
}

export interface DeploymentMetadata {
  id: string
  name: string
  created_at: string
  updated_at: string
}

export interface DeploymentResponse {
  deployment: DeploymentMetadata
  metamodel: JsonObject
  deployment_model: JsonObject
}

export interface CreateDeploymentRequest {
  name: string;
  metamodel: JsonObject | null;
  deployment_model: JsonObject;
}

export type ReconcileStage = "sync" | "core" | "ric" | "ran" | "ue";

export interface ReconcileResponse {
  until: ReconcileStage;
  stages: ReconcileStage[];
  metamodel: JsonObject;
  deployment_model: JsonObject;
}

export interface ApiErrorDetail {
  loc?: Array<string | number>
  type?: string
  msg?: string
  [key: string]: unknown
}

export interface ApiErrorBody {
  kind: string
  stage: string
  exception: string
  message: string
  details: ApiErrorDetail[] | null
  provider?: 'slices' | 'r2lab'
}

export interface ApiErrorResponse {
  error: ApiErrorBody
}

export interface BootstrapData {
  health: HealthResponse
  options: OptionsResponse
  metamodelSchema: JsonSchema
  deploymentModelSchema: JsonSchema
  providerCatalogs: ProviderCatalogsResponse
}


// ---- deployment runtime (long-running actions) -----------------------------------

export type DeploymentStage = "infrastructure" | "kubernetes" | "core" | "ric" | "radio" | "ran" | "ue";
export type StageAction = "deploy" | "remove" | "reserve";
export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "skipped";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "interrupted";

export interface StageRun {
  stage: DeploymentStage;
  action: StageAction;
  status: StageStatus;
  started_at: string | null;
  finished_at: string | null;
  error: ApiErrorBody | null;
}

export interface JobRecord {
  id: string;
  deployment_id: string;
  action: StageAction;
  status: JobStatus;
  stages: StageRun[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: ApiErrorBody | null;
  reservation_minutes: number | null;
}

export interface StageRequirement {
  provider: "slices" | "r2lab";
  kind: "authentication" | "reservation";
  label: string;
  satisfied: boolean;
  message: string | null;
}

export interface StageOverview {
  stage: DeploymentStage;
  applicable: boolean;
  status: StageStatus;
  items: Array<{ name: string; done: boolean }>;
  done: number;
  total: number;
  requirements: StageRequirement[];
  can_deploy: boolean;
  can_retry: boolean;
  can_remove: boolean;
  can_reserve: boolean;
  last_run: StageRun | null;
}

export interface RuntimeOverview {
  deployment_id: string;
  has_state: boolean;
  active_job: JobRecord | null;
  last_job: JobRecord | null;
  stages: StageOverview[];
}

export interface ActionRequest {
  action: StageAction;
  stages?: DeploymentStage[] | null;
  reservation_minutes?: number | null;
}

export interface JobLogs {
  job_id: string;
  status?: JobStatus;
  runs: string[];
  text: string;
  truncated: boolean;
}

export interface SlicesAuthStatus {
  provider: "slices";
  state: "cli_missing" | "unauthenticated" | "authenticated" | "pending";
  user: string | null;
  verification_url: string | null;
  message: string | null;
  checked_at: string;
  expiry_detectable: boolean;
}

export interface R2LabSessionStatus {
  provider: "r2lab";
  state: "unauthenticated" | "authenticated";
  email: string | null;
  slice: string | null;
  expires_at: string | null;
  token_expired?: boolean;
}

export interface R2LabLease {
  id: number;
  slice_name: string | null;
  t_from: string;
  t_until: string;
  mine: boolean;
}

export interface R2LabReservation {
  state: "not_reserved" | "reserved_by_you" | "reserved_by_other";
  current: R2LabLease | null;
  upcoming: R2LabLease[];
  slice: string | null;
  checked_at: string;
}

export interface R2LabDevices {
  known: Record<string, { name: string; infrastructure: string | null; ips: string[] | null }>;
  requested: Array<{ name: string; known: boolean; power?: { power_status?: string; success?: boolean; error?: string } }>;
  checked_at: string;
}

export interface DeploymentState {
  has_state: boolean;
  metamodel: JsonObject;
  deployment_model: JsonObject;
}
