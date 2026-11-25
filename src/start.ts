import { spawn } from 'node:child_process';
import { join } from 'node:path';

function runNodeScript(scriptPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: 'inherit' });
    const forwardSignal = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.on('SIGTERM', forwardSignal);
    process.on('SIGINT', forwardSignal);
    child.on('error', (error) => {
      process.off('SIGTERM', forwardSignal);
      process.off('SIGINT', forwardSignal);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGTERM', forwardSignal);
      process.off('SIGINT', forwardSignal);
      if (signal) resolve(128);
      else resolve(code ?? 0);
    });
  });
}

async function start() {
  if (process.env.RUN_MIGRATIONS !== 'false') {
    const migrationCode = await runNodeScript(join(__dirname, 'migrate.js'));
    if (migrationCode !== 0) {
      process.exit(migrationCode);
    }
  }
  const appCode = await runNodeScript(join(__dirname, 'main.js'));
  process.exit(appCode);
}

void start().catch((error) => {
  console.error('[Auric Startup Error]:', error);
  process.exit(1);
});
