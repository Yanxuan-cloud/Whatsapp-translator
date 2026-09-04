# WhatsApp 翻译助手 - GitHub 一键部署脚本
# 使用前请先安装 Git: https://git-scm.com/download/win
#
# 用法:
#   1. 安装 Git
#   2. 在本文件夹打开 PowerShell
#   3. 运行: .\push-to-github.ps1
#   4. 按提示输入 GitHub 用户名和密码/Token

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "`n===== WhatsApp 翻译助手 - GitHub 部署 =====`n" -ForegroundColor Cyan

# 检查 Git 是否安装
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git 未安装！请先从 https://git-scm.com/download/win 下载安装。" -ForegroundColor Red
    exit 1
}

# 设置 Git 用户信息（如果还没有）
$configName = git config --global user.name 2>$null
$configEmail = git config --global user.email 2>$null
if (-not $configName) {
    $name = Read-Host "请输入你的名字（Git 提交署名）"
    git config --global user.name $name
}
if (-not $configEmail) {
    $email = Read-Host "请输入你的邮箱（Git 提交署名）"
    git config --global user.email $email
}

# 初始化仓库
Write-Host "`n[1/4] 初始化 Git 仓库..." -ForegroundColor Yellow
git init
git branch -M main

# 添加文件
Write-Host "[2/4] 添加文件..." -ForegroundColor Yellow
git add -A
git status

# 提交
Write-Host "[3/4] 创建初始提交..." -ForegroundColor Yellow
git commit -m "feat: WhatsApp 双语翻译助手 v0.2.0 - 初始开源版本

- Manifest V3 架构，权限最小化
- DeepL / Google Translate 双引擎
- 收消息自动翻译显示，发消息手动复制译文
- 不代替用户自动发送消息（安全设计原则）
- 深色模式适配
- LRU 内存缓存，API Key 请求头传递
- MIT 开源协议"

# 添加远程仓库
Write-Host "[4/4] 添加远程仓库..." -ForegroundColor Yellow
$repoUrl = "https://github.com/Yanxuan-cloud/whatsapp-translator.git"
git remote add origin $repoUrl 2>$null
if ($LASTEXITCODE -ne 0) {
    git remote set-url origin $repoUrl
}

Write-Host "`n===== 仓库准备完成 =====" -ForegroundColor Green
Write-Host "`n下一步操作:`n" -ForegroundColor Cyan
Write-Host "1. 在 GitHub 上创建仓库: https://github.com/new" -ForegroundColor White
Write-Host "   仓库名: whatsapp-translator" -ForegroundColor White
Write-Host "   设为 Public，不要勾选添加 README" -ForegroundColor White
Write-Host "2. 创建完成后运行以下命令推送:" -ForegroundColor White
Write-Host "   git push -u origin main" -ForegroundColor Yellow
Write-Host "`n如果提示需要认证，使用 GitHub Token 作为密码。" -ForegroundColor Gray
Write-Host "Token 生成地址: https://github.com/settings/tokens`n" -ForegroundColor Gray
