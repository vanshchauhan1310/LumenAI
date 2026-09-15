# Opens the Supabase Table Editor for this project (replacement for the old
# Prisma Studio workflow). Reads SUPABASE_URL from .env and launches the
# browser at the project's dashboard so you can browse/edit rows safely.
#
# Usage (from the byok-platform folder):
#   powershell -File scripts\open-prod-studio.ps1
#
# .env must contain, e.g.:
#   SUPABASE_URL="https://<project-ref>.supabase.co"
#   SUPABASE_SERVICE_ROLE_KEY="<service_role key>"   # server-side use only

$envFile = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envFile)) {
  Write-Host "No .env found at $envFile" -ForegroundColor Red
  Write-Host 'Expected keys:'
  Write-Host 'SUPABASE_URL="https://<project-ref>.supabase.co"'
  exit 1
}

$urlLine = Get-Content $envFile | Where-Object { $_ -match '^\s*SUPABASE_URL\s*=' } | Select-Object -First 1
if (-not $urlLine) {
  Write-Host "SUPABASE_URL not found in $envFile" -ForegroundColor Red
  Write-Host 'Add it from Supabase Dashboard -> Project Settings -> API'
  exit 1
}

$value = ($urlLine -replace '^\s*SUPABASE_URL\s*=\s*', '') -replace '^"|"$', ''
Write-Host "Opening the Supabase Table Editor for: $value" -ForegroundColor Yellow
Write-Host 'Tip: the service_role key bypasses row-level security - use it only server-side.'
Start-Process "$value/project/_/editor"
