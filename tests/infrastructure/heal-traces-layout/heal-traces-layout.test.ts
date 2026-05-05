/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { HealTracesLayout } from '../../../src/infrastructure/heal-traces-layout';

describe('HealTracesLayout', () => {
  const ROOT = '/tmp/repo';
  const EXEC = 'exec-123';
  const TID = 'abcdef';
  const ATTEMPT = 1;

  const layout = (): HealTracesLayout => new HealTracesLayout(ROOT, EXEC);

  it('healTracesRoot joins rootDir with the heal-traces dirname', () => {
    expect(layout().healTracesRoot()).toBe(path.join(ROOT, 'heal-traces'));
  });

  it('executionDir nests executionId under heal-traces', () => {
    expect(layout().executionDir()).toBe(path.join(ROOT, 'heal-traces', EXEC));
  });

  it('testDir nests playwrightTestId and attempt under executionDir', () => {
    expect(layout().testDir(TID, ATTEMPT)).toBe(path.join(ROOT, 'heal-traces', EXEC, TID, '1'));
  });

  it('ndjsonPath places heal-traces.ndjson at the per-attempt root', () => {
    expect(layout().ndjsonPath(TID, ATTEMPT)).toBe(
      path.join(ROOT, 'heal-traces', EXEC, TID, '1', 'heal-traces.ndjson'),
    );
  });

  it('tracePath places trace.zip at the per-attempt root', () => {
    expect(layout().tracePath(TID, ATTEMPT)).toBe(
      path.join(ROOT, 'heal-traces', EXEC, TID, '1', 'trace.zip'),
    );
  });

  it('screenshotPath places files under the screenshots/ subdir', () => {
    expect(layout().screenshotPath(TID, ATTEMPT, 'stmt-0001.png')).toBe(
      path.join(ROOT, 'heal-traces', EXEC, TID, '1', 'screenshots', 'stmt-0001.png'),
    );
  });

  it('screenshotPath strips any directory components from the filename', () => {
    expect(layout().screenshotPath(TID, ATTEMPT, '../escape.png')).toBe(
      path.join(ROOT, 'heal-traces', EXEC, TID, '1', 'screenshots', 'escape.png'),
    );
  });

  it('videoPath places files under the videos/ subdir', () => {
    expect(layout().videoPath(TID, ATTEMPT, 'video.webm')).toBe(
      path.join(ROOT, 'heal-traces', EXEC, TID, '1', 'videos', 'video.webm'),
    );
  });

  it('attachmentPath resolves nested relative paths under the per-attempt dir', () => {
    expect(layout().attachmentPath(TID, ATTEMPT, 'pages/page-1/video.webm')).toBe(
      path.resolve(path.join(ROOT, 'heal-traces', EXEC, TID, '1', 'pages', 'page-1', 'video.webm')),
    );
  });

  it('attachmentPath rejects path traversal attempts', () => {
    expect(() => layout().attachmentPath(TID, ATTEMPT, '../../../etc/passwd')).toThrow(
      /escapes test directory/,
    );
  });

  it('attachmentPath accepts the per-attempt root itself', () => {
    expect(layout().attachmentPath(TID, ATTEMPT, '.')).toBe(
      path.resolve(path.join(ROOT, 'heal-traces', EXEC, TID, '1')),
    );
  });

  it('executionsNdjsonPath sits next to the per-execution dirs', () => {
    expect(layout().executionsNdjsonPath()).toBe(
      path.join(ROOT, 'heal-traces', 'executions.ndjson'),
    );
  });

  it('executionManifestPath sits at the executionDir root', () => {
    expect(layout().executionManifestPath()).toBe(
      path.join(ROOT, 'heal-traces', EXEC, 'execution.json'),
    );
  });

  it('exposes rootDir and executionId unchanged', () => {
    const l = layout();
    expect(l.rootDir).toBe(ROOT);
    expect(l.executionId).toBe(EXEC);
  });
});
