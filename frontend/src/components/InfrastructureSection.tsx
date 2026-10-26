import AddRoundedIcon from "@mui/icons-material/AddRounded";
import CloudQueueRoundedIcon from "@mui/icons-material/CloudQueueRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DevicesOtherRoundedIcon from "@mui/icons-material/DevicesOtherRounded";
import DnsRoundedIcon from "@mui/icons-material/DnsRounded";
import RouterRoundedIcon from "@mui/icons-material/RouterRounded";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";

import type { OptionsResponse, ProviderCatalogsResponse } from "../api/types";
import {
  requiresR2LabHardware,
  sophianodeNeedsSlicesUsername,
  type DeploymentBuilderState,
} from "../builder/deploymentBuilder";
import {
  createResourceDraft,
  RESOURCE_SOURCES,
  sourceById,
  type CustomResourceDraft,
  type ResourceKind,
} from "../infrastructure/resourceSources";

interface InfrastructureSectionProps {
  options: OptionsResponse;
  catalogs: ProviderCatalogsResponse;
  state: DeploymentBuilderState;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  node: "Node",
  ru: "Radio unit",
  ue: "User equipment",
};

export default function InfrastructureSection({
  options,
  catalogs,
  state,
  disabled = false,
  onChange,
}: InfrastructureSectionProps) {
  const source = sourceById(state.resourceSource);
  const needsRadioHost = requiresR2LabHardware(state);
  const sophianodes = catalogs.slices.sophianodes.filter((node) => node.available);

  function addResource(kind: ResourceKind) {
    onChange({ resources: [...state.resources, createResourceDraft(kind)] });
  }

  function updateResource(id: string, patch: Partial<CustomResourceDraft>) {
    onChange({
      resources: state.resources.map((resource) =>
        resource.id === id ? { ...resource, ...patch } : resource,
      ),
    });
  }

  return (
    <Box component="section" aria-labelledby="infrastructure-heading">
      <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Box>
          <Typography id="infrastructure-heading" variant="overline" color="text.primary">
            Resource source
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Combine SLICES compute with R2Lab radios, or describe everything directly.
          </Typography>
        </Box>
        <CloudQueueRoundedIcon color="action" />
      </Stack>

      <RadioGroup
        value={state.resourceSource}
        onChange={(event) => onChange({ resourceSource: event.target.value })}
        aria-label="Resource source"
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" },
            gap: 1.5,
          }}
        >
          {RESOURCE_SOURCES.map((candidate) => (
            <Paper
              key={candidate.id}
              variant="outlined"
              sx={{
                borderColor: state.resourceSource === candidate.id ? "primary.main" : "divider",
                bgcolor:
                  state.resourceSource === candidate.id ? "primary.light" : "background.paper",
              }}
            >
              <FormControlLabel
                value={candidate.id}
                disabled={disabled}
                control={<Radio size="small" />}
                sx={{ m: 0, p: 1.5, width: "100%", alignItems: "flex-start" }}
                label={
                  <Box sx={{ pt: 0.25 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <Typography variant="body2" sx={{ fontWeight: 800 }}>
                        {candidate.label}
                      </Typography>
                      <Chip
                        label={candidate.kind === "custom" ? "Manual" : "Catalog"}
                        size="small"
                        variant="outlined"
                      />
                    </Stack>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: "block", mt: 0.75 }}
                    >
                      {candidate.description}
                    </Typography>
                  </Box>
                }
              />
            </Paper>
          ))}
        </Box>
      </RadioGroup>

      {source?.kind === "federated" && (
        <Stack spacing={2.5} sx={{ mt: 3 }}>
          <Box
            sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1.5 }}
          >
            <ProviderSummary
              icon={<DnsRoundedIcon color="primary" />}
              name="SLICES"
              provides="SophiaNode servers or BI virtual machines"
            />
            <ProviderSummary
              icon={<RouterRoundedIcon color="primary" />}
              name="R2Lab"
              provides="Physical radio units and COTS UEs"
            />
          </Box>

          {needsRadioHost && (
            <Alert severity="info" variant="outlined">
              R2Lab hardware requires at least one compatible SophiaNode. You may also select other
              SophiaNodes or add BI VMs for Core, CU, RIC, and auxiliary functions.
            </Alert>
          )}

          <Autocomplete
            multiple
            options={sophianodes}
            value={sophianodes.filter((node) => state.sophianodeIds.includes(node.id))}
            getOptionLabel={(node) => node.id}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, nodes) => onChange({ sophianodeIds: nodes.map((node) => node.id) })}
            disabled={disabled}
            renderInput={(params) => (
              <TextField
                {...params}
                label="SophiaNode servers"
                helperText="Existing servers (no reprovisioning). Roles are assigned in the placement section."
              />
            )}
          />

          {sophianodeNeedsSlicesUsername(state, catalogs) && (
            <TextField
              label="SLICES username"
              value={state.slicesUsername}
              onChange={(event) => onChange({ slicesUsername: event.target.value })}
              error={!state.slicesUsername.trim()}
              disabled={disabled}
              slotProps={{ htmlInput: { autoComplete: "username" } }}
            />
          )}

          <FormControlLabel
            control={
              <Switch
                checked={state.biEnabled}
                onChange={(event) => onChange({ biEnabled: event.target.checked })}
                disabled={disabled}
              />
            }
            label="Add SLICES BI virtual machines"
          />

          {state.biEnabled && (
            <BIConfiguration state={state} disabled={disabled} onChange={onChange} />
          )}
        </Stack>
      )}

      {source?.kind === "custom" && (
        <Box sx={{ mt: 3 }}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            sx={{ justifyContent: "space-between", mb: 2 }}
          >
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                Custom resources
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Inventory maps directly to DeploymentModel resources.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap" }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DnsRoundedIcon />}
                onClick={() => addResource("node")}
                disabled={disabled}
              >
                Add node
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<RouterRoundedIcon />}
                onClick={() => addResource("ru")}
                disabled={disabled}
              >
                Add RU hardware
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<DevicesOtherRoundedIcon />}
                onClick={() => addResource("ue")}
                disabled={disabled}
              >
                Add COTS UE
              </Button>
            </Stack>
          </Stack>

          {state.resources.length === 0 ? (
            <Paper
              variant="outlined"
              sx={{ p: 3, textAlign: "center", borderStyle: "dashed", bgcolor: "#fbfcfa" }}
            >
              <AddRoundedIcon color="action" />
              <Typography variant="body2" sx={{ mt: 0.75, fontWeight: 700 }}>
                No custom resources yet
              </Typography>
              <Typography variant="caption" color="text.secondary">
                An empty custom inventory remains valid.
              </Typography>
            </Paper>
          ) : (
            <Stack spacing={2}>
              {state.resources.map((resource) => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  options={options}
                  disabled={disabled}
                  onChange={(patch) => updateResource(resource.id, patch)}
                  onRemove={() =>
                    onChange({
                      resources: state.resources.filter((item) => item.id !== resource.id),
                    })
                  }
                />
              ))}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  );
}

