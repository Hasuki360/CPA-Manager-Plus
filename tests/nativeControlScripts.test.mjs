import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unixControlScript = path.join(repoRoot, 'bin/native/cpa-manager-plusctl.sh');
const windowsControlScript = path.join(repoRoot, 'bin/native/cpa-manager-plusctl.ps1');
const tempDirs = [];

const findExecutable = (candidates) => candidates.find((candidate) => existsSync(candidate));

const windowsPowerShell = () => {
  if (process.env.SystemRoot) {
    return path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
};

const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;

const runUnixControl = (script, env, args, options = {}) =>
  execFileSync('bash', [script, ...args], {
    env,
    encoding: 'utf8',
    ...options,
  });

const runControl = (env, args, options = {}) =>
  runUnixControl(unixControlScript, env, args, options);

const runPowerShell = (args, options = {}) =>
  execFileSync(windowsPowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
    ...options,
  });

const runPowerShellControl = (env, args, options = {}) =>
  execFileSync(windowsPowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsControlScript, ...args], {
    env,
    encoding: 'utf8',
    ...options,
  });

const spawnPowerShellControl = (env, args) => {
  const result = spawnSync(
    windowsPowerShell(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsControlScript, ...args],
    {
      env,
      stdio: 'ignore',
    },
  );
  expect(result.status).toBe(0);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('native control scripts', () => {
  it('starts Unix processes from the package directory when invoked elsewhere', () => {
    if (process.platform === 'win32') {
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cpamp-native-cwd-'));
    tempDirs.push(tempDir);

    const packageDir = path.join(tempDir, 'package');
    const callerDir = path.join(tempDir, 'caller');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(callerDir, { recursive: true });

    const controlScript = path.join(packageDir, 'cpa-manager-plusctl');
    const fakeBinary = path.join(packageDir, 'cpa-manager-plus');
    const cwdFile = path.join(tempDir, 'cwd.txt');
    const dataEnvFile = path.join(tempDir, 'data-env.txt');
    copyFileSync(unixControlScript, controlScript);
    chmodSync(controlScript, 0o755);
    writeFileSync(
      fakeBinary,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'pwd >"${CPA_MANAGER_PLUS_TEST_CWD_FILE}"',
        'printf "%s\\n" "${USAGE_DATA_DIR:-}" >"${CPA_MANAGER_PLUS_TEST_DATA_FILE}"',
        'sleep 30',
        '',
      ].join('\n'),
    );
    chmodSync(fakeBinary, 0o755);

    const env = {
      ...process.env,
      CPA_MANAGER_PLUS_TEST_CWD_FILE: cwdFile,
      CPA_MANAGER_PLUS_TEST_DATA_FILE: dataEnvFile,
      USAGE_DATA_DIR: './data',
    };

    try {
      runUnixControl(controlScript, env, ['start'], { cwd: callerDir });

      expect(readFileSync(cwdFile, 'utf8').trim()).toBe(packageDir);
      expect(readFileSync(dataEnvFile, 'utf8').trim()).toBe('./data');
      expect(runUnixControl(controlScript, env, ['status'], { cwd: callerDir })).toContain('is running with PID');
      expect(runUnixControl(controlScript, env, ['stop'], { cwd: callerDir })).toContain('stopped');
    } finally {
      spawnSync('bash', [controlScript, 'stop'], { cwd: callerDir, env, encoding: 'utf8' });
    }
  });

  it('creates custom Unix PID/log parent directories with private runtime files', () => {
    if (process.platform === 'win32') {
      return;
    }

    const sleepBinary = findExecutable(['/bin/sleep', '/usr/bin/sleep']);
    if (!sleepBinary) {
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cpamp-native-control-'));
    tempDirs.push(tempDir);

    const pidFile = path.join(tempDir, 'custom-run', 'nested', 'manager.pid');
    const logFile = path.join(tempDir, 'custom-logs', 'nested', 'manager.log');
    const env = {
      ...process.env,
      CPA_MANAGER_PLUS_BIN: sleepBinary,
      CPA_MANAGER_PLUS_RUN_DIR: path.join(tempDir, 'default-run'),
      CPA_MANAGER_PLUS_LOG_DIR: path.join(tempDir, 'default-logs'),
      CPA_MANAGER_PLUS_PID_FILE: pidFile,
      CPA_MANAGER_PLUS_LOG_FILE: logFile,
    };

    try {
      runControl(env, ['start', '30']);

      expect(existsSync(path.dirname(pidFile))).toBe(true);
      expect(existsSync(path.dirname(logFile))).toBe(true);
      expect(existsSync(pidFile)).toBe(true);
      expect(existsSync(logFile)).toBe(true);
      expect(statSync(pidFile).mode & 0o777).toBe(0o600);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);

      const pidRecord = readFileSync(pidFile, 'utf8');
      expect(pidRecord).toContain('pid=');
      expect(pidRecord).toContain('start=');
      expect(pidRecord).toContain('binary=');
      expect(pidRecord).toContain('command=');

      expect(runControl(env, ['status'])).toContain('is running with PID');
      expect(runControl(env, ['stop'])).toContain('stopped');
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      spawnSync('bash', [unixControlScript, 'stop'], { env, encoding: 'utf8' });
    }
  });

  it('does not change permissions on existing custom Unix run/log directories', () => {
    if (process.platform === 'win32') {
      return;
    }

    const sleepBinary = findExecutable(['/bin/sleep', '/usr/bin/sleep']);
    if (!sleepBinary) {
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cpamp-native-existing-dir-'));
    tempDirs.push(tempDir);

    const runDir = path.join(tempDir, 'existing-run');
    const logDir = path.join(tempDir, 'existing-logs');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    chmodSync(runDir, 0o755);
    chmodSync(logDir, 0o755);

    const pidFile = path.join(runDir, 'cpa-manager-plus.pid');
    const logFile = path.join(logDir, 'cpa-manager-plus.log');
    const env = {
      ...process.env,
      CPA_MANAGER_PLUS_BIN: sleepBinary,
      CPA_MANAGER_PLUS_RUN_DIR: runDir,
      CPA_MANAGER_PLUS_LOG_DIR: logDir,
    };

    try {
      runControl(env, ['start', '30']);

      expect(statSync(runDir).mode & 0o777).toBe(0o755);
      expect(statSync(logDir).mode & 0o777).toBe(0o755);
      expect(statSync(pidFile).mode & 0o777).toBe(0o600);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
      expect(runControl(env, ['stop'])).toContain('stopped');
    } finally {
      spawnSync('bash', [unixControlScript, 'stop'], { env, encoding: 'utf8' });
    }
  });

  it('refuses to stop a running process from an unverifiable legacy Unix PID file', () => {
    if (process.platform === 'win32') {
      return;
    }

    const sleepBinary = findExecutable(['/bin/sleep', '/usr/bin/sleep']);
    if (!sleepBinary) {
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cpamp-native-conflict-'));
    tempDirs.push(tempDir);

    const pidFile = path.join(tempDir, 'run', 'manager.pid');
    const logFile = path.join(tempDir, 'logs', 'manager.log');
    const unrelatedProcess = spawn(sleepBinary, ['5'], {
      stdio: 'ignore',
    });
    const unrelatedPid = unrelatedProcess.pid;
    expect(unrelatedPid).toBeGreaterThan(0);

    const env = {
      ...process.env,
      CPA_MANAGER_PLUS_BIN: sleepBinary,
      CPA_MANAGER_PLUS_PID_FILE: pidFile,
      CPA_MANAGER_PLUS_LOG_FILE: logFile,
    };

    try {
      rmSync(path.dirname(pidFile), { force: true, recursive: true });
      mkdirSync(path.dirname(pidFile), { recursive: true });
      writeFileSync(pidFile, `${unrelatedPid}\n`);

      const stopResult = spawnSync('bash', [unixControlScript, 'stop'], {
        env,
        encoding: 'utf8',
      });

      expect(stopResult.status).not.toBe(0);
      expect(stopResult.stderr).toContain('Refusing to stop');
      expect(spawnSync('kill', ['-0', String(unrelatedPid)]).status).toBe(0);
    } finally {
      unrelatedProcess.kill();
    }
  });

  it('parses the Windows PowerShell control script', () => {
    if (process.platform !== 'win32') {
      return;
    }

    runPowerShell([
      '-Command',
      [
        '$tokens = $null',
        '$errors = $null',
        `[System.Management.Automation.Language.Parser]::ParseFile(${psQuote(windowsControlScript)}, [ref]$tokens, [ref]$errors) | Out-Null`,
        'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
      ].join('; '),
    ]);
  });

  it('starts Windows processes with custom paths, private files, logs, and stop', () => {
    if (process.platform !== 'win32') {
      return;
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'cpamp-native-win-'));
    tempDirs.push(tempDir);

    const pidFile = path.join(tempDir, 'custom-run', 'nested', 'manager.pid');
    const logFile = path.join(tempDir, 'custom-logs', 'nested', 'manager.log');
    const errLogFile = path.join(tempDir, 'custom-logs', 'nested', 'manager.err.log');
    const childScript = path.join(tempDir, 'child.ps1');
    writeFileSync(childScript, 'Start-Sleep -Seconds 30\r\n');

    const env = {
      ...process.env,
      CPA_MANAGER_PLUS_BIN: windowsPowerShell(),
      CPA_MANAGER_PLUS_PID_FILE: pidFile,
      CPA_MANAGER_PLUS_LOG_FILE: logFile,
      CPA_MANAGER_PLUS_ERR_LOG_FILE: errLogFile,
    };

    try {
      spawnPowerShellControl(env, [
        'start',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        childScript,
      ]);

      expect(existsSync(pidFile)).toBe(true);
      expect(existsSync(logFile)).toBe(true);
      expect(existsSync(errLogFile)).toBe(true);
      expect(runPowerShellControl(env, ['status'])).toContain('is running with PID');

      const pidRecord = JSON.parse(readFileSync(pidFile, 'utf8'));
      expect(pidRecord.pid).toBeGreaterThan(0);
      expect(pidRecord.startTimeUtc).toBeTruthy();
      expect(pidRecord.binaryPath || pidRecord.commandLine).toBeTruthy();

      runPowerShell([
        '-Command',
        [
          `foreach ($path in @(${[pidFile, logFile, errLogFile].map(psQuote).join(', ')})) {`,
          '  if (-not (Get-Acl -LiteralPath $path).AreAccessRulesProtected) { throw "ACL is not protected: $path" }',
          '}',
        ].join(' '),
      ]);

      expect(runPowerShellControl(env, ['logs', '20'])).toBeDefined();
      expect(runPowerShellControl(env, ['stop'])).toContain('stopped');
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      spawnSync(windowsPowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowsControlScript, 'stop'], {
        env,
        encoding: 'utf8',
      });
    }
  }, 30000);
});
