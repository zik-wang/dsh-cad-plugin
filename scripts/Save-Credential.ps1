param([string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'DSH-CAD\deepseek.dpapi'))
$ErrorActionPreference = 'Stop'
$cadSecret = Read-Host '请输入你自己的 DeepSeek API key（隐藏输入）' -AsSecureString
if ($cadSecret.Length -eq 0) { throw '未输入密钥，未写入文件。' }
$cadCredentialFullPath = [System.IO.Path]::GetFullPath($CredentialPath)
if (Test-Path -LiteralPath $cadCredentialFullPath) { throw '目标凭据文件已存在。请改用新路径，避免覆盖正在使用的凭据。' }
$cadCredentialDirectory = Split-Path -Parent $cadCredentialFullPath
New-Item -ItemType Directory -Path $cadCredentialDirectory -Force | Out-Null
$cadSecret | ConvertFrom-SecureString | Set-Content -LiteralPath $cadCredentialFullPath -Encoding ASCII
$cadSecret.Dispose()
Write-Output "credentialFile: $cadCredentialFullPath"
Write-Output '已使用当前 Windows 用户 DPAPI 加密。不要上传此文件。'