function ProviderSummary({
  icon,
  name,
  provides,
}: {
  icon: ReactNode;
  name: string;
  provides: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, bgcolor: "#fbfcfa" }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "flex-start" }}>
        {icon}
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            {name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {provides}
          </Typography>
        </Box>
      </Stack>
    </Paper>
  );
}

function BIConfiguration({
  state,
  disabled,
  onChange,
}: {
  state: DeploymentBuilderState;
  disabled: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: "#fbfcfa" }}>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}
      >
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            SLICES BI virtual machines
          </Typography>
          <Typography variant="caption" color="text.secondary">
            All VMs use the same BI provisioner parameters.
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddRoundedIcon />}
          onClick={() =>
            onChange({ biVmNames: [...state.biVmNames, `node${state.biVmNames.length + 1}`] })
          }
          disabled={disabled}
        >
          Add VM
        </Button>
      </Stack>
      <Stack spacing={1.25} sx={{ mb: 2 }}>
        {state.biVmNames.map((name, index) => (
          <Stack key={index} direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <TextField
              label={`VM ${index + 1} name`}
              value={name}
              onChange={(event) =>
                onChange({
                  biVmNames: state.biVmNames.map((candidate, candidateIndex) =>
                    candidateIndex === index ? event.target.value : candidate,
                  ),
                })
              }
              disabled={disabled}
              required
              fullWidth
            />
            <Tooltip title="Remove VM">
              <span>
                <IconButton
                  onClick={() =>
                    onChange({
                      biVmNames: state.biVmNames.filter(
                        (_, candidateIndex) => candidateIndex !== index,
                      ),
                    })
                  }
                  disabled={disabled}
                  aria-label={`Remove VM ${index + 1}`}
                >
                  <DeleteOutlineRoundedIcon />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ))}
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
        <TextField
          label="Infrastructure"
          value={state.biInfra}
          onChange={(event) => onChange({ biInfra: event.target.value })}
          disabled={disabled}
          required
        />
        <TextField
          label="Image"
          value={state.biImage}
          onChange={(event) => onChange({ biImage: event.target.value })}
          disabled={disabled}
          required
        />
        <TextField
          label="VM size"
          value={state.biFlavor}
          onChange={(event) => onChange({ biFlavor: event.target.value })}
          disabled={disabled}
          required
        />
        <TextField
          label="Project"
          value={state.biProject}
          onChange={(event) => onChange({ biProject: event.target.value })}
          disabled={disabled}
          required
        />
        <TextField
          label="Experiment"
          value={state.biExperiment}
          onChange={(event) => onChange({ biExperiment: event.target.value })}
          disabled={disabled}
          required
        />
        <TextField
          label="Experiment duration"
          value={state.biExperimentDuration}
          onChange={(event) => onChange({ biExperimentDuration: event.target.value })}
          disabled={disabled}
          required
        />
        <TextField
          label="Node duration"
          value={state.biNodeDuration}
          onChange={(event) => onChange({ biNodeDuration: event.target.value })}
          disabled={disabled}
          required
        />
        <FormControlLabel
          control={
            <Switch
              checked={state.biCreateExperiment}
              onChange={(event) => onChange({ biCreateExperiment: event.target.checked })}
              disabled={disabled}
            />
          }
          label="Create experiment"
        />
      </Box>
    </Paper>
  );
}

