import AccountTreeRoundedIcon from "@mui/icons-material/AccountTreeRounded";
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

import {
  builderNodeNames,
  builderPlacementPlan,
  type DeploymentBuilderState,
  type PlacementAssignment,
  type PlacementCategory,
} from "../builder/deploymentBuilder";
import { syncPlacements, type BuilderContext } from "../builder/instanceActions";

interface PlacementSectionProps {
  ctx: BuilderContext;
  state: DeploymentBuilderState;
  disabled?: boolean;
  onChange: (patch: Partial<DeploymentBuilderState>) => void;
}

const CATEGORY_LABELS: Record<PlacementCategory, string> = {
  core: "Core",
  ran: "RAN",
  ric: "RIC",
  ue: "UE",
};

export default function PlacementSection({ ctx, state, disabled = false, onChange }: PlacementSectionProps) {
  const { catalogs } = ctx;
  const nodes = builderNodeNames(state, catalogs);
  const plan = builderPlacementPlan(state, ctx.options, catalogs);
  const compatibleNodes = nodes.filter((node) => catalogs.r2lab.required_sophianodes.includes(node));

  function setMode(placementMode: "simple" | "explicit") {
    const next = { ...state, placementMode };
    onChange({ placementMode, componentPlacements: syncPlacements(next, ctx) });
  }

  const byNode = new Map<string, PlacementAssignment[]>();
  for (const assignment of plan) {
    byNode.set(assignment.node, [...(byNode.get(assignment.node) ?? []), assignment]);
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
      <Stack direction="row" sx={{ alignItems: "flex-start", justifyContent: "space-between", mb: 2 }}>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Function placement</Typography>
          <Typography variant="caption" color="text.secondary">
            Every instance is placed on its own. Uses node roles, force_type_scheduling, and node_name.
          </Typography>
        </Box>
        <AccountTreeRoundedIcon color="action" />
      </Stack>

      {nodes.length === 0 && (
        <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
          Select infrastructure nodes before assigning component placement.
        </Alert>
      )}

      <RadioGroup
        row
        value={state.placementMode}
        onChange={(event) => setMode(event.target.value as "simple" | "explicit")}
        aria-label="Function placement mode"
      >
        <FormControlLabel value="simple" control={<Radio />} label="Simple: one default node" disabled={disabled} />
        <FormControlLabel value="explicit" control={<Radio />} label="Explicit placement" disabled={disabled} />
      </RadioGroup>

      {state.placementMode === "simple" ? (
        <TextField
          select
          fullWidth
          label="Default component node"
          value={nodes.includes(state.defaultPlacementNode) ? state.defaultPlacementNode : ""}
          onChange={(event) => onChange({ defaultPlacementNode: event.target.value })}
          helperText="This node receives the category roles required by all selected components."
          disabled={disabled || nodes.length === 0}
          sx={{ mt: 1.5 }}
        >
          {nodes.map((node) => <MenuItem key={node} value={node}>{node}</MenuItem>)}
        </TextField>
      ) : (
        <Stack spacing={2.5} sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            When every instance of a type is on the same node, it gets force_type_scheduling and that node gets the type role.
            When instances of one type are on different nodes, each one is pinned with node_name, as the RU tutorial does for its DU.
            UEs always use node_name.
          </Typography>
          {(Object.keys(CATEGORY_LABELS) as PlacementCategory[]).map((category) => {
            const assignments = plan.filter((assignment) => assignment.category === category);
            if (assignments.length === 0) return null;
            return (
              <Box key={category}>
                <Typography variant="overline" color="text.secondary">{CATEGORY_LABELS[category]}</Typography>
                <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2, mt: 0.5 }}>
                  {assignments.map((assignment) => {
                    const choices = assignment.needsR2LabNode ? compatibleNodes : nodes;
                    const current = state.componentPlacements[assignment.key] ?? "";
                    return (
                      <TextField
                        key={assignment.key}
                        select
                        label={assignment.label}
                        value={choices.includes(current) ? current : ""}
                        onChange={(event) => onChange({
                          componentPlacements: { ...state.componentPlacements, [assignment.key]: event.target.value },
                        })}
                        helperText={strategyText(assignment)}
                        error={!choices.includes(current)}
                        disabled={disabled || choices.length === 0}
                      >
                        {choices.map((node) => <MenuItem key={node} value={node}>{node}</MenuItem>)}
                      </TextField>
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Stack>
      )}

      {plan.length > 0 && nodes.length > 0 && (
        <Box sx={{ mt: 2.5 }}>
          <Typography variant="overline" color="text.secondary">Placement summary</Typography>
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {[...byNode.entries()].map(([node, assignments]) => (
              <Stack key={node || "unassigned"} direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
                <Typography variant="body2" sx={{ fontWeight: 800, minWidth: 140 }}>{node || "Unassigned"}</Typography>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
                  {assignments.map((assignment) => (
                    <Chip
                      key={assignment.key}
                      size="small"
                      variant="outlined"
                      color={assignment.strategy === "node-name" ? "secondary" : "default"}
                      label={assignment.name || "(unnamed)"}
                    />
                  ))}
                </Stack>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
}

function strategyText(assignment: PlacementAssignment): string {
  const r2lab = assignment.needsR2LabNode ? " Drives an R2Lab radio: compatible SophiaNodes only." : "";
  if (assignment.strategy === "type-role") {
    return `force_type_scheduling · all ${assignment.type} instances on this node.${r2lab}`;
  }
  if (assignment.category === "ue") {
    return `node_name · UE types are not node roles.${r2lab}`;
  }
  return `node_name · ${assignment.type} instances are on different nodes.${r2lab}`;
}
