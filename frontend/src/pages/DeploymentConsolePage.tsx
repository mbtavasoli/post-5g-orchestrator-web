import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EventAvailableRoundedIcon from "@mui/icons-material/EventAvailableRounded";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import ReplayRoundedIcon from "@mui/icons-material/ReplayRounded";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getDeployment, getDeploymentState, getJobLogs, getRuntime, startAction } from "../api/client";
import type {
  ActionRequest,
  DeploymentResponse,
  DeploymentStage,
  JobLogs,
  JobRecord,
  RuntimeOverview,
  StageOverview,
  StageStatus,
} from "../api/types";
import ErrorPanel from "../components/ErrorPanel";
import { R2LabPanel, SlicesAuthPanel } from "../components/ProviderPanels";

const STAGE_LABELS: Record<DeploymentStage, { title: string; description: string }> = {
  infrastructure: { title: "Infrastructure", description: "Provision nodes (e.g. SLICES BI VMs) — ProvisioningManagement.provision_nodes()" },
  kubernetes: { title: "Kubernetes", description: "Prepare, create and join the cluster — K8SManagement.deploy()" },
  core: { title: "Core", description: "Database, network functions, subscribers — CoreManagement.deploy()" },
  ric: { title: "RIC", description: "RAN Intelligent Controller — RICManagement.deploy()" },
  radio: { title: "Radio resources", description: "Power on R2Lab RUs and COTS UEs — ProvisioningManagement.provision()" },
  ran: { title: "RAN", description: "CU/CU-CP/CU-UP before DUs, gNBs — RANManagement.deploy()" },
  ue: { title: "UE", description: "Containerized UEs, then COTS connect — UEManagement.deploy() / connect()" },
};

const STATUS_COLORS: Record<StageStatus, "default" | "info" | "success" | "error" | "warning"> = {
  pending: "default",
  running: "info",
  succeeded: "success",
  failed: "error",
  blocked: "warning",
  skipped: "default",
};

interface DeploymentConsolePageProps {
  deploymentId: string;
}

