$js = Get-Content 'D:\桌面\游戏\酒馆\mqzn-build\备份\fix12-data-persistence\index.js' -Raw
$obj = @{
    type = 'script'
    enabled = $true
    name = 'mqzn-script-fix12'
    id = 'mqzn-script-fix12'
    content = $js
}
$obj | ConvertTo-Json -Depth 1 -Compress | Out-File -FilePath 'D:\桌面\游戏\酒馆\mqzn-build\备份\fix12-data-persistence\明月秋青脚本-fix12.json' -Encoding UTF8 -NoNewline
Write-Host ('done, ' + $js.Length + ' chars')
