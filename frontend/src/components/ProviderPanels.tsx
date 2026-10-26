import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";

import {
  getR2LabDevices,
  getR2LabReservation,
  getR2LabSession,
  getSlicesAuth,
  releaseR2LabLease,
  signInR2Lab,
  signOutR2Lab,
  startSlicesLogin,
} from "../api/client";
import type { R2LabDevices, R2LabReservation, R2LabSessionStatus, SlicesAuthStatus } from "../api/types";
import ErrorPanel from "./ErrorPanel";

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ---- SLICES ----------------------------------------------------------------------

export function SlicesAuthPanel({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<SlicesAuthStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (force = false) => {
    try {
      setStatus(await getSlicesAuth(force));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Could not read SLICES status."));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSlicesAuth()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught : new Error("Could not read SLICES status."));
      });
    return () => { cancelled = true; };
  }, []);

  // While the device-code login is pending, poll until the CLI finishes.
  useEffect(() => {
    if (status?.state !== "pending") return;
    const timer = window.setInterval(async () => {
      const next = await getSlicesAuth().catch(() => null);
      if (next) {
        setStatus(next);
        if (next.state !== "pending") onChange();
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [status?.state, onChange]);

  async function login() {
    setBusy(true);
    try {
      setStatus(await startSlicesLogin());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Could not start SLICES login."));
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <KeyRoundedIcon color="primary" fontSize="small" />
        <Typography variant="subtitle2" sx={{ fontWeight: 800, flex: 1 }}>SLICES</Typography>
        {status && (
          <Chip
            size="small"
            color={state === "authenticated" ? "success" : state === "pending" ? "info" : "warning"}
            label={state === "authenticated" ? `Signed in as ${status.user}` : state?.replace("_", " ")}
          />
        )}
        <Button size="small" startIcon={<RefreshRoundedIcon />} onClick={() => void refresh(true)}>Check</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        BI provisioning runs the SLICES CLI on the backend host; its login (slices auth login) is used. Tokens stay on the server.
      </Typography>

      {state === "pending" && status?.verification_url && (
        <Alert severity="info" variant="outlined">
          Open{" "}
          <Link href={status.verification_url} target="_blank" rel="noreferrer">
            the SLICES verification page <OpenInNewRoundedIcon sx={{ fontSize: 14, verticalAlign: "middle" }} />
          </Link>{" "}
          and authorize the CLI. This panel updates when the login completes.
        </Alert>
      )}
      {(state === "unauthenticated" || state === "cli_missing") && (
        <Alert
          severity="warning"
          variant="outlined"
          action={state === "unauthenticated" ? (
            <Button color="inherit" size="small" onClick={() => void login()} disabled={busy}>
              {busy ? <CircularProgress size={16} color="inherit" /> : "Authenticate with SLICES"}
            </Button>
          ) : undefined}
        >
          {state === "cli_missing" ? status?.message : "SLICES authentication required."}
        </Alert>
      )}
      {state === "authenticated" && !status?.expiry_detectable && (
        <Typography variant="caption" color="text.secondary">
          The SLICES CLI does not document token expiry; if BI provisioning reports an authentication error, authenticate again.
          {" "}
          <Link component="button" variant="caption" onClick={() => void login()}>Authenticate again</Link>
        </Typography>
      )}
      {error && <Box sx={{ mt: 1 }}><ErrorPanel error={error} /></Box>}
    </Paper>
  );
}

// ---- R2Lab -----------------------------------------------------------------------

export function R2LabPanel({ deviceNames, onChange }: { deviceNames: string[]; onChange: () => void }) {
  const [session, setSession] = useState<R2LabSessionStatus | null>(null);
  const [reservation, setReservation] = useState<R2LabReservation | null>(null);
  const [devices, setDevices] = useState<R2LabDevices | null>(null);
  const [form, setForm] = useState({ email: "", password: "", slice: "" });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const namesKey = deviceNames.join(",");

  const refresh = useCallback(async () => {
    const names = namesKey ? namesKey.split(",") : [];
    try {
      const [nextSession, nextReservation, nextDevices] = await Promise.all([
        getR2LabSession(),
        getR2LabReservation(),
        getR2LabDevices(names),
      ]);
      setSession(nextSession);
      setReservation(nextReservation);
      setDevices(nextDevices);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Could not read R2Lab status."));
    }
  }, [namesKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function run(operation: () => Promise<unknown>) {
    setBusy(true);
    try {
      await operation();
      setError(null);
      await refresh();
      onChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("R2Lab request failed."));
    } finally {
      setBusy(false);
    }
  }

  const signedIn = session?.state === "authenticated";
  const reservationColor = reservation?.state === "reserved_by_you" ? "success" : reservation?.state === "reserved_by_other" ? "error" : "warning";

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <KeyRoundedIcon color="primary" fontSize="small" />
        <Typography variant="subtitle2" sx={{ fontWeight: 800, flex: 1 }}>R2Lab</Typography>
        {session && (
          <Chip size="small" color={signedIn ? "success" : "warning"}
                label={signedIn ? `${session.email} · ${session.slice}` : "not signed in"} />
        )}
        <Button size="small" startIcon={<RefreshRoundedIcon />} onClick={() => void refresh()}>Refresh</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
        Credentials are checked with the R2Lab API and kept in backend memory only, to configure the orchestrator's r2lab provisioner. They are never stored with the deployment.
      </Typography>

      {!signedIn ? (
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await signInR2Lab(form);
              setForm((current) => ({ ...current, password: "" }));
            });
          }}
          sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr 1fr auto" }, gap: 1.5, alignItems: "start" }}
        >
          <TextField size="small" label="Email" value={form.email} autoComplete="username"
                     onChange={(event) => setForm({ ...form, email: event.target.value })} />
          <TextField size="small" label="Password" type="password" value={form.password} autoComplete="current-password"
                     onChange={(event) => setForm({ ...form, password: event.target.value })} />
          <TextField size="small" label="Slice" value={form.slice}
                     onChange={(event) => setForm({ ...form, slice: event.target.value })} />
          <Button type="submit" variant="contained" disabled={busy || !form.email || !form.password || !form.slice}>
            Sign in
          </Button>
        </Box>
      ) : (
        <Button size="small" onClick={() => void run(signOutR2Lab)} disabled={busy}>Sign out</Button>
      )}

      {reservation && (
        <Box sx={{ mt: 1.5 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>Testbed lease</Typography>
            <Chip size="small" color={reservationColor} label={reservation.state.replaceAll("_", " ")} />
            {reservation.current && (
              <Typography variant="caption" color="text.secondary">
                {reservation.current.slice_name ?? "unknown slice"} · {formatTime(reservation.current.t_from)} → {formatTime(reservation.current.t_until)}
              </Typography>
            )}
            {reservation.current?.mine && (
              <Button size="small" color="error" disabled={busy}
                      onClick={() => {
                        if (window.confirm("Release your current R2Lab lease?")) void run(() => releaseR2LabLease(reservation.current!.id));
                      }}>
                Release
              </Button>
            )}
          </Stack>
          {reservation.upcoming.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              Upcoming: {reservation.upcoming.slice(0, 5).map((lease) => `${lease.slice_name ?? "?"} ${formatTime(lease.t_from)}`).join(" · ")}
            </Typography>
          )}
          {reservation.state !== "reserved_by_you" && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              Reserve from the Radio stage below; it runs the orchestrator's r2lab reserve role (which also powers off all R2Lab devices).
            </Typography>
          )}
        </Box>
      )}

      {devices && devices.requested.length > 0 && (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 1.5, flexWrap: "wrap" }}>
          {devices.requested.map((device) => (
            <Chip
              key={device.name}
              size="small"
              variant="outlined"
              color={!device.known ? "error" : device.power?.power_status === "on" ? "success" : "default"}
              label={`${device.name}: ${!device.known ? "unknown to device manager" : device.power?.power_status ?? device.power?.error ?? (signedIn ? "power unknown" : "sign in for power state")}`}
            />
          ))}
        </Stack>
      )}
      {error && <Box sx={{ mt: 1.5 }}><ErrorPanel error={error} /></Box>}
    </Paper>
  );
}
