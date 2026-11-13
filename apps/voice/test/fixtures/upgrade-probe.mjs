// Test only (server.test.ts, I3): the reviewer's probe, run in its own process so the test process's memory figures
// are the server's alone. argv: port, Authorization header, count, junk (1 = send 5 × 60 KB after the request).
// A socket that is upgraded (101) is kept open, so every refusal is concurrent with it; it is destroyed at the end.
// Prints one JSON line: { closedWithin, statuses }.
import { connect } from 'node:net';

const [port, authorization, count, junk] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4]), process.argv[5] === '1'];
const payload = Buffer.alloc(60 * 1024, 0x4b);
const statuses = {};
const upgraded = [];
const started = Date.now();
await Promise.all(
  Array.from(
    { length: count },
    () =>
      new Promise((resolve) => {
        const sock = connect(port, '127.0.0.1', () => {
          sock.write(
            'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: ${authorization}\r\n\r\n`,
          );
          if (junk) for (let i = 0; i < 5; i++) sock.write(payload);
        });
        let head = '';
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 'none';
          statuses[status] = (statuses[status] ?? 0) + 1;
          resolve();
        };
        sock.on('data', (d) => {
          if (head.length < 64) head += d.toString('latin1');
          if (head.startsWith('HTTP/1.1 101')) {
            upgraded.push(sock);
            finish();
          }
        });
        sock.on('error', () => {});
        sock.on('close', finish);
      }),
  ),
);
const closedWithin = Date.now() - started;
for (const u of upgraded) u.destroy();
process.stdout.write(`${JSON.stringify({ closedWithin, statuses })}\n`);
