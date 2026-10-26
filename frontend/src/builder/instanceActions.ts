import type { OptionsResponse, ProviderCatalogsResponse } from "../api/types";
import {
  builderNodeNames,
  builderPlacementTargets,
  defaultNodeForTarget,
  inventoryNames,
  requiresR2LabHardware,
  type DeploymentBuilderState,
} from "./deploymentBuilder";
import {
  createRanInstance,
  createRuInstance,
  createUeInstance,
  fillMissingReferences,
  nextInstanceName,
  type BuilderModelDefaults,
  type RanInstance,
  type RuInstance,
  type UeInstance,
} from "./instances";

export interface BuilderContext {
  options: OptionsResponse;
  catalogs: ProviderCatalogsResponse;
  defaults: BuilderModelDefaults;
}

type Patch = Partial<DeploymentBuilderState>;

/**
 * Complete a patch: repair dangling references, make sure R2Lab hardware has a compatible
 * SophiaNode, and give explicit placement a node for every new instance.
 */
export function finalizePatch(
  state: DeploymentBuilderState,
  ctx: BuilderContext,
  patch: Patch,
  editedUeId?: string,
): Patch {
  let next: DeploymentBuilderState = { ...state, ...patch };
  next = { ...next, ...fillMissingReferences(next.rus, next.ranInstances, next.ues, editedUeId) };
  next = { ...next, ...r2labNodePatch(next, ctx) };
  next = { ...next, componentPlacements: syncPlacements(next, ctx) };
  return {
    ...patch,
    ranInstances: next.ranInstances,
    ues: next.ues,
    sophianodeIds: next.sophianodeIds,
    defaultPlacementNode: next.defaultPlacementNode,
    componentPlacements: next.componentPlacements,
  };
}

/** Explicit placements for the current targets; keeps valid choices, fills the rest. */
export function syncPlacements(state: DeploymentBuilderState, ctx: BuilderContext): Record<string, string> {
  if (state.placementMode !== "explicit") return state.componentPlacements;
  const nodes = builderNodeNames(state, ctx.catalogs);
  const compatible = ctx.catalogs.r2lab.required_sophianodes;
  const placements: Record<string, string> = {};
  for (const target of builderPlacementTargets(state, ctx.options)) {
    const current = state.componentPlacements[target.key];
    const valid = current && nodes.includes(current) && (!target.needsR2LabNode || compatible.includes(current));
    placements[target.key] = valid ? current : defaultNodeForTarget(state, ctx.catalogs, target);
  }
  return placements;
}

function r2labNodePatch(state: DeploymentBuilderState, ctx: BuilderContext): Patch {
  if (!requiresR2LabHardware(state)) return {};
  const required = ctx.catalogs.r2lab.required_sophianodes;
  const server = state.sophianodeIds.find((id) => required.includes(id)) ?? required[0];
  if (!server) return {};
  const sophianodeIds = state.sophianodeIds.includes(server) ? state.sophianodeIds : [...state.sophianodeIds, server];
  const radioTargets = builderPlacementTargets({ ...state, sophianodeIds }, ctx.options).some((target) => target.needsR2LabNode);
  const moveDefault = state.placementMode === "simple" && radioTargets && !required.includes(state.defaultPlacementNode);
  return { sophianodeIds, ...(moveDefault ? { defaultPlacementNode: server } : {}) };
}

// ---- Radio units -------------------------------------------------------------------

export function addRu(state: DeploymentBuilderState, ctx: BuilderContext): Patch {
  const type = ctx.options.ru.types.includes("simulated") ? "simulated" : ctx.options.ru.types[0] ?? "";
  const ru = createRuInstance(nextInstanceName("ru", state.rus.map((candidate) => candidate.name)), type);
  const rus = [...state.rus, type === "simulated" ? ru : retypedRu(state, ctx, ru, type)];
  return finalizePatch(state, ctx, { rus });
}

export function updateRu(state: DeploymentBuilderState, ctx: BuilderContext, id: string, patch: Partial<RuInstance>): Patch {
  return finalizePatch(state, ctx, { rus: state.rus.map((ru) => (ru.id === id ? { ...ru, ...patch } : ru)) });
}

export function changeRuType(state: DeploymentBuilderState, ctx: BuilderContext, id: string, type: string): Patch {
  return finalizePatch(state, ctx, {
    rus: state.rus.map((ru) => (ru.id === id ? retypedRu(state, ctx, ru, type) : ru)),
  });
}

export function selectProviderRu(state: DeploymentBuilderState, ctx: BuilderContext, id: string, providerRuId: string): Patch {
  const radio = ctx.catalogs.r2lab.radio_units.find((candidate) => candidate.id === providerRuId);
  if (!radio) return {};
  return updateRu(state, ctx, id, { providerRuId: radio.id, name: radio.id, type: radio.type, model: radio.model });
}

export function removeRu(state: DeploymentBuilderState, ctx: BuilderContext, id: string): Patch {
  return finalizePatch(state, ctx, {
    rus: state.rus.filter((ru) => ru.id !== id),
    ranInstances: state.ranInstances.map((instance) => (instance.ruId === id ? { ...instance, ruId: "" } : instance)),
    ues: state.ues.map((ue) => (ue.ruId === id ? { ...ue, ruId: "" } : ue)),
  });
}

