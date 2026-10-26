import type {
  CreateDeploymentRequest,
  JsonObject,
  JsonSchema,
  ModelComponentDefault,
  OptionsResponse,
  ProviderCatalogsResponse,
} from "../api/types";
import {
  normalizeCustomInfrastructure,
  sourceById,
  validateCustomResources,
  type CustomResourceDraft,
} from "../infrastructure/resourceSources";
import {
  COMPONENT_NAME_PATTERN,
  IDENTITY_FIELDS_BY_TYPE,
  IDENTITY_LABELS,
  IDENTITY_SCOPES,
  createRanInstance,
  createRuInstance,
  createUeInstance,
  effectiveIdentity,
  effectiveSupi,
  fillMissingReferences,
  isRadioType,
  k8sSafeName,
  nextInstanceName,
  ranTypeLabel,
  ruUsers,
  type BuilderModelDefaults,
  type IdentityField,
  type RanInstance,
  type RuInstance,
  type UeInstance,
} from "./instances";

export interface DeploymentBuilderState {
  name: string;
  resourceSource: string;
  resources: CustomResourceDraft[];
  sophianodeIds: string[];
  biEnabled: boolean;
  biVmNames: string[];
  biInfra: string;
  biImage: string;
  biFlavor: string;
  biProject: string;
  biExperiment: string;
  biCreateExperiment: boolean;
  biExperimentDuration: string;
  biNodeDuration: string;
  /** SLICES username, used as jump-host user for SophiaNodes reached through the POS gateway. */
  slicesUsername: string;
  coreImplementation: string;
  coreComponentMode: "all" | "selected";
  coreComponentTypes: string[];
  ranImplementation: string;
  ranInstances: RanInstance[];
  rus: RuInstance[];
  ues: UeInstance[];
  ricEnabled: boolean;
  ricImplementation: string;
  placementMode: "simple" | "explicit";
  defaultPlacementNode: string;
  /** Target node per placement key (see `placementKey`). */
  componentPlacements: Record<string, string>;
  masterNode: string;
  clusterName: string;
  nrBand: string;
  channelBandwidthMhz: string;
}

export interface SchemaFieldInfo {
  default?: unknown;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export type PlacementCategory = "core" | "ran" | "ric" | "ue";

export interface PlacementTarget {
  key: string;
  name: string;
  label: string;
  category: PlacementCategory;
  type: string;
  /** The instance drives an R2Lab radio and must run on a radio-capable SophiaNode. */
  needsR2LabNode: boolean;
}

/**
 * How a target reaches its node:
 * - category-role: only the category label (simple mode)
 * - type-role: category + type labels with `force_type_scheduling` (tutorial mechanism;
 *   used when every instance of that type goes to the same node)
 * - node-name: `node_name` pin (tutorial mechanism for an individual instance; used when
 *   instances of one type are spread across nodes, and always for UEs)
 */
export type PlacementStrategy = "category-role" | "type-role" | "node-name";

export interface PlacementAssignment extends PlacementTarget {
  node: string;
  strategy: PlacementStrategy;
}

export function placementKey(category: PlacementCategory, id: string): string {
  return `${category}:${id}`;
}

export function createInitialBuilderState(
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
  defaults: BuilderModelDefaults,
): DeploymentBuilderState {
  const firstSophianode = catalogs.slices.sophianodes.find((node) => node.available)?.id ?? "";

  const rus = Object.values(options.ru.default_components).map((ru, index) =>
    createRuInstance(`ru${index + 1}`, ru.type, ru.model ?? ""),
  );
  const supportedRan = options.ran.supported_components[options.ran.default_implementation] ?? [];
  const ranInstances: RanInstance[] = [];
  for (const component of Object.values(options.ran.default_components)) {
    if (!supportedRan.includes(component.type)) continue;
    const name = nextInstanceName(
      component.type,
      ranInstances.map((instance) => instance.name),
    );
    ranInstances.push(createRanInstance(name, component.type, ranInstances, defaults));
  }
  const ues: UeInstance[] = [];
  for (const ue of Object.values(options.ue.default_components)) {
    const type = ue.type || options.ue.types[0] || "";
    ues.push(
      createUeInstance(
        nextInstanceName(
          "ue",
          ues.map((candidate) => candidate.name),
        ),
        type,
        ue.implementation ?? options.ue.default_implementation,
        ues,
        defaults,
      ),
    );
  }
  const filled = fillMissingReferences(rus, ranInstances, ues);

  return {
    name: "",
    resourceSource: "custom",
    resources: [],
    sophianodeIds: firstSophianode ? [firstSophianode] : [],
    biEnabled: false,
    biVmNames: ["node1"],
    biInfra: catalogs.provisioner_models.bi.params_defaults.infra,
    biImage: catalogs.provisioner_models.bi.params_defaults.image,
    biFlavor: catalogs.provisioner_models.bi.params_defaults.flavor,
    biProject: catalogs.provisioner_models.bi.params_defaults.project,
    biExperiment: catalogs.provisioner_models.bi.params_defaults.experiment,
    biCreateExperiment: catalogs.provisioner_models.bi.params_defaults.create_experiment,
    biExperimentDuration: catalogs.provisioner_models.bi.params_defaults.experiment_duration,
    biNodeDuration: catalogs.provisioner_models.bi.params_defaults.node_duration,
    slicesUsername: "",
    coreImplementation: options.core.default_implementation,
    coreComponentMode: "all",
    coreComponentTypes:
      options.core.supported_components[options.core.default_implementation] ?? [],
    ranImplementation: options.ran.default_implementation,
    ranInstances: filled.ranInstances,
    rus,
    ues: filled.ues,
    ricEnabled: false,
    ricImplementation: options.ric.default_implementation,
    placementMode: "simple",
    defaultPlacementNode: firstSophianode,
    componentPlacements: {},
    masterNode: "",
    clusterName: "",
    nrBand: "",
    channelBandwidthMhz: "",
  };
}

export function validateBuilderStep(
  step: number,
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): string[] {
  if (step === 0) {
    return state.name.trim() ? [] : ["Enter a deployment name."];
  }

  if (step === 1) {
    const source = sourceById(state.resourceSource);
    if (!source) return ["Choose a valid infrastructure source."];
    if (source.kind === "custom") {
      const errors = validateCustomResources(state.resources);
      if (!state.resources.some((resource) => resource.kind === "node" && resource.name.trim())) {
        errors.push("Add at least one infrastructure node.");
      }
      return errors;
    }
    return validateProviderInfrastructure(state, catalogs);
  }

  if (step === 2) {
    return [
      ...validateComponentChoices(state, options, catalogs),
      ...validatePlacement(state, options, catalogs),
    ];
  }

  if (step === 3 && state.masterNode) {
    const nodeNames = builderNodeNames(state, catalogs);
    return nodeNames.includes(state.masterNode)
      ? []
      : ["Choose a master node from the current inventory."];
  }

  return [];
}

export function buildDeploymentRequest(
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): CreateDeploymentRequest {
  const errors = [0, 1, 2, 3].flatMap((step) =>
    validateBuilderStep(step, state, options, catalogs),
  );
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }

