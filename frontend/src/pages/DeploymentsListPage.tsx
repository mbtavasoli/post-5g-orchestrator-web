import { Button, List, ListItemButton, ListItemText, Paper, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";

import { listDeployments } from "../api/client";
import type { DeploymentMetadata } from "../api/types";
import ErrorPanel from "../components/ErrorPanel";

export default function DeploymentsListPage() {
  const [deployments, setDeployments] = useState<DeploymentMetadata[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listDeployments(controller.signal).then(setDeployments).catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught : new Error("Could not list deployments."));
      }
    });
    return () => controller.abort();
  }, []);

  return (
    <Stack spacing={3}>
      <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="h1">Deployments</Typography>
        <Button variant="contained" href="#/">New deployment</Button>
      </Stack>
      {error && <ErrorPanel error={error} />}
      <Paper variant="outlined">
        {deployments?.length === 0 && (
          <Typography color="text.secondary" sx={{ p: 3 }}>No deployments yet.</Typography>
        )}
        <List disablePadding>
          {[...(deployments ?? [])].reverse().map((deployment) => (
            <ListItemButton key={deployment.id} component="a" href={`#/deployments/${deployment.id}`} divider>
              <ListItemText
                primary={deployment.name}
                secondary={`${deployment.id} · updated ${new Date(deployment.updated_at).toLocaleString()}`}
              />
            </ListItemButton>
          ))}
        </List>
      </Paper>
    </Stack>
  );
}
