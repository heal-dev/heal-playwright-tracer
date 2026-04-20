// TracerITBootstrap — central lifecycle for the collector +
// LocalStack integration suite. Mirrors the shape of heal-cli's
// `HealCliTestBootstrap`:
//
//   const b = new TracerITBootstrap();
//   await b.start({ specSource });
//   await b.runPlaywright();
//   const { s3Objects, sqsMessages } = await b.snapshot();
//   // assertions…
//   await b.stop();
//
// `start()` owns:
//   - LocalStack container (S3 + SQS)
//   - Bucket + FIFO queue creation
//   - Sandbox scaffolding (pkg.json, playwright.config, pod wrapper, spec)
//   - npm install + `npx playwright install chromium`
//   - Collector child process spawn (env points at LocalStack)
//
// Accessors expose the pieces the tests need. Constants (bucket
// name, key prefix parts) live here so tests don't redefine them.

import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Message } from '@aws-sdk/client-sqs';
import type { _Object } from '@aws-sdk/client-s3';

import type { CollectorPushRecord } from '../../../src/trace-collector/schemas/collector-push-schema';

import {
  LocalStack,
  LOCALSTACK_ACCESS_KEY_ID,
  LOCALSTACK_REGION,
  LOCALSTACK_SECRET_ACCESS_KEY,
} from '../helpers/localstack';
import { S3Helper } from '../helpers/s3-helper';
import { SqsHelper } from '../helpers/sqs-helper';
import { CollectorProcess } from '../helpers/collector-process';
import { scaffoldSandbox } from './sandbox-builder';

export interface StartOptions {
  /** Spec source written to `tests/collector.spec.ts` in the sandbox. */
  specSource: string;
}

export interface ParsedMessage {
  body: CollectorPushRecord;
  attrs: Record<string, string>;
  groupId: string | undefined;
}

export interface TracerITSnapshot {
  s3Objects: _Object[];
  sqsMessages: ParsedMessage[];
}

const BUCKET = 'heal-tracer-test';
const QUEUE_NAME = 'heal-tracer-test';
const ORG_SLUG = 'test-org';
const REPO_NAME = 'test-repo';

export class TracerITBootstrap {
  private readonly localstack = new LocalStack();
  private s3: S3Helper | null = null;
  private sqs: SqsHelper | null = null;
  private collector: CollectorProcess | null = null;
  private sandboxDir: string | null = null;
  private readonly executionId: string;