  const ruNames = new Map(state.rus.map((ru) => [ru.id, ru.name.trim()]));
  const ranNames = new Map(
    state.ranInstances.map((instance) => [instance.id, instance.name.trim()]),
  );
  const physicalRuNames = state.rus
    .filter((ru) => ru.type !== "simulated")
    .map((ru) => ru.name.trim());
  const cotsUeNames = state.ues.filter((ue) => ue.type === "cots").map((ue) => ue.name.trim());

  const infrastructure: {
    nodes: JsonObject;
    rus: JsonObject;
    ues: JsonObject;
    provisioners?: JsonObject;
  } =
    state.resourceSource === "custom"
      ? normalizeCustomInfrastructure(state.resources, physicalRuNames, cotsUeNames).deploymentModel
      : buildProviderInfrastructure(state, catalogs);

  const coreComponents = buildSelectedComponents(
    options.core.default_components,
    selectedComponentTypes(
      state.coreComponentMode,
      state.coreComponentTypes,
      options.core.supported_components[state.coreImplementation] ?? [],
    ),
  );
  const amfName = Object.entries(coreComponents).find(
    ([, component]) => isObject(component) && component.type === "amf",
  )?.[0];

  const radioConfiguration: JsonObject = {};
  setNumberIfPresent(radioConfiguration, "nrBand", state.nrBand);
  setNumberIfPresent(radioConfiguration, "channelBandwidthMhz", state.channelBandwidthMhz);

