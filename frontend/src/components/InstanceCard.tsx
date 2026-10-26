import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import { Box, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import type { ReactNode } from "react";

interface InstanceCardProps {
  title: string;
  chips?: ReactNode;
  removeLabel: string;
  onRemove: () => void;
  disabled?: boolean;
  children: ReactNode;
}

interface InstanceSectionHeaderProps {
  icon: ReactNode;
  title: string;
  count: number;
  description: string;
  actions: ReactNode;
}

export function InstanceSectionHeader({ icon, title, count, description, actions }: InstanceSectionHeaderProps) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ justifyContent: "space-between", mb: 2 }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: "flex-start" }}>
        <Box sx={{ color: "primary.main", pt: 0.25 }}>{icon}</Box>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            {title} <Typography component="span" variant="caption" color="text.secondary">({count})</Typography>
          </Typography>
          <Typography variant="caption" color="text.secondary">{description}</Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "flex-start", justifyContent: { sm: "flex-end" } }}>
        {actions}
      </Stack>
    </Stack>
  );
}

export default function InstanceCard({ title, chips, removeLabel, onRemove, disabled = false, children }: InstanceCardProps) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.75, sm: 2 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.75, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 800, overflowWrap: "anywhere" }}>{title}</Typography>
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap", flex: 1, minWidth: 0 }}>
          {chips}
        </Stack>
        <Tooltip title={removeLabel}>
          <span>
            <IconButton size="small" aria-label={removeLabel} onClick={onRemove} disabled={disabled}>
              <DeleteOutlineRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: "1fr 1fr 1fr" }, gap: 2 }}>
        {children}
      </Box>
    </Paper>
  );
}
