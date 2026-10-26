import AddRoundedIcon from "@mui/icons-material/AddRounded";
import SettingsInputAntennaRoundedIcon from "@mui/icons-material/SettingsInputAntennaRounded";
import { Alert, Button, Chip, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";

import { inventoryNames, type DeploymentBuilderState } from "../builder/deploymentBuilder";
import {
  addRu,
  changeRuType,
  removeRu,
  selectProviderRu,
  updateRu,
  type BuilderContext,
} from "../builder/instanceActions";
import { ruUsers } from "../builder/instances";
import InstanceCard, { InstanceSectionHeader } from "./InstanceCard";

interface RadioUnitsSectionProps {
  ctx: BuilderContext;
  state: DeploymentBuilderState;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

export default function RadioUnitsSection({ ctx, state, disabled = false, onChange }: RadioUnitsSectionProps) {
  const { options, catalogs } = ctx;
  const isProvider = state.resourceSource !== "custom";
  const inventory = inventoryNames(state.resources, "ru");

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: "#fbfcfa" }}>
      <InstanceSectionHeader
        icon={<SettingsInputAntennaRoundedIcon />}
        title="Radio units"
        count={state.rus.length}
        description="MetaModel.rus, keyed by name. Each gNB/DU references exactly one RU; containerized UEs reference their own."
        actions={(
          <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => onChange(addRu(state, ctx))} disabled={disabled}>
            Add RU
          </Button>
        )}
      />

      <Stack spacing={1.5}>
        {state.rus.length === 0 && (
          <Typography variant="body2" color="text.secondary">No radio units. gNBs, DUs, and containerized UEs need one.</Typography>
        )}
        {state.rus.map((ru, index) => {
          const isSimulated = ru.type === "simulated";
          const models = options.ru.models[ru.type] ?? [];
          const users = ruUsers(ru.id, state.ranInstances, state.ues);
          const takenNames = new Set(state.rus.filter((other) => other.id !== ru.id).map((other) => other.name.trim()));
          const catalogRus = catalogs.r2lab.radio_units.filter((radio) => radio.type === ru.type);
          return (
            <InstanceCard
              key={ru.id}
              title={ru.name.trim() || `RU ${index + 1}`}
              chips={(
                <>
                  <Chip size="small" variant="outlined" label={isSimulated ? "simulated" : `${ru.type}${ru.model ? ` · ${ru.model}` : ""}`} />
                  {users.length > 0
                    ? <Chip size="small" color="primary" variant="outlined" label={`used by ${users.join(", ")}`} />
                    : <Chip size="small" color="warning" variant="outlined" label="unreferenced" />}
                </>
              )}
              removeLabel={`Remove ${ru.name.trim() || "RU"}`}
              onRemove={() => onChange(removeRu(state, ctx, ru.id))}
              disabled={disabled}
            >
              <TextField
                select
                label="RU type"
                value={ru.type}
                onChange={(event) => onChange(changeRuType(state, ctx, ru.id, event.target.value))}
                helperText="MetaModel.rus[name].type"
                disabled={disabled}
              >
                {options.ru.types.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
              </TextField>

              {!isSimulated && isProvider ? (
                <TextField
                  select
                  label="R2Lab radio unit"
                  value={catalogRus.some((radio) => radio.id === ru.providerRuId) ? ru.providerRuId : ""}
                  onChange={(event) => onChange(selectProviderRu(state, ctx, ru.id, event.target.value))}
                  helperText="Name, type, and model come from the provider catalog."
                  error={!ru.providerRuId}
                  disabled={disabled}
                  sx={{ gridColumn: { lg: "span 2" } }}
                >
                  {catalogRus.map((radio) => (
                    <MenuItem key={radio.id} value={radio.id} disabled={takenNames.has(radio.id)}>{radio.label}</MenuItem>
                  ))}
                </TextField>
              ) : (
                <>
                  {models.length > 0 ? (
                    <TextField
                      select
                      label="RU model"
                      value={models.includes(ru.model) ? ru.model : ""}
                      onChange={(event) => onChange(updateRu(state, ctx, ru.id, { model: event.target.value }))}
                      helperText="Model catalog for the selected RU type."
                      disabled={disabled}
                    >
                      {models.map((model) => <MenuItem key={model} value={model}>{model}</MenuItem>)}
                    </TextField>
                  ) : (
                    <TextField label="RU model" value="Not required by this type" disabled />
                  )}

                  {isSimulated ? (
                    <TextField
                      label="RU name"
                      value={ru.name}
                      onChange={(event) => onChange(updateRu(state, ctx, ru.id, { name: event.target.value }))}
                      helperText="Simulated RUs exist only in MetaModel.rus."
                      error={!ru.name.trim() || takenNames.has(ru.name.trim())}
                      disabled={disabled}
                    />
                  ) : inventory.length > 0 ? (
                    <TextField
                      select
                      label="RU hardware resource"
                      value={inventory.includes(ru.name.trim()) ? ru.name.trim() : ""}
                      onChange={(event) => onChange(updateRu(state, ctx, ru.id, { name: event.target.value }))}
                      helperText="Links this RU to a DeploymentModel.rus inventory entry."
                      error={!inventory.includes(ru.name.trim())}
                      disabled={disabled}
                    >
                      {inventory.map((name) => (
                        <MenuItem key={name} value={name} disabled={takenNames.has(name)}>{name}</MenuItem>
                      ))}
                    </TextField>
                  ) : (
                    <Alert severity="warning" variant="outlined">
                      Add RU hardware in Infrastructure first.
                    </Alert>
                  )}
                </>
              )}
            </InstanceCard>
          );
        })}
      </Stack>
    </Paper>
  );
}
