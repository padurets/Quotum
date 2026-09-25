@echo off
rem Antigravity's client as far as the agent asks it, with an answer recorded from agy 1.1.11
rem (the dates moved on): the smoke test starts no real client and needs no account.
if "%~1"=="--version" (
  echo 1.1.11
  exit /b 0
)
echo {"conversation_id":"","status":"SUCCESS","response":"","num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0},"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.75,"reset_time":"2030-01-07T00:00:00Z"},{"id":"gemini-5h","window":"5h","remaining_fraction":0.5,"reset_time":"2030-01-01T05:00:00Z"}]}]}}}