  const ranComponents: JsonObject = {};
  for (const instance of state.ranInstances) {
    const config: JsonObject = {};
    for (const field of IDENTITY_FIELDS_BY_TYPE[instance.type] ?? []) {
      const raw = instance.identity[field]?.trim();
      if (raw) config[field] = Number(raw);
    }
    if (isRadioType(instance.type)) {
      config.ru = ruNames.get(instance.ruId);
      if (Object.keys(radioConfiguration).length > 0)
        config.radioConfiguration = { ...radioConfiguration };
    }
    if (instance.type === "du") {
      config.cu_cp = ranNames.get(instance.cuCpId);
      config.cu_up = ranNames.get(instance.cuUpId);
    }
    if (instance.type === "cu_up") {
      config.cu_cp = ranNames.get(instance.cuCpId);
    }
    if (["gnb", "cu", "cu_cp"].includes(instance.type) && amfName) {
      config.amf = amfName;
    }
    ranComponents[instance.name.trim()] = {
      type: instance.type,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  }

  const providerUes = new Map(catalogs.r2lab.user_equipment.map((ue) => [ue.id, ue]));
  const ueComponents: JsonObject = {};
  for (const ue of state.ues) {
    const isCots = ue.type === "cots";
    const config: JsonObject = {
      gnbs: ue.gnbIds.map((id) => ranNames.get(id)).filter((name): name is string => Boolean(name)),
    };
    if (!isCots) config.ru = ruNames.get(ue.ruId);
    if (state.nrBand.trim()) config.nrBands = [Number(state.nrBand)];
    const supi =
      state.resourceSource !== "custom" && isCots
        ? (providerUes.get(ue.providerUeId)?.imsi ?? "")
        : ue.supi.trim();
    if (supi) config.supi = supi;
    ueComponents[ue.name.trim()] = { type: ue.type, config };
  }

  const ricComponents = state.ricEnabled
    ? buildRicComponents(options, state.ricImplementation)
    : {};

  const plan = builderPlacementPlan(state, options, catalogs);
  infrastructure.nodes = applyPlacementRoles(infrastructure.nodes, plan, state.placementMode);
  const assignments = new Map(plan.map((assignment) => [assignment.key, assignment]));

  const deploymentEntry = (key: string, type: string): JsonObject => {
    const assignment = assignments.get(key);
    return {
      type,
      ...(assignment?.strategy === "type-role" ? { force_type_scheduling: true } : {}),
      ...(assignment?.strategy === "node-name" ? { node_name: assignment.node } : {}),
    };
  };

  const coreDeploymentComponents = Object.fromEntries(
    Object.entries(coreComponents).map(([name, component]) => [
      name,
      deploymentEntry(
        placementKey("core", name),
        String(isObject(component) ? component.type : ""),
      ),
    ]),
  );
  const ricDeploymentComponents = Object.fromEntries(
    Object.entries(ricComponents).map(([name, component]) => [
      name,
      deploymentEntry(placementKey("ric", name), String(isObject(component) ? component.type : "")),
    ]),
  );
  const ranDeploymentComponents = Object.fromEntries(
    state.ranInstances.map((instance) => [
      instance.name.trim(),
      deploymentEntry(placementKey("ran", instance.id), instance.type),
    ]),
  );
  const ueDeployment: JsonObject = { ...infrastructure.ues };
  for (const ue of state.ues) {
    if (ue.type === "cots") continue;
    ueDeployment[ue.name.trim()] = {
      ...deploymentEntry(placementKey("ue", ue.id), ue.type),
      implementation: ue.implementation,
    };
  }

  const metamodel: JsonObject = {
    core: { components: coreComponents },
    ran: { components: ranComponents },
    rus: Object.fromEntries(
      state.rus.map((ru) => [
        ru.name.trim(),
        { type: ru.type, ...(ru.model ? { model: ru.model } : {}) },
      ]),
    ),
    ues: ueComponents,
    ric: { components: ricComponents },
  };

  const k8sParams: JsonObject = {};
  if (state.masterNode) {
    k8sParams.master_node = state.masterNode;
  }
  if (state.clusterName.trim()) {
    k8sParams.cluster_name = state.clusterName.trim();
  }

  const deploymentModel: JsonObject = {
    ...(Object.keys(k8sParams).length > 0 ? { params: { k8s: k8sParams } } : {}),
    ...(infrastructure.provisioners ? { provisioners: infrastructure.provisioners } : {}),
    nodes: infrastructure.nodes,
    core: {
      implementation: state.coreImplementation,
      components: coreDeploymentComponents,
    },
    ran: {
      implementation: state.ranImplementation,
      components: ranDeploymentComponents,
    },
    rus: infrastructure.rus,
    ues: ueDeployment,
    ric: {
      implementation: state.ricImplementation,
      components: ricDeploymentComponents,
    },
  };

  return {
    name: state.name.trim(),
    metamodel,
    deployment_model: deploymentModel,
  };
}

/**
 * Non-blocking observations. The models accept these combinations, but they are
 * usually mistakes for a real network.
 */
export function builderWarnings(
  state: DeploymentBuilderState,
  defaults: BuilderModelDefaults,
): string[] {
  const warnings: string[] = [];

  for (const ru of state.rus) {
    const users = ruUsers(ru.id, state.ranInstances, state.ues);
    const name = ru.name.trim() || "An RU";
    if (users.length === 0) {
      warnings.push(
        ru.type === "simulated"
          ? `${name} is not referenced by any gNB, DU, or UE.`
          : `${name} is not referenced by any gNB, DU, or UE but will still be provisioned.`,
      );
    } else if (ru.type !== "simulated" && users.length > 1) {
      warnings.push(
        `Physical RU ${name} is shared by ${users.join(", ")}. The model allows it, but one radio is normally driven by a single gNB/DU or UE.`,
      );
    }
  }

  for (const [field, scope] of Object.entries(IDENTITY_SCOPES) as Array<
    [IdentityField, string[]]
  >) {
    const holders = state.ranInstances.filter(
      (instance) =>
        scope.includes(instance.type) &&
        (IDENTITY_FIELDS_BY_TYPE[instance.type] ?? []).includes(field),
    );
    for (const [value, names] of groupBy(holders, (instance) =>
      String(effectiveIdentity(instance, field, defaults)),
    )) {
      if (names.length > 1) {
        warnings.push(
          `${IDENTITY_LABELS[field]} ${value} is used by ${names.map((instance) => instance.name.trim()).join(", ")}.`,
        );
      }
    }
  }

  for (const [supi, ues] of groupBy(state.ues, (ue) => effectiveSupi(ue, defaults))) {
    if (ues.length > 1) {
      warnings.push(
        `SUPI ${supi} is used by ${ues.map((ue) => ue.name.trim()).join(", ")}; subscribers are registered per SUPI.`,
      );
    }
  }

  return warnings;
}

export function schemaField(
  schema: JsonSchema,
  definitionName: string,
  propertyName: string,
): SchemaFieldInfo {
  const definition = schema.$defs?.[definitionName];
  const properties = isObject(definition?.properties) ? definition.properties : undefined;
  const field = isObject(properties?.[propertyName]) ? properties[propertyName] : undefined;
  return field
    ? {
        default: field.default,
        minimum: typeof field.minimum === "number" ? field.minimum : undefined,
        maximum: typeof field.maximum === "number" ? field.maximum : undefined,
        pattern: typeof field.pattern === "string" ? field.pattern : undefined,
      }
    : {};
}

function validateComponentChoices(
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): string[] {
  const errors: string[] = [];
  if (!options.core.implementations.includes(state.coreImplementation))
    errors.push("Choose a valid Core implementation.");
  if (!options.ran.implementations.includes(state.ranImplementation))
    errors.push("Choose a valid RAN implementation.");
  validateSelectedComponentTypes(
    "Core",
    state.coreComponentMode,
    state.coreComponentTypes,
    options.core.supported_components[state.coreImplementation] ?? [],
    errors,
  );
  if (state.ricEnabled && !options.ric.implementations.includes(state.ricImplementation))
    errors.push("Choose a valid RIC implementation.");

  errors.push(...validateRus(state, options, catalogs));
  errors.push(...validateRanInstances(state, options));
  errors.push(...validateUes(state, options, catalogs));
  return errors;
}

function validateRus(
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): string[] {
  const errors: string[] = [];
  const isProvider = state.resourceSource !== "custom";
  const inventoryRus = inventoryNames(state.resources, "ru");
  errors.push(
    ...duplicateNameErrors(
      "RU",
      state.rus.map((ru) => ru.name.trim()),
    ),
  );

  for (const [index, ru] of state.rus.entries()) {
    const name = ru.name.trim();
    const label = name || `RU ${index + 1}`;
    if (!options.ru.types.includes(ru.type)) {
      errors.push(`Choose a valid type for ${label}.`);
      continue;
    }
    const models = options.ru.models[ru.type] ?? [];
    if (models.length > 0 && !models.includes(ru.model)) {
      errors.push(`Choose a valid model for ${label}.`);
    }
    if (ru.type === "simulated") {
      if (!name) errors.push(`Give simulated RU ${index + 1} a name.`);
      else if (/\s/.test(name)) errors.push(`RU name ${name} cannot contain spaces.`);
    } else if (isProvider) {
      const providerRu = catalogs.r2lab.radio_units.find((radio) => radio.id === ru.providerRuId);
      if (
        !providerRu ||
        providerRu.type !== ru.type ||
        providerRu.model !== ru.model ||
        providerRu.id !== name
      ) {
        errors.push(`Choose an R2Lab radio unit from the provider catalog for ${label}.`);
      }
    } else if (!inventoryRus.includes(name)) {
      errors.push(`Choose RU hardware from the infrastructure inventory for ${label}.`);
    }
  }
  return errors;
}

function validateRanInstances(state: DeploymentBuilderState, options: OptionsResponse): string[] {
  const errors: string[] = [];
  const supported = options.ran.supported_components[state.ranImplementation] ?? [];
  const byId = new Map(state.ranInstances.map((instance) => [instance.id, instance]));
  const ruIds = new Set(state.rus.map((ru) => ru.id));
  const names = state.ranInstances.map((instance) => instance.name.trim());
  errors.push(...duplicateNameErrors("RAN component", names));
  errors.push(
    ...duplicateNameErrors(
      "RAN component Kubernetes",
      names.filter(Boolean).map(k8sSafeName),
      "differ only by case or '_' versus '-'; Helm release names would collide",
    ),
  );

  const hasAmf = selectedComponentTypes(
    state.coreComponentMode,
    state.coreComponentTypes,
    options.core.supported_components[state.coreImplementation] ?? [],
  ).includes("amf");

  for (const [index, instance] of state.ranInstances.entries()) {
    const name = instance.name.trim();
    const label = name || `RAN component ${index + 1}`;
    if (!name) errors.push(`Give RAN component ${index + 1} a name.`);
    else if (!COMPONENT_NAME_PATTERN.test(name)) {
      errors.push(
        `${name} must use letters, digits, '_' or '-', and start and end with a letter or digit.`,
      );
    }
    if (!supported.includes(instance.type)) {
      errors.push(
        `${label}: ${ranTypeLabel(instance.type)} is not supported by the ${state.ranImplementation} RAN.`,
      );
    }
    if (isRadioType(instance.type) && !ruIds.has(instance.ruId)) {
      errors.push(`Choose the RU used by ${label}.`);
    }
    if (instance.type === "du") {
      const cuCp = byId.get(instance.cuCpId);
      const cuUp = byId.get(instance.cuUpId);
      if (!cuCp || !["cu", "cu_cp"].includes(cuCp.type))
        errors.push(`Choose the CU or CU-CP that ${label} connects to over F1-C.`);
      if (!cuUp || !["cu", "cu_up"].includes(cuUp.type))
        errors.push(`Choose the CU or CU-UP that ${label} connects to over F1-U.`);
    }
    if (instance.type === "cu_up") {
      const cuCp = byId.get(instance.cuCpId);
      if (!cuCp || cuCp.type !== "cu_cp")
        errors.push(`Choose the CU-CP that ${label} connects to over E1.`);
    }
    if (["gnb", "cu", "cu_cp"].includes(instance.type) && !hasAmf) {
      errors.push(`${label} needs an AMF; include the AMF in the Core functions.`);
    }
    for (const field of IDENTITY_FIELDS_BY_TYPE[instance.type] ?? []) {
      const raw = instance.identity[field]?.trim();
      if (raw && !/^\d+$/.test(raw))
        errors.push(`${IDENTITY_LABELS[field]} of ${label} must be a whole number.`);
    }
  }
  return errors;
}

function validateUes(
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): string[] {
  const errors: string[] = [];
  const isProvider = state.resourceSource !== "custom";
  const inventoryUes = inventoryNames(state.resources, "ue");
  const radioIds = new Set(
    state.ranInstances
      .filter((instance) => isRadioType(instance.type))
      .map((instance) => instance.id),
  );
  const ruIds = new Set(state.rus.map((ru) => ru.id));
  const names = state.ues.map((ue) => ue.name.trim());
  errors.push(...duplicateNameErrors("UE", names));
  errors.push(
    ...duplicateNameErrors(
      "UE Kubernetes",
      state.ues
        .filter((ue) => ue.type !== "cots")
        .map((ue) => ue.name)
        .filter((name) => name.trim())
        .map(k8sSafeName),
      "differ only by case or '_' versus '-'; Helm release names would collide",
    ),
  );

  for (const [index, ue] of state.ues.entries()) {
    const name = ue.name.trim();
    const label = name || `UE ${index + 1}`;
    if (!options.ue.types.includes(ue.type)) {
      errors.push(`Choose a valid type for ${label}.`);
      continue;
    }
    if (ue.type === "cots") {
      if (isProvider) {
        if (
          !catalogs.r2lab.user_equipment.some(
            (candidate) => candidate.id === ue.providerUeId && candidate.id === name,
          )
        ) {
          errors.push(`Choose an R2Lab UE from the provider catalog for ${label}.`);
        }
      } else if (!inventoryUes.includes(name)) {
        errors.push(`Choose a COTS UE from the infrastructure inventory for ${label}.`);
      }
    } else {
      if (!name) errors.push(`Give containerized UE ${index + 1} a name.`);
      else if (!COMPONENT_NAME_PATTERN.test(name)) {
        errors.push(
          `${name} must use letters, digits, '_' or '-', and start and end with a letter or digit.`,
        );
      }
      if (!options.ue.implementations.includes(ue.implementation))
        errors.push(`Choose a valid implementation for ${label}.`);
      if (!ruIds.has(ue.ruId)) errors.push(`Choose the RU used by containerized UE ${label}.`);
    }
    // The orchestrator derives UE radio settings from gnbs[0], so at least one is required.
    if (ue.gnbIds.length === 0) errors.push(`Connect ${label} to at least one gNB or DU.`);
    if (ue.gnbIds.some((id) => !radioIds.has(id)))
      errors.push(`${label} references a gNB or DU that no longer exists.`);
    const supi = ue.supi.trim();
    if (supi && !(isProvider && ue.type === "cots") && !/^[0-9]{15}$/.test(supi)) {
      errors.push(`SUPI of ${label} must be 15 digits.`);
    }
  }
  return errors;
}

export function requiresR2LabHardware(state: DeploymentBuilderState): boolean {
  return (
    state.resourceSource !== "custom" &&
    (state.rus.some((ru) => ru.type !== "simulated") || state.ues.some((ue) => ue.type === "cots"))
  );
}

export function builderNodeNames(
  state: DeploymentBuilderState,
  catalogs: ProviderCatalogsResponse,
): string[] {
  if (state.resourceSource === "custom") {
    return state.resources.filter((resource) => resource.kind === "node").map(resourceName);
  }
  const catalogIds = new Set(catalogs.slices.sophianodes.map((node) => node.id));
  return unique([
    ...state.sophianodeIds.filter((id) => catalogIds.has(id)),
    ...(state.biEnabled ? state.biVmNames.map((name) => name.trim()).filter(Boolean) : []),
  ]);
}

export function builderPlacementTargets(
  state: DeploymentBuilderState,
  options: OptionsResponse,
): PlacementTarget[] {
  const isProvider = state.resourceSource !== "custom";
  const physicalRuIds = new Set(
    state.rus.filter((ru) => ru.type !== "simulated").map((ru) => ru.id),
  );
  const needsR2Lab = (ruId: string) => isProvider && physicalRuIds.has(ruId);

  const coreComponents = buildSelectedComponents(
    options.core.default_components,
    selectedComponentTypes(
      state.coreComponentMode,
      state.coreComponentTypes,
      options.core.supported_components[state.coreImplementation] ?? [],
    ),
  );
  const ricComponents = state.ricEnabled
    ? buildRicComponents(options, state.ricImplementation)
    : {};

  return [
    ...placementTargetsForComponents("core", coreComponents),
    ...state.ranInstances.map(
      (instance): PlacementTarget => ({
        key: placementKey("ran", instance.id),
        name: instance.name.trim(),
        label: `RAN · ${instance.name.trim() || "(unnamed)"} (${ranTypeLabel(instance.type)})`,
        category: "ran",
        type: instance.type,
        needsR2LabNode: isRadioType(instance.type) && needsR2Lab(instance.ruId),
      }),
    ),
    ...placementTargetsForComponents("ric", ricComponents),
    ...state.ues
      .filter((ue) => ue.type !== "cots")
      .map(
        (ue): PlacementTarget => ({
          key: placementKey("ue", ue.id),
          name: ue.name.trim(),
          label: `UE · ${ue.name.trim() || "(unnamed)"} (${ue.type})`,
          category: "ue",
          type: ue.type,
          needsR2LabNode: needsR2Lab(ue.ruId),
        }),
      ),
  ];
}

/** Resolve each placement target to a node and the scheduling mechanism used for it. */
export function builderPlacementPlan(
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): PlacementAssignment[] {
  const targets = builderPlacementTargets(state, options);
  if (state.placementMode === "simple") {
    return targets.map((target) => ({
      ...target,
      node: state.defaultPlacementNode,
      strategy: "category-role",
    }));
  }

  const nodeFor = (target: PlacementTarget) =>
    state.componentPlacements[target.key] ?? defaultNodeForTarget(state, catalogs, target);
  const nodesByType = new Map<string, Set<string>>();
  for (const target of targets) {
    const group = `${target.category}:${target.type}`;
    const nodes = nodesByType.get(group) ?? new Set<string>();
    nodes.add(nodeFor(target));
    nodesByType.set(group, nodes);
  }

  return targets.map((target) => {
    // UE types (containerized/cots) are not node roles, so UEs are always pinned by node_name.
    const sharedNode =
      target.category !== "ue" &&
      (nodesByType.get(`${target.category}:${target.type}`)?.size ?? 0) === 1;
    return {
      ...target,
      node: nodeFor(target),
      strategy: sharedNode ? "type-role" : "node-name",
    };
  });
}

/** Node suggested for a target before the user picks one explicitly. */
export function defaultNodeForTarget(
  state: DeploymentBuilderState,
  catalogs: ProviderCatalogsResponse,
  target: PlacementTarget,
): string {
  const nodes = builderNodeNames(state, catalogs);
  const candidates = target.needsR2LabNode
    ? nodes.filter((node) => catalogs.r2lab.required_sophianodes.includes(node))
    : nodes;
  return candidates.includes(state.defaultPlacementNode)
    ? state.defaultPlacementNode
    : (candidates[0] ?? "");
}

function validateProviderInfrastructure(
  state: DeploymentBuilderState,
  catalogs: ProviderCatalogsResponse,
): string[] {
  const errors: string[] = [];
  const needsRadioHost = requiresR2LabHardware(state);
  const availableIds = new Set(
    catalogs.slices.sophianodes.filter((node) => node.available).map((node) => node.id),
  );
  if (state.sophianodeIds.some((id) => !availableIds.has(id))) {
    errors.push("Choose only available SophiaNode servers.");
  }
  if (
    needsRadioHost &&
    !state.sophianodeIds.some((id) => catalogs.r2lab.required_sophianodes.includes(id))
  ) {
    errors.push(
      `Select at least one of ${catalogs.r2lab.required_sophianodes.join(", ")} for R2Lab radio hardware.`,
    );
  }
  if (state.biEnabled) {
    const vmNames = state.biVmNames.map((name) => name.trim());
    if (vmNames.length === 0 || vmNames.some((name) => !name)) {
      errors.push("Give every SLICES BI virtual machine a name.");
    }
    if (new Set(vmNames).size !== vmNames.length) {
      errors.push("SLICES BI virtual machine names must be unique.");
    }
    if (vmNames.some((name) => state.sophianodeIds.includes(name))) {
      errors.push("A BI virtual machine cannot reuse a selected SophiaNode name.");
    }
    for (const [label, value] of [
      ["infrastructure", state.biInfra],
      ["image", state.biImage],
      ["flavor", state.biFlavor],
      ["project", state.biProject],
      ["experiment", state.biExperiment],
      ["experiment duration", state.biExperimentDuration],
      ["node duration", state.biNodeDuration],
    ] satisfies Array<[string, string]>) {
      if (!value.trim()) errors.push(`Enter the BI ${label}.`);
    }
  }
  if (sophianodeNeedsSlicesUsername(state, catalogs) && !state.slicesUsername.trim()) {
    errors.push(
      "Enter your SLICES username: the selected SophiaNodes are reached through the POS jump host with it.",
    );
  }
  if (state.sophianodeIds.length === 0 && (!state.biEnabled || state.biVmNames.length === 0)) {
    errors.push("Select or define at least one infrastructure node.");
  }
  return errors;
}

function buildProviderInfrastructure(
  state: DeploymentBuilderState,
  catalogs: ProviderCatalogsResponse,
): { nodes: JsonObject; rus: JsonObject; ues: JsonObject; provisioners?: JsonObject } {
  const nodes: JsonObject = {};
  let provisioners: JsonObject | undefined;
  if (state.biEnabled) {
    for (const name of state.biVmNames.map((candidate) => candidate.trim()).filter(Boolean)) {
      nodes[name] = {
        category: "node",
        is_provisioned: false,
        provisioner: "bi",
        roles: [],
      };
    }
    provisioners = {
      bi: {
        type: catalogs.slices.bi.provisioner_type,
        params: {
          infra: state.biInfra,
          image: state.biImage,
          flavor: state.biFlavor,
          project: state.biProject,
          experiment: state.biExperiment,
          create_experiment: state.biCreateExperiment,
          experiment_duration: state.biExperimentDuration,
          node_duration: state.biNodeDuration,
        },
      },
    };
  }
  // Existing SophiaNode servers: nothing to provision, SSH path from the catalog.
  for (const sophianodeId of state.sophianodeIds) {
    const selected = catalogs.slices.sophianodes.find((node) => node.id === sophianodeId);
    nodes[sophianodeId] = {
      category: "node",
      is_provisioned: true,
      provisioner: null,
      roles: [],
      ...sophianodeSshInfo(selected, state.slicesUsername),
    };
  }

  // R2Lab RUs and COTS UEs are powered on, and their IPs/SSH info filled in, by the
  // orchestrator's r2lab provisioner. The backend configures that provisioner from the
  // signed-in R2Lab session at action time, so no credentials are part of this model.
  const rus: JsonObject = {};
  for (const ru of state.rus) {
    if (ru.type === "simulated") continue;
    rus[ru.name.trim()] = { category: "ru", is_provisioned: false, provisioner: "r2lab", ips: [] };
  }
  const ues: JsonObject = {};
  for (const ue of state.ues) {
    if (ue.type !== "cots") continue;
    ues[ue.name.trim()] = {
      category: "ue",
      type: "cots",
      is_provisioned: false,
      provisioner: "r2lab",
    };
  }
  return { nodes, rus, ues, provisioners };
}

export function sophianodeNeedsSlicesUsername(
  state: DeploymentBuilderState,
  catalogs: ProviderCatalogsResponse,
): boolean {
  return (
    state.resourceSource !== "custom" &&
    state.sophianodeIds.some(
      (id) =>
        catalogs.slices.sophianodes.find((node) => node.id === id)?.ssh?.jumphost?.user_from ===
        "slices_username",
    )
  );
}

function sophianodeSshInfo(
  node: ProviderCatalogsResponse["slices"]["sophianodes"][number] | undefined,
  slicesUsername: string,
): JsonObject {
  if (node?.ssh) {
    const jump = node.ssh.jumphost;
    return {
      ssh_info: {
        hostname: node.ssh.hostname,
        ...(jump
          ? {
              jumphost: {
                hostname: jump.hostname,
                ...(jump.port ? { port: jump.port } : {}),
                user: jump.user_from === "slices_username" ? slicesUsername.trim() : jump.user,
              },
            }
          : {}),
      },
    };
  }
  return node?.ssh_hostname ? { ssh_info: { hostname: node.ssh_hostname } } : {};
}

function validatePlacement(
  state: DeploymentBuilderState,
  options: OptionsResponse,
  catalogs: ProviderCatalogsResponse,
): string[] {
  const errors: string[] = [];
  const nodes = builderNodeNames(state, catalogs);
  const targets = builderPlacementTargets(state, options);
  if (nodes.length === 0) return ["Select at least one node before configuring placement."];

  if (state.placementMode === "simple") {
    if (!nodes.includes(state.defaultPlacementNode)) {
      errors.push("Choose a default placement node from the selected infrastructure.");
    }
    if (
      targets.some((target) => target.needsR2LabNode) &&
      !catalogs.r2lab.required_sophianodes.includes(state.defaultPlacementNode)
    ) {
      errors.push("The default node for R2Lab radio processing must be a compatible SophiaNode.");
    }
    return errors;
  }

  for (const target of targets) {
    const node = state.componentPlacements[target.key];
    if (!node || !nodes.includes(node)) {
      errors.push(`Choose a target node for ${target.label}.`);
      continue;
    }
    if (target.needsR2LabNode && !catalogs.r2lab.required_sophianodes.includes(node)) {
      errors.push(`${target.label} must use a compatible R2Lab SophiaNode.`);
    }
  }
  return errors;
}

function applyPlacementRoles(
  inputNodes: JsonObject,
  plan: PlacementAssignment[],
  mode: DeploymentBuilderState["placementMode"],
): JsonObject {
  const nodes = Object.fromEntries(
    Object.entries(inputNodes).map(([name, value]) => {
      const node = isObject(value) ? { ...value } : {};
      node.roles = Array.isArray(node.roles)
        ? node.roles.filter((role): role is string => typeof role === "string")
        : [];
      return [name, node];
    }),
  );

  if (mode === "explicit") {
    // A type label anywhere else would let force_type_scheduling pick another node.
    const scheduledTypes = new Set(
      plan
        .filter((assignment) => assignment.strategy === "type-role")
        .map((assignment) => assignment.type),
    );
    for (const node of Object.values(nodes)) {
      if (isObject(node) && Array.isArray(node.roles)) {
        node.roles = node.roles.filter((role) => !scheduledTypes.has(String(role)));
      }
    }
  }

  for (const assignment of plan) {
    const node = assignment.node ? nodes[assignment.node] : undefined;
    if (!isObject(node)) continue;
    const roles = Array.isArray(node.roles) ? node.roles.map(String) : [];
    // The category selector is always set by reconciliation, so even node_name pins need it.
    roles.push(assignment.category);
    if (assignment.strategy === "type-role") {
      roles.push(assignment.type);
    }
    node.roles = unique(roles);
  }
  return nodes;
}

function placementTargetsForComponents(
  category: "core" | "ric",
  components: JsonObject,
): PlacementTarget[] {
  return Object.entries(components).flatMap(([name, component]) => {
    if (!isObject(component) || typeof component.type !== "string") return [];
    return [
      {
        key: placementKey(category, name),
        name,
        label: `${category.toUpperCase()} · ${name} (${component.type})`,
        category,
        type: component.type,
        needsR2LabNode: false,
      },
    ];
  });
}

function buildDefaultComponents(
  defaults: Record<string, ModelComponentDefault>,
  supportedTypes: string[],
): JsonObject {
  return Object.fromEntries(
    Object.entries(defaults)
      .filter(([, component]) => supportedTypes.includes(component.type))
      .map(([name, component]) => [name, { type: component.type }]),
  );
}

function selectedComponentTypes(
  mode: "all" | "selected",
  selectedTypes: string[],
  supportedTypes: string[],
): string[] {
  return mode === "all" ? supportedTypes : selectedTypes;
}

function buildSelectedComponents(
  defaults: Record<string, ModelComponentDefault>,
  selectedTypes: string[],
): JsonObject {
  return Object.fromEntries(
    selectedTypes.map((type) => {
      const defaultEntry = Object.entries(defaults).find(
        ([, component]) => component.type === type,
      );
      return [defaultEntry?.[0] ?? type, { type }];
    }),
  );
}

function validateSelectedComponentTypes(
  label: string,
  mode: "all" | "selected",
  selectedTypes: string[],
  supportedTypes: string[],
  errors: string[],
): void {
  if (mode === "selected" && selectedTypes.length === 0) {
    errors.push(`Choose at least one ${label} function.`);
  }
  if (mode === "selected" && selectedTypes.some((type) => !supportedTypes.includes(type))) {
    errors.push(`Choose only ${label} functions supported by the selected implementation.`);
  }
}

function buildRicComponents(options: OptionsResponse, implementation: string): JsonObject {
  const supportedTypes = options.ric.supported_components[implementation] ?? [];
  const defaultComponents = buildDefaultComponents(options.ric.default_components, supportedTypes);
  if (Object.keys(defaultComponents).length > 0) {
    return defaultComponents;
  }
  return Object.fromEntries(supportedTypes.map((type) => [type, { type }]));
}

function duplicateNameErrors(label: string, names: string[], reason = "must be unique"): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates].map((name) => `${label} names ${reason}: ${name}.`);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return groups;
}

export function inventoryNames(
  resources: CustomResourceDraft[],
  kind: CustomResourceDraft["kind"],
): string[] {
  return resources
    .filter((resource) => resource.kind === kind)
    .map(resourceName)
    .filter(Boolean);
}

function resourceName(resource: CustomResourceDraft): string {
  return resource.name.trim();
}

function setNumberIfPresent(target: JsonObject, key: string, rawValue: string): void {
  if (!rawValue.trim()) return;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`);
  }
  target[key] = value;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
