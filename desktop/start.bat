@echo off
REM ============================================================================
REM  start.bat - run the Praimana desktop app from source on Windows.
REM
REM  WHAT THIS DOES
REM    1. Checks you have Node and a package manager.
REM    2. Installs dependencies the first time (into node_modules\ beside this file).
REM    3. Builds the app if it has not been built yet.
REM    4. Launches the app. If a connect.json sits next to this file, the app opens on the
REM       "connect to this experience" confirmation screen, pre-filled with that config; you
REM       still click Connect and then sign in. Without connect.json the app opens normally
REM       and you can connect from inside it ("Sign in to another experience").
REM
REM  HOW TO USE
REM    1. Download and extract the desktop source zip.
REM    2. Download connect.json (from the portal) and place it in THIS folder, next to start.bat.
REM    3. Open Command Prompt, cd into this folder, and run:  start.bat
REM       (first run installs dependencies, so it takes a few minutes)
REM
REM  connect.json format (all four values come from your portal - none is secret):
REM    {
REM      "portalUrl":  "https://<your-portal-host>",
REM      "apiBaseUrl": "https://<your-api-host>",
REM      "poolId":     "<cognito-user-pool-id>",
REM      "clientId":   "<cognito-app-client-id>"
REM    }
REM ============================================================================
setlocal enabledelayedexpansion

REM Always operate from the folder this script lives in.
cd /d "%~dp0"

REM -- 1. Prerequisites --------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [Praimana] Node.js is not installed. Install Node 22 or newer from https://nodejs.org and re-run.
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo.
  echo [Praimana] Node 22 or newer is required. Please upgrade and re-run.
  exit /b 1
)

REM Prefer pnpm; fall back to "npx pnpm" so it need not be installed globally.
set "PNPM=pnpm"
where pnpm >nul 2>&1
if errorlevel 1 (
  where npx >nul 2>&1
  if errorlevel 1 (
    echo.
    echo [Praimana] Neither pnpm nor npx is available. Install Node 22+ ^(which bundles npx^) and re-run.
    exit /b 1
  )
  echo [Praimana] pnpm not found; using "npx pnpm" instead.
  set "PNPM=npx --yes pnpm@10.30.3"
)

REM -- 1b. Pin the PUBLIC npm registry, overriding the user's global config ----
REM This package pins packageManager: pnpm@<ver>, so a mismatched pnpm DOWNLOADS the pinned
REM version to run it, and that self-download reads the user's GLOBAL npmrc (not this folder's
REM .npmrc). On a machine whose global config names a private registry with a stale token, that
REM bootstrap fetch fails with a 401 before any dependency is touched. Point pnpm's USERCONFIG at
REM a throwaway npmrc pinning the public registry so both the self-download and the install use
REM npmjs.org regardless of the user's global config.
set "PRAIMANA_NPMRC=%TEMP%\praimana-npmrc-%RANDOM%.txt"
> "%PRAIMANA_NPMRC%" echo registry=https://registry.npmjs.org/
>> "%PRAIMANA_NPMRC%" echo node-linker=hoisted
set "npm_config_userconfig=%PRAIMANA_NPMRC%"
set "COREPACK_NPM_REGISTRY=https://registry.npmjs.org/"

REM -- 2. Install dependencies (first run only) --------------------------------
if not exist "node_modules\.bin\electron.cmd" (
  echo.
  echo [Praimana] Installing dependencies ^(first run - this can take a few minutes^)...
  call %PNPM% install --frozen-lockfile
  if errorlevel 1 ( echo [Praimana] Dependency install failed. & del "%PRAIMANA_NPMRC%" 2>nul & exit /b 1 )
) else (
  echo [Praimana] Dependencies already installed; skipping.
)

REM -- 3. Build if needed ------------------------------------------------------
if not exist "dist\main\index.js" (
  echo.
  echo [Praimana] Building the app...
  call %PNPM% run build
  if errorlevel 1 ( echo [Praimana] Build failed. & exit /b 1 )
) else (
  echo [Praimana] Build is present; skipping.
)

REM -- 4. Assemble the connect link from connect.json, if present --------------
set "CONNECT_ARG="
if exist "connect.json" (
  echo [Praimana] Found connect.json - the app will offer to connect to that experience.
  for /f "usebackq delims=" %%L in (`node -e "const fs=require('fs');let c;try{c=JSON.parse(fs.readFileSync('connect.json','utf8'))}catch(e){console.error('connect.json is not valid JSON: '+e.message);process.exit(3)}const need=['portalUrl','apiBaseUrl','poolId','clientId'];const m=need.filter(k=>!c[k]||String(c[k]).trim()==='');if(m.length){console.error('connect.json is missing: '+m.join(', '));process.exit(3)}const q=new URLSearchParams({p:String(c.portalUrl).trim(),a:String(c.apiBaseUrl).trim(),pool:String(c.poolId).trim(),c:String(c.clientId).trim()});process.stdout.write('praimana://connect?'+q.toString())"`) do set "CONNECT_ARG=%%L"
  if not defined CONNECT_ARG (
    echo [Praimana] Could not read connect.json. Fix it ^(see the format in start.bat^) and re-run.
    exit /b 1
  )
) else (
  echo [Praimana] No connect.json in this folder - the app will open normally; connect from inside it.
)

REM -- 5. Launch ---------------------------------------------------------------
REM The temp registry npmrc has done its job (install + build); remove it before launch.
del "%PRAIMANA_NPMRC%" 2>nul
echo.
echo [Praimana] Starting Praimana...
if defined CONNECT_ARG (
  call "node_modules\.bin\electron.cmd" . "%CONNECT_ARG%"
) else (
  call "node_modules\.bin\electron.cmd" .
)

endlocal
