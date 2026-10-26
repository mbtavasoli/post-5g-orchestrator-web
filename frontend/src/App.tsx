import { useEffect, useState } from 'react'
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded'
import { Alert, AlertTitle, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material'

import { loadBootstrapData } from './api/client'
import type { BootstrapData } from './api/types'
import AppShell from './components/AppShell'
import DeploymentConsolePage from './pages/DeploymentConsolePage'
import DeploymentsListPage from './pages/DeploymentsListPage'
import NewDeploymentPage from './pages/NewDeploymentPage'

type Route = { page: 'new' } | { page: 'list' } | { page: 'console'; deploymentId: string }

function routeFromHash(hash: string): Route {
  const match = /^#\/deployments(?:\/([0-9a-fA-F-]{36}))?\/?$/.exec(hash)
  if (!match) return { page: 'new' }
  return match[1] ? { page: 'console', deploymentId: match[1] } : { page: 'list' }
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    loadBootstrapData(controller.signal)
      .then(setBootstrap)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        setLoadError(error instanceof Error ? error : new Error('Unable to load backend configuration.'))
      })

    return () => controller.abort()
  }, [loadAttempt])

  return (
    <AppShell bootstrap={bootstrap} page={route.page}>
      {!bootstrap && !loadError && (
        <Paper variant="outlined" sx={{ p: { xs: 3, sm: 4 } }} aria-live="polite">
          <Stack direction="row" spacing={2.5} sx={{ alignItems: 'center' }}>
            <CircularProgress size={32} thickness={4} />
            <Box>
              <Typography variant="overline" color="text.secondary">Connecting to source of truth</Typography>
              <Typography variant="h2" sx={{ mt: 0.5 }}>Loading orchestrator models…</Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                Checking backend health, options, and validation schemas.
              </Typography>
            </Box>
          </Stack>
        </Paper>
      )}

      {loadError && (
        <Alert
          severity="error"
          variant="outlined"
          action={
            <Button
              color="error"
              size="small"
              startIcon={<RefreshRoundedIcon />}
              onClick={() => {
                setLoadError(null)
                setLoadAttempt((value) => value + 1)
              }}
            >
              Try again
            </Button>
          }
          sx={{ bgcolor: 'background.paper', p: 2 }}
        >
          <AlertTitle>Could not load the deployment model</AlertTitle>
          {loadError.message}
        </Alert>
      )}

      {bootstrap && (
        // Kept mounted so the builder state survives a visit to the console.
        <div hidden={route.page !== 'new'}>
          <NewDeploymentPage
            options={bootstrap.options}
            providerCatalogs={bootstrap.providerCatalogs}
            metamodelSchema={bootstrap.metamodelSchema}
            deploymentModelSchema={bootstrap.deploymentModelSchema}
          />
        </div>
      )}
      {bootstrap && route.page === 'list' && <DeploymentsListPage />}
      {bootstrap && route.page === 'console' && (
        <DeploymentConsolePage key={route.deploymentId} deploymentId={route.deploymentId} />
      )}
    </AppShell>
  )
}