export default function DeploymentConsolePage({ deploymentId }: DeploymentConsolePageProps) {
  const [deployment, setDeployment] = useState<DeploymentResponse | null>(null);
  const [runtime, setRuntime] = useState<RuntimeOverview | null>(null);
  const [r2labDevices, setR2LabDevices] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [starting, setStarting] = useState(false);
  const [reservationMinutes, setReservationMinutes] = useState("120");
  const [logs, setLogs] = useState<JobLogs | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRuntime(await getRuntime(deploymentId));
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught : new Error("Could not load the deployment status."));
    }
  }, [deploymentId]);

  useEffect(() => {
    let cancelled = false;
    getRuntime(deploymentId)
      .then((next) => { if (!cancelled) setRuntime(next); })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught : new Error("Could not load the deployment status."));
      });
    void getDeployment(deploymentId).then(setDeployment).catch(setLoadError);
    void getDeploymentState(deploymentId).then((state) => {
      const model = state.deployment_model as {
        rus?: Record<string, { provisioner?: string | null }>;
        ues?: Record<string, { provisioner?: string | null; type?: string }>;
      };
      setR2LabDevices([
        ...Object.entries(model.rus ?? {}).filter(([, ru]) => ru.provisioner === "r2lab").map(([name]) => name),
        ...Object.entries(model.ues ?? {}).filter(([, ue]) => ue.type === "cots" && ue.provisioner === "r2lab").map(([name]) => name),
      ]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [deploymentId]);

  const activeJob = runtime?.active_job ?? null;
  const shownJob: JobRecord | null = activeJob ?? runtime?.last_job ?? null;
  const shownJobId = selectedJobId ?? shownJob?.id ?? null;

  // Poll quickly while a job runs, slowly otherwise.
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), activeJob ? 2000 : 8000);
    return () => window.clearInterval(timer);
  }, [activeJob, refresh]);

  useEffect(() => {
    if (!shownJobId) return;
    let cancelled = false;
    const load = () => getJobLogs(deploymentId, shownJobId).then((next) => !cancelled && setLogs(next)).catch(() => undefined);
    void load();
    if (!activeJob) return () => { cancelled = true; };
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deploymentId, shownJobId, activeJob]);

  async function act(body: ActionRequest) {
    setStarting(true);
    setActionError(null);
    try {
      const job = await startAction(deploymentId, body);
      setSelectedJobId(job.id);
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught : new Error("The action could not be started."));
      await refresh();
    } finally {
      setStarting(false);
    }
  }

  const stages = useMemo(() => runtime?.stages ?? [], [runtime]);
  const applicable = stages.filter((stage) => stage.applicable);
  const skipped = stages.filter((stage) => !stage.applicable);
  const needsSlices = applicable.some((stage) => stage.requirements.some((r) => r.provider === "slices"))
    || applicable.some((stage) => stage.stage === "infrastructure");
  const needsR2Lab = r2labDevices.length > 0 || applicable.some((stage) => stage.requirements.some((r) => r.provider === "r2lab"));
  const next = applicable.find((stage) => stage.status !== "succeeded");
  const allDone = applicable.length > 0 && !next;

  return (
    <Stack spacing={3} id="deployment-console">
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "center" } }}>
        <Box>
          <Button size="small" startIcon={<ArrowBackRoundedIcon />} href="#/deployments">All deployments</Button>
          <Typography variant="h1" sx={{ mt: 1 }}>{deployment?.deployment.name ?? "Deployment"}</Typography>
          <Typography variant="body2" color="text.secondary">
            {deploymentId} · {runtime?.has_state ? "runtime state saved after every stage" : "not deployed yet"}
          </Typography>
        </Box>
        <Button
          variant="contained"
          size="large"
          startIcon={starting ? <CircularProgress size={18} color="inherit" /> : <PlayArrowRoundedIcon />}
          disabled={!runtime || Boolean(activeJob) || starting || allDone || !next?.can_deploy}
          onClick={() => void act({ action: "deploy" })}
        >
          {allDone ? "Deployed" : runtime?.has_state ? "Continue deployment" : "Start deployment"}
        </Button>
      </Stack>

      {loadError && <ErrorPanel error={loadError} title="Could not load the deployment" />}

      {(needsSlices || needsR2Lab) && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: needsSlices && needsR2Lab ? "1fr 1fr" : "1fr" }, gap: 2 }}>
          {needsSlices && <SlicesAuthPanel onChange={() => void refresh()} />}
          {needsR2Lab && <R2LabPanel deviceNames={r2labDevices} onChange={() => void refresh()} />}
        </Box>
      )}

      {actionError && <ErrorPanel error={actionError} />}

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Typography variant="overline">Stages</Typography>
        {!runtime && !loadError && <LinearProgress sx={{ mt: 1 }} />}
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          {applicable.map((stage) => (
            <StageRow
              key={stage.stage}
              stage={stage}
              busy={starting || Boolean(activeJob)}
              reservationMinutes={reservationMinutes}
              onReservationMinutes={setReservationMinutes}
              onAction={(body) => void act(body)}
            />
          ))}
        </Stack>
        {skipped.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
            Not needed for this deployment: {skipped.map((stage) => STAGE_LABELS[stage.stage].title).join(", ")}.
          </Typography>
        )}
      </Paper>

      {shownJob && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }} aria-live="polite">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
            <Typography variant="overline" sx={{ flex: 1 }}>
              {activeJob ? "Running action" : "Last action"} · {shownJob.action}
            </Typography>
            <Chip size="small" label={shownJob.status} color={shownJob.status === "succeeded" ? "success" : shownJob.status === "running" ? "info" : shownJob.status === "queued" ? "default" : "error"} />
          </Stack>
          {activeJob && <LinearProgress sx={{ mb: 1.5 }} />}
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", mb: 1.5 }}>
            {shownJob.stages.map((run) => (
              <Chip key={run.stage} size="small" variant="outlined" color={STATUS_COLORS[run.status]}
                    label={`${STAGE_LABELS[run.stage].title}: ${run.status}`} />
            ))}
          </Stack>
          {shownJob.error && <ErrorPanel body={shownJob.error} />}
          <Accordion variant="outlined" disableGutters defaultExpanded={Boolean(activeJob)} sx={{ mt: 1.5 }}>
            <AccordionSummary expandIcon={<ExpandMoreRoundedIcon />}>
              <Typography variant="body2" sx={{ fontWeight: 800 }}>
                Ansible output {logs?.runs.length ? `(${logs.runs.length} runs)` : ""}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ bgcolor: "#132c25", color: "#dcebe5", p: 0 }}>
              <Box component="pre" sx={{ m: 0, p: 2, overflow: "auto", maxHeight: 480, fontSize: 12, lineHeight: 1.55 }}>
                {logs?.truncated ? "… (earlier output truncated)\n" : ""}
                {logs?.text || "No Ansible output yet."}
              </Box>
            </AccordionDetails>
          </Accordion>
        </Paper>
      )}
    </Stack>
  );
}

