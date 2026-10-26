import { FormControl, FormHelperText, InputLabel, MenuItem, Select } from '@mui/material'
import type { SelectChangeEvent } from '@mui/material/Select'

interface ImplementationSelectProps {
  id: string
  label: string
  description: string
  value: string
  options: string[]
  onChange: (value: string) => void
  disabled?: boolean
}

function displayValue(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

export default function ImplementationSelect({
  id,
  label,
  description,
  value,
  options,
  onChange,
  disabled = false,
}: ImplementationSelectProps) {
  function handleChange(event: SelectChangeEvent) {
    onChange(event.target.value)
  }

  return (
    <FormControl fullWidth disabled={disabled}>
      <InputLabel id={`${id}-label`}>{label}</InputLabel>
      <Select id={id} labelId={`${id}-label`} label={label} value={value} onChange={handleChange}>
        {options.map((option) => (
          <MenuItem key={option} value={option}>{displayValue(option)}</MenuItem>
        ))}
      </Select>
      <FormHelperText>{description}</FormHelperText>
    </FormControl>
  )
}

