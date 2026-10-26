import HubRoundedIcon from "@mui/icons-material/HubRounded";
import {
  Alert,
  AlertTitle,
  Box,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from "@mui/material";

import type { OptionsResponse, ProviderCatalogsResponse } from "../api/types";
import { builderWarnings, type DeploymentBuilderState } from "../builder/deploymentBuilder";
import { finalizePatch, type BuilderContext } from "../builder/instanceActions";
import type { BuilderModelDefaults } from "../builder/instances";
import ComponentFunctionSelector from "./ComponentFunctionSelector";
import ImplementationSelect from "./ImplementationSelect";
import PlacementSection from "./PlacementSection";
import RadioUnitsSection from "./RadioUnitsSection";
import RanInstancesSection from "./RanInstancesSection";
import UeInstancesSection from "./UeInstancesSection";

interface ComponentsStepProps {
  options: OptionsResponse;
  catalogs: ProviderCatalogsResponse;
  modelDefaults: BuilderModelDefaults;
  state: DeploymentBuilderState;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

export default function ComponentsStep({
  options,
  catalogs,
  modelDefaults,
  state,
  disabled = false,
  onChange,
}: ComponentsStepProps) {
  const ctx: BuilderContext = { options, catalogs, defaults: modelDefaults };
  const warnings = builderWarnings(state, modelDefaults);

  return (
    <Stack spacing={3}>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Box>
          <Typography variant="overline">Network choices</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Every selectable value below comes from the backend model catalogs. Add as many instances as the topology needs.
          </Typography>
        </Box>
        <HubRoundedIcon color="action" />
      </Stack>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2.5 }}>
        <ImplementationSelect
          id="core-implementation"
          label="Core implementation"
          description="Used by DeploymentModel.core.implementation."
          value={state.coreImplementation}
          options={options.core.implementations}
          onChange={(coreImplementation) => onChange(finalizePatch(state, ctx, {
            coreImplementation,
            coreComponentTypes: options.core.supported_components[coreImplementation] ?? [],
          }))}
          disabled={disabled}
        />
        <ImplementationSelect
          id="ran-implementation"
          label="RAN implementation"
          description="Used by DeploymentModel.ran.implementation."
          value={state.ranImplementation}
          options={options.ran.implementations}
          onChange={(ranImplementation) => onChange(finalizePatch(state, ctx, { ranImplementation }))}
          disabled={disabled}
        />
      </Box>

      <ComponentFunctionSelector
        label="Core"
        implementation={state.coreImplementation}
        mode={state.coreComponentMode}
        selectedTypes={state.coreComponentTypes}
        supportedTypes={options.core.supported_components[state.coreImplementation] ?? []}
        disabled={disabled}
        onChange={(coreComponentMode, coreComponentTypes) => onChange(finalizePatch(state, ctx, {
          coreComponentMode,
          coreComponentTypes,
        }))}
      />

      <RadioUnitsSection ctx={ctx} state={state} disabled={disabled} onChange={onChange} />
      <RanInstancesSection ctx={ctx} state={state} disabled={disabled} onChange={onChange} />
      <UeInstancesSection ctx={ctx} state={state} disabled={disabled} onChange={onChange} />

      {warnings.length > 0 && (
        <Alert severity="warning" variant="outlined">
          <AlertTitle sx={{ fontWeight: 800 }}>Allowed by the models, but worth checking</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {warnings.map((warning) => <li key={warning}><Typography variant="body2">{warning}</Typography></li>)}
          </Box>
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between" }}>
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>RAN Intelligent Controller</Typography>
              <Chip label="Optional" size="small" variant="outlined" />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Disabled means MetaModel.ric.components is sent empty.
            </Typography>
          </Box>
          <FormControlLabel
            control={(
              <Switch
                checked={state.ricEnabled}
                onChange={(event) => onChange(finalizePatch(state, ctx, { ricEnabled: event.target.checked }))}
                disabled={disabled}
              />
            )}
            label={state.ricEnabled ? "Enabled" : "Disabled"}
          />
        </Stack>
        {state.ricEnabled && (
          <Box sx={{ mt: 2 }}>
            <ImplementationSelect
              id="ric-implementation"
              label="RIC implementation"
              description="Used by DeploymentModel.ric.implementation."
              value={state.ricImplementation}
              options={options.ric.implementations}
              onChange={(ricImplementation) => onChange(finalizePatch(state, ctx, { ricImplementation }))}
              disabled={disabled}
            />
          </Box>
        )}
      </Paper>

      <PlacementSection ctx={ctx} state={state} disabled={disabled} onChange={onChange} />
    </Stack>
  );
}
