@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul

if "%~1"=="" (
  echo Usage: %~nx0 ^<sorting-id^> [base-file.js]
  echo Example: %~nx0 timsort timsort_base_0120.js
  popd >nul
  exit /b 1
)

set "SORTING_ID=%~1"
if "%~2"=="" (
  set "BASE_FILE=%SORTING_ID%_base_0120.js"
) else (
  set "BASE_FILE=%~2"
)

node benchmark_search_cli.js --sorting "%SORTING_ID%" --base-file "%BASE_FILE%" --from-shortlist --presets=medium,balanced,large,huge --ab-testing=on --runs 7 --progress

set "EXIT_CODE=%ERRORLEVEL%"
popd >nul
endlocal & exit /b %EXIT_CODE%
