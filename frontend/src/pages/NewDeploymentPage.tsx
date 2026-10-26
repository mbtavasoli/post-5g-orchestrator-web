import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";

import { createDeployment, reconcileDeployment, replaceDeployment } from "../api/client";
import type {
  CreateDeploymentRequest,
  DeploymentResponse,
  JsonSchema,
  OptionsResponse,
  ProviderCatalogsResponse,
  ReconcileResponse,
} from "../api/types";
import {
  buildDeploymentRequest,
  createInitialBuilderState,
  validateBuilderStep,
  type DeploymentBuilderState,
} from "../builder/deploymentBuilder";
import { modelDefaultsFromSchema } from "../builder/instances";
import ComponentsStep from "../components/ComponentsStep";
import ConfigurationStep from "../components/ConfigurationStep";
import InfrastructureSection from "../components/InfrastructureSection";
import ReviewStep from "../components/ReviewStep";

interface NewDeploymentPageProps {
  options: OptionsResponse;
  metamodelSchema: JsonSchema;
  deploymentModelSchema: JsonSchema;
  providerCatalogs: ProviderCatalogsResponse;
}

const STEPS = [
  {
    label: "General",
    title: "Name the deployment",
    description: "Create the identity for the MetaModel and DeploymentModel pair.",
  },
  {
    label: "Infrastructure",
    title: "Choose the resources",
    description:
      "Use SLICES servers with R2Lab radios, or describe arbitrary local and lab resources.",
  },
  {
    label: "5G components",
    title: "Compose the network",
    description:
      "Choose model-backed implementations and connect simulated or physical radio resources.",
  },
  {
    label: "Configuration",
    title: "Tune the essentials",
    description: "Set a few high-level values or leave them empty to preserve model defaults.",
  },
  {
    label: "Review",
    title: "Validate the models",
    description:
      "Inspect the exact payload, store it, and run the existing orchestrator reconciliation chain.",
  },
] as const;

