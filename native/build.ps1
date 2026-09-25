# Compila AudioCap.exe e InputCtl.exe usando o compilador C# do .NET Framework que ja vem no Windows.
$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe nao encontrado em $csc" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

& $csc /nologo /optimize+ /platform:x64 /target:exe `
    /out:"$here\AudioCap.exe" `
    /reference:System.Management.dll `
    "$here\AudioCap.cs"
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar AudioCap.cs" }

& $csc /nologo /optimize+ /platform:x64 /target:exe `
    /out:"$here\InputCtl.exe" `
    "$here\InputCtl.cs"
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar InputCtl.cs" }

Write-Host "AudioCap.exe e InputCtl.exe compilados."
