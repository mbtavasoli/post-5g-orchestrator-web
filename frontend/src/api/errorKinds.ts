/** Human labels for the backend error kinds; the raw kind is shown next to them. */
export const ERROR_KIND_LABELS: Record<string, string> = {
  validation: "Validation error",
  reference: "Invalid reference",
  state: "Invalid resource state",
  reconciliation: "Reconciliation error",
  not_found: "Not found",
  conflict: "Action not possible now",
  authentication_required: "Authentication required",
  reservation_required: "Reservation required",
  resource_unavailable: "Resource unavailable",
  provisioning_failure: "Provisioning failed",
  kubernetes_failure: "Kubernetes setup failed",
  component_failure: "Component deployment failed",
  provider_error: "Provider API error",
  internal: "Internal backend error",
};
