import AddRoundedIcon from "@mui/icons-material/AddRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import RocketLaunchRoundedIcon from "@mui/icons-material/RocketLaunchRounded";
import {
  AppBar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import type { BootstrapData } from "../api/types";
import HealthStatus from "./HealthStatus";

interface AppShellProps {
  bootstrap: BootstrapData | null;
  page: "new" | "list" | "console";
  children: ReactNode;
}

const drawerWidth = 252;

const SlicesIcon = ({ size = 50 }: { size?: number }) => (
  <img
    src={"../../dist/assets/slices-ri-icon.png"}
    alt=""
    width={size}
    height={size / 3}
    style={{ display: "flex" }}
  />
);

const NAV_SX = {
  borderRadius: 2,
  color: "#fff",
  "&.Mui-selected": { bgcolor: "rgba(255,255,255,0.1)" },
  "&.Mui-selected:hover": { bgcolor: "rgba(255,255,255,0.14)" },
};

export default function AppShell({ bootstrap, page, children }: AppShellProps) {
  return (
    <Box sx={{ minHeight: "100vh", display: "flex" }}>
      <Drawer
        variant="permanent"
        sx={{
          width: drawerWidth,
          flexShrink: 0,
          display: { xs: "none", md: "block" },
          "& .MuiDrawer-paper": {
            width: drawerWidth,
            boxSizing: "border-box",
            bgcolor: "#5e8e7f",
            color: "#fff",
            border: 0,
            p: 2.5,
          },
        }}
      >
        <Stack direction="column" spacing={1.5} sx={{ px: 1, py: 1, alignItems: "center" }}>
          <IconButton>
            <SlicesIcon size={150} />
          </IconButton>
          <Box>
            <Typography sx={{ color: "#fff", fontWeight: 800, lineHeight: 1.15 }}>
              Post-5G
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: "rgba(255,255,255,0.58)",
                letterSpacing: "0.13em",
                textTransform: "uppercase",
              }}
            >
              Orchestrator
            </Typography>
          </Box>
        </Stack>

        <List component="nav" aria-label="Primary navigation" sx={{ mt: 4 }}>
          <ListItemButton component="a" href="#/" selected={page === "new"} sx={NAV_SX}>
            <ListItemIcon sx={{ minWidth: 38, color: "secondary.main" }}>
              <AddRoundedIcon />
            </ListItemIcon>
            <ListItemText
              primary={
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>New deployment</Typography>
              }
            />
          </ListItemButton>
          <ListItemButton component="a" href="#/deployments" selected={page !== "new"} sx={NAV_SX}>
            <ListItemText
              primary={<Typography sx={{ fontWeight: 700, fontSize: 14 }}>Deployments</Typography>}
            />
          </ListItemButton>
        </List>

        <Box sx={{ mt: "auto", p: 1 }}>
          <Divider sx={{ borderColor: "rgba(255,255,255,0.12)", mb: 2.5 }} />
          <Typography variant="overline" sx={{ color: "secondary.main" }}>
            Configuration phase
          </Typography>
          <Typography
            variant="body2"
            sx={{ mt: 1, color: "rgba(255,255,255,0.58)", lineHeight: 1.65 }}
          >
            Define and validate a network model before any infrastructure action.
          </Typography>
        </Box>
      </Drawer>

      <Box sx={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column" }}>
        <AppBar
          position="sticky"
          color="inherit"
          elevation={0}
          sx={{
            borderBottom: "1px solid",
            borderColor: "divider",
            bgcolor: "rgba(255,255,255,0.94)",
          }}
        >
          <Toolbar sx={{ minHeight: { xs: 72, sm: 78 }, px: { xs: 2, sm: 4, lg: 6 } }}>
            <Box sx={{ display: { xs: "block", md: "none" }, mr: 2, lineHeight: 0 }}>
              <HubRoundedIcon color="primary" />
            </Box>
            <Box sx={{ flex: 1 }}>
              <Typography variant="overline" color="text.secondary">
                Model workspace
              </Typography>
              <Typography sx={{ fontWeight: 750 }}>Deployment designer</Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              {/* <Chip
                icon={<DataObjectRoundedIcon />}
                label={schemaCount === null ? 'Loading schemas' : `${schemaCount} schema definitions`}
                variant="outlined"
                size="small"
                sx={{ display: { xs: 'none', sm: 'inline-flex' }, bgcolor: 'background.paper', fontWeight: 700 }}
              /> */}
              <HealthStatus health={bootstrap?.health ?? null} />
            </Stack>
          </Toolbar>
        </AppBar>

        <Box
          component="main"
          sx={{
            width: "100%",
            maxWidth: 1160,
            mx: "auto",
            px: { xs: 2, sm: 4, lg: 6 },
            py: { xs: 4, md: 7 },
            flex: 1,
          }}
        >
          {children}
        </Box>

        <Box
          component="footer"
          sx={{
            display: "flex",
            justifyContent: "space-between",
            gap: 2,
            px: { xs: 2, sm: 4, lg: 6 },
            py: 2.5,
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            Post-5G configuration workspace
          </Typography>
          {bootstrap && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: { xs: "none", sm: "block" } }}
            >
              Orchestrator {bootstrap.health.versions.orchestrator ?? "unknown"} · Metamodel{" "}
              {bootstrap.health.versions.metamodel ?? "unknown"}
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  );
}