interface StageRowProps {
  stage: StageOverview;
  busy: boolean;
  reservationMinutes: string;
  onReservationMinutes: (value: string) => void;
  onAction: (body: ActionRequest) => void;
}

function StageRow({ stage, busy, reservationMinutes, onReservationMinutes, onAction }: StageRowProps) {
  const label = STAGE_LABELS[stage.stage];
  const unmet = stage.requirements.filter((requirement) => !requirement.satisfied);
  const minutes = Number(reservationMinutes);

  return (
    <Paper variant="outlined" sx={{ p: 1.75, borderColor: stage.status === "failed" ? "error.light" : "divider" }}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ alignItems: { md: "center" } }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
            <Typography variant="body1" sx={{ fontWeight: 800 }}>{label.title}</Typography>
            <Chip size="small" color={STATUS_COLORS[stage.status]} label={stage.status}
                  icon={stage.status === "running" ? <CircularProgress size={12} color="inherit" /> : undefined} />
            <Typography variant="caption" color="text.secondary">{stage.done}/{stage.total} done</Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">{label.description}</Typography>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap", mt: 0.75 }}>
            {stage.items.map((item) => (
              <Chip key={item.name} size="small" variant="outlined" color={item.done ? "success" : "default"} label={item.name} />
            ))}
          </Stack>
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", justifyContent: { md: "flex-end" } }}>
          {stage.can_reserve && (
            <>
              <TextField
                size="small"
                type="number"
                label="Minutes"
                value={reservationMinutes}
                onChange={(event) => onReservationMinutes(event.target.value)}
                sx={{ width: 110 }}
                slotProps={{ htmlInput: { min: 10, step: 10 } }}
              />
              <Button size="small" variant="outlined" startIcon={<EventAvailableRoundedIcon />}
                      disabled={busy || !Number.isFinite(minutes) || minutes < 10}
                      onClick={() => onAction({ action: "reserve", stages: ["radio"], reservation_minutes: minutes })}>
                Reserve R2Lab
              </Button>
            </>
          )}
          {stage.can_retry ? (
            <Button size="small" variant="contained" color="warning" startIcon={<ReplayRoundedIcon />} disabled={busy || unmet.length > 0}
                    onClick={() => onAction({ action: "deploy", stages: [stage.stage] })}>
              Retry
            </Button>
          ) : stage.status !== "succeeded" && (
            <Button size="small" variant="outlined" startIcon={<PlayArrowRoundedIcon />} disabled={busy || !stage.can_deploy}
                    onClick={() => onAction({ action: "deploy", stages: [stage.stage] })}>
              Deploy
            </Button>
          )}
          {stage.can_remove && (
            <Button size="small" color="error" startIcon={<DeleteOutlineRoundedIcon />} disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove the ${label.title} stage with the orchestrator's remove action?`)) {
                        onAction({ action: "remove", stages: [stage.stage] });
                      }
                    }}>
              Remove
            </Button>
          )}
        </Stack>
      </Stack>
      {unmet.map((requirement) => (
        <Alert key={`${requirement.provider}-${requirement.kind}`} severity="warning" variant="outlined" sx={{ mt: 1.25 }}>
          <strong>{requirement.label}.</strong> {requirement.message}
        </Alert>
      ))}
      {stage.status === "failed" && stage.last_run?.error && (
        <Box sx={{ mt: 1.25 }}><ErrorPanel body={stage.last_run.error} /></Box>
      )}
    </Paper>
  );
}