function retypedRu(state: DeploymentBuilderState, ctx: BuilderContext, ru: RuInstance, type: string): RuInstance {
  const others = state.rus.filter((candidate) => candidate.id !== ru.id);
  const models = ctx.options.ru.models[type] ?? [];
  if (type === "simulated") {
    const name = ru.type === "simulated" ? ru.name : nextInstanceName("ru", others.map((candidate) => candidate.name));
    return { ...ru, type, model: "", providerRuId: "", name };
  }
  if (state.resourceSource !== "custom") {
    const usedProviderIds = new Set(others.map((candidate) => candidate.providerRuId));
    const catalog = ctx.catalogs.r2lab.radio_units.filter((radio) => radio.type === type);
    const radio = catalog.find((candidate) => !usedProviderIds.has(candidate.id)) ?? catalog[0];
    return { ...ru, type, model: radio?.model ?? models[0] ?? "", providerRuId: radio?.id ?? "", name: radio?.id ?? "" };
  }
  const usedNames = new Set(others.map((candidate) => candidate.name.trim()));
  const inventory = inventoryNames(state.resources, "ru");
  const name = inventory.find((candidate) => !usedNames.has(candidate)) ?? "";
  return { ...ru, type, model: models.includes(ru.model) ? ru.model : models[0] ?? "", providerRuId: "", name };
}

// ---- RAN components ----------------------------------------------------------------

export function addRanInstance(state: DeploymentBuilderState, ctx: BuilderContext, type: string): Patch {
  const name = nextInstanceName(type, state.ranInstances.map((instance) => instance.name));
  const instance = createRanInstance(name, type, state.ranInstances, ctx.defaults);
  return finalizePatch(state, ctx, { ranInstances: [...state.ranInstances, instance] });
}

export function updateRanInstance(
  state: DeploymentBuilderState,
  ctx: BuilderContext,
  id: string,
  patch: Partial<RanInstance>,
): Patch {
  return finalizePatch(state, ctx, {
    ranInstances: state.ranInstances.map((instance) => (instance.id === id ? { ...instance, ...patch } : instance)),
  });
}

export function removeRanInstance(state: DeploymentBuilderState, ctx: BuilderContext, id: string): Patch {
  return finalizePatch(state, ctx, {
    ranInstances: state.ranInstances
      .filter((instance) => instance.id !== id)
      .map((instance) => ({
        ...instance,
        cuCpId: instance.cuCpId === id ? "" : instance.cuCpId,
        cuUpId: instance.cuUpId === id ? "" : instance.cuUpId,
      })),
    ues: state.ues.map((ue) => ({ ...ue, gnbIds: ue.gnbIds.filter((gnbId) => gnbId !== id) })),
  });
}

// ---- User equipment ----------------------------------------------------------------

export function addUe(state: DeploymentBuilderState, ctx: BuilderContext): Patch {
  const defaultType = Object.values(ctx.options.ue.default_components)[0]?.type ?? ctx.options.ue.types[0] ?? "";
  const ue = createUeInstance(
    nextInstanceName("ue", state.ues.map((candidate) => candidate.name)),
    defaultType,
    ctx.options.ue.default_implementation,
    state.ues,
    ctx.defaults,
  );
  const ues = [...state.ues, defaultType === "cots" ? retypedUe(state, ctx, ue, defaultType) : ue];
  return finalizePatch(state, ctx, { ues });
}

export function updateUe(state: DeploymentBuilderState, ctx: BuilderContext, id: string, patch: Partial<UeInstance>): Patch {
  return finalizePatch(
    state,
    ctx,
    { ues: state.ues.map((ue) => (ue.id === id ? { ...ue, ...patch } : ue)) },
    "gnbIds" in patch ? id : undefined,
  );
}

export function changeUeType(state: DeploymentBuilderState, ctx: BuilderContext, id: string, type: string): Patch {
  return finalizePatch(state, ctx, {
    ues: state.ues.map((ue) => (ue.id === id ? retypedUe(state, ctx, ue, type) : ue)),
  });
}

export function selectProviderUe(state: DeploymentBuilderState, ctx: BuilderContext, id: string, providerUeId: string): Patch {
  const providerUe = ctx.catalogs.r2lab.user_equipment.find((candidate) => candidate.id === providerUeId);
  if (!providerUe) return {};
  return updateUe(state, ctx, id, { providerUeId: providerUe.id, name: providerUe.id, supi: providerUe.imsi });
}

export function removeUe(state: DeploymentBuilderState, ctx: BuilderContext, id: string): Patch {
  return finalizePatch(state, ctx, { ues: state.ues.filter((ue) => ue.id !== id) });
}

function retypedUe(state: DeploymentBuilderState, ctx: BuilderContext, ue: UeInstance, type: string): UeInstance {
  const others = state.ues.filter((candidate) => candidate.id !== ue.id);
  if (type === "cots") {
    if (state.resourceSource !== "custom") {
      const used = new Set(others.map((candidate) => candidate.providerUeId));
      const catalog = ctx.catalogs.r2lab.user_equipment;
      const providerUe = catalog.find((candidate) => !used.has(candidate.id)) ?? catalog[0];
      return { ...ue, type, providerUeId: providerUe?.id ?? "", name: providerUe?.id ?? "", supi: providerUe?.imsi ?? "", ruId: "" };
    }
    const usedNames = new Set(others.map((candidate) => candidate.name.trim()));
    const name = inventoryNames(state.resources, "ue").find((candidate) => !usedNames.has(candidate)) ?? "";
    return { ...ue, type, providerUeId: "", name, ruId: "" };
  }
  if (ue.type !== "cots") return { ...ue, type };
  // Leaving a COTS UE: its name and SUPI belonged to the hardware, so suggest fresh ones.
  const fresh = createUeInstance(
    nextInstanceName("ue", others.map((candidate) => candidate.name)),
    type,
    ue.implementation || ctx.options.ue.default_implementation,
    others,
    ctx.defaults,
  );
  return { ...ue, type, name: fresh.name, supi: fresh.supi, providerUeId: "", implementation: fresh.implementation };
}
