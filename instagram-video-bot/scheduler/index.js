// Runs the daily Reel pipeline on a schedule, with node-cron.
//
//   npm start            stay running; run `pipeline.py run` at CRON_SCHEDULE
//   npm start -- --now   run the pipeline once, right now, and exit
//
// Settings come from ../.env (see ../.env.example):
//   CRON_SCHEDULE  cron expression, default "45 17 * * *" (17:45 every day)
//   CRON_TIMEZONE  IANA zone the schedule is read in, default the machine's
//   PYTHON         interpreter to run the pipeline with; default the .venv one
//
// The pipeline itself decides whether there is anything to do: it posts at
// most one Reel per day and picks up where a failed run stopped. So a missed
// or doubled tick is harmless, and a failed run is retried at RETRY_HOURS.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

const BOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(BOT_DIR, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const SCHEDULE = process.env.CRON_SCHEDULE || '45 17 * * *';
const TIMEZONE = process.env.CRON_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const RETRY_HOURS = Number(process.env.CRON_RETRY_HOURS || 2);

function python() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const venv = process.platform === 'win32'
    ? join(BOT_DIR, '.venv', 'Scripts', 'python.exe')
    : join(BOT_DIR, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

let child = null;

function runPipeline(extraArgs = []) {
  return new Promise((resolve) => {
    const args = [join(BOT_DIR, 'pipeline.py'), 'run', ...extraArgs];
    log(`starting: ${python()} ${args.join(' ')}`);
    child = spawn(python(), args, { cwd: BOT_DIR, stdio: 'inherit' });
    child.on('error', (err) => {
      log(`could not start the pipeline: ${err.message}`);
      child = null;
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      log(signal ? `pipeline stopped by ${signal}` : `pipeline finished with exit code ${code}`);
      child = null;
      resolve(code ?? 1);
    });
  });
}

if (process.argv.includes('--now')) {
  process.exitCode = await runPipeline();
} else {
  if (!cron.validate(SCHEDULE)) {
    console.error(`CRON_SCHEDULE "${SCHEDULE}" is not a valid cron expression`);
    process.exit(2);
  }

  let retry = null;
  const tick = async () => {
    // noOverlap covers two cron ticks; this covers a tick landing on a retry.
    if (child) return log('previous run still going; skipping this one');
    clearTimeout(retry);
    const code = await runPipeline();
    if (code !== 0 && RETRY_HOURS > 0) {
      // Most failures are a provider that was slow or briefly down. The run
      // resumes from its saved state, so trying again later costs nothing.
      log(`will retry in ${RETRY_HOURS}h`);
      retry = setTimeout(tick, RETRY_HOURS * 3600 * 1000);
    }
  };

  const task = cron.schedule(SCHEDULE, tick, {
    name: 'daily-reel',
    timezone: TIMEZONE,
    noOverlap: true, // a run still going when the next tick fires is left alone
  });
  log(`scheduled "${SCHEDULE}" (${TIMEZONE}); next run ${task.getNextRun()?.toString()}`);

  const shutdown = async (signal) => {
    log(`${signal}: shutting down`);
    clearTimeout(retry);
    await task.stop();
    if (child) child.kill(signal);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
