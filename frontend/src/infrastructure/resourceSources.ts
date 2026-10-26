import type { JsonObject } from "../api/types";

export type ResourceKind = "node" | "ru" | "ue";

export interface CustomResourceDraft {
  id: string;
  kind: ResourceKind;
  name: string;
  hostname: string;
  sshUser: string;
  sshPort: string;
  roles: string[];
  provisioner: string;
  ips: string;
}

export interface ResourceCatalogState {
  status: "manual" | "catalog";
  message: string;
}

export interface ResourceSourceAdapter {
  id: string;
  label: string;
  kind: "federated" | "custom";
  description: string;
  catalog: ResourceCatalogState;
}

export interface InfrastructurePayload {
  deploymentModel: {
    nodes: JsonObject;
    rus: JsonObject;
    ues: JsonObject;
  };
}

// Provider entries describe discovery adapters, not supported infrastructure types.
// A future provider can be registered here without changing DeploymentModel normalization.
export const RESOURCE_SOURCES: ResourceSourceAdapter[] = [
  {
    id: "slices-r2lab",
    label: "SLICES + R2Lab",
    kind: "federated",
    description: "Use SLICES compute servers together with R2Lab radio devices.",
    catalog: {
      status: "catalog",
      message: "Provider resources are loaded from the backend catalog.",
    },
  },
  {
    id: "custom",
    label: "Custom",
    kind: "custom",
    description: "Describe local, private-lab, or future testbed resources manually.",
    catalog: {
      status: "manual",
      message: "Resources are entered manually and validated by the orchestrator models.",
    },
  },
];

export function createResourceDraft(kind: ResourceKind): CustomResourceDraft {
  return {
    id: crypto.randomUUID(),
    kind,
    name: "",
    hostname: "",
    sshUser: "root",
    sshPort: "22",
    roles: [],
    provisioner: "",
    ips: "",
  };
}

export function sourceById(sourceId: string): ResourceSourceAdapter | undefined {
  return RESOURCE_SOURCES.find((source) => source.id === sourceId);
}

export function normalizeCustomInfrastructure(
  resources: CustomResourceDraft[],
  selectedRuNames: string[] = [],
  selectedUeNames: string[] = [],
): InfrastructurePayload {
  const errors = validateCustomResources(resources);
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const nodes: JsonObject = {};
  const rus: JsonObject = {};
  const ues: JsonObject = {};

  for (const resource of resources) {
    const resourceName = resource.name.trim();
    const provisioner = resource.provisioner || null;
    const common = {
      is_provisioned: provisioner === null,
      provisioner,
    };

    if (resource.kind === "node") {
      nodes[resourceName] = {
        category: "node",
        ...common,
        ssh_info: sshInfo(resource),
        roles: resource.roles,
      };
      continue;
    }

    if (resource.kind === "ru") {
      // Unreferenced inventory RUs would be dropped by orchestrator synchronization anyway.
      if (selectedRuNames.includes(resourceName)) {
        rus[resourceName] = {
          category: "ru",
          ...common,
          ips: commaSeparatedValues(resource.ips),
        };
      }
      continue;
    }

    if (selectedUeNames.includes(resourceName)) {
      ues[resourceName] = {
        category: "ue",
        type: "cots",
        ...common,
        ssh_info: sshInfo(resource),
      };
    }
  }

  return {
    deploymentModel: { nodes, rus, ues },
  };
}

export function validateCustomResources(resources: CustomResourceDraft[]): string[] {
  const errors: string[] = [];
  const names = new Set<string>();

  for (const [index, resource] of resources.entries()) {
    const resourceName = resource.name.trim();
    const label = resourceName || `Resource ${index + 1}`;

    if (!resourceName) {
      errors.push(`Resource ${index + 1} needs a name.`);
    } else if (names.has(resourceName)) {
      errors.push(`Resource name ${resourceName} is duplicated.`);
    } else {
      names.add(resourceName);
    }

    if ((resource.kind === "node" || resource.kind === "ue") && !resource.hostname.trim()) {
      errors.push(`${label} needs a host or IP address.`);
    }

    const port = Number(resource.sshPort);
    if ((resource.kind === "node" || resource.kind === "ue") && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      errors.push(`${label} needs a valid SSH port.`);
    }
  }

  return errors;
}

function sshInfo(resource: CustomResourceDraft): JsonObject {
  return {
    hostname: resource.hostname.trim(),
    user: resource.sshUser.trim() || "root",
    port: Number(resource.sshPort),
  };
}

function commaSeparatedValues(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
