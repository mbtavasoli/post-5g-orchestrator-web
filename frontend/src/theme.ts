import { createTheme } from '@mui/material/styles'

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1f5b4b', dark: '#143d33', light: '#d8ebe4', contrastText: '#ffffff' },
    secondary: { main: '#a7d94b', dark: '#6f9f1b', contrastText: '#173026' },
    background: { default: '#f4f6f3', paper: '#ffffff' },
    text: { primary: '#172722', secondary: '#60706a' },
    divider: '#dce4df',
    success: { main: '#4f8d2c' },
    error: { main: '#b33f39' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: { fontSize: 'clamp(2.25rem, 5vw, 4rem)', fontWeight: 650, letterSpacing: '-0.055em', lineHeight: 0.98 },
    h2: { fontSize: '1.7rem', fontWeight: 700, letterSpacing: '-0.025em' },
    button: { fontWeight: 750, textTransform: 'none' },
    overline: { fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.14em', lineHeight: 1.6 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { minHeight: 44, borderRadius: 10, paddingInline: 18 } },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiTextField: { defaultProps: { variant: 'outlined' } },
  },
})

export default theme
