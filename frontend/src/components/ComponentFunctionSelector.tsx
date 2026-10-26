import {
  Autocomplete,
  Box,
  Chip,
  FormControlLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

interface ComponentFunctionSelectorProps {
  label: string;
  implementation: string;
  mode: "all" | "selected";
  selectedTypes: string[];
  supportedTypes: string[];
  disabled?: boolean;
  onChange: (mode: "all" | "selected", selectedTypes: string[]) => void;
}

export default function ComponentFunctionSelector({
  label,
  implementation,
  mode,
  selectedTypes,
  supportedTypes,
  disabled = false,
  onChange,
}: ComponentFunctionSelectorProps) {
  const visibleTypes = mode === "all" ? supportedTypes : selectedTypes;

  return (
    <Paper variant="outlined" sx={{ p: 2, bgcolor: "#fbfcfa" }}>
      <Stack spacing={1.75}>
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>{label} functions</Typography>
          <Typography variant="caption" color="text.secondary">
            Supported by {implementation}; loaded from the backend.
          </Typography>
        </Box>

        <RadioGroup
          row
          value={mode}
          onChange={(event) => {
            const nextMode = event.target.value as "all" | "selected";
            onChange(nextMode, nextMode === "all" ? supportedTypes : selectedTypes);
          }}
          aria-label={`${label} function selection`}
        >
          <FormControlLabel
            value="all"
            control={<Radio size="small" />}
            label="All supported functions"
            disabled={disabled}
          />
          <FormControlLabel
            value="selected"
            control={<Radio size="small" />}
            label="Choose functions"
            disabled={disabled}
          />
        </RadioGroup>

        {mode === "selected" ? (
          <Autocomplete
            multiple
            options={supportedTypes}
            value={selectedTypes.filter((type) => supportedTypes.includes(type))}
            onChange={(_, values) => onChange("selected", values)}
            disabled={disabled}
            renderInput={(params) => (
              <TextField
                {...params}
                label={`${label} functions`}
                helperText="Select one or more functions. Model validation remains authoritative."
              />
            )}
          />
        ) : (
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: "wrap" }}>
            {visibleTypes.map((type) => <Chip key={type} label={type} size="small" variant="outlined" />)}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