  constructor() {
    this.executionId = `itest-${crypto.randomUUID()}`;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async start(opts: StartOptions): Promise<void> {
    const tarballPath = requireEnv('INTEGRATION_TARBALL');

    // 1. Sandbox: scaffold → npm install → ensure chromium.
    this.sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-tracer-collector-itest-'));
    scaffoldSandbox(this.sandboxDir, { tarballPath, specSource: opts.specSource });
    execSync('npm install --no-audit --no-fund --silent', {
      cwd: this.sandboxDir,
      stdio: 'inherit',
    });
    execSync('npx playwright install chromium', {
      cwd: this.sandboxDir,
      stdio: 'inherit',
    });

    // 2. LocalStack + bucket + queue.
    await this.localstack.start();
    this.s3 = new S3Helper({
      endpoint: this.localstack.endpoint,
      region: LOCALSTACK_REGION,
      accessKeyId: LOCALSTACK_ACCESS_KEY_ID,
      secretAccessKey: LOCALSTACK_SECRET_ACCESS_KEY,
      bucket: BUCKET,
    });
    await this.s3.createBucket();

    this.sqs = new SqsHelper({
      endpoint: this.localstack.endpoint,
      region: LOCALSTACK_REGION,
      accessKeyId: LOCALSTACK_ACCESS_KEY_ID,
      secretAccessKey: LOCALSTACK_SECRET_ACCESS_KEY,
    });
    await this.sqs.createFifoQueue(QUEUE_NAME);

    // 3. Collector child process pointed at LocalStack.
    this.collector = new CollectorProcess({
      env: {
        ...process.env,
        AWS_S3_BUCKET_NAME: BUCKET,
        SQS_QUEUE_URL: this.sqs.getQueueUrl(),
        HEAL_ORG_SLUG: ORG_SLUG,
        REPO_NAME,
        HEAL_EXECUTION_ID: this.executionId,
        AWS_REGION: LOCALSTACK_REGION,
        AWS_ACCESS_KEY_ID: LOCALSTACK_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: LOCALSTACK_SECRET_ACCESS_KEY,
        AWS_S3_ENDPOINT: this.localstack.endpoint,
        SQS_ENDPOINT: this.localstack.endpoint,
      },
      stdio: 'inherit',
    });
    await this.collector.start();
  }

  async stop(): Promise<void> {
    if (this.collector) {
      await this.collector.stop();
      this.collector = null;
    }
    await this.localstack.stop();
    if (this.s3) {
      this.s3.destroy();
      this.s3 = null;
    }
    if (this.sqs) {
      this.sqs.destroy();
      this.sqs = null;
    }
    if (this.sandboxDir && fs.existsSync(this.sandboxDir)) {
      fs.rmSync(this.sandboxDir, { recursive: true, force: true });
      this.sandboxDir = null;
    }
  }

  // ── Operations ───────────────────────────────────────────────

  /**
   * Run the sandbox's Playwright spec against the running collector.
   * `extraEnv` is merged on top of the base env needed by the fixture.
   */
  runPlaywright(extraEnv: Record<string, string> = {}): void {
    execSync('npx playwright test --config .heal-playwright-pod.config.ts', {
      cwd: this.getSandboxDir(),
      env: {
        ...process.env,
        HEAL_COLLECTOR_URL: this.getCollectorUrl(),
        // The fixture reads this to stamp executionId on test-header;
        // mirrors what `env -i` forwards to Playwright in prod.
        HEAL_EXECUTION_ID: this.executionId,
        ...extraEnv,
      },
      stdio: 'inherit',
    });
  }

  /**
   * Give the collector a beat to process in-flight work, SIGTERM
   * it (drain awaits), then fetch the S3 object listing and drain
   * the SQS queue. Returns both snapshots in one shot.
   */
  async snapshot(): Promise<TracerITSnapshot> {
    await new Promise((r) => setTimeout(r, 500));
    if (this.collector) {
      await this.collector.stop();
      this.collector = null;
    }
    const s3Objects = await this.getS3Helper().listObjects();
    const rawMessages = await this.getSqsHelper().receiveAllMessages();
    const sqsMessages = rawMessages.map(parseMessage);
    return { s3Objects, sqsMessages };
  }

  // ── Accessors ────────────────────────────────────────────────

  getS3Helper(): S3Helper {
    if (!this.s3) throw new Error('TracerITBootstrap not started — call start() first.');
    return this.s3;
  }

  getSqsHelper(): SqsHelper {
    if (!this.sqs) throw new Error('TracerITBootstrap not started — call start() first.');
    return this.sqs;
  }

  getCollectorUrl(): string {
    if (!this.collector) {
      throw new Error('Collector not running — call start() first, or snapshot() already ran.');
    }
    return this.collector.url;
  }

  getLocalStackEndpoint(): string {
    return this.localstack.endpoint;
  }

  getSandboxDir(): string {
    if (!this.sandboxDir) {
      throw new Error('Sandbox not created — call start() first.');
    }
    return this.sandboxDir;
  }

  getExecutionId(): string {
    return this.executionId;
  }

  getBucket(): string {
    return BUCKET;
  }

  getOrgSlug(): string {
    return ORG_SLUG;
  }

  getRepoName(): string {
    return REPO_NAME;
  }
}

function parseMessage(m: Message): ParsedMessage {
  const body = JSON.parse(m.Body ?? '{}') as CollectorPushRecord;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.MessageAttributes ?? {})) {
    if (v.StringValue != null) attrs[k] = v.StringValue;
  }
  return { body, attrs, groupId: m.Attributes?.MessageGroupId };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set — did global-setup run?`);
  return value;
}
