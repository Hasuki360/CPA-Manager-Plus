#!/usr/bin/env bash
set -euo pipefail

app_name="cpa-manager-plus"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binary="${CPA_MANAGER_PLUS_BIN:-"${script_dir}/${app_name}"}"
binary_name="$(basename "${binary}")"
run_dir="${CPA_MANAGER_PLUS_RUN_DIR:-"${script_dir}/run"}"
log_dir="${CPA_MANAGER_PLUS_LOG_DIR:-"${script_dir}/logs"}"
pid_file="${CPA_MANAGER_PLUS_PID_FILE:-"${run_dir}/${app_name}.pid"}"
log_file="${CPA_MANAGER_PLUS_LOG_FILE:-"${log_dir}/${app_name}.log"}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args...]

Commands:
  start [args...]  Start cpa-manager-plus in the background
  stop             Stop the background process
  restart          Restart the background process
  status           Show process status
  logs [lines|-f]  Print recent logs, or follow with -f

Environment overrides:
  CPA_MANAGER_PLUS_BIN       Binary path
  CPA_MANAGER_PLUS_RUN_DIR   Runtime directory, default: ./run
  CPA_MANAGER_PLUS_LOG_DIR   Log directory, default: ./logs
  CPA_MANAGER_PLUS_PID_FILE  PID file path
  CPA_MANAGER_PLUS_LOG_FILE  Log file path
EOF
}

read_pid() {
  if [ ! -f "${pid_file}" ]; then
    return 1
  fi
  local pid
  pid="$(tr -d '[:space:]' <"${pid_file}")"
  if [ -z "${pid}" ]; then
    return 1
  fi
  printf '%s\n' "${pid}"
}

is_pid_running() {
  local pid="$1"
  kill -0 "${pid}" >/dev/null 2>&1
}

resolve_path() {
  local path="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "${path}" 2>/dev/null || printf '%s\n' "${path}"
    return
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "${path}" 2>/dev/null || printf '%s\n' "${path}"
    return
  fi
  printf '%s\n' "${path}"
}

pid_matches_binary() {
  local pid="$1"
  local resolved_binary resolved_process comm

  if ! is_pid_running "${pid}"; then
    return 1
  fi

  resolved_binary="$(resolve_path "${binary}")"

  if [ -L "/proc/${pid}/exe" ]; then
    resolved_process="$(resolve_path "/proc/${pid}/exe")"
    [ "${resolved_process}" = "${resolved_binary}" ] && return 0
    return 1
  fi

  comm="$(ps -p "${pid}" -o comm= 2>/dev/null | awk '{$1=$1;print}')"
  case "${comm}" in
    "${binary}" | "${resolved_binary}" | "${binary_name}" | */"${binary_name}")
      return 0
      ;;
  esac

  return 1
}

running_pid() {
  local pid
  if ! pid="$(read_pid)"; then
    return 1
  fi
  if pid_matches_binary "${pid}"; then
    printf '%s\n' "${pid}"
    return 0
  fi
  return 1
}

start_app() {
  if [ ! -x "${binary}" ]; then
    echo "Binary is not executable: ${binary}" >&2
    exit 1
  fi

  local pid
  if pid="$(running_pid)"; then
    echo "${app_name} is already running with PID ${pid}"
    return 0
  fi

  mkdir -p "${run_dir}" "${log_dir}"
  rm -f "${pid_file}"

  nohup "${binary}" "$@" >>"${log_file}" 2>&1 &
  pid="$!"
  printf '%s\n' "${pid}" >"${pid_file}"

  sleep 1
  if pid_matches_binary "${pid}"; then
    echo "${app_name} started with PID ${pid}"
    echo "Log: ${log_file}"
    return 0
  fi

  rm -f "${pid_file}"
  echo "${app_name} failed to start. Recent log output:" >&2
  if [ -f "${log_file}" ]; then
    tail -n 40 "${log_file}" >&2
  fi
  exit 1
}

stop_app() {
  local pid
  if ! pid="$(read_pid)"; then
    echo "${app_name} is not running"
    return 0
  fi

  if ! pid_matches_binary "${pid}"; then
    rm -f "${pid_file}"
    echo "Removed stale PID file for ${app_name}"
    return 0
  fi

  kill "${pid}"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! pid_matches_binary "${pid}"; then
      rm -f "${pid_file}"
      echo "${app_name} stopped"
      return 0
    fi
    sleep 1
  done

  echo "${app_name} did not stop within 10 seconds. PID: ${pid}" >&2
  exit 1
}

status_app() {
  local pid
  if pid="$(running_pid)"; then
    echo "${app_name} is running with PID ${pid}"
    echo "PID file: ${pid_file}"
    echo "Log: ${log_file}"
    return 0
  fi

  if [ -f "${pid_file}" ]; then
    echo "${app_name} is not running; stale PID file: ${pid_file}"
    return 1
  fi

  echo "${app_name} is not running"
  return 1
}

show_logs() {
  if [ ! -f "${log_file}" ]; then
    echo "Log file does not exist yet: ${log_file}" >&2
    exit 1
  fi

  local option="${1:-80}"
  if [ "${option}" = "-f" ] || [ "${option}" = "--follow" ]; then
    tail -n 80 -f "${log_file}"
    return 0
  fi

  tail -n "${option}" "${log_file}"
}

command="${1:-status}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "${command}" in
  start)
    start_app "$@"
    ;;
  stop)
    stop_app
    ;;
  restart)
    stop_app
    start_app "$@"
    ;;
  status)
    status_app
    ;;
  logs)
    show_logs "$@"
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
