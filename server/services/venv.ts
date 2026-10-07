import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WORKSPACE_DIR } from '../config.js';
import { resolveSafePath } from './workspace.js';

export interface VenvStatus {
  exists: boolean;
  pythonPath: string;
  hasRequirements: boolean;
  installedPackages?: string[];
}

export function getVenvPythonPath(): string {
  const venvPython = path.join(WORKSPACE_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  // Windows fallback
  const winPython = path.join(WORKSPACE_DIR, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(winPython)) {
    return winPython;
  }
  return 'python3';
}

export function getVenvPipPath(): string {
  const venvPip = path.join(WORKSPACE_DIR, '.venv', 'bin', 'pip');
  if (fs.existsSync(venvPip)) {
    return venvPip;
  }
  const winPip = path.join(WORKSPACE_DIR, '.venv', 'Scripts', 'pip.exe');
  if (fs.existsSync(winPip)) {
    return winPip;
  }
  return 'pip3';
}

export function getVenvStatus(): VenvStatus {
  const venvDir = path.join(WORKSPACE_DIR, '.venv');
  const exists = fs.existsSync(venvDir);
  const pythonPath = getVenvPythonPath();
  const hasRequirements = fs.existsSync(path.join(WORKSPACE_DIR, 'requirements.txt'));

  return {
    exists,
    pythonPath,
    hasRequirements
  };
}

export function createVenv(): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['-m', 'venv', '.venv'], {
      cwd: WORKSPACE_DIR
    });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: output || 'Virtual environment created successfully.' });
      } else {
        resolve({ success: false, output: output || `Venv creation failed with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

export function installRequirements(): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const pipPath = getVenvPipPath();
    const reqPath = path.join(WORKSPACE_DIR, 'requirements.txt');
    if (!fs.existsSync(reqPath)) {
      return resolve({ success: false, output: 'requirements.txt not found in workspace' });
    }

    const proc = spawn(pipPath, ['install', '-r', 'requirements.txt'], {
      cwd: WORKSPACE_DIR
    });

    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: output || `Process exited with code ${code}`
      });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

const activeProcesses = new Map<string, Set<any>>();

export function registerSessionProcess(sessionId: string, proc: any): () => void {
  if (!activeProcesses.has(sessionId)) {
    activeProcesses.set(sessionId, new Set());
  }
  const set = activeProcesses.get(sessionId)!;
  set.add(proc);
  return () => {
    set.delete(proc);
    if (set.size === 0) activeProcesses.delete(sessionId);
  };
}

export function killSessionProcesses(sessionId: string): number {
  const set = activeProcesses.get(sessionId);
  if (!set || set.size === 0) return 0;
  let count = 0;
  for (const proc of set) {
    try {
      proc.kill('SIGKILL');
      count++;
    } catch {}
  }
  activeProcesses.delete(sessionId);
  return count;
}

export function runPythonScript(
  scriptRelPath: string,
  args: string[] = [],
  onData?: (data: string) => void,
  sessionId?: string
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const pythonPath = getVenvPythonPath();
    const fullScriptPath = resolveSafePath(scriptRelPath);

    const env = {
      ...process.env,
      PATH: `${path.join(WORKSPACE_DIR, '.venv', 'bin')}:${process.env.PATH}`,
      PYTHONUNBUFFERED: '1'
    };

    const proc = spawn(pythonPath, [fullScriptPath, ...args], {
      cwd: WORKSPACE_DIR,
      env
    });

    const unregister = sessionId ? registerSessionProcess(sessionId, proc) : null;

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const str = d.toString();
      stdout += str;
      if (onData) onData(str);
    });

    proc.stderr.on('data', (d) => {
      const str = d.toString();
      stderr += str;
      if (onData) onData(str);
    });

    proc.on('close', (code) => {
      if (unregister) unregister();
      resolve({
        success: code === 0,
        code: code ?? 0,
        stdout,
        stderr
      });
    });

    proc.on('error', (err) => {
      if (unregister) unregister();
      resolve({
        success: false,
        code: -1,
        stdout: '',
        stderr: err.message
      });
    });
  });
}

export function runBashCommand(
  cmd: string,
  onData?: (data: string) => void,
  sessionId?: string
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PATH: `${path.join(WORKSPACE_DIR, '.venv', 'bin')}:${process.env.PATH}`
    };

    const proc = spawn('/bin/bash', ['-c', cmd], {
      cwd: WORKSPACE_DIR,
      env
    });

    const unregister = sessionId ? registerSessionProcess(sessionId, proc) : null;

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      const str = d.toString();
      stdout += str;
      if (onData) onData(str);
    });

    proc.stderr.on('data', (d) => {
      const str = d.toString();
      stderr += str;
      if (onData) onData(str);
    });

    proc.on('close', (code) => {
      if (unregister) unregister();
      resolve({
        success: code === 0,
        code: code ?? 0,
        stdout,
        stderr
      });
    });

    proc.on('error', (err) => {
      if (unregister) unregister();
      resolve({
        success: false,
        code: -1,
        stdout: '',
        stderr: err.message
      });
    });
  });
}
