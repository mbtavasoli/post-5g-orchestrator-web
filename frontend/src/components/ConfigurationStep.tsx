import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import { Alert, Box, MenuItem, Stack, TextField, Typography } from "@mui/material";

import type { JsonSchema, ProviderCatalogsResponse } from "../api/types";
import {
  builderNodeNames,
  schemaField,
  type DeploymentBuilderState,
} from "../builder/deploymentBuilder";

interface ConfigurationStepProps {
  state: DeploymentBuilderState;
  metamodelSchema: JsonSchema;
  deploymentModelSchema: JsonSchema;
  catalogs: ProviderCatalogsResponse;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

export default function ConfigurationStep({
  state,
  metamodelSchema,
  deploymentModelSchema,
  catalogs,
  disabled = false,
  onChange,
}: ConfigurationStepProps) {
  const nodes = builderNodeNames(state, catalogs);
  const clusterName = schemaField(deploymentModelSchema, "K8SParams", "cluster_name");
  const nrBand = schemaField(metamodelSchema, "RadioConfiguration", "nrBand");
  const bandwidth = schemaField(metamodelSchema, "RadioConfiguration", "channelBandwidthMhz");

  return (
    <Stack spacing={3}>
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Box>
          <Typography variant="overline">High-level configuration</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Leave fields empty to let Pydantic model defaults apply.
          </Typography>
        </Box>
        <TuneRoundedIcon color="action" />
      </Stack>

      <Alert severity="info" variant="outlined">
        Advanced implementation-specific configuration is intentionally excluded from this builder.
      </Alert>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2.5 }}>
        <TextField
          select
          label="Kubernetes master node"
          value={state.masterNode}
          onChange={(event) => onChange({ masterNode: event.target.value })}
          helperText="Optional DeploymentModel.params.k8s.master_node reference."
          disabled={disabled}
        >
          <MenuItem value="">Let the model remain unset</MenuItem>
          {nodes.map((node) => <MenuItem key={node} value={node}>{node}</MenuItem>)}
        </TextField>

        <TextField
          label="Cluster name"
          value={state.clusterName}
          onChange={(event) => onChange({ clusterName: event.target.value })}
          placeholder={defaultText(clusterName.default)}
          helperText={`Optional. Model default: ${defaultText(clusterName.default, "not declared")}.`}
          disabled={disabled}
        />

        <TextField
          label="NR band"
          type="number"
          value={state.nrBand}
          onChange={(event) => onChange({ nrBand: event.target.value })}
          placeholder={defaultText(nrBand.default)}
          helperText={`Optional; applies to every gNB/DU and UE. Model default: ${defaultText(nrBand.default, "not declared")}.`}
          disabled={disabled}
          slotProps={{ htmlInput: { min: nrBand.minimum, max: nrBand.maximum } }}
        />

        <TextField
          label="Channel bandwidth (MHz)"
          type="number"
          value={state.channelBandwidthMhz}
          onChange={(event) => onChange({ channelBandwidthMhz: event.target.value })}
          placeholder={defaultText(bandwidth.default)}
          helperText={`Optional; applies to every gNB/DU. Model default: ${defaultText(bandwidth.default, "not declared")}.`}
          disabled={disabled}
          slotProps={{ htmlInput: { min: bandwidth.minimum, max: bandwidth.maximum } }}
        />

      </Box>
    </Stack>
  );
}

function defaultText(value: unknown, fallback = ""): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return fallback;
}
