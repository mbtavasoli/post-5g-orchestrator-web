import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import RocketLaunchRoundedIcon from "@mui/icons-material/RocketLaunchRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from "@mui/material";

import ErrorPanel from "./ErrorPanel";
import type { CreateDeploymentRequest, DeploymentResponse, ReconcileResponse } from "../api/types";

interface ReviewStepProps {
  request: CreateDeploymentRequest | null;
  buildError: Error | null;
  apiError: Error | null;
  deployment: DeploymentResponse | null;
  reconciliation: ReconcileResponse | null;
  isSubmitting: boolean;
  isUpdate: boolean;
  onSubmit: () => void;
}

export default function ReviewStep({
  request,
  buildError,
  apiError,
  deployment,
  reconciliation,
  isSubmitting,
  isUpdate,
  onSubmit,
}: ReviewStepProps) {
  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="overline">Review and validate</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          These are the exact sparse model objects sent to the backend. The response is validated by Pydantic and reconciled by the orchestrator.
        </Typography>
      </Box>

      {buildError && <ErrorPanel error={buildError} title="The request is not ready" />}

      {request && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" }, gap: 2 }}>
          <JsonPanel title="MetaModel" value={request.metamodel} />
          <JsonPanel title="DeploymentModel" value={request.deployment_model} />
        </Box>
      )}

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { sm: "center" } }}>
        <Button
          variant="contained"
          size="large"
          startIcon={isSubmitting ? <CircularProgress color="inherit" size={18} /> : <PlayArrowRoundedIcon />}
          onClick={onSubmit}
          disabled={!request || isSubmitting}
        >
          {isSubmitting ? "Validating…" : isUpdate ? "Update and reconcile" : "Create and reconcile"}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Reconciliation stops before stages that require installed Core, RIC, or provisioned radio state.
        </Typography>
      </Stack>

      {apiError && <ErrorPanel error={apiError} title="Backend validation failed" />}

      {deployment && reconciliation && (
        <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 }, borderColor: "success.light" }} aria-live="polite">
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { sm: "center" } }}>
            <CheckCircleRoundedIcon color="success" sx={{ fontSize: 36 }} />
            <Box sx={{ flex: 1 }}>
              <Typography variant="overline" color="success.main">Validated and reconciled</Typography>
              <Typography variant="h2">{deployment.deployment.name}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Stored as {deployment.deployment.id}; stages: {reconciliation.stages.join(" → ")}.
              </Typography>
            </Box>
            <Chip label={`until: ${reconciliation.until}`} color="success" variant="outlined" />
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 2, alignItems: { sm: "center" } }}>
            <Button
              variant="contained"
              startIcon={<RocketLaunchRoundedIcon />}
              href={`#/deployments/${deployment.deployment.id}`}
            >
              Open deployment console
            </Button>
            <Typography variant="caption" color="text.secondary">
              Run the deployment stage by stage with the orchestrator managers, and follow progress and logs.
            </Typography>
          </Stack>
          <Box sx={{ mt: 2 }}>
            <JsonPanel title="Reconciled backend result" value={reconciliation} compact />
          </Box>
        </Paper>
      )}
    </Stack>
  );
}

function JsonPanel({ title, value, compact = false }: { title: string; value: unknown; compact?: boolean }) {
  return (
    <Accordion variant="outlined" defaultExpanded={!compact} disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}>
        <Typography variant="body2" sx={{ fontWeight: 800 }}>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ bgcolor: "#132c25", color: "#dcebe5", p: 0 }}>
        <Box
          component="pre"
          sx={{ m: 0, p: 2.5, overflow: "auto", fontSize: 12, lineHeight: 1.65, maxHeight: compact ? 320 : 480 }}
        >
          {JSON.stringify(value, null, 2)}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}
