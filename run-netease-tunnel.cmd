@echo off
cd /d "C:\tunnel-client"
"C:\tunnel-client\tunnel-client.exe" run --profile netease --health.listen-addr 127.0.0.1:18082 >> "C:\tunnel-client\netease-tunnel.log" 2>> "C:\tunnel-client\netease-tunnel-error.log"
