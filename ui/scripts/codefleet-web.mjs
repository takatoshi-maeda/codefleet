#!/usr/bin/env node

import { createServer } from 'node:http';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const distDir = path.join(packageRoot, 'dist');
const buildMetadataPath = path.join(distDir, '.codefleet-web-build.json');
const ANSI_GREEN = '\x1b[32m';
const ANSI_RESET = '\x1b[0m';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function printHelp() {
  console.log(`Usage: codefleet-web --codefleet-api-base-url <url> [--host <host>] [--port <port>]

Builds the Expo web bundle into dist/ and serves the exported files.

Options:
  --codefleet-api-base-url <url>  Base URL baked into the exported web bundle.
  --host <host>                   Host to bind the web server to. Default: 127.0.0.1
  --port <port>                   Port to bind the web server to. Default: 8080
  --help                          Show this help message.
`);
}

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 8080,
    codefleetApiBaseUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--codefleet-api-base-url') {
      options.codefleetApiBaseUrl = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument === '--host') {
      options.host = argv[index + 1] ?? options.host;
      index += 1;
      continue;
    }
    if (argument === '--port') {
      const rawPort = argv[index + 1] ?? '';
      const parsedPort = Number.parseInt(rawPort, 10);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        throw new Error(`Invalid --port value: ${rawPort}`);
      }
      options.port = parsedPort;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.codefleetApiBaseUrl) {
    throw new Error('--codefleet-api-base-url is required.');
  }

  try {
    new URL(options.codefleetApiBaseUrl);
  } catch {
    throw new Error(
      `Invalid --codefleet-api-base-url value: ${options.codefleetApiBaseUrl}`,
    );
  }

  return options;
}

function resolveExpoCliPath() {
  const require = createRequire(import.meta.url);
  const expoPackageJsonPath = require.resolve('expo/package.json', {
    paths: [packageRoot],
  });
  const expoPackage = require(expoPackageJsonPath);
  return path.resolve(path.dirname(expoPackageJsonPath), expoPackage.bin.expo);
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: 'inherit',
      env: process.env,
      ...options,
    });

    const forwardSignal = (signal) => {
      child.kill(signal);
    };
    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
      if (signal) {
        reject(new Error(`Command terminated with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Command exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function captureCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Command terminated with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Command exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function resolveUiHeadTreeHash() {
  try {
    return await captureCommand('git', ['rev-parse', 'HEAD:ui']);
  } catch {
    return null;
  }
}

async function readBuildMetadata() {
  try {
    const raw = await readFile(buildMetadataPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeBuildMetadata(metadata) {
  await writeFile(buildMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

async function hasReusableBuild({ baseUrl, uiHeadTreeHash }) {
  if (!uiHeadTreeHash) {
    return false;
  }

  const [metadata, indexExists] = await Promise.all([
    readBuildMetadata(),
    isReadableFile(path.join(distDir, 'index.html')),
  ]);

  if (!metadata || !indexExists) {
    return false;
  }

  return metadata.codefleetApiBaseUrl === baseUrl && metadata.uiHeadTreeHash === uiHeadTreeHash;
}

async function exportWebBundle({ baseUrl, uiHeadTreeHash }) {
  const expoCliPath = resolveExpoCliPath();

  await spawnCommand(process.execPath, [expoCliPath, 'export', '--platform', 'web', '--output-dir', 'dist'], {
    env: {
      ...process.env,
      EXPO_PUBLIC_CODEFLEET_BASE_URL: baseUrl,
    },
  });

  await writeBuildMetadata({
    codefleetApiBaseUrl: baseUrl,
    uiHeadTreeHash,
  });
}

async function isReadableFile(filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return false;
    }
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function buildCandidatePaths(requestPathname) {
  const trimmed = requestPathname.replace(/^\/+/, '');
  if (trimmed.length === 0) {
    return ['index.html'];
  }

  const hasExtension = path.extname(trimmed).length > 0;
  const candidates = [trimmed];
  if (!hasExtension) {
    candidates.push(`${trimmed}.html`, path.join(trimmed, 'index.html'));
  }
  return candidates;
}

async function resolveFilePath(requestPathname) {
  const safePathname = path.posix.normalize(requestPathname);
  if (safePathname.includes('..')) {
    return null;
  }

  for (const candidate of buildCandidatePaths(safePathname)) {
    const filePath = path.join(distDir, candidate);
    if (await isReadableFile(filePath)) {
      return filePath;
    }
  }

  if (path.extname(safePathname).length === 0) {
    const indexFilePath = path.join(distDir, 'index.html');
    if (await isReadableFile(indexFilePath)) {
      return indexFilePath;
    }
  }

  return null;
}

function getContentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

async function startStaticServer({ host, port }) {
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed');
        return;
      }

      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const filePath = await resolveFilePath(requestUrl.pathname);
      if (!filePath) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }

      const payload = method === 'HEAD' ? null : await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': getContentType(filePath),
        'Cache-Control': 'no-cache',
      });
      response.end(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let isShuttingDown = false;
  const shutdown = (signal) => {
    if (isShuttingDown) {
      process.exit(0);
      return;
    }
    isShuttingDown = true;
    server.close();
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log(`${ANSI_GREEN}Serving ${distDir} at http://${host}:${port}${ANSI_RESET}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const normalizedBaseUrl = new URL(options.codefleetApiBaseUrl).toString();
  const uiHeadTreeHash = await resolveUiHeadTreeHash();

  // Reuse only when the baked API base URL and the committed ui/ tree snapshot are unchanged.
  if (await hasReusableBuild({ baseUrl: normalizedBaseUrl, uiHeadTreeHash })) {
    console.log(`Reusing existing web build in ${distDir}`);
  } else {
    console.log(`Building web bundle into ${distDir}`);
    await exportWebBundle({ baseUrl: normalizedBaseUrl, uiHeadTreeHash });
  }
  await startStaticServer(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