function ResourceCard({
  resource,
  options,
  disabled,
  onChange,
  onRemove,
}: {
  resource: CustomResourceDraft;
  options: OptionsResponse;
  disabled: boolean;
  onChange: (patch: Partial<CustomResourceDraft>) => void;
  onRemove: () => void;
}) {
  const provisioners = Object.entries(options.provisioners.default_instances).filter(
    ([, provisioner]) => provisioner.supported_categories.includes(resource.kind),
  );
  const hasSsh = resource.kind === "node" || resource.kind === "ue";
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, bgcolor: "#fbfcfa" }}>
      <Stack direction="row" sx={{ justifyContent: "space-between", mb: 2.5 }}>
        <Chip
          label={RESOURCE_KIND_LABELS[resource.kind]}
          size="small"
          color="primary"
          variant="outlined"
        />
        <Tooltip title="Remove resource">
          <span>
            <IconButton
              size="small"
              onClick={onRemove}
              disabled={disabled}
              aria-label="Remove resource"
            >
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
        <TextField
          label="Resource name"
          value={resource.name}
          onChange={(event) => onChange({ name: event.target.value })}
          helperText="DeploymentModel dictionary key."
          required
          disabled={disabled}
        />
        <TextField
          select
          label="Provisioner"
          value={resource.provisioner}
          onChange={(event) => onChange({ provisioner: event.target.value })}
          disabled={disabled}
        >
          <MenuItem value="">Already available</MenuItem>
          {provisioners.map(([name, provisioner]) => (
            <MenuItem key={name} value={name}>
              {name} ({provisioner.type})
            </MenuItem>
          ))}
        </TextField>
        {hasSsh && (
          <>
            <TextField
              label="Host or IP"
              value={resource.hostname}
              onChange={(event) => onChange({ hostname: event.target.value })}
              required
              disabled={disabled}
            />
            <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 110px", gap: 2 }}>
              <TextField
                label="SSH user"
                value={resource.sshUser}
                onChange={(event) => onChange({ sshUser: event.target.value })}
                disabled={disabled}
              />
              <TextField
                label="SSH port"
                type="number"
                value={resource.sshPort}
                onChange={(event) => onChange({ sshPort: event.target.value })}
                disabled={disabled}
                slotProps={{ htmlInput: { min: 1, max: 65535 } }}
              />
            </Box>
          </>
        )}
        {resource.kind === "node" && (
          <Autocomplete
            multiple
            options={options.node_roles}
            value={resource.roles}
            onChange={(_, roles) => onChange({ roles })}
            disabled={disabled}
            sx={{ gridColumn: { sm: "1 / -1" } }}
            renderInput={(params) => <TextField {...params} label="Node roles" />}
          />
        )}
        {resource.kind === "ru" && (
          <TextField
            label="IP addresses"
            value={resource.ips}
            onChange={(event) => onChange({ ips: event.target.value })}
            helperText="Optional comma-separated DeploymentModel.rus[name].ips."
            disabled={disabled}
            sx={{ gridColumn: { sm: "1 / -1" } }}
          />
        )}
      </Box>
    </Paper>
  );
}
