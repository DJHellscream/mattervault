# ==============================================================================
# Mattervault Native Services Startup Script (Windows)
# Starts Ollama and Docling on the host for GPU acceleration
# Usage: .\scripts\start-native.ps1
# ==============================================================================

$ErrorActionPreference = "Stop"

Write-Host "=============================================="
Write-Host "  Mattervault Native Services Startup"
Write-Host "=============================================="
Write-Host ""

# Check if Ollama is installed
Write-Host "Checking Ollama installation..."
$ollamaPath = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaPath) {
    Write-Host "ERROR: Ollama not found. Install from https://ollama.ai" -ForegroundColor Red
    exit 1
}
Write-Host "Found Ollama at: $($ollamaPath.Source)" -ForegroundColor Green

# Check if Docling is installed
Write-Host "Checking Docling installation..."
$doclingPath = Get-Command docling-serve -ErrorAction SilentlyContinue
if (-not $doclingPath) {
    Write-Host "WARNING: docling-serve not found." -ForegroundColor Yellow
    Write-Host "Install with: pip install docling-serve" -ForegroundColor Yellow
    $skipDocling = $true
} else {
    Write-Host "Found docling-serve at: $($doclingPath.Source)" -ForegroundColor Green
    $skipDocling = $false
}

Write-Host ""

# Start Ollama (bind to all interfaces for Docker access)
Write-Host "Starting Ollama (binding to 0.0.0.0:11434)..."
$env:OLLAMA_HOST = "0.0.0.0"

# Check if Ollama is already running
$ollamaRunning = Test-NetConnection -ComputerName localhost -Port 11434 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
if ($ollamaRunning.TcpTestSucceeded) {
    Write-Host "Ollama is already running on port 11434" -ForegroundColor Green
} else {
    Write-Host "Starting Ollama in background..."
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
    Write-Host "Ollama started" -ForegroundColor Green
}

# Start Docling if available
if (-not $skipDocling) {
    Write-Host ""
    Write-Host "Starting Docling (binding to 0.0.0.0:5001)..."

    $doclingRunning = Test-NetConnection -ComputerName localhost -Port 5001 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    if ($doclingRunning.TcpTestSucceeded) {
        Write-Host "Docling is already running on port 5001" -ForegroundColor Green
    } else {
        Write-Host "Starting Docling in background..."
        Start-Process -FilePath "docling-serve" -ArgumentList "--host", "0.0.0.0", "--port", "5001", "--no-ui" -WindowStyle Hidden
        Start-Sleep -Seconds 5
        Write-Host "Docling started" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=============================================="
Write-Host "Native services started!" -ForegroundColor Green
Write-Host ""
Write-Host "Verify with:"
Write-Host "  curl http://localhost:11434/api/tags   # Ollama"
if (-not $skipDocling) {
    Write-Host "  curl http://localhost:5001/health     # Docling"
}
Write-Host ""
Write-Host "Pull required models:"
Write-Host "  ollama pull bge-m3"
Write-Host "  ollama pull llama3.1:8b"
Write-Host "=============================================="