export default function NewDeploymentPage({
  options,
  metamodelSchema,
  deploymentModelSchema,
  providerCatalogs,
}: NewDeploymentPageProps) {
  const modelDefaults = useMemo(() => modelDefaultsFromSchema(metamodelSchema), [metamodelSchema]);
  const [activeStep, setActiveStep] = useState(0);
  const [state, setState] = useState<DeploymentBuilderState>(() =>
    createInitialBuilderState(options, providerCatalogs, modelDefaultsFromSchema(metamodelSchema)),
  );
  const [stepError, setStepError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deployment, setDeployment] = useState<DeploymentResponse | null>(null);
  const [reconciliation, setReconciliation] = useState<ReconcileResponse | null>(null);
  const [apiError, setApiError] = useState<Error | null>(null);

  const requestResult = useMemo((): {
    request: CreateDeploymentRequest | null;
    error: Error | null;
  } => {
    try {
      return { request: buildDeploymentRequest(state, options, providerCatalogs), error: null };
    } catch (error) {
      return {
        request: null,
        error:
          error instanceof Error ? error : new Error("The deployment request could not be built."),
      };
    }
  }, [options, providerCatalogs, state]);

  function updateState(patch: Partial<DeploymentBuilderState>) {
    setState((current) => ({ ...current, ...patch }));
    setStepError(null);
    setApiError(null);
    setReconciliation(null);
  }

  function goForward() {
    const errors = validateBuilderStep(activeStep, state, options, providerCatalogs);
    if (errors.length > 0) {
      setStepError(errors.join(" "));
      return;
    }
    setStepError(null);
    setActiveStep((step) => Math.min(step + 1, STEPS.length - 1));
  }

  async function submitAndReconcile() {
    if (!requestResult.request) return;
    setIsSubmitting(true);
    setApiError(null);
    setReconciliation(null);

    try {
      const saved = deployment
        ? await replaceDeployment(deployment.deployment.id, requestResult.request)
        : await createDeployment(requestResult.request);
      setDeployment(saved);

      // RAN/UE managers require installed Core/RIC and provisioned real RUs. The safe
      // pre-deployment chain therefore ends at Core, or RIC when it was selected.
      const reconciled = await reconcileDeployment(
        saved.deployment.id,
        state.ricEnabled ? "ric" : "core",
      );
      setReconciliation(reconciled);
    } catch (error) {
      setApiError(
        error instanceof Error
          ? error
          : new Error("The backend could not validate the deployment."),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const step = STEPS[activeStep] ?? STEPS[0];

  return (
    <Box
      id="new-deployment"
      sx={{
        display: "flex",
        flexDirection: { xs: "column", lg: "column" },
        gap: { xs: 4, lg: 6 },
        alignItems: "start",
      }}
    >
      <Box component="div" sx={{ top: { lg: 126 }, pt: 1 }}>
        <Typography
          variant="overline"
          color="primary.main"
          sx={{ pb: 1, borderBottom: "2px solid", borderColor: "secondary.dark" }}
        >
          {String(activeStep + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}
        </Typography>
        <Typography variant="h1" sx={{ mt: 3, maxWidth: 430 }}>
          {step.title}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 2, maxWidth: 420, lineHeight: 1.75 }}>
          {step.description}
        </Typography>
      </Box>

      <Paper
        component="div"
        variant="outlined"
        sx={{
          width: "100%",
          flexDirection: "column",
          p: { xs: 2.5, sm: 4 },
          boxShadow: "0 18px 50px rgba(31, 65, 52, 0.06)",
        }}
      >
        <Stack
          direction="row"
          spacing={2}
          sx={{ mb: 3, alignItems: "center", justifyContent: "space-between" }}
        >
          <Box>
            <Typography variant="overline" color="text.secondary">
              New deployment
            </Typography>
            <Typography variant="h2" sx={{ mt: 0.5 }}>
              {step.label}
            </Typography>
          </Box>
        </Stack>

        <Stepper activeStep={activeStep} alternativeLabel sx={{ mb: 4, mx: { xs: -2, sm: 0 } }}>
          {STEPS.map((item) => (
            <Step key={item.label}>
              <StepLabel>{item.label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {stepError && (
          <Alert severity="error" variant="outlined" sx={{ mb: 3 }}>
            {stepError}
          </Alert>
        )}

        {activeStep === 0 && (
          <TextField
            id="deployment-name"
            label="Deployment name"
            value={state.name}
            onChange={(event) => updateState({ name: event.target.value })}
            placeholder="e.g. campus-lab"
            helperText="Sent as DeploymentWrite.name; it does not alter either orchestrator model."
            fullWidth
            required
            autoFocus
            disabled={isSubmitting}
            slotProps={{ htmlInput: { autoComplete: "off" } }}
          />
        )}

        {activeStep === 1 && (
          <InfrastructureSection
            options={options}
            catalogs={providerCatalogs}
            state={state}
            disabled={isSubmitting}
            onChange={updateState}
          />
        )}

        {activeStep === 2 && (
          <ComponentsStep
            options={options}
            catalogs={providerCatalogs}
            modelDefaults={modelDefaults}
            state={state}
            onChange={updateState}
            disabled={isSubmitting}
          />
        )}

        {activeStep === 3 && (
          <ConfigurationStep
            state={state}
            metamodelSchema={metamodelSchema}
            deploymentModelSchema={deploymentModelSchema}
            catalogs={providerCatalogs}
            onChange={updateState}
            disabled={isSubmitting}
          />
        )}

        {activeStep === 4 && (
          <ReviewStep
            request={requestResult.request}
            buildError={requestResult.error}
            apiError={apiError}
            deployment={deployment}
            reconciliation={reconciliation}
            isSubmitting={isSubmitting}
            isUpdate={Boolean(deployment)}
            onSubmit={submitAndReconcile}
          />
        )}

        <Stack direction="row" spacing={1.5} sx={{ mt: 4, justifyContent: "space-between" }}>
          <Button
            startIcon={<ArrowBackRoundedIcon />}
            onClick={() => {
              setStepError(null);
              setActiveStep((current) => Math.max(0, current - 1));
            }}
            disabled={activeStep === 0 || isSubmitting}
          >
            Back
          </Button>
          {activeStep < STEPS.length - 1 && (
            <Button
              variant="contained"
              endIcon={<ArrowForwardRoundedIcon />}
              onClick={goForward}
              disabled={isSubmitting}
            >
              Continue
            </Button>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
