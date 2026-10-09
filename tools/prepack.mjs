import { chmodSync } from 'node:fs';

for (const bin of ['dist-server/server/main.js', 'dist-server/server/set-password.js']) {
  chmodSync(bin, 0o755);
}
