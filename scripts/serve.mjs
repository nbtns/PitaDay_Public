import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { prepareConfig, projectRoot } from './prepare-config.mjs';

prepareConfig();
const publicRoot = fs.realpathSync(path.join(projectRoot, 'public'));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (relative.split(/[\\/]/).some(part => part.startsWith('.'))) throw new Error('hidden');
        const candidate = path.resolve(publicRoot, relative);
        if (!candidate.startsWith(publicRoot + path.sep)) throw new Error('outside');
        const filename = fs.realpathSync(candidate);
        if (!filename.startsWith(publicRoot + path.sep) || !fs.statSync(filename).isFile()) throw new Error('file');
        response.writeHead(200, { 'Content-Type': (types[path.extname(filename)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (request.method === 'HEAD') response.end();
        else fs.createReadStream(filename).pipe(response);
    } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`PitaDay 公開デモ: http://localhost:${port}`));
