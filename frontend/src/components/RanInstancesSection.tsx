import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CellTowerRoundedIcon from "@mui/icons-material/CellTowerRounded";
import { Alert, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";

import type { DeploymentBuilderState } from "../builder/deploymentBuilder";
import {
  addRanInstance,
  removeRanInstance,
  updateRanInstance,
  type BuilderContext,
} from "../builder/instanceActions";
import {
  COMPONENT_NAME_PATTERN,
  IDENTITY_FIELDS_BY_TYPE,
  IDENTITY_LABELS,
  isRadioType,
  k8sSafeName,
  ranTypeLabel,
  type RanInstance,
} from "../builder/instances";
import InstanceCard, { InstanceSectionHeader } from "./InstanceCard";

interface RanInstancesSectionProps {
  ctx: BuilderContext;
  state: DeploymentBuilderState;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

export default function RanInstancesSection({ ctx, state, disabled = false, onChange }: RanInstancesSectionProps) {
  const supportedTypes = ctx.options.ran.supported_components[state.ranImplementation] ?? [];
  const instances = state.ranInstances;
  const ofTypes = (types: string[]) => instances.filter((instance) => types.includes(instance.type));

  function update(id: string, patch: Partial<RanInstance>) {
    onChange(updateRanInstance(state, ctx, id, patch));
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: "#fbfcfa" }}>
      <InstanceSectionHeader
        icon={<CellTowerRoundedIcon />}
        title="RAN components"
        count={instances.length}
        description={`MetaModel.ran.components, keyed by name. Types offered by ${state.ranImplementation}.`}
        actions={supportedTypes.map((type) => (
          <Button
            key={type}
            size="small"
            variant="outlined"
            startIcon={<AddRoundedIcon />}
            onClick={() => onChange(addRanInstance(state, ctx, type))}
            disabled={disabled}
          >
            {ranTypeLabel(type)}
          </Button>
        ))}
      />

      <Stack spacing={1.5}>
        {instances.length === 0 && (
          <Typography variant="body2" color="text.secondary">No RAN components. Add a gNB, or a CU/DU split.</Typography>
        )}
        {instances.map((instance, index) => {
          const name = instance.name.trim();
          const duplicate = instances.some((other) => other.id !== instance.id && k8sSafeName(other.name) === k8sSafeName(instance.name));
          const nameInvalid = !name || !COMPONENT_NAME_PATTERN.test(name) || duplicate;
          const servedUes = state.ues.filter((ue) => ue.gnbIds.includes(instance.id)).map((ue) => ue.name.trim() || "(unnamed)");
          const cuCpTargets = instance.type === "du" ? ofTypes(["cu", "cu_cp"]) : ofTypes(["cu_cp"]);
          const cuUpTargets = ofTypes(["cu", "cu_up"]);
          return (
            <InstanceCard
              key={instance.id}
              title={name || `RAN component ${index + 1}`}
              chips={(
                <>
                  <Chip size="small" variant="outlined" label={ranTypeLabel(instance.type)} />
                  {isRadioType(instance.type) && servedUes.length > 0 && (
                    <Chip size="small" color="primary" variant="outlined" label={`serves ${servedUes.join(", ")}`} />
                  )}
                </>
              )}
              removeLabel={`Remove ${name || "RAN component"}`}
              onRemove={() => onChange(removeRanInstance(state, ctx, instance.id))}
              disabled={disabled}
            >
              {!supportedTypes.includes(instance.type) && (
                <Alert severity="error" variant="outlined" sx={{ gridColumn: "1 / -1" }}>
                  {ranTypeLabel(instance.type)} is not supported by the {state.ranImplementation} RAN. Remove it or change the implementation.
                </Alert>
              )}

              <TextField
                label="Component name"
                value={instance.name}
                onChange={(event) => update(instance.id, { name: event.target.value })}
                helperText={duplicate ? "Another RAN component maps to the same Helm release name." : "MetaModel and DeploymentModel key."}
                error={nameInvalid}
                disabled={disabled}
              />

              {isRadioType(instance.type) && (
                <ReferenceSelect
                  label="Radio unit"
                  value={instance.ruId}
                  choices={state.rus.map((ru) => ({
                    id: ru.id,
                    label: `${ru.name.trim() || "(unnamed)"} · ${ru.type}${ru.model ? ` ${ru.model}` : ""}`,
                  }))}
                  helperText="config.ru"
                  emptyText="Add an RU first"
                  disabled={disabled}
                  onChange={(ruId) => update(instance.id, { ruId })}
                />
              )}

              {(instance.type === "du" || instance.type === "cu_up") && (
                <ReferenceSelect
                  label={instance.type === "du" ? "CU / CU-CP (F1-C)" : "CU-CP (E1)"}
                  value={instance.cuCpId}
                  choices={cuCpTargets.map((target) => ({
                    id: target.id,
                    label: `${target.name.trim() || "(unnamed)"} · ${ranTypeLabel(target.type)}`,
                  }))}
                  helperText="config.cu_cp"
                  emptyText={instance.type === "du" ? "Add a CU or CU-CP" : "Add a CU-CP"}
                  disabled={disabled}
                  onChange={(cuCpId) => {
                    const target = instances.find((candidate) => candidate.id === cuCpId);
                    // A combined CU serves both planes; keep F1-U on the same CU by default.
                    update(instance.id, target?.type === "cu" && instance.type === "du" ? { cuCpId, cuUpId: cuCpId } : { cuCpId });
                  }}
                />
              )}

              {instance.type === "du" && (
                <ReferenceSelect
                  label="CU / CU-UP (F1-U)"
                  value={instance.cuUpId}
                  choices={cuUpTargets.map((target) => ({
                    id: target.id,
                    label: `${target.name.trim() || "(unnamed)"} · ${ranTypeLabel(target.type)}`,
                  }))}
                  helperText="config.cu_up"
                  emptyText="Add a CU or CU-UP"
                  disabled={disabled}
                  onChange={(cuUpId) => update(instance.id, { cuUpId })}
                />
              )}

              {(IDENTITY_FIELDS_BY_TYPE[instance.type] ?? []).map((field) => {
                const info = ctx.defaults.identity[field];
                const raw = instance.identity[field] ?? "";
                return (
                  <TextField
                    key={field}
                    label={IDENTITY_LABELS[field]}
                    type="number"
                    value={raw}
                    placeholder={String(info.default)}
                    onChange={(event) => update(instance.id, { identity: { ...instance.identity, [field]: event.target.value } })}
                    helperText={`config.${field} · empty = model default ${info.default}`}
                    error={Boolean(raw.trim()) && !/^\d+$/.test(raw.trim())}
                    disabled={disabled}
                    slotProps={{ htmlInput: { min: info.minimum, max: info.maximum } }}
                  />
                );
              })}
            </InstanceCard>
          );
        })}
      </Stack>
    </Paper>
  );
}

interface ReferenceSelectProps {
  label: string;
  value: string;
  choices: Array<{ id: string; label: string }>;
  helperText: string;
  emptyText: string;
  disabled: boolean;
  onChange: (id: string) => void;
}

function ReferenceSelect({ label, value, choices, helperText, emptyText, disabled, onChange }: ReferenceSelectProps) {
  const valid = choices.some((choice) => choice.id === value);
  return (
    <TextField
      select
      label={label}
      value={valid ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      helperText={choices.length === 0 ? emptyText : helperText}
      error={!valid}
      disabled={disabled || choices.length === 0}
    >
      {choices.map((choice) => <MenuItem key={choice.id} value={choice.id}>{choice.label}</MenuItem>)}
    </TextField>
  );
}
