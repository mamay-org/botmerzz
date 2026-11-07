#!/usr/bin/env bash
set -Eeuo pipefail

readonly max_attempts=4
readonly initial_delay_seconds=5

if [[ "$#" -eq 0 ]]; then
  echo 'A command is required.' >&2
  exit 2
fi

attempt=1
while true; do
  if "$@"; then
    exit 0
  else
    command_status=$?
  fi

  if (( attempt >= max_attempts )); then
    echo "Command failed after ${max_attempts} attempts." >&2
    exit "$command_status"
  fi

  delay_seconds=$((initial_delay_seconds * (1 << (attempt - 1))))
  echo "Command failed on attempt ${attempt}/${max_attempts}; retrying in ${delay_seconds}s." >&2
  sleep "$delay_seconds"
  attempt=$((attempt + 1))
done
