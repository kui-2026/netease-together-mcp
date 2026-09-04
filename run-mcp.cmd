@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" src\server.js >> "%~dp0mcp.log" 2>> "%~dp0mcp-error.log"
