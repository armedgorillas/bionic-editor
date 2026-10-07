import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';
import { WORKSPACE_DIR } from '../config.js';

export class TerminalSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.start();
  }

  private start() {
    const venvBin = path.join(WORKSPACE_DIR, '.venv', 'bin');
    const env = {
      ...process.env,
      PATH: `${venvBin}:${process.env.PATH}`,
      TERM: 'xterm-256color',
      PS1: 'bionic-env:\\w$ '
    };

    this.proc = spawn('/bin/bash', ['-i'], {
      cwd: WORKSPACE_DIR,
      env
    });

    this.proc.stdout.on('data', (chunk) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'terminal_output',
          data: chunk.toString()
        }));
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'terminal_output',
          data: chunk.toString()
        }));
      }
    });

    this.proc.on('close', (code) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'terminal_exit',
          code
        }));
      }
    });
  }

  public handleInput(data: string) {
    if (this.proc && this.proc.stdin && !this.proc.killed) {
      this.proc.stdin.write(data);
    }
  }

  public kill() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
