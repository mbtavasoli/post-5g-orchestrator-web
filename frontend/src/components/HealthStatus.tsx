import CircleRoundedIcon from '@mui/icons-material/CircleRounded'
import { Chip } from '@mui/material'

import type { HealthResponse } from '../api/types'

interface HealthStatusProps {
  health: HealthResponse | null
}

export default function HealthStatus({ health }: HealthStatusProps) {
  const isHealthy = health?.status === 'ok'

  return (
    <Chip
      size="small"
      variant="outlined"
      icon={<CircleRoundedIcon />}
      label={isHealthy ? 'Backend connected' : 'Connecting'}
      color={isHealthy ? 'success' : 'default'}
      sx={{ bgcolor: 'background.paper', fontWeight: 700, '& .MuiChip-icon': { fontSize: 11 } }}
    />
  )
}

