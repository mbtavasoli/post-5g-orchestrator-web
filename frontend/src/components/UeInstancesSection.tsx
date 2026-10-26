import AddRoundedIcon from "@mui/icons-material/AddRounded";
import SmartphoneRoundedIcon from "@mui/icons-material/SmartphoneRounded";
import { Alert, Autocomplete, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";

import { inventoryNames, type DeploymentBuilderState } from "../builder/deploymentBuilder";
import {
  addUe,
  changeUeType,
  removeUe,
  selectProviderUe,
  updateUe,
  type BuilderContext,
} from "../builder/instanceActions";
import { COMPONENT_NAME_PATTERN, isRadioType, k8sSafeName, ranTypeLabel } from "../builder/instances";
import InstanceCard, { InstanceSectionHeader } from "./InstanceCard";

interface UeInstancesSectionProps {
  ctx: BuilderContext;
  state: DeploymentBuilderState;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

export default function UeInstancesSection({ ctx, state, disabled = false, onChange }: UeInstancesSectionProps) {
  const { options, catalogs, defaults } = ctx;
  const isProvider = state.resourceSource !== "custom";
  const inventory = inventoryNames(state.resources, "ue");
  const radios = state.ranInstances.filter((instance) => isRadioType(instance.type));
  const radioLabel = (id: string) => {
    const radio = radios.find((candidate) => candidate.id === id);
    return radio ? `${radio.name.trim() || "(unnamed)"} · ${ranTypeLabel(radio.type)}` : "(removed)";
  };

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: "#fbfcfa" }}>
      <InstanceSectionHeader
        icon={<SmartphoneRoundedIcon />}
        title="User equipment"
        count={state.ues.length}
        description="MetaModel.ues, keyed by name. config.gnbs lists one or more gNBs/DUs; the first one sets the UE radio parameters."
        actions={(
          <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => onChange(addUe(state, ctx))} disabled={disabled}>
            Add UE
          </Button>
        )}
      />

      <Stack spacing={1.5}>
        {state.ues.length === 0 && (
          <Typography variant="body2" color="text.secondary">No UEs. MetaModel.ues will be sent empty.</Typography>
        )}
        {state.ues.map((ue, index) => {
          const isCots = ue.type === "cots";
          const name = ue.name.trim();
          const takenNames = new Set(state.ues.filter((other) => other.id !== ue.id).map((other) => other.name.trim()));
          const duplicate = !isCots && state.ues.some((other) => (
            other.id !== ue.id && other.type !== "cots" && k8sSafeName(other.name) === k8sSafeName(ue.name)
          ));
          const supiLocked = isProvider && isCots;
          const supiInvalid = Boolean(ue.supi.trim()) && !supiLocked && !/^[0-9]{15}$/.test(ue.supi.trim());
          return (
            <InstanceCard
              key={ue.id}
              title={name || `UE ${index + 1}`}
              chips={<Chip size="small" variant="outlined" label={ue.type} />}
              removeLabel={`Remove ${name || "UE"}`}
              onRemove={() => onChange(removeUe(state, ctx, ue.id))}
              disabled={disabled}
            >
              <TextField
                select
                label="UE type"
                value={ue.type}
                onChange={(event) => onChange(changeUeType(state, ctx, ue.id, event.target.value))}
                helperText="Containerized UEs are pods; COTS UEs are provisioned hardware."
                disabled={disabled}
              >
                {options.ue.types.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
              </TextField>

              {isCots ? (
                isProvider ? (
                  <TextField
                    select
                    label="R2Lab UE"
                    value={catalogs.r2lab.user_equipment.some((candidate) => candidate.id === ue.providerUeId) ? ue.providerUeId : ""}
                    onChange={(event) => onChange(selectProviderUe(state, ctx, ue.id, event.target.value))}
                    helperText="The catalog IMSI becomes config.supi."
                    error={!ue.providerUeId}
                    disabled={disabled}
                  >
                    {catalogs.r2lab.user_equipment.map((candidate) => (
                      <MenuItem key={candidate.id} value={candidate.id} disabled={takenNames.has(candidate.id)}>
                        {candidate.label} · {candidate.imsi}
                      </MenuItem>
                    ))}
                  </TextField>
                ) : inventory.length > 0 ? (
                  <TextField
                    select
                    label="COTS UE resource"
                    value={inventory.includes(name) ? name : ""}
                    onChange={(event) => onChange(updateUe(state, ctx, ue.id, { name: event.target.value }))}
                    helperText="Uses the matching DeploymentModel.ues inventory entry."
                    error={!inventory.includes(name)}
                    disabled={disabled}
                  >
                    {inventory.map((candidate) => (
                      <MenuItem key={candidate} value={candidate} disabled={takenNames.has(candidate)}>{candidate}</MenuItem>
                    ))}
                  </TextField>
                ) : (
                  <Alert severity="warning" variant="outlined">Add a COTS UE in Infrastructure first.</Alert>
                )
              ) : (
                <TextField
                  label="UE name"
                  value={ue.name}
                  onChange={(event) => onChange(updateUe(state, ctx, ue.id, { name: event.target.value }))}
                  helperText={duplicate ? "Another UE maps to the same Helm release name." : "MetaModel and DeploymentModel key."}
                  error={!name || !COMPONENT_NAME_PATTERN.test(name) || takenNames.has(name) || duplicate}
                  disabled={disabled}
                />
              )}

              {!isCots && (
                <TextField
                  select
                  label="UE implementation"
                  value={options.ue.implementations.includes(ue.implementation) ? ue.implementation : ""}
                  onChange={(event) => onChange(updateUe(state, ctx, ue.id, { implementation: event.target.value }))}
                  helperText="DeploymentModel.ues[name].implementation"
                  disabled={disabled}
                >
                  {options.ue.implementations.map((implementation) => (
                    <MenuItem key={implementation} value={implementation}>{implementation}</MenuItem>
                  ))}
                </TextField>
              )}

              <Autocomplete
                multiple
                options={radios.map((radio) => radio.id)}
                value={ue.gnbIds}
                getOptionLabel={radioLabel}
                onChange={(_, gnbIds) => onChange(updateUe(state, ctx, ue.id, { gnbIds }))}
                disabled={disabled}
                filterSelectedOptions
                sx={{ gridColumn: { sm: "span 2", lg: isCots ? "span 2" : "span 1" } }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="gNBs / DUs"
                    helperText={radios.length === 0 ? "Add a gNB or DU first." : "config.gnbs (in order)"}
                    error={ue.gnbIds.length === 0}
                  />
                )}
              />

              {!isCots && (
                <TextField
                  select
                  label="UE radio unit"
                  value={state.rus.some((ru) => ru.id === ue.ruId) ? ue.ruId : ""}
                  onChange={(event) => onChange(updateUe(state, ctx, ue.id, { ruId: event.target.value }))}
                  helperText={state.rus.length === 0 ? "Add an RU first." : "config.ru (the UE's own front-end)"}
                  error={!state.rus.some((ru) => ru.id === ue.ruId)}
                  disabled={disabled || state.rus.length === 0}
                >
                  {state.rus.map((ru) => (
                    <MenuItem key={ru.id} value={ru.id}>{ru.name.trim() || "(unnamed)"} · {ru.type}</MenuItem>
                  ))}
                </TextField>
              )}

              <TextField
                label="SUPI"
                value={ue.supi}
                placeholder={defaults.supi.default}
                onChange={(event) => onChange(updateUe(state, ctx, ue.id, { supi: event.target.value }))}
                helperText={supiLocked ? "Taken from the R2Lab catalog." : `config.supi · empty = model default ${defaults.supi.default}`}
                error={supiInvalid}
                disabled={disabled || supiLocked}
                slotProps={{ htmlInput: { pattern: defaults.supi.pattern, inputMode: "numeric" } }}
              />
            </InstanceCard>
          );
        })}
      </Stack>
    </Paper>
  );
}
