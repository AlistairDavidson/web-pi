// set-password.ts — set/replace the single login credential.
// Interactive:
//   npm run set-password   (or: node dist-server/server/set-password.js)
// Piped:  printf 'user\npass\npass\n' | node dist-server/server/set-password.js
import * as readline from 'node:readline';
import { setCredential } from '../src/lib/auth';
import { StateDb } from '../src/lib/db';
import { ENV } from '../src/lib/env';

const stateDb = new StateDb(ENV.WEB_PI_DB_FILE);

// Interactive prompt (TTY): prompt printed BEFORE muting output (else the
// prompt itself is swallowed and it looks hung — fixed 2026-09-30).
function askInteractive(out: NodeJS.WriteStream, rl: readline.Interface,
  q: string, mute: boolean): Promise<string> {
  return new Promise(resolve => {
    if (!mute) { rl.question(q, a => resolve(a)); return; }
    const write = out.write.bind(out);
    write(q);
    out.write = (s: string) => { if (s === '\r\n' || s === '\n') write(s); return true; };
    rl.question('', a => { out.write = write; out.write('\n'); resolve(a); });
  });
}

// Piped mode: read all stdin lines up front (sequential rl.question() races
// when a pipe delivers every line in one chunk).
function readPiped(): Promise<string[]> {
  return new Promise(resolve => {
    const lines: string[] = []; let buf = '';
    process.stdin.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1);
      }
    });
    process.stdin.on('end', () => {
      if (buf) lines.push(buf.replace(/\r$/, ''));
      resolve(lines);
    });
  });
}

(async (): Promise<void> => {
  let username: string, pw: string, pw2: string;
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username = (await askInteractive(process.stdout, rl, 'Username: ', false)).trim();
    pw = await askInteractive(process.stdout, rl, 'Password (input hidden): ', true);
    pw2 = await askInteractive(process.stdout, rl, 'Repeat password: ', true);
    rl.close();
  } else {
    const lines = await readPiped();
    username = (lines[0] ?? '').trim();
    pw = lines[1] ?? '';
    pw2 = lines[2] ?? '';
  }
  if (!username) { console.error('username required'); process.exit(1); }
  if (!pw || pw.length < 8) { console.error('password must be >= 8 chars'); process.exit(1); }
  if (pw !== pw2) { console.error('passwords do not match'); process.exit(1); }
  setCredential(stateDb, username, pw);
  console.log('written:', ENV.WEB_PI_DB_FILE);
})();
