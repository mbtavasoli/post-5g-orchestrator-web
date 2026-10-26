import type { JsonObject, JsonSchema } from "../api/types";

// Builder-side drafts of keyed MetaModel/DeploymentModel entries. Cross-references are
// held by draft id so renaming an instance never breaks them; they are turned into
// component names only when the request is built.

export interface RuInstance {
  id: string;
  name: string;
  type: string;
  model: string;
  providerRuId: string;
}

export interface RanInstance {
  id: string;
  name: string;
  type: string;
  /** gNB/DU `config.ru` */
  ruId: string;
  /** DU `config.cu_cp` (CU or CU-CP) and CU-UP `config.cu_cp` (CU-CP) */
  cuCpId: string;
  /** DU `config.cu_up` (CU or CU-UP) */
  cuUpId: string;
  /** Optional identity fields; an empty string keeps the model default. */
  identity: Partial<Record<IdentityField, string>>;
}

export interface UeInstance {
  id: string;
  name: string;
  type: string;
  implementation: string;
  providerUeId: string;
  supi: string;
  /** UE `config.gnbs` (gNB or DU names) */
  gnbIds: string[];
  /** Containerized UE `config.ru` */
  ruId: string;
}

export type IdentityField = "gnbId" | "nrCellId" | "physicalCellId" | "gnbDuId" | "gnbCuUpId";

export interface NumericFieldInfo {
  default: number;
  minimum?: number;
  maximum?: number;
}

export interface BuilderModelDefaults {
  identity: Record<IdentityField, NumericFieldInfo>;
  supi: { default: string; pattern?: string };
}

/** Identity fields exposed per RAN type, as defined by the metamodel config classes. */
export const IDENTITY_FIELDS_BY_TYPE: Record<string, IdentityField[]> = {
  gnb: ["gnbId", "nrCellId", "physicalCellId"],
  du: ["gnbDuId", "nrCellId", "physicalCellId"],
  cu: ["gnbId"],
  cu_cp: ["gnbId"],
  cu_up: ["gnbCuUpId"],
};

/** RAN types whose instances should not reuse the same value of a given identity field. */
export const IDENTITY_SCOPES: Record<IdentityField, string[]> = {
  gnbId: ["gnb", "cu", "cu_cp"],
  nrCellId: ["gnb", "du"],
  physicalCellId: ["gnb", "du"],
  gnbDuId: ["du"],
  gnbCuUpId: ["cu_up"],
};

export const IDENTITY_LABELS: Record<IdentityField, string> = {
  gnbId: "gNB ID",
  nrCellId: "NR cell ID",
  physicalCellId: "PCI",
  gnbDuId: "DU ID",
  gnbCuUpId: "CU-UP ID",
};

const IDENTITY_SCHEMA_SOURCES: Record<IdentityField, [string, string]> = {
  gnbId: ["GNBConfig", "gnbId"],
  nrCellId: ["GNBConfig", "nrCellId"],
  physicalCellId: ["GNBConfig", "physicalCellId"],
  gnbDuId: ["DUConfig", "gnbDuId"],
  gnbCuUpId: ["CUUPConfig", "gnbCuUpId"],
};

/** Helm release names are `<implementation>-<name>`, so names must stay Kubernetes-safe. */
export const COMPONENT_NAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/;

export const RAN_TYPE_LABELS: Record<string, string> = {
  gnb: "gNB",
  du: "DU",
  cu: "CU",
  cu_cp: "CU-CP",
  cu_up: "CU-UP",
};

export function ranTypeLabel(type: string): string {
  return RAN_TYPE_LABELS[type] ?? type;
}

export function isRadioType(type: string): boolean {
  return type === "gnb" || type === "du";
}

/** Same transformation as orchestrator `build_k8s_safe`. */
export function k8sSafeName(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "-");
}

export function modelDefaultsFromSchema(schema: JsonSchema): BuilderModelDefaults {
  const identity = Object.fromEntries(
    (Object.entries(IDENTITY_SCHEMA_SOURCES) as Array<[IdentityField, [string, string]]>).map(
      ([field, [definition, property]]) => {
        const info = schemaProperty(schema, definition, property);
        const minimum = typeof info?.minimum === "number" ? info.minimum : undefined;
        const fallback = minimum ?? 0;
        return [field, {
          default: typeof info?.default === "number" ? info.default : fallback,
          minimum,
          maximum: typeof info?.maximum === "number" ? info.maximum : undefined,
        }];
      },
    ),
  ) as Record<IdentityField, NumericFieldInfo>;
  const supi = schemaProperty(schema, "UEConfiguration", "supi");
  return {
    identity,
    supi: {
      default: typeof supi?.default === "string" ? supi.default : "",
      pattern: typeof supi?.pattern === "string" ? supi.pattern : undefined,
    },
  };
}

/** Smallest `<prefix><n>` (n ≥ 1) not already used. */
export function nextInstanceName(prefix: string, usedNames: Iterable<string>): string {
  const used = new Set([...usedNames].map((name) => name.trim()));
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function createRuInstance(name: string, type: string, model = "", providerRuId = ""): RuInstance {
  return { id: crypto.randomUUID(), name, type, model, providerRuId };
}

export function createRanInstance(
  name: string,
  type: string,
  others: RanInstance[],
  defaults: BuilderModelDefaults,
): RanInstance {
  const identity: RanInstance["identity"] = {};
  for (const field of IDENTITY_FIELDS_BY_TYPE[type] ?? []) {
    const suggested = suggestIdentityValue(field, others, defaults);
    identity[field] = suggested === defaults.identity[field].default ? "" : String(suggested);
  }
  return { id: crypto.randomUUID(), name, type, ruId: "", cuCpId: "", cuUpId: "", identity };
}

export function createUeInstance(
  name: string,
  type: string,
  implementation: string,
  others: UeInstance[],
  defaults: BuilderModelDefaults,
): UeInstance {
  const supi = suggestSupi(others, defaults);
  return {
    id: crypto.randomUUID(),
    name,
    type,
    implementation,
    providerUeId: "",
    supi: supi === defaults.supi.default ? "" : supi,
    gnbIds: [],
    ruId: "",
  };
}

export function effectiveIdentity(
  instance: RanInstance,
  field: IdentityField,
  defaults: BuilderModelDefaults,
): number {
  const raw = instance.identity[field]?.trim() ?? "";
  return raw ? Number(raw) : defaults.identity[field].default;
}

export function effectiveSupi(ue: UeInstance, defaults: BuilderModelDefaults): string {
  return ue.supi.trim() || defaults.supi.default;
}

function suggestIdentityValue(field: IdentityField, others: RanInstance[], defaults: BuilderModelDefaults): number {
  const scope = IDENTITY_SCOPES[field];
  const used = new Set(
    others
      .filter((instance) => scope.includes(instance.type) && (IDENTITY_FIELDS_BY_TYPE[instance.type] ?? []).includes(field))
      .map((instance) => effectiveIdentity(instance, field, defaults)),
  );
  let value = defaults.identity[field].default;
  while (used.has(value)) value += 1;
  return value;
}

function suggestSupi(others: UeInstance[], defaults: BuilderModelDefaults): string {
  const base = defaults.supi.default;
  if (!/^[0-9]+$/.test(base)) return "";
  const used = new Set(others.map((ue) => effectiveSupi(ue, defaults)));
  let value = BigInt(base);
  while (used.has(value.toString().padStart(base.length, "0"))) value += 1n;
  return value.toString().padStart(base.length, "0");
}

/**
 * Fill references that are empty or point to removed instances with a sensible
 * candidate. Existing valid choices are never replaced.
 */
export function fillMissingReferences(
  rus: RuInstance[],
  ranInstances: RanInstance[],
  ues: UeInstance[],
  /** UE whose gNB list the user is editing; an empty list is left for validation to report. */
  editedUeId?: string,
): { ranInstances: RanInstance[]; ues: UeInstance[] } {
  const ruIds = new Set(rus.map((ru) => ru.id));
  const byType = (types: string[]) => ranInstances.filter((instance) => types.includes(instance.type));
  const cuCpTargets = byType(["cu", "cu_cp"]);
  const cuCps = byType(["cu_cp"]);

  const nextRan = ranInstances.map((instance) => {
    const next = { ...instance };
    if (isRadioType(next.type) && !ruIds.has(next.ruId)) {
      const usedByRadio = new Set(
        ranInstances.filter((other) => other.id !== next.id && isRadioType(other.type)).map((other) => other.ruId),
      );
      next.ruId = rus.find((ru) => !usedByRadio.has(ru.id))?.id
        ?? rus.find((ru) => ru.type === "simulated")?.id
        ?? "";
    }
    if (next.type === "du") {
      if (!cuCpTargets.some((target) => target.id === next.cuCpId)) {
        next.cuCpId = cuCpTargets[0]?.id ?? "";
      }
      const cuCp = ranInstances.find((target) => target.id === next.cuCpId);
      const cuUpTargets = byType(["cu", "cu_up"]);
      if (!cuUpTargets.some((target) => target.id === next.cuUpId)) {
        next.cuUpId = cuCp?.type === "cu"
          ? cuCp.id
          : cuUpTargets.find((target) => target.type === "cu_up" && target.cuCpId === next.cuCpId)?.id
            ?? cuUpTargets[0]?.id
            ?? "";
      }
    }
    if (next.type === "cu_up" && !cuCps.some((target) => target.id === next.cuCpId)) {
      next.cuCpId = cuCps[0]?.id ?? "";
    }
    return next;
  });

  const radios = nextRan.filter((instance) => isRadioType(instance.type));
  const radioIds = new Set(radios.map((instance) => instance.id));
  const nextUes = ues.map((ue) => {
    const next = { ...ue, gnbIds: ue.gnbIds.filter((id) => radioIds.has(id)) };
    if (next.gnbIds.length === 0 && radios.length > 0 && ue.id !== editedUeId) {
      next.gnbIds = [leastLoadedRadio(radios, ues.filter((other) => other.id !== ue.id))];
    }
    if (ue.type !== "cots" && !ruIds.has(next.ruId)) {
      next.ruId = rus.find((ru) => ru.type === "simulated")?.id ?? rus[0]?.id ?? "";
    }
    return next;
  });

  return { ranInstances: nextRan, ues: nextUes };
}

function leastLoadedRadio(radios: RanInstance[], ues: UeInstance[]): string {
  const load = new Map(radios.map((radio) => [radio.id, 0]));
  for (const ue of ues) {
    for (const id of ue.gnbIds) {
      if (load.has(id)) load.set(id, (load.get(id) ?? 0) + 1);
    }
  }
  return [...radios].sort((left, right) => (load.get(left.id) ?? 0) - (load.get(right.id) ?? 0))[0]?.id ?? "";
}

/** Names of the instances that reference a given RU. */
export function ruUsers(ruId: string, ranInstances: RanInstance[], ues: UeInstance[]): string[] {
  return [
    ...ranInstances.filter((instance) => isRadioType(instance.type) && instance.ruId === ruId),
    ...ues.filter((ue) => ue.type !== "cots" && ue.ruId === ruId),
  ].map((instance) => instance.name.trim() || "(unnamed)");
}

function schemaProperty(schema: JsonSchema, definition: string, property: string): JsonObject | undefined {
  const properties = schema.$defs?.[definition]?.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const value = (properties as JsonObject)[property];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
